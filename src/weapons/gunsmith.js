import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TAU } from '../core/util.js';

/**
 * The gunsmith.
 *
 * Weapons are built here from a small library of machined primitives rather
 * than from boxes: every part is bevelled, every barrel has a real crown and a
 * bore you can see down, turrets and charging handles are knurled, and rails
 * have individual slots. A first-person weapon is the one asset the player
 * looks at for the entire run, at a fixed half-metre from the camera, so it is
 * worth an order of magnitude more geometry than anything in the world — and
 * costs nothing, because there is exactly one of it.
 *
 * Three things do most of the work of making these read as manufactured
 * objects rather than as programmer art:
 *
 *   Bevels. Nothing in the real world has a zero-radius edge. Every slab here
 *   is an extruded rounded rectangle with a chamfer, so edges catch a highlight
 *   instead of vanishing into a hard black line.
 *
 *   Edge wear, baked to vertex colours. `wear()` finds the vertices near two or
 *   more extremes of a part's bounding box — which is exactly where a holster,
 *   a sling and a wall rub the finish off — and brightens them toward bare
 *   metal, while darkening downward-facing surfaces where grime collects. It is
 *   free at runtime and it survives the per-material merge.
 *
 *   Moving parts. Slides reciprocate, cylinders index, pumps cycle, magazines
 *   drop. Those are returned as named sub-groups so the viewmodel can animate
 *   them; everything else is merged flat.
 *
 * Coordinates are the viewmodel's: +X right, +Y up, -Z down the barrel, origin
 * at the web of the shooting hand. Units are metres, and so are UVs — every
 * primitive rescales its own UVs to world units so one tiled detail map has a
 * consistent texel density across the whole weapon.
 */

/** Radial segments for round parts. A viewmodel can afford a smooth barrel. */
const RSEG = 22;
/** Segments used when tessellating the corner arcs of a bevelled slab. */
const CURVE = 4;
/** Default chamfer, in metres. Roughly the break a machinist would leave. */
const BEVEL = 0.0016;

// --------------------------------------------------------------- primitives

/** Rounded rectangle in XY, centred, for extruding. */
function rrect(w, h, r) {
  const x = w / 2, y = h / 2;
  const k = Math.min(r, x * 0.999, y * 0.999);
  const s = new THREE.Shape();
  s.moveTo(-x + k, -y);
  s.lineTo(x - k, -y);
  s.quadraticCurveTo(x, -y, x, -y + k);
  s.lineTo(x, y - k);
  s.quadraticCurveTo(x, y, x - k, y);
  s.lineTo(-x + k, y);
  s.quadraticCurveTo(-x, y, -x, y - k);
  s.lineTo(-x, -y + k);
  s.quadraticCurveTo(-x, -y, -x + k, -y);
  return s;
}

/**
 * A bevelled slab: the workhorse. `w`/`h` are the cross-section, `d` the length
 * along Z, and the result is centred on the origin with a real chamfer on every
 * edge. ExtrudeGeometry's world UV generator already emits UVs in object units,
 * which is the density the rest of the library matches.
 */
