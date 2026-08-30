import * as THREE from 'three';
import { WEAPONS, fireInterval, damageAtRange, STARTING_WEAPONS, MAX_CARRIED } from './arsenal.js';
import { clamp, damp, gauss, rand, randInt, lerp, TAU } from '../core/util.js';
import { audio } from '../core/audio.js';

/**
 * Firing, ammunition, projectiles and damage resolution.
 *
 * Hitscan weapons resolve against the analytic zombie capsules and the level's
 * box colliders in one pass, picking whichever is nearer, so a shot that clips
 * a wall corner does not pass through it to hit a zombie behind. Pierce
 * continues through zombies but always stops on world geometry.
 */

const DEG = Math.PI / 180;

export class Combat {
  constructor({ stage, player, zombies, level, effects, viewmodel }) {
    this.stage = stage;
    this.player = player;
    this.zm = zombies;
    this.level = level;
    this.fx = effects;
    this.vm = viewmodel;

    this.owned = STARTING_WEAPONS.slice();
    this.index = 1;
    this.ammo = new Map();
    for (const id of this.owned) this._initAmmo(id);

    this.cooldown = 0;
    this.reloading = false;
    this.reloadT = 0;
    this.shellsToLoad = 0;
    this.spinUp = 0;
    this.charge = 0;
    this.chargeReady = false;
    this.adsAmount = 0;
    this.ads = false;
    this.switchLock = 0;
    this.lastIndex = 0;
    this.grenades = 3;
    this.maxGrenades = 4;
    this.grenadeCooldown = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;

    // Damage multipliers granted by power-ups and perks.
    this.damageMul = 1;
    this.fireRateMul = 1;
    this.instaKill = false;
    this.infiniteAmmo = false;
    this.reloadMul = 1;

    this.onPoints = null;      // (amount, kind) => void
    this.onHitMarker = null;   // (crit, killed) => void
    this.onNotice = null;      // (text) => void
    this.onDamage = null;      // (worldPoint, amount, crit) => void

    this.projectiles = [];
    this._projPool = [];
    this._buildProjectilePool();

    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._sdir = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._hitOut = {};
    this._worldOut = {};
    this._end = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._chainHit = [];
    this._radiusOut = [];

    this.vm.equip(this.spec);
  }

  // ------------------------------------------------------------- inventory

  get id() { return this.owned[this.index]; }
  get spec() { return WEAPONS[this.owned[this.index]]; }
  get mag() { return this.ammo.get(this.id)?.mag ?? 0; }
  get reserve() { return this.ammo.get(this.id)?.reserve ?? 0; }

  _initAmmo(id) {
    const w = WEAPONS[id];
    this.ammo.set(id, {
      mag: w.magSize === Infinity ? Infinity : w.magSize,
      reserve: w.reserve === Infinity ? Infinity : (w.reserve ?? 0),
    });
  }

  has(id) { return this.owned.includes(id); }

  /**
   * Adds a weapon. If the arsenal is full the currently held weapon is
   * replaced, which is the behaviour players expect from a mystery box.
   */
  give(id, { refill = true } = {}) {
    const w = WEAPONS[id];
    if (!w) return false;

    if (this.has(id)) {
      if (refill) this.refill(id);
      this.index = this.owned.indexOf(id);
      this._onSwitch();
      return true;
    }

    // Slot 0 is always the knife.
    const carried = this.owned.length - 1;
    if (carried >= MAX_CARRIED) {
      const replaceAt = this.index === 0 ? 1 : this.index;
      this.ammo.delete(this.owned[replaceAt]);
      this.owned[replaceAt] = id;
      this.index = replaceAt;
    } else {
      this.owned.push(id);
      this.index = this.owned.length - 1;
    }
    this._initAmmo(id);
    this._onSwitch();
    return true;
  }

  refill(id = this.id) {
    const w = WEAPONS[id];
    const a = this.ammo.get(id);
    if (!w || !a) return;
    a.mag = w.magSize === Infinity ? Infinity : w.magSize;
    a.reserve = w.reserve === Infinity ? Infinity : (w.reserveMax ?? w.reserve ?? 0);
  }

  refillAll() {
    for (const id of this.owned) this.refill(id);
    this.grenades = this.maxGrenades;
  }

  switchTo(i) {
    if (i < 0 || i >= this.owned.length || i === this.index || this.switchLock > 0) return;
    this.lastIndex = this.index;
    this.index = i;
    this._onSwitch();
  }

