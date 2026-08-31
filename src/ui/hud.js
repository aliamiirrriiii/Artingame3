import * as THREE from 'three';
import { clamp, lerp, fmt, rand } from '../core/util.js';
import { PERKS } from '../game/economy.js';

/**
 * The HUD.
 *
 * Everything here is DOM rather than drawn into the canvas: text stays crisp at
 * any resolution (including when the adaptive scaler drops render resolution
 * below native), it costs no GPU time, and it does not have to be re-uploaded
 * every frame. Updates are guarded so we only touch the DOM when a value has
 * actually changed — writing to `textContent` sixty times a second for numbers
 * that did not move is a real cost.
 */

const $ = (id) => document.getElementById(id);

/** Pixels per degree on the compass strip: 330px of strip shows ~89 degrees. */
const COMPASS_PPD = 3.7;
/** Above this magazine size the pip row switches from one-per-round to a scale. */
const MAX_PIPS = 24;

export class HUD {
  constructor(stage) {
    this.stage = stage;

    this.el = {
      crosshair: $('crosshair'),
      chT: $('ch-t'), chB: $('ch-b'), chL: $('ch-l'), chR: $('ch-r'), chDot: $('ch-dot'),
      hitmarker: $('hitmarker'),
      waveNum: $('wave-num'), waveSub: $('wave-sub'), waveFill: $('wave-fill'),
      points: $('points'), pointsDelta: $('points-delta'),
      healthFill: $('health-fill'), healthGhost: $('health-ghost'), healthNum: $('health-num'),
      perks: $('perks'),
      weaponName: $('weapon-name'), ammoMag: $('ammo-mag'), ammoRes: $('ammo-res'),
      ammo: $('ammo'),
      reloadBar: $('reload-bar'), reloadFill: $('reload-fill'),
      chargeBar: $('charge-bar'), chargeFill: $('charge-fill'),
      slots: $('slots'), grenades: $('grenades'),
      announce: $('announce'),
      announceBig: document.querySelector('#announce .big'),
      announceSmall: document.querySelector('#announce .small'),
      notices: $('notice-stack'),
      prompt: $('prompt'),
      promptTitle: document.querySelector('#prompt .ptitle'),
      promptDetail: document.querySelector('#prompt .pdetail'),
      promptAction: document.querySelector('#prompt .paction'),
      damageRing: $('damage-ring'),
      hurtVignette: $('vignette-hurt'),
      dmgLayer: $('dmg-layer'),
      powerupBar: $('powerup-bar'),
      perf: $('perf'),
      boxSpin: $('box-spin'),
      lowfps: $('lowfps'),
      compass: $('compass'),
      compassMarks: $('compass-marks'),
      magPips: $('mag-pips'),
      killfeed: $('killfeed'),
      gore: $('gore'),
      conditions: $('conditions'),
    };

    this.cache = {};
    this._pointsShown = 0;
    this._deltaTimer = 0;
    this._deltaAccum = 0;
    this._announceTimer = 0;

    this._buildDamageNumbers();
    this._buildCompass();
    this._projected = new THREE.Vector3();
    this._facing = new THREE.Vector3();
    this._pips = [];
  }

  // --------------------------------------------------------------- compass

