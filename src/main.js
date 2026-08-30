import * as THREE from 'three';
import { PRESETS, detectTier, mobilePreset, AdaptiveScaler } from './core/quality.js';
import { AssetManager, MANIFEST } from './core/assets.js';
import { Input } from './core/input.js';
import { TouchInput, isTouchDevice } from './core/touch.js';
import { audio } from './core/audio.js';
import { clamp, damp, fmt, rand, RollingAverage } from './core/util.js';
import { Stage } from './render/stage.js';
import { NightSky } from './render/sky.js';
import { Effects } from './render/fx.js';
import { MaterialLibrary } from './world/materials.js';
import { Level } from './world/level.js';
import { Player } from './entities/player.js';
import { ZombieManager } from './entities/zombies.js';
import { Viewmodel } from './weapons/viewmodel.js';
import { Combat } from './weapons/combat.js';
import { WEAPONS } from './weapons/arsenal.js';
import { Director, WAVE_STATE } from './game/director.js';
import { Economy } from './game/economy.js';
import { HUD } from './ui/hud.js';

/**
 * NIGHT OF THE RISEN — entry point and game loop.
 *
 * The loop is deliberately simple: one variable-dt update clamped to a sane
 * maximum, then one render. All the smoothing that would normally justify a
 * fixed timestep (camera, recoil, AI steering) is written frame-rate
 * independently with exponential damping, so the game behaves identically at
 * 30 and at 144 fps.
 */

const SETTINGS_KEY = 'notr.settings.v1';
const BEST_KEY = 'notr.best.v1';

const TIPS = [
  'Points come from damage as well as kills — nothing you shoot is wasted.',
  'The ring road loops all the way around the block. Use it.',
  'Headshots deal far more damage and pay 50% more points.',
  'Barrels and wrecked cars explode. Wait until the pack walks past.',
  'Screamers turn the whole street into runners. Kill them first.',
  'Brutes charge in a straight line — sidestep, never backpedal.',
  'Every fifth wave sends something much bigger. The sky turns red.',
  'The mystery box moves after a few uses. Spend while it is close.',
  'Juggernog doubles your health. It is the best 2500 points in the game.',
];

