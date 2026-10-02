// Wiring: DOM, pointer gestures, the clock, storage, and the `window.slant` surface the
// verification harness drives. No rule about the board lives here — every judgement comes from
// js/engine/slant.js through js/ui/game.js.

import { Palette, applyThemeVars, setReduceMotion, systemPrefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierFor, makePuzzle, generate, randomSolution, pruneClues } from './engine/generate.js';
import { Cell } from './theme.js';
import * as Engine from './engine/slant.js';
import { countSolutions } from './engine/count.js';
import { BoardView } from './render/board.js';
import { Game, name, OPEN, SLASH, BACK } from './ui/game.js';
import { registerServiceWorker, installPromptSurface } from './pwa.js';
import { createFx } from './render/fx.js';

const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  filled: $('#stat-filled'),
  remaining: $('#stat-remaining'),
  satisfied: $('#stat-satisfied'),
  conflicts: $('#stat-conflicts'),
  score: $('#stat-score'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  stateLine: $('#state-line'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  pauseVeil: $('#pause-veil'),
  pauseMeta: $('#pause-meta'),
  helpVeil: $('#help-veil'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
};

const view = new BoardView(el.canvas);

// ---- 动效层 ------------------------------------------------------------------
// 唯一的动画时钟在 js/render/fx.js（定步长累加器 + dt 积分）。这里只做三件事：
// 喂帧、把脉冲进度换算成颜色、把粒子画到覆盖层。覆盖层是独立 canvas，
// 不动 #board 的像素——浏览器闸按棋盘中心采样色，任何改动棋盘像素的"美化"都会打红它。
const FX_SPRITES = ['spark-amber', 'spark-blue', 'spark-green', 'shard-amber'];
const fxSprites = {};
for (const key of FX_SPRITES) {
  const img = new Image();
  img.src = `./assets/fx/${key}.png`;
  fxSprites[key] = img;
}
const fx = createFx({ sprites: fxSprites, reduceMotion: Store.setting('reduceMotion') });
const fxCanvas = $('#fx');
const fxCtx = fxCanvas && fxCanvas.getContext ? fxCanvas.getContext('2d') : null;

function syncFxCanvas() {
  if (!fxCanvas) return;
  if (fxCanvas.width !== el.canvas.width || fxCanvas.height !== el.canvas.height) {
    fxCanvas.width = el.canvas.width;
    fxCanvas.height = el.canvas.height;
  }
}

const hexRgba = (color, alpha) => {
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) return color || '';
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
};

// 环的透明度由仿真时钟里的 t 决定，跟这一帧是 16ms 还是 41ms 无关。
function fxPulse() {
  const rings = fx.active();
  if (!rings.length) return null;
  const r = rings[0];
  if (r.cell == null) return null;
  return { cell: r.cell, node: r.node, color: r.color || hexRgba(Palette.hint, 0.28 + 0.72 * r.fade) };
}

function fxFrame() {
  const elapsed = fx.feed(); // 暂停时也要刷新 last，否则回来会补算整个暂停段
  if (!paused) {
    const steps = fx.step();
    if (steps || elapsed) {
      syncFxCanvas();
      if (fxCtx) fxCtx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      const live = fxCtx ? fx.render(fxCtx, fxCanvas.width, fxCanvas.height, window.devicePixelRatio || 1) : 0;
      if (live || fx.active().length) draw();
    }
  }
  requestAnimationFrame(fxFrame);
}
requestAnimationFrame(fxFrame);

let game = null;
let stroke = null;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function availBox() {
  const narrow = window.innerWidth <= 900;
  const w = narrow ? window.innerWidth - 60 : el.viewGame.clientWidth - 340;
  return { w: Math.max(240, w), h: Math.max(240, window.innerHeight - 250) };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  view.draw(game, { pulse: fxPulse(), preview: stroke && stroke.items.length ? { cells: stroke.items.map((i) => i.cell) } : null });
}

// One place writes the readouts, so a stat can never be updated by half the file.
function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = `${st.name} · ${game.w}×${game.h}`;
  el.tier.textContent = tierFor(st.tier).name;
  el.tier.dataset.tier = st.tier;
  el.time.textContent = fmtMs(clock());
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  el.filled.textContent = `${st.filled}/${st.total}`;
  el.remaining.textContent = st.remaining;
  el.satisfied.textContent = `${st.satisfied}/${st.clues}`;
  el.conflicts.textContent = st.conflicts;
  el.score.textContent = st.score.toFixed(1);
  el.conflicts.closest('.stat').classList.toggle('bad', st.conflicts > 0);
  el.remaining.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.remaining > 0);
  el.satisfied.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.conflicts > 0);
  el.stateLine.textContent = st.stuck
    ? '这些线和数字已经矛盾了：不管剩下的格怎么放，都不可能让所有数字对上。撤销一步再想。'
    : st.conflicts
      ? `${st.conflicts} 个数字对不上：它周围的线多了，或者已经凑不到那个数了。`
      : '';
}

