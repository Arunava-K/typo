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

// --- Sentence mode (Task #17): full grammatical sentences ---

const SENTENCES: string[] = [
  "The river bends around the old stone bridge at dawn.",
  "She packed her bags before the sun came up.",
  "Every garden needs both patience and rain.",
  "The cat slept through the entire thunderstorm.",
  "We found a small cafe hidden behind the station.",
  "His letter arrived three weeks after he left.",
  "The mountain trail grows steep past the waterfall.",
  "Children raced their bicycles down the hill.",
  "A quiet library is the best place to think.",
  "The baker sells warm bread every morning.",
  "They crossed the desert in an old blue truck.",
  "My grandmother tells the greatest stories.",
  "The orchestra tuned their instruments slowly.",
  "Rain tapped against the bedroom window all night.",
  "He fixed the broken fence with spare wire.",
  "The lighthouse guides ships through the fog.",
  "We watched the sunset from the rooftop garden.",
  "Her garden grows tomatoes, basil, and mint.",
  "The train arrived exactly on the minute.",
  "Dogs barked at the stranger by the gate.",
  "The museum opens its new wing in spring.",
  "He learned to sail during one calm summer.",
  "The old clock chimes thirteen times at midnight.",
  "Fresh snow covered the silent pine forest.",
  "She keeps a diary under her pillow.",
  "The chef tasted the soup and smiled broadly.",
  "Wild geese flew south before the frost.",
  "Our neighbors built a treehouse last weekend.",
  "The river carried fallen leaves toward the sea.",
  "He whistled while he painted the front door.",
  "The stars appeared one by one after dusk.",
  "A red fox darted across the empty road.",
  "The teacher wrote the lesson on the board.",
  "Warm wind moved through the tall dry grass.",
  "She bought fresh apples at the corner market.",
  "The puppy chewed my left shoe again today.",
  "Clouds gathered over the distant gray hills.",
  "He reads one chapter before turning off the lamp.",
  "The ferry crosses the bay twice each morning.",
  "Autumn paints the valley gold and crimson.",
];

/**
 * N full sentences joined by spaces (cycles the shuffled bank when
 * n exceeds it). Injectable rng for deterministic tests.
 */
export function generateSentences(n: number, rng: () => number = Math.random): string {
  const count = Math.max(1, Math.floor(n));
  const bank = [...SENTENCES];
  for (let i = bank.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bank[i], bank[j]] = [bank[j]!, bank[i]!];
  }
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(bank[i % bank.length]!);
  return out.join(" ");
}
