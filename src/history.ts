import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface HistoryEntry {
  date: string; // ISO
  mode: string; // e.g. "time 30s" | "words 25" | "quote" | "custom"
  wpm: number;
  raw: number;
  acc: number;
  correctChars: number;
  totalTyped: number;
  durationSec: number;
  consistency?: number; // 0–100, steady pace → ~100 (added v0.2, optional for old rows)
  weakKeys?: { key: string; acc: number; avgMs: number; presses: number }[]; // worst ≤5 (Task #2)
  gross?: number; // all-presses WPM incl. deleted chars (Task #4)
  cpm?: number; // correct chars per minute (Task #4)
  corrections?: number; // backspace/word-delete/clear presses (Task #4)
  mistakes?: { word: string; typed: string }[]; // completed words typed wrong, ≤20 (Task #5)
}

// --- Session replay (Task #5) ---
// Full keystroke log of the latest run, kept in its own file so the
// 500-row history.json stays lean. Overwritten on every finished test.

export interface ReplayEvent {
  t: number; // ms since first keystroke
  type: "insert" | "back" | "worddel" | "clear";
  text?: string; // insert payload (already filtered + capped)
}

export interface LastReplay {
  version: 1;
  date: string; // ISO
  mode: string;
  modeLabel: string;
  target: string;
  events: ReplayEvent[];
}

function replayFile(): string {
  return path.join(dir(), "last-replay.json");
}

/** Persist the finished run's keystroke log (best-effort, never throws). */
export async function saveLastReplay(rep: LastReplay): Promise<void> {
  try {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(replayFile(), JSON.stringify(rep), "utf8");
  } catch {
    /* replay is a bonus — a failed write must not break result saving */
  }
}

export async function loadLastReplay(): Promise<LastReplay | null> {
  try {
    const raw = await fs.readFile(replayFile(), "utf8");
    const rep = JSON.parse(raw) as LastReplay;
    if (!rep || rep.version !== 1 || typeof rep.target !== "string" || !Array.isArray(rep.events)) {
      return null;
    }
    return rep;
  } catch {
    return null;
  }
}

function dir(): string {
  return path.join(os.homedir(), ".typo");
}

