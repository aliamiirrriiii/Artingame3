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
  stone: 2.4, canvas: 1.6, roadPaint: 3,
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

  /**
   * Standing water.
   *
   * A puddle has a hard edge — water does — but it does not have a
   * *rectangular* one, and four fourteen-metre squares of wet asphalt is what
   * this level had. In the dark that read as reflection; in daylight it reads
   * as four pale slabs someone left in the road. This is an irregular disc
   * instead: a fan whose rim wanders on two out-of-phase sine terms seeded off
   * the puddle's own position, so no two are the same shape and none of them
   * is a circle either.
   */
  puddle(matKey, x, z, r, opts = {}) {
    const { y = 0.015, seg = 32, wobble = 0.22 } = opts;
    const tile = TILE_METERS[matKey] || 3;
    const g = new THREE.CircleGeometry(r, seg);
    const pos = g.attributes.position;
    // Vertex 0 is the centre; the rim follows, and its last vertex coincides
    // with its first — which is why the wobble has to be a continuous
    // function of the angle rather than per-vertex noise.
    for (let i = 1; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i);
      const a = Math.atan2(vy, vx);
      const k = 1 + wobble * 0.5 * (Math.sin(a * 3 + x * 0.7) + Math.sin(a * 5 + z * 0.9));
      pos.setXY(i, vx * k, vy * k);
    }
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (pos.getX(i) + x) / tile, (pos.getY(i) + z) / tile);
    }
    uv.needsUpdate = true;
    g.rotateX(-Math.PI / 2);
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
    this._buildClutter();
    this._buildOvergrowth();
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

    // Standing water where the drains backed up. Smaller than the night build
    // wanted: at seven metres across these are ponds, and in daylight a pond
    // in the road is a thing you notice rather than a thing you walk over.
    for (const [px, pz, pr] of [[-14, 22, 4.2], [19, -12, 3.4], [0, 38, 5.2], [-30, -26, 3.0]]) {
      this.puddle('wetAsphalt', px, pz, pr, { y: 0.015 });
    }

    this._buildStreets();
  }

  /**
   * What makes a road a road.
   *
   * A sidewalk that is only a raised quad has no edge: it floats twelve
   * centimetres above the asphalt with a hairline where the two meet, and the
   * eye reads it as a lighter patch of the same surface. A kerb is the single
   * cheapest piece of geometry in a city scene and does more for it than any
   * texture — it gives every street a hard line running the length of it, and
   * a shadow under that line all afternoon.
   */
  _buildStreets() {
    const detail = this.preset.worldDetail ?? 2;
    const r = this.rng;

    // Kerbs around each sidewalk block, with the gutter channel outside them.
    for (const [sx, sz] of QUADRANTS) {
      const cx = sx * 34, cz = sz * 34, half = 15;
      for (const [nx, nz] of FACES) {
        const along = 30 + 0.7;
        const px = cx + nx * half, pz = cz + nz * half;
        const bw = nx !== 0 ? 0.35 : along;
        const bd = nx !== 0 ? along : 0.35;
        // Kerbstone: the face of it, standing up out of the road.
        this.box('stone', px, 0, pz, bw, 0.155, bd, { collide: false });
        // Gutter: a strip of darker, dirtier surface right against the kerb,
        // which is where every city street is filthiest.
        const gw = nx !== 0 ? 0.55 : along;
        const gd = nx !== 0 ? along : 0.55;
        this.ground('wetAsphalt', px + nx * 0.45, pz + nz * 0.45, gw, gd, { y: 0.006 });
      }

      if (detail >= 1) {
        // Expansion joints across the flags, both ways.
        for (let i = -5; i <= 5; i++) {
          this.box('asphalt', cx + i * 2.6, 0.118, cz, 0.06, 0.02, 30, { collide: false });
          this.box('asphalt', cx, 0.118, cz + i * 2.6, 30, 0.02, 0.06, { collide: false });
        }
      }
    }

    // Centre lines down both street spokes, broken where the plaza starts.
    for (const axis of [0, 1]) {
      for (let t = -46; t <= 46; t += 3.4) {
        if (Math.abs(t) < 14) continue;
        const px = axis === 0 ? 0 : t;
        const pz = axis === 0 ? t : 0;
        const bw = axis === 0 ? 0.16 : 1.9;
        const bd = axis === 0 ? 1.9 : 0.16;
        this.box('roadPaint', px, 0.004, pz, bw, 0.012, bd, { collide: false });
      }
    }

    // Crossings on the four approaches to the plaza.
    for (const [ax, az] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const base = 16.5;
      for (let i = -3; i <= 3; i++) {
        const off = i * 1.15;
        const px = ax !== 0 ? ax * base : off;
        const pz = az !== 0 ? az * base : off;
        const bw = ax !== 0 ? 3.6 : 0.55;
        const bd = ax !== 0 ? 0.55 : 3.6;
        this.box('roadPaint', px, 0.004, pz, bw, 0.012, bd, { collide: false });
      }
    }

    if (detail < 1) return;

    // Ironwork in the road: manholes on the crown, gully gratings at the kerb.
    for (const [mx, mz] of [[0, 24], [0, -21], [26, 0], [-23, 0], [12, 12], [-11, -13]]) {
      this.cylinder('rust', mx, 0.004, mz, 0.42, 0.42, 0.02, { seg: 14 });
      this.cylinder('steel', mx, 0.006, mz, 0.34, 0.34, 0.02, { seg: 14 });
    }
    for (const [sx, sz] of QUADRANTS) {
      for (let k = -1; k <= 1; k += 2) {
        this.box('rust', sx * 34 + k * 9, 0.004, sz * (34 - 15.4), 0.75, 0.03, 0.35,
          { collide: false });
        this.box('rust', sx * (34 - 15.4), 0.004, sz * 34 + k * 9, 0.35, 0.03, 0.75,
          { collide: false });
      }
    }

    if (detail < 2) return;

    // Tarmac patches: the road has been dug up and filled in a dozen times,
    // and the seams are one of the things that reads as "real place" without
    // anyone consciously noticing them.
    for (let i = 0; i < 14; i++) {
      const px = r.range(-44, 44), pz = r.range(-44, 44);
      if (Math.hypot(px, pz) < 13) continue;
      if (this._occupied(px, pz, 1.4)) continue;
      const w = r.range(2.2, 6.5), d = r.range(1.6, 4.5);
      this.ground('wetAsphalt', px, pz, w, d, { y: 0.003, rotY: r.range(0, TAU) });
    }
  }

  /**
   * The ring wall that seals the block.
   *
   * It is the single largest thing in most frames — nine metres tall and a
   * hundred long on every side — so a plain slab of brick behind everything
   * flattens the whole picture. It gets the same treatment as the buildings:
   * a base course, piers, a capping band, blind window bays between the piers,
   * and enough shadow-casting relief that the sun rakes across it in the
   * afternoon instead of lighting it evenly like a backdrop.
   */
  _buildPerimeter() {
    const H = ARENA_HALF;
    const wallH = 9;
    // Solid outer shell with no gaps: the block is sealed.
    this.box('brick', 0, 0, -H, H * 2 + 4, wallH, 4, { tag: 'wall' });
    this.box('brick', 0, 0, H, H * 2 + 4, wallH, 4, { tag: 'wall' });
    this.box('brick', -H, 0, 0, 4, wallH, H * 2 + 4, { tag: 'wall' });
    this.box('brick', H, 0, 0, 4, wallH, H * 2 + 4, { tag: 'wall' });

    const detail = this.preset.worldDetail ?? 2;
    const r = this.rng;
    const runs = [
      { nx: 0, nz: 1, ox: 0, oz: -H + 2 },   // north wall, inward face
      { nx: 0, nz: -1, ox: 0, oz: H - 2 },
      { nx: 1, nz: 0, ox: -H + 2, oz: 0 },
      { nx: -1, nz: 0, ox: H - 2, oz: 0 },
    ];

    for (const run of runs) {
      const face = {
        nx: run.nx, nz: run.nz, ox: run.ox, oz: run.oz,
        tx: run.nx !== 0 ? 0 : 1, tz: run.nx !== 0 ? 1 : 0,
        width: H * 2, toPlaza: true,
      };

      // Base course and capping, the full length of the run.
      this._faceBox('stone', face, 0, 0, 0.20, H * 2, 0.75, 0.40);
      this._faceBox('stone', face, 0, wallH - 0.75, 0.26, H * 2, 0.42, 0.52);
      this._faceBox('concrete', face, 0, wallH - 0.33, 0.16, H * 2, 0.34, 0.32);

      for (let i = -4; i <= 4; i++) {
        const u = i * 11;
        // Pier, standing proud of the wall its whole height.
        this._faceBox('concrete', face, u, 0, 0.6, 1.7, wallH - 0.6, 1.2, { tag: 'wall', collide: true });
        this._faceBox('stone', face, u, wallH - 1.15, 0.75, 2.1, 0.40, 1.5);

        if (detail < 1 || i === 4) continue;

        // Blind bays between the piers: a recessed panel with an arch head,
        // which is what a warehouse wall of this period actually looks like
        // and what gives the run its rhythm at distance.
        const mid = u + 5.5;
        this._faceBox('stone', face, mid, 1.1, 0.30, 5.6, 0.26, 0.60);
        this._faceBox('stone', face, mid, 6.4, 0.30, 5.6, 0.34, 0.60);
        this._faceBox('stone', face, mid - 2.6, 1.36, 0.28, 0.40, 5.05, 0.56);
        this._faceBox('stone', face, mid + 2.6, 1.36, 0.28, 0.40, 5.05, 0.56);

        if (detail >= 2 && r.next() < 0.45) {
          // Some of them are real openings, boarded over.
          for (let k = 0; k < 5; k++) {
            this._faceBox('plank', face, mid, 2.2 + k * 0.75, 0.34,
              4.6, 0.55, 0.10, { rotY: 0 });
          }
        }
      }
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

  /**
   * One building.
   *
   * The shell is still a box — it has to be, because the collision world is
   * boxes and a zombie has to be able to path around it. Everything that makes
   * it read as a building is dressing hung on the outside of that box: a base
   * course, a shopfront at street level, sills and lintels and jambs standing
   * proud of every window, a string course at each floor line, a cornice under
   * the parapet, and the pipework and plant that real buildings are covered in
   * and game buildings almost never are.
   *
   * None of it collides. The player's silhouette against the wall is the box;
   * the trim is 20 cm deep and would only ever catch them on a corner.
   */
  _building(x, z, w, d, h) {
    const r = this.rng;
    const detail = this.preset.worldDetail ?? 2;
    const brick = r.next() < 0.55;
    const wallMat = brick ? 'brick' : 'plaster';

    this.box(wallMat, x, 0, z, w, h, d, { tag: 'wall' });

    // Base course: a plinth the whole building stands on, so the wall does not
    // simply meet the pavement at a line.
    this.box('stone', x, 0, z, w + 0.34, 0.55, d + 0.34, { tag: 'wall' });
    this.box('stone', x, 0.55, z, w + 0.22, 0.16, d + 0.22, { collide: false });

    // Cornice and coping. Two bands rather than one: the wider one throws the
    // shadow that separates the building from the sky, the narrow one on top
    // is the stone cap that keeps the rain out of the brickwork.
    this.box('stone', x, h - 0.55, z, w + 0.62, 0.42, d + 0.62, { collide: false });
    this.box('stone', x, h - 0.13, z, w + 0.40, 0.30, d + 0.40, { collide: false });
    this.box('concrete', x, h + 0.17, z, w + 0.10, 0.50, d + 0.10, { collide: false });
    this.box('rust', x, h + 0.02, z, w - 0.6, 0.16, d - 0.6, { collide: false });

    const shopH = 3.5;
    const floorH = 3.2;
    const floors = Math.max(1, Math.floor((h - shopH - 1.4) / floorH));

    for (const [nx, nz] of FACES) {
      const face = {
        nx, nz,
        // Face centre, and the tangent that runs along it.
        ox: x + nx * (w / 2), oz: z + nz * (d / 2),
        tx: nx !== 0 ? 0 : 1, tz: nx !== 0 ? 1 : 0,
        width: nx !== 0 ? d : w,
        // Which way the plaza is: the side a player actually walks past.
        toPlaza: (nx !== 0 && Math.sign(nx) !== Math.sign(x))
          || (nz !== 0 && Math.sign(nz) !== Math.sign(z)),
      };
      this._facade(face, h, shopH, floorH, floors, detail);
    }

    if (detail >= 1) this._rooftop(x, z, w, d, h);
  }

  /** A box positioned in a facade's own frame: `u` along it, `v` out of it. */
  _faceBox(matKey, face, u, y, v, along, height, out, opts = {}) {
    const px = face.ox + face.tx * u + face.nx * v;
    const pz = face.oz + face.tz * u + face.nz * v;
    const bw = face.nx !== 0 ? out : along;
    const bd = face.nx !== 0 ? along : out;
    return this.box(matKey, px, y, pz, bw, height, bd, { collide: false, ...opts });
  }

  _facade(face, h, shopH, floorH, floors, detail) {
    const r = this.rng;
    const fw = face.width;
    const bays = Math.max(2, Math.round(fw / 3.3));
    const bayW = fw / bays;
    const half = fw / 2;

    // ------------------------------------------------------------ shopfront
    //
    // The ground floor is where the player's eye actually is, so it gets the
    // most: recessed glazing between stone pilasters, a stall riser under it,
    // a fascia board over it, and an awning on some of them.
    for (let b = 0; b < bays; b++) {
      const u = -half + (b + 0.5) * bayW;
      const openW = bayW - 0.7;

      this._faceBox('plank', face, u, 0.55, 0.10, openW, 0.62, 0.16);
      const shuttered = r.next() < 0.22;
      if (shuttered) {
        this._faceBox('rust', face, u, 1.17, 0.13, openW, 1.75, 0.10);
      } else if (face.toPlaza && r.next() < 0.55) {
        // The one place a real broken-window model is worth its draw call.
        this.windowPlacements.push({
          x: face.ox + face.tx * u + face.nx * 0.10,
          z: face.oz + face.tz * u + face.nz * 0.10,
          y: 1.30,
          rotY: Math.atan2(face.nx, face.nz),
        });
      } else {
        this._pane(face, u, 1.17, openW, 1.75, 2, 1);
      }

      if (detail >= 1 && !shuttered && r.next() < 0.35) {
        // Awning: a flat canopy on two brackets. Flat rather than sloped
        // because the batcher only carries a yaw, and at eye level from below
        // the difference is a shadow nobody reads.
        this._faceBox('canvas', face, u, 2.95, 0.55, openW + 0.35, 0.07, 1.05);
        this._faceBox('steel', face, u - openW * 0.4, 2.98, 0.30, 0.05, 0.30, 0.55);
        this._faceBox('steel', face, u + openW * 0.4, 2.98, 0.30, 0.05, 0.30, 0.55);
      }
    }

    // Pilasters between the bays, and one at each end.
    for (let b = 0; b <= bays; b++) {
      const u = -half + b * bayW;
      this._faceBox('stone', face, u, 0.55, 0.14, 0.42, shopH - 0.55, 0.24);
    }
    // Fascia over the whole shopfront, and the transom under it.
    this._faceBox('plank', face, 0, shopH - 0.62, 0.16, fw, 0.62, 0.26);
    this._faceBox('stone', face, 0, shopH, 0.20, fw + 0.30, 0.26, 0.32);

    // ---------------------------------------------------------- upper floors
    for (let f = 0; f < floors; f++) {
      const fy = shopH + 0.26 + f * floorH;
      if (fy + 2.1 > h - 0.9) break;

      // String course: the horizontal that gives a facade its storeys.
      this._faceBox('stone', face, 0, fy - 0.16, 0.08, fw, 0.16, 0.20);

      for (let b = 0; b < bays; b++) {
        const u = -half + (b + 0.5) * bayW;
        const ww = Math.min(1.55, bayW - 1.1);
        this._window(face, u, fy + 0.55, ww, 1.75, detail);

        // Plant hanging off the wall, because every building of this vintage
        // has had air conditioning bolted to it since.
        if (detail >= 1 && f > 0 && r.next() < 0.10) {
          this._faceBox('paintedMetal', face, u, fy + 0.30, 0.28, 0.72, 0.46, 0.42);
          this._faceBox('steel', face, u, fy + 0.24, 0.26, 0.80, 0.07, 0.46);
        }
      }
    }

    // ----------------------------------------------------------- ironmongery
    if (detail >= 1) {
      // Downpipe at one end of the face, with the hopper head at the top.
      const side = r.next() < 0.5 ? -1 : 1;
      const u = side * (half - 0.35);
      this.cylinder('rust',
        face.ox + face.tx * u + face.nx * 0.16,
        0, face.oz + face.tz * u + face.nz * 0.16,
        0.075, 0.075, h - 0.7, { seg: 6 });
      this._faceBox('rust', face, u, h - 1.0, 0.16, 0.30, 0.30, 0.30);
      // Brackets, so the pipe is fixed to something.
      for (let y = 1.6; y < h - 1.2; y += 2.4) {
        this._faceBox('rust', face, u, y, 0.09, 0.16, 0.07, 0.20);
      }
    }

    if (detail >= 2 && face.toPlaza && floors >= 2 && r.next() < 0.45) {
      this._fireEscape(face, shopH + 0.26, floorH, Math.min(floors, 4));
    }
  }

  /** One window: pane, jambs, sill and lintel, all standing off the wall. */
  _window(face, u, y, ww, wh, detail) {
    this._pane(face, u, y, ww, wh, 2, 2);
    // Jambs either side, deeper than the pane, so the opening reads as cut in.
    this._faceBox('stone', face, u - ww / 2 - 0.09, y, 0.09, 0.18, wh, 0.20);
    this._faceBox('stone', face, u + ww / 2 + 0.09, y, 0.09, 0.18, wh, 0.20);
    // Sill: the deepest thing on the facade, and the one that throws the
    // shadow that says "there is a hole here".
    this._faceBox('stone', face, u, y - 0.13, 0.13, ww + 0.52, 0.14, 0.28);
    // Lintel over the top.
    this._faceBox('stone', face, u, y + wh, 0.11, ww + 0.44, 0.18, 0.24);
    if (detail >= 2 && this.rng.next() < 0.18) {
      // A blind left half down behind the glass.
      this._faceBox('plank', face, u, y + wh * 0.55, 0.03,
        ww - 0.06, wh * 0.45, 0.03);
    }
  }

  /**
   * Glazing, as a grid of small panes with the wall showing between them.
   *
   * Cheaper than a pane plus separate glazing bars — the gaps *are* the bars —
   * and it means a window is never one flat rectangle of reflection, which is
   * what made the old facades read as stickers.
   */
  _pane(face, u, y, ww, wh, cols, rows) {
    const bar = 0.055;
    const pw = (ww - bar * (cols - 1)) / cols;
    const ph = (wh - bar * (rows - 1)) / rows;
    for (let c = 0; c < cols; c++) {
      for (let rr = 0; rr < rows; rr++) {
        const pu = u - ww / 2 + pw / 2 + c * (pw + bar);
        const py = y + ph / 2 + rr * (ph + bar);
        const px = face.ox + face.tx * pu + face.nx * 0.03;
        const pz = face.oz + face.tz * pu + face.nz * 0.03;
        const g = new THREE.PlaneGeometry(pw, ph);
        g.rotateY(Math.atan2(face.nx, face.nz));
        g.translate(px, py, pz);
        this._batch('windowDark').push(g);
      }
    }
  }

  /** Landings, railings and a ladder down the front of a building. */
  _fireEscape(face, y0, floorH, flights) {
    const w = Math.min(face.width * 0.45, 3.0);
    for (let f = 0; f < flights; f++) {
      const y = y0 + f * floorH + 0.6;
      this._faceBox('steel', face, 0, y, 0.75, w, 0.06, 1.35);
      // Railings: two rails and the posts between them.
      this._faceBox('steel', face, 0, y + 1.0, 1.40, w, 0.05, 0.05);
      this._faceBox('steel', face, 0, y + 0.5, 1.40, w, 0.04, 0.04);
      for (let i = -1; i <= 1; i++) {
        this._faceBox('steel', face, i * w * 0.45, y, 1.40, 0.05, 1.05, 0.05);
      }
      // The ladder up to the next landing.
      if (f < flights - 1) {
        for (const s of [-1, 1]) {
          this._faceBox('steel', face, w * 0.3 + s * 0.22, y, 1.05, 0.045, floorH, 0.045);
        }
        for (let k = 1; k < 7; k++) {
          this._faceBox('steel', face, w * 0.3, y + k * (floorH / 7), 1.05, 0.44, 0.035, 0.035);
        }
      }
    }
  }

  /** What is actually on a city roof: the stair head, a tank, and vents. */
  _rooftop(x, z, w, d, h) {
    const r = this.rng;
    const top = h + 0.42;
    this.box('brick', x + r.range(-w * 0.2, w * 0.2), top, z + r.range(-d * 0.2, d * 0.2),
      2.4, 2.3, 2.0, { collide: false });

    if (r.next() < 0.55) {
      // Water tank on legs.
      const tx = x + r.range(-w * 0.25, w * 0.25);
      const tz = z + r.range(-d * 0.25, d * 0.25);
      for (const [ax, az] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        this.cylinder('rust', tx + ax * 0.75, top, tz + az * 0.75, 0.09, 0.09, 1.5, { seg: 5 });
      }
      this.cylinder('wood', tx, top + 1.5, tz, 1.15, 1.05, 2.1, { seg: 12 });
      this.cylinder('rust', tx, top + 3.5, tz, 1.22, 1.22, 0.14, { seg: 12 });
    }

    for (let i = 0; i < r.int(2, 4); i++) {
      const vx = x + r.range(-w * 0.35, w * 0.35);
      const vz = z + r.range(-d * 0.35, d * 0.35);
      this.cylinder('steel', vx, top, vz, 0.22, 0.26, r.range(0.6, 1.4), { seg: 8 });
      this.cylinder('rust', vx, top + 1.3, vz, 0.30, 0.30, 0.10, { seg: 8 });
    }

    // An aerial, for the silhouette.
    if (r.next() < 0.5) {
      const ax = x + r.range(-w * 0.3, w * 0.3);
      const az = z + r.range(-d * 0.3, d * 0.3);
      this.cylinder('steel', ax, top, az, 0.035, 0.05, r.range(2.5, 4.5), { seg: 4 });
    }
  }

  /**
   * The plaza.
   *
   * Everything here is at the dead centre of the map and every fight ends up
   * looking at it, so it is worth more geometry than anywhere else. The
   * fountain was two cylinders and a box, which from ten metres reads as a
   * traffic cone on a bollard; it is now a basin with a coping you can see
   * the thickness of, a moulded pedestal, an upper dish, and a figure on top
   * with enough of a silhouette to be a statue rather than a lump.
   */
  _buildPlaza() {
    const detail = this.preset.worldDetail ?? 2;
    const r = this.rng;

    if (detail >= 1) {
      // Paving joints across the apron, so the plaza floor is flags rather
      // than a single poured sheet twenty-six metres across.
      for (let i = -6; i <= 6; i++) {
        this.box('asphalt', i * 2.1, 0.058, 0, 0.05, 0.02, 26, { collide: false });
        this.box('asphalt', 0, 0.058, i * 2.1, 26, 0.02, 0.05, { collide: false });
      }
    }

    // Basin: wall, coping you can read the thickness of, and the step round it.
    this.cylinder('stone', 0, 0, 0, 5.9, 6.1, 0.22, { seg: 32 });
    this.cylinder('concrete', 0, 0.20, 0, 5.2, 5.55, 0.86, { seg: 32, collide: true, tag: 'cover' });
    this.cylinder('stone', 0, 1.02, 0, 5.35, 5.35, 0.20, { seg: 32 });
    this.cylinder('stone', 0, 1.22, 0, 5.05, 5.20, 0.10, { seg: 32 });

    // What is left in the bottom of it: stagnant water, not a working jet.
    this.cylinder('water', 0, 0.38, 0, 4.9, 4.9, 0.05, { seg: 32 });

    // Pedestal: base, shaft, cap. Three pieces is the whole difference
    // between a column and a pipe.
    this.cylinder('stone', 0, 0.42, 0, 1.35, 1.5, 0.34, { seg: 16, collide: true, tag: 'cover' });
    this.cylinder('stone', 0, 0.76, 0, 0.78, 1.05, 1.95, { seg: 16, collide: true, tag: 'cover' });
    this.cylinder('stone', 0, 2.71, 0, 1.15, 0.92, 0.26, { seg: 16 });
    // The upper dish the water used to fall from.
    this.cylinder('stone', 0, 2.97, 0, 2.0, 1.2, 0.34, { seg: 20 });
    this.cylinder('stone', 0, 3.31, 0, 1.9, 1.9, 0.12, { seg: 20 });

    this._statue(0, 3.43);

    // Planters ringing the plaza — waist-high cover you can shoot over.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.39;
      const px = Math.cos(a) * 11, pz = Math.sin(a) * 11;
      this.box('stone', px, 0, pz, 2.6, 0.72, 2.6, { rotY: a, tag: 'cover' });
      // Coping: the rim you would sit on, and the reason the box reads as a
      // planter and not as a crate.
      this.box('stone', px, 0.72, pz, 2.86, 0.16, 2.86, { rotY: a, collide: false });
      this.ground('dirt', px, pz, 2.35, 2.35, { y: 0.875, rotY: a });
      if (detail >= 1) {
        // Long dead, and full of whatever blew into it since.
        for (let k = 0; k < 7; k++) {
          this._weeds(px + r.range(-0.85, 0.85), pz + r.range(-0.85, 0.85),
            r.range(0.4, 0.85), r.range(0.35, 0.8), 2, 0.88);
        }
        if (r.next() < 0.5) {
          this.cylinder('wood', px + r.range(-0.5, 0.5), 0.88, pz + r.range(-0.5, 0.5),
            0.05, 0.08, r.range(1.1, 1.9), { seg: 5 });
        }
      }
    }

    // Overturned squad car in the middle of the plaza, still burning.
    this._car(-8.5, 6.5, 0.7, true);
    this._car(9, -7.5, -1.9, false);
  }

  /**
   * A weathered bronze figure. Crude up close and correct from anywhere you
   * will actually see it: what makes a statue read at twenty metres is the
   * silhouette — a standing figure with its weight on one leg and one arm
   * out — not the modelling.
   */
  _statue(x, base) {
    const z = 0;
    this.cylinder('rust', x, base, z, 0.62, 0.7, 0.22, { seg: 12 });
    // Legs, one straight and one bent back.
    this.cylinder('rust', x - 0.16, base + 0.22, z, 0.13, 0.17, 1.05, { seg: 8 });
    this.cylinder('rust', x + 0.18, base + 0.22, z + 0.10, 0.12, 0.16, 0.98, { seg: 8 });
    // Torso, tapering, and the coat over it.
    this.cylinder('rust', x, base + 1.20, z, 0.30, 0.24, 0.92, { seg: 10 });
    this.box('rust', x, base + 1.28, z - 0.06, 0.62, 0.80, 0.36, { rotY: 0.2, collide: false });
    // Arms: one down at the side, one raised across the body.
    this.box('rust', x - 0.36, base + 1.24, z, 0.16, 0.80, 0.17, { rotY: 0.15, collide: false });
    this.box('rust', x + 0.40, base + 1.72, z + 0.16, 0.62, 0.15, 0.16, { rotY: -0.5, collide: false });
    // Head and shoulders.
    this.cylinder('rust', x, base + 2.12, z, 0.19, 0.17, 0.30, { seg: 8 });
    this.cylinder('rust', x, base + 2.42, z, 0.05, 0.22, 0.12, { seg: 8 });
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
        // A dumpster, not a rusty box. The lid, the ribs down the sides and
        // the four little castors are what stop it reading as a cube someone
        // painted orange, and they cost about thirty triangles.
        const rot = r.range(0, TAU);
        const cs = Math.cos(rot), sn = Math.sin(rot);
        this.box('rust', x, 0.28, z, 2.4, 1.25, 1.3, { rotY: rot, tag: 'cover' });
        for (let k = -2; k <= 2; k++) {
          this.box('rust', x + cs * k * 0.5, 0.30, z + sn * k * 0.5,
            0.09, 1.18, 1.36, { rotY: rot, collide: false });
        }
        const lidUp = r.next() < 0.4;
        if (lidUp) {
          this.box('paintedMetal', x - cs * 1.16, 1.53, z - sn * 1.16,
            0.10, 1.20, 1.34, { rotY: rot, collide: false });
        } else {
          this.box('paintedMetal', x, 1.53, z, 2.44, 0.10, 1.36,
            { rotY: rot, collide: false });
        }
        for (const [ox, oz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          this.cylinder('gunPolymer',
            x + cs * ox * 0.95 - sn * oz * 0.5, 0,
            z + sn * ox * 0.95 + cs * oz * 0.5,
            0.14, 0.14, 0.28, { seg: 8 });
        }
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
  /**
   * The layer that makes a place look lived in and then abandoned.
   *
   * None of this is gameplay. It is rubble against the kerbs, bins and
   * pallets stacked where someone left them, silt fanning out of the gutters,
   * and — the cheapest and most valuable piece of it — a band of dirt where
   * every wall meets the ground. Nothing says "this building was dropped in
   * here five minutes ago" like a clean line at its base, and nothing fixes
   * it faster than half a metre of muck.
   */
  _buildClutter() {
    const detail = this.preset.worldDetail ?? 2;
    const r = this.rng;

    // Grime at the foot of every wall: the buildings, then the ring wall.
    for (const [sx, sz] of QUADRANTS) {
      const ox = sx * 34, oz = sz * 34;
      for (const [bx, bz, bw, bd] of [
        [ox - sx * 8, oz - sz * 9, 14, 11],
        [ox + sx * 8, oz - sz * 6, 11, 16],
        [ox - sx * 4, oz + sz * 8, 18, 9],
      ]) {
        for (const [nx, nz] of FACES) {
          const along = (nx !== 0 ? bd : bw) + 1.2;
          this.ground('dirt',
            bx + nx * (bw / 2 + 0.42), bz + nz * (bd / 2 + 0.42),
            nx !== 0 ? 1.1 : along, nx !== 0 ? along : 1.1,
            { y: 0.014 });
        }
      }
    }
    const H = ARENA_HALF;
    for (const [nx, nz] of FACES) {
      this.ground('dirt', nx * (H - 2.4), nz * (H - 2.4),
        nx !== 0 ? 1.4 : H * 2, nx !== 0 ? H * 2 : 1.4, { y: 0.014 });
    }

    if (detail < 1) return;

    // Silt fanning out of the gutters where the drains gave up.
    for (let i = 0; i < 18; i++) {
      const a = r.range(0, TAU), rad = r.range(16, 46);
      const px = Math.cos(a) * rad, pz = Math.sin(a) * rad;
      if (this._occupied(px, pz, 1.0)) continue;
      this.puddle('dirt', px, pz, r.range(0.8, 2.4), { y: 0.010, wobble: 0.4 });
    }

    // Rubble: brick and broken slab against the kerbs and walls.
    for (let i = 0; i < 46; i++) {
      const a = r.range(0, TAU), rad = r.range(14, 46);
      const px = Math.cos(a) * rad, pz = Math.sin(a) * rad;
      if (this._occupied(px, pz, 1.2)) continue;
      const n = r.int(3, 7);
      for (let k = 0; k < n; k++) {
        const jx = px + r.range(-0.9, 0.9), jz = pz + r.range(-0.9, 0.9);
        const sz2 = r.range(0.12, 0.42);
        this.box(r.next() < 0.5 ? 'brick' : 'concrete',
          jx, 0, jz, sz2, r.range(0.06, 0.22), sz2 * r.range(0.6, 1.3),
          { rotY: r.range(0, TAU), collide: false });
      }
    }

    // Things people put down and never picked up.
    for (let i = 0; i < 30; i++) {
      const a = r.range(0, TAU), rad = r.range(15, 45);
      const px = Math.cos(a) * rad, pz = Math.sin(a) * rad;
      if (this._occupied(px, pz, 2.0)) continue;
      const rot = r.range(0, TAU);
      const pick = r.next();

      if (pick < 0.22) {
        // Wheelie bin, lid up or down.
        this.box('paintedMetal', px, 0, pz, 0.66, 1.05, 0.72, { rotY: rot, tag: 'cover' });
        this.box('paintedMetal', px, 1.05, pz, 0.70, 0.08, 0.76, { rotY: rot, collide: false });
        this.cylinder('rust', px, 0, pz + 0.3, 0.09, 0.09, 0.18, { seg: 6 });
      } else if (pick < 0.42) {
        // Pallet stack.
        const n = r.int(1, 4);
        for (let k = 0; k < n; k++) {
          this.box('plank', px, k * 0.15, pz, 1.2, 0.12, 1.0,
            { rotY: rot + r.range(-0.12, 0.12), collide: k === 0 });
        }
      } else if (pick < 0.60) {
        // Crates, stacked badly.
        const n = r.int(1, 3);
        for (let k = 0; k < n; k++) {
          const c = r.range(0.55, 0.85);
          this.box('wood', px + r.range(-0.2, 0.2), k * c, pz + r.range(-0.2, 0.2),
            c, c, c, { rotY: rot + r.range(-0.4, 0.4), tag: 'cover' });
        }
      } else if (pick < 0.76) {
        // Tyres.
        for (let k = 0; k < r.int(1, 4); k++) {
          this.cylinder('gunPolymer', px + r.range(-0.4, 0.4), k * 0.2,
            pz + r.range(-0.4, 0.4), 0.36, 0.36, 0.2, { seg: 12 });
        }
      } else if (pick < 0.90) {
        // A sandbag line — someone tried to hold this street.
        const n = r.int(3, 6);
        for (let k = 0; k < n; k++) {
          const t = (k - (n - 1) / 2) * 0.52;
          const bx = px + Math.cos(rot) * t, bz = pz + Math.sin(rot) * t;
          this.box('dirt', bx, 0, bz, 0.52, 0.24, 0.34,
            { rotY: rot + r.range(-0.1, 0.1), collide: false });
          if (r.next() < 0.6) {
            this.box('dirt', bx, 0.24, bz, 0.50, 0.22, 0.32,
              { rotY: rot + r.range(-0.2, 0.2), collide: false });
          }
        }
        this.collision.add(new Box(px, 0, pz, 1.4, 0.4, 0.5, rot, 'cover'));
      } else {
        // Drifts of paper against a kerb.
        for (let k = 0; k < r.int(4, 9); k++) {
          this.box('plank', px + r.range(-0.8, 0.8), 0.004, pz + r.range(-0.8, 0.8),
            r.range(0.18, 0.34), 0.012, r.range(0.14, 0.26),
            { rotY: r.range(0, TAU), collide: false });
        }
      }
    }
  }

  /**
   * A clump of weeds: crossed cards, so it holds up from any angle.
   *
   * Three quads at sixty degrees rather than two at ninety — the extra card
   * costs two triangles and removes the angle at which a crossed pair goes
   * edge-on and disappears.
   */
  _weeds(x, z, w, h, cards = 3, y = 0) {
    const batch = this._batch('foliage');
    const spin = this.rng.range(0, TAU);
    for (let i = 0; i < cards; i++) {
      const g = new THREE.PlaneGeometry(w, h);
      g.translate(0, y + h / 2, 0);
      g.rotateY(spin + (i / cards) * Math.PI);
      g.translate(x, 0, z);
      batch.push(g);
    }
  }

  /**
   * Where a year of no maintenance shows.
   *
   * Weeds come up through the joint between two surfaces before they come up
   * anywhere else, so this seeds the kerb lines, the foot of every wall and
   * the open lots, and leaves the middle of the road alone — which is both
   * what actually happens and what keeps the ground the player fights on
   * clear.
   */
  _buildOvergrowth() {
    const detail = this.preset.worldDetail ?? 2;
    if (detail < 1) return;
    const r = this.rng;
    const H = ARENA_HALF;

    // Along the kerbs.
    for (const [sx, sz] of QUADRANTS) {
      const cx = sx * 34, cz = sz * 34, half = 15.3;
      for (const [nx, nz] of FACES) {
        for (let k = -13; k <= 13; k++) {
          if (r.next() < 0.45) continue;
          const u = k * 1.1 + r.range(-0.3, 0.3);
          const px = cx + nx * half + (nx !== 0 ? 0 : u);
          const pz = cz + nz * half + (nz !== 0 ? 0 : u);
          this._weeds(px + r.range(-0.12, 0.12), pz + r.range(-0.12, 0.12),
            r.range(0.32, 0.62), r.range(0.26, 0.55), 2);
        }
      }
    }

    // Against the ring wall, where nothing ever walks.
    for (const [nx, nz] of FACES) {
      for (let k = -44; k <= 44; k += 1.6) {
        if (r.next() < 0.4) continue;
        const px = nx !== 0 ? nx * (H - 2.5) : k;
        const pz = nz !== 0 ? nz * (H - 2.5) : k;
        this._weeds(px + r.range(-0.4, 0.4), pz + r.range(-0.4, 0.4),
          r.range(0.4, 0.9), r.range(0.35, 0.8), 2);
      }
    }

    // The two open lots have gone over completely.
    for (const lx of [-34, 34]) {
      for (let i = 0; i < 90; i++) {
        const px = lx + r.range(-6.5, 6.5), pz = r.range(-10.5, 10.5);
        if (this._occupied(px, pz, 0.5)) continue;
        this._weeds(px, pz, r.range(0.5, 1.2), r.range(0.4, 1.1), 3);
      }
      if (detail >= 2) {
        // A few saplings, tall enough to break the roofline behind them.
        for (let i = 0; i < 5; i++) {
          const px = lx + r.range(-5, 5), pz = r.range(-8, 8);
          if (this._occupied(px, pz, 1.2)) continue;
          this.cylinder('wood', px, 0, pz, 0.05, 0.09, r.range(1.6, 2.6), { seg: 5 });
          this._weeds(px, pz, r.range(1.6, 2.4), r.range(1.8, 2.8), 3);
        }
      }
    }

    if (detail < 2) return;

    // Clumps in the cracks, out in the open, sparsely.
    for (let i = 0; i < 70; i++) {
      const a = r.range(0, TAU), rad = r.range(15, 46);
      const px = Math.cos(a) * rad, pz = Math.sin(a) * rad;
      if (this._occupied(px, pz, 0.6)) continue;
      this._weeds(px, pz, r.range(0.3, 0.7), r.range(0.25, 0.6), 2);
    }
  }

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
        /*
         * A vending machine, not a box with a light on it.
         *
         * These sit at eight places around the map and you walk right up to
         * every one of them to use it, so it is the prop the player sees from
         * closest. What it needed was a plinth to stand on, a frame around the
         * front so the panel is recessed rather than stuck on, a sign board
         * over the top, and a return down each side — four minutes of boxes
         * and it stops being a monolith.
         */
        /*
         * The cabinet's own axes, matching what `box`'s rotY actually does:
         * three's Y rotation sends local +X to (cos, -sin) and local +Z to
         * (sin, cos) in world XZ. Getting these the wrong way round is not a
         * subtle error — the frame stiles end up lying across the front of the
         * machine instead of running down its sides.
         */
        const c = Math.cos(d.rot), sn = Math.sin(d.rot);
        const fwd = (t) => [d.x + sn * t, d.z + c * t];
        const side = (t) => [d.x + c * t, d.z - sn * t];

        this.box('steel', d.x, 0, d.z, 1.24, 0.16, 0.92, { rotY: d.rot, tag: 'prop' });
        this.box('paintedMetal', d.x, 0.16, d.z, 1.10, 1.86, 0.80, { rotY: d.rot, tag: 'prop' });
        // Frame: two stiles and a head, standing proud of the front face.
        for (const s2 of [-1, 1]) {
          const [px, pz] = side(s2 * 0.47);
          this.box('steel', px, 0.16, pz, 0.14, 1.86, 0.86, { rotY: d.rot, collide: false });
        }
        {
          const [px, pz] = fwd(0.06);
          this.box('steel', px, 1.72, pz, 1.16, 0.30, 0.14, { rotY: d.rot, collide: false });
          this.box('steel', px, 0.16, pz, 1.16, 0.22, 0.14, { rotY: d.rot, collide: false });
        }
        // Sign board on top, and the lit strip that lights it.
        this.box('paintedMetal', d.x, 2.02, d.z, 1.26, 0.46, 0.30, { rotY: d.rot, collide: false });
        {
          const [px, pz] = fwd(0.17);
          this.box('neonCyan', px, 2.10, pz, 1.02, 0.26, 0.04, { rotY: d.rot, collide: false });
        }
        // The illuminated front panel, set back inside the frame.
        {
          const [px, pz] = fwd(0.40);
          this.box('neonCyan', px, 0.62, pz, 0.80, 1.02, 0.05, { rotY: d.rot, collide: false });
          const [gx, gz] = fwd(0.44);
          this.box('glass', gx, 0.60, gz, 0.86, 1.08, 0.03, { rotY: d.rot, collide: false });
        }
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
    // Glass. Rough enough that the sun spreads across a pane instead of
    // clipping to a white rectangle on it, and reflecting the sky at a
    // believable strength rather than two and a half times it.
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x0c1017, roughness: 0.14, metalness: 0.35,
      envMapIntensity: 1.45, side: THREE.DoubleSide,
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
        && key !== 'windowDark' && key !== 'tile' && key !== 'roadPaint';
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

// Outward normals of a box's four vertical faces.
const FACES = [[0, -1], [0, 1], [-1, 0], [1, 0]];

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
