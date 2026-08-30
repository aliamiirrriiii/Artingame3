#!/usr/bin/env node
/**
 * Verifies a built APK actually contains a complete, playable game.
 *
 * The failure this guards against is quiet and nasty: the APK builds, installs
 * and launches, and then shows a black screen because an asset never made it
 * into the bundle. So rather than trusting the build, every entry in the asset
 * manifest is checked for by name inside the APK, along with the code and the
 * Android bits that make it an app at all.
 *
 *   node tools/verify-apk.mjs path/to/app-debug.apk
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apk = process.argv[2];

if (!apk) {
  console.error('usage: node tools/verify-apk.mjs <apk>');
  process.exit(2);
}

const size = statSync(apk).size;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// `unzip -Z1` lists entry names only; an APK is a zip.
const entries = new Set(
  execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((s) => s.trim()).filter(Boolean),
);

let failed = 0;
const need = (path, why) => {
  if (entries.has(path)) return true;
  failed++;
  console.log(`  MISSING ${path}${why ? `  (${why})` : ''}`);
  return false;
};

console.log(`\n${apk}`);
console.log(`  size    ${mb(size)}`);
console.log(`  entries ${entries.size}`);

console.log('\nandroid');
need('AndroidManifest.xml', 'not a valid APK');
need('classes.dex', 'no compiled code');
need('resources.arsc', 'no compiled resources');
const signed = [...entries].some((e) => /^META-INF\/.*\.(RSA|DSA|EC)$/.test(e))
  || entries.has('META-INF/BNDLTOOL.SF') || [...entries].some((e) => e.startsWith('META-INF/'));
console.log(`  ${signed ? 'ok  ' : 'note'}    signature block ${signed ? 'present' : 'absent (unsigned build)'}`);

console.log('\ngame code');
const W = 'assets/www/';
let codeOk = 0;
const CODE = [
  'index.html',
  'src/main.js',
  'src/core/touch.js',
  'src/core/input.js',
  'src/entities/zombies.js',
  'src/weapons/combat.js',
  'src/world/level.js',
  'src/render/stage.js',
  'vendor/three/build/three.module.js',
  'vendor/three/build/three.core.js',
  'vendor/three/examples/jsm/loaders/GLTFLoader.js',
  'vendor/three/examples/jsm/postprocessing/EffectComposer.js',
  'vendor/three/examples/jsm/utils/SkeletonUtils.js',
  'src/world/props.js',
  'src/weapons/gunsmith.js',
  'src/weapons/viewmodel.js',
  'src/ui/hud.js',
  'assets/credits.json',
];
for (const f of CODE) if (need(W + f)) codeOk++;
console.log(`  ${codeOk}/${CODE.length} present`);

console.log('\ndownloaded assets (every entry in the manifest)');
const manifest = JSON.parse(readFileSync(resolve(root, 'tools/assets.manifest.json'), 'utf8'));
let ok = 0;
for (const a of manifest.assets) {
  if (need(W + a.dst)) ok++;
}
console.log(`  ${ok}/${manifest.assets.length} present`);

// A game bundle that is suspiciously small almost certainly lost its assets.
console.log('\nsanity');
if (size < 15 * 1024 * 1024) {
  failed++;
  console.log(`  FAIL   APK is only ${mb(size)} — the asset pack alone is ~19 MB`);
} else {
  console.log(`  ok     size is consistent with a full asset pack`);
}

const wwwCount = [...entries].filter((e) => e.startsWith(W)).length;
console.log(`  ok     ${wwwCount} bundled game files`);

console.log(failed ? `\n${failed} problem(s) found\n` : '\nAPK contents verified\n');
process.exit(failed ? 1 : 0);
