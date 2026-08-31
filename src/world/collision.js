import * as THREE from 'three';

/**
 * Yaw-aligned box collider. Everything solid in the level is one of these.
 *
 * Keeping collision analytic (rather than raycasting the render meshes) means
 * bullet tests and character pushes are a handful of floating point ops against
 * a flat array — no BVH, no per-triangle work, and it stays fast with a hundred
 * zombies all resolving against the world every frame.
 */
export class Box {
  constructor(cx, y0, cz, hx, hz, y1, rot = 0, tag = 'world') {
    this.cx = cx; this.cz = cz;
    this.hx = hx; this.hz = hz;
    this.y0 = y0; this.y1 = y1;
    this.rot = rot;
    this.cos = Math.cos(rot); this.sin = Math.sin(rot);
    this.tag = tag;
    // Broad-phase circle, so most tests reject with one distance compare.
    this.br = Math.hypot(hx, hz);
    // Query stamp, so a box that spans four grid cells is only collected once
    // per query without scanning the results so far. See `near`.
    this._seen = 0;
  }

  toLocal(x, z, out) {
    const dx = x - this.cx, dz = z - this.cz;
    out.x = dx * this.cos + dz * this.sin;
    out.z = -dx * this.sin + dz * this.cos;
    return out;
  }

  toWorldDir(x, z, out) {
    out.x = x * this.cos - z * this.sin;
    out.z = x * this.sin + z * this.cos;
    return out;
  }

  containsXZ(x, z, pad = 0) {
    if ((x - this.cx) ** 2 + (z - this.cz) ** 2 > (this.br + pad) ** 2) return false;
    const dx = x - this.cx, dz = z - this.cz;
    const lx = dx * this.cos + dz * this.sin;
    const lz = -dx * this.sin + dz * this.cos;
    return Math.abs(lx) <= this.hx + pad && Math.abs(lz) <= this.hz + pad;
  }
}

const _l = { x: 0, z: 0 };
const _d = { x: 0, z: 0 };

/** Spatial hash over the XZ plane. Cheap to build, cheap to query. */
export class CollisionWorld {
  constructor(cell = 6) {
    this.boxes = [];
    this.cell = cell;
    this.grid = new Map();
    this._nearStamp = 0;
  }

