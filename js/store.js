// Persistence. Everything lives under one key so a reset is one line, and a run in progress is
// stored as (origin seed, tier, the diagonals drawn so far, what the run has cost) rather than a
// copy of the clue set or the solution — the generator is deterministic, so the board never has
// to travel through storage, and a solved 10×10 comes to a couple of hundred bytes.

const KEY = 'slant.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// Cell states are 0 empty / 1 "/" / 2 "\", and an early board is mostly 0s — run-length coding
// is why a 100-cell save is not a 3 KB JSON array. No offset is needed: nothing here is negative.
function rleEncode(board) {
  const out = [];
  let run = board[0] ?? 0;
  let n = 1;
  for (let i = 1; i < board.length; i++) {
    if (board[i] === run && n < 255) n++;
    else {
      out.push(run, n);
      run = board[i];
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

function rleDecode(pairs, len) {
  const b = new Uint8Array(len);
  let i = 0;
  for (let p = 0; p < pairs.length; p += 2) {
    const v = pairs[p];
    const n = pairs[p + 1];
    for (let k = 0; k < n && i < len; k++) b[i++] = v;
  }
  return b;
}

// Two-phase decode. Phase 1 only asks whether the *text* is JSON; phase 2 judges each record
// on its own. That split is the whole point: one hand-edited or half-written record used to take
// the entire save with it (`{best: null}` threw inside recordBest, freezing the win path long
// before that tier was ever reached), and "your other three records are gone too" is not a
// defensible answer to a corrupt byte.
const int = (v, lo = 0, hi = Number.MAX_SAFE_INTEGER) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : null;
const bool = (v) => (typeof v === 'boolean' ? v : null);

function decodeSettings(raw) {
  const out = defaults().settings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of Object.keys(out)) {
    const v = bool(raw[k]);
    if (v !== null) out[k] = v; // 这个键坏了就用默认值，别把兄弟键一起扔
  }
  return out;
}

function decodeTotals(raw) {
  const out = defaults().totals;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of Object.keys(out)) {
    const v = int(raw[k]);
    if (v !== null) out[k] = v;
  }
  return out;
}

// A best record is only meaningful as a whole: ms without hints cannot be compared, so an
// unusable field drops that tier's record and nothing else.
function decodeBest(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [tier, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const ms = int(rec.ms);
    const hints = int(rec.hints);
    const moves = int(rec.moves);
    const size = int(rec.size, 1, 64 * 64);
    const at = int(rec.at, 0);
    if (ms === null || hints === null || moves === null || size === null || at === null) continue;
    out[tier] = { ms, hints, moves, size, at };
  }
  return out;
}

const MAX_CELLS = 64 * 64;

// ink 是 (值, 游程) 成对数组：值只可能是 0/1/2，游程 1..255，展开后不许超过 cells。
// 任何一条不成立就丢整份 resume——半张盘比没有续玩更糟，玩家会以为自己在同一局里。
function decodeResume(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cells = int(raw.cells, 1, MAX_CELLS);
  const elapsedMs = int(raw.elapsedMs);
  const moves = int(raw.moves);
  const hints = int(raw.hints);
  const at = int(raw.at, 0);
  const tier = typeof raw.tier === 'string' && raw.tier ? raw.tier : null;
  const seed = typeof raw.seed === 'string' || typeof raw.seed === 'number' ? String(raw.seed) : null;
  const ink = raw.ink;
  if (cells === null || elapsedMs === null || moves === null || hints === null || at === null || !tier || !seed) return null;
  if (!Array.isArray(ink) || ink.length % 2 !== 0 || ink.length === 0) return null;
  let run = 0;
  for (let i = 0; i < ink.length; i += 2) {
    const v = int(ink[i], 0, 2);
    const n = int(ink[i + 1], 1, 255);
    if (v === null || n === null) return null;
    run += n;
  }
  if (run > cells) return null;
  return { seed, tier, elapsedMs, cells, ink: ink.slice(), moves, hints, at };
}

export function decodeSave(raw) {
  const base = defaults();
  if (typeof raw !== 'string' || !raw) return base;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base; // 文本本身不是 JSON：只能整份重来
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
  return {
    settings: decodeSettings(parsed.settings),
    best: decodeBest(parsed.best),
    totals: decodeTotals(parsed.totals),
    resume: decodeResume(parsed.resume),
  };
}

function readRaw() {
  // localStorage 在 file://、私密模式、以及"没有 window 的 Node 测试"下都可能直接抛或不存在。
  try {
    const s = typeof localStorage === 'undefined' ? null : localStorage;
    return s ? s.getItem(KEY) : null;
  } catch {
    return null;
  }
}

function load() {
  return decodeSave(readRaw());
}

export const Store = {
  data: load(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game is still playable, just forgetful */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // Best time is decided by *least help taken* first: a record must mean "I worked this board
  // out myself", and a fast run built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  saveResume(puzzle, state, elapsedMs, run) {
    this.data.resume = {
      // The generator derives an internal seed from what it is handed, so a resume has to store
      // the *origin* seed or the rebuilt board would not be the same one.
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      cells: puzzle.w * puzzle.h,
      ink: rleEncode(state),
      // The cost of the run travels with the board. Without it a player could take six hints,
      // close the tab, come back, and finish with a clean 提示 0 record — the number that
      // decides the best time is counted from actions, and actions are not saved.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    const r = this.data.resume;
    if (!r) return null;
    return { ...r, board: rleDecode(r.ink, r.cells) };
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};
