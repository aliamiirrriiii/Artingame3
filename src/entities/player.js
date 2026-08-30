import * as THREE from 'three';
import { clamp, damp, lerp, rand, TAU } from '../core/util.js';
import { audio } from '../core/audio.js';

/**
 * First-person player.
 *
 * Movement is acceleration-based with separate ground and air control, which is
 * what makes strafing feel responsive without being frictionless. Collision is
 * a vertical cylinder resolved against the level's boxes, with the feet probe
 * raised by `STEP_HEIGHT` so kerbs and low debris are stepped over rather than
 * walked into — a detail you only notice when it is missing.
 */

const RADIUS = 0.40;
const HEIGHT = 1.80;
const CROUCH_HEIGHT = 1.15;
const EYE_RATIO = 0.935;
const STEP_HEIGHT = 0.42;
const GRAVITY = -22;

export class Player {
  constructor(stage, level, effects) {
    this.stage = stage;
    this.level = level;
    this.fx = effects;

    this.pos = new THREE.Vector3(0, 0, 26);
    this.vel = new THREE.Vector3();
    this.yaw = Math.PI;
    this.pitch = 0;

    this.height = HEIGHT;
    this.targetHeight = HEIGHT;
    this.grounded = true;
    this.crouching = false;
    this.sprinting = false;

    // ------------------------------------------------------------- stats
    this.maxHealth = 100;
    this.health = 100;
    this.regenDelay = 4.5;
    this.regenRate = 22;
    this._sinceDamage = 99;
    this.dead = false;

    this.baseSpeed = 5.0;
    this.sprintMul = 1.62;
    this.crouchMul = 0.5;
    this.accel = 62;
    this.airAccel = 9;
    this.friction = 11;
    this.jumpSpeed = 6.4;

    this.perks = new Set();

    // -------------------------------------------------------- camera feel
    this.bobPhase = 0;
    this.bobAmount = 0;
    this._bobOffset = new THREE.Vector3();
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this._recoilVelP = 0;
    this._recoilVelY = 0;
    this.lean = 0;
    this.landDip = 0;
    this._landVel = 0;
    this.fovBase = 75;
    this.fovCurrent = 75;

    this.flashlightOn = true;

    // ---------------------------------------------------------- feedback
    this.damageFlash = 0;
    this.damageDir = new THREE.Vector2();
    this.lastAttacker = null;
    this._heartTimer = 0;
    this._stepDist = 0;

    this.forward = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.eye = new THREE.Vector3();

    this._scratch = [];
    this._axis = { x: 0, z: 0 };
    this._rayOut = {};
    this._down = new THREE.Vector3(0, -1, 0);
    this._shake = new THREE.Vector3();
  }

  reset(spawn) {
    this.pos.copy(spawn || new THREE.Vector3(0, 0, 26));
    this.vel.set(0, 0, 0);
    this.health = this.maxHealth;
    this.dead = false;
    this._sinceDamage = 99;
    this.damageFlash = 0;
    this.pitch = 0;
    this.yaw = Math.PI;
    this.perks.clear();
    this.applyPerks();
  }

  // ------------------------------------------------------------ modifiers

  addPerk(id) {
    this.perks.add(id);
    this.applyPerks();
  }

  hasPerk(id) { return this.perks.has(id); }

  applyPerks() {
    this.maxHealth = this.perks.has('juggernaut') ? 200 : 100;
    this.health = Math.min(this.health, this.maxHealth);
    this.sprintMul = this.perks.has('sprinter') ? 1.95 : 1.62;
    this.baseSpeed = this.perks.has('sprinter') ? 5.5 : 5.0;
  }

  get speed() {
    let s = this.baseSpeed;
    if (this.crouching) s *= this.crouchMul;
    else if (this.sprinting) s *= this.sprintMul;
    return s;
  }

  get eyeHeight() { return this.height * EYE_RATIO; }

  // ------------------------------------------------------------ combat io

  takeDamage(amount, fromPos = null) {
    if (this.dead) return;
    this.health -= amount;
    this._sinceDamage = 0;
    this.damageFlash = Math.min(1, this.damageFlash + clamp(amount / 45, 0.25, 1));
    this.stage.addShake(clamp(amount / 90, 0.08, 0.5));
    audio.playerHurt(clamp(amount / 40, 0.4, 1.2));

    if (fromPos) {
      // Direction of the hit in screen space, for the HUD's damage arc.
      const dx = fromPos.x - this.pos.x;
      const dz = fromPos.z - this.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const fx = dx / len, fz = dz / len;
      this.damageDir.set(
        fx * this.right.x + fz * this.right.z,
        fx * this.forward.x + fz * this.forward.z,
      );
      this.lastAttacker = fromPos;
    }

    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
    }
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  addRecoil(pitch, yaw) {
    this._recoilVelP += pitch;
    this._recoilVelY += yaw;
  }