export function slab(w, h, d, opts = {}) {
  const { r = 0.0022, bevel = BEVEL } = opts;
  const b = Math.min(bevel, w / 2.5, h / 2.5, d / 2.5);
  const depth = Math.max(1e-4, d - b * 2);
  const geo = new THREE.ExtrudeGeometry(rrect(w - b * 2, h - b * 2, r), {
    depth, bevelEnabled: true, bevelSize: b, bevelThickness: b,
    bevelSegments: 1, curveSegments: CURVE, steps: 1,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

/** A tapered rod down -Z, centred. `r2` defaults to `r` for a plain cylinder. */
export function rod(r, len, r2 = r, seg = RSEG, open = false) {
  const g = new THREE.CylinderGeometry(r2, r, len, seg, 1, open);
  scaleUV(g, TAU * Math.max(r, r2), len);
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * Revolve a profile around the barrel axis. `pts` are `[radius, z]` pairs with
 * z increasing toward the muzzle; the result points down -Z.
 *
 * Note the convention, which differs from `rod`: a lathe grows *forward from
 * its placement point*, because a profile has a base and a tip, where a rod is
 * centred on its own middle. Place a lathe where its base belongs.
 */
export function lathe(pts, seg = RSEG) {
  let span = 0, rMax = 0;
  for (let i = 0; i < pts.length; i++) {
    rMax = Math.max(rMax, pts[i][0]);
    if (i) span += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const g = new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(Math.max(1e-5, r), z)), seg);
  scaleUV(g, TAU * rMax, span);
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * A barrel with a crowned muzzle and a bore that goes somewhere. The profile
 * runs up the outside, chamfers over the crown and back down the inside, so
 * looking into the muzzle shows a dark hole rather than a flat disc — the
 * single cheapest detail that separates a gun from a pipe.
 */
export function barrel(rOut, rBore, len, opts = {}) {
  const { crown = 0.0018, boreDepth = 0.06, taper = 1.0 } = opts;
  const bore = Math.min(rBore, rOut - 0.0006);
  return lathe([
    [0, 0],
    [rOut, 0],
    [rOut * taper, len - crown * 2],
    [rOut * taper - crown * 0.5, len - crown],
    [bore + crown * 0.5, len],
    [bore, len - crown * 0.6],
    [bore, len - Math.min(boreDepth, len * 0.9)],
    [0, len - Math.min(boreDepth, len * 0.9)],
  ]);
}

/**
 * An open loop: a rounded rectangle with a rounded hole through it, extruded.
 * A trigger guard is the shape a player reads a gun by, and a solid block where
 * the bow should be is the single most obvious tell that a weapon was modelled
 * by someone stacking cuboids.
 */
export function loop(w, h, thick, d, r = 0.006) {
  const outer = rrect(w, h, r);
  outer.holes.push(rrect(w - thick * 2, h - thick * 2, Math.max(0.0008, r - thick)));
  const geo = new THREE.ExtrudeGeometry(outer, {
    depth: d, bevelEnabled: true, bevelSize: 0.0008, bevelThickness: 0.0008,
    bevelSegments: 1, curveSegments: CURVE, steps: 1,
  });
  geo.translate(0, 0, -d / 2);
  return geo;
}

/** A ring — sight hoods, barrel bands, coil windings. */
export function ring(R, r, seg = RSEG, arc = TAU) {
  const g = new THREE.TorusGeometry(R, r, 8, seg, arc);
  scaleUV(g, TAU * R, TAU * r);
  return g;
}

/**
 * Diamond knurling, cut straight into a revolved part: push each vertex in or
 * out along its radius by a two-frequency pattern. Real knurling is a rolled
 * crosshatch and this is exactly that, which is why turrets and charging
 * handles built with it catch light the way the real things do.
 */
export function knurl(geo, freq = 26, depth = 0.00035, axialFreq = 200) {
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = Math.hypot(v.x, v.y);
    if (r < 1e-5) continue;
    const a = Math.atan2(v.y, v.x);
    const d = depth * Math.sin(a * freq) * Math.sin(v.z * axialFreq);
    p.setXY(i, v.x + (v.x / r) * d, v.y + (v.y / r) * d);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Longitudinal flutes, as cut into a heavy barrel or a revolver cylinder. */
export function flute(geo, count = 6, depth = 0.0012) {
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = Math.hypot(v.x, v.y);
    if (r < 1e-5) continue;
    const a = Math.atan2(v.y, v.x);
    const d = -depth * Math.pow(Math.max(0, Math.cos(a * count)), 6);
    p.setXY(i, v.x + (v.x / r) * d, v.y + (v.y / r) * d);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Multiply UVs into world units so one detail map tiles evenly everywhere. */
function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

// ------------------------------------------------------------------- wear

const HASH = (x, y, z) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Bake edge wear and grime into vertex colours.
 *
 * "Edge" is measured against the part's own bounding box rather than from the
 * normals: a vertex sitting near the extreme along two or more axes is on a
 * corner, which is true for a chamfered slab, a barrel crown and a lathe step
 * alike, and unlike a normal-direction test it does not mistake the curve of a
 * cylinder for an edge and leave stripes down it.
 */
export function wear(geo, opts = {}) {
  const { amount = 0.45, grime = 0.30, base = 1.0, tint = null } = opts;
  const pos = geo.attributes.position;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const c = bb.getCenter(new THREE.Vector3());
  const h = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  h.set(Math.max(h.x, 1e-4), Math.max(h.y, 1e-4), Math.max(h.z, 1e-4));

  const nrm = geo.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const t = [0, 0, 0];

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    t[0] = Math.abs(v.x - c.x) / h.x;
    t[1] = Math.abs(v.y - c.y) / h.y;
    t[2] = Math.abs(v.z - c.z) / h.z;
    t.sort((a, b) => b - a);
    // Second-largest: near an extreme in two axes at once means a corner.
    const e = Math.max(0, (t[1] - 0.80) / 0.20);
    const n = 0.55 + 0.45 * HASH(v.x * 91, v.y * 91, v.z * 91);
    const edge = e * e * n * amount;

    // Grime pools on upward-facing recesses and along the underside.
    const ny = nrm ? nrm.getY(i) : 0;
    const dirt = grime * Math.max(0, -ny) * (0.5 + 0.5 * HASH(v.z * 37, v.x * 37, 4.2));

    const k = base * (1 - dirt) + edge;
    col[i * 3 + 0] = tint ? k * tint[0] : k;
    col[i * 3 + 1] = tint ? k * tint[1] : k;
    col[i * 3 + 2] = tint ? k * tint[2] : k * (1 + edge * 0.06);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// ---------------------------------------------------------------- assembly

/**
 * How hard each finish wears. Steel on a holster rim goes bright; polymer just
 * scuffs; glass and emissive parts do not wear at all.
 */
const WEAR = {
  gunSteel: { amount: 0.34, grime: 0.30 },
  gunBlued: { amount: 0.40, grime: 0.22 },
  gunAlloy: { amount: 0.28, grime: 0.28 },
  gunGrip:  { amount: 0.16, grime: 0.34 },
  gunWood:  { amount: 0.26, grime: 0.30 },
  gunBrass: { amount: 0.35, grime: 0.18 },
  gunGlass: { amount: 0.00, grime: 0.00 },
  gunGlow:  { amount: 0.00, grime: 0.00 },
};

/**
 * A build in progress. Parts are filed under a sub-group name; everything in
 * `body` is static, and the rest are the pieces the viewmodel animates.
 */
function forge() {
  const groups = new Map();
  let cur = 'body';
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();

  const f = {
    // Height of the sighting plane above the weapon origin. The viewmodel uses
    // it to work out where to hold the gun when aiming, so the irons actually
    // land on the crosshair instead of somewhere near it.
    sightY: 0.020,
    // Where the shooting hand goes. Written by `pistolGrip` so the hands rig
    // does not have to guess at it from the silhouette; a weapon without one
    // (the knife) falls back to its bounding box.
    gripAt: null,
    on(name) { cur = name; return f; },
    add(matKey, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
      wear(geo, WEAR[matKey] || WEAR.gunSteel);
      m.compose(v.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz, 'XYZ')), UNIT);
      geo.applyMatrix4(m);
      if (!groups.has(cur)) groups.set(cur, []);
      groups.get(cur).push({ matKey, geo });
      return f;
    },
    groups,
  };
  return f;
}

const UNIT = new THREE.Vector3(1, 1, 1);

// ----------------------------------------------------------- sub-assemblies

/**
 * A Picatinny rail: a base with a slotted top. The slots are what make a rail
 * legible at a glance, and they cost eight triangles each.
 */
function picatinny(f, mat, { z0, z1, y, w = 0.021, x = 0 }) {
  const len = z0 - z1;
  f.add(mat, slab(w, 0.005, len, { r: 0.001 }), x, y, (z0 + z1) / 2);
  const pitch = 0.0102;
  const n = Math.max(1, Math.floor(len / pitch));
  for (let i = 0; i < n; i++) {
    const z = z0 - pitch * (i + 0.5);
    f.add(mat, slab(w * 0.98, 0.0042, 0.0058, { r: 0.0008, bevel: 0.0009 }), x, y + 0.0044, z);
  }
}

/**
 * Front post inside a protective hood, and a rear notch to line it up with.
 *
 * `frontY`/`rearY` are the *sighting plane* — the top of the front blade and
 * the floor of the rear notch — not the base of either block, so that a weapon
 * held at `-sightY` puts its sights exactly on the camera axis. Building it the
 * other way round leaves the post standing a centimetre above the notch, which
 * looks fine in a side view and is obviously wrong the moment you aim.
 */
function ironSights(f, mat, { frontZ, frontY, rearZ, rearY, hood = true, w = 0.016 }) {
  f.sightY = frontY;
  // Front: a base block, and a blade whose tip reaches the sighting plane.
  f.add(mat, slab(0.0075, 0.010, 0.0075, { r: 0.0006, bevel: 0.0007 }), 0, frontY - 0.0125, frontZ);
  f.add(mat, slab(0.0022, 0.009, 0.0030, { r: 0.0004, bevel: 0.0004 }), 0, frontY - 0.0045, frontZ);
  if (hood) {
    f.add(mat, ring(0.0092, 0.0011, 14, Math.PI * 1.25), 0, frontY - 0.005, frontZ, 0, 0, -Math.PI * 0.125);
  }
  // Rear: a base whose top face is the notch floor, with an ear either side.
  f.add(mat, slab(w, 0.0075, 0.011, { r: 0.0008, bevel: 0.0007 }), 0, rearY - 0.00375, rearZ);
  f.add(mat, slab(0.0042, 0.0085, 0.0090, { r: 0.0006, bevel: 0.0006 }), w * 0.28, rearY + 0.00425, rearZ);
  f.add(mat, slab(0.0042, 0.0085, 0.0090, { r: 0.0006, bevel: 0.0006 }), -w * 0.28, rearY + 0.00425, rearZ);
}

/**
 * A pistol grip: a raked, slightly swollen column with finger grooves and a
 * flared base. Grooves are added rather than cut because additive detail keeps
 * the silhouette convex, which is what a hand actually wraps.
 */
function pistolGrip(f, mat, { x = 0, y, z, rake = 0.22, w = 0.030, h = 0.098, d = 0.046 }) {
  // The palm sits on the swell, a little above the grip's centre.
  f.gripAt = { x, y: y + h * 0.06, z: z - d * 0.06, rake };
  f.add(mat, slab(w, h, d, { r: 0.008 }), x, y, z, rake);
  // Palm swell.
  f.add(mat, slab(w * 1.12, h * 0.55, d * 0.72, { r: 0.010 }), x, y + h * 0.05, z, rake);
  // Front-strap finger grooves. `rake` is a rotation about X, so a local drop
  // of `t` lands at (y + t·cos, z − t·sin) — displacing it in X, as an earlier
  // version did, threw the whole lower half of the grip off to one side.
  for (let i = 0; i < 3; i++) {
    const t = -0.012 - i * 0.016;
    f.add(mat, rod(0.0035, w * 1.02, 0.0035, 8),
      x, y + t * Math.cos(rake), z - t * Math.sin(rake) - d * 0.44,
      0, Math.PI / 2, 0);
  }
  // Flared baseplate the magazine seats against.
  f.add(mat, slab(w * 1.18, 0.008, d * 1.06, { r: 0.003 }),
    x, y - Math.cos(rake) * (h / 2) - 0.002, z + Math.sin(rake) * (h / 2), rake);
}

/** A box magazine, filed under `mag` so the reload can drop it. */
function boxMag(f, mat, { x = 0, y, z, w = 0.026, h = 0.11, d = 0.036, rake = 0, curve = 0 }) {
  f.on('mag');
  const seg = curve ? 6 : 1;
  for (let i = 0; i < seg; i++) {
    const t = seg === 1 ? 0 : i / (seg - 1) - 0.5;
    const hh = h / seg;
    f.add(mat, slab(w, hh * 1.04, d, { r: 0.004 }),
      x, y + t * h, z + curve * t * t * 4 - curve * 0.25, rake + curve * t * 1.6);
  }
  // Floorplate and the witness rib up the spine.
  f.add(mat, slab(w * 1.15, 0.007, d * 1.1, { r: 0.002 }),
    x, y - Math.cos(rake) * h * 0.52, z + Math.sin(rake) * h * 0.52, rake);
  f.add(mat, slab(0.004, h * 0.8, 0.003, { r: 0.001, bevel: 0.0006 }),
    x + w * 0.5, y, z + d * 0.5 - 0.004, rake);
  f.on('body');
}

/**
 * Trigger guard and trigger. The loop is built in XY and turned a quarter turn
 * so its opening faces the side, which is how you see it in the hand.
 */
function triggerGroup(f, mat, { z, y, len = 0.050, h = 0.034, bar = 0.0050, w = 0.024 }) {
  f.add(mat, loop(len, h, bar, w), 0, y, z, 0, Math.PI / 2, 0);
  f.add('gunSteel', slab(0.0060, h * 0.62, 0.0090, { r: 0.003, bevel: 0.0006 }), 0, y + h * 0.10, z + len * 0.16, 0.18);
}

/** Hex socket-head screws. Small, but their absence is what reads as "untextured". */
function screws(f, mat, list) {
  for (const [x, y, z, r = 0.0022] of list) {
    f.add(mat, rod(r, 0.0016, r, 6), x, y, z);
    f.add(mat, rod(r * 0.55, 0.0022, r * 0.55, 6), x, y, z - 0.0004);
  }
}

// ------------------------------------------------------------- the weapons
/*
 * Each builder returns the muzzle's Z. Proportions are taken from the real
 * dimensions of the thing being suggested — a 1911 slide really is 32 mm wide
 * and a 30-round AK magazine really does curve through about 12 degrees —
 * because a silhouette that is subtly wrong reads as wrong even to a player
 * who has never held one.
 */

function buildKnife(f, spec) {
  const L = spec.model.bladeLen;
  // Blade: a long tapered slab with a fuller ground down the middle.
  f.add('gunBlued', slab(0.0042, 0.032, L, { r: 0.0012, bevel: 0.0010 }), 0, 0.004, -0.05 - L / 2);
  f.add('gunBlued', slab(0.0052, 0.010, L * 0.72, { r: 0.0008, bevel: 0.0008 }), 0, 0.006, -0.05 - L / 2);
  // Clip point.
  f.add('gunBlued', slab(0.0040, 0.020, 0.030, { r: 0.006, bevel: 0.0009 }), 0, 0.010, -0.05 - L - 0.010);
  // Brass knuckle bow and guard.
  f.add('gunBrass', slab(0.036, 0.014, 0.014, { r: 0.004 }), 0, -0.002, -0.044);
  for (let i = 0; i < 4; i++) {
    f.add('gunBrass', ring(0.0115, 0.0032, 10), -0.0165 + i * 0.011, -0.020, 0.006, Math.PI / 2, 0, 0);
  }
  // Ribbed handle.
  f.add('gunGrip', slab(0.026, 0.030, 0.098, { r: 0.010 }), 0, -0.004, 0.020);
  for (let i = 0; i < 6; i++) {
    f.add('gunGrip', rod(0.0016, 0.026, 0.0016, 6), 0, -0.019, -0.014 + i * 0.016, 0, Math.PI / 2, 0);
  }
  f.add('gunBrass', slab(0.028, 0.020, 0.012, { r: 0.004 }), 0, -0.004, 0.072);
  return -0.06 - L - 0.020;
}

function buildPistol(f) {
  // ---- frame. A 1911's slide is 25 mm tall over a 22 mm frame, not the brick
  // you get by eye: keeping to the real numbers is most of the silhouette.
  f.add('gunAlloy', slab(0.0250, 0.022, 0.180, { r: 0.004 }), 0, -0.017, -0.056);
  f.add('gunAlloy', slab(0.0250, 0.007, 0.034, { r: 0.002 }), 0, -0.045, -0.018);  // guard underside
  f.add('gunAlloy', slab(0.0290, 0.024, 0.032, { r: 0.006 }), 0, -0.010, 0.026);   // beavertail tang
  triggerGroup(f, 'gunAlloy', { z: -0.014, y: -0.034, len: 0.046, h: 0.030, w: 0.023 });
  // ---- slide (reciprocates)
  f.on('slide');
  f.add('gunBlued', slab(0.0320, 0.027, 0.196, { r: 0.004 }), 0, 0.008, -0.060);
  // Ejection port, cut as a step rather than a hole: cheaper and reads the same.
  f.add('gunBlued', slab(0.0170, 0.011, 0.050, { r: 0.002 }), 0.011, 0.014, -0.026);
  // Cocking serrations.
  for (let i = 0; i < 9; i++) {
    f.add('gunBlued', slab(0.0332, 0.019, 0.0022, { r: 0.0004, bevel: 0.0005 }), 0, 0.008, 0.016 - i * 0.0050);
  }
  // Barrel bushing and the barrel through it.
  f.add('gunBlued', lathe([[0, 0], [0.0126, 0], [0.0126, 0.009], [0.0096, 0.009]]), 0, 0.008, -0.156);
  f.on('body');
  f.add('gunBlued', barrel(0.0086, 0.0052, 0.030, { boreDepth: 0.020 }), 0, 0.008, -0.140);
  // Hammer, thumb safety, slide stop.
  f.add('gunSteel', ring(0.0072, 0.0020, 10, Math.PI), 0, 0.014, 0.038, 0, 0, Math.PI * 0.15);
  f.add('gunSteel', slab(0.0055, 0.008, 0.026, { r: 0.002 }), -0.015, -0.002, 0.014);
  f.add('gunSteel', slab(0.0050, 0.009, 0.018, { r: 0.002 }), -0.014, -0.008, -0.030);
  // ---- grip, checkered panels, magazine
  pistolGrip(f, 'gunGrip', { y: -0.068, z: 0.028, rake: 0.26, w: 0.029, h: 0.086, d: 0.042 });
  f.add('gunWood', knurl(slab(0.0035, 0.058, 0.032, { r: 0.004 }), 40, 0.0004, 420), 0.0160, -0.064, 0.026, 0.26);
  f.add('gunWood', knurl(slab(0.0035, 0.058, 0.032, { r: 0.004 }), 40, 0.0004, 420), -0.0160, -0.064, 0.026, 0.26);
  boxMag(f, 'gunSteel', { y: -0.072, z: 0.028, w: 0.020, h: 0.086, d: 0.029, rake: 0.26 });
  ironSights(f, 'gunBlued', { frontZ: -0.146, frontY: 0.022, rearZ: 0.024, rearY: 0.022, hood: false, w: 0.022 });
  screws(f, 'gunSteel', [[0.0175, -0.062, 0.020], [-0.0175, -0.062, 0.020]]);
  return -0.172;
}

function buildRevolver(f) {
  f.add('gunSteel', slab(0.0240, 0.042, 0.108, { r: 0.006 }), 0, 0.008, -0.018);   // frame
  triggerGroup(f, 'gunSteel', { z: -0.006, y: -0.028, len: 0.044, h: 0.032, w: 0.022 });
  // ---- cylinder (indexes on fire)
  f.on('cylinder');
  const cyl = flute(rod(0.0245, 0.052, 0.0245, 28), 6, 0.0022);
  f.add('gunBlued', cyl, 0, 0.008, -0.006);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    f.add('gunBrass', rod(0.0052, 0.004, 0.0052, 10),
      Math.cos(a) * 0.0138, 0.008 + Math.sin(a) * 0.0138, 0.019);
  }
  f.add('gunSteel', rod(0.0050, 0.056, 0.0050, 10), 0, 0.008, -0.006);   // crane pin
  f.on('body');
  // ---- barrel with a vent rib and a full underlug
  f.add('gunBlued', barrel(0.0115, 0.0058, 0.150, { boreDepth: 0.06 }), 0, 0.010, -0.072);
  f.add('gunBlued', slab(0.0112, 0.0042, 0.146, { r: 0.001 }), 0, 0.0228, -0.106);  // vent rib
  for (let i = 0; i < 7; i++) {
    f.add('gunBlued', slab(0.0072, 0.0075, 0.0060, { r: 0.001, bevel: 0.0006 }), 0, 0.0175, -0.050 - i * 0.017);
  }
  f.add('gunBlued', slab(0.0150, 0.020, 0.140, { r: 0.005 }), 0, -0.008, -0.104);  // underlug
  f.add('gunSteel', rod(0.0042, 0.120, 0.0042, 10), 0, -0.008, -0.100);            // ejector rod
  // ---- hammer and grips
  f.add('gunSteel', slab(0.0060, 0.026, 0.016, { r: 0.004 }), 0, 0.030, 0.044, -0.5);
  f.add('gunSteel', knurl(slab(0.0075, 0.010, 0.012, { r: 0.002 }), 18, 0.0004, 500), 0, 0.042, 0.048, -0.5);
  pistolGrip(f, 'gunWood', { y: -0.062, z: 0.018, rake: 0.38, w: 0.030, h: 0.082, d: 0.040 });
  ironSights(f, 'gunBlued', { frontZ: -0.214, frontY: 0.037, rearZ: 0.030, rearY: 0.037, hood: false, w: 0.020 });
  return -0.226;
}

function buildSmg(f) {
  // Polymer lower, alloy upper, rail across the top.
  f.add('gunGrip', slab(0.0420, 0.062, 0.250, { r: 0.008 }), 0, -0.006, -0.075);
  f.add('gunAlloy', slab(0.0400, 0.030, 0.240, { r: 0.005 }), 0, 0.026, -0.080);
  picatinny(f, 'gunAlloy', { z0: 0.030, z1: -0.185, y: 0.042 });
  // Barrel shroud with cooling slots, then the barrel itself.
  f.add('gunAlloy', lathe([[0, 0], [0.0165, 0], [0.0165, 0.086], [0.0130, 0.090], [0.0130, 0.092], [0, 0.092]]),
    0, 0.014, -0.196);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    f.add('gunSteel', slab(0.0060, 0.0035, 0.052, { r: 0.001, bevel: 0.0006 }),
      Math.cos(a) * 0.0152, 0.014 + Math.sin(a) * 0.0152, -0.242, 0, 0, a);
  }
  f.add('gunBlued', barrel(0.0092, 0.0046, 0.070, { boreDepth: 0.04 }), 0, 0.014, -0.250);
  // Ejection port and charging handle (the bolt group).
  f.on('bolt');
  f.add('gunAlloy', slab(0.0090, 0.014, 0.040, { r: 0.002 }), 0.023, 0.026, -0.088);
  f.add('gunSteel', knurl(rod(0.0055, 0.026, 0.0055, 12), 14, 0.0004, 400), 0.032, 0.026, -0.088, 0, Math.PI / 2, 0);
  f.on('body');
  // Grips and stock.
  pistolGrip(f, 'gunGrip', { y: -0.078, z: 0.016, rake: 0.14, w: 0.030, h: 0.100, d: 0.046 });
  f.add('gunGrip', slab(0.0300, 0.058, 0.038, { r: 0.008 }), 0, -0.052, -0.176, -0.18);   // vertical foregrip
  f.add('gunAlloy', slab(0.0180, 0.020, 0.084, { r: 0.004 }), 0.014, 0.004, 0.128);       // folding stock rails
  f.add('gunAlloy', slab(0.0180, 0.020, 0.084, { r: 0.004 }), -0.014, 0.004, 0.128);
  f.add('gunGrip', slab(0.0400, 0.052, 0.020, { r: 0.006 }), 0, 0.002, 0.176);            // buttplate
  boxMag(f, 'gunAlloy', { y: -0.082, z: -0.070, w: 0.026, h: 0.116, d: 0.038, rake: -0.10, curve: 0.010 });
  ironSights(f, 'gunAlloy', { frontZ: -0.178, frontY: 0.050, rearZ: 0.018, rearY: 0.050 });
  return -0.324;
}

function buildRifle(f) {
  // Stamped receiver with the classic AK dust cover and rear sight block.
  f.add('gunSteel', slab(0.0400, 0.062, 0.270, { r: 0.006 }), 0, -0.002, -0.100);
  f.on('bolt');
  // The cover, the upper handguard and the gas tube all sit *under* the line
  // from notch to post. An AK with a dust cover level with its rear sight looks
  // right from the side and blinds you the moment you aim down it.
  f.add('gunSteel', slab(0.0420, 0.022, 0.190, { r: 0.010 }), 0, 0.030, -0.086);           // dust cover
  f.add('gunSteel', slab(0.0120, 0.016, 0.030, { r: 0.003 }), 0.024, 0.026, -0.008);       // charging handle
  f.on('body');
  // Wood furniture: handguard with vent slots, upper guard, stock.
  f.add('gunWood', slab(0.0400, 0.044, 0.150, { r: 0.010 }), 0, -0.010, -0.268);
  f.add('gunWood', slab(0.0340, 0.026, 0.130, { r: 0.008 }), 0, 0.024, -0.262);
  for (let i = 0; i < 4; i++) {
    f.add('gunSteel', slab(0.0410, 0.0055, 0.024, { r: 0.001, bevel: 0.0007 }), 0, -0.026, -0.226 - i * 0.030);
  }
  f.add('gunWood', slab(0.0330, 0.058, 0.180, { r: 0.012 }), 0, -0.020, 0.152, -0.055);
  f.add('gunSteel', slab(0.0340, 0.052, 0.014, { r: 0.004 }), 0, -0.030, 0.240, -0.055);
  // Gas block, gas tube, front sight tower, slotted brake.
  f.add('gunSteel', slab(0.0220, 0.038, 0.034, { r: 0.004 }), 0, 0.018, -0.344, 0.30);
  f.add('gunSteel', rod(0.0090, 0.130, 0.0090, 14), 0, 0.028, -0.276);
  f.add('gunBlued', barrel(0.0092, 0.0050, 0.130, { boreDepth: 0.05 }), 0, 0.006, -0.340);
  f.add('gunSteel', slab(0.0200, 0.040, 0.026, { r: 0.004 }), 0, 0.016, -0.436);
  const brake = lathe([[0, 0], [0.0155, 0], [0.0155, 0.036], [0.0110, 0.040], [0.0062, 0.040], [0.0062, 0.010], [0, 0.010]]);
  f.add('gunBlued', brake, 0, 0.006, -0.446);
  for (let i = 0; i < 3; i++) {
    f.add('gunBlued', slab(0.0330, 0.0050, 0.0060, { r: 0.001, bevel: 0.0007 }), 0, 0.020, -0.456 - i * 0.011);
  }
  // Grip, curved 30-round magazine, safety lever.
  triggerGroup(f, 'gunGrip', { z: -0.030, y: -0.044, len: 0.046, h: 0.032, w: 0.026 });
  pistolGrip(f, 'gunGrip', { y: -0.082, z: 0.008, rake: 0.20, w: 0.030, h: 0.100, d: 0.048 });
  boxMag(f, 'gunSteel', { y: -0.086, z: -0.096, w: 0.026, h: 0.130, d: 0.042, rake: -0.06, curve: 0.040 });
  f.add('gunSteel', slab(0.0045, 0.070, 0.020, { r: 0.004 }), 0.022, 0.006, -0.036, 0.35);
  ironSights(f, 'gunSteel', { frontZ: -0.430, frontY: 0.050, rearZ: -0.176, rearY: 0.050 });
  return -0.492;
}

function buildShotgun(f) {
  f.add('gunSteel', slab(0.0400, 0.058, 0.210, { r: 0.007 }), 0, -0.002, -0.058);
  triggerGroup(f, 'gunSteel', { z: -0.014, y: -0.038, len: 0.050, h: 0.034, w: 0.026 });
  // Ejection port and loading gate.
  f.add('gunBlued', slab(0.0180, 0.024, 0.070, { r: 0.003 }), 0.012, 0.008, -0.062);
  f.add('gunBrass', rod(0.0092, 0.006, 0.0092, 12), 0.022, 0.008, -0.052, 0, Math.PI / 2, 0);
  // Vent-rib barrel over a magazine tube.
  f.add('gunBlued', barrel(0.0168, 0.0122, 0.300, { boreDepth: 0.10 }), 0, 0.016, -0.160);
  f.add('gunBlued', slab(0.0110, 0.008, 0.290, { r: 0.002 }), 0, 0.032, -0.310);
  for (let i = 0; i < 12; i++) {
    f.add('gunBlued', slab(0.0114, 0.0055, 0.0075, { r: 0.001, bevel: 0.0006 }), 0, 0.034, -0.180 - i * 0.023);
  }
  f.add('gunSteel', rod(0.0118, 0.278, 0.0118, 16), 0, -0.012, -0.298);
  f.add('gunSteel', knurl(rod(0.0128, 0.016, 0.0128, 16), 20, 0.0004, 400), 0, -0.012, -0.432);
  f.add('gunSteel', ring(0.0150, 0.0026, 12), 0, 0.002, -0.300, 0, 0, 0);
  // ---- pump (cycles after each shot)
  f.on('pump');
  f.add('gunGrip', slab(0.0400, 0.044, 0.100, { r: 0.009 }), 0, -0.010, -0.236);
  for (let i = 0; i < 7; i++) {
    f.add('gunGrip', slab(0.0412, 0.046, 0.0035, { r: 0.002, bevel: 0.0006 }), 0, -0.010, -0.198 - i * 0.0125);
  }
  f.on('body');
  // Stock: polymer, with a recoil pad and a sling loop.
  f.add('gunGrip', slab(0.0330, 0.062, 0.190, { r: 0.012 }), 0, -0.028, 0.148, -0.075);
  f.add('gunGrip', slab(0.0340, 0.054, 0.016, { r: 0.005 }), 0, -0.040, 0.240, -0.075);
  f.add('gunSteel', ring(0.0090, 0.0022, 10), 0, -0.052, 0.200, Math.PI / 2, 0, 0);
  pistolGrip(f, 'gunGrip', { y: -0.076, z: 0.016, rake: 0.24, w: 0.030, h: 0.092, d: 0.046 });
  // Brass bead front sight.
  f.add('gunBrass', rod(0.0026, 0.005, 0.0026, 8), 0, 0.038, -0.448);
  f.sightY = 0.040;            // you aim a bead gun off the top of the rib
  return -0.466;
}

function buildSniper(f) {
  // Alloy chassis with a bedded action.
  f.add('gunAlloy', slab(0.0420, 0.066, 0.320, { r: 0.007 }), 0, 0.000, -0.100);
  f.add('gunSteel', slab(0.0380, 0.044, 0.180, { r: 0.005 }), 0, 0.010, -0.086);
  f.add('gunGrip', slab(0.0440, 0.030, 0.190, { r: 0.010 }), 0, -0.038, -0.196);      // forend
  for (let i = 0; i < 5; i++) {
    f.add('gunGrip', slab(0.0452, 0.0060, 0.020, { r: 0.001, bevel: 0.0007 }), 0, -0.050, -0.148 - i * 0.032);
  }
  // Heavy fluted barrel and a big brake.
  const bbl = flute(rod(0.0135, 0.300, 0.0118, 22), 6, 0.0016);
  f.add('gunBlued', bbl, 0, 0.010, -0.400);
  f.add('gunBlued', barrel(0.0118, 0.0062, 0.030, { boreDepth: 0.02 }), 0, 0.010, -0.548);
  f.add('gunSteel', lathe([[0, 0], [0.0210, 0], [0.0210, 0.052], [0.0150, 0.056], [0.0072, 0.056], [0.0072, 0.012], [0, 0.012]]),
    0, 0.010, -0.574);
  for (let i = 0; i < 4; i++) {
    f.add('gunSteel', slab(0.0440, 0.0055, 0.0070, { r: 0.001, bevel: 0.0007 }), 0, 0.028, -0.586 - i * 0.012);
  }
  // Bolt handle.
  f.on('bolt');
  f.add('gunSteel', rod(0.0055, 0.040, 0.0055, 12), 0.028, 0.018, -0.010, 0, Math.PI / 2, 0);
  f.add('gunSteel', rod(0.0090, 0.012, 0.0090, 12), 0.048, 0.018, -0.010, 0, Math.PI / 2, 0);
  f.on('body');
  // ---- optic
  picatinny(f, 'gunAlloy', { z0: 0.010, z1: -0.150, y: 0.038, w: 0.024 });
  f.add('gunAlloy', slab(0.0180, 0.030, 0.022, { r: 0.003 }), 0, 0.052, -0.026);   // rings
  f.add('gunAlloy', slab(0.0180, 0.030, 0.022, { r: 0.003 }), 0, 0.052, -0.132);
  f.add('gunAlloy', lathe([
    [0, 0], [0.0180, 0], [0.0180, 0.030], [0.0148, 0.036], [0.0148, 0.150],
    [0.0250, 0.158], [0.0250, 0.196], [0.0242, 0.200], [0, 0.200],
  ]), 0, 0.066, -0.010, 0, 0, 0);
  // Turrets, knurled, with index lines.
  f.add('gunAlloy', knurl(rod(0.0105, 0.016, 0.0105, 16), 22, 0.0004, 420), 0, 0.084, -0.062);
  f.add('gunAlloy', knurl(rod(0.0105, 0.016, 0.0105, 16), 22, 0.0004, 420), 0.018, 0.066, -0.062, 0, Math.PI / 2, 0);
  // Objective lens, ocular lens, and the reticle that sits on the glass.
  f.add('gunGlass', rod(0.0238, 0.002, 0.0238, 24), 0, 0.066, -0.208);
  f.add('gunGlass', rod(0.0140, 0.002, 0.0140, 20), 0, 0.066, -0.008);
  f.sightY = 0.066;            // the optical axis
  f.on('reticle');
  f.add('gunGlow', slab(0.0006, 0.020, 0.0004, { r: 0.0001, bevel: 0.0001 }), 0, 0.066, -0.010);
  f.add('gunGlow', slab(0.0200, 0.0006, 0.0004, { r: 0.0001, bevel: 0.0001 }), 0, 0.066, -0.010);
  f.on('body');
  // Stock, cheek riser, folded bipod.
  f.add('gunGrip', slab(0.0350, 0.070, 0.210, { r: 0.012 }), 0, -0.024, 0.168, -0.05);
  f.add('gunGrip', slab(0.0300, 0.024, 0.110, { r: 0.006 }), 0, 0.020, 0.140, -0.05);
  f.add('gunGrip', slab(0.0360, 0.060, 0.018, { r: 0.005 }), 0, -0.034, 0.268, -0.05);
  f.add('gunSteel', rod(0.0038, 0.150, 0.0032, 10), 0.012, -0.056, -0.246, 0.16, 0, 0.10);
  f.add('gunSteel', rod(0.0038, 0.150, 0.0032, 10), -0.012, -0.056, -0.246, 0.16, 0, -0.10);
  triggerGroup(f, 'gunAlloy', { z: -0.024, y: -0.046, len: 0.046, h: 0.032, w: 0.026 });
  pistolGrip(f, 'gunGrip', { y: -0.084, z: 0.014, rake: 0.16, w: 0.030, h: 0.104, d: 0.048 });
  boxMag(f, 'gunAlloy', { y: -0.068, z: -0.096, w: 0.028, h: 0.078, d: 0.050, rake: 0 });
  return -0.636;
}

function buildLmg(f) {
  // Rotor housing and receiver.
  f.add('gunAlloy', slab(0.0560, 0.084, 0.300, { r: 0.010 }), 0, 0.000, -0.090);
  f.add('gunSteel', lathe([[0, 0], [0.0460, 0], [0.0460, 0.052], [0.0380, 0.058], [0, 0.058]]), 0, 0.010, -0.236);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    f.add('gunSteel', slab(0.0080, 0.0060, 0.040, { r: 0.001, bevel: 0.0007 }),
      Math.cos(a) * 0.0420, 0.010 + Math.sin(a) * 0.0420, -0.230, 0, 0, a);
  }
  // ---- spinning barrel cluster
  f.on('spin');
  f.add('gunSteel', rod(0.0180, 0.030, 0.0180, 16), 0, 0.010, -0.290);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const x = Math.cos(a) * 0.0262, y = 0.010 + Math.sin(a) * 0.0262;
    f.add('gunBlued', rod(0.0072, 0.240, 0.0072, 12), x, y, -0.420);
    f.add('gunBlued', barrel(0.0072, 0.0040, 0.014, { boreDepth: 0.010 }), x, y, -0.538);
  }
  // The clamp that ties the muzzle ends together.
  f.add('gunSteel', lathe([[0.0180, 0], [0.0345, 0], [0.0345, 0.014], [0.0180, 0.014]]), 0, 0.010, -0.534);
  f.on('body');
  // Ammo drum with a feed chute, and spade grips.
  // The drum lies across the receiver: rotated about Y, the lathe runs out
  // along -X, so its bands have to march the same way.
  f.add('gunSteel', lathe([[0, 0], [0.0520, 0], [0.0520, 0.110], [0, 0.110]], 20), 0.072, -0.046, 0.070, 0, Math.PI / 2, 0);
  for (let i = 0; i < 5; i++) {
    f.add('gunSteel', ring(0.0524, 0.0022, 18), 0.060 - i * 0.022, -0.046, 0.070, 0, Math.PI / 2, 0);
  }
  f.add('gunGrip', slab(0.0300, 0.030, 0.140, { r: 0.008 }), 0.040, -0.030, -0.010, 0, -0.28, 0);
  for (let i = 0; i < 6; i++) {
    f.add('gunBrass', rod(0.0048, 0.020, 0.0048, 8), 0.040, -0.030, -0.060 + i * 0.018, 0, Math.PI / 2, 0);
  }
  pistolGrip(f, 'gunGrip', { y: -0.086, z: 0.032, rake: 0.10, w: 0.032, h: 0.104, d: 0.050 });
  f.add('gunGrip', slab(0.0340, 0.062, 0.140, { r: 0.010 }), 0, -0.030, 0.150, -0.06);
  f.add('gunAlloy', slab(0.0180, 0.026, 0.060, { r: 0.004 }), 0, 0.052, -0.150);
  return -0.556;
}

function buildFlamer(f) {
  // Valve body and regulator.
  f.add('gunSteel', slab(0.0440, 0.054, 0.200, { r: 0.008 }), 0, 0.000, -0.060);
  f.add('gunSteel', lathe([[0, 0], [0.0180, 0], [0.0180, 0.022], [0.0120, 0.026], [0, 0.026]]), 0, 0.020, -0.126);
  f.add('gunBrass', knurl(rod(0.0135, 0.014, 0.0135, 16), 24, 0.0005, 380), 0.024, 0.010, -0.060, 0, Math.PI / 2, 0);
  f.add('gunBrass', ring(0.0180, 0.0030, 14), -0.026, 0.014, -0.040, 0, Math.PI / 2, 0);  // valve wheel
  for (let i = 0; i < 4; i++) {
    f.add('gunBrass', rod(0.0022, 0.034, 0.0022, 6), -0.026, 0.014, -0.040, 0, Math.PI / 2, (i / 4) * Math.PI);
  }
  // Lance: a long tube stepping down to a flared nozzle with a pilot ring.
  f.add('gunSteel', rod(0.0125, 0.150, 0.0110, 16), 0, 0.014, -0.230);
  f.add('gunSteel', lathe([
    [0, 0], [0.0110, 0], [0.0110, 0.020], [0.0250, 0.052], [0.0250, 0.060],
    [0.0205, 0.060], [0.0205, 0.026], [0.0086, 0.010], [0, 0.010],
  ]), 0, 0.014, -0.300);
  f.add('gunBrass', ring(0.0225, 0.0022, 16), 0, 0.014, -0.348);
  f.on('pilot');
  f.add('gunGlow', ring(0.0180, 0.0030, 14), 0, 0.014, -0.344);
  f.on('body');
  // Pilot fuel line running back along the lance.
  f.add('gunBrass', rod(0.0032, 0.230, 0.0032, 8), 0.017, 0.030, -0.240);
  // Twin fuel tanks with gauges and a cross-brace.
  // Tanks lie fore-and-aft along the barrel axis, so the lathe needs no
  // rotation at all: placed at its rear, it grows forward on its own.
  for (const sx of [1, -1]) {
    f.add('gunSteel', lathe([[0, 0], [0.0480, 0], [0.0480, 0.180], [0, 0.180]], 20),
      sx * 0.062, -0.036, 0.320);
    f.add('gunSteel', ring(0.0484, 0.0024, 18), sx * 0.062, -0.036, 0.170);
    f.add('gunSteel', ring(0.0484, 0.0024, 18), sx * 0.062, -0.036, 0.290);
    f.add('gunBrass', rod(0.0090, 0.010, 0.0090, 10), sx * 0.062, 0.020, 0.230);
  }
  f.add('gunSteel', rod(0.0060, 0.124, 0.0060, 8), 0, -0.036, 0.200, 0, Math.PI / 2, 0);
  pistolGrip(f, 'gunGrip', { y: -0.074, z: 0.012, rake: 0.20, w: 0.030, h: 0.092, d: 0.046 });
  f.add('gunGrip', slab(0.0300, 0.052, 0.038, { r: 0.008 }), 0, -0.048, -0.150, -0.20);
  return -0.366;
}

function buildTesla(f) {
  f.add('gunGrip', slab(0.0500, 0.060, 0.240, { r: 0.010 }), 0, -0.004, -0.066);
  f.add('gunAlloy', slab(0.0460, 0.026, 0.220, { r: 0.005 }), 0, 0.030, -0.070);
  // Vented shroud over the emitter.
  f.add('gunAlloy', lathe([[0, 0], [0.0300, 0], [0.0300, 0.120], [0.0230, 0.128], [0, 0.128]]), 0, 0.014, -0.182);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    f.add('gunAlloy', slab(0.0070, 0.0040, 0.086, { r: 0.001, bevel: 0.0006 }),
      Math.cos(a) * 0.0286, 0.014 + Math.sin(a) * 0.0286, -0.256, 0, 0, a);
  }
  // Coil stack: rings of decreasing radius up the emitter.
  for (let i = 0; i < 5; i++) {
    f.add('gunBrass', ring(0.0245 - i * 0.0022, 0.0030, 16), 0, 0.014, -0.210 - i * 0.022);
  }
  f.add('gunSteel', rod(0.0110, 0.170, 0.0110, 14), 0, 0.014, -0.240);
  // Charge core and capacitor bank.
  f.on('core');
  f.add('gunGlow', rod(0.0086, 0.140, 0.0086, 14), 0, 0.014, -0.240);
  f.add('gunGlow', rod(0.0130, 0.050, 0.0130, 14), 0, 0.014, -0.110);
  f.on('body');
  f.add('gunGlass', lathe([[0, 0], [0.0170, 0], [0.0170, 0.058], [0, 0.058]], 18), 0, 0.014, -0.142);
  for (const sx of [1, -1]) {
    f.add('gunSteel', rod(0.0125, 0.090, 0.0125, 14), sx * 0.030, -0.026, -0.040);
    f.add('gunBrass', ring(0.0128, 0.0022, 12), sx * 0.030, -0.026, -0.082);
  }
  // Cooling fins along the receiver.
  for (let i = 0; i < 7; i++) {
    f.add('gunAlloy', slab(0.0520, 0.0050, 0.0075, { r: 0.001, bevel: 0.0007 }), 0, 0.046, -0.016 - i * 0.020);
  }
  pistolGrip(f, 'gunGrip', { y: -0.078, z: 0.016, rake: 0.18, w: 0.030, h: 0.098, d: 0.046 });
  f.add('gunGrip', slab(0.0360, 0.056, 0.150, { r: 0.010 }), 0, -0.022, 0.140, -0.06);
  f.add('gunGrip', slab(0.0300, 0.048, 0.036, { r: 0.008 }), 0, -0.046, -0.164, -0.18);
  return -0.330;
}

