import * as THREE from 'three';
import { Pool, rand, randInt, gauss, clamp, TAU } from '../core/util.js';

/**
 * All transient visuals: particles, gore chunks, decals, tracers and impact
 * flashes.
 *
 * Everything is pre-allocated and pooled. The steady-state frame allocates
 * nothing, and the whole effects layer costs about six draw calls no matter how
 * much is happening — one per particle texture, one for gibs, one for decals,
 * one for tracers.
 */

// ---------------------------------------------------------------- particles

const PARTICLE_VERT = /* glsl */`
  attribute float aSize;
  attribute vec4 aColor;
  varying vec4 vColor;
  varying float vFog;
  uniform float uPixelScale;
  uniform float uMaxSize;
  void main() {
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    float d = -mv.z;

    // Hard cap on sprite size. A two-metre smoke puff a metre from the eye
    // projects to thousands of pixels and whites out the entire frame, which
    // is exactly what a grenade at your feet used to do.
    gl_PointSize = clamp( aSize * uPixelScale / max( d, 0.1 ), 1.0, uMaxSize );

    // Fade anything the camera is practically inside, so you never end up
    // looking at the flat side of a single sprite.
    vColor = aColor;
    vColor.a *= smoothstep( 0.12, 0.85, d );

    vFog = d;
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uMap;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying vec4 vColor;
  varying float vFog;
  void main() {
    vec4 t = texture2D( uMap, gl_PointCoord );
    float a = t.a * vColor.a;
    if ( a < 0.006 ) discard;
    vec3 c = t.rgb * vColor.rgb;
    float f = 1.0 - exp( - uFogDensity * uFogDensity * vFog * vFog );
    c = mix( c, uFogColor, clamp( f, 0.0, 1.0 ) * 0.85 );
    gl_FragColor = vec4( c, a );
  }
`;

/**
 * One pooled point-sprite system. Positions are integrated on the CPU (a few
 * hundred particles is nothing) and uploaded as a single partial buffer update.
 */
class ParticleField {
  constructor(scene, texture, capacity, { additive = true, gravity = -9.8 } = {}) {
    this.capacity = capacity;
    this.count = 0;
    this.gravity = gravity;

    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);

