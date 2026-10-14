// Personal weakness drills (Task #18, TypeRacer/"tricky keys" style).
// Aggregates stored per-run weakKeys + word mistakes into a trouble
// profile, then generates targeted practice: words containing your worst
// keys plus full words you actually mistyped. With thin history it falls
// back to generic hard letters + commonly mangled words, so drills work
// from the very first run. All pure and unit-testable.
import { WORDS } from "./words.js";
import type { HistoryEntry } from "./history.js";

export interface TroubleKey {
  key: string;
  acc: number;
  avgMs: number;
  presses: number;
}

export interface TroubleWord {
  word: string;
  count: number;
}

/** Generic hard letters when history has no key stats yet. */
export const FALLBACK_KEYS = ["q", "z", "x", "v", "k"];

/** Commonly mangled words when history has no mistakes yet. */
export const FALLBACK_WORDS = [
  "their",
  "there",
  "weird",
  "receive",
  "separate",
  "definitely",
  "occasion",
  "rhythm",
  "necessary",
  "accommodate",
  "embarrass",
  "conscience",
  "millennium",
  "liaison",
  "pronunciation",
  "immediately",
  "beginning",
  "writing",
  "occurred",
  "calendar",
];

/**
 * Worst keys across history: merges per-run weakKeys (press-weighted),
 * lowest accuracy first (min 3 total presses), slowest breaks ties.
 */
export function troubleKeys(hist: HistoryEntry[], limit = 5, minPresses = 3): TroubleKey[] {
  const agg = new Map<string, { presses: number; hits: number; latency: number; latencyN: number }>();
  for (const h of hist) {
    for (const w of h.weakKeys ?? []) {
      let a = agg.get(w.key);
      if (!a) {
        a = { presses: 0, hits: 0, latency: 0, latencyN: 0 };
        agg.set(w.key, a);
      }
      a.presses += w.presses;
      a.hits += (w.acc / 100) * w.presses;
      if (w.avgMs > 0) {
        a.latency += w.avgMs * w.presses;
        a.latencyN += w.presses;
      }
    }
  }
  return [...agg.entries()]
    .filter(([, a]) => a.presses >= minPresses)
    .map(([key, a]) => ({
      key,
      acc: (a.hits / a.presses) * 100,
      avgMs: a.latencyN > 0 ? a.latency / a.latencyN : 0,
      presses: a.presses,
    }))
    .sort((a, b) => a.acc - b.acc || b.avgMs - a.avgMs || b.presses - a.presses)
    .slice(0, Math.max(0, limit));
}

/** Most-mistyped expected words across history, most frequent first. */
export function troubleWords(hist: HistoryEntry[], limit = 8): TroubleWord[] {
  const counts = new Map<string, number>();
  for (const h of hist) {
    for (const m of h.mistakes ?? []) {
      counts.set(m.word, (counts.get(m.word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1))
    .slice(0, Math.max(0, limit));
}

/**
 * Targeted drill text: ~70% words containing your worst keys, ~30%
 * your own mistyped words. Injectable rng for deterministic tests.
 */
export function generateTricky(
  hist: HistoryEntry[],
  count = 30,
  rng: () => number = Math.random,
): { text: string; keys: string[]; words: string[] } {
  const keys = troubleKeys(hist).map((k) => k.key);
  const pool = keys.length > 0 ? keys : FALLBACK_KEYS;
  const candidates = WORDS.filter((w) => pool.some((k) => w.includes(k)));
  const source = candidates.length >= 10 ? candidates : WORDS;
  const tw = troubleWords(hist).map((w) => w.word);
  const wordPool = tw.length > 0 ? tw : FALLBACK_WORDS;
  const pick = (arr: string[]): string => arr[Math.floor(rng() * arr.length)]!;
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, count); i++) {
    out.push(rng() < 0.3 ? pick(wordPool) : pick(source));
  }
  return { text: out.join(" "), keys: pool.slice(0, 5), words: wordPool.slice(0, 8) };
}
