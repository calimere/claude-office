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
  DirectionalLight: Light, AmbientLight: Light, PointLight: Light,
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
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    remove() {}, setAttribute() {}, getAttribute: () => null,
    addEventListener(k, fn) { (listeners[k] ||= []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }),
    firstChild: null, onclick: null, onchange: null,
  };
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
globalThis.EventSource = class { constructor() { setTimeout(() => this.onerror?.(), 0); } close() {} };
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

/* ---------- Quelques images ---------- */
let loopErr = null;
try { for (let i = 0; i < 8; i++) LOOPS[0](); } catch (e) { loopErr = e; }
check(!loopErr, 'huit images de la boucle passent' + (loopErr ? ' — ' + loopErr.message : ''));

if (warn.length) console.log('\n  avertissements attendus : ' + warn.map((w) => w.slice(0, 60)).join(' | '));

console.log(bad ? '\n' + bad + ' echec(s)' : '\nLe module se charge et tourne');
process.exit(bad ? 1 : 0);
