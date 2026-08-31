import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { GradeShader } from './grade.js';
import { clamp, damp } from '../core/util.js';

/**
 * Owns the renderer, the scene's lighting rig and the post chain.
 *
 * The look: a physically-lit afternoon. A warm sun key with a shadow frustum
 * that rides along with the player (so a 2k map covers 50 m at full density
 * instead of smearing across the whole arena), HDRI image-based ambient, a
 * strong sky/ground bounce because a daylight shadow is blue-filled rather than
 * black, exponential haze tuned to the draw distance, and a flashlight that now
 * matters only indoors.
 */
/** Daylight carries far less haze than the night build wanted. */
const DAY_FOG = 0.30;

/**
 * Where the sun sits relative to whatever it is lighting.
 *
 * 42 west, 30 north, 44 up: an elevation of about forty degrees.
 *
 * Lower than this looks better in a still and plays worse in motion. The
 * arena is a courtyard ringed by a nine-metre wall with seventeen-metre
 * buildings inside it, so at the twenty-two degrees a photographer would pick,
 * essentially the whole playable street falls into shadow and the horde
 * crossing it becomes silhouettes on black. Forty keeps the long raking
 * shadows off the kerbs, sills and lamp posts — which is what the angle is
 * for — while leaving the ground lit enough to fight on.
 */
const SUN_OFFSET = [-42, 44, 30];

export class Stage {
  constructor(canvas, preset) {
    this.canvas = canvas;
    this.preset = preset;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,           // MSAA is done on the composer target instead
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.renderer.shadowMap.enabled = preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.06, preset.drawDistance);

    // The camera is part of the scene graph so the weapon viewmodel and the
    // hand light can be parented to it and still render.
    this.scene.add(this.camera);

    this.renderScale = preset.renderScale;
    this._width = 1; this._height = 1;

    this._buildLights();
    this._buildComposer();

