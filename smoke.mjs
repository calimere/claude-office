// Test de fumee : evalue le MODULE ENTIER d index.html avec un three.js factice,
// puis fait tourner huit images de la boucle de rendu.
//
//   node smoke.mjs            # heure et meteo par defaut
//   node smoke.mjs "?hour=21" # avec des parametres d URL
//
// Pourquoi : `node --check` ne voit que la syntaxe. Un appel au chargement qui touche
// une constante declaree plus bas leve une ReferenceError de zone morte, tue tout le
// script et laisse une page noire — sans la moindre erreur de syntaxe. C est arrive,
// et c est ce que ce test attrape.
import fs from 'node:fs';

/* ---------- three.js factice ---------- */
class Vec {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z ?? this.z; return this; }
  setScalar(v) { return this.set(v, v, v); }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new Vec(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, k) { this.x += v.x * k; this.y += v.y * k; this.z += v.z * k; return this; }
  lerp(v, a) { this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; }
  lerpVectors(a, b, t) { return this.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  project() { return this; }
  normalize() { return this; }
}
class Col {
  constructor(h = 0) { this.h = h; this.r = this.g = this.b = .5; }
  copy(c) { this.h = c.h; return this; }
  clone() { return new Col(this.h); }
  lerp() { return this; }
  setHex(h) { this.h = h; return this; }
  getHex() { return this.h; }
}
class Obj3 {
  constructor() {
    this.position = new Vec(); this.rotation = new Vec(); this.scale = new Vec(1, 1, 1);
    this.quaternion = { copy() {} };
    this.children = []; this.userData = {}; this.visible = true;
    this.castShadow = this.receiveShadow = false; this.frustumCulled = true;
    this.shadow = { mapSize: new Vec(), camera: {}, radius: 0, bias: 0 };
    this.material = null; this.geometry = null;
  }
  add(...c) { for (const k of c) if (k) this.children.push(k); return this; }
  remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return this; }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse?.(fn); }
  lookAt() {}
}
class Mat {
  constructor(o = {}) { Object.assign(this, o); this.emissive = new Col(o.emissive ?? 0); this.color = new Col(o.color ?? 0xffffff); this.needsUpdate = false; }
  dispose() {}
}
class Geo { constructor() { this.attributes = {}; } setAttribute(k, a) { this.attributes[k] = a; } dispose() {} }
class Light extends Obj3 { constructor(c, i) { super(); this.color = new Col(c); this.intensity = i ?? 1; } }

const KNOWN = {
  PCFSoftShadowMap: 2, RepeatWrapping: 1000, DoubleSide: 2, AdditiveBlending: 2,
  SRGBColorSpace: 'srgb', ACESFilmicToneMapping: 4,
};
const EXPLICIT = {
  Vector3: Vec, Vector2: Vec, Color: Col, Group: Obj3, Object3D: Obj3,
  Mesh: class extends Obj3 { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Points: class extends Obj3 { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  BufferGeometry: Geo,
  BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; this.needsUpdate = false; } },
  MeshStandardMaterial: Mat, MeshBasicMaterial: Mat, PointsMaterial: Mat,
  CanvasTexture: class { constructor(c) { this.image = c; this.needsUpdate = false; this.repeat = new Vec(1,1,1); this.offset = new Vec(); this.wrapS = this.wrapT = 0; this.anisotropy = 1; } dispose() {} },
  TextureLoader: class { load(_u, _ok, _p, err) { err?.(new Error('pas de logo.png en test')); } },
  // Une DirectionalLight du vrai three.js porte un `target` : c est lui qui donne
  // la direction du soleil, et c est par lui qu on recentre le volume d ombre.
  DirectionalLight: class extends Light { constructor(c, i) { super(c, i); this.target = new Obj3(); } },
  AmbientLight: Light, PointLight: Light,
  HemisphereLight: class extends Light { constructor(a, b, i) { super(a, i); this.isHemisphereLight = true; } },
  Scene: class extends Obj3 { constructor() { super(); this.background = null; this.fog = null; } },
  Fog: class {}, Clock: class { constructor() { this.elapsedTime = 0; } getDelta() { this.elapsedTime += 1 / 30; return 1 / 30; } },
  Raycaster: class { setFromCamera() {} intersectObjects() { return []; } },
  OrthographicCamera: class extends Obj3 { updateProjectionMatrix() {} },
  WebGLRenderer: class {
    constructor() { this.domElement = mkEl('canvas'); this.shadowMap = {}; this.loopFn = null; }
    setPixelRatio() {} setSize() {} render() {} setAnimationLoop(fn) { this.loopFn = fn; LOOPS.push(fn); }
  },
};
const LOOPS = [];
const THREE = new Proxy({}, {
  get(_o, k) {
    if (typeof k !== 'string') return undefined;
    if (k in KNOWN) return KNOWN[k];
    if (k in EXPLICIT) return EXPLICIT[k];
    if (/Geometry$/.test(k)) return Geo;
    if (/Material$/.test(k)) return Mat;
    return class extends Obj3 {};
  },
});
const OrbitControls = class { constructor() { this.target = new Vec(); this.enableDamping = false; } update() {} };