    // Simulation state (never touches the GPU).
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.r0 = new Float32Array(capacity);
    this.g0 = new Float32Array(capacity);
    this.b0 = new Float32Array(capacity);
    this.r1 = new Float32Array(capacity);
    this.g1 = new Float32Array(capacity);
    this.b1 = new Float32Array(capacity);
    this.gravScale = new Float32Array(capacity);
    this.bounce = new Uint8Array(capacity);
    this.fadeIn = new Float32Array(capacity);

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSize);
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uPixelScale: { value: 600 },
        uMaxSize: { value: 190 },
        uFogColor: { value: new THREE.Color(0x111823) },
        uFogDensity: { value: 0.026 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
    this.geometry = g;
  }

  setFog(color, density) {
    this.material.uniforms.uFogColor.value.copy(color);
    this.material.uniforms.uFogDensity.value = density;
  }

  setViewportHeight(h) {
    // Matches the perspective projection for a ~75 degree vertical FOV, so
    // `size` in the emitters means metres.
    this.material.uniforms.uPixelScale.value = h * 0.66;
    this.material.uniforms.uMaxSize.value = Math.max(64, h * 0.28);
  }

  /** Spawns one particle; silently drops it when the field is saturated. */
  emit(o) {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx; this.vel[i3 + 1] = o.vy; this.vel[i3 + 2] = o.vz;
    this.life[i] = 0;
    this.maxLife[i] = o.life;
    this.drag[i] = o.drag ?? 1.4;
    this.baseSize[i] = o.size;
    this.grow[i] = o.grow ?? 0;
    this.gravScale[i] = o.gravity ?? 1;
    this.bounce[i] = o.bounce ? 1 : 0;
    this.fadeIn[i] = o.fadeIn ?? 0.06;
    this.r0[i] = o.r0; this.g0[i] = o.g0; this.b0[i] = o.b0;
    this.r1[i] = o.r1 ?? o.r0; this.g1[i] = o.g1 ?? o.g0; this.b1[i] = o.b1 ?? o.b0;
    this.size[i] = o.size;
    return true;
  }

  update(dt) {
    const { pos, vel, life, maxLife, drag, size, baseSize, grow, col } = this;
    let n = this.count;
    for (let i = 0; i < n; i++) {
      life[i] += dt;
      if (life[i] >= maxLife[i]) {
        // Swap-remove; order does not matter for additive sprites.
        n--;
        if (i !== n) this._move(n, i);
        i--;
        continue;
      }
      const i3 = i * 3;
      const d = Math.exp(-drag[i] * dt);
      vel[i3] *= d;
      vel[i3 + 1] = vel[i3 + 1] * d + this.gravity * this.gravScale[i] * dt;
      vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      if (this.bounce[i] && pos[i3 + 1] < 0.02) {
        pos[i3 + 1] = 0.02;
        vel[i3 + 1] = Math.abs(vel[i3 + 1]) * 0.28;
        vel[i3] *= 0.55; vel[i3 + 2] *= 0.55;
        if (Math.abs(vel[i3 + 1]) < 0.35) this.bounce[i] = 0;
      }

      const t = life[i] / maxLife[i];
      size[i] = baseSize[i] * (1 + grow[i] * t);

      // Alpha: quick ramp in, smooth ramp out — no popping at either end.
      const a = Math.min(1, t / Math.max(0.001, this.fadeIn[i])) * (1 - t * t);
      const i4 = i * 4;
      col[i4] = this.r0[i] + (this.r1[i] - this.r0[i]) * t;
      col[i4 + 1] = this.g0[i] + (this.g1[i] - this.g0[i]) * t;
      col[i4 + 2] = this.b0[i] + (this.b1[i] - this.b0[i]) * t;
      col[i4 + 3] = a;
    }
    this.count = n;

    if (n > 0) {
      this.aPos.addUpdateRange(0, n * 3); this.aPos.needsUpdate = true;
      this.aCol.addUpdateRange(0, n * 4); this.aCol.needsUpdate = true;
      this.aSize.addUpdateRange(0, n); this.aSize.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, n);
    this.points.visible = n > 0;
  }

  _move(from, to) {
    const f3 = from * 3, t3 = to * 3, f4 = from * 4, t4 = to * 4;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
    }
    for (let k = 0; k < 4; k++) this.col[t4 + k] = this.col[f4 + k];
    this.size[to] = this.size[from];
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.drag[to] = this.drag[from];
    this.baseSize[to] = this.baseSize[from];
    this.grow[to] = this.grow[from];
    this.gravScale[to] = this.gravScale[from];
    this.bounce[to] = this.bounce[from];
    this.fadeIn[to] = this.fadeIn[from];
    this.r0[to] = this.r0[from]; this.g0[to] = this.g0[from]; this.b0[to] = this.b0[from];
    this.r1[to] = this.r1[from]; this.g1[to] = this.g1[from]; this.b1[to] = this.b1[from];
  }

  clear() { this.count = 0; this.geometry.setDrawRange(0, 0); }
}

// ------------------------------------------------------------------ decals

/**
 * Bullet holes and blood splatter, as instanced quads with multiply blending.
 * Multiply is the right call here: a decal darkens whatever it lands on, and
 * fading it back toward white is a perfect no-op, so decals dissolve away
 * without ever showing a rectangular edge.
 */
