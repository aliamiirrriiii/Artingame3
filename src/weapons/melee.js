import * as THREE from 'three';
import { clamp } from '../core/util.js';

/**
 * Melee.
 *
 * A gun resolves to one ray and one target. A swing does not: a bat travels
 * through an arc, and everything standing in that arc gets hit by it. That
 * difference is the whole reason to pick up a bat instead of a pistol, so it
 * is what this models — the sweep, not a cone test that picks a winner.
 *
 * A swing is three phases and one instant:
 *
 *   Wind-up   The weapon pulls back and up. Nothing has happened yet, and for
 *             a sledgehammer this is a fifth of a second of commitment.
 *   Strike    It sweeps across. The damage lands on one frame in here — see
 *             `STRIKE_AT` — not when the button went down.
 *   Recover   It settles back to the ready stance.
 *
 * Putting the damage at the strike rather than at the input is the single
 * thing that makes a heavy weapon feel heavy. It also means a swing can be
 * seen to miss, which is what makes reach worth caring about.
 */

/** Fractions of the swing cycle. */
export const WIND_TO = 0.30;
export const STRIKE_AT = 0.38;

/**
 * How many rays a sweep is sampled with. A wide swing needs more of them or a
 * zombie can stand in a gap between two samples and be missed by a weapon that
 * visibly passed through it.
 */
export function sweepRays(arcDeg) {
  return clamp(Math.round(3 + arcDeg / 9), 3, 11);
}

const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Nothing nearer than this can shield a target: the arc is already inside it. */
const MIN_SWING = 0.9;

/**
 * How far below the crosshair the sweep is centred, as a slope.
 *
 * You swing down at what is in front of you. Sweeping level with the eye is
 * what a laser does, and against a zombie that the pose layer has hunched
 * forward it misses over the top of the skull from a metre away — which is the
 * one distance at which a melee weapon must never miss.
 */
const SWING_DROP = 0.17;

/**
 * Everything a swing connects with.
 *
 * Fans `sweepRays` rays across the arc, tilted along the swing's own diagonal
 * so a downward stroke reaches heads on one side and hips on the other. Each
 * ray is stopped by the world first, so you cannot hit through a wall, and a
 * zombie already caught by an earlier ray is not counted twice.
 *
 * Returns hits nearest first, capped at `maxTargets`.
 */
export function sweep(zm, collision, origin, aim, w, side, out = []) {
  out.length = 0;
  const arc = (w.arcDeg ?? 40) * Math.PI / 180;
  const reach = w.reach ?? w.range ?? 2.2;
  const n = sweepRays(w.arcDeg ?? 40);
  const seen = new Set();
  const scratch = {};

  // The swing plane: mostly horizontal, rolled by the direction of travel so
  // the stroke comes down across the body rather than straight across it.
  _axis.copy(_up).addScaledVector(aim, -aim.dot(_up)).normalize();
  _side.crossVectors(aim, _axis).normalize();

  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    // Sweep from the leading edge to the trailing one, so `out` comes back in
    // the order the weapon actually met them.
    const a = (t - 0.5) * arc * side;
    _dir.copy(aim)
      .addScaledVector(_side, Math.sin(a))
      .addScaledVector(_axis, Math.sin(a) * 0.35 * side - SWING_DROP)
      .normalize();

    // The world stops a swing, but not at arm's length: the arc starts at your
    // own hands and comes round, so standing against a chest-high barricade
    // must not disable the bat you are holding over it.
    const wall = collision && collision.raycast
      ? collision.raycast(origin, _dir, reach, scratch) : null;
    const limit = wall ? Math.max(MIN_SWING, wall.distance - 0.02) : reach;
    const hit = zm.raycast(origin, _dir, limit, {});
    if (!hit || seen.has(hit.zombie)) continue;
    seen.add(hit.zombie);
    out.push({
      zombie: hit.zombie,
      point: hit.point.clone(),
      part: hit.part,
      mul: hit.mul,
      head: hit.head,
      distance: hit.distance,
    });
    if (out.length >= (w.maxTargets ?? 2)) break;
  }
  return out;
}

/**
 * Weapon condition.
 *
 * Improvised weapons break. That is not a tax — it is the loop: you are always
 * a few swings away from having to find something else, so the street stays
 * worth looking at. Guns are exempt; anything with a `durability` is not.
 */
export class Condition {
  constructor() { this.left = new Map(); }

  /** Swings remaining, or Infinity for anything that does not wear out. */
  of(spec) {
    if (!spec?.durability) return Infinity;
    if (!this.left.has(spec.id)) this.left.set(spec.id, spec.durability);
    return this.left.get(spec.id);
  }

  /** Fraction remaining, 0..1. */
  fraction(spec) {
    if (!spec?.durability) return 1;
    return clamp(this.of(spec) / spec.durability, 0, 1);
  }

  /** Spends `n` swings. Returns true when the weapon has just broken. */
  spend(spec, n = 1) {
    if (!spec?.durability) return false;
    const left = Math.max(0, this.of(spec) - n);
    this.left.set(spec.id, left);
    return left <= 0;
  }

  reset(spec) { if (spec?.durability) this.left.set(spec.id, spec.durability); }
  forget(spec) { this.left.delete(spec.id); }
}