/* ---------- DOM factice ---------- */
const ctx2d = new Proxy({}, {
  get(_o, k) {
    if (k === 'measureText') return (s) => ({ width: String(s).length * 9 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
    if (typeof k === 'symbol') return undefined;
    return () => {};
  },
  set() { return true; },
});
const listeners = {};
function mkEl(tag) {
  const el = {
    tagName: tag, width: 0, height: 0, style: {}, dataset: {}, children: [],
    className: '', textContent: '', value: '35', hidden: false, title: '', href: '',
    rel: '', type: '', id: '',
    getContext: () => ctx2d, toDataURL: () => 'data:image/png;base64,AA',
    appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; },
    append(...c) { for (const x of c) this.appendChild(x); },
    // Un vrai remove() se retire de son parent, et firstChild suit la liste. Les
    // laisser inertes rendait le faux DOM incoherent : le panneau d activite elague
    // ses lignes avec `logEl.firstChild.remove()`, et tombait sur null.
    remove() { const p = this.parentNode; if (!p) return;
      const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1);
      this.parentNode = null; },
    setAttribute() {}, getAttribute: () => null,
    addEventListener(k, fn) { (listeners[k] ||= []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }),
    parentNode: null, onclick: null, onchange: null,
  };
  Object.defineProperty(el, 'firstChild', { get() { return this.children[0] ?? null; } });
  Object.defineProperty(el, 'lastChild', { get() { return this.children[this.children.length - 1] ?? null; } });
  return el;
}
const byId = {};
globalThis.document = {
  head: mkEl('head'), body: mkEl('body'),
  createElement: mkEl,
  getElementById: (id) => (byId[id] ||= Object.assign(mkEl('div'), { id })),
  addEventListener() {},
};
globalThis.innerWidth = 1600; globalThis.innerHeight = 900; globalThis.devicePixelRatio = 1;
globalThis.addEventListener = () => {};
globalThis.location = { search: process.argv[2] || '', protocol: 'http:' };
globalThis.requestAnimationFrame = () => 0;
// Le flux : on garde la source sous la main pour lui faire livrer, plus bas, une
// poignee d evenements de flotte. Sans ca, tout le chemin « mode flotte » de handle()
// — libelles generiques, delegation sans description, cafe sans prompt — ne serait
// jamais execute par le test, et une erreur y dormirait jusqu a la mise en service.
let STREAM = null;
globalThis.EventSource = class {
  constructor() { STREAM = this; setTimeout(() => this.onerror?.(), 0); }
  close() {}
  deliver(ev) { this.onmessage?.({ data: JSON.stringify(ev) }); }
};
globalThis.Audio = class { constructor() { this.volume = 0; } play() { return Promise.resolve(); } pause() {} addEventListener() {} };
globalThis.AudioContext = class { constructor() { this.currentTime = 0; this.destination = {}; }
  createOscillator() { return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({ connect() {} }), start() {}, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({ connect() {} }) }; } };
globalThis.fetch = async () => ({ json: async () => ({ offline: true }) });

