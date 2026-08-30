import * as THREE from 'three';

/**
 * Downloaded first-person viewmodels.
 *
 * The gunsmith builds eleven of the twelve weapons from primitives. This is the
 * path for the one that is a real authored asset: a rigged rifle with gloved
 * hands, a full finger chain and a hold animation, which is a level of detail
 * no amount of parametric geometry gets to.
 *
 * A downloaded viewmodel needs three things done to it before it can be used:
 *
 *   Posed. A rigged model's bind pose is not the pose it was made for — the
 *   weapon is placed into the hand by the animation, so loading it and drawing
 *   it gives you a rifle floating next to a pair of T-posed arms. The clip is
 *   played once and frozen, and the game's own sway, bob and recoil ride on top
 *   of that; letting the authored idle keep running fights the recoil spring.
 *
 *   Calibrated. It arrives in its author's units, at its author's origin. The
 *   numbers below put the barrel down -Z at the right size with the grip near
 *   the origin, so the rig that positions the procedural weapons positions this
 *   one identically.
 *
 *   Told where its muzzle and its sight line are. Those come off the mesh for a
 *   built weapon; here they are measured once and written down.
 */
export const MODEL_VIEWMODELS = {
  /*
   * Adopted from the Steel Tide / Quaternius pack. `adopt` sends these down the
   * re-finishing path at the bottom of this file rather than being used as they
   * arrive — they come with no textures and no UVs at all.
   */
  pistol: {
    adopt: true, asset: 'wpnPistol',
    scale: 0.54,                       // its 0.40-unit body against a 216 mm 1911
    sightY: 0.022,
    basePos: [0.125, -0.078, -0.255],
    adsPos: [0, -0.022, -0.185],
    motion: { slide: { travel: 0.026, time: 0.085 }, magDrop: 0.15 },
  },

  smg: {
    adopt: true, asset: 'wpnSmg',
    scale: 0.581,                      // 1.17 units against a 680 mm MP5A5
    sightY: 0.030,
    basePos: [0.135, -0.105, -0.300],
    adsPos: [0, -0.030, -0.180],
    boltAs: 'bolt',
    motion: { bolt: { travel: 0.022, time: 0.060 }, magDrop: 0.17 },
  },

  sniper: {
    adopt: true, asset: 'wpnSniper',
    scale: 0.615,                      // 2.0 units against a 1230 mm AWM
    sightY: 0.038,
    basePos: [0.128, -0.108, -0.320],
    adsPos: [0, -0.038, -0.200],
    boltAs: 'bolt',
    motion: { bolt: { travel: 0.030, time: 0.30 }, magDrop: 0.14 },
  },

  rifle: {
    asset: 'viewmodelRifle',
    /* Freeze the hold animation here. Early in the clip, before the authored
       idle drifts the arms out of frame. */
    poseTime: 0.05,
    /* Its rifle spans 3.2 units nose to tail; a Galil is about 0.85 m. */
    scale: 0.266,
    rotation: [0, 0, 0],
    /* Applied after scaling, to bring the shooting hand onto the rig's origin.
       Read off the r_middle_low bone rather than guessed. */
    offset: [-0.075, 0.067, 0.141],
    /* A built weapon is a gun; this is a whole authored composition, arms and
       all, framed by its author for a particular hold. So it overrides the
       rig's hip and aim positions rather than being posed by numbers tuned for
       a bare gunsmith weapon whose origin is its grip. */
    basePos: [0.115, -0.205, -0.300],
    adsPos: [-0.009, -0.058, -0.265],
    muzzle: [0, 0.010, -0.520],
    sightY: 0.052,
    rear: 0.20,
  },
};

/**
 * Instance a downloaded viewmodel, posed and calibrated.
 *
 * `parts` is returned in the same shape the gunsmith produces, so the viewmodel
 * rig does not have to know which kind of weapon it is holding — a model with
 * no separable magazine simply has no `mag` entry and the reload animation
 * falls back to the whole-weapon dip.
 */
export function buildModelWeapon(spec, cfg, assets) {
  const gltf = assets.model(cfg.asset);
  if (!gltf) return null;

  const src = gltf.scene;

  // Freeze the authored pose. The mixer is discarded immediately: the bone
  // transforms it wrote are what we want, and nothing after this moves them.
  if (gltf.animations?.length) {
    const mixer = new THREE.AnimationMixer(src);
    mixer.clipAction(gltf.animations[0]).play();
    mixer.update(cfg.poseTime ?? 0);
    src.updateMatrixWorld(true);
  }

  const body = new THREE.Group();
  body.name = 'body';
  body.add(src);
  src.scale.setScalar(cfg.scale);
  src.rotation.set(...(cfg.rotation || [0, 0, 0]));
  src.position.set(...(cfg.offset || [0, 0, 0]));

  src.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    // A viewmodel is always in front of the camera; culling it by a bounding
    // box that skinning has already invalidated only ever makes it vanish.
    o.frustumCulled = false;
    o.renderOrder = 4;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      m.envMapIntensity = 0.9;
    }
  });

  const group = new THREE.Group();
  group.name = `weapon:${spec.id}`;
  group.add(body);
  group.userData.muzzle = new THREE.Vector3(...cfg.muzzle);
  group.userData.parts = { body };
  group.userData.motion = {};
  group.userData.sightY = cfg.sightY;
  group.userData.rear = cfg.rear;
  group.userData.basePos = cfg.basePos || null;
  group.userData.adsPos = cfg.adsPos || null;
  group.userData.spec = spec;
  group.userData.model = true;
  return group;
}

