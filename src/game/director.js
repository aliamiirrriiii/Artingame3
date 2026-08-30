import * as THREE from 'three';
import { ARCHETYPES } from '../entities/zombieTypes.js';
import { clamp, lerp, rand, randInt, RNG, TAU } from '../core/util.js';
import { audio } from '../core/audio.js';

/**
 * The wave director.
 *
 * Waves are built from a points budget rather than a flat count, so difficulty
 * scales through composition as well as numbers: wave 3 introduces runners,
 * wave 6 the first brute, wave 8 spitters that punish standing still, wave 10
 * screamers that turn the whole street into runners. Every fifth wave is a boss.
 *
 * Spawning is throttled by `maxAlive` and by a trickle rate, which is what keeps
 * a wave feeling like a rising tide instead of one lump arriving at the door.
 */

export const WAVE_STATE = {
  PREPARING: 'preparing',
  ACTIVE: 'active',
  CLEARED: 'cleared',
};

export class Director {
  constructor({ zombies, level, player, effects, stage, seed = 1337 }) {
    this.zm = zombies;
    this.level = level;
    this.player = player;
    this.fx = effects;
    this.stage = stage;
    this.rng = new RNG(seed);

    this.wave = 0;
    this.state = WAVE_STATE.PREPARING;
    this.stateT = 0;
    this.breather = 8.0;

    this.queue = [];           // archetype ids still to spawn this wave
    this.spawnTimer = 0;
    this.spawnInterval = 1.0;
    this.killedThisWave = 0;
    this.spawnedThisWave = 0;
    this.totalKills = 0;

    this.onWaveStart = null;
    this.onWaveClear = null;
    this.onAnnounce = null;
    this.onPowerup = null;

    this.powerups = [];
    this._buildPowerupPool();

    this.active = false;
    this._tmpForward = new THREE.Vector3();
    this._flowTimer = 0;
  }

  start() {
    this.wave = 0;
    this.state = WAVE_STATE.PREPARING;
    this.stateT = 0;
    this.breather = 4.0;
    this.queue.length = 0;
    this.killedThisWave = 0;
    this.totalKills = 0;
    this.active = true;
    for (const p of this.powerups) this._despawnPowerup(p);
  }

  stop() { this.active = false; }

  // ------------------------------------------------------------ composition

  /** Total spawn budget for a wave. Grows fast early, then steadies. */
  budgetFor(wave) {
    return Math.round(4 + wave * 2.6 + Math.pow(wave, 1.62) * 0.55);
  }

  /** How many may be alive at once — climbs to the preset cap by wave 12. */
  aliveCapFor(wave) {
    const cap = this.zm.maxAlive;
    return Math.round(clamp(6 + wave * 2.4, 6, cap));
  }

  isBossWave(wave) { return wave > 0 && wave % 5 === 0; }