function buildLauncher(f) {
  // Launch tube with a blast cone at the back and a heat shield along the top.
  f.add('gunSteel', rod(0.0330, 0.360, 0.0330, 20), 0, 0.012, -0.140);
  f.add('gunSteel', lathe([[0.0330, 0], [0.0330, 0.010], [0.0470, 0.062], [0.0430, 0.062], [0.0300, 0.012], [0.0300, 0]]),
    0, 0.012, 0.040, Math.PI, 0, 0);
  f.add('gunWood', slab(0.0420, 0.030, 0.180, { r: 0.010 }), 0, 0.040, -0.180);
  for (let i = 0; i < 6; i++) {
    f.add('gunWood', slab(0.0430, 0.0055, 0.014, { r: 0.001, bevel: 0.0007 }), 0, 0.052, -0.110 - i * 0.028);
  }
  f.add('gunSteel', ring(0.0345, 0.0032, 18), 0, 0.012, -0.060);
  f.add('gunSteel', ring(0.0345, 0.0032, 18), 0, 0.012, -0.250);
  // The warhead, sitting proud of the muzzle. It is the point of the weapon.
  f.on('mag');
  f.add('gunSteel', lathe([
    [0, 0], [0.0170, 0.010], [0.0300, 0.048], [0.0300, 0.086], [0.0210, 0.096], [0.0210, 0.130], [0, 0.130],
  ], 20), 0, 0.012, -0.430, Math.PI, 0, 0);
  f.add('gunBrass', ring(0.0304, 0.0026, 16), 0, 0.012, -0.386);
  for (let i = 0; i < 4; i++) {
    f.add('gunSteel', slab(0.0030, 0.036, 0.040, { r: 0.002, bevel: 0.0007 }),
      0, 0.012, -0.300, 0, 0, (i / 4) * Math.PI);
  }
  f.on('body');
  // Optical sight on a folding mount, plus the trigger group.
  f.add('gunAlloy', slab(0.0140, 0.044, 0.014, { r: 0.003 }), -0.030, 0.052, -0.140);
  f.add('gunAlloy', lathe([[0, 0], [0.0130, 0], [0.0130, 0.062], [0.0170, 0.068], [0, 0.068]]), -0.030, 0.076, -0.150);
  f.add('gunGlass', rod(0.0162, 0.002, 0.0162, 18), -0.030, 0.076, -0.220);
  f.add('gunSteel', slab(0.0300, 0.040, 0.060, { r: 0.006 }), 0, -0.024, -0.030);
  pistolGrip(f, 'gunGrip', { y: -0.078, z: 0.008, rake: 0.22, w: 0.030, h: 0.094, d: 0.046 });
  f.add('gunGrip', slab(0.0300, 0.050, 0.038, { r: 0.008 }), 0, -0.050, -0.180, -0.18);
  f.add('gunGrip', slab(0.0400, 0.056, 0.024, { r: 0.008 }), 0, 0.012, 0.108, 0.30);   // shoulder rest
  return -0.434;
}