  // --------------------------------------------------------------- update

  update(dt, input, opts = {}) {
    const { canMove = true, freezeSlow = 1 } = opts;

    if (canMove && input.locked) {
      const look = input.takeLook();
      this.yaw += look.yaw;
      this.pitch = clamp(this.pitch + look.pitch, -1.52, 1.52);
    } else {
      input.takeLook();
    }

    // Recoil is a critically damped spring back to zero.
    this._recoilVelP += -this.recoilPitch * 62 * dt;
    this._recoilVelY += -this.recoilYaw * 62 * dt;
    this._recoilVelP *= Math.exp(-13 * dt);
    this._recoilVelY *= Math.exp(-13 * dt);
    this.recoilPitch += this._recoilVelP * dt;
    this.recoilYaw += this._recoilVelY * dt;

    this._updateBasis();

    if (!this.dead && canMove) this._move(dt, input, freezeSlow);
    else {
      this.vel.x = damp(this.vel.x, 0, 10, dt);
      this.vel.z = damp(this.vel.z, 0, 10, dt);
      this._integrateVertical(dt);
    }

    // Health regeneration, gated on not being hit recently.
    this._sinceDamage += dt;
    if (!this.dead && this._sinceDamage > this.regenDelay && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + this.regenRate * dt);
    }

    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);

    // Heartbeat under 35% health.
    const hp = this.health / this.maxHealth;
    if (!this.dead && hp < 0.35) {
      this._heartTimer -= dt;
      if (this._heartTimer <= 0) {
        audio.heartbeat(clamp(1 - hp / 0.35, 0.3, 1));
        this._heartTimer = lerp(0.55, 1.1, hp / 0.35);
      }
    }

    this._updateCamera(dt);
  }

  _updateBasis() {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    this.forward.set(-sy, 0, -cy);
    this.right.set(cy, 0, -sy);
  }

  _move(dt, input, freezeSlow) {
    const a = input.moveAxis(this._axis);
    const moving = a.x !== 0 || a.z !== 0;

    this.crouching = input.down('ControlLeft') || input.down('KeyC');
    this.sprinting = input.down('ShiftLeft') && a.z > 0.1 && !this.crouching;
    this.targetHeight = this.crouching ? CROUCH_HEIGHT : HEIGHT;

    // Refuse to stand up under a low ceiling.
    if (!this.crouching && this.height < HEIGHT - 0.01) {
      if (this._blockedAbove()) this.targetHeight = this.height;
    }
    this.height = damp(this.height, this.targetHeight, 12, dt);

    const wishX = (this.right.x * a.x + this.forward.x * a.z);
    const wishZ = (this.right.z * a.x + this.forward.z * a.z);
    const wishLen = Math.hypot(wishX, wishZ);

    const maxSpeed = this.speed * freezeSlow;
    const accel = (this.grounded ? this.accel : this.airAccel) * freezeSlow;

    if (wishLen > 0.001) {
      const nx = wishX / wishLen, nz = wishZ / wishLen;
      // Quake-style accelerate: only add speed up to the wish direction's cap.
      const current = this.vel.x * nx + this.vel.z * nz;
      const add = Math.min(maxSpeed - current, accel * dt);
      if (add > 0) { this.vel.x += nx * add; this.vel.z += nz * add; }
    }

    if (this.grounded) {
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (sp > 0.001) {
        const drop = Math.max(sp, 3.5) * this.friction * dt * (moving ? 0.35 : 1);
        const k = Math.max(0, sp - drop) / sp;
        this.vel.x *= k; this.vel.z *= k;
      }
    }

    if (input.hit('Space') && this.grounded) {
      this.vel.y = this.jumpSpeed;
      this.grounded = false;
      audio.click(180, 0.05, 0.1);
    }

    if (input.hit('KeyF')) {
      this.flashlightOn = !this.flashlightOn;
      audio.click(2400, 0.03, 0.25);
    }

    this._integrateHorizontal(dt);
    this._integrateVertical(dt);
    this._footsteps(dt, moving);
  }

  _integrateHorizontal(dt) {
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    const before = { x: this.pos.x, z: this.pos.z };
    this.level.collision.resolveCircle(
      this.pos, RADIUS,
      this.pos.y + STEP_HEIGHT,
      this.pos.y + this.height,
      this._scratch,
    );

    // Kill the velocity component we were pushed against, so sliding along a
    // wall keeps the tangential speed instead of stopping dead.
    const px = this.pos.x - before.x, pz = this.pos.z - before.z;
    const plen = Math.hypot(px, pz);
    if (plen > 1e-6) {
      const nx = px / plen, nz = pz / plen;
      const into = this.vel.x * nx + this.vel.z * nz;
      if (into < 0) { this.vel.x -= nx * into; this.vel.z -= nz * into; }
    }

    // Hard clamp to the arena in case a collider is missed.
    this.pos.x = clamp(this.pos.x, -47.5, 47.5);
    this.pos.z = clamp(this.pos.z, -47.5, 47.5);
  }

  _integrateVertical(dt) {
    this.vel.y += GRAVITY * dt;
    this.pos.y += this.vel.y * dt;

    const groundY = this._probeGround();

    if (this.pos.y <= groundY + 0.001) {
      if (!this.grounded && this.vel.y < -5) {
        // Landing: dip the camera and, past a threshold, take fall damage.
        this._landVel -= clamp(-this.vel.y * 0.022, 0, 0.35);
        this.stage.addShake(clamp(-this.vel.y / 90, 0, 0.25));
        audio.footstep(this.pos, true);
        if (this.vel.y < -17) this.takeDamage((-this.vel.y - 17) * 5.5);
      }
      this.pos.y = groundY;
      this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
  }

  /** Highest solid surface directly under the player, else 0 (the street). */
  _probeGround() {
    const origin = this._probeOrigin || (this._probeOrigin = new THREE.Vector3());
    origin.set(this.pos.x, this.pos.y + STEP_HEIGHT + 0.05, this.pos.z);
    const hit = this.level.collision.raycast(origin, this._down, STEP_HEIGHT + 0.35, this._rayOut);
    if (hit && hit.normal.y > 0.6) return hit.point.y;
    return 0;
  }

  _blockedAbove() {
    const origin = this._upOrigin || (this._upOrigin = new THREE.Vector3());
    origin.set(this.pos.x, this.pos.y + this.height * 0.5, this.pos.z);
    const up = this._up || (this._up = new THREE.Vector3(0, 1, 0));
    const hit = this.level.collision.raycast(origin, up, HEIGHT - this.height * 0.5 + 0.1, this._rayOut);
    return !!hit;
  }

  _footsteps(dt, moving) {
    if (!this.grounded || !moving) { this.bobAmount = damp(this.bobAmount, 0, 8, dt); return; }
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.bobAmount = damp(this.bobAmount, clamp(sp / this.baseSpeed, 0, 1.6), 8, dt);
    this.bobPhase += dt * (this.sprinting ? 12.5 : this.crouching ? 5.5 : 8.6) * clamp(sp / 3, 0.2, 1.6);

    this._stepDist += sp * dt;
    const stride = this.sprinting ? 2.1 : this.crouching ? 1.35 : 1.65;
    if (this._stepDist > stride) {
      this._stepDist = 0;
      audio.footstep(this.pos, this.sprinting);
      if (this.fx && Math.random() < 0.7) this.fx.footDust(this.pos.x, this.pos.z, this.sprinting ? 1.2 : 0.8);
    }
  }

  _updateCamera(dt) {
    const cam = this.stage.camera;

    // Head bob: a figure-eight, vertical at twice the horizontal rate.
    const b = this.bobAmount;
    this._bobOffset.set(
      Math.sin(this.bobPhase) * 0.045 * b,
      Math.abs(Math.sin(this.bobPhase * 2)) * 0.035 * b - 0.02 * b,
      0,
    );

    // Landing dip, spring-damped.
    this._landVel += -this.landDip * 90 * dt;
    this._landVel *= Math.exp(-11 * dt);
    this.landDip += this._landVel * dt;

    // Slight roll when strafing.
    const strafe = this.vel.x * this.right.x + this.vel.z * this.right.z;
    this.lean = damp(this.lean, clamp(-strafe / this.baseSpeed, -1, 1) * 0.035, 7, dt);

    this.eye.set(
      this.pos.x + this.right.x * this._bobOffset.x,
      this.pos.y + this.eyeHeight + this._bobOffset.y + this.landDip,
      this.pos.z + this.right.z * this._bobOffset.x,
    );

    const shake = this.stage.shakeOffset(this._shake);

    cam.position.copy(this.eye);
    cam.rotation.set(0, 0, 0);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw + this.recoilYaw + shake.y;
    cam.rotation.x = this.pitch + this.recoilPitch + shake.x;
    cam.rotation.z = this.lean + shake.z * 0.5;

    // FOV kick while sprinting reads as speed without touching the movement.
    const target = this.fovBase + (this.sprinting ? 8 : 0);
    this.fovCurrent = damp(this.fovCurrent, target, 7, dt);
    this.stage.setFov(this.fovCurrent);

    this.stage.updateFlashlight(cam, this.flashlightOn);
    this.stage.updateShadowFocus(this.pos, this.forward);

    audio.setListener(cam.position, this.right);
  }

  /** World-space muzzle origin for hitscan: eye position, forward direction. */
  aimRay(outOrigin, outDir) {
    outOrigin.copy(this.stage.camera.position);
    outDir.set(0, 0, -1).applyQuaternion(this.stage.camera.quaternion);
    return outDir;
  }
}
