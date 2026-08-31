import { WEAPONS, BOX_POOL } from '../weapons/arsenal.js';
import { clamp, fmt, rand, randInt } from '../core/util.js';
import { audio } from '../core/audio.js';

/**
 * Points, wall-buys, perks and the mystery box.
 *
 * Points come from damage as well as kills, so a weapon that chips away at a
 * brute still pays for itself. Prices are set so a careful player can afford
 * their first real weapon around wave 3 and their first perk around wave 6 —
 * fast enough to keep the loop moving, slow enough that the choice matters.
 */

export const PERKS = {
  juggernaut: {
    id: 'juggernaut', name: 'JUGGERNOG', color: '#ff4d4d',
    blurb: 'Doubles your maximum health.', cost: 2500,
  },
  sprinter: {
    id: 'sprinter', name: 'STAMIN-UP', color: '#4dff88',
    blurb: 'Move faster, sprint further.', cost: 2000,
  },
  doubletap: {
    id: 'doubletap', name: 'DOUBLE TAP', color: '#ffaa33',
    blurb: 'Fire 33% faster with every weapon.', cost: 3000,
  },
  quickhands: {
    id: 'quickhands', name: 'SPEED COLA', color: '#66aaff',
    blurb: 'Reload twice as fast.', cost: 2200,
  },
};

const fmtShort = (n) => fmt(Math.max(0, Math.round(n)));

export class Economy {
  constructor({ player, combat, level, director, effects }) {
    this.player = player;
    this.combat = combat;
    this.level = level;
    this.director = director;
    this.fx = effects;

    this.points = 500;
    this.earned = 500;
    this.spent = 0;
    this.pointsMultiplier = 1;

    this.boxUses = 0;
    this.boxLimit = randInt(4, 7);
    this.boxSpin = null;

    this.onNotice = null;        // (text, tone) => void
    this.onPickup = null;        // (station) => void — an improvised weapon taken
    this.onPurchase = null;      // (station) => void
    this.onStatsChanged = null;  // () => void — recompute perk + power-up stacking

    this.nearest = null;
    this.prompt = null;
  }

  reset() {
    this.points = 500;
    this.earned = 500;
    this.spent = 0;
    this.pointsMultiplier = 1;
    this.boxUses = 0;
    this.boxSpin = null;
    for (const s of this.level.stations) {
      s.active = s.kind !== 'box' || s.id === 'box_a';
      s.bought = false;
    }
  }

  award(amount, kind = 'damage') {
    if (amount <= 0) return;
    const gained = Math.round(amount * this.pointsMultiplier);
    this.points += gained;
    this.earned += gained;
    return gained;
  }

  canAfford(cost) { return this.points >= cost; }

  spend(cost) {
    if (this.points < cost) return false;
    this.points -= cost;
    this.spent += cost;
    return true;
  }

  // ---------------------------------------------------------- interaction

  /** Recomputes the interaction prompt for whatever station the player is at. */
  update(dt, input, canAct) {
    if (this.boxSpin) this._updateBoxSpin(dt);

    const s = canAct ? this.level.stationNear(this.player.pos, 2.8) : null;
    this.nearest = s;
    this.prompt = s ? this._promptFor(s) : null;

    if (s && canAct && input.hit('KeyE')) this.interact(s);
  }