function buildRailgun(f) {
  f.add('gunGrip', slab(0.0520, 0.070, 0.290, { r: 0.010 }), 0, -0.004, -0.080);
  f.add('gunAlloy', slab(0.0480, 0.028, 0.270, { r: 0.005 }), 0, 0.034, -0.086);
  picatinny(f, 'gunAlloy', { z0: 0.030, z1: -0.140, y: 0.050 });
  // Twin rails with the accelerator channel between them.
  for (const sx of [1, -1]) {
    f.add('gunSteel', slab(0.0110, 0.020, 0.380, { r: 0.002 }), sx * 0.020, 0.018, -0.330);
    for (let i = 0; i < 9; i++) {
      f.add('gunAlloy', slab(0.0140, 0.026, 0.0060, { r: 0.001, bevel: 0.0007 }),
        sx * 0.020, 0.018, -0.180 - i * 0.038);
    }
  }
  f.on('core');
  f.add('gunGlow', slab(0.0250, 0.0055, 0.370, { r: 0.001, bevel: 0.0005 }), 0, 0.018, -0.330);
  f.on('body');
  // Capacitor bank under the barrel, with cooling fins and a charge lamp.
  for (const sx of [1, -1]) {
    f.add('gunSteel', rod(0.0165, 0.120, 0.0165, 16), sx * 0.020, -0.030, -0.140);
    f.add('gunBrass', ring(0.0168, 0.0024, 14), sx * 0.020, -0.030, -0.196);
    f.add('gunBrass', ring(0.0168, 0.0024, 14), sx * 0.020, -0.030, -0.084);
  }
  for (let i = 0; i < 8; i++) {
    f.add('gunAlloy', slab(0.0540, 0.0050, 0.0070, { r: 0.001, bevel: 0.0007 }), 0, 0.050, -0.010 - i * 0.019);
  }
  f.on('core');
  f.add('gunGlow', rod(0.0060, 0.024, 0.0060, 10), 0.026, 0.030, 0.026, 0, Math.PI / 2, 0);
  f.on('body');
  pistolGrip(f, 'gunGrip', { y: -0.084, z: 0.014, rake: 0.16, w: 0.032, h: 0.102, d: 0.048 });
  f.add('gunGrip', slab(0.0380, 0.066, 0.180, { r: 0.012 }), 0, -0.024, 0.156, -0.05);
  f.add('gunGrip', slab(0.0400, 0.058, 0.018, { r: 0.005 }), 0, -0.034, 0.248, -0.05);
  f.add('gunGrip', slab(0.0300, 0.054, 0.038, { r: 0.008 }), 0, -0.052, -0.180, -0.18);
  boxMag(f, 'gunAlloy', { y: -0.070, z: -0.086, w: 0.030, h: 0.084, d: 0.052, rake: 0 });
  return -0.526;
}

