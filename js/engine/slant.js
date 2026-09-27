// Gokigen Naname / 五寸钉 engine. Every cell carries one diagonal; the number on a node says
// how many of the lines around it end there. That is the whole game, and it makes the node count
// the only fact worth reasoning about — so the solver is arc consistency over one sum constraint
// per clued node, and the acceptance test is that same sum read straight off the board.
//
// `solve()` below is the pencil path: it is the player's route, the generator's acceptance test
// and the source of every hint, so it never backtracks. Search lives only in count.js, and the
// generator trusts neither.

// A cell's own states, and a *separate* sentinel for "this node carries no number". They cannot
// share one constant: 0 is a real clue here — it says "no line ends here" — so treating it as
// "absent" would silently delete every zero from a board.
export const OPEN = 0;
// Screen coordinates, y growing downward: the glyph "/" runs from the cell's bottom-left corner
// up to its top-right, and "\" runs top-left to bottom-right. Every rule, every clue and the
// renderer all read this one pair of sentences.
export const SLASH = 1; // "/"  — reaches this cell's bottom-left and top-right nodes
export const BACK = 2; //  "\" — reaches this cell's top-left and bottom-right nodes
export const NO_CLUE = -1;

export const other = (v) => (v === SLASH ? BACK : SLASH);

// The four cells around node (r, c), each with the diagonal value that would end a line here.
// A cell's "/" reaches its top-left and bottom-right corners; "\" reaches the other two.
export function nodeAt(w, h, r, c) {
  const out = [];
  if (r > 0 && c > 0) out.push([(r - 1) * w + (c - 1), BACK]);
  if (r > 0 && c < w) out.push([(r - 1) * w + c, SLASH]);
  if (r < h && c > 0) out.push([r * w + (c - 1), SLASH]);
  if (r < h && c < w) out.push([r * w + c, BACK]);
  return out;
}

export function createBoard({ w, h, clue }) {
  if (!(w > 0 && h > 0)) throw new Error('board too small');
  const nw = w + 1;
  const nh = h + 1;
  if (clue.length !== nw * nh) throw new Error('clue length mismatch');
  const nodes = [];
  for (let r = 0; r < nh; r++) for (let c = 0; c < nw; c++) nodes.push(nodeAt(w, h, r, c));
  for (let i = 0; i < nodes.length; i++) {
    const v = clue[i];
    if (v === NO_CLUE) continue;
    if (v < 0 || v > nodes[i].length) {
      throw new Error(`节点(${(i / nw) | 0},${i % nw}) 写着 ${v}，但它周围只有 ${nodes[i].length} 格`);
    }
  }
  // which nodes each cell's two possible diagonals would reach, kept for the UI's feedback
  const cellNodes = Array.from({ length: w * h }, () => []);
  for (let i = 0; i < nodes.length; i++) for (const [cell] of nodes[i]) cellNodes[cell].push(i);
  let clues = 0;
  for (let i = 0; i < clue.length; i++) if (clue[i] !== NO_CLUE) clues++;
  if (!clues) throw new Error('盘上没有数字');
  return {
    w,
    h,
    n: w * h,
    nw,
    nh,
    clue: Int8Array.from(clue),
    nodes,
    cellNodes,
    clues,
    cells: Array.from({ length: w * h }, (_, i) => i),
    nodeName: (i) => `第${((i / nw) | 0) + 1}行${(i % nw) + 1}列`,
    cellName: (t) => `第${((t / w) | 0) + 1}行${(t % w) + 1}列`,
  };
}

// The numbers a solution implies. Used by the generator, and by nothing that judges a board —
// verify() reads the clues, never this.
export function cluesFrom(w, h, solution) {
  const out = new Int8Array((w + 1) * (h + 1));
  out.fill(NO_CLUE);
  for (let r = 0; r <= h; r++) for (let c = 0; c <= w; c++) {
    let k = 0;
    for (const [cell, want] of nodeAt(w, h, r, c)) if (solution[cell] === want) k++;
    out[r * (w + 1) + c] = k;
  }
  return out;
}

export const Rules = {
  zero: {
    name: '无钉节点',
    weight: 1,
    text: (b, d) => `${b.nodeName(d.node)} 写着 0：它四周的线都不能收在这里`,
  },
  full: {
    name: '四面归一',
    weight: 1,
    text: (b, d) => `${b.nodeName(d.node)} 写着 ${b.clue[d.node]}，四周每一格都得把线收到这里`,
  },
  need: {
    name: '只差这些',
    weight: 1.5,
    text: (b, d) => `${b.nodeName(d.node)} 还差 ${d.need} 条线，而它只剩 ${d.open} 格可放——那 ${d.open} 格都必须收在这里`,
  },
  done: {
    name: '已经够了',
    weight: 1.5,
    text: (b, d) => `${b.nodeName(d.node)} 的 ${b.clue[d.node]} 条线已经凑满，其余格子都不能再收在这里`,
  },
};

