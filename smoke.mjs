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
  + ' COFFEE, RACK_Z, STAND_SPOTS, COFFEE_SPOTS, DOOR };';

let bad = 0;
const check = (ok, m) => { console.log((ok ? 'OK   ' : 'ECHEC') + '  ' + m); if (!ok) bad++; };

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

/* ---------- Quelques images ---------- */
let loopErr = null;
try { for (let i = 0; i < 8; i++) LOOPS[0](); } catch (e) { loopErr = e; }
check(!loopErr, 'huit images de la boucle passent' + (loopErr ? ' — ' + loopErr.message : ''));

if (warn.length) console.log('\n  avertissements attendus : ' + warn.map((w) => w.slice(0, 60)).join(' | '));

console.log(bad ? '\n' + bad + ' echec(s)' : '\nLe module se charge et tourne');
process.exit(bad ? 1 : 0);
