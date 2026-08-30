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
  // Hold the stick forward long enough to move and to trigger auto-sprint.
  await touch('touchStart', [{ x: 150, y: 280, id: 1 }]);
  await touch('touchMove', [{ x: 150, y: 190, id: 1 }]);
  await sleep(1400);
  const mid = await report();
  await touch('touchEnd', []);
  const moved = Math.hypot(mid.playerPosF[0] - before.playerPosF[0],
                           mid.playerPosF[1] - before.playerPosF[1]);
  check('stick walks the player', moved > 1.0, `moved ${moved.toFixed(2)} m`);

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
