/**
 * Skeletal hit volumes and the ray maths behind them.
 *
 * Kept apart from `zombies.js` — and free of any three.js import — so the
 * geometry can be unit-tested without a renderer. Everything here takes plain
 * `{x, y, z}` objects.
 */

/**
 * Hitboxes, expressed as capsules between two bones of the Mixamo rig.
 *
 * The old test was a vertical cylinder plus a head sphere hung off the
 * zombie's ground position, which meant it ignored the animation completely:
 * the pose layer folds the spine forward and lurches the body sideways, so the
 * sphere sat in the air above a hunched zombie's actual skull. These follow
 * the skeleton, so a headshot has to be on the head as drawn.
 *
 * `t0`/`t1` slide the capsule's ends along the bone segment — the head bone
 * runs from the jaw to the crown, and a capsule spanning all of it with a
 * skull-sized radius would stick out past both. `r` is metres for a 1.8 m body
 * and is scaled per zombie. `mul` is the damage multiplier; the head's comes
 * from the weapon's own `headMul` instead, so a sniper still one-taps.
 *
 * `limb` names the bone that comes off when this box is shot to pieces.
 */
export const HITBOX_DEFS = [
  { part: 'head',  a: 'Head',         b: 'HeadTop_End',  t0: 0.14, t1: 0.60, r: 0.105, mul: 1 },
  { part: 'chest', a: 'Spine1',       b: 'Spine2',       t0: 0,    t1: 1,    r: 0.195, mul: 1 },
  // The neck is its own, much thinner capsule. Carrying the ribcage's radius
  // all the way up to the neck joint threw a 0.19 m sphere around the throat
  // that sat in front of the skull once the pose layer hunched the spine, and
  // a shot aimed squarely at the head came back as a body hit.
  { part: 'chest', a: 'Spine2',       b: 'Neck',         t0: 0,    t1: 1,    r: 0.115, mul: 1 },
  { part: 'gut',   a: 'Hips',         b: 'Spine1',       t0: 0,    t1: 1,    r: 0.170, mul: 0.9 },
  { part: 'arm',   a: 'LeftArm',      b: 'LeftForeArm',  t0: 0,    t1: 1,    r: 0.064, mul: 0.65, limb: 'LeftArm' },
  { part: 'arm',   a: 'LeftForeArm',  b: 'LeftHand',     t0: 0,    t1: 1,    r: 0.054, mul: 0.65, limb: 'LeftForeArm' },
  { part: 'arm',   a: 'RightArm',     b: 'RightForeArm', t0: 0,    t1: 1,    r: 0.064, mul: 0.65, limb: 'RightArm' },
  { part: 'arm',   a: 'RightForeArm', b: 'RightHand',    t0: 0,    t1: 1,    r: 0.054, mul: 0.65, limb: 'RightForeArm' },
  { part: 'leg',   a: 'LeftUpLeg',    b: 'LeftLeg',      t0: 0,    t1: 1,    r: 0.088, mul: 0.7,  limb: 'LeftUpLeg' },
  { part: 'leg',   a: 'LeftLeg',      b: 'LeftFoot',     t0: 0,    t1: 1,    r: 0.070, mul: 0.7,  limb: 'LeftLeg' },
  { part: 'leg',   a: 'RightUpLeg',   b: 'RightLeg',     t0: 0,    t1: 1,    r: 0.088, mul: 0.7,  limb: 'RightUpLeg' },
  { part: 'leg',   a: 'RightLeg',     b: 'RightFoot',    t0: 0,    t1: 1,    r: 0.070, mul: 0.7,  limb: 'RightLeg' },
];

/**
 * Severing a limb collapses its bone to nothing, which drags every vertex
 * weighted to it into the joint. It is not a real cut — there is no cap on the
 * wound — but with a gib burst and a jet of blood at that joint it reads
 * correctly at gameplay distance, and it costs one scale assignment.
 */
export const SEVERED_SCALE = 0.001;

/** Ray vs sphere. Returns t or -1. `d` must be normalised. */
export function intersectSphere(o, d, cx, cy, cz, r, maxT) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - c;
  if (h < 0) return -1;
  const sq = Math.sqrt(h);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxT) return -1;
  return t;
}

/** Ray vs infinite Y-axis cylinder, clipped to [y0, y1]. Returns t or -1. */
export function intersectCylinder(o, d, cx, cz, r, y0, y1, maxT) {
  const ox = o.x - cx, oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return -1;
  const b = 2 * (ox * d.x + oz * d.z);
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0 || t > maxT) return -1;
  const y = o.y + d.y * t;
  if (y < y0 || y > y1) return -1;
  return t;
}

/**
 * Does the ray touch this sphere anywhere in [0, maxT]? Broad phase only, so
 * it answers yes/no rather than where — a point-blank shot starts inside the
 * body sphere, where the nearest root is behind the muzzle and useless as a
 * rejection distance.
 */
export function sphereOverlapsRay(o, d, cx, cy, cz, r, maxT) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - c;
  if (h < 0) return false;
  const s = Math.sqrt(h);
  return (-b + s) >= 0 && (-b - s) <= maxT;
}

/**
 * Ray vs capsule — a sphere of radius `r` swept from `a` to `b`. Returns t or
 * -1. `d` must be normalised.
 *
 * Solves the infinite-cylinder quadratic about the segment axis and accepts a
 * root only where it lands between the two ends, falling back to the end caps
 * otherwise. `A` collapses to zero when the ray runs parallel to the axis —
 * shooting straight down a leg — and then only the caps can be hit.
 */
export function intersectCapsule(o, d, a, b, r, maxT) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  if (baba < 1e-9) return intersectSphere(o, d, a.x, a.y, a.z, r, maxT);

  const oax = o.x - a.x, oay = o.y - a.y, oaz = o.z - a.z;
  const bard = bax * d.x + bay * d.y + baz * d.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d.x * oax + d.y * oay + d.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;

  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;
  const h = B * B - A * C;

  if (h >= 0 && Math.abs(A) > 1e-9) {
    const sq = Math.sqrt(h);
    // Near root first; the far one only matters when the muzzle is already
    // inside the limb.
    const near = (-B - sq) / A, far = (-B + sq) / A;
    if (near >= 0 && near <= maxT) {
      const y = baoa + near * bard;
      if (y > 0 && y < baba) return near;
    }
    if (far >= 0 && far <= maxT) {
      const y = baoa + far * bard;
      if (y > 0 && y < baba) return far;
    }
  }

  const t0 = intersectSphere(o, d, a.x, a.y, a.z, r, maxT);
  const t1 = intersectSphere(o, d, b.x, b.y, b.z, r, maxT);
  if (t0 < 0) return t1;
  if (t1 < 0) return t0;
  return Math.min(t0, t1);
}
