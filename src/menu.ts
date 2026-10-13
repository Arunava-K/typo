import { promises as fs } from "node:fs";
import { ansi, c, padCenter, stripAnsi, termHeight, termWidth } from "./ui.js";
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
import { sparkline } from "./stats.js";

export interface MenuConfig {
  mode: "time" | "words" | "quote" | "custom" | "daily";
  timeSec: number;
  wordCount: number;
  punctuation: boolean;
  numbers: boolean;
  customFile: string;
}

export type MenuResult = { kind: "start"; config: MenuConfig } | { kind: "quit" };

export const TIME_OPTS = [15, 30, 60, 120, 240];
export const WORD_OPTS = [10, 25, 50, 100, 200];
const MODES = ["time", "words", "quote", "custom", "daily"] as const;
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
  | "punct"
  | "numbers"
  | "start"
  | "history"
  | "quit";

/** Rows shown for each mode — only relevant options appear. */
export function buildRows(mode: ModeName): RowId[] {
  const rows: RowId[] = ["mode"];
  if (mode === "time") rows.push("time");
  if (mode === "words") rows.push("words");
  if (mode === "custom") rows.push("file");
  rows.push("punct", "numbers", "start", "history", "quit");
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
  };
  let rows = buildRows(cfg.mode);
  let sel = 0;
  let editing = false;
  let editBuf = "";
  let message = "";
  let screen: "menu" | "history" = "menu";
  let histEntries: HistoryEntry[] = [];

  function onOff(v: boolean): string {
    return v ? c(ansi.green, "on") : c(ansi.gray, "off");
  }

  function rowValue(id: RowId): string {
    switch (id) {
      case "mode":
        return c(ansi.bold + ansi.yellow, `< ${MODE_LABEL[cfg.mode]} >`);
      case "time":
        return c(ansi.bold + ansi.yellow, `< ${cfg.timeSec}s >`);
      case "words":
        return c(ansi.bold + ansi.yellow, `< ${cfg.wordCount} >`);
      case "file":
        if (editing) return c(ansi.cyan, "[") + editBuf + c(ansi.inverse, " ") + c(ansi.cyan, "]");
        return cfg.customFile ? c(ansi.white, `[${cfg.customFile}]`) : c(ansi.gray, "[no file yet]");
      case "punct":
        return onOff(cfg.punctuation);
      case "numbers":
        return onOff(cfg.numbers);
      case "start":
        return c(ansi.bold + ansi.green, "start test →");
      case "history":
        return c(ansi.cyan, "view");
      case "quit":
        return c(ansi.gray, "quit");
    }
  }

  function rowLabel(id: RowId): string {
    switch (id) {
      case "mode":
        return "mode";
      case "time":
        return "duration";
      case "words":
        return "words";
      case "file":
        return "file";
      case "punct":
        return "punctuation";
      case "numbers":
        return "numbers";
      case "start":
        return "";
      case "history":
        return "history";
      case "quit":
        return "";
    }
  }

  function draw(): void {
    const vpCols = termWidth();
    const vpRows = Math.max(10, termHeight());
    const contentWidth = Math.min(vpCols, 60);

    if (screen === "history") {
      const foot = c(ansi.gray, "press any key to go back");
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

      const availW = Math.max(40, Math.min(vpCols - 4, 92));
      const maxBody = Math.max(6, vpRows - 2);
      const heightOf = (cs: HistCard[]): number =>
        cs.reduce((n, cd) => n + cd.lines.length + 2, 0) + Math.max(0, cs.length - 1);

      // Start with the minimum recent rows, shed whole sections until it fits,
      // then spend any leftover height on more recent rows.
      const MIN_RECENT = 3;
      const MAX_RECENT = 10;
      let cards = buildHistoryCards(histEntries, MIN_RECENT);
      const droppable = ["distribution", "best per mode", "activity"];
      const dropped: string[] = [];
      while (heightOf(cards) > maxBody) {
        const drop = droppable.shift();
        if (!drop) break;
        cards = cards.filter((cd) => cd.title !== drop);
        dropped.push(drop);
      }
      const room = maxBody - heightOf(cards);
      const grow = Math.min(room, MAX_RECENT - MIN_RECENT, Math.max(0, histEntries.length - MIN_RECENT));
      if (grow > 0) {
        cards = buildHistoryCards(histEntries, MIN_RECENT + grow).filter((cd) => !dropped.includes(cd.title));
      }

      let innerW = 0;
      for (const cd of cards) {
        innerW = Math.max(innerW, cd.title.length + 1);
        for (const l of cd.lines) innerW = Math.max(innerW, stripAnsi(l).length);
      }
      innerW = Math.max(20, Math.min(innerW, availW - 4));

      const lines: string[] = [];
      cards.forEach((cd, i) => {
        if (i > 0) lines.push("");
        lines.push(...buildTitledBox(cd.title, cd.lines, innerW));
      });
      lines.push("");
      if (dropped.length > 0) {
        lines.push(c(ansi.gray, `+${dropped.length} section${dropped.length === 1 ? "" : "s"} hidden — enlarge the terminal`));
      }
      lines.push(foot);
      stdout.write(composeScreen(centerBlock(lines, innerW + 4), vpCols, vpRows, innerW + 4));
      return;
    }

    const body: string[] = [];
    rows.forEach((id, i) => {
      const active = i === sel;
      const marker = active ? c(ansi.bold + ansi.cyan, "> ") : "  ";
      if (id === "start" || id === "quit") {
        if (id === "start") body.push("");
        body.push(marker + rowValue(id));
        return;
      }
      const label = c(active ? ansi.bold + ansi.white : ansi.gray, rowLabel(id).padEnd(13));
      body.push(marker + label + rowValue(id));
    });

    const innerW = Math.max(...body.map((l) => stripAnsi(l).length));
    const lines = buildBox([
      padCenter(c(ansi.bold + ansi.cyan, "typo"), innerW),
      padCenter(c(ansi.gray, "set up your test"), innerW),
      "",
      ...body,
    ]);
    lines.push("");
    if (editing) {
      lines.push(c(ansi.gray, "type a file path  ·  enter confirm  ·  esc cancel"));
    } else {
      lines.push(c(ansi.gray, "↑↓/jk move  ·  ←→/hl change  ·  enter select  ·  q quit"));
    }
    if (message) {
      lines.push(c(ansi.red, message));
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
      case "punct":
        cfg.punctuation = !cfg.punctuation;
        break;
      case "numbers":
        cfg.numbers = !cfg.numbers;
        break;
      default:
        break;
    }
  }

  return new Promise<MenuResult>((resolve) => {
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
      draw();
    }

    function activate(id: RowId): void {
      switch (id) {
        case "mode":
        case "time":
        case "words":
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
        screen = "menu";
        draw();
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