/*
 * -------------------------------------------------------------- melee
 *
 * The lethal end of the improvised arsenal. Where the scanned props are
 * whatever was lying around, these are things somebody keeps for a reason: a
 * blade, an axe, a hammer. They are also far easier to build than a firearm —
 * a machete is one tapered slab and a handle — so they are built rather than
 * downloaded.
 *
 * All three point down -Z with the grip on the origin, and set `f.gripAt` so
 * the hands rig has something to close on.
 */

/** A shaft with a wrapped grip, the common half of an axe and a hammer. */
function haft(f, { len, r = 0.017, mat = 'meleeWood', wrap = 0.20 }) {
  f.add(mat, rod(r, len, r * 0.86, 12), 0, 0, -len / 2 + 0.06);
  // Wrapped grip at the butt, and a swelled knob so it cannot slide out.
  f.add('gunGrip', rod(r * 1.16, wrap, r * 1.16, 12), 0, 0, 0.06 - wrap / 2);
  for (let i = 0; i < 7; i++) {
    f.add('gunGrip', ring(r * 1.2, 0.0022, 10), 0, 0, 0.045 - i * (wrap - 0.03) / 6, 0, 0, 0);
  }
  f.add('gunGrip', rod(r * 1.34, 0.016, r * 1.20, 12), 0, 0, 0.062);
}