  _promptFor(s) {
    switch (s.kind) {
      case 'wallbuy': {
        const w = WEAPONS[s.weapon];
        const owned = this.combat.has(s.weapon);
        return {
          title: w.name,
          action: owned ? 'REFILL AMMO' : 'BUY',
          cost: owned ? Math.round(s.cost * 0.45) : s.cost,
          affordable: this.points >= (owned ? Math.round(s.cost * 0.45) : s.cost),
          detail: w.tip,
        };
      }
      case 'melee': {
        const w = WEAPONS[s.weapon];
        return {
          title: w.name,
          action: 'PICK UP',
          cost: 0,
          affordable: true,
          detail: w.tip,
        };
      }
      case 'ammo':
        return {
          title: 'AMMO CRATE',
          action: 'REFILL ALL',
          cost: s.cost,
          affordable: this.points >= s.cost,
          detail: 'Tops up every weapon you are carrying, plus grenades.',
        };
      case 'perk': {
        const p = PERKS[s.perk];
        const have = this.player.hasPerk(s.perk);
        return {
          title: p.name,
          action: have ? 'ALREADY ACTIVE' : 'DRINK',
          cost: have ? 0 : p.cost,
          affordable: have ? false : this.points >= p.cost,
          detail: p.blurb,
          color: p.color,
        };
      }
      case 'pack': {
        const w = WEAPONS[this.combat.id];
        const wave = this.director?.wave ?? 0;
        if (wave < (s.minWave ?? 8)) {
          return {
            title: 'ARC FURNACE',
            action: `SEALED UNTIL WAVE ${s.minWave ?? 8}`,
            cost: 0, affordable: false,
            detail: 'Still charging. It will not take a weapon yet.',
            color: '#ff6644',
          };
        }
        if (!this.combat.canUpgrade()) {
          return {
            title: 'ARC FURNACE',
            action: w.magSize === Infinity ? 'CANNOT UPGRADE THIS' : 'ALREADY UPGRADED',
            cost: 0, affordable: false,
            detail: `${w.name} cannot go through again.`,
            color: '#ff6644',
          };
        }
        return {
          title: 'ARC FURNACE',
          action: `UPGRADE ${w.short}`,
          cost: s.cost,
          affordable: this.points >= s.cost,
          detail: 'Doubles the held weapon\u2019s damage and adds half again to its reserve.',
          color: '#ff6644',
        };
      }
      case 'box':
        return {
          title: 'MYSTERY BOX',
          action: this.boxSpin ? 'OPENING…' : 'OPEN',
          cost: s.cost,
          affordable: !this.boxSpin && this.points >= s.cost,
          detail: `A weapon at random. ${this.boxLimit - this.boxUses} left before it moves on.`,
        };
      default:
        return null;
    }
  }

  interact(s) {
    const p = this._promptFor(s);
    if (!p) return;

    // One gate for every blocked case — including the free-but-unavailable
    // ones (a perk you already have, a weapon that cannot be upgraded, the box
    // mid-spin), which would otherwise fall through and fire for nothing.
    if (!p.affordable) {
      if (p.cost > 0 && this.points < p.cost) {
        audio.click(180, 0.09, 0.3);
        this._notice(`NEED ${fmtShort(p.cost - this.points)} MORE POINTS`, 'bad');
      } else {
        audio.click(200, 0.06, 0.2);
      }
      return;
    }

    switch (s.kind) {
      case 'melee': return this._takePickup(s, p);
      case 'wallbuy': return this._buyWeapon(s, p);
      case 'ammo': return this._buyAmmo(s, p);
      case 'perk': return this._buyPerk(s, p);
      case 'pack': return this._upgradeWeapon(s, p);
      case 'box': return this._openBox(s, p);
    }
  }

  /** Free, and it goes straight into the hand. */
  _takePickup(s, p) {
    if (!this.combat.takeMelee(s.weapon)) return;
    if (this.onPickup) this.onPickup(s);
    audio.click(680, 0.05, 0.18);
    this._notice(`PICKED UP ${p.title.toUpperCase()}`, 'good');
  }

  _buyWeapon(s, p) {
    const owned = this.combat.has(s.weapon);
    this.spend(p.cost);
    if (owned) {
      this.combat.refill(s.weapon);
      this._notice(`${WEAPONS[s.weapon].short} RESUPPLIED`, 'good');
    } else {
      this.combat.give(s.weapon);
      this._notice(`${WEAPONS[s.weapon].name}`, 'good');
    }
    audio.chime([67, 72], 0.07, 0.3);
    if (this.onPurchase) this.onPurchase(s);
  }

