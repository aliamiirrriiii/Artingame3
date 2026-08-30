import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/util.js';
import { buildWeapon } from './gunsmith.js';
import { MODEL_VIEWMODELS, buildModelWeapon, buildAdoptedWeapon } from './viewmodels.js';
import { handsTemplate, attachHands } from './hands.js';

/** Where a gunsmith-built weapon is held at the hip. Models bring their own. */
const HIP_POS = new THREE.Vector3(0.136, -0.116, -0.335);

/**
 * First-person weapon viewmodels, built procedurally.
 *
 * Each gun is assembled from primitives and then merged per material, so a
 * weapon costs three or four draw calls and can be tweaked by editing numbers
 * rather than re-exporting a model. They live in the main scene parented to the
 * camera, which means they receive the world's lighting, the muzzle flash, the
 * bloom and the grade — a gun rendered in a separate pass always looks pasted on.
 *
 * The trade for that is clipping into walls, which is handled by pulling the
 * weapon back toward the camera when something solid is close ahead.
 */

export class Viewmodel {
  constructor(stage, materials, collision, assets = null) {
    this.stage = stage;
    this.mats = materials;
    this.collision = collision;
    this.assets = assets;

    this.root = new THREE.Group();
    this.root.name = 'Viewmodel';
    // Rendered after the world so it never fights the depth buffer at grazing
    // angles; the pull-back below keeps it out of geometry.
    this.root.renderOrder = 4;
    stage.camera.add(this.root);

    this.rig = new THREE.Group();     // sway + bob
    this.recoilRig = new THREE.Group();  // recoil + reload
    this.root.add(this.rig);
    this.rig.add(this.recoilRig);

    this.cache = new Map();
    this.current = null;
    this.currentId = null;

    this.muzzle = new THREE.Object3D();
    this.recoilRig.add(this.muzzle);

    // Animation state.
    this.swayX = 0; this.swayY = 0;
    this.bobT = 0;
    this.kick = 0; this._kickVel = 0;
    this.kickPitch = 0; this._kickPitchVel = 0;
    this.reloadT = 0; this.reloadDur = 0;
    this.adsT = 0;
    this.switchT = 1;
    this.spin = 0; this.spinRate = 0;
    this.charge = 0;
    this.pullback = 0;
    // Action cycle: 0 at the instant of firing, 1 once the action is closed.
    this.cycleT = 1;
    this.cylTarget = 0;
    this.parts = {};
    this.motion = {};
    this.glow = null;

    this._basePos = HIP_POS.clone();
    // Y is replaced per weapon at equip time from its sight height; the value
    // here is only what an unbuilt weapon would use.
    this._adsPos = new THREE.Vector3(0, -0.030, -0.215);
    // Held weapons are canted a few degrees inward and down so the barrel
    // converges on the crosshair instead of pointing off to the right.
    this._baseYaw = 0.055;
    this._basePitch = 0.022;
    this._baseRoll = -0.018;
    // Slightly under scale: at the world camera's 75-degree FOV an unscaled
    // half-metre rifle eats a quarter of the screen at the edge.
    this.rig.scale.setScalar(0.94);
    this._muzzleWorld = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._rayOut = {};
  }

  // -------------------------------------------------------------- building

  equip(spec) {
    if (this.currentId === spec.id) return;
    if (this.current) this.current.visible = false;
    let g = this.cache.get(spec.id);
    if (!g) {
      g = this._build(spec);
      this.cache.set(spec.id, g);
      this.recoilRig.add(g);
    }
    g.visible = true;
    this.current = g;
    this.currentId = spec.id;
    this.switchT = 0;
    this.spin = 0;
    this.charge = 0;

    // The moving parts, and how far each of them moves.
    this.parts = g.userData.parts || {};
    this.motion = g.userData.motion || {};
    this.glow = g.userData.glow || null;
    this.cycleT = 1;
    this.cylTarget = this.parts.cylinder ? this.parts.cylinder.rotation.z : 0;
    for (const name of ['slide', 'bolt', 'pump', 'mag']) {
      const part = this.parts[name];
      if (part) { part.position.set(0, 0, 0); part.rotation.set(0, 0, 0); }
    }

    // Aiming holds the weapon so its own sighting plane is on the camera axis.
    // Weapons differ by centimetres here — an AK's rear leaf sits 26 mm higher
    // than a 1911's notch — and a single shared offset puts one or the other
    // visibly off the crosshair.
    if (g.userData.basePos) {
      // A downloaded viewmodel comes framed; the rig honours its framing.
      this._basePos.set(...g.userData.basePos);
      this._adsPos.set(...(g.userData.adsPos || [0, -(g.userData.sightY ?? 0.02), -0.26]));
    } else {
      this._basePos.copy(HIP_POS);
      this._adsPos.set(
        0,
        -(g.userData.sightY ?? 0.020),
        -clamp(0.12 + (g.userData.rear ?? 0.10), 0.22, 0.40),
      );
    }

    // Arms hang below the gun, so a weapon carrying them rides lower at the
    // hip. Aiming is untouched: the sights still have to land on the
    // crosshair, whatever is holding them.
    this._basePos.y -= g.userData.hipDrop || 0;

    // Muzzle marker sits at the end of the barrel.
    this.muzzle.position.copy(g.userData.muzzle || new THREE.Vector3(0, 0, -0.3));
  }