class DecalField {
  constructor(scene, texture, capacity) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending: THREE.MultiplyBlending,
      // three requires premultiplied alpha for multiply blending; without it
      // the decal draws as an opaque black quad.
      premultipliedAlpha: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);

    this.capacity = capacity;
    this.cursor = 0;
    this.live = 0;
    this.age = new Float32Array(capacity);
    this.ttl = new Float32Array(capacity);
    this.baseColor = new Float32Array(capacity * 3);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._roll = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 0, 1);
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  /** Places a decal on a surface with the given normal. */
  place(point, normal, size, color, ttl = 25) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.live = Math.min(this.live + 1, this.capacity);
    this.mesh.count = this.live;

    this._q.setFromUnitVectors(this._up, normal);
    // Random roll so repeated hits on one wall never look stamped.
    this._roll.setFromAxisAngle(this._up, rand(0, TAU));
    this._q.multiply(this._roll);
    this._s.set(size, size, size);
    this._p.set(
      point.x + normal.x * 0.012,
      point.y + normal.y * 0.012,
      point.z + normal.z * 0.012,
    );
    this._m.compose(this._p, this._q, this._s);
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;

    this._c.set(color);
    this.baseColor[i * 3] = this._c.r;
    this.baseColor[i * 3 + 1] = this._c.g;
    this.baseColor[i * 3 + 2] = this._c.b;
    this.mesh.setColorAt(i, this._c);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.age[i] = 0;
    this.ttl[i] = ttl;
    return i;
  }

  update(dt) {
    if (!this.live) return;
    let dirty = false;
    for (let i = 0; i < this.live; i++) {
      if (this.ttl[i] <= 0) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.ttl[i];
      if (t >= 1) { this.ttl[i] = 0; }
      // Only the last 30% of life fades, so decals stay crisp while they matter.
      const f = t < 0.7 ? 0 : (t - 0.7) / 0.3;
      if (f > 0) {
        const k = Math.min(1, f);
        this._c.setRGB(
          this.baseColor[i * 3] + (1 - this.baseColor[i * 3]) * k,
          this.baseColor[i * 3 + 1] + (1 - this.baseColor[i * 3 + 1]) * k,
          this.baseColor[i * 3 + 2] + (1 - this.baseColor[i * 3 + 2]) * k,
        );
        this.mesh.setColorAt(i, this._c);
        dirty = true;
      }
    }
    if (dirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() { this.live = 0; this.cursor = 0; this.mesh.count = 0; }
}

// -------------------------------------------------------------------- gibs

/** Chunks of zombie. Ballistic, they bounce once or twice, then sink and vanish. */
class GibField {
  constructor(scene, capacity, material) {
    const geo = new THREE.IcosahedronGeometry(0.075, 0);
    // Squash into irregular shards so they do not read as identical pebbles.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) * rand(0.6, 1.5), pos.getY(i) * rand(0.5, 1.3), pos.getZ(i) * rand(0.6, 1.5));
    }
    geo.computeVertexNormals();

    this.mesh = new THREE.InstancedMesh(geo, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.count = 0;
    scene.add(this.mesh);

    this.capacity = capacity;
    this.n = 0;
    this.p = new Float32Array(capacity * 3);
    this.v = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 3);
    this.spin = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.ttl = new Float32Array(capacity);
    this.scale = new Float32Array(capacity);
    this._m = new THREE.Matrix4();
    this._e = new THREE.Euler();
    this._q = new THREE.Quaternion();
    this._pv = new THREE.Vector3();
    this._sv = new THREE.Vector3();
    this.onLand = null;
  }

  spawn(x, y, z, vx, vy, vz, scale = 1, ttl = 6) {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    const i3 = i * 3;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z;
    this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.rot[i3] = rand(0, TAU); this.rot[i3 + 1] = rand(0, TAU); this.rot[i3 + 2] = rand(0, TAU);
    this.spin[i3] = gauss() * 9; this.spin[i3 + 1] = gauss() * 9; this.spin[i3 + 2] = gauss() * 9;
    this.life[i] = 0;
    this.ttl[i] = ttl;
    this.scale[i] = scale;
    this.mesh.count = this.n;
  }

  update(dt) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.ttl[i]) {
        n--;
        if (i !== n) this._swap(n, i);
        i--;
        continue;
      }
      const i3 = i * 3;
      this.v[i3 + 1] -= 17 * dt;
      this.p[i3] += this.v[i3] * dt;
      this.p[i3 + 1] += this.v[i3 + 1] * dt;
      this.p[i3 + 2] += this.v[i3 + 2] * dt;

      const r = 0.07 * this.scale[i];
      if (this.p[i3 + 1] < r) {
        if (this.v[i3 + 1] < -1.2 && this.onLand) {
          this.onLand(this.p[i3], r, this.p[i3 + 2]);
        }
        this.p[i3 + 1] = r;
        this.v[i3 + 1] *= -0.24;
        this.v[i3] *= 0.6; this.v[i3 + 2] *= 0.6;
        this.spin[i3] *= 0.5; this.spin[i3 + 1] *= 0.5; this.spin[i3 + 2] *= 0.5;
      }

      this.rot[i3] += this.spin[i3] * dt;
      this.rot[i3 + 1] += this.spin[i3 + 1] * dt;
      this.rot[i3 + 2] += this.spin[i3 + 2] * dt;

      // Shrink away over the last second instead of blinking out.
      const left = this.ttl[i] - this.life[i];
      const s = this.scale[i] * (left < 1 ? left : 1);
      this._e.set(this.rot[i3], this.rot[i3 + 1], this.rot[i3 + 2]);
      this._q.setFromEuler(this._e);
      this._pv.set(this.p[i3], this.p[i3 + 1], this.p[i3 + 2]);
      this._sv.set(s, s, s);
      this._m.compose(this._pv, this._q, this._sv);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.n = n;
    this.mesh.count = n;
    if (n) this.mesh.instanceMatrix.needsUpdate = true;
  }

  _swap(from, to) {
    const f3 = from * 3, t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.p[t3 + k] = this.p[f3 + k];
      this.v[t3 + k] = this.v[f3 + k];
      this.rot[t3 + k] = this.rot[f3 + k];
      this.spin[t3 + k] = this.spin[f3 + k];
    }
    this.life[to] = this.life[from];
    this.ttl[to] = this.ttl[from];
    this.scale[to] = this.scale[from];
  }

  clear() { this.n = 0; this.mesh.count = 0; }
}

