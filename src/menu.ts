import { promises as fs } from "node:fs";
import { ansi, c, cycler, divider, keycap, logo, onOffPill, padCenter, stripAnsi, termHeight, termWidth, xpBar } from "./ui.js";
import { buildBox, composeScreen, deleteLastWord, enterFullscreen, isWordDeleteKey, leaveFullscreen } from "./engine.js";
import {
  activityBar,
  activityCells,
  fmtDuration,
  histBar,
  lastNAvg,
  loadHistory,
  pbMatrix,
  totals,
  wpmHistogram,
  type HistoryEntry,
} from "./history.js";
import { badges, streaks, totalXp, xpProgress } from "./progression.js";
import { CODE_LANGS } from "./code.js";
import { sparkline } from "./stats.js";

export interface MenuConfig {
  mode: "time" | "words" | "quote" | "custom" | "daily" | "code" | "zen";
  timeSec: number;
  wordCount: number;
  punctuation: boolean;
  numbers: boolean;
  customFile: string;
  codeLang: string;
  suddenDeath: boolean;
  noBackspace: boolean;
  minAcc: number | null;
}

export type MenuResult = { kind: "start"; config: MenuConfig } | { kind: "quit" };

export const TIME_OPTS = [15, 30, 60, 120, 240];
export const WORD_OPTS = [10, 25, 50, 100, 200];
const MODES = ["time", "words", "quote", "custom", "daily", "code", "zen"] as const;
type ModeName = (typeof MODES)[number];

/**
 * Center each visible line within `width`. Blocks built by `buildBox` and the
 * footer below it are narrower than the content column, so left-aligning them
 * (as `composeScreen` does) pushes the panel off-center. Centering them here
 * lets the global column pad keep everything symmetric.
 */
function centerBlock(lines: string[], width: number): string[] {
  return lines.map((l) => (l.length === 0 ? "" : padCenter(l, width)));
}

/**
 * ANSI-aware truncate to `width` visible columns (assumes single-width glyphs).
 */
function truncateVisible(s: string, width: number): string {
  if (stripAnsi(s).length <= width) return s;
  let out = "";
  let vis = 0;
  for (let i = 0; i < s.length; ) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i, i + 12));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    if (vis >= width) break;
    out += s[i];
    vis++;
    i++;
  }
  return out + ansi.reset;
}

/** Rounded box with the section name set into its top border. */
function buildTitledBox(title: string, lines: string[], innerW: number): string[] {
  const titleLen = stripAnsi(title).length;
  const fill = Math.max(0, innerW - titleLen - 1);
  const out = [
    c(ansi.cyan, "╭─ ") + c(ansi.bold + ansi.cyan, title) + " " + c(ansi.cyan, "─".repeat(fill) + "╮"),
  ];
  for (const ln of lines) {
    const vis = stripAnsi(ln).length;
    const body = vis > innerW ? truncateVisible(ln, innerW) : ln;
    out.push(
      c(ansi.cyan, "│") +
        "  " +
        body +
        " ".repeat(Math.max(0, innerW - Math.min(vis, innerW))) +
        "  " +
        c(ansi.cyan, "│"),
    );
  }
  out.push(c(ansi.cyan, "╰" + "─".repeat(innerW + 2) + "╯"));
  return out;
}

interface HistCard {
  title: string;
  lines: string[];
}

const HIST_LABEL_W = 7;

/** `label` in gray, padded to a fixed column so values line up. */
function metric(label: string, value: string): string {
  return c(ansi.gray, label.padEnd(HIST_LABEL_W)) + value;
}

/** A `metric` padded to `width` visible columns (0 = no padding). */
function seg(label: string, value: string, width: number): string {
  const s = metric(label, value);
  return s + " ".repeat(Math.max(0, width - stripAnsi(s).length));
}

