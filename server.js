// Claude Office — le serveur de la flotte.
// Zero dependance. Node 18+.  Lancer : node server.js  → http://localhost:4317
//
//   agent d'un poste ──WS /ingest (assaini)──┐
//                                            ├──▶ etat en RAM ──SSE /stream──▶ index.html
//   hooks locaux ─────HTTP /event (brut)─────┘
//
// RIEN n'est stocke. Pas de base de donnees, pas de journal d'activite, pas d'etat
// de session sur disque : on recharge la page, tout disparait. Le seul element qui
// survit a un redemarrage est le ROSTER — la liste des metiers d'agents deja vus au
// moins une fois. C'est lui qui peuple l'open space et donne a la piece son animation ;
// il ne contient ni projet, ni poste, ni activite, juste des noms de metiers.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ws = require('./ws.js');
const { PROTOCOL_VERSION, sanitize } = require('./protocol.js');

const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || '127.0.0.1';
// Jeton que les agents presentent pour publier. Jamais vide : un /ingest ouvert sur
// 0.0.0.0 laisserait n'importe qui peupler la piece. Sans valeur fournie, on en tire
// un au hasard et on l'affiche au demarrage — zero configuration, mais pas ouvert.
const TOKEN = process.env.OFFICE_TOKEN || crypto.randomBytes(16).toString('hex');
const GENERATED_TOKEN = !process.env.OFFICE_TOKEN;
// Mot de passe de la page. Vide = libre, ce qui convient a un LAN ; on le remplit
// le jour ou le serveur prend une adresse publique.
const VIEW_PASSWORD = process.env.VIEW_PASSWORD || '';
const VIEW_USER = process.env.VIEW_USER || 'office';
// /event accepte des hooks BRUTS (avec prompts, commandes, chemins). Reserve a la
// boucle locale : l'ouvrir au reseau, ce serait precisement la fuite qu'on evite.
const ALLOW_REMOTE_EVENT = process.env.ALLOW_REMOTE_EVENT === '1';

const MACHINE_TIMEOUT = 45e3;  // sans signe de vie : le poste est considere parti
// Delai de grace apres une coupure brutale, avant de demonter les ilots du poste.
// Reglable surtout pour les tests, qui ne vont pas attendre vingt secondes.
const OFFLINE_GRACE = Number(process.env.OFFLINE_GRACE) || 20e3;
// Periode du ping qui revele les sockets mortes. Reglable pour les memes raisons.
const SWEEP_EVERY = Number(process.env.SWEEP_EVERY) || 15e3;
// Combien de temps on garde les ilots d'un poste qui ne repond plus. Pendant ce
// delai ses gens sont en pause ; apres, on admet qu'il ne reviendra pas. Une heure
// couvre un dejeuner et une reunion sans laisser trainer les machines eteintes
// pour la nuit.
const ABSENT_TTL = Number(process.env.ABSENT_TTL) || 3600e3;
// Deplacable : dans un conteneur, c'est le seul fichier a monter sur un volume.
const ROSTER_FILE = process.env.ROSTER_FILE || path.join(__dirname, '.roster.json');

/* ======================= Le roster (seule chose persistee) ======================= */

const roster = new Map(); // type -> { type, since }
try {
  for (const a of JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8')).roster ?? []) {
    if (a && typeof a.type === 'string') roster.set(a.type, { type: a.type, since: a.since || 0 });
  }
  if (roster.size) console.log(`  ${roster.size} metier(s) repris du roster`);
} catch { /* premier demarrage, ou roster illisible : la maison part vide */ }

let rosterTimer = null;
function hire(type) {
  if (!type || roster.has(type)) return false;
  roster.set(type, { type, since: Date.now() });
  clearTimeout(rosterTimer);
  rosterTimer = setTimeout(() => {
    fs.writeFile(ROSTER_FILE, JSON.stringify({ roster: [...roster.values()] }), () => {});
  }, 800);
  rosterTimer.unref?.();
  broadcast({ hook_event_name: 'Staff', staff: [...roster.keys()] });
  return true;
}

