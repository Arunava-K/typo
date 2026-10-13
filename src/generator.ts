import { WORDS } from "./words.js";
import { QUOTES } from "./quotes.js";

export interface GenerateOptions {
  count?: number;
  punctuation?: boolean;
  numbers?: boolean;
}

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function capitalize(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

const PUNCT = [",", ".", ";", ":", "!", "?", "'", '"'];
const FILLER_PUNCT = [",", ".", ".", ",", "!", "?", ";", ":"];

/** Generate `count` random lowercase words joined by spaces. */
export function generateWords(count: number, opts: GenerateOptions = {}): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let w = rand(WORDS);
    if (opts.numbers && Math.random() < 0.08) {
      w = String(Math.floor(Math.random() * 900) + 100);
    } else if (opts.punctuation) {
      const r = Math.random();
      if (r < 0.12) w = capitalize(w);
      if (r > 0.82) w = w + rand(FILLER_PUNCT);
      else if (r < 0.05) w = '"' + w + '"';
    }
    void PUNCT;
    out.push(w);
  }
  let text = out.join(" ");
  if (opts.punctuation && !/[.!?]$/.test(text)) text += ".";
  return text;
}

export function generateQuote(): string {
  return rand(QUOTES);
}

// --- Seeded daily challenge (Task #10) ---

/** FNV-1a 32-bit hash — stable across runs and machines for daily seeds. */
export function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32) yielding [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UTC day string for the daily challenge (injectable clock for tests). */
export function dailyDateStr(now = Date.now()): string {
  const d = new Date(now);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * Seeded daily text — identical on every machine for a given date
 * (a shared daily challenge), fresh each day. Retries replay the
 * same text while the date holds.
 */
export function generateDaily(dateStr: string, count = 50): string {
  const rng = mulberry32(hashSeed(`typo-daily:${dateStr}`));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(WORDS[Math.floor(rng() * WORDS.length)]!);
  }
  return out.join(" ");
}

/** Normalize custom text: collapse whitespace/newlines into single spaces. */
export function normalizeCustom(text: string, maxChars = 1200): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (t.length > maxChars) t = t.slice(0, maxChars).trimEnd() + "…";
  return t;
}
