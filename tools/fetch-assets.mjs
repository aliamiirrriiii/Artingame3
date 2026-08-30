#!/usr/bin/env node
/**
 * Downloads every runtime asset for NIGHT OF THE RISEN from the web.
 *
 *   node tools/fetch-assets.mjs [--force]
 *
 * Reads tools/assets.manifest.json. Skips files that already exist unless
 * --force is passed. Zero npm dependencies — uses the built-in fetch.
 */
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

const manifest = JSON.parse(await readFile(resolve(root, 'tools/assets.manifest.json'), 'utf8'));

const expand = (src) => {
  const i = src.indexOf(':');
  const base = manifest.bases[src.slice(0, i)];
  if (!base) throw new Error(`unknown base in "${src}"`);
  return `${base}/${src.slice(i + 1)}`;
};

const exists = async (p) => { try { return (await stat(p)).size > 0; } catch { return false; } };

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

let downloaded = 0, skipped = 0, failed = 0, bytes = 0;

for (const asset of manifest.assets) {
  const dst = resolve(root, asset.dst);
  if (!force && await exists(dst)) {
    skipped++;
    console.log(`  skip   ${asset.dst}`);
    continue;
  }
  const url = expand(asset.src);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('empty body');
    await mkdir(dirname(dst), { recursive: true });
    await writeFile(dst, buf);
    downloaded++; bytes += buf.length;
    console.log(`  get    ${asset.dst}  (${kb(buf.length)})`);
  } catch (err) {
    failed++;
    console.error(`  FAIL   ${asset.dst}  <- ${url}\n         ${err.message}`);
  }
}

console.log(`\n${downloaded} downloaded (${kb(bytes)}), ${skipped} already present, ${failed} failed.`);
process.exit(failed ? 1 : 0);