/* ======================= L'etat vivant (RAM uniquement) ======================= */

// machine -> { name, since, lastSeen, sock, usage, sessions: Map }
//   session -> { session, project, tasks: Map(ref -> { agent, agentId }) }
const machines = new Map();

const clients = new Set();       // navigateurs abonnes au flux SSE
const SAFE_NAME = /^[A-Za-z0-9 ._-]{1,32}$/;

function machineOf(name) {
  let m = machines.get(name);
  if (!m) {
    m = { name, since: Date.now(), lastSeen: Date.now(), sock: null, usage: null, sessions: new Map() };
    machines.set(name, m);
  }
  m.lastSeen = Date.now();
  return m;
}

function broadcast(ev) {
  const msg = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(msg);
}

/* ======================= Du fil a la page ======================= */

// Libelles generiques : en mode flotte la page n'a RIEN a afficher du contenu, donc
// elle affiche l'activite. C'est exactement ce qu'on veut voir — quelqu'un travaille,
// quelqu'un attend, quelqu'un est au repos — sans savoir sur quoi.
const LABELS = {
  read: '🔎 cherche', type: '⌨️ code', term: '🖥️ console',
  web: '🌐 consulte', plan: '📝 planifie', think: '💭 réfléchit',
};

// Deplie un evenement du fil en evenement de hook, la forme que la page parle.
// L'identifiant de session porte le nom du poste : deux PC ne peuvent pas se
// marcher dessus, et l'ilot sait de quelle machine il vient.
function expand(ev) {
  const out = {
    session_id: ev.machine + ':' + ev.session,
    machine: ev.machine,
    hook_event_name: ev.event,
    fleet: true,
    _ts: ev.ts || Date.now(),
  };
  if (ev.project) out.cwd = ev.project;
  if (typeof ev.bg === 'number' && ev.bg >= 0) {
    out.background_tasks = Array.from({ length: ev.bg }, () => ({ status: 'running' }));
  }

  if (ev.event === 'UserPromptSubmit') {
    // Le prompt n'a pas quitte le poste. Seul « il demandait une pause cafe » est
    // arrive jusqu'ici, et il suffit a envoyer le lead au mange-debout.
    out.prompt = ev.coffee ? 'pause' : '';
    out.act = 'think';
    out.label = '💭 nouvelle consigne';
    return out;
  }

  if (ev.event === 'PreToolUse' || ev.event === 'PostToolUse') {
    out.act = ev.act || 'think';
    if (ev.ref) out.tool_use_id = ev.ref;
    if (out.act === 'task') {
      out.tool_name = 'Agent';
      out.tool_input = { subagent_type: ev.agent || 'agent' };
      if (ev.async) out.tool_response = { isAsync: true, status: 'async_launched', agentId: ev.agentId };
    } else {
      out.label = LABELS[out.act] || LABELS.think;
      if (Number.isFinite(ev.ms)) out.duration_ms = ev.ms;
    }
    return out;
  }

  if (ev.event === 'SubagentStop' && ev.agentId) out.agent_id = ev.agentId;
  return out;
}

// Applique un evenement du fil : met a jour ce que le serveur croit savoir du poste
// (necessaire pour la reconciliation et pour demonter les ilots quand il part), puis
// le relaie aux navigateurs.
function applyEvent(m, ev) {
  ev.machine = m.name;
  const key = ev.session;
  if (!key) return;

  if (ev.event === 'SessionEnd') m.sessions.delete(key);
  else {
    let s = m.sessions.get(key);
    if (!s) { s = { session: key, project: ev.project || '', tasks: new Map() }; m.sessions.set(key, s); }
    if (ev.project) s.project = ev.project;

    if (ev.act === 'task' && ev.ref) {
      if (ev.event === 'PreToolUse') {
        hire(ev.agent || 'agent');
        s.tasks.set(ev.ref, { agent: ev.agent || 'agent', agentId: null });
      } else if (ev.event === 'PostToolUse') {
        // Lancement asynchrone : l'appel rend la main mais l'agent commence seulement.
        if (ev.async) { const t = s.tasks.get(ev.ref); if (t) t.agentId = ev.agentId || null; }
        else s.tasks.delete(ev.ref);
      }
    }
    if (ev.event === 'SubagentStop' && ev.agentId) {
      for (const [k, t] of s.tasks) if (t.agentId === ev.agentId) s.tasks.delete(k);
    }
  }
  broadcast(expand(ev));
}

