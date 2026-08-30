# NIGHT OF THE RISEN

A wave-survival zombie shooter that runs in the browser on WebGL2 — physically
based night rendering, a flow-field horde, and a twelve-weapon arsenal.

![wave one](docs/screenshot-wave.png)

```bash
npm run assets     # download the asset pack from the web (once)
npm start          # serve on http://localhost:8080
```

There is no build step. The game is plain ES modules behind an import map, so
`npm start` (or any static server) is all it needs.

---

## What this is, and what it is not

The brief asked for Unreal Engine 5 "or equivalent". UE5 is not buildable here
and would not be runnable by anyone you sent it to: it is a ~120 GB editor that
needs a desktop GPU, an Epic account and a per-platform cook-and-package step.

So this is the equivalent, built to actually be played: a real-time PBR renderer
on WebGL2 with image-based lighting, cascaded-frustum shadows, screen-space
ambient occlusion, bloom and a filmic grade — running in any browser, from a
link, at 60 fps. Every technique below is the same technique a UE5 project would
use; the budget is just smaller and the delivery is a URL.

## Performance

The target is **60 fps**, with a hard floor of 30 held by an adaptive scaler.

| | |
|---|---|
| Static level | ~12 draw calls (all geometry merged per material) |
| Effects layer | ~6 draw calls regardless of activity |
| Zombie eyes | 1 draw call for the entire horde |
| Steady-state allocation | zero — everything hot is pooled |
| Frame budget defence | resolution scaling, never simulation rate |

Specific decisions that buy the frame time:

- **Flow-field navigation.** One breadth-first flood from the player over a
  coarse walkability grid, five times a second. Each zombie then reads a single
  vector out of the field, so pathing is O(1) per agent instead of O(path).
  Sixty zombies navigate real corners and doorways for the cost of one search.
- **Merged static geometry.** Every box, window and prop in the level is baked
  into one mesh per material at build time.
- **Animation LOD.** Skinning is the most expensive thing in the frame, so
  distant zombies evaluate their skeleton every second or fourth frame and stop
  contributing to the shadow map past a distance set by the quality tier.
- **Analytic collision and hit detection.** No BVH and no mesh raycasts —
  bullets test against yaw-aligned boxes and per-zombie capsule + head sphere,
  which is a handful of float operations and keeps headshots accurate mid-animation.
- **A pooled light budget.** The level has ~100 emissive fixtures but only ever
  pays for the nearest few, ranked by importance as well as distance. Everything
  else is covered by baked additive ground pools in a single draw call.
- **Adaptive resolution.** A rolling frame-time average nudges render scale
  between 0.55× and 1× with hysteresis. The simulation rate never changes, so
  the game feels identical whether it is holding 30 or 144.

Quality tiers (`Low` / `Medium` / `High` / `Ultra`) are picked from a GPU probe
on first run and are switchable in-game; they control shadow resolution, AO,
bloom, draw distance, particle budget and the live-zombie cap (22 → 60).

## The game

**Precinct 13, sealed.** A city block with a plaza to hold, four street spokes,
and an unbroken ring road — because when the plaza fills up, the only answer is
to start a lap and let the horde string out behind you.

Waves are built from a **points budget**, not a body count, so difficulty scales
through composition as well as numbers:

| Wave | What arrives |
|---|---|
| 1 | Walkers |
| 3 | Runners — fast, and they flank |
| 5 | **Abomination.** The sky turns red. Every fifth wave. |
| 5 | Crawlers — small target, quick |
| 6 | Brutes — charge in a straight line, shrug off stagger |
| 8 | Spitters — ranged acid, punishes standing still |
| 10 | Screamers — turn the whole street into runners |

Points come from **damage as well as kills**, so nothing you shoot is wasted,
and chipping a brute still pays for your next weapon. Headshots do far more
damage and pay 50% more.

Spend points on wall-buys, the ammo crate, four perks (Juggernog, Stamin-Up,
Double Tap, Speed Cola) and the mystery box — which moves on after a few uses,
so spend while it is close. Six power-ups drop from kills: Insta-Kill, Double
Points, Max Ammo, Nuke, Deep Freeze and Carnage.

### The arsenal

Twelve weapons, each built to solve a problem the others do not.