// ----------------------------------------------------------------- tracers

/** Bullet trails as a single dynamic LineSegments buffer. */
class TracerField {
  constructor(scene, capacity) {
    this.capacity = capacity;
    this.n = 0;
    this.pos = new Float32Array(capacity * 6);
    this.col = new Float32Array(capacity * 6);
    this.life = new Float32Array(capacity);
    this.ttl = new Float32Array(capacity);
    this.base = new Float32Array(capacity * 3);

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('color', this.aCol);
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const m = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.lines = new THREE.LineSegments(g, m);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 9;
    scene.add(this.lines);
    this.geometry = g;
    this._c = new THREE.Color();
  }

  add(from, to, color = 0xffd08a, ttl = 0.06) {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    const i6 = i * 6;
    this.pos[i6] = from.x; this.pos[i6 + 1] = from.y; this.pos[i6 + 2] = from.z;
    this.pos[i6 + 3] = to.x; this.pos[i6 + 4] = to.y; this.pos[i6 + 5] = to.z;
    this._c.set(color);
    this.base[i * 3] = this._c.r; this.base[i * 3 + 1] = this._c.g; this.base[i * 3 + 2] = this._c.b;
    this.life[i] = 0; this.ttl[i] = ttl;
  }

  update(dt) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      const t = this.life[i] / this.ttl[i];
      if (t >= 1) {
        n--;
        if (i !== n) {
          const f6 = n * 6, t6 = i * 6, f3 = n * 3, t3 = i * 3;
          for (let k = 0; k < 6; k++) this.pos[t6 + k] = this.pos[f6 + k];
          for (let k = 0; k < 3; k++) this.base[t3 + k] = this.base[f3 + k];
          this.life[i] = this.life[n]; this.ttl[i] = this.ttl[n];
        }
        i--;
        continue;
      }
      const a = (1 - t) * (1 - t);
      const i6 = i * 6, i3 = i * 3;
      for (let v = 0; v < 2; v++) {
        this.col[i6 + v * 3] = this.base[i3] * a;
        this.col[i6 + v * 3 + 1] = this.base[i3 + 1] * a;
        this.col[i6 + v * 3 + 2] = this.base[i3 + 2] * a;
      }
    }
    this.n = n;
    if (n) {
      this.aPos.addUpdateRange(0, n * 6); this.aPos.needsUpdate = true;
      this.aCol.addUpdateRange(0, n * 6); this.aCol.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, n * 2);
    this.lines.visible = n > 0;
  }

  clear() { this.n = 0; this.geometry.setDrawRange(0, 0); }
}

// --------------------------------------------------------------- facade

export class Effects {
  constructor(scene, assets, preset) {
    this.scene = scene;
    this.preset = preset;
    const B = preset.particleBudget;

    this.sparks = new ParticleField(scene, assets.tex('spark'), Math.floor(B * 0.45), { additive: true });
    this.smoke = new ParticleField(scene, assets.tex('softCircle'), Math.floor(B * 0.3), { additive: false });
    this.blood = new ParticleField(scene, assets.tex('softCircle'), Math.floor(B * 0.35), { additive: false });
    this.dust = new ParticleField(scene, assets.tex('dust'), Math.floor(B * 0.2), { additive: false });
    this.fields = [this.sparks, this.smoke, this.blood, this.dust];

    this.bulletDecals = new DecalField(scene, assets.tex('decalAlbedo'), Math.floor(preset.decalBudget * 0.55));
    this.bloodDecals = new DecalField(scene, assets.tex('disc'), Math.floor(preset.decalBudget * 0.75));

    const gibMat = new THREE.MeshStandardMaterial({
      color: 0x5e1010, roughness: 0.55, metalness: 0.0, envMapIntensity: 0.7,
    });
    this.gibs = new GibField(scene, 120, gibMat);
    this.gibs.onLand = (x, y, z) => {
      if (Math.random() < 0.5) {
        this.bloodDecals.place(
          { x, y: 0.02, z }, UP, rand(0.5, 1.1), 0x6a1a18, 26,
        );
      }
    };

    this.tracers = new TracerField(scene, 160);

    this._v = new THREE.Vector3();
  }