  add(box) {
    this.boxes.push(box);
    const r = box.br;
    const x0 = Math.floor((box.cx - r) / this.cell), x1 = Math.floor((box.cx + r) / this.cell);
    const z0 = Math.floor((box.cz - r) / this.cell), z1 = Math.floor((box.cz + r) / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const k = x * 73856093 ^ z * 19349663;
        let arr = this.grid.get(k);
        if (!arr) { arr = []; this.grid.set(k, arr); }
        arr.push(box);
      }
    }
    return box;
  }

  /**
   * Boxes near a point, written into `out` (reused array).
   *
   * Deduplicated by a per-query stamp rather than by scanning `out`. That was
   * a linear search per candidate — fine at a handful of calls a frame, which
   * is what this had when only characters and bullets used it, and quadratic
   * in the wrong place now that a few hundred blood droplets sweep themselves
   * against the level every step.
   */
  near(x, z, radius, out) {
    out.length = 0;
    const c = this.cell;
    const stamp = ++this._nearStamp;
    const x0 = Math.floor((x - radius) / c), x1 = Math.floor((x + radius) / c);
    const z0 = Math.floor((z - radius) / c), z1 = Math.floor((z + radius) / c);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const arr = this.grid.get(gx * 73856093 ^ gz * 19349663);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const b = arr[i];
          if (b._seen === stamp) continue;
          b._seen = stamp;
          out.push(b);
        }
      }
    }
    return out;
  }

  /**
   * Pushes a vertical cylinder out of every box it overlaps.
   * Returns true if anything moved. `pos` is mutated in place.
   */
  resolveCircle(pos, radius, feetY, headY, scratch = []) {
    this.near(pos.x, pos.z, radius + 2, scratch);
    let moved = false;
    for (let i = 0; i < scratch.length; i++) {
      const b = scratch[i];
      if (headY <= b.y0 || feetY >= b.y1) continue;

      b.toLocal(pos.x, pos.z, _l);
      // Closest point on the box to the circle centre, in box space.
      const qx = Math.max(-b.hx, Math.min(b.hx, _l.x));
      const qz = Math.max(-b.hz, Math.min(b.hz, _l.z));
      let dx = _l.x - qx, dz = _l.z - qz;
      let d2 = dx * dx + dz * dz;

      if (d2 > radius * radius) continue;

      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        const push = radius - d;
        dx /= d; dz /= d;
        b.toWorldDir(dx * push, dz * push, _d);
        pos.x += _d.x; pos.z += _d.z;
      } else {
        // Centre is inside: eject along the shallowest axis.
        const ox = b.hx - Math.abs(_l.x);
        const oz = b.hz - Math.abs(_l.z);
        if (ox < oz) b.toWorldDir(Math.sign(_l.x || 1) * (ox + radius), 0, _d);
        else b.toWorldDir(0, Math.sign(_l.z || 1) * (oz + radius), _d);
        pos.x += _d.x; pos.z += _d.z;
      }
      moved = true;
    }
    return moved;
  }

  /**
   * Segment sweep for a point-sized body, accelerated by the grid.
   *
   * `raycast` walks every box in the level, which is right for a bullet fired
   * a few times a second and badly wrong for two hundred blood droplets asking
   * every frame. This walks only the cells the segment passes near, and writes
   * into a caller-owned result so a full frame of droplet collision allocates
   * nothing.
   *
   * Returns the fraction along the segment at which it hit, or -1.
   */
  sweepPoint(px, py, pz, qx, qy, qz, out) {
    const dx = qx - px, dy = qy - py, dz = qz - pz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return -1;

    const scratch = this._sweepNear || (this._sweepNear = []);
    this.near((px + qx) * 0.5, (pz + qz) * 0.5, len * 0.5 + 0.5, scratch);

    let best = 1;
    let hit = null, hitAxis = -1, hitSign = 1;

    for (let i = 0; i < scratch.length; i++) {
      const b = scratch[i];
      // Vertical reject first: most boxes in a cell are the wrong height.
      if (Math.max(py, qy) < b.y0 || Math.min(py, qy) > b.y1) continue;

      const ox = px - b.cx, oz = pz - b.cz;
      const lox = ox * b.cos + oz * b.sin;
      const loz = -ox * b.sin + oz * b.cos;
      const ldx = dx * b.cos + dz * b.sin;
      const ldz = -dx * b.sin + dz * b.cos;

      let tmin = 0, tmax = best;
      let axis = -1, sign = 1;

      if (Math.abs(ldx) < 1e-9) {
        if (Math.abs(lox) > b.hx) continue;
      } else {
        const inv = 1 / ldx;
        let t1 = (-b.hx - lox) * inv, t2 = (b.hx - lox) * inv, s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = 0; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) continue;
      }

      if (Math.abs(dy) < 1e-9) {
        if (py < b.y0 || py > b.y1) continue;
      } else {
        const inv = 1 / dy;
        let t1 = (b.y0 - py) * inv, t2 = (b.y1 - py) * inv, s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) continue;
      }

      if (Math.abs(ldz) < 1e-9) {
        if (Math.abs(loz) > b.hz) continue;
      } else {
        const inv = 1 / ldz;
        let t1 = (-b.hz - loz) * inv, t2 = (b.hz - loz) * inv, s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = 2; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) continue;
      }

      if (tmin >= 0 && tmin < best) {
        best = tmin; hit = b; hitAxis = axis; hitSign = sign;
      }
    }

    if (!hit) return -1;

    out.t = best;
    out.box = hit;
    out.x = px + dx * best;
    out.y = py + dy * best;
    out.z = pz + dz * best;
    if (hitAxis === 1) { out.nx = 0; out.ny = hitSign; out.nz = 0; }
    else if (hitAxis === 0) {
      hit.toWorldDir(hitSign, 0, _d);
      out.nx = _d.x; out.ny = 0; out.nz = _d.z;
    } else {
      hit.toWorldDir(0, hitSign, _d);
      out.nx = _d.x; out.ny = 0; out.nz = _d.z;
    }
    return best;
  }

  /**
   * Slab-method ray/OBB test across every box. Returns the nearest hit or null.
   * Used for bullets, line-of-sight and viewmodel wall pull-back.
   */
  raycast(origin, dir, maxDist, out = {}) {
    let best = maxDist;
    let hit = null;

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];

      // Ray into box space (yaw only, so Y is untouched).
      const ox = origin.x - b.cx, oz = origin.z - b.cz;
      const lox = ox * b.cos + oz * b.sin;
      const loz = -ox * b.sin + oz * b.cos;
      const ldx = dir.x * b.cos + dir.z * b.sin;
      const ldz = -dir.x * b.sin + dir.z * b.cos;

      let tmin = 0, tmax = best;
      let axis = -1, sign = 1;

      // X slab
      if (Math.abs(ldx) < 1e-8) {
        if (Math.abs(lox) > b.hx) continue;
      } else {
        const inv = 1 / ldx;
        let t1 = (-b.hx - lox) * inv, t2 = (b.hx - lox) * inv;
        let s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = 0; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) continue;
      }

      // Y slab (world aligned)
      if (Math.abs(dir.y) < 1e-8) {
        if (origin.y < b.y0 || origin.y > b.y1) continue;
      } else {
        const inv = 1 / dir.y;
        let t1 = (b.y0 - origin.y) * inv, t2 = (b.y1 - origin.y) * inv;
        let s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) continue;
      }

      // Z slab
      if (Math.abs(ldz) < 1e-8) {
        if (Math.abs(loz) > b.hz) continue;
      } else {
        const inv = 1 / ldz;
        let t1 = (-b.hz - loz) * inv, t2 = (b.hz - loz) * inv;
        let s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = 2; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) continue;
      }

      if (tmin > 0 && tmin < best) {
        best = tmin;
        hit = b;
        out.axis = axis; out.sign = sign;
      }
    }

    if (!hit) return null;
    out.distance = best;
    out.box = hit;
    out.point = out.point || new THREE.Vector3();
    out.normal = out.normal || new THREE.Vector3();
    out.point.set(
      origin.x + dir.x * best,
      origin.y + dir.y * best,
      origin.z + dir.z * best,
    );
    if (out.axis === 1) out.normal.set(0, out.sign, 0);
    else if (out.axis === 0) {
      hit.toWorldDir(out.sign, 0, _d);
      out.normal.set(_d.x, 0, _d.z);
    } else {
      hit.toWorldDir(0, out.sign, _d);
      out.normal.set(_d.x, 0, _d.z);
    }
    return out;
  }

  /** True if nothing solid sits between two points. */
  visible(a, b, ignoreTag = null) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.001) return true;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    const hit = this.raycast(a, dir, dist - 0.05, this._losOut || (this._losOut = {}));
    if (!hit) return true;
    return ignoreTag !== null && hit.box.tag === ignoreTag;
  }
}

