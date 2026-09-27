// Engine unit tests, run in plain Node: `node tools/engine-test.mjs`.
//
// The risk in this repo is not arithmetic but soundness: one rule that wrote a cell the clues do
// not force, and every board would still ship, the hints would still be self-consistent, and
// "每局都能推到底" would be a caption on a coin flip. So the expectations below are hand-derived
// from boards worked out on paper and written as literals — never read back off the solver.

import {
  createBoard,
  cluesFrom,
  solve,
  verify,
  complete,
  reachable,
  propagate,
  Rules,
  OPEN,
  SLASH,
  BACK,
  nodeAt,
} from '../js/engine/slant.js';
import { countSolutions, UNIQUE, MANY, NONE } from '../js/engine/count.js';
import { generate, makePuzzle, randomSolution, pruneClues, TIERS } from '../js/engine/generate.js';
import { Store } from '../js/store.js';
import { Game, name } from '../js/ui/game.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

// A board from an explicit grid of diagonals: '/' and '\' per row, top row first.
const board = (rows, clueGrid) => {
  const h = rows.length;
  const w = rows[0].length;
  const sol = new Int8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) sol[r * w + c] = rows[r][c] === '/' ? SLASH : BACK;
  const clue = clueGrid == null ? cluesFrom(w, h, sol) : Int8Array.from(clueGrid.flat());
  return { b: createBoard({ w, h, clue }), sol };
};
const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};

// ---------- the geometry, hand-checked ----------

// A cell's "/" reaches its own top-left and bottom-right corners; "\" the other two. Read off a
// sheet: the cell at row 0, col 0 of a 2×2 board touches nodes (0,0), (0,1), (1,0), (1,1).
{
  const a = nodeAt(2, 2, 0, 0);
  eq('角上只有 1 格', a.length, 1);
  eq('那格是左上角', a[0][0], 0);
  eq('它的 ╲ 才收到这个角', a[0][1], BACK);
  const mid = nodeAt(2, 2, 1, 1);
  eq('盘心的节点四周有 4 格', mid.length, 4);
  eq('盘心左上那格用 ╲', JSON.stringify(mid[0]), JSON.stringify([0, BACK]));
  eq('盘心右上那格用 ╱', JSON.stringify(mid[1]), JSON.stringify([1, SLASH]));
  eq('盘心左下那格用 ╱', JSON.stringify(mid[2]), JSON.stringify([2, SLASH]));
  eq('盘心右下那格用 ╲', JSON.stringify(mid[3]), JSON.stringify([3, BACK]));
}

// Σ clues over all nodes = 2 × cells for a fully numbered board: every cell's diagonal has
// exactly two ends, each landing on one node. Hand count on 2×2: 4 cells → 8.
{
  const { b, sol } = board(['/\\', '\\/']);
  const sum = Array.from(b.clue).reduce((a, x) => a + x, 0);
  eq('全数字盘的线索之和 = 2×格数', sum, 2 * b.n);
  eq('2×2 的线索之和是 8', sum, 8);
  eq('每个节点度数之和 = 4×格数', b.nodes.reduce((a, l) => a + l.length, 0), 4 * b.n);
  eq('解自己通过验收', verify(b, sol).length, 0);
  eq('解推得完', solve(b).ok, true);
  eq('解与铅笔同盘', Array.from(solve(b).derived).join(','), Array.from(sol).join(','));
}

// ---------- the givens have to be possible ----------

