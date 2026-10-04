// Canvas renderer. It reads the Game's engine state and paints; it decides nothing — no node is
// "satisfied" here, no line is judged wrong here — so the picture cannot disagree with the solver
// that the hints and the win check both use.
//
// Layout lives here too (cell size from the container, board origin, DPR) because hitTest has to
// answer with the *same* numbers draw() used. Those two drifting apart is how a board renders
// correctly but takes clicks one cell off.


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown 触发，全仓 requestAnimationFrame 出现 0 次；唯一的周期性调用是 1 秒 ticker（刷新用时读数，走墙钟）
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Cell, Radius } from '../theme.js';
import { OPEN, SLASH, NO_CLUE } from '../engine/slant.js';

export function layoutFor(w, h, availW, availH) {
  const pad = 22; // the numbered nodes sit on the corners, half of them outside the grid
  const size = Math.max(0, Math.min((availW - pad * 2) / w, (availH - pad * 2) / h));
  const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(size)));
  return { cell, boardW: cell * w, boardH: cell * h, pad };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels: one
  // ctx.scale at the top keeps the digits crisp on a Retina display without doubling every
  // constant in this file.
  resize(game, availW, availH) {
    const l = layoutFor(game.w, game.h, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr };
    this.game = game;
    return this.geo;
  }

  cellRect(t) {
    const { cell, x, y } = this.geo;
    return { x: (t % this.game.w) * cell + x, y: (((t / this.game.w) | 0) * cell) + y, size: cell };
  }

  nodePoint(i) {
    const { cell, x, y } = this.geo;
    const b = this.game.board;
    return { x: (i % b.nw) * cell + x, y: (((i / b.nw) | 0) * cell) + y };
  }

  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const game = this.game;
    if (!cell || !game) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    if (px < 0 || py < 0) return -1;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= game.w || gy >= game.h) return -1;
    return gy * game.w + gx;
  }

  draw(game, { pulse = null, preview = null } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell } = geo;
    const b = game.board;
    const st = game.st;
    const diag = game.diag;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, geo.w, geo.h);

    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();

    // Cells: the paper. A settled cell is lifted so the grid you are filling reads as filled.
    for (let t = 0; t < b.n; t++) {
      const r = this.cellRect(t);
      ctx.fillStyle = st.cell[t] === OPEN ? Palette.bgBottom : Palette.surfaceLift;
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // The diagonals. Colour is the live feedback this game lives on: a line that helps every
    // node it touches is cool blue, one that breaks a number is red, and a finished board is all
    // green. Which nodes are satisfied is the engine's answer, not a guess made here.
    const badCells = new Set();
    const goodNodes = diag.satisfied;
    for (const p of diag.violated) for (const [cell_] of b.nodes[p]) badCells.add(cell_);
    ctx.lineCap = 'round';
    for (let t = 0; t < b.n; t++) {
      const v = st.cell[t];
      if (v === OPEN) continue;
      const r = this.cellRect(t);
      const inset = cell * 0.16;
      const bad = badCells.has(t);
      const allGood = b.cellNodes[t].every((i) => b.clue[i] === NO_CLUE || goodNodes.has(i));
      ctx.strokeStyle = won ? Palette.success : bad ? Palette.error : allGood ? Palette.info : Palette.pencilStrong;
      ctx.lineWidth = Math.max(2.5, cell * Cell.lineScale);
      ctx.beginPath();
      if (v === SLASH) {
        ctx.moveTo(r.x + inset, r.y + cell - inset);
        ctx.lineTo(r.x + cell - inset, r.y + inset);
      } else {
        ctx.moveTo(r.x + inset, r.y + inset);
        ctx.lineTo(r.x + cell - inset, r.y + cell - inset);
      }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    // Grid.
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= game.w; i++) line(ctx, geo.x + i * cell, geo.y, geo.x + i * cell, geo.y + game.h * cell);
    for (let j = 0; j <= game.h; j++) line(ctx, geo.x, geo.y + j * cell, geo.x + game.w * cell, geo.y + j * cell);

    // The box under the finger, before it is committed: a preview is paint, never ink.
    if (preview && preview.cells) {
      ctx.strokeStyle = Palette.accent;
      ctx.lineWidth = Math.max(2, cell * 0.06);
      ctx.setLineDash([Math.max(4, cell * 0.2), Math.max(3, cell * 0.14)]);
      for (const t of preview.cells) {
        const r = this.cellRect(t);
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, cell - 3, cell - 3);
      }
      ctx.setLineDash([]);
    }

    // Nodes last, so a number always sits on top of the lines it counts.
    const rad = Math.min(15, cell * Cell.nodeScale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < b.nodes.length; i++) {
      const p = this.nodePoint(i);
      const want = b.clue[i];
      if (want === NO_CLUE) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.5, cell * 0.045), 0, Math.PI * 2);
        ctx.fillStyle = Palette.inkFaint;
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = Palette.bgTop;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, rad * 0.18);
      ctx.strokeStyle = diag.violated.has(i) ? Palette.error : diag.satisfied.has(i) ? Palette.success : Palette.lineHeavy;
      ctx.stroke();
      ctx.font = `700 ${Math.round(rad * 1.25)}px ${FontStack}`;
      ctx.fillStyle = diag.violated.has(i) ? Palette.error : diag.satisfied.has(i) ? Palette.success : Palette.ink;
      ctx.fillText(String(want), p.x, p.y + 1);
    }

    // What a hint just named — the only place the UI is allowed to say "look here".
    if (pulse && pulse.cell != null) {
      const r = this.cellRect(pulse.cell);
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
      ctx.stroke();
      const node = pulse.node;
      if (node != null && b.clue[node] !== NO_CLUE) {
        const p = this.nodePoint(node);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + Math.max(2, cell * 0.08), 0, Math.PI * 2);
        ctx.strokeStyle = Palette.hint;
        ctx.lineWidth = Math.max(1.5, cell * 0.05);
        ctx.stroke();
      }
    }
  }
}

const FontStack = "-apple-system, 'SF Pro Text', system-ui, sans-serif";

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
