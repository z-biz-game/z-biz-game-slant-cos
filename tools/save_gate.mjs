// 存档解码闸。为什么要专门一个：坏存档不是异常路径，是玩家手改/半写入/浏览器同步冲突的日常，
// 而"一条坏记录把整份存档带走"是看不见的能力缺失——浏览器闸采样的是画布像素，它永远不会知道。
// 这里直接喂垃圾样本，逐条定罪：该丢的那条丢掉，该留的必须留下。
//
// 跑法：node tools/save_gate.mjs（无浏览器、无依赖，CI check job 可跑）。
import { decodeSave } from '../js/store.js';

// 键序不参与相等：解码器按 defaults 的形状重排过字段，玩家看不见顺序，断言也不该看得见。
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

let pass = 0;
const fails = [];

function check(name, cond, detail) {
  if (cond) pass++;
  else fails.push(`${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

const GOOD_BEST = { ms: 123456, hints: 0, moves: 41, size: 100, at: 1700000000000 };
const goodResume = (over = {}) => ({
  seed: 'gate|fixed',
  tier: 'regular',
  elapsedMs: 4321,
  cells: 36,
  ink: [0, 30, 1, 3, 2, 3], // 30 空格 + 3 个 "/" + 3 个 "\\"
  moves: 6,
  hints: 1,
  at: 1700000000000,
  ...over,
});
const goodSave = () => ({
  settings: { sound: false, reduceMotion: true },
  best: { regular: { ...GOOD_BEST }, expert: { ...GOOD_BEST, ms: 654321 } },
  resume: goodResume(),
  totals: { solved: 7, hints: 3, ms: 999999 },
});

// ---- 第一段：文本不是 JSON / 不是对象 ⇒ 整份回落默认，但不抛 ----
for (const [name, raw] of [
  ['空串', ''],
  ['null 字面量', 'null'],
  ['截断的 JSON', '{"settings":{"sound":tru'],
  ['顶层是数组', '[1,2,3]'],
  ['顶层是字符串', '"hello"'],
  ['顶层是数字', '42'],
]) {
  let out;
  try {
    out = decodeSave(raw);
  } catch (e) {
    check(`文本段 ${name} 不抛`, false, String(e));
    continue;
  }
  check(`文本段 ${name} 回落默认`, same(out, decodeSave(null)), out);
}
check('原始非字符串(undefined) 不抛', (() => {
  try {
    return same(decodeSave(undefined), decodeSave(null));
  } catch {
    return false;
  }
})());

// ---- 第二段：坏一条只丢那条 ----
const keep = (raw, expect, name) => {
  let out;
  try {
    out = decodeSave(JSON.stringify(raw));
  } catch (e) {
    check(`${name} 不抛`, false, String(e));
    return;
  }
  expect(out, name);
};

// best：整段是 null（曾经的致命样本）⇒ 只丢 best，其余全留
keep({ ...goodSave(), best: null }, (o, n) => {
  check(`${n} best=null 清空 best`, Object.keys(o.best).length === 0, o.best);
  check(`${n} best=null 保住 settings`, o.settings.reduceMotion === true && o.settings.sound === false, o.settings);
  check(`${n} best=null 保住 totals`, o.totals.solved === 7 && o.totals.ms === 999999, o.totals);
  check(`${n} best=null 保住 resume`, o.resume && o.resume.moves === 6, o.resume);
}, 'A');

// best：单条记录坏 ⇒ 只丢那条，另一档留着
keep({ best: { regular: { ...GOOD_BEST }, expert: null, trainee: { ...GOOD_BEST, hints: '0' }, master: { ...GOOD_BEST, ms: -5 }, nano: { ...GOOD_BEST, size: 0 }, guru: { ...GOOD_BEST, at: null } }, resume: null, settings: null, totals: null },
  (o, n) => {
    check(`${n} 只留合法那一条`, Object.keys(o.best).join() === 'regular', o.best);
  }, 'B');

// best：字段类型错 / 越界 / NaN / Infinity 都只打掉本条
for (const [label, bad] of [
  ['ms 是字符串', { ms: '123' }],
  ['ms 是 NaN', { ms: NaN }],
  ['ms 是 Infinity', { ms: Infinity }],
  ['hints 负数', { hints: -1 }],
  ['moves 小数', { moves: 3.5 }], // 0.5 会被 floor，见下条断言
  ['size 越界', { size: 999999 }],
  ['at 是日期串', { at: '2026-01-01' }],
]) {
  const rec = { ...GOOD_BEST, ...bad };
  keep({ best: { regular: rec, expert: { ...GOOD_BEST } } }, (o, n) => {
    if (label === 'moves 小数') check(`${n} 小数被量化(不判死)`, o.best.regular && o.best.regular.moves === 3 && Object.keys(o.best).length === 2, o.best);
    else check(`${n} 坏记录(${label})被丢、好记录留住`, o.best.expert && Object.keys(o.best).length === 1, o.best);
  }, `C:${label}`);
}

// resume：样本逐个定罪，坏 resume 不许带走 best
for (const [label, over] of [
  ['ink 缺失', { ink: undefined }],
  ['ink 是字符串', { ink: '0,30,1,3' }],
  ['ink 长度奇数', { ink: [0, 30, 1] }],
  ['ink 值越界', { ink: [0, 30, 7, 3] }],
  ['ink 游程为 0', { ink: [0, 0, 1, 3] }],
  ['ink 游程负数', { ink: [0, -3, 1, 3] }],
  ['ink 展开超过 cells', { ink: [0, 300] }],
  ['cells 越界', { cells: 999999 }],
  ['cells 是 0', { cells: 0 }],
  ['elapsedMs 负数', { elapsedMs: -1 }],
  ['moves 是字符串', { moves: '6' }],
  ['tier 缺失', { tier: undefined }],
  ['seed 是对象', { seed: { a: 1 } }],
  ['整段是数组', null],
]) {
  const raw = over === null ? [] : goodResume(over);
  keep({ ...goodSave(), resume: Array.isArray(raw) ? raw : raw }, (o, n) => {
    check(`${n} 坏 resume(${label}) 被丢`, o.resume === null, o.resume);
    check(`${n} 坏 resume(${label}) 不伤 best`, Object.keys(o.best).length === 2, o.best);
    check(`${n} 坏 resume(${label}) 不伤 settings`, o.settings.reduceMotion === true, o.settings);
  }, `D:${label}`);
}

// settings：坏键回落默认，好键照收
keep({ settings: { sound: 'yes', reduceMotion: false } }, (o, n) => {
  check(`${n} sound 类型错回落默认`, o.settings.sound === true, o.settings);
  check(`${n} reduceMotion 合法值保留`, o.settings.reduceMotion === false, o.settings);
}, 'E');

// totals：越界/类型错只打掉本字段
keep({ totals: { solved: '7', hints: -2, ms: 5000 } }, (o, n) => {
  check(`${n} totals 逐字段定罪`, o.totals.solved === 0 && o.totals.hints === 0 && o.totals.ms === 5000, o.totals);
}, 'F');

// 全合法存档必须原样往返（解码不许顺手把好东西也洗掉）
const rt = decodeSave(JSON.stringify(goodSave()));
check('合法存档原样往返', same(rt, goodSave()), rt);

// ---- 真对象层：解码后的 data 走 Store 的读写路径不能抛 ----
import { Store } from '../js/store.js';
const hostile = [
  { best: null, resume: null, settings: null, totals: null },
  { best: { regular: { ms: 'x' } }, resume: { ink: 'junk' }, settings: 7, totals: 'nope' },
  { best: { regular: GOOD_BEST }, resume: goodResume({ ink: [0, 30, 1, 3, 2, 3] }), settings: { sound: true }, totals: {} },
];
for (const [i, raw] of hostile.entries()) {
  const data = decodeSave(JSON.stringify(raw));
  const prev = Store.data;
  Store.data = data;
  try {
    Store.best('regular');
    Store.recordBest('regular', { ms: 1000, hints: 0, moves: 10, size: 36 });
    Store.recordSolve(1000, 0);
    Store.resume();
    Store.saveResume({ originSeed: 's', tier: 'regular', seed: 's' }, new Uint8Array([0, 1, 2, 1]), 500, { moves: 2, hints: 1 });
    Store.clearResume();
    check(` hostile[${i}] 全链路不抛`, true);
  } catch (e) {
    check(`hostile[${i}] 全链路不抛`, false, String(e));
  }
  Store.data = prev;
}

console.log(`存档解码闸：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  for (const f of fails) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log(`结论：✅ ${pass} 条断言 / 12 类垃圾样本全部逐条定罪——坏一条只丢那条（best 逐条、resume 逐段、settings+totals 逐键），合法存档原样往返`);
