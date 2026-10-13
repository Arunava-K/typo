import { ansi, c, termHeight, termWidth } from "./ui.js";
import { scoreRun } from "./stats.js";
import { saveResult } from "./history.js";

export interface RunConfig {
  target: string;
  modeLabel: string; // e.g. "time 30s", "words 50", "quote", "custom"
  timeLimitSec: number | null; // null = no limit (ends at full text)
  saveMode: string;
}

export type AfterAction = "quit" | "restart" | "next";

/** Split global char indices into wrapped lines (greedy by words). */
export function layoutLines(target: string, width: number): number[][] {
  const words: { start: number; len: number }[] = [];
  let i = 0;
  while (i < target.length) {
    // word = run of non-space; spaces handled as separators (single space assumed but be safe)
    let j = i;
    while (j < target.length && target[j] !== " ") j++;
    words.push({ start: i, len: j - i });
    // include following spaces with the word gap (usually 1)
    let k = j;
    while (k < target.length && target[k] === " ") k++;
    // attach spaces to previous word for wrapping purposes by advancing i
    // we store gap implicitly; simpler: advance i to k
    void k;
    i = j + 1; // skip exactly one space; extra spaces each become own step
    if (target[j] !== " ") {
      // j === target.length (last word, no trailing space)
      i = j;
    }
  }
  // Build lines greedily
  const lines: number[][] = [];
  let cur: number[] = [];
  let curLen = 0;
  for (const w of words) {
    const need = (cur.length === 0 ? 0 : 1) + w.len;
    if (cur.length > 0 && curLen + need > width) {
      lines.push(cur);
      cur = [];
      curLen = 0;
    }
    // push space separator index (the char before word start) if not first on line and word not at 0
    if (cur.length > 0) {
      const spaceIdx = w.start - 1;
      if (spaceIdx >= 0 && target[spaceIdx] === " ") {
        cur.push(spaceIdx);
        curLen += 1;
      }
    }
    for (let k = 0; k < w.len; k++) cur.push(w.start + k);
    curLen += w.len;
    // Edge: single word longer than width — force break
    if (curLen >= width) {
      lines.push(cur);
      cur = [];
      curLen = 0;
    }
  }
  if (cur.length > 0) lines.push(cur);
  if (lines.length === 0) lines.push([]);
  return lines;
}

function renderChar(
  target: string,
  typed: string,
  idx: number,
  isCursor: boolean,
): string {
  const t = target[idx]!;
  const isTyped = idx < typed.length;
  const correct = isTyped && typed[idx] === t;
  const wrong = isTyped && typed[idx] !== t;

  const display = t === " " ? " " : t;

  if (isCursor) {
    // cursor highlight: inverse, keep semantic color underneath via bold
    if (wrong) return c(ansi.bgRed + ansi.white, display);
    if (correct) return c(ansi.inverse + ansi.green, display);
    // pending cursor: underline + inverse dim
    if (t === " ") return c(ansi.inverse, display);
    return c(ansi.inverse, display);
  }
  if (correct) return c(ansi.green, display);
  if (wrong) {
    if (t === " ") return c(ansi.bgRed, " ");
    return c(ansi.red, display);
  }
  // pending
  if (t === " ") return display;
  return c(ansi.gray, display);
}

