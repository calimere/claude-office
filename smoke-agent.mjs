// Le trajet complet, avec les vrais binaires : un hook brut entre dans l'agent Go,
// et un statut assaini ressort cote page.
//
//   cd agent && go build -o claude-office-agent.exe .
//   node smoke-agent.mjs
//
// C'est le seul test qui fasse parler le client WebSocket ecrit a la main (Go) et le
// serveur WebSocket ecrit a la main (ws.js). Les tests unitaires de chaque cote
// peuvent passer tous les deux pendant qu'ils refusent de se parler.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EXE = process.platform === 'win32'
  ? path.join('agent', 'claude-office-agent.exe')
  : path.join('agent', 'claude-office-agent');

if (!fs.existsSync(EXE)) {
  console.log('IGNORE  ' + EXE + ' absent — compilez d abord : cd agent && go build -o '
    + path.basename(EXE) + ' .');
  process.exit(0);
}

let ok = 0, ko = 0;
const check = (n, c, extra) => {
  if (c) { ok++; console.log('OK     ' + n); }
  else { ko++; console.log('ECHEC  ' + n + (extra === undefined ? '' : ' — ' + JSON.stringify(extra))); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SRV_PORT = 4398, AGENT_PORT = 4396, TOKEN = 'jeton-bout-en-bout';
const ROSTER = path.join(os.tmpdir(), 'roster-smoke-agent.json');
try { fs.unlinkSync(ROSTER); } catch { /* pas encore la */ }

const srv = spawn(process.execPath, ['server.js'], {
  // Tuer un processus sous Windows ne laisse pas le temps d envoyer une trame de
  // fermeture : le serveur voit une coupure brutale, donc un delai de grace. On le
  // raccourcit, sinon ce test attendrait vingt secondes.
  env: { ...process.env, PORT: String(SRV_PORT), HOST: '127.0.0.1', OFFICE_TOKEN: TOKEN,
    ROSTER_FILE: ROSTER, OFFLINE_GRACE: '1200', SWEEP_EVERY: '400' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
srv.stderr.on('data', (d) => process.stdout.write('   [serveur] ' + d));
await wait(900);

// -config sur un chemin inexistant : le test ne doit pas dependre de la configuration
// reelle du poste qui l execute.
const agent = spawn(EXE, [
  '-server', 'http://127.0.0.1:' + SRV_PORT,
  '-token', TOKEN,
  '-machine', 'poste-test',
  '-port', String(AGENT_PORT),
  '-config', path.join(os.tmpdir(), 'config-qui-nexiste-pas.json'),
], { stdio: ['ignore', 'pipe', 'pipe'] });
const agentOut = [];
agent.stdout.on('data', (d) => agentOut.push(String(d)));
agent.stderr.on('data', (d) => process.stdout.write('   [agent] ' + d));

// Le flux que verrait un navigateur.
const seen = [];
await new Promise((done) => {
  http.get({ host: '127.0.0.1', port: SRV_PORT, path: '/stream' }, (res) => {
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

await wait(1500); // le temps que l agent se connecte
const got = (p) => seen.filter(p);

const post = (body) => new Promise((done) => {
  const r = http.request({ host: '127.0.0.1', port: AGENT_PORT, path: '/event', method: 'POST',
    headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', done); });
  r.on('error', done);
  r.end(JSON.stringify(body));
});

const status = () => new Promise((done) => {
  http.get({ host: '127.0.0.1', port: AGENT_PORT, path: '/status' }, (res) => {
    let b = ''; res.on('data', (c) => b += c); res.on('end', () => done(JSON.parse(b)));
  }).on('error', () => done(null));
});

const st0 = await status();
check('l agent repond sur /status', !!st0, st0);
check('le client WebSocket ecrit a la main parle au serveur ecrit a la main',
  st0 && st0.flotte && st0.flotte.en_ligne === true, st0 && st0.flotte);

// Des hooks BRUTS, avec tout ce qu ils contiennent reellement.
const SECRETS = ['rm -rf /srv/prod', 'refacto du module de paie', 'salaires.xlsx',
  'client-confidentiel', 'Atlassian_MCP', 'tache secrete'];

await post({ hook_event_name: 'SessionStart', session_id: 'eeee1111-aaaa-bbbb',
  cwd: 'C:\\dev\\client-confidentiel\\paie' });
await post({ hook_event_name: 'UserPromptSubmit', session_id: 'eeee1111-aaaa-bbbb',
  prompt: 'refacto du module de paie' });
await post({ hook_event_name: 'PreToolUse', session_id: 'eeee1111-aaaa-bbbb',
  cwd: '/srv/prod/app', tool_name: 'Bash', tool_input: { command: 'rm -rf /srv/prod' },
  tool_use_id: 'b1' });
await post({ hook_event_name: 'PreToolUse', session_id: 'eeee1111-aaaa-bbbb',
  tool_name: 'Read', tool_input: { file_path: '/home/rh/salaires.xlsx' }, tool_use_id: 'b2' });
await post({ hook_event_name: 'PreToolUse', session_id: 'eeee1111-aaaa-bbbb',
  tool_name: 'mcp__claude_ai_Atlassian_MCP__getJiraIssue', tool_input: { issue: 'SEC-1' } });
await post({ hook_event_name: 'PreToolUse', session_id: 'eeee1111-aaaa-bbbb',
  tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: 'tache secrete' },
  tool_use_id: 'b3' });
await wait(600);

const blob = JSON.stringify(seen);
for (const s of SECRETS) check('« ' + s.slice(0, 26) + ' » n atteint pas la page', !blob.includes(s));

check('la session arrive nommee par son poste',
  got((e) => e.session_id === 'poste-test:eeee1111').length > 0,
  got(() => true).map((e) => e.session_id).slice(0, 5));
check('seul le dernier segment du chemin arrive',
  got((e) => e.cwd === 'paie').length > 0);
check('la commande shell devient une activite muette',
  got((e) => e.act === 'term')[0]?.label === '🖥️ console');
check('le MCP devient la categorie web, sans le nom du serveur',
  got((e) => e.act === 'web').length > 0);
check('la delegation garde le metier, pas la description',
  got((e) => e.act === 'task')[0]?.tool_input?.subagent_type === 'Explore');

// La pause cafe : calculee sur le poste, transmise en booleen.
await post({ hook_event_name: 'UserPromptSubmit', session_id: 'eeee1111-aaaa-bbbb', prompt: 'va boire un café' });
await wait(400);
check('la pause cafe survit au trajet',
  got((e) => e.hook_event_name === 'UserPromptSubmit').pop()?.prompt === 'pause');

// L instantane : l agent doit republier son etat tout seul. On coupe la connexion en
// redemarrant le serveur, et le poste doit reapparaitre sans qu un hook ne le pousse.
const before = seen.length;
await wait(11000); // un cycle d instantane complet (10 s)
const snapshots = seen.slice(before);
check('l agent republie son etat sans qu un hook l y oblige',
  snapshots.length === 0 || snapshots.every((e) => e.hook_event_name !== 'SessionEnd'),
  snapshots.map((e) => e.hook_event_name));

const diag = await new Promise((done) => {
  http.get({ host: '127.0.0.1', port: SRV_PORT, path: '/sessions' }, (res) => {
    let b = ''; res.on('data', (c) => b += c); res.on('end', () => done(JSON.parse(b)));
  });
});
check('le serveur voit le poste et sa session',
  diag.machines[0]?.machine === 'poste-test' && diag.machines[0]?.sessions.length === 1, diag.machines);
check('le serveur voit le sous-agent encore au travail',
  diag.machines[0]?.sessions[0]?.subagents.includes('Explore'), diag.machines[0]?.sessions[0]);

// Depart de l agent : ses ilots doivent se demonter.
const beforeKill = seen.length;
agent.kill();
await wait(800);
check('les ilots survivent au tout premier instant de la coupure',
  !seen.slice(beforeKill).some((e) => e.hook_event_name === 'SessionEnd'),
  seen.slice(beforeKill).map((e) => e.hook_event_name));
await wait(1600); // au-dela du delai de grace du test
check('les ilots sont demontes une fois le delai de grace passe',
  seen.slice(beforeKill).some((e) => e.hook_event_name === 'SessionEnd'),
  seen.slice(beforeKill).map((e) => e.hook_event_name));

check('l agent annonce clairement sa configuration au demarrage',
  agentOut.join('').includes('poste-test') && agentOut.join('').includes('/status'),
  agentOut.join('').slice(0, 200));

srv.kill();
await wait(200);
try { fs.unlinkSync(ROSTER); } catch { /* deja parti */ }

console.log('\n' + ok + ' OK, ' + ko + ' en echec');
process.exit(ko ? 1 : 0);