/* ---------- Evaluation ---------- */
const html = fs.readFileSync('index.html', 'utf8').split('\r\n').join('\n');
let src = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
// On retire les imports statiques : les dependances sont injectees. L'import dynamique
// du halo restera, echouera, et c'est precisement ce qu'on veut verifier (il est sous try).
src = src.replace(/^\s*import .*?;\s*$/gm, '');
// Le module est evalue dans une fonction : ses `const` ne sont pas globaux. On lui
// ajoute un epilogue qui expose les constantes de plan dont le test a besoin —
// plutot que de recopier des coordonnees dans le test, ou elles divergeraient.
src += '\n;globalThis.__plan = { ROOM, POD_X, POD_Z, AISLES, aisleFor, NAV,'
  + ' COFFEE, RACK_Z, STAND_SPOTS, COFFEE_SPOTS, DOOR, LUNCH_Z, LUNCH_CHAISE_Z };'
  + '\n;globalThis.__vie = { sessions, applyEndOfDay, applyBlockPause, USAGE, handle };'
  + '\n;globalThis.__midi = { claimLeisure, LUNCH_SPOTS, poser: (h) => { HEURE = h; } };'
  + '\n;globalThis.__places = { COFFEE_SPOTS, COUCH_SPOTS, STAND_SPOTS, LUNCH_SPOTS,'
  + ' buildNav, navCell, DOOR };'
  + '\n;globalThis.__cam = () => ({ cible: { x: camTarget.x, z: camTarget.z }, span: camSpan,'
  + ' ilots: [...pods].map((p) => ({ x: p.slot.x, z: p.slot.z })) });';

let bad = 0;
// Le troisieme argument est le DIAGNOSTIC : ce qu on a obtenu au lieu de ce qu on
// attendait. Sans lui, un echec dit seulement qu il y a un probleme, pas lequel.
const check = (ok, m, extra) => {
  console.log((ok ? 'OK   ' : 'ECHEC') + '  ' + m
    + (ok || extra === undefined ? '' : ' — ' + JSON.stringify(extra)));
  if (!ok) bad++;
};

const warn = [];
const realWarn = console.warn; console.warn = (...a) => warn.push(a.join(' '));

const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
let err = null;
try {
  await new AsyncFn('THREE', 'OrbitControls', src)(THREE, OrbitControls);
} catch (e) { err = e; }
console.warn = realWarn;

if (err) {
  console.log('ECHEC  le module leve une erreur au chargement :');
  console.log('       ' + err.constructor.name + ' : ' + err.message);
  const l = (err.stack || '').split('\n').slice(1, 3).join('\n       ');
  if (l.trim()) console.log('       ' + l);
  process.exit(1);
}
check(true, 'le module s evalue entierement, sans erreur de zone morte');
check(LOOPS.length === 1, 'la boucle de rendu est bien installee');

