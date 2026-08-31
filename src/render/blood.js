import * as THREE from 'three';

/**
 * Blood as a liquid.
 *
 * The old system stamped a fixed-size disc wherever something died and let a
 * cloud of droplets evaporate in mid-air. Nothing about that reads as fluid:
 * the spray never lands, and a pool is the same size a second after the kill
 * as it is a minute later.
 *
 * What is here instead:
 *
 *  - droplets are swept against the level every frame and *stop* where they
 *    hit something, leaving a mark there (see `ParticleField` in fx.js, which
 *    calls back into this module);
 *  - what lands on the ground becomes volume in a pool, and pools spread from
 *    the volume they hold, so blood accumulates where the killing happened;
 *  - pools that grow into each other merge into one larger pool rather than
 *    overlapping as two discs;
 *  - what lands on a wall high enough starts a runner, which slides down the
 *    surface laying a streak and finally feeds the pool at the wall's foot.
 *
 * Rendering is one instanced quad per mark under multiply blending, which is
 * the only blend mode that darkens a surface without also pasting a colour
 * over it. Alpha is per-instance, so a mark can dry out without its colour
 * shifting, and fog is applied by fading alpha with distance — under multiply
 * that is exactly right, since a mark seen through haze should tint less.
 */

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

// One texture, four shapes. Instances pick a cell, so a hundred marks on one
// wall never repeat in a way the eye can lock onto.
const ATLAS_CELLS = 2;

const SPLAT_VERT = /* glsl */`
  attribute vec2 aCell;
  attribute vec3 aTint;
  attribute float aAlpha;
  uniform float uFogDensity;
  uniform float uCellSize;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vAlpha;
  varying float vFog;
  void main() {
    vUv = uv * uCellSize + aCell;
    vTint = aTint;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    float d = max(-mv.z, 0.0);
    // Exponential-squared, matching the scene fog, so a mark on a distant
    // wall recedes into the haze at the same rate the wall does.
    float f = uFogDensity * d;
    vFog = clamp(1.0 - exp(-f * f), 0.0, 1.0);
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * mv;
  }
`;

const SPLAT_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uMap;
  uniform vec3 uLight;
  uniform vec3 uFogColor;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vAlpha;
  varying float vFog;
  void main() {
    float a = texture2D(uMap, vUv).a * vAlpha;
    if (a < 0.004) discard;
    // The tint is blood's albedo, not a colour to paste on. Multiplying it by
    // the level's light level is what keeps a pool dark in shadow and bright
    // in the sun without the decal having to be lit for real.
    vec3 col = mix(vTint * uLight, uFogColor, vFog);
    // Premultiplied, so alpha is coverage: the surface is lerped toward the
    // blood by however much of it is covered.
    gl_FragColor = vec4(col * a, a);
  }