  _build(spec) {
    // A downloaded viewmodel where there is one, the gunsmith otherwise. If the
    // asset failed to load we fall through rather than leaving the player
    // holding nothing.
    const cfg = MODEL_VIEWMODELS[spec.model.type];
    let g = null;
    if (cfg && this.assets) {
      g = cfg.adopt
        ? buildAdoptedWeapon(spec, cfg, this.assets, this.mats)
        : buildModelWeapon(spec, cfg, this.assets);
    }
    if (!g) g = buildWeapon(spec, this.mats);
    attachHands(g, spec, this._hands());
    return g;
  }

  /** The shared hands rig, lifted from the one authored viewmodel. */
  _hands() {
    if (this._handsTpl === undefined) {
      this._handsTpl = this.assets ? handsTemplate(this.assets) : null;
    }
    return this._handsTpl;
  }


  // ------------------------------------------------------------- animation

  /**
   * Fire kick. `power` scales with the weapon's recoil.
   *
   * This also cycles the action: the slide runs back and returns, the pump
   * strokes, the cylinder indexes to the next chamber. A gun whose mechanism
   * does not move when it fires reads as a prop, however well modelled.
   */
  punch(power = 1) {
    this._kickVel -= 3.4 * power;
    this._kickPitchVel -= 7.0 * power;
    this.cycleT = 0;
    if (this.motion.cylinder) this.cylTarget -= this.motion.cylinder.step;
  }

  startReload(duration) {
    this.reloadT = 0;
    this.reloadDur = duration;
  }

  cancelReload() { this.reloadDur = 0; }

  setSpin(rate) { this.spinRate = rate; }
  setCharge(t) { this.charge = clamp(t, 0, 1); }

