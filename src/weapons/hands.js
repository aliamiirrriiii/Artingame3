import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Gloved first-person hands, shared by every weapon.
 *
 * One of the twelve weapons — the Galil — arrived as a complete authored
 * composition: a rifle, a pair of gloved hands with full finger chains, and a
 * hold animation that puts one onto the other. The other eleven are built by
 * the gunsmith or adopted bare, and a floating gun with nothing holding it is
 * the single loudest tell that a first-person game is a prototype.
 *
 * So the arms are lifted out of that one asset and re-used. The hands mesh is
 * a separate primitive from the rifle inside the same skinned mesh, which
 * means it can be kept while the rifle is dropped, skeleton and all.
 *
 * Fitting them to a different weapon is two problems:
 *
 *   The trigger hand is rigid. Its authored grip — finger curl, thumb over the
 *   top, wrist angle — is better than anything that could be solved for, so it
 *   is not solved for. The whole rig is translated so that the right palm lands
 *   on the weapon's grip, and that is the entire fit.
 *
 *   The support hand is not. Palm-to-palm on the authored pose is 235 mm,
 *   which is a Galil; a revolver wants both hands touching and a railgun wants
 *   them half a metre apart. That one is a two-bone IK solve down the left arm
 *   onto a support point taken off the weapon's own geometry.
 *
 * The authored arms are already at full extension, so the support hand can be
 * drawn back toward the shooter but not pushed much further out. Support
 * points beyond reach are clamped, and the arm simply straightens.
 */

/** Metres per model unit — the same figure the Galil viewmodel is built at. */
const HAND_SCALE = 0.266;

/**
 * How far the fist is rolled around what it is holding.
 *
 * Aligning the knuckle line with the weapon's shaft leaves one degree of
 * freedom — the spin about that shaft — and the minimal rotation lands on the
 * wrong side of it, fingers under the handle rather than closed over it. Half
 * a turn puts the knuckles where a batter's are.
 */
const MELEE_ROLL = Math.PI;

/** Natural palm-to-palm distance in the authored pose, in metres. */
export const NATURAL_SPAN = 0.235;

/**
 * Where the support hand goes when a weapon does not say, and how far the
 * elbow is swung out from there.
 *
 * Deliberately shorter than the authored 235 mm. At the natural span the left
 * arm is at full extension, the elbow sits exactly on the line from shoulder
 * to wrist, and the pole vector has no effect at all — which also means the
 * forearm cannot be angled to carry its own cut end off the bottom of the
 * screen. Bringing the hand back a few centimetres puts a bend in the arm and
 * gives the elbow somewhere to go.
 */
const DEFAULT_SPAN = 0.195;
const POLE_BIAS = [-0.05, -0.34, 0.18];

/**
 * How far to drop a weapon at the hip once there are arms on it.
 *
 * The one authored viewmodel is held 90 mm lower than the bare gunsmith
 * weapons, and it is not framed differently for the sake of it: a gun with
 * arms attached has to sit low enough that the arms come in from the bottom
 * of the screen rather than ending in mid-air.
 */
const HIP_DROP = 0.060;

/**
 * Per-weapon-type adjustments to the derived fit. Everything here is a nudge
 * to a number the geometry already produced, in metres, in weapon space:
 *
 *   grip     — moves the trigger palm off the grip the gunsmith recorded.
 *   support  — moves the support palm off the derived handguard point.
 *   span     — overrides how far ahead of the grip the support hand sits.
 *   roll     — twists the support forearm about its own axis, radians.
 *   oneHanded — collapses the left arm out of sight.
 */