  cycle(dir) {
    const n = this.owned.length;
    this.switchTo(((this.index + dir) % n + n) % n);
  }

  _onSwitch() {
    this.reloading = false;
    this.reloadT = 0;
    this.shellsToLoad = 0;
    this.spinUp = 0;
    this.charge = 0;
    this.chargeReady = false;
    this.cooldown = Math.max(this.cooldown, 0.28);
    this.switchLock = 0.28;
    this.vm.equip(this.spec);
    this.vm.cancelReload();
    audio.click(700, 0.06, 0.22);
  }

  // ------------------------------------------------------------ projectiles

  _buildProjectilePool() {
    const geoGrenade = new THREE.SphereGeometry(0.055, 10, 8);
    const geoSpit = new THREE.SphereGeometry(0.11, 8, 6);
    const matGrenade = new THREE.MeshStandardMaterial({
      color: 0x3a4a35, roughness: 0.6, metalness: 0.5, envMapIntensity: 1.2,
    });
    const matSpit = new THREE.MeshStandardMaterial({
      color: 0x203a12, emissive: 0x6aff3a, emissiveIntensity: 1.4, roughness: 0.4,
    });

    for (let i = 0; i < 24; i++) {
      const isSpit = i >= 14;
      const m = new THREE.Mesh(isSpit ? geoSpit : geoGrenade, isSpit ? matSpit : matGrenade);
      m.visible = false;
      m.castShadow = false;
      m.frustumCulled = false;
      this.stage.scene.add(m);
      this._projPool.push({
        mesh: m, kind: isSpit ? 'spit' : 'grenade', active: false,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        life: 0, fuse: 0, spec: null, owner: null,
      });
    }
  }

  _acquireProjectile(kind) {
    for (const p of this._projPool) {
      if (!p.active && p.kind === kind) return p;
    }
    return null;
  }

  spawnProjectile(kind, origin, dir, spec, speed, owner = null) {
    const p = this._acquireProjectile(kind);
    if (!p) return null;
    p.active = true;
    p.pos.copy(origin);
    p.vel.copy(dir).multiplyScalar(speed);
    p.life = 0;
    p.fuse = spec.fuse ?? 6;
    p.spec = spec;
    p.owner = owner;
    p.mesh.position.copy(origin);
    p.mesh.visible = true;
    return p;
  }

  _updateProjectiles(dt) {
    for (const p of this._projPool) {
      if (!p.active) continue;
      p.life += dt;

      const gravity = p.kind === 'grenade' ? (p.spec.gravity ?? -16) : -5.5;
      p.vel.y += gravity * dt;

      this._tmp.copy(p.vel).multiplyScalar(dt);
      const stepLen = this._tmp.length();
      this._tmp2.copy(p.vel).normalize();

      let detonated = false;

      // World hit.
      const worldHit = stepLen > 0.0001
        ? this.level.collision.raycast(p.pos, this._tmp2, stepLen, this._worldOut)
        : null;

      // Zombie hit (grenades bounce off them, spit splashes on the player).
      if (p.kind === 'grenade') {
        const zHit = this.zm.raycast(p.pos, this._tmp2, Math.min(stepLen, worldHit ? worldHit.distance : stepLen), this._hitOut);
        if (zHit) {
          p.pos.copy(zHit.point);
          this._detonate(p);
          detonated = true;
        }
      } else {
        // Spit: does it reach the player?
        const dx = this.player.pos.x - p.pos.x;
        const dy = (this.player.pos.y + 1.0) - p.pos.y;
        const dz = this.player.pos.z - p.pos.z;
        if (dx * dx + dy * dy + dz * dz < 0.8 * 0.8) {
          this._splashPlayer(p);
          detonated = true;
        }
      }

      if (!detonated && worldHit) {
        p.pos.copy(worldHit.point).addScaledVector(worldHit.normal, 0.02);
        if (p.kind === 'grenade') {
          // Bounce, and lose most of the energy so it settles quickly.
          const dot = p.vel.dot(worldHit.normal);
          p.vel.addScaledVector(worldHit.normal, -2 * dot).multiplyScalar(0.34);
          audio.click(320, 0.05, 0.18, p.pos);
          if (p.vel.lengthSq() < 0.6) p.vel.set(0, 0, 0);
        } else {
          this._splashGround(p);
          detonated = true;
        }
      } else if (!detonated) {
        p.pos.addScaledVector(p.vel, dt);
      }

      if (!detonated) {
        p.mesh.position.copy(p.pos);
        if (p.kind === 'spit') {
          this.fx.sparks.emit({
            x: p.pos.x, y: p.pos.y, z: p.pos.z,
            vx: gauss() * 0.4, vy: gauss() * 0.4, vz: gauss() * 0.4,
            life: 0.35, size: 0.16, drag: 2, gravity: 0.6,
            r0: 0.25, g0: 1.3, b0: 0.15, r1: 0.05, g1: 0.3, b1: 0.02,
          });
        }
        if (p.life >= p.fuse) {
          if (p.kind === 'grenade') this._detonate(p);
          else this._splashGround(p);
        }
      }
    }
  }

