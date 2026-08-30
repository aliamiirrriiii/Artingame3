#!/usr/bin/env node
/**
 * Headless verification: boots the game in Chromium, waits for the smoke page to
 * finish, and prints its report. Fails the process on any console/runtime error.
 *
 *   node tools/smoke.mjs [--page tools/smoke.html] [--q high] [--shot out.png] [--ms 30000]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 ? process.argv[i + 1] : d;
};

const port = Number(arg('port', 8931));
const page = arg('page', 'tools/smoke.html');
const q = arg('q', 'high');
const shot = arg('shot', null);
const budget = Number(arg('ms', 90000));

const server = spawn(process.execPath, ['serve.mjs', String(port)], { stdio: 'ignore' });
await sleep(600);

// Prefer a browser already present in the environment; fall back to Playwright's.
const execPath = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                  '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find((p) => existsSync(p));

const browser = await chromium.launch({
  ...(execPath ? { executablePath: execPath } : {}),
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist',
  ],
});

let exitCode = 0;
let pageRef = null;
let logRef = null;
try {
  // A smaller viewport makes software-rendered runs fast enough to exercise
  // real gameplay; screenshots still scale for visual review.
  const vp = (arg('viewport', '1280x720') || '1280x720').split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: vp[0], height: vp[1] } });
  const p = await ctx.newPage();

  const logs = [];
  pageRef = p; logRef = logs;
  p.on('console', (m) => {
    const t = m.type();
    logs.push(`[${t}] ${m.text()}`);
  });
  p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  const bot = process.argv.includes('--bot') ? '&bot=1' : '';
  const extra = arg('params', '') ? `&${arg('params', '')}` : '';
  const url = `http://localhost:${port}/${page}?q=${q}&headless=1${bot}${extra}`;
  console.log('opening', url);
  await p.goto(url, { waitUntil: 'domcontentloaded' });

  await p.waitForFunction(
    () => (window.__smoke && window.__smoke.done) || (window.__game && window.__game.ready),
    null,
    { timeout: budget, polling: 250 },
  );

  // Let a bot run play for a while before sampling, so the report covers real
  // gameplay rather than the first frame after boot.
  const runSeconds = Number(arg('run', 0));
  if (runSeconds > 0) {
    console.log(`running for ${runSeconds}s...`);
    await sleep(runSeconds * 1000);
  }

  const report = await p.evaluate(() => window.__smoke || window.__game.report());
  console.log('\n--- report ---');
  console.log(JSON.stringify(report, null, 2));

  const bad = logs.filter((l) => /\[error\]|\[pageerror\]/.test(l));
  if (logs.length) {
    console.log('\n--- console ---');
    for (const l of logs.slice(0, 60)) console.log(l);
  }

  if (shot) {
    const views = Number(arg('views', 1));
    for (let v = 0; v < views; v++) {
      if (views > 1) {
        await p.evaluate((n) => window.__setView && window.__setView(n), v);
        await sleep(400);
      }
      const path = views > 1 ? shot.replace(/\.png$/, `_${v}.png`) : shot;
      await p.screenshot({ path });
      console.log('screenshot ->', path);
    }
  }

  if (bad.length || report.ok === false || (report.errors && report.errors.length)) {
    exitCode = 1;
  }
} catch (err) {
  console.error('smoke failed:', err.message);
  // Dump whatever the page managed to record — that is usually the real cause.
  try {
    const partial = await pageRef?.evaluate(() => window.__smoke || null);
    if (partial) console.log('\n--- partial report ---\n' + JSON.stringify(partial, null, 2));
  } catch {}
  if (logRef) {
    console.log('\n--- console ---');
    for (const l of logRef.slice(0, 80)) console.log(l);
  }
  exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
process.exit(exitCode);
