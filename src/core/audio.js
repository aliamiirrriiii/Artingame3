import { clamp, rand } from './util.js';

/**
 * Every sound effect in the game is synthesised at runtime with the Web Audio
 * API — no sample downloads, no streaming stalls, and each shot/growl/impact is
 * subtly different because the parameters are randomised per call.
 *
 * Spatialisation is a cheap 2D approximation (distance gain + stereo pan from
 * the listener's right vector), which is all a first-person game needs and is
 * far cheaper than a full PannerNode per voice.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.masterVolume = 0.7;
    this._noise = null;
    this._pinkNoise = null;
    this.listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
    this._voices = 0;
    this._maxVoices = 48;
    this._ambienceBuffer = null;
    this._ambienceSource = null;
    this._musicTimer = 0;
    this._musicIntensity = 0;
  }

  /** Must be called from a user gesture (browsers block audio otherwise). */
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx({ latencyHint: 'interactive' });

    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVolume;

    // Glue compressor: keeps a minigun burst from clipping the mix.
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 8;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.18;

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 1.0;
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.34;

    this.sfxBus.connect(this.comp);
    this.musicBus.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(this.ctx.destination);

    this._buildNoise();
    this.ready = true;

    if (this._ambienceBuffer) this.startAmbience(this._ambienceBuffer);
  }

  _buildNoise() {
    const sr = this.ctx.sampleRate;
    const n = sr * 2;
    const white = this.ctx.createBuffer(1, n, sr);
    const wd = white.getChannelData(0);
    for (let i = 0; i < n; i++) wd[i] = Math.random() * 2 - 1;
    this._noise = white;

    // Voss-McCartney-ish pink noise: warmer body for explosions and wind.
    const pink = this.ctx.createBuffer(1, n, sr);
    const pd = pink.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    this._pinkNoise = pink;
  }

  setListener(pos, rightVec) {
    this.listener.x = pos.x; this.listener.y = pos.y; this.listener.z = pos.z;
    this.listener.rx = rightVec.x; this.listener.rz = rightVec.z;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.masterVolume;
  }

  setVolume(v) {
    this.masterVolume = clamp(v, 0, 1);
    if (this.master && !this.muted) this.master.gain.value = this.masterVolume;
  }

  /** Distance attenuation + stereo placement for a world-space emitter. */
  _spatial(pos, refDist = 6, maxDist = 70) {
    if (!pos) return { gain: 1, pan: 0, delay: 0 };
    const dx = pos.x - this.listener.x;
    const dy = pos.y - this.listener.y;
    const dz = pos.z - this.listener.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > maxDist) return null;
    const gain = refDist / (refDist + Math.max(0, dist - refDist) * 1.35);
    const inv = dist > 0.0001 ? 1 / dist : 0;
    const pan = clamp((dx * inv) * this.listener.rx + (dz * inv) * this.listener.rz, -1, 1);
    return { gain, pan, delay: Math.min(dist / 340, 0.18) };
  }

  /** Builds the per-voice output chain and auto-frees the voice slot. */
  _chain(spatial, dur) {
    const g = this.ctx.createGain();
    const p = this.ctx.createStereoPanner();
    p.pan.value = spatial.pan * 0.85;
    g.connect(p);
    p.connect(this.sfxBus);
    this._voices++;
    setTimeout(() => { this._voices--; try { p.disconnect(); } catch {} }, (dur + 0.3) * 1000);
    return g;
  }

  _canPlay() {
    return this.ready && !this.muted && this._voices < this._maxVoices;
  }

  _noiseSource(pink = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = pink ? this._pinkNoise : this._noise;
    s.loop = true;
    s.playbackRate.value = rand(0.9, 1.1);
    return s;
  }

  // ---------------------------------------------------------------- weapons

  /**
   * Layered gunshot: a transient noise crack, a filtered body "thump" that
   * carries the calibre, and a short tail. `spec` comes straight from the
   * weapon definition so every gun has its own voice.
   */
  gunshot(pos, spec = {}) {
    if (!this._canPlay()) return;
    const sp = this._spatial(pos, 8, 120);
    if (!sp) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + sp.delay;
    const {
      body = 150, crack = 3800, dur = 0.22, punch = 1.0, tail = 0.35, tone = 0.5,
    } = spec;

    const out = this._chain(sp, dur + tail);
    out.gain.value = sp.gain * 0.55 * punch;

    // Transient crack.
    const n = this._noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = crack * 0.35;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.setValueAtTime(crack, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(180, crack * 0.12), t + dur);
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(1.0, t + 0.002);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(hp); hp.connect(bp); bp.connect(ng); ng.connect(out);
    n.start(t); n.stop(t + dur + 0.05);

    // Low body — the part you feel.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(body, t);
    o.frequency.exponentialRampToValueAtTime(body * 0.35, t + dur * 0.9);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.9 * punch, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.1);
    o.connect(og); og.connect(out);
    o.start(t); o.stop(t + dur * 1.2);

    // Mid "snap" that distinguishes rifles from pistols.
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.setValueAtTime(body * 4.2, t);
    o2.frequency.exponentialRampToValueAtTime(body * 1.2, t + 0.05);
    const o2g = ctx.createGain();
    o2g.gain.setValueAtTime(0.0001, t);
    o2g.gain.exponentialRampToValueAtTime(0.28 * tone, t + 0.003);
    o2g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o2.connect(o2g); o2g.connect(out);
    o2.start(t); o2.stop(t + 0.09);

    // Environment tail.
    if (tail > 0.05) {
      const tn = this._noiseSource(true);
      const tf = ctx.createBiquadFilter();
      tf.type = 'lowpass';
      tf.frequency.setValueAtTime(1400, t);
      tf.frequency.exponentialRampToValueAtTime(220, t + tail);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.0001, t + 0.01);
      tg.gain.exponentialRampToValueAtTime(0.22, t + 0.04);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + tail);
      tn.connect(tf); tf.connect(tg); tg.connect(out);
      tn.start(t); tn.stop(t + tail + 0.05);
    }
  }

  /** Energy weapons: tesla, railgun, plasma. */
  zap(pos, spec = {}) {
    if (!this._canPlay()) return;
    const sp = this._spatial(pos, 8, 100);
    if (!sp) return;
    const ctx = this.ctx, t = ctx.currentTime + sp.delay;
    const { f0 = 1800, f1 = 120, dur = 0.34, buzz = 1 } = spec;
    const out = this._chain(sp, dur);
    out.gain.value = sp.gain * 0.4;

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const lfo = ctx.createOscillator();
    lfo.type = 'square'; lfo.frequency.value = 55 * buzz;
    const lfoG = ctx.createGain(); lfoG.gain.value = f0 * 0.28;
    lfo.connect(lfoG); lfoG.connect(o.frequency);

    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass'; flt.frequency.value = 1200; flt.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.85, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(flt); flt.connect(g); g.connect(out);
    o.start(t); o.stop(t + dur);
    lfo.start(t); lfo.stop(t + dur);
  }

  /** Flamethrower loop tick — called continuously while firing. */
  flame(pos) {
    if (!this._canPlay()) return;
    const sp = this._spatial(pos, 7, 45);
    if (!sp) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._chain(sp, 0.2);
    out.gain.value = sp.gain * 0.3;
    const n = this._noiseSource(true);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = rand(500, 1400); f.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.7, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t); n.stop(t + 0.2);
  }

  explosion(pos, power = 1) {
    if (!this._canPlay()) return;
    const sp = this._spatial(pos, 14, 180);
    if (!sp) return;
    const ctx = this.ctx, t = ctx.currentTime + sp.delay;
    const dur = 0.9 * power;
    const out = this._chain(sp, dur);
    out.gain.value = sp.gain * 0.85;

    const n = this._noiseSource(true);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.0, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(lp); lp.connect(g); g.connect(out);
    n.start(t); n.stop(t + dur);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(90 * power, t);
    sub.frequency.exponentialRampToValueAtTime(26, t + dur * 0.8);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(1.0, t + 0.02);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    sub.connect(sg); sg.connect(out);
    sub.start(t); sub.stop(t + dur);
  }

  // ------------------------------------------------------------- impacts

  /** Wet flesh hit. `crit` gives the bone-crunch layer for headshots. */
  flesh(pos, crit = false) {
    if (!this._canPlay()) return;
    const sp = this._spatial(pos, 6, 55);
    if (!sp) return;
    const ctx = this.ctx, t = ctx.currentTime + sp.delay;
    const dur = crit ? 0.24 : 0.12;
    const out = this._chain(sp, dur);
    out.gain.value = sp.gain * (crit ? 0.65 : 0.42);

    const n = this._noiseSource(true);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(crit ? 1800 : 900, t);
    f.frequency.exponentialRampToValueAtTime(140, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t); n.stop(t + dur);

    if (crit) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(rand(180, 260), t);
      o.frequency.exponentialRampToValueAtTime(60, t + 0.1);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.6, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(og); og.connect(out);
      o.start(t); o.stop(t + 0.13);
    }
  }

  /** Bullet striking stone / metal — the ricochet whine sells the miss. */
  ricochet(pos, metal = false) {
    if (!this._canPlay()) return;
    const sp = this._spatial(pos, 6, 60);
    if (!sp) return;
    const ctx = this.ctx, t = ctx.currentTime + sp.delay;
    const out = this._chain(sp, 0.3);
    out.gain.value = sp.gain * 0.3;

    const n = this._noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.8, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t); n.stop(t + 0.08);

    if (metal || Math.random() < 0.45) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f0 = rand(1400, 3200);
      o.frequency.setValueAtTime(f0, t + 0.01);
      o.frequency.exponentialRampToValueAtTime(f0 * rand(0.3, 0.6), t + 0.28);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t + 0.01);
      og.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(og); og.connect(out);
      o.start(t + 0.01); o.stop(t + 0.31);
    }
  }

  // ------------------------------------------------------------- zombies

  /**
   * Zombie vocals. A detuned pair of saw/growl oscillators through a formant-ish
   * bandpass; `kind` shifts register so a brute sounds nothing like a crawler.
   */
  growl(pos, kind = 'walker', aggro = 0) {
    if (!this._canPlay()) return;
    const sp = this._spatial(pos, 7, 48);
    if (!sp) return;
    const ctx = this.ctx, t = ctx.currentTime + sp.delay;

    const profiles = {
      walker:  { f: 96,  dur: 1.0, q: 3.5, vol: 0.30 },
      runner:  { f: 140, dur: 0.55, q: 5.0, vol: 0.34 },
      crawler: { f: 175, dur: 0.5, q: 6.0, vol: 0.26 },
      brute:   { f: 46,  dur: 1.6, q: 2.4, vol: 0.55 },
      spitter: { f: 118, dur: 0.8, q: 7.0, vol: 0.30 },
      screamer:{ f: 300, dur: 1.5, q: 9.0, vol: 0.6 },
      boss:    { f: 32,  dur: 2.4, q: 2.0, vol: 0.8 },
    };
    const p = profiles[kind] || profiles.walker;
    const dur = p.dur * rand(0.85, 1.2);
    const out = this._chain(sp, dur);
    out.gain.value = sp.gain * p.vol * (1 + aggro * 0.3);

    const base = p.f * rand(0.88, 1.14);
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'sawtooth' : 'square';
      o.frequency.setValueAtTime(base * (i ? 1.005 : 1) * rand(0.95, 1.05), t);
      o.frequency.linearRampToValueAtTime(base * rand(0.6, 1.5), t + dur);

      // Throat wobble.
      const wob = ctx.createOscillator();
      wob.type = 'sine';
      wob.frequency.value = rand(4, 11);
      const wg = ctx.createGain();
      wg.gain.value = base * 0.16;
      wob.connect(wg); wg.connect(o.frequency);
      wob.start(t); wob.stop(t + dur);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(base * rand(5, 9), t);
      bp.frequency.linearRampToValueAtTime(base * rand(3, 6), t + dur);
      bp.Q.value = p.q;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(i ? 0.25 : 0.6, t + dur * 0.22);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      o.connect(bp); bp.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur);
    }

    // Breath / rasp layer.
    const n = this._noiseSource(true);
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = rand(700, 1900); nf.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.3, t + dur * 0.3);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(nf); nf.connect(ng); ng.connect(out);
    n.start(t); n.stop(t + dur);
  }

  // --------------------------------------------------------------- UI/misc

  /** Short mechanical tick — reload steps, weapon swap, button presses. */
  click(freq = 900, dur = 0.05, vol = 0.28, pos = null) {
    if (!this._canPlay()) return;
    const sp = pos ? this._spatial(pos, 6, 40) : { gain: 1, pan: 0, delay: 0 };
    if (!sp) return;
    const ctx = this.ctx, t = ctx.currentTime + sp.delay;
    const out = this._chain(sp, dur);
    out.gain.value = sp.gain * vol;
    const n = this._noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t); n.stop(t + dur + 0.02);
  }

  /** Musical UI cue — pickups, perks, wave clear. `notes` are midi numbers. */
  chime(notes = [72, 76, 79], step = 0.075, vol = 0.3, type = 'triangle') {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = vol;
    out.connect(this.musicBus);
    notes.forEach((m, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
      const g = ctx.createGain();
      const t = t0 + i * step;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.8, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.45);
    });
    setTimeout(() => { try { out.disconnect(); } catch {} }, (notes.length * step + 1) * 1000);
  }

  /** Rising dread sting when a wave begins. */
  waveHorn(wave = 1) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(this.musicBus);
    const base = 55 * Math.pow(2, ((wave - 1) % 5) / 12);
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'sawtooth' : 'sine';
      o.frequency.setValueAtTime(base * (i + 1) * 0.99, t);
      o.frequency.linearRampToValueAtTime(base * (i + 1) * 1.02, t + 2.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(i === 2 ? 0.12 : 0.4, t + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 2.7);
    }
    setTimeout(() => { try { out.disconnect(); } catch {} }, 3200);
  }

  playerHurt(severity = 1) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.45 * severity;
    out.connect(this.sfxBus);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(rand(150, 220), t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.5);
    setTimeout(() => { try { out.disconnect(); } catch {} }, 900);
  }

  /** Heartbeat when near death — driven by the HUD each beat. */
  heartbeat(intensity = 1) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.5 * intensity;
    out.connect(this.sfxBus);
    for (const off of [0, 0.16]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(62, t + off);
      o.frequency.exponentialRampToValueAtTime(28, t + off + 0.13);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(off ? 0.6 : 1, t + off + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.16);
      o.connect(g); g.connect(out);
      o.start(t + off); o.stop(t + off + 0.18);
    }
    setTimeout(() => { try { out.disconnect(); } catch {} }, 700);
  }

  footstep(pos, running = false) {
    this.click(running ? rand(180, 300) : rand(120, 200), running ? 0.07 : 0.09,
      running ? 0.14 : 0.08, pos);
  }

  // ------------------------------------------------------------- ambience

  setAmbienceBuffer(arrayBuffer) {
    if (!this.ctx) { this._ambienceBuffer = arrayBuffer; return; }
    this.ctx.decodeAudioData(arrayBuffer.slice(0)).then((buf) => {
      this._ambienceBuffer = buf;
      this.startAmbience(buf);
    }).catch(() => {});
  }

  startAmbience(buf) {
    if (!this.ready || !buf || buf instanceof ArrayBuffer) return;
    if (this._ambienceSource) { try { this._ambienceSource.stop(); } catch {} }
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = 0.62; // pitched down into an uneasy drone
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 620;
    const g = this.ctx.createGain();
    g.gain.value = 0.16;
    s.connect(f); f.connect(g); g.connect(this.musicBus);
    s.start();
    this._ambienceSource = s;
    this._ambienceGain = g;
  }

  /** Wind bed whose brightness tracks combat intensity. */
  startWind() {
    if (!this.ready || this._wind) return;
    const ctx = this.ctx;
    const n = this._noiseSource(true);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 340; f.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0.09;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.07;
    const lg = ctx.createGain(); lg.gain.value = 0.045;
    lfo.connect(lg); lg.connect(g.gain);
    n.connect(f); f.connect(g); g.connect(this.musicBus);
    n.start(); lfo.start();
    this._wind = { n, f, g, lfo };
  }

  /** 0..1 — raises the ambience as the horde closes in. */
  setIntensity(v) {
    this._musicIntensity = clamp(v, 0, 1);
    if (this._wind) {
      this._wind.f.frequency.value = 300 + this._musicIntensity * 900;
      this._wind.g.gain.value = 0.07 + this._musicIntensity * 0.1;
    }
    if (this._ambienceGain) {
      this._ambienceGain.gain.value = 0.12 + this._musicIntensity * 0.14;
    }
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
}

export const audio = new AudioEngine();
