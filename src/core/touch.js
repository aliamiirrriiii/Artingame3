import { clamp } from './util.js';

/**
 * Touch input.
 *
 * Implements exactly the same surface as `Input` (down/hit/moveAxis/takeLook/
 * buttons/endFrame), so the player controller, combat and economy are unchanged
 * — the game does not know or care which device it is being played on.
 *
 * Layout is the one that has settled as standard for mobile shooters, because
 * it is the one that works with two thumbs and no fingers to spare:
 *
 *   left half   floating movement stick — the base appears wherever you press,
 *               rather than a fixed pad you have to find without looking
 *   right half  drag anywhere to look
 *   buttons     hit-tested in JS against cached rects rather than relying on
 *               DOM event routing, so a drag that starts on FIRE keeps firing
 *               *and* steers, which is how you shoot while turning
 *
 * Auto-sprint triggers on holding the stick fully forward, so sprinting costs
 * no extra thumb.
 */

const STICK_RADIUS = 66;      // css px at which the stick reads full deflection
const STICK_DEADZONE = 0.16;
const SPRINT_HOLD = 0.35;     // seconds at full forward before auto-sprint
const TAP_MAX_MS = 250;       // press/release inside this counts as a tap
const TAP_MAX_MOVE = 16;

export class TouchInput {
  constructor(canvas, layer) {
    this.canvas = canvas;
    this.layer = layer;

    // --- Input-compatible state -------------------------------------------
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0 };
    this.buttons = [false, false, false];
    this.buttonsPressed = [false, false, false];
    this.locked = true;          // there is nothing to lock on touch
    this.sensitivity = 0.0035;
    this.invertY = false;
    this.enabled = true;
    this.onLockChange = null;

    // --- Touch specifics ---------------------------------------------------
    this.pointers = new Map();   // pointerId -> role record
    this.buttonDefs = [];
    this.stick = { active: false, ox: 0, oy: 0, x: 0, y: 0, dx: 0, dy: 0 };
    this.autoSprint = false;
    this._fullForwardT = 0;
    this.lookScale = 1.0;
    this.fireHeld = false;
    this.adsToggle = false;
    this.crouchToggle = false;
    this.onPause = null;
    this.onFirstTouch = null;
    this._firstTouchDone = false;

    this._els = {
      stickBase: layer.querySelector('#tc-stick-base'),
      stickKnob: layer.querySelector('#tc-stick-knob'),
    };