function buildMachete(f) {
  const L = 0.44;                       // blade
  f.gripAt = { x: 0, y: 0, z: 0.02, rake: 0 };

  // Blade: a long slab that widens toward the tip, which is what a machete is
  // for — the mass wants to be out at the end of the swing, not at the hand.
  f.add('gunBlued', slab(0.0040, 0.052, L, { r: 0.004, bevel: 0.0012 }), 0, 0.010, -0.06 - L / 2);
  f.add('gunBlued', slab(0.0044, 0.070, L * 0.34, { r: 0.010, bevel: 0.0012 }),
    0, 0.016, -0.06 - L * 0.82);
  // Ground edge along the bottom: a second, thinner slab reads as a bevel.
  f.add('meleeAlu', slab(0.0018, 0.014, L * 0.96, { r: 0.001, bevel: 0.0006 }),
    0, -0.014, -0.06 - L / 2);
  // Spine ridge.
  f.add('gunBlued', slab(0.0062, 0.008, L * 0.9, { r: 0.001 }), 0, 0.032, -0.06 - L / 2);

  // Bolster and handle.
  f.add('meleeSteel', slab(0.020, 0.048, 0.016, { r: 0.004 }), 0, 0.006, -0.052);
  f.add('gunGrip', slab(0.026, 0.038, 0.115, { r: 0.012 }), 0, 0.002, 0.014);
  for (let i = 0; i < 5; i++) {
    f.add('gunGrip', rod(0.0022, 0.026, 0.0022, 8), 0, -0.016, -0.020 + i * 0.024, 0, Math.PI / 2, 0);
  }
  f.add('meleeSteel', slab(0.024, 0.030, 0.010, { r: 0.004 }), 0, 0.002, 0.076);
  // Lanyard hole through the butt.
  f.add('meleeSteel', ring(0.006, 0.0022, 10), 0, 0.002, 0.078, 0, Math.PI / 2, 0);
  return -0.06 - L - 0.02;
}