/* ======================= Reconciliation par instantane ======================= */

// Un evenement perdu sur le reseau laisserait un agent assis a son bureau pour
// l'eternite. Le poste reenvoie donc regulierement l'etat complet de ce qu'il voit ;
// on le compare a ce qu'on croyait, et on n'emet QUE les corrections. Sans ca, le
// seul remede a un PostToolUse egare serait de recharger la page.
function applySnapshot(m, snap) {
  const seen = new Set();
  for (const s of snap.sessions ?? []) {
    if (!s || typeof s.session !== 'string') continue;
    seen.add(s.session);
    let cur = m.sessions.get(s.session);
    if (!cur) {
      cur = { session: s.session, project: s.project || '', tasks: new Map() };
      m.sessions.set(s.session, cur);
      broadcast(expand({ machine: m.name, session: s.session, project: cur.project,
        event: 'SessionStart', ts: Date.now() }));
    }
    const tasks = new Map();
    for (const t of s.tasks ?? []) {
      if (!t || typeof t.ref !== 'string') continue;
      tasks.set(t.ref, { agent: t.agent || 'agent', agentId: t.agentId || null });
    }
    // Missions que le poste voit et que nous avions ratees
    for (const [ref, t] of tasks) {
      if (cur.tasks.has(ref)) continue;
      hire(t.agent);
      cur.tasks.set(ref, t);
      broadcast(expand({ machine: m.name, session: s.session, event: 'PreToolUse',
        act: 'task', ref, agent: t.agent, ts: Date.now() }));
      if (t.agentId) {
        broadcast(expand({ machine: m.name, session: s.session, event: 'PostToolUse',
          act: 'task', ref, agent: t.agent, async: true, agentId: t.agentId, ts: Date.now() }));
      }
    }
    // Missions finies sans qu'on l'apprenne : on libere le bureau
    for (const ref of [...cur.tasks.keys()]) {
      if (tasks.has(ref)) continue;
      cur.tasks.delete(ref);
      broadcast(expand({ machine: m.name, session: s.session, event: 'PostToolUse',
        act: 'task', ref, ts: Date.now() }));
    }
  }
  // Sessions fermees sans qu'on l'apprenne : on demonte l'ilot
  for (const key of [...m.sessions.keys()]) {
    if (seen.has(key)) continue;
    m.sessions.delete(key);
    broadcast(expand({ machine: m.name, session: key, event: 'SessionEnd', ts: Date.now() }));
  }
}

// Un poste qui se tait n'est PAS un poste parti. Veille, wifi coupe, fenetre
// fermee : dans tous ces cas la session Claude existe toujours quelque part, elle
// ne nous parle simplement plus. On met donc ses gens en pause, et on garde l'ilot.
// Ce n'est qu'au bout d'ABSENT_TTL qu'on admet que le poste ne reviendra pas.
function markAbsent(m, why) {
  if (m.absent) return;
  m.absent = true;
  broadcast({ hook_event_name: 'MachineOffline', machine: m.name, fleet: true, _ts: Date.now() });
  console.log(`  ~ ${m.name} ne repond plus (${why}) — ses agents passent en pause`);
}

function markPresent(m) {
  if (!m.absent) return;
  m.absent = false;
  broadcast({ hook_event_name: 'MachineOnline', machine: m.name, fleet: true, _ts: Date.now() });
  console.log(`  → ${m.name} est de retour`);
}