  _detonate(p) {
    p.active = false;
    p.mesh.visible = false;
    const blast = p.spec.blast || { radius: 5, damage: 500, falloff: 0.35, selfDamage: 0.3 };
    this.explode(p.pos, blast, true);
  }

  _splashPlayer(p) {
    p.active = false;
    p.mesh.visible = false;
    this.player.takeDamage(p.spec.damage ?? 22, p.pos);
    this.fx.explosion(p.pos, 1.6, 0x6aff3a);
    audio.explosion(p.pos, 0.35);
  }

  _splashGround(p) {
    p.active = false;
    p.mesh.visible = false;
    this.fx.explosion(p.pos, 1.4, 0x6aff3a);
    this.fx.bloodDecals.place(
      { x: p.pos.x, y: 0.02, z: p.pos.z }, UP, 1.5, 0x2a4a12, 18,
    );
    audio.explosion(p.pos, 0.3);
    // Lingering pool that hurts if you stand in it.
    const d = this.player.pos.distanceTo(p.pos);
    if (d < (p.spec.radius ?? 2.2)) {
      this.player.takeDamage((p.spec.damage ?? 22) * 0.5, p.pos);
    }
  }

  // -------------------------------------------------------------- explosion

  /**
   * Radial damage. Used by the launcher, exploding barrels and the nuke.
   * `chain` lets a blast set off barrels caught in it.
   */
  explode(pos, blast, chain = false, { hurtPlayer = true } = {}) {
    const radius = blast.radius;
    this.fx.explosion(pos, radius, blast.color ?? 0xff8a30);
    audio.explosion(pos, clamp(radius / 5, 0.5, 1.6));
    this.stage.muzzleFlash(pos, 60 * (radius / 5), 0xffa040);
    this.stage.flash(clamp(radius / 22, 0.05, 0.4));

    const dPlayer = this.player.pos.distanceTo(pos);
    this.stage.addShake(clamp(1.6 / (1 + dPlayer * 0.25), 0.05, 0.9));

    const list = this.zm.inRadius(pos.x, pos.z, radius, this._radiusOut);
    let killed = 0, points = 0;
    for (const z of list) {
      const d = Math.hypot(z.pos.x - pos.x, z.pos.z - pos.z);
      const t = clamp(1 - d / radius, 0, 1);
      const dmg = blast.damage * lerp(blast.falloff ?? 0.35, 1, t) * this.damageMul;
      this._dir.set(z.pos.x - pos.x, 0.35, z.pos.z - pos.z).normalize();
      this._tmp.set(z.pos.x, z.pos.y + z.height * 0.5, z.pos.z);
      const r = this.zm.damage(z, this.instaKill ? 1e9 : dmg, this._tmp, this._dir,
        { crit: false, stagger: 0.9 * t, byPlayer: true });
      if (r) { points += r.points; if (r.killed) killed++; }
    }

    if (hurtPlayer && dPlayer < radius && blast.selfDamage) {
      const t = clamp(1 - dPlayer / radius, 0, 1);
      this.player.takeDamage(blast.damage * blast.selfDamage * t, pos);
    }

    if (chain) this._chainBarrels(pos, radius);
    if (points && this.onPoints) this.onPoints(points, 'explosion');
    return { killed, points };
  }

  _chainBarrels(pos, radius) {
    for (const b of this.level.barrels) {
      if (b.used) continue;
      if (b.pos.distanceTo(pos) > radius + b.radius) continue;
      b.used = true;
      // Deferred so a chain does not recurse into a stack overflow.
      setTimeout(() => {
        this.explode(b.pos, {
          radius: b.radius + 3.4, damage: b.damage, falloff: 0.3, selfDamage: 0.3,
        }, true);
      }, randInt(60, 220));
    }
  }