class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.state = 'loading';
    this.ready = false;
    this.error = null;

    this.settings = this._loadSettings();
    this.isTouch = isTouchDevice();
    const forced = new URLSearchParams(location.search).get('q');
    this.presetKey = (forced && PRESETS[forced] ? forced : null)
      || this.settings.quality || detectTier();
    this.preset = this._resolvePreset(this.presetKey);

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.runTime = 0;
    this.frameCount = 0;
    this.frameAvg = new RollingAverage(60, 16.7);
    this.fpsAvg = new RollingAverage(30, 60);

    this.powerupsActive = [];
    this._tmpV = new THREE.Vector3();
    this._lastPoints = 0;

    // Development/test query parameters. Harmless in normal play — nobody
    // arrives at the page with these set — and they make the headless harness
    // able to reach states that would otherwise take ten minutes of play.
    const q = new URLSearchParams(location.search);
    this.headless = q.has('headless');
    this.botMode = q.get('bot') === '1';
    this.devGive = (q.get('give') || '').split(',').filter(Boolean);
    this.devWave = Number(q.get('wave') || 0);
    this.devPoints = Number(q.get('points') || 0);
    this._botT = 0;
  }

  // -------------------------------------------------------------- settings

  /** Applies the phone caps on top of the chosen tier. */
  _resolvePreset(key) {
    const base = PRESETS[key] || PRESETS.medium;
    return this.isTouch ? mobilePreset(base) : base;
  }

  _loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* fresh profile */ }
    return {
      quality: s.quality ?? null,
      targetFps: s.targetFps ?? 60,
      adaptive: s.adaptive ?? true,
      sensitivity: s.sensitivity ?? 100,
      volume: s.volume ?? 70,
      invertY: s.invertY ?? false,
      touchSensitivity: s.touchSensitivity ?? 100,
      autoFire: s.autoFire ?? true,
      aimAssist: s.aimAssist ?? true,
    };
  }

  _saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
  }

  _loadBest() {
    try { return JSON.parse(localStorage.getItem(BEST_KEY) || 'null'); } catch { return null; }
  }

  _saveBest(run) {
    const best = this._loadBest();
    if (!best || run.wave > best.wave || (run.wave === best.wave && run.points > best.points)) {
      try { localStorage.setItem(BEST_KEY, JSON.stringify(run)); } catch { /* private mode */ }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ boot

  async boot() {
    const loadFill = document.getElementById('load-fill');
    const loadText = document.getElementById('load-text');
    document.getElementById('load-tip').textContent = TIPS[(Math.random() * TIPS.length) | 0];

    try {
      this.stage = new Stage(this.canvas, this.preset);
      this._resize();

      this.assets = new AssetManager(this.stage.renderer);
      this.assets.onProgress = (p, label) => {
        loadFill.style.width = `${Math.round(p * 92)}%`;
        loadText.textContent = `Loading · ${label}`;
      };
      await this.assets.loadAll(MANIFEST, { anisotropy: this.preset.anisotropy });

      loadText.textContent = 'Building the precinct';
      loadFill.style.width = '95%';
      await nextFrame();

      const env = this.assets.environment('night');
      this.stage.applyEnvironment(env, { intensity: 0.7, fog: 0x111823 });
      this.sky = new NightSky(this.stage.scene);
      this.sky.matchFog(this.stage.fogColor);
      this.sky.alignToLight(this.stage.moon);

      this.materials = new MaterialLibrary(this.assets);
      this.level = new Level(this.stage.scene, this.materials, this.assets, this.preset).build();
      this.effects = new Effects(this.stage.scene, this.assets, this.preset);
      this.effects.setFog(this.stage.fogColor, this.preset.fogDensity);
      this.effects.setViewportHeight(window.innerHeight);

      loadText.textContent = 'Waking the dead';
      loadFill.style.width = '98%';
      await nextFrame();

      this.zombies = new ZombieManager(this.stage.scene, this.assets, this.level, this.effects, this.preset);
      this.zombies.prewarm(this.preset.maxZombies);
      this.player = new Player(this.stage, this.level, this.effects);
      this.viewmodel = new Viewmodel(this.stage, this.materials, this.level.collision);
      this.combat = new Combat({
        stage: this.stage, player: this.player, zombies: this.zombies,
        level: this.level, effects: this.effects, viewmodel: this.viewmodel,
      });
      this.director = new Director({
        zombies: this.zombies, level: this.level, player: this.player,
        effects: this.effects, stage: this.stage,
      });
      this.economy = new Economy({
        player: this.player, combat: this.combat, level: this.level,
        director: this.director, effects: this.effects,
      });

      this.hud = new HUD(this.stage);
      this.input = new Input(this.canvas);
      this.touchInput = this.isTouch
        ? new TouchInput(this.canvas, document.getElementById('touch'))
        : null;
      this.botInput = this.botMode ? new BotInput() : null;
      if (this.isTouch) this._setupTouch();

      this.scaler = new AdaptiveScaler(this.preset, this.settings.targetFps);
      this.scaler.enabled = this.settings.adaptive;

      this._wire();
      this._applySettings();
      this._bindUI();

      // Pre-compile so the first shot does not hitch on shader compilation.
      loadText.textContent = 'Compiling shaders';
      await nextFrame();
      this._warmup();

      loadFill.style.width = '100%';
      loadText.textContent = 'Ready';
      await nextFrame();

      this.ready = true;
      this._setScreen(this.botMode ? null : 'menu');
      this.state = this.botMode ? 'playing' : 'menu';
      if (this.botMode) this.startRun();

      document.getElementById('best-run').textContent = this._bestLabel();

      this.clock.start();
      requestAnimationFrame(this._frame);
    } catch (err) {
      this.error = err;
      loadText.textContent = 'Failed to start';
      document.getElementById('load-tip').textContent = String(err && err.message || err);
      this.ready = true;   // let the harness read the error instead of hanging
      throw err;
    }
  }

  /**
   * Renders one throwaway frame with a zombie and every weapon instantiated so
   * three compiles the programs now rather than mid-firefight.
   */
  _warmup() {
    const z = this.zombies.spawn('walker', new THREE.Vector3(0, 0, 40), 1);
    // Build every viewmodel once so switching weapons never hitches.
    for (const w of Object.values(WEAPONS)) this.viewmodel.equip(w);
    this.viewmodel.equip(this.combat.spec);
    this.stage.camera.position.set(0, 1.7, 44);
    this.stage.camera.lookAt(0, 1.6, 40);
    this.stage.updateFlashlight(this.stage.camera, true);
    this.zombies.update(0.016, this.player, 0);
    this.effects.muzzle(new THREE.Vector3(0, 1.6, 42), new THREE.Vector3(0, 0, -1));
    this.effects.bloodBurst(new THREE.Vector3(0, 1.6, 41), new THREE.Vector3(0, 0, -1), 1, true);
    this.effects.impact(new THREE.Vector3(0, 0.5, 41), new THREE.Vector3(0, 1, 0), 'stone');
    this.effects.update(0.016);
    this.director.spawnPowerup(0, 42);
    this.stage.render();
    if (z) this.zombies._release(z);
    for (const p of this.director.powerups) this.director._despawnPowerup(p);
    this.effects.clear();
  }

  /**
   * Touch mode. Pointer lock does not exist here, so the game is driven by the
   * on-screen controls; the rest is the housekeeping a phone needs to behave
   * like an app — landscape only, immersive, and the screen kept awake.
   */
  _setupTouch() {
    document.body.classList.add('touch');
    const t = this.touchInput;

    t.onPause = () => this._pause();
    t.onFirstTouch = () => this._enterImmersive();
    t.setAutoFire(this.settings.autoFire);
    t.sensitivity = 0.0035 * (this.settings.touchSensitivity / 100);
    t.invertY = this.settings.invertY;

    const checkOrientation = () => {
      const portrait = window.innerHeight > window.innerWidth;
      document.body.classList.toggle('portrait', portrait);
      t.refreshRects();
    };
    checkOrientation();
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', () => setTimeout(checkOrientation, 120));

    // Nothing in the page should ever scroll, zoom or select.
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
  }

  /** Fullscreen + landscape lock + wake lock. Each is best-effort. */
  async _enterImmersive() {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch { /* the WebView shell already runs immersive */ }
    try {
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
    } catch { /* not permitted outside fullscreen on some devices */ }
    try {
      if ('wakeLock' in navigator) {
        this._wakeLock = await navigator.wakeLock.request('screen');
        document.addEventListener('visibilitychange', async () => {
          if (document.visibilityState === 'visible' && !this._wakeLock) {
            try { this._wakeLock = await navigator.wakeLock.request('screen'); } catch { /* denied */ }
          }
        });
      }
    } catch { /* no wake lock support */ }
    audio.init();
  }

  get activeInput() {
    if (this.botMode) return this.botInput;
    return this.isTouch ? this.touchInput : this.input;
  }

  _wire() {
    this.combat.onPoints = (amount, kind) => {
      const gained = this.economy.award(amount, kind);
      this.hud.setPoints(this.economy.points, gained);
    };
    this.combat.onHitMarker = (crit, kill) => this.hud.hitMarker(crit, kill);
    this.combat.onNotice = (t) => this.hud.notice(t, 'bad');
    this.combat.onDamage = (point, amount, crit) => {
      if (amount >= 1e8) return;   // insta-kill reads as a kill, not a number
      this.hud.damageNumber(point, amount, crit);
    };

    this.zombies.onPlayerHit = (damage, z) => {
      this.player.takeDamage(damage, z.pos);
      this.hud.damageDirection(this.player.damageDir.x, this.player.damageDir.y);
      if (this.player.dead) this._onDeath();
    };
    this.zombies.onKill = (z, byPlayer) => {
      this.director.notifyKill(z);
      if (byPlayer) {
        const gained = this.economy.award(z.spec.points, 'kill');
        this.hud.setPoints(this.economy.points, gained);
        this.hud.killFeed(z.spec.name, !!z.spec.boss);
      }
      if (this.player.hasPerk('vampire')) this.player.heal(4);
    };
    this.zombies.onSpit = (origin, dir, spec) => {
      this.combat.spawnProjectile('spit', origin, dir, spec, spec.speed);
    };

    this.director.onAnnounce = (text, tone) => {
      const sub = tone === 'boss' ? 'Kill it before it reaches you'
        : tone === 'clear' ? 'Spend your points'
        : 'Hold the line';
      this.hud.announce(text, sub, tone === 'boss' ? 'boss' : tone === 'clear' ? 'good' : '');
    };
    this.director.onPowerup = (kind, def) => this._grantPowerup(kind, def);

    this.economy.onNotice = (t, tone) => this.hud.notice(t, tone);
    this.economy.onStatsChanged = () => this._applyPowerupState();

    this.input.onLockChange = (locked) => {
      if (locked && this._wantResume) {
        this._wantResume = false;
        this.state = 'playing';
        this._setScreen(null);
        audio.resume();
      } else if (!locked && this.state === 'playing') {
        this._pause();
      }
    };

    window.addEventListener('resize', () => this._resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this._pause();
    });
  }

  // -------------------------------------------------------------- powerups

  _grantPowerup(kind, def) {
    this.hud.announce(def.label, def.blurb, kind === 'nuke' ? 'gold' : 'good');
    audio.chime([72, 76, 79, 83], 0.07, 0.4);

    switch (kind) {
      case 'maxammo':
        this.combat.refillAll();
        break;

      case 'nuke': {
        // Everything on the street, at once.
        const list = this.zombies.alive.slice();
        let points = 0;
        this.stage.flash(0.9);
        this.stage.addShake(0.85);
        for (const z of list) {
          if (z.state === 'dying' || z.state === 'dead') continue;
          const d = this._tmpV.set(rand(-1, 1), 0.3, rand(-1, 1)).normalize();
          points += z.spec.points;
          this.zombies.damage(z, 1e9, z.pos, d, { crit: true, byPlayer: true });
          this.effects.explosion(z.pos, 2.4, 0x88ff66);
        }
        const gained = this.economy.award(points, 'kill');
        this.hud.setPoints(this.economy.points, gained);
        audio.explosion(this.player.pos, 1.6);
        break;
      }

      default: {
        // Timed effects; re-picking one refreshes rather than stacks.
        const existing = this.powerupsActive.find((p) => p.id === kind);
        if (existing) { existing.left = def.duration; break; }
        this.powerupsActive.push({
          id: kind, label: def.label, color: def.color, left: def.duration,
        });
        this._applyPowerupState();
        break;
      }
    }
  }

  _applyPowerupState() {
    const has = (id) => this.powerupsActive.some((p) => p.id === id);
    this.combat.instaKill = has('instakill');
    this.economy.pointsMultiplier = has('doublepoints') ? 2 : 1;
    this.zombies.globalSpeedMul = has('freeze') ? 0.32 : 1;
    this.combat.damageMul = has('carnage') ? 2 : 1;
    this.combat.fireRateMul = (this.player.hasPerk('doubletap') ? 1.33 : 1) * (has('carnage') ? 2 : 1);
    this.stage.grade.uniforms.uFreeze.value = has('freeze') ? 0.75 : 0;
    this.stage.grade.uniforms.uAdrenaline.value = has('carnage') ? 0.55 : 0;
  }

  _updatePowerups(dt) {
    if (!this.powerupsActive.length) return;
    let dirty = false;
    for (let i = this.powerupsActive.length - 1; i >= 0; i--) {
      const p = this.powerupsActive[i];
      p.left -= dt;
      if (p.left <= 0) {
        this.powerupsActive.splice(i, 1);
        dirty = true;
        this.hud.notice(`${p.label} ENDED`, 'bad');
      }
    }
    if (dirty) this._applyPowerupState();
  }

  // ----------------------------------------------------------------- flow

  startRun() {
    this.player.reset(new THREE.Vector3(0, 0, 20));
    this.zombies.clear();
    this.effects.clear();
    this.economy.reset();
    this.combat.owned = ['knife', 'pistol'];
    this.combat.index = 1;
    this.combat.ammo.clear();
    for (const id of this.combat.owned) this.combat._initAmmo(id);
    this.combat.instaKill = false;
    this.combat.damageMul = 1;
    this.combat.fireRateMul = 1;
    this.combat.reloadMul = 1;
    this.combat.upgrades.clear();
    this.combat.grenades = 3;
    this.combat._onSwitch();
    this.powerupsActive.length = 0;
    this._applyPowerupState();
    this.zombies.globalSpeedMul = 1;

    this.level.flow.compute(this.player.pos.x, this.player.pos.z, true);
    this.director.start();
    this.runTime = 0;

    for (const id of this.devGive) this.combat.give(id);
    if (this.devPoints) this.economy.points = this.devPoints;
    if (this.devWave > 1) this.director.wave = this.devWave - 1;

    this.hud.setPoints(this.economy.points, 0);
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setPerks(this.player.perks);
    this.hud.setHudVisible(true);

    this.state = 'playing';
    this._setScreen(null);
    document.body.classList.add('playing');
    if (this.touchInput) { this.touchInput.reset(); this.touchInput.refreshRects(); }
    if (!this.botMode) {
      audio.init();
      audio.startWind();
      const buf = this.assets.buffers.get('ambience');
      if (buf) audio.setAmbienceBuffer(buf);
      if (!this.isTouch) this.input.requestLock();
      else this._enterImmersive();
    }
  }

  _pause() {
    if (this.state !== 'playing') return;
    this._wantResume = false;
    this.state = 'paused';
    document.body.classList.remove('playing');
    if (this.touchInput) this.touchInput.reset();
    this.input.exitLock();
    audio.suspend();
    document.getElementById('pause-sub').textContent =
      `Wave ${this.director.wave} · ${fmt(this.economy.points)} points`;
    this._setScreen('pause');
  }

  _resume() {
    if (this.state !== 'paused' || this._wantResume) return;
    if (this.isTouch) {
      // No lock to reacquire — go straight back in.
      this.state = 'playing';
      document.body.classList.add('playing');
      this._setScreen(null);
      this.touchInput.reset();
      this.touchInput.refreshRects();
      audio.resume();
      return;
    }
    // Browsers rate-limit re-locking the pointer after an exit; ask, and let
    // the lock-change handler decide when we are actually back in the game.
    this._wantResume = true;
    this.input.requestLock();
    setTimeout(() => {
      if (this._wantResume && !this.input.locked) this.input.requestLock();
    }, 1400);
    setTimeout(() => {
      // Last resort: if the browser will not give the lock back, resume anyway
      // rather than trapping the player on the pause screen.
      if (this._wantResume) {
        this._wantResume = false;
        this.state = 'playing';
        this._setScreen(null);
        audio.resume();
      }
    }, 3000);
  }

  _onDeath() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.director.stop();
    document.body.classList.remove('playing');
    if (this.touchInput) this.touchInput.reset();
    this.input.exitLock();
    this.hud.setHudVisible(false);

    const run = {
      wave: this.director.wave,
      kills: this.director.totalKills,
      points: this.economy.earned,
      time: this.runTime,
    };
    const isBest = this._saveBest(run);

    document.getElementById('ov-wave').textContent = run.wave;
    document.getElementById('ov-kills').textContent = fmt(run.kills);
    document.getElementById('ov-points').textContent = fmt(run.points);
    document.getElementById('ov-time').textContent = formatTime(run.time);
    document.getElementById('over-sub').textContent = isBest
      ? 'A new best. The precinct is quiet again.'
      : 'The precinct is quiet again.';
    document.getElementById('best-run').textContent = this._bestLabel();

    audio.chime([55, 51, 48, 43], 0.28, 0.34, 'sawtooth');
    setTimeout(() => this._setScreen('gameover'), 1400);
  }

  _bestLabel() {
    const b = this._loadBest();
    return b ? `Wave ${b.wave} · ${fmt(b.points)} pts` : '—';
  }

  _setScreen(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('show');
    if (id) document.getElementById(id).classList.add('show');
    this._screen = id;
  }

  // -------------------------------------------------------------- settings

  _applySettings() {
    this.input.sensitivity = 0.0022 * (this.settings.sensitivity / 100);
    this.input.invertY = this.settings.invertY;
    audio.setVolume(this.settings.volume / 100);
    this.scaler.enabled = this.settings.adaptive;
    this.scaler.setTarget(this.settings.targetFps);

    for (const b of document.querySelectorAll('#seg-quality button')) {
      b.classList.toggle('on', b.dataset.q === this.presetKey);
    }
    for (const b of document.querySelectorAll('#seg-fps button')) {
      b.classList.toggle('on', Number(b.dataset.f) === this.settings.targetFps);
    }
    for (const b of document.querySelectorAll('#seg-adaptive button')) {
      b.classList.toggle('on', (b.dataset.a === '1') === !!this.settings.adaptive);
    }
    for (const b of document.querySelectorAll('#seg-invert button')) {
      b.classList.toggle('on', (b.dataset.i === '1') === !!this.settings.invertY);
    }
    const sens = document.getElementById('set-sens');
    const vol = document.getElementById('set-vol');
    sens.value = this.settings.sensitivity;
    vol.value = this.settings.volume;
    document.getElementById('val-sens').textContent = this.settings.sensitivity;
    document.getElementById('val-vol').textContent = this.settings.volume;

    for (const b of document.querySelectorAll('#seg-autofire button')) {
      b.classList.toggle('on', (b.dataset.af === '1') === !!this.settings.autoFire);
    }
    for (const b of document.querySelectorAll('#seg-assist button')) {
      b.classList.toggle('on', (b.dataset.aa === '1') === !!this.settings.aimAssist);
    }
    const tsens = document.getElementById('set-tsens');
    tsens.value = this.settings.touchSensitivity;
    document.getElementById('val-tsens').textContent = this.settings.touchSensitivity;

    if (this.touchInput) {
      this.touchInput.sensitivity = 0.0035 * (this.settings.touchSensitivity / 100);
      this.touchInput.invertY = this.settings.invertY;
      this.touchInput.setAutoFire(this.settings.autoFire);
    }
  }

  _setQuality(key) {
    if (!PRESETS[key] || key === this.presetKey) return;
    this.presetKey = key;
    this.preset = this._resolvePreset(key);
    this.settings.quality = key;
    this._saveSettings();

    this.stage.setPreset(this.preset);
    this.scaler.setPreset(this.preset);
    this.level.setLightBudget(this.preset.dynamicLights);
    this.zombies.preset = this.preset;
    this.zombies.setMaxAlive(this.preset.maxZombies);
    this.zombies.prewarm(this.preset.maxZombies);
    this.effects.setFog(this.stage.fogColor, this.preset.fogDensity);
    this.sky.matchFog(this.stage.fogColor);
    this._applySettings();
    // The composer (and with it the grade pass) was rebuilt, so re-apply any
    // power-up tint that was live when the quality changed.
    this._applyPowerupState();
    this.hud.notice(`QUALITY: ${this.preset.name.toUpperCase()}`, '');
  }

  _bindUI() {
    const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);

    on('btn-play', () => this.startRun());
    on('btn-settings', () => this._setScreen('settings'));
    on('btn-howto', () => this._setScreen('howto'));
    on('btn-credits', () => { this._buildCredits(); this._setScreen('credits'); });
    on('btn-credits-back', () => this._setScreen('menu'));
    on('btn-howto-back', () => this._setScreen('menu'));
    on('btn-settings-back', () => this._setScreen(this.state === 'paused' ? 'pause' : 'menu'));
    on('btn-resume', () => this._resume());
    on('btn-pause-settings', () => this._setScreen('settings'));
    on('btn-quit', () => {
      this.state = 'menu';
      document.body.classList.remove('playing');
      if (this.touchInput) this.touchInput.reset();
      this.director.stop();
      this.zombies.clear();
      this.effects.clear();
      this.hud.setHudVisible(false);
      this._setScreen('menu');
    });
    on('btn-retry', () => this.startRun());
    on('btn-menu', () => {
      this.state = 'menu';
      document.body.classList.remove('playing');
      if (this.touchInput) this.touchInput.reset();
      this.hud.setHudVisible(false);
      this._setScreen('menu');
    });

    for (const b of document.querySelectorAll('#seg-quality button')) {
      b.classList.add('clickable');
      b.addEventListener('click', () => this._setQuality(b.dataset.q));
    }
    for (const b of document.querySelectorAll('#seg-fps button')) {
      b.classList.add('clickable');
      b.addEventListener('click', () => {
        this.settings.targetFps = Number(b.dataset.f);
        this.scaler.setTarget(this.settings.targetFps);
        this._saveSettings(); this._applySettings();
      });
    }
    for (const b of document.querySelectorAll('#seg-adaptive button')) {
      b.classList.add('clickable');
      b.addEventListener('click', () => {
        this.settings.adaptive = b.dataset.a === '1';
        this.scaler.enabled = this.settings.adaptive;
        if (!this.settings.adaptive) this.stage.setRenderScale(this.preset.renderScale);
        this._saveSettings(); this._applySettings();
      });
    }
    for (const b of document.querySelectorAll('#seg-invert button')) {
      b.classList.add('clickable');
      b.addEventListener('click', () => {
        this.settings.invertY = b.dataset.i === '1';
        this._saveSettings(); this._applySettings();
      });
    }

    const sens = document.getElementById('set-sens');
    sens.addEventListener('input', () => {
      this.settings.sensitivity = Number(sens.value);
      document.getElementById('val-sens').textContent = sens.value;
      this.input.sensitivity = 0.0022 * (this.settings.sensitivity / 100);
      this._saveSettings();
    });
    for (const b of document.querySelectorAll('#seg-autofire button')) {
      b.classList.add('clickable');
      b.addEventListener('click', () => {
        this.settings.autoFire = b.dataset.af === '1';
        this._saveSettings(); this._applySettings();
      });
    }
    for (const b of document.querySelectorAll('#seg-assist button')) {
      b.classList.add('clickable');
      b.addEventListener('click', () => {
        this.settings.aimAssist = b.dataset.aa === '1';
        this._saveSettings(); this._applySettings();
      });
    }
    const tsens = document.getElementById('set-tsens');
    tsens.addEventListener('input', () => {
      this.settings.touchSensitivity = Number(tsens.value);
      document.getElementById('val-tsens').textContent = tsens.value;
      if (this.touchInput) this.touchInput.sensitivity = 0.0035 * (Number(tsens.value) / 100);
      this._saveSettings();
    });

    const vol = document.getElementById('set-vol');
    vol.addEventListener('input', () => {
      this.settings.volume = Number(vol.value);
      document.getElementById('val-vol').textContent = vol.value;
      audio.setVolume(this.settings.volume / 100);
      this._saveSettings();
    });

    // Clicking the canvas from the menu starts a run; from a paused run, resumes.
    this.canvas.addEventListener('click', () => {
      if (this.state === 'menu' && this._screen === 'menu') this.startRun();
      else if (this.state === 'paused' && this._screen === 'pause') this._resume();
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.state === 'playing') this._pause();
        else if (this.state === 'paused' && this._screen === 'pause') this._resume();
        else if (this._screen === 'settings' || this._screen === 'howto'
                 || this._screen === 'credits') {
          this._setScreen(this.state === 'paused' ? 'pause' : 'menu');
        }
      }
      if (e.code === 'F3') {
        e.preventDefault();
        this._perfOn = !this._perfOn;
        this.hud.togglePerf(this._perfOn);
      }
    });
  }

  /**
   * Credits, built from assets/credits.json — which is generated from the asset
   * manifest at download time, so it cannot drift as assets change. Several of
   * the models are CC-BY, which obliges us to attribute them somewhere a player
   * can actually read.
   */
  async _buildCredits() {
    const body = document.getElementById('credits-body');
    if (this._creditsBuilt) return;

    body.innerHTML = '<div class="engine">Loading…</div>';
    let doc = null;
    try {
      const res = await fetch('assets/credits.json');
      doc = await res.json();
    } catch {
      body.innerHTML = '<div class="engine">Credits manifest unavailable.</div>';
      return;
    }

    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const parts = [
      '<div class="engine">Engine: <b>three.js</b> r180 (MIT). '
      + 'Game code MIT. All audio synthesised at runtime.</div>',
    ];
    for (const e of doc.entries) {
      parts.push(`<div class="lic">${esc(e.license)}</div>`);
      parts.push(`<div class="files">${e.files.map(esc).join(' · ')}</div>`);
    }
    body.innerHTML = parts.join('');
    this._creditsBuilt = true;
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.stage.resize(w, h);
    if (this.effects) this.effects.setViewportHeight(h);
  }

  // ------------------------------------------------------------- game loop

  _frame = (now) => {
    requestAnimationFrame(this._frame);
    const frameStart = performance.now();

    // Clamp dt so an alt-tab or a GC pause cannot teleport the horde into you.
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;
    this.frameCount++;

    try {
      this.update(dt);
      this.stage.render();
    } catch (err) {
      // Never let one bad frame kill the loop silently.
      if (!this._loggedError) { this._loggedError = true; console.error(err); this.error = err; }
    }

    const frameMs = performance.now() - frameStart;
    this.frameAvg.push(frameMs);
    this.fpsAvg.push(1 / Math.max(dt, 1e-4));

    const newScale = this.scaler.update(frameMs, dt);
    if (newScale !== null) {
      this.stage.setRenderScale(newScale);
      this.hud.flashLowFps(newScale < this.preset.renderScale - 0.01);
    }

    if (this._perfOn && this.frameCount % 10 === 0) this._updatePerf(frameMs);
  };

  update(dt) {
    const playing = this.state === 'playing';
    const input = this.activeInput;

    if (this.botMode) this.botInput.update(dt, this);
    else if (this.touchInput) this.touchInput.tick(dt);

    if (playing) this.runTime += dt;

    this.player.update(dt, input, { canMove: playing });

    // Touch assists run after the look input has been applied and before
    // firing is resolved, so a shot fired this frame uses the assisted aim.
    if (playing && this.isTouch && !this.player.dead) this._updateTouchAssist(dt, input);

    // Death is checked here rather than only on the melee path: you can just
    // as easily be killed by your own grenade, a spitter, or a barrel you
    // stood too close to, and none of those go through the zombie hit callback.
    if (playing && this.player.dead) this._onDeath();

    this.combat.update(dt, input, { canAct: playing && !this.player.dead });
    this.economy.update(dt, input, playing && !this.player.dead);

    if (playing) {
      this.director.update(dt);
      this.zombies.update(dt, this.player, this.elapsed);
      this._updatePowerups(dt);
    }

    this.effects.update(dt);
    this.level.update(dt, this.player.pos, this.elapsed);
    this.sky.update(dt, this.elapsed, this.stage.camera.position);
    this.stage.update(dt, this.elapsed);

    // Ambient embers from the burning props near the player.
    if (playing && this.frameCount % 2 === 0) {
      for (const d of this.level.decorTargets) {
        if (d.pos.distanceToSquared(this.player.pos) > 900) continue;
        if (Math.random() < 0.35) this.effects.ember(d.pos, d.scale);
      }
    }

    // Combat intensity drives the music bed.
    if (playing) {
      const near = this.zombies.alive.filter((z) => z.distToPlayer < 18).length;
      audio.setIntensity(clamp(near / 12, 0, 1));
    }

    this._updateHud(dt, playing);
    input.endFrame();
  }

  /**
   * Aim assist and auto-fire.
   *
   * Auto-fire is an exact test — a ray down the crosshair that has to reach a
   * zombie without passing through geometry first — rather than a cone, so it
   * never fires at a wall. It is disabled for the knife and the grenade
   * launcher, where firing at whatever happens to be in front of you is a bad
   * idea for different reasons.
   */
  _updateTouchAssist(dt, input) {
    const t = this.touchInput;
    if (!t) return;

    if (this.settings.aimAssist) {
      this.player.aimAssist(dt, this.zombies, this.level.collision, {
        firing: input.buttons[0],
        looking: !!t.lookActive,
        strength: this.combat.adsAmount > 0.5 ? 4.6 : 3.4,
        cone: this.combat.adsAmount > 0.5 ? 0.10 : 0.15,
      });
    }

    let want = false;
    if (this.settings.autoFire) {
      const w = this.combat.spec;
      const canAuto = w.kind !== 'melee' && w.kind !== 'projectile';
      const ready = this.combat.mag > 0 && !this.combat.reloading && !this.player.sprinting;
      if (canAuto && ready) {
        const o = this._afOrigin || (this._afOrigin = new THREE.Vector3());
        const d = this._afDir || (this._afDir = new THREE.Vector3());
        this.player.aimRay(o, d);
        const maxDist = Math.min(w.range ?? 60, 70);
        const hit = this.zombies.raycast(o, d, maxDist, this._afOut || (this._afOut = {}));
        if (hit) {
          const wall = this.level.collision.raycast(o, d, hit.distance - 0.05,
            this._afWall || (this._afWall = {}));
          want = !wall;
        }
      }
    }

    // Never override a thumb that is already on the trigger.
    input.buttons[0] = t.fireHeld || want;
    if (want) input.buttonsPressed[0] = true;
  }

  /** Keeps the contextual touch buttons in step with the game state. */
  _updateTouchHud() {
    const t = this.touchInput;
    if (!t) return;

    const p = this.economy.prompt;
    t.setButtonVisible('interact', !!p);
    if (p) t.setLabel('interact', p.cost > 0 ? `${p.action} · ${fmt(p.cost)}` : p.action);

    const hud = this.combat.hudState();
    for (let i = 0; i < 4; i++) {
      const id = `slot${i + 1}`;
      const visible = i < hud.owned.length;
      t.setButtonVisible(id, visible);
      if (visible) {
        t.setLabel(id, hud.owned[i]);
        t.setActive(id, i === hud.index);
      }
    }
  }

  _updateHud(dt, playing) {
    const d = this.director;
    if (playing) {
      if (d.state === WAVE_STATE.PREPARING) {
        // Show the wave that is about to start, then the countdown to it.
        const next = d.wave + 1;
        this.hud.setWave(next, 0, 1, d.isBossWave(next));
        this.hud.setBreather(d.breather - d.stateT);
      } else {
        this.hud.setWave(d.wave, d.remaining, d.waveTotal || 1, d.isBossWave(d.wave));
      }

      this.hud.setHealth(this.player.health, this.player.maxHealth);
      this.hud.setPerks(this.player.perks);
      this.hud.setWeapon(this.combat.hudState());
      this.hud.setCrosshair(
        this.combat.currentSpread,
        this.combat.spec.kind === 'melee',
        this.combat.adsAmount > 0.6,
      );
      this.hud.setPrompt(this.economy.prompt);
      this.hud.setBoxSpin(this.economy.boxSpinLabel);
      this.hud.setPowerups(this.powerupsActive);
      this.hud.setPoints(this.economy.points, 0);
      if (this.isTouch) this._updateTouchHud();
    }

    // Grade uniforms driven by player state.
    const g = this.stage.grade.uniforms;
    g.uDamage.value = damp(g.uDamage.value, this.player.damageFlash, 9, dt);
    g.uHealth.value = damp(g.uHealth.value, this.player.health / this.player.maxHealth, 6, dt);

    this.hud.update(dt, this.stage.camera);
  }

  _updatePerf(frameMs) {
    const r = this.stage.renderer.info;
    const scale = this.stage.renderScale.toFixed(2);
    this.hud.setPerf(
      `${this.fpsAvg.mean.toFixed(0)} fps   ${this.frameAvg.mean.toFixed(1)} ms   ` +
      `scale ${scale}   ${this.preset.name}\n` +
      `draws ${r.render.calls}   tris ${fmt(r.render.triangles)}   ` +
      `progs ${r.programs.length}   zombies ${this.zombies.aliveCount}`,
    );
  }

  /** Snapshot used by the headless harness. */
  report() {
    return {
      ok: !this.error,
      error: this.error ? String(this.error.stack || this.error) : null,
      state: this.state,
      wave: this.director?.wave ?? 0,
      kills: this.director?.totalKills ?? 0,
      points: this.economy?.points ?? 0,
      health: Math.round(this.player?.health ?? 0),
      aliveZombies: this.zombies?.aliveCount ?? 0,
      weapons: this.combat?.owned ?? [],
      weapon: this.combat?.id,
      frameMs: Number(this.frameAvg.mean.toFixed(2)),
      fps: Number(this.fpsAvg.mean.toFixed(1)),
      renderScale: Number((this.stage?.renderScale ?? 1).toFixed(2)),
      draws: this.stage?.renderer.info.render.calls ?? 0,
      tris: this.stage?.renderer.info.render.triangles ?? 0,
      programs: this.stage?.renderer.info.programs.length ?? 0,
      preset: this.preset?.name,
      frames: this.frameCount,
      screen: this._screen ?? null,
      isTouch: !!this.isTouch,
      bodyClass: document.body.className,
      autoFire: !!this.settings.autoFire,
      aimAssist: !!this.settings.aimAssist,
      playerPosF: this.player ? [ +this.player.pos.x.toFixed(2), +this.player.pos.z.toFixed(2) ] : null,
      yaw: this.player ? +this.player.yaw.toFixed(3) : null,
      pitch: this.player ? +this.player.pitch.toFixed(3) : null,
      shotsFired: this.combat?.shotsFired ?? 0,
      shotsHit: this.combat?.shotsHit ?? 0,
      spawned: this.director?.spawnedThisWave ?? 0,
      waveState: this.director?.state,
      playerPos: this.player ? [Math.round(this.player.pos.x), Math.round(this.player.pos.z)] : null,
      loadingVisible: document.getElementById('loading').classList.contains('show'),
      shownScreens: [...document.querySelectorAll('.screen.show')].map((e) => e.id),
      runTime: Number(this.runTime.toFixed(1)),
      done: true,
    };
  }
}

