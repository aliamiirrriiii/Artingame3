import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Downloaded prop models, prepared for instanced placement.
 *
 * These are real photogrammetry-grade glTF assets, which is a different problem
 * from the procedural level geometry: they arrive at arbitrary scale and
 * orientation, sometimes wrapped in a demo scene (the traffic cone ships with a
 * 19.7 m ground plane, a camera and a light), and with materials authored for a
 * product-viewer rather than a night-time horror game.
 *
 * So `prepare()` does four things: pull out only the nodes that are the actual
 * object, bake each mesh's transform into its geometry, normalise the result to
 * a real-world height with its base on the ground, and hand the materials to a
 * caller-supplied tweak so a showroom-white window frame can be made filthy.
 *
 * Everything is then drawn with InstancedMesh — fourteen street lamps cost one
 * draw call, not fourteen.
 */
export class PropLibrary {
  constructor(scene, assets, preset) {
    this.scene = scene;
    this.assets = assets;
    this.preset = preset;
    this.prepared = new Map();
    this.meshes = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  /**
   * @param {string} key           asset key of the loaded glTF
   * @param {object} opts
   *   include      node names to keep (default: the whole scene)
   *   orient       [x,y,z] radians applied before measuring, for assets that
   *                are not Y-up (the traffic cone is authored Z-up, so without
   *                this it is normalised across its width and laid on its side)
   *   targetHeight metres the prop should stand, measured on Y
   *   merge        merge parts that share a material into one geometry
   *   material     (mat, name) => mat|null — return a replacement, or mutate
   *   markers      { name: nodeName } — local-space points to remember,
   *                e.g. where a lamp's bulb sits so a light can be put there
   */
  prepare(key, opts = {}) {
    if (this.prepared.has(key)) return this.prepared.get(key);
    const gltf = this.assets.model(key);
    if (!gltf) return null;

    const {
      include = null, targetHeight = null, merge = true,
      material = null, markers = null, orient = null,
    } = opts;

    const src = gltf.scene.clone(true);
    // Correct the model's up-axis before anything is measured, so
    // `targetHeight` really is a height.
    if (orient) src.rotation.set(orient[0] || 0, orient[1] || 0, orient[2] || 0);
    src.updateMatrixWorld(true);

    // Keep only the requested nodes.
    let roots = [src];
    if (include) {
      roots = include.map((n) => findNode(src, n)).filter(Boolean);
      if (!roots.length) {
        console.warn(`[props] ${key}: none of [${include}] found; using whole scene`);
        roots = [src];
      }
    }

    // Measure before normalising.
    const box = new THREE.Box3();
    for (const r of roots) box.expandByObject(r);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);

    const scale = targetHeight ? targetHeight / Math.max(1e-6, size.y) : 1;
    // Base on the ground, centred in XZ.
    const norm = new THREE.Matrix4().makeTranslation(
      -center.x * scale, -box.min.y * scale, -center.z * scale,
    ).multiply(new THREE.Matrix4().makeScale(scale, scale, scale));

    const parts = [];
    const collect = (obj) => {
      obj.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const geo = o.geometry.clone();
        geo.applyMatrix4(this._m.copy(norm).multiply(o.matrixWorld));
        let mat = Array.isArray(o.material) ? o.material[0] : o.material;
        if (material) {
          const replaced = material(mat, mat.name || o.name, o.name);
          if (replaced) mat = replaced;
        }
        parts.push({ geometry: geo, material: mat, name: o.name });
      });
    };
    for (const r of roots) collect(r);

    // Merge parts sharing a material and an attribute layout: the lantern's
    // body, chain and lantern all use one material, so they become one mesh.
    let finalParts = parts;
    if (merge && parts.length > 1) {
      const groups = new Map();
      for (const p of parts) {
        const layout = Object.keys(p.geometry.attributes).sort().join(',');
        const k = `${p.material.uuid}|${layout}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
      }
      finalParts = [];
      for (const group of groups.values()) {
        if (group.length === 1) { finalParts.push(group[0]); continue; }
        const merged = mergeGeometries(group.map((p) => p.geometry), false);
        if (merged) {
          for (const p of group) p.geometry.dispose();
          finalParts.push({ geometry: merged, material: group[0].material, name: group[0].name });
        } else {
          finalParts.push(...group);
        }
      }
    }

    // Marker points, in normalised local space.
    const marks = {};
    if (markers) {
      for (const [label, nodeName] of Object.entries(markers)) {
        const node = findNode(src, nodeName);
        if (!node) { console.warn(`[props] ${key}: marker node "${nodeName}" not found`); continue; }
        const b = new THREE.Box3().setFromObject(node);
        const c = new THREE.Vector3(); b.getCenter(c);
        marks[label] = c.applyMatrix4(norm);
      }
    }

    let tris = 0;
    for (const p of finalParts) {
      tris += (p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count) / 3;
    }

    const result = {
      key, parts: finalParts, markers: marks,
      size: size.multiplyScalar(scale),
      tris: Math.round(tris),
    };
    this.prepared.set(key, result);
    return result;
  }

  /**
   * Draws `placements` copies of a prepared prop.
   * @param {Array} placements [{ x, y, z, rotY, scale, tiltX, tiltZ }]
   */
  place(prep, placements, { castShadow = true, receiveShadow = true, name = 'prop' } = {}) {
    if (!prep || !placements.length) return [];
    const made = [];

    for (const part of prep.parts) {
      const inst = new THREE.InstancedMesh(part.geometry, part.material, placements.length);
      inst.name = `prop:${name}:${part.name}`;
      inst.castShadow = castShadow;
      inst.receiveShadow = receiveShadow;
      // The arena is small enough that per-instance culling is not worth the
      // bookkeeping; a single always-visible batch is cheaper.
      inst.frustumCulled = false;
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      placements.forEach((p, i) => {
        const e = new THREE.Euler(p.tiltX || 0, p.rotY || 0, p.tiltZ || 0, 'YXZ');
        this._q.setFromEuler(e);
        this._v.set(p.x, p.y || 0, p.z);
        const s = p.scale ?? 1;
        this._s.set(s, s, s);
        this._m.compose(this._v, this._q, this._s);
        inst.setMatrixAt(i, this._m);
      });
      inst.instanceMatrix.needsUpdate = true;

      this.scene.add(inst);
      this.meshes.push(inst);
      made.push(inst);
    }
    return made;
  }

  /** World position of a prop marker for a given placement. */
  markerWorld(prep, label, placement, out = new THREE.Vector3()) {
    const local = prep?.markers?.[label];
    if (!local) return out.set(placement.x, placement.y || 0, placement.z);
    out.copy(local);
    const s = placement.scale ?? 1;
    out.multiplyScalar(s);
    out.applyAxisAngle(UP, placement.rotY || 0);
    out.x += placement.x; out.y += placement.y || 0; out.z += placement.z;
    return out;
  }

  get triangleCount() {
    let t = 0;
    for (const m of this.meshes) {
      const g = m.geometry;
      t += ((g.index ? g.index.count : g.attributes.position.count) / 3) * m.count;
    }
    return Math.round(t);
  }

  dispose() {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.dispose();
    }
    this.meshes.length = 0;
    this.prepared.clear();
  }
}

/**
 * Node lookup that tolerates glTF name sanitising. three's loader runs names
 * through PropertyBinding.sanitizeNodeName, which turns spaces into
 * underscores and strips reserved characters — so the "Cone Normal" node in
 * the source file arrives as "Cone_Normal".
 */
function findNode(root, name) {
  const direct = root.getObjectByName(name);
  if (direct) return direct;
  const norm = (s) => String(s).toLowerCase().replace(/[\s_.:/[\]]/g, '');
  const want = norm(name);
  let found = null;
  root.traverse((o) => { if (!found && o.name && norm(o.name) === want) found = o; });
  return found;
}

const UP = new THREE.Vector3(0, 1, 0);
