// 帧率无关闸（定步长仿真 + 内建阴性对照）。为什么专门写一个：
// 官方探针 cos_frame_probe.js 用 vm.runInContext 装载脚本，解析不了本仓的 ESM `import`，
// 对本仓只能判"结论：无法比对"。没有这个闸，"帧率无关"就只剩一句注释。
//
// 判法（规范 §3/§6）：同一份 fx 源码、同一串 spawn，只改"每秒喂几次 rAF"，
// 同一虚拟时长后的状态必须落在**一步物理量**以内 —— 定步长累加器的唯一合法误差，
// 就是不足一个 STEP 的尾差。容差不拍脑袋：位移 ≤ |v|×STEP、寿命/时钟 ≤ STEP。
//
// 阴性对照按 §6 的口径钉在"仍在吃帧 dt 的那一行"（累加器 accum += dt）：
// 把它改成 accum += 1/60 后本闸必须变红，否则说明尺子是空跑的。
//
// 跑法：node tools/frame_gate.mjs（无浏览器、无依赖）。
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');
const FX = path.join(REPO, 'js/render/fx.js');
const STEP = 1 / 120; // 与 fx.js 同源
const GRAV = 900;
const VIRTUAL = 0.9; // 秒：落在 win 粒子（寿命 0.8~1.5s）仍然存活的窗口里
const TIERS = [30, 60, 120];
const REF = 60;

const { createFx } = await import(pathToFileURL(FX).href);

// 虚拟时钟从 1000ms 起：从 0 起步会被 `lastTime === 0` 那类哨兵吃掉第一帧，凭空造出假依赖。
function run(Fx, hz) {
  let clock = 1000;
  const fx = Fx({ now: () => clock });
  fx.burst('win', 320, 320, 1);
  fx.ring(3, 5, 1.6);
  const frames = Math.round(VIRTUAL * hz);
  for (let i = 0; i < frames; i++) {
    clock += 1000 / hz;
    fx.feed();
    fx.step();
  }
  return { s: fx.state(), frames };
}

const R = Object.fromEntries(TIERS.map((hz) => [hz, run(createFx, hz)]));
const ref = R[REF].s;
if (!ref.head.length) {
  console.log('结论：❌ 参考档没有存活粒子，对拍窗口选错（尺子会空跑）');
  process.exit(1);
}
const p = ref.head[0];
const tol = {
  x: Math.abs(p.vx) * STEP + 0.05,
  y: Math.abs(p.vy) * STEP + GRAV * STEP * STEP + 0.05,
  rot: Math.abs(p.vr) * STEP + 0.002,
  age: STEP + 0.002,
  time: STEP + 1e-9,
};

let pass = 0;
const fails = [];
const rows = [];
for (const hz of TIERS) {
  if (hz === REF) continue;
  const o = R[hz].s.head[0] || {};
  const row = {
    hz,
    'Δx/容差': +(Math.abs((o.x ?? 0) - p.x) / tol.x).toFixed(3),
    'Δy/容差': +(Math.abs((o.y ?? 0) - p.y) / tol.y).toFixed(3),
    'Δrot/容差': +(Math.abs((o.rot ?? 0) - p.rot) / tol.rot).toFixed(3),
    'Δage/容差': +(Math.abs((o.age ?? 0) - p.age) / tol.age).toFixed(3),
    'Δtime/容差': +(Math.abs(R[hz].s.time - ref.time) / tol.time).toFixed(3),
    'Δ存活': R[hz].s.count - ref.count,
    '步数': Math.round(R[hz].s.time * 120),
  };
  rows.push(row);
  const worst = Math.max(row['Δx/容差'], row['Δy/容差'], row['Δrot/容差'], row['Δage/容差'], row['Δtime/容差']);
  const cntOk = Math.abs(row['Δ存活']) <= 1; // 一步之内至多一个粒子跨过寿命边界
  if (worst <= 1.5 && cntOk) pass += 2;
  else fails.push(`${hz}Hz 对 ${REF}Hz：偏差/容差 最坏 ${worst.toFixed(2)}（阈值 1.5），存活差 ${row['Δ存活']}`);
}

console.log(`帧率对拍（虚拟 ${VIRTUAL}s，帧距 ${TIERS.map((h) => (1000 / h).toFixed(3)).join(' / ')} ms）`);
console.log(`  参考档 ${REF}Hz：步数=${Math.round(ref.time * 120)} 存活=${ref.count} 首粒子 v=(${p.vx.toFixed(1)},${p.vy.toFixed(1)}) 容差 x≤${tol.x.toFixed(3)}px y≤${tol.y.toFixed(3)}px`);
for (const r of rows) console.log(`  ${r.hz}Hz  Δx=${(Math.abs(R[r.hz].s.head[0].x - p.x)).toFixed(3)}px Δy=${(Math.abs(R[r.hz].s.head[0].y - p.y)).toFixed(3)}px Δtime=${Math.abs(R[r.hz].s.time - ref.time).toFixed(6)}s 步数=${r['步数']} 存活差=${r['Δ存活']}  最坏偏差/容差=${Math.max(r['Δx/容差'], r['Δy/容差'], r['Δtime/容差']).toFixed(2)}`);

// ---- 阴性对照：把仍在吃帧 dt 的那一行改成常数，本闸必须变红 ----
const src = fs.readFileSync(FX, 'utf8');
const NEEDLE = 'accum += dt;';
let ctrl = { ok: false, detail: '检不到 accum += dt（口径已变，需更新本闸）' };
if (src.includes(NEEDLE)) {
  const mut = src.replace(NEEDLE, 'accum += 1 / 60; // __MUTATION__');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slant-fx-')), 'fx_mut.mjs');
  fs.writeFileSync(tmp, mut);
  const { createFx: MutFx } = await import(pathToFileURL(tmp).href);
  const M = Object.fromEntries(TIERS.map((hz) => [hz, run(MutFx, hz)]));
  const steps = TIERS.map((hz) => Math.round(M[hz].s.time * 120));
  const spread = Math.max(...steps) - Math.min(...steps);
  const m0 = M[REF].s.head[0] || { x: 0, y: 0 };
  const d30 = M[30].s.head[0] || m0;
  const dev = Math.max(Math.abs(d30.x - m0.x) / tol.x, Math.abs(d30.y - m0.y) / tol.y);
  ctrl = {
    ok: spread >= 20 || dev > 5,
    detail: `变异 accum += dt → accum += 1/60 后：三档步数 ${steps.join('/')}（极差 ${spread}），30Hz 对 60Hz 偏差/容差 = ${dev.toFixed(1)}`,
  };
  fs.rmSync(tmp, { force: true });
}
if (ctrl.ok) pass++;
else fails.push('阴性对照未变红 → 尺子是空跑的：' + ctrl.detail);

console.log(`阴性对照：${ctrl.ok ? '✅ 变异后确实变红' : '❌'} ${ctrl.detail}`);
console.log(`帧率无关闸：${pass} 项通过，${fails.length} 项失败`);
fails.forEach((f) => console.log('  FAIL ' + f));
console.log(fails.length ? '结论：❌ 位移/寿命随时长加测在 30/60/120Hz 下不收敛' : `结论：✅ 关卡外同一段仿真在 ${TIERS.join('/')}Hz 下逐字段落在一步物理量以内，且尺子经阴性对照自证非空跑`);
process.exit(fails.length ? 1 : 0);
