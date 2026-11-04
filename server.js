// Claude Office — pont entre les hooks de Claude Code et la vue three.js
// Zéro dépendance. Node 18+.  Lancer : node server.js  → http://localhost:4317
const http = require('http');
const fs = require('fs');
const os = require('os');
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
// L'effectif de la maison : tous les types d'agents deja appeles au moins une fois.
// La page en fait des employes permanents. Sans cette memoire, un rechargement
// viderait l'open space de tous ceux qui ne sont pas sur un dossier a cet instant.
const staff = new Map(); // type -> { type, since }
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
  for (const a of saved.staff ?? []) staff.set(a.type, a);
  if (live.size) console.log(`  ${live.size} session(s) reprise(s) depuis .state.json`);
  if (staff.size) console.log(`  ${staff.size} employe(s) repris depuis .state.json`);
} catch { /* premier démarrage, ou état illisible : on repart à vide */ }

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const sessions = [...live.values()].map((s) => ({ ...s, tasks: [...s.tasks] }));
    fs.writeFile(STATE, JSON.stringify({ sessions, staff: [...staff.values()] }), () => {});
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
      // Premiere apparition de ce metier : il entre a l'effectif, et n'en sort plus.
      const type = ev.tool_input?.subagent_type || 'agent';
      if (!staff.has(type)) staff.set(type, { type, since: ev._ts });
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


/* ======================= Meteo ======================= */
// Open-Meteo : pas de cle d'API, pas de compte. C'est le SEUL appel sortant de ce
// serveur. Ce qui part : le nom de la ville, puis des coordonnees. Rien d'autre —
// ni chemin, ni nom de projet, ni contenu de session.
const CITY = process.env.CITY || 'Paris';
const geoCache = new Map();   // ville -> coordonnees, valable pour la vie du process
let wxCache = null;           // { ville, at, data }
const WX_TTL = 10 * 60e3;     // la meteo ne change pas toutes les secondes

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
  // On renvoie lever et coucher reels : c'est eux qui decideront d'allumer les lampes,
  // plutot que des heures fixes qui seraient fausses en decembre comme en juin.
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
// Lit les transcripts de Claude Code pour n'en extraire QUE deux choses par ligne :
// l'horodatage et le bloc `usage`. Le contenu des messages n'est jamais lu, jamais
// retenu, jamais servi — et rien de tout ca ne quitte la machine.
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const WINDOW = 5 * 3600e3;   // duree d'un bloc
// On garde plus que la duree d'un bloc : pour savoir OU commence le bloc courant, il
// faut pouvoir remonter au message qui l'a ouvert, et il peut dater de presque 5 h.
const KEEP = 12 * 3600e3;
const seen = new Map();  // fichier -> decalage deja lu
let samples = [];        // { t, tok } encore dans la fenetre
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
    if (st.mtimeMs < cut) { seen.delete(f); continue; } // trop vieux pour compter
    let off = seen.get(f) ?? 0;
    if (st.size < off) off = 0;          // fichier reecrit : on repart du debut
    if (st.size === off) continue;       // rien de neuf
    let chunk;
    try {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(st.size - off);
      fs.readSync(fd, buf, 0, buf.length, off);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch { continue; }
    // Un transcript est un journal en ajout seul : on ne relit que ce qui s'est ecrit
    // depuis le dernier passage, et on s'arrete a la derniere ligne COMPLETE — la
    // suivante est peut-etre en cours d'ecriture, elle sera lue au prochain tour.
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) continue;
    seen.set(f, off + Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf8'));
    for (const l of chunk.slice(0, lastNl).split('\n')) {
      if (!l.trim()) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      const u = j.message?.usage; if (!u) continue;
      const t = Date.parse(j.timestamp || '');
      if (!Number.isFinite(t)) continue;
      // Le cache_read n'est pas compte : il represente le contexte relu, pas le travail.
      samples.push({ t, tok: (u.input_tokens || 0) + (u.output_tokens || 0)
        + (u.cache_creation_input_tokens || 0) });
    }
  }
  samples = samples.filter((x) => x.t >= cut).sort((a, b) => a.t - b.t);
}

// Le bloc de 5 h est ANCRE, pas glissant : il s'ouvre a un message et dure cinq heures,
// puis le message suivant en ouvre un neuf. Une fenetre glissante donnerait un
// indicateur colle a 100 % des qu'on travaille plus de cinq heures d'affilee, puisque
// le plus ancien message aurait toujours exactement cinq heures.
function blockStartOf(list, now) {
  if (!list.length) return now;
  let start = list[0].t;
  for (const x of list) if (x.t >= start + WINDOW) start = x.t; // ce message ouvre un bloc
  return start;
}

function usageNow() {
  if (Date.now() - usageAt > 20e3) { scanUsage(); usageAt = Date.now(); }
  const now = Date.now();
  let start = blockStartOf(samples, now);
  // Bloc arrive a terme sans qu'un nouveau message l'ait relance : on est a zero d'un
  // bloc qui n'a pas encore commence, pas a 100 % d'un bloc fini.
  if (now >= start + WINDOW) start = now;
  const win = samples.filter((x) => x.t >= start && x.t < start + WINDOW);
  return {
    tokens: win.reduce((n, x) => n + x.tok, 0),
    messages: win.length,
    blockStart: start,
    blockEnd: start + WINDOW,
    elapsed: Math.min(1, Math.max(0, (now - start) / WINDOW)),
    now,
  };
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
    // L'effectif d'abord : la page reconstitue la maison, puis on y pose les dossiers.
    if (staff.size) res.write(`data: ${JSON.stringify({
      hook_event_name: 'Staff', staff: [...staff.keys()],
    })}\n\n`);
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

  // Meteo de la ville choisie. Hors ligne ou ville inconnue : on repond quand meme,
  // avec offline:true, pour que la page continue sans meteo plutot que de casser.
  if (req.url.startsWith('/weather')) {
    let city = CITY;
    try { city = new URL(req.url, 'http://x').searchParams.get('city') || CITY; } catch { /* url bancale */ }
    weather(city)
      .then((d) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(d)))
      .catch((e) => res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ offline: true, city, error: String(e && e.message || e) })));
    return;
  }

  // Consommation sur la fenetre glissante de 5 h.
  if (req.url === '/usage') {
    let out;
    try { out = usageNow(); } catch (e) { out = { error: String(e && e.message || e) }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    return;
  }

  // Diagnostic : ce que le serveur croit savoir des sessions ouvertes
  if (req.url === '/sessions') {
    const out = [...live.values()].map((s) => ({
      session_id: s.session_id, cwd: s.cwd, _ts: s._ts,
      subagents: [...s.tasks.values()].map((e) => e.tool_input?.subagent_type ?? 'agent'),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ clients: clients.size, staff: [...staff.keys()], sessions: out }, null, 2));
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
}).listen(PORT, HOST, () => {
  console.log(`Claude Office → http://localhost:${PORT}`);
  console.log(`  meteo : ${CITY}  (CITY=... pour en changer, ?city=... pour un essai)`);
});
