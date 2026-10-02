// 粒子与脉冲的时钟。这里唯一的时间来源是 step(elapsedMs)：一切积分都乘 dt，
// 一帧的推进量绝不带 1/60 这种"假设每秒 60 帧"的常数。
//
// 为什么用定步长累加器而不是直接 dt：定步长让 30/60/120Hz 在同样的虚拟时长里跑
// 同样的步数，状态对拍可以做到逐字段几乎零漂移；直接 dt 的欧拉积分会因步数不同
// 留下肉眼可见的差别（尤其重力的位移项）。累加器只要还在消费真实 elapsed，
// 帧率就只影响"多久结算一次"，不影响"结算多少"。

const STEP = 1 / 120; // 定步长（秒）
const GRAV = 900; // px/s²
const MAX_PARTICLES = 220;

const KINDS = {
  place: { count: 7, spread: 150, up: -190, life: 0.5, size: 7, sprite: 'spark-amber', dye: '#f0a63c' },
  rub: { count: 5, spread: 110, up: -110, life: 0.4, size: 6, sprite: 'spark-blue', dye: '#67b6e6' },
  hint: { count: 4, spread: 80, up: -140, life: 0.45, size: 6, sprite: 'spark-green', dye: '#7ed4a0' },
  win: { count: 46, spread: 320, up: -360, life: 1.15, size: 9, sprite: 'shard-amber', dye: '#f0a63c' },
};

export function createFx({ sprites = null, reduceMotion = false, now = () => performance.now() } = {}) {
  let accum = 0;
  let last = now();
  let time = 0; // 已结算的仿真时间（秒）
  let particles = [];
  let rings = [];
  let shake = 0;

  const rand = (() => {
    let s = 20261002;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  })();

  // 每帧只把"真正过去了多少秒"记进累加器；结算循环从这里取定步长。
  function feed() {
    const t = now();
    let elapsed = (t - last) / 1000;
    last = t;
    if (!(elapsed > 0)) return 0;
    if (elapsed > 0.25) elapsed = 0.25; // 切后台回来不补算一整套宇宙
    accum += elapsed;
    return elapsed;
  }

  function integrate(dt) {
    time += dt;
    for (const p of particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += GRAV * dt;
      p.vx *= 1 - 0.9 * dt;
      p.rot += p.vr * dt;
      p.age += dt;
    }
    particles = particles.filter((p) => p.age < p.ttl);
    for (const r of rings) r.age += dt;
    rings = rings.filter((r) => r.age < r.ttl);
    shake *= Math.pow(0.82, dt * 60);
    if (shake < 0.05) shake = 0;
  }

  // 一帧最多追 8 步：掉帧时宁可让粒子慢半拍，也不在这一帧里卡住主线程。
  function step(cappedElapsedMs = null) {
    if (cappedElapsedMs != null) accum += cappedElapsedMs / 1000;
    let n = 0;
    while (accum >= STEP && n < 8) {
      accum -= STEP;
      integrate(STEP);
      n++;
    }
    if (accum > STEP * 8) accum = 0;
    return n;
  }

  function burst(kind, cx, cy, scale = 1) {
    if (reduceMotion) return 0; // 省动效：不放粒子，脉冲退化成静态环（见 ring）
    const k = KINDS[kind] || KINDS.place;
    let added = 0;
    for (let i = 0; i < k.count; i++) {
      if (particles.length >= MAX_PARTICLES) break;
      const a = rand() * Math.PI * 2;
      const sp = (0.35 + rand() * 0.65) * k.spread * scale;
      particles.push({
        kind,
        x: cx + (rand() - 0.5) * 10 * scale,
        y: cy + (rand() - 0.5) * 10 * scale,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + k.up * scale,
        rot: rand() * Math.PI,
        vr: (rand() - 0.5) * 9,
        age: 0,
        ttl: k.life * (0.7 + rand() * 0.6),
        size: k.size * (0.7 + rand() * 0.7) * scale,
        sprite: k.sprite,
        dye: k.dye,
      });
      added++;
    }
    return added;
  }

  // 提示脉冲：寿命由仿真时钟结算，不再挂 setTimeout——120Hz 与 30Hz 下它
  // 消失的时刻相同，且被暂停/重开清掉时不会出现"定时器还在跑"的幽灵高亮。
  function ring(cell, node, ttl = 1.6, color = null) {
    const r = { cell, node, age: 0, ttl: reduceMotion ? 0.0001 : ttl, color, static: reduceMotion };
    rings.push(r);
    return r;
  }

  // 交给渲染层：t 是 0→1 的进度，opacity/scale 都由它算，跟帧率无关。
  function active() {
    return rings.map((r) => ({
      cell: r.cell,
      node: r.node,
      color: r.color,
      t: r.static ? 1 : Math.min(1, r.age / r.ttl),
      fade: r.static ? 0.85 : 1 - Math.min(1, r.age / r.ttl),
    }));
  }

  function render(ctx, w, h, dpr = 1) {
    if (!particles.length) {
      if (ctx.__slantDirty) {
        ctx.clearRect(0, 0, w, h);
        ctx.__slantDirty = false;
      }
      return 0;
    }
    ctx.__slantDirty = true;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      const k = Math.max(0, 1 - p.age / p.ttl);
      const img = sprites && sprites[p.sprite];
      ctx.globalAlpha = k * 0.9;
      if (img && img.complete) {
        const s = p.size * (0.6 + k * 0.7);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.drawImage(img, -s / 2, -s / 2, s, s);
        ctx.restore();
      } else {
        ctx.fillStyle = p.dye;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;
    return particles.length;
  }

  return {
    step,
    feed,
    burst,
    ring,
    active,
    render,
    shake,
    reset() {
      particles = [];
      rings = [];
      accum = 0;
      shake = 0;
      last = now();
    },
    setReduceMotion(v) {
      reduceMotion = !!v;
      if (reduceMotion) particles = [];
    },
    state: () => ({
      time,
      accum,
      count: particles.length,
      rings: rings.length,
      // 环进度也进对拍：它是唯一决定"高亮何时消失"的量，帧率相关就必然在这里露出来
      pulse: active().map((r) => Math.round(r.t * 1000) / 1000),
      // 对拍用：位置量化到 0.01px，避免尾数噪声盖掉真差异
      head: particles.slice(0, 6).map((p) => ({
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        rot: Math.round(p.rot * 1000) / 1000,
        age: Math.round(p.age * 1000) / 1000,
        vx: Math.round(p.vx * 100) / 100,
        vy: Math.round(p.vy * 100) / 100,
        vr: Math.round(p.vr * 1000) / 1000,
      })),
    }),
  };
}

export const FX_STEP = STEP;