    this._collectButtons();
    this._bind();
    this.refreshRects();
  }

  /** Buttons are declared in the markup; behaviour comes from data attributes. */
  _collectButtons() {
    this.buttonDefs = [];
    for (const el of this.layer.querySelectorAll('[data-touch]')) {
      this.buttonDefs.push({
        el,
        id: el.dataset.touch,
        key: el.dataset.key || null,          // keyboard code to synthesise
        mouse: el.dataset.mouse !== undefined ? Number(el.dataset.mouse) : null,
        mode: el.dataset.mode || 'hold',      // hold | tap | toggle
        lookDrag: el.dataset.lookdrag === '1',
        rect: null,
        active: false,
      });
    }
  }

  refreshRects() {
    for (const b of this.buttonDefs) {
      // Hidden buttons must not swallow touches meant for the look zone.
      b.rect = b.el.offsetParent === null ? null : b.el.getBoundingClientRect();
    }
    this._halfX = window.innerWidth * 0.42;
  }

  _bind() {
    const opts = { passive: false };
    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onUp = (e) => this._pointerUp(e);

    this.layer.addEventListener('pointerdown', this._onDown, opts);
    this.layer.addEventListener('pointermove', this._onMove, opts);
    this.layer.addEventListener('pointerup', this._onUp, opts);
    this.layer.addEventListener('pointercancel', this._onUp, opts);
    this.layer.addEventListener('pointerleave', this._onUp, opts);
    this.layer.addEventListener('contextmenu', (e) => e.preventDefault());

    this._onResize = () => this.refreshRects();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
  }

  _hitButton(x, y) {
    // Reverse order so later markup wins where controls overlap.
    for (let i = this.buttonDefs.length - 1; i >= 0; i--) {
      const b = this.buttonDefs[i];
      const r = b.rect;
      if (!r) continue;
      // Generous hit padding: thumbs are not precise, and a missed reload is
      // worse than an occasional stray press.
      const pad = 8;
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) {
        return b;
      }
    }
    return null;
  }

  _pointerDown(e) {
    if (!this.enabled) return;
    e.preventDefault();

    if (!this._firstTouchDone) {
      this._firstTouchDone = true;
      if (this.onFirstTouch) this.onFirstTouch();
    }

    const x = e.clientX, y = e.clientY;
    const btn = this._hitButton(x, y);

    if (btn) {
      this._press(btn);
      this.pointers.set(e.pointerId, {
        role: 'button', btn, x, y, sx: x, sy: y, t: performance.now(), moved: 0,
      });
      btn.el.classList.add('down');
      return;
    }

    if (x < this._halfX) {
      // Movement stick, anchored where the thumb landed.
      this.stick.active = true;
      this.stick.ox = x; this.stick.oy = y;
      this.stick.x = x; this.stick.y = y;
      this.stick.dx = 0; this.stick.dy = 0;
      this._showStick(true);
      this.pointers.set(e.pointerId, { role: 'move', x, y });
    } else {
      this.pointers.set(e.pointerId, {
        role: 'look', x, y, sx: x, sy: y, t: performance.now(), moved: 0,
      });
    }
  }

  _pointerMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();

    const x = e.clientX, y = e.clientY;
    const dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;
    if (p.sx !== undefined) p.moved += Math.abs(dx) + Math.abs(dy);

    if (p.role === 'move') {
      this.stick.x = x; this.stick.y = y;
      let ox = x - this.stick.ox, oy = y - this.stick.oy;
      const len = Math.hypot(ox, oy);
      if (len > STICK_RADIUS) {
        // Drag the base along so the stick never runs out of travel.
        const k = (len - STICK_RADIUS) / len;
        this.stick.ox += ox * k;
        this.stick.oy += oy * k;
        ox = x - this.stick.ox; oy = y - this.stick.oy;
      }
      this.stick.dx = ox / STICK_RADIUS;
      this.stick.dy = oy / STICK_RADIUS;
      this._updateStickVisual();
    } else if (p.role === 'look' || (p.role === 'button' && p.btn.lookDrag)) {
      this.mouse.dx += dx;
      this.mouse.dy += dy;
    }
  }

  _pointerUp(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    this.pointers.delete(e.pointerId);

    if (p.role === 'move') {
      this.stick.active = false;
      this.stick.dx = 0; this.stick.dy = 0;
      this._fullForwardT = 0;
      this.autoSprint = false;
      this._showStick(false);
    } else if (p.role === 'button') {
      const isTap = performance.now() - p.t < TAP_MAX_MS && p.moved < TAP_MAX_MOVE;
      this._release(p.btn, isTap);
      p.btn.el.classList.remove('down');
    }
  }

  _press(b) {
    b.active = true;
    if (b.mode === 'toggle') {
      // Toggles fire on press and latch until pressed again.
      if (b.id === 'ads') { this.adsToggle = !this.adsToggle; b.el.classList.toggle('on', this.adsToggle); }
      else if (b.id === 'crouch') { this.crouchToggle = !this.crouchToggle; b.el.classList.toggle('on', this.crouchToggle); }
      else if (b.key) {
        this.pressed.add(b.key);
        b.el.classList.toggle('on', !b.el.classList.contains('on'));
      }
      return;
    }

    if (b.key) {
      if (!this.keys.has(b.key)) this.pressed.add(b.key);
      this.keys.add(b.key);
    }
    if (b.mouse !== null) {
      if (!this.buttons[b.mouse]) this.buttonsPressed[b.mouse] = true;
      this.buttons[b.mouse] = true;
      if (b.mouse === 0) this.fireHeld = true;
    }
    if (b.id === 'pause' && this.onPause) this.onPause();
  }

  _release(b, isTap) {
    b.active = false;
    if (b.mode === 'toggle') return;
    if (b.key) { this.keys.delete(b.key); this.released.add(b.key); }
    if (b.mouse !== null) {
      this.buttons[b.mouse] = false;
      if (b.mouse === 0) this.fireHeld = false;
    }
  }

  // ------------------------------------------------------------- visuals

  _showStick(on) {
    const base = this._els.stickBase, knob = this._els.stickKnob;
    if (!base || !knob) return;
    base.style.opacity = on ? '1' : '0';
    knob.style.opacity = on ? '1' : '0';
    if (on) this._updateStickVisual();
  }

  _updateStickVisual() {
    const base = this._els.stickBase, knob = this._els.stickKnob;
    if (!base || !knob) return;
    base.style.transform = `translate(${this.stick.ox}px, ${this.stick.oy}px) translate(-50%, -50%)`;
    const kx = this.stick.ox + clamp(this.stick.dx, -1, 1) * STICK_RADIUS;
    const ky = this.stick.oy + clamp(this.stick.dy, -1, 1) * STICK_RADIUS;
    knob.style.transform = `translate(${kx}px, ${ky}px) translate(-50%, -50%)`;
  }

  /** Shows or hides a contextual button (used for the buy prompt). */
  setButtonVisible(id, visible) {
    const b = this.buttonDefs.find((d) => d.id === id);
    if (!b) return;
    const want = visible ? '' : 'none';
    if (b.el.style.display !== want) {
      b.el.style.display = want;
      // Its rect only exists while it is displayed.
      b.rect = visible ? b.el.getBoundingClientRect() : null;
      if (!visible && b.active) { this._release(b, false); b.el.classList.remove('down'); }
    }
  }

  /** Highlights a button (used for the active weapon slot). */
  setActive(id, on) {
    const b = this.buttonDefs.find((d) => d.id === id);
    if (b) b.el.classList.toggle('on', !!on);
  }

  setLabel(id, text) {
    const b = this.buttonDefs.find((d) => d.id === id);
    if (b && b.el.textContent !== text) b.el.textContent = text;
  }

  /** Auto-fire is a setting; the HUD reflects it on the fire button. */
  setAutoFire(on) {
    this.autoFire = on;
    const b = this.buttonDefs.find((d) => d.id === 'fire');
    if (b) b.el.classList.toggle('auto', !!on);
  }

  // ---------------------------------------------------- Input-compatible

  requestLock() { /* nothing to lock */ }
  exitLock() { /* nothing to lock */ }

  down(code) {
    if (code === 'ControlLeft' && this.crouchToggle) return true;
    return this.keys.has(code);
  }
  hit(code) { return this.pressed.has(code); }
  up(code) { return this.released.has(code); }
  anyDown(...codes) { return codes.some((c) => this.down(c)); }
  anyHit(...codes) { return codes.some((c) => this.pressed.has(c)); }

  takeLook() {
    const s = this.sensitivity * this.lookScale;
    const yaw = -this.mouse.dx * s;
    const pitch = (this.invertY ? this.mouse.dy : -this.mouse.dy) * s;
    // Aim assist needs to know whether the thumb is actually moving; parking
    // it on the screen should not keep dragging the view onto a target.
    this.lookActive = Math.abs(yaw) + Math.abs(pitch) > 1e-4;
    this.mouse.dx = 0; this.mouse.dy = 0;
    return { yaw, pitch };
  }

  takeWheel() { const w = this.mouse.wheel; this.mouse.wheel = 0; return w; }

  moveAxis(out) {
    let x = this.stick.dx, z = -this.stick.dy;   // screen up = forward
    const len = Math.hypot(x, z);
    if (len < STICK_DEADZONE) { out.x = 0; out.z = 0; return out; }
    if (len > 1) { x /= len; z /= len; }
    out.x = x; out.z = z;
    return out;
  }

  /** Called once per frame before systems read state. */
  tick(dt) {
    // Auto-sprint: stick held near full forward for a moment.
    const len = Math.hypot(this.stick.dx, this.stick.dy);
    const forward = -this.stick.dy;
    if (this.stick.active && len > 0.9 && forward > 0.75) {
      this._fullForwardT += dt;
      if (this._fullForwardT >= SPRINT_HOLD) this.autoSprint = true;
    } else {
      this._fullForwardT = 0;
      this.autoSprint = false;
    }

    if (this.autoSprint) this.keys.add('ShiftLeft');
    else this.keys.delete('ShiftLeft');

    if (this.adsToggle) {
      if (!this.buttons[2]) this.buttons[2] = true;
    } else if (this.buttons[2] && !this.buttonDefs.some((b) => b.id === 'ads' && b.active)) {
      this.buttons[2] = false;
    }
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.buttonsPressed[0] = this.buttonsPressed[1] = this.buttonsPressed[2] = false;
  }

  reset() {
    this.keys.clear();
    this.pressed.clear();
    this.released.clear();
    this.buttons = [false, false, false];
    this.pointers.clear();
    this.stick.active = false;
    this.stick.dx = this.stick.dy = 0;
    this.autoSprint = false;
    this.adsToggle = false;
    this._showStick(false);
    for (const b of this.buttonDefs) { b.active = false; b.el.classList.remove('down', 'on'); }
  }

  dispose() {
    this.layer.removeEventListener('pointerdown', this._onDown);
    this.layer.removeEventListener('pointermove', this._onMove);
    this.layer.removeEventListener('pointerup', this._onUp);
    this.layer.removeEventListener('pointercancel', this._onUp);
    this.layer.removeEventListener('pointerleave', this._onUp);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
  }
}

/** True when the device is primarily touch-driven. */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(location.search);
  if (params.has('touch')) return params.get('touch') !== '0';
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
  const points = navigator.maxTouchPoints > 0;
  return points && (coarse || noHover);
}
