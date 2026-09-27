// Generator. Solution first: pick a diagonal for every cell, and the number of lines ending at
// each node *is* the clue — so a board cannot be born unsolvable, which is the opposite of
// guessing a clue set and hoping. Difficulty then comes from the one knob the game actually has:
// how many of those numbers get removed. A removal is kept only if the pencil path still
// finishes the board, so "unique" and "no guessing" are the same test here, and the exhaustive
// counter in count.js exists to check that the two have not drifted apart.

import { NO_CLUE, SLASH, BACK, createBoard, cluesFrom, solve } from './slant.js';

function mix(seed) {
  let x = typeof seed === 'string' ? 2166136261 : seed >>> 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      x ^= seed.charCodeAt(i);
      x = Math.imul(x, 16777619) >>> 0;
    }
  }
  x = x || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

export function randomSolution(w, h, rand) {
  const out = new Int8Array(w * h);
  for (let t = 0; t < out.length; t++) out[t] = rand() < 0.5 ? SLASH : BACK;
  return out;
}

// Greedy removal down to `target` clues. Order is shuffled, so which numbers survive is a
// property of the seed, not of the scan direction.
export function pruneClues(board, rand, target) {
  const clue = Int8Array.from(board.clue);
  const nodes = board.clue.length;
  const order = [];
  for (let i = 0; i < nodes; i++) order.push(i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let kept = board.clues;
  for (const i of order) {
    if (kept <= target) break;
    const before = clue[i];
    if (before === NO_CLUE) continue;
    clue[i] = NO_CLUE;
    kept--;
    const probe = createBoard({ w: board.w, h: board.h, clue });
    if (!solve(probe).ok) {
      clue[i] = before;
      kept++;
    }
  }
  return clue;
}

export function generate(opts = {}) {
  const { w = 6, h = 6, seed = 'plain', keepRatio = 0.4, band = null, tries = 40, report = () => {} } = opts;
  const target = Math.max(1, Math.round((w + 1) * (h + 1) * keepRatio));
  let best = null;
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    const rand = mix(trial);
    const solution = randomSolution(w, h, rand);
    let board;
    let clue;
    try {
      board = createBoard({ w, h, clue: cluesFrom(w, h, solution) });
      clue = pruneClues(board, rand, target);
      board = createBoard({ w, h, clue });
    } catch {
      continue;
    }
    const p = solve(board);
    if (!p.ok) continue;
    const offBand = band ? Math.abs(p.score - clamp(p.score, band[0], band[1])) : 0;
    const cand = {
      board,
      solution,
      seed: trial,
      score: p.score,
      steps: p.steps,
      breakdown: p.breakdown,
      clues: board.clues,
      offBand,
      gen: k + 1,
    };
    if (!best || cand.offBand < best.offBand) best = cand;
    report({ k, score: p.score, clues: board.clues, offBand });
    if (band && cand.offBand === 0) break;
  }
  if (!best) return { ok: false, board: null, reason: '没找到既唯一又能纯逻辑推到底的盘面' };
  return { ok: true, ...best };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// The bands below are selection targets, and every number in them is measured — see
// tools/balance.mjs, which prints the spread per tier and fails the build when the ladder stops
// ordering. The 2026-09-27 probe (30 boards per tier, `tries: 1`, no selection at all) shipped
// 150/150 boards that the independent counter called unique and the pencil path finished, with
// medians 33.5 / 49 / 67 / 87 / 138 and a spread of about ±3 around each. So the ladder is
// (board size × how many numbers survive), and the bands are drawn around those medians.
export const TIERS = [
  { key: 'trainee', name: '初学', w: 5, h: 5, keepRatio: 0.62, band: [30, 37] },
  { key: 'apprentice', name: '上手', w: 6, h: 6, keepRatio: 0.5, band: [44, 54] },
  { key: 'regular', name: '熟练', w: 7, h: 7, keepRatio: 0.44, band: [62, 73] },
  { key: 'expert', name: '高阶', w: 8, h: 8, keepRatio: 0.42, band: [81, 95] },
  { key: 'master', name: '大师', w: 10, h: 10, keepRatio: 0.4, band: [128, 148] },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[1];
}

export function makePuzzle(seed, tierKey) {
  const tier = tierFor(tierKey);
  const r = generate({ ...tier, seed });
  if (!r.ok) return null;
  return {
    ...r,
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: `${tier.w}×${tier.h}`,
    w: tier.w,
    h: tier.h,
  };
}

export { NO_CLUE };
