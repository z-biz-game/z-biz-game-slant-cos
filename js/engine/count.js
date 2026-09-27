// An exhaustive counter. It shares no geometry helper, no rule and no state with slant.js: the
// node table is rebuilt here from the rules of the game, because the point of the second opinion
// is that a mistake in the first one cannot show up in both.
//
// It answers one question — how many completions does this clue set have? — and stops at `cap`,
// spending its node budget rather than lying about a board it could not finish counting.

import { OPEN, NO_CLUE, SLASH, BACK } from './slant.js';

function nodeAt(w, h, r, c) {
  const out = [];
  if (r > 0 && c > 0) out.push([(r - 1) * w + (c - 1), BACK]);
  if (r > 0 && c < w) out.push([(r - 1) * w + c, SLASH]);
  if (r < h && c > 0) out.push([r * w + (c - 1), SLASH]);
  if (r < h && c < w) out.push([r * w + c, BACK]);
  return out;
}

export const UNIQUE = 'UNIQUE';
export const MANY = 'MANY';
export const NONE = 'NONE';
export const OVERBUDGET = 'OVERBUDGET';

// Cells are decided in scan order, so a node's count is checked the moment its last cell lands:
// that is what keeps the search off the 2^(w*h) floor.
export function countSolutions(board, { cap = 2, budget = 400000 } = {}) {
  const { w, h, clue } = board;
  const n = w * h;
  const nodes = [];
  for (let r = 0; r <= h; r++) for (let c = 0; c <= w; c++) nodes.push(nodeAt(w, h, r, c));
  const touchedBy = [];
  for (let t = 0; t < n; t++) {
    const x = t % w;
    const y = (t / w) | 0;
    const list = [];
    for (const [nr, nc] of [[y, x], [y, x + 1], [y + 1, x], [y + 1, x + 1]]) {
      const i = nr * (w + 1) + nc;
      if (i >= 0 && i < nodes.length) list.push(i);
    }
    touchedBy.push(list);
  }
  const assign = new Int8Array(n);
  const left = nodes.map((l) => l.length);
  let nodesVisited = 0;
  let solutions = 0;
  let first = null;
  let over = false;

  function go(t) {
    if (nodesVisited++ > budget) {
      over = true;
      return true;
    }
    if (t === n) {
      solutions++;
      if (!first) first = Int8Array.from(assign);
      return solutions >= cap;
    }
    for (const v of [SLASH, BACK]) {
      assign[t] = v;
      let bad = false;
      for (const i of touchedBy[t]) {
        left[i]--;
        if (left[i] === 0 && clue[i] !== NO_CLUE) {
          let k = 0;
          for (const [cell, want] of nodes[i]) if (assign[cell] === want) k++;
          if (k !== clue[i]) bad = true;
        }
      }
      if (!bad && go(t + 1)) {
        for (const i of touchedBy[t]) left[i]++;
        assign[t] = OPEN;
        return true;
      }
      for (const i of touchedBy[t]) left[i]++;
      assign[t] = OPEN;
    }
    return false;
  }
  go(0);
  if (over) return { status: OVERBUDGET, solutions, nodes: nodesVisited, first: null };
  return {
    status: solutions >= cap ? MANY : solutions === 1 ? UNIQUE : NONE,
    solutions,
    nodes: nodesVisited,
    first,
  };
}
