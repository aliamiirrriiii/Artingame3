/**
 * The arsenal.
 *
 * Every weapon is tuned around one question: what problem does it solve that
 * the others do not? The pistol is infinite-ammo insurance, the shotgun buys
 * you a doorway, the rifle is the all-rounder, the tesla clears a pile-up, the
 * railgun deletes a lane, the flamethrower buys time you cannot buy with
 * bullets. Damage numbers are balanced against the health curve in
 * zombieTypes.js so that a wall-buy weapon stays useful roughly ten waves.
 *
 * `dps` in the comments is sustained, including reloads, against a single
 * target with no headshots.
 */

export const WEAPONS = {
  // ------------------------------------------------------------- melee

  knife: {
    id: 'knife', name: 'Trench Knife', short: 'KNIFE',
    kind: 'melee', slot: 0,
    damage: 145, headMul: 1.6,
    rpm: 105, range: 2.3, arc: 0.55,
    magSize: Infinity, reserve: Infinity, infinite: true,
    stagger: 0.25, knockback: 1.2,
    recoil: { pitch: 0.012, yaw: 0.006, kick: 0.10 }, shake: 0.05,
    automatic: true,
    sound: { type: 'swing' },
    model: { type: 'knife', bladeLen: 0.26 },
    boxWeight: 0, price: 0,
    tip: 'Silent, free, and always in your hand. Enough to open wave one.',
  },

  // ------------------------------------------------------------ sidearms

  pistol: {
    id: 'pistol', name: 'M1911', short: 'M1911',
    kind: 'hitscan', slot: 1,
    damage: 62, headMul: 2.6, pellets: 1, spread: 0.5, moveSpread: 1.4,
    rpm: 340, magSize: 8, reserve: 120, reserveMax: 160, reloadTime: 1.35,
    range: 90, falloff: [26, 60], minDamage: 0.55,
    pierce: 0, stagger: 0.1,
    recoil: { pitch: 0.035, yaw: 0.010, kick: 0.055 }, shake: 0.08,
    automatic: false, adsZoom: 12,
    sound: { body: 175, crack: 4200, dur: 0.20, punch: 0.9, tail: 0.32, tone: 0.6 },
    model: { type: 'pistol', length: 0.20, barrel: 0.055 },
    boxWeight: 0, price: 0,
    tip: 'Reliable, infinite reserve at the ammo crate. Aim for the head.',
  },

  revolver: {
    id: 'revolver', name: '.44 Peacekeeper', short: '.44',
    kind: 'hitscan', slot: 1,
    damage: 260, headMul: 2.4, pellets: 1, spread: 0.35, moveSpread: 2.0,
    rpm: 145, magSize: 6, reserve: 60, reserveMax: 90, reloadTime: 2.3,
    range: 110, falloff: [34, 80], minDamage: 0.7,
    pierce: 1, stagger: 0.45,
    recoil: { pitch: 0.10, yaw: 0.024, kick: 0.14 }, shake: 0.20,
    automatic: false, adsZoom: 16,
    sound: { body: 120, crack: 5200, dur: 0.30, punch: 1.5, tail: 0.55, tone: 0.8 },
    model: { type: 'revolver', length: 0.24, barrel: 0.09 },
    boxWeight: 1.0, price: 900,
    tip: 'Punches through two bodies and staggers anything that survives.',
  },

  // ------------------------------------------------------------ automatics

  smg: {
    id: 'smg', name: 'MP-9 Hornet', short: 'MP-9',
    kind: 'hitscan', slot: 2,
    damage: 44, headMul: 2.0, pellets: 1, spread: 1.5, moveSpread: 2.2,
    rpm: 900, magSize: 32, reserve: 320, reserveMax: 420, reloadTime: 1.75,
    range: 70, falloff: [18, 46], minDamage: 0.4,
    pierce: 0, stagger: 0.06,
    recoil: { pitch: 0.020, yaw: 0.011, kick: 0.032 }, shake: 0.05,
    automatic: true, adsZoom: 10,
    sound: { body: 190, crack: 3600, dur: 0.14, punch: 0.75, tail: 0.20, tone: 0.5 },
    model: { type: 'smg', length: 0.34, barrel: 0.10 },
    boxWeight: 1.0, price: 1000,
    tip: 'Shreds runners up close. Falls off hard past twenty metres.',
  },

  rifle: {
    id: 'rifle', name: 'AKM-74', short: 'AKM',
    kind: 'hitscan', slot: 2,
    damage: 78, headMul: 2.2, pellets: 1, spread: 1.0, moveSpread: 2.0,
    rpm: 620, magSize: 30, reserve: 300, reserveMax: 390, reloadTime: 2.1,
    range: 120, falloff: [34, 84], minDamage: 0.6,
    pierce: 1, stagger: 0.14,
    recoil: { pitch: 0.033, yaw: 0.014, kick: 0.05 }, shake: 0.09,
    automatic: true, adsZoom: 14,
    sound: { body: 145, crack: 4400, dur: 0.20, punch: 1.15, tail: 0.42, tone: 0.7 },
    model: { type: 'rifle', length: 0.46, barrel: 0.20 },
    boxWeight: 1.1, price: 1600,
    tip: 'The all-rounder. Good at every range, master of none.',
  },

  lmg: {
    id: 'lmg', name: 'M-901 Reaper', short: 'REAPER',
    kind: 'hitscan', slot: 3,
    damage: 66, headMul: 1.8, pellets: 1, spread: 2.6, moveSpread: 3.4,
    rpm: 1150, magSize: 150, reserve: 450, reserveMax: 600, reloadTime: 5.0,
    range: 100, falloff: [30, 70], minDamage: 0.5,
    pierce: 2, stagger: 0.10,
    spinUp: 0.55,
    recoil: { pitch: 0.017, yaw: 0.015, kick: 0.028 }, shake: 0.07,
    automatic: true, adsZoom: 6, heavy: true,
    sound: { body: 130, crack: 3900, dur: 0.13, punch: 1.0, tail: 0.25, tone: 0.55 },
    model: { type: 'lmg', length: 0.52, barrel: 0.26 },
    boxWeight: 0.7, price: 0,
    tip: 'Spins up, then does not stop. Reloading takes five long seconds.',
  },

  // ------------------------------------------------------------ shotguns

  shotgun: {
    id: 'shotgun', name: 'SPAS-12 Breaker', short: 'BREAKER',
    kind: 'hitscan', slot: 3,
    damage: 38, headMul: 1.7, pellets: 10, spread: 5.2, moveSpread: 6.4,
    rpm: 85, magSize: 8, reserve: 64, reserveMax: 96,
    reloadTime: 0.55, shellReload: true,
    range: 34, falloff: [7, 22], minDamage: 0.16,
    pierce: 0, stagger: 0.6, knockback: 2.2,
    recoil: { pitch: 0.11, yaw: 0.02, kick: 0.17 }, shake: 0.24,
    automatic: false, adsZoom: 4,
    sound: { body: 95, crack: 3200, dur: 0.34, punch: 1.6, tail: 0.62, tone: 0.9 },
    model: { type: 'shotgun', length: 0.48, barrel: 0.26 },
    boxWeight: 1.1, price: 1200,
    tip: 'Owns a doorway. Ten pellets, and every one can be a headshot.',
  },

  // -------------------------------------------------------------- precision

  sniper: {
    id: 'sniper', name: 'Longbow .338', short: 'LONGBOW',
    kind: 'hitscan', slot: 4,
    damage: 700, headMul: 2.8, pellets: 1, spread: 0.1, moveSpread: 6.0,
    rpm: 48, magSize: 5, reserve: 45, reserveMax: 70, reloadTime: 3.0,
    boltAction: 0.95,
    range: 220, falloff: [220, 240], minDamage: 1.0,
    pierce: 5, stagger: 0.8,
    recoil: { pitch: 0.16, yaw: 0.02, kick: 0.24 }, shake: 0.32,
    automatic: false, adsZoom: 42,
    sound: { body: 85, crack: 6000, dur: 0.42, punch: 1.9, tail: 0.9, tone: 1.0 },
    model: { type: 'sniper', length: 0.62, barrel: 0.34 },
    boxWeight: 0.9, price: 0,
    tip: 'Punches down a whole street. Line the horde up and pull once.',
  },

  // ---------------------------------------------------------------- exotic

  flamer: {
    id: 'flamer', name: 'Cinder Mk II', short: 'CINDER',
    kind: 'flame', slot: 5,
    damage: 34, headMul: 1.0, dps: true,
    rpm: 600, magSize: 220, reserve: 440, reserveMax: 660, reloadTime: 3.1,
    range: 11, coneAngle: 0.32,
    burn: { dps: 46, duration: 4.0 },
    stagger: 0.05,
    recoil: { pitch: 0.004, yaw: 0.004, kick: 0.012 }, shake: 0.03,
    automatic: true, adsZoom: 0,
    sound: { type: 'flame' },
    model: { type: 'flamer', length: 0.40, barrel: 0.12 },
    boxWeight: 0.85, price: 0,
    tip: 'Sets the whole pack alight. Damage keeps ticking after you let go.',
  },

  tesla: {
    id: 'tesla', name: 'Arc Projector', short: 'ARC',
    kind: 'chain', slot: 5,
    damage: 210, headMul: 1.0,
    chains: 5, chainRange: 7.5, chainFalloff: 0.78,
    rpm: 130, magSize: 24, reserve: 96, reserveMax: 144, reloadTime: 2.4,
    range: 30,
    stagger: 0.5,
    recoil: { pitch: 0.03, yaw: 0.012, kick: 0.06 }, shake: 0.12,
    automatic: true, adsZoom: 0,
    sound: { type: 'zap', f0: 2200, f1: 140, dur: 0.3, buzz: 1 },
    model: { type: 'tesla', length: 0.42, barrel: 0.16 },
    boxWeight: 0.8, price: 0,
    tip: 'Arcs to five targets. The answer to a pile-up at a choke point.',
  },

  launcher: {
    id: 'launcher', name: 'M79 Thumper', short: 'THUMPER',
    kind: 'projectile', slot: 6,
    damage: 60, headMul: 1.0,
    blast: { radius: 6.0, damage: 620, falloff: 0.35, selfDamage: 0.35 },
    projectileSpeed: 34, gravity: -16, fuse: 4.0,
    rpm: 55, magSize: 1, reserve: 18, reserveMax: 28, reloadTime: 1.9,
    range: 120, stagger: 1.0,
    recoil: { pitch: 0.13, yaw: 0.02, kick: 0.2 }, shake: 0.3,
    automatic: false, adsZoom: 6,
    sound: { body: 110, crack: 2400, dur: 0.28, punch: 1.3, tail: 0.5, tone: 0.6 },
    model: { type: 'launcher', length: 0.44, barrel: 0.22 },
    boxWeight: 0.75, price: 0,
    tip: 'One shell, one crowd. Mind the blast radius — it does not like you either.',
  },

  railgun: {
    id: 'railgun', name: 'Ferro Lance', short: 'LANCE',
    kind: 'beam', slot: 6,
    damage: 1500, headMul: 1.5,
    charge: 0.85, pierce: 99,
    rpm: 40, magSize: 4, reserve: 24, reserveMax: 36, reloadTime: 2.8,
    range: 200, stagger: 1.0,
    recoil: { pitch: 0.14, yaw: 0.01, kick: 0.26 }, shake: 0.38,
    automatic: false, adsZoom: 20,
    sound: { type: 'zap', f0: 3400, f1: 90, dur: 0.5, buzz: 0.4 },
    model: { type: 'railgun', length: 0.60, barrel: 0.32 },
    boxWeight: 0.6, price: 0,
    tip: 'Hold to charge, release to erase everything in a straight line.',
  },

  // ------------------------------------------------------ improvised melee
  /*
   * Whatever was lying around. These are not bought — they are picked up off
   * the street, swung until they break, and thrown away, which is the loop the
   * whole game is built around.
   *
   * The fields a gun does not have:
   *
   *   reach      metres from the eye the swing carries.
   *   arcDeg     how wide the sweep is. A frying pan clears a doorway; a drill
   *              hits one zombie and nothing either side of it.
   *   maxTargets how many bodies one swing can carry through.
   *   durability swings before it breaks. The whole point of a disposable
   *              weapon is that you are always about to lose it.
   *   heft       0..1, how much the weapon throws a body and how slow it feels.
   *   sever      how readily it takes limbs off, independent of damage — a
   *              machete at half a sledgehammer's damage takes twice the arms.
   */

  bat: {
    id: 'bat', name: 'Baseball Bat', short: 'BAT',
    kind: 'melee', slot: 0,
    damage: 210, headMul: 2.0,
    rpm: 78, range: 2.6, arc: 0.48,
    reach: 2.6, arcDeg: 55, maxTargets: 3, durability: 40, heft: 0.7, sever: 0.15,
    magSize: Infinity, reserve: Infinity, infinite: true,
    stagger: 0.6, knockback: 3.4,
    recoil: { pitch: 0.02, yaw: 0.012, kick: 0.18 }, shake: 0.10,
    automatic: true,
    sound: { type: 'swing' },
    model: { type: 'bat' },
    boxWeight: 0, price: 0, pickup: 5,
    tip: 'Aluminium, and it rings when it connects. The one everybody reaches for.',
  },

  pan: {
    id: 'pan', name: 'Frying Pan', short: 'PAN',
    kind: 'melee', slot: 0,
    damage: 190, headMul: 2.2,
    rpm: 88, range: 2.0, arc: 0.62,
    reach: 2.0, arcDeg: 72, maxTargets: 3, durability: 55, heft: 0.6, sever: 0.05,
    magSize: Infinity, reserve: Infinity, infinite: true,
    stagger: 0.7, knockback: 3.0,
    recoil: { pitch: 0.018, yaw: 0.014, kick: 0.16 }, shake: 0.09,
    automatic: true,
    sound: { type: 'swing' },
    model: { type: 'pan' },
    boxWeight: 0, price: 0, pickup: 4,
    tip: 'Short, wide and heavy. Clears a doorway and survives longer than it should.',
  },

  drill: {
    id: 'drill', name: 'Power Drill', short: 'DRILL',
    kind: 'melee', slot: 0,
    damage: 74, headMul: 3.0,
    rpm: 320, range: 1.7, arc: 0.16,
    reach: 1.7, arcDeg: 16, maxTargets: 1, durability: 30, heft: 0.15, sever: 0.30,
    magSize: Infinity, reserve: Infinity, infinite: true,
    stagger: 0.05, knockback: 0.2,
    recoil: { pitch: 0.004, yaw: 0.004, kick: 0.04 }, shake: 0.03,
    automatic: true,
    sound: { type: 'swing' },
    model: { type: 'drill' },
    boxWeight: 0, price: 0, pickup: 3,
    tip: 'Held against a skull rather than swung. Hits one thing, very fast.',
  },

  sign: {
    id: 'sign', name: 'Wet Floor Sign', short: 'SIGN',
    kind: 'melee', slot: 0,
    damage: 88, headMul: 1.4,
    rpm: 70, range: 3.0, arc: 0.72,
    reach: 3.0, arcDeg: 82, maxTargets: 5, durability: 25, heft: 0.5, sever: 0.02,
    magSize: Infinity, reserve: Infinity, infinite: true,
    stagger: 1.0, knockback: 4.2,
    recoil: { pitch: 0.016, yaw: 0.018, kick: 0.14 }, shake: 0.08,
    automatic: true,
    sound: { type: 'swing' },
    model: { type: 'sign' },
    boxWeight: 0, price: 0, pickup: 5,
    tip: 'Reaches further than anything else and kills almost nothing. Knocks a whole rank flat.',
  },

  ukulele: {
    id: 'ukulele', name: 'Ukulele', short: 'UKE',
    kind: 'melee', slot: 0,
    damage: 34, headMul: 1.5,
    rpm: 96, range: 2.1, arc: 0.40,
    reach: 2.1, arcDeg: 44, maxTargets: 2, durability: 6, heft: 0.25, sever: 0.02,
    magSize: Infinity, reserve: Infinity, infinite: true,
    stagger: 0.3, knockback: 1.4,
    recoil: { pitch: 0.01, yaw: 0.01, kick: 0.10 }, shake: 0.05,
    automatic: true,
    sound: { type: 'swing' },
    model: { type: 'ukulele' },
    boxWeight: 0, price: 0, pickup: 2,
    tip: 'Six swings and it is kindling. Take it anyway.',
  },
};

export const WEAPON_LIST = Object.values(WEAPONS);

/** Weapons the mystery box can hand out, with their relative odds. */
export const BOX_POOL = WEAPON_LIST.filter((w) => w.boxWeight > 0);

/** Fire interval in seconds. */
export const fireInterval = (w) => 60 / w.rpm;

/**
 * Damage at a given distance, with linear falloff between the two `falloff`
 * breakpoints down to `minDamage` as a fraction of base.
 */
export function damageAtRange(w, dist) {
  if (!w.falloff) return w.damage;
  const [near, far] = w.falloff;
  if (dist <= near) return w.damage;
  if (dist >= far) return w.damage * (w.minDamage ?? 0.5);
  const t = (dist - near) / (far - near);
  return w.damage * (1 + ((w.minDamage ?? 0.5) - 1) * t);
}

/** Starting loadout. */
export const STARTING_WEAPONS = ['knife', 'pistol'];
export const MAX_CARRIED = 3;   // plus the knife, which is always slot 0