// Depart pour de bon : ses ilots n'ont plus personne pour les animer, on les demonte.
function dropMachine(m, why) {
  clearTimeout(m.graceTimer); m.graceTimer = null;
  clearTimeout(m.absentTimer); m.absentTimer = null;
  for (const key of m.sessions.keys()) {
    broadcast(expand({ machine: m.name, session: key, event: 'SessionEnd', ts: Date.now() }));
  }
  machines.delete(m.name);
  console.log(`  ← ${m.name} s'en va (${why})`);
}

// Un poste dont le WebSocket est tombe sans fermeture propre (cable debranche, PC
// en veille) : cote serveur, la connexion a l'air parfaitement ouverte. Rien ne
// revele une socket morte sauf une ecriture — d'ou ce ping periodique, qui echoue
// et declenche la fermeture. C'est la seule facon de s'en apercevoir autrement
// qu'au bout des longues minutes du TCP.
//
// Compter : jusqu'a SWEEP_EVERY pour s'en apercevoir, puis OFFLINE_GRACE avant que
// ses gens passent en pause. Une machine qui plante se fige donc en 35 s au pire,
// et son emplacement n'est rendu qu'apres ABSENT_TTL.
setInterval(() => {
  const now = Date.now();
  for (const m of [...machines.values()]) {
    if (m.sock && m.sock.open) { m.sock.ping(); continue; }
    // Une minuterie court deja pour ce poste : elle sait quoi faire et quand. Ce
    // filet ne sert qu'aux machines arrivees la sans passer par onClose.
    if (m.graceTimer || m.absentTimer) continue;
    if (now - m.lastSeen > MACHINE_TIMEOUT) markAbsent(m, 'silence');
  }
}, SWEEP_EVERY).unref?.();

/* ======================= Meteo ======================= */
// Open-Meteo : pas de cle d'API, pas de compte. C'est le SEUL appel sortant de ce
// serveur. Ce qui part : le nom de la ville, puis des coordonnees. Rien d'autre —
// ni poste, ni projet, ni activite.
const CITY = process.env.CITY || 'Paris';
const geoCache = new Map();
let wxCache = null;
const WX_TTL = 10 * 60e3;

async function geocode(city) {
  if (geoCache.has(city)) return geoCache.get(city);
  const u = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=fr&format=json'
    + '&name=' + encodeURIComponent(city);
  const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
  const g = (await r.json()).results?.[0];
  if (!g) throw new Error('ville introuvable : ' + city);
  const out = { lat: g.latitude, lon: g.longitude, name: g.name, country: g.country };
  geoCache.set(city, out);
  return out;
}

