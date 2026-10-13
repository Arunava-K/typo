import { promises as fs } from "node:fs";
import { ansi, c, padCenter, stripAnsi, termHeight, termWidth } from "./ui.js";
import { buildBox, composeScreen, deleteLastWord, enterFullscreen, isWordDeleteKey, leaveFullscreen } from "./engine.js";
import { loadHistory, summarize } from "./history.js";

export interface MenuConfig {
  mode: "time" | "words" | "quote" | "custom";
  timeSec: number;
  wordCount: number;
  punctuation: boolean;
  numbers: boolean;
  customFile: string;
}

export type MenuResult = { kind: "start"; config: MenuConfig } | { kind: "quit" };

export const TIME_OPTS = [15, 30, 60, 120, 240];
export const WORD_OPTS = [10, 25, 50, 100, 200];
const MODES = ["time", "words", "quote", "custom"] as const;
type ModeName = (typeof MODES)[number];

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
  let histLines: string[] = [];

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
      const maxLines = Math.max(4, vpRows - 10);
      const inner = histLines.slice(-maxLines);
      const w = Math.max(1, ...inner.map((l) => stripAnsi(l).length));
      const content = [
        padCenter(c(ansi.bold + ansi.cyan, "history"), w),
        "",
        ...inner.map((l) => c(ansi.gray, l)),
      ];
      const lines = [...buildBox(content), "", c(ansi.gray, "press any key to go back")];
      stdout.write(composeScreen(lines, vpCols, vpRows, contentWidth));
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
    stdout.write(composeScreen(lines, vpCols, vpRows, contentWidth));
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
      const hist = await loadHistory();
      histLines = summarize(hist).split("\n");
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
