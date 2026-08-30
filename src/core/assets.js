import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/**
 * Loads the downloaded asset pack with a real progress signal.
 *
 * Textures get correct colour spaces (sRGB for albedo, linear for data maps),
 * repeat wrapping and anisotropy applied once here rather than at every use
 * site, and height maps are converted to tangent-space normal maps on a worker-
 * free canvas pass so the brick/wood sets light properly instead of looking flat.
 */
export class AssetManager {
  constructor(renderer) {
    this.renderer = renderer;
    this.textures = new Map();
    this.models = new Map();
    this.hdri = new Map();
    this.buffers = new Map();
    this.maxAnisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
    this.anisotropy = Math.min(8, this.maxAnisotropy);
    this.onProgress = null;
    this._done = 0;
    this._total = 0;
  }

  _tick(label) {
    this._done++;
    if (this.onProgress) this.onProgress(this._done / Math.max(1, this._total), label);
  }

  async loadAll(manifest, { anisotropy = 8 } = {}) {
    this.anisotropy = Math.min(anisotropy, this.maxAnisotropy);
    const jobs = [];
    this._total =
      manifest.textures.length + manifest.models.length +
      manifest.hdri.length + (manifest.buffers?.length || 0);
    this._done = 0;

    for (const t of manifest.textures) jobs.push(this._loadTexture(t));
    for (const m of manifest.models) jobs.push(this._loadModel(m));
    for (const h of manifest.hdri) jobs.push(this._loadHDRI(h));
    for (const b of manifest.buffers || []) jobs.push(this._loadBuffer(b));

    await Promise.all(jobs);
    return this;
  }

  _loadTexture(spec) {
    const { key, url, srgb = false, repeat = [1, 1], flipY = true } = spec;
    return new Promise((resolve) => {
      new THREE.TextureLoader().load(
        url,
        (tex) => {
          tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(repeat[0], repeat[1]);
          tex.anisotropy = this.anisotropy;
          tex.flipY = flipY;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.needsUpdate = true;
          this.textures.set(key, tex);
          this._tick(key);
          resolve(tex);
        },
        undefined,
        () => { this._tick(key); resolve(null); },
      );
    });
  }

  _loadModel(spec) {
    const { key, url } = spec;
    return new Promise((resolve) => {
      new GLTFLoader().load(
        url,
        (gltf) => { this.models.set(key, gltf); this._tick(key); resolve(gltf); },
        undefined,
        () => { this._tick(key); resolve(null); },
      );
    });
  }

  _loadHDRI(spec) {
    const { key, url } = spec;
    return new Promise((resolve) => {
      new HDRLoader().load(
        url,
        (tex) => {
          tex.mapping = THREE.EquirectangularReflectionMapping;
          this.hdri.set(key, tex);
          this._tick(key);
          resolve(tex);
        },
        undefined,
        () => { this._tick(key); resolve(null); },
      );
    });
  }

  async _loadBuffer(spec) {
    try {
      const res = await fetch(spec.url);
      this.buffers.set(spec.key, await res.arrayBuffer());
    } catch { /* optional asset — the game runs fine without it */ }
    this._tick(spec.key);
  }

  tex(key) { return this.textures.get(key) || null; }
  model(key) { return this.models.get(key) || null; }

