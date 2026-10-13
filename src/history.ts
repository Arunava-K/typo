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

export function summarize(hist: HistoryEntry[]): string {
  if (hist.length === 0) return "No history yet. Run `typo` to record your first test.";
  const wpms = hist.map((h) => h.wpm);
  const best = Math.max(...wpms);
  const avg = wpms.reduce((a, b) => a + b, 0) / wpms.length;
  const conss = hist.map((h) => h.consistency ?? NaN).filter((x) => Number.isFinite(x));
  const avgCons = conss.length > 0 ? conss.reduce((a, b) => a + b, 0) / conss.length : NaN;
  const recent = hist.slice(-10).reverse();
  const lines: string[] = [];
  lines.push(
    `Tests: ${hist.length}   Best: ${best.toFixed(1)} wpm   Avg: ${avg.toFixed(1)} wpm` +
      (Number.isFinite(avgCons) ? `   Cons: ${avgCons.toFixed(1)}%` : ""),
  );
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
