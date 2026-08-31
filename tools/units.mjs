#!/usr/bin/env node
/**
 * Fast logic tests — no browser, no GPU. These cover the pure systems where a
 * regression is easy to introduce and hard to notice by playing: navigation,
 * damage falloff, the health and wave curves, and the pooling primitives.
 *
 *   node tools/units.mjs
 */
import assert from 'node:assert/strict';

import { Box, CollisionWorld, FlowField } from '../src/world/collision.js';
import { Pool, RNG, clamp, damp, angleDelta, RollingAverage } from '../src/core/util.js';
import { WEAPONS, damageAtRange, fireInterval, BOX_POOL } from '../src/weapons/arsenal.js';
import { ARCHETYPES } from '../src/entities/zombieTypes.js';
import {
  HITBOX_DEFS, intersectCapsule, sphereOverlapsRay,
} from '../src/entities/hitboxes.js';
import {
  MODIFIERS, countFor, drawModifiers, foldModifiers,
} from '../src/game/modifiers.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('\ncollision');

test('circle is pushed out of a box', () => {
  const w = new CollisionWorld(6);
  w.add(new Box(0, 0, 0, 2, 2, 3));           // 4x4 footprint, 3 tall
  const p = { x: 1.5, y: 0, z: 0 };
  w.resolveCircle(p, 0.5, 0.2, 1.8, []);
  assert.ok(p.x > 2.4, `expected ejection past the face, got x=${p.x}`);
});

test('a circle above the box is untouched', () => {
  const w = new CollisionWorld(6);
  w.add(new Box(0, 0, 0, 2, 2, 1));
  const p = { x: 1.5, y: 2, z: 0 };
  w.resolveCircle(p, 0.5, 2.2, 3.8, []);
  assert.equal(p.x, 1.5);
});