  /**
   * Returns a cloned texture with its own repeat/offset. Textures are shared
   * GPU uploads; only the sampler state is duplicated, so this is nearly free.
   */
  tiled(key, u, v = u, { srgb = null } = {}) {
    const src = this.textures.get(key);
    if (!src) return null;
    const t = src.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(u, v);
    t.anisotropy = this.anisotropy;
    if (srgb !== null) t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /**
   * Sobel-filters a greyscale height map into a tangent-space normal map.
   * The three.js brick/wood sets ship bump maps only; real normal maps give a
   * far stronger sense of relief under the flashlight.
   */
  normalFromHeight(key, outKey, strength = 2.2) {
    const src = this.textures.get(key);
    if (!src || !src.image) return null;
    const img = src.image;
    const w = Math.min(img.width || 512, 1024);
    const h = Math.min(img.height || 512, 1024);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const sd = ctx.getImageData(0, 0, w, h);
    const s = sd.data;
    const out = ctx.createImageData(w, h);
    const o = out.data;

    const at = (x, y) => {
      const xi = (x + w) % w, yi = (y + h) % h;
      const i = (yi * w + xi) * 4;
      return (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) / 255;
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
        const l = at(x - 1, y), r = at(x + 1, y);
        const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
        const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        let nx = -dx * strength, ny = -dy * strength, nz = 1;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv; ny *= inv; nz *= inv;
        const i = (y * w + x) * 4;
        o[i] = (nx * 0.5 + 0.5) * 255;
        o[i + 1] = (ny * 0.5 + 0.5) * 255;
        o[i + 2] = (nz * 0.5 + 0.5) * 255;
        o[i + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);

    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = this.anisotropy;
    tex.needsUpdate = true;
    this.textures.set(outKey, tex);
    return tex;
  }

  /** Prefilters an HDRI into a PMREM environment map for image-based lighting. */
  environment(key) {
    const hdr = this.hdri.get(key);
    if (!hdr) return null;
    const cached = this.hdri.get(key + ':env');
    if (cached) return cached;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const env = pmrem.fromEquirectangular(hdr).texture;
    pmrem.dispose();
    this.hdri.set(key + ':env', env);
    return env;
  }

  dispose() {
    for (const t of this.textures.values()) t.dispose?.();
    for (const t of this.hdri.values()) t.dispose?.();
    this.textures.clear(); this.hdri.clear(); this.models.clear();
  }
}

/** The asset pack, as written to disk by tools/fetch-assets.mjs. */
export const MANIFEST = {
  textures: [
    { key: 'brickAlbedo', url: 'assets/textures/brick_albedo.jpg', srgb: true },
    { key: 'brickBump', url: 'assets/textures/brick_bump.jpg' },
    { key: 'brickRough', url: 'assets/textures/brick_rough.jpg' },
    { key: 'woodAlbedo', url: 'assets/textures/wood_albedo.jpg', srgb: true },
    { key: 'woodBump', url: 'assets/textures/wood_bump.jpg' },
    { key: 'woodRough', url: 'assets/textures/wood_rough.jpg' },
    { key: 'tileAlbedo', url: 'assets/textures/tile_albedo.jpg', srgb: true },
    { key: 'tileNormal', url: 'assets/textures/tile_normal.jpg' },
    { key: 'carbonAlbedo', url: 'assets/textures/carbon_albedo.png', srgb: true },
    { key: 'carbonNormal', url: 'assets/textures/carbon_normal.png' },
    { key: 'grunge', url: 'assets/textures/grunge.jpg', srgb: true },
    { key: 'roughDetail', url: 'assets/textures/rough_detail.jpg' },
    { key: 'perlin', url: 'assets/textures/perlin.png' },
    { key: 'wetNormal', url: 'assets/textures/wet_normal.jpg' },
    { key: 'grassAlbedo', url: 'assets/textures/grass_albedo.jpg', srgb: true },
    { key: 'ember', url: 'assets/textures/ember.jpg', srgb: true },
    { key: 'moon', url: 'assets/textures/moon.jpg', srgb: true },
    { key: 'decalAlbedo', url: 'assets/textures/decal_albedo.png', srgb: true },
    { key: 'decalNormal', url: 'assets/textures/decal_normal.jpg' },
    { key: 'spark', url: 'assets/textures/spark.png', srgb: true },
    { key: 'softCircle', url: 'assets/textures/soft_circle.png', srgb: true },
    { key: 'disc', url: 'assets/textures/disc.png', srgb: true },
    { key: 'dust', url: 'assets/textures/dust.png', srgb: true },
  ],
  models: [
    { key: 'soldier', url: 'assets/models/soldier.glb' },
    { key: 'xbot', url: 'assets/models/xbot.glb' },
    { key: 'lantern', url: 'assets/models/lantern.glb' },
    { key: 'brokenWindow', url: 'assets/models/broken_window.glb' },
    { key: 'trafficCone', url: 'assets/models/trafficcone/TrafficCone.gltf' },
  ],
  hdri: [
    { key: 'night', url: 'assets/hdri/moonless_night_1k.hdr' },
    { key: 'dusk', url: 'assets/hdri/blood_dusk_1k.hdr' },
  ],
  buffers: [
    { key: 'ambience', url: 'assets/sounds/ambience.ogg' },
  ],
};
