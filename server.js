// Claude Office — pont entre les hooks de Claude Code et la vue three.js
// Zéro dépendance. Node 18+.  Lancer : node server.js  → http://localhost:4317
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || '127.0.0.1';
const clients = new Set();

// Mémoire des sessions ouvertes : sans elle, une page rechargée reste vide jusqu'au
// prochain événement. On retient l'identité (id + projet) ET les sous-agents encore
// en vol, sinon des agents lancés avant l'ouverture de la page resteraient invisibles.
// Elle est aussi écrite sur disque : un redémarrage du serveur ne doit pas rendre
// invisibles des agents lancés une heure plus tôt et toujours au travail.
const live = new Map();
const TTL = 12 * 3600e3; // une session sans signe de vie depuis 12 h est oubliée
const MAX_TASKS = 12;    // garde-fou si un PostToolUse se perd
const isTask = (n) => n === 'Task' || n === 'Agent';
const STATE = path.join(__dirname, '.state.json');

try {
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const now = Date.now();
  for (const s of saved.sessions ?? []) {
    if (now - s._ts > TTL) continue;
    live.set(s.session_id, { ...s, tasks: new Map(s.tasks ?? []) });
  }
  if (live.size) console.log(`  ${live.size} session(s) reprise(s) depuis .state.json`);
} catch { /* premier démarrage, ou état illisible : on repart à vide */ }

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const sessions = [...live.values()].map((s) => ({ ...s, tasks: [...s.tasks] }));
    fs.writeFile(STATE, JSON.stringify({ sessions }), () => {});
  }, 800);
  saveTimer.unref?.();
}

function remember(ev) {
  const sid = ev.session_id;
  if (!sid) return;
  if (ev.hook_event_name === 'SessionEnd') { live.delete(sid); persist(); return; }

  let s = live.get(sid);
  if (!s) { s = { session_id: sid, cwd: ev.cwd, tasks: new Map() }; live.set(sid, s); }
  if (ev.cwd) s.cwd = ev.cwd;
  s._ts = ev._ts;

  if (isTask(ev.tool_name) && ev.tool_use_id) {
    if (ev.hook_event_name === 'PreToolUse') {
      // On ne retient que l'essentiel : le prompt complet n'a rien à faire sur disque.
      s.tasks.set(ev.tool_use_id, {
        session_id: sid, cwd: ev.cwd, hook_event_name: 'PreToolUse',
        tool_name: ev.tool_name, tool_use_id: ev.tool_use_id,
        tool_input: {
          subagent_type: ev.tool_input?.subagent_type,
          description: ev.tool_input?.description,
        },
      });
    }
    if (ev.hook_event_name === 'PostToolUse') {
      const r = ev.tool_response ?? {}, t = s.tasks.get(ev.tool_use_id);
      // Lancement asynchrone : l'appel rend la main mais l'agent commence seulement.
      // On le garde, et on note son agentId pour le retirer à son vrai SubagentStop.
      if (r.isAsync || r.status === 'async_launched') { if (t) t.agentId = r.agentId; }
      else s.tasks.delete(ev.tool_use_id);
    }
    while (s.tasks.size > MAX_TASKS) s.tasks.delete(s.tasks.keys().next().value);
  }
  // Fin réelle d'un agent asynchrone
  if (ev.hook_event_name === 'SubagentStop' && ev.agent_id) {
    for (const [k, t] of s.tasks) if (t.agentId === ev.agent_id) s.tasks.delete(k);
  }
  for (const [k, v] of live) if (ev._ts - v._ts > TTL) live.delete(k);
  persist();
}

function broadcast(ev) {
  const msg = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(msg);
}

http.createServer((req, res) => {
  // Les hooks Claude Code postent ici le JSON reçu sur stdin
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        ev._ts = Date.now();
        remember(ev);
        broadcast(ev);
      } catch { /* JSON invalide : on ignore */ }
      res.writeHead(204).end();
    });
    return;
  }

  // Flux temps réel pour la page (Server-Sent Events)
  if (req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': hello\n\n');
    // Rejoue les sessions déjà ouvertes pour que la page se peuple immédiatement,
    // sans attendre qu'un agent bouge. On les présente comme des SessionStart :
    // l'îlot et son nom de projet sont reconstruits, l'activité reprend au vol.
    for (const s of live.values()) {
      res.write(`data: ${JSON.stringify({
        session_id: s.session_id, cwd: s.cwd, hook_event_name: 'SessionStart', source: 'replay',
      })}\n\n`);
      // Puis les sous-agents encore en vol, pour qu'ils réapparaissent à leur poste.
      // Le PostToolUse synthétique rend à la page l'agentId, dont elle a besoin pour
      // reconnaître le SubagentStop qui mettra fin à la mission.
      for (const ev of s.tasks.values()) {
        res.write(`data: ${JSON.stringify({ ...ev, _replay: true })}\n\n`);
        if (ev.agentId) res.write(`data: ${JSON.stringify({
          ...ev, hook_event_name: 'PostToolUse', _replay: true,
          tool_response: { isAsync: true, status: 'async_launched', agentId: ev.agentId },
        })}\n\n`);
      }
    }
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  // Diagnostic : ce que le serveur croit savoir des sessions ouvertes
  if (req.url === '/sessions') {
    const out = [...live.values()].map((s) => ({
      session_id: s.session_id, cwd: s.cwd, _ts: s._ts,
      subagents: [...s.tasks.values()].map((e) => e.tool_input?.subagent_type ?? 'agent'),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ clients: clients.size, sessions: out }, null, 2));
    return;
  }

  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) return res.writeHead(500).end('index.html introuvable');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(data);
    });
    return;
  }

  // Images posées à côté d'index.html (logo.png notamment). Nom de fichier simple
  // uniquement : pas de sous-dossier, pas de remontée de chemin.
  const asset = /^\/([A-Za-z0-9_-]+\.(png|jpg|jpeg|svg|webp))$/.exec(req.url);
  if (asset) {
    const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' };
    fs.readFile(path.join(__dirname, asset[1]), (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[asset[2]] }).end(data);
    });
    return;
  }

  res.writeHead(404).end();
}).listen(PORT, HOST, () => {
  console.log(`Claude Office → http://localhost:${PORT}`);
});
