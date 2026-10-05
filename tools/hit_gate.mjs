// 指针命中闸。为什么专门一个：hitCell 的正确性只在"画布被 CSS 缩放过"时才暴露，
// 而无头浏览器按 900×900 一屏跑，永远缩不到那个比例 —— 浏览器闸对它是盲的。
// 这里把 rect 按 0.5/1/2/0.62 倍拉伸，逐格喂"该格中心的 client 坐标"，要求逐格打回该格。
//
// 跑法：node tools/hit_gate.mjs（无浏览器、无依赖，CI check job 可跑）。
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');

const ctxStub = () =>
  new Proxy(
    {},
    {
      get: (t, p) => (p in t ? t[p] : () => (p === 'measureText' ? { width: 8 } : undefined)),
      set: (t, p, v) => ((t[p] = v), true),
    },
  );

const canvas = {
  style: {},
  width: 0,
  height: 0,
  getContext: () => ctxStub(),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
};
globalThis.window = { devicePixelRatio: 2 };

const { BoardView } = await import(pathToFileURL(path.join(REPO, 'js/render/board.js')).href);

const game = { w: 5, h: 5 }; // hitCell/resize 只用到 w、h
const view = new BoardView(canvas);
const geo = view.resize(game, 900, 700);

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ' → ' + detail : ''}`);
};

check('resize 把 CSS 宽写成布局宽', Math.round(parseFloat(canvas.style.width)) === geo.w, `style.width=${canvas.style.width} geo.w=${geo.w}`);
check('backing store 按 dpr 放大', canvas.width === Math.round(geo.w * 2), `canvas.width=${canvas.width} geo.w=${geo.w} dpr=2`);

// 逐格 × 逐缩放：每个格心都必须打回自己那一格
const SCALES = [1, 0.5, 2, 0.62, 1.37];
let wrong = 0;
const firstWrong = [];
for (const scale of SCALES) {
  canvas.getBoundingClientRect = () => ({ left: 37, top: 121, width: geo.w * scale, height: geo.h * scale });
  const ox = 37;
  const oy = 121;
  for (let gy = 0; gy < game.h; gy++) {
    for (let gx = 0; gx < game.w; gx++) {
      const want = gy * game.w + gx;
      const cx = ox + (geo.x + gx * geo.cell + geo.cell / 2) * scale;
      const cy = oy + (geo.y + gy * geo.cell + geo.cell / 2) * scale;
      const got = view.hitCell(cx, cy);
      if (got !== want) {
        wrong++;
        if (firstWrong.length < 4) firstWrong.push(`scale=${scale} 格(${gx},${gy}) 期望${want} 实得${got}`);
      }
    }
  }
}
check(`逐格命中在 ${SCALES.length} 种缩放下不错位（${SCALES.length * 25} 次点击）`, wrong === 0, firstWrong.join('; '));

// 越界点击必须返回 -1，不能绕回盘内（缩放后尤其容易算出负索引）
let leaked = 0;
for (const scale of SCALES) {
  canvas.getBoundingClientRect = () => ({ left: 37, top: 121, width: geo.w * scale, height: geo.h * scale });
  for (const [x, y] of [[0, 0], [36, 120], [37 + geo.w * scale + 1, 200], [200, 121 + geo.h * scale + 5]]) {
    if (view.hitCell(x, y) !== -1) leaked++;
  }
}
check('盘外点击一律返回 -1', leaked === 0, leaked ? `${leaked} 次越界点击打进了盘内` : '');

// cellRect 与 hitCell 必须互逆：拿 cellRect 的中心回去必须还是那一格
let bad = 0;
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: geo.w, height: geo.h });
for (let t = 0; t < 25; t++) {
  const r = view.cellRect(t);
  if (view.hitCell(r.x + r.size / 2, r.y + r.size / 2) !== t) bad++;
}
check('cellRect ↔ hitCell 互逆', bad === 0, bad ? `${bad}/25 格不自洽` : '');

console.log(`指针命中闸：${pass} 项通过，${fails.length} 项失败`);
fails.forEach((f) => console.log('  FAIL ' + f));
console.log(fails.length ? `结论：❌ 命中映射仍有错位，修 hitCell 的 CSS 缩放折算（geo=${JSON.stringify(geo)}）` : '结论：✅ 5×5 全 25 格 × 5 种缩放共 125 次点击逐格打回本格，盘外 20 次全部拒收，cellRect 与 hitCell 互逆');
process.exit(fails.length ? 1 : 0);