const FIT = {
  knife:    { oneHanded: true, grip: [0, -0.012, 0.030] },
  pistol:   { span: 0.055, support: [-0.045, -0.022, 0.010] },
  revolver: { span: 0.060, support: [-0.045, -0.020, 0.010] },
  smg:      { span: 0.160 },
  lmg:      { span: 0.215 },
  shotgun:  { span: 0.195 },
  sniper:   { span: 0.180 },
  flamer:   { span: 0.175 },
  tesla:    { span: 0.170 },
  launcher: { span: 0.185 },
  railgun:  { span: 0.205 },

  // Improvised melee. A bat is held with both fists together at the butt, a
  // wet-floor sign at two points a foot apart, a drill in one hand — the span
  // is most of what tells one hold from another.
  bat:      { span: 0.135 },
  // Two of these are flat rather than round, and the roll about the shaft
  // decides whether you are looking at a blade or at a line. A machete turned
  // edge-on to the camera is invisible; a wet-floor sign turned face-on is a
  // wall across half the screen.
  machete:  { span: 0.090, gripRoll: 1.57 },
  sign:     { span: 0.300, gripRoll: 4.71 },
  pan:      { span: 0.105 },
  drill:    { oneHanded: true },
  ukulele:  { span: 0.260 },
  axe:      { span: 0.230 },
  sledge:   { span: 0.260 },
};

/**
 * Pull the hands out of the Galil viewmodel, posed and frozen.
 *
 * Returns a template that `attachHands` clones per weapon, plus the palm
 * anchors measured off the frozen pose so callers do not have to know the
 * asset's bone names.
 */
export function handsTemplate(assets) {
  const gltf = assets?.model?.('viewmodelRifle');
  if (!gltf?.scene) return null;

  const root = cloneSkinned(gltf.scene);
  // The Galil viewmodel builds from this same scene and scales, rotates and
  // offsets it in place, so a clone taken afterwards arrives pre-scaled. Reset
  // the root and the template is the same whichever weapon is equipped first.
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.setScalar(1);

  // Freeze the hold animation at the same instant the Galil viewmodel does,
  // before the authored idle drifts the arms out of frame.
  if (gltf.animations?.length) {
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(gltf.animations[0]).play();
    mixer.update(0.05);
  }
  root.updateMatrixWorld(true);

  // Drop the rifle, keep the gloves. They are separate primitives of one
  // skinned mesh, so this is a material-name test, not a node-name test.
  const drop = [];
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const names = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => m?.name || '');
    if (!names.includes('v_hands')) drop.push(o);
  });
  for (const o of drop) o.parent?.remove(o);
  if (!root.getObjectByProperty('isSkinnedMesh', true)) return null;

  const bones = {};
  root.traverse((o) => { if (o.name) bones[o.name] = o; });
  for (const need of ['r_wrist', 'l_upperarm', 'l_forearm', 'l_wrist']) {
    if (!bones[need]) return null;
  }

  return {
    root,
    bones,
    // Palm centres, midway between wrist and knuckles, in model space.
    palmR: palm(bones.r_wrist, bones.r_middle_low),
    palmL: palm(bones.l_wrist, bones.l_middle_low),
    poleL: bones.l_pole ? worldPos(bones.l_pole) : null,
    /*
     * The fist, measured rather than guessed.
     *
     * `gripR` is where a held object's axis actually passes through the hand:
     * midway between the middle knuckle and the middle fingertip, which is the
     * channel between the curled fingers and the palm. That is 27 mm from
     * `palmR` — which sits back toward the wrist — and 27 mm is the difference
     * between a fist closed on a bat and a hand with a bat through the back of
     * it.
     *
     * `wrapR` is the direction that object runs: across the knuckles, index to
     * pinky. The index finger is no use for this one; it is on a trigger, not
     * wrapped round anything.
     */
    gripR: (bones.r_middle_low && bones.r_middle_tip)
      ? worldPos(bones.r_middle_low).lerp(worldPos(bones.r_middle_tip), 0.5)
      : null,
    wrapR: (bones.r_index_low && bones.r_pinky_low)
      ? worldPos(bones.r_pinky_low).sub(worldPos(bones.r_index_low)).normalize()
      : null,
  };
}