  /** Where the muzzle actually is in the world, for flashes and tracers. */
  muzzleWorld(out) {
    this.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.muzzle.matrixWorld);
  }

  update(dt, player, input, opts = {}) {
    const { ads = false, adsAmount = 0 } = opts;

    // Sway lags the look input, then springs back.
    const lookX = input ? -input.mouse.dx * 0.00035 : 0;
    const lookY = input ? -input.mouse.dy * 0.00035 : 0;
    this.swayX = damp(this.swayX + clamp(lookX, -0.05, 0.05), 0, 8, dt);
    this.swayY = damp(this.swayY + clamp(lookY, -0.05, 0.05), 0, 8, dt);

    // Bob, driven by the same phase as the footsteps so they line up.
    this.bobT = player.bobPhase;
    const bobAmt = player.bobAmount * (1 - adsAmount * 0.8);
    const bobX = Math.sin(this.bobT) * 0.016 * bobAmt;
    const bobY = Math.abs(Math.sin(this.bobT * 2)) * 0.012 * bobAmt;

    // Recoil springs.
    this._kickVel += -this.kick * 210 * dt;
    this._kickVel *= Math.exp(-16 * dt);
    this.kick += this._kickVel * dt;
    this._kickPitchVel += -this.kickPitch * 190 * dt;
    this._kickPitchVel *= Math.exp(-14 * dt);
    this.kickPitch += this._kickPitchVel * dt;

    // Reload: dip the weapon out of view and bring it back.
    let reloadDip = 0, reloadRoll = 0;
    if (this.reloadDur > 0) {
      this.reloadT += dt;
      const t = clamp(this.reloadT / this.reloadDur, 0, 1);
      // Down fast, hold, up slower — reads as work being done.
      const shape = t < 0.25 ? t / 0.25 : t > 0.75 ? (1 - t) / 0.25 : 1;
      reloadDip = shape * 0.11;
      reloadRoll = shape * 0.5;
      if (t >= 1) this.reloadDur = 0;
    }

    // Weapon switch: rise into frame.
    this.switchT = Math.min(1, this.switchT + dt * 4.2);
    const switchDip = (1 - this.switchT) * (1 - this.switchT) * 0.18;

    // Sprint: cant the weapon aside so it is obviously not ready to fire.
    const sprintAmt = player.sprinting && this.reloadDur === 0 ? 1 : 0;
    this._sprint = damp(this._sprint ?? 0, sprintAmt, 9, dt);

    // Pull back when close to a wall, so the barrel does not poke through it.
    if (this.collision) {
      this._fwd.set(0, 0, -1).applyQuaternion(this.stage.camera.quaternion);
      const hit = this.collision.raycast(this.stage.camera.position, this._fwd, 1.1, this._rayOut);
      const want = hit ? clamp(1 - hit.distance / 1.1, 0, 1) : 0;
      this.pullback = damp(this.pullback, want, 14, dt);
    }

    // Compose the final transform.
    const base = this._basePos, adsP = this._adsPos;
    const px = lerp(base.x, adsP.x, adsAmount) + this.swayX + bobX;
    const py = lerp(base.y, adsP.y, adsAmount) + this.swayY + bobY
             - reloadDip - switchDip - this._sprint * 0.05;
    const pz = lerp(base.z, adsP.z, adsAmount) + this.kick * 0.14
             + this.pullback * 0.20 + this._sprint * 0.05;

    this.rig.position.set(px, py, pz);
    // Convergence fades out as the sights come up — down the irons the weapon
    // has to be dead straight.
    const cant = 1 - adsAmount;
    this.rig.rotation.set(
      this._basePitch * cant + this.kickPitch * 0.5 - this.swayY * 3.0 + this.pullback * 0.35,
      this._baseYaw * cant - this.swayX * 3.0 + this._sprint * 0.5,
      this._baseRoll * cant + reloadRoll + this._sprint * 0.45 - this.swayX * 1.5,
    );
    this.rig.scale.setScalar(lerp(0.94, 1.0, adsAmount));

    if (this.current) this._animateParts(dt, adsAmount);
  }

  // ---------------------------------------------------------- moving parts

  /**
   * Drive the sub-groups the gunsmith left animatable. Everything here is
   * driven off state the viewmodel already tracks — the fire cycle, the reload
   * clock, the spin rate, the charge — so no weapon needs a special case here
   * or a call site of its own.
   */
  _animateParts(dt, adsAmount) {
    const p = this.parts, m = this.motion;

    // Fire cycle: back fast, forward slower, which is what an action does.
    const recip = m.slide || m.bolt || m.pump;
    if (recip) {
      this.cycleT = Math.min(1, this.cycleT + dt / recip.time);
      const t = this.cycleT;
      const k = t >= 1 ? 0 : t < 0.4 ? t / 0.4 : 1 - (t - 0.4) / 0.6;
      const part = p.slide || p.bolt || p.pump;
      if (part) part.position.z = k * recip.travel;
    }

    // Revolver: the cylinder springs round to the next chamber and stops.
    if (p.cylinder) {
      p.cylinder.rotation.z = damp(p.cylinder.rotation.z, this.cylTarget, 14, dt);
    }

    // Minigun: only the barrel cluster turns, not the whole weapon.
    if (p.spin) {
      if (this.spinRate > 0.001) {
        this.spin += this.spinRate * dt;
        p.spin.rotation.z = this.spin;
      } else if (p.spin.rotation.z !== 0) {
        p.spin.rotation.z = damp(p.spin.rotation.z, 0, 6, dt);
      }
    }

    // Reload: the magazine falls clear, a fresh one goes up, the action closes.
    if (p.mag && (m.magDrop || m.magForward)) {
      let drop = 0;
      if (this.reloadDur > 0) {
        const t = clamp(this.reloadT / this.reloadDur, 0, 1);
        drop = t < 0.30 ? t / 0.30
             : t < 0.58 ? 1
             : t < 0.86 ? 1 - (t - 0.58) / 0.28
             : 0;
      }
      p.mag.position.y = -(m.magDrop || 0) * drop;
      p.mag.position.z = (m.magForward || 0) * drop;
      p.mag.rotation.z = 0.55 * drop * (m.magDrop ? 1 : 0);
      // Bolt release: the action slams shut as the reload finishes.
      const closer = p.slide || p.bolt;
      if (closer && this.reloadDur > 0) {
        const t = clamp(this.reloadT / this.reloadDur, 0, 1);
        if (t > 0.86) closer.position.z = (1 - (t - 0.86) / 0.14) * (recip ? recip.travel : 0.02);
      }
    }

    // Energy weapons: the core brightens and swells as the shot charges.
    if (p.core) {
      const k = 0.35 + this.charge * 0.65;
      p.core.scale.set(1, 1, 1 + this.charge * 0.05);
      if (this.glow) this.glow.opacity = k;
    }
    // A scope reticle is only lit when you are actually behind the glass.
    if (p.reticle) p.reticle.visible = adsAmount > 0.45;
    if (p.pilot && this.glow) this.glow.opacity = 0.55 + Math.sin(performance.now() * 0.02) * 0.15;
  }

  dispose() {
    for (const g of this.cache.values()) {
      g.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    }
    this.cache.clear();
    this.stage.camera.remove(this.root);
  }
}