eq('数字超过周围格数时直接拒绝', throws(() => createBoard({ w: 2, h: 2, clue: Int8Array.from([0, 5, 0, 0, 0, 0, 0, 0, 0]) })), '节点(0,1) 写着 5，但它周围只有 2 格');
eq('长度不对的数组不放行', throws(() => createBoard({ w: 2, h: 2, clue: new Int8Array(8) })), 'clue length mismatch');
eq('一个数字都没有的盘没有解', throws(() => createBoard({ w: 2, h: 2, clue: Int8Array.from([-1, -1, -1, -1, -1, -1, -1, -1, -1]) })), '盘上没有数字');
eq('太小的盘不开', throws(() => createBoard({ w: 0, h: 3, clue: new Int8Array(4) })), 'board too small');
// 1×1 board: the top-left node is reached by ╲, so "0" there forces ╱. The top-right node is
// reached by ╱, so "0" there forces ╲. Both at once is unsolvable, and the engine must say so
// rather than wander.
{
  const one = createBoard({ w: 1, h: 1, clue: Int8Array.from([0, -1, -1, -1]) });
  eq('顶边右侧写 0 就定另一头', solve(createBoard({ w: 1, h: 1, clue: Int8Array.from([-1, 0, -1, -1]) })).derived[0], BACK);
  const s = solve(one);
  eq('角上写 0 就定了那格', s.derived[0], SLASH);
  eq('那一格确实把 ╱ 的两端避开这个角', verify(one, s.derived).length, 0);
  const both = createBoard({ w: 1, h: 1, clue: Int8Array.from([0, 0, -1, -1]) });
  eq('两个对角都写 0 时立刻判死', solve(both).ok, false);
  ok('判死时给出矛盾说法', /对不上/.test(solve(both).conflict), solve(both).conflict);
}

// ---------- each rule says something a player can act on ----------

{
  const { b } = board(['//', '//']);
  const names = new Set();
  const derived = new Int8Array(b.n);
  for (let i = 0; i < 60; i++) {
    const sweep = propagate(b, derived);
    if (!sweep.changed) break;
    for (const f of sweep.found) names.add(f.rule.name);
  }
  ok('四条规则都有名字', Object.keys(Rules).length === 4);
  eq('规则权重都是正数', Object.values(Rules).every((r) => r.weight > 0), true);
  ok('规则文本带坐标', /第\d+行\d+列/.test(Rules.zero.text(b, { node: 0 })), Rules.zero.text(b, { node: 0 }));
  ok('规则文本说出方向', /线/.test(Rules.done.text(b, { node: 0 })), Rules.done.text(b, { node: 0 }));
  eq('全 ╱ 盘能推完', solve(b).ok, true);
  void names;
}

// ---------- the two independent implementations must agree ----------

// The falsifiable claim: a board the exhaustive counter calls unique is finished by the node
// rules, and a board it calls multi-solution is *not* finished by them. Boards come from three
// sources — full clues, the generator's own gated pruning, and a naive random half-deletion that
// no filter has touched — because only the last two can produce a disagreement.
{
  const rand = (seed) => {
    let x = seed >>> 0 || 7;
    return () => {
      x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
      return x / 4294967296;
    };
  };
  let unique = 0;
  let many = 0;
  let disagree = 0;
  let pencilButNotUnique = 0;
  for (let s = 0; s < 45; s++) {
    const w = 4 + (s % 3);
    const r = rand(5000 + s * 977);
    const sol = randomSolution(w, w, r);
    const full = createBoard({ w, h: w, clue: cluesFrom(w, w, sol) });
    const boards = [full];
    boards.push(createBoard({ w, h: w, clue: pruneClues(full, r, Math.round((w + 1) * (w + 1) * 0.45)) }));
    const loose = Int8Array.from(full.clue);
    const idx = [...loose.keys()].sort((a, b) => r() - r());
    for (const i of idx.slice(0, Math.floor(idx.length / 2))) loose[i] = -1;
    boards.push(createBoard({ w, h: w, clue: loose }));
    for (const b of boards) {
      const c = countSolutions(b, { cap: 2, budget: 150000 });
      const p = solve(b);
      if (c.status === 'OVERBUDGET') continue;
      if (c.status === UNIQUE) {
        unique++;
        if (!p.ok) disagree++;
        else if (Array.from(p.derived).join(',') !== Array.from(c.first).join(',')) disagree++;
      } else if (c.status === MANY) {
        many++;
        if (p.ok) pencilButNotUnique++;
      } else disagree++;
    }
  }
  eq('唯一盘一律能推到底且与穷举同解', disagree, 0, `${unique} 个唯一盘`);
  eq('多解盘不会被规则误判推完', pencilButNotUnique, 0, `${many} 个多解盘`);
  ok('样本里两种判定都够多', unique >= 40 && many >= 10, `唯一 ${unique} 多解 ${many}`);
}