  _buyAmmo(s, p) {
    this.spend(p.cost);
    this.combat.refillAll();
    audio.chime([64, 71, 76], 0.06, 0.3);
    this._notice('ALL WEAPONS RESUPPLIED', 'good');
  }

  _buyPerk(s, p) {
    if (this.player.hasPerk(s.perk)) return;
    this.spend(p.cost);
    this.player.addPerk(s.perk);
    this._applyPerkEffects();
    audio.chime([60, 64, 67, 72], 0.08, 0.36);
    this._notice(`${PERKS[s.perk].name} ACQUIRED`, 'perk');
    if (this.onPurchase) this.onPurchase(s);
  }

  _applyPerkEffects() {
    // Reload speed is a pure perk effect, so it can be set directly.
    this.combat.reloadMul = this.player.hasPerk('quickhands') ? 0.5 : 1;
    // Fire rate stacks with the Carnage power-up, so the game owns that sum.
    if (this.onStatsChanged) this.onStatsChanged();
  }

  _upgradeWeapon(s, p) {
    if (!this.combat.canUpgrade()) return;
    const name = WEAPONS[this.combat.id].name;
    this.spend(p.cost);
    this.combat.upgrade();
    audio.chime([48, 55, 60, 67, 72], 0.07, 0.42, 'sawtooth');
    this.fx.explosion(s.pos, 1.8, 0xff5522);
    this._notice(`${name} UPGRADED`, 'good');
    if (this.onPurchase) this.onPurchase(s);
  }

  /**
   * The box: a short spin during which the HUD cycles weapon names, then the
   * reveal. The pause is the whole point — it is the most exciting three
   * seconds in the game.
   */
  _openBox(s, p) {
    if (this.boxSpin) return;
    this.spend(p.cost);
    audio.chime([48, 55, 60], 0.1, 0.3, 'sawtooth');

    // Never hand back the weapon already in hand.
    const pool = BOX_POOL.filter((w) => w.id !== this.combat.id);
    const total = pool.reduce((a, w) => a + w.boxWeight, 0);
    let r = Math.random() * total;
    let prize = pool[0];
    for (const w of pool) { r -= w.boxWeight; if (r <= 0) { prize = w; break; } }

    this.boxSpin = {
      station: s, t: 0, duration: 3.2, prize,
      shown: pool[randInt(0, pool.length - 1)],
      tick: 0,
    };
    this.boxUses++;
  }

  _updateBoxSpin(dt) {
    const b = this.boxSpin;
    b.t += dt;

    // Names flick past quickly, then slow into the reveal.
    const progress = clamp(b.t / b.duration, 0, 1);
    const interval = 0.05 + progress * progress * 0.4;
    b.tick -= dt;
    if (b.tick <= 0) {
      b.tick = interval;
      b.shown = BOX_POOL[randInt(0, BOX_POOL.length - 1)];
      audio.click(1200 + Math.random() * 600, 0.03, 0.16);
    }

    if (b.t >= b.duration) {
      this.combat.give(b.prize.id);
      this._notice(`${b.prize.name}`, 'good');
      audio.chime([72, 79, 84], 0.08, 0.4);
      this.fx.explosion(b.station.pos, 1.5, 0xffcc44);

      // Move the box on once it has been used enough times.
      if (this.boxUses >= this.boxLimit) {
        const boxes = this.level.stations.filter((x) => x.kind === 'box');
        const others = boxes.filter((x) => x !== b.station);
        b.station.active = false;
        if (others.length) {
          const next = others[randInt(0, others.length - 1)];
          next.active = true;
          this._notice('THE BOX HAS MOVED', 'bad');
          audio.chime([55, 51, 48], 0.14, 0.3, 'sawtooth');
        }
        this.boxUses = 0;
        this.boxLimit = randInt(4, 7);
      }
      this.boxSpin = null;
    }
  }

  get boxSpinLabel() {
    return this.boxSpin ? this.boxSpin.shown.name : null;
  }

  _notice(text, tone) {
    if (this.onNotice) this.onNotice(text, tone);
  }
}