  /*
   * A bearing strip. The marks are laid out once across two full turns and the
   * whole strip is slid under a fixed centre index, which is both cheaper than
   * re-laying it out every frame and free of the seam you get from wrapping a
   * single 360-degree run: the window we show is always well inside the second
   * turn, so there is never an edge to fall off.
   */
  _buildCompass() {
    const marks = this.el.compassMarks;
    if (!marks) return;
    const CARD = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = 0; d <= 720; d += 15) {
      const bearing = d % 360;
      const label = CARD[bearing];
      const tick = document.createElement('div');
      tick.className = label ? 'm major' : 'm';
      tick.style.left = `${d * COMPASS_PPD}px`;
      marks.appendChild(tick);
      if (!label) continue;
      const cap = document.createElement('div');
      cap.className = label.length === 1 ? 'c' : 'c ord';
      cap.style.left = `${d * COMPASS_PPD}px`;
      cap.textContent = label;
      marks.appendChild(cap);
    }
    marks.style.width = `${720 * COMPASS_PPD}px`;
    this._compassX = null;
  }

  _updateCompass(camera) {
    const marks = this.el.compassMarks;
    if (!marks) return;
    camera.getWorldDirection(this._facing);
    // Bearing is measured off -Z, which is the direction the arena's north wall
    // faces, so "N" points the way the player starts out looking.
    let bearing = Math.atan2(this._facing.x, -this._facing.z) * (180 / Math.PI);
    if (bearing < 0) bearing += 360;
    // Offset into the second turn so the visible window never runs off an end.
    const x = this._halfCompass() - (bearing + 360) * COMPASS_PPD;
    if (this._compassX !== null && Math.abs(this._compassX - x) < 0.25) return;
    this._compassX = x;
    marks.style.transform = `translateX(${x.toFixed(1)}px)`;
  }

  /** Cached because reading offsetWidth every frame forces a layout. */
  _halfCompass() {
    if (this._compassHalf === undefined || this._compassW !== window.innerWidth) {
      this._compassW = window.innerWidth;
      this._compassHalf = (this.el.compass?.offsetWidth || 330) / 2;
      this._compassX = null;
    }
    return this._compassHalf;
  }

  // ------------------------------------------------------------ core stats

  setWave(n, remaining, total, boss) {
    if (this.cache.wave !== n) {
      this.cache.wave = n;
      this.el.waveNum.textContent = n;
      this.el.waveNum.classList.toggle('boss', !!boss);
    }
    if (this.cache.remaining !== remaining) {
      this.cache.remaining = remaining;
      this.el.waveSub.textContent = remaining > 0
        ? `${remaining} remaining`
        : 'street clear';
    }
    const pct = total > 0 ? clamp(1 - remaining / total, 0, 1) * 100 : 0;
    if (Math.abs((this.cache.wavePct ?? -1) - pct) > 0.9) {
      this.cache.wavePct = pct;
      this.el.waveFill.style.width = `${pct}%`;
    }
  }

  setBreather(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    if (this.cache.breather !== s) {
      this.cache.breather = s;
      this.el.waveSub.textContent = `next wave in ${s}`;
      this.cache.remaining = -1;
    }
  }

  setPoints(points, delta = 0) {
    if (delta > 0) {
      this._deltaAccum += delta;
      this._deltaTimer = 1.1;
      this.el.pointsDelta.textContent = `+${fmt(this._deltaAccum)}`;
      this.el.pointsDelta.classList.add('show');
    }
    if (this.cache.points !== points) {
      this.cache.points = points;
      this.el.points.textContent = fmt(points);
    }
  }

  setHealth(hp, max) {
    const pct = clamp(hp / max, 0, 1) * 100;
    if (Math.abs((this.cache.hp ?? -1) - pct) > 0.4) {
      this.cache.hp = pct;
      this.el.healthFill.style.width = `${pct}%`;
      // Ghost bar trails behind, so you can see how much you just lost.
      this.el.healthGhost.style.width = `${pct}%`;
    }
    const shown = Math.ceil(hp);
    if (this.cache.hpNum !== shown) {
      this.cache.hpNum = shown;
      this.el.healthNum.textContent = shown;
    }
    const hurt = clamp(1 - hp / max, 0, 1);
    this.el.hurtVignette.style.opacity = hurt > 0.55 ? (hurt - 0.55) / 0.45 * 0.9 : 0;
  }

  setPerks(perkSet) {
    const key = [...perkSet].sort().join(',');
    if (this.cache.perks === key) return;
    this.cache.perks = key;
    this.el.perks.innerHTML = '';
    for (const id of perkSet) {
      const p = PERKS[id];
      if (!p) continue;
      const d = document.createElement('div');
      d.className = 'perk';
      d.style.color = p.color;
      // Initials, not the first two letters: "DOUBLE TAP" abbreviated by
      // truncation reads as the word "DO", and "SPEED COLA" as "SP". One
      // letter per word is how a player expects a chip to be labelled.
      d.textContent = p.name.split(/[\s-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2);
      d.title = `${p.name} — ${p.blurb}`;
      this.el.perks.appendChild(d);
    }
  }

  setWeapon(w) {
    if (this.cache.weaponName !== w.name) {
      this.cache.weaponName = w.name;
      this.el.weaponName.textContent = w.name;
    }
    const magStr = String(w.mag);
    if (this.cache.mag !== magStr) {
      this.cache.mag = magStr;
      this.el.ammoMag.textContent = magStr;
    }
    const resStr = `/ ${w.reserve}`;
    if (this.cache.res !== resStr) {
      this.cache.res = resStr;
      this.el.ammoRes.textContent = resStr;
    }
    if (this.cache.low !== w.lowAmmo) {
      this.cache.low = w.lowAmmo;
      this.el.ammo.classList.toggle('low', w.lowAmmo);
    }
    this._setMagPips(w.mag, w.magSize);

    if (this.cache.reloading !== w.reloading) {
      this.cache.reloading = w.reloading;
      this.el.reloadBar.classList.toggle('show', w.reloading);
    }
    if (w.reloading) this.el.reloadFill.style.width = `${w.reloadProgress * 100}%`;

    const charging = w.charge > 0.001;
    if (this.cache.charging !== charging) {
      this.cache.charging = charging;
      this.el.chargeBar.classList.toggle('show', charging);
    }
    if (charging) this.el.chargeFill.style.width = `${w.charge * 100}%`;

    const gren = `FRAGS ×${w.grenades}`;
    if (this.cache.gren !== gren) {
      this.cache.gren = gren;
      this.el.grenades.textContent = gren;
    }

    const slotKey = w.owned.join(',') + '|' + w.index;
    if (this.cache.slots !== slotKey) {
      this.cache.slots = slotKey;
      this.el.slots.innerHTML = '';
      w.owned.forEach((short, i) => {
        const d = document.createElement('div');
        d.className = 'slot' + (i === w.index ? ' active' : '');
        d.textContent = `${i + 1} ${short}`;
        this.el.slots.appendChild(d);
      });
    }
  }

  /*
   * Rounds left, as ticks. One tick per round while that stays readable; past
   * that the row becomes a coarser scale, because twenty-four ticks you can
   * count at a glance beat a hundred you cannot.
   */
  _setMagPips(mag, magSize) {
    const size = typeof magSize === 'number' && isFinite(magSize) ? magSize : 0;
    const count = size > 0 ? Math.min(size, MAX_PIPS) : 0;
    if (this.cache.pipCount !== count) {
      this.cache.pipCount = count;
      this.el.magPips.innerHTML = '';
      this._pips = [];
      for (let i = 0; i < count; i++) {
        const d = document.createElement('div');
        d.className = 'pip';
        this.el.magPips.appendChild(d);
        this._pips.push(d);
      }
      this.cache.pipsFilled = -1;
    }
    if (count === 0) return;
    const rounds = typeof mag === 'number' ? mag : size;
    const filled = clamp(Math.ceil((rounds / size) * count), 0, count);
    if (this.cache.pipsFilled === filled) return;
    this.cache.pipsFilled = filled;
    for (let i = 0; i < count; i++) this._pips[i].classList.toggle('spent', i >= filled);
  }

  // ---------------------------------------------------------- wave conditions

  /**
   * What is different about this wave.
   *
   * Named and left on screen for the whole wave, not flashed once: a rule the
   * player cannot name is indistinguishable from the game being inconsistent,
   * and half of these are only visible in how the wave behaves.
   */
  setConditions(list) {
    const el = this.el.conditions;
    if (!el) return;
    const key = list.map((c) => c.name).join('|');
    if (this.cache.conditions === key) return;
    this.cache.conditions = key;
    el.textContent = '';
    for (const c of list) {
      const d = document.createElement('div');
      d.className = 'cond';
      d.textContent = c.name;
      if (c.blurb) {
        const b = document.createElement('span');
        b.textContent = c.blurb;
        d.appendChild(b);
      }
      el.appendChild(d);
    }
  }

  // -------------------------------------------------------------- kill feed

  /** One line per kill, newest at the bottom. Purely feedback — no state. */
  killFeed(name, crit = false, tag = '') {
    const row = document.createElement('div');
    row.className = crit ? 'kf crit' : 'kf';
    const b = document.createElement('b');
    b.textContent = name;
    row.appendChild(b);
    if (tag) {
      const i = document.createElement('i');
      i.textContent = tag;
      row.appendChild(i);
    }
    this.el.killfeed.appendChild(row);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.firstChild.remove();
    setTimeout(() => row.remove(), 3200);
  }

  // -------------------------------------------------------------- lens gore

  /**
   * Blood on the lens. `power` is 0..1 — one small fleck for a kill across the
   * street, a faceful for one at arm's length.
   *
   * Deliberately not a red wash over the whole screen: that is what taking
   * damage looks like, and the two must never be confusable. These are
   * discrete blobs, weighted toward the edges so the middle of the screen —
   * where the player is actually aiming — stays readable.
   */
  gore(power = 1) {
    const layer = this.el.gore;
    if (!layer || power <= 0.02) return;
    const n = Math.round(clamp(1 + power * 5, 1, 7));
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      const fine = Math.random() < 0.45;
      el.className = fine ? 'splat fine' : 'splat';
      const size = (fine ? rand(14, 44) : rand(40, 150)) * (0.55 + power * 0.75);
      // Push the blob off centre: |x| biased outward, so the crosshair stays clear.
      const ex = (Math.random() < 0.5 ? -1 : 1) * (0.18 + Math.random() * 0.34);
      const ey = (Math.random() < 0.5 ? -1 : 1) * (0.10 + Math.random() * 0.38);
      el.style.width = `${size}px`;
      el.style.height = `${size * rand(0.62, 1.35)}px`;
      el.style.left = `${(0.5 + ex) * 100}%`;
      el.style.top = `${(0.5 + ey) * 100}%`;
      el.style.setProperty('--r', `${Math.round(rand(0, 360))}deg`);
      el.style.animationDelay = `${Math.round(rand(0, 70))}ms`;
      layer.appendChild(el);
      setTimeout(() => el.remove(), 3000);
    }
    // A cap, so a shotgun into a crowd cannot paper the screen.
    while (layer.children.length > 26) layer.firstChild.remove();
  }

  // ------------------------------------------------------------- crosshair

  /** Crosshair gap follows the weapon's live spread, so it tells the truth. */
  setCrosshair(spreadDeg, hidden = false, ads = false) {
    const gap = clamp(3 + spreadDeg * 2.6, 3, 26);
    if (Math.abs((this.cache.gap ?? -1) - gap) > 0.35) {
      this.cache.gap = gap;
      this.el.chT.style.top = `${23 - gap - 8}px`;
      this.el.chB.style.bottom = `${23 - gap - 8}px`;
      this.el.chL.style.left = `${23 - gap - 8}px`;
      this.el.chR.style.right = `${23 - gap - 8}px`;
    }
    const hide = hidden || ads;
    if (this.cache.chHidden !== hide) {
      this.cache.chHidden = hide;
      this.el.crosshair.classList.toggle('hidden', hide);
    }
  }

  hitMarker(crit, kill) {
    const el = this.el.hitmarker;
    el.classList.remove('show', 'crit', 'kill');
    void el.offsetWidth;   // restart the animation
    if (kill) el.classList.add('kill');
    else if (crit) el.classList.add('crit');
    el.classList.add('show');
  }

  // ---------------------------------------------------------- damage feed

  damageDirection(screenX, screenY) {
    // `screenX/Y` are the attacker's direction in view space (-1..1).
    const angle = Math.atan2(screenX, screenY) * (180 / Math.PI);
    const arc = document.createElement('div');
    arc.className = 'dmg-arc';
    arc.style.transform = `rotate(${angle - 90}deg)`;
    this.el.damageRing.appendChild(arc);
    setTimeout(() => arc.remove(), 1200);
  }

  _buildDamageNumbers() {
    this._dmgPool = [];
    for (let i = 0; i < 22; i++) {
      const el = document.createElement('div');
      el.className = 'dmg-num';
      el.style.opacity = '0';
      this.el.dmgLayer.appendChild(el);
      this._dmgPool.push({ el, active: false, t: 0, ttl: 1, world: new THREE.Vector3(), value: 0, crit: false });
    }
  }

  /** Floating damage number anchored to a world position. */
  damageNumber(worldPos, value, crit) {
    const slot = this._dmgPool.find((d) => !d.active);
    if (!slot) return;
    slot.active = true;
    slot.t = 0;
    slot.ttl = crit ? 1.15 : 0.85;
    slot.world.copy(worldPos);
    slot.value = Math.round(value);
    slot.crit = crit;
    slot.el.textContent = crit ? `${slot.value}!` : slot.value;
    slot.el.className = 'dmg-num' + (crit ? ' crit' : '');
  }

  _updateDamageNumbers(dt, camera) {
    for (const d of this._dmgPool) {
      if (!d.active) continue;
      d.t += dt;
      if (d.t >= d.ttl) {
        d.active = false;
        d.el.style.opacity = '0';
        continue;
      }
      const k = d.t / d.ttl;
      this._projected.copy(d.world);
      this._projected.y += k * 0.85;
      this._projected.project(camera);

      if (this._projected.z > 1 || Math.abs(this._projected.x) > 1.2) {
        d.el.style.opacity = '0';
        continue;
      }
      const x = (this._projected.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-this._projected.y * 0.5 + 0.5) * window.innerHeight;
      const scale = d.crit ? 1 + (1 - k) * 0.35 : 1;
      d.el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${scale.toFixed(2)})`;
      d.el.style.opacity = String(clamp(1 - k * k, 0, 1) * 0.95);
    }
  }

  // ------------------------------------------------------------- messaging

  announce(big, small = '', tone = '') {
    const el = this.el.announce;
    this.el.announceBig.textContent = big;
    this.el.announceSmall.textContent = small;
    el.className = tone ? tone : '';
    void el.offsetWidth;
    el.classList.add('show');
  }

  notice(text, tone = '') {
    const d = document.createElement('div');
    d.className = `notice ${tone}`;
    d.textContent = text;
    this.el.notices.appendChild(d);
    // Keep the stack short so it never runs off the screen.
    while (this.el.notices.children.length > 5) this.el.notices.firstChild.remove();
    setTimeout(() => d.remove(), 2500);
  }

  setPrompt(p) {
    const el = this.el.prompt;
    if (!p) {
      if (this.cache.prompt !== null) {
        this.cache.prompt = null;
        el.classList.remove('show');
      }
      return;
    }
    const key = `${p.title}|${p.action}|${p.cost}|${p.affordable}`;
    if (this.cache.prompt === key) return;
    this.cache.prompt = key;

    this.el.promptTitle.textContent = p.title;
    this.el.promptTitle.style.color = p.color || '';
    this.el.promptDetail.textContent = p.detail || '';
    this.el.promptAction.innerHTML = p.cost > 0
      ? `<kbd>E</kbd> ${p.action} — ${fmt(p.cost)}`
      : `<kbd>E</kbd> ${p.action}`;
    el.classList.toggle('cant', !p.affordable && p.cost > 0);
    el.classList.add('show');
  }

  setBoxSpin(label) {
    const el = this.el.boxSpin;
    if (!label) {
      if (this.cache.box !== null) { this.cache.box = null; el.classList.remove('show'); }
      return;
    }
    if (this.cache.box !== label) {
      this.cache.box = label;
      el.textContent = label;
      el.classList.add('show');
    }
  }

  setPowerups(active) {
    const key = active.map((a) => `${a.id}:${Math.ceil(a.left)}`).join(',');
    if (this.cache.pu === key) return;
    this.cache.pu = key;
    this.el.powerupBar.innerHTML = '';
    for (const a of active) {
      const d = document.createElement('div');
      d.className = 'pu';
      d.style.color = `#${a.color.toString(16).padStart(6, '0')}`;
      d.textContent = `${a.label} ${Math.ceil(a.left)}s`;
      this.el.powerupBar.appendChild(d);
    }
  }

  setPerf(text) {
    if (this.cache.perf !== text) {
      this.cache.perf = text;
      this.el.perf.textContent = text;
    }
  }

  togglePerf(on) { this.el.perf.classList.toggle('show', on); }

  /**
   * The adaptive scaler drops render resolution whenever the frame budget is
   * missed, which on a marginal machine is most of the time — and this notice
   * simply stayed up for as long as that was true, so the player read "quality
   * reduced" across the top of every frame they ever played. It is a notice,
   * not an error: say it once, take it away, and stay quiet for a while.
   */
  flashLowFps(on) {
    clearTimeout(this._lowFpsHide);
    if (!on) { this.el.lowfps.classList.remove('show'); return; }
    const now = performance.now();
    if (now - (this._lowFpsAt ?? -1e9) < 30000) return;
    this._lowFpsAt = now;
    this.el.lowfps.classList.add('show');
    this._lowFpsHide = setTimeout(() => this.el.lowfps.classList.remove('show'), 4000);
  }

  setHudVisible(v) {
    for (const id of ['hud-tl', 'hud-tr', 'hud-bl', 'hud-br']) {
      const el = document.getElementById(id);
      if (el) el.style.opacity = v ? '1' : '0';
    }
    this.el.crosshair.style.opacity = v ? '' : '0';
  }

  update(dt, camera) {
    this._updateDamageNumbers(dt, camera);
    this._updateCompass(camera);
    if (this._deltaTimer > 0) {
      this._deltaTimer -= dt;
      if (this._deltaTimer <= 0) {
        this._deltaAccum = 0;
        this.el.pointsDelta.classList.remove('show');
      }
    }
  }
}