test('raycast hits the near face with the right normal', () => {
  const w = new CollisionWorld(6);
  w.add(new Box(0, 0, 0, 1, 1, 2));
  const hit = w.raycast({ x: -5, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 20, {});
  assert.ok(hit, 'expected a hit');
  assert.ok(Math.abs(hit.distance - 4) < 1e-6, `distance ${hit.distance}`);
  assert.ok(hit.normal.x < -0.99, `normal ${hit.normal.x}`);
});

test('raycast misses when the ray passes beside the box', () => {
  const w = new CollisionWorld(6);
  w.add(new Box(0, 0, 0, 1, 1, 2));
  assert.equal(w.raycast({ x: -5, y: 1, z: 5 }, { x: 1, y: 0, z: 0 }, 20, {}), null);
});

test('a yaw-rotated box is hit on its rotated face', () => {
  const w = new CollisionWorld(6);
  // hx=3, hz=0.5 rotated 90 degrees: the long axis now runs along Z, so the
  // box occupies x in [-0.5, 0.5] and z in [-3, 3].
  w.add(new Box(0, 0, 0, 3, 0.5, 2, Math.PI / 2));

  // End on, down the long axis.
  const endOn = w.raycast({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, 20, {});
  assert.ok(endOn && Math.abs(endOn.distance - 2) < 1e-6, `end-on ${endOn?.distance}`);

  // Broadside, within the long extent: hits the narrow face at x = -0.5.
  const side = w.raycast({ x: -5, y: 1, z: 2.5 }, { x: 1, y: 0, z: 0 }, 20, {});
  assert.ok(side && Math.abs(side.distance - 4.5) < 1e-6, `broadside ${side?.distance}`);

  // Past the end of the long extent: nothing there.
  assert.equal(w.raycast({ x: -5, y: 1, z: 4 }, { x: 1, y: 0, z: 0 }, 20, {}), null);
});

test('visible() is blocked by a wall between two points', () => {
  const w = new CollisionWorld(6);
  w.add(new Box(0, 0, 0, 0.5, 5, 4));
  assert.equal(w.visible({ x: -5, y: 1, z: 0 }, { x: 5, y: 1, z: 0 }), false);
  assert.equal(w.visible({ x: -5, y: 1, z: 8 }, { x: 5, y: 1, z: 8 }), true);
});

console.log('\nflow field');

test('routes around a wall instead of through it', () => {
  const w = new CollisionWorld(6);
  // A wall across x = 0 with a gap at the far +Z end.
  w.add(new Box(0, 0, -6, 0.5, 6, 3));
  const f = new FlowField(20, 1.0).bake(w, 0.4, 0.5);
  assert.ok(f.compute(-8, -6, true), 'flood should run');

  // A point on the far side is reachable, but only the long way round.
  const straight = Math.hypot(8 - -8, 0);
  const routed = f.distanceAt(8, -6);
  assert.ok(routed > 0, 'target should be reachable');
  assert.ok(routed > straight, `expected a detour, got ${routed} vs ${straight}`);
});

test('flow vectors point down the gradient', () => {
  const w = new CollisionWorld(6);
  const f = new FlowField(20, 1.0).bake(w, 0.4, 0.5);
  f.compute(0, 0, true);
  const v = f.sample(10, 0, { x: 0, z: 0 });
  assert.ok(v.x < -0.7, `expected to steer toward -X, got ${v.x}`);
});

test('a sealed border is not walkable', () => {
  const f = new FlowField(20, 1.0);
  f.bake(new CollisionWorld(6), 0.4, 0.5);
  f.sealBorder(2);
  assert.equal(f.walkable(19.5, 0), false);
  assert.equal(f.walkable(0, 0), true);
});

test('geometry a zombie can step over is not an obstacle', () => {
  const w = new CollisionWorld(6);
  w.add(new Box(0, 0, 0, 3, 3, 0.12));   // a kerb
  const f = new FlowField(20, 1.0).bake(w, 0.4, 0.55);
  assert.equal(f.walkable(0, 0), true);
});

console.log('\nhitboxes');

const norm = (x, y, z) => { const l = Math.hypot(x, y, z); return { x: x / l, y: y / l, z: z / l }; };

test('a capsule is hit across its middle at the right distance', () => {
  // Upright capsule, radius 0.2, from y=1 to y=2 at the origin.
  const a = { x: 0, y: 1, z: 0 }, b = { x: 0, y: 2, z: 0 };
  const t = intersectCapsule({ x: 0, y: 1.5, z: -5 }, { x: 0, y: 0, z: 1 }, a, b, 0.2, 20);
  assert.ok(Math.abs(t - 4.8) < 1e-6, `expected the near wall at 4.8, got ${t}`);
});

test('a ray past the shoulder of a capsule misses', () => {
  const a = { x: 0, y: 1, z: 0 }, b = { x: 0, y: 2, z: 0 };
  assert.equal(intersectCapsule({ x: 0.25, y: 1.5, z: -5 }, { x: 0, y: 0, z: 1 }, a, b, 0.2, 20), -1);
});

test('the end caps are solid', () => {
  const a = { x: 0, y: 1, z: 0 }, b = { x: 0, y: 2, z: 0 };
  // Just above the top end, still inside the cap.
  const t = intersectCapsule({ x: 0, y: 2.1, z: -5 }, { x: 0, y: 0, z: 1 }, a, b, 0.2, 20);
  assert.ok(t > 4.8 && t < 5, `expected a cap hit just short of the axis, got ${t}`);
  // Above the cap entirely.
  assert.equal(intersectCapsule({ x: 0, y: 2.25, z: -5 }, { x: 0, y: 0, z: 1 }, a, b, 0.2, 20), -1);
});

test('firing straight down the axis still hits the cap', () => {
  // Degenerate case: the cylinder quadratic collapses, only the caps remain.
  const a = { x: 0, y: 1, z: 0 }, b = { x: 0, y: 2, z: 0 };
  const t = intersectCapsule({ x: 0, y: 4, z: 0 }, { x: 0, y: -1, z: 0 }, a, b, 0.2, 20);
  assert.ok(Math.abs(t - 1.8) < 1e-6, `expected the top cap at 1.8, got ${t}`);
});

test('a muzzle inside the capsule finds the far wall, not a negative t', () => {
  const a = { x: 0, y: 1, z: 0 }, b = { x: 0, y: 2, z: 0 };
  const t = intersectCapsule({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: 1 }, a, b, 0.2, 20);
  assert.ok(t > 0 && Math.abs(t - 0.2) < 1e-6, `expected the far wall at 0.2, got ${t}`);
});

test('a zero-length capsule degrades to a sphere', () => {
  const a = { x: 0, y: 1, z: 0 };
  const t = intersectCapsule({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, a, a, 0.3, 20);
  assert.ok(Math.abs(t - 4.7) < 1e-6, `expected 4.7, got ${t}`);
});

test('a tilted capsule is hit along its own axis', () => {
  const a = { x: 0, y: 1, z: 0 }, b = { x: 1, y: 2, z: 0 };
  const mid = { x: 0.5, y: 1.5, z: 0 };
  const t = intersectCapsule({ x: mid.x, y: mid.y, z: -5 }, { x: 0, y: 0, z: 1 }, a, b, 0.15, 20);
  assert.ok(Math.abs(t - 4.85) < 1e-6, `expected 4.85 through the midpoint, got ${t}`);
});

test('maxT clips a hit that lies beyond it', () => {
  const a = { x: 0, y: 1, z: 0 }, b = { x: 0, y: 2, z: 0 };
  assert.equal(intersectCapsule({ x: 0, y: 1.5, z: -5 }, { x: 0, y: 0, z: 1 }, a, b, 0.2, 4), -1);
});

test('the broad-phase sphere accepts a ray that starts inside it', () => {
  // Point blank: the near root is behind the muzzle, so a naive distance test
  // would reject the zombie the player has their barrel against.
  assert.ok(sphereOverlapsRay({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 0, 1, 0.2, 1.5, 0.3));
  assert.ok(!sphereOverlapsRay({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, 0, 1, 0, 0.5, 3));
  assert.ok(!sphereOverlapsRay({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: -1 }, 0, 1, 0, 0.5, 30));
  assert.ok(sphereOverlapsRay({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, 0, 1, 0, 0.5, 30));
});

test('an oblique ray through a limb capsule is found', () => {
  const a = { x: 0, y: 1.0, z: 0 }, b = { x: 0, y: 1.45, z: 0 };   // a thigh
  const d = norm(0.3, -0.1, 1);
  const t = intersectCapsule({ x: -1.5, y: 1.7, z: -5 }, d, a, b, 0.088, 40);
  assert.ok(t > 0, 'a diagonal shot through the thigh should connect');
});

test('the hitbox table covers the body and names real Mixamo bones', () => {
  const parts = new Set(HITBOX_DEFS.map((h) => h.part));
  for (const p of ['head', 'chest', 'gut', 'arm', 'leg']) {
    assert.ok(parts.has(p), `no hitbox for ${p}`);
  }
  const known = new Set([
    'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End',
    'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
    'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot',
  ]);
  for (const h of HITBOX_DEFS) {
    assert.ok(known.has(h.a) && known.has(h.b), `unknown bone in ${h.part}: ${h.a}/${h.b}`);
    assert.ok(h.r > 0.02 && h.r < 0.4, `implausible radius on ${h.part}: ${h.r}`);
    assert.ok(h.t1 > h.t0, `${h.part} capsule has no length`);
    assert.ok(h.mul > 0 && h.mul <= 1, `${h.part} multiplier out of range`);
    if (h.part === 'arm' || h.part === 'leg') {
      assert.ok(h.limb, `${h.part} must name the bone that comes off`);
    }
  }
  // Every limb capsule severs a distinct bone, or two boxes would take the
  // same arm off twice and one would never be reachable.
  const limbs = HITBOX_DEFS.filter((h) => h.limb).map((h) => h.limb);
  assert.equal(new Set(limbs).size, limbs.length, 'duplicate sever bone');
});

console.log('\nwave conditions');

test('the table is well formed', () => {
  const ids = new Set();
  for (const m of MODIFIERS) {
    assert.ok(m.id && !ids.has(m.id), `duplicate or missing id: ${m.id}`);
    ids.add(m.id);
    assert.ok(m.name && m.blurb, `${m.id} has nothing to show the player`);
    assert.ok(m.minWave >= 1 && m.weight > 0, `${m.id} cannot be drawn`);
    assert.ok(m.zombie || m.wave || m.mood, `${m.id} does nothing`);
  }
});

test('no conditions before wave 3, and never more than three', () => {
  for (let w = 1; w <= 60; w++) {
    const n = countFor(w, false);
    assert.ok(n >= 0 && n <= 3, `wave ${w} wants ${n}`);
    if (w < 3) assert.equal(n, 0, `wave ${w} should be plain`);
  }
  // A boss is a condition in itself.
  assert.ok(countFor(20, true) < countFor(20, false));
});

test('a draw never repeats what the last waves had', () => {
  const rng = new RNG(99);
  let recent = [];
  for (let w = 3; w <= 40; w++) {
    const got = drawModifiers(w, () => rng.next(), recent, false);
    for (const m of got) assert.ok(!recent.includes(m.id), `wave ${w} repeated ${m.id}`);
    const ids = got.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `wave ${w} drew a duplicate`);
    recent = [...ids, ...recent].slice(0, 4);
  }
});

test('a draw only offers what the wave has unlocked', () => {
  const rng = new RNG(7);
  for (let w = 3; w <= 40; w++) {
    for (const m of drawModifiers(w, () => rng.next(), [], false)) {
      assert.ok(w >= m.minWave, `${m.id} turned up on wave ${w}, needs ${m.minWave}`);
    }
  }
});

test('two conditions never fight over the same lever', () => {
  const rng = new RNG(4242);
  for (let w = 7; w <= 60; w++) {
    const got = drawModifiers(w, () => rng.next(), [], false);
    assert.ok(got.filter((m) => m.mood).length <= 1, `wave ${w} has two skies`);
    assert.ok(got.filter((m) => m.wave?.budget).length <= 1, `wave ${w} scales the budget twice`);
    assert.ok(got.filter((m) => m.wave?.interval).length <= 1, `wave ${w} scales the pace twice`);
  }
});

test('folding is neutral with nothing to fold', () => {
  const f = foldModifiers([]);
  for (const v of Object.values(f.zombie)) assert.equal(v, 1);
  for (const v of Object.values(f.wave)) assert.equal(v, 1);
  assert.equal(f.mood, null);
});

test('folding stays inside sane bounds however it stacks', () => {
  // Every combination of three, including ones the draw would refuse.
  for (let i = 0; i < MODIFIERS.length; i++) {
    for (let j = 0; j < MODIFIERS.length; j++) {
      for (let k = 0; k < MODIFIERS.length; k++) {
        const f = foldModifiers([MODIFIERS[i], MODIFIERS[j], MODIFIERS[k]]);
        assert.ok(f.zombie.health >= 0.25 && f.zombie.health <= 3.2, 'health out of range');
        assert.ok(f.zombie.speed >= 0.7 && f.zombie.speed <= 1.6, 'speed out of range');
        assert.ok(f.zombie.damage <= 2.0, 'damage out of range');
        assert.ok(f.wave.budget <= 2.4 && f.wave.budget >= 0.5, 'budget out of range');
        assert.ok(f.wave.interval >= 0.4, 'interval out of range');
      }
    }
  }
});

test('a swarm really is more of them, and a hardened wave really is fewer', () => {
  const swarm = foldModifiers([MODIFIERS.find((m) => m.id === 'swarm')]);
  const elite = foldModifiers([MODIFIERS.find((m) => m.id === 'elite')]);
  assert.ok(swarm.wave.budget > 1.2 && swarm.zombie.health < 1);
  assert.ok(elite.wave.budget < 0.8 && elite.zombie.health > 1.5);
});

console.log('\nweapons');

test('damage falls off between the breakpoints only', () => {
  const w = WEAPONS.rifle;
  assert.equal(damageAtRange(w, 0), w.damage);
  assert.equal(damageAtRange(w, w.falloff[0]), w.damage);
  const mid = damageAtRange(w, (w.falloff[0] + w.falloff[1]) / 2);
  assert.ok(mid < w.damage && mid > w.damage * w.minDamage);
  assert.ok(Math.abs(damageAtRange(w, 500) - w.damage * w.minDamage) < 1e-9);
});

test('every weapon is internally consistent', () => {
  for (const w of Object.values(WEAPONS)) {
    assert.ok(w.name && w.short, `${w.id} needs a name`);
    assert.ok(w.rpm > 0, `${w.id} rpm`);
    assert.ok(fireInterval(w) > 0);
    assert.ok(w.model && w.model.type, `${w.id} needs a viewmodel type`);
    assert.ok(w.recoil && typeof w.recoil.kick === 'number', `${w.id} recoil`);
    if (w.magSize !== Infinity) {
      assert.ok(w.reloadTime > 0, `${w.id} needs a reload time`);
      assert.ok(w.magSize > 0, `${w.id} mag size`);
    }
  }
});

test('the mystery box can hand out something', () => {
  assert.ok(BOX_POOL.length >= 3);
  assert.ok(BOX_POOL.every((w) => w.boxWeight > 0));
});

console.log('\nbalance curves');

const health = (spec, wave) => {
  const w = Math.max(0, wave - 1);
  const growth = spec.boss
    ? 1 + Math.max(0, wave - 5) * 0.25
    : (w <= 9 ? 1 + w * 0.22 : 1 + 9 * 0.22 + (w - 9) * 0.30);
  return Math.round(spec.health * growth * (spec.healthScale ?? 1));
};

test('health rises monotonically and stays killable', () => {
  const walker = ARCHETYPES.walker;
  let prev = 0;
  for (let wave = 1; wave <= 30; wave++) {
    const h = health(walker, wave);
    assert.ok(h > prev, `wave ${wave} health did not rise`);
    prev = h;
  }
  // An upgraded rifle headshot must still drop a wave-30 walker in a burst.
  const perHead = WEAPONS.rifle.damage * WEAPONS.rifle.headMul * 2;
  assert.ok(health(walker, 30) / perHead < 5,
    `wave 30 walker takes ${(health(walker, 30) / perHead).toFixed(1)} upgraded headshots`);
});

test('a wave-5 boss dies to a full magazine or three', () => {
  const boss = health(ARCHETYPES.abomination, 5);
  const shotgunMag = WEAPONS.shotgun.magSize * WEAPONS.shotgun.pellets * WEAPONS.shotgun.damage;
  assert.ok(boss / shotgunMag < 4, `boss takes ${(boss / shotgunMag).toFixed(1)} shotgun mags`);
  assert.ok(boss / shotgunMag > 0.8, 'boss should not fall to a single magazine');
});

test('archetype table is well formed', () => {
  for (const a of Object.values(ARCHETYPES)) {
    assert.ok(a.health > 0 && a.budget > 0, `${a.id} health/budget`);
    assert.ok(a.speed[0] > 0 && a.speed[1] >= a.speed[0], `${a.id} speed range`);
    assert.ok(a.scale[0] > 0 && a.scale[1] >= a.scale[0], `${a.id} scale range`);
    assert.ok(a.heightM > 0.5 && a.heightM < 6, `${a.id} height`);
    assert.ok(a.points > 0 && a.minWave >= 1, `${a.id} points/minWave`);
    assert.ok(Array.isArray(a.tint) && a.tint.length > 0, `${a.id} tint`);
    if (a.charges) assert.ok(a.sprintSpeed > a.speed[1], `${a.id} charge speed`);
  }
});

console.log('\nprimitives');

test('pool hands out and takes back without leaking', () => {
  const p = new Pool(3, (i) => ({ i }));
  const a = p.acquire(), b = p.acquire(), c = p.acquire();
  assert.equal(p.acquire(), null);
  assert.equal(p.count, 3);
  p.release(b);
  assert.equal(p.count, 2);
  assert.ok(p.acquire());
  p.releaseAll();
  assert.equal(p.count, 0);
  assert.ok(a && c);
});

test('seeded RNG is deterministic', () => {
  const a = new RNG(42), b = new RNG(42);
  for (let i = 0; i < 50; i++) assert.equal(a.next(), b.next());
  assert.notEqual(new RNG(1).next(), new RNG(2).next());
});

test('damp is frame-rate independent', () => {
  // One big step and many small ones must land in the same place.
  let big = 0;
  big = damp(big, 1, 5, 0.5);
  let small = 0;
  for (let i = 0; i < 50; i++) small = damp(small, 1, 5, 0.01);
  assert.ok(Math.abs(big - small) < 1e-9, `${big} vs ${small}`);
});

test('angleDelta takes the short way round', () => {
  assert.ok(Math.abs(angleDelta(0.1, -0.1) - -0.2) < 1e-9);
  assert.ok(Math.abs(angleDelta(3.0, -3.0) - 0.2831853) < 1e-6);
});

test('rolling average converges', () => {
  const r = new RollingAverage(10, 0);
  for (let i = 0; i < 20; i++) r.push(5);
  assert.ok(Math.abs(r.mean - 5) < 1e-9);
});

test('clamp behaves at the edges', () => {
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(2, 0, 1), 1);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