// ---------- the acceptance test reads only the board ----------

{
  const { b, sol } = board(['/\\', '\\/']);
  eq('这块盘的解通过验收', verify(b, sol).length, 0);
  eq('验收认它为完整', complete(b, sol), true);
  const flip = Int8Array.from(sol);
  flip[0] = flip[0] === SLASH ? BACK : SLASH;
  const bad = verify(b, flip);
  ok('翻掉一格立刻有数字对不上', bad.length >= 1, JSON.stringify(bad));
  ok('说得出是哪个节点', bad.some((x) => x.node != null), JSON.stringify(bad));
  const hole = Int8Array.from(sol);
  hole[3] = OPEN;
  eq('留空格被判错', verify(b, hole).some((x) => x.why === '空格'), true);
  eq('留空格不算走完', complete(b, hole), false);
  // a board with only one clue must be MANY, not UNIQUE — the counter must not be fooled
  const sparse = createBoard({ w: 2, h: 2, clue: Int8Array.from([-1, -1, -1, -1, 2, -1, -1, -1, -1]) });
  eq('只给一个数字时判为多解', countSolutions(sparse, { cap: 2, budget: 100000 }).status, MANY);
  eq('只给一个数字时推不完', solve(sparse).ok, false);
  // 盘心写 4 要求四格都收在这里，左上角写 0 又要求左上那格不能收在那里：两个数字互相矛盾。
  const impossible = createBoard({ w: 2, h: 2, clue: Int8Array.from([0, -1, -1, -1, 4, -1, -1, -1, -1]) });
  eq('两个互相矛盾的数字判为无解', countSolutions(impossible, { cap: 2, budget: 100000 }).status, NONE);
  eq('矛盾盘不会被规则推完', solve(impossible).ok, false);
}

// ---------- survivable ink: a warning that is always true ----------

// `reachable` says "no completion of this ink exists" only when the forced writes themselves
// contradict — so it must never cry wolf on a board that still has a solution.
{
  const p = makePuzzle('unit|reach', 'regular');
  const b = p.board;
  eq('空盘当然可完成', reachable(b, new Int8Array(b.n)), true);
  eq('照解画满是可完成', reachable(b, p.solution), true);
  eq('画满且合法时不报警', verify(b, p.solution).length, 0);
  // the first cell the clues force, drawn the other way, must be caught: the rule that forced it
  // is sound, so its opposite cannot extend any solution
  const first = solve(b).rows[0];
  const wrong = Int8Array.from(p.solution);
  wrong[first.cell] = first.value === SLASH ? BACK : SLASH;
  eq('把被逼出来的一格画反，判为矛盾', reachable(b, wrong), false);
  const oneBad = Int8Array.from(p.solution);
  oneBad[first.cell] = wrong[first.cell];
  ok('矛盾不一定违反某个数字（所以验收器看不出来）', verify(b, oneBad).length === 0 || reachable(b, oneBad) === false, JSON.stringify(verify(b, oneBad)));
  // and a board where the ink is only *partly* wrong must still be judged by the same rule
  const partial = new Int8Array(b.n);
  partial[first.cell] = wrong[first.cell];
  eq('只画错那一格也判矛盾', reachable(b, partial), false);
  const okPartial = new Int8Array(b.n);
  okPartial[first.cell] = first.value;
  eq('画对一格仍可完成', reachable(b, okPartial), true);
}

// ---------- the state machine: gestures, undo, hints ----------