/** Structured, colored cards for the interactive history screen. */
function buildHistoryCards(hist: HistoryEntry[], recentRows: number): HistCard[] {
  const now = Date.now();
  const cards: HistCard[] = [];
  const num = (v: string) => c(ansi.bold + ansi.white, v);
  const yel = (v: string) => c(ansi.bold + ansi.yellow, v);
  const gry = (v: string) => c(ansi.gray, v);

  const wpms = hist.map((h) => h.wpm);
  const best = Math.max(...wpms);
  const avg = wpms.reduce((a, b) => a + b, 0) / wpms.length;
  const conss = hist.map((h) => h.consistency ?? NaN).filter((x) => Number.isFinite(x));
  const avgCons = conss.length > 0 ? conss.reduce((a, b) => a + b, 0) / conss.length : NaN;
  const last10 = lastNAvg(hist, 10);
  const tot = totals(hist);
  const cells = activityCells(hist, 14, now);
  const activeDays = cells.filter((x) => x > 0).length;

  cards.push({
    title: "overview",
    lines: [
      seg("tests", num(String(hist.length)), 20) + seg("avg", num(`${avg.toFixed(1)} wpm`), 0),
      seg("best", yel(`${best.toFixed(1)} wpm`), 20) +
        seg("cons", num(Number.isFinite(avgCons) ? `${avgCons.toFixed(1)}%` : "—"), 0),
      seg("total", num(fmtDuration(tot.seconds)) + gry(" typing"), 20) +
        seg("words", num(tot.words.toLocaleString("en-US")), 0),
      seg(`last${last10.runs}`, num(`${last10.wpm.toFixed(1)} wpm`), 20) +
        seg("acc", num(`${last10.acc.toFixed(1)}%`), 0) +
        (Number.isFinite(last10.cons) ? gry("   ") + num(`${last10.cons.toFixed(1)}%`) + gry(" cons") : ""),
    ],
  });

  const xp = totalXp(hist);
  const prog = xpProgress(xp);
  const st = streaks(hist, now);
  const bd = badges(hist, now);
  const earned = bd.filter((b) => b.earned);
  const badgeStr =
    earned.length > 0 ? earned.map((b) => c(ansi.cyan, b.name)).join(gry(" · ")) : gry("—");
  cards.push({
    title: "progression",
    lines: [
      seg(
        "level",
        num(String(prog.level)) +
          gry(`   ${xp.toLocaleString("en-US")} XP · ${(prog.need - prog.into).toLocaleString("en-US")} to L${prog.level + 1}`),
        0,
      ),
      seg("streak", num(st.current > 0 ? `${st.current} day${st.current === 1 ? "" : "s"}` : "—") + gry(`   best ${st.best}`), 0),
      seg(
        "badges",
        num(`${earned.length}/${bd.length}`) +
          gry("   ") +
          badgeStr +
          (earned.length < bd.length ? gry(`   (+${bd.length - earned.length} locked)`) : ""),
        0,
      ),
    ],
  });

  cards.push({
    title: "activity",
    lines: [
      seg("14d", c(ansi.cyan, activityBar(cells)) + gry(`   ${activeDays}/14 days`), 0),
      seg("trend", c(ansi.cyan, sparkline(wpms, 40) || "—") + gry("   wpm"), 0),
    ],
  });

  const bins = wpmHistogram(wpms, 6);
  const maxBin = Math.max(...bins.map((b) => b.count), 1);
  cards.push({
    title: "distribution",
    lines: bins.map(
      (b) =>
        gry(`${b.lo.toFixed(0)}-${b.hi.toFixed(0)}`.padEnd(7)) +
        c(ansi.magenta, histBar(b.count, maxBin).padEnd(20)) +
        gry(` ${b.count}`),
    ),
  });

  const pbs = pbMatrix(hist);
  cards.push({
    title: "best per mode",
    lines: pbs.map(
      (p) =>
        c(ansi.white, p.mode.padEnd(11)) +
        yel(p.wpm.toFixed(1).padStart(5)) +
        gry(" wpm   ") +
        num(`${p.acc.toFixed(1)}%`) +
        gry(`   x${p.runs}   ${p.date.slice(0, 10)}`),
    ),
  });

  const recent = hist.slice(-recentRows).reverse();
  const header =
    gry("date".padEnd(16)) +
    "  " +
    gry("mode".padEnd(10)) +
    " " +
    gry("wpm".padStart(5)) +
    " " +
    gry("raw".padStart(5)) +
    "  " +
    gry("acc".padStart(6)) +
    " " +
    gry("cons".padStart(5));
  const recentLines = [header, gry("─".repeat(stripAnsi(header).length))];
  for (const h of recent) {
    const d = h.date.slice(0, 16).replace("T", " ");
    const cons = h.consistency != null ? `${h.consistency.toFixed(1)}%`.padStart(5) : "    —";
    recentLines.push(
      gry(d) +
        "  " +
        c(ansi.white, h.mode.padEnd(10)) +
        " " +
        yel(h.wpm.toFixed(1).padStart(5)) +
        " " +
        num(h.raw.toFixed(1).padStart(5)) +
        "  " +
        num(`${h.acc.toFixed(1)}%`.padStart(6)) +
        " " +
        gry(cons),
    );
  }
  cards.push({ title: "recent runs", lines: recentLines });

  return cards;
}

