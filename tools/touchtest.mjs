#!/usr/bin/env node
/**
 * Touch-control integration test.
 *
 * Drives the game with real touch events through the DevTools Protocol — not
 * synthesised DOM events — in a landscape phone viewport, and asserts that each
 * control actually moves the thing it is supposed to move: the stick walks the
 * player, the right half turns the camera, FIRE fires, RELOAD reloads.
 *
 *   node tools/touchtest.mjs [--shot out.png]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const port = Number(arg('port', 8801));
const shot = arg('shot', null);
const W = 844, H = 390;   // a phone held sideways

const execPath = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                  '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => existsSync(p));

const server = spawn(process.execPath, ['serve.mjs', String(port)], { stdio: 'ignore' });
await sleep(600);

const browser = await chromium.launch({
  ...(execPath ? { executablePath: execPath } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    // Without these, headless Chromium treats the page as backgrounded and
    // throttles requestAnimationFrame to a few frames per minute. The run
    // then reports a plausible frame time from three frames and a game that
    // never advanced far enough to spawn anything.
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
});

let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

try {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  const cdp = await ctx.newCDPSession(page);
  const touch = async (type, pts) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });

  /** A held drag, delivered as a real touch stream. */
  const drag = async (x0, y0, x1, y1, steps = 12, holdMs = 0) => {
    await touch('touchStart', [{ x: x0, y: y0, id: 1 }]);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await touch('touchMove', [{ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, id: 1 }]);
      await sleep(16);
    }
    if (holdMs) await sleep(holdMs);
    await touch('touchEnd', []);
  };

  const tapHold = async (x, y, ms) => {
    await touch('touchStart', [{ x, y, id: 1 }]);
    await sleep(ms);
    await touch('touchEnd', []);
  };

  const report = () => page.evaluate(() => window.__game.report());

  console.log(`\nloading (${W}x${H}, touch)`);
  await page.goto(`http://localhost:${port}/index.html?headless=1&touch=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000, polling: 250 });

  let r = await report();
  check('detected as a touch device', r.isTouch === true, `isTouch=${r.isTouch}`);
  check('mobile quality caps applied', r.preset !== undefined, `preset=${r.preset}`);
  check('body carries the touch class', /\btouch\b/.test(r.bodyClass), r.bodyClass);

  console.log('\ncredits (CC-BY attribution must actually render)');
  const credBtn = await page.locator('#btn-credits').boundingBox();
  await page.touchscreen.tap(credBtn.x + credBtn.width / 2, credBtn.y + credBtn.height / 2);
  await sleep(700);
  const cred = await page.evaluate(() => {
    const b = document.getElementById('credits-body');
    return { shown: document.getElementById('credits').classList.contains('show'),
             licences: b.querySelectorAll('.lic').length, text: b.textContent.slice(0, 80) };
  });
  check('credits screen opens', cred.shown === true);
  check('credits list every licence', cred.licences >= 6, `found ${cred.licences}`);
  check('credits name the CC-BY holders',
    /Wayfair|hinndia/.test(await page.evaluate(() => document.getElementById('credits-body').textContent)));
  const backBtn = await page.locator('#btn-credits-back').boundingBox();
  await page.touchscreen.tap(backBtn.x + backBtn.width / 2, backBtn.y + backBtn.height / 2);
  await sleep(400);

  console.log('\nstarting a run');
  const playBox = await page.locator('#btn-play').boundingBox();
  await page.touchscreen.tap(playBox.x + playBox.width / 2, playBox.y + playBox.height / 2);
  await page.waitForFunction(() => window.__game.state === 'playing', null, { timeout: 30000, polling: 100 });
  r = await report();
  check('run started from a tap', r.state === 'playing');
  check('touch overlay is live', /\bplaying\b/.test(r.bodyClass), r.bodyClass);

  const layerVisible = await page.evaluate(() =>
    getComputedStyle(document.getElementById('touch')).display);
  check('#touch is displayed', layerVisible === 'block', `display=${layerVisible}`);

  console.log('\nmovement stick (left half)');
  const before = await report();
  // The stick floats: its base is planted where the thumb goes down, on the
  // first frame that runs after the touchStart, so give it a frame before
  // moving the thumb.
  await touch('touchStart', [{ x: 150, y: 280, id: 1 }]);
  await sleep(90);
  await touch('touchMove', [{ x: 150, y: 190, id: 1 }]);

  // Sample through the hold rather than only at its ends. When this check
  // fails the question is always the same — did the stick stop reading, or did
  // the player walk into something — and two positions cannot tell those apart.
  const trace = [];
  const sample = () => page.evaluate(() => {
    const g = window.__game;
    const st = g.touchInput?.stick;
    return {
      x: +g.player.pos.x.toFixed(2), z: +g.player.pos.z.toFixed(2),
      yaw: +g.player.yaw.toFixed(2),
      v: +Math.hypot(g.player.vel.x, g.player.vel.z).toFixed(2),
      sx: st ? +st.dx.toFixed(2) : null, sy: st ? +st.dy.toFixed(2) : null,
      sprint: !!g.player.sprinting, zombies: g.zombies.aliveCount,
    };
  });
  for (let i = 0; i < 8; i++) { await sleep(175); trace.push(await sample()); }
  const mid = await report();
  await touch('touchEnd', []);

  const moved = Math.hypot(mid.playerPosF[0] - before.playerPosF[0],
                           mid.playerPosF[1] - before.playerPosF[1]);
  // Two assertions, because they are two different claims. The stick's actual
  // contract is the vector it produces, and that is deterministic: a 90 px drag
  // against a 66 px radius is full forward deflection wherever this runs. How
  // far the player then travels is a fact about the level in front of the spawn
  // and about frame timing, so it is checked only loosely — enough to prove the
  // vector is wired through to the player, not enough to fail because the arena
  // has a barricade in it. The distance is printed every run either way, so a
  // real drift in it is visible before it becomes a failure.
  const deflect = trace.length ? -Math.min(...trace.map((t) => t.sy ?? 0)) : 0;
  check('stick reads full forward deflection', deflect > 0.8, `dy=${(-deflect).toFixed(2)}`);
  check('stick walks the player', moved > 0.3, `moved ${moved.toFixed(2)} m`);
  console.log(`       walked ${moved.toFixed(2)} m in 1.4 s, peak deflection ${deflect.toFixed(2)}`);
  for (const t of trace) {
    console.log(`       x=${t.x} z=${t.z} yaw=${t.yaw} v=${t.v} `
      + `stick=(${t.sx},${t.sy}) sprint=${t.sprint} zombies=${t.zombies}`);
  }

  console.log('\nlook drag (right half)');
  const beforeYaw = (await report()).yaw;
  await drag(600, 200, 760, 200, 14);
  await sleep(120);
  const afterYaw = (await report()).yaw;
  const dYaw = Math.abs(afterYaw - beforeYaw);
  check('right-half drag turns the camera', dYaw > 0.05, `yaw ${beforeYaw} -> ${afterYaw}`);

  console.log('\nbuttons');
  const rect = (sel) => page.locator(sel).boundingBox();

  const fire = await rect('[data-touch="fire"]');
  const shotsBefore = (await report()).shotsFired;
  await tapHold(fire.x + fire.width / 2, fire.y + fire.height / 2, 700);
  await sleep(150);
  const shotsAfter = (await report()).shotsFired;
  check('FIRE fires the weapon', shotsAfter > shotsBefore, `${shotsBefore} -> ${shotsAfter}`);

  const reload = await rect('[data-touch="reload"]');
  await tapHold(reload.x + reload.width / 2, reload.y + reload.height / 2, 90);
  await sleep(120);
  const afterReload = await page.evaluate(() =>
    window.__game.combat.reloading || window.__game.combat.mag === window.__game.combat.spec.magSize);
  check('RELOAD triggers a reload', afterReload === true);

  // Dragging off the FIRE button must keep firing and also steer.
  const yaw0 = (await report()).yaw;
  await touch('touchStart', [{ x: fire.x + fire.width / 2, y: fire.y + fire.height / 2, id: 1 }]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ x: fire.x + fire.width / 2 - i * 12, y: fire.y + fire.height / 2, id: 1 }]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  const yaw1 = (await report()).yaw;
  check('drag from FIRE also steers', Math.abs(yaw1 - yaw0) > 0.02, `yaw ${yaw0} -> ${yaw1}`);

  const crouch = await rect('[data-touch="crouch"]');
  await tapHold(crouch.x + crouch.width / 2, crouch.y + crouch.height / 2, 80);
  await sleep(300);
  const crouched = await page.evaluate(() => window.__game.player.crouching);
  check('CROUCH toggles', crouched === true);
  await tapHold(crouch.x + crouch.width / 2, crouch.y + crouch.height / 2, 80);
  await sleep(300);
  check('CROUCH untoggles', (await page.evaluate(() => window.__game.player.crouching)) === false);

  console.log('\ntwo thumbs at once');
  // Put the player somewhere known and open first. By this point the earlier
  // steps have walked and turned it, and if it happens to end up nose-first
  // against a wall this measures the level layout rather than the input code.
  const stuckAt = await report();
  await page.evaluate(() => {
    const g = window.__game;
    g.player.pos.set(0, 0, 20);
    g.player.vel.set(0, 0, 0);
    g.player.yaw = Math.PI;      // facing up the open north street
    g.player.pitch = 0;
  });
  await sleep(120);
  console.log(`       (was at ${stuckAt.playerPosF}, reset to [0,20] facing +Z)`);

  // Move and look simultaneously — the case a single-pointer implementation breaks on.
  const p0 = await report();
  await touch('touchStart', [{ x: 150, y: 280, id: 1 }]);
  await touch('touchStart', [{ x: 150, y: 280, id: 1 }, { x: 620, y: 200, id: 2 }]);
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', [
      { x: 150, y: 280 - i * 7, id: 1 },
      { x: 620 + i * 10, y: 200, id: 2 },
    ]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  const p1 = await report();
  const movedBoth = Math.hypot(p1.playerPosF[0] - p0.playerPosF[0], p1.playerPosF[1] - p0.playerPosF[1]);
  check('moves and looks at the same time',
    movedBoth > 0.5 && Math.abs(p1.yaw - p0.yaw) > 0.05,
    `moved ${movedBoth.toFixed(2)} m, yaw d=${Math.abs(p1.yaw - p0.yaw).toFixed(3)}`);

  /*
   * The improvised-weapon loop, end to end: something is lying in the street,
   * you pick it up, it swings through a crowd, it wears out, it breaks, and
   * you are back on the knife. Every one of those steps is a separate way for
   * this to be silently broken.
   */
  console.log('\nimprovised weapons');
  const melee = await page.evaluate(() => {
    const g = window.__game;
    const items = g.pickups.items.filter((i) => !i.taken);
    if (!items.length) return { spawned: 0 };

    // Stand on one and take it.
    const it = items[0];
    g.player.pos.set(it.pos.x, 0, it.pos.z + 1.0);
    g.economy.update(0.016, { hit: () => false, buttons: [] }, true);
    const prompt = g.economy.prompt && g.economy.prompt.action;
    g.economy.interact(g.economy.nearest);

    const held = g.combat.owned[0];
    const full = g.combat.swingsLeft;

    // Put a zombie in front and swing until the weapon gives out.
    const z = g.zombies.alive[0];
    let hits = 0, swings = 0;
    if (z) {
      // In front of the camera, wherever it happens to be pointing. And the
      // hitboxes hang off the bones, which follow the model's node — moving
      // z.pos alone leaves them where the zombie used to be.
      // Somewhere open: pressed against a barricade this measures the level
      // layout, not the swing.
      g.player.pos.set(0, 0, 20);
      g.player.vel.set(0, 0, 0);
      g.stage.camera.position.set(0, 1.68, 20);
      g.stage.camera.updateMatrixWorld(true);
      const cam = g.stage.camera;
      const fwd = { x: 0, y: 0, z: -1 };
      const q = cam.quaternion;
      const put = () => {
        const v = new (z.pos.constructor)(fwd.x, fwd.y, fwd.z).applyQuaternion(q);
        z.pos.set(cam.position.x + v.x * 1.3, 0, cam.position.z + v.z * 1.3);
        z.root.position.copy(z.pos);
        z.root.updateMatrixWorld(true);
        z.hbFrame = -1;
        z.health = 1e9; z.maxHealth = 1e9; z.state = 'pursue';
      };
      for (let i = 0; i < 400 && g.combat.owned[0] === held; i++) {
        put();
        g.combat.cooldown = 0;
        const before = g.combat.shotsHit;
        g.combat._fireMelee(g.combat.spec);
        g.combat._resolveSwing();
        g.combat._swing = null;
        swings++;
        if (g.combat.shotsHit > before) hits++;
      }
    }
    const hitSomething = hits > 0;
    // Kept for when it does not: a swing that misses is almost always the
    // hitbox being somewhere other than where the ray went.
    let probe = null;
    if (z && !hitSomething) {
      const o = new (z.pos.constructor)(), d = new (z.pos.constructor)();
      g.player.aimRay(o, d);
      const head = (z.hitboxes || [])[0];
      probe = {
        origin: o.toArray().map((v) => +v.toFixed(2)),
        dir: d.toArray().map((v) => +v.toFixed(2)),
        zPos: z.pos.toArray().map((v) => +v.toFixed(2)),
        direct: g.zombies.raycast(o, d, 4, {}) ? 'yes' : 'no',
        wall: g.level.collision.raycast(o, d, 4, {}) ? 'yes' : 'no',
        head: head && head.a.toArray().map((v) => +v.toFixed(2)),
      };
    }
    return {
      spawned: items.length,
      kinds: [...new Set(g.pickups.items.map((i) => i.weapon))],
      prompt,
      held,
      full,
      swings,
      hits,
      hitSomething,
      probe,
      after: g.combat.owned[0],
      taken: it.taken,
    };
  });
  check('improvised weapons are lying in the street', melee.spawned >= 6,
    `${melee.spawned} of ${(melee.kinds || []).length} kinds`);
  check('one can be picked up', melee.prompt === 'PICK UP' && melee.held !== 'knife',
    `prompt ${melee.prompt}, holding ${melee.held}`);
  check('it leaves the ground when taken', melee.taken === true);
  check('it arrives at full condition', melee.full > 0 && melee.full !== Infinity,
    `${melee.full} swings`);
  check('the swing connects', melee.hitSomething === true,
    `${melee.hits} of ${melee.swings} swings landed`
      + (melee.probe ? ` ${JSON.stringify(melee.probe)}` : ''));
  check('it wears out and breaks back to the knife', melee.after === 'knife',
    `${melee.swings} swings from ${melee.full}`);

  // A kill is supposed to hold the frame, jolt the camera and throw blood at
  // the lens. None of that is reachable by playing the game headlessly — the
  // scripted inputs rarely finish anything — so one is staged: a zombie moved
  // to arm's length and shot through the head.
  console.log('\nkill feedback');
  const beforeKill = await report();
  const gore = await page.evaluate(() => {
    const g = window.__game;
    const z = g.zombies.alive[0];
    if (!z) return { staged: false };
    z.pos.set(g.player.pos.x, 0, g.player.pos.z + 1.4);
    z.distToPlayer = 1.4;
    // Explicit, because an earlier step used this same zombie as a punchbag
    // and left it on a billion hit points.
    z.maxHealth = 400;
    z.health = 1;
    z.severed.clear();
    z.state = 'pursue';
    const before = document.getElementById('gore') ? document.getElementById('gore').childElementCount : 0;
    g.hitStop = 0;
    g.stage._shakeTrauma = 0;
    g.zombies.damage(z, 400, z.pos, { x: 0, y: 0, z: 1 },
      { crit: true, part: 'head', byPlayer: true });
    return {
      staged: true,
      hitStop: +(g.hitStop || 0).toFixed(3),
      splats: (document.getElementById('gore')
        ? document.getElementById('gore').childElementCount : 0) - before,
      shake: +g.stage._shakeTrauma.toFixed(3),
      severed: [...(z.severed || [])],
      feed: document.getElementById('killfeed').textContent,
    };
  });
  check('a kill holds the frame', gore.hitStop > 0, `hitStop ${gore.hitStop}s`);
  check('a kill jolts the camera', gore.shake > 0, `trauma ${gore.shake}`);
  check('a kill at arm\'s length throws blood at the lens', gore.splats > 0,
    `${gore.splats} splats`);
  check('a headshot kill takes the head off', gore.severed.includes('Head'),
    `severed ${JSON.stringify(gore.severed)}`);
  check('the kill feed says how it died', /HEADSHOT/i.test(gore.feed), gore.feed.trim());
  await sleep(700);
  const afterKill = await report();
  console.log(`       (frame time ${beforeKill.frameMs} ms before the kill, `
    + `${afterKill.frameMs} ms after)`);

  console.log('\npause');
  const pause = await rect('[data-touch="pause"]');
  await page.touchscreen.tap(pause.x + pause.width / 2, pause.y + pause.height / 2);
  await sleep(400);
  r = await report();
  check('pause button pauses', r.state === 'paused', `state=${r.state}`);
  check('touch overlay hidden while paused', !/\bplaying\b/.test(r.bodyClass), r.bodyClass);

  const resume = await page.locator('#btn-resume').boundingBox();
  await page.touchscreen.tap(resume.x + resume.width / 2, resume.y + resume.height / 2);
  await sleep(500);
  r = await report();
  check('resume returns to play', r.state === 'playing', `state=${r.state}`);

  if (shot) {
    // Put the stick and a couple of buttons on screen for the capture.
    await touch('touchStart', [{ x: 160, y: 270, id: 1 }, { x: 700, y: 300, id: 2 }]);
    await touch('touchMove', [{ x: 175, y: 215, id: 1 }, { x: 700, y: 300, id: 2 }]);
    await sleep(700);
    await page.screenshot({ path: shot });
    await touch('touchEnd', []);
    console.log(`\nscreenshot -> ${shot}`);
  }

  const bad = logs.filter((l) => /\[error\]|\[pageerror\]/.test(l));
  check('no console errors', bad.length === 0, bad.slice(0, 3).join('\n       '));

  const final = await report();
  console.log(`\nstate: wave ${final.wave}, ${final.kills} kills, ${final.aliveZombies} alive, `
    + `${final.frameMs} ms/frame, preset ${final.preset}`);
} catch (err) {
  failed++;
  console.error('touch test failed:', err.message);
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${failed ? `${failed} FAILED` : 'all touch checks passed'}\n`);
process.exit(failed ? 1 : 0);
