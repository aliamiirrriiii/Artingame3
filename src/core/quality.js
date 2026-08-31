import { RollingAverage, clamp } from './util.js';

/**
 * Quality tiers. Each one is a complete budget: what the renderer does, how far
 * things draw, and how many zombies may live at once. `auto` picks a starting
 * tier from a quick hardware probe, then the adaptive scaler nudges render
 * resolution every frame to defend the frame-rate target.
 */
export const PRESETS = {
  low: {
    name: 'Low',
    maxPixelRatio: 1.0, renderScale: 0.75,
    shadows: true, shadowMapSize: 1024, shadowDistance: 26, cascades: 1,
    bloom: false, ssao: false, motionBlur: false,
    anisotropy: 2, envMapSize: 128,
    maxZombies: 22, zombieShadowDistance: 14, animLodDistance: 16,
    particleBudget: 240, decalBudget: 48, drawDistance: 110, fogDensity: 0.036,
    // How much static dressing the level builds: window trim and shopfronts,
    // fire escapes and rooftop clutter, kerbside litter. It is all merged into
    // the existing batches, so the cost is triangles and memory rather than
    // draw calls — which is exactly the budget a low-end phone has least of.
    worldDetail: 0,
    dynamicLights: 3,
  },
  medium: {
    name: 'Medium',
    maxPixelRatio: 1.25, renderScale: 0.9,
    shadows: true, shadowMapSize: 2048, shadowDistance: 38, cascades: 1,
    bloom: true, ssao: false, motionBlur: false,
    anisotropy: 4, envMapSize: 256,
    maxZombies: 34, zombieShadowDistance: 20, animLodDistance: 24,
    particleBudget: 500, decalBudget: 96, drawDistance: 150, fogDensity: 0.030,
    worldDetail: 1,
    dynamicLights: 6,
  },
  high: {
    name: 'High',
    maxPixelRatio: 1.5, renderScale: 1.0,
    shadows: true, shadowMapSize: 2048, shadowDistance: 52, cascades: 1,
    bloom: true, ssao: true, motionBlur: true,
    anisotropy: 8, envMapSize: 256,
    maxZombies: 46, zombieShadowDistance: 28, animLodDistance: 32,
    particleBudget: 900, decalBudget: 160, drawDistance: 190, fogDensity: 0.026,
    worldDetail: 2,
    dynamicLights: 9,
  },
  ultra: {
    name: 'Ultra',
    maxPixelRatio: 2.0, renderScale: 1.0,
    shadows: true, shadowMapSize: 4096, shadowDistance: 70, cascades: 1,
    bloom: true, ssao: true, motionBlur: true,
    anisotropy: 16, envMapSize: 512,
    maxZombies: 60, zombieShadowDistance: 38, animLodDistance: 44,
    particleBudget: 1400, decalBudget: 220, drawDistance: 240, fogDensity: 0.022,
    worldDetail: 2,
    dynamicLights: 14,
  },
};

export const PRESET_ORDER = ['low', 'medium', 'high', 'ultra'];

/**
 * Caps a preset for phone-class hardware.
 *
 * A mobile GPU's problem is not raw shading power so much as memory bandwidth
 * and thermal headroom, so the things clamped hardest are the ones that move
 * the most pixels: device pixel ratio (a 3x phone screen is 8x the fill of a
 * 1x one for no visible gain at this art density), shadow map size, draw
 * distance, and how many skinned characters are on screen. Ambient occlusion
 * goes entirely — it is the worst cost-to-benefit ratio on a small screen.
 */
export function mobilePreset(preset) {
  return {
    ...preset,
    maxPixelRatio: Math.min(preset.maxPixelRatio, 1.0),
    renderScale: Math.min(preset.renderScale, 0.85),
    shadowMapSize: Math.min(preset.shadowMapSize, 1024),
    shadowDistance: Math.min(preset.shadowDistance, 24),
    ssao: false,
    anisotropy: Math.min(preset.anisotropy, 4),
    envMapSize: Math.min(preset.envMapSize, 128),
    // Dressing is static and batched, so a phone can afford one tier of it
    // even where it cannot afford the pixels.
    worldDetail: Math.min(preset.worldDetail, 1),
    maxZombies: Math.min(preset.maxZombies, 26),
    zombieShadowDistance: Math.min(preset.zombieShadowDistance, 12),
    animLodDistance: Math.min(preset.animLodDistance, 15),
    particleBudget: Math.min(preset.particleBudget, 340),
    decalBudget: Math.min(preset.decalBudget, 64),
    drawDistance: Math.min(preset.drawDistance, 125),
    fogDensity: Math.max(preset.fogDensity, 0.030),
    dynamicLights: Math.min(preset.dynamicLights, 4),
    mobile: true,
  };
}

/** Cheap capability probe: GPU renderer string + core count + memory. */
export function detectTier() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'low';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') || '';
    const g = gpu.toLowerCase();
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;

    const software = /swiftshader|llvmpipe|softwarerasterizer|angle \(google/.test(g);
    if (software) return 'low';
    const mobile = /adreno|mali|apple gpu|powervr/.test(g) || /Mobi|Android/i.test(navigator.userAgent);
    if (mobile) return cores >= 8 ? 'medium' : 'low';

    const strong = /rtx|radeon rx (6|7|9)|arc a[0-9]|apple m[1-9]|rx 7[0-9]{3}/.test(g);
    if (strong && cores >= 8 && mem >= 8) return 'ultra';
    const decent = /geforce|radeon|nvidia|intel\(r\) (arc|iris)/.test(g);
    if (decent && cores >= 6) return 'high';
    return cores >= 4 ? 'medium' : 'low';
  } catch {
    return 'medium';
  }
}

/**
 * Adaptive resolution. We never drop simulation rate — we scale the number of
 * pixels instead, which is where the cost actually is. Hysteresis and a cooldown
 * keep it from oscillating visibly.
 */
export class AdaptiveScaler {
  constructor(preset, targetFps = 60) {
    this.setPreset(preset);
    this.target = targetFps;
    this.avg = new RollingAverage(45, 1000 / targetFps);
    this.cooldown = 1.2;
    this.enabled = true;
  }

  setPreset(preset) {
    this.preset = preset;
    this.scale = preset.renderScale;
    this.minScale = 0.55;
    this.maxScale = preset.renderScale;
  }

  setTarget(fps) {
    this.target = fps;
    this.avg = new RollingAverage(45, 1000 / fps);
  }

  /** Returns the new render scale, or null when nothing changed. */
  update(frameMs, dt) {
    if (!this.enabled) return null;
    const mean = this.avg.push(Math.min(frameMs, 120));
    this.cooldown -= dt;
    if (this.cooldown > 0) return null;

    const budget = 1000 / this.target;
    const prev = this.scale;

    if (mean > budget * 1.22) {
      this.scale = clamp(this.scale - 0.08, this.minScale, this.maxScale);
    } else if (mean < budget * 0.78) {
      this.scale = clamp(this.scale + 0.05, this.minScale, this.maxScale);
    }

    if (this.scale !== prev) {
      this.cooldown = 0.9;
      return this.scale;
    }
    this.cooldown = 0.35;
    return null;
  }
}