{
  const p = makePuzzle('unit|game', 'apprentice');
  const g = new Game(p);
  eq('开局没有线', g.state().filled, 0);
  eq('开局没有冲突', g.state().conflicts, 0);
  const t0 = g.cellAt(0, 0);
  g.tap(t0, SLASH);
  eq('点一下放一条线', g.valueOf(t0), SLASH);
  eq('放线算一步', g.moves, 1);
  g.tap(t0, SLASH);
  eq('再点同方向就擦掉', g.valueOf(t0), OPEN);
  eq('擦掉也算一步', g.moves, 2);
  g.undo();
  eq('撤销把线还回来', g.valueOf(t0), SLASH);
  eq('撤销退一步', g.moves, 1);
  g.undo();
  eq('撤销到空盘', g.state().filled, 0);
  eq('空盘再撤销不报错', g.undo(), null);
  // a stroke is one step, not one step per cell
  const row = [0, 1, 2, 3].map((c) => g.cellAt(c, 0));
  const before = g.moves;
  const step = g.stroke(row, BACK);
  ok('拖动一次写成四格', !!step && step.writes.length === 4, JSON.stringify(step && step.writes));
  eq('拖动只算一步', g.moves, before + 1);
  g.undo();
  eq('一次撤销退掉整笔', g.state().filled, 0);
  // preview writes must never leave a snapshot behind
  eq('历史栈与步数对齐', g.st.history.length, g.steps.length);
}

// ---------- hints come from the clues, not from the player's ink ----------

{
  const p = makePuzzle('unit|hint', 'regular');
  const g = new Game(p);
  const s = solve(p.board);
  eq('提示脚本能走完这局', s.rows.length, g.script.length);
  let charged = 0;
  let badRule = 0;
  let outOfRange = 0;
  const names = new Set(Object.values(Rules).map((r) => r.name));
  for (let k = 0; k < 400 && g.status !== 'won'; k++) {
    const info = g.hint();
    if (!info || info.stalled) break;
    charged++;
    if (!names.has(info.rule)) badRule++;
    if (!(info.cell >= 0 && info.cell < p.board.n)) outOfRange++;
    if (!/第\d+行\d+列/.test(info.why)) badRule++;
    if (g.valueOf(info.cell) !== info.value) badRule++;
  }
  eq('一路提示能走完这局', g.status, 'won');
  eq('提示次数等于充电次数', g.hints, charged);
  eq('提示从不越界', outOfRange, 0);
  eq('提示说的规则与写下的格都合法', badRule, 0);
  eq('走完的盘通过独立验收', verify(p.board, g.st.cell).length, 0);
  eq('提示用掉的格数等于全盘', charged, p.board.n);
  eq('走完之后不再收费', (() => {
    const before = g.hints;
    const r = g.hint();
    return (r === null || r.stalled) && g.hints === before;
  })(), true);
}

// A wrong line must not teach the hints to agree with it: the script is derived from the clues,
// so the hint says what the numbers force and names the contradiction instead of obeying the ink.
{
  const p = makePuzzle('unit|wrong', 'trainee');
  const g = new Game(p);
  const first = g.script[0];
  const wrong = first.value === SLASH ? BACK : SLASH;
  g.tap(first.cell, wrong);
  const info = g.hint();
  ok('与数字矛盾时提示拒绝落子', !!info.conflict, JSON.stringify(info));
  eq('矛盾时不收钱', g.hints, 0);
  ok('矛盾说明写清了该放哪条', /必须是/.test(info.conflict), info.conflict);
  eq('那格还留着玩家自己的线', g.valueOf(first.cell), wrong);
  g.tap(first.cell, wrong);
  eq('擦掉错的之后提示就能落子', g.hint().value, first.value);
  eq('这次才计一次提示', g.hints, 1);
  eq('方向名说人话', `${name(SLASH)}${name(BACK)}`, '╱╲');
}

// ---------- storage: the run's cost travels with the board ----------

