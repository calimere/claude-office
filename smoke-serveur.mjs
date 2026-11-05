// Test de fumee du cote serveur : le contrat, le WebSocket, et le trajet complet
// d'un poste jusqu'a la page.
//
//   node smoke-serveur.mjs
//
// Le premier bloc est le plus important du fichier : il verifie qu'AUCUN contenu ne
// franchit l'assainisseur. Une regression la-dessus ne casse rien de visible — elle
// se contente d'envoyer les prompts de toute l'equipe sur le reseau.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

// Un client WebSocket de fortune : ouvrir, envoyer une trame masquee, arracher la
// prise. Le client WebSocket de Node ne sait pas faire la derniere : il refuse de
// fermer avec le code 1006 (reserve) et ne donne pas acces a sa socket. Or c est
// exactement ce qu il faut simuler — un cable debranche ne previent personne.
function rawWS(port, path) {
  return new Promise((done, fail) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET ' + path + ' HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n'
        + 'Connection: Upgrade\r\nSec-WebSocket-Key: '
        + crypto.randomBytes(16).toString('base64')
        + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = '';
    const onData = (d) => {
      buf += d;
      if (!buf.includes('\r\n\r\n')) return;
      s.off('data', onData);
      if (!buf.startsWith('HTTP/1.1 101')) return fail(new Error(buf.split('\r\n')[0]));
      done({
        send(text) {
          const p = Buffer.from(text, 'utf8');
          const mask = crypto.randomBytes(4);
          let head;
          if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length]);
          else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
          const body = Buffer.from(p);
          for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
          s.write(Buffer.concat([head, mask, body]));
        },
        kill() { s.destroy(); },
      });
    };
    s.on('data', onData);
    s.on('error', fail);
  });
}

const require = createRequire(import.meta.url);
const proto = require('./protocol.js');
const wslib = require('./ws.js');