`;

/**
 * Draws the atlas: four blobs with ragged edges and a scatter of outflung
 * droplets, white with the shape carried entirely in alpha. White matters —
 * the instance tint is what colours the mark, and any colour baked into the
 * texture would multiply against it twice.
 */
export function makeSplatTexture(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const cell = size / ATLAS_CELLS;

  for (let cy = 0; cy < ATLAS_CELLS; cy++) {
    for (let cx = 0; cx < ATLAS_CELLS; cx++) {
      const ox = cx * cell, oy = cy * cell;
      const mx = ox + cell * 0.5, my = oy + cell * 0.5;
      // Keep the blob well inside its cell: bilinear filtering samples across
      // the seam otherwise and a neighbour's edge bleeds in.
      const R = cell * 0.36;

      ctx.save();
      ctx.beginPath();
      ctx.rect(ox + 1, oy + 1, cell - 2, cell - 2);
      ctx.clip();

      // Body: a closed spline through a ring of jittered radii, so no two
      // cells share a silhouette.
      const lobes = 9 + cx + cy * 2;
      const pts = [];
      let phase = Math.random() * TAU;
      for (let i = 0; i < lobes; i++) {
        const a = phase + (i / lobes) * TAU;
        const r = R * (0.72 + Math.random() * 0.45);
        pts.push([mx + Math.cos(a) * r, my + Math.sin(a) * r]);
      }
      ctx.beginPath();
      ctx.moveTo((pts[0][0] + pts[lobes - 1][0]) / 2, (pts[0][1] + pts[lobes - 1][1]) / 2);
      for (let i = 0; i < lobes; i++) {
        const p = pts[i], q = pts[(i + 1) % lobes];
        ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,1)';
      ctx.fill();

      // A soft skirt around the body so the edge feathers into the surface
      // instead of ending on a line. Alpha is coverage now, not a multiply
      // strength, so a partly covered edge simply blends toward the ground —
      // which is what let this go back to being generous.
      const g = ctx.createRadialGradient(mx, my, R * 0.68, mx, my, R * 1.18);
      g.addColorStop(0, 'rgba(255,255,255,0.62)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.30)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(ox, oy, cell, cell);

      // Outflung droplets, a few of them still joined to the body by the
      // thread they tore away on. Short threads: long ones read as legs.
      const drops = 9 + Math.floor(Math.random() * 7);
      for (let i = 0; i < drops; i++) {
        const a = Math.random() * TAU;
        const d = R * (1.05 + Math.random() * 0.35);
        const px = mx + Math.cos(a) * d, py = my + Math.sin(a) * d;
        const rr = cell * (0.005 + Math.random() * 0.016);
        ctx.globalAlpha = 0.4 + Math.random() * 0.6;
        ctx.beginPath();
        ctx.ellipse(px, py, rr, rr * (0.7 + Math.random() * 0.8), a, 0, TAU);
        ctx.fill();
        if (Math.random() < 0.3) {
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(mx + Math.cos(a) * d * 0.82, my + Math.sin(a) * d * 0.82);
          ctx.lineWidth = rr * 0.7;
          ctx.strokeStyle = 'rgba(255,255,255,1)';
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function splatMaterial(texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uFogDensity: { value: 0.02 },
      uCellSize: { value: 1 / ATLAS_CELLS },
      uLight: { value: new THREE.Vector3(1, 1, 1) },
      uFogColor: { value: new THREE.Color(0xb9c6d4) },
    },
    vertexShader: SPLAT_VERT,
    fragmentShader: SPLAT_FRAG,
    transparent: true,
    // Not multiply.
    //
    // Multiply is the obvious choice for a decal and it is wrong for blood,
    // because blood is opaque: it does not darken what is under it by a fixed
    // ratio, it replaces it. On pale concrete a multiply tint that looks like
    // blood is far too weak; on asphalt the same tint is a black hole in the
    // ground. Lerping toward blood's own albedo is both the physical answer
    // and the one that holds up on every surface in the level.
    blending: THREE.NormalBlending,
    // The shader writes premultiplied colour, so this has to be declared or
    // every mark comes out with a bright halo.
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

/** Shared instanced-quad plumbing for both the marks and the pools. */
class MarkMesh {
  constructor(scene, texture, capacity, renderOrder) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.cellArr = new Float32Array(capacity * 2);
    this.tintArr = new Float32Array(capacity * 3);
    this.alphaArr = new Float32Array(capacity);
    this.aCell = new THREE.InstancedBufferAttribute(this.cellArr, 2).setUsage(THREE.DynamicDrawUsage);
    this.aTint = new THREE.InstancedBufferAttribute(this.tintArr, 3).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.InstancedBufferAttribute(this.alphaArr, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCell', this.aCell);
    geo.setAttribute('aTint', this.aTint);
    geo.setAttribute('aAlpha', this.aAlpha);

    this.material = splatMaterial(texture);
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.count = 0;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    scene.add(this.mesh);
    this.capacity = capacity;
  }

  setCell(i, n) {
    const c = n % (ATLAS_CELLS * ATLAS_CELLS);
    this.cellArr[i * 2] = (c % ATLAS_CELLS) / ATLAS_CELLS;
    this.cellArr[i * 2 + 1] = Math.floor(c / ATLAS_CELLS) / ATLAS_CELLS;
    this.aCell.needsUpdate = true;
  }

  setTint(i, color) {
    this.tintArr[i * 3] = color.r;
    this.tintArr[i * 3 + 1] = color.g;
    this.tintArr[i * 3 + 2] = color.b;
    this.aTint.needsUpdate = true;
  }

  setFog(color, density) {
    this.material.uniforms.uFogDensity.value = density;
    if (color) this.material.uniforms.uFogColor.value.copy(color);
  }

  /** The level's light level, so blood is lit like everything around it. */
  setLight(r, g, b) { this.material.uniforms.uLight.value.set(r, g, b); }

  clear() { this.mesh.count = 0; }
}

const _c = new THREE.Color();
const _q = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _basis = new THREE.Matrix4();

/**
 * Marks on walls, props and the ground: droplet impacts, arterial splatter,
 * the streaks runners leave behind.
 *
 * A ring buffer — the oldest mark is recycled when the budget is spent, which
 * is what you want in a room that has seen twenty kills.
 */
export class MarkField {
  constructor(scene, texture, capacity) {
    this.gl = new MarkMesh(scene, texture, capacity, 3);
    this.capacity = capacity;
    this.cursor = 0;
    this.live = 0;
    this.age = new Float32Array(capacity);
    this.ttl = new Float32Array(capacity);
    this.peak = new Float32Array(capacity);
  }

  /**
   * @param {number} alpha how strongly the mark tints the surface at its wettest
   */
  place(x, y, z, nx, ny, nz, size, color, alpha = 0.85, ttl = 34) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.live = Math.min(this.live + 1, this.capacity);
    this.gl.mesh.count = this.live;

    _n.set(nx, ny, nz).normalize();
    _q.setFromUnitVectors(_up, _n);
    _roll.setFromAxisAngle(_up, rand(0, TAU));
    _q.multiply(_roll);
    // Slightly oval, so even the same atlas cell twice never looks stamped.
    _s.set(size * rand(0.82, 1.2), size * rand(0.82, 1.2), 1);
    _p.set(x + _n.x * 0.014, y + _n.y * 0.014, z + _n.z * 0.014);
    _m.compose(_p, _q, _s);
    this.gl.mesh.setMatrixAt(i, _m);
    this.gl.mesh.instanceMatrix.needsUpdate = true;

    this.gl.setCell(i, Math.floor(Math.random() * 4));
    this.gl.setTint(i, _c.set(color));
    this.gl.alphaArr[i] = alpha;
    this.gl.aAlpha.needsUpdate = true;
    this.age[i] = 0;
    this.ttl[i] = ttl;
    this.peak[i] = alpha;
    return i;
  }

  /**
   * A mark laid by a runner: taller than it is wide and standing upright on
   * the surface, so a line of them reads as one continuous streak instead of
   * a string of beads. Cheaper than it looks — a stretched mark every ten
   * centimetres covers a run that round marks would need thirty to cover.
   */
  streak(x, y, z, nx, nz, width, height, color, alpha = 0.6, ttl = 30) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.live = Math.min(this.live + 1, this.capacity);
    this.gl.mesh.count = this.live;

    _n.set(nx, 0, nz).normalize();
    _bx.set(-_n.z, 0, _n.x);          // right = up x normal, on a vertical face
    _by.set(0, 1, 0);
    _basis.makeBasis(_bx, _by, _n);
    _q.setFromRotationMatrix(_basis);
    _s.set(width, height, 1);
    _p.set(x + _n.x * 0.016, y, z + _n.z * 0.016);
    _m.compose(_p, _q, _s);
    this.gl.mesh.setMatrixAt(i, _m);
    this.gl.mesh.instanceMatrix.needsUpdate = true;

    this.gl.setCell(i, Math.floor(Math.random() * 4));
    this.gl.setTint(i, _c.set(color));
    this.gl.alphaArr[i] = alpha;
    this.gl.aAlpha.needsUpdate = true;
    this.age[i] = 0;
    this.ttl[i] = ttl;
    this.peak[i] = alpha;
    return i;
  }

  update(dt) {
    if (!this.live) return;
    let dirty = false;
    for (let i = 0; i < this.live; i++) {
      if (this.ttl[i] <= 0) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.ttl[i];
      if (t >= 1) { this.ttl[i] = 0; this.gl.alphaArr[i] = 0; dirty = true; continue; }
      // Blood darkens as it dries and only starts thinning near the end, so
      // a fight leaves its marks for as long as the fight is worth remembering.
      const dry = t < 0.65 ? 0 : (t - 0.65) / 0.35;
      const a = this.peak[i] * (1 - dry * dry);
      if (a !== this.gl.alphaArr[i]) { this.gl.alphaArr[i] = a; dirty = true; }
    }
    if (dirty) this.gl.aAlpha.needsUpdate = true;
  }

  setFog(color, density) { this.gl.setFog(color, density); }
  setLight(r, g, b) { this.gl.setLight(r, g, b); }
  clear() { this.live = 0; this.cursor = 0; this.gl.clear(); }
}

// Pools lie flat, and the quad is built in the XY plane.
const _HALF_X = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

// Volume-to-radius. Blood spreads until surface tension and the roughness of
// the ground stop it, which in practice means area scales with how much came
// out — so radius goes as the square root.
const POOL_K = 0.52;
const POOL_MIN = 0.16;
const POOL_MAX = 2.9;
const THIN = new THREE.Color(0x5e2318);
const THICK = new THREE.Color(0x3d120d);

/**
 * Ground pools: the one part of the blood that is genuinely simulated rather
 * than stamped. Each pool holds a volume, spreads toward the radius that
 * volume implies, and swallows any neighbour it grows into.
 */
export class PoolField {
  constructor(scene, texture, capacity = 72) {
    this.gl = new MarkMesh(scene, texture, capacity, 2);
    this.capacity = capacity;
    this.n = 0;
    this.x = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.vol = new Float32Array(capacity);
    this.r = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.aspect = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.ttl = new Float32Array(capacity);
    this._scan = 0;
  }

  radiusFor(v) {
    return Math.min(POOL_MAX, Math.max(POOL_MIN, POOL_K * Math.sqrt(v)));
  }

  /**
   * Adds `volume` of blood at a point. Feeds the pool already there when the
   * point falls inside one, so a corpse bleeding out grows a single spreading
   * pool instead of a stack of discs.
   */
  add(x, z, volume, ttl = 55, seedChance = 1) {
    for (let i = 0; i < this.n; i++) {
      const dx = x - this.x[i], dz = z - this.z[i];
      const reach = this.r[i] + 0.22;
      if (dx * dx + dz * dz > reach * reach) continue;
      const w = volume / (this.vol[i] + volume);
      // The pool drifts toward where the new blood landed, but only a little:
      // a pool does not walk across the street to meet a droplet.
      this.x[i] += dx * w * 0.5;
      this.z[i] += dz * w * 0.5;
      this.vol[i] += volume;
      this.age[i] = Math.min(this.age[i], this.ttl[i] * 0.25);
      this.ttl[i] = Math.max(this.ttl[i], ttl);
      return i;
    }

    // Nothing to feed. A corpse always starts a pool; a single droplet
    // usually does not — otherwise a spray across a courtyard leaves fifty
    // identical wet dots, each one a pool in its own right.
    if (Math.random() >= seedChance) return -1;

    let i = this.n;
    if (i >= this.capacity) {
      // Full: reuse whatever is nearest the end of its life.
      let worst = 0, wt = -1;
      for (let k = 0; k < this.n; k++) {
        const t = this.age[k] / Math.max(0.001, this.ttl[k]);
        if (t > wt) { wt = t; worst = k; }
      }
      i = worst;
    } else {
      this.n++;
      this.gl.mesh.count = this.n;
    }
    this.x[i] = x; this.z[i] = z;
    this.vol[i] = volume;
    this.r[i] = POOL_MIN * 0.5;
    this.rot[i] = rand(0, TAU);
    this.aspect[i] = rand(0.78, 1.28);
    this.age[i] = 0;
    this.ttl[i] = ttl;
    this.gl.setCell(i, Math.floor(Math.random() * 4));
    return i;
  }

  update(dt) {
    if (!this.n) return;
    const spread = 1 - Math.exp(-1.7 * dt);

    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.ttl[i]) {
        this.n--;
        if (i !== this.n) this._move(this.n, i);
        i--;
        continue;
      }
      const target = this.radiusFor(this.vol[i]);
      this.r[i] += (target - this.r[i]) * spread;
    }
    this.gl.mesh.count = this.n;

    // Merge one candidate pair per frame. Pools change slowly, so a full
    // O(n^2) pass every frame would be pure waste.
    if (this.n > 1) {
      const i = this._scan % this.n;
      this._scan = (this._scan + 1) % Math.max(1, this.n);
      for (let j = 0; j < this.n; j++) {
        if (j === i) continue;
        const dx = this.x[i] - this.x[j], dz = this.z[i] - this.z[j];
        const reach = (this.r[i] + this.r[j]) * 0.55;
        if (dx * dx + dz * dz > reach * reach) continue;
        const big = this.vol[i] >= this.vol[j] ? i : j;
        const small = big === i ? j : i;
        const tv = this.vol[big] + this.vol[small];
        this.x[big] += (this.x[small] - this.x[big]) * (this.vol[small] / tv);
        this.z[big] += (this.z[small] - this.z[big]) * (this.vol[small] / tv);
        this.vol[big] = tv;
        this.ttl[big] = Math.max(this.ttl[big], this.ttl[small]);
        this.age[big] = Math.min(this.age[big], this.age[small]);
        this.n--;
        if (small !== this.n) this._move(this.n, small);
        this.gl.mesh.count = this.n;
        break;
      }
    }

    for (let i = 0; i < this.n; i++) {
      const r = this.r[i];
      _q.setFromAxisAngle(_up, this.rot[i]);
      _q.premultiply(_HALF_X);
      _p.set(this.x[i], 0.018, this.z[i]);
      _s.set(r * 2 * this.aspect[i], r * 2 / this.aspect[i], 1);
      _m.compose(_p, _q, _s);
      this.gl.mesh.setMatrixAt(i, _m);

      // Deep blood is darker and more opaque than a thin smear.
      const thickness = Math.min(1, this.vol[i] / 7);
      _c.copy(THIN).lerp(THICK, thickness);
      this.gl.setTint(i, _c);

      const t = this.age[i] / this.ttl[i];
      const dry = t < 0.6 ? 0 : (t - 0.6) / 0.4;
      // Fresh blood needs a moment to spread before it reads at full strength.
      const wet = Math.min(1, this.age[i] / 0.35);
      this.gl.alphaArr[i] = (0.72 + 0.24 * thickness) * wet * (1 - dry * dry);
    }
    this.gl.mesh.instanceMatrix.needsUpdate = true;
    this.gl.aAlpha.needsUpdate = true;
  }

  _move(from, to) {
    this.x[to] = this.x[from]; this.z[to] = this.z[from];
    this.vol[to] = this.vol[from]; this.r[to] = this.r[from];
    this.rot[to] = this.rot[from]; this.aspect[to] = this.aspect[from];
    this.age[to] = this.age[from]; this.ttl[to] = this.ttl[from];
    this.gl.cellArr[to * 2] = this.gl.cellArr[from * 2];
    this.gl.cellArr[to * 2 + 1] = this.gl.cellArr[from * 2 + 1];
    this.gl.aCell.needsUpdate = true;
  }

  setFog(color, density) { this.gl.setFog(color, density); }
  setLight(r, g, b) { this.gl.setLight(r, g, b); }
  clear() { this.n = 0; this.gl.clear(); }
}

/**
 * Blood running down a wall.
 *
 * A runner is a bead of blood pinned to a surface. It accelerates downward,
 * loses to friction as it thins out, and lays a narrow mark every few
 * centimetres — the streak is the trail, not a single stretched quad. When it
 * reaches the floor it hands its remaining volume to the pool there, which is
 * why blood sprayed up a wall ends up on the ground under it.
 */
export class RunnerField {
  constructor(capacity = 28) {
    this.capacity = capacity;
    this.n = 0;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.nx = new Float32Array(capacity);
    this.nz = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.width = new Float32Array(capacity);
    this.vol = new Float32Array(capacity);
    this.since = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
  }

  spawn(x, y, z, nx, nz, width, volume) {
    if (this.n >= this.capacity || y < 0.35) return false;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.nx[i] = nx; this.nz[i] = nz;
    this.vy[i] = -rand(0.05, 0.16);
    this.width[i] = width;
    this.vol[i] = volume;
    this.since[i] = 0;
    this.life[i] = 0;
    return true;
  }

  /**
   * @param {(x,y,z,nx,nz,w) => void} mark called where the runner leaves a trace
   * @param {(x,z,vol) => void} land  called when it reaches the floor
   */
  update(dt, mark, land) {
    for (let i = 0; i < this.n; i++) {
      this.life[i] += dt;
      // Gravity pulls, the surface drags back, and the bead thins as it goes,
      // so runs start slow, speed up, then stall part-way down — which is
      // what blood on a rough wall actually does.
      const thin = Math.max(0.22, 1 - this.life[i] * 0.2);
      this.vy[i] = (this.vy[i] - 2.2 * dt * thin) * Math.exp(-2.6 * dt);
      this.y[i] += this.vy[i] * dt;
      this.since[i] += Math.abs(this.vy[i]) * dt;

      // One mark per stretch a little shorter than the mark itself, so
      // consecutive marks overlap into a continuous run with no gaps.
      const span = this.width[i] * 3.6;
      if (this.since[i] > span) {
        this.since[i] = 0;
        mark(
          this.x[i], this.y[i] + span * 0.5, this.z[i],
          this.nx[i], this.nz[i], this.width[i] * thin, span * 1.35,
        );
      }

      const stalled = Math.abs(this.vy[i]) < 0.012 && this.life[i] > 0.6;
      if (this.y[i] <= 0.04 || stalled || this.life[i] > 9) {
        if (this.y[i] <= 0.06) {
          land(this.x[i] + this.nx[i] * 0.12, this.z[i] + this.nz[i] * 0.12, this.vol[i]);
        }
        this.n--;
        if (i !== this.n) this._move(this.n, i);
        i--;
      }
    }
  }

  _move(from, to) {
    this.x[to] = this.x[from]; this.y[to] = this.y[from]; this.z[to] = this.z[from];
    this.nx[to] = this.nx[from]; this.nz[to] = this.nz[from];
    this.vy[to] = this.vy[from]; this.width[to] = this.width[from];
    this.vol[to] = this.vol[from]; this.since[to] = this.since[from];
    this.life[to] = this.life[from];
  }

  clear() { this.n = 0; }
}