    this._shakeTrauma = 0;
    this._shakeTime = 0;
    this._flashTimer = 0;
    // Matches the constructor's starting exposure: this is damped toward every
    // frame, so a different value up there is overwritten within a second.
    this.exposureTarget = 0.82;
  }

  // ------------------------------------------------------------------ setup

  _buildLights() {
    const p = this.preset;

    /*
     * Sun key light, late afternoon.
     *
     * Rotated well off-axis from the camera so the arena reads with depth
     * rather than flat frontal light, and — the part that matters most —
     * *low*. At the old elevation of forty-eight degrees every shadow was a
     * short puddle under the thing that cast it, which is the light a
     * photographer would go home rather than shoot in. At thirty the shadows
     * run the length of the street, every kerb and sill has a hard edge under
     * it, and the facades split into lit and unlit faces instead of reading
     * as one grey mass. It also warms up: low sun is filtered through much
     * more air, so the key goes amber and the fill it leaves behind goes blue.
     */
    this.sun = new THREE.DirectionalLight(0xffe4be, 2.5);
    this.sun.position.set(...SUN_OFFSET);
    this.sun.castShadow = p.shadows;
    const s = this.sun.shadow;
    s.mapSize.set(p.shadowMapSize, p.shadowMapSize);
    s.camera.near = 1;
    s.camera.far = 180;
    s.bias = -0.0012;
    s.normalBias = 0.05;
    s.radius = 2.4;
    this._setShadowExtent(p.shadowDistance);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Sky/ground bounce. Under a real sky this is doing most of the work in
    // shadow, so it is much stronger than the night version was: a daylight
    // shadow is blue-filled, not black.
    // Sky fill. Under a real sky this is doing most of the work in shadow, and
    // with the key this low it is doing more still: a daylight shadow is
    // blue-filled, not black, and the darker half of every facade is lit
    // entirely by this.
    this.hemi = new THREE.HemisphereLight(0x8ab6f0, 0x6a5b46, 1.25);
    this.scene.add(this.hemi);

    // Flashlight. In daylight it earns its keep only inside the blocks and
    // under the overpass, so it is dimmer than it was at night — at full night
    // strength it blew out everything it touched in an already-lit street.
    this.flashlight = new THREE.SpotLight(0xfff2d8, 42, 34, 0.48, 0.50, 1.7);
    this.flashlight.castShadow = p.shadows && p.name !== 'Low';
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.4;
    this.flashlight.shadow.camera.far = 46;
    this.flashlight.shadow.bias = -0.002;
    this.flashlight.shadow.normalBias = 0.04;
    this.flashlightTarget = new THREE.Object3D();
    this.scene.add(this.flashlight, this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;

    // Muzzle flash light — one shared, pooled light beats one per shot.
    this.muzzleLight = new THREE.PointLight(0xffd08a, 0, 24, 2.0);
    this.muzzleLight.castShadow = false;
    this.scene.add(this.muzzleLight);
    this._muzzleDecay = 0;

    // A tiny rim light rides on the camera so the weapon keeps some shape when
    // the player is facing into shadow.
    this.viewRim = new THREE.PointLight(0xbfd2ea, 0.5, 2.2, 2.0);
    this.viewRim.position.set(0.35, 0.1, 0.25);
    this.camera.add(this.viewRim);
  }

  _setShadowExtent(dist) {
    const c = this.sun.shadow.camera;
    c.left = -dist; c.right = dist;
    c.top = dist; c.bottom = -dist;
    c.updateProjectionMatrix();
  }

  _buildComposer() {
    const p = this.preset;
    if (this.composer) this.composer.dispose?.();

    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: p.name === 'Low' ? 0 : 4,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.composer = new EffectComposer(this.renderer, rt);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.gtao = null;
    if (p.ssao) {
      try {
        this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
        this.gtao.output = GTAOPass.OUTPUT.Default;
        this.gtao.updateGtaoMaterial?.({
          radius: 0.35, distanceExponent: 1.4, thickness: 0.6,
          scale: 1.0, samples: 12, screenSpaceRadius: false,
        });
        this.composer.addPass(this.gtao);
      } catch {
        this.gtao = null; // graceful: the scene still looks right without AO
      }
    }

    this.bloom = null;
    if (p.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.30, 1.05);
      this.composer.addPass(this.bloom);
    }

    this.composer.addPass(new OutputPass());

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    if (p.name === 'Low' || p.name === 'Medium') {
      this.fxaa = new FXAAPass();
      this.composer.addPass(this.fxaa);
    } else {
      this.fxaa = null;
    }
  }

  // ------------------------------------------------------------ environment

  applyEnvironment(envMap, { intensity = 0.4, fog = 0xb9c6d4 } = {}) {
    // The HDRI is used for image-based lighting only. Sky draws the backdrop,
    // which keeps the horizon under our control and stops the HDRI's brightest
    // pixel from dominating the bloom pass.
    this.scene.environment = envMap;
    this.scene.environmentIntensity = intensity;
    this.scene.background = null;
    // Well under a third of the night density. That fog was tuned to hide the
    // arena's edge in the dark, where it read as depth; in daylight the same
    // figure turns the far side of the street into a sheet of milk. Half was
    // still too much: the arena is 124 m across, and at half density the far
    // side of it was ninety per cent haze — you could not see the horde start
    // to move, which is most of what a daylight game is for.
    this.fogDensity = this.preset.fogDensity * DAY_FOG;
    this.scene.fog = new THREE.FogExp2(fog, this.fogDensity);
    this.fogColor = new THREE.Color(fog);
  }

  /**
   * Roughly how much light lands on a horizontal surface out in the open,
   * in the renderer's linear working space.
   *
   * Decals that are drawn rather than lit — blood, mostly — multiply their
   * albedo by this so they sit at the same brightness as the ground they are
   * on, and follow it when a boss wave retints the whole frame.
   */
  lightLevel(out = new THREE.Color()) {
    out.copy(this.sun.color).multiplyScalar(this.sun.intensity * 0.55);
    out.r += this.hemi.color.r * this.hemi.intensity * 0.55;
    out.g += this.hemi.color.g * this.hemi.intensity * 0.55;
    out.b += this.hemi.color.b * this.hemi.intensity * 0.55;
    // Image-based ambient is not in either light, so allow for it.
    const env = this.scene.environmentIntensity || 1;
    return out.multiplyScalar(0.55 + env * 0.3);
  }

  setMood(mood) {
    // Called on boss waves and power-ups to re-tint the whole frame.
    const { fog, fogDensity, sunColor, sunIntensity, exposure } = mood;
    if (fog !== undefined && this.scene.fog) this.scene.fog.color.setHex(fog);
    if (fogDensity !== undefined && this.scene.fog) this.scene.fog.density = fogDensity;
    if (sunColor !== undefined) this.sun.color.setHex(sunColor);
    if (sunIntensity !== undefined) this.sun.intensity = sunIntensity;
    if (exposure !== undefined) this.exposureTarget = exposure;
    if (fog !== undefined) this.fogColor.setHex(fog);
    // The sky's haze band and the particle fog are tuned to match the scene
    // fog exactly; leaving them behind on a mood change puts a visible seam
    // along the horizon where the two disagree.
    this.onMood?.(this);
  }

  // ---------------------------------------------------------------- quality

  setPreset(preset) {
    this.preset = preset;
    this.renderer.shadowMap.enabled = preset.shadows;
    this.renderer.shadowMap.needsUpdate = true;
    this.sun.castShadow = preset.shadows;
    this.sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.flashlight.castShadow = preset.shadows && preset.name !== 'Low';
    this._setShadowExtent(preset.shadowDistance);
    this.camera.far = preset.drawDistance;
    this.camera.updateProjectionMatrix();
    this.fogDensity = preset.fogDensity * DAY_FOG;
    if (this.scene.fog) this.scene.fog.density = this.fogDensity;
    this.renderScale = preset.renderScale;
    this._buildComposer();
    this.resize(this._width, this._height);
  }

  setRenderScale(scale) {
    this.renderScale = clamp(scale, 0.4, 2);
    this.resize(this._width, this._height);
  }

  resize(width, height) {
    this._width = width; this._height = height;
    const dpr = Math.min(window.devicePixelRatio || 1, this.preset.maxPixelRatio) * this.renderScale;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);

    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);

    const aspect = width / Math.max(1, height);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();

    this.grade.uniforms.uResolution.value[0] = width * dpr;
    this.grade.uniforms.uResolution.value[1] = height * dpr;
  }

  /** Vertical FOV in degrees; widened while sprinting for a speed cue. */
  setFov(deg) {
    if (Math.abs(this.camera.fov - deg) < 0.01) return;
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------- feel

  /** Trauma-based screen shake: squared falloff reads far better than linear. */
  addShake(amount) {
    this._shakeTrauma = clamp(this._shakeTrauma + amount, 0, 1);
  }

  flash(amount) {
    this._flashTimer = Math.max(this._flashTimer, amount);
  }

  /** Fires the shared muzzle light for one shot. */
  muzzleFlash(position, intensity = 9, color = 0xffd08a) {
    this.muzzleLight.position.copy(position);
    this.muzzleLight.color.setHex(color);
    this.muzzleLight.intensity = intensity;
    this._muzzleDecay = 1;
  }

  /**
   * Keeps the sun's shadow frustum centred a little ahead of the player so the
   * shadow texels land where the player is actually looking.
   */
  updateShadowFocus(playerPos, forward) {
    const t = this.sun.target.position;
    t.set(
      playerPos.x + forward.x * this.preset.shadowDistance * 0.35,
      0,
      playerPos.z + forward.z * this.preset.shadowDistance * 0.35,
    );
    this.sun.position.set(t.x + SUN_OFFSET[0], SUN_OFFSET[1], t.z + SUN_OFFSET[2]);
    this.sun.target.updateMatrixWorld();
  }

  updateFlashlight(camera, on, intensity = 90) {
    this.flashlight.visible = on;
    if (!on) return;
    this.flashlight.position.copy(camera.position);
    // Offset slightly down-right: shoulder-mounted, not eye-mounted.
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    this.flashlightTarget.position.copy(camera.position).addScaledVector(dir, 20);
    this.flashlight.intensity = intensity;
  }

  update(dt, elapsed) {
    // Shake decays fast; the offset is applied by the player controller.
    this._shakeTrauma = Math.max(0, this._shakeTrauma - dt * 1.65);
    this._shakeTime += dt;

    if (this._muzzleDecay > 0) {
      this._muzzleDecay = Math.max(0, this._muzzleDecay - dt * 14);
      this.muzzleLight.intensity *= this._muzzleDecay > 0 ? 0.55 : 0;
      if (this._muzzleDecay === 0) this.muzzleLight.intensity = 0;
    }

    this._flashTimer = Math.max(0, this._flashTimer - dt * 2.6);

    const g = this.grade.uniforms;
    g.uTime.value = elapsed;
    g.uFlash.value = this._flashTimer * this._flashTimer;

    this.renderer.toneMappingExposure = damp(
      this.renderer.toneMappingExposure, this.exposureTarget, 3, dt,
    );
  }

  /** Current shake offset in radians/metres, consumed by the camera rig. */
  shakeOffset(out) {
    const t = this._shakeTrauma * this._shakeTrauma;
    if (t < 0.0001) { out.set(0, 0, 0); return out; }
    const s = this._shakeTime * 34;
    out.set(
      Math.sin(s * 1.7) * t * 0.055,
      Math.sin(s * 2.3 + 1.7) * t * 0.055,
      Math.sin(s * 1.1 + 3.1) * t * 0.03,
    );
    return out;
  }

  render() {
    this.renderer.info.reset();
    this.composer.render();
  }

  get drawCalls() { return this.renderer.info.render.calls; }
  get triangles() { return this.renderer.info.render.triangles; }
}