let ok = 0, ko = 0;
const check = (name, cond, extra) => {
  if (cond) { ok++; console.log('OK     ' + name); }
  else { ko++; console.log('ECHEC  ' + name + (extra === undefined ? '' : ' — ' + JSON.stringify(extra))); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 1. Le contrat : rien de confidentiel ne passe ================= */

const SECRETS = ['rm -rf /srv/prod', 'refacto du module de paie', 'salaires.xlsx',
  'C:\\dev\\client-confidentiel', 'Atlassian_MCP', 'resume de la tache secrete'];

const hooks = [
  { hook_event_name: 'UserPromptSubmit', session_id: 'aaaabbbb-1111', cwd: 'C:\\dev\\client-confidentiel\\paie',
    prompt: 'refacto du module de paie' },
  { hook_event_name: 'PreToolUse', session_id: 'aaaabbbb-1111', cwd: '/srv/prod/app',
    tool_name: 'Bash', tool_input: { command: 'rm -rf /srv/prod' }, tool_use_id: 'x1' },
  { hook_event_name: 'PreToolUse', session_id: 'aaaabbbb-1111',
    tool_name: 'Read', tool_input: { file_path: '/home/rh/salaires.xlsx' }, tool_use_id: 'x2' },
  { hook_event_name: 'PreToolUse', session_id: 'aaaabbbb-1111',
    tool_name: 'mcp__claude_ai_Atlassian_MCP__getJiraIssue', tool_input: { issue: 'SEC-1' } },
  { hook_event_name: 'PreToolUse', session_id: 'aaaabbbb-1111', tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', description: 'resume de la tache secrete' }, tool_use_id: 'x3' },
  { hook_event_name: 'Notification', session_id: 'aaaabbbb-1111',
    message: 'Claude a besoin de ta permission pour git push' },
];

const wire = hooks.map((h) => proto.sanitize(h, 'poste-1'));
const blob = JSON.stringify(wire);
for (const s of SECRETS) check('« ' + s.slice(0, 28) + ' » ne franchit pas l assainisseur', !blob.includes(s));
check('le chemin complet ne sort pas, seul le projet', blob.includes('"paie"') && !blob.includes('client-confidentiel'));
check('le metier de l agent delegue sort, lui', wire[4].agent === 'Explore');
check('un hook inconnu n est pas relaye par defaut',
  proto.sanitize({ hook_event_name: 'QuelqueChoseDeNeuf', session_id: 'a' }, 'p') === null);
check('un evenement sans session est refuse',
  proto.sanitize({ hook_event_name: 'Stop' }, 'p') === null);

// La table des activites doit rester le miroir de describe() dans index.html.
const ACT = { Read: 'read', Grep: 'read', Write: 'type', Edit: 'type', Bash: 'term',
  PowerShell: 'term', WebFetch: 'web', WebSearch: 'web', TodoWrite: 'plan',
  Agent: 'task', Task: 'task', mcp__x__y: 'web', TrucInconnu: 'think' };
let actsOk = true;
for (const [tool, act] of Object.entries(ACT)) if (proto.actOf(tool) !== act) { actsOk = false; console.log('   ' + tool + ' -> ' + proto.actOf(tool) + ', attendu ' + act); }
check('la table des activites correspond a describe()', actsOk);

check('la pause cafe est reconnue, pas une phrase qui en parle',
  proto.isCoffeeCmd('va boire un café') && !proto.isCoffeeCmd('ajoute un bouton café'));
check('le projet est le dernier segment, quel que soit le separateur',
  proto.projectOf('C:\\dev\\gitlab-rd\\protrack') === 'protrack'
  && proto.projectOf('/home/x/mon-projet/') === 'mon-projet');

/* ================= 2. WebSocket : le vecteur de test de la RFC 6455 ================= */

// Une poignee de main fausse se traduit par une connexion qui se ferme sans
// explication. Ce vecteur est la seule facon de s en apercevoir tout de suite.
{
  const srv = http.createServer((q, r) => r.writeHead(404).end());
  wslib.attach(srv, {
    route: (q) => (q.url.startsWith('/ok') ? {} : null),
    onOpen: (sock) => { sock.onText = (t) => sock.send('echo:' + t.length); },
  });
  await new Promise((done) => srv.listen(0, '127.0.0.1', done));
  const port = srv.address().port;

  const accept = crypto.createHash('sha1')
    .update('dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  check('la chaine magique RFC 6455 est la bonne', accept === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', accept);

  await new Promise((done) => {
    const w = new WebSocket('ws://127.0.0.1:' + port + '/refuse');
    w.onerror = () => { check('un chemin non autorise est refuse avant la poignee de main', true); done(); };
    w.onopen = () => { check('un chemin non autorise est refuse avant la poignee de main', false); done(); };
  });

  // 5 octets, 200 octets et 70 ko couvrent les trois encodages de longueur
  // (7 bits, 16 bits, 64 bits) : c est la que se cachent les erreurs de decalage.
  for (const n of [5, 200, 70000]) {
    await new Promise((done) => {
      const w = new WebSocket('ws://127.0.0.1:' + port + '/ok');
      w.onopen = () => w.send('x'.repeat(n));
      w.onmessage = (e) => { check('aller-retour WebSocket de ' + n + ' octets', e.data === 'echo:' + n, e.data); w.close(); done(); };
      w.onerror = () => { check('aller-retour WebSocket de ' + n + ' octets', false); done(); };
    });
  }

  await new Promise((done) => {
    const w = new WebSocket('ws://127.0.0.1:' + port + '/ok');
    let got = 0;
    w.onopen = () => { for (let i = 0; i < 50; i++) w.send('m' + i); };
    w.onmessage = () => { if (++got === 50) { check('50 trames enchainees sont toutes lues', true); w.close(); done(); } };
    setTimeout(() => { if (got !== 50) { check('50 trames enchainees sont toutes lues', false, got); done(); } }, 2000);
  });
  srv.close();
}

/* ================= 3. Bout en bout : un poste jusqu a la page ================= */

const PORT = 4399, TOKEN = 'jeton-de-test';
const srv = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', OFFICE_TOKEN: TOKEN,
    ROSTER_FILE: '.roster-test.json', OFFLINE_GRACE: '1500', SWEEP_EVERY: '400' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
srv.stderr.on('data', (d) => process.stdout.write('   [serveur] ' + d));
await wait(900);

const seen = [];
await new Promise((done) => {
  http.get({ host: '127.0.0.1', port: PORT, path: '/stream' }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) seen.push(JSON.parse(line.slice(6)));
      }
    });
    done();
  }).on('error', done);
});
const got = (p) => seen.filter(p);

await new Promise((done) => {
  const w = new WebSocket('ws://127.0.0.1:' + PORT + '/ingest?token=mauvais&machine=poste-1');
  w.onerror = () => { check('un jeton invalide est refuse', true); done(); };
  w.onopen = () => { check('un jeton invalide est refuse', false); done(); };
});
await new Promise((done) => {
  const w = new WebSocket('ws://127.0.0.1:' + PORT + '/ingest?token=' + TOKEN
    + '&machine=' + encodeURIComponent('../../etc/passwd'));
  w.onerror = () => { check('un nom de poste douteux est refuse', true); done(); };
  w.onopen = () => { check('un nom de poste douteux est refuse', false); done(); };
});

const agent = new WebSocket('ws://127.0.0.1:' + PORT + '/ingest?token=' + TOKEN + '&machine=poste-1');
await new Promise((done) => { agent.onopen = done; agent.onerror = done; });
check('un poste legitime se connecte', agent.readyState === 1);
const send = (o) => agent.send(JSON.stringify({ v: 1, ...o }));

// On rejoue les hooks assainis du bloc 1 : le trajet complet, sans raccourci.
for (const ev of wire) send({ type: 'event', ...ev, machine: 'poste-1' });
await wait(300);