function syncAll() {
  syncStats();
  draw();
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.st.cell, clock(), { moves: game.moves, hints: game.hints });
}

function startClock() {
  startedAt = Date.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    el.time.textContent = fmtMs(clock());
  }, 1000);
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
  clearInterval(ticker);
  ticker = 0;
}

// ---- 外壳状态：暂停 / 重开 / 全屏 / 教学。四个都只在这里改，按钮回调只调函数。 ----

let paused = false;
let helpOpen = false;

// 暂停必须真的让时钟停下：clock() 是 baseElapsed + (Date.now() - startedAt)，
// 所以唯一诚实的做法是走 stopClock() 把已跑的时长结算进 baseElapsed。
// 只把遮罩显示出来、时钟继续累加 = 假暂停，回来会发现"想了一会儿"也算进了纪录。
function setPaused(v) {
  const want = !!v;
  if (want === paused) return paused;
  if (want && (!game || game.status === 'won')) return false;
  paused = want;
  if (paused) {
    if (stroke) {
      unpreview();
      stroke = null;
    }
    stopClock();
    el.pauseMeta.textContent = `${fmtMs(clock())} · ${game.moves} 步 · 提示 ${game.hints} 次 · 待画 ${game.state().remaining} 格`;
    el.pauseVeil.hidden = false;
  } else {
    el.pauseVeil.hidden = true;
    startClock();
  }
  const b = $('#btn-pause');
  b.setAttribute('aria-pressed', String(paused));
  b.textContent = paused ? '继续' : '暂停';
  syncAll();
  return paused;
}

const runReadout = () =>
  (game ? { elapsedMs: clock(), moves: game.moves, hints: game.hints, steps: game.steps.length, filled: game.diag.filled, cursor: game.cursor } : null);

// 重开走 begin() 的确定性种子路径：makePuzzle(originSeed, tier) 必然还原同一张盘
// （存档续局靠的就是这条性质），所以"重开本局"不需要另写一套复位代码，也就不会漏掉
// 某一样没复位的东西——时钟、预览缓冲、脉冲、步数、提示数、求解游标全在新 Game 里。
function restart() {
  if (!game) return null;
  const { tier, originSeed } = game.puzzle;
  const before = runReadout();
  const clueBefore = Array.from(game.board.clue).join(',');
  const g = begin({ tier, seed: originSeed });
  return { before, after: runReadout(), sameBoard: g ? clueBefore === Array.from(g.board.clue).join(',') : false };
}

const fullscreenSupported = () => typeof document.documentElement.requestFullscreen === 'function';
const isFullscreen = () => !!document.fullscreenElement;

function syncFullscreen() {
  const b = $('#btn-fullscreen');
  if (!b) return;
  const on = isFullscreen();
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? '退出全屏' : '全屏';
  // 不支持时不隐藏而是禁用：隐藏了玩家找不到，也永远不知道为什么按了没反应。
  b.disabled = !fullscreenSupported();
  if (!fullscreenSupported()) b.title = '这个浏览器不提供元素级全屏';
}

async function toggleFullscreen() {
  if (!fullscreenSupported()) return false;
  try {
    if (isFullscreen()) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    /* 用户拒绝、或权限策略不允许 —— 状态由 fullscreenchange 兜底同步 */
  }
  syncFullscreen();
  return isFullscreen();
}

function setHelp(open) {
  helpOpen = !!open;
  el.helpVeil.hidden = !helpOpen;
  const b = $('#btn-help');
  b.setAttribute('aria-pressed', String(helpOpen));
  if (helpOpen) $('#btn-help-close')?.focus?.();
  else $('#btn-help')?.focus?.();
  return helpOpen;
}