| | Weapon | Why you would carry it |
|---|---|---|
| 🔪 | Trench Knife | Free, silent, enough for wave one |
| 🔫 | M1911 | Insurance. Infinite reserve at the crate |
| 🔫 | .44 Peacekeeper | Punches through two bodies and staggers the third |
| 🔫 | MP-9 Hornet | Shreds runners inside twenty metres |
| 🔫 | AKM-74 | The all-rounder |
| 💥 | SPAS-12 Breaker | Owns a doorway. Ten pellets, all of them can crit |
| 🎯 | Longbow .338 | Pierces five. Line the street up and pull once |
| 🌀 | M-901 Reaper | Spins up, then does not stop |
| 🔥 | Cinder Mk II | Sets the pack alight; damage keeps ticking |
| ⚡ | Arc Projector | Chains to five targets — the answer to a pile-up |
| 💣 | M79 Thumper | One shell, one crowd |
| ☄️ | Ferro Lance | Charge, release, erase a lane |

Weapons are **procedural** — assembled from primitives and merged per material,
three or four draw calls each — and they live in the main scene parented to the
camera, so they take the world's light, the muzzle flash, the bloom and the
grade. A gun rendered in its own pass always looks pasted on. The trade is wall
clipping, handled by pulling the weapon back when something solid is close.

### The horde

The zombies are a Mixamo-rigged skinned mesh playing a walk/run clip with a
**procedural pose layer applied on top of the bones every frame**: a forward
hunch across the spine, a lateral lurch on a per-zombie phase, a lolling head
and arms reaching forward. That layer is what turns a marching soldier into
something that shambles, and it costs a few quaternion multiplies each.

Their skin is a shader pass over the source texture — desaturated, pushed toward
a per-archetype tint, mottled with necrosis and dried blood from a noise lookup,
so no two read the same. They flash white when hit and **dissolve** along a
noise threshold with a hot rim when they die, rather than blinking out.

Each one has a pair of additive eye quads billboarded from the head bone, drawn
for the entire horde in one instanced call. In a level this dark, a pair of
points coming at you out of an alley does more work than any amount of texture
detail.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | Move |
| `Shift` / `Ctrl` / `Space` | Sprint / Crouch / Jump |
| Mouse · `LMB` · `RMB` | Aim · Fire · Aim down sights |
| `R` · `G` · `F` | Reload · Grenade · Flashlight |
| `E` | Buy / interact |
| `1`–`4`, wheel, `Q` | Switch weapon, last weapon |
| `Esc` · `F3` | Pause · Performance overlay |

## Assets

Every runtime asset is **downloaded from the web** by `tools/fetch-assets.mjs`,
which reads `tools/assets.manifest.json` — 29 files, ~19 MB, each entry
recording its source, licence and what it is used for. Sources are the three.js
example asset pool (MIT) and Poly Haven HDRIs (CC0).

Downloaded assets are combined and extended at load time rather than used raw:

- Height maps that shipped without normal maps are **Sobel-filtered into real
  tangent-space normal maps** on load, so brick and wood catch the flashlight
  with actual relief.
- Large tiled surfaces get a **world-space detail breakup** injected into their
  shader — one extra texture fetch at a different scale, modulating albedo and
  roughness, which destroys the visible repetition of a 1k texture stretched
  across a 90 m street.
- The night sky, the light-pool falloff and every sound effect are generated at
  runtime.

**All audio is synthesised** with the Web Audio API — layered gunshots whose
body, crack and tail come from the weapon definition, formant-filtered zombie
vocals that differ per archetype, wet impacts, ricochet whines and an ambient
wind bed that brightens as the horde closes in. Nothing is sampled, so every
shot and every growl is slightly different.

## Project layout

```
src/
  core/      util, quality tiers + adaptive scaler, input, asset loader, audio synth
  render/    renderer + post chain, night sky, final grade, particles/decals/gore
  world/     PBR material library, arena generator, collision + flow-field nav
  entities/  player controller, zombie manager, archetype table
  weapons/   arsenal data, procedural viewmodels, combat resolution
  game/      wave director + power-ups, economy/perks/mystery box
  ui/        HUD
tools/       asset manifest + downloader, headless test harness
vendor/      three.js r180 (build + addons), vendored so there is no install step
```

## Testing

The game ships with a headless harness built on Playwright:

```bash
npm run smoke                                        # boot, load, build, render
node tools/smoke.mjs --page index.html --bot --run 60 # play it with a scripted bot
```

`--bot` runs a scripted player that walks, aims, fires, reloads, throws grenades
and buys from stations, so a test run exercises spawning, pathing, hit
detection, gore, the economy and wave transitions with nobody at the mouse. Any
console error, unhandled rejection or page error fails the run.

## Licence

Game code is MIT. Vendored three.js is MIT (`vendor/three/LICENSE`). Downloaded
assets keep their own licences, recorded per entry in
`tools/assets.manifest.json`.
