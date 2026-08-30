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