function worldPos(o) { return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); }
function palm(wrist, knuckle) {
  const p = worldPos(wrist);
  return knuckle ? p.lerp(worldPos(knuckle), 0.5) : p;
}

/**
 * Fit a pair of hands to a built weapon and parent them into it.
 *
 * `group` is whatever the gunsmith or the adopted-model path produced. The
 * hands become a child of it, so every bit of sway, bob, recoil and reload
 * motion the rig applies to the weapon carries the arms with it — which is
 * what makes them read as holding it rather than hovering near it.
 */
export function attachHands(group, spec, template, opts = {}) {
  if (!template || group.userData.ownHands) return null;

  const type = spec?.model?.type || 'pistol';
  const fit = { ...(FIT[type] || {}) };
  if (opts.pole) fit.pole = opts.pole;
  if (opts.gripRoll !== undefined && opts.gripRoll !== null) fit.gripRoll = opts.gripRoll;

  // Measure the weapon before the arms are in it.
  const bounds = new THREE.Box3().setFromObject(group);
  if (!isFinite(bounds.min.x)) return null;

  const grip = gripPoint(group, bounds, fit);
  const support = supportPoint(group, bounds, grip, fit);

  const inst = cloneSkinned(template.root);
  const bones = {};
  inst.traverse((o) => { if (o.name) bones[o.name] = o; });

  inst.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    // Skinning invalidates the bounding box the culler would use, and a
    // viewmodel is never off screen anyway.
    o.frustumCulled = false;
    o.renderOrder = 3;              // behind the weapon, so fingers do not z-fight
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m) m.envMapIntensity = 0.9;
    }
  });

  // Scale to metres and slide the rig so the trigger palm lands on the grip.
  const holder = new THREE.Group();
  holder.name = 'hands';
  const axis = group.userData.gripAxis || fit.gripAxis;
  // A weapon that says which way it runs is held in a closed fist, and the
  // anchor is the channel through that fist. Anything else is placed by the
  // palm, which is what the guns were framed against.
  const anchor = (axis && template.gripR) ? template.gripR : template.palmR;
  inst.scale.setScalar(HAND_SCALE);
  inst.position.copy(anchor).multiplyScalar(-HAND_SCALE);
  holder.add(inst);
  holder.position.copy(grip);
  if (opts.bias) holder.position.add(new THREE.Vector3(...opts.bias));

  /*
   * Turn the weapon to the hand, not the hand to the weapon.
   *
   * The authored fist closes around a rifle's pistol grip — a column running
   * up through the palm. Every gun has one of those, so translating the hand
   * onto it is enough. A bat does not: its shaft runs along the barrel axis,
   * ninety degrees from where the fingers curl, and the result is a hand
   * splayed flat across the handle with the bat through the palm. That is
   * what "not properly grabbing" looks like, and no amount of moving the hand
   * fixes it.
   *
   * Rotating the hand rig instead does fix the fist, and breaks everything
   * else: the shoulders travel with it, and the support arm ends up pointing
   * at the camera with its open end filling the middle of the screen. So the
   * weapon is turned inside the composition instead. The arms keep the pose
   * and the framing their author gave them — the same ones that make the one
   * hand-authored weapon in the game look right — and the shaft is laid
   * through the fist where the fingers already close.
   *
   * `gripRoll` then spins the weapon about that shaft: the one degree of
   * freedom the alignment leaves, and the difference between a fist closed
   * over a handle and one closed under it.
   */
  if (axis && template.wrapR && group.userData.parts?.body) {
    const from = new THREE.Vector3(...axis).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(from, template.wrapR);
    const roll = fit.gripRoll ?? MELEE_ROLL;
    if (roll) q.premultiply(new THREE.Quaternion().setFromAxisAngle(template.wrapR, roll));

    const body = group.userData.parts.body;
    body.quaternion.premultiply(q);
    body.position.sub(grip).applyQuaternion(q).add(grip);
    // Anything measured off the weapon in group space turns with it.
    group.userData.muzzle?.sub(grip).applyQuaternion(q).add(grip);
    group.userData.tip?.sub(grip).applyQuaternion(q).add(grip);
    group.userData.gripQuat = q;
  }

  group.add(holder);
  group.updateMatrixWorld(true);

  // The support point was measured off the weapon before it turned, so it has
  // to turn with it or the second hand reaches for where the fore-end was.
  if (group.userData.gripQuat) {
    support.sub(grip).applyQuaternion(group.userData.gripQuat).add(grip);
    group.updateMatrixWorld(true);
  }

  if (fit.oneHanded) {
    collapse(bones.l_upperarm);
  } else {
    // The solve moves the wrist, but `support` is where the palm goes, and
    // the palm is another 36 mm down the hand. Targeting the palm directly
    // asks for a reach the arm does not have — the authored pose is already
    // at full extension — so it clamps, straightens, and the forearm ends up
    // standing vertically in the middle of the screen.
    const shoulder = new THREE.Vector3().setFromMatrixPosition(bones.l_upperarm.matrixWorld);
    const target = holder.parent.localToWorld(support.clone());
    const reach = template.palmL.distanceTo(worldPos(template.bones.l_wrist)) * HAND_SCALE;
    const back = target.clone().sub(shoulder);
    if (back.lengthSq() > 1e-8) target.addScaledVector(back.normalize(), -reach);

    // Pole bias drops the elbow. The forearm mesh stops at the elbow — a
    // viewmodel has no upper arm — so a high elbow leaves the cut end of the
    // arm hanging in the middle of the screen. Swinging it down carries the
    // stump off the bottom of the frame, which is where every viewmodel hides
    // it.
    const pole = (template.poleL
      ? inst.localToWorld(template.poleL.clone())
      : holder.localToWorld(new THREE.Vector3(-0.4, -0.2, 0)))
      .add(new THREE.Vector3(...(fit.pole || POLE_BIAS)));
    solveTwoBone(bones.l_upperarm, bones.l_forearm, bones.l_wrist, target, pole);
    if (fit.roll) twist(bones.l_forearm, bones.l_wrist, fit.roll);
  }

  group.userData.hands = holder;
  group.userData.hipDrop = HIP_DROP;
  group.userData.handPoints = { grip, support };
  return holder;
}