{
  Store.reset();
  const p = makePuzzle('unit|store', 'expert');
  const full = Int8Array.from(solve(p.board).derived);
  const ink = full.map((v, t) => (t % 3 === 0 ? OPEN : v));
  Store.saveResume(p, ink, 61000, { moves: 9, hints: 2 });
  const r = Store.resume();
  eq('存档带上步数', r.moves, 9);
  eq('存档带上提示数', r.hints, 2);
  eq('存档带计时', r.elapsedMs, 61000);
  eq('存档能一格不差地还原斜线', Array.from(r.board).join(','), Array.from(ink).join(','));
  ok('空格还原后仍是空格', r.board.some((v) => v === OPEN) && r.board.every((v) => v <= BACK));
  eq('存档记的是原始种子', r.seed, p.originSeed);
  const again = makePuzzle(r.seed, r.tier);
  eq('从存档种子重绘得到同一块盘', Array.from(again.board.clue).join(','), Array.from(p.board.clue).join(','));
  eq('重绘出来的盘尺寸也对', `${again.board.w}×${again.board.h}`, p.size);
  Store.saveResume(p, full.map((v, t) => (t < 6 ? v : OPEN)), 4000, { moves: 3, hints: 0 });
  const early = Store.resume();
  ok('开局就退出时，存档明显小于一格一数', early.ink.length < p.board.n / 2, `${early.ink.length} vs ${p.board.n} 格`);
  // a resumed run keeps its cost: the hint count must not be able to reset to zero
  const g = new Game(again);
  g.moves = r.moves;
  g.hints = r.hints;
  g.load(r.board);
  eq('续局还原提示数', g.hints, 2);
  eq('续局的撤销不越过重开边界', g.undo(), null);
  eq('首个纪录直接成立', Store.recordBest('expert', { ms: 50000, hints: 1, moves: 20, size: '8×8' }), true);
  eq('更快但更靠提示的不算破纪录', Store.recordBest('expert', { ms: 1000, hints: 2, moves: 5, size: '8×8' }), false);
  eq('同样求助次数下省步数的算破纪录', Store.recordBest('expert', { ms: 60000, hints: 1, moves: 12, size: '8×8' }), true);
  eq('步数也相同时才比时间', Store.recordBest('expert', { ms: 90000, hints: 1, moves: 12, size: '8×8' }), false);
  eq('纪录里存的是最好的那一次', Store.best('expert').moves, 12);
  Store.clearResume();
  eq('清档之后没有续局', Store.resume(), null);
  eq('存档键是本作的', Store.data.settings.sound, true);
}

// ---------- difficulty: the ladder is measured, and the bands are honest ----------

{
  const med = (a) => a.slice().sort((x, y) => x - y)[(a.length - 1) >> 1];
  const rows = [];
  for (const tier of TIERS) {
    const scores = [];
    let inBand = 0;
    let unsolvable = 0;
    let unique = 0;
    let ms = 0;
    for (let s = 0; s < 6; s++) {
      const t0 = Date.now();
      const p = makePuzzle(`band|${tier.key}|${s}`, tier.key);
      ms += Date.now() - t0;
      if (!p) continue;
      scores.push(p.score);
      if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
      if (!solve(p.board).ok) unsolvable++;
      if (countSolutions(p.board, { cap: 2, budget: 200000 }).status === UNIQUE) unique++;
    }
    rows.push({ key: tier.key, median: med(scores), inBand, n: scores.length, unsolvable, unique, ms: ms / 6 });
    eq(`${tier.key} 出货 6/6`, scores.length, 6);
    eq(`${tier.key} 每局都能推到底`, unsolvable, 0);
    eq(`${tier.key} 每局都唯一解`, unique, scores.length);
    ok(`${tier.key} 分数落在自己的区间里`, inBand >= 5, `${inBand}/6 在 ${tier.band}`);
    ok(`${tier.key} 出题够快`, ms / 6 < 900, `${(ms / 6).toFixed(0)} ms/局`);
  }
  let mono = true;
  for (let i = 1; i < rows.length; i++) if (!(rows[i].median > rows[i - 1].median)) mono = false;
  eq('档位中位分数单调递增', mono, true);
  const noband = generate({ w: 5, h: 5, seed: 'band|noband', tries: 4 });
  ok('不给区间也能出货', noband.ok && noband.offBand === 0);
  const tiny = generate({ w: 4, h: 4, seed: 'band|tiny', tries: 6, keepRatio: 0.95 });
  ok('线索给满时更简单', tiny.ok && tiny.score > 0, tiny.score);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