async function weather(city) {
  if (wxCache && wxCache.city === city && Date.now() - wxCache.at < WX_TTL) return wxCache.data;
  const g = await geocode(city);
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}`
    + '&current=weather_code,temperature_2m,cloud_cover,wind_speed_10m'
    + '&daily=sunrise,sunset&timezone=auto&forecast_days=1';
  const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
  const j = await r.json();
  if (!j.current) throw new Error('reponse meteo inattendue');
  const data = {
    city: g.name, country: g.country,
    code: j.current.weather_code, temp: j.current.temperature_2m,
    clouds: j.current.cloud_cover, wind: j.current.wind_speed_10m,
    sunrise: j.daily?.sunrise?.[0] ?? null, sunset: j.daily?.sunset?.[0] ?? null,
    tz: j.timezone, at: Date.now(),
  };
  wxCache = { city, at: Date.now(), data };
  return data;
}

/* ======================= Usage des 5 h ======================= */
// Deux sources, dans cet ordre :
//  - les transcripts locaux, quand le serveur tourne sur une machine de dev ;
//  - sinon la somme de ce que les postes rapportent (dans un conteneur, ~/.claude
//    n'existe pas : scanner le disque ne donnerait rien).
// Dans les deux cas on ne lit QUE l'horodatage et le bloc `usage`. Jamais un message.
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const WINDOW = 5 * 3600e3;
const KEEP = 12 * 3600e3;
const HAS_TRANSCRIPTS = (() => { try { return fs.statSync(PROJECTS).isDirectory(); } catch { return false; } })();
const seen = new Map();
let samples = [];
let usageAt = 0;

function scanUsage() {
  const cut = Date.now() - KEEP;
  const files = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(PROJECTS);

  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < cut) { seen.delete(f); continue; }
    let off = seen.get(f) ?? 0;
    if (st.size < off) off = 0;
    if (st.size === off) continue;
    let chunk;
    try {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(st.size - off);
      fs.readSync(fd, buf, 0, buf.length, off);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch { continue; }
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) continue;
    seen.set(f, off + Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf8'));
    for (const l of chunk.slice(0, lastNl).split('\n')) {
      if (!l.trim()) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      const u = j.message?.usage; if (!u) continue;
      const t = Date.parse(j.timestamp || '');
      if (!Number.isFinite(t)) continue;
      samples.push({ t, tok: (u.input_tokens || 0) + (u.output_tokens || 0)
        + (u.cache_creation_input_tokens || 0) });
    }
  }
  samples = samples.filter((x) => x.t >= cut).sort((a, b) => a.t - b.t);
}

// Le bloc de 5 h est ANCRE, pas glissant : il s'ouvre a un message et dure cinq
// heures, puis le message suivant en ouvre un neuf.
function blockStartOf(list, now) {
  if (!list.length) return now;
  let start = list[0].t;
  for (const x of list) if (x.t >= start + WINDOW) start = x.t;
  return start;
}

function localUsage() {
  if (Date.now() - usageAt > 20e3) { scanUsage(); usageAt = Date.now(); }
  const now = Date.now();
  let start = blockStartOf(samples, now);
  if (now >= start + WINDOW) start = now;
  const win = samples.filter((x) => x.t >= start && x.t < start + WINDOW);
  return {
    tokens: win.reduce((n, x) => n + x.tok, 0),
    messages: win.length,
    blockStart: start, blockEnd: start + WINDOW,
    elapsed: Math.min(1, Math.max(0, (now - start) / WINDOW)),
    now,
  };
}

// En flotte, chaque poste a SON bloc de 5 h, demarre a une heure differente. Les
// additionner donnerait une fenetre qui ne veut rien dire : on somme la consommation
// et on retient l'avancement du poste le plus engage dans son bloc.
function fleetUsage() {
  const now = Date.now();
  let tokens = 0, messages = 0, elapsed = 0;
  const per = [];
  for (const m of machines.values()) {
    const u = m.usage;
    if (!u || now > u.blockEnd) continue;
    tokens += u.tokens || 0;
    messages += u.messages || 0;
    elapsed = Math.max(elapsed, u.elapsed || 0);
    per.push({ machine: m.name, tokens: u.tokens || 0, elapsed: u.elapsed || 0 });
  }
  return { fleet: true, tokens, messages, elapsed, machines: per, now };
}

const usageNow = () => (HAS_TRANSCRIPTS ? localUsage() : fleetUsage());

/* ======================= Entree des agents (WebSocket) ======================= */

// Comparaison a temps constant : un jeton ne se devine pas a la milliseconde pres.
function tokenOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ingestRoute(req) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return null; }
  if (url.pathname !== '/ingest') return null;
  const given = url.searchParams.get('token')
    || (req.headers.authorization || '').replace(/^Bearer /i, '');
  if (!tokenOk(given)) return null;
  const name = (url.searchParams.get('machine') || '').trim();
  if (!SAFE_NAME.test(name)) return null;
  return { name };
}

function onAgent(sock, ctx) {
  // Un poste qui se reconnecte remplace le precedent : sans ca, deux connexions
  // pour la meme machine se marcheraient dessus apres une coupure reseau.
  const old = machines.get(ctx.name);
  if (old && old.sock && old.sock !== sock) {
    // La fermeture de l'ancienne connexion ne doit RIEN demonter : le poste est
    // toujours la, il vient juste de se rebrancher. On la debranche de son gestionnaire
    // avant de la fermer, sinon elle serait lue comme un depart propre et ferait
    // tomber les ilots une fraction de seconde avant que la nouvelle les remonte.
    const stale = old.sock;
    old.sock = null;
    stale.onClose = () => {};
    stale.close(1000, 'remplace');
  }
  const m = machineOf(ctx.name);
  // Retour du poste : on annule les deux minuteries, et on rappelle ses gens du
  // cafe si on les y avait envoyes. L'instantane qui suit remet l'etat d'aplomb.
  clearTimeout(m.graceTimer); m.graceTimer = null;
  clearTimeout(m.absentTimer); m.absentTimer = null;
  markPresent(m);
  m.sock = sock;
  console.log(`  → ${ctx.name} se connecte`);

  sock.onText = (text) => {
    m.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.v && msg.v !== PROTOCOL_VERSION) return; // protocole different : on ignore

    if (msg.type === 'event') { applyEvent(m, { ...msg, machine: m.name }); return; }
    if (msg.type === 'snapshot') { applySnapshot(m, msg); return; }
    if (msg.type === 'usage') {
      m.usage = {
        tokens: Number(msg.tokens) || 0, messages: Number(msg.messages) || 0,
        blockStart: Number(msg.blockStart) || 0, blockEnd: Number(msg.blockEnd) || 0,
        elapsed: Number(msg.elapsed) || 0,
      };
      return;
    }
    if (msg.type === 'hello') { sock.send(JSON.stringify({ type: 'welcome', v: PROTOCOL_VERSION })); return; }
  };

  // Le poste se tait : ses gens passent en pause, l'ilot reste. Deux minuteries.
  //
  // La premiere decide QUAND l'annoncer. Une fermeture propre est deliberee, on le
  // dit tout de suite ; une coupure brutale attend OFFLINE_GRACE, sinon un hoquet
  // de reseau de deux secondes enverrait tout le monde au cafe pour en revenir
  // aussitot — une convulsion pour une broutille.
  //
  // La seconde decide QUAND renoncer. Au bout d'ABSENT_TTL sans retour, le poste
  // est considere parti et son emplacement est rendu.
  sock.onClose = (code) => {
    if (m.sock !== sock) return;
    m.sock = null;
    const propre = code === 1000;
    const quand = propre ? 0 : OFFLINE_GRACE;
    if (!propre) console.log(`  ~ ${m.name} a decroche, on attend ${OFFLINE_GRACE / 1000} s`);

    clearTimeout(m.graceTimer);
    m.graceTimer = setTimeout(() => {
      if (machines.get(m.name) === m && !m.sock) markAbsent(m, propre ? 'arret' : 'coupure');
    }, quand);
    m.graceTimer.unref?.();

    clearTimeout(m.absentTimer);
    m.absentTimer = setTimeout(() => {
      if (machines.get(m.name) === m && !m.sock) dropMachine(m, 'absent trop longtemps');
    }, ABSENT_TTL);
    m.absentTimer.unref?.();
  };
}

/* ======================= HTTP ======================= */

const isLoopback = (req) => {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

// Mot de passe de la page. Vide = pas de controle : c'est le mode LAN.
function viewOk(req) {
  if (!VIEW_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const want = Buffer.from(VIEW_USER + ':' + VIEW_PASSWORD);
  const got = Buffer.from((u || '') + ':' + (p || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const server = http.createServer((req, res) => {
  // Hooks locaux, charge utile BRUTE. Boucle locale uniquement, sauf demande
  // explicite : ce qui arrive ici contient les prompts et les commandes.
  if (req.method === 'POST' && req.url === '/event') {
    if (!isLoopback(req) && !ALLOW_REMOTE_EVENT) return res.writeHead(403).end();
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        ev._ts = Date.now();
        // Le roster se nourrit aussi du mode local.
        if ((ev.tool_name === 'Task' || ev.tool_name === 'Agent')
          && ev.hook_event_name === 'PreToolUse') hire(ev.tool_input?.subagent_type || 'agent');
        broadcast(ev); // mode local : la page a droit au detail, rien ne sort de la machine
      } catch { /* JSON invalide : on ignore */ }
      res.writeHead(204).end();
    });
    return;
  }

  // Sonde de sante, AVANT le mot de passe : un orchestrateur n'a pas de compte, et
  // un 401 ne dit pas si le serveur va bien. Elle ne revele rien — ni poste, ni
  // projet, ni activite.
  if (req.url === '/health') {
    return res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok: true, v: PROTOCOL_VERSION, machines: machines.size }));
  }

  // La page d'installation, servie par le serveur lui-meme : un collegue a qui l'on
  // donne l'adresse du bureau y trouve aussi comment s'y brancher. Hors mot de passe
  // pour la meme raison — il ne l'a pas encore.
  if (req.url === '/install' || req.url === '/install.html') {
    return fs.readFile(path.join(__dirname, 'install.html'), (err, data) => {
      if (err) return res.writeHead(404).end('install.html introuvable');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(data);
    });
  }

  if (!viewOk(req)) {
    return res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Claude Office"' })
      .end('Mot de passe requis');
  }

  // Flux temps reel pour la page (Server-Sent Events).
  if (req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': hello\n\n');
    // Le roster, et rien d'autre. Aucune session n'est rejouee : une page
    // rechargee repart d'une piece vide, et se repeuple au premier signe de vie
    // des postes — les instantanes s'en chargent en moins de dix secondes.
    if (roster.size) res.write(`data: ${JSON.stringify({
      hook_event_name: 'Staff', staff: [...roster.keys()],
    })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (req.url.startsWith('/weather')) {
    let city = CITY;
    try { city = new URL(req.url, 'http://x').searchParams.get('city') || CITY; } catch { /* url bancale */ }
    weather(city)
      .then((d) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(d)))
      .catch((e) => res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ offline: true, city, error: String(e && e.message || e) })));
    return;
  }

  if (req.url === '/usage') {
    let out;
    try { out = usageNow(); } catch (e) { out = { error: String(e && e.message || e) }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    return;
  }

  // Diagnostic : ce que le serveur croit savoir, a l'instant.
  if (req.url === '/sessions') {
    const out = [...machines.values()].map((m) => ({
      machine: m.name, online: !!(m.sock && m.sock.open), absent: !!m.absent,
      lastSeen: m.lastSeen,
      sessions: [...m.sessions.values()].map((s) => ({
        session: s.session, project: s.project,
        subagents: [...s.tasks.values()].map((t) => t.agent),
      })),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ v: PROTOCOL_VERSION, clients: clients.size,
        roster: [...roster.keys()], machines: out }, null, 2));
    return;
  }

  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) return res.writeHead(500).end('index.html introuvable');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(data);
    });
    return;
  }

  // Fichiers poses a cote d'index.html (logo.png notamment). Nom simple uniquement :
  // pas de sous-dossier, pas de remontee de chemin.
  const asset = /^\/([A-Za-z0-9_-]+\.(png|jpg|jpeg|svg|webp|mp3|ogg|m4a|wav))$/.exec(req.url);
  if (asset) {
    const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml',
      webp: 'image/webp', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav' };
    fs.readFile(path.join(__dirname, asset[1]), (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[asset[2]] }).end(data);
    });
    return;
  }

  res.writeHead(404).end();
});

ws.attach(server, { route: ingestRoute, onOpen: onAgent });

server.listen(PORT, HOST, () => {
  console.log(`Claude Office → http://localhost:${PORT}`);
  console.log(`  meteo : ${CITY}  (CITY=... pour en changer, ?city=... pour un essai)`);
  console.log(`  usage : ${HAS_TRANSCRIPTS ? 'transcripts locaux' : 'rapporte par les postes'}`);
  console.log(`  page  : ${VIEW_PASSWORD ? 'protegee (' + VIEW_USER + ')' : 'libre'}`);
  if (GENERATED_TOKEN) {
    console.log(`\n  Jeton des agents (tire au hasard, fixez OFFICE_TOKEN pour le garder) :`);
    console.log(`    ${TOKEN}\n`);
  }
});

module.exports = { server };
