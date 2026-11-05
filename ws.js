// Claude Office — un serveur WebSocket minimal, sans dependance (RFC 6455).
//
// Pourquoi pas `ws` : le depot n'a aucune dependance, et l'usage ici est etroit —
// nos propres agents, du JSON de quelques centaines d'octets, pas d'extension, pas
// de sous-protocole, pas de binaire. Tout ce que `ws` sait faire en plus serait du
// code mort, et une image Docker sans `npm install` est une image sans chaine
// d'approvisionnement a surveiller.
//
// Ce qu'il fait : poignee de main, trames texte (fragmentees comprises), ping/pong,
// fermeture propre, et des garde-fous de taille. Ce qu'il refuse : les trames non
// masquees (un client DOIT masquer), les bits RSV (donc permessage-deflate), et
// tout message au-dela de MAX_MESSAGE.

const crypto = require('crypto');

// La chaine magique de la RFC 6455. Elle se recopie mal : le vecteur de test de la
// RFC (cle dGhlIHNhbXBsZSBub25jZQ== -> accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo=) est
// verifie par smoke.mjs, parce qu'un caractere de travers donne une poignee de main
// refusee sans le moindre message d'erreur exploitable.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 256 * 1024;  // un snapshot de poste tient tres largement dedans
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const CRLF = '\r\n';

// Reponse a la poignee de main. Ecrit directement sur la socket : a ce stade le
// serveur HTTP de Node a deja rendu la main (evenement 'upgrade').
function handshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request' + CRLF + CRLF);
    return false;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols' + CRLF
    + 'Upgrade: websocket' + CRLF
    + 'Connection: Upgrade' + CRLF
    + 'Sec-WebSocket-Accept: ' + accept + CRLF + CRLF);
  return true;
}

// Trame serveur : jamais masquee (c'est le client qui masque, pas nous).
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}

class Socket {
  constructor(socket) {
    this.socket = socket;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.frags = [];       // morceaux d'un message fragmente
    this.fragLen = 0;
    this.fragging = false;
    this.onText = () => {};
    this.onClose = () => {};
  }

  send(text) {
    if (!this.open) return false;
    try { this.socket.write(frame(OP.TEXT, Buffer.from(text, 'utf8'))); return true; }
    catch { this.destroy(); return false; }
  }

  ping() {
    if (!this.open) return;
    try { this.socket.write(frame(OP.PING, Buffer.alloc(0))); } catch { this.destroy(); }
  }

  // Fermeture polie : on annonce le code, puis on coupe. Si l'autre bout ne repond
  // pas, couper suffit — on n'attend pas un acquittement qui peut ne jamais venir.
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try { this.socket.write(frame(OP.CLOSE, body)); } catch { /* deja parti */ }
    this.destroy(code);
  }

  destroy(code = 1006) {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch { /* deja parti */ }
    this.onClose(code);
  }

  // Analyse tout ce qui est complet dans le tampon. Une trame incomplete reste en
  // attente du prochain paquet TCP : rien ne garantit qu'une trame arrive d'un bloc.
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      if (b[0] & 0x70) return this.close(1002, 'RSV');      // aucune extension negociee
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'trop gros');
        len = Number(big); off = 10;
      }
      if (!masked) return this.close(1002, 'non masque');
      if (b.length < off + 4 + len) return;                 // trame incomplete
      const mask = b.subarray(off, off + 4);
      off += 4;
      // Copie : le tampon sera retranche juste apres, et on demasque sur place.
      const payload = Buffer.from(b.subarray(off, off + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);

      // Trames de controle : jamais fragmentees, 125 octets maximum, et elles
      // peuvent s'intercaler au milieu d'un message fragmente.
      if (op >= 0x8) {
        if (!fin || len > 125) return this.close(1002, 'controle invalide');
        if (op === OP.CLOSE) return this.close(1000);
        if (op === OP.PING) {
          try { this.socket.write(frame(OP.PONG, payload)); } catch { this.destroy(); }
        }
        continue;                                           // PONG : rien a faire
      }

      if (op === OP.BIN) return this.close(1003, 'binaire refuse');
      if (op === OP.TEXT) {
        if (this.fragging) return this.close(1002, 'fragmentation');
        if (!fin) { this.fragging = true; this.frags = [payload]; this.fragLen = len; continue; }
        this.deliver(payload);
        continue;
      }
      if (op === OP.CONT) {
        if (!this.fragging) return this.close(1002, 'continuation orpheline');
        this.fragLen += len;
        if (this.fragLen > MAX_MESSAGE) return this.close(1009, 'trop gros');
        this.frags.push(payload);
        if (!fin) continue;
        this.fragging = false;
        const whole = Buffer.concat(this.frags, this.fragLen);
        this.frags = []; this.fragLen = 0;
        this.deliver(whole);
      }
    }
  }

  deliver(payload) {
    if (payload.length > MAX_MESSAGE) return this.close(1009, 'trop gros');
    const text = payload.toString('utf8');
    try { this.onText(text); } catch (e) { console.error('ws handler:', e && e.message); }
  }
}

// Branche le WebSocket sur un serveur HTTP existant. `route(req)` decide : il rend
// l'objet de contexte a passer a onOpen, ou null pour refuser (mauvais chemin,
// jeton absent) — le refus se fait AVANT la poignee de main, en HTTP, pour que le
// client voie un vrai 401 plutot qu'une connexion qui se ferme sans explication.
function attach(server, { route, onOpen }) {
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => { try { socket.destroy(); } catch { /* deja parti */ } });
    let ctx;
    try { ctx = route(req); } catch { ctx = null; }
    if (!ctx) { socket.end('HTTP/1.1 401 Unauthorized' + CRLF + CRLF); return; }
    if (!handshake(req, socket)) return;
    socket.setNoDelay(true);
    const ws = new Socket(socket);
    socket.on('data', (c) => ws.feed(c));
    socket.on('close', () => ws.destroy());
    socket.on('error', () => ws.destroy());
    onOpen(ws, ctx, req);
  });
}

module.exports = { attach, Socket, frame, MAX_MESSAGE, OP };
