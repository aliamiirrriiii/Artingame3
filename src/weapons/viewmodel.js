import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp, lerp, rand, TAU } from '../core/util.js';

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
  constructor(stage, materials, collision) {
    this.stage = stage;
    this.mats = materials;
    this.collision = collision;

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

    this._basePos = new THREE.Vector3(0.155, -0.135, -0.30);
    this._adsPos = new THREE.Vector3(0, -0.058, -0.22);
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

    // Muzzle marker sits at the end of the barrel.
    this.muzzle.position.copy(g.userData.muzzle || new THREE.Vector3(0, 0, -0.3));
  }

  _build(spec) {
    const parts = [];
    const add = (matKey, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
      geo.applyMatrix4(m);
      parts.push({ matKey, geo });
    };
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const cyl = (r1, r2, h, seg = 10) => {
      const g = new THREE.CylinderGeometry(r1, r2, h, seg);
      g.rotateX(Math.PI / 2);   // point down -Z
      return g;
    };

    const t = spec.model.type;
    let muzzleZ = -0.3;

    switch (t) {
      case 'knife': {
        add('gunPolymer', box(0.026, 0.030, 0.11), 0, 0, 0.02);
        add('chrome', box(0.006, 0.034, spec.model.bladeLen), 0, 0.004, -0.04 - spec.model.bladeLen / 2);
        add('chrome', box(0.006, 0.012, 0.05), 0, 0.018, -0.05 - spec.model.bladeLen);
        add('gunmetal', box(0.05, 0.010, 0.012), 0, 0, -0.035);
        muzzleZ = -0.06 - spec.model.bladeLen;
        break;
      }

      case 'pistol': {
        add('gunmetal', box(0.032, 0.052, 0.20), 0, 0.012, -0.06);          // slide
        add('gunmetal', box(0.028, 0.026, 0.20), 0, -0.026, -0.06);         // frame
        add('gunPolymer', box(0.030, 0.088, 0.042), 0, -0.072, 0.030, 0.24); // grip
        add('gunmetal', box(0.020, 0.014, 0.030), 0, -0.040, -0.012);       // trigger guard
        add('chrome', cyl(0.008, 0.008, 0.03, 8), 0, 0.012, -0.16);         // barrel
        add('gunmetal', box(0.006, 0.008, 0.008), 0, 0.040, -0.14);         // front sight
        add('gunmetal', box(0.018, 0.008, 0.010), 0, 0.040, 0.024);         // rear sight
        muzzleZ = -0.175;
        break;
      }

      case 'revolver': {
        add('gunmetal', box(0.026, 0.040, 0.10), 0, 0.010, -0.02);
        add('chrome', cyl(0.026, 0.026, 0.055, 12), 0, 0.008, -0.005);      // cylinder
        add('chrome', cyl(0.011, 0.011, 0.16, 10), 0, 0.012, -0.13);        // long barrel
        add('gunmetal', box(0.014, 0.020, 0.15), 0, -0.008, -0.12);         // underlug
        add('wood', box(0.028, 0.090, 0.044), 0, -0.070, 0.042, 0.30);      // grip
        add('gunmetal', box(0.006, 0.010, 0.010), 0, 0.032, -0.20);
        muzzleZ = -0.215;
        break;
      }

      case 'smg': {
        add('gunPolymer', box(0.040, 0.070, 0.26), 0, 0, -0.08);            // receiver
        add('gunmetal', cyl(0.011, 0.011, 0.13, 8), 0, 0.010, -0.24);       // barrel
        add('gunPolymer', box(0.030, 0.100, 0.048), 0, -0.078, 0.020, 0.10); // grip
        add('gunmetal', box(0.030, 0.110, 0.040), 0, -0.070, -0.075, -0.12); // magazine
        add('gunPolymer', box(0.026, 0.030, 0.11), 0, 0.008, 0.11);         // stock
        add('gunmetal', box(0.044, 0.014, 0.13), 0, 0.042, -0.10);          // rail
        add('gunmetal', box(0.008, 0.016, 0.008), 0, 0.056, -0.15);
        muzzleZ = -0.31;
        break;
      }

      case 'rifle': {
        add('gunmetal', box(0.044, 0.072, 0.30), 0, 0, -0.10);
        add('wood', box(0.040, 0.048, 0.16), 0, -0.006, -0.26);             // handguard
        add('gunmetal', cyl(0.010, 0.010, 0.20, 8), 0, 0.012, -0.38);
        add('gunmetal', cyl(0.016, 0.016, 0.035, 8), 0, 0.012, -0.47);      // brake
        add('wood', box(0.030, 0.100, 0.050), 0, -0.080, 0.010, 0.12);      // grip
        add('gunmetal', box(0.034, 0.130, 0.060), 0, -0.088, -0.085, -0.30); // curved mag
        add('wood', box(0.032, 0.062, 0.17), 0, -0.016, 0.15, -0.06);       // stock
        add('gunmetal', box(0.010, 0.020, 0.010), 0, 0.052, -0.30);
        muzzleZ = -0.50;
        break;
      }

      case 'shotgun': {
        add('gunmetal', box(0.042, 0.060, 0.24), 0, 0, -0.06);
        add('gunmetal', cyl(0.017, 0.017, 0.30, 10), 0, 0.016, -0.30);      // barrel
        add('gunmetal', cyl(0.012, 0.012, 0.28, 8), 0, -0.014, -0.29);      // tube mag
        add('gunPolymer', box(0.038, 0.040, 0.10), 0, -0.014, -0.24);       // pump
        add('gunPolymer', box(0.030, 0.095, 0.048), 0, -0.072, 0.018, 0.14);
        add('gunPolymer', box(0.034, 0.058, 0.16), 0, -0.024, 0.14, -0.08);
        add('brass', box(0.008, 0.010, 0.010), 0, 0.046, -0.42);
        muzzleZ = -0.46;
        break;
      }

      case 'sniper': {
        add('gunPolymer', box(0.044, 0.070, 0.34), 0, 0, -0.10);
        add('gunmetal', cyl(0.013, 0.013, 0.34, 10), 0, 0.014, -0.44);
        add('gunmetal', cyl(0.020, 0.020, 0.06, 10), 0, 0.014, -0.62);      // brake
        add('gunmetal', cyl(0.026, 0.026, 0.20, 12), 0, 0.062, -0.14);      // scope tube
        add('chrome', cyl(0.030, 0.030, 0.02, 12), 0, 0.062, -0.245);       // objective
        add('gunmetal', box(0.014, 0.030, 0.014), 0, 0.040, -0.06);         // mounts
        add('gunmetal', box(0.014, 0.030, 0.014), 0, 0.040, -0.20);
        add('gunPolymer', box(0.030, 0.100, 0.050), 0, -0.080, 0.010, 0.10);
        add('gunPolymer', box(0.036, 0.070, 0.20), 0, -0.020, 0.18, -0.05);
        add('gunmetal', box(0.030, 0.070, 0.040), 0, -0.062, -0.10);        // mag
        muzzleZ = -0.66;
        break;
      }

      case 'lmg': {
        add('gunmetal', box(0.058, 0.086, 0.32), 0, 0, -0.10);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU;
          add('gunmetal', cyl(0.008, 0.008, 0.30, 6),
            Math.cos(a) * 0.026, 0.012 + Math.sin(a) * 0.026, -0.40);        // barrel cluster
        }
        add('gunmetal', cyl(0.042, 0.042, 0.05, 12), 0, 0.012, -0.26);      // spin plate
        add('rust', box(0.090, 0.090, 0.11), 0.055, -0.055, 0.02);          // ammo drum
        add('gunPolymer', box(0.032, 0.100, 0.050), 0, -0.084, 0.030, 0.08);
        add('gunPolymer', box(0.030, 0.060, 0.13), 0, -0.030, 0.16, -0.05);
        muzzleZ = -0.56;
        break;
      }

      case 'flamer': {
        add('gunmetal', box(0.046, 0.056, 0.22), 0, 0, -0.06);
        add('steel', cyl(0.014, 0.014, 0.16, 8), 0, 0.010, -0.24);
        add('rust', cyl(0.026, 0.026, 0.05, 10), 0, 0.010, -0.33);          // nozzle bell
        add('brass', cyl(0.006, 0.006, 0.09, 6), 0.024, 0.020, -0.28);      // pilot line
        add('rust', cyl(0.052, 0.052, 0.20, 12), 0.075, -0.030, 0.12);      // fuel tank
        add('rust', cyl(0.052, 0.052, 0.20, 12), -0.045, -0.040, 0.14);
        add('gunPolymer', box(0.030, 0.095, 0.048), 0, -0.072, 0.010, 0.12);
        muzzleZ = -0.37;
        break;
      }

      case 'tesla': {
        add('gunPolymer', box(0.050, 0.066, 0.26), 0, 0, -0.07);
        add('chrome', cyl(0.014, 0.014, 0.18, 8), 0, 0.014, -0.26);
        for (let i = 0; i < 3; i++) {
          add('chrome', cyl(0.030 - i * 0.004, 0.030 - i * 0.004, 0.012, 12),
            0, 0.014, -0.24 - i * 0.05);                                    // coil rings
        }
        add('neonCyan', cyl(0.020, 0.020, 0.10, 10), 0, 0.014, -0.16);      // core
        add('neonCyan', box(0.014, 0.030, 0.014), 0, 0.050, 0.02);          // charge lamp
        add('gunPolymer', box(0.030, 0.095, 0.048), 0, -0.074, 0.014, 0.12);
        add('gunmetal', box(0.036, 0.056, 0.14), 0, -0.024, 0.14, -0.06);
        muzzleZ = -0.40;
        break;
      }

      case 'launcher': {
        add('gunmetal', box(0.046, 0.056, 0.16), 0, 0, -0.02);
        add('gunmetal', cyl(0.032, 0.032, 0.26, 12), 0, 0.014, -0.26);      // fat tube
        add('gunmetal', cyl(0.036, 0.036, 0.03, 12), 0, 0.014, -0.39);
        add('wood', box(0.038, 0.042, 0.11), 0, -0.010, -0.20);
        add('gunPolymer', box(0.030, 0.095, 0.048), 0, -0.072, 0.020, 0.14);
        add('wood', box(0.034, 0.060, 0.16), 0, -0.022, 0.12, -0.08);
        add('gunmetal', box(0.010, 0.026, 0.010), 0, 0.048, -0.16);
        muzzleZ = -0.42;
        break;
      }

      case 'railgun': {
        add('gunPolymer', box(0.052, 0.070, 0.30), 0, 0, -0.08);
        // Twin rails with a gap between them — the whole point of the thing.
        add('chrome', box(0.010, 0.016, 0.40), 0.020, 0.018, -0.36);
        add('chrome', box(0.010, 0.016, 0.40), -0.020, 0.018, -0.36);
        add('gunmetal', box(0.056, 0.014, 0.10), 0, 0.040, -0.22);
        add('neonCyan', box(0.024, 0.008, 0.34), 0, 0.018, -0.34);          // arc channel
        add('gunmetal', cyl(0.034, 0.034, 0.08, 12), 0, 0.010, -0.18);      // capacitor
        add('neonCyan', cyl(0.016, 0.016, 0.09, 10), 0.038, -0.010, -0.10);
        add('gunPolymer', box(0.032, 0.100, 0.050), 0, -0.080, 0.014, 0.10);
        add('gunPolymer', box(0.036, 0.066, 0.18), 0, -0.022, 0.16, -0.05);
        muzzleZ = -0.58;
        break;
      }

      default: {
        add('gunmetal', box(0.05, 0.06, 0.3), 0, 0, -0.1);
        muzzleZ = -0.28;
      }
    }

    // Merge per material: three or four draws for the whole weapon.
    const byMat = new Map();
    for (const p of parts) {
      if (!byMat.has(p.matKey)) byMat.set(p.matKey, []);
      byMat.get(p.matKey).push(p.geo);
    }

    const group = new THREE.Group();
    group.name = `weapon:${spec.id}`;
    for (const [matKey, geos] of byMat) {
      const mat = this.mats.get(matKey) || this.mats.get('gunmetal');
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      group.add(mesh);
    }

    group.userData.muzzle = new THREE.Vector3(0, 0.012, muzzleZ);
    group.userData.spec = spec;
    return group;
  }

  // ------------------------------------------------------------- animation

  /** Fire kick. `power` scales with the weapon's recoil. */
  punch(power = 1) {
    this._kickVel -= 3.4 * power;
    this._kickPitchVel -= 7.0 * power;
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
    this.rig.rotation.set(
      this.kickPitch * 0.5 - this.swayY * 3.0 + this.pullback * 0.35,
      -this.swayX * 3.0 + this._sprint * 0.5,
      reloadRoll + this._sprint * 0.45 - this.swayX * 1.5,
    );

    // Minigun barrels keep spinning while the trigger is held.
    if (this.spinRate > 0.001 && this.current) {
      this.spin += this.spinRate * dt;
      this.current.rotation.z = this.spin;
    } else if (this.current && this.current.rotation.z !== 0) {
      this.current.rotation.z = damp(this.current.rotation.z, 0, 6, dt);
    }

    // Charge glow on the energy weapons.
    if (this.current && this.charge > 0.001) {
      const s = 1 + this.charge * 0.06;
      this.current.scale.set(1, 1, s);
    } else if (this.current) {
      this.current.scale.set(1, 1, 1);
    }
  }

  dispose() {
    for (const g of this.cache.values()) {
      g.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    }
    this.cache.clear();
    this.stage.camera.remove(this.root);
  }
}