// ------------------------------------------------------- adopted geometry
/*
 * Some downloaded weapons are good shapes wearing nothing. The Steel Tide /
 * Quaternius pack has better silhouettes than anything parametric geometry
 * gets to — an MP5 that is unmistakably an MP5 — and ships no textures at all:
 * every surface is a flat material colour, and the meshes carry POSITION and
 * NORMAL only, with no UVs for a texture to map to.
 *
 * So they are re-finished on load rather than re-modelled. Three things happen:
 *
 *   UVs are generated by box projection, in metres, which is the same
 *   convention the gunsmith's primitives use — so the game's existing detail
 *   maps tile across imported geometry at exactly the density they were tuned
 *   for. The seams a box projection leaves fall where the dominant normal axis
 *   flips, and at 25 mm tiling on a fine grain map you cannot find them.
 *
 *   Vertex shading is baked from surface orientation: grime gathers on the
 *   downward faces, a little light sits on the upward ones. Not the gunsmith's
 *   edge-wear trick, which measures distance to a part's bounding box — these
 *   are whole-weapon meshes, so that would brighten the muzzle and the butt and
 *   nothing in between.
 *
 *   Materials are mapped by name. The pack names them semantically, which is a
 *   gift: Metal, DarkMetal, ActionSteel, Wood, Glass. Anything unrecognised
 *   falls back on the source material's own metalness.
 */

/** Detail-map tiles per metre across adopted geometry. The gunsmith uses ~40. */
const DETAIL_REPEAT = 4.5;

/** Their finish names, mapped onto the game's. */
const FINISH = {
  metal: 'gunSteel',
  lightmetal: 'gunSteel',
  m1911magazinesteel: 'gunSteel',
  awmmagazinesteel: 'gunSteel',
  darkmetal: 'gunBlued',
  actionsteel: 'gunBlued',
  awmactionsteel: 'gunBlued',
  black: 'gunGrip',
  grey: 'gunGrip',
  gray: 'gunGrip',
  wood: 'gunWood',
  glass: 'gunGlass',
  brass: 'gunBrass',
};

/** Anything unnamed is judged on how metallic its author made it. */
function finishFor(material) {
  const named = FINISH[String(material?.name || '').toLowerCase()];
  if (named) return named;
  const m = material?.metalness ?? 0.5;
  return m > 0.6 ? 'gunBlued' : m > 0.3 ? 'gunSteel' : 'gunGrip';
}

/**
 * Box-projected UVs in metres. `scale` is the factor the model will be drawn
 * at, so the UVs come out in world units rather than the author's.
 */
function boxProjectUV(geo, scale) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  if (!pos || !nrm) return;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i) * scale, y = pos.getY(i) * scale, z = pos.getZ(i) * scale;
    let u, v;
    if (nx >= ny && nx >= nz) { u = z; v = y; }
    else if (ny >= nz) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Grime below, a little light above, and a low-frequency break-up over both. */
function bakeShading(geo, { grime = 0.26, lift = 0.10 } = {}) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  if (!pos || !nrm) return;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i);
    const n = Math.sin(pos.getX(i) * 91.7 + pos.getY(i) * 57.3 + pos.getZ(i) * 33.1) * 0.5 + 0.5;
    const k = 1
      - grime * Math.max(0, -ny) * (0.55 + 0.45 * n)
      + lift * Math.max(0, ny) * (0.4 + 0.6 * n);
    col[i * 3] = k; col[i * 3 + 1] = k; col[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/**
 * Where the barrel ends, found from the geometry: take every vertex within a
 * centimetre of the furthest-forward point and average them.
 */
function muzzleOf(root) {
  const v = new THREE.Vector3();
  let minZ = Infinity;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.z < minZ) minZ = v.z;
    }
  });
  const acc = new THREE.Vector3();
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.z < minZ + 0.01) { acc.add(v); n++; }
    }
  });
  return n ? acc.multiplyScalar(1 / n) : new THREE.Vector3(0, 0, minZ);
}

/**
 * Re-finish a downloaded weapon and file its moving parts under the names the
 * viewmodel rig animates. Returns the same shape `buildWeapon` does.
 */
