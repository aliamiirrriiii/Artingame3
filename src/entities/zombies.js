import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { ARCHETYPES } from './zombieTypes.js';
import { clamp, damp, dampAngle, lerp, rand, randInt, gauss, angleDelta, TAU } from '../core/util.js';
import { audio } from '../core/audio.js';
import {
  HITBOX_DEFS, SEVERED_SCALE,
  intersectCapsule, intersectCylinder, intersectSphere, sphereOverlapsRay,
} from './hitboxes.js';

/**
 * The horde.
 *
 * Design notes that matter for both feel and frame time:
 *
 *  - Navigation is a flow-field lookup, so pathing cost does not grow with the
 *    number of zombies. They round real corners and pour through the alleys
 *    instead of pressing into walls.
 *
 *  - Animation is a Mixamo walk/run clip with a procedural layer applied on top
 *    of the bones every frame: a forward hunch, a lateral lurch on a per-zombie
 *    phase, lolling head, and raised arms. That layer is what turns a marching
 *    soldier into something that shambles, and it costs a handful of quaternion
 *    multiplies per zombie.
 *
 *  - Distant zombies tick their AnimationMixer at a reduced rate and stop
 *    casting shadows. Skinning is the single most expensive thing in the frame,
 *    so this is where the budget is won.
 *
 *  - Hit detection is analytic: eleven capsules strung between the animated
 *    bones. No mesh raycasts and no BVH, but the boxes hunch, lurch and swing
 *    with the pose layer, so a headshot has to actually be on the head.
 */

const BODY_RADIUS = 0.38;

// Procedural pose layer. Tuned against the Mixamo rest pose.
export const POSE = {
  spineHunch: 0.30,      // forward fold across the three spine bones
  spineSway: 0.16,       // lateral lurch amplitude
  headLoll: 0.42,
  armRaise: 1.12,        // shoulder lift toward the player
  foreArmBend: 0.70,
  armSway: 0.30,
  // Which local axes the shoulder/elbow rotations act on. Mixamo bone axes are
  // not intuitive, so these are data rather than hard-coded euler components.
  // Signs are mirrored for the right arm by `armMirror`.
  armEuler: [0, 0, 1.0],
  armMirror: [1, -1, -1],
  foreEuler: [0, 0.35, 0.72],
};

export class ZombieManager {
  constructor(scene, assets, level, effects, preset) {
    this.scene = scene;
    this.level = level;
    this.fx = effects;
    this.preset = preset;

    this.zombies = [];
    this.alive = [];
    this.maxAlive = preset.maxZombies;

    this.onPlayerHit = null;      // (damage, zombie) => void
    this.onKill = null;           // (zombie, byPlayer, { crit, part, popped }) => void
    this.onDismember = null;      // (zombie, boneName) => void

    /*
     * Per-wave multipliers set by the director's modifiers. Applied at spawn
     * for health and speed, and at the point of use for everything else, so a
     * wave already on the field is not retroactively rewritten when the next
     * one is drawn.
     */
    this.mods = { health: 1, speed: 1, damage: 1, points: 1, stagger: 1, sever: 1 };
    this.onSpit = null;           // (origin, dir, spec) => void
    this.onScream = null;         // (zombie) => void

    this._flowDir = { x: 0, z: 0 };
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._frameId = 0;
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();

    this._buildTemplate(assets);
    this._buildEyes();

    // Uniform grid for separation — rebuilt each frame, cheap and allocation free.
    this._cell = 2.0;
    this._grid = new Map();

    this._growlTimer = 0;
    this._time = 0;
    // Global speed scale, driven by the Deep Freeze power-up.
    this.globalSpeedMul = 1;
  }

  // ------------------------------------------------------------- resources

  _buildTemplate(assets) {
    const gltf = assets.model('soldier');
    if (!gltf) throw new Error('zombie base model missing');

    const src = gltf.scene;
    src.updateMatrixWorld(true);

    // Normalise height so archetype scales mean metres, not model units.
    const box = new THREE.Box3().setFromObject(src);
    const modelHeight = Math.max(0.01, box.max.y - box.min.y);
    this._modelHeight = modelHeight;

    this.template = src;
    this.clips = gltf.animations;
    this.assets = assets;

    // One shared material program; each zombie clones it for its own uniforms.
    this._baseMaterials = new Map();
    src.traverse((o) => {
      if (o.isSkinnedMesh || o.isMesh) {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (m && !this._baseMaterials.has(m.uuid)) this._baseMaterials.set(m.uuid, m);
      }
    });
  }

  /**
   * Glowing eyes for every zombie in a single instanced draw.
   *
   * Two quads per zombie, positioned from the head bone each frame. In a level
   * this dark, a pair of points coming at you out of an alley does more work
   * than any amount of texture detail.
   */
  _buildEyes() {
    const geo = new THREE.PlaneGeometry(0.055, 0.03);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff5522,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const cap = this.maxAlive * 2;
    this.eyes = new THREE.InstancedMesh(geo, mat, cap);
    this.eyes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.eyes.frustumCulled = false;
    this.eyes.count = 0;
    this.eyes.renderOrder = 6;
    this.scene.add(this.eyes);
    this._eyeMatrix = new THREE.Matrix4();
    this._eyeColor = new THREE.Color();
  }

