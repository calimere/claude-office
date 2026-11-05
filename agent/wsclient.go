package main

// Client WebSocket minimal (RFC 6455), ecrit a la main pour la meme raison que le
// serveur : l'agent doit rester un binaire autonome que `go build` produit sans rien
// telecharger. Ce qu'il fait : poignee de main, trames texte masquees, ping/pong,
// fermeture. Ce qu'il ne fait pas : extensions, fragmentation a l'emission, binaire.

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	opCont  = 0x0
	opText  = 0x1
	opClose = 0x8
	opPing  = 0x9
	opPong  = 0xa
)

const maxMessage = 256 << 10

type WSConn struct {
	conn net.Conn
	br   *bufio.Reader
	// Le verrou d'ecriture appartient a la connexion, pas a l'appelant. La goroutine
	// qui LIT ecrit elle aussi : elle doit repondre aux pings. Sans ce verrou, un pong
	// peut s'intercaler au milieu d'une trame d'evenement — en-tete d'un cote, charge
	// utile de l'autre — et le serveur ferme sur une erreur de protocole. La panne
	// arrive toutes les quinze secondes, au rythme des pings, et seulement quand un
	// evenement part au meme instant : rare, donc insupportable a diagnostiquer.
	wmu sync.Mutex
}

// Dial ouvre la connexion et verifie la poignee de main. L'accept est verifie :
// un serveur qui repond 101 sans la bonne valeur n'est pas un serveur WebSocket.
func wsDial(raw string, headers map[string]string, timeout time.Duration) (*WSConn, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	var tlsOn bool
	switch u.Scheme {
	case "ws":
	case "wss":
		tlsOn = true
	default:
		return nil, fmt.Errorf("schema non supporte : %s (attendu ws:// ou wss://)", u.Scheme)
	}
	host := u.Host
	if u.Port() == "" {
		if tlsOn {
			host = net.JoinHostPort(u.Hostname(), "443")
		} else {
			host = net.JoinHostPort(u.Hostname(), "80")
		}
	}

	d := &net.Dialer{Timeout: timeout}
	var conn net.Conn
	if tlsOn {
		conn, err = tls.DialWithDialer(d, "tcp", host, &tls.Config{ServerName: u.Hostname()})
	} else {
		conn, err = d.Dial("tcp", host)
	}
	if err != nil {
		return nil, err
	}

	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		conn.Close()
		return nil, err
	}
	k64 := base64.StdEncoding.EncodeToString(key)

	path := u.RequestURI()
	var b strings.Builder
	fmt.Fprintf(&b, "GET %s HTTP/1.1\r\n", path)
	fmt.Fprintf(&b, "Host: %s\r\n", u.Host)
	b.WriteString("Upgrade: websocket\r\n")
	b.WriteString("Connection: Upgrade\r\n")
	fmt.Fprintf(&b, "Sec-WebSocket-Key: %s\r\n", k64)
	b.WriteString("Sec-WebSocket-Version: 13\r\n")
	for k, v := range headers {
		fmt.Fprintf(&b, "%s: %s\r\n", k, v)
	}
	b.WriteString("\r\n")

	conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write([]byte(b.String())); err != nil {
		conn.Close()
		return nil, err
	}

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		conn.Close()
		return nil, err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		// 401 ici veut dire jeton refuse ou nom de poste invalide : c'est la
		// panne la plus probable en exploitation, elle merite d'etre nommee.
		return nil, fmt.Errorf("le serveur a repondu %s (jeton ou nom de poste refuse ?)", resp.Status)
	}
	sum := sha1.Sum([]byte(k64 + wsGUID))
	if resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		conn.Close()
		return nil, errors.New("poignee de main invalide : ce n'est pas un serveur WebSocket")
	}
	conn.SetDeadline(time.Time{})
	return &WSConn{conn: conn, br: br}, nil
}

// writeFrame : un client DOIT masquer ses trames, meme en clair. Un serveur
// conforme ferme la connexion si on ne le fait pas.
func (c *WSConn) writeFrame(op byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	n := len(payload)
	head := make([]byte, 0, 14)
	head = append(head, 0x80|op)
	switch {
	case n < 126:
		head = append(head, 0x80|byte(n))
	case n < 65536:
		head = append(head, 0x80|126)
		head = binary.BigEndian.AppendUint16(head, uint16(n))
	default:
		head = append(head, 0x80|127)
		head = binary.BigEndian.AppendUint64(head, uint64(n))
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	head = append(head, mask[:]...)

	body := make([]byte, n)
	for i := 0; i < n; i++ {
		body[i] = payload[i] ^ mask[i&3]
	}
	c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if _, err := c.conn.Write(head); err != nil {
		return err
	}
	_, err := c.conn.Write(body)
	return err
}

func (c *WSConn) WriteText(s string) error { return c.writeFrame(opText, []byte(s)) }
func (c *WSConn) WritePing() error         { return c.writeFrame(opPing, nil) }

// ReadMessage rend le prochain message texte complet. Les trames de controle sont
// traitees ici meme : un ping sans pong et le serveur nous declare morts.
func (c *WSConn) ReadMessage(deadline time.Duration) (string, error) {
	var acc []byte
	var fragging bool
	for {
		if deadline > 0 {
			c.conn.SetReadDeadline(time.Now().Add(deadline))
		}
		var h [2]byte
		if _, err := io.ReadFull(c.br, h[:]); err != nil {
			return "", err
		}
		fin := h[0]&0x80 != 0
		if h[0]&0x70 != 0 {
			return "", errors.New("bits RSV inattendus")
		}
		op := h[0] & 0x0f
		masked := h[1]&0x80 != 0
		n := int(h[1] & 0x7f)
		switch n {
		case 126:
			var e [2]byte
			if _, err := io.ReadFull(c.br, e[:]); err != nil {
				return "", err
			}
			n = int(binary.BigEndian.Uint16(e[:]))
		case 127:
			var e [8]byte
			if _, err := io.ReadFull(c.br, e[:]); err != nil {
				return "", err
			}
			v := binary.BigEndian.Uint64(e[:])
			if v > maxMessage {
				return "", errors.New("trame trop grosse")
			}
			n = int(v)
		}
		if n > maxMessage {
			return "", errors.New("trame trop grosse")
		}
		var mask [4]byte
		if masked {
			if _, err := io.ReadFull(c.br, mask[:]); err != nil {
				return "", err
			}
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(c.br, payload); err != nil {
			return "", err
		}
		if masked {
			for i := range payload {
				payload[i] ^= mask[i&3]
			}
		}

		switch op {
		case opClose:
			c.writeFrame(opClose, payload)
			return "", io.EOF
		case opPing:
			if err := c.writeFrame(opPong, payload); err != nil {
				return "", err
			}
			continue
		case opPong:
			continue
		case opText:
			if !fin {
				fragging, acc = true, payload
				continue
			}
			return string(payload), nil
		case opCont:
			if !fragging {
				return "", errors.New("continuation orpheline")
			}
			acc = append(acc, payload...)
			if len(acc) > maxMessage {
				return "", errors.New("message trop gros")
			}
			if !fin {
				continue
			}
			return string(acc), nil
		default:
			return "", fmt.Errorf("opcode inattendu : %d", op)
		}
	}
}

func (c *WSConn) Close() error {
	c.writeFrame(opClose, []byte{0x03, 0xe8}) // 1000, fermeture normale
	return c.conn.Close()
}