  /** Barrel test along a ray, so shooting a barrel sets it off. */
  _barrelHit(origin, dir, maxDist) {
    let best = maxDist, found = null;
    for (const b of this.level.barrels) {
      if (b.used) continue;
      const ox = origin.x - b.pos.x, oy = origin.y - b.pos.y, oz = origin.z - b.pos.z;
      const r = b.kind === 'car' ? 1.6 : 0.5;
      const bq = 2 * (ox * dir.x + oy * dir.y + oz * dir.z);
      const c = ox * ox + oy * oy + oz * oz - r * r;
      const disc = bq * bq - 4 * c;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      let t = (-bq - sq) / 2;
      if (t < 0) t = (-bq + sq) / 2;
      if (t < 0 || t > best) continue;
      best = t; found = b;
    }
    return found ? { barrel: found, distance: best } : null;
  }

  // ------------------------------------------------------------------ fire

  _spreadDir(dir, degrees, out) {
    if (degrees <= 0.001) return out.copy(dir);
    const rad = degrees * DEG;
    // Gaussian scatter reads as natural inaccuracy; a uniform disc does not.
    const ax = gauss() * rad * 0.5;
    const ay = gauss() * rad * 0.5;
    out.copy(dir);
    const right = this._tmp.set(dir.z, 0, -dir.x);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = this._tmp2.crossVectors(right, dir).normalize();
    out.addScaledVector(right, ax).addScaledVector(up, ay).normalize();
    return out;
  }

  get currentSpread() {
    const w = this.spec;
    const base = w.spread ?? 0;
    const move = w.moveSpread ?? base;
    const speed = Math.hypot(this.player.vel.x, this.player.vel.z);
    const moveT = clamp(speed / this.player.baseSpeed, 0, 1);
    const air = this.player.grounded ? 0 : 1.6;
    const adsK = 1 - this.adsAmount * 0.72;
    return (lerp(base, move, moveT) + air) * adsK * (this.player.crouching ? 0.7 : 1);
  }

  /** One hitscan line, handling pierce and choosing the nearest of world/zombie. */
  _traceLine(origin, dir, w, damage, tracerColor) {
    let remaining = (w.pierce ?? 0) + 1;
    let travelled = 0;
    let anyHit = false;
    let points = 0, kills = 0, crit = false;

    const from = this._tmp2.copy(origin);
    const maxRange = w.range;

    // Zombies already hit by this line, so pierce does not double-dip.
    const hitList = this._chainHit;
    hitList.length = 0;

    while (remaining > 0 && travelled < maxRange) {
      const left = maxRange - travelled;

      const worldHit = this.level.collision.raycast(from, dir, left, this._worldOut);
      const worldDist = worldHit ? worldHit.distance : left;

      const barrel = this._barrelHit(from, dir, worldDist);

      let zHit = null;
      let zDist = Infinity;
      // Find the nearest zombie not already pierced on this line.
      const searchLimit = barrel ? barrel.distance : worldDist;
      const candidate = this.zm.raycast(from, dir, searchLimit, this._hitOut);
      if (candidate && hitList.indexOf(candidate.zombie) === -1) {
        zHit = candidate; zDist = candidate.distance;
      } else if (candidate) {
        // Skip past the already-hit zombie and continue the line.
        from.addScaledVector(dir, candidate.distance + 0.35);
        travelled += candidate.distance + 0.35;
        continue;
      }

      if (barrel && (!zHit || barrel.distance < zDist)) {
        barrel.barrel.used = true;
        const bp = barrel.barrel.pos;
        this.fx.tracer(origin, bp, tracerColor, 0.05);
        this.explode(bp, {
          radius: barrel.barrel.radius + 3.4, damage: barrel.barrel.damage,
          falloff: 0.3, selfDamage: 0.3,
        }, true);
        return { hit: true, points, kills, crit };
      }

      if (zHit) {
        const z = zHit.zombie;
        hitList.push(z);
        const dist = travelled + zDist;
        let dmg = damageAtRange(w, dist) * this.damageMul;
        if (zHit.head) dmg *= w.headMul ?? 2;
        if (this.instaKill) dmg = 1e9;

        const r = this.zm.damage(z, dmg, zHit.point, dir, {
          crit: zHit.head, stagger: w.stagger ?? 0, byPlayer: true,
        });
        anyHit = true;
        if (this.onDamage) this.onDamage(zHit.point, dmg, zHit.head);
        if (r) {
          points += r.points;
          if (r.killed) kills++;
          if (zHit.head) crit = true;
        }
        if (w.knockback) {
          z.vel.x += dir.x * w.knockback / z.spec.mass;
          z.vel.z += dir.z * w.knockback / z.spec.mass;
        }

        this.fx.tracer(origin, zHit.point, tracerColor, 0.05);
        from.copy(zHit.point).addScaledVector(dir, 0.25);
        travelled = dist + 0.25;
        remaining--;
        continue;
      }

      // Nothing but geometry (or empty air).
      if (worldHit) {
        const metal = worldHit.box.tag === 'prop' || worldHit.box.tag === 'cover';
        this.fx.impact(worldHit.point, worldHit.normal, metal ? 'metal' : 'stone');
        audio.ricochet(worldHit.point, metal);
        this.fx.tracer(origin, worldHit.point, tracerColor, 0.05);
      } else {
        this._end.copy(from).addScaledVector(dir, left);
        this.fx.tracer(origin, this._end, tracerColor, 0.05);
      }
      break;
    }

    return { hit: anyHit, points, kills, crit };
  }

