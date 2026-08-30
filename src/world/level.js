import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Box, CollisionWorld, FlowField } from './collision.js';
import { PropLibrary } from './props.js';
import { RNG, clamp, TAU } from '../core/util.js';

/**
 * "Precinct 13" — a sealed city block after the outbreak.
 *
 * Layout is built around how the game actually plays: a central plaza to make a
 * stand in, four street spokes, and an unbroken perimeter ring road so a player
 * who is about to be overwhelmed can always start a training loop. Corner blocks
 * break line of sight and create the choke points the wall-buys are priced around.
 *
 * Everything static is merged into one mesh per material at build time. The
 * whole level — hundreds of boxes, windows, props — costs about a dozen draw
 * calls, which leaves the frame budget for zombies and effects.
 */

const TILE_METERS = {
  asphalt: 6, wetAsphalt: 11, concrete: 3, dirt: 5, tile: 2,
  brick: 3.2, plaster: 4, wood: 2.2, plank: 2.2, rust: 2.5,
  steel: 2, paintedMetal: 3, gunmetal: 1, ember: 1.5, water: 4,
};

export const ARENA_HALF = 50;

export class Level {
  constructor(scene, materials, assets, preset, seed = 20260830) {
    this.scene = scene;
    this.mats = materials;
    this.assets = assets;
    this.preset = preset;
    this.rng = new RNG(seed);

    this.collision = new CollisionWorld(6);
    this.flow = new FlowField(ARENA_HALF + 8, 1.25);

    this.root = new THREE.Group();
    this.root.name = 'Level';
    scene.add(this.root);

    this.batches = new Map();
    this.meshes = [];
    this.spawnPoints = [];
    this.stations = [];       // wall-buys, perk machines, mystery box anchors
    this.fixtures = [];       // light emitters we can activate near the player
    this.barrels = [];        // explosive props
    this.decorTargets = [];   // spots for ambient effects

    this._lightPool = [];
    this._flickerT = 0;

    // Downloaded glTF props, drawn instanced.
    this.props = new PropLibrary(scene, assets, preset);
    this.windowPlacements = [];
  }

  // ------------------------------------------------------------- batching

  _batch(matKey) {
    let b = this.batches.get(matKey);
    if (!b) { b = []; this.batches.set(matKey, b); }
    return b;
  }

  /** Box with world-scaled UVs, optionally solid. Returns its collider. */
  box(matKey, x, y, z, w, h, d, opts = {}) {
    const { rotY = 0, collide = true, tag = 'world', tileScale = 1 } = opts;
    const tile = (TILE_METERS[matKey] || 3) * tileScale;
    const g = new THREE.BoxGeometry(w, h, d);
    scaleBoxUVs(g, w, h, d, tile);
    const m = new THREE.Matrix4()
      .makeRotationY(rotY)
      .setPosition(x, y + h / 2, z);
    g.applyMatrix4(m);
    this._batch(matKey).push(g);

    if (!collide) return null;
    return this.collision.add(new Box(x, y, z, w / 2, d / 2, y + h, rotY, tag));
  }

