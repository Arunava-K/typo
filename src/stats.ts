// Pure stat functions — easy to unit-test.

export interface KeystrokeStats {
  correctChars: number; // correct incl. spaces
  totalTyped: number; // all typed chars (excl. backspaces themselves)
  correctKeystrokes: number;
  totalKeystrokes: number;
  elapsedSec: number;
}

/** Standard WPM: (correctChars / 5) / minutes. */
export function calcWpm(correctChars: number, elapsedSec: number): number {
  if (elapsedSec <= 0) return 0;
  return correctChars / 5 / (elapsedSec / 60);
}

/** Raw WPM counts every typed char. */
export function calcRawWpm(totalTyped: number, elapsedSec: number): number {
  if (elapsedSec <= 0) return 0;
  return totalTyped / 5 / (elapsedSec / 60);
}

/** Gross WPM counts every keystroke ever pressed (incl. later-deleted). */
export function calcGrossWpm(totalKeystrokes: number, elapsedSec: number): number {
  if (elapsedSec <= 0) return 0;
  return totalKeystrokes / 5 / (elapsedSec / 60);
}/** CPM: correct chars (incl. spaces) per minute. */
export function calcCpm(correctChars: number, elapsedSec: number): number {
  if (elapsedSec <= 0) return 0;
  return correctChars / (elapsedSec / 60);
}

export function calcAccuracy(correctKeystrokes: number, totalKeystrokes: number): number {
  if (totalKeystrokes === 0) return 100;
  return (correctKeystrokes / totalKeystrokes) * 100;
}

/**
 * Current-word burst WPM: correct chars in the active word over the time
 * spent in it. Returns 0 below `minSec` to avoid spike artifacts on
 * word entry. Pure wrapper over calcWpm for testability (Task #3).
 */
export function calcBurst(correctInWord: number, elapsedSec: number, minSec = 0.2): number {
  if (elapsedSec < minSec) return 0;
  return calcWpm(correctInWord, elapsedSec);
}

/** One snapshot of run progress, for WPM-over-time traces. */
export interface TimelineSample {
  tSec: number; // seconds since first keystroke
  correctChars: number; // correct chars in current buffer
  typedLen: number; // current buffer length
}

/**
 * Bucket timeline snapshots into per-`bucketSec` cumulative WPM series.
 * Each bucket uses the last snapshot at or before the bucket end, so the
 * curve matches what the live HUD would have shown at that moment.
 */
export function buildWpmTrace(
  samples: TimelineSample[],
  durationSec: number,
  bucketSec = 1,
): { wpm: number[]; raw: number[] } {
  if (durationSec <= 0 || bucketSec <= 0) return { wpm: [], raw: [] };
  const buckets = Math.max(1, Math.ceil(durationSec / bucketSec));
  const wpm: number[] = [];
  const raw: number[] = [];
  let si = 0;
  let lastCorrect = 0;
  let lastTyped = 0;
  for (let b = 1; b <= buckets; b++) {
    const end = b * bucketSec;
    while (si < samples.length && samples[si]!.tSec <= end) {
      lastCorrect = samples[si]!.correctChars;
      lastTyped = samples[si]!.typedLen;
      si++;
    }
    const mins = end / 60;
    wpm.push(mins > 0 ? lastCorrect / 5 / mins : 0);
    raw.push(mins > 0 ? lastTyped / 5 / mins : 0);
  }
  return { wpm, raw };
}

/**
 * Monkeytype-style consistency: 100 * (1 - stdev/mean) over per-second
 * raw WPM samples, clamped 0–100. Steady pace → ~100, bursty → lower.
 */
export function calcConsistency(rawSamples: number[]): number {
  const xs = rawSamples.filter((x) => x > 0);
  if (xs.length < 2) return 100;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean <= 0) return 0;
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.max(0, Math.min(100, (1 - cv) * 100));
}