/**
 * Flow-field pathfinding.
 *
 * A breadth-first wavefront from the player floods a coarse walkability grid
 * once every few frames; each zombie then reads one vector out of the field.
 * That makes pathing O(1) per zombie instead of O(path length), so the horde
 * navigates real corners and doorways at zero measurable cost even at 60+ agents.
 */
export class FlowField {
  constructor(halfExtent = 62, cellSize = 1.25) {
    this.cell = cellSize;
    this.half = halfExtent;
    this.n = Math.ceil((halfExtent * 2) / cellSize);
    const n2 = this.n * this.n;
    this.blocked = new Uint8Array(n2);
    this.dist = new Int32Array(n2);
    this.flowX = new Float32Array(n2);
    this.flowZ = new Float32Array(n2);
    this.queue = new Int32Array(n2);
    this.version = 0;
    this._lastCell = -1;
  }

  idx(ix, iz) { return iz * this.n + ix; }
  toCellX(x) { return Math.floor((x + this.half) / this.cell); }
  toCellZ(z) { return Math.floor((z + this.half) / this.cell); }
  cellCenterX(ix) { return ix * this.cell - this.half + this.cell * 0.5; }
  cellCenterZ(iz) { return iz * this.cell - this.half + this.cell * 0.5; }
  inBounds(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.n && iz < this.n; }

  /** Bakes level colliders into walkability. `agentRadius` inflates obstacles. */
  bake(collision, agentRadius = 0.45, stepHeight = 0.55) {
    this.blocked.fill(0);
    const scratch = [];
    for (let iz = 0; iz < this.n; iz++) {
      for (let ix = 0; ix < this.n; ix++) {
        const x = this.cellCenterX(ix), z = this.cellCenterZ(iz);
        collision.near(x, z, agentRadius + 1, scratch);
        let solid = 0;
        for (let i = 0; i < scratch.length; i++) {
          const b = scratch[i];
          // Anything a zombie can simply walk over is not an obstacle.
          if (b.y1 <= stepHeight) continue;
          if (b.containsXZ(x, z, agentRadius)) { solid = 1; break; }
        }
        this.blocked[this.idx(ix, iz)] = solid;
      }
    }
    return this;
  }

  /** Marks the arena rim solid so nothing wanders out of the level. */
  sealBorder(thickness = 1) {
    for (let i = 0; i < this.n; i++) {
      for (let t = 0; t < thickness; t++) {
        this.blocked[this.idx(i, t)] = 1;
        this.blocked[this.idx(i, this.n - 1 - t)] = 1;
        this.blocked[this.idx(t, i)] = 1;
        this.blocked[this.idx(this.n - 1 - t, i)] = 1;
      }
    }
  }