export async function runTest(cfg: RunConfig): Promise<AfterAction> {
  const { target } = cfg;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("typo needs an interactive terminal (TTY).");
    return "quit";
  }

  let typed = "";
  let correctKeystrokes = 0;
  let totalKeystrokes = 0;
  let startTime: number | null = null;
  let finished = false;
  let finishElapsed = 0;
  let resultSaved = false;

  const stdin = process.stdin;
  const stdout = process.stdout;

  function elapsed(): number {
    if (startTime === null) return 0;
    if (finished) return finishElapsed;
    return (Date.now() - startTime) / 1000;
  }

  function liveScore() {
    return scoreRun(target, typed, Math.max(elapsed(), 0.01));
  }

  function draw() {
    const width = Math.max(40, termWidth());
    const height = Math.max(10, termHeight());
    // App-like centered column (Monkeytype style): cap content width,
    // pad it horizontally so it sits in the middle of wide terminals.
    const contentWidth = Math.min(width, 80);
    const leftPad = " ".repeat(Math.max(0, Math.floor((width - contentWidth) / 2)));
    const e = elapsed();
    const s = liveScore();
    const timeLabel =
      cfg.timeLimitSec != null
        ? startTime === null
          ? `${cfg.timeLimitSec}s`
          : `${Math.max(0, Math.ceil(cfg.timeLimitSec - e))}s`
        : `${e.toFixed(0)}s`;

    const progress =
      cfg.timeLimitSec != null && startTime !== null
        ? Math.min(1, e / cfg.timeLimitSec)
        : target.length > 0
          ? Math.min(1, typed.length / target.length)
          : 0;

    const barW = Math.min(30, contentWidth - 20);
    const filled = Math.round(progress * barW);
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barW - filled));

    // Build the screen as discrete lines, then center vertically.
    const lines: string[] = [];
    // header
    lines.push(
      c(ansi.bold + ansi.cyan, "typo") +
        c(ansi.gray, `  │  ${cfg.modeLabel}  │  ⏱ ${timeLabel}  │  `) +
        c(ansi.yellow, `${s.wpm.toFixed(0)} wpm`) +
        c(ansi.gray, "  │  ") +
        c(s.acc >= 95 ? ansi.green : s.acc >= 85 ? ansi.yellow : ansi.red, `${s.acc.toFixed(1)}% acc`),
    );
    lines.push(c(ansi.gray, bar));
    lines.push("");

    if (!finished) {
      if (startTime === null) {
        lines.push(c(ansi.gray, "Start typing to begin…"));
        lines.push("");
      } else {
        lines.push("");
      }
      // text window
      const textLines = layoutLines(target, contentWidth);
      let cursorLine = 0;
      for (let li = 0; li < textLines.length; li++) {
        if (textLines[li]!.includes(typed.length) || (typed.length >= target.length && li === textLines.length - 1)) {
          cursorLine = li;
          break;
        }
        if (textLines[li]!.length > 0 && typed.length > textLines[li]![textLines[li]!.length - 1]!) {
          cursorLine = Math.min(li + 1, textLines.length - 1);
        }
      }
      const WIN = 5;
      let start = Math.max(0, cursorLine - 1);
      if (start + WIN > textLines.length) start = Math.max(0, textLines.length - WIN);
      const end = Math.min(textLines.length, start + WIN);

      for (let li = start; li < end; li++) {
        const idxs = textLines[li]!;
        let line = "";
        for (const idx of idxs) {
          line += renderChar(target, typed, idx, idx === typed.length);
        }
        // cursor past end of text
        if (typed.length >= target.length && li === textLines.length - 1) {
          line += c(ansi.inverse, " ");
        }
        // extra chars beyond target
        if (li === textLines.length - 1 && typed.length > target.length) {
          const extra = typed.slice(target.length, target.length + 20);
          for (const ch of extra) line += c(ansi.bgRed + ansi.white, ch === " " ? " " : ch);
        }
        lines.push(line);
      }
      if (end < textLines.length) lines.push(c(ansi.gray, `… +${textLines.length - end} more lines`));
      lines.push("");
      lines.push(c(ansi.gray, "esc quit   ·   ctrl+w delete word   ·   backspace fix"));
    } else {
      // results
      const f = scoreRun(target, typed, finishElapsed);
      lines.push(c(ansi.bold + ansi.green, "done!"));
      lines.push("");
      lines.push(
        `${c(ansi.gray, "wpm")}   ${c(ansi.bold + ansi.yellow, f.wpm.toFixed(1).padStart(6))}   ${c(ansi.gray, "raw " + f.raw.toFixed(1))}`,
      );
      lines.push(`  ${c(ansi.gray, "acc")}   ${c(ansi.bold + ansi.white, f.acc.toFixed(1).padStart(6) + "%")}`);
      lines.push("");
      lines.push(
        `  ${c(ansi.gray, "chars")}  ${c(ansi.green, String(f.correctChars))} correct  ${c(ansi.red, String(f.incorrectChars))} wrong  ${c(ansi.magenta, String(f.extraChars))} extra  ${c(ansi.gray, String(f.missedChars) + " missed")}`,
      );
      lines.push(`  ${c(ansi.gray, "time")}   ${finishElapsed.toFixed(1)}s   ${c(ansi.gray, "mode " + cfg.modeLabel)}`);
      if (resultSaved) lines.push(`  ${c(ansi.gray, "saved to ~/.typo/history.json")}`);
      lines.push("");
      lines.push(
        c(ansi.cyan, "[r]") + c(ansi.gray, " retry   ") + c(ansi.cyan, "[tab/n]") + c(ansi.gray, " next   ") + c(ansi.cyan, "[q/esc]") + c(ansi.gray, " quit"),
      );
    }

    const topPad = Math.max(0, Math.floor((height - lines.length) / 2));
    let out = ansi.clearScreen + ansi.hideCursor + "\n".repeat(topPad);
    for (const ln of lines) {
      out += (ln.length === 0 ? "" : leftPad) + ln + "\n";
    }

    stdout.write(out);
  }

  function finish() {
    if (finished) return;
    finished = true;
    finishElapsed = startTime === null ? 0 : (Date.now() - startTime) / 1000;
    if (finishElapsed < 0.5) finishElapsed = 0.5;
    const f = scoreRun(target, typed, finishElapsed);
    saveResult({
      date: new Date().toISOString(),
      mode: cfg.saveMode,
      wpm: Math.round(f.wpm * 10) / 10,
      raw: Math.round(f.raw * 10) / 10,
      acc: Math.round(f.acc * 10) / 10,
      correctChars: f.correctChars,
      totalTyped: typed.length,
      durationSec: Math.round(finishElapsed * 10) / 10,
    })
      .then(() => {
        resultSaved = true;
        draw();
      })
      .catch(() => {
        draw();
      });
    draw();
  }

  function checkEnd() {
    if (finished) return;
    // words/quote/custom: end when full length typed
    if (cfg.timeLimitSec == null) {
      if (typed.length >= target.length) finish();
    } else {
      if (typed.length >= target.length) {
        finish();
        return;
      }
      const e = elapsed();
      if (startTime !== null && e >= cfg.timeLimitSec) finish();
    }
  }

  return new Promise<AfterAction>((resolve) => {
    const onData = (chunk: Buffer) => {
      const data = chunk.toString("utf8");

      // Ctrl-C
      if (data === "\x03") {
        cleanup();
        resolve("quit");
        return;
      }

      if (!finished) {
        // Esc (bare) quits. Arrow/function keys start with \x1b[ — ignore.
        if (data === "\x1b") {
          cleanup();
          resolve("quit");
          return;
        }
        if (data.startsWith("\x1b")) return;

        // Ctrl+W / Ctrl+Backspace (0x17 or 0x08 with ctrl?) — delete word
        if (data === "\x17" || data === "\x18") {
          if (typed.length > 0) {
            // delete trailing spaces then word
            let end = typed.length;
            while (end > 0 && typed[end - 1] === " ") end--;
            while (end > 0 && typed[end - 1] !== " ") end--;
            // remove from end..typed.length, adjust keystroke counts approx (don't rewrite history)
            typed = typed.slice(0, end);
            draw();
          }
          return;
        }
        // Backspace (DEL or BS)
        if (data === "\x7f" || data === "\x08") {
          if (typed.length > 0) {
            typed = typed.slice(0, -1);
            draw();
          }
          return;
        }
        // Ctrl-U: clear all
        if (data === "\x15") {
          typed = "";
          draw();
          return;
        }
        // ignore tab/enter during run
        if (data === "\t" || data === "\r" || data === "\n") return;

        // printable input (may contain multiple chars if pasted)
        let added = false;
        for (const ch of data) {
          const code = ch.codePointAt(0)!;
          if (code < 32 || code === 127) continue; // control
          if (typed.length >= target.length + 20) break;
          if (startTime === null) startTime = Date.now();
          const pos = typed.length;
          typed += ch;
          totalKeystrokes++;
          if (pos < target.length && ch === target[pos]) correctKeystrokes++;
          added = true;
        }
        void correctKeystrokes;
        void totalKeystrokes;
        if (added) {
          draw();
          checkEnd();
        }
        return;
      } else {
        // finished — result shortcuts
        if (data === "\x03" || data === "q" || data === "Q" || data === "\x1b") {
          cleanup();
          resolve("quit");
          return;
        }
        if (data === "r" || data === "R") {
          cleanup();
          resolve("restart");
          return;
        }
        if (data === "n" || data === "N" || data === "\t" || data === "\r" || data === "\n") {
          cleanup();
          resolve("next");
          return;
        }
        return;
      }
    };

    const onResize = () => draw();

    function cleanup() {
      clearInterval(tick);
      stdin.off("data", onData);
      process.stdout.off("resize", onResize);
      try {
        stdin.setRawMode(false);
      } catch { /* noop */ }
      stdin.pause();
      stdout.write(ansi.showCursor);
    }

    stdin.setEncoding("utf8");
    try {
      stdin.setRawMode(true);
    } catch { /* noop */ }
    stdin.resume();
    stdin.on("data", onData);
    process.stdout.on("resize", onResize);

    const tick = setInterval(() => {
      if (!finished) {
        draw();
        checkEnd();
      }
    }, 250);

    draw();
  });
}