  /** Flat ground quad (no collision — the floor is implicit at y=0). */
  ground(matKey, x, z, w, d, opts = {}) {
    const { y = 0, rotY = 0, tileScale = 1 } = opts;
    const tile = (TILE_METERS[matKey] || 3) * tileScale;
    const g = new THREE.PlaneGeometry(w, d, 1, 1);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * (w / tile), uv.getY(i) * (d / tile));
    }
    uv.needsUpdate = true;
    g.rotateX(-Math.PI / 2);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y, z);
    this._batch(matKey).push(g);
  }

  cylinder(matKey, x, y, z, rTop, rBot, h, opts = {}) {
    const { seg = 12, collide = false, tag = 'world', tileScale = 1 } = opts;
    const tile = (TILE_METERS[matKey] || 3) * tileScale;
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, false);
    const uv = g.attributes.uv;
    const circ = TAU * Math.max(rTop, rBot);
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * (circ / tile), uv.getY(i) * (h / tile));
    }
    uv.needsUpdate = true;
    g.translate(x, y + h / 2, z);
    this._batch(matKey).push(g);
    if (collide) {
      const r = Math.max(rTop, rBot);
      return this.collision.add(new Box(x, y, z, r, r, y + h, 0, tag));
    }
    return null;
  }

  // ----------------------------------------------------------------- build

  build() {
    this._buildGround();
    this._buildPerimeter();
    this._buildBlocks();
    this._buildPlaza();
    this._buildStreetProps();
    this._buildSpawnPoints();
    this._buildStations();
    this._finalize();
    this._buildBrokenWindows();
    this._buildLightPools();

    this.flow.bake(this.collision, 0.5, 0.55);
    this.flow.sealBorder(2);

    // A spawn point walled off from the plaza would strand its zombies, so
    // prove every one of them is connected before the game can use it.
    this.flow.compute(0, 0, true);
    const usable = this.spawnPoints.filter((p) => this.flow.reachable(p.x, p.z));
    if (usable.length >= 4) this.spawnPoints = usable;
    this.flow._lastCell = -1;

    this._buildLightPool();
    return this;
  }

  _buildGround() {
    const H = ARENA_HALF;
    // Base asphalt across the whole block.
    this.ground('asphalt', 0, 0, H * 2 + 16, H * 2 + 16, { y: 0 });

    // Sidewalks around the four corner blocks, raised 12 cm.
    for (const [sx, sz] of QUADRANTS) {
      this.ground('concrete', sx * 34, sz * 34, 30, 30, { y: 0.12 });
    }

    // Overgrown lots that break up the grey.
    this.ground('dirt', -34, 0, 14, 22, { y: 0.02 });
    this.ground('dirt', 34, 0, 14, 22, { y: 0.02 });

    // Plaza apron — poured concrete, tiled tighter than the sidewalks so the
    // change of surface reads underfoot.
    this.ground('concrete', 0, 0, 26, 26, { y: 0.06, tileScale: 0.7 });

    // Standing water where the drains backed up — mirrors the moon and every
    // muzzle flash, which is most of what sells "wet night street".
    for (const [px, pz, pr] of [[-14, 22, 7], [19, -12, 6], [0, 38, 9], [-30, -26, 5]]) {
      this.ground('wetAsphalt', px, pz, pr * 2, pr * 2, { y: 0.015 });
    }
  }

  _buildPerimeter() {
    const H = ARENA_HALF;
    const wallH = 9;
    // Solid outer shell with no gaps: the block is sealed.
    this.box('brick', 0, 0, -H, H * 2 + 4, wallH, 4, { tag: 'wall' });
    this.box('brick', 0, 0, H, H * 2 + 4, wallH, 4, { tag: 'wall' });
    this.box('brick', -H, 0, 0, 4, wallH, H * 2 + 4, { tag: 'wall' });
    this.box('brick', H, 0, 0, 4, wallH, H * 2 + 4, { tag: 'wall' });

    // Buttress piers, purely to break the flat run of wall.
    for (let i = -4; i <= 4; i++) {
      const t = i * 11;
      this.box('concrete', t, 0, -H + 2.6, 1.6, 9.6, 1.2, { tag: 'wall' });
      this.box('concrete', t, 0, H - 2.6, 1.6, 9.6, 1.2, { tag: 'wall' });
      this.box('concrete', -H + 2.6, 0, t, 1.2, 9.6, 1.6, { tag: 'wall' });
      this.box('concrete', H - 2.6, 0, t, 1.2, 9.6, 1.6, { tag: 'wall' });
    }
  }

  /** Four corner blocks of buildings, each with an interior alley. */
  _buildBlocks() {
    for (const [sx, sz] of QUADRANTS) {
      const ox = sx * 34, oz = sz * 34;
      const r = this.rng;

      // Three buildings per block, arranged in an L with a slot between them.
      const specs = [
        { x: ox - sx * 8, z: oz - sz * 9, w: 14, d: 11, h: r.range(9, 14) },
        { x: ox + sx * 8, z: oz - sz * 6, w: 11, d: 16, h: r.range(11, 17) },
        { x: ox - sx * 4, z: oz + sz * 8, w: 18, d: 9, h: r.range(7, 11) },
      ];

      for (const s of specs) this._building(s.x, s.z, s.w, s.d, s.h);
    }
  }

  _building(x, z, w, d, h) {
    const r = this.rng;
    const matKey = r.next() < 0.55 ? 'brick' : 'plaster';
    this.box(matKey, x, 0, z, w, h, d, { tag: 'wall' });

    // Parapet + roof slab: reads correctly from the ground and gives the
    // silhouette an edge against the sky.
    this.box('concrete', x, h, z, w + 0.5, 0.6, d + 0.5, { collide: false });

    // Ground-floor plinth.
    this.box('concrete', x, 0, z, w + 0.3, 0.9, d + 0.3, { tag: 'wall' });

    // Windows. In daylight every one of them is a dark reflective pane: what
    // you see in the glass is the sky and the building opposite, which is what
    // sells a street as somewhere with depth behind its facades.
    const floors = Math.max(1, Math.floor((h - 2.5) / 3.2));
    const darkBatch = this._batch('windowDark');

    for (let f = 0; f < floors; f++) {
      const wy = 2.2 + f * 3.2;
      if (wy + 1.2 > h) break;
      for (const [nx, nz, ww] of [
        [0, -1, w], [0, 1, w], [-1, 0, d], [1, 0, d],
      ]) {
        const count = Math.max(1, Math.floor(ww / 3.2));
        for (let i = 0; i < count; i++) {
          const t = (i + 0.5) / count - 0.5;
          const px = x + nx * (w / 2 + 0.06) + (nx === 0 ? t * ww : 0);
          const pz = z + nz * (d / 2 + 0.06) + (nz === 0 ? t * ww : 0);
          // Ground floor, facing the plaza: use the real smashed-window model.
          // Everything above stays a cheap quad — you never get close enough
          // to tell, and there are hundreds of them.
          const towardPlaza = (nx !== 0 && Math.sign(nx) !== Math.sign(x))
            || (nz !== 0 && Math.sign(nz) !== Math.sign(z));
          if (f === 0 && towardPlaza && r.next() < 0.65) {
            this.windowPlacements.push({
              x: px + nx * 0.06, y: wy - 0.78, z: pz + nz * 0.06,
              rotY: Math.atan2(nx, nz),
            });
          } else {
            const g = new THREE.PlaneGeometry(1.5, 1.9);
            g.rotateY(Math.atan2(nx, nz));
            g.translate(px, wy, pz);
            darkBatch.push(g);
          }

          // Lit windows were the warm landmarks of the night version. In
          // daylight nothing behind that glass could out-shine the sky, so
          // they are simply windows now.
        }
      }
    }

    // Boarded-up doorway on the street-facing side.
    const side = r.int(0, 3);
    const [dnx, dnz] = [[0, -1], [0, 1], [-1, 0], [1, 0]][side];
    const dx = x + dnx * (w / 2 + 0.12);
    const dz = z + dnz * (d / 2 + 0.12);
    for (let i = 0; i < 4; i++) {
      this.box('plank',
        dx + (dnz ? 0 : 0), 0.5 + i * 0.55, dz,
        dnz ? 2.2 : 0.1, 0.34, dnz ? 0.1 : 2.2,
        { collide: false, rotY: r.range(-0.05, 0.05) });
    }
  }

  _buildPlaza() {
    // Fountain: the anchor of the whole map and the best place to hold.
    this.cylinder('concrete', 0, 0.06, 0, 5.2, 5.6, 1.0, { seg: 24, collide: true, tag: 'cover' });
    this.cylinder('concrete', 0, 1.0, 0, 4.6, 4.6, 0.15, { seg: 24 });
    this.cylinder('concrete', 0, 1.1, 0, 0.7, 1.1, 2.4, { seg: 12, collide: true, tag: 'cover' });
    this.cylinder('water', 0, 1.05, 0, 4.4, 4.4, 0.06, { seg: 24 });

    // A dead statue on top, because every plaza has one.
    this.cylinder('rust', 0, 3.5, 0, 0.35, 0.5, 1.8, { seg: 8 });
    this.box('rust', 0, 5.3, 0, 0.9, 0.9, 0.5, { collide: false });

    // Planters ringing the plaza — waist-high cover you can shoot over.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.39;
      const px = Math.cos(a) * 11, pz = Math.sin(a) * 11;
      this.box('concrete', px, 0.06, pz, 2.6, 0.85, 2.6, { rotY: a, tag: 'cover' });
      this.ground('dirt', px, pz, 2.2, 2.2, { y: 0.92 });
    }

    // Overturned squad car in the middle of the plaza, still burning.
    this._car(-8.5, 6.5, 0.7, true);
    this._car(9, -7.5, -1.9, false);
  }

  /** Procedural wrecked car: body, cabin, wheels, blown-out glass. */
  _car(x, z, rot, burning) {
    const bodyKey = 'paintedMetal';
    this.box(bodyKey, x, 0.42, z, 4.4, 0.75, 1.95, { rotY: rot, tag: 'cover' });
    this.box(bodyKey, x, 0.05, z, 4.0, 0.4, 1.8, { rotY: rot, collide: false });

    const cx = Math.cos(rot), sz = Math.sin(rot);
    // Cabin, pushed back from the centre along the car's long axis.
    this.box(bodyKey, x - cx * 0.35, 1.17, z - sz * 0.35, 2.1, 0.75, 1.75,
      { rotY: rot, tag: 'cover' });
    this.box('brokenGlass', x - cx * 0.35, 1.2, z - sz * 0.35, 2.0, 0.65, 1.8,
      { rotY: rot, collide: false });

    for (const [ox, oz] of [[1.5, 0.95], [1.5, -0.95], [-1.5, 0.95], [-1.5, -0.95]]) {
      const wx = x + ox * cx - oz * sz;
      const wz = z + ox * sz + oz * cx;
      const g = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 12);
      g.rotateX(Math.PI / 2);
      g.rotateY(rot);
      g.translate(wx, 0.36, wz);
      this._batch('rust').push(g);
    }

    if (burning) {
      this.fixtures.push({
        pos: new THREE.Vector3(x, 1.4, z),
        color: 0xff7a22, intensity: 34, range: 17, flicker: 0.65, kind: 'fire',
      });
      this.decorTargets.push({ pos: new THREE.Vector3(x, 1.5, z), kind: 'fire', scale: 1.4 });
    }
    this.barrels.push({ pos: new THREE.Vector3(x, 0.8, z), radius: 2.6, damage: 260, used: false, kind: 'car' });
  }

  _buildStreetProps() {
    const r = this.rng;

    // Street lamps. These are the downloaded "old wooden street light" model
    // rather than a procedural pole: one material across its three meshes, so
    // every lamp on the map is a single instanced draw call. The light itself
    // is placed at the lantern's own bulb, read out of the model, instead of
    // being guessed from an offset.
    const lamp = this.props.prepare('lantern', {
      targetHeight: 6.6,
      markers: { bulb: 'LanternPole_Lantern' },
      material: (mat) => {
        // The street lights are off: it is the middle of the afternoon, and a
        // lamp glowing in daylight is the sort of detail that makes a scene
        // read as a game rather than a place.
        mat.emissiveIntensity = 0.0;
        mat.envMapIntensity = 1.0;
        return null;
      },
    });

    const lampPlacements = [];
    const bulb = new THREE.Vector3();
    for (const [lx, lz, rot] of STREETLIGHTS) {
      const place = { x: lx, y: 0, z: lz, rotY: rot };
      lampPlacements.push(place);

      // The post is what you collide with, not the whole lamp.
      this.collision.add(new Box(lx, 0, lz, 0.16, 0.16, 6.2, 0, 'cover'));

      if (lamp) this.props.markerWorld(lamp, 'bulb', place, bulb);
      else bulb.set(lx + Math.cos(rot) * 1.7, 5.7, lz + Math.sin(rot) * 1.7);

      // No fixture: an unlit lamp emits nothing, and the point-light budget is
      // better spent on the fires, which are the only real light sources left.
    }
    if (lamp) this.props.place(lamp, lampPlacements, { name: 'lantern' });

    this._buildCones();

    // Burning barrels: warmth, landmarks, and 260 damage when shot.
    for (const [bx, bz] of BARRELS) {
      this.cylinder('rust', bx, 0, bz, 0.42, 0.38, 1.05, { seg: 12, collide: true, tag: 'prop' });
      this.cylinder('ember', bx, 1.0, bz, 0.38, 0.38, 0.12, { seg: 12 });
      this.fixtures.push({
        pos: new THREE.Vector3(bx, 1.5, bz),
        color: 0xff8a30, intensity: 26, range: 14, flicker: 0.75, kind: 'fire',
      });
      this.decorTargets.push({ pos: new THREE.Vector3(bx, 1.15, bz), kind: 'fire', scale: 1 });
      this.barrels.push({ pos: new THREE.Vector3(bx, 0.6, bz), radius: 3.2, damage: 340, used: false, kind: 'barrel' });
    }

    // Crates and dumpsters: mid-height cover, scattered but never blocking a
    // spoke completely, so the ring loop always stays runnable.
    for (let i = 0; i < 34; i++) {
      const a = r.range(0, TAU), rad = r.range(14, 46);
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      if (this._occupied(x, z, 2.2)) continue;
      if (r.next() < 0.35) {
        this.box('rust', x, 0, z, 2.4, 1.5, 1.3, { rotY: r.range(0, TAU), tag: 'cover' });
      } else {
        const s = r.range(0.8, 1.35);
        this.box('wood', x, 0, z, s, s, s, { rotY: r.range(0, TAU), tag: 'cover' });
        if (r.next() < 0.4) {
          this.box('wood', x + r.range(-0.3, 0.3), s, z + r.range(-0.3, 0.3),
            s * 0.85, s * 0.85, s * 0.85, { rotY: r.range(0, TAU), collide: false });
        }
      }
    }

    // Sandbag barricades at the mouths of the four spokes.
    for (const [sx, sz, rot] of BARRICADES) {
      for (let i = 0; i < 3; i++) {
        this.box('dirt', sx + Math.cos(rot + Math.PI / 2) * (i - 1) * 1.5, 0,
          sz + Math.sin(rot + Math.PI / 2) * (i - 1) * 1.5,
          1.5, 0.95, 0.7, { rotY: rot, tag: 'cover', tileScale: 0.3 });
      }
    }

    // Chain-link fence runs that funnel the horde into the plaza.
    for (const [fx, fz, len, rot] of FENCES) {
      const seg = Math.floor(len / 2.4);
      for (let i = 0; i < seg; i++) {
        const t = (i - (seg - 1) / 2) * 2.4;
        const px = fx + Math.cos(rot) * t, pz = fz + Math.sin(rot) * t;
        // Twelve sides, not six: at six a 50 mm post has 25 mm flat faces, and
        // one of them catching the sun square-on lights the whole post up like
        // a strip light. More sides make the highlight narrow instead.
        this.cylinder('steel', px, 0, pz, 0.05, 0.05, 2.1, { seg: 12 });
        this.box('steel', px, 2.05, pz, 2.4, 0.06, 0.06, { rotY: rot, collide: false });
      }
      this.collision.add(new Box(fx, 0, fz, len / 2, 0.12, 2.1, rot, 'cover'));
    }
  }

  /**
   * Traffic cones around the barricades and along the spokes. The asset ships
   * inside a demo scene, so only the cone node is taken; the rest is a 19.7 m
   * ground plane, a camera and a light.
   */
  _buildCones() {
    const cone = this.props.prepare('trafficCone', {
      include: ['Cone Normal'],
      // Authored Z-up: its 0.52 m dimension is the height, not the 0.42 m one.
      // Without this every cone is normalised across its width and laid over.
      orient: [-Math.PI / 2, 0, 0],
      targetHeight: 0.72,
      material: (mat) => {
        // Authored as a bright retroreflective cone for daylight product shots.
        // Under moonlight that reads as a glowing plastic toy, so knock the
        // albedo down and rough it up; it still lights up under the flashlight,
        // which is when you actually want to see it.
        mat.color = new THREE.Color(0x6a6a6a);
        mat.envMapIntensity = 0.35;
        mat.roughness = Math.min(1, (mat.roughness ?? 0.6) + 0.25);
        mat.metalness = 0;
        return null;
      },
    });
    if (!cone) return;

    const r = this.rng;
    const places = [];

    // Clustered at the barricades, where a road closure would actually be.
    // The sandbags run along (cos(rot+90), sin(rot+90)), so the cones are
    // offset along the perpendicular to stand *in front* of the line rather
    // than inside it.
    for (const [bx, bz, rot] of BARRICADES) {
      const alongX = Math.cos(rot + Math.PI / 2), alongZ = Math.sin(rot + Math.PI / 2);
      const outX = Math.cos(rot), outZ = Math.sin(rot);
      const n = this.preset.mobile ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const t = (i - (n - 1) / 2) * 1.7;
        // Alternate sides so both approaches to the barricade are marked.
        const side = (i % 2 === 0 ? 1 : -1) * r.range(1.5, 2.1);
        const x = bx + alongX * t + outX * side + r.range(-0.2, 0.2);
        const z = bz + alongZ * t + outZ * side + r.range(-0.2, 0.2);
        if (this._occupied(x, z, 0.45)) continue;
        places.push({
          x, z,
          rotY: r.range(0, TAU),
          // A few have been knocked over.
          tiltX: r.next() < 0.25 ? r.range(1.2, 1.6) : r.range(-0.04, 0.04),
        });
      }
    }
    // A scatter of strays, none of them blocking the ring road.
    const strays = this.preset.mobile ? 3 : 6;
    for (let i = 0; i < strays; i++) {
      const a = r.range(0, TAU), rad = r.range(16, 44);
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      if (this._occupied(x, z, 1.0)) continue;
      places.push({
        x, z, rotY: r.range(0, TAU),
        tiltX: r.next() < 0.4 ? r.range(1.2, 1.6) : 0,
      });
    }
    // Small enough that its shadow is invisible, and shadow casting would
    // triple its cost across the moon and flashlight depth passes.
    this.props.place(cone, places, { name: 'cone', castShadow: false, receiveShadow: true });
  }

  /**
   * Smashed street-level windows. Only the ground floor gets them — that is
   * the only storey the player is ever close enough to read — and only a
   * capped number, because each one is a separate piece of geometry rather
   * than a flat emissive quad.
   */
  _buildBrokenWindows() {
    if (!this.windowPlacements.length) return;
    const win = this.props.prepare('brokenWindow', {
      targetHeight: 1.55,
      merge: false,
      material: (mat, name) => {
        if (name === 'WindowFrame') {
          // Showroom white, straight out of a furniture catalogue.
          mat.color.setHex(0x4a453c);
          mat.roughness = 0.88;
          mat.metalness = 0.0;
          mat.envMapIntensity = 0.5;
        } else if (name === 'WindowGlass') {
          // Transmission needs its own render pass; far too expensive for
          // dozens of windows, and at night the difference is invisible.
          mat.transmission = 0;
          mat.thickness = 0;
          // Dark and only sharply reflective: at night a pane reads as almost
          // black with a hard glint, not as a lit panel.
          mat.roughness = 0.18;
          mat.metalness = 0;
          mat.color.setHex(0x2b3740);
          mat.envMapIntensity = 0.9;
          mat.side = THREE.DoubleSide;
        } else if (name === 'WindowClasp') {
          mat.color.setHex(0x2a241c);
          mat.roughness = 0.7;
        }
        return null;
      },
    });
    if (!win) return;

    const cap = this.preset.mobile ? 16 : 40;
    const list = this.windowPlacements.slice(0, cap);
    this.props.place(win, list, { name: 'window', castShadow: false });
  }

  _occupied(x, z, pad) {
    const scratch = [];
    this.collision.near(x, z, pad + 1, scratch);
    for (const b of scratch) if (b.containsXZ(x, z, pad)) return true;
    // Keep the plaza centre and the ring road clear.
    if (Math.hypot(x, z) < 13) return true;
    return false;
  }

  /**
   * Spawn points sit in the recessed alleys behind the corner blocks and along
   * the ring road, so the horde walks in rather than appearing in front of you.
   */
  _buildSpawnPoints() {
    const candidates = [];
    for (const [sx, sz] of QUADRANTS) {
      candidates.push([sx * 44, sz * 26], [sx * 26, sz * 44], [sx * 44, sz * 44]);
    }
    candidates.push([0, 45], [0, -45], [45, 0], [-45, 0]);
    candidates.push([0, 30], [0, -30], [30, 0], [-30, 0]);

    for (const [x, z] of candidates) {
      // Nudge until the point is genuinely walkable.
      let px = x, pz = z, ok = false;
      for (let a = 0; a < 12 && !ok; a++) {
        const ang = (a / 12) * TAU;
        const rr = a === 0 ? 0 : 2.5;
        px = x + Math.cos(ang) * rr;
        pz = z + Math.sin(ang) * rr;
        ok = !this._occupied(px, pz, 0.7) && Math.abs(px) < ARENA_HALF - 3 && Math.abs(pz) < ARENA_HALF - 3;
      }
      if (ok) this.spawnPoints.push(new THREE.Vector3(px, 0, pz));
    }
  }

  /** Anchors for wall-buys, perk machines and the mystery box. */
  _buildStations() {
    const defs = [
      // Wall-buys are mounted on the plaza-facing wall of each corner block's
      // front building — one per quadrant, so whichever way you run there is
      // something to spend points on.
      { id: 'buy_shotgun',  kind: 'wallbuy', x: -26, z: -19.3, rot: 0,       weapon: 'shotgun',  cost: 1200 },
      { id: 'buy_rifle',    kind: 'wallbuy', x: 26,  z: -19.3, rot: 0,       weapon: 'rifle',    cost: 1600 },
      { id: 'buy_smg',      kind: 'wallbuy', x: 26,  z: 19.3,  rot: Math.PI, weapon: 'smg',      cost: 1000 },
      { id: 'buy_revolver', kind: 'wallbuy', x: -26, z: 19.3,  rot: Math.PI, weapon: 'revolver', cost: 900 },

      // Ammo crate sits in the plaza itself: always reachable, always the
      // fallback when the horde has pushed you off everything else.
      { id: 'buy_ammo',     kind: 'ammo',    x: 0,   z: -10.5, rot: 0,       cost: 750 },

      { id: 'perk_jugg',    kind: 'perk', perk: 'juggernaut', x: -30, z: 6,  rot: 0,           cost: 2500 },
      { id: 'perk_speed',   kind: 'perk', perk: 'sprinter',   x: 30,  z: -6, rot: Math.PI,     cost: 2000 },
      { id: 'perk_rapid',   kind: 'perk', perk: 'doubletap',  x: 6,   z: 30, rot: -Math.PI / 2, cost: 3000 },
      { id: 'perk_hands',   kind: 'perk', perk: 'quickhands', x: -6,  z: -30, rot: Math.PI / 2, cost: 2200 },

      { id: 'pack', kind: 'pack', x: -36, z: 36, rot: -Math.PI / 4, cost: 5000, minWave: 8 },

      { id: 'box_a', kind: 'box', x: -36, z: -36, rot: Math.PI / 4, cost: 950 },
      { id: 'box_b', kind: 'box', x: 36,  z: 36,  rot: -Math.PI * 0.75, cost: 950 },
      { id: 'box_c', kind: 'box', x: 36,  z: -36, rot: Math.PI * 0.75, cost: 950 },
    ];

    for (const d of defs) {
      // Physical cabinet so the station is a real object in the world.
      if (d.kind === 'perk') {
        this.box('paintedMetal', d.x, 0, d.z, 1.1, 2.0, 0.8, { rotY: d.rot, tag: 'prop' });
        this.box('neonCyan', d.x + Math.cos(d.rot) * 0.45, 1.15, d.z + Math.sin(d.rot) * 0.45,
          0.75, 0.5, 0.06, { rotY: d.rot, collide: false });
        this.fixtures.push({
          pos: new THREE.Vector3(d.x, 1.6, d.z), color: PERK_LIGHT[d.perk] || 0x40e0ff,
          intensity: 16, range: 9, flicker: 0.08, kind: 'perk',
        });
      } else if (d.kind === 'pack') {
        // A jury-rigged machine: cabinet, glowing intake, and a lot of cabling.
        this.box('paintedMetal', d.x, 0, d.z, 1.8, 2.3, 1.2, { rotY: d.rot, tag: 'prop' });
        this.box('rust', d.x, 2.3, d.z, 2.0, 0.25, 1.4, { rotY: d.rot, collide: false });
        this.box('neonRed', d.x + Math.cos(d.rot) * 0.65, 1.35, d.z + Math.sin(d.rot) * 0.65,
          1.0, 0.7, 0.06, { rotY: d.rot, collide: false });
        this.cylinder('steel', d.x - Math.cos(d.rot) * 0.9, 0, d.z - Math.sin(d.rot) * 0.9,
          0.22, 0.26, 1.9, { seg: 10 });
        this.fixtures.push({
          pos: new THREE.Vector3(d.x, 1.9, d.z), color: 0xff5522,
          intensity: 22, range: 11, flicker: 0.35, kind: 'perk',
        });
        this.decorTargets.push({ pos: new THREE.Vector3(d.x, 2.4, d.z), kind: 'fire', scale: 0.5 });
      } else if (d.kind === 'box') {
        this.box('wood', d.x, 0, d.z, 1.7, 1.0, 1.1, { rotY: d.rot, tag: 'prop' });
        this.box('rust', d.x, 1.0, d.z, 1.75, 0.12, 1.15, { rotY: d.rot, collide: false });
      } else if (d.kind === 'ammo') {
        // A crate of loose ammunition, open, with a lamp clamped to the lid.
        this.box('wood', d.x, 0, d.z, 1.5, 0.85, 1.0, { rotY: d.rot, tag: 'prop' });
        this.box('rust', d.x, 0.85, d.z, 1.6, 0.1, 1.1, { rotY: d.rot, collide: false });
        this.box('brass', d.x, 0.95, d.z, 1.1, 0.14, 0.7, { rotY: d.rot, collide: false });
        this.box('neonGreen', d.x, 1.15, d.z, 0.5, 0.16, 0.05, { rotY: d.rot, collide: false });
        this.fixtures.push({
          pos: new THREE.Vector3(d.x, 1.3, d.z), color: 0x60ff90,
          intensity: 12, range: 8, flicker: 0.05, kind: 'buy',
        });
      } else {
        // Wall-buys: a chalk outline on the brick with the weapon racked on it.
        this.box('plank', d.x, 1.05, d.z, 1.5, 0.06, 0.10, { rotY: d.rot, collide: false });
        this.box('gunmetal', d.x, 1.18, d.z, 1.15, 0.10, 0.12, { rotY: d.rot, collide: false });
        this.box('gunPolymer', d.x, 1.30, d.z, 0.55, 0.22, 0.10, { rotY: d.rot, collide: false });
        this.box('neonGreen', d.x, 1.62, d.z, 1.3, 0.42, 0.05, { rotY: d.rot, collide: false });
        this.fixtures.push({
          pos: new THREE.Vector3(
            d.x + Math.sin(d.rot) * 0.6, 1.8, d.z + Math.cos(d.rot) * 0.6,
          ),
          color: 0x60ff90, intensity: 12, range: 8, flicker: 0.05, kind: 'buy',
        });
      }

      this.stations.push({
        ...d,
        pos: new THREE.Vector3(d.x, 1.1, d.z),
        active: d.kind !== 'box' || d.id === 'box_a',
      });
    }
  }

  // -------------------------------------------------------------- finalize

  /**
   * Baked light pools.
   *
   * There are ~100 emissive fixtures in the level but only a handful of real
   * point lights in the budget, so distant street lamps used to look switched
   * off. Each lamp and fire also gets an additive ground disc merged into a
   * single mesh: one draw call for the whole map, visible from anywhere, and it
   * gives the real lights something to blend into instead of popping in.
   */
  _buildLightPools() {
    // A generated radial falloff rather than the sprite texture: circle.png has
    // a broad plateau, so overlapping pools summed to a flat white sheet.
    const tex = radialFalloffTexture(128, 3.0);

    const geos = [];
    // Weighted right down from the night build: an additive disc on the ground
    // was how a lamp announced itself across a dark street, and in sunlight the
    // same disc is a white sheet. Only the fires and the stations keep one, and
    // only enough to say "something is glowing here".
    const WEIGHT = { street: 0, fire: 0.22, perk: 0, buy: 0, window: 0 };

    for (const f of this.fixtures) {
      const w = WEIGHT[f.kind] ?? 0;
      if (w <= 0) continue;

      // Kept deliberately tight: these overlap along a street, and additive
      // discs that each look reasonable alone will sum to white together.
      const radius = f.range * (f.kind === 'fire' ? 0.26 : 0.32);
      const g = new THREE.PlaneGeometry(radius * 2, radius * 2, 1, 1);
      g.rotateX(-Math.PI / 2);
      g.translate(f.pos.x, 0.035, f.pos.z);

      const c = new THREE.Color(f.color);
      // Pools sit on the floor, so they read brighter than the source; scale
      // down and bias toward the lamp's hue rather than its raw intensity.
      const k = w * 0.11;
      const colors = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < g.attributes.position.count; i++) {
        colors[i * 3] = c.r * k;
        colors[i * 3 + 1] = c.g * k;
        colors[i * 3 + 2] = c.b * k;
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geos.push(g);
    }

    if (!geos.length) return;
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) return;

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
      toneMapped: true,
    });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = 'level:lightPools';
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    this.meshes.push(mesh);
    this.lightPoolMesh = mesh;
  }

  _finalize() {
    // One extra material that only exists for windows: a dark, near-smooth
    // pane that is almost entirely what it reflects. Under a sky this is what
    // gives a flat facade its depth.
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x0b0e13, roughness: 0.09, metalness: 0.40,
      envMapIntensity: 2.6, side: THREE.DoubleSide,
    });

    for (const [key, geos] of this.batches) {
      if (!geos.length) continue;
      let material;
      if (key === 'windowDark') material = darkMat;
      else material = this.mats.get(key);
      if (!material) continue;

      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      merged.computeBoundingSphere();

      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `level:${key}`;
      mesh.castShadow = key !== 'asphalt' && key !== 'wetAsphalt' && key !== 'dirt'
        && key !== 'windowDark' && key !== 'tile';
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      this.meshes.push(mesh);

      for (const g of geos) g.dispose();
    }
    this.batches.clear();
  }

  /**
   * A small pool of real point lights is re-assigned every frame to whichever
   * fixtures are closest to the player. There can be 80 light sources in the
   * level and still only `dynamicLights` of them costing anything.
   */
  _buildLightPool() {
    const n = this.preset.dynamicLights;
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;
      l.visible = false;
      this.scene.add(l);
      this._lightPool.push({ light: l, fixture: null, phase: Math.random() * TAU });
    }
  }

  setLightBudget(n) {
    while (this._lightPool.length > n) {
      const e = this._lightPool.pop();
      this.scene.remove(e.light);
      e.light.dispose();
    }
    while (this._lightPool.length < n) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.visible = false;
      this.scene.add(l);
      this._lightPool.push({ light: l, fixture: null, phase: Math.random() * TAU });
    }
  }

  update(dt, playerPos, elapsed) {
    this._flickerT += dt;

    // Rank fixtures by squared distance, take the nearest few.
    const pool = this._lightPool;
    if (!pool.length) return;

    const fx = this.fixtures;
    const scored = this._scored || (this._scored = []);
    scored.length = 0;
    for (let i = 0; i < fx.length; i++) {
      const f = fx[i];
      const dx = f.pos.x - playerPos.x, dz = f.pos.z - playerPos.z, dy = f.pos.y - playerPos.y;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > f.range * f.range * 2.2) continue;
      // Divide by importance so a distant burning barrel still outranks a lit
      // window three metres away.
      scored.push({ f, d2: d2 / (FIXTURE_PRIORITY[f.kind] || 1) });
    }
    scored.sort((a, b) => a.d2 - b.d2);

    for (let i = 0; i < pool.length; i++) {
      const slot = pool[i];
      const entry = scored[i];
      if (!entry) { slot.light.visible = false; slot.fixture = null; continue; }
      const f = entry.f;
      slot.fixture = f;
      const l = slot.light;
      l.visible = true;
      l.position.copy(f.pos);
      l.color.setHex(f.color);
      l.distance = f.range;

      // Flicker: two detuned sines plus a rare dropout, which reads as a failing
      // ballast rather than a sine wave.
      let flick = 1;
      if (f.flicker > 0.01) {
        const t = elapsed * (f.kind === 'fire' ? 9 : 3.4) + slot.phase;
        flick = 1 - f.flicker * (0.5 + 0.5 * Math.sin(t)) * (0.6 + 0.4 * Math.sin(t * 2.37));
        if (f.flicker > 0.4 && Math.sin(t * 0.71 + slot.phase) > 0.985) flick *= 0.15;
      }
      // Daylight scale. These intensities were tuned as the only light in a
      // dark street; against a sun they only have to say "this machine has
      // power". Fires keep most of theirs — a fire is genuinely bright.
      l.intensity = f.intensity * flick * (f.kind === 'fire' ? 0.55 : 0.20);
    }
  }

  /** Nearest interactable station within `range`, or null. */
  stationNear(pos, range = 2.6) {
    let best = null, bestD = range * range;
    for (const s of this.stations) {
      if (!s.active) continue;
      const dx = s.pos.x - pos.x, dz = s.pos.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; best = s; }
    }
    return best;
  }

  /** Picks a spawn point that is far enough away and out of the player's view. */
  pickSpawn(playerPos, forward, minDist = 16, rng = Math.random) {
    const pts = this.spawnPoints;
    if (!pts.length) return null;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i + ((rng() * pts.length) | 0)) % pts.length];
      const dx = p.x - playerPos.x, dz = p.z - playerPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < minDist) continue;
      if (!this.flow.reachable(p.x, p.z)) continue;
      // Prefer behind the player, and prefer closer among those.
      const dot = dist > 0 ? (dx / dist) * forward.x + (dz / dist) * forward.z : 0;
      const score = -dot * 3 - dist * 0.05 + rng() * 0.8;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best || pts[(rng() * pts.length) | 0];
  }

  dispose() {
    this.props.dispose();
    for (const m of this.meshes) { m.geometry.dispose(); }
    this.scene.remove(this.root);
    for (const e of this._lightPool) { this.scene.remove(e.light); e.light.dispose(); }
    this._lightPool.length = 0;
  }
}

