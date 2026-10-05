// 关卡内帧率对拍闸 + 暂停/重开/静音的行为定罪闸（无浏览器、无依赖）。
//
// 为什么再来一个闸：官方探针 cos_frame_probe.js 用 vm.runInContext 逐文件跑脚本，
// 解析不了本仓的 ESM `import`，对本仓只能打「结论：无法比对」；tools/frame_gate.mjs 量的是
// fx 模块自己那一段仿真（关卡外）。规范 §3 要的是**真的进了关卡**：走 main.js 的开机、
// begin() 开局、真实 tap/stroke/hint/undo/pause/restart 事件流，再按 30/60/120Hz 喂同样的
// 虚拟时长逐字段对拍。本闸把整张应用图（index.html 的 id 集合 + js/main.js）装进 DOM 桩里跑。
//
// 三条口径（都是前面几棒踩过的坑）：
//  ① 时钟从 1000ms 起，别从 0 起 —— 否则首帧被 lastTime===0 那类哨兵吃掉，凭空造依赖；
//  ② 事件按**精确虚拟时刻**触发，不等帧边界对齐 —— 不然 30Hz 的注入点天然比 120Hz 晚 8ms，
//     量到的差异里混着"注入时刻不同"而不是"积分步长不同"；
//  ③ 末帧把时钟钉到 1000+V*1000 的整值 —— 1000/60 的浮点亏损会让定步长累加器少跑一步，凭空判红。
// 合法误差只有一个定步长：位移 ≤|v|·STEP、寿命/时钟 ≤STEP、结算步数差 ≤1。
//
// 阴性对照按 §6 的口径钉在仍在吃帧 dt 的那一行（fx.js 的 `accum += dt`）：整仓复制到临时目录、
// 改成 `accum += 1 / 60` 再跑一遍三档 ⇒ 步数极差必须 ≥20，否则本闸是空跑的。
//
// 跑法：node tools/level_gate.mjs            （父进程：三档对拍 + 变异对照）
//       node tools/level_gate.mjs --boot …  （子进程：装载并跑一档，末态打 JSON）
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');

// ---------------------------------------------------------------- 子进程模式

const BOOT = process.argv.some((a) => a === '--boot' || a.startsWith('--boot='));
if (BOOT) {
  const arg = (name, dflt) => {
    const m = process.argv.find((a) => a.startsWith(`--${name}=`));
    return m ? m.slice(name.length + 3) : dflt;
  };
  const root = path.resolve(arg('root', REPO));
  const hz = Number(arg('hz', 60));
  const VIRTUAL = Number(arg('virtual', 3));
  await bootAndRun({ root, hz, virtual: VIRTUAL });
} else {
  parentRun();
}