export type RowId =
  | "mode"
  | "time"
  | "words"
  | "file"
  | "lang"
  | "punct"
  | "numbers"
  | "death"
  | "noback"
  | "minacc"
  | "start"
  | "history"
  | "quit";

/** History viewer tabs — one screen per topic so nothing overflows. */
const HIST_TABS = ["overview", "trends", "bests", "runs"] as const;
type HistTab = (typeof HIST_TABS)[number];
const HIST_TAB_CARDS: Record<HistTab, string[]> = {
  overview: ["overview", "progression"],
  trends: ["activity", "distribution"],
  bests: ["best per mode"],
  runs: ["recent runs"],
};

/** Rows shown for each mode — only relevant options appear. */
export function buildRows(mode: ModeName): RowId[] {
  const rows: RowId[] = ["mode"];
  if (mode === "time") rows.push("time");
  if (mode === "words") rows.push("words");
  if (mode === "custom") rows.push("file");
  if (mode === "code") rows.push("lang");
  rows.push("punct", "numbers", "death", "noback", "minacc", "start", "history", "quit");
  return rows;
}

/** Step to next/previous option with wrap-around. */
export function cycle<T>(opts: readonly T[], cur: T, dir: 1 | -1): T {
  let i = opts.indexOf(cur);
  if (i === -1) i = dir === 1 ? -1 : 0;
  return opts[(i + dir + opts.length) % opts.length]!;
}

/** Snap an arbitrary number to the nearest option. */
export function snap(opts: readonly number[], v: number): number {
  let best = opts[0]!;
  for (const o of opts) {
    if (Math.abs(o - v) < Math.abs(best - v)) best = o;
  }
  return best;
}

const ARROWS: Record<string, "up" | "down" | "left" | "right"> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
};

const MODE_LABEL: Record<ModeName, string> = {
  time: "time",
  words: "words",
  quote: "quote",
  custom: "custom file",
  daily: "daily",
  code: "code",
  zen: "zen",
};

const MODE_ICON: Record<ModeName, string> = {
  time: "◷",
  words: "≡",
  quote: "❝",
  custom: "✎",
  daily: "◉",
  code: "<>",
  zen: "∞",
};