  _fireHitscan(w) {
    this.player.aimRay(this._origin, this._dir);
    this.vm.muzzleWorld(this._muzzle);

    const pellets = w.pellets ?? 1;
    const spread = this.currentSpread;
    let points = 0, kills = 0, crit = false, anyHit = false;

    for (let i = 0; i < pellets; i++) {
      this._spreadDir(this._dir, spread, this._sdir);
      const r = this._traceLine(this._muzzle, this._sdir, w, w.damage, 0xffcf9a);
      points += r.points; kills += r.kills;
      if (r.crit) crit = true;
      if (r.hit) anyHit = true;
    }

    this.fx.muzzle(this._muzzle, this._dir, w.heavy ? 1.5 : pellets > 1 ? 1.6 : 1.0);
    this.stage.muzzleFlash(this._muzzle, w.heavy ? 22 : pellets > 1 ? 26 : 16);
    audio.gunshot(this._muzzle, w.sound);
    this._afterShot(w, points, kills, crit, anyHit);
  }

  _fireBeam(w) {
    this.player.aimRay(this._origin, this._dir);
    this.vm.muzzleWorld(this._muzzle);

    const r = this._traceLine(this._muzzle, this._dir, w, w.damage, 0x9fe8ff);
    // A fat second tracer sells the beam.
    this._end.copy(this._muzzle).addScaledVector(this._dir, w.range);
    this.fx.tracer(this._muzzle, this._end, 0xbff4ff, 0.16);
    this.fx.tracer(this._muzzle, this._end, 0x3a9fff, 0.24);
    this.fx.muzzle(this._muzzle, this._dir, 2.2, 0x66ddff);
    this.stage.muzzleFlash(this._muzzle, 60, 0x66ddff);
    audio.zap(this._muzzle, w.sound);
    this._afterShot(w, r.points, r.kills, r.crit, r.hit);
  }

  _fireChain(w) {
    this.player.aimRay(this._origin, this._dir);
    this.vm.muzzleWorld(this._muzzle);

    const first = this.zm.raycast(this._muzzle, this._dir, w.range, this._hitOut);
    audio.zap(this._muzzle, w.sound);
    this.fx.muzzle(this._muzzle, this._dir, 1.4, 0x66ddff);
    this.stage.muzzleFlash(this._muzzle, 26, 0x66ddff);

    if (!first) {
      this._end.copy(this._muzzle).addScaledVector(this._dir, w.range);
      this.fx.arc(this._muzzle, this._end, 0x66ddff);
      this._afterShot(w, 0, 0, false, false);
      return;
    }

    // Walk the chain, each link weaker than the last.
    let points = 0, kills = 0;
    let from = this._muzzle.clone();
    let target = first.zombie;
    let dmg = w.damage * this.damageMul;
    const chain = this._chainHit;
    chain.length = 0;

    for (let i = 0; i < w.chains && target; i++) {
      const p = new THREE.Vector3(target.pos.x, target.pos.y + target.height * 0.6, target.pos.z);
      this.fx.arc(from, p, i === 0 ? 0x9fe8ff : 0x66ddff);
      const d = this._tmp.copy(p).sub(from).normalize();
      const r = this.zm.damage(target, this.instaKill ? 1e9 : dmg, p, d,
        { crit: false, stagger: w.stagger, byPlayer: true });
      if (r) { points += r.points; if (r.killed) kills++; }
      chain.push(target);

      // Next link: nearest not already in the chain.
      let next = null, bestD = w.chainRange * w.chainRange;
      for (const z of this.zm.alive) {
        if (chain.indexOf(z) !== -1 || z.state === 'dying' || z.state === 'dead') continue;
        const dx = z.pos.x - target.pos.x, dz = z.pos.z - target.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) { bestD = d2; next = z; }
      }
      from = p;
      target = next;
      dmg *= w.chainFalloff;
    }

