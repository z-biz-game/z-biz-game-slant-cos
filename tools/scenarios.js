// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not a
// flag. A `.hidden` boolean says what the code intended; a client rect and a pixel say what the
// player got. The interesting failures in this game are exactly the ones where the state is right
// and the picture or the click is wrong — a line drawn in the engine but painted the other way on
// screen, or a node whose number says one thing while its ring says another.
//
// window.slant.engine is the shipped module graph, so a scenario that passes here has passed on
// the same solver the player's hints come from — not a second copy kept for testing.
//
// ck(name, condition, detail) is truthiness; eq(name, got, want) is equality. Mixing them up is
// how `ck('count', 0)` reads as a failure to a human and a pass to a boolean — every "must equal"
// below therefore goes through eq.

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // rows is copied, not aliased: the array is cleared below, and a live reference would hand
    // back an empty report that still reads as "0 failed".
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const A = () => w.slant;
  const E = () => w.slant.engine;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  function pointer(type, x, y) {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }
  const at = (t) => {
    const r = A().view.cellRect(t);
    const box = A().view.canvas.getBoundingClientRect();
    return { x: box.left + r.x + r.size / 2, y: box.top + r.y + r.size / 2, size: r.size };
  };
  async function tap(t) {
    const p = at(t);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    return wait(24);
  }
  async function drag(from, to) {
    const a = at(from);
    const b = at(to);
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (a.size / 3)));
    pointer('pointerdown', a.x, a.y);
    for (let i = 1; i <= steps; i++) {
      pointer('pointermove', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    }
    pointer('pointerup', b.x, b.y);
    return wait(24);
  }

  const hex = (h) => {
    const m = String(h).replace('#', '');
    return m.length < 6 ? [-1, -1, -1] : [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const rgb = (s) => {
    const m = String(s).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [-1, -1, -1];
  };
  const near = (p, c, tol = 10) => p.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);
  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    const p = v.ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  // A point on the diagonal itself: the middle of the cell, which is where any line through the
  // cell must pass.
  const linePixel = (t) => {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size / 2, r.y + r.size / 2);
  };
  // A point that only one of the two diagonals crosses: the top-right half of the cell.
  const cornerPixel = (t, which) => {
    const r = A().view.cellRect(t);
    const off = r.size * 0.26;
    return which === 'slash' ? pixel(r.x + r.size * 0.72, r.y + off) : pixel(r.x + r.size * 0.72, r.y + r.size - off);
  };
  const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[(a.length - 1) >> 1] : NaN);
  const sum = (arr) => arr.reduce((a, v) => a + v, 0);

  // ---------- engine ----------

  const engine = async () => {
    const en = E();
    ck('页面挂出了可测的引擎', !!(en && en.createBoard && en.solve));
    eq('格子的三个状态', `${en.OPEN},${en.SLASH},${en.BACK}`, '0,1,2');
    eq('没有数字的哨兵是 -1', en.NO_CLUE, -1);
    eq('规则表里有四条', Object.keys(en.Rules).length, 4);
    eq('档位有五级', en.TIERS.length, 5);
    let ordered = true;
    for (let i = 1; i < en.TIERS.length; i++) {
      if (!(en.TIERS[i].band[0] > en.TIERS[i - 1].band[0])) ordered = false;
      if (!(en.TIERS[i].w > en.TIERS[i - 1].w)) ordered = false;
    }
    ck('档位按难度与尺寸同时递增', ordered, JSON.stringify(en.TIERS.map((t) => [t.w, t.band])));
    eq('档位不认识时退回上手', en.tierFor('nope').key, 'apprentice');

    // geometry, hand-checked on paper: node (0,0) of any board is reached only by the cell below
    // right, and only by that cell's "\"
    const g = en.nodeAt(2, 2, 0, 0);
    eq('角节点只有一格可数', g.length, 1);
    eq('那格是 (0,0)', g[0][0], 0);
    eq('角上只有 ╲ 会收到这里', g[0][1], en.BACK);
    const mid = en.nodeAt(2, 2, 1, 1);
    eq('盘心节点四周四格', mid.length, 4);
    eq('盘心左上格用 ╲', JSON.stringify(mid[0]), JSON.stringify([0, en.BACK]));
    eq('盘心右上格用 ╱', JSON.stringify(mid[1]), JSON.stringify([1, en.SLASH]));

    // Σ clues = 2 × cells on a fully numbered board: every diagonal has exactly two ends.
    const p = en.makePuzzle('scen|engine', 'regular');
    ck('出一局', !!p);
    const b = p.board;
    eq('盘面尺寸就是档位', `${b.w}×${b.h}`, '7×7');
    eq('格数', b.n, 49);
    const full = en.cluesFrom(b.w, b.h, p.solution);
    eq('满数字盘的线索之和 = 2×格数', sum(Array.from(full)), 2 * b.n);
    eq('出货盘的数字少于满盘', b.clues < full.length, true);
    ck('数字都在 0..4 之内', Array.from(b.clue).every((v) => v === -1 || (v >= 0 && v <= 4)));
    const s = en.solve(b);
    ck('铅笔推到底', s.ok === true);
    eq('推到底与种下的解同盘', Array.from(s.derived).join(','), Array.from(p.solution).join(','));
    eq('推出来的盘通过独立验收', en.verify(b, s.derived).length, 0);
    eq('推出来即完整', en.complete(b, s.derived), true);
    const c = en.countSolutions(b, { cap: 2, budget: 200000 });
    eq('穷举计数判定唯一', c.status, 'UNIQUE');
    eq('穷举与铅笔逐格同解', Array.from(c.first).join(','), Array.from(s.derived).join(','));
    eq('空盘不判胜', en.complete(b, new Int8Array(b.n)), false);
    eq('空盘没有冲突', en.diagnose(b, new Int8Array(b.n)).conflicts, 0);
    // one flipped diagonal must break at least one number on a fully numbered board
    const flip = Int8Array.from(full);
    const fullBoard = en.createBoard({ w: b.w, h: b.h, clue: flip });
    const oneBad = Int8Array.from(p.solution);
    oneBad[5] = oneBad[5] === en.SLASH ? en.BACK : en.SLASH;
    ck('翻一格必有数字对不上', en.verify(fullBoard, oneBad).length >= 1, JSON.stringify(en.verify(fullBoard, oneBad)));
    // 1×1: the top-left node is reached by ╲, the top-right by ╱, so both saying 0 is impossible
    eq('左上写 0 定出 ╱', en.solve(en.createBoard({ w: 1, h: 1, clue: Int8Array.from([0, -1, -1, -1]) })).derived[0], en.SLASH);
    eq('右上写 0 定出 ╲', en.solve(en.createBoard({ w: 1, h: 1, clue: Int8Array.from([-1, 0, -1, -1]) })).derived[0], en.BACK);
    eq('两个 0 顶边互相矛盾', en.solve(en.createBoard({ w: 1, h: 1, clue: Int8Array.from([0, 0, -1, -1]) })).ok, false);
    eq('数字超过周围格数时拒绝开局', (() => {
      try {
        en.createBoard({ w: 2, h: 2, clue: Int8Array.from([9, -1, -1, -1, -1, -1, -1, -1, -1]) });
        return '';
      } catch (e) {
        return /周围只有 1 格/.test(e.message);
      }
    })(), true);
    const d0 = en.solve(b).rows[0];
    ck('提示脚本的每条都带规则与格', !!(d0.rule && d0.cell >= 0 && d0.node >= 0));
    ck('规则文本带坐标', /第\d+行\d+列/.test(d0.rule.text(b, d0)), d0.rule.text(b, d0));
    return report({ score: p.score, clues: b.clues, steps: s.steps });
  };

  // ---------- gen ----------

  const gen = async () => {
    const en = E();
    const medians = [];
    for (const tier of en.TIERS) {
      const scores = [];
      const clueCount = [];
      let inBand = 0;
      let unique = 0;
      let finishable = 0;
      let ms = 0;
      for (let s = 0; s < 4; s++) {
        const t0 = performance.now();
        const p = en.makePuzzle(`gen|${tier.key}|${s}`, tier.key);
        ms += performance.now() - t0;
        if (!p) continue;
        scores.push(p.score);
        clueCount.push(p.clues);
        if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
        if (en.solve(p.board).ok) finishable++;
        if (en.countSolutions(p.board, { cap: 2, budget: 600000 }).status === 'UNIQUE') unique++;
      }
      const nodes = (tier.w + 1) * (tier.h + 1);
      eq(`${tier.key} 出货 4/4`, scores.length, 4);
      ck(`${tier.key} 命中难度区间`, inBand >= 3, `${inBand}/4 在 ${tier.band}`);
      eq(`${tier.key} 每局唯一解`, unique, scores.length);
      eq(`${tier.key} 每局推得完`, finishable, scores.length);
      ck(`${tier.key} 数字确实被删过`, median(clueCount) < nodes, `${median(clueCount)}/${nodes}`);
      ck(`${tier.key} 出题够快`, ms / 4 < 900, `${(ms / 4).toFixed(0)} ms/局`);
      medians.push({ key: tier.key, m: median(scores), size: `${tier.w}×${tier.h}`, clues: median(clueCount), nodes });
    }
    let mono = true;
    for (let i = 1; i < medians.length; i++) if (!(medians[i].m > medians[i - 1].m)) mono = false;
    ck('档位中位分数单调递增', mono, medians.map((o) => `${o.key}:${o.m}`).join(' '));
    eq('每档盘面都比上一档大', new Set(medians.map((o) => o.size)).size, 5);
    // the same seed must give the same board — a save stores only the seed
    const a = en.makePuzzle('gen|same', 'expert');
    eq('同种子同盘', Array.from(en.makePuzzle('gen|same', 'expert').board.clue).join(','), Array.from(a.board.clue).join(','));
    ck('不同种子不同盘', Array.from(en.makePuzzle('gen|other', 'expert').board.clue).join(',') !== Array.from(a.board.clue).join(','));
    eq('出货记下原始种子', a.originSeed, 'gen|same');
    ck('派生种子带 trials 编号', /^gen\|same#\d+$/.test(a.seed), a.seed);
    // ungated random deletion: the counter, not the generator, decides — and where it says many,
    // the pencil rules must refuse to finish
    let many = 0;
    let fooled = 0;
    const en2 = en;
    for (let s = 0; s < 12; s++) {
      const s2 = en2.randomSolution(5, 5, (() => { let x = 31 + s * 977; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; })());
      const full = en2.createBoard({ w: 5, h: 5, clue: en2.cluesFrom(5, 5, s2) });
      const clue = Int8Array.from(full.clue);
      for (let i = 0; i < 14; i++) clue[(i * 7 + s * 3) % clue.length] = -1;
      const b = en2.createBoard({ w: 5, h: 5, clue });
      const c = en2.countSolutions(b, { cap: 2, budget: 120000 });
      if (c.status !== 'UNIQUE') {
        many++;
        if (en2.solve(b).ok) fooled++;
      }
    }
    ck('随机乱删会造出多解盘（对照组不是空的）', many >= 6, String(many));
    eq('多解盘不会被规则误判推完', fooled, 0);
    return report({ medians: medians.map((o) => o.m) });
  };

  // ---------- play ----------

  const play = async () => {
    const en = E();
    A().show('menu');
    await wait(40);
    ck('选档页可见', shown('#view-menu'));
    ck('棋局页藏起', !shown('#view-game'));
    eq('标题是斜钉', text('#app h1'), '斜钉');
    ck('副标题点出玩法', /Gokigen Naname/.test(text('.brand .sub')), text('.brand .sub'));
    const tiers = [...document.querySelectorAll('#tier-list .tier')];
    eq('档位按钮五个', tiers.length, 5);
    ck('档位按钮写着尺寸', tiers.every((x) => /×/.test(x.textContent)));
    ck('档位按钮写着实测分', tiers.every((x) => /实测/.test(x.textContent)));
    eq('玩法说明写了四条规则', document.querySelectorAll('.rules li').length, 4);
    eq('纪录表按档位排', document.querySelectorAll('#record-list li').length, 5);
    ck('页脚提到验证脚本', /tools\/verify\.sh/.test(text('footer')));
    ck('未开局不显示继续', !shown('#resume-card'));

    tiers[1].click();
    await wait(80);
    ck('点档位进入棋局', shown('#view-game'));
    const g = A().game;
    eq('进入的是上手档', g.puzzle.tier, 'apprentice');
    ck('棋头写了档位名', text('#stat-name').includes('上手'), text('#stat-name'));
    ck('棋头写了尺寸', text('#stat-name').includes('6×6'), text('#stat-name'));
    eq('计时从 00:00 起', text('#stat-time'), '00:00');
    eq('步数为 0', text('#stat-moves'), '0');
    eq('提示为 0', text('#stat-hints'), '0');
    eq('已画线读数 0/36', text('#stat-filled'), '0/36');
    eq('待画格 36', text('#stat-remaining'), '36');
    ck('凑齐的数从 0 起', text('#stat-satisfied').startsWith('0/'), text('#stat-satisfied'));
    eq('冲突 0', text('#stat-conflicts'), '0');
    eq('难度实测显示分数', text('#stat-score'), g.puzzle.score.toFixed(1));
    ck('胜利遮罩藏起', !shown('#win-veil'));
    eq('状态行开局为空', text('#state-line'), '');
    const geo = A().view.geo;
    const rect = A().view.canvas.getBoundingClientRect();
    ck('画布按棋盘铺开', Math.abs(rect.width - (geo.cell * g.w + geo.x * 2)) <= 1, `${rect.width} vs ${geo.cell * g.w}`);
    eq('格子边长是整数', Number.isInteger(geo.cell), true);
    ck('画不出视口', rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, JSON.stringify({ r: rect.right, b: rect.bottom }));
    eq('默认方向是 ╱', $('#board').dataset.mode, 'slash');
    eq('╱ 按钮按下态', $('#btn-mode-slash').getAttribute('aria-pressed'), 'true');
    eq('╲ 按钮未按下', $('#btn-mode-back').getAttribute('aria-pressed'), 'false');

    $('#btn-mode-back').click();
    await wait(30);
    eq('切方向写进 data-mode', $('#board').dataset.mode, 'back');
    eq('╲ 按钮亮起', $('#btn-mode-back').getAttribute('aria-pressed'), 'true');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    await wait(30);
    eq('/ 键切回 ╱', $('#board').dataset.mode, 'slash');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', bubbles: true }));
    await wait(30);
    eq('\\ 键切到 ╲', $('#board').dataset.mode, 'back');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    await wait(30);
    eq('M 键再切回来', $('#board').dataset.mode, 'slash');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    await wait(60);
    eq('H 键给一次提示', text('#stat-hints'), '1');
    ck('提示理由写出规则名', /规则：/.test(text('#hint-rule')), text('#hint-rule'));
    ck('提示不是空话', text('#hint-line').length > 8, text('#hint-line'));
    eq('提示按钮角标同步', text('#hint-count'), '1');
    ck('提示真的画了一条线', A().game.state().filled > 0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    await wait(60);
    eq('Z 键退掉提示画的线', A().game.state().filled, 0);
    eq('撤销不退提示次数', text('#stat-hints'), '1');

    const wasOn = $('#btn-sound').getAttribute('aria-pressed') === 'true';
    $('#btn-sound').click();
    await wait(30);
    eq('音效按钮改文案', text('#btn-sound'), wasOn ? '音效 关' : '音效 开');
    eq('音效选择进存档', JSON.parse(localStorage.getItem('slant.save.v1')).settings.sound, !wasOn);
    $('#btn-sound').click();
    $('#btn-motion').click();
    await wait(30);
    eq('动效按钮改文案', text('#btn-motion'), '动效 省');
    ck('减少动效写进 body', document.body.classList.contains('reduce-motion'));
    $('#btn-motion').click();

    $('#btn-new').click();
    await wait(80);
    eq('换一局留在同档', A().game.puzzle.tier, 'apprentice');
    eq('换一局清零步数', text('#stat-moves'), '0');
    eq('换一局清零提示', text('#stat-hints'), '0');
    ck('换一局关掉遮罩', !shown('#win-veil'));
    $('#btn-menu').click();
    await wait(40);
    ck('回选档留下可继续的一局', shown('#resume-card'));
    ck('继续卡写了花费', /步 · 提示/.test(text('#resume-meta')), text('#resume-meta'));
    $('#btn-resume').click();
    await wait(60);
    ck('继续回到棋局', shown('#view-game'));
    return report({});
  };

  // ---------- hint ----------

  const hint = async () => {
    const en = E();
    A().begin({ tier: 'expert', seed: 'scen|hint' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    eq('提示局开局干净', g.state().filled, 0);
    const names = new Set(Object.values(en.Rules).map((r) => r.name));
    const seen = new Set();
    let charged = 0;
    let badRule = 0;
    let outOfRange = 0;
    let notWritten = 0;
    for (let k = 0; k < 400 && g.status !== 'won'; k++) {
      const info = A().useHint();
      if (!info) break;
      if (info.stalled) {
        ck('推完之前不喊停', false, info.text);
        break;
      }
      if (info.conflict) {
        ck('一路提示不该撞到自己的线', false, info.conflict);
        break;
      }
      charged++;
      seen.add(info.rule);
      if (!names.has(info.rule)) badRule++;
      if (!(info.cell >= 0 && info.cell < b.n)) outOfRange++;
      if (g.valueOf(info.cell) !== info.value) notWritten++;
      if (!/第\d+行\d+列/.test(info.why)) badRule++;
    }
    eq('一路提示能走完这局', g.status, 'won');
    eq('提示次数等于格子数', charged, b.n);
    eq('提示次数被记上', g.hints, charged);
    eq('提示说的规则都在表里', badRule, 0);
    eq('提示不越界', outOfRange, 0);
    eq('提示说完就真落子', notWritten, 0);
    ck('用到的规则不止一种', seen.size >= 2, [...seen].join(','));
    eq('终局通过独立验收', en.verify(b, g.st.cell).length, 0);
    ck('胜利遮罩出现', shown('#win-veil'));
    ck('胜利文案带花费', /步 · 提示/.test(text('#win-meta')), text('#win-meta'));
    const after = g.hints;
    A().useHint();
    eq('胜利后再按提示不充电', g.hints, after);
    eq('胜利后续局被清掉', en.Store.resume(), null);
    // a second board must not be walkable by reusing the first one's script
    const g2 = A().begin({ tier: 'expert', seed: 'scen|hint2' });
    eq('换局后脚本重来', g2.cursor, 0);
    eq('换局后提示清零', g2.hints, 0);
    return report({ hints: charged, rules: [...seen] });
  };

  // ---------- stroke ----------

  const stroke = async () => {
    const en = E();
    A().begin({ tier: 'trainee', seed: 'scen|stroke' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    eq('开局没有线', g.state().filled, 0);
    await drag(0, 2);
    eq('一笔横拖画出三格', g.state().filled, 3);
    eq('一笔只算一步', text('#stat-moves'), '1');
    eq('方向是当前的 ╱', g.valueOf(1), en.SLASH);
    A().undo();
    await wait(30);
    eq('一次撤销退掉整笔', g.state().filled, 0);
    eq('撤销也退步数', text('#stat-moves'), '0');

    // a diagonal drag covers the diagonal, not the board — the pointer has to actually travel
    // over each cell for that cell to be painted
    A().setMode(en.BACK);
    await drag(g.cellAt(0, 0), g.cellAt(b.w - 1, b.h - 1));
    eq('对角拖过 5 格就画 5 格', g.state().filled, b.w);
    ck('拖过的都是 ╲', [0, 2, 4].every((r) => g.valueOf(g.cellAt(r, r)) === en.BACK), Array.from(g.st.cell).join(''));
    // the diagonal already laid ╲, and starting a stroke on a line that points this way is an
    // eraser — so clear the board before testing what a plain sweep does
    while (A().undo()) { /* drain */ }
    eq('一路撤销能退到空盘', g.state().filled, 0);
    for (let row = 0; row < b.h; row++) await drag(g.cellAt(0, row), g.cellAt(b.w - 1, row));
    eq('逐行拖满整盘', g.state().filled, b.n);
    eq('全部是 ╲', Array.from(g.st.cell).every((v) => v === en.BACK), true);
    ck('满盘 ╲ 与数字矛盾', g.state().conflicts > 0 || g.state().stuck || g.status === 'won', JSON.stringify(g.state()));
    ck('矛盾会被说出来', /矛盾|对不上/.test(text('#state-line')), text('#state-line'));

    // a single tap lays a line, and a second tap on the same cell erases it
    const t = g.cellAt(1, 1);
    A().setMode(en.SLASH);
    let tapMoves = Number(text('#stat-moves'));
    await tap(t);
    eq('点一格放线', g.valueOf(t), en.SLASH);
    eq('点一格算一步', Number(text('#stat-moves')), tapMoves + 1);
    tapMoves = Number(text('#stat-moves'));
    await tap(t);
    eq('再点同方向擦掉', g.valueOf(t), en.OPEN);
    eq('擦掉也算一步', Number(text('#stat-moves')), tapMoves + 1);
    A().setMode(en.BACK);
    await tap(t);
    eq('换方向后点同一格放新线', g.valueOf(t), en.BACK);
    await tap(t);
    eq('同方向再点仍是擦掉', g.valueOf(t), en.OPEN);

    // dragging back over your own line must not eat it mid-gesture
    A().setMode(en.SLASH);
    const row = [0, 1, 2].map((c) => g.cellAt(c, 0));
    const a0 = at(row[0]);
    const a1 = at(row[1]);
    const a2 = at(row[2]);
    const movesBefore = Number(text('#stat-moves'));
    pointer('pointerdown', a0.x, a0.y);
    pointer('pointermove', a1.x, a1.y);
    pointer('pointermove', a2.x, a2.y);
    pointer('pointermove', a1.x, a1.y);
    pointer('pointermove', a0.x, a0.y);
    pointer('pointerup', a0.x, a0.y);
    await wait(40);
    eq('来回拖仍然写下三格', [0, 1, 2].filter((c) => g.valueOf(g.cellAt(c, 0)) === en.SLASH).length, 3);
    eq('来回拖仍然只算一步', Number(text('#stat-moves')), movesBefore + 1);

    // starting a drag on a line that already points this way turns the whole gesture into an
    // eraser — the same predictable rule both modes use
    const moves2 = Number(text('#stat-moves'));
    await drag(row[0], row[2]);
    eq('从自己的线上起笔就是擦', [0, 1, 2].filter((c) => g.valueOf(g.cellAt(c, 0)) === en.OPEN).length, 3);
    eq('擦掉这一笔也算一步', Number(text('#stat-moves')), moves2 + 1);
    // off-canvas press does nothing
    const c = A().view.canvas.getBoundingClientRect();
    const moves3 = Number(text('#stat-moves'));
    pointer('pointerdown', c.left - 6, c.top + 6);
    pointer('pointerup', c.left - 6, c.top + 6);
    await wait(30);
    eq('画布外的按下不落子', Number(text('#stat-moves')), moves3);

    // win by playing the engine's own answer through the real gesture path
    A().begin({ tier: 'trainee', seed: 'scen|stroke-win' });
    await wait(60);
    const g2 = A().game;
    const sol = g2.puzzle.solution;
    for (let t2 = 0; t2 < g2.board.n; t2++) A().stroke([t2], sol[t2]);
    eq('一格一格照解画就能胜', g2.status, 'won');
    eq('纯手工通关不用提示', g2.hints, 0);
    eq('手工通关的步数等于格数', g2.moves, g2.board.n);
    ck('胜利文案写 0 次提示', /提示 0 次/.test(text('#win-meta')), text('#win-meta'));
    ck('手工通关写下纪录', !!en.Store.best('trainee'), JSON.stringify(en.Store.best('trainee')));
    return report({});
  };

  // ---------- conflict ----------

  const conflict = async () => {
    const en = E();
    A().begin({ tier: 'regular', seed: 'scen|conflict' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const first = g.script[0];
    const wrong = first.value === en.SLASH ? en.BACK : en.SLASH;
    A().setMode(wrong);
    await tap(first.cell);
    eq('玩家放了与数字相反的一条', g.valueOf(first.cell), wrong);
    const info = A().useHint();
    ck('提示拒绝落子', !!info.conflict, JSON.stringify(info));
    eq('矛盾时不收钱', g.hints, 0);
    ck('矛盾说明写清该放哪条', /必须是/.test(info.conflict), info.conflict);
    // the important half: the engine can prove no completion survives this line, even though not
    // one number is violated yet — the UI has to say so rather than let the player finish in vain
    ck('这条线被证明无法完成', g.state().stuck === true, JSON.stringify(g.state()));
    ck('状态行说出矛盾', /矛盾/.test(text('#state-line')), text('#state-line'));
    ck('矛盾与违反至少有一个被说出来', g.state().stuck || g.state().conflicts > 0, JSON.stringify(g.state()));
    A().setMode(wrong);
    await tap(first.cell);
    eq('擦掉错线之后矛盾消失', A().game.state().stuck, false);
    eq('状态行也清空', text('#state-line'), '');
    const ok2 = A().useHint();
    eq('这时提示才肯落子', ok2.value, first.value);
    eq('这次才计一次提示', g.hints, 1);

    // a node's ring must read green when its number is satisfied and red when it is broken
    const satisfied = en.diagnose(b, g.st.cell).satisfied;
    ck('引擎能说出哪些数字已凑齐', typeof satisfied.has === 'function');
    // fill the whole board with the wrong diagonal everywhere: many conflicts, no crash
    A().begin({ tier: 'trainee', seed: 'scen|conflict2' });
    await wait(60);
    const g2 = A().game;
    for (let t = 0; t < g2.board.n; t++) A().stroke([t], en.SLASH);
    ck('满盘同方向时冲突可读', typeof g2.state().conflicts === 'number', String(g2.state().conflicts));
    eq('满盘同方向不会误判胜利', g2.status, 'playing');
    eq('待画格归零', g2.state().remaining, 0);
    ck('还有数字没凑齐', g2.state().satisfied < g2.state().clues, `${g2.state().satisfied}/${g2.state().clues}`);
    // the engine's own answer, drawn through the same path, must have no conflict at all
    A().begin({ tier: 'trainee', seed: 'scen|conflict3' });
    await wait(60);
    const g3 = A().game;
    for (let t = 0; t < g3.board.n; t++) A().stroke([t], g3.puzzle.solution[t]);
    eq('照解画完时冲突为 0', g3.state().conflicts, 0);
    eq('照解画完时所有数字都凑齐', g3.state().satisfied, g3.state().clues);
    return report({});
  };

  // ---------- save ----------

  const save = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'regular', seed: 'scen|save' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    for (let i = 0; i < 6; i++) A().stroke([i], g.puzzle.solution[i]);
    A().useHint();
    await wait(30);
    const raw = JSON.parse(localStorage.getItem('slant.save.v1'));
    ck('存档键名是本作的', !!raw && !!raw.resume, Object.keys(raw || {}).join(','));
    eq('存档写原始种子', raw.resume.seed, g.puzzle.originSeed);
    eq('存档写档位', raw.resume.tier, 'regular');
    eq('存档写格数', raw.resume.cells, b.n);
    eq('存档写步数', raw.resume.moves, g.moves);
    eq('存档写提示数', raw.resume.hints, g.hints);
    ck('存档写用时', raw.resume.elapsedMs > 0, raw.resume.elapsedMs);
    ck('存档不过一千字节', JSON.stringify(raw.resume).length < 1000, JSON.stringify(raw.resume).length);
    const back = en.Store.resume();
    eq('斜线一格不差地回来', Array.from(back.board).join(','), Array.from(g.st.cell).join(','));
    ck('空格在存档里还是空格', back.board.some((v) => v === en.OPEN) && back.board.every((v) => v >= 0 && v <= en.BACK), Array.from(back.board).slice(0, 10).join(','));
    ck('游程编码比一格一数省', back.ink.length < b.n * 2, `${back.ink.length} vs ${b.n * 2}`);
    eq('默认设置音效开', en.Store.setting('sound'), true);
    ck('本作没有上一作的设置项', !('showNotes' in raw.settings), JSON.stringify(raw.settings));
    const solvedBefore = en.Store.data.totals.solved;
    en.Store.recordSolve(1000, 2);
    eq('总局数按局累加', en.Store.data.totals.solved, solvedBefore + 1);
    ck('累计提示在涨', en.Store.data.totals.hints >= 2, en.Store.data.totals.hints);
    en.Store.data.best = {};
    eq('首个纪录直接成立', en.Store.recordBest('regular', { ms: 50000, hints: 1, moves: 20, size: '7×7' }), true);
    eq('更快但更靠提示的不算破纪录', en.Store.recordBest('regular', { ms: 1000, hints: 2, moves: 5, size: '7×7' }), false);
    eq('同求助次数下省步算破纪录', en.Store.recordBest('regular', { ms: 60000, hints: 1, moves: 12, size: '7×7' }), true);
    eq('步数也相同时才比时间', en.Store.recordBest('regular', { ms: 90000, hints: 1, moves: 12, size: '7×7' }), false);
    eq('纪录留的是最好的那次', en.Store.best('regular').moves, 12);
    en.Store.data.best = {};
    localStorage.setItem('shikaku.save.v1', JSON.stringify({ settings: { showNotes: false }, resume: { seed: 'x' } }));
    eq('不读上一作的存档键', en.Store.setting('sound'), true);
    localStorage.removeItem('shikaku.save.v1');
    return report({ bytes: JSON.stringify(raw.resume).length });
  };

  // ---------- resume ----------

  const resume = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'expert', seed: 'scen|resume' });
    await wait(60);
    const g = A().game;
    const clueBefore = Array.from(g.board.clue).join(',');
    for (let i = 0; i < 8; i++) A().stroke([i], g.puzzle.solution[i]);
    A().useHint();
    A().useHint();
    await wait(30);
    const saved = { cell: Array.from(g.st.cell).join(','), moves: g.moves, hints: g.hints };
    A().show('menu');
    await wait(40);
    ck('回选档留下继续卡', shown('#resume-card'));
    ck('继续卡写着档位', /高阶/.test(text('#resume-name')), text('#resume-name'));
    const r = en.Store.resume();
    eq('续局取回了斜线', Array.from(r.board).join(','), saved.cell);
    A().begin({ tier: r.tier, seed: r.seed, resume: r });
    await wait(60);
    const g2 = A().game;
    eq('续局重绘出同一块盘', Array.from(g2.board.clue).join(','), clueBefore);
    eq('续局还原全部斜线', Array.from(g2.st.cell).join(','), saved.cell);
    eq('续局还原步数', g2.moves, saved.moves);
    eq('续局还原提示数', g2.hints, saved.hints);
    eq('面板显示还原后的提示', text('#stat-hints'), String(saved.hints));
    eq('面板显示还原后的步数', text('#stat-moves'), String(saved.moves));
    ck('续局接着计时', A().elapsed() >= r.elapsedMs, `${A().elapsed()} vs ${r.elapsedMs}`);
    eq('面板已画线与引擎一致', text('#stat-filled').split('/')[0], String(g2.diag.filled));
    eq('续局不能撤销到重开之前', A().undo(), null);
    eq('续局之后斜线还在', Array.from(g2.st.cell).join(','), saved.cell);
    const hintsAtResume = g2.hints;
    A().begin({ tier: r.tier, seed: r.seed, resume: r });
    await wait(60);
    const g3 = A().game;
    const res = A().solveWithLogic();
    eq('续局可以推到胜利', g3.status, 'won', JSON.stringify(res));
    ck('推到底用了逻辑', res.steps > 1, res.steps);
    ck('提示次数没被续局清零', g3.hints >= hintsAtResume, `${g3.hints} vs ${hintsAtResume}`);
    ck('破纪录按求助最少算', !en.Store.best('expert') || en.Store.best('expert').hints <= g3.hints, JSON.stringify(en.Store.best('expert')));
    eq('胜利后续局被清掉', en.Store.resume(), null);
    ck('胜利遮罩可见', shown('#win-veil'));
    $('#btn-menu-2').click();
    await wait(40);
    ck('胜利后回选档不再给继续', !shown('#resume-card'));
    ck('总局数累加了', en.Store.data.totals.solved >= 1, en.Store.data.totals.solved);
    $('#btn-reset').click();
    await wait(40);
    eq('清空存档清掉纪录', en.Store.best('expert'), null);
    ck('清空存档回到选档', shown('#view-menu'));
    eq('清空后续档也没了', en.Store.resume(), null);
    return report({});
  };

  // ---------- layout ----------

  const layout = async () => {
    const en = E();
    A().begin({ tier: 'master', seed: 'scen|layout' });
    await wait(80);
    const g = A().game;
    const b = g.board;
    eq('大师档 10×10', `${g.w}×${g.h}`, '10×10');
    const rect = A().view.canvas.getBoundingClientRect();
    ck('最大盘也在视口里', rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, JSON.stringify({ l: rect.left, r: rect.right, b: rect.bottom }));
    ck('格子不小于可点最小值', A().view.geo.cell >= 22, A().view.geo.cell);
    ck('页面没有横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);
    let misses = 0;
    for (let t = 0; t < b.n; t++) {
      const p = at(t);
      if (A().view.hitCell(p.x, p.y) !== t) misses++;
    }
    eq('大棋盘每一格都点得中', misses, 0);
    // the padding must be big enough for a node disc to sit whole outside the grid
    const corner = A().view.nodePoint(0);
    ck('角上的数字完整可见', corner.x - 15 >= 0 && corner.y - 15 >= 0, JSON.stringify(corner));

    const sol = g.puzzle.solution;
    A().stroke([0, 1, 2, 3], sol[0]);
    A().stroke([g.cellAt(0, b.h - 1)], sol[g.cellAt(0, b.h - 1)]);
    await wait(50);
    const infoColor = hex(cssVar('--info'));
    const pendingColor = hex(cssVar('--pencil-strong'));
    const errColor = hex(cssVar('--error'));
    const paper = hex(cssVar('--bg-bottom'));
    void pendingColor;
    void errColor;
    const t0 = 0;
    ck('画过的格中心有线', !near(linePixel(t0), paper), `${linePixel(t0)} vs 纸色 ${paper}`);
    // (0.72, 0.26) of a cell sits on its "/" and far from its "\"; the mirror point does the
    // opposite. Reading both says which way the line actually went, which is the one thing a
    // screenshot of this game can get wrong while every number still adds up.
    const onSlashSide = cornerPixel(t0, 'slash');
    const onBackSide = cornerPixel(t0, 'back');
    const want = sol[t0] === en.SLASH ? [!near(onSlashSide, paper, 26), near(onBackSide, paper, 26)] : [near(onSlashSide, paper, 26), !near(onBackSide, paper, 26)];
    ck('线的方向能从像素读出来', want[0] && want[1], JSON.stringify({ sol: sol[t0], onSlashSide, onBackSide, paper }));
    const untouched = (() => {
      for (let t = b.n - 1; t >= 0; t--) if (g.st.cell[t] === en.OPEN) return t;
      return -1;
    })();
    ck('还有没画的格可采样', untouched >= 0);
    eq('没画的格就是纸色', near(linePixel(untouched), paper), true);
    ck('线的颜色由引擎的判定决定', near(linePixel(t0), infoColor) || near(linePixel(t0), pendingColor) || near(linePixel(t0), errColor), `${linePixel(t0)} vs ${infoColor}/${pendingColor}/${errColor}`);
    // a satisfied number must wear the success ring: fill the whole board and sample a node
    for (let t = 0; t < b.n; t++) A().stroke([t], sol[t]);
    await wait(60);
    eq('照解画完就胜利', g.status, 'won');
    const winColor = hex(cssVar('--success'));
    const nodeIdx = (() => {
      for (let i = 0; i < b.clue.length; i++) if (b.clue[i] !== -1) return i;
      return -1;
    })();
    const np = A().view.nodePoint(nodeIdx);
    // sample the ring itself: the disc is min(15, cell*0.3) across and the stroke sits on that
    // radius, so a probe inside it reads the disc's dark fill rather than the ring's colour
    const rad = Math.min(15, A().view.geo.cell * en.theme.Cell.nodeScale);
    let green = 0;
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const p = pixel(np.x + Math.cos(ang) * rad, np.y + Math.sin(ang) * rad);
      if (near(p, winColor, 40)) green++;
    }
    ck('凑齐的数字画了绿色环', green >= 4, `绿环采样 ${green}/12 @节点${nodeIdx} r=${rad}`);
    const glyph = A().view.ctx.getImageData(Math.round((np.x - 6) * A().view.geo.dpr), Math.round((np.y - 5) * A().view.geo.dpr), Math.round(12 * A().view.geo.dpr), Math.round(10 * A().view.geo.dpr)).data;
    let bright = 0;
    for (let k = 0; k < glyph.length; k += 4) if (glyph[k] + glyph[k + 1] + glyph[k + 2] > 300) bright++;
    ck('数字真的被画出来', bright >= 4, `亮像素 ${bright}`);
    eq('图例五项', document.querySelectorAll('.legend span').length, 5);
    ck('图例色块与画布同一个颜色', near(rgb(getComputedStyle($('.sw-good')).backgroundColor), infoColor), `${getComputedStyle($('.sw-good')).backgroundColor} vs ${infoColor}`);
    ck('操作提示讲清三种手势', /拖动/.test(text('.keyhint')) && /撤销/.test(text('.keyhint')), text('.keyhint'));
    eq('统计项七条', document.querySelectorAll('.stats .stat').length, 7);
    ck('按钮都够点', [...document.querySelectorAll('.acts button, .modes button, .top-actions button')].every((x) => x.getBoundingClientRect().height >= 28));
    ck('顶部按钮不重叠', (() => {
      const bs = [...document.querySelectorAll('.top-actions button')].map((x) => x.getBoundingClientRect());
      for (let i = 1; i < bs.length; i++) if (bs[i].left < bs[i - 1].right - 1) return false;
      return true;
    })());
    ck('提示框不横向溢出', (() => {
      const e = $('.hint-box');
      return e.scrollWidth <= e.clientWidth + 1;
    })());
    A().begin({ tier: 'trainee', seed: 'scen|layout-win' });
    await wait(40);
    for (let t = 0; t < A().game.board.n; t++) A().stroke([t], A().game.puzzle.solution[t]);
    await wait(60);
    ck('胜利卡居中在棋盘内', (() => {
      const card = $('.win-card').getBoundingClientRect();
      const wrap = $('#board-wrap').getBoundingClientRect();
      return card.left >= wrap.left - 1 && card.right <= wrap.right + 1 && card.top >= wrap.top - 1 && card.bottom <= wrap.bottom + 1;
    })(), JSON.stringify({ c: $('.win-card').getBoundingClientRect(), w: $('#board-wrap').getBoundingClientRect() }));
    ck('胜利按钮点得到', $('#btn-again').getBoundingClientRect().width > 40);
    return report({ cell: A().view.geo.cell, dpr: A().view.geo.dpr });
  };

  w.__ng = { engine, gen, play, hint, stroke, conflict, save, resume, layout };
})(window);