function buildAxe(f) {
  const len = 0.66;
  f.gripAt = { x: 0, y: 0, z: 0.02, rake: 0 };
  haft(f, { len, r: 0.016, wrap: 0.22 });

  const headZ = -len + 0.10;
  // The bit: a wedge that flares to the cutting edge, hung off one side of
  // the haft the way a real axe head is.
  f.add('meleeSteel', slab(0.020, 0.088, 0.050, { r: 0.006 }), 0, 0.010, headZ);
  f.add('meleeSteel', slab(0.014, 0.130, 0.030, { r: 0.010 }), 0, 0.030, headZ - 0.028);
  f.add('meleeAlu', slab(0.0055, 0.140, 0.012, { r: 0.004, bevel: 0.0008 }), 0, 0.034, headZ - 0.045);
  // Poll and spike on the back.
  f.add('meleeSteel', slab(0.022, 0.040, 0.034, { r: 0.005 }), 0, -0.030, headZ + 0.014);
  f.add('meleeSteel', slab(0.012, 0.020, 0.062, { r: 0.004 }), 0, -0.042, headZ + 0.052);
  // Collar where the head is wedged onto the haft.
  f.add('meleeSteel', rod(0.021, 0.030, 0.019, 12), 0, 0, headZ + 0.030);
  return headZ - 0.06;
}