function file(): string {
  return path.join(dir(), "history.json");
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const raw = await fs.readFile(file(), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export async function saveResult(entry: HistoryEntry): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  const hist = await loadHistory();
  hist.push(entry);
  // keep last 500
  const trimmed = hist.slice(-500);
  await fs.writeFile(file(), JSON.stringify(trimmed, null, 2), "utf8");
}

// --- Personal-best matrix (Task #6) ---

export interface ModeBest {
  mode: string;
  runs: number;
  wpm: number;
  acc: number;
  date: string; // ISO of the best run
}

/** Canonical sort: time (by seconds) → words (by count) → quote → custom → other. */
function parseModeSort(m: string): { group: number; num: number } {
  const t = /^time (\d+)s$/.exec(m);
  if (t) return { group: 0, num: Number(t[1]) };
  const w = /^words (\d+)$/.exec(m);
  if (w) return { group: 1, num: Number(w[1]) };
  if (m === "quote") return { group: 2, num: 0 };
  if (m === "custom") return { group: 3, num: 0 };
  return { group: 4, num: 0 };
}

function cmpMode(a: string, b: string): number {
  const pa = parseModeSort(a);
  const pb = parseModeSort(b);
  if (pa.group !== pb.group) return pa.group - pb.group;
  if (pa.num !== pb.num) return pa.num - pb.num;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Best run per mode. Ties break toward higher accuracy, then recency.
 * Pure function so grouping/sorting/tiebreaks are unit-testable.
 */
export function pbMatrix(hist: HistoryEntry[]): ModeBest[] {
  const map = new Map<string, { best: HistoryEntry; runs: number }>();
  for (const h of hist) {
    const cur = map.get(h.mode);
    if (!cur) {
      map.set(h.mode, { best: h, runs: 1 });
    } else {
      cur.runs++;
      const b = cur.best;
      if (h.wpm > b.wpm || (h.wpm === b.wpm && (h.acc > b.acc || (h.acc === b.acc && h.date > b.date)))) {
        cur.best = h;
      }
    }
  }
  return [...map.entries()]
    .map(([mode, v]) => ({ mode, runs: v.runs, wpm: v.best.wpm, acc: v.best.acc, date: v.best.date }))
    .sort((a, b) => cmpMode(a.mode, b.mode));
}

// --- History insights (Task #7): filters, averages, totals, activity ---

export interface HistoryFilter {
  /** case-insensitive substrings; a row matches if ANY matches its mode */
  modes?: string[];
  /** table rows to show (default 10) */
  last?: number;
  /** reference time for the activity heatmap (default Date.now) */
  now?: number;
}

/** Filter rows by mode substrings (case-insensitive, match-any). */
export function filterHistory(hist: HistoryEntry[], modes?: string[]): HistoryEntry[] {
  if (!modes || modes.length === 0) return hist;
  const needles = modes.map((m) => m.toLowerCase());
  return hist.filter((h) => needles.some((n) => h.mode.toLowerCase().includes(n)));
}

/** Mean WPM/acc/cons over the last `n` rows (cons over rows that have it). */
export function lastNAvg(
  hist: HistoryEntry[],
  n = 10,
): { runs: number; wpm: number; acc: number; cons: number } {
  const rows = hist.slice(-Math.max(1, n));
  const wpm = rows.reduce((a, h) => a + h.wpm, 0) / rows.length;
  const acc = rows.reduce((a, h) => a + h.acc, 0) / rows.length;
  const conss = rows.map((h) => h.consistency ?? NaN).filter((x) => Number.isFinite(x));
  const cons = conss.length > 0 ? conss.reduce((a, b) => a + b, 0) / conss.length : NaN;
  return { runs: rows.length, wpm, acc, cons };
}

/** Totals: tests, seconds typed, words (correctChars / 5). */
export function totals(hist: HistoryEntry[]): { tests: number; seconds: number; words: number } {
  return {
    tests: hist.length,
    seconds: hist.reduce((a, h) => a + (Number.isFinite(h.durationSec) ? h.durationSec : 0), 0),
    words: Math.round(hist.reduce((a, h) => a + (Number.isFinite(h.correctChars) ? h.correctChars : 0), 0) / 5),
  };
}

/** Compact duration: 45s / 12m / 1.5h. */
export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

/** Per-day run counts for the last `days` UTC days, oldest → today. */
export function activityCells(hist: HistoryEntry[], days = 14, now = Date.now()): number[] {
  const counts = new Array<number>(days).fill(0);
  const dayMs = 86400000;
  const today = Math.floor(now / dayMs);
  for (const h of hist) {
    const t = Date.parse(h.date);
    if (!Number.isFinite(t)) continue;
    const ago = today - Math.floor(t / dayMs);
    if (ago >= 0 && ago < days) counts[days - 1 - ago]++;
  }
  return counts;
}

/** Spark-bar for activity cells: idle days render as ·, busiest as █. */
export function activityBar(counts: number[]): string {
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const max = Math.max(...counts, 1);
  return counts
    .map((c) => {
      if (c <= 0) return "·";
      return blocks[Math.min(blocks.length - 1, Math.ceil((c / max) * blocks.length) - 1)]!;
    })
    .join("");
}

export function summarize(hist: HistoryEntry[], filter: HistoryFilter = {}): string {
  if (hist.length === 0) return "No history yet. Run `typo` to record your first test.";
  const rows = filterHistory(hist, filter.modes);
  if (rows.length === 0) {
    const available = [...new Set(hist.map((h) => h.mode))].join(", ");
    return `No runs match filter: ${(filter.modes ?? []).join(", ")}\nAvailable modes: ${available}`;
  }
  const lastN = Math.min(Math.max(1, Math.floor(filter.last ?? 10)), 500);
  const wpms = rows.map((h) => h.wpm);
  const best = Math.max(...wpms);
  const avg = wpms.reduce((a, b) => a + b, 0) / wpms.length;
  const conss = rows.map((h) => h.consistency ?? NaN).filter((x) => Number.isFinite(x));
  const avgCons = conss.length > 0 ? conss.reduce((a, b) => a + b, 0) / conss.length : NaN;
  const recent = rows.slice(-lastN).reverse();
  const last10 = lastNAvg(rows, 10);
  const tot = totals(rows);
  const cells = activityCells(rows, 14, filter.now ?? Date.now());
  const activeDays = cells.filter((c) => c > 0).length;
  const lines: string[] = [];
  if (filter.modes && filter.modes.length > 0) {
    lines.push(`Filter: ${filter.modes.join(", ")} (${rows.length} run${rows.length === 1 ? "" : "s"})`);
  }
  lines.push(
    `Tests: ${rows.length}   Best: ${best.toFixed(1)} wpm   Avg: ${avg.toFixed(1)} wpm` +
      (Number.isFinite(avgCons) ? `   Cons: ${avgCons.toFixed(1)}%` : ""),
  );
  lines.push(
    `Last ${last10.runs}: ${last10.wpm.toFixed(1)} wpm   ${last10.acc.toFixed(1)}% acc` +
      (Number.isFinite(last10.cons) ? `   ${last10.cons.toFixed(1)}% cons` : ""),
  );
  lines.push(
    `Total: ${fmtDuration(tot.seconds)} typing   ${tot.words.toLocaleString("en-US")} words   Activity 14d: ${activityBar(cells)} (${activeDays}/14 days)`,
  );
  const pbs = pbMatrix(rows);
  lines.push(`PBs (${pbs.length} mode${pbs.length === 1 ? "" : "s"}):`);
  for (const p of pbs) {
    lines.push(
      `  ${p.mode.padEnd(10)} ${p.wpm.toFixed(1).padStart(5)} wpm  ${p.acc.toFixed(1).padStart(5)}%  x${p.runs}  ${p.date.slice(0, 10)}`,
    );
  }
  lines.push("");
  lines.push("  date                  mode        wpm    raw    acc   cons");
  lines.push("  ─────────────────────────────────────────────────────────");
  for (const h of recent) {
    const d = h.date.slice(0, 16).replace("T", " ");
    const cons = h.consistency != null ? `${h.consistency.toFixed(1).padStart(5)}%` : "    — ";
    lines.push(
      `  ${d}   ${h.mode.padEnd(10)} ${h.wpm.toFixed(1).padStart(5)} ${h.raw
        .toFixed(1)
        .padStart(5)}  ${h.acc.toFixed(1).padStart(5)}% ${cons}`,
    );
  }
  return lines.join("\n");
}
