import { clamp } from '../core/util.js';

/**
 * Wave modifiers.
 *
 * A wave that is only bigger than the last one stops being interesting around
 * wave eight: the answer is always the same answer, applied harder. These
 * change what the wave *is* — how fast they come, how many, how tough, how
 * dark it is, what is worth using — so that being on wave twenty means having
 * played twenty different fights rather than one fight twenty times.
 *
 * They are drawn procedurally with a wave-scaled count, weighted so the nastier
 * ones only start turning up once the player has an arsenal to answer them.
 * Nothing here changes a rule the player cannot see: each one announces itself,
 * and the ones that alter the light or the air are visible before the first
 * zombie arrives.
 *
 * Every field is optional. `zombie` is merged into the horde's per-wave
 * multipliers; `wave` adjusts composition and pacing; `mood` is handed to the
 * stage.
 */
export const MODIFIERS = [
  {
    id: 'swarm', name: 'SWARM', blurb: 'More of them, and they are already moving',
    minWave: 3, weight: 1.4,
    wave: { budget: 1.55, interval: 0.72, cap: 1.25 },
    zombie: { health: 0.62 },
  },
  {
    id: 'elite', name: 'HARDENED', blurb: 'Fewer, and they do not go down',
    minWave: 6, weight: 1.0,
    wave: { budget: 0.62 },
    zombie: { health: 2.1, stagger: 0.45, points: 1.8 },
  },
  {
    id: 'sprint', name: 'FERAL', blurb: 'All of them run',
    minWave: 5, weight: 1.1,
    wave: { interval: 0.85 },
    zombie: { speed: 1.42, health: 0.86 },
  },
  {
    id: 'dusk', name: 'BLACKOUT', blurb: 'The light is going',
    minWave: 7, weight: 0.9,
    mood: { fog: 0x2a3138, fogDensity: 2.2, sunColor: 0x6f8199, sunIntensity: 0.42, exposure: 1.05 },
    zombie: { points: 1.25 },
  },
  {
    id: 'smoke', name: 'SMOKE', blurb: 'You will not see them coming',
    minWave: 8, weight: 0.85,
    mood: { fog: 0xb0a596, fogDensity: 3.4, sunColor: 0xffd0a0, sunIntensity: 1.3, exposure: 0.82 },
    zombie: { points: 1.2 },
  },
  {
    id: 'brutal', name: 'BRUTAL', blurb: 'They hit harder than they should',
    minWave: 9, weight: 0.9,
    zombie: { damage: 1.5, stagger: 0.6, points: 1.3 },
  },
  {
    id: 'butcher', name: 'BUTCHER', blurb: 'Everything you can pick up is worth more',
    minWave: 4, weight: 1.0,
    wave: { meleePoints: 2.4 },
    zombie: { points: 0.75 },
  },
  {
    id: 'flood', name: 'FLOOD', blurb: 'No gaps in it anywhere',
    minWave: 11, weight: 0.8,
    wave: { budget: 1.3, interval: 0.55, cap: 1.4 },
    zombie: { health: 0.8, speed: 1.12 },
  },
  {
    id: 'glass', name: 'GLASS', blurb: 'They come apart, and there are far more',
    minWave: 6, weight: 0.9,
    wave: { budget: 1.9, interval: 0.7, cap: 1.3 },
    zombie: { health: 0.34, points: 0.6, sever: 2.2 },
  },
];

/** How many modifiers a wave gets. Boss waves get one fewer — they are one. */
export function countFor(wave, boss = false) {
  const n = wave < 3 ? 0 : wave < 7 ? 1 : wave < 13 ? 2 : 3;
  return Math.max(0, n - (boss ? 1 : 0));
}

/**
 * Draws this wave's modifiers.
 *
 * `recent` is the ids used in the last couple of waves; nothing repeats out of
 * it, so a run cannot serve BLACKOUT four waves running and call it variety.
 * Combinations that would stack into nonsense are refused: two that both
 * multiply the budget, or two that both take over the sky.
 */
export function drawModifiers(wave, rng, recent = [], boss = false) {
  const want = countFor(wave, boss);
  if (!want) return [];

  const pool = MODIFIERS.filter((m) => wave >= m.minWave && !recent.includes(m.id));
  const out = [];
  let guard = 0;
  while (out.length < want && guard++ < 60) {
    const avail = pool.filter((m) => !out.includes(m) && compatible(out, m));
    if (!avail.length) break;
    const total = avail.reduce((s, m) => s + m.weight, 0);
    let r = rng() * total;
    let pick = avail[0];
    for (const m of avail) { r -= m.weight; if (r <= 0) { pick = m; break; } }
    out.push(pick);
  }
  return out;
}

/** Two modifiers that pull the same lever hard in the same direction do not mix. */
function compatible(chosen, m) {
  for (const c of chosen) {
    if (c.mood && m.mood) return false;
    const a = c.wave || {}, b = m.wave || {};
    if (a.budget && b.budget) return false;
    if (a.interval && b.interval) return false;
  }
  return true;
}

/**
 * Folds a set of modifiers into one multiplier set.
 *
 * Multiplicative throughout, and then clamped: three modifiers each shaving a
 * third off zombie health would otherwise leave a wave that dies to a sneeze.
 */
export function foldModifiers(mods) {
  const z = { health: 1, speed: 1, damage: 1, points: 1, stagger: 1, sever: 1 };
  const w = { budget: 1, interval: 1, cap: 1, meleePoints: 1 };
  let mood = null;
  for (const m of mods) {
    for (const k of Object.keys(z)) if (m.zombie?.[k] !== undefined) z[k] *= m.zombie[k];
    for (const k of Object.keys(w)) if (m.wave?.[k] !== undefined) w[k] *= m.wave[k];
    if (m.mood) mood = m.mood;
  }
  z.health = clamp(z.health, 0.25, 3.2);
  z.speed = clamp(z.speed, 0.7, 1.6);
  z.damage = clamp(z.damage, 0.6, 2.0);
  z.points = clamp(z.points, 0.5, 2.5);
  z.stagger = clamp(z.stagger, 0.3, 1.4);
  z.sever = clamp(z.sever, 0.5, 3.0);
  w.budget = clamp(w.budget, 0.5, 2.4);
  w.interval = clamp(w.interval, 0.4, 1.4);
  w.cap = clamp(w.cap, 0.8, 1.5);
  w.meleePoints = clamp(w.meleePoints, 1, 3);
  return { zombie: z, wave: w, mood };
}