// ------------------------------------------------------------------ tables

const QUADRANTS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

// Higher means "worth a real light slot from further away".
const FIXTURE_PRIORITY = { fire: 9, street: 6, perk: 2.2, buy: 1.6, window: 0.35 };

const PERK_LIGHT = {
  juggernaut: 0xff4444,
  sprinter: 0x44ff88,
  doubletap: 0xffaa22,
  quickhands: 0x66aaff,
};

const STREETLIGHTS = [
  [-6, -20, 0], [6, -34, Math.PI], [-6, -46, 0],
  [6, 20, Math.PI], [-6, 34, 0], [6, 46, Math.PI],
  [-20, 6, -Math.PI / 2], [-34, -6, Math.PI / 2], [-46, 6, -Math.PI / 2],
  [20, -6, Math.PI / 2], [34, 6, -Math.PI / 2], [46, -6, Math.PI / 2],
  [-16, -16, Math.PI / 4], [16, 16, -Math.PI * 0.75],
];

const BARRELS = [
  [-14, -14], [15, -13], [-13, 16], [16, 15],
  [-40, 2], [40, -2], [2, -40], [-2, 40],
  [-26, -38], [27, 38],
];

const BARRICADES = [
  [0, -17, 0], [0, 17, 0], [-17, 0, Math.PI / 2], [17, 0, Math.PI / 2],
];

const FENCES = [
  [-24, -2, 12, Math.PI / 2],
  [24, 2, 12, Math.PI / 2],
  [-2, 24, 12, 0],
  [2, -24, 12, 0],
];

/**
 * A soft radial gradient, used for the ground light pools. `power` controls how
 * fast it falls off — 3.0 keeps the bright core small so several pools can
 * overlap along a street without summing to white.
 */
function radialFalloffTexture(size = 128, power = 3.0) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / c;
      const a = r >= 1 ? 0 : Math.pow(1 - r, power);
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Rewrites a BoxGeometry's UVs so every face has the same texel density,
 * expressed in metres per texture tile. Without this a 30 m wall and a 1 m crate
 * sharing a material would show wildly different brick sizes.
 */
function scaleBoxUVs(geo, w, h, d, tile) {
  const uv = geo.attributes.uv;
  const spans = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = spans[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * (su / tile), uv.getY(k) * (sv / tile));
    }
  }
  uv.needsUpdate = true;
  return geo;
}