    this._afterShot(w, points, kills, false, true);
  }

  _fireProjectile(w) {
    this.player.aimRay(this._origin, this._dir);
    this.vm.muzzleWorld(this._muzzle);
    this.spawnProjectile('grenade', this._muzzle, this._dir, w, w.projectileSpeed);
    this.fx.muzzle(this._muzzle, this._dir, 1.8);
    this.stage.muzzleFlash(this._muzzle, 24);
    audio.gunshot(this._muzzle, w.sound);
    this._afterShot(w, 0, 0, false, false);
  }

  /** Flamethrower: a cone test each tick rather than a projectile. */
  _fireFlame(w, dt) {
    this.player.aimRay(this._origin, this._dir);
    this.vm.muzzleWorld(this._muzzle);
    this.fx.flame(this._muzzle, this._dir, 0.16);
    if (Math.random() < 0.35) audio.flame(this._muzzle);
    this.stage.muzzleFlash(this._muzzle, 12, 0xff7a20);

    const cos = Math.cos(w.coneAngle);
    let points = 0, kills = 0, hit = false;
    for (const z of this.zm.alive) {
      if (z.state === 'dying' || z.state === 'dead') continue;
      const dx = z.pos.x - this._muzzle.x;
      const dy = (z.pos.y + z.height * 0.5) - this._muzzle.y;
      const dz = z.pos.z - this._muzzle.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > w.range || d < 0.001) continue;
      if ((dx * this._dir.x + dy * this._dir.y + dz * this._dir.z) / d < cos) continue;

      hit = true;
      const p = this._tmp.set(z.pos.x, z.pos.y + z.height * 0.55, z.pos.z);
      const dmg = (this.instaKill ? 1e9 : w.damage * this.damageMul) * dt;
      const r = this.zm.damage(z, dmg, p, this._dir, { crit: false, stagger: 0, byPlayer: true });
      if (r) { points += r.points; if (r.killed) kills++; }
      // Ignite: damage keeps ticking after the trigger is released.
      z.burnT = w.burn.duration;
      z.burnDps = w.burn.dps * this.damageMul;
    }
    if (points && this.onPoints) this.onPoints(points, 'damage');
    if (kills && this.onHitMarker) this.onHitMarker(false, true);
    return hit;
  }

  _fireMelee(w) {
    this.player.aimRay(this._origin, this._dir);
    audio.click(rand(200, 340), 0.10, 0.22);

    const cos = Math.cos(w.arc);
    let best = null, bestD = w.range;
    for (const z of this.zm.alive) {
      if (z.state === 'dying' || z.state === 'dead') continue;
      const dx = z.pos.x - this._origin.x;
      const dy = (z.pos.y + z.height * 0.6) - this._origin.y;
      const dz = z.pos.z - this._origin.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > w.range || d < 0.001) continue;
      if ((dx * this._dir.x + dy * this._dir.y + dz * this._dir.z) / d < cos) continue;
      if (d < bestD) { bestD = d; best = z; }
    }

    if (best) {
      const p = this._tmp.set(best.pos.x, best.pos.y + best.height * 0.72, best.pos.z);
      // Melee always aims for the neck: generous, and it feels good.
      const crit = Math.random() < 0.4;
      const dmg = this.instaKill ? 1e9 : w.damage * this.damageMul * (crit ? w.headMul : 1);
      const r = this.zm.damage(best, dmg, p, this._dir,
        { crit, stagger: w.stagger, byPlayer: true });
      this._afterShot(w, r?.points ?? 0, r?.killed ? 1 : 0, crit, true);
    } else {
      this._afterShot(w, 0, 0, false, false);
    }
  }

  _afterShot(w, points, kills, crit, hit) {
    this.shotsFired++;
    if (hit) this.shotsHit++;
    const rc = w.recoil;
    this.player.addRecoil(rc.pitch * (1 - this.adsAmount * 0.35), rc.yaw * (Math.random() * 2 - 1));
    this.stage.addShake(w.shake * (1 - this.adsAmount * 0.3));
    this.vm.punch(rc.kick * 8);
    if (points && this.onPoints) this.onPoints(points, kills ? 'kill' : 'damage');
    if (hit && this.onHitMarker) this.onHitMarker(crit, kills > 0);
  }

  // ---------------------------------------------------------------- reload

  canReload() {
    const w = this.spec;
    if (w.magSize === Infinity || this.infiniteAmmo) return false;
    const a = this.ammo.get(this.id);
    return a.mag < w.magSize && a.reserve > 0 && !this.reloading;
  }

  startReload() {
    if (!this.canReload()) return;
    const w = this.spec;
    this.reloading = true;
    this.reloadT = 0;
    if (w.shellReload) {
      const a = this.ammo.get(this.id);
      this.shellsToLoad = Math.min(w.magSize - a.mag, a.reserve);
    }
    this.vm.startReload(w.reloadTime * this.reloadMul);
    audio.click(520, 0.07, 0.24);
  }

  _updateReload(dt) {
    if (!this.reloading) return;
    const w = this.spec;
    const a = this.ammo.get(this.id);
    this.reloadT += dt;

    if (w.shellReload) {
      // Shell-by-shell, interruptible by firing — the classic pump-gun feel.
      if (this.reloadT >= w.reloadTime * this.reloadMul) {
        this.reloadT = 0;
        a.mag++; a.reserve--; this.shellsToLoad--;
        audio.click(430, 0.06, 0.26);
        this.vm.startReload(w.reloadTime * this.reloadMul);
        if (this.shellsToLoad <= 0 || a.mag >= w.magSize || a.reserve <= 0) {
          this.reloading = false;
          this.vm.cancelReload();
        }
      }
    } else if (this.reloadT >= w.reloadTime * this.reloadMul) {
      const need = w.magSize - a.mag;
      const take = Math.min(need, a.reserve);
      a.mag += take; a.reserve -= take;
      this.reloading = false;
      audio.click(900, 0.05, 0.3);
    }
  }

  // ---------------------------------------------------------------- update

  update(dt, input, opts = {}) {
    const { canAct = true } = opts;
    const w = this.spec;

    this.cooldown -= dt;
    this.switchLock -= dt;
    this.grenadeCooldown -= dt;
    this._updateReload(dt);
    this._updateProjectiles(dt);
    this._updateBurning(dt);

    // Aim down sights.
    this.ads = canAct && input.buttons[2] && !this.player.sprinting
      && w.adsZoom > 0 && !this.reloading;
    this.adsAmount = damp(this.adsAmount, this.ads ? 1 : 0, 13, dt);
    this.player.fovBase = 75 - (w.adsZoom ?? 0) * this.adsAmount;

    if (!canAct) {
      this.vm.setSpin(0);
      this.vm.update(dt, this.player, input, { adsAmount: this.adsAmount });
      return;
    }

    // Weapon selection.
    for (let i = 0; i < Math.min(this.owned.length, 9); i++) {
      if (input.hit(`Digit${i + 1}`)) this.switchTo(i);
    }
    if (input.hit('KeyQ')) this.switchTo(this.lastIndex);
    const wheel = input.takeWheel();
    if (wheel) this.cycle(wheel > 0 ? 1 : -1);
    if (input.hit('KeyR')) this.startReload();
    if (input.hit('KeyG')) this._throwGrenade();

    const a = this.ammo.get(this.id);
    const holding = input.buttons[0];
    const pressed = input.buttonsPressed[0];

    // Minigun spin-up: the barrels must be turning before rounds come out.
    if (w.spinUp) {
      this.spinUp = clamp(this.spinUp + (holding ? dt / w.spinUp : -dt / (w.spinUp * 0.8)), 0, 1);
      this.vm.setSpin(this.spinUp * 26);
    } else {
      this.vm.setSpin(0);
    }

    // Railgun charge.
    if (w.charge) {
      if (holding && a.mag > 0 && !this.reloading) {
        this.charge = clamp(this.charge + dt / w.charge, 0, 1);
        this.chargeReady = this.charge >= 1;
      } else if (this.charge > 0) {
        const fire = this.charge >= 0.35 && a.mag > 0 && !this.reloading && this.cooldown <= 0;
        const power = this.charge;
        this.charge = 0;
        this.chargeReady = false;
        if (fire) {
          a.mag -= this.infiniteAmmo ? 0 : 1;
          this.cooldown = fireInterval(w) / this.fireRateMul;
          const scaled = { ...w, damage: w.damage * lerp(0.35, 1, power) };
          this._fireBeam(scaled);
        }
      }
      this.vm.setCharge(this.charge);
      this.vm.update(dt, this.player, input, { adsAmount: this.adsAmount });
      if (a.mag <= 0 && !this.reloading && a.reserve > 0) this.startReload();
      return;
    }

    const wantsFire = w.automatic ? holding : pressed;

    if (wantsFire && this.cooldown <= 0 && !this.player.sprinting) {
      if (this.reloading && w.shellReload && a.mag > 0) {
        this.reloading = false;
        this.vm.cancelReload();
      }

      if (this.reloading) {
        // wait
      } else if (a.mag <= 0) {
        if (pressed) {
          audio.click(1600, 0.03, 0.2);
          if (a.reserve > 0) this.startReload();
          else if (this.onNotice) this.onNotice('OUT OF AMMO');
        }
        this.cooldown = 0.18;
      } else if (w.kind === 'flame') {
        // Fuel burns continuously rather than per shot, hit or not.
        this._fireFlame(w, dt);
        if (!this.infiniteAmmo) a.mag = Math.max(0, a.mag - dt * 60);
        this.vm.punch(0.25);
      } else if (w.spinUp && this.spinUp < 1) {
        // still spinning up
      } else {
        if (!this.infiniteAmmo) a.mag -= 1;
        this.cooldown = fireInterval(w) / this.fireRateMul
          + (w.boltAction && a.mag > 0 ? w.boltAction : 0);

        switch (w.kind) {
          case 'melee': this._fireMelee(w); break;
          case 'chain': this._fireChain(w); break;
          case 'beam': this._fireBeam(w); break;
          case 'projectile': this._fireProjectile(w); break;
          default: this._fireHitscan(w); break;
        }

        if (a.mag <= 0 && a.reserve > 0) this.startReload();
      }
    }

    this.vm.update(dt, this.player, input, { adsAmount: this.adsAmount });
  }

  _throwGrenade() {
    if (this.grenades <= 0 || this.grenadeCooldown > 0) return;
    this.grenades--;
    this.grenadeCooldown = 0.75;
    this.player.aimRay(this._origin, this._dir);
    this._dir.y += 0.14;
    this._dir.normalize();
    this._tmp.copy(this._origin).addScaledVector(this._dir, 0.5);
    this.spawnProjectile('grenade', this._tmp, this._dir, {
      blast: { radius: 6.5, damage: 520, falloff: 0.3, selfDamage: 0.4 },
      fuse: 2.2, gravity: -18,
    }, 18);
    audio.click(300, 0.08, 0.22);
  }

  /** Burn damage-over-time from the flamethrower. */
  _updateBurning(dt) {
    let points = 0;
    for (const z of this.zm.alive) {
      if (!z.burnT || z.burnT <= 0) continue;
      z.burnT -= dt;
      if (z.state === 'dying' || z.state === 'dead') { z.burnT = 0; continue; }

      const dmg = z.burnDps * dt;
      z.health -= dmg;
      points += dmg * 0.1;

      // Visible fire on the body.
      if (Math.random() < 0.55) {
        this.fx.ember({ x: z.pos.x, y: z.pos.y + z.height * rand(0.3, 0.9), z: z.pos.z }, 0.8);
      }
      if (z.health <= 0) {
        this._dir.set(gauss() * 0.4, 0.4, gauss() * 0.4).normalize();
        this.zm._kill(z, this._dir, false, true);
        if (this.onHitMarker) this.onHitMarker(false, true);
        points += z.spec.points;
      }
    }
    if (points > 0.5 && this.onPoints) this.onPoints(Math.round(points), 'damage');
  }

  /** Snapshot for the HUD. */
  hudState() {
    const w = this.spec;
    const a = this.ammo.get(this.id);
    return {
      id: w.id, name: w.name, short: w.short,
      mag: a.mag === Infinity ? '∞' : Math.ceil(a.mag),
      reserve: a.reserve === Infinity ? '∞' : Math.floor(a.reserve),
      magSize: w.magSize === Infinity ? '∞' : w.magSize,
      lowAmmo: a.mag !== Infinity && a.mag <= Math.max(1, w.magSize * 0.25),
      reloading: this.reloading,
      reloadProgress: this.reloading ? clamp(this.reloadT / (w.reloadTime * this.reloadMul), 0, 1) : 0,
      charge: this.charge,
      spinUp: this.spinUp,
      grenades: this.grenades,
      ads: this.adsAmount > 0.5,
      owned: this.owned.map((id) => WEAPONS[id].short),
      index: this.index,
    };
  }
}

const UP = new THREE.Vector3(0, 1, 0);