// 把浏览器那一层桩出来，装 main.js，按 hz 喂 virtual 秒，回传末态与行为定罪。
async function bootAndRun({ root, hz, virtual }) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));

  let clock = 1000; // 口径 ①
  const RealDate = Date;
  class VDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }

  // Math.random 必须是可复现的：begin() 不传 seed 时用它，对拍三档得走同一条流。
  let rs = 0x2f6e2b1;
  const Random = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
  const MathStub = new Proxy(globalThis.Math, { get: (o, k) => (k === 'random' ? Random : o[k]) });

  const ctx2d = new Proxy({
    canvas: null, globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({ setTransform() {} }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    setTransform() {}, save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, arcTo() {}, ellipse() {}, rect() {}, roundRect() {}, fill() {}, stroke() {}, strokeRect() {},
    fillRect() {}, clearRect() {}, fillText() {}, strokeText() {}, setLineDash() {}, drawImage() {},
    clip() {}, translate() {}, rotate() {}, scale() {},
  }, {
    get: (o, k) => (k in o ? o[k] : () => {}),
    set: (o, k, v) => { o[k] = v; return true; },
  });

  const statStub = { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
  const elCache = new Map();
  let audioCtxCount = 0;
  let oscCount = 0;
  let suspendCalls = 0;
  let resumeCalls = 0;
  function makeEl(id) {
    const listeners = {};
    const el = {
      id, hidden: false, disabled: false, textContent: '', innerHTML: '', value: '1', checked: false,
      width: 900, height: 900, clientWidth: 900, clientHeight: 900, offsetWidth: 900, offsetHeight: 900,
      scrollTop: 0, children: [], childElementCount: 0, dataset: {},
      classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); }, toggle(c, f) { const w = f === undefined ? !this._s.has(c) : !!f; w ? this._s.add(c) : this._s.delete(c); return w; }, contains(c) { return this._s.has(c); } },
      style: new Proxy({ setProperty() {}, removeProperty() {}, getPropertyValue: () => '' }, { get: (o, k) => (k in o ? o[k] : ''), set: (o, k, v) => { o[k] = v; return true; } }),
      addEventListener(t, cb) { (listeners[t] = listeners[t] || []).push(cb); },
      removeEventListener(t, cb) { listeners[t] = (listeners[t] || []).filter((f) => f !== cb); },
      dispatch(ev) { (listeners[ev.type] || []).forEach((f) => f(ev)); },
      _listeners: listeners,
      setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
      appendChild(c) { this.children.push(c); this.childElementCount = this.children.length; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      insertBefore(c) { return this.appendChild(c); }, remove() {},
      querySelector: () => makeEl('sub'), querySelectorAll: () => [],
      closest: () => statStub, contains: () => false, matches: () => false,
      focus() {}, blur() {}, scrollIntoView() {}, click() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 900, width: 900, height: 900, x: 0, y: 0 }),
      getClientRects: () => [],
      setPointerCapture() {}, releasePointerCapture() {},
      getContext: () => ctx2d, toDataURL: () => '',
    };
    return el;
  }
  const docEl = makeEl('html');
  const bodyEl = makeEl('body');
  const doc = {
    getElementById(i) { if (!ids.has(i)) return null; if (!elCache.has(i)) elCache.set(i, makeEl(i)); return elCache.get(i); },
    querySelector(sel) { const id = (sel || '').replace(/^#/, ''); if (!ids.has(id)) return makeEl(sel); if (!elCache.has(id)) elCache.set(id, makeEl(id)); return elCache.get(id); },
    querySelectorAll: () => [],
    createElement: (t) => makeEl('c-' + t),
    createTextNode: (t) => ({ textContent: String(t) }),
    documentElement: docEl, body: bodyEl, head: makeEl('head'),
    addEventListener() {}, removeEventListener() {}, activeElement: null, fullscreenElement: null,
    exitFullscreen: () => Promise.resolve(), visibilityState: 'visible', hidden: false, title: '',
  };

  let rafQ = [];
  const timers = [];
  let timerId = 1;
  const store = new Map();
  const win = {
    document: doc, console: { log() {}, warn() {}, error() {} },
    requestAnimationFrame(cb) { rafQ.push(cb); return rafQ.length; },
    cancelAnimationFrame() {},
    setTimeout(cb, ms) { const id = timerId++; timers.push({ at: clock + Math.max(0, Number(ms) || 0), cb, id }); return id; },
    setInterval(cb, ms) { const iv = Math.max(1, Number(ms) || 1), id = timerId++; timers.push({ at: clock + iv, cb, id, iv }); return id; },
    clearTimeout(id) { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    clearInterval(id) { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    performance: { now: () => clock },
    Date: VDate, Math: MathStub,
    devicePixelRatio: 2, innerWidth: 1200, innerHeight: 900,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => store.clear(),
    },
    // file:// 形态：pwa.js 的 REGISTRABLE 会跳过 SW 注册，对拍不需要 SW，也不该被它污染。
    location: { href: 'file:///index.html', protocol: 'file:', hash: '', search: '', pathname: '/index.html', origin: 'file://', host: '', hostname: '' },
    navigator: { userAgent: 'level-gate', maxTouchPoints: 1, serviceWorker: undefined },
    history: { pushState() {}, replaceState() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    Image: function () { return { complete: true, naturalWidth: 64, naturalHeight: 64, width: 64, height: 64, src: '', addEventListener() {}, decode: () => Promise.resolve() }; },
    AudioContext: function () {
      audioCtxCount++;
      const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
      const ac = {
        currentTime: 0, sampleRate: 44100, state: 'running', destination: {},
        createOscillator: () => { oscCount++; return { type: 'sine', frequency: param(), connect(d) { return d; }, disconnect() {}, start() {}, stop() {} }; },
        createGain: () => ({ gain: param(), connect(d) { return d; }, disconnect() {} }),
        createBuffer: () => ({ getChannelData: () => new Float32Array(64) }),
        // 状态必须真的翻：静音定罪要问的就是"上下文是不是被停下来了"，
        // 一个永远 running 的桩会把假静音洗成绿。
        resume() { if (ac.state !== 'running') { resumeCalls++; ac.state = 'running'; ctxState = 'running'; } return Promise.resolve(); },
        suspend() { suspendCalls++; ac.state = 'suspended'; ctxState = 'suspended'; return Promise.resolve(); },
        close: () => { ac.state = 'closed'; ctxState = 'closed'; return Promise.resolve(); },
      };
      ctxState = ac.state;
      return ac;
    },
  };
  win.window = win; win.self = win; win.global = win;

  // 只覆盖"浏览器语义"的那几个全局；node 原生的（URL/TextEncoder/…）保持原生。
  const FORCE = ['window', 'self', 'global', 'document', 'navigator', 'location', 'localStorage', 'Image',
    'AudioContext', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'matchMedia', 'devicePixelRatio', 'innerWidth', 'innerHeight',
    'addEventListener', 'removeEventListener', 'getComputedStyle', 'performance', 'dispatchEvent', 'history', 'console'];
  // node 22 把 navigator 这类名字做成了只读访问器，直接赋值会抛
  // "Cannot set property navigator of #<Object> which has only a getter" ⇒ 只能用 defineProperty。
  const put = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
  for (const k of FORCE) put(k, win[k]);
  put('Date', VDate);
  put('Math', MathStub);

  let ctxState = 'none';
  const S = {
    audioCtx: () => audioCtxCount,
    osc: () => oscCount,
    suspend: () => suspendCalls,
    resume: () => resumeCalls,
    ctxState: () => ctxState,
  };

  // 装整张应用图：index.html 的入口就是 js/main.js（`<script type="module" src="js/main.js">`）。
  // 装载失败必须当场报，不能让它伪装成"三档对拍不一致"。
  await import(pathToFileURL(path.join(root, 'js/main.js')).href);
  if (!win.slant || typeof win.slant.begin !== 'function') {
    process.stdout.write(JSON.stringify({ bootError: 'js/main.js 装载后 window.slant 没出现', root, hz }));
    process.exit(3);
  }

  // ---- 关卡内事件脚本：精确虚拟时刻触发（口径 ②），三档走完全相同的时序 ----
  const SCRIPT = [
    [0, () => win.slant.begin({ tier: 'apprentice', seed: 'LEVEL-GATE' })],
    [120, () => win.slant.tap(0)],
    [200, () => win.slant.tap(4)],
    [260, () => win.slant.stroke([7, 8, 9], 2)],
    [340, () => win.slant.useHint()],
    [520, () => win.slant.tap(13)],
    [700, () => win.slant.undo()],
    [860, () => win.slant.setPaused(true)],
    [1880, () => win.slant.setPaused(false)],
    [2200, () => win.slant.useHint()],
    [2500, () => win.slant.restart()],
    [2850, () => win.slant.tap(2)],
  ];

  // 静音定罪的四段（规范 §2「静音态不得再新建振荡器节点」＋「真停 AudioContext」）：
  //  ① 上下文还没建时关声：不许为了"停"它而顺手 new 一个；此时放音效必须一个节点都不建。
  //  ② 开声放 7 种音效：必须真建出上下文与振荡器（否则后面三段无从谈起）。
  //  ③ 已有上下文时再关声：必须 suspend 它，且再放 7 种音效不得新增振荡器/上下文/resume。
  //  ④ 再开声：必须 resume 同一个上下文并重新出声。
  const KINDS7 = ['place', 'rub', 'hint', 'conflict', 'win', 'undo', 'erase'];
  const muteProbe = (() => {
    const snap = () => ({ ctx: S.audioCtx(), osc: S.osc(), susp: S.suspend(), res: S.resume(), state: S.ctxState() });
    const off0 = snap();
    win.slant.sound.setEnabled(false);
    KINDS7.forEach((k) => win.slant.sound[k]());
    const mutedNoCtx = snap();
    win.slant.sound.setEnabled(true);
    KINDS7.forEach((k) => win.slant.sound[k]());
    const sounded = snap();
    win.slant.sound.setEnabled(false);
    const suspended = snap();
    KINDS7.forEach((k) => win.slant.sound[k]());
    const mutedAgain = snap();
    win.slant.sound.setEnabled(true);
    KINDS7.forEach((k) => win.slant.sound[k]());
    const soundedAgain = snap();
    win.slant.sound.setEnabled(false);
    return { off0, mutedNoCtx, sounded, suspended, mutedAgain, soundedAgain };
  })();

  // ---- 驱动：帧边界 + 事件时刻 + 定时器到期，全部按精确时间排序推进 ----
  // 同一个虚拟时刻既可能是帧边界又可能是注入点（120Hz 下 200/700/2200/2500/2850 全是整数倍）。
  // 这里必须**合并**而不是覆盖：早先事件标记把 frame 抹掉，那些帧就被静悄悄吞了，
  // 每档吞的帧数还不一样 —— 量出来的"帧率依赖"是尺子造的，不是游戏的。
  const round = (v) => Math.round(v * 1e6) / 1e6;
  const step = 1000 / hz;
  const frames = Math.round(virtual * hz);
  const marks = new Map();
  const mark = (t, isFrame) => {
    const k = round(t);
    const m = marks.get(k) || { frame: false };
    if (isFrame) m.frame = true;
    marks.set(k, m);
  };
  for (let i = 1; i <= frames; i++) mark(i === frames ? 1000 + virtual * 1000 : 1000 + i * step, true); // 口径 ③：末帧钉整值
  for (const [at] of SCRIPT) mark(1000 + at, false);

  const timeline = [...marks.entries()].sort((a, b) => a[0] - b[0]);
  const events = SCRIPT.map(([at, fn]) => ({ at: round(1000 + at), fn, done: false }));
  let maxEventErr = 0;

  const runFrame = () => {
    const q = rafQ; rafQ = [];
    for (const cb of q) cb(clock);
  };
  const runTimers = () => {
    for (const t of timers) {
      if (t.dead || t.at > clock) continue;
      if (t.iv) t.at = clock + t.iv; else t.dead = true;
      try { t.cb(); } catch { /* 定时器回调不许打断推进 */ }
    }
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].dead) timers.splice(i, 1);
  };

  for (const [t, meta] of timeline) {
    clock = t;
    if (meta.frame) runFrame();
    for (const e of events) {
      if (!e.done && e.at <= t) { e.done = true; e.fn(); maxEventErr = Math.max(maxEventErr, Math.abs(clock - e.at)); }
    }
    if (meta.frame) runTimers();
  }
  clock = 1000 + virtual * 1000;

  // 三档对拍用的末态必须在暂停/重开那两段之前取：那两段会 begin() 新盘、把状态与 HUD 覆盖掉。
  const snapMain = {
    state: win.slant.state(),
    fx: win.slant.fxState(),
    readout: {
      time: doc.querySelector('#stat-time').textContent,
      moves: doc.querySelector('#stat-moves').textContent,
      hints: doc.querySelector('#stat-hints').textContent,
      filled: doc.querySelector('#stat-filled').textContent,
      satisfied: doc.querySelector('#stat-satisfied').textContent,
      conflicts: doc.querySelector('#stat-conflicts').textContent,
      score: doc.querySelector('#stat-score').textContent,
      hintRule: doc.querySelector('#hint-rule').textContent,
    },
    save: store.size,
  };

  // 暂停/重开的行为定罪（就在这一档里量，三档都跑同样断言）
  const pauseTruth = (() => {
    const g = win.slant;
    g.begin({ tier: 'regular', seed: 'PAUSE-GATE' });
    g.tap(1); g.useHint();
    const elapsedBefore = g.elapsed();
    const fxBefore = g.fxState();
    let maxFxTime = fxBefore.time;
    g.setPaused(true);
    const pausedAt = clock;
    for (let i = 0; i <= 60; i++) { clock = pausedAt + i * (5000 / 60); runFrame(); }
    const fxDuring = g.fxState();
    const elapsedDuringPause = g.elapsed();
    clock = pausedAt + 5000;
    runFrame();
    g.setPaused(false);
    const elapsedAfterResume = g.elapsed();
    clock = pausedAt + 5400;
    runFrame();
    const elapsedLater = g.elapsed();
    for (let i = 0; i < 30; i++) { clock += 20; runFrame(); }
    const fxAfter = g.fxState();
    maxFxTime = Math.max(maxFxTime, fxDuring.time);
    return {
      pausedForMs: 5000,
      elapsedFrozen: elapsedAfterResume - elapsedBefore,
      fxTimeFrozen: +(fxDuring.time - fxBefore.time).toFixed(9),
      elapsedTicks: +(elapsedLater - elapsedBefore).toFixed(3),
      fxAdvanced: +(fxAfter.time - fxDuring.time).toFixed(6),
      stateOk: g.state().status === 'playing',
    };
  })();

  const restartTruth = (() => {
    const g = win.slant;
    g.begin({ tier: 'regular', seed: 'RESTART-GATE' });
    for (let t = 0; t < 12; t++) g.tap(t);
    g.useHint(); g.useHint();
    for (let i = 0; i < 40; i++) { clock += 16; runFrame(); }
    const pick = () => {
      const s = g.state();
      const f = g.fxState();
      return { moves: s.moves, hints: s.hints, filled: s.filled, steps: s.steps, cursor: s.cursor, remaining: s.remaining, elapsedMs: Math.round(s.elapsedMs), fxTime: +f.time.toFixed(6), accum: +f.accum.toFixed(6), particles: f.count, rings: f.rings };
    };
    const before = pick();
    const clueBefore = Array.from(g.game.board.clue).join(',');
    g.restart();
    const after = pick(); // 立刻读：晚一帧就像"计时没归零"
    for (let i = 0; i < 40; i++) { clock += 16; runFrame(); }
    const resumed = pick();
    return {
      boardSame: clueBefore === Array.from(g.game.board.clue).join(','),
      before, after, resumed,
    };
  })();

  const out = {
    hz, virtual,
    frames,
    eventLagMs: maxEventErr,
    state: { ...snapMain.state, elapsedMs: Math.round(snapMain.state.elapsedMs) },
    fx: snapMain.fx,
    readout: snapMain.readout,
    save: snapMain.save,
    audio: { ctx: S.audioCtx(), osc: S.osc(), suspend: S.suspend(), resume: S.resume() },
    muteProbe,
    pauseTruth,
    restartTruth,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

// ------------------------------------------------------------------ 父进程

function parentRun() {
  const TIERS = [30, 60, 120];
  const VIRTUAL = 3;
  const STEP = 1 / 120;
  const GRAV = 900;

  const boot = (root, hz) => {
    const raw = execFileSync(process.execPath, [path.join(HERE, 'level_gate.mjs'), `--boot=1`, `--root=${root}`, `--hz=${hz}`, `--virtual=${VIRTUAL}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const i = raw.indexOf('{');
    if (i < 0) throw new Error('子进程没吐出 JSON：' + raw.slice(0, 200));
    return JSON.parse(raw.slice(i));
  };

  const R = {};
  for (const hz of TIERS) R[hz] = boot(REPO, hz);

  const ref = R[60];
  // 参考档必须真的在关卡里跑着：粒子在飞、环在亮、棋盘上有字，否则对拍窗口选错（尺子空跑）。
  const alive = ref.fx.head.length > 0 && ref.fx.count > 0 && ref.state.moves > 0 && ref.state.filled > 0;
  const p = ref.fx.head[0] || { vx: 0, vy: 0, vr: 0, age: 0 };
  const tol = {
    x: Math.abs(p.vx) * STEP + 0.05,
    y: Math.abs(p.vy) * STEP + GRAV * STEP * STEP + 0.05,
    rot: Math.abs(p.vr) * STEP + 0.002,
    age: STEP + 0.002,
    time: STEP + 1e-9,
    accum: STEP + 1e-9,
  };

  console.log(`关卡内帧率对拍（seed=LEVEL-GATE 虚拟 ${VIRTUAL}s，帧距 ${TIERS.map((h) => (1000 / h).toFixed(3)).join(' / ')} ms，事件按精确虚拟时刻注入）`);
  console.log(`  ${alive ? '✅' : '❌'} 参考档确实在关卡内：state=${ref.state.status} moves=${ref.state.moves} hints=${ref.state.hints} filled=${ref.state.filled}/${ref.state.total} satisfied=${ref.state.satisfied}/${ref.state.clues} 光标=${ref.state.cursor} 粒子=${ref.fx.count} 环=${ref.fx.rings} 仿真=${ref.fx.time.toFixed(4)}s`);
  console.log(`  参考档 60Hz 首粒子 v=(${p.vx.toFixed(1)},${p.vy.toFixed(1)}) 容差 x≤${tol.x.toFixed(3)}px y≤${tol.y.toFixed(3)}px age≤${tol.age.toFixed(4)}s`);

  const fails = [];
  let pass = alive ? 1 : 0;
  if (!alive) fails.push('参考档没进玩法态（粒子/落子为零）——对拍窗口选错，本闸会空跑');

  // 逐字段：状态机字段要求**精确相等**（都是事件驱动的整数/字符串，不该有帧率余地），
  // 只有仿真量允许一个定步长的尾差。
  const EXACT = ['moves', 'hints', 'filled', 'total', 'satisfied', 'clues', 'conflicts', 'remaining', 'cursor', 'steps', 'status', 'score', 'seed', 'tier'];
  for (const hz of TIERS) {
    if (hz === 60) continue;
    const o = R[hz];
    const q = o.fx.head[0] || {};
    const d = {
      x: Math.abs((q.x ?? 0) - p.x), y: Math.abs((q.y ?? 0) - p.y),
      rot: Math.abs((q.rot ?? 0) - p.rot), age: Math.abs((q.age ?? 0) - p.age),
      time: Math.abs(o.fx.time - ref.fx.time), accum: Math.abs(o.fx.accum - ref.fx.accum),
    };
    const ratios = { 'Δx/容差': +(d.x / tol.x).toFixed(3), 'Δy/容差': +(d.y / tol.y).toFixed(3), 'Δrot/容差': +(d.rot / tol.rot).toFixed(3), 'Δage/容差': +(d.age / tol.age).toFixed(3), 'Δtime/容差': +(d.time / tol.time).toFixed(3) };
    const worst = Math.max(...Object.values(ratios));
    const stepDiff = Math.abs(Math.round(o.fx.time / STEP) - Math.round(ref.fx.time / STEP));
    const cntDiff = o.fx.count - ref.fx.count;
    const exactBad = EXACT.filter((k) => String(o.state[k]) !== String(ref.state[k]));
    const readoutBad = Object.keys(ref.readout).filter((k) => o.readout[k] !== ref.readout[k]);
    console.log(`  ${hz}Hz  Δx=${d.x.toFixed(3)}px Δy=${d.y.toFixed(3)}px Δage=${d.age.toFixed(5)}s Δtime=${d.time.toFixed(6)}s 步数=${Math.round(o.fx.time / STEP)}(Δ${stepDiff}) 存活差=${cntDiff} 存档条数=${o.save}  最坏偏差/容差=${worst.toFixed(2)}  ${ratios['Δx/容差'] <= 1.5 && ratios['Δy/容差'] <= 1.5 ? '' : JSON.stringify(ratios)}`);
    if (worst > 1.5) fails.push(`${hz}Hz 对 60Hz：粒子末态偏差/容差 最坏 ${worst.toFixed(2)}（阈值 1.5）`);
    if (stepDiff > 1) fails.push(`${hz}Hz 对 60Hz：定步长结算步数差 ${stepDiff} 步（>1 步就不是尾差）`);
    if (Math.abs(cntDiff) > 1) fails.push(`${hz}Hz 对 60Hz：存活粒子差 ${cntDiff} 个`);
    if (exactBad.length) fails.push(`${hz}Hz 对 60Hz：状态机字段不等：${exactBad.map((k) => `${k} ${ref.state[k]}≠${o.state[k]}`).join('，')}`);
    if (readoutBad.length) fails.push(`${hz}Hz 对 60Hz：HUD 读数不同：${readoutBad.map((k) => `${k} "${ref.readout[k]}"≠"${o.readout[k]}"`).join('，')}`);
    if (Math.abs(o.state.elapsedMs - ref.state.elapsedMs) > 1) fails.push(`${hz}Hz 对 60Hz：对局计时差 ${o.state.elapsedMs - ref.state.elapsedMs}ms`);
    if (worst <= 1.5 && stepDiff <= 1 && !exactBad.length && !readoutBad.length) pass += 2;
  }
  console.log(`  三档 HUD 读数（60Hz）：时间 ${ref.readout.time} 步数 ${ref.readout.moves} 提示 ${ref.readout.hints} 已画线 ${ref.readout.filled} 凑齐 ${ref.readout.satisfied} 冲突 ${ref.readout.conflicts}`);

  // ---- 行为定罪：暂停 / 重开 / 静音（三档各跑一遍，取最坏值报告）----
  const pt = TIERS.map((h) => R[h].pauseTruth);
  const frozen = Math.max(...pt.map((x) => Math.abs(x.elapsedFrozen)));
  const fxFrozen = Math.max(...pt.map((x) => Math.abs(x.fxTimeFrozen)));
  const advanced = Math.min(...pt.map((x) => x.fxAdvanced));
  console.log(`  暂停定罪：暂停 ${pt[0].pausedForMs}ms 期间对局计时走 ${frozen}ms、仿真时钟走 ${fxFrozen}s；恢复后继续走 ${pt.map((x) => x.fxAdvanced.toFixed(4)).join('/')}s`);
  if (frozen > 1) fails.push(`暂停期间对局计时仍走了 ${frozen}ms（假暂停）`);
  if (fxFrozen > 0) fails.push(`暂停期间仿真时钟仍走了 ${fxFrozen}s（粒子在偷偷往前）`);
  if (!(advanced > 0)) fails.push('恢复后仿真没有继续推进（暂停把时钟弄死了）');
  if (pt.every((x) => x.elapsedTicks >= 0) && frozen <= 1) pass++;

  const rt = TIERS.map((h) => R[h].restartTruth);
  const r0 = rt[0];
  console.log(`  重开定罪：同盘=${r0.boardSame}`);
  console.log(`    重开前 步数=${r0.before.moves} 提示=${r0.before.hints} 已画=${r0.before.filled} 历史=${r0.before.steps} 光标=${r0.before.cursor} 待画=${r0.before.remaining} 计时=${r0.before.elapsedMs}ms 仿真=${r0.before.fxTime}s 尾差=${r0.before.accum} 粒子=${r0.before.particles} 环=${r0.before.rings}`);
  console.log(`    重开后 步数=${r0.after.moves} 提示=${r0.after.hints} 已画=${r0.after.filled} 历史=${r0.after.steps} 光标=${r0.after.cursor} 待画=${r0.after.remaining} 计时=${r0.after.elapsedMs}ms 仿真=${r0.after.fxTime}s 尾差=${r0.after.accum} 粒子=${r0.after.particles} 环=${r0.after.rings}`);
  console.log(`    再跑 40 帧 计时=${r0.resumed.elapsedMs}ms 仿真=${r0.resumed.fxTime}s 步数=${r0.resumed.moves}`);
  const zeroed = ['moves', 'hints', 'filled', 'steps', 'cursor'].every((k) => r0.after[k] === 0)
    && r0.after.elapsedMs === 0 && r0.after.fxTime < STEP && r0.after.particles === 0 && r0.after.rings === 0
    && r0.boardSame && r0.before.moves > 0 && r0.before.filled > 0 && r0.before.elapsedMs > 0 && r0.before.particles > 0;
  const resumed = r0.resumed.elapsedMs >= 600 && r0.resumed.fxTime >= 0.5 && r0.resumed.cursor === 0;
  if (!zeroed) fails.push(`重开没有把计时/仿真时钟/粒子/环/步数/提示/光标全部归零（after=${JSON.stringify(r0.after)}）`);
  if (!resumed) fails.push(`重开后时钟没重新走（resumed=${JSON.stringify(r0.resumed)}）`);
  if (zeroed && resumed) pass++;

  const mp = R[60].muteProbe;
  const d = (a, b, k) => b[k] - a[k];
  console.log(`  静音定罪（四段，节点计数为累计值）：`);
  console.log(`    ① 无上下文时关声后打 7 种音效：新增 ctx=${d(mp.off0, mp.mutedNoCtx, 'ctx')} 新增振荡器=${d(mp.off0, mp.mutedNoCtx, 'osc')} suspend=${d(mp.off0, mp.mutedNoCtx, 'susp')} 状态=${mp.mutedNoCtx.state}`);
  console.log(`    ② 开声后打 7 种音效：新增 ctx=${d(mp.mutedNoCtx, mp.sounded, 'ctx')} 新增振荡器=${d(mp.mutedNoCtx, mp.sounded, 'osc')} 状态=${mp.sounded.state}`);
  console.log(`    ③ 再关声：suspend 次数=${d(mp.sounded, mp.suspended, 'susp')} 状态=${mp.suspended.state}；再打 7 种音效：新增 ctx=${d(mp.suspended, mp.mutedAgain, 'ctx')} 新增振荡器=${d(mp.suspended, mp.mutedAgain, 'osc')} 新增 resume=${d(mp.suspended, mp.mutedAgain, 'res')} 状态=${mp.mutedAgain.state}`);
  console.log(`    ④ 再开声：resume 次数=${d(mp.mutedAgain, mp.soundedAgain, 'res')} 新增振荡器=${d(mp.mutedAgain, mp.soundedAgain, 'osc')} 新增 ctx=${d(mp.mutedAgain, mp.soundedAgain, 'ctx')} 状态=${mp.soundedAgain.state}`);
  if (d(mp.off0, mp.mutedNoCtx, 'ctx') !== 0) fails.push(`静音状态下仍新建了 ${d(mp.off0, mp.mutedNoCtx, 'ctx')} 个 AudioContext`);
  if (d(mp.off0, mp.mutedNoCtx, 'osc') !== 0) fails.push(`静音状态下仍新建了 ${d(mp.off0, mp.mutedNoCtx, 'osc')} 个振荡器`);
  if (d(mp.mutedNoCtx, mp.sounded, 'ctx') !== 1 || d(mp.mutedNoCtx, mp.sounded, 'osc') < 7) fails.push('开声后打 7 种音效没有真建出上下文与振荡器');
  if (d(mp.sounded, mp.suspended, 'susp') < 1 || mp.suspended.state !== 'suspended') fails.push('已有上下文时关声没有真的 suspend');
  if (d(mp.suspended, mp.mutedAgain, 'osc') !== 0 || d(mp.suspended, mp.mutedAgain, 'ctx') !== 0) fails.push(`静音态仍在发声：新增振荡器 ${d(mp.suspended, mp.mutedAgain, 'osc')}、新增上下文 ${d(mp.suspended, mp.mutedAgain, 'ctx')}`);
  if (d(mp.suspended, mp.mutedAgain, 'res') !== 0) fails.push('静音态里还偷偷 resume 了 AudioContext');
  if (d(mp.mutedAgain, mp.soundedAgain, 'res') < 1 || d(mp.mutedAgain, mp.soundedAgain, 'osc') < 7) fails.push('重新开声后没有 resume 或没恢复发声');
  if (d(mp.mutedAgain, mp.soundedAgain, 'ctx') !== 0) fails.push('重新开声时又新建了一个 AudioContext（该复用已有的）');
  const muteOk = d(mp.off0, mp.mutedNoCtx, 'ctx') === 0 && d(mp.off0, mp.mutedNoCtx, 'osc') === 0
    && d(mp.mutedNoCtx, mp.sounded, 'ctx') === 1 && d(mp.mutedNoCtx, mp.sounded, 'osc') >= 7
    && d(mp.sounded, mp.suspended, 'susp') >= 1 && mp.suspended.state === 'suspended'
    && d(mp.suspended, mp.mutedAgain, 'osc') === 0 && d(mp.suspended, mp.mutedAgain, 'ctx') === 0 && d(mp.suspended, mp.mutedAgain, 'res') === 0
    && d(mp.mutedAgain, mp.soundedAgain, 'res') >= 1 && d(mp.mutedAgain, mp.soundedAgain, 'osc') >= 7 && d(mp.mutedAgain, mp.soundedAgain, 'ctx') === 0;
  if (muteOk) pass++;

  // ---- 阴性对照（§6 口径）：把仍在吃帧 dt 的 accum += dt 改成 accum += 1/60，本闸必须变红 ----
  const FX = path.join(REPO, 'js/render/fx.js');
  const src = fs.readFileSync(FX, 'utf8');
  const NEEDLE = 'accum += dt;';
  let ctrl = { red: false, detail: '' };
  if (!src.includes(NEEDLE)) {
    ctrl.detail = '检不到 accum += dt —— 口径已变，需更新本闸的变异靶子';
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slant-level-'));
    fs.cpSync(REPO, tmp, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules|dist|build|tools[\\/]shots)[\\/]/.test(s + '/') });
    fs.writeFileSync(path.join(tmp, 'js/render/fx.js'), src.replace(NEEDLE, 'accum += 1 / 60; // __MUTATION__'));
    const M = {};
    for (const hz of TIERS) M[hz] = boot(tmp, hz);
    const steps = TIERS.map((h) => Math.round(M[h].fx.time / STEP));
    const spread = Math.max(...steps) - Math.min(...steps);
    const dev = Math.max(...TIERS.filter((h) => h !== 60).map((h) => {
      const q = M[h].fx.head[0] || { x: 0, y: 0 };
      return Math.max(Math.abs(q.x - p.x) / tol.x, Math.abs(q.y - p.y) / tol.y);
    }));
    ctrl = {
      red: spread >= 20 || dev > 5,
      detail: `变异 accum += dt → accum += 1/60：三档仿真步数 ${steps.join('/')}（极差 ${spread}），首粒子对 60Hz 偏差/容差 = ${dev.toFixed(1)}，HUD 时间 ${TIERS.map((h) => M[h].readout.time).join('/')}`,
    };
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`  阴性对照：${ctrl.red ? '✅ 变异后确实变红' : '❌ 变异后仍判绿 → 本闸空跑'} ${ctrl.detail}`);
  if (!ctrl.red) fails.push('阴性对照未变红（尺子空跑）');
  else pass++;

  console.log(`关卡内闸：${pass} 项通过，${fails.length} 项失败`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  console.log(fails.length ? '结论：❌ 关卡内状态在 30/60/120Hz 下不收敛，或行为定罪未成立' : '结论：✅ 同一事件流在关卡内跑满 3s，三档逐字段（状态机精确等 + 仿真量≤一步定步长）收敛，暂停/重开/静音行为成立，且尺子经阴性对照自证非空跑');
  process.exit(fails.length ? 1 : 0);
}
