import * as THREE from 'three';
import { WEAPONS } from '../weapons/arsenal.js';
import { MODEL_VIEWMODELS, buildAdoptedWeapon } from '../weapons/viewmodels.js';
import { rand, randInt, clamp } from '../core/util.js';

/**
 * Improvised weapons lying in the street.
 *
 * The loop this exists for: everything worth swinging is already on the map,
 * you take it, you wear it out, you go and find another one. Nothing here is
 * bought, which is the point — the shops are for guns, and the street is for
 * whatever you can pick up off it.
 *
 * They are the real models, laid on the ground and turning slowly, because a
 * bat you can see from across a plaza is the thing that makes you cross it.
 * Each one registers itself as a station, so the existing prompt, the E key
 * and the touch button all work on it without knowing what it is.
 */

const BOB = 0.055;

export class Pickups {
  constructor(scene, level, assets, materials) {
    this.scene = scene;
    this.level = level;
    this.assets = assets;
    this.mats = materials;
    this.items = [];
    this.root = new THREE.Group();
    this.root.name = 'Pickups';
    scene.add(this.root);
    this._v = new THREE.Vector3();
  }

  /** Every melee weapon that has a model to lie on the ground. */
  static kinds() {
    return Object.values(WEAPONS).filter(
      (w) => w.kind === 'melee' && w.pickup > 0 && MODEL_VIEWMODELS[w.model.type],
    );
  }

  /**
   * Scatters `count` weapons over the level's open ground.
   *
   * Weighted by each weapon's `pickup`: a bat turns up far more often than a
   * ukulele, so the street reads as a street with a few odd things in it
   * rather than as a props department.
   */
  build(count = 14, rng = Math.random) {
    const kinds = Pickups.kinds();
    if (!kinds.length) return this;
    const total = kinds.reduce((n, w) => n + w.pickup, 0);

    const spots = this._spots(count, rng);
    for (const p of spots) {
      let r = rng() * total;
      let spec = kinds[0];
      for (const w of kinds) { r -= w.pickup; if (r <= 0) { spec = w; break; } }
      this._place(spec, p, rng);
    }
    return this;
  }

  /**
   * Open ground, away from the walls and from each other.
   *
   * Reuses the spawn points the navigation already proved reachable, jittered
   * outward — a weapon inside a wall is worse than no weapon, and the flow
   * field is the only thing that knows what is actually walkable.
   */
  _spots(count, rng) {
    const src = this.level.spawnPoints;
    const out = [];
    if (!src?.length) return out;
    let guard = count * 40;
    while (out.length < count && guard-- > 0) {
      const base = src[randInt(0, src.length - 1)];
      const x = base.x + rand(-9, 9), z = base.z + rand(-9, 9);
      if (!this.level.flow.reachable(x, z)) continue;
      if (!this.level.flow.walkable(x, z)) continue;
      let clear = true;
      for (const o of out) {
        if ((o.x - x) ** 2 + (o.z - z) ** 2 < 36) { clear = false; break; }
      }
      if (clear) out.push({ x, z });
    }
    return out;
  }

  _place(spec, at, rng) {
    const cfg = MODEL_VIEWMODELS[spec.model.type];
    const g = buildAdoptedWeapon(spec, cfg, this.assets, this.mats);
    if (!g) return;

    // Undo the first-person carry: on the ground it lies down and is seen from
    // outside, so it needs its shadows back and its cull test back.
    g.rotation.set(0, 0, 0);
    g.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = true;
      o.renderOrder = 0;
    });

    const holder = new THREE.Group();
    holder.add(g);
    // Lay the weapon's long axis across the ground and lift it clear of it.
    g.rotation.set(-Math.PI / 2, 0, 0);
    const box = new THREE.Box3().setFromObject(g);
    g.position.y -= box.min.y;

    holder.position.set(at.x, 0.02, at.z);
    holder.rotation.y = rand(0, Math.PI * 2);
    this.root.add(holder);

    const item = {
      id: `pk_${this.items.length}`,
      kind: 'melee',
      weapon: spec.id,
      node: holder,
      pos: new THREE.Vector3(at.x, 0.9, at.z),
      base: 0.02 + box.max.y * 0.15,
      phase: rand(0, Math.PI * 2),
      taken: false,
      active: true,
    };
    this.items.push(item);
    this.level.stations.push(item);
  }

  /** Bob and turn, so they catch the eye from across the street. */
  update(dt, elapsed) {
    for (const it of this.items) {
      if (it.taken) continue;
      it.node.rotation.y += dt * 0.7;
      it.node.position.y = it.base + Math.sin(elapsed * 1.7 + it.phase) * BOB;
    }
  }

  take(item) {
    if (!item || item.taken) return false;
    item.taken = true;
    item.active = false;
    item.node.visible = false;
    return true;
  }

  /**
   * Puts everything back between waves.
   *
   * Without this the map is stripped bare by wave four and the loop stops. A
   * wave break restocking the street is also what makes the break worth using
   * for something other than shopping.
   */
  restock(fraction = 0.6) {
    const gone = this.items.filter((i) => i.taken);
    const n = Math.ceil(gone.length * clamp(fraction, 0, 1));
    for (let i = 0; i < n; i++) {
      const it = gone[i];
      it.taken = false;
      it.active = true;
      it.node.visible = true;
    }
    return n;
  }

  reset() {
    for (const it of this.items) {
      it.taken = false;
      it.active = true;
      it.node.visible = true;
    }
  }

  dispose() {
    this.scene.remove(this.root);
    this.items.length = 0;
  }
}