/** Where the trigger palm goes: what the gunsmith recorded, or the box. */
function gripPoint(group, bounds, fit) {
  const g = group.userData.grip;
  const p = g
    ? new THREE.Vector3(g.x, g.y, g.z)
    // Adopted models and anything without a recorded grip: just behind the
    // rear of the receiver and below it, which is where a grip lives.
    : new THREE.Vector3(0, bounds.min.y + (bounds.max.y - bounds.min.y) * 0.30, bounds.max.z - 0.055);
  if (fit.grip) p.add(new THREE.Vector3(...fit.grip));
  return p;
}

/**
 * Where the support palm goes: under the handguard, `span` ahead of the grip.
 *
 * The height comes off the weapon itself — the lowest geometry in a thin slice
 * at that station — so a shotgun's pump, a launcher's tube and a minigun's
 * barrel cluster each get a hand under them rather than through them.
 */
function supportPoint(group, bounds, grip, fit) {
  const span = fit.span ?? DEFAULT_SPAN;
  const z = Math.max(bounds.min.z + 0.035, grip.z - span);

  // Height comes from the authored pose, not from the silhouette. The support
  // palm sits 24 mm above the trigger palm and 30 mm to the weak side, which
  // is the angle the left arm was built at; deriving it from the lowest
  // geometry instead put the hand under a magazine or a bipod and swung the
  // whole forearm up through the middle of the screen.
  const p = new THREE.Vector3(grip.x - 0.030, grip.y + 0.024, z);

  // Then keep it inside the weapon it is meant to be holding.
  const band = bandAt(group, z, 0.045);
  if (isFinite(band.lo)) p.y = Math.min(Math.max(p.y, band.lo - 0.006), band.hi);

  if (fit.support) p.add(new THREE.Vector3(...fit.support));
  return p;
}

