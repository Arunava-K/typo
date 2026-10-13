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

export function calcAccuracy(correctKeystrokes: number, totalKeystrokes: number): number {
  if (totalKeystrokes === 0) return 100;
  return (correctKeystrokes / totalKeystrokes) * 100;
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
 */
export function scoreRun(
  target: string,
  typed: string,
  elapsedSec: number,
): {
  wpm: number;
  raw: number;
  acc: number;
  correctChars: number;
  incorrectChars: number;
  extraChars: number;
  missedChars: number;
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
  return {
    wpm: calcWpm(correct, elapsedSec),
    raw: calcRawWpm(typed.length, elapsedSec),
    acc,
    correctChars: correct,
    incorrectChars: incorrect - extra < 0 ? 0 : incorrect - extra,
    extraChars: extra,
    missedChars: missed,
  };
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

/** Display form: space renders as ␣ so the table stays readable. */
export function formatKey(k: string): string {
  return k === " " ? "␣" : k;
}
