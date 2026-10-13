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

/** Normalize custom text: collapse whitespace/newlines into single spaces. */
export function normalizeCustom(text: string, maxChars = 1200): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (t.length > maxChars) t = t.slice(0, maxChars).trimEnd() + "…";
  return t;
}
