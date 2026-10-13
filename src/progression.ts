// Local progression: XP/levels, daily streaks, milestone badges.
// Everything derives from ~/.typo/history.json — no accounts, no server.
// XP follows 10FastFingers' curve: level N starts at 100×N² total XP.
import type { HistoryEntry } from "./history.js";

/** 1 XP per active second, minimum 1 per finished run. */
export function xpForDuration(durationSec: number): number {
  if (!Number.isFinite(durationSec)) return 1;
  return Math.max(1, Math.round(durationSec));
}

export function totalXp(hist: HistoryEntry[]): number {
  return hist.reduce((a, h) => a + xpForDuration(h.durationSec), 0);
}

/** XP threshold at which level N starts (L0 below 100). */
export function xpThreshold(level: number): number {
  return 100 * level * level;
}

/** Level for a total: largest N with 100×N² ≤ xp. */
export function levelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp < 100) return 0;
  return Math.floor(Math.sqrt(xp / 100));
}

/** Progress within the current level: xp into it + xp needed for next. */
export function xpProgress(xp: number): { level: number; into: number; need: number } {
  const level = levelForXp(xp);
  const base = xpThreshold(level);
  const need = xpThreshold(level + 1) - base;
  return { level, into: xp - base, need };
}

const DAY_MS = 86400000;

/** Distinct UTC day indices with ≥1 run, ignoring future-dated rows. */
function activeDays(hist: HistoryEntry[], now: number): Set<number> {
  const today = Math.floor(now / DAY_MS);
  const days = new Set<number>();
  for (const h of hist) {
    const t = Date.parse(h.date);
    if (!Number.isFinite(t)) continue;
    const d = Math.floor(t / DAY_MS);
    if (d <= today) days.add(d);
  }
  return days;
}

/**
 * Daily streaks from run dates. Current stays alive when the latest
 * active day is today or yesterday; otherwise it reads 0 (broken).
 */
export function streaks(hist: HistoryEntry[], now = Date.now()): { current: number; best: number } {
  const days = activeDays(hist, now);
  if (days.size === 0) return { current: 0, best: 0 };
  const sorted = [...days].sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === sorted[i - 1]! + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const today = Math.floor(now / DAY_MS);
  const latest = sorted[sorted.length - 1]!;
  let current = 0;
  if (latest === today || latest === today - 1) {
    current = 1;
    for (let d = latest - 1; days.has(d); d--) current++;
  }
  return { current, best: Math.max(best, current) };
}

export interface Badge {
  id: string;
  name: string;
  desc: string;
  earned: boolean;
}

/** Milestone badges derived from history + streaks (pure, testable). */
export function badges(hist: HistoryEntry[], now = Date.now()): Badge[] {
  const st = streaks(hist, now);
  const bestWpm = hist.reduce((a, h) => Math.max(a, Number.isFinite(h.wpm) ? h.wpm : 0), 0);
  const bestAcc = hist.reduce((a, h) => Math.max(a, Number.isFinite(h.acc) ? h.acc : 0), 0);
  const at: [string, string, string, boolean][] = [
    ["first-steps", "First steps", "finish 1 test", hist.length >= 1],
    ["tenacious", "Tenacious", "finish 10 tests", hist.length >= 10],
    ["centurion", "Centurion", "finish 100 tests", hist.length >= 100],
    ["week-warrior", "Week warrior", "7-day streak", st.best >= 7],
    ["unstoppable", "Unstoppable", "30-day streak", st.best >= 30],
    ["speedy", "Speedy", "reach 40 wpm", bestWpm >= 40],
    ["swift", "Swift", "reach 60 wpm", bestWpm >= 60],
    ["blazing", "Blazing", "reach 80 wpm", bestWpm >= 80],
    ["unreal", "Unreal", "reach 100 wpm", bestWpm >= 100],
    ["sharpshooter", "Sharpshooter", "99%+ accuracy run", bestAcc >= 99],
  ];
  return at.map(([id, name, desc, earned]) => ({ id, name, desc, earned }));
}
