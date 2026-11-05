package main

// La liaison avec le serveur de la flotte : connexion, reconnexion, instantanes.
//
// Un choix a expliquer : quand la connexion revient apres une coupure, on JETTE ce
// qui s'est accumule et on envoie un instantane. Rejouer dix minutes d'evenements
// perimes ferait rasseoir des agents qui ont fini depuis longtemps, avant que la
// reconciliation ne les releve — on gagnerait une animation fausse pour rien.
// L'instantane dit la verite du moment, c'est tout ce qui compte.
//
// La file d'attente ne sert donc qu'aux a-coups d'ecriture, et elle est bornee :
// un serveur qui ne lit plus ne doit pas faire gonfler la memoire d'un poste.

import (
	"context"
	"errors"
	"io"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

const (
	queueSize       = 256
	snapshotEvery   = 10 * time.Second
	usageEvery      = 60 * time.Second
	pingEvery       = 20 * time.Second
	dialTimeout     = 10 * time.Second
	backoffMin      = 2 * time.Second
	backoffMax      = 60 * time.Second
	// Delai au-dela duquel on considere la connexion morte faute de la moindre
	// trame recue. Le serveur ne nous parle presque jamais : ce qui tient ce delai
	// a distance, ce sont les pong a nos propres pings (pingEvery, toutes les 20 s).
	// Il doit donc rester nettement superieur a pingEvery, sinon l'agent se
	// reconnecterait en boucle sur une liaison parfaitement saine.
	readIdleTimeout = 90 * time.Second
)

type Fleet struct {
	endpoint string // URL /ingest complete, jeton compris
	machine  string
	state    *State
	usage    func() string
	logf     func(string, ...any)

	out       chan string
	online    atomic.Bool
	dropped   atomic.Int64
	lastError atomic.Value // string
}

// NewFleet construit l'URL d'ingestion a partir de ce que l'utilisateur a ecrit dans
// sa configuration : on accepte http(s) comme ws(s), parce que personne n'a envie de
// se souvenir que c'est un WebSocket.
func NewFleet(server, token, machine string, st *State, usage func() string, logf func(string, ...any)) (*Fleet, error) {
	u, err := url.Parse(strings.TrimSpace(server))
	if err != nil {
		return nil, err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return nil, errors.New("adresse de serveur incomprise : " + server)
	}
	if u.Host == "" {
		return nil, errors.New("adresse de serveur sans hote : " + server)
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/ingest"
	q := url.Values{}
	q.Set("token", token)
	q.Set("machine", machine)
	u.RawQuery = q.Encode()

	f := &Fleet{endpoint: u.String(), machine: machine, state: st, usage: usage, logf: logf,
		out: make(chan string, queueSize)}
	f.lastError.Store("")
	return f, nil
}

// Publish ne bloque JAMAIS. Un hook qui attendrait le reseau ralentirait Claude Code,
// ce qui est exactement ce que cet agent existe pour eviter.
func (f *Fleet) Publish(msg string) {
	select {
	case f.out <- msg:
	default:
		// File pleine : on jette le plus ancien pour garder le plus recent. Le
		// prochain instantane remettra de toute facon tout le monde d'accord.
		select {
		case <-f.out:
			f.dropped.Add(1)
		default:
		}
		select {
		case f.out <- msg:
		default:
		}
	}
}

func (f *Fleet) Online() bool    { return f.online.Load() }
func (f *Fleet) Dropped() int64  { return f.dropped.Load() }
func (f *Fleet) LastError() string {
	s, _ := f.lastError.Load().(string)
	return s
}

func (f *Fleet) drain() {
	for {
		select {
		case <-f.out:
		default:
			return
		}
	}
}

func (f *Fleet) Run(ctx context.Context) {
	backoff := backoffMin
	for ctx.Err() == nil {
		started := time.Now()
		err := f.session(ctx)
		f.online.Store(false)
		if ctx.Err() != nil {
			return
		}
		// Une connexion qui a tenu n'est pas un symptome : le serveur a redemarre,
		// ou le wifi a saute. On repart du delai le plus court. Sans cette remise a
		// zero, le recul s'accumule pour toujours et un poste finit par attendre une
		// minute entiere apres chaque coupure, meme s'il etait connecte depuis la veille.
		if time.Since(started) > 2*backoffMax {
			backoff = backoffMin
		}
		if err != nil && !errors.Is(err, io.EOF) {
			f.lastError.Store(err.Error())
			f.logf("flotte : %v — nouvelle tentative dans %s", err, backoff)
		} else {
			f.logf("flotte : connexion fermee, nouvelle tentative dans %s", backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > backoffMax {
			backoff = backoffMax
		}
	}
}

func (f *Fleet) session(ctx context.Context) error {
	c, err := wsDial(f.endpoint, nil, dialTimeout)
	if err != nil {
		return err
	}
	defer c.Close()

	f.online.Store(true)
	f.lastError.Store("")
	f.logf("flotte : connecte")

	// Ce qui s'est accumule pendant la coupure est perime : l'instantane qui suit
	// dit mieux, et tout de suite.
	f.drain()

	// Pas de verrou ici : WSConn serialise ses propres ecritures, parce que la
	// goroutine de lecture ecrit elle aussi (les pong).
	write := c.WriteText

	if err := write(f.state.Snapshot(f.machine)); err != nil {
		return err
	}
	if u := f.usage(); u != "" {
		if err := write(u); err != nil {
			return err
		}
	}

	// Lecteur : le serveur ne nous dit presque rien, mais c'est lui qui repond aux
	// pings et qui nous apprend que la connexion est morte.
	dead := make(chan error, 1)
	go func() {
		for {
			if _, err := c.ReadMessage(readIdleTimeout); err != nil {
				dead <- err
				return
			}
		}
	}()

	snapT := time.NewTicker(snapshotEvery)
	usageT := time.NewTicker(usageEvery)
	pingT := time.NewTicker(pingEvery)
	defer snapT.Stop()
	defer usageT.Stop()
	defer pingT.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-dead:
			return err
		case msg := <-f.out:
			if err := write(msg); err != nil {
				return err
			}
		case <-snapT.C:
			if err := write(f.state.Snapshot(f.machine)); err != nil {
				return err
			}
		case <-usageT.C:
			if u := f.usage(); u != "" {
				if err := write(u); err != nil {
					return err
				}
			}
		case <-pingT.C:
			if err := c.WritePing(); err != nil {
				return err
			}
		}
	}
}