/* ---------- La geometrie de la piece ---------- */
// Vingt emplacements tiennent-ils vraiment dans les murs, sans chevaucher le mobilier,
// et chaque ilot s ouvre-t-il bien sur une allee ? Une capture d ecran ne repond a
// aucune de ces questions de facon fiable : un ilot qui mord sur la baie serveurs de
// dix centimetres ne se voit pas, et se verra sur le poste de quelqu un d autre.
{
  const plan = globalThis.__plan || {};
  const G = (n) => plan[n]; // constantes du module, exposees par l epilogue d evaluation
  const ROOM = G('ROOM'), POD_X = G('POD_X'), POD_Z = G('POD_Z');
  const AISLES = G('AISLES'), aisleFor = G('aisleFor');
  const HALF = 3.05; // demi-cote d un ilot, cf. insidePod()

  if (!ROOM || !POD_X) {
    check(false, 'les constantes de la piece sont lisibles depuis le test');
  } else {
    check(POD_X.length * POD_Z.length >= 20,
      POD_X.length + ' x ' + POD_Z.length + ' = ' + (POD_X.length * POD_Z.length) + ' emplacements');

    let dedans = true, chevauche = null, sansAllee = null;
    for (const x of POD_X) {
      for (const z of POD_Z) {
        if (x - HALF < -ROOM.w / 2 || x + HALF > ROOM.w / 2) dedans = false;
        if (z - HALF < ROOM.back || z + HALF > ROOM.front) dedans = false;
        // Le portillon doit tomber dans l allee de l ilot, pas dans le vide.
        const a = aisleFor(z);
        if (Math.abs(a - z) > HALF + 2.0) sansAllee = x + ',' + z;
      }
    }
    // Deux colonnes, deux rangees : jamais de recouvrement.
    for (let i = 0; i < POD_X.length - 1; i++) {
      if (POD_X[i + 1] - POD_X[i] < 2 * HALF) chevauche = 'colonnes ' + POD_X[i] + '/' + POD_X[i + 1];
    }
    const zs = [...POD_Z].sort((a, b) => a - b);
    for (let i = 0; i < zs.length - 1; i++) {
      if (zs[i + 1] - zs[i] < 2 * HALF) chevauche = 'rangees ' + zs[i] + '/' + zs[i + 1];
    }
    check(dedans, 'les vingt emplacements tiennent dans les murs');
    check(!chevauche, 'aucun emplacement n en chevauche un autre' + (chevauche ? ' — ' + chevauche : ''));
    check(!sansAllee, 'chaque ilot s ouvre sur une allee' + (sansAllee ? ' — ' + sansAllee : ''));

    // Les allees doivent passer ENTRE les rangees, pas a travers.
    let alleeLibre = true;
    for (const a of AISLES) {
      for (const z of POD_Z) if (Math.abs(a - z) < HALF) alleeLibre = false;
    }
    check(alleeLibre, 'aucune allee ne traverse un ilot');

    // La grille de navigation doit recouvrir la piece EXACTEMENT. Son origine est le
    // coin de la piece ; depuis que celle-ci ne grandit que vers le fond, son centre
    // n'est plus z = 0, et une origine calculee sur la profondeur decalerait toute la
    // grille — les agents contourneraient des meubles absents et traverseraient ceux
    // qui sont la. Rien ne le signalerait : l'A* trouve toujours un chemin.
    const NAV = G('NAV');
    check(Math.abs(NAV.x0 - (-ROOM.w / 2)) < 1e-9 && Math.abs(NAV.z0 - ROOM.back) < 1e-9,
      'la grille de navigation part bien du coin de la piece',
      { x0: NAV.x0, z0: NAV.z0, attendu: { x0: -ROOM.w / 2, z0: ROOM.back } });
    check(Math.abs(NAV.cols * NAV.cell - ROOM.w) < NAV.cell
      && Math.abs(NAV.rows * NAV.cell - ROOM.d) < NAV.cell,
      'la grille de navigation couvre toute la piece',
      { cols: NAV.cols, rows: NAV.rows });

    // La bande avant (cafe, salon, places debout) reste devant la premiere rangee.
    check(G('COFFEE').z > Math.max(...POD_Z) + HALF,
      'le coin cafe reste devant la premiere rangee');

    // La baie serveurs est au fond a droite, derriere la derniere rangee.
    check(G('RACK_Z') + .45 < Math.min(...POD_Z) - HALF,
      'la baie serveurs ne mord pas sur la rangee du fond');

    // Le point d arrivee doit etre dans la piece ET hors de tout ilot. Reste fixe
    // pendant que les murs bougent, il atterrit au milieu du parquet — ou pire, a
    // l interieur d un ilot, d ou des arrivees qui traversent le verre.
    const DOOR = G('DOOR');
    let porteDansIlot = false;
    for (const x of POD_X) {
      for (const z of POD_Z) {
        if (Math.abs(DOOR.x - x) < HALF && Math.abs(DOOR.z - z) < HALF) porteDansIlot = true;
      }
    }
    check(!porteDansIlot && DOOR.x > -ROOM.w / 2 && DOOR.x < ROOM.w / 2
      && DOOR.z > ROOM.back && DOOR.z < ROOM.front,
      'la porte est dans la piece et hors de tout ilot',
      { x: DOOR.x, z: DOOR.z });

    // La bande avant ne fait que 3,3 entre la premiere rangee et le mur. Tout ce
    // qu on y pose doit laisser le passage : c est la que vivent le cafe, le salon,
    // les places debout et la table du midi, et c est la seule bande libre de la
    // piece. Un ilot qui gagne quinze centimetres les prend a elle.
    const dosIlot = Math.max(...POD_Z) + 3.05;
    const chaise = G('LUNCH_CHAISE_Z') - .25;
    check(chaise - dosIlot > .6,
      'la table du midi laisse le passage derriere les ilots',
      { dosIlot, bordChaise: chaise, passage: +(chaise - dosIlot).toFixed(2) });
    check(G('LUNCH_Z') + .65 < ROOM.front,
      'et elle ne traverse pas le mur avant',
      { bordTable: G('LUNCH_Z') + .65, mur: ROOM.front });
  }
}