  setFog(color, density) {
    for (const f of this.fields) f.setFog(color, density);
  }

  setViewportHeight(h) {
    for (const f of this.fields) f.setViewportHeight(h);
  }

  // ------------------------------------------------------------ emitters

  /** Muzzle flash: a hot core, a spray of sparks and a puff of smoke. */
  muzzle(pos, dir, scale = 1, color = 0xffcc70) {
    const c = new THREE.Color(color);
    for (let i = 0; i < Math.round(3 * scale); i++) {
      this.sparks.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * rand(2, 7) + gauss() * 1.1,
        vy: dir.y * rand(2, 7) + gauss() * 1.1,
        vz: dir.z * rand(2, 7) + gauss() * 1.1,
        life: rand(0.05, 0.11) * scale, size: rand(0.5, 1.2) * scale,
        drag: 7, gravity: 0.2, grow: 1.5, fadeIn: 0.02,
        r0: c.r * 2.4, g0: c.g * 2.0, b0: c.b * 1.4,
        r1: c.r, g1: c.g * 0.4, b1: 0,
      });
    }
    for (let i = 0; i < Math.round(5 * scale); i++) {
      this.sparks.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * rand(3, 14) + gauss() * 2.4,
        vy: dir.y * rand(3, 14) + gauss() * 2.4,
        vz: dir.z * rand(3, 14) + gauss() * 2.4,
        life: rand(0.12, 0.35), size: rand(0.08, 0.2) * scale,
        drag: 2.4, gravity: 1.1, bounce: false,
        r0: 2.2, g0: 1.3, b0: 0.4, r1: 0.9, g1: 0.15, b1: 0,
      });
    }
    if (scale > 0.6) {
      this.smoke.emit({
        x: pos.x + dir.x * 0.3, y: pos.y + dir.y * 0.3, z: pos.z + dir.z * 0.3,
        vx: dir.x * 2.2 + gauss() * 0.4, vy: dir.y * 2.2 + 0.5, vz: dir.z * 2.2 + gauss() * 0.4,
        life: rand(0.5, 0.9), size: rand(0.5, 0.9) * scale, drag: 2.6, gravity: -0.08,
        grow: 3.2, fadeIn: 0.2,
        r0: 0.35, g0: 0.33, b0: 0.30, r1: 0.12, g1: 0.12, b1: 0.13,
      });
    }
  }

  /** Bullet hitting the world: sparks, dust puff, and a hole. */
  impact(point, normal, kind = 'stone') {
    const metal = kind === 'metal';
    const n = metal ? 10 : 6;
    for (let i = 0; i < n; i++) {
      const sx = normal.x + gauss() * 0.65;
      const sy = normal.y + gauss() * 0.65 + 0.3;
      const sz = normal.z + gauss() * 0.65;
      this.sparks.emit({
        x: point.x, y: point.y, z: point.z,
        vx: sx * rand(2, 9), vy: sy * rand(2, 9), vz: sz * rand(2, 9),
        life: rand(0.15, 0.45), size: rand(0.06, 0.16),
        drag: 1.6, gravity: 1.4, bounce: true,
        r0: metal ? 2.6 : 1.6, g0: metal ? 2.0 : 1.1, b0: metal ? 1.2 : 0.6,
        r1: 0.8, g1: 0.2, b1: 0,
      });
    }
    for (let i = 0; i < 4; i++) {
      this.dust.emit({
        x: point.x, y: point.y, z: point.z,
        vx: normal.x * rand(0.5, 2.2) + gauss() * 0.5,
        vy: normal.y * rand(0.5, 2.2) + gauss() * 0.5 + 0.4,
        vz: normal.z * rand(0.5, 2.2) + gauss() * 0.5,
        life: rand(0.5, 1.1), size: rand(0.25, 0.6), drag: 2.4, gravity: 0.12,
        grow: 2.6, fadeIn: 0.15,
        r0: 0.42, g0: 0.40, b0: 0.36, r1: 0.16, g1: 0.15, b1: 0.14,
      });
    }
    this.bulletDecals.place(point, normal, rand(0.16, 0.30), metal ? 0x707070 : 0x3a3a3a, 30);
  }

  /**
   * Blood. `power` scales the whole thing so a pistol tap and a shotgun blast to
   * the chest are visibly different events.
   */
  bloodBurst(point, dir, power = 1, crit = false) {
    const n = Math.round(clamp(6 + power * 9, 4, 26));
    for (let i = 0; i < n; i++) {
      this.blood.emit({
        x: point.x + gauss() * 0.05, y: point.y + gauss() * 0.05, z: point.z + gauss() * 0.05,
        vx: dir.x * rand(1, 6) * power + gauss() * 1.8,
        vy: dir.y * rand(1, 5) * power + gauss() * 1.8 + 1.2,
        vz: dir.z * rand(1, 6) * power + gauss() * 1.8,
        life: rand(0.5, 1.3), size: rand(0.07, 0.20) * (crit ? 1.5 : 1),
        drag: 0.9, gravity: 1.5, bounce: false, fadeIn: 0.04,
        r0: 0.62, g0: 0.045, b0: 0.035, r1: 0.16, g1: 0.01, b1: 0.01,
      });
    }
    // Fine mist that hangs for a moment — reads as spray rather than droplets.
    for (let i = 0; i < Math.round(n * 0.5); i++) {
      this.blood.emit({
        x: point.x, y: point.y, z: point.z,
        vx: dir.x * rand(0.5, 3) + gauss() * 1.2,
        vy: dir.y * rand(0.5, 3) + gauss() * 1.2 + 0.5,
        vz: dir.z * rand(0.5, 3) + gauss() * 1.2,
        life: rand(0.35, 0.8), size: rand(0.18, 0.45), drag: 3.2, gravity: 0.25,
        grow: 1.8, fadeIn: 0.1,
        r0: 0.38, g0: 0.05, b0: 0.04, r1: 0.10, g1: 0.02, b1: 0.02,
      });
    }
    if (crit || power > 1.4) {
      const g = crit ? 5 : 3;
      for (let i = 0; i < g; i++) {
        this.gibs.spawn(
          point.x, point.y, point.z,
          dir.x * rand(1, 5) + gauss() * 2.2,
          rand(2, 6),
          dir.z * rand(1, 5) + gauss() * 2.2,
          rand(0.6, 1.4), rand(5, 8),
        );
      }
    }
  }

  /** Ground pool under a corpse. */
  bloodPool(x, z, size = 1.4) {
    this.bloodDecals.place({ x, y: 0.02, z }, UP, size, 0x5a1412, 40);
  }

  /** Wall splatter behind a zombie that just took a heavy hit. */
  bloodSplat(point, normal, size = 0.8) {
    this.bloodDecals.place(point, normal, size, 0x6a1614, 30);
  }

  explosion(pos, radius = 4, color = 0xff8a30) {
    const c = new THREE.Color(color);
    for (let i = 0; i < 26; i++) {
      const a = rand(0, TAU), e = rand(-0.2, 1);
      const sp = rand(4, 16) * (radius / 4);
      this.sparks.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: Math.cos(a) * sp * (1 - e * 0.6), vy: e * sp, vz: Math.sin(a) * sp * (1 - e * 0.6),
        life: rand(0.3, 0.9), size: rand(0.15, 0.5) * (radius / 4),
        drag: 1.3, gravity: 1.0, bounce: true, grow: 0.5,
        r0: c.r * 3, g0: c.g * 2.2, b0: c.b * 1.2, r1: 0.6, g1: 0.1, b1: 0,
      });
    }
    for (let i = 0; i < 16; i++) {
      const a = rand(0, TAU);
      this.smoke.emit({
        x: pos.x + Math.cos(a) * rand(0, radius * 0.4), y: pos.y + rand(-0.3, 0.6),
        z: pos.z + Math.sin(a) * rand(0, radius * 0.4),
        vx: Math.cos(a) * rand(1, 5), vy: rand(1.5, 5), vz: Math.sin(a) * rand(1, 5),
        life: rand(1.1, 2.3), size: rand(0.9, 2.0) * (radius / 4),
        drag: 1.5, gravity: -0.15, grow: 3.4, fadeIn: 0.12,
        r0: 0.55, g0: 0.30, b0: 0.16, r1: 0.10, g1: 0.10, b1: 0.11,
      });
    }
    this.bulletDecals.place({ x: pos.x, y: 0.02, z: pos.z }, UP, radius * 0.9, 0x1a1a1a, 45);
  }

  /** Continuous flame cone for the flamethrower. */
  flame(pos, dir, spread = 0.18) {
    for (let i = 0; i < 3; i++) {
      const vx = dir.x * rand(9, 16) + gauss() * spread * 9;
      const vy = dir.y * rand(9, 16) + gauss() * spread * 9 + 0.8;
      const vz = dir.z * rand(9, 16) + gauss() * spread * 9;
      this.sparks.emit({
        x: pos.x, y: pos.y, z: pos.z, vx, vy, vz,
        life: rand(0.28, 0.5), size: rand(0.35, 0.75), drag: 2.6, gravity: -0.3,
        grow: 3.0, fadeIn: 0.08,
        r0: 2.6, g0: 1.5, b0: 0.35, r1: 0.5, g1: 0.06, b1: 0,
      });
    }
    if (Math.random() < 0.5) {
      this.smoke.emit({
        x: pos.x + dir.x * 2, y: pos.y + dir.y * 2 + 0.3, z: pos.z + dir.z * 2,
        vx: dir.x * 4, vy: dir.y * 4 + 1.4, vz: dir.z * 4,
        life: rand(0.9, 1.6), size: rand(0.5, 1.0), drag: 1.9, gravity: -0.25,
        grow: 3.6, fadeIn: 0.25,
        r0: 0.22, g0: 0.20, b0: 0.19, r1: 0.07, g1: 0.07, b1: 0.08,
      });
    }
  }

  /** Ambient embers rising off a burning prop. */
  ember(pos, scale = 1) {
    this.sparks.emit({
      x: pos.x + gauss() * 0.22 * scale, y: pos.y, z: pos.z + gauss() * 0.22 * scale,
      vx: gauss() * 0.35, vy: rand(1.1, 2.6) * scale, vz: gauss() * 0.35,
      life: rand(0.9, 2.0), size: rand(0.05, 0.13), drag: 0.5, gravity: -0.28,
      r0: 2.4, g0: 1.0, b0: 0.15, r1: 0.5, g1: 0.05, b1: 0,
    });
  }

  /** Electric arc for the tesla weapon. */
  arc(from, to, color = 0x66ddff) {
    const steps = 5;
    const a = this._arcA || (this._arcA = new THREE.Vector3());
    const b = this._arcB || (this._arcB = new THREE.Vector3());
    a.copy(from);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      b.lerpVectors(from, to, t);
      if (i < steps) {
        b.x += gauss() * 0.35; b.y += gauss() * 0.35; b.z += gauss() * 0.35;
      }
      this.tracers.add(a, b, color, 0.09);
      a.copy(b);
    }
  }

  tracer(from, to, color = 0xffd08a, ttl = 0.05) {
    this.tracers.add(from, to, color, ttl);
  }

  /** Dust kicked up by a footfall. */
  footDust(x, z, scale = 1) {
    this.dust.emit({
      x: x + gauss() * 0.12, y: 0.05, z: z + gauss() * 0.12,
      vx: gauss() * 0.35, vy: rand(0.2, 0.7), vz: gauss() * 0.35,
      life: rand(0.4, 0.9), size: rand(0.15, 0.35) * scale, drag: 3.2, gravity: 0.1,
      grow: 2.4, fadeIn: 0.2,
      r0: 0.30, g0: 0.28, b0: 0.25, r1: 0.10, g1: 0.10, b1: 0.10,
    });
  }

  update(dt) {
    for (const f of this.fields) f.update(dt);
    this.gibs.update(dt);
    this.tracers.update(dt);
    this.bulletDecals.update(dt);
    this.bloodDecals.update(dt);
  }

  clear() {
    for (const f of this.fields) f.clear();
    this.gibs.clear();
    this.tracers.clear();
    this.bulletDecals.clear();
    this.bloodDecals.clear();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