function buildSledge(f) {
  const len = 0.78;
  f.gripAt = { x: 0, y: 0, z: 0.02, rake: 0 };
  haft(f, { len, r: 0.019, mat: 'meleeWood', wrap: 0.26 });

  const headZ = -len + 0.10;
  // A single block of steel across the end of the shaft, with the faces
  // chamfered. Nothing clever: the whole idea of the weapon is the mass.
  f.add('meleeSteel', rod(0.041, 0.150, 0.041, 14), 0, 0, headZ, 0, Math.PI / 2, 0);
  f.add('meleeAlu', rod(0.043, 0.014, 0.041, 14), -0.075, 0, headZ, 0, Math.PI / 2, 0);
  f.add('meleeAlu', rod(0.041, 0.014, 0.043, 14), 0.068, 0, headZ, 0, Math.PI / 2, 0);
  // Eye reinforcement where the shaft passes through.
  f.add('meleeSteel', rod(0.026, 0.042, 0.024, 12), 0, 0, headZ + 0.020);
  return headZ - 0.05;
}

const BUILDERS = {
  knife: buildKnife, pistol: buildPistol, revolver: buildRevolver, smg: buildSmg,
  rifle: buildRifle, shotgun: buildShotgun, sniper: buildSniper, lmg: buildLmg,
  flamer: buildFlamer, tesla: buildTesla, launcher: buildLauncher, railgun: buildRailgun,
  machete: buildMachete, axe: buildAxe, sledge: buildSledge,
};

/**
 * How each sub-group moves. The viewmodel reads this rather than special-casing
 * weapon ids, so a new weapon animates correctly the moment its builder files
 * parts under the right names.
 */
const MOTION = {
  pistol:   { slide: { travel: 0.030, time: 0.085 }, magDrop: 0.16 },
  revolver: { cylinder: { step: TAU / 6, time: 0.16 } },
  smg:      { bolt: { travel: 0.022, time: 0.060 }, magDrop: 0.18 },
  rifle:    { bolt: { travel: 0.026, time: 0.075 }, magDrop: 0.20 },
  shotgun:  { pump: { travel: 0.062, time: 0.30 } },
  sniper:   { bolt: { travel: 0.034, time: 0.30 }, magDrop: 0.14 },
  lmg:      { spin: { axis: 'z' } },
  launcher: { magDrop: 0.0, magForward: 0.30 },
  railgun:  { magDrop: 0.12 },
  tesla:    {},
  flamer:   {},
  knife:    {},
};

/**
 * Build one weapon. Returns a group whose children are the animated sub-groups,
 * each merged down to one mesh per material — so a rifle with a moving bolt and
 * a droppable magazine still costs well under a dozen draw calls.
 */
export function buildWeapon(spec, mats) {
  const f = forge();
  const build = BUILDERS[spec.model.type] || BUILDERS.pistol;
  const muzzleZ = build(f, spec);

  const group = new THREE.Group();
  group.name = `weapon:${spec.id}`;
  const parts = {};
  let glow = null;

  for (const [name, list] of f.groups) {
    const byMat = new Map();
    for (const p of list) {
      const geo = p.geo.index ? p.geo.toNonIndexed() : p.geo;
      if (geo !== p.geo) p.geo.dispose();
      if (!byMat.has(p.matKey)) byMat.set(p.matKey, []);
      byMat.get(p.matKey).push(geo);
    }
    const sub = new THREE.Group();
    sub.name = name;
    for (const [matKey, geos] of byMat) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      // Emissive parts get their own material instance so a charging railgun
      // cannot dim a scope reticle through a shared uniform.
      const base = mats.get(matKey) || mats.get('gunSteel');
      const mat = matKey === 'gunGlow' ? base.clone() : base;
      if (matKey === 'gunGlow') glow = mat;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = matKey === 'gunGlow' ? 5 : 4;
      sub.add(mesh);
    }
    group.add(sub);
    parts[name] = sub;
  }

  group.userData.muzzle = new THREE.Vector3(0, 0.012, muzzleZ);
  group.userData.parts = parts;
  group.userData.motion = MOTION[spec.model.type] || {};
  group.userData.sightY = f.sightY;
  // How far the weapon reaches behind its own origin. The viewmodel uses it to
  // decide how far forward to hold the weapon when aiming: a rifle whose butt
  // is against your shoulder must sit further out than a pistol at arm's
  // length, or the stock ends up filling the bottom of the screen.
  group.userData.rear = new THREE.Box3().setFromObject(group).max.z;
  group.userData.glow = glow;
  group.userData.grip = f.gripAt;
  if (spec.kind === 'melee' && spec.id !== 'knife') {
    // Carried like the scanned props: cocked, up and across, out of the sight
    // line. A blade held down the view axis is a line and nothing else.
    group.userData.melee = true;
    group.userData.gripAxis = [0, 0, 1];
    // Melee weapons are carried lower and further out than a gun is.
    group.userData.basePos = spec.model.basePos || [0.20, -0.34, -0.44];
    group.userData.adsPos = spec.model.adsPos || [0.15, -0.30, -0.50];
    // Same carry as the scanned props; see MELEE_REST in viewmodels.js.
    group.rotation.set(...(spec.model.rest || [-0.40, 0, 0]));
    group.userData.rest = group.rotation.clone();
    group.userData.tip = new THREE.Vector3(0, 0, muzzleZ);
  }
  group.userData.spec = spec;
  return group;
}

/** Triangle count, for the model preview and the perf report. */
export function triangleCount(group) {
  let n = 0;
  group.traverse((o) => { if (o.isMesh) n += o.geometry.attributes.position.count / 3; });
  return n;
}