// One sweep: every clued node whose count already decides something. Each write below is a
// consequence of that node's number, so it holds in every solution of the board.
export function propagate(board, derived) {
  const found = [];
  let changed = false;
  for (let i = 0; i < board.nodes.length; i++) {
    const want = board.clue[i];
    if (want === NO_CLUE) continue;
    const list = board.nodes[i];
    let have = 0;
    const open = [];
    for (const [cell, value] of list) {
      if (derived[cell] !== OPEN) {
        if (derived[cell] === value) have++;
      } else open.push([cell, value]);
    }
    const need = want - have;
    if (need < 0 || need > open.length) {
      return { found: [], changed: false, conflict: `${board.nodeName(i)} 写着 ${want}，可它周围的线已经对不上了`, node: i };
    }
    let rule = null;
    if (need === 0 && open.length) rule = want === 0 ? Rules.zero : Rules.done;
    else if (need === open.length && open.length) rule = want === list.length ? Rules.full : Rules.need;
    if (!rule) continue;
    for (const [cell, value] of open) {
      const to = rule === Rules.full || rule === Rules.need ? value : other(value);
      if (derived[cell] === to) continue;
      derived[cell] = to;
      found.push({ cell, value: to, rule, node: i, need, open: open.length });
      changed = true;
    }
  }
  return { found, changed };
}

// The pencil path from an empty board to a finished one. Returns the deductions in the order the
// clues forced them — that list *is* the hint script, and it never reads the player's ink, so a
// wrong diagonal cannot make the hints agree with the mistake.
export function solve(board) {
  const derived = new Int8Array(board.n);
  const rows = [];
  const used = new Map();
  let guard = 0;
  for (;;) {
    const sweep = propagate(board, derived);
    if (sweep.conflict) return { ok: false, conflict: sweep.conflict, rows, steps: rows.length, score: 0, breakdown: {} };
    if (!sweep.changed) break;
    for (const f of sweep.found) {
      const key = f.rule.name;
      const cur = used.get(key) || { n: 0, weight: f.rule.weight };
      cur.n++;
      used.set(key, cur);
      rows.push({ cell: f.cell, value: f.value, rule: f.rule, node: f.node });
    }
    if (++guard > 400) return { ok: false, conflict: '推导没有收敛（引擎缺陷）', rows, steps: rows.length, score: 0, breakdown: {} };
  }
  const filled = derived.every((v) => v !== OPEN);
  let score = 0;
  for (const x of used.values()) score += x.n * x.weight;
  return {
    ok: filled,
    derived,
    rows,
    steps: rows.length,
    score: Math.round(score * 10) / 10,
    breakdown: Object.fromEntries([...used].map(([k, v]) => [k, v.n])),
  };
}

// The next thing the clues force that the player has not drawn yet.
export function nextDeduction(board, derived) {
  const sweep = propagate(board, derived);
  if (sweep.conflict) return { conflict: sweep.conflict };
  return sweep.found[0] || null;
}

// ---- is this ink still survivable? --------------------------------------------

// Every write the node rules make is true in *every* solution, so if seeding the player's own
// lines and then running those rules hits a contradiction, no completion of this board exists.
// That is the one thing a player cannot see coming — a single wrong diagonal leaves every number
// still numerically reachable — and it is worth saying out loud.
export function reachable(board, cell) {
  const derived = Int8Array.from(cell);
  for (let round = 0; round < board.n + 4; round++) {
    const sweep = propagate(board, derived);
    if (sweep.conflict) return false;
    if (!sweep.changed) break;
  }
  return true;
}

// ---- readouts for the UI -----------------------------------------------------

// Judged straight from the rules of the game: a clued node must have exactly that many line ends,
// and every cell must carry a diagonal. Nothing here reads `derived` or the hint script, so a bug
// in the propagation cannot fake a win.
export function verify(board, cell) {
  const bad = [];
  for (let t = 0; t < board.n; t++) if (cell[t] === OPEN) bad.push({ why: '空格', cell: t });
  for (let i = 0; i < board.nodes.length; i++) {
    const want = board.clue[i];
    if (want === NO_CLUE) continue;
    let have = 0;
    let open = 0;
    for (const [c, value] of board.nodes[i]) {
      if (cell[c] === OPEN) open++;
      else if (cell[c] === value) have++;
    }
    if (have > want) bad.push({ why: '线多了', node: i, want, have });
    else if (have + open < want) bad.push({ why: '线不够', node: i, want, have, open });
  }
  return bad;
}

export function complete(board, cell) {
  return verify(board, cell).length === 0 && cell.every((v) => v !== OPEN);
}

export function diagnose(board, cell) {
  let filled = 0;
  for (let t = 0; t < board.n; t++) if (cell[t] !== OPEN) filled++;
  const violated = new Set();
  const satisfied = new Set();
  for (let i = 0; i < board.nodes.length; i++) {
    const want = board.clue[i];
    if (want === NO_CLUE) continue;
    let have = 0;
    let open = 0;
    for (const [c, value] of board.nodes[i]) {
      if (cell[c] === OPEN) open++;
      else if (cell[c] === value) have++;
    }
    if (have > want || have + open < want) violated.add(i);
    else if (have === want && open === 0) satisfied.add(i);
  }
  return {
    filled,
    total: board.n,
    remaining: board.n - filled,
    clues: board.clues,
    violated,
    satisfied,
    conflicts: violated.size,
  };
}

// ---- the player's own ink ----------------------------------------------------

export function createState(board) {
  return { board, cell: new Int8Array(board.n), history: [] };
}

export function snapshot(st) {
  st.history.push(Int8Array.from(st.cell));
  if (st.history.length > 500) st.history.shift();
  return st;
}

export function undo(st) {
  const last = st.history.pop();
  if (!last) return false;
  st.cell.set(last);
  return true;
}

export function setCell(st, t, value) {
  if (t < 0 || t >= st.board.n) return false;
  if (st.cell[t] === value) return false;
  snapshot(st);
  st.cell[t] = value;
  return true;
}

export function eraseCell(st, t) {
  return setCell(st, t, OPEN);
}

export function resetInk(st) {
  st.cell.fill(OPEN);
  st.history.length = 0;
  return st;
}