/** Vertical extent of the geometry within `half` metres of the plane z. */
function bandAt(group, z, half) {
  const v = new THREE.Vector3();
  let lo = Infinity, hi = -Infinity;
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const m = new THREE.Matrix4();
  group.traverse((o) => {
    if (!o.isMesh) return;               // runs before the arms are parented in
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (Math.abs(v.z - z) > half) continue;
      if (v.y < lo) lo = v.y;
      if (v.y > hi) hi = v.y;
    }
  });
  return { lo, hi };
}

/** Collapses a bone chain out of sight, for a one-handed hold. */
function collapse(bone) { if (bone) bone.scale.setScalar(0.0001); }

/**
 * Two-bone IK. Rotates `upper` and `fore` so that `tip` reaches `target`,
 * bending toward `pole`. All three points are world space.
 *
 * The reach is clamped rather than allowed to overshoot: a target beyond
 * `l1 + l2` would otherwise divide through a hyperextended triangle and
 * produce a NaN quaternion, which silently deletes the arm.
 */
export function solveTwoBone(upper, fore, tip, target, pole) {
  if (!upper || !fore || !tip) return;
  upper.updateWorldMatrix(true, true);

  const A = worldPos(upper), B = worldPos(fore), C = worldPos(tip);
  const l1 = A.distanceTo(B), l2 = B.distanceTo(C);
  if (l1 < 1e-6 || l2 < 1e-6) return;

  const toT = target.clone().sub(A);
  const dist = toT.length();
  if (dist < 1e-6) return;
  const d = Math.min(Math.max(dist, Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4);
  const dir = toT.divideScalar(dist);

  // Elbow angle at the shoulder, by the law of cosines.
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const a = Math.acos(cosA);

  // Bend plane: the component of the pole direction perpendicular to the aim.
  const perp = pole.clone().sub(A);
  perp.addScaledVector(dir, -perp.dot(dir));
  if (perp.lengthSq() < 1e-8) {
    perp.set(0, 1, 0).addScaledVector(dir, -dir.y);
    if (perp.lengthSq() < 1e-8) perp.set(1, 0, 0).addScaledVector(dir, -dir.x);
  }
  perp.normalize();

  const elbow = A.clone().addScaledVector(dir, Math.cos(a) * l1).addScaledVector(perp, Math.sin(a) * l1);
  rotateWorld(upper, B.sub(A).normalize(), elbow.clone().sub(A).normalize());
  upper.updateWorldMatrix(false, true);

  const B2 = worldPos(fore);
  const wrist = A.clone().addScaledVector(dir, d);
  rotateWorld(fore, worldPos(tip).sub(B2).normalize(), wrist.sub(B2).normalize());
  fore.updateWorldMatrix(false, true);
}

/** Applies a world-space rotation to a bone, expressed in its local frame. */
function rotateWorld(bone, from, to) {
  const delta = new THREE.Quaternion().setFromUnitVectors(from, to);
  const parent = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(parent);
  const own = new THREE.Quaternion();
  bone.getWorldQuaternion(own);
  // world' = delta · world, and world = parent · local, so local' = parent⁻¹ · delta · world.
  bone.quaternion.copy(parent.invert().multiply(delta).multiply(own));
}

/** Twists a bone about the axis running to its child, for palm roll. */
function twist(bone, child, radians) {
  if (!bone || !child) return;
  bone.updateWorldMatrix(true, true);
  const axis = worldPos(child).sub(worldPos(bone)).normalize();
  const delta = new THREE.Quaternion().setFromAxisAngle(axis, radians);
  const parent = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(parent);
  const own = new THREE.Quaternion();
  bone.getWorldQuaternion(own);
  bone.quaternion.copy(parent.invert().multiply(delta).multiply(own));
}