/** Compact unicode sparkline (▁▂▃▄▅▆▇█) for WPM traces. */
export function sparkline(values: number[], width = 30): string {  if (values.length === 0) return "";
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  let vals = values;
  if (values.length > width) {
    // average down into `width` buckets
    vals = [];
    const per = values.length / width;
    for (let i = 0; i < width; i++) {
      const start = Math.floor(i * per);
      const end = Math.max(start + 1, Math.floor((i + 1) * per));
      const slice = values.slice(start, end);
      vals.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (max <= min) return blocks[3]!.repeat(vals.length);
  return vals
    .map((v) => {
      const t = (v - min) / (max - min);
      return blocks[Math.min(blocks.length - 1, Math.floor(t * blocks.length))]!;
    })
    .join("");
}

/**
 * Score a finished (or in-progress) run by comparing typed vs target
 * char-by-char. Extra chars beyond target count as incorrect.
 *
 * Pass `opts.totalKeystrokes` (every printable press, incl. later-deleted)
 * for a true gross WPM; otherwise gross falls back to buffer-based raw.
 * Pass `opts.corrections` (backspace/word-delete/clear presses) to report
 * it alongside the char breakdown.
 */
export function scoreRun(
  target: string,
  typed: string,
  elapsedSec: number,
  opts: { totalKeystrokes?: number; corrections?: number } = {},
): {
  wpm: number;
  raw: number;
  gross: number;
  acc: number;
  correctChars: number;
  incorrectChars: number;
  extraChars: number;
  missedChars: number;
  cpm: number;
  cpmRaw: number;
  corrections: number;
} {
  let correct = 0;
  let incorrect = 0;
  const n = Math.max(target.length, typed.length);
  for (let i = 0; i < typed.length; i++) {
    if (i < target.length && typed[i] === target[i]) correct++;
    else incorrect++;
  }
  void n;
  const extra = Math.max(0, typed.length - target.length);
  const missed = Math.max(0, target.length - typed.length);
  // typed-vs-target per-keystroke accuracy here equals correct / typed
  const acc = typed.length === 0 ? 100 : (correct / typed.length) * 100;
  const raw = calcRawWpm(typed.length, elapsedSec);
  return {
    wpm: calcWpm(correct, elapsedSec),
    raw,
    gross: opts.totalKeystrokes != null ? calcGrossWpm(opts.totalKeystrokes, elapsedSec) : raw,
    acc,
    correctChars: correct,
    incorrectChars: incorrect - extra < 0 ? 0 : incorrect - extra,
    extraChars: extra,
    missedChars: missed,
    cpm: calcCpm(correct, elapsedSec),
    cpmRaw: elapsedSec <= 0 ? 0 : typed.length / (elapsedSec / 60),
    corrections: opts.corrections ?? 0,
  };
}

// --- Zen mode scoring (Task #14) ---
// Freestyle has no target: every typed char counts as correct by
// definition, so WPM == raw and accuracy is always 100.

/** Minimum zen run length that gets saved to history (Monkeytype parity). */
export const MIN_ZEN_SAVE_SEC = 15;
export function scoreZen(
  typed: string,
  elapsedSec: number,
  totalKeystrokes: number,
  corrections: number,
): ReturnType<typeof scoreRun> {
  const wpm = calcRawWpm(typed.length, elapsedSec);
  return {
    wpm,
    raw: wpm,
    gross: calcGrossWpm(totalKeystrokes, elapsedSec),
    acc: 100,
    correctChars: typed.length,
    incorrectChars: 0,
    extraChars: 0,
    missedChars: 0,
    cpm: calcCpm(typed.length, elapsedSec),
    cpmRaw: elapsedSec <= 0 ? 0 : typed.length / (elapsedSec / 60),
    corrections,
  };
}

// --- Fail modifiers (Task #15) ---

/**
 * True when buffer accuracy drops below minAcc after a grace period.
 * Pure so the grace rule is unit-testable.
 */
export function belowMinAcc(correctChars: number, typedLen: number, minAcc: number, grace = 10): boolean {
  if (typedLen < grace) return false;
  return (correctChars / typedLen) * 100 < minAcc;
}

// --- Pace ghost (Task #16) ---

/**
 * Characters a pace-WPM typist covers in elapsedSec (5 chars = 1 word).
 * Pure so ghost math is unit-testable.
 */
export function ghostCharsAt(paceWpm: number, elapsedSec: number): number {
  if (elapsedSec <= 0 || paceWpm <= 0) return 0;
  return (paceWpm * elapsedSec) / 12;
}

// --- Per-key stats (Task #2) ---

/** One typed keystroke attributed to its expected char. */
export interface KeyPressEvent {
  /** expected char (lowercased for A-Z so Shift+letter maps to one key) */
  key: string;
  correct: boolean;
  /** ms since previous keystroke; 0 = same-batch paste, excluded from avg */
  latencyMs: number;
}

/** Fold A-Z onto a-z so capitals share their base key. */
export function normalizeKey(ch: string): string {
  if (ch.length === 1 && ch >= "A" && ch <= "Z") return ch.toLowerCase();
  return ch;
}

export interface KeyStat {
  key: string;
  presses: number;
  hits: number;
  totalLatencyMs: number;
  latencyCount: number;
}

/** Accumulate per-key presses/hits/latency from a run's key events. */
export function accumulateKeyStats(events: KeyPressEvent[]): Map<string, KeyStat> {
  const map = new Map<string, KeyStat>();
  for (const e of events) {
    let s = map.get(e.key);
    if (!s) {
      s = { key: e.key, presses: 0, hits: 0, totalLatencyMs: 0, latencyCount: 0 };
      map.set(e.key, s);
    }
    s.presses++;
    if (e.correct) s.hits++;
    if (e.latencyMs > 0 && Number.isFinite(e.latencyMs) && e.latencyMs < 30000) {
      s.totalLatencyMs += e.latencyMs;
      s.latencyCount++;
    }
  }
  return map;
}

export interface WeakKey {
  key: string;
  acc: number; // 0–100
  avgMs: number; // mean inter-key latency, 0 when unknown
  presses: number;
}

/**
 * Worst keys first: lowest accuracy, then slowest average latency,
 * then most presses. Only keys with >= `minPresses` qualify.
 */
export function worstKeys(
  stats: Map<string, KeyStat>,
  limit = 5,
  minPresses = 2,
): WeakKey[] {
  const rows: WeakKey[] = [];
  for (const s of stats.values()) {
    if (s.presses < minPresses) continue;
    rows.push({
      key: s.key,
      acc: (s.hits / s.presses) * 100,
      avgMs: s.latencyCount > 0 ? s.totalLatencyMs / s.latencyCount : 0,
      presses: s.presses,
    });
  }
  rows.sort((a, b) => a.acc - b.acc || b.avgMs - a.avgMs || b.presses - a.presses);
  return rows.slice(0, Math.max(0, limit));
}

/** Display form: space renders as ␣, newline as ⏎, so tables stay readable. */
export function formatKey(k: string): string {
  if (k === " ") return "␣";
  if (k === "\n") return "⏎";
  return k;
}

// --- Mistake log (Task #5) ---

/**
 * Compare a completed word's expected vs typed text.
 * Returns null when the word was typed correctly.
 */
export function wordMistake(expected: string, actual: string): { word: string; typed: string } | null {
  if (expected === actual) return null;
  return { word: expected, typed: actual };
}

/** Shorten long words for the results mistakes row. */
export function shortWord(w: string, n = 14): string {
  if (w.length <= n) return w;
  return w.slice(0, n - 1) + "…";
}
