/**
 * Pointer-lock first-person input. Mouse deltas accumulate between frames and
 * are drained by the player controller, so a 1000 Hz mouse loses nothing at
 * 60 fps and camera motion stays smooth.
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();     // edge-triggered, cleared each frame
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0 };
    this.buttons = [false, false, false];
    this.buttonsPressed = [false, false, false];
    this.locked = false;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this.enabled = true;
    this.onLockChange = null;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const c = e.code;
      // Let the browser keep its own shortcuts — but Ctrl is the crouch key,
      // so a bare Ctrl press has to come through.
      const bareCtrl = c === 'ControlLeft' || c === 'ControlRight';
      if (e.metaKey || e.altKey || (e.ctrlKey && !bareCtrl)) return;
      if (!this.keys.has(c)) this.pressed.add(c);
      this.keys.add(c);
      if (this.locked && PREVENT.has(c)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    };
    this._onMouseMove = (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      if (!this.locked) return;
      if (e.button < 3) {
        if (!this.buttons[e.button]) this.buttonsPressed[e.button] = true;
        this.buttons[e.button] = true;
      }
      e.preventDefault();
    };
    this._onMouseUp = (e) => { if (e.button < 3) this.buttons[e.button] = false; };
    this._onWheel = (e) => { if (this.locked) { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); } };
    this._onBlur = () => { this.keys.clear(); this.buttons = [false, false, false]; };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this._onBlur();
      if (this.onLockChange) this.onLockChange(this.locked);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onLockChange);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  requestLock() {
    if (this.locked) return;
    const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
  }

  exitLock() { if (this.locked) document.exitPointerLock(); }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }
  up(code) { return this.released.has(code); }

  /** Any of a set — lets us bind both WASD and arrows without branching. */
  anyDown(...codes) { return codes.some((c) => this.keys.has(c)); }
  anyHit(...codes) { return codes.some((c) => this.pressed.has(c)); }

  /** Drains accumulated mouse motion, in radians. */
  takeLook() {
    const yaw = -this.mouse.dx * this.sensitivity;
    const pitch = (this.invertY ? this.mouse.dy : -this.mouse.dy) * this.sensitivity;
    this.mouse.dx = 0; this.mouse.dy = 0;
    return { yaw, pitch };
  }

  takeWheel() { const w = this.mouse.wheel; this.mouse.wheel = 0; return w; }

  /** Movement axes in local space: x = strafe (+right), z = forward (+fwd). */
  moveAxis(out) {
    let x = 0, z = 0;
    if (this.anyDown('KeyW', 'ArrowUp')) z += 1;
    if (this.anyDown('KeyS', 'ArrowDown')) z -= 1;
    if (this.anyDown('KeyD', 'ArrowRight')) x += 1;
    if (this.anyDown('KeyA', 'ArrowLeft')) x -= 1;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    out.x = x; out.z = z;
    return out;
  }

  /** Call once per frame, after all systems have read edge state. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.buttonsPressed[0] = this.buttonsPressed[1] = this.buttonsPressed[2] = false;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}

// Keys the game owns while pointer-locked (stops page scroll / quick-find).
const PREVENT = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Slash',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
]);