/**
 * A scripted player used only by the headless harness: it walks, turns, shoots
 * and reloads so a test run exercises the whole loop — spawning, pathing,
 * hit detection, gore, wave transitions — without a human at the mouse.
 */
class BotInput {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0 };
    this.buttons = [false, false, false];
    this.buttonsPressed = [false, false, false];
    this.locked = true;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this._t = 0;
    this._yawRate = 0.6;
    this._fire = 0;
  }

  update(dt, game) {
    this._t += dt;

    // Face the nearest zombie when there is one; otherwise sweep.
    const z = game.zombies.nearest(game.player.pos.x, game.player.pos.z, 70);
    this._target = z;
    if (z) {
      const want = Math.atan2(-(z.pos.x - game.player.pos.x), -(z.pos.z - game.player.pos.z));
      let d = want - game.player.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.mouse.dx = -d / this.sensitivity * Math.min(1, dt * 9);
      this.buttons[0] = Math.abs(d) < 0.5;

      // Aim for the chest, which also exercises the pitch path.
      const dist = Math.hypot(z.pos.x - game.player.pos.x, z.pos.z - game.player.pos.z);
      const wantPitch = Math.atan2((z.pos.y + z.height * 0.65) - (game.player.pos.y + 1.68), dist);
      this.mouse.dy = -(wantPitch - game.player.pitch) / this.sensitivity * Math.min(1, dt * 9);
    } else {
      this.mouse.dx = -this._yawRate * dt / this.sensitivity;
      this.mouse.dy = 0;
      this.buttons[0] = false;
    }

    // Keep moving so pathing, collision and footsteps all get exercised.
    this.keys.clear();
    this.keys.add(Math.sin(this._t * 0.31) > -0.2 ? 'KeyW' : 'KeyS');
    if (Math.sin(this._t * 0.53) > 0.35) this.keys.add('KeyD');
    if (Math.sin(this._t * 0.47) < -0.35) this.keys.add('KeyA');
    // Sprinting locks out firing, so only sprint when nothing is in range.
    if (!z && Math.sin(this._t * 0.19) > 0.6) this.keys.add('ShiftLeft');

    this.pressed.clear();
    if (game.combat.mag === 0 && !game.combat.reloading) this.pressed.add('KeyR');
    if (Math.floor(this._t) % 17 === 0 && Math.floor(this._t) !== this._lastSwitch) {
      this._lastSwitch = Math.floor(this._t);
      this.pressed.add('Digit2');
    }
    // Exercise the economy: buy whatever station we happen to be standing at.
    if (game.economy.prompt && game.economy.prompt.affordable) this.pressed.add('KeyE');
    if (Math.sin(this._t * 0.9) > 0.98) this.pressed.add('KeyG');
    this.buttonsPressed[0] = this.buttons[0];
  }

  takeLook() {
    const yaw = -this.mouse.dx * this.sensitivity;
    const pitch = -this.mouse.dy * this.sensitivity;
    this.mouse.dx = 0; this.mouse.dy = 0;
    return { yaw, pitch };
  }
  takeWheel() { return 0; }
  down(c) { return this.keys.has(c); }
  hit(c) { return this.pressed.has(c); }
  up() { return false; }
  anyDown(...c) { return c.some((k) => this.keys.has(k)); }
  anyHit(...c) { return c.some((k) => this.pressed.has(k)); }
  moveAxis(out) {
    let x = 0, z = 0;
    if (this.keys.has('KeyW')) z += 1;
    if (this.keys.has('KeyS')) z -= 1;
    if (this.keys.has('KeyD')) x += 1;
    if (this.keys.has('KeyA')) x -= 1;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    out.x = x; out.z = z;
    return out;
  }
  endFrame() { this.pressed.clear(); this.buttonsPressed[0] = false; }
  requestLock() {}
  exitLock() {}
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

if (window.__bootBlocked) {
  // The capability gate in index.html already explained what is missing.
  console.warn('boot skipped:', window.__bootBlocked);
} else {
  const game = new Game();
  window.__game = game;
  game.boot().catch((e) => console.error('boot failed', e));
}
