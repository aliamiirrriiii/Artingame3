/**
 * Zombie archetypes.
 *
 * `budget` is what one costs the wave director, which is how the mix is
 * balanced: a brute eats the same slice of a wave as six walkers, so late waves
 * get scarier without simply getting more numerous.
 */
export const ARCHETYPES = {
  walker: {
    id: 'walker', name: 'Walker',
    health: 130, healthScale: 1.0,
    speed: [1.25, 1.75], sprintSpeed: 0,
    damage: 19, attackRange: 1.55, attackWindup: 0.42, attackCooldown: 1.15,
    scale: [0.94, 1.06], heightM: 1.82,
    mass: 1.0, staggerResist: 0.0, points: 60,
    tint: [0x59634a, 0x646a52, 0x4e5a44],
    budget: 1, minWave: 1,
    gore: 1.0, clip: 'Walk', clipSpeed: 0.72,
  },

  runner: {
    id: 'runner', name: 'Runner',
    health: 95, healthScale: 1.0,
    speed: [3.5, 4.35], sprintSpeed: 0,
    damage: 17, attackRange: 1.5, attackWindup: 0.26, attackCooldown: 0.8,
    scale: [0.92, 1.0], heightM: 1.78,
    mass: 0.85, staggerResist: 0.1, points: 85,
    tint: [0x6a5843, 0x71604c, 0x5c5242],
    budget: 1.6, minWave: 3,
    gore: 1.0, clip: 'Run', clipSpeed: 0.92,
  },

  crawler: {
    id: 'crawler', name: 'Crawler',
    health: 70, healthScale: 1.0,
    speed: [2.4, 3.1], sprintSpeed: 0,
    damage: 14, attackRange: 1.35, attackWindup: 0.3, attackCooldown: 0.75,
    scale: [0.62, 0.72], heightM: 1.15,
    mass: 0.5, staggerResist: 0.0, points: 70,
    tint: [0x4c5642, 0x545540],
    budget: 1.2, minWave: 5,
    gore: 0.8, clip: 'Run', clipSpeed: 1.15,
    hunch: 0.85,
  },

  brute: {
    id: 'brute', name: 'Brute',
    health: 820, healthScale: 1.0,
    speed: [1.5, 1.9], sprintSpeed: 4.6,
    damage: 42, attackRange: 2.3, attackWindup: 0.62, attackCooldown: 1.8,
    scale: [1.32, 1.46], heightM: 2.5,
    mass: 4.0, staggerResist: 0.85, points: 320,
    tint: [0x66493a, 0x5c4535],
    budget: 6, minWave: 6,
    gore: 2.2, clip: 'Walk', clipSpeed: 0.62,
    charges: true,
  },

  spitter: {
    id: 'spitter', name: 'Spitter',
    health: 175, healthScale: 1.0,
    speed: [1.1, 1.5], sprintSpeed: 0,
    damage: 16, attackRange: 1.5, attackWindup: 0.4, attackCooldown: 1.2,
    scale: [0.95, 1.05], heightM: 1.8,
    mass: 1.0, staggerResist: 0.0, points: 150,
    tint: [0x4a6644, 0x3f5c41],
    budget: 3, minWave: 8,
    gore: 1.1, clip: 'Walk', clipSpeed: 0.66,
    ranged: { range: 22, minRange: 5, cooldown: 3.4, damage: 26, speed: 20, radius: 2.2 },
  },

  screamer: {
    id: 'screamer', name: 'Screamer',
    health: 135, healthScale: 1.0,
    speed: [1.9, 2.4], sprintSpeed: 0,
    damage: 12, attackRange: 1.5, attackWindup: 0.35, attackCooldown: 1.0,
    scale: [0.9, 1.0], heightM: 1.76,
    mass: 0.9, staggerResist: 0.0, points: 200,
    tint: [0x71485a, 0x664250],
    budget: 3.5, minWave: 10,
    gore: 1.0, clip: 'Walk', clipSpeed: 0.85,
    scream: { interval: 7, radius: 26, speedBoost: 1.45, duration: 6 },
  },

  abomination: {
    id: 'abomination', name: 'ABOMINATION',
    health: 5200, healthScale: 1.0,
    speed: [1.9, 2.2], sprintSpeed: 6.0,
    damage: 45, attackRange: 3.1, attackWindup: 0.7, attackCooldown: 2.1,
    scale: [2.05, 2.2], heightM: 3.8,
    mass: 14, staggerResist: 1.0, points: 2500,
    tint: [0x743c2e],
    budget: 40, minWave: 5,
    gore: 4.0, clip: 'Walk', clipSpeed: 0.55,
    boss: true, charges: true,
    spawnsAdds: { every: 9, count: 3, type: 'runner' },
  },
};

export const ARCHETYPE_LIST = Object.values(ARCHETYPES);