/* ---------- Le mode flotte ---------- */
// Exactement ce que server.js envoie quand un poste distant publie : une activite,
// jamais un libelle de contenu. Le piege a eviter est l absence de `tool_input` et de
// `prompt`, que le mode local avait toujours sous la main.
let fleetErr = null;
if (!STREAM) {
  check(false, 'le flux SSE est installe');
} else {
  const sid = 'poste-1:aaaabbbb';
  const fleet = [
    { hook_event_name: 'Staff', staff: ['Explore', 'Plan'] },
    { session_id: sid, machine: 'poste-1', cwd: 'protrack', hook_event_name: 'SessionStart', fleet: true },
    { session_id: sid, hook_event_name: 'UserPromptSubmit', fleet: true, prompt: '', act: 'think', label: '💭 nouvelle consigne' },
    { session_id: sid, hook_event_name: 'PreToolUse', fleet: true, act: 'term', label: '🖥️ console', tool_use_id: 'r1' },
    { session_id: sid, hook_event_name: 'PostToolUse', fleet: true, act: 'term', tool_use_id: 'r1', duration_ms: 120 },
    // Delegation : pas de description, c est tout l interet du mode flotte.
    { session_id: sid, hook_event_name: 'PreToolUse', fleet: true, act: 'task', tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore' }, tool_use_id: 'r2' },
    { session_id: sid, hook_event_name: 'PostToolUse', fleet: true, act: 'task', tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore' }, tool_use_id: 'r2',
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'ag1' } },
    { session_id: sid, hook_event_name: 'SubagentStop', fleet: true, agent_id: 'ag1' },
    // La pause cafe a survecu a l assainissement sous forme de booleen.
    { session_id: sid, hook_event_name: 'UserPromptSubmit', fleet: true, prompt: 'pause', act: 'think' },
    { session_id: sid, hook_event_name: 'Notification', fleet: true },
    { session_id: sid, hook_event_name: 'SessionEnd', fleet: true },
  ];
  try { for (const ev of fleet) STREAM.deliver(ev); } catch (e) { fleetErr = e; }
  check(!fleetErr, 'les evenements de flotte traversent handle()'
    + (fleetErr ? ' — ' + fleetErr.constructor.name + ' : ' + fleetErr.message : ''));
}