export async function runMenu(defaults: MenuConfig): Promise<MenuResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("typo needs an interactive terminal (TTY).");
    return { kind: "quit" };
  }

  const stdin = process.stdin;
  const stdout = process.stdout;

  const cfg: MenuConfig = {
    ...defaults,
    timeSec: snap(TIME_OPTS, defaults.timeSec),
    wordCount: snap(WORD_OPTS, defaults.wordCount),
    codeLang: (CODE_LANGS as readonly string[]).includes(defaults.codeLang) ? defaults.codeLang : "python",
    minAcc: [null, 80, 85, 90, 95].includes(defaults.minAcc) ? defaults.minAcc : null,
  };
  let rows = buildRows(cfg.mode);
  let sel = 0;
  let editing = false;
  let editBuf = "";
  let message = "";
  let screen: "menu" | "history" = "menu";
  let histEntries: HistoryEntry[] = [];
  let histTab = 0;
  let histScroll = 0;
  let histBudget = 10;
  /** Two short status lines (kept ≤ body width so the box stays tight). */
  let profileLines: string[] = [];

  function rowValue(id: RowId): string {
    switch (id) {
      case "mode":
        return cycler(MODE_LABEL[cfg.mode]);
      case "time":
        return cycler(`${cfg.timeSec}s`);
      case "words":
        return cycler(String(cfg.wordCount));
      case "file":
        if (editing) return c(ansi.cyan, "[") + editBuf + c(ansi.inverse, " ") + c(ansi.cyan, "]");
        return cfg.customFile
          ? c(ansi.white, cfg.customFile)
          : c(ansi.gray, "○ no file yet — select to add one");
      case "lang":
        return cycler(cfg.codeLang);
      case "punct":
        return onOffPill(cfg.punctuation);
      case "numbers":
        return onOffPill(cfg.numbers);
      case "death":
        return onOffPill(cfg.suddenDeath);
      case "noback":
        return onOffPill(cfg.noBackspace);
      case "minacc":
        return cycler(cfg.minAcc == null ? "off" : `${cfg.minAcc}%`);
      case "start":
        return c(ansi.bold + ansi.green, "▶  start test");
      case "history":
        return c(ansi.cyan, "↺  history");
      case "quit":
        return c(ansi.gray, "⎋  quit");
    }
  }

  /**
   * Single icon prefix per option row — the icon lives here OR in the
   * value, never both (double icons made the old menu look cluttered).
   */
  /**
   * Icons mirror Phosphor's picks for these concepts (Play, Hash, TextAa,
   * Pencil, Quotes, ClockCounterClockwise…), using the nearest glyph the
   * terminal can render. Real Phosphor SVGs can't draw in a terminal, and
   * Nerd-Font codepoints would be tofu for users without patched fonts —
   * so geometric text glyphs only, no emoji.
   *
   * The icon field is always exactly 2 columns (`Aa` is naturally wide,
   * the rest are padded) so the option names left-align with each other.
   */
  function rowLabel(id: RowId): string {
    const ic = (g: string): string => `${g.padEnd(2)} `;
    switch (id) {
      case "mode":
        return `${ic(MODE_ICON[cfg.mode])}mode`;
      case "time":
        return `${ic("◔")}duration`;
      case "words":
        return `${ic("≡")}words`;
      case "file":
        return `${ic("✎")}file`;
      case "lang":
        return `${ic("<>")}language`;
      case "punct":
        return `${ic("Aa")}punctuation`;
      case "numbers":
        return `${ic("#")}numbers`;
      case "death":
        return `${ic("✗")}sudden death`;
      case "noback":
        return `${ic("⌫")}no backspace`;
      case "minacc":
        return `${ic("%")}min accuracy`;
      case "start":
        return "";
      case "history":
        return "";
      case "quit":
        return "";
    }
  }

  function draw(): void {
    const vpCols = termWidth();
    const vpRows = Math.max(10, termHeight());
    const contentWidth = Math.min(vpCols, 60);

    if (screen === "history") {
      const foot = `${keycap("←→/tab")} ${c(ansi.gray, "tabs")}  ${c(ansi.gray, "·")}  ${keycap("↑↓")} ${c(ansi.gray, "scroll")}  ${c(ansi.gray, "·")}  ${keycap("esc")} ${c(ansi.gray, "back")}`;
      if (histEntries.length === 0) {
        const w = Math.min(contentWidth, vpCols) - 4;
        const box = buildTitledBox(
          "history",
          [c(ansi.gray, "No history yet — finish a test to start recording.")],
          w,
        );
        const lines = [...box, "", foot];
        stdout.write(composeScreen(centerBlock(lines, w + 4), vpCols, vpRows, w + 4));
        return;
      }

      // Tabbed viewer: exactly one topic per screen, windowed to the
      // viewport so the top can never scroll off (see screenshot #1).
      const tab = HIST_TABS[histTab]!;
      const availW = Math.max(40, Math.min(vpCols - 4, 92));
      const allCards = buildHistoryCards(histEntries, histEntries.length);
      const wanted = HIST_TAB_CARDS[tab];
      const cards = allCards.filter((cd) => wanted.includes(cd.title));

      let innerW = 0;
      for (const cd of cards) {
        innerW = Math.max(innerW, cd.title.length + 1);
        for (const l of cd.lines) innerW = Math.max(innerW, stripAnsi(l).length);
      }
      innerW = Math.max(20, Math.min(innerW, availW - 4));

      const full: string[] = [];
      cards.forEach((cd, i) => {
        if (i > 0) full.push("");
        full.push(...buildTitledBox(cd.title, cd.lines, innerW));
      });

      const titleLine = `${c(ansi.bold + ansi.white, "history")}  ${c(ansi.gray, `·  ${histEntries.length} run${histEntries.length === 1 ? "" : "s"}`)}`;
      const tabBar = HIST_TABS.map((t, i) =>
        i === histTab ? c(ansi.bold + ansi.cyan, `● ${t}`) : c(ansi.gray, `○ ${t}`),
      ).join("  ");
      const head = [titleLine, tabBar, ""];
      // tail is always 3 lines (position + blank + footer) so the frame
      // height is stable and total lines can never exceed vpRows.
      const budget = Math.max(4, vpRows - head.length - 3);
      histBudget = budget;
      const maxScroll = Math.max(0, full.length - budget);
      if (histScroll > maxScroll) histScroll = maxScroll;
      if (histScroll < 0) histScroll = 0;
      const visible = full.slice(histScroll, histScroll + budget);
      const above = histScroll;
      const below = full.length - (histScroll + visible.length);
      let posLine: string;
      if (above > 0 || below > 0) {
        posLine = c(ansi.gray, `${above > 0 ? `▲ ${above} more  ·  ` : ""}rows ${histScroll + 1}–${histScroll + visible.length} of ${full.length}${below > 0 ? `  ·  ▼ ${below} more` : ""}`);
      } else if (tab === "runs") {
        posLine = c(ansi.gray, `${histEntries.length} run${histEntries.length === 1 ? "" : "s"}`);
      } else if (tab === "bests") {
        const n = cards[0]?.lines.length ?? 0;
        posLine = c(ansi.gray, `${n} mode${n === 1 ? "" : "s"}`);
      } else {
        posLine = "";
      }
      const lines = [...head, ...visible, posLine, "", foot];
      stdout.write(composeScreen(centerBlock(lines, innerW + 4), vpCols, vpRows, innerW + 4));
      return;
    }

    const options: { label: string; value: string; active: boolean }[] = [];
    const actions: string[] = [];
    const LABEL_W = 15; // fits "Aa punctuation", the longest option label
    rows.forEach((id, i) => {
      const active = i === sel;
      const marker = active ? c(ansi.bold + ansi.cyan, "▌ ") : "  ";
      if (id === "start" || id === "history" || id === "quit") {
        actions.push(marker + rowValue(id));
        return;
      }
      options.push({ label: rowLabel(id), value: rowValue(id), active });
    });

    // Justified rows: labels hug the left, values hug the right edge, so
    // the panel width is load-bearing instead of trailing dead space.
    const valueW = Math.max(0, ...options.map((o) => stripAnsi(o.value).length));
    const profW = profileLines.length > 0 ? Math.max(...profileLines.map((l) => stripAnsi(l).length)) : 0;
    // Roomy minimum so the panel never hugs the rows (screenshot #3);
    // clamped for very narrow terminals so the box can't overflow them.
    const minW = Math.min(34, Math.max(16, vpCols - 10));
    const innerW = Math.max(2 + LABEL_W + 1 + valueW, profW, minW);
    const optionLines = options.map((o) => {
      const marker = o.active ? c(ansi.bold + ansi.cyan, "▌ ") : "  ";
      const label = c(o.active ? ansi.bold + ansi.white : ansi.gray, o.label.padEnd(LABEL_W));
      const gap = " ".repeat(Math.max(1, innerW - 2 - LABEL_W - stripAnsi(o.value).length));
      return marker + label + gap + o.value;
    });
    // Actions read as menu items under the options — same left edge,
    // not centered (centered buttons of different widths zigzag).
    const actionLines = actions;
    const headTitle = padCenter(`${logo()}  ${c(ansi.gray, "·  setup")}`, innerW);
    const headSub = padCenter(c(ansi.gray, "pick a setup, hit enter"), innerW);
    const content = [headTitle, headSub, "", ...optionLines, "", divider(innerW), "", ...actionLines];
    if (profileLines.length > 0) {
      content.push("", divider(innerW), ...profileLines.map((l) => padCenter(l, innerW)));
    }
    const lines = buildBox(content, 3);
    lines.push("");
    if (editing) {
      lines.push(
        padCenter(
          `${keycap("type path")}  ${c(ansi.gray, "·")}  ${keycap("⏎")} ${c(ansi.gray, "confirm")}  ${c(ansi.gray, "·")}  ${keycap("esc")} ${c(ansi.gray, "cancel")}`,
          contentWidth,
        ),
      );
    } else {
      lines.push(
        padCenter(
          `${keycap("↑↓/jk")} ${c(ansi.gray, "move")}  ${c(ansi.gray, "·")}  ${keycap("←→/hl")} ${c(ansi.gray, "change")}  ${c(ansi.gray, "·")}  ${keycap("⏎")} ${c(ansi.gray, "select")}  ${c(ansi.gray, "·")}  ${keycap("q")} ${c(ansi.gray, "quit")}`,
          contentWidth,
        ),
      );
    }
    if (message) {
      lines.push(padCenter(c(ansi.bold + ansi.red, `!  ${message}`), contentWidth));
    }
    stdout.write(composeScreen(centerBlock(lines, contentWidth), vpCols, vpRows, contentWidth));
  }

  function adjust(id: RowId, dir: 1 | -1): void {
    message = "";
    switch (id) {
      case "mode":
        cfg.mode = cycle(MODES, cfg.mode, dir);
        rows = buildRows(cfg.mode);
        sel = Math.min(sel, rows.length - 1);
        break;
      case "time":
        cfg.timeSec = cycle(TIME_OPTS, cfg.timeSec, dir);
        break;
      case "words":
        cfg.wordCount = cycle(WORD_OPTS, cfg.wordCount, dir);
        break;
      case "lang":
        cfg.codeLang = cycle(CODE_LANGS as readonly string[], cfg.codeLang, dir);
        break;
      case "punct":
        cfg.punctuation = !cfg.punctuation;
        break;
      case "numbers":
        cfg.numbers = !cfg.numbers;
        break;
      case "death":
        cfg.suddenDeath = !cfg.suddenDeath;
        break;
      case "noback":
        cfg.noBackspace = !cfg.noBackspace;
        break;
      case "minacc":
        cfg.minAcc = cycle([null, 80, 85, 90, 95] as (number | null)[], cfg.minAcc, dir);
        break;
      default:
        break;
    }
  }

  return new Promise<MenuResult>((resolve) => {
    // Background profile: level · XP bar · streak · best — redraws once ready.
    void loadHistory()
      .then((h) => {
        if (h.length === 0 || screen !== "menu") return;
        const xp = totalXp(h);
        const prog = xpProgress(xp);
        const st = streaks(h, Date.now());
        const best = Math.max(...h.map((x) => x.wpm));
        const streakTxt = st.current > 0 ? `${st.current}d streak` : `○ no streak yet`;
        profileLines = [
          c(ansi.gray, `lv ${prog.level}  `) +
            xpBar(prog.into, prog.need, 8) +
            c(ansi.gray, `  ${xp.toLocaleString("en-US")} xp`),
          c(ansi.gray, `${streakTxt}  ·  ★ ${best.toFixed(0)} best`),
        ];
        draw();
      })
      .catch(() => {});

    function cleanup(): void {
      stdin.off("data", onData);
      process.stdout.off("resize", onResize);
      try {
        stdin.setRawMode(false);
      } catch {
        /* noop */
      }
      stdin.pause();
      leaveFullscreen();
    }

    async function doStart(): Promise<void> {
      if (cfg.mode === "custom") {
        const f = cfg.customFile.trim();
        if (!f) {
          message = "enter a file path first (select the file row)";
          draw();
          return;
        }
        try {
          const raw = await fs.readFile(f, "utf8");
          if (!raw.trim()) {
            message = `file is empty: ${f}`;
            draw();
            return;
          }
        } catch {
          message = `cannot read file: ${f}`;
          draw();
          return;
        }
      }
      cleanup();
      resolve({ kind: "start", config: { ...cfg } });
    }

    async function openHistory(): Promise<void> {
      histEntries = await loadHistory();
      screen = "history";
      histTab = 0;
      histScroll = 0;
      draw();
    }

    function activate(id: RowId): void {
      switch (id) {
        case "mode":
        case "time":
        case "words":
        case "lang":
          adjust(id, 1);
          draw();
          break;
        case "file":
          editing = true;
          editBuf = cfg.customFile;
          message = "";
          draw();
          break;
        case "punct":
        case "numbers":
        case "death":
        case "noback":
        case "minacc":
          adjust(id, 1);
          draw();
          break;
        case "start":
          void doStart();
          break;
        case "history":
          void openHistory();
          break;
        case "quit":
          cleanup();
          resolve({ kind: "quit" });
          break;
      }
    }

    const onData = (chunk: Buffer): void => {
      const data = chunk.toString("utf8");
      // Stray cursor-position reports are never input.
      if (/^\x1b\[\d+;\d+R/.test(data)) return;
      if (data === "\x03") {
        cleanup();
        resolve({ kind: "quit" });
        return;
      }

      if (screen === "history") {
        // Tabbed viewer: ←→/tab switch screens, ↑↓ scroll, esc/q back.
        // (Deliberately NOT "any key goes back" — that would eat navigation.)
        if (data === "\x1b" || data === "q" || data === "Q" || data === "\x7f" || data === "\r" || data === "\n") {
          screen = "menu";
          histScroll = 0;
          draw();
          return;
        }
        const hArrow = ARROWS[data];
        if (hArrow === "left" || data === "h" || data === "H") {
          histTab = (histTab - 1 + HIST_TABS.length) % HIST_TABS.length;
          histScroll = 0;
          draw();
          return;
        }
        if (hArrow === "right" || data === "l" || data === "L" || data === "\t") {
          histTab = (histTab + 1) % HIST_TABS.length;
          histScroll = 0;
          draw();
          return;
        }
        if (data >= "1" && data <= String(HIST_TABS.length)) {
          histTab = Number(data) - 1;
          histScroll = 0;
          draw();
          return;
        }
        if (hArrow === "up" || data === "k" || data === "K") {
          histScroll = Math.max(0, histScroll - 1);
          draw();
          return;
        }
        if (hArrow === "down" || data === "j" || data === "J" || data === " ") {
          histScroll = histScroll + 1;
          draw();
          return;
        }
        if (data === "\x1b[5~") {
          histScroll = Math.max(0, histScroll - Math.max(1, histBudget - 1));
          draw();
          return;
        }
        if (data === "\x1b[6~") {
          histScroll = histScroll + Math.max(1, histBudget - 1);
          draw();
          return;
        }
        if (data.startsWith("\x1b")) return;
        return;
      }

      const arrow = ARROWS[data];

      if (editing) {
        if (data === "\x1b") {
          editing = false;
          draw();
          return;
        }
        // Ctrl+W / Ctrl+Backspace / Alt+Backspace delete a whole word.
        if (isWordDeleteKey(data)) {
          editBuf = deleteLastWord(editBuf);
          draw();
          return;
        }
        if (arrow) return;
        if (data.startsWith("\x1b")) return;
        if (data === "\r" || data === "\n") {
          cfg.customFile = editBuf.trim();
          editing = false;
          message = "";
          draw();
          return;
        }
        if (data === "\x7f" || data === "\x08") {
          editBuf = editBuf.slice(0, -1);
          draw();
          return;
        }
        if (data === "\x15") {
          editBuf = "";
          draw();
          return;
        }
        if (data === "\t") return;
        let added = false;
        for (const ch of data) {
          const code = ch.codePointAt(0)!;
          if (code < 32 || code === 127) continue;
          if (editBuf.length >= 256) break;
          editBuf += ch;
          added = true;
        }
        if (added) draw();
        return;
      }

      if (data === "\x1b" || data === "q" || data === "Q") {
        cleanup();
        resolve({ kind: "quit" });
        return;
      }
      if (arrow === "up" || data === "k" || data === "K") {
        sel = (sel - 1 + rows.length) % rows.length;
        draw();
        return;
      }
      if (arrow === "down" || data === "j" || data === "J") {
        sel = (sel + 1) % rows.length;
        draw();
        return;
      }
      if (arrow === "left" || data === "h" || data === "H") {
        adjust(rows[sel]!, -1);
        draw();
        return;
      }
      if (arrow === "right" || data === "l" || data === "L") {
        adjust(rows[sel]!, 1);
        draw();
        return;
      }
      if (data === "\r" || data === "\n" || data === " ") {
        activate(rows[sel]!);
        return;
      }
      if (data.startsWith("\x1b")) return;
    };

    const onResize = (): void => draw();

    stdin.setEncoding("utf8");
    try {
      stdin.setRawMode(true);
    } catch {
      /* noop */
    }
    stdin.resume();
    enterFullscreen();
    stdin.on("data", onData);
    process.stdout.on("resize", onResize);
    draw();
  });
}
