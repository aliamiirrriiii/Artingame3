import * as THREE from 'three';

/**
 * The material library.
 *
 * Two things do most of the heavy lifting for image quality here:
 *
 *  1. Height maps that shipped without normal maps are converted to real
 *     tangent-space normals at load (see AssetManager.normalFromHeight), so
 *     brick and wood catch the flashlight with actual relief.
 *
 *  2. Every large tiled surface gets a "detail breakup" injected into its
 *     shader — a low-frequency noise lookup at a different scale that modulates
 *     albedo and roughness. It costs one texture fetch and completely destroys
 *     the visible repetition you would otherwise get from a 1k texture stretched
 *     over a 90 m street.
 */
export class MaterialLibrary {
  constructor(assets) {
    this.assets = assets;
    this.cache = new Map();
    this.noise = assets.tex('perlin');
    if (this.noise) {
      this.noise.wrapS = this.noise.wrapT = THREE.RepeatWrapping;
    }
    this._build();
  }

  /**
   * Injects large-scale variation into a standard material. `scale` is in world
   * units (metres per noise tile) because the lookup is done in world space,
   * which also means adjacent surfaces blend continuously instead of each
   * showing their own tiling seam.
   */
  breakup(mat, { scale = 14, albedo = 0.32, rough = 0.28, tint = null } = {}) {
    if (!this.noise) return mat;
    const uniforms = {
      uNoise: { value: this.noise },
      uNoiseScale: { value: 1 / scale },
      uAlbedoVar: { value: albedo },
      uRoughVar: { value: rough },
      uTint: { value: new THREE.Color(tint ?? 0xffffff) },
    };
    mat.userData.breakupUniforms = uniforms;

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n varying vec3 vWorldPosBreakup;`)
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vWorldPosBreakup = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
        );

      // worldpos_vertex only emits when needed; guarantee we have the value.
      if (!shader.vertexShader.includes('vWorldPosBreakup = (')) {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          `vWorldPosBreakup = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
           #include <project_vertex>`,
        );
      }

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWorldPosBreakup;
          uniform sampler2D uNoise;
          uniform float uNoiseScale;
          uniform float uAlbedoVar;
          uniform float uRoughVar;
          uniform vec3  uTint;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 bpW = vWorldPosBreakup * uNoiseScale;
          float bpA = texture2D( uNoise, bpW.xz ).r;
          float bpB = texture2D( uNoise, bpW.xz * 0.31 + 0.37 ).g;
          float bpC = texture2D( uNoise, bpW.xz * 3.7 + 0.11 ).b;
          float grime = mix( bpA, bpB, 0.5 );
          diffuseColor.rgb *= uTint * ( 1.0 - uAlbedoVar * ( 0.5 - grime ) * 2.0 );
          diffuseColor.rgb *= 1.0 - 0.14 * ( bpC - 0.5 );`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = clamp(
            roughnessFactor + uRoughVar * ( texture2D( uNoise, vWorldPosBreakup.xz * uNoiseScale * 0.7 ).g - 0.5 ),
            0.18, 1.0 );`);
    };

    // Distinct cache key so three does not share a compiled program between a
    // broken-up material and a plain one.
    mat.customProgramCacheKey = () => `breakup:${scale}:${albedo}:${rough}`;
    return mat;
  }

  _std(opts) { return new THREE.MeshStandardMaterial(opts); }

  _build() {
    const a = this.assets;

    // Height -> normal conversions for the sets that only shipped bump maps.
    const brickN = a.normalFromHeight('brickBump', 'brickNormal', 2.4);
    const woodN = a.normalFromHeight('woodBump', 'woodNormal', 1.9);
    const grungeN = a.normalFromHeight('grunge', 'grungeNormal', 1.1);

    const rep = (t, u, v) => {
      if (!t) return null;
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(u, v);
      c.anisotropy = a.anisotropy;
      c.needsUpdate = true;
      return c;
    };

    // ---------------------------------------------------------------- ground

    this.set('asphalt', this.breakup(this._std({
      normalMap: rep(grungeN, 1, 1),
      normalScale: new THREE.Vector2(0.55, 0.55),
      color: 0x333337,
      roughness: 0.90,
      metalness: 0.02,
      envMapIntensity: 0.30,
    }), { scale: 22, albedo: 0.5, rough: 0.16, tint: 0x9a9aa0 }));

    // Wet asphalt for the puddle ring around drains — same base, glossier, with
    // a scrolling water normal that catches the sun and the muzzle flashes.
    this.set('wetAsphalt', this.breakup(this._std({
      normalMap: rep(a.tex('wetNormal'), 1, 1),
      normalScale: new THREE.Vector2(0.10, 0.10),
      color: 0x2f3036,
      roughness: 0.34,
      metalness: 0.04,
      envMapIntensity: 0.75,
    }), { scale: 18, albedo: 0.24, rough: 0.08 }));

    this.set('concrete', this.breakup(this._std({
      normalMap: rep(grungeN, 1, 1),
      normalScale: new THREE.Vector2(0.42, 0.42),
      color: 0x4a4a46,
      roughness: 0.88,
      metalness: 0.0,
      envMapIntensity: 0.35,
    }), { scale: 11, albedo: 0.30, rough: 0.16, tint: 0xb9b8b2 }));

    this.set('dirt', this.breakup(this._std({
      map: rep(a.tex('grassAlbedo'), 1, 1),
      color: 0x4c4736,
      roughness: 0.97,
      metalness: 0,
      envMapIntensity: 0.4,
    }), { scale: 16, albedo: 0.5, rough: 0.2, tint: 0x8a8570 }));

    this.set('water', this._std({
      color: 0x0d1418,
      roughness: 0.08,
      metalness: 0.25,
      envMapIntensity: 1.6,
    }));

    this.set('tile', this._std({
      map: rep(a.tex('tileAlbedo'), 1, 1),
      normalMap: rep(a.tex('tileNormal'), 1, 1),
      normalScale: new THREE.Vector2(0.7, 0.7),
      color: 0x8d8d8d,
      roughness: 0.42,
      metalness: 0.05,
      envMapIntensity: 0.9,
    }));

    // ----------------------------------------------------------------- walls

    this.set('brick', this.breakup(this._std({
      map: rep(a.tex('brickAlbedo'), 1, 1),
      normalMap: rep(brickN, 1, 1),
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughnessMap: rep(a.tex('brickRough'), 1, 1),
      color: 0x6f5d51,
      roughness: 0.93,
      metalness: 0.0,
      envMapIntensity: 0.35,
    }), { scale: 9, albedo: 0.38, rough: 0.2, tint: 0xa9968a }));

    this.set('plaster', this.breakup(this._std({
      normalMap: rep(grungeN, 1, 1),
      normalScale: new THREE.Vector2(0.35, 0.35),
      color: 0x5c574e,
      roughness: 0.9,
      metalness: 0,
      envMapIntensity: 0.35,
    }), { scale: 13, albedo: 0.42, rough: 0.22, tint: 0xa39d92 }));

    this.set('wood', this.breakup(this._std({
      map: rep(a.tex('woodAlbedo'), 1, 1),
      normalMap: rep(woodN, 1, 1),
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughnessMap: rep(a.tex('woodRough'), 1, 1),
      color: 0x6b5136,
      roughness: 0.86,
      metalness: 0,
      envMapIntensity: 0.5,
    }), { scale: 7, albedo: 0.3, rough: 0.2 }));

    this.set('plank', this._std({
      map: rep(a.tex('woodAlbedo'), 1, 1),
      normalMap: rep(woodN, 1, 1),
      normalScale: new THREE.Vector2(0.9, 0.9),
      color: 0x5d472f,
      roughness: 0.9,
      metalness: 0,
      envMapIntensity: 0.45,
    }));

    // ---------------------------------------------------------------- metals

    // Weathered street steel, not a mirror: under an open sky a low-roughness
    // metal reflects the whole hemisphere and reads as a chrome rod.
    this.set('steel', this._std({
      color: 0x767c84,
      roughness: 0.82,
      metalness: 0.55,
      roughnessMap: rep(a.tex('roughDetail'), 1, 1),
      envMapIntensity: 1.0,
    }));

    this.set('rust', this.breakup(this._std({
      normalMap: rep(grungeN, 1, 1),
      normalScale: new THREE.Vector2(0.6, 0.6),
      color: 0x6d4429,
      roughness: 0.82,
      metalness: 0.75,
      envMapIntensity: 1.1,
    }), { scale: 6, albedo: 0.55, rough: 0.35, tint: 0xc08050 }));

    this.set('gunmetal', this._std({
      color: 0x2f3338,
      roughness: 0.34,
      metalness: 1.0,
      normalMap: rep(a.tex('carbonNormal'), 6, 6),
      normalScale: new THREE.Vector2(0.35, 0.35),
      envMapIntensity: 1.7,
    }));

    this.set('gunPolymer', this._std({
      color: 0x15171a,
      roughness: 0.62,
      metalness: 0.05,
      map: rep(a.tex('carbonAlbedo'), 4, 4),
      normalMap: rep(a.tex('carbonNormal'), 4, 4),
      normalScale: new THREE.Vector2(0.6, 0.6),
      envMapIntensity: 1.0,
    }));

    this.set('brass', this._std({
      color: 0xd8a441, roughness: 0.25, metalness: 1.0, envMapIntensity: 1.8,
    }));

    this.set('chrome', this._std({
      color: 0xc9d2dc, roughness: 0.15, metalness: 1.0, envMapIntensity: 1.4,
    }));

    // -------------------------------------------------------- weapon finishes
    /*
     * The viewmodel gets its own set of metals rather than reusing the world's.
     * A gun is the one object on screen at a fixed half-metre from the camera,
     * so it can carry a texel density and an environment response that would be
     * wasted on a wall, and it is the only thing whose silhouette the player
     * looks at for hours.
     *
     * Every one of these reads vertex colours: that is where the gunsmith bakes
     * edge wear (bright bare metal on the chamfers a holster would rub) and the
     * grime that collects along the bottom of a receiver. Baking it into the
     * mesh costs nothing at runtime and survives the per-material merge.
     *
     * UVs on gunsmith parts are in metres, so a repeat of 40 puts one tile of
     * detail every 25 mm.
     */
    const gunN = a.normalFromHeight('roughDetail', 'gunGrainNormal', 0.7);
    const gun = (o) => this._std({ vertexColors: true, envMapIntensity: 0.95, ...o });

    // Parkerised receiver steel: matte, slightly warm, the default for frames.
    this.set('gunSteel', gun({
      color: 0x33373b, roughness: 0.46, metalness: 1.0,
      normalMap: rep(gunN, 40, 40), normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: rep(a.tex('roughDetail'), 30, 30),
    }));

    // Blued steel for barrels, slides and anything machined and oiled.
    this.set('gunBlued', gun({
      color: 0x24282c, roughness: 0.24, metalness: 1.0,
      normalMap: rep(gunN, 55, 55), normalScale: new THREE.Vector2(0.28, 0.28),
      envMapIntensity: 1.10,
    }));

    // Hard-anodised aluminium: receivers, rails, optic bodies.
    this.set('gunAlloy', gun({
      color: 0x2c2f31, roughness: 0.40, metalness: 0.9,
      normalMap: rep(gunN, 46, 46), normalScale: new THREE.Vector2(0.45, 0.45),
    }));

    // Glass-filled polymer: grips, handguards, stocks. Not a metal.
    this.set('gunGrip', gun({
      color: 0x131518, roughness: 0.74, metalness: 0.02,
      normalMap: rep(a.tex('carbonNormal'), 70, 70),
      normalScale: new THREE.Vector2(0.5, 0.5),
      envMapIntensity: 1.0,
    }));

    // Oiled walnut for the furniture on the older weapons.
    this.set('gunWood', gun({
      color: 0x3c2b1e, roughness: 0.54, metalness: 0.0,
      map: rep(a.tex('woodAlbedo'), 5, 5),
      normalMap: rep(woodN, 5, 5), normalScale: new THREE.Vector2(0.5, 0.5),
      envMapIntensity: 1.2,
    }));

    /*
     * Improvised melee finishes.
     *
     * The Poly Haven props arrive as one material each with no texture images,
     * so each weapon gets exactly one finish and it has to carry the whole
     * object. These are deliberately further apart from each other than the
     * gun finishes are: at a glance across a cluttered street you have to be
     * able to tell a bat from a pipe from a sign, and colour is the only
     * channel with the range to do that.
     */

    // Bare aluminium: the bat. Bright, brushed, and scratched from use.
    this.set('meleeAlu', gun({
      color: 0x9aa0a6, roughness: 0.34, metalness: 1.0,
      normalMap: rep(gunN, 24, 24), normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: rep(a.tex('roughDetail'), 18, 18),
      envMapIntensity: 1.15,
    }));

    // Painted and chipped steel tube: chair frames, crowbars, pipes.
    this.set('meleeSteel', gun({
      color: 0x4a5157, roughness: 0.58, metalness: 0.85,
      normalMap: rep(gunN, 22, 22), normalScale: new THREE.Vector2(0.6, 0.6),
      roughnessMap: rep(a.tex('roughDetail'), 14, 14),
    }));

    // Safety yellow: the wet-floor sign, the drill's shell. Injection-moulded
    // plastic, so almost no specular break-up and no metalness at all.
    this.set('meleeYellow', gun({
      color: 0xc9a01c, roughness: 0.46, metalness: 0.0,
      normalMap: rep(a.tex('carbonNormal'), 40, 40),
      normalScale: new THREE.Vector2(0.22, 0.22),
      envMapIntensity: 1.05,
    }));

    // Light ash and plywood: bat handles, axe hafts, a ukulele.
    this.set('meleeWood', gun({
      color: 0x8a6640, roughness: 0.60, metalness: 0.0,
      map: rep(a.tex('woodAlbedo'), 3.5, 3.5),
      normalMap: rep(woodN, 3.5, 3.5), normalScale: new THREE.Vector2(0.45, 0.45),
      envMapIntensity: 1.1,
    }));

    this.set('gunBrass', gun({
      color: 0xc9973b, roughness: 0.30, metalness: 1.0, envMapIntensity: 1.3,
    }));

    // Optic glass. Not transmissive — a viewmodel lens only ever has to look
    // dark, wet and coated, and transmission on a per-frame object is not free.
    this.set('gunGlass', new THREE.MeshPhysicalMaterial({
      color: 0x0a1418, roughness: 0.06, metalness: 0.0,
      clearcoat: 1.0, clearcoatRoughness: 0.03,
      reflectivity: 0.9, envMapIntensity: 1.6,
      vertexColors: true,
    }));

    // Emissive bits: reticles, charge cores, pilot flames, arc channels.
    this.set('gunGlow', new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, toneMapped: false,
      transparent: true, opacity: 0.95, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));

    this.set('paintedMetal', this.breakup(this._std({
      color: 0x2b3a4a,
      roughness: 0.42,
      metalness: 0.65,
      normalMap: rep(grungeN, 1, 1),
      normalScale: new THREE.Vector2(0.22, 0.22),
      envMapIntensity: 1.3,
    }), { scale: 5, albedo: 0.3, rough: 0.3 }));

    // ----------------------------------------------------------- transparent

    this.set('glass', new THREE.MeshPhysicalMaterial({
      color: 0x9fb6c8,
      roughness: 0.06,
      metalness: 0,
      transmission: 0.0,      // real transmission is too costly for this budget
      opacity: 0.22,
      transparent: true,
      envMapIntensity: 2.4,
      side: THREE.DoubleSide,
    }));

    this.set('brokenGlass', new THREE.MeshStandardMaterial({
      color: 0x6d8494, roughness: 0.25, metalness: 0.1,
      opacity: 0.12, transparent: true, side: THREE.DoubleSide,
      envMapIntensity: 2.0,
    }));

    // ------------------------------------------------------------- emissive

    this.set('lampGlass', new THREE.MeshStandardMaterial({
      color: 0x201c14, emissive: 0xffcf9a, emissiveIntensity: 1.15, roughness: 0.3,
      metalness: 0, toneMapped: true,
    }));

    this.set('neonRed', new THREE.MeshStandardMaterial({
      color: 0x120000, emissive: 0xff2018, emissiveIntensity: 1.5, roughness: 0.4,
    }));

    this.set('neonGreen', new THREE.MeshStandardMaterial({
      color: 0x001200, emissive: 0x35ff6a, emissiveIntensity: 0.9, roughness: 0.4,
    }));

    this.set('neonCyan', new THREE.MeshStandardMaterial({
      color: 0x001014, emissive: 0x3fe8ff, emissiveIntensity: 0.95, roughness: 0.4,
    }));

    this.set('ember', new THREE.MeshStandardMaterial({
      map: rep(a.tex('ember'), 1, 1),
      emissiveMap: rep(a.tex('ember'), 1, 1),
      emissive: 0xff6a1a, emissiveIntensity: 1.6,
      color: 0x110700, roughness: 0.8,
    }));
  }

  set(k, v) { this.cache.set(k, v); return v; }
  get(k) { return this.cache.get(k); }

  /** Clones a library material so an instance can be tinted without side effects. */
  variant(key, overrides = {}) {
    const base = this.cache.get(key);
    if (!base) return null;
    const m = base.clone();
    // clone() drops onBeforeCompile's identity; re-attach so breakup survives.
    m.onBeforeCompile = base.onBeforeCompile;
    m.customProgramCacheKey = base.customProgramCacheKey;
    Object.assign(m, overrides);
    return m;
  }

  applyEnvironment(intensity) {
    for (const m of this.cache.values()) {
      if ('envMapIntensity' in m) m.envMapIntensity *= intensity;
    }
  }

  dispose() {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}