function setMode(mode) {
  if (!game) return;
  game.mode = mode;
  $('#btn-mode-slash').setAttribute('aria-pressed', String(mode === SLASH));
  $('#btn-mode-back').setAttribute('aria-pressed', String(mode === BACK));
  el.canvas.dataset.mode = mode === SLASH ? 'slash' : 'back';
  draw();
}

function showHint(info) {
  if (!info) return;
  if (info.stalled) {
    el.hintRule.textContent = '推不动了';
    el.hintLine.textContent = info.text;
    return;
  }
  if (info.conflict) {
    el.hintRule.textContent = '这里和数字矛盾';
    el.hintLine.textContent = info.conflict;
    fx.ring(info.cell, null, 1.6, 'rgba(255,92,122,0.9)');
    draw();
    Sound.conflict();
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.why;
  fx.ring(info.cell, info.node, 1.6);
  draw();
  Sound.hint();
}

function onWin() {
  stopClock();
  const ms = clock();
  const better = Store.recordBest(game.puzzle.tier, {
    ms,
    hints: game.hints,
    moves: game.moves,
    size: `${game.w}×${game.h}`,
  });
  Store.recordSolve(ms, game.hints);
  Store.clearResume();
  el.winMeta.textContent = `${tierFor(game.puzzle.tier).name} · ${game.w}×${game.h} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  el.winRecord.textContent = better ? '新纪录：这一局比存档里的更不求人。' : '未破纪录：同档先比提示次数。';
  el.winVeil.hidden = false;
  const rect = el.canvas.getBoundingClientRect();
  fx.burst('win', rect.width / 2, rect.height / 2, Math.max(0.6, rect.width / 420));
  fx.ring(null, null, 0.0001);
  Sound.win();
  renderRecords();
}

function afterStep(soundKey, cells) {
  if (soundKey && cells && cells.length) {
    const r = view.cellRect(cells[0]);
    fx.burst(soundKey, r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 44));
  }
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    if (soundKey) Sound[soundKey]();
    if (game.stuck || game.diag.violated.size) Sound.conflict();
  }
}

function useHint() {
  if (!game || game.status === 'won' || paused) return null;
  const before = game.hints;
  const info = game.hint();
  if (!info) return null;
  // An unproductive hint is not a purchase: nothing was written, nothing is charged.
  if (info.stalled || info.conflict) {
    showHint(info);
    return info;
  }
  showHint(info);
  if (game.hints !== before) afterStep('hint', [info.cell]);
  return info;
}

function undo() {
  if (!game || paused) return null;
  const step = game.undo();
  if (!step) return null;
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

function begin({ tier = 'trainee', seed = null, resume = null } = {}) {
  if (paused) setPaused(false);
  const origin = seed || `s${Math.floor(Math.random() * 1e9)}`;
  const puzzle = makePuzzle(origin, tier);
  if (!puzzle) return null;
  game = new Game(puzzle);
  fx.reset();
  stroke = null;
  el.winVeil.hidden = true;
  baseElapsed = 0;
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    baseElapsed = resume.elapsedMs || 0;
    game.cursor = 0;
    game.load(resume.board);
  }
  setMode(SLASH);
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一格，以及它依据哪条规则。';
  syncAll();
  flushResume();
  renderResumeCard();
  return game;
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    if (paused) setPaused(false);
    stopClock();
    renderMenu();
  }
  if (which === 'game') draw();
  return which;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderResumeCard();
}

const TIER_NOTE = {
  trainee: '数字给得多，一格一数就推得完',
  apprentice: '要开始数"还差几条"和"已经够了"',
  regular: '数字稀了，得连着看好几个交点',
  expert: '大半交点没有数字，全靠推',
  master: '盘大数少，一步看错整片对不上',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML =
      `<span class="tier-name">${t.name}</span>` +
      `<span class="tier-note">${TIER_NOTE[t.key] || ''}</span>` +
      `<span class="tier-size mono">${t.w}×${t.h} · 实测 ${t.band[0]}–${t.band[1]}</span>`;
    b.addEventListener('click', () => begin({ tier: t.key }));
    el.tiers.appendChild(b);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.dataset.tier = t.key;
    li.innerHTML =
      `<b>${t.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.size}</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

function renderResumeCard() {
  const r = Store.resume();
  // Do not offer "继续" for the board already on screen.
  const live = game && game.status !== 'won' && running();
  if (!r || (live && r.seed === game.puzzle.originSeed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} 的一局`;
  el.resumeMeta.textContent = `${fmtMs(r.elapsedMs || 0)} · ${r.moves || 0} 步 · 提示 ${r.hints || 0} 次`;
}

function applySettings() {
  Sound.setEnabled(Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
  // 省动效必须同时传进仿真时钟：只关 CSS 过渡、粒子照放，等于没省。
  fx.setReduceMotion(reduce);
}

// ---- pointer gestures: down decides the value for the whole stroke, up commits one step ------

// During a drag the cells are painted ahead of the commit so the picture follows the finger.
// Each preview remembers the state the cell had *before* the gesture, because the committed step
// has to record that as its undo target — restoring to OPEN instead would quietly eat the line
// an erase gesture was about to remove.
function preview(t, value) {
  stroke.items.push({ cell: t, from: game.st.cell[t] });
  game.st.cell[t] = value;
  game.recompute();
}

function unpreview() {
  for (const it of stroke.items) game.st.cell[it.cell] = it.from;
  game.recompute();
}

function strokeStart(ev) {
  if (!game || game.status === 'won' || paused) return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  ev.preventDefault();
  el.canvas.setPointerCapture?.(ev.pointerId);
  stroke = { items: [] };
  // Starting on a line that already points this way makes the whole gesture an eraser.
  const value = game.st.cell[t] === game.mode ? OPEN : game.mode;
  stroke.value = value;
  preview(t, value);
  draw();
}

function strokeMove(ev) {
  if (!stroke || !game) return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  if (stroke.items.some((it) => it.cell === t) || game.st.cell[t] === stroke.value) return;
  preview(t, stroke.value);
  draw();
}

function strokeEnd() {
  if (!stroke || !game) return null;
  const s = stroke;
  const cells = s.items.map((it) => it.cell);
  unpreview();
  stroke = null;
  const step = game.stroke(cells, s.value);
  if (!step) {
    syncAll();
    return null;
  }
  afterStep(s.value === OPEN ? 'rub' : 'place', s.items.map((i) => i.cell));
  return step;
}

function abortStroke() {
  if (!stroke) return;
  unpreview();
  stroke = null;
  syncAll();
}

el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

// pointerdown 优先：它是唯一能同时说清"哪个手指、在哪个坐标"的事件。
// 只有 window.PointerEvent 真的不存在时（老 Safari < 13）才回落 touch/mouse —— 两套同时
// 绑会在现代浏览器上把一次触摸处理两遍。
const hasPointerEvents = typeof window.PointerEvent === 'function';

if (hasPointerEvents) {
  el.canvas.addEventListener('pointerdown', strokeStart);
  el.canvas.addEventListener('pointermove', strokeMove);
  el.canvas.addEventListener('pointerup', strokeEnd);
  el.canvas.addEventListener('pointercancel', abortStroke);
} else {
  const adapt = (ev) => {
    const t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]);
    if (!t) return null;
    return { clientX: t.clientX, clientY: t.clientY, pointerId: 1, preventDefault: () => ev.preventDefault() };
  };
  const fromMouse = (ev) => (ev.button !== undefined && ev.button !== 0 ? null : { clientX: ev.clientX, clientY: ev.clientY, preventDefault: () => ev.preventDefault() });
  el.canvas.addEventListener('touchstart', (ev) => { const p = adapt(ev); if (p) strokeStart(p); }, { passive: false });
  el.canvas.addEventListener('touchmove', (ev) => { const p = adapt(ev); if (p) strokeMove(p); }, { passive: false });
  // 抬起与取消绑在 window 上：手指滑到画布外松手，这一笔仍然要结算，不能留下预览态。
  window.addEventListener('touchend', strokeEnd);
  window.addEventListener('touchcancel', abortStroke);
  el.canvas.addEventListener('mousedown', (ev) => { const p = fromMouse(ev); if (p) strokeStart(p); });
  window.addEventListener('mousemove', (ev) => { if (!stroke) return; const p = fromMouse(ev); if (p) strokeMove(p); });
  window.addEventListener('mouseup', strokeEnd);
}

function toggleSound() {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  if (Store.setting('sound')) Sound.place();
}

$('#btn-mode-slash').addEventListener('click', () => setMode(SLASH));
$('#btn-mode-back').addEventListener('click', () => setMode(BACK));
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-restart').addEventListener('click', restart);
$('#btn-new').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  if (!r) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
$('#btn-pause').addEventListener('click', () => setPaused(!paused));
$('#btn-resume-play').addEventListener('click', () => setPaused(false));
$('#btn-fullscreen').addEventListener('click', toggleFullscreen);
$('#btn-help').addEventListener('click', () => setHelp(!helpOpen));
$('#btn-help-close').addEventListener('click', () => setHelp(false));
el.helpVeil.addEventListener('click', (ev) => {
  if (ev.target === el.helpVeil) setHelp(false); // 点到卡片外面就是关掉它
});
document.addEventListener('fullscreenchange', syncFullscreen);
$('#btn-sound').addEventListener('click', toggleSound);
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

window.addEventListener('keydown', (ev) => {
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  // 组合键不吃：Cmd+R / Ctrl+R 是刷新，不是重开本局。
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key;
  const startKey = k === ' ' || k === 'Enter' || k === 'Spacebar';
  // 焦点停在某个按钮上时，空格/回车属于"按下这个按钮"，不能被解释成暂停。
  if (startKey && ev.target && ev.target.closest && ev.target.closest('button')) return;
  if (k === 'Escape') {
    if (helpOpen) setHelp(false);
    return;
  }
  if (k === '?' || (k === '/' && ev.shiftKey)) {
    ev.preventDefault();
    setHelp(!helpOpen);
    return;
  }
  if (helpOpen) return; // 教学开着时，底下的键不该偷偷改对局
  const inGame = !el.viewGame.hidden && game;
  if (startKey) {
    ev.preventDefault();
    if (inGame) setPaused(!paused);
    else begin({ tier: 'trainee' });
    return;
  }
  if (k === 'p' || k === 'P') setPaused(inGame ? !paused : false);
  else if ((k === 'r' || k === 'R') && inGame) restart();
  else if (k === 'f' || k === 'F') toggleFullscreen();
  else if (k === 'm' || k === 'M') toggleSound();
  else if (k === 'h' || k === 'H') (inGame ? useHint() : setHelp(true));
  else if (k === 'z' || k === 'Z') undo();
  else if ((k === 'x' || k === 'X') && game) setMode(game.mode === SLASH ? BACK : SLASH);
  else if (k === '/') setMode(SLASH);
  else if (k === '\\') setMode(BACK);
});

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

applyThemeVars();
applySettings();
syncFullscreen();
renderMenu();

const swRegistration = registerServiceWorker();
installPromptSurface(window);
const pwaState = { registered: false, scope: null, version: VERSION };
if (swRegistration && typeof swRegistration.then === 'function') {
  swRegistration
    .then((reg) => {
      if (!reg) return;
      pwaState.registered = true;
      pwaState.scope = reg.scope;
    })
    .catch(() => {});
}

window.slant = {
  version: VERSION,
  pwa: pwaState,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  useHint,
  undo,
  get paused() {
    return paused;
  },
  setPaused,
  restart,
  setHelp,
  toggleFullscreen,
  fx,
  fxState: () => fx.state(),
  runReadout,
  setMode,
  // The harness commits through the same path a pointer release does, so a scenario that passes
  // here has driven the real state machine rather than a copy of it.
  stroke(cells, value) {
    if (!game || paused) return null;
    const step = game.stroke(cells, value === undefined ? game.mode : value);
    if (step) afterStep(step.value === OPEN ? 'rub' : 'place', cells);
    return step;
  },
  tap(t, mode) {
    if (!game || paused) return null;
    const step = mode === undefined ? game.tap(t) : game.tap(t, mode);
    if (step) afterStep(step.writes[0].to === OPEN ? 'rub' : 'place', [t]);
    return step;
  },
  solveWithLogic() {
    if (!game) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock() } : null),
  cellAt: (x, y) => (game ? game.cellAt(x, y) : -1),
  valueOf: (t) => (game ? game.valueOf(t) : OPEN),
  lineName: name,
  engine: {
    ...Engine,
    makePuzzle,
    generate,
    randomSolution,
    pruneClues,
    countSolutions,
    TIERS,
    tierFor,
    Game,
    Store,
    theme: { ...Palette, Cell },
    OPEN,
    SLASH,
    BACK,
  },
};