/* ---------- Pauses subies et fin de journee ---------- */
// Un poste qui se tait, un bloc de 5 h epuise, 18 h sonnant : trois facons pour une
// session de se figer sans disparaitre. Ce qu on verifie, c est que les gens gardent
// leur bureau — sans quoi leur retour devrait reconstruire des affectations que
// personne ne reannonce, et ils resteraient plantes dans l open space.
{
  const vie = globalThis.__vie;
  if (!vie || !STREAM) {
    check(false, 'la vie de la piece est accessible depuis le test');
  } else {
    const sid = 'poste-9:cafe1234';
    const base = { session_id: sid, machine: 'poste-9', fleet: true };
    STREAM.deliver({ ...base, cwd: 'essai-pause', hook_event_name: 'SessionStart' });
    STREAM.deliver({ ...base, hook_event_name: 'PreToolUse', act: 'task', tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore' }, tool_use_id: 'p1' });
    const s = vie.sessions.get(sid);
    check(!!s && s.subs.length === 1, 'la session d essai existe, avec un sous-agent');

    const gens = () => [s.main, ...s.subs];
    const bureaux = () => gens().map((a) => a.desk);

    // --- Poste injoignable
    const avant = bureaux();
    STREAM.deliver({ hook_event_name: 'MachineOffline', machine: 'poste-9', fleet: true });
    check(gens().every((a) => a.paused === 'absent'),
      'un poste injoignable met TOUS ses gens en pause',
      gens().map((a) => a.paused));
    check(bureaux().every((d, i) => d === avant[i]),
      'la pause ne leur fait pas rendre leur bureau');
    check(s.pod.lampScale < 1, 'l ilot est tamise pendant l absence', s.pod.lampScale);

    STREAM.deliver({ hook_event_name: 'MachineOnline', machine: 'poste-9', fleet: true });
    check(gens().every((a) => !a.paused), 'le retour du poste leve la pause');
    check(bureaux().every((d, i) => d === avant[i]),
      'ils retrouvent exactement le bureau qu ils avaient');
    check(s.pod.lampScale === 1, 'l ilot se rallume');

    // --- Bloc de 5 h epuise, pour CE poste seulement
    Object.assign(vie.USAGE, { known: true, elapsed: 1,
      machines: [{ machine: 'poste-9', elapsed: 1 }, { machine: 'poste-8', elapsed: .2 }] });
    vie.applyBlockPause();
    check(gens().every((a) => a.paused === 'bloc'),
      'un bloc de 5 h epuise met les gens du poste en pause', gens().map((a) => a.paused));

    vie.USAGE.machines = [{ machine: 'poste-9', elapsed: .05 }];
    vie.applyBlockPause();
    check(gens().every((a) => !a.paused), 'un bloc neuf les remet au travail');

    // --- 18 h, session qui attend une reponse
    STREAM.deliver({ ...base, hook_event_name: 'Notification' });
    check(!!s.alert, 'la session attend une reponse');
    vie.applyEndOfDay(20);
    check(s.deserte === true, 'a 20 h, une session sans reponse est desertee');
    check(gens().every((a) => a.home === true), 'ses gens rentrent chez eux',
      gens().map((a) => a.state));
    check(s.pod.lampScale === 0, 'et l ilot s eteint', s.pod.lampScale);

    // Une session qui travaille n est PAS desertee, meme a 20 h.
    const sid2 = 'poste-9:boss0001';
    STREAM.deliver({ session_id: sid2, machine: 'poste-9', fleet: true, cwd: 'de-nuit',
      hook_event_name: 'SessionStart' });
    STREAM.deliver({ session_id: sid2, machine: 'poste-9', fleet: true,
      hook_event_name: 'PreToolUse', act: 'term', label: '🖥️ console' });
    vie.applyEndOfDay(20);
    const s2 = vie.sessions.get(sid2);
    check(s2 && !s2.deserte, 'une session qui travaille la nuit reste a son poste');

    // Le matin, ou des qu on repond, tout le monde revient.
    vie.applyEndOfDay(10);
    check(!s.deserte && gens().every((a) => !a.home), 'au matin, ils reviennent');
  }
}

/* ---------- Midi, et le lead qui va briefer ---------- */
{
  const midi = globalThis.__midi, vie = globalThis.__vie;
  if (!midi || !vie || !STREAM) {
    check(false, 'la table du midi est inspectable depuis le test');
  } else {
    const estRepas = (k) => midi.LUNCH_SPOTS.includes(k);
    const rendre = (k) => { if (k) k.busy = false; };

    midi.poser(10);
    const matin = midi.claimLeisure();
    check(matin && !estRepas(matin), 'a dix heures, on ne va pas a table', matin && matin.kind);
    rendre(matin);

    midi.poser(13);
    const aTable = midi.claimLeisure();
    check(aTable && estRepas(aTable), 'a treize heures, la table passe devant',
      aTable && aTable.kind);
    rendre(aTable);
    midi.poser(10);

    // Le lead designe l agent qu il doit aller briefer. L aller-retour lui-meme est
    // joue par la boucle de rendu ; ce qui se verifie ici, c est le declenchement.
    const sid = 'poste-b:brief001';
    const base = { session_id: sid, machine: 'poste-b', fleet: true };
    STREAM.deliver({ ...base, cwd: 'briefing', hook_event_name: 'SessionStart' });
    STREAM.deliver({ ...base, hook_event_name: 'PreToolUse', act: 'task',
      tool_name: 'Agent', tool_input: { subagent_type: 'Explore' }, tool_use_id: 'br1' });
    const s = vie.sessions.get(sid);
    check(s && s.main.briefTarget === s.subs[0],
      'une delegation envoie le lead briefer l agent',
      s && (s.main.briefTarget ? s.main.briefTarget.name : null));
    STREAM.deliver({ ...base, hook_event_name: 'SessionEnd' });
  }
}

/* ---------- Toute place de repos doit etre atteignable ---------- */
// Poser un meuble, c est bloquer des cases de la grille de navigation. Un meuble mal
// place mure ses propres chaises : les agents n y vont jamais, et rien ne le dit —
// ils s installent simplement ailleurs. C est arrive deux fois dans ce fichier
// (meubles restes a leur ancienne place apres l agrandissement de la piece), et
// seule une assertion le voit.
{
  const pl = globalThis.__places;
  if (!pl) {
    check(false, 'les places de repos sont inspectables depuis le test');
  } else {
    const grille = pl.buildNav();
    // Une assise DANS un meuble est voulue : on s assoit sur le canape, on se cale
    // au mange-debout. findPath() le gere, en menant a la case libre la plus proche
    // puis en posant le dernier pas a la main. Ce qu il faut verifier, c est donc
    // qu une case libre existe TOUT PRES — sinon l agent est debarque a l autre bout
    // de la piece et finit par traverser le decor en ligne droite.
    const APPROCHE = 1.6;
    const loinDeTout = [];
    for (const [nom, pool] of [['bar', pl.COFFEE_SPOTS], ['canape', pl.COUCH_SPOTS],
      ['places debout', pl.STAND_SPOTS], ['table du midi', pl.LUNCH_SPOTS]]) {
      check(pool.length > 0, 'le pool « ' + nom + ' » n est pas vide', pool.length);
      for (const p of pool) {
        let mini = Infinity;
        for (let dx = -APPROCHE; dx <= APPROCHE; dx += .2) {
          for (let dz = -APPROCHE; dz <= APPROCHE; dz += .2) {
            if (grille[pl.navCell(p.pos.x + dx, p.pos.z + dz)]) continue;
            mini = Math.min(mini, Math.hypot(dx, dz));
          }
        }
        if (mini > 1.3) {
          loinDeTout.push(nom + ' (' + p.pos.x.toFixed(1) + ',' + p.pos.z.toFixed(1)
            + ') a ' + (mini === Infinity ? '∞' : mini.toFixed(1)));
        }
      }
    }
    check(loinDeTout.length === 0,
      'chaque place de repos a une case libre a portee de pas', loinDeTout);
    check(!grille[pl.navCell(pl.DOOR.x, pl.DOOR.z)],
      'la porte d entree n est pas muree', { x: pl.DOOR.x, z: pl.DOOR.z });
  }
}

/* ---------- L ilot epouse son equipe ---------- */
// Les cloisons disaient « equipe de quatre » quel que soit l effectif : une session
// seule occupait quatre places, une equipe de six s entassait a deux par bureau. Le
// tapis se dimensionne desormais sur les gens reellement la.
{
  const vie = globalThis.__vie;
  if (!vie || !STREAM) {
    check(false, 'les ilots sont inspectables depuis le test');
  } else {
    const sid = 'poste-t:taille01';
    const base = { session_id: sid, machine: 'poste-t', fleet: true };
    const tache = (n) => ({ ...base, hook_event_name: 'PreToolUse', act: 'task',
      tool_name: 'Agent', tool_input: { subagent_type: 'Explore' }, tool_use_id: 't' + n });

    STREAM.deliver({ ...base, cwd: 'taille', hook_event_name: 'SessionStart' });
    const s = vie.sessions.get(sid);
    check(!!s && s.pod.desks.length === 1,
      'une session seule n occupe qu un bureau', s && s.pod.desks.length);
    const tapisSeul = s.pod.edge.scale.z;

    // Les places deja attribuees ne doivent JAMAIS bouger : un employe assis qui
    // glisse parce qu un collegue arrive, ca se voit tout de suite.
    const posAvant = s.pod.desks.map((d) => ({ x: d.seat.x, z: d.seat.z }));
    STREAM.deliver(tache(1));
    STREAM.deliver(tache(2));
    check(s.pod.desks.length === 3, 'deux agents de plus, trois bureaux', s.pod.desks.length);
    check(s.pod.desks.slice(0, 1).every((d, i) => d.seat.x === posAvant[i].x && d.seat.z === posAvant[i].z),
      'les bureaux deja occupes n ont pas bouge');
    check(s.pod.edge.scale.z > tapisSeul, 'le tapis a grandi avec l equipe',
      { avant: tapisSeul, apres: s.pod.edge.scale.z });

    // Plafond d emprise : au-dela de quatre, on double plutot que de mordre sur le voisin.
    for (let i = 3; i <= 6; i++) STREAM.deliver(tache(i));
    check(s.pod.desks.length === 4, 'l ilot plafonne a quatre bureaux', s.pod.desks.length);
    check(s.subs.length === 6, 'mais les six agents sont bien la', s.subs.length);

    // L equipe retrecit : les places rendues disparaissent.
    const fin = (n) => STREAM.deliver({ ...base, hook_event_name: 'PostToolUse', act: 'task',
      tool_name: 'Agent', tool_use_id: 't' + n });
    for (let i = 1; i <= 6; i++) fin(i);
    // finishSub() laisse l employe lire son rapport 1,4 s avant de rendre sa place :
    // la fin de mission n est pas instantanee a l ecran, et le test doit l attendre.
    await new Promise((r) => setTimeout(r, 1700));
    check(s.pod.desks.length === 1,
      'une fois l equipe partie, il ne reste qu un bureau', s.pod.desks.length);
    check(Math.abs(s.pod.edge.scale.z - tapisSeul) < 1e-9,
      'et le tapis a retrouve sa taille', { attendu: tapisSeul, obtenu: s.pod.edge.scale.z });

    // Le portillon suit le bord du tapis, sinon on entre par le vide.
    const g = s.pod.gate, h = s.pod.half;
    check(Math.abs(Math.abs(g.z - h.cz) - (h.z + .4)) < 1e-6,
      'le portillon reste au bord du tapis', { gate: g.z, centre: h.cz, demi: h.z });

    STREAM.deliver({ ...base, hook_event_name: 'SessionEnd' });
  }
}

/* ---------- Le cadrage ---------- */
// Une camera qui ne montre pas les ilots occupes ne sert a rien, et c est le genre
// de chose qu une capture d ecran laisse passer : on voit une belle piece, sans
// remarquer que deux sessions sur vingt sont hors champ. En isometrique, un point
// (x, z) monte a l ecran de -(x+z)/racine(6) et se decale de (x-z)/racine(2).
{
  const cam = globalThis.__cam;
  const vie = globalThis.__vie;
  if (!cam || !vie || !STREAM) {
    check(false, 'le cadrage est inspectable depuis le test');
  } else {
    const HALF = 3.05, R6 = Math.sqrt(6), R2 = Math.sqrt(2);
    const aspect = globalThis.innerWidth / globalThis.innerHeight;

    const horsChamp = () => {
      const c = cam();
      const su = (x, z) => -(x + z) / R6, sr = (x, z) => (x - z) / R2;
      const cu = su(c.cible.x, c.cible.z), cr = sr(c.cible.x, c.cible.z);
      const dehors = [];
      for (const p of c.ilots) {
        for (const dx of [-HALF, HALF]) {
          for (const dz of [-HALF, HALF]) {
            const x = p.x + dx, z = p.z + dz;
            if (Math.abs(su(x, z) - cu) > c.span || Math.abs(sr(x, z) - cr) > c.span * aspect) {
              dehors.push(p.x + ',' + p.z);
            }
          }
        }
      }
      return { dehors: [...new Set(dehors)], span: c.span, cible: c.cible };
    };


    // On ferme tout ce que les blocs precedents ont ouvert : le cadrage depend du
    // NOMBRE d ilots, donc il faut partir d une piece vide.
    for (const sid of [...vie.sessions.keys()]) {
      STREAM.deliver({ session_id: sid, hook_event_name: 'SessionEnd' });
    }

    for (const n of [1, 2, 3, 6, 20]) {
      for (let i = 0; i < n; i++) {
        STREAM.deliver({ session_id: 'cadre-' + n + '-' + i, machine: 'poste-c', fleet: true,
          cwd: 'projet' + i, hook_event_name: 'SessionStart' });
      }
      const r = horsChamp();
      check(r.dehors.length === 0,
        'a ' + n + ' ilot' + (n > 1 ? 's' : '') + ', tous sont dans le cadre', r);
      for (let i = 0; i < n; i++) {
        STREAM.deliver({ session_id: 'cadre-' + n + '-' + i, hook_event_name: 'SessionEnd' });
      }
    }
  }
}

/* ---------- Quelques images ---------- */
let loopErr = null;
try { for (let i = 0; i < 8; i++) LOOPS[0](); } catch (e) { loopErr = e; }
check(!loopErr, 'huit images de la boucle passent' + (loopErr ? ' — ' + loopErr.message : ''));

if (warn.length) console.log('\n  avertissements attendus : ' + warn.map((w) => w.slice(0, 60)).join(' | '));

console.log(bad ? '\n' + bad + ' echec(s)' : '\nLe module se charge et tourne');
process.exit(bad ? 1 : 0);