  walkable(x, z) {
    const ix = this.toCellX(x), iz = this.toCellZ(z);
    if (!this.inBounds(ix, iz)) return false;
    return this.blocked[this.idx(ix, iz)] === 0;
  }

  /** Wavefront flood from the target. Returns false when nothing changed. */
  compute(tx, tz, force = false) {
    let ix = this.toCellX(tx), iz = this.toCellZ(tz);
    ix = Math.max(1, Math.min(this.n - 2, ix));
    iz = Math.max(1, Math.min(this.n - 2, iz));
    const start = this.idx(ix, iz);
    if (!force && start === this._lastCell) return false;
    this._lastCell = start;

    const { dist, blocked, queue, n } = this;
    dist.fill(-1);

    // If the player stands in a sealed cell (mid-collider), spiral out to the
    // nearest walkable one so the field is never empty.
    let seed = start;
    if (blocked[seed]) {
      let found = -1;
      for (let r = 1; r < 8 && found < 0; r++) {
        for (let dz = -r; dz <= r && found < 0; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const jx = ix + dx, jz = iz + dz;
            if (!this.inBounds(jx, jz)) continue;
            const k = this.idx(jx, jz);
            if (!blocked[k]) { found = k; break; }
          }
        }
      }
      if (found < 0) return false;
      seed = found;
    }

    let head = 0, tail = 0;
    queue[tail++] = seed;
    dist[seed] = 0;

    while (head < tail) {
      const cur = queue[head++];
      const cd = dist[cur];
      const cx = cur % n, cz = (cur / n) | 0;

      for (let k = 0; k < 8; k++) {
        const nx = cx + NX[k], nz = cz + NZ[k];
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nz * n + nx;
        if (dist[ni] !== -1 || blocked[ni]) continue;
        // Do not let diagonals cut through the corner of a wall.
        if (k >= 4 && (blocked[cz * n + nx] || blocked[nz * n + cx])) continue;
        dist[ni] = cd + (k >= 4 ? 3 : 2);
        queue[tail++] = ni;
      }
    }

    this._buildVectors();
    this.version++;
    return true;
  }

  /** Steepest-descent direction per cell, precomputed once per flood. */
  _buildVectors() {
    const { dist, blocked, flowX, flowZ, n } = this;
    for (let iz = 1; iz < n - 1; iz++) {
      for (let ix = 1; ix < n - 1; ix++) {
        const i = iz * n + ix;
        if (blocked[i] || dist[i] < 0) { flowX[i] = 0; flowZ[i] = 0; continue; }
        let bestD = dist[i], bx = 0, bz = 0;
        for (let k = 0; k < 8; k++) {
          const ni = (iz + NZ[k]) * n + (ix + NX[k]);
          const d = dist[ni];
          if (d < 0 || blocked[ni]) continue;
          if (d < bestD) { bestD = d; bx = NX[k]; bz = NZ[k]; }
        }
        const len = Math.hypot(bx, bz) || 1;
        flowX[i] = bx / len;
        flowZ[i] = bz / len;
      }
    }
  }

  /** Bilinear sample of the flow field, so agents steer smoothly across cells. */
  sample(x, z, out) {
    const fx = (x + this.half) / this.cell - 0.5;
    const fz = (z + this.half) / this.cell - 0.5;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    let vx = 0, vz = 0;
    for (let dz = 0; dz <= 1; dz++) {
      for (let dx = 0; dx <= 1; dx++) {
        const jx = ix + dx, jz = iz + dz;
        if (!this.inBounds(jx, jz)) continue;
        const i = this.idx(jx, jz);
        const w = (dx ? tx : 1 - tx) * (dz ? tz : 1 - tz);
        vx += this.flowX[i] * w;
        vz += this.flowZ[i] * w;
      }
    }
    const len = Math.hypot(vx, vz);
    if (len > 0.0001) { out.x = vx / len; out.z = vz / len; }
    else { out.x = 0; out.z = 0; }
    return out;
  }

  /** Grid distance to the target, in metres. -1 when unreachable. */
  distanceAt(x, z) {
    const ix = this.toCellX(x), iz = this.toCellZ(z);
    if (!this.inBounds(ix, iz)) return -1;
    const d = this.dist[this.idx(ix, iz)];
    return d < 0 ? -1 : (d / 2) * this.cell;
  }

  reachable(x, z) { return this.distanceAt(x, z) >= 0; }
}

const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NZ = [0, 0, 1, -1, 1, -1, 1, -1];