check('la session arrive nommee par son poste',
  got((e) => e.hook_event_name === 'UserPromptSubmit')[0]?.session_id === 'poste-1:aaaabbbb');
check('une commande shell devient une activite muette',
  got((e) => e.act === 'term')[0]?.label === '🖥️ console');
check('aucun contenu n atteint la page', !JSON.stringify(seen).includes('rm -rf'));
check('la delegation garde le metier',
  got((e) => e.act === 'task')[0]?.tool_input?.subagent_type === 'Explore');
check('le roster a embauche Explore',
  got((e) => e.hook_event_name === 'Staff').pop()?.staff.includes('Explore'));

send({ type: 'event', event: 'UserPromptSubmit', session: 'aaaabbbb', coffee: true, ts: Date.now() });
await wait(200);
check('la pause cafe survit a l assainissement',
  got((e) => e.hook_event_name === 'UserPromptSubmit').pop()?.prompt === 'pause');

// La reconciliation : c est elle qui repare un evenement perdu sur le reseau.
send({ type: 'snapshot', machine: 'poste-1', sessions: [{ session: 'aaaabbbb', project: 'paie', tasks: [] }] });
await wait(300);
check('un instantane libere une mission dont la fin s est perdue',
  got((e) => e.hook_event_name === 'PostToolUse' && e.tool_use_id === 'x3').length > 0);

send({ type: 'snapshot', machine: 'poste-1', sessions: [
  { session: 'aaaabbbb', project: 'paie', tasks: [] },
  { session: 'ccccdddd', project: 'autre', tasks: [{ ref: 'r9', agent: 'Plan' }] }] });
await wait(300);
check('un instantane fait apparaitre une session ratee',
  got((e) => e.hook_event_name === 'SessionStart' && e.session_id === 'poste-1:ccccdddd').length > 0);
check('un instantane fait apparaitre une mission ratee',
  got((e) => e.tool_use_id === 'r9')[0]?.tool_input?.subagent_type === 'Plan');

// Fermeture PROPRE : le poste s en va pour de bon, on demonte sans attendre.
const before = seen.length;
agent.close();
await wait(600);
check('un depart propre demonte les ilots sans delai',
  seen.slice(before).filter((e) => e.hook_event_name === 'SessionEnd').length === 2);

// Coupure BRUTALE : le poste a peut-etre juste perdu le wifi. On attend, et s il
// revient dans le delai, le spectateur ne doit rien avoir vu.
{
  const SNAP = JSON.stringify({ v: 1, type: 'snapshot', machine: 'poste-2',
    sessions: [{ session: 'ffff9999', project: 'reseau', tasks: [] }] });
  const path2 = '/ingest?token=' + TOKEN + '&machine=poste-2';

  const a2 = await rawWS(PORT, path2);
  a2.send(SNAP);
  await wait(300);
  const avant = seen.length;
  a2.kill(); // cable arrache : aucune trame de fermeture
  await wait(900);
  check('une coupure brutale ne demonte pas tout de suite',
    seen.slice(avant).filter((e) => e.hook_event_name === 'SessionEnd').length === 0);

  const a3 = await rawWS(PORT, path2);
  a3.send(SNAP);
  await wait(2500); // bien au-dela du delai de grace du test (1,5 s)
  check('une reconnexion dans le delai annule le demontage',
    seen.slice(avant).filter((e) => e.hook_event_name === 'SessionEnd').length === 0,
    seen.slice(avant).map((e) => e.hook_event_name));

  // Et sans reconnexion, le demontage finit bien par arriver.
  const avant2 = seen.length;
  a3.kill();
  await wait(2500);
  check('sans reconnexion, le delai de grace finit par demonter',
    seen.slice(avant2).filter((e) => e.hook_event_name === 'SessionEnd').length === 1,
    seen.slice(avant2).map((e) => e.hook_event_name));
}

// Le mode local doit continuer de marcher tel quel, avec son detail.
await new Promise((done) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: '/event', method: 'POST',
    headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', done); });
  r.end(JSON.stringify({ session_id: 'local-1', cwd: '/x/mon-projet', hook_event_name: 'SessionStart' }));
});
await wait(200);
check('le mode local /event relaie toujours le detail', got((e) => e.session_id === 'local-1').length === 1);

const diag = await new Promise((done) => {
  http.get({ host: '127.0.0.1', port: PORT, path: '/sessions' }, (res) => {
    let b = ''; res.on('data', (c) => b += c); res.on('end', () => done(JSON.parse(b)));
  });
});
check('aucune activite ne survit au depart du poste', diag.machines.length === 0, diag.machines);
check('le roster, lui, survit', diag.roster.includes('Explore') && diag.roster.includes('Plan'), diag.roster);

srv.kill();
await wait(200);
try { (await import('node:fs')).default.unlinkSync('.roster-test.json'); } catch { /* deja parti */ }

console.log('\n' + ok + ' OK, ' + ko + ' en echec');
process.exit(ko ? 1 : 0);