  /** Materialises one reusable zombie: mesh, skeleton, mixer, bone handles. */
  _createZombie() {
    const root = cloneSkinned(this.template);
    root.visible = false;
    root.matrixAutoUpdate = true;

    const bones = {};
    const meshes = [];

    root.traverse((o) => {
      // Anything on the Mixamo rig, not just the skinning joints. The leaf
      // markers — HeadTop_End, Toe_End, the eyes — are not listed in the GLTF
      // skin, so GLTFLoader builds them as plain Object3D rather than Bone,
      // and the head hitbox needs HeadTop_End to know which way the skull
      // points.
      if (o.isBone || /^mixamorig/.test(o.name)) {
        // GLTFLoader sanitises node names, so "mixamorig:LeftArm" arrives as
        // "mixamorigLeftArm". Accept either form.
        const n = o.name.replace(/^mixamorig[:_]?/, '');
        bones[n] = o;
        // Cache the animated rest rotation so the procedural layer is additive.
        o.userData.baseQuat = o.quaternion.clone();
      }
      if (o.isSkinnedMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        const src = Array.isArray(o.material) ? o.material[0] : o.material;
        o.material = this._makeZombieMaterial(src);
        meshes.push(o);
      }
    });

    const mixer = new THREE.AnimationMixer(root);
    const actions = {};
    for (const clip of this.clips) {
      if (clip.name === 'TPose') continue;
      const a = mixer.clipAction(clip);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      actions[clip.name] = a;
    }

    this.scene.add(root);

    return {
      root, mixer, actions, bones, meshes,
      active: false, type: null, spec: null,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      yaw: 0, targetYaw: 0,
      health: 1, maxHealth: 1,
      speed: 1, baseSpeed: 1, scale: 1, height: 1.8, radius: BODY_RADIUS,
      state: 'idle', stateT: 0,
      attackT: 0, cooldownT: 0, rangedT: 0, screamT: 0,
      phase: 0, lurchPhase: 0,
      hitFlash: 0, dissolve: 0, staggerT: 0,
      boostT: 0, boostMul: 1,
      distToPlayer: 999, lodLevel: 0, animAccum: 0,
      deathDir: new THREE.Vector3(),
      fallAngle: 0, fallAxis: 0, launched: false, spin: 0,
      lastGrowl: 0, chargeT: 0, charging: false,
      spawnT: 0, addTimer: 0,
      currentClip: null,
      damageTaken: 0,
      // Skeletal hit volumes, rebuilt at most once per frame and only for
      // zombies a ray actually reaches.
      hitboxes: HITBOX_DEFS.map(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0, ok: false })),
      hbFrame: -1,
      severed: new Set(),
      limbDamage: new Map(),
    };
  }

  /**
   * Turns the source soldier material into rotting flesh: desaturated, tinted,
   * mottled with rot and dried blood from a world-space noise lookup, plus a
   * white hit flash and a dissolve-on-death that eats the mesh from the edges.
   */
  _makeZombieMaterial(src) {
    const m = src.clone();
    m.roughness = 0.86;
    m.metalness = 0.0;
    m.envMapIntensity = 0.55;

    const uniforms = {
      uTint: { value: new THREE.Color(0x6f7a5e) },
      uHit: { value: 0 },
      uDissolve: { value: 0 },
      uRot: { value: 0.75 },
      uNoise: { value: this.assets.tex('perlin') },
      uSeed: { value: 0 },
    };
    m.userData.zUniforms = uniforms;

    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vZLocal;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vZLocal = position * 0.05;`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vZLocal;
          uniform vec3  uTint;
          uniform float uHit;
          uniform float uDissolve;
          uniform float uRot;
          uniform float uSeed;
          uniform sampler2D uNoise;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          // Dissolve: eat the mesh away along a noise threshold, with a hot rim
          // just ahead of the edge so bodies burn out instead of blinking off.
          float zN = texture2D( uNoise, vZLocal.xy * 3.1 + uSeed ).r;
          float zN2 = texture2D( uNoise, vZLocal.zy * 5.7 + uSeed * 1.7 ).g;
          float zNoise = mix( zN, zN2, 0.5 );
          if ( uDissolve > 0.001 && zNoise < uDissolve ) discard;

          // Rot: desaturate the source skin and push it toward the archetype
          // tint, with mottling so no two zombies read the same.
          float zLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
          vec3 zRot = mix( diffuseColor.rgb, vec3( zLum ), 0.82 ) * uTint * 2.2;
          float zMottle = zNoise * 0.55 + zN2 * 0.45;
          zRot *= 0.46 + zMottle * 0.95;
          // Necrotic blotching, then dried blood pooled in the low areas.
          zRot = mix( zRot, zRot * vec3( 0.55, 0.78, 0.48 ), smoothstep( 0.35, 0.75, zN ) * 0.7 );
          zRot = mix( zRot, vec3( 0.16, 0.026, 0.024 ), smoothstep( 0.55, 0.88, zN2 ) * 0.72 );
          diffuseColor.rgb = mix( diffuseColor.rgb, zRot, uRot );`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          if ( uDissolve > 0.001 ) {
            float rim = smoothstep( uDissolve, uDissolve + 0.13, zNoise );
            gl_FragColor.rgb += vec3( 1.0, 0.30, 0.06 ) * ( 1.0 - rim ) * 2.6;
          }
          gl_FragColor.rgb += vec3( 1.0, 0.62, 0.55 ) * uHit;`);
    };

    m.customProgramCacheKey = () => 'zombieFlesh';
    return m;
  }

  // ------------------------------------------------------------ life cycle

  setMaxAlive(n) {
    this.maxAlive = n;
    if (this.eyes && this.eyes.instanceMatrix.count < n * 2) {
      this.scene.remove(this.eyes);
      this.eyes.dispose();
      this.maxAlive = n;
      this._buildEyes();
    }
  }

  get aliveCount() { return this.alive.length; }

  /**
   * Builds the pool up front during the loading screen. Cloning a rigged mesh
   * costs a millisecond or two; doing it lazily meant a visible hitch the first
   * time a wave stepped up its concurrent count.
   */
  prewarm(n = this.maxAlive) {
    while (this.zombies.length < n) {
      this.zombies.push(this._createZombie());
    }
    return this.zombies.length;
  }

  _acquire() {
    for (let i = 0; i < this.zombies.length; i++) {
      if (!this.zombies[i].active) return this.zombies[i];
    }
    if (this.zombies.length >= this.maxAlive + 12) return null;
    const z = this._createZombie();
    this.zombies.push(z);
    return z;
  }

  /** Spawns one zombie of `typeId` at `pos`, scaled for the given wave. */
  spawn(typeId, pos, wave = 1) {
    if (this.alive.length >= this.maxAlive) return null;
    const spec = ARCHETYPES[typeId];
    if (!spec) return null;
    const z = this._acquire();
    if (!z) return null;

    z.active = true;
    z.type = typeId;
    z.spec = spec;

    // Health scaling.
    //
    // One shared linear-then-steeper curve rather than a per-archetype
    // exponent: compounding a brute's higher scale made it 15x tougher than a
    // walker by wave 20, which is a damage wall, not a difficulty curve. The
    // archetypes differentiate through their base health instead.
    //
    // Bosses get their own gentler curve — a boss on the generic one hit
    // 25,000 HP by wave 5, well past what the wave-5 arsenal can chew through.
    const w = Math.max(0, wave - 1);
    const growth = spec.boss
      ? 1 + Math.max(0, wave - 5) * 0.25
      : (w <= 9 ? 1 + w * 0.22 : 1 + 9 * 0.22 + (w - 9) * 0.30);
    z.maxHealth = Math.max(1, Math.round(spec.health * growth * (spec.healthScale ?? 1) * this.mods.health));
    z.health = z.maxHealth;
    z.damageTaken = 0;

    const avgScale = (spec.scale[0] + spec.scale[1]) / 2;
    // `scale` is per-instance variation around the archetype's nominal size;
    // `heightM` is the absolute target height in metres. Keep them separate or
    // a brute ends up three times taller than intended.
    z.sizeVar = rand(spec.scale[0], spec.scale[1]) / avgScale;
    z.scale = z.sizeVar * (spec.heightM / 1.8);
    z.height = spec.heightM * z.sizeVar;
    z.radius = BODY_RADIUS * (spec.heightM / 1.8) * z.sizeVar * (spec.boss ? 1.45 : 1);
    z.baseSpeed = rand(spec.speed[0], spec.speed[1]) * (1 + Math.min(wave, 20) * 0.008) * this.mods.speed;
    z.speed = z.baseSpeed;

    z.pos.set(pos.x, 0, pos.z);
    z.vel.set(0, 0, 0);
    z.yaw = rand(0, TAU);
    z.targetYaw = z.yaw;
    z.phase = rand(0, TAU);
    z.lurchPhase = rand(0, TAU);
    z.state = 'emerge';
    z.stateT = 0;
    z.spawnT = 0;
    z.attackT = 0;
    z.cooldownT = rand(0, 0.5);
    z.rangedT = rand(1, 3);
    z.screamT = rand(2, 5);
    z.didHit = false;
    z.hitFlash = 0;
    z.dissolve = 0;
    z.staggerT = 0;
    z.boostT = 0;
    z.boostMul = 1;
    z.chargeT = rand(3, 7);
    z.charging = false;
    z.addTimer = spec.spawnsAdds ? spec.spawnsAdds.every : 0;
    z.lodLevel = 0;
    z.animAccum = 0;
    z.hbFrame = -1;
    z.launched = false;
    z.spin = 0;
    z.pos.y = 0;
    // A recycled zombie may still be carrying the collapsed bones of the last
    // one's amputations.
    for (const name of z.severed) { const b = z.bones[name]; if (b) b.scale.setScalar(1); }
    z.severed.clear();
    z.limbDamage.clear();

    const finalScale = (spec.heightM / this._modelHeight) * z.sizeVar;
    z.root.scale.setScalar(finalScale);
    z.root.position.copy(z.pos);
    z.root.visible = true;

    // Per-instance look.
    const tint = spec.tint[randInt(0, spec.tint.length - 1)];
    for (const mesh of z.meshes) {
      const u = mesh.material.userData.zUniforms;
      if (!u) continue;
      u.uTint.value.setHex(tint).multiplyScalar(rand(0.82, 1.18));
      u.uHit.value = 0;
      u.uDissolve.value = 0;
      u.uSeed.value = rand(0, 10);
      u.uRot.value = rand(0.7, 0.92);
    }

    this._setClip(z, spec.clip, 0);
    this.alive.push(z);

    if (spec.boss) audio.growl(z.pos, 'boss', 1);
    return z;
  }

  _setClip(z, name, fade = 0.22) {
    const next = z.actions[name];
    if (!next || z.currentClip === name) return;
    const prev = z.currentClip ? z.actions[z.currentClip] : null;
    next.reset();
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(z.spec.clipSpeed * (z.speed / z.baseSpeed));
    next.play();
    if (prev && fade > 0) {
      prev.crossFadeTo(next, fade, false);
    } else if (prev) {
      prev.setEffectiveWeight(0);
    }
    z.currentClip = name;
  }

  _release(z) {
    z.active = false;
    z.root.visible = false;
    const i = this.alive.indexOf(z);
    if (i > -1) {
      this.alive[i] = this.alive[this.alive.length - 1];
      this.alive.pop();
    }
  }

  clear() {
    for (const z of this.alive.slice()) this._release(z);
    this.alive.length = 0;
  }

  // --------------------------------------------------------------- damage

  /**
   * Applies damage. Returns an outcome the weapon layer uses for hit markers,
   * points and audio.
   */
  damage(z, amount, hitPoint, dir, { crit = false, stagger = 0, byPlayer = true, part = 'chest' } = {}) {
    if (!z.active || z.state === 'dead' || z.state === 'dying') return null;

    z.health -= amount;
    z.damageTaken += amount;
    z.hitFlash = Math.min(1, z.hitFlash + (crit ? 0.9 : 0.5));

    const power = clamp(amount / 120, 0.35, 2.4) * z.spec.gore;
    this.fx.bloodBurst(hitPoint, dir, power * (crit ? 1.7 : 1), crit);
    audio.flesh(hitPoint, crit);

    // Spray onto whatever is standing behind them. Short ray, so it only fires
    // when there is actually a wall to paint.
    if (byPlayer && power > 0.7) this._backSplatter(hitPoint, dir, power);

    // Limbs come off before the body does. Accumulated rather than
    // single-shot so a magazine emptied into one arm takes it off, which is
    // what a player who keeps shooting an arm is asking for.
    const limb = part === 'arm' || part === 'leg' ? this._limbBone(z, hitPoint) : null;
    if (limb && byPlayer && z.spec.gore > 0.3) {
      const taken = (z.limbDamage.get(limb) || 0) + amount;
      z.limbDamage.set(limb, taken);
      if (taken * this.mods.sever > z.maxHealth * 0.30 + 12 && part === 'arm') this._sever(z, limb, dir, 1);
    }

    // Stagger, resisted by mass. Brutes and bosses barely flinch.
    const st = stagger * (1 - z.spec.staggerResist) * this.mods.stagger;
    if (st > 0.01 && z.state !== 'attack') {
      z.staggerT = Math.max(z.staggerT, st);
      z.state = 'stagger';
      z.stateT = 0;
    }

    // Knockback, also mass-scaled.
    const push = clamp(amount / (140 * z.spec.mass), 0, 2.4);
    z.vel.x += dir.x * push;
    z.vel.z += dir.z * push;

    if (z.health <= 0) {
      this._kill(z, dir, crit, byPlayer, part, amount, hitPoint);
      return { killed: true, crit, part,
        points: Math.round(z.spec.points * (crit ? 1.5 : 1) * this.mods.points) };
    }
    return { killed: false, crit, part, points: Math.round(amount * 0.1 * this.mods.points) };
  }

  /** Which limb bone a hit at `hitPoint` belongs to, by nearest capsule. */
  _limbBone(z, hitPoint) {
    let best = Infinity, name = null;
    for (let i = 0; i < HITBOX_DEFS.length; i++) {
      const def = HITBOX_DEFS[i];
      if (!def.limb) continue;
      const hb = z.hitboxes[i];
      if (!hb.ok) continue;
      const d = Math.min(hitPoint.distanceToSquared(hb.a), hitPoint.distanceToSquared(hb.b));
      if (d < best) { best = d; name = def.limb; }
    }
    return name;
  }

  /**
   * Takes a limb off. The bone collapses (see `SEVERED_SCALE`), and the joint
   * it left behind throws meat and a jet of blood.
   */
  _sever(z, boneName, dir, force = 1) {
    if (z.severed.has(boneName)) return;
    const bone = z.bones[boneName];
    if (!bone) return;
    z.severed.add(boneName);
    bone.scale.setScalar(SEVERED_SCALE);
    z.hbFrame = -1;

    bone.updateWorldMatrix(true, false);
    const p = this._tmp.setFromMatrixPosition(bone.matrixWorld);
    this.fx.bloodBurst(p, dir, 2.2 * force * z.spec.gore, true);
    this.fx.bloodPool(p.x, p.z, rand(0.4, 0.8) * z.scale);
    for (let i = 0; i < Math.round(5 * force * z.spec.gore); i++) {
      this.fx.gibs.spawn(
        p.x, p.y, p.z,
        dir.x * rand(1.5, 5) + gauss() * 2.6,
        rand(2.2, 6),
        dir.z * rand(1.5, 5) + gauss() * 2.6,
        rand(0.5, 1.2) * z.scale, rand(5, 9),
      );
    }
    audio.flesh(p, true);
    if (this.onDismember) this.onDismember(z, boneName);
  }

  /** Paints the surface behind a hit, if there is one within a couple of metres. */
  _backSplatter(hitPoint, dir, power) {
    const col = this.level?.collision;
    if (!col?.raycast) return;
    const hit = col.raycast(hitPoint, dir, 2.6, this._splatOut || (this._splatOut = {}));
    if (!hit) return;
    this.fx.bloodSplat(hit.point, hit.normal, clamp(0.5 + power * 0.55, 0.4, 1.9));
  }

  _kill(z, dir, crit, byPlayer, part = 'chest', amount = 0, hitPoint = null) {
    z.state = 'dying';
    z.stateT = 0;
    z.health = 0;
    z.deathDir.copy(dir);
    z.fallAxis = Math.random() < 0.5 ? 1 : -1;
    z.fallAngle = 0;
    /*
     * A body hit hard enough leaves the ground.
     *
     * Whatever was already pushing it — a sledgehammer's swing, a blast —
     * decides. Toppling everything the same way makes a sledgehammer read
     * exactly like a pistol, which is most of the reason to carry one gone.
     */
    const shove = Math.hypot(z.vel.x, z.vel.z);
    z.launched = shove > 3.2;
    z.spin = z.launched ? rand(4, 9) * z.fallAxis : 0;
    if (z.launched) {
      z.vel.y = clamp(1.4 + shove * 0.32, 1.4, 6.5);
      z.vel.x *= 1.25; z.vel.z *= 1.25;
    } else {
      z.vel.set(dir.x * 1.6, 0, dir.z * 1.6);
    }

    // A death is loud and messy — this is the payoff for the whole loop, so
    // it is deliberately the largest single effect in the game.
    const p = this._tmp2.set(z.pos.x, z.pos.y + z.height * 0.55, z.pos.z);
    this.fx.bloodBurst(p, dir, 2.7 * z.spec.gore, true);
    this.fx.bloodPool(z.pos.x, z.pos.z, rand(1.1, 1.9) * z.scale);
    for (let i = 0; i < Math.round(7 * z.spec.gore); i++) {
      this.fx.gibs.spawn(
        p.x, p.y, p.z,
        dir.x * rand(1, 5) + gauss() * 2.8,
        rand(2.5, 7.5),
        dir.z * rand(1, 5) + gauss() * 2.8,
        rand(0.7, 1.6) * z.scale, rand(5, 9),
      );
    }
    // And a second pool where the body is going to end up, not only where it
    // was standing when it died.
    this.fx.bloodPool(z.pos.x + dir.x * 0.7, z.pos.z + dir.z * 0.7, rand(0.5, 1.0) * z.scale);
    if (byPlayer) this._backSplatter(p, dir, 2.0);

    // The killing blow takes the part it landed on with it. Whether a head
    // actually comes off is the difference between a kill that registers and
    // one that just makes a number go up, so the bar is low: any headshot
    // carrying more than a third of the body's health pops.
    let popped = false;
    if (byPlayer && z.spec.gore > 0.3 && !z.spec.boss) {
      if (part === 'head' && amount * this.mods.sever > z.maxHealth * 0.34) {
        this._sever(z, 'Head', dir, 1.6);
        popped = true;
      } else if (hitPoint && (part === 'arm' || part === 'leg')) {
        const limb = this._limbBone(z, hitPoint);
        if (limb && amount * this.mods.sever > z.maxHealth * 0.30) this._sever(z, limb, dir, 1.2);
      }
    }

    audio.growl(z.pos, z.spec.boss ? 'boss' : z.type, 0);
    audio.flesh(p, true);

    if (this.onKill) this.onKill(z, byPlayer, { crit, part, popped });
  }

  /**
   * Rebuilds one zombie's capsule set from its current bone matrices.
   *
   * Guarded by a frame stamp: a shotgun fires eight pellets through this in a
   * single frame, and the skeleton does not move between them.
   */
  _refreshHitboxes(z) {
    if (z.hbFrame === this._frameId) return;
    z.hbFrame = this._frameId;

    // The renderer will do this again later in the frame; doing it here costs
    // one extra pass over the bones of the few zombies actually being shot at.
    z.root.updateMatrixWorld(true);

    const girth = z.spec.boss ? 1.35 : 1;
    for (let i = 0; i < HITBOX_DEFS.length; i++) {
      const def = HITBOX_DEFS[i];
      const hb = z.hitboxes[i];
      const ba = z.bones[def.a], bb = z.bones[def.b];
      if (!ba || !bb || (def.limb && z.severed.has(def.limb)) || z.severed.has(def.a)) {
        hb.ok = false;
        continue;
      }
      this._tmp.setFromMatrixPosition(ba.matrixWorld);
      this._tmp2.setFromMatrixPosition(bb.matrixWorld);
      hb.a.lerpVectors(this._tmp, this._tmp2, def.t0);
      hb.b.lerpVectors(this._tmp, this._tmp2, def.t1);
      hb.r = def.r * z.scale * girth;
      hb.ok = true;
    }
  }

  /**
   * Analytic hit test along a ray. Returns the closest zombie hit with the
   * point, which body part took it, its damage multiplier, and the distance.
   *
   * `head` is kept on the result because the whole weapon layer keys crits,
   * hit markers and audio off it.
   */
  raycast(origin, dir, maxDist, out = {}) {
    let best = maxDist, hit = null, part = 'chest', mul = 1, index = -1;

    for (let i = 0; i < this.alive.length; i++) {
      const z = this.alive[i];
      if (z.state === 'dead' || z.state === 'dying') continue;

      // Broad phase: one sphere around the whole body. Generous enough to
      // cover arms thrown forward mid-attack.
      const bx = z.pos.x, by = z.pos.y + z.height * 0.5, bz = z.pos.z;
      const br = z.height * 0.70 + 0.25;
      if (!sphereOverlapsRay(origin, dir, bx, by, bz, br, best)) continue;

      this._refreshHitboxes(z);

      let anyBox = false;
      for (let j = 0; j < z.hitboxes.length; j++) {
        const hb = z.hitboxes[j];
        if (!hb.ok) continue;
        anyBox = true;
        const t = intersectCapsule(origin, dir, hb.a, hb.b, hb.r, best);
        if (t >= 0 && t < best) {
          best = t; hit = z; index = j;
          part = HITBOX_DEFS[j].part;
          mul = HITBOX_DEFS[j].mul;
        }
      }

      // A rig without the expected bones (a stand-in model, a test fixture)
      // still has to be shootable, so fall back to the old body approximation.
      if (!anyBox) {
        const t = intersectCylinder(origin, dir, z.pos.x, z.pos.z, z.radius,
          z.pos.y + 0.1, z.pos.y + z.height * 0.88, best);
        if (t >= 0 && t < best) { best = t; hit = z; index = -1; part = 'chest'; mul = 1; }
        const ht = intersectSphere(origin, dir, z.pos.x, z.pos.y + z.height * 0.92, z.pos.z,
          0.155 * z.scale * (z.spec.boss ? 1.6 : 1), best);
        if (ht >= 0 && ht < best) { best = ht; hit = z; index = -1; part = 'head'; mul = 1; }
      }
    }

    if (!hit) return null;
    out.zombie = hit;
    out.distance = best;
    out.part = part;
    out.box = index;
    out.mul = mul;
    out.head = part === 'head';
    out.point = out.point || new THREE.Vector3();
    out.point.set(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best);
    return out;
  }

  /** Every live zombie within `radius` of a point — for explosions and auras. */
  inRadius(x, z, radius, out = []) {
    out.length = 0;
    const r2 = radius * radius;
    for (let i = 0; i < this.alive.length; i++) {
      const zz = this.alive[i];
      if (zz.state === 'dead' || zz.state === 'dying') continue;
      const dx = zz.pos.x - x, dz = zz.pos.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= r2) out.push(zz);
    }
    return out;
  }

  /** Nearest live zombie to a point, for chain lightning and auto-aim assists. */
  nearest(x, z, maxDist, exclude = null) {
    let best = maxDist * maxDist, found = null;
    for (let i = 0; i < this.alive.length; i++) {
      const zz = this.alive[i];
      if (zz === exclude || zz.state === 'dead' || zz.state === 'dying') continue;
      const dx = zz.pos.x - x, dz = zz.pos.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; found = zz; }
    }
    return found;
  }

  // --------------------------------------------------------------- update

  update(dt, player, elapsed) {
    this._time = elapsed;
    this._frameId++;
    this._player = player;
    this._buildGrid();

    const px = player.pos.x, pz = player.pos.z;
    const playerAlive = !player.dead;

    let eyeCount = 0;
    const scratch = this._scratch || (this._scratch = []);

    for (let i = this.alive.length - 1; i >= 0; i--) {
      const z = this.alive[i];
      const dx = px - z.pos.x, dz = pz - z.pos.z;
      const dist = Math.hypot(dx, dz);
      z.distToPlayer = dist;

      // LOD: how often this zombie's skeleton is evaluated, and whether it
      // contributes to the shadow map.
      z.lodLevel = dist > this.preset.animLodDistance * 2 ? 2
        : dist > this.preset.animLodDistance ? 1 : 0;
      const wantShadow = dist < this.preset.zombieShadowDistance;
      if (z.meshes[0] && z.meshes[0].castShadow !== wantShadow) {
        for (const m of z.meshes) m.castShadow = wantShadow;
      }

      switch (z.state) {
        case 'emerge': this._updateEmerge(z, dt); break;
        case 'stagger': this._updateStagger(z, dt); break;
        case 'attack': this._updateAttack(z, dt, player, dist); break;
        case 'dying': this._updateDying(z, dt); break;
        case 'dead': break;
        default: this._updatePursue(z, dt, player, dist, dx, dz, playerAlive); break;
      }

      if (z.state === 'dead') { this._release(z); continue; }

      if (z.state !== 'dying') {
        this._separate(z, dt, scratch);
        this._integrate(z, dt);
      }

      this._animate(z, dt, dist);
      this._updateUniforms(z, dt);

      if (z.state !== 'dying' && z.state !== 'dead' && eyeCount + 2 <= this.eyes.instanceMatrix.count) {
        eyeCount = this._placeEyes(z, eyeCount, player);
      }
    }

    this.eyes.count = eyeCount;
    if (eyeCount) this.eyes.instanceMatrix.needsUpdate = true;

    this._ambientGrowls(dt, player);
  }

  // ---------------------------------------------------------------- states

  _updateEmerge(z, dt) {
    // A short crouched rise so zombies do not simply appear at full height.
    z.stateT += dt;
    const t = clamp(z.stateT / 0.9, 0, 1);
    z.root.position.y = -z.height * 0.65 * (1 - t) * (1 - t);
    if (z.stateT >= 0.9) {
      z.root.position.y = 0;
      z.state = 'pursue';
      z.stateT = 0;
      if (Math.random() < 0.5) audio.growl(z.pos, z.type, 0);
    }
  }

  _updateStagger(z, dt) {
    z.didHit = false;
    z.staggerT -= dt;
    z.vel.x *= Math.exp(-6 * dt);
    z.vel.z *= Math.exp(-6 * dt);
    if (z.staggerT <= 0) { z.state = 'pursue'; z.stateT = 0; }
  }

  _updatePursue(z, dt, player, dist, dx, dz, playerAlive) {
    z.stateT += dt;
    z.cooldownT -= dt;

    // Boost from a nearby screamer.
    if (z.boostT > 0) { z.boostT -= dt; if (z.boostT <= 0) z.boostMul = 1; }

    // Brute / boss charge.
    if (z.spec.charges) {
      if (z.charging) {
        z.chargeT -= dt;
        if (z.chargeT <= 0) { z.charging = false; z.chargeT = rand(5, 9); }
      } else {
        z.chargeT -= dt;
        if (z.chargeT <= 0 && dist > 6 && dist < 26) {
          z.charging = true;
          z.chargeT = rand(1.6, 2.6);
          audio.growl(z.pos, z.spec.boss ? 'boss' : 'brute', 1);
        }
      }
    }

    // Spitter ranged attack, only with a clear line.
    if (z.spec.ranged && playerAlive) {
      z.rangedT -= dt;
      const r = z.spec.ranged;
      if (z.rangedT <= 0 && dist < r.range && dist > r.minRange) {
        const from = this._tmp.set(z.pos.x, z.pos.y + z.height * 0.75, z.pos.z);
        const to = this._tmp2.set(player.pos.x, player.pos.y + 1.2, player.pos.z);
        if (this.level.collision.visible(from, to)) {
          z.rangedT = r.cooldown * rand(0.8, 1.3);
          if (this.onSpit) {
            const d = to.clone().sub(from);
            const dl = d.length();
            d.multiplyScalar(1 / dl);
            // Lead the shot slightly upward so it arcs.
            d.y += clamp(dl * 0.012, 0, 0.3);
            d.normalize();
            this.onSpit(from.clone(), d, r, z);
          }
          audio.growl(z.pos, 'spitter', 1);
        }
      }
    }

    // Screamer aura.
    if (z.spec.scream) {
      z.screamT -= dt;
      if (z.screamT <= 0 && dist < z.spec.scream.radius * 1.2) {
        z.screamT = z.spec.scream.interval * rand(0.85, 1.2);
        this._doScream(z);
      }
    }

    // Boss adds.
    if (z.spec.spawnsAdds) {
      z.addTimer -= dt;
      if (z.addTimer <= 0) {
        z.addTimer = z.spec.spawnsAdds.every;
        for (let i = 0; i < z.spec.spawnsAdds.count; i++) {
          const a = rand(0, TAU);
          const p = this._tmp.set(
            z.pos.x + Math.cos(a) * 2.2, 0, z.pos.z + Math.sin(a) * 2.2,
          );
          this.spawn(z.spec.spawnsAdds.type, p, 8);
        }
      }
    }

    // Attack when in reach.
    const reach = z.spec.attackRange * z.scale;
    if (playerAlive && dist < reach && z.cooldownT <= 0) {
      z.state = 'attack';
      z.stateT = 0;
      z.attackT = 0;
      z.didHit = false;
      z.vel.x *= 0.2; z.vel.z *= 0.2;
      return;
    }

    // Steering: flow field at range, direct line up close (the field is coarse
    // and a zombie two metres away should come straight at you).
    let sx, sz;
    if (dist < 4.5) {
      const inv = dist > 0.001 ? 1 / dist : 0;
      sx = dx * inv; sz = dz * inv;
    } else {
      const f = this.level.flow.sample(z.pos.x, z.pos.z, this._flowDir);
      if (f.x === 0 && f.z === 0) {
        const inv = dist > 0.001 ? 1 / dist : 0;
        sx = dx * inv; sz = dz * inv;
      } else { sx = f.x; sz = f.z; }
    }

    const chargeMul = z.charging ? (z.spec.sprintSpeed / z.baseSpeed) : 1;
    const target = z.baseSpeed * z.boostMul * chargeMul * this.globalSpeedMul;
    z.speed = damp(z.speed, target, 4, dt);

    // Ease off once inside striking distance so they crowd around the player
    // rather than shoving through and out the other side.
    const hold = reach * 0.8;
    const approach = dist < hold ? 0 : Math.min(1, (dist - hold) / 1.2);

    const accel = 14;
    z.vel.x = damp(z.vel.x, sx * z.speed * approach, accel * dt * 6, dt * 6);
    z.vel.z = damp(z.vel.z, sz * z.speed * approach, accel * dt * 6, dt * 6);

    z.targetYaw = Math.atan2(sx, sz);
    z.state = 'pursue';
  }

  _doScream(z) {
    const s = z.spec.scream;
    audio.growl(z.pos, 'screamer', 1);
    const list = this.inRadius(z.pos.x, z.pos.z, s.radius, this._screamOut || (this._screamOut = []));
    for (const other of list) {
      if (other === z || other.spec.boss) continue;
      other.boostMul = Math.max(other.boostMul, s.speedBoost);
      other.boostT = s.duration;
    }
    if (this.onScream) this.onScream(z);
  }

  _updateAttack(z, dt, player, dist) {
    z.attackT += dt;
    z.vel.x *= Math.exp(-9 * dt);
    z.vel.z *= Math.exp(-9 * dt);

    // Keep facing the player through the swing.
    const dx = player.pos.x - z.pos.x, dz = player.pos.z - z.pos.z;
    z.targetYaw = Math.atan2(dx, dz);

    if (!z.didHit && z.attackT >= z.spec.attackWindup) {
      z.didHit = true;
      const reach = z.spec.attackRange * z.scale + 0.45;
      if (dist <= reach && !player.dead) {
        if (this.onPlayerHit) this.onPlayerHit(z.spec.damage * this.mods.damage, z);
      }
      audio.flesh(z.pos, false);
    }

    if (z.attackT >= z.spec.attackWindup + 0.35) {
      z.didHit = false;
      z.cooldownT = z.spec.attackCooldown * rand(0.85, 1.2) / clamp(this.globalSpeedMul, 0.25, 1);
      z.state = 'pursue';
      z.stateT = 0;
    }
  }

  _updateDying(z, dt) {
    z.stateT += dt;

    if (z.launched) {
      // Ballistic, tumbling, until it comes down. Then it slides and settles
      // like any other corpse.
      z.vel.y -= 21 * dt;
      z.pos.y += z.vel.y * dt;
      z.pos.x += z.vel.x * dt;
      z.pos.z += z.vel.z * dt;
      z.fallAngle += z.spin * dt;
      if (z.pos.y <= 0) {
        z.pos.y = 0;
        z.launched = false;
        z.stateT = 0.18;              // rejoin the topple part-way through
        z.vel.x *= 0.35; z.vel.z *= 0.35;
        this.fx.bloodPool(z.pos.x, z.pos.z, rand(0.8, 1.4) * z.scale);
        audio.flesh(this._tmp.set(z.pos.x, 0.2, z.pos.z), false);
      }
    } else {
      // Fall: rotate about the foot line, then lie still, then dissolve.
      const fall = clamp(z.stateT / 0.75, 0, 1);
      z.fallAngle = (Math.PI * 0.5) * (1 - Math.pow(1 - fall, 3));
      z.vel.x *= Math.exp(-4 * dt);
      z.vel.z *= Math.exp(-4 * dt);
      z.pos.x += z.vel.x * dt;
      z.pos.z += z.vel.z * dt;
    }

    if (z.stateT > 2.8) {
      z.dissolve = clamp((z.stateT - 2.8) / 1.3, 0, 1.05);
      if (z.dissolve >= 1.04) { z.state = 'dead'; }
    }
  }

  // ------------------------------------------------------------- movement

  _buildGrid() {
    this._grid.clear();
    for (let i = 0; i < this.alive.length; i++) {
      const z = this.alive[i];
      const cx = Math.floor(z.pos.x / this._cell);
      const cz = Math.floor(z.pos.z / this._cell);
      const k = cx * 73856093 ^ cz * 19349663;
      let arr = this._grid.get(k);
      if (!arr) { arr = []; this._grid.set(k, arr); }
      arr.push(z);
    }
  }

  /**
   * Crowd separation. Without this the horde collapses into one zombie-shaped
   * column; with it they spread across the street and flank naturally.
   */
  _separate(z, dt, scratch) {
    const cx = Math.floor(z.pos.x / this._cell);
    const cz = Math.floor(z.pos.z / this._cell);
    let pushX = 0, pushZ = 0, n = 0;

    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const arr = this._grid.get(gx * 73856093 ^ gz * 19349663);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const o = arr[i];
          if (o === z || o.state === 'dying' || o.state === 'dead') continue;
          const dx = z.pos.x - o.pos.x, dz = z.pos.z - o.pos.z;
          const d2 = dx * dx + dz * dz;
          const minD = z.radius + o.radius;
          if (d2 > minD * minD || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          // Heavier zombies shove lighter ones aside instead of both budging.
          const w = (o.spec.mass / (z.spec.mass + o.spec.mass)) * 2;
          const f = (minD - d) / minD * w;
          pushX += (dx / d) * f;
          pushZ += (dz / d) * f;
          n++;
        }
      }
    }

    if (n > 0) {
      const k = 9.0;
      z.vel.x += pushX * k * dt;
      z.vel.z += pushZ * k * dt;
    }
  }

  _integrate(z, dt) {
    z.pos.x += z.vel.x * dt;
    z.pos.z += z.vel.z * dt;

    this.level.collision.resolveCircle(
      z.pos, z.radius, z.pos.y + 0.45, z.pos.y + z.height, this._colScratch || (this._colScratch = []),
    );

    // Bodies are solid against the player. The split is deliberately uneven:
    // most of the overlap is resolved by moving the zombie, so a crowd slows
    // you down and blocks a doorway without ever hard-locking you in place.
    const p = this._player;
    if (p && !p.dead) {
      const dx = z.pos.x - p.pos.x, dz = z.pos.z - p.pos.z;
      const min = z.radius + 0.40;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = min - d;
        const nx = dx / d, nz = dz / d;
        z.pos.x += nx * push * 0.68;
        z.pos.z += nz * push * 0.68;
        p.pos.x -= nx * push * 0.32;
        p.pos.z -= nz * push * 0.32;
      }
    }

    z.pos.x = clamp(z.pos.x, -48, 48);
    z.pos.z = clamp(z.pos.z, -48, 48);

    z.yaw = dampAngle(z.yaw, z.targetYaw, 7, dt);
    z.root.position.set(z.pos.x, z.root.position.y, z.pos.z);
  }

  // ------------------------------------------------------------ animation

  _animate(z, dt, dist) {
    // Staggered mixer updates for distant zombies: the single biggest CPU win
    // available, and completely invisible past ~30 m.
    const rate = z.lodLevel === 0 ? 1 : z.lodLevel === 1 ? 2 : 4;
    z.animAccum += dt;
    z._frame = (z._frame || 0) + 1;
    if (rate > 1 && z._frame % rate !== 0) {
      // Skip the skinning evaluation but keep the body where it belongs.
      this._applyRootTransform(z, dt);
      return;
    }
    const step = z.animAccum;
    z.animAccum = 0;

    if (z.state === 'dying') {
      // Freeze the clip; the body is now a falling rigid object.
      this._applyRootTransform(z, dt);
      return;
    }

    const speedRatio = clamp(Math.hypot(z.vel.x, z.vel.z) / Math.max(0.1, z.baseSpeed), 0.15, 2.2);
    const act = z.actions[z.currentClip];
    if (act) act.setEffectiveTimeScale(z.spec.clipSpeed * speedRatio * (z.state === 'attack' ? 0.3 : 1));

    z.mixer.update(step);
    this._applyPoseLayer(z, step, speedRatio);
    this._applyRootTransform(z, dt);
  }

  _applyRootTransform(z, dt) {
    z.root.rotation.set(0, z.yaw + Math.PI, 0);
    if (z.state === 'dying') {
      // Topple about the axis perpendicular to the direction of the killing blow.
      const a = z.fallAngle * z.fallAxis;
      this._e.set(a, z.yaw + Math.PI, 0, 'YXZ');
      z.root.rotation.copy(this._e);
      z.root.position.y = z.pos.y - 0.12 * clamp(z.fallAngle / (Math.PI * 0.5), 0, 1);
    }
    z.hitFlash = Math.max(0, z.hitFlash - dt * 5.5);
  }

  /**
   * The layer that makes them zombies. Applied on top of whatever the clip
   * produced, so it works with walk, run and the attack pose alike.
   */
  _applyPoseLayer(z, dt, speedRatio) {
    const b = z.bones;
    const t = this._time;
    const hunch = z.spec.hunch ?? 1;

    z.lurchPhase += dt * (3.4 + speedRatio * 2.2);
    const lurch = Math.sin(z.lurchPhase + z.phase);
    const lurch2 = Math.sin(z.lurchPhase * 0.63 + z.phase * 1.7);

    const attacking = z.state === 'attack';
    const swing = attacking
      ? clamp(z.attackT / Math.max(0.001, z.spec.attackWindup), 0, 1.6)
      : 0;

    // Spine: fold forward and lurch sideways.
    const spineBones = [b.Spine, b.Spine1, b.Spine2];
    for (let i = 0; i < spineBones.length; i++) {
      const bone = spineBones[i];
      if (!bone) continue;
      const k = (i + 1) / spineBones.length;
      this._e.set(
        POSE.spineHunch * hunch * k * (attacking ? 0.5 : 1),
        lurch2 * POSE.spineSway * 0.4 * k,
        lurch * POSE.spineSway * k,
        'XYZ',
      );
      this._q.setFromEuler(this._e);
      bone.quaternion.multiply(this._q);
    }

    // Head: lolls against the spine's sway, which reads as "neck is broken".
    if (b.Head) {
      this._e.set(
        -POSE.spineHunch * hunch * 0.8 + Math.sin(t * 0.9 + z.phase) * 0.12,
        Math.sin(t * 0.7 + z.phase * 2.1) * 0.25,
        -lurch * POSE.headLoll * 0.5,
        'XYZ',
      );
      this._q.setFromEuler(this._e);
      b.Head.quaternion.multiply(this._q);
    }

    // Arms: reach forward. During an attack they drive through the swing.
    const cfgR = (z.poseOverride || POSE);
    const armRaise = cfgR.armRaise ?? POSE.armRaise;
    const reach = attacking
      ? lerp(armRaise, armRaise * 1.9, Math.min(1, swing))
      : armRaise + lurch * POSE.armSway * 0.35;

    // `poseOverride` exists so individual zombies can be posed differently for
    // tuning; in the game every zombie uses the shared POSE table.
    const cfg = z.poseOverride || POSE;
    const ae = cfg.armEuler, am = cfg.armMirror || POSE.armMirror, fe = cfg.foreEuler;
    if (b.LeftArm) {
      this._e.set(reach * ae[0], reach * ae[1], reach * ae[2], 'XYZ');
      this._q.setFromEuler(this._e);
      b.LeftArm.quaternion.multiply(this._q);
    }
    if (b.RightArm) {
      this._e.set(reach * ae[0] * am[0], reach * ae[1] * am[1], reach * ae[2] * am[2], 'XYZ');
      this._q.setFromEuler(this._e);
      b.RightArm.quaternion.multiply(this._q);
    }
    const bend = attacking ? (cfg.foreArmBend ?? POSE.foreArmBend) * (1 - Math.min(1, swing) * 0.7) : (cfg.foreArmBend ?? POSE.foreArmBend);
    if (b.LeftForeArm) {
      this._e.set(bend * fe[0], bend * fe[1], bend * fe[2], 'XYZ');
      this._q.setFromEuler(this._e);
      b.LeftForeArm.quaternion.multiply(this._q);
    }
    if (b.RightForeArm) {
      this._e.set(bend * fe[0] * am[0], bend * fe[1] * am[1], bend * fe[2] * am[2], 'XYZ');
      this._q.setFromEuler(this._e);
      b.RightForeArm.quaternion.multiply(this._q);
    }

    // Last word on the skeleton: anything shot off stays off, whatever the
    // clip or the pose layer just did to it.
    if (z.severed.size) {
      for (const name of z.severed) {
        const bone = b[name];
        if (bone) bone.scale.setScalar(SEVERED_SCALE);
      }
    }
  }

  _updateUniforms(z, dt) {
    for (let i = 0; i < z.meshes.length; i++) {
      const u = z.meshes[i].material.userData.zUniforms;
      if (!u) continue;
      u.uHit.value = z.hitFlash;
      u.uDissolve.value = z.dissolve;
    }
  }

  /** Positions the two eye quads from the head bone, billboarded to the camera. */
  _placeEyes(z, index, player) {
    const head = z.bones.Head;
    if (!head) return index;
    head.updateWorldMatrix(true, false);
    const p = this._tmp.setFromMatrixPosition(head.matrixWorld);

    // Face the player.
    const dx = player.pos.x - p.x, dz = player.pos.z - p.z;
    const yaw = Math.atan2(dx, dz);
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
    const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);

    const sep = 0.052 * z.scale;
    const fwd = 0.085 * z.scale;
    const up = 0.035 * z.scale;

    const intensity = z.state === 'attack' ? 2.2 : z.charging ? 2.6 : 1;
    this._eyeColor.setHex(z.spec.boss ? 0xff2200 : z.spec.scream ? 0xff40aa : 0xff5522)
      .multiplyScalar(intensity);

    for (let s = -1; s <= 1; s += 2) {
      const m = this._eyeMatrix;
      m.makeRotationY(yaw);
      m.setPosition(
        p.x + fwdX * fwd + rightX * sep * s,
        p.y + up,
        p.z + fwdZ * fwd + rightZ * sep * s,
      );
      const sc = z.scale * (z.spec.boss ? 1.8 : 1);
      m.scale(this._tmp2.set(sc, sc, sc));
      this.eyes.setMatrixAt(index, m);
      this.eyes.setColorAt(index, this._eyeColor);
      index++;
    }
    if (this.eyes.instanceColor) this.eyes.instanceColor.needsUpdate = true;
    return index;
  }

  /** Occasional moans from the pack, weighted toward whoever is closest. */
  _ambientGrowls(dt, player) {
    this._growlTimer -= dt;
    if (this._growlTimer > 0 || !this.alive.length) return;
    this._growlTimer = rand(0.5, 1.6) / Math.max(1, Math.sqrt(this.alive.length) * 0.5);

    let pick = null, bestScore = -1;
    for (let i = 0; i < 5; i++) {
      const z = this.alive[randInt(0, this.alive.length - 1)];
      if (!z || z.state === 'dying' || z.state === 'dead') continue;
      const score = 1 / (1 + z.distToPlayer) + Math.random() * 0.35;
      if (score > bestScore) { bestScore = score; pick = z; }
    }
    if (pick && pick.distToPlayer < 42) {
      audio.growl(pick.pos, pick.type, pick.distToPlayer < 8 ? 1 : 0);
    }
  }

  dispose() {
    for (const z of this.zombies) {
      this.scene.remove(z.root);
      for (const m of z.meshes) m.material.dispose();
    }
    this.zombies.length = 0;
    this.alive.length = 0;
    this.scene.remove(this.eyes);
    this.eyes.dispose();
  }
}