  /** Builds the spawn list for a wave from the archetypes unlocked so far. */
  composeWave(wave) {
    const list = [];
    let budget = this.budgetFor(wave);

    if (this.isBossWave(wave)) {
      const bosses = 1 + Math.floor((wave - 5) / 15);
      for (let i = 0; i < bosses; i++) list.push('abomination');
      budget = Math.round(budget * 0.55);
    }

    const pool = Object.values(ARCHETYPES).filter(
      (a) => !a.boss && wave >= a.minWave,
    );

    // Weight toward the more expensive archetypes as waves go on, but always
    // keep a body of walkers so the horde still reads as a horde.
    const weights = pool.map((a) => {
      const age = wave - a.minWave;
      const base = a.id === 'walker' ? 5.0 : 1.0;
      return base * (1 + clamp(age, 0, 12) * 0.16) / Math.pow(a.budget, 0.55);
    });
    const total = weights.reduce((s, w) => s + w, 0);

    let guard = 0;
    while (budget > 0 && guard++ < 800) {
      let r = this.rng.next() * total;
      let pickIdx = 0;
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i];
        if (r <= 0) { pickIdx = i; break; }
      }
      const a = pool[pickIdx];
      if (a.budget > budget && a.id !== 'walker') continue;
      list.push(a.id);
      budget -= a.budget;
    }

    // Bosses first so they are on the field for the whole wave.
    list.sort((x, y) => (ARCHETYPES[y].boss ? 1 : 0) - (ARCHETYPES[x].boss ? 1 : 0));
    return list;
  }

  // ----------------------------------------------------------------- update

  update(dt) {
    if (!this.active) return;
    this.stateT += dt;

    // Re-flood the navigation field a few times a second, and only when the
    // player has actually changed cell.
    this._flowTimer -= dt;
    if (this._flowTimer <= 0) {
      this._flowTimer = 0.18;
      this.level.flow.compute(this.player.pos.x, this.player.pos.z);
    }

    switch (this.state) {
      case WAVE_STATE.PREPARING: this._updatePreparing(dt); break;
      case WAVE_STATE.ACTIVE: this._updateActive(dt); break;
      case WAVE_STATE.CLEARED: this._updateCleared(dt); break;
    }

    this._updatePowerups(dt);
  }

  _updatePreparing(dt) {
    if (this.stateT < this.breather) return;
    this.wave++;
    this.queue = this.composeWave(this.wave);
    this.spawnedThisWave = 0;
    this.killedThisWave = 0;
    this.waveTotal = this.queue.length;
    this.state = WAVE_STATE.ACTIVE;
    this.stateT = 0;

    // Later waves arrive faster.
    this.spawnInterval = clamp(1.5 - this.wave * 0.055, 0.28, 1.5);
    this.spawnTimer = 0.4;

    audio.waveHorn(this.wave);
    if (this.onWaveStart) this.onWaveStart(this.wave, this.waveTotal, this.isBossWave(this.wave));
    if (this.onAnnounce) {
      this.onAnnounce(
        this.isBossWave(this.wave) ? 'THEY SENT SOMETHING BIGGER' : `WAVE ${this.wave}`,
        this.isBossWave(this.wave) ? 'boss' : 'wave',
      );
    }

    // Boss waves recolour the whole scene.
    if (this.isBossWave(this.wave)) {
      this.stage.setMood({
        fog: 0x2a1014, fogDensity: this.stage.preset.fogDensity * 1.15,
        moonColor: 0xff8866, moonIntensity: 1.5, exposure: 1.0,
      });
    } else {
      this.stage.setMood({
        fog: 0x111823, fogDensity: this.stage.preset.fogDensity,
        moonColor: 0xa8c6ff, moonIntensity: 1.9, exposure: 1.05,
      });
    }
  }

  _updateActive(dt) {
    const cap = this.aliveCapFor(this.wave);

    this.spawnTimer -= dt;
    if (this.queue.length && this.spawnTimer <= 0 && this.zm.aliveCount < cap) {
      // Spawn in small clusters: two or three walking out of one alley reads
      // better than a steady drip of singles.
      const cluster = Math.min(
        this.queue.length,
        cap - this.zm.aliveCount,
        randInt(1, this.wave < 4 ? 2 : 3),
      );
      this._tmpForward.copy(this.player.forward);
      for (let i = 0; i < cluster; i++) {
        const id = this.queue[0];
        const point = this.level.pickSpawn(
          this.player.pos, this._tmpForward,
          ARCHETYPES[id].boss ? 22 : 15,
          () => this.rng.next(),
        );
        if (!point) break;
        const jitter = new THREE.Vector3(
          point.x + rand(-1.4, 1.4), 0, point.z + rand(-1.4, 1.4),
        );
        const z = this.zm.spawn(id, jitter, this.wave);
        if (!z) break;
        this.queue.shift();
        this.spawnedThisWave++;
      }
      this.spawnTimer = this.spawnInterval * rand(0.7, 1.3);
    }

    if (!this.queue.length && this.zm.aliveCount === 0) {
      this.state = WAVE_STATE.CLEARED;
      this.stateT = 0;
      audio.chime([72, 76, 79, 84], 0.09, 0.34);
      if (this.onWaveClear) this.onWaveClear(this.wave);
      if (this.onAnnounce) this.onAnnounce(`WAVE ${this.wave} CLEARED`, 'clear');
    }
  }

  _updateCleared(dt) {
    if (this.stateT < 1.5) return;
    this.state = WAVE_STATE.PREPARING;
    this.stateT = 0;
    // The pause between waves shrinks as the night wears on.
    this.breather = clamp(9 - this.wave * 0.22, 4.0, 9);
  }

  /** Called by the game when a zombie dies, to roll for a power-up drop. */
  notifyKill(zombie) {
    this.killedThisWave++;
    this.totalKills++;

    // Drop chance rises with the wave, plus a guaranteed drop from bosses.
    const chance = zombie.spec.boss ? 1.0 : clamp(0.022 + this.wave * 0.0016, 0.02, 0.06);
    if (Math.random() < chance) {
      this.spawnPowerup(zombie.pos.x, zombie.pos.z, zombie.spec.boss ? 'nuke' : null);
    }
  }

  get progress() {
    const total = this.waveTotal || 1;
    const left = this.queue.length + this.zm.aliveCount;
    return clamp(1 - left / total, 0, 1);
  }

  get remaining() { return this.queue.length + this.zm.aliveCount; }

  // ---------------------------------------------------------------- powerups

  _buildPowerupPool() {
    const geo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x111111, emissive: 0xffffff, emissiveIntensity: 1.6,
        roughness: 0.3, metalness: 0.4,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.castShadow = false;
      const light = new THREE.PointLight(0xffffff, 0, 9, 2);
      light.visible = false;
      this.stage.scene.add(mesh, light);
      this.powerups.push({
        mesh, light, active: false, kind: null, t: 0, ttl: 22,
        pos: new THREE.Vector3(),
      });
    }
  }

  spawnPowerup(x, z, forceKind = null) {
    const slot = this.powerups.find((p) => !p.active);
    if (!slot) return null;
    const kind = forceKind || pickPowerupKind(this.rng);
    const def = POWERUPS[kind];
    slot.active = true;
    slot.kind = kind;
    slot.t = 0;
    slot.ttl = 22;
    slot.pos.set(x, 0.75, z);
    slot.mesh.position.copy(slot.pos);
    slot.mesh.material.emissive.setHex(def.color);
    slot.mesh.visible = true;
    slot.light.color.setHex(def.color);
    slot.light.position.copy(slot.pos);
    slot.light.intensity = 14;
    slot.light.visible = true;
    audio.chime([60, 67], 0.12, 0.22, 'sine');
    return slot;
  }

  _despawnPowerup(p) {
    p.active = false;
    p.mesh.visible = false;
    p.light.visible = false;
    p.light.intensity = 0;
  }

  _updatePowerups(dt) {
    for (const p of this.powerups) {
      if (!p.active) continue;
      p.t += dt;

      p.mesh.rotation.y += dt * 1.9;
      p.mesh.rotation.x += dt * 0.9;
      p.mesh.position.y = p.pos.y + Math.sin(p.t * 2.6) * 0.14;
      p.light.position.copy(p.mesh.position);

      // Blink out over the last four seconds.
      const left = p.ttl - p.t;
      if (left < 4) {
        const blink = Math.sin(left * 14) > 0;
        p.mesh.visible = blink;
        p.light.intensity = blink ? 14 : 0;
      }

      if (Math.random() < 0.4) {
        this.fx.sparks.emit({
          x: p.mesh.position.x + rand(-0.2, 0.2),
          y: p.mesh.position.y + rand(-0.2, 0.2),
          z: p.mesh.position.z + rand(-0.2, 0.2),
          vx: 0, vy: rand(0.3, 0.9), vz: 0,
          life: rand(0.4, 0.9), size: rand(0.06, 0.14), drag: 1.4, gravity: -0.2,
          r0: 1.2, g0: 1.2, b0: 1.2, r1: 0.2, g1: 0.2, b1: 0.2,
        });
      }

      const dx = this.player.pos.x - p.mesh.position.x;
      const dz = this.player.pos.z - p.mesh.position.z;
      if (dx * dx + dz * dz < 2.0 * 2.0) {
        const kind = p.kind;
        this._despawnPowerup(p);
        if (this.onPowerup) this.onPowerup(kind, POWERUPS[kind]);
      } else if (p.t >= p.ttl) {
        this._despawnPowerup(p);
      }
    }
  }
}

