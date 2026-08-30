// Small, allocation-conscious helpers used everywhere in the game loop.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);

/** Frame-rate independent exponential approach. `l` is roughly "how fast", in 1/sec. */
export const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));

/** Shortest signed angular difference, in radians. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function dampAngle(a, b, l, dt) {
  return a + angleDelta(a, b) * (1 - Math.exp(-l * dt));
}

/** Deterministic, fast PRNG (mulberry32). Seeded so levels are reproducible. */
export class RNG {
  constructor(seed = 0x9e3779b9) { this.s = seed >>> 0; }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
}

export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/** Box-Muller, cached. Useful for natural-looking spread and scatter. */
let spareGauss = null;
export function gauss() {
  if (spareGauss !== null) { const v = spareGauss; spareGauss = null; return v; }
  let u, v, s;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const m = Math.sqrt((-2 * Math.log(s)) / s);
  spareGauss = v * m;
  return u * m;
}

/**
 * Fixed-capacity object pool. Everything hot in this game (particles, tracers,
 * projectiles, decals, damage numbers) comes from one of these so that the
 * steady-state frame does zero garbage-collectable allocation.
 */
export class Pool {
  constructor(size, factory) {
    this.items = new Array(size);
    for (let i = 0; i < size; i++) this.items[i] = factory(i);
    this.active = [];
    this.free = this.items.slice();
  }
  acquire() {
    const it = this.free.pop();
    if (!it) return null;
    this.active.push(it);
    return it;
  }
  release(it) {
    const i = this.active.indexOf(it);
    if (i === -1) return;
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
    this.free.push(it);
  }
  releaseAt(i) {
    const it = this.active[i];
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
    this.free.push(it);
    return it;
  }
  releaseAll() {
    while (this.active.length) this.free.push(this.active.pop());
  }
  get count() { return this.active.length; }
}

/** Rolling window statistic, used by the adaptive quality scaler. */
export class RollingAverage {
  constructor(n = 60, seed = 16.6) {
    this.buf = new Float32Array(n).fill(seed);
    this.i = 0; this.n = n;
    this.sum = seed * n;
  }
  push(v) {
    this.sum -= this.buf[this.i];
    this.buf[this.i] = v;
    this.sum += v;
    this.i = (this.i + 1) % this.n;
    return this.sum / this.n;
  }
  get mean() { return this.sum / this.n; }
}

export const fmt = (n) => n.toLocaleString('en-US');

export function romanize(n) {
  const map = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out || 'I';
}