export function buildAdoptedWeapon(spec, cfg, assets, mats) {
  const gltf = assets.model(cfg.asset);
  if (!gltf) return null;

  const src = gltf.scene.clone(true);
  src.updateMatrixWorld(true);

  // The spare magazine floats beside the weapon as a display prop for the
  // pack's own preview renders. In a viewmodel it is a magazine hanging in
  // mid-air next to your hand.
  const spare = [];
  src.traverse((o) => { if (/spare/i.test(o.name || '')) spare.push(o); });
  for (const o of spare) o.removeFromParent();

  const s = cfg.scale;

  /*
   * Adopted meshes get their own copies of the finishes, with the detail normal
   * turned well down. The gunsmith's parts are small and bevelled, so a fine
   * grain map breaks up across them; these are big flat low-poly faces, and at
   * full strength the same map reads as a checkerboard printed on the gun
   * rather than as machining on it.
   */
  const cache = new Map();
  const finish = (key) => {
    if (cache.has(key)) return cache.get(key);
    const base = mats.get(key) || mats.get('gunSteel');
    const m = base.clone();
    /*
     * The detail maps are tuned for the gunsmith's parts, which are small and
     * bevelled, so a grain repeating every 25 mm breaks up across them. An
     * imported receiver is a few big flat faces, and the same grain lays about
     * thirty tiles across it in a dead-regular grid — which reads as a
     * checkerboard printed on the gun rather than as machining in it.
     *
     * Widening the tile is what fixes it, not weakening it: broad, soft
     * variation reads as a surface, where a fine one at low contrast just reads
     * as a fainter checkerboard.
     */
    const widen = (map) => {
      if (!map) return map;
      const t = map.clone();
      t.repeat.set(DETAIL_REPEAT, DETAIL_REPEAT);
      t.needsUpdate = true;
      return t;
    };
    m.normalMap = widen(m.normalMap);
    m.roughnessMap = widen(m.roughnessMap);
    m.map = widen(m.map);
    if (m.normalScale) m.normalScale.multiplyScalar(0.55);
    cache.set(key, m);
    return m;
  };

  src.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    o.frustumCulled = false;
    o.renderOrder = 4;
    const geo = o.geometry;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    boxProjectUV(geo, s);
    bakeShading(geo);
    const key = finishFor(Array.isArray(o.material) ? o.material[0] : o.material);
    o.material = finish(key);
  });

  // Sub-groups the rig knows how to move. The pack names them for us.
  const parts = {};
  const holder = new THREE.Group();
  holder.name = 'body';
  holder.add(src);
  parts.body = holder;

  const claim = (nodeName, as) => {
    const node = src.getObjectByName(nodeName);
    if (!node) return;
    const g = new THREE.Group();
    g.name = as;
    node.parent.add(g);
    g.position.copy(node.position);
    node.position.set(0, 0, 0);
    g.add(node);
    parts[as] = g;
  };
  claim('Magazine', 'mag');
  claim('ChargingHandle', cfg.boltAs || 'slide');

  /*
   * Place it off its own measurements rather than off numbers typed in by hand.
   * Guessing an offset costs a render per guess and gets it wrong in ways that
   * only show up in the game — the first pass here put an AWM's buttstock
   * behind the camera, so a 1.2 m rifle filled the screen.
   *
   * The rule: the weapon's rear face sits on the rig's origin, it is centred
   * across, and its top sits `sightY` above. That makes basePos.z read as "how
   * far in front of the eye the butt is", which is a thing you can reason
   * about, and it holds for a pistol and a sniper rifle alike.
   */
  src.scale.setScalar(s);
  src.rotation.set(...(cfg.rotation || [0, 0, 0]));
  src.position.set(0, 0, 0);
  src.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(src);
  const centre = box.getCenter(new THREE.Vector3());
  const sightY = cfg.sightY ?? 0.02;
  src.position.set(-centre.x, -box.max.y + sightY, -box.max.z);
  src.updateMatrixWorld(true);

  // The muzzle is where the barrel ends: average the vertices at the far end
  // rather than assuming it is on the centre line, because on this pack it is
  // not — an MP5's bore sits well below its optic rail.
  const muzzle = cfg.muzzle ? new THREE.Vector3(...cfg.muzzle) : muzzleOf(src);

  const group = new THREE.Group();
  group.name = `weapon:${spec.id}`;
  group.add(holder);
  group.userData.muzzle = muzzle;
  group.userData.parts = parts;
  // Travel distances are authored in metres, but the parts they move live
  // under a node scaled by `s`, so a 26 mm slide throw would come out at 14 mm.
  const motion = {};
  for (const [k, v] of Object.entries(cfg.motion || {})) {
    if (v && typeof v === 'object' && v.travel !== undefined) motion[k] = { ...v, travel: v.travel / s };
    else if (k === 'magDrop' || k === 'magForward') motion[k] = v / s;
    else motion[k] = v;
  }

  group.userData.motion = motion;
  group.userData.sightY = sightY;
  group.userData.rear = 0;          // the rear face is the origin, by construction
  group.userData.basePos = cfg.basePos || null;
  group.userData.adsPos = cfg.adsPos || null;
  group.userData.spec = spec;
  group.userData.model = true;
  return group;
}