export const POWERUPS = {
  instakill: {
    id: 'instakill', label: 'INSTA-KILL', color: 0xff3020, duration: 22,
    blurb: 'Anything you touch dies.',
  },
  doublepoints: {
    id: 'doublepoints', label: 'DOUBLE POINTS', color: 0xffcc22, duration: 26,
    blurb: 'Every point counts twice.',
  },
  maxammo: {
    id: 'maxammo', label: 'MAX AMMO', color: 0x40b8ff, duration: 0,
    blurb: 'Every magazine and reserve, full.',
  },
  nuke: {
    id: 'nuke', label: 'NUKE', color: 0x66ff66, duration: 0,
    blurb: 'The whole street, at once.',
  },
  freeze: {
    id: 'freeze', label: 'DEEP FREEZE', color: 0x66eaff, duration: 14,
    blurb: 'The horde slows to a crawl.',
  },
  carnage: {
    id: 'carnage', label: 'CARNAGE', color: 0xff44cc, duration: 20,
    blurb: 'Double damage, double fire rate.',
  },
};

const POWERUP_WEIGHTS = [
  ['maxammo', 26], ['instakill', 18], ['doublepoints', 20],
  ['nuke', 12], ['freeze', 12], ['carnage', 12],
];

function pickPowerupKind(rng) {
  const total = POWERUP_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = rng.next() * total;
  for (const [id, w] of POWERUP_WEIGHTS) {
    r -= w;
    if (r <= 0) return id;
  }
  return 'maxammo';
}
