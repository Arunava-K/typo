import { ansi, c, padCenter, stripAnsi, termHeight, termWidth } from "./ui.js";
import { buildWpmTrace, calcConsistency, scoreRun, sparkline } from "./stats.js";
import { saveResult } from "./history.js";

export interface RunConfig {
  target: string;
  modeLabel: string; // e.g. "time 30s", "words 50", "quote", "custom"
  timeLimitSec: number | null; // null = no limit (ends at full text)
  saveMode: string;
}

export type AfterAction = "quit" | "restart" | "next";

// Fullscreen canvas: alternate screen buffer (restored on exit),
// so scrollback / prompt position can't push content around.
const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H";
const LEAVE_ALT = "\x1b[?1049l";

/** Enter the fullscreen canvas (alternate screen buffer). */
export function enterFullscreen(): void {
  try {
    process.stdout.write(ENTER_ALT + ansi.hideCursor);
  } catch {
    /* noop */
  }
}

/** Leave the fullscreen canvas (safe to call even if not entered). */
export function leaveFullscreen(): void {
  try {
    process.stdout.write(LEAVE_ALT + ansi.showCursor);
  } catch {
    /* noop */
  }
}

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

// --- Pure, unit-testable layout helpers ---

/** Visible text rows to show, given viewport height (reserve ~9 for HUD/footer). */
export function textWindowSize(vpRows: number): number {
  return Math.max(2, Math.min(5, vpRows - 9));
}

/** Leading spaces to center a contentWidth column in vpCols. */
export function centerPad(vpCols: number, contentWidth: number): string {
  return " ".repeat(Math.max(0, Math.floor((vpCols - contentWidth) / 2)));
}

/** Blank lines above content to vertically center lineCount rows in vpRows. */
export function topPadFor(lineCount: number, vpRows: number): number {
  return Math.max(0, Math.floor((vpRows - lineCount) / 2));
}

/**
 * Assemble the final frame: erase + home + vertical pad + left-padded lines.
 * Pure function so centering math can be verified without a TTY.
 */
export function composeScreen(
  screenLines: string[],
  vpCols: number,
  vpRows: number,
  contentWidth: number,
): string {
  const pad = centerPad(vpCols, contentWidth);
  const top = "\n".repeat(topPadFor(screenLines.length, vpRows));
  let out = ansi.clearScreen + ansi.hideCursor + top;
  for (const ln of screenLines) {
    out += (ln.length === 0 ? "" : pad) + ln + "\n";
  }
  return out;
}

/**
 * Word under the cursor: [start, end) char range, space-delimited.
 * A cursor sitting on a space belongs to the next word; past-the-end
 * (or empty target) yields null. Exported for tests.
 */
export function currentWordRange(target: string, pos: number): { start: number; end: number } | null {
  if (pos >= target.length || target.length === 0) return null;
  let s = pos;
  if (target[s] === " ") {
    while (s < target.length && target[s] === " ") s++;
    if (s >= target.length) return null;
  } else {
    while (s > 0 && target[s - 1] !== " ") s--;
  }
  let e = s;
  while (e < target.length && target[e] !== " ") e++;
  return { start: s, end: e };
}

/**
 * Frame content lines in a rounded box. Widths are measured by visible
 * characters so ANSI colors don't break alignment. Exported for tests.
 */
export function buildBox(content: string[]): string[] {
  const widths = content.map((l) => stripAnsi(l).length);
  const inner = widths.length > 0 ? Math.max(...widths) : 0;
  const bar = "─".repeat(inner + 4);
  const out = [c(ansi.cyan, `╭${bar}╮`)];
  for (const ln of content) {
    out.push(
      c(ansi.cyan, "│") + "  " + ln + " ".repeat(inner - stripAnsi(ln).length) + "  " + c(ansi.cyan, "│"),
    );
  }
  out.push(c(ansi.cyan, `╰${bar}╯`));
  return out;
}

/**
 * Delete the last word (plus any spaces before it), like Ctrl+Backspace.
 * Exported for tests and reused by the menu's path field.
 */
export function deleteLastWord(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === " ") end--;
  while (end > 0 && s[end - 1] !== " ") end--;
  return s.slice(0, end);
}

/**
 * True for every key sequence that means "delete word": Ctrl+W (23),
 * Ctrl+X-adjacent (24), ESC DEL / ESC BS, xterm CSI sequences, and the
 * CSI u keyboard protocol used by modern terminals (kitty, Ghostty,
 * WezTerm, foot, VS Code). Uses char codes so no terminal-specific
 * string matching is needed.
 */
export function isWordDeleteKey(data: string): boolean {
  if (data.length === 1) {
    const c0 = data.charCodeAt(0);
    return c0 === 23 || c0 === 24;
  }
  if (data.length === 2 && data.charCodeAt(0) === 27) {
    const c1 = data.charCodeAt(1);
    return c1 === 127 || c1 === 8;
  }
  // CSI 3 ; m ~ (xterm Delete with modifiers, e.g. Ctrl+Delete): with the
  // cursor pinned to the end of input there is nothing ahead to delete,
  // so treat the intent as a word delete as well. Modifier digit 2 is
  // shift-only, everything else up to 8 involves alt and/or ctrl.
  if (
    data.length === 6 &&
    data.charCodeAt(0) === 27 &&
    data.charCodeAt(1) === 91 &&
    data.charCodeAt(2) === 51 &&
    data.charCodeAt(3) === 59 &&
    data.charCodeAt(4) >= 51 &&
    data.charCodeAt(4) <= 56 &&
    data.charCodeAt(5) === 126
  ) {
    return true;
  }
  // CSI u keyboard protocol: ESC [ code (; mods)? u. A ctrl/alt-modified
  // Backspace (8/127) or Delete (3) key means delete word. Plain
  // (unmodified, shift-only) presses are single deletes — not matched.
  if (
    data.length >= 4 &&
    data.charCodeAt(0) === 27 &&
    data.charCodeAt(1) === 91 &&
    data.charCodeAt(data.length - 1) === 117
  ) {
    const parts = data.slice(2, -1).split(";");
    if (
      parts.length <= 2 &&
      parts.every((p) => p.length > 0 && p.length <= 6 && /^[0-9]+$/.test(p))
    ) {
      const code = Number(parts[0]);
      const mods = parts.length === 2 ? Number(parts[1]) : 1;
      if ((code === 8 || code === 127 || code === 3) && mods !== 1 && mods !== 2) {
        return true;
      }
    }
  }
  return false;
}

export interface CaretOpts {
  /** false → caret blinked off, show pending style instead of the block */
  caret: boolean;
  /** line already completed → dim it so focus stays on the active line */
  dim: boolean;
  /** char belongs to the word under the cursor → brighter pending color */
  active: boolean;
}

function pendingStyle(t: string, active: boolean): string {
  if (t === " ") return " ";
  return active ? c(ansi.white, t) : c(ansi.gray, t);
}

function renderChar(
  target: string,
  typed: string,
  idx: number,
  isCursor: boolean,
  opts: CaretOpts,
): string {
  const t = target[idx]!;
  const isTyped = idx < typed.length;
  const correct = isTyped && typed[idx] === t;
  const wrong = isTyped && typed[idx] !== t;

  if (isCursor) {
    if (!opts.caret) return pendingStyle(t, opts.active);
    if (wrong) return c(ansi.bgRed + ansi.white, t);
    if (correct) return c(ansi.inverse + ansi.green, t);
    return c(ansi.inverse, t);
  }
  if (correct) return opts.dim ? c(ansi.dim + ansi.green, t) : c(ansi.green, t);
  if (wrong) {
    if (t === " ") return c(ansi.bgRed, " ");
    return c(ansi.red, t);
  }
  return pendingStyle(t, opts.active);
}

/**
 * Measure the TRUE visible viewport height via a cursor-position report
 * (DSR/CPR). Falls back to termHeight() when the terminal doesn't answer.
 * Any user keystrokes typed during the ~200ms probe are returned as
 * `pending` so they can be replayed instead of swallowed.
 */
function calibrateViewport(timeoutMs = 200): Promise<{ rows: number; scale: number; pending: string }> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const ioctlRows = termHeight();
  return new Promise((resolve) => {
    let buf = "";
    let finished = false;
    const done = (rows: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      if (rows != null && rows >= 5 && rows <= 500 && ioctlRows > 0) {
        resolve({ rows, scale: rows / ioctlRows, pending: buf.replace(/\x1b\[\d+;\d+R/, "") });
      } else {
        resolve({
          rows: ioctlRows > 0 ? ioctlRows : 24,
          scale: 1,
          pending: buf.replace(/\x1b\[\d+;\d+R/, ""),
        });
      }
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const m = buf.match(/\x1b\[(\d+);(\d+)R/);
      if (m) done(parseInt(m[1]!, 10));
    };
    stdin.on("data", onData);
    // save cursor, jump far past the bottom (clamps to the real last row),
    // ask where we landed, restore cursor.
    stdout.write("\x1b7\x1b[999;1H\x1b[6n\x1b8");
  });
}

export async function runTest(cfg: RunConfig): Promise<AfterAction> {
  const { target } = cfg;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("typo needs an interactive terminal (TTY).");
    return "quit";
  }

  const stdin = process.stdin;
  const stdout = process.stdout;

  // Enter fullscreen canvas BEFORE anything is drawn.
  stdin.setEncoding("utf8");
  try {
    stdin.setRawMode(true);
  } catch {
    /* noop */
  }
  stdin.resume();
  stdout.write(ENTER_ALT);

  // True viewport size (don't trust winsize blindly for centering).
  const cal = await calibrateViewport();
  let vpCols = termWidth();
  let vpRows = cal.rows;
  const rowScale = cal.scale;

  let typed = "";
  let correctKeystrokes = 0;
  let totalKeystrokes = 0;
  let startTime: number | null = null;
  let finished = false;
  let finishElapsed = 0;
  let resultSaved = false;
  let lastKeyAt = 0;

  // Per-keystroke timeline for WPM trace + consistency (Task #1).
  const samples: { t: number; correct: number; typed: number }[] = [];
  function countCorrect(): number {
    let n = 0;
    const m = Math.min(typed.length, target.length);
    for (let i = 0; i < m; i++) if (typed[i] === target[i]) n++;
    return n;
  }
  function snapshot(): void {
    if (startTime === null) return;
    samples.push({
      t: (Date.now() - startTime) / 1000,
      correct: countCorrect(),
      typed: typed.length,
    });
  }

  function elapsed(): number {
    if (startTime === null) return 0;
    if (finished) return finishElapsed;
    return (Date.now() - startTime) / 1000;
  }

  function liveScore() {
    return scoreRun(target, typed, Math.max(elapsed(), 0.01));
  }

  function draw() {
    const contentWidth = Math.min(vpCols, 80);
    // Block caret blinks when idle (~530ms), stays solid while typing.
    const blinkOn = Date.now() - lastKeyAt < 600 || Math.floor(Date.now() / 530) % 2 === 0;
    const word = currentWordRange(target, Math.min(typed.length, target.length));
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

    // Build the screen as discrete lines, then center via composeScreen.
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
      const WIN = textWindowSize(vpRows);
      let start = Math.max(0, cursorLine - 1);
      if (start + WIN > textLines.length) start = Math.max(0, textLines.length - WIN);
      const end = Math.min(textLines.length, start + WIN);

      for (let li = start; li < end; li++) {
        const idxs = textLines[li]!;
        let line = "";
        for (const idx of idxs) {
          line += renderChar(target, typed, idx, idx === typed.length, {
            caret: blinkOn,
            dim: li < cursorLine,
            active: word != null && idx >= word.start && idx < word.end,
          });
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
      lines.push(c(ansi.gray, "esc quit   ·   ctrl+w / ctrl+backspace delete word   ·   backspace fix"));
    } else {
      // results — framed panel
      const f = scoreRun(target, typed, finishElapsed);
      const traceSamples = samples.map((s) => ({
        tSec: s.t,
        correctChars: s.correct,
        typedLen: s.typed,
      }));
      traceSamples.push({
        tSec: finishElapsed,
        correctChars: f.correctChars,
        typedLen: typed.length,
      });
      const trace = buildWpmTrace(traceSamples, finishElapsed);
      const consistency = calcConsistency(trace.raw);
      const trend = sparkline(trace.wpm, 30);
      const body = [
        `${c(ansi.gray, "wpm".padEnd(6))}${c(ansi.bold + ansi.yellow, f.wpm.toFixed(1))}   ${c(ansi.gray, "raw " + f.raw.toFixed(1))}`,
        `${c(ansi.gray, "acc".padEnd(6))}${c(ansi.bold + ansi.white, f.acc.toFixed(1) + "%")}   ${c(ansi.gray, "cons ")}${c(ansi.bold + ansi.white, consistency.toFixed(1) + "%")}`,
        `${c(ansi.gray, "trend".padEnd(6))}${c(ansi.cyan, trend || "—")}`,
        "",
        `${c(ansi.gray, "chars".padEnd(6))}${c(ansi.green, String(f.correctChars))} correct  ${c(ansi.red, String(f.incorrectChars))} wrong  ${c(ansi.magenta, String(f.extraChars))} extra  ${c(ansi.gray, String(f.missedChars) + " missed")}`,
        `${c(ansi.gray, "time".padEnd(6))}${finishElapsed.toFixed(1)}s   ${c(ansi.gray, "mode " + cfg.modeLabel)}`,
      ];
      if (resultSaved) body.push(c(ansi.gray, "saved to ~/.typo/history.json"));
      body.push("");
      body.push(
        c(ansi.cyan, "[r]") + c(ansi.gray, " retry   ") + c(ansi.cyan, "[tab/n]") + c(ansi.gray, " next   ") + c(ansi.cyan, "[q/esc]") + c(ansi.gray, " quit"),
      );
      const innerW = Math.max(...body.map((l) => stripAnsi(l).length));
      body.unshift(padCenter(c(ansi.bold + ansi.green, "done!"), innerW));
      for (const bl of buildBox(body)) lines.push(bl);
    }

    stdout.write(composeScreen(lines, vpCols, vpRows, contentWidth));
  }

  function finish() {
    if (finished) return;
    finished = true;
    finishElapsed = startTime === null ? 0 : (Date.now() - startTime) / 1000;
    if (finishElapsed < 0.5) finishElapsed = 0.5;
    snapshot();
    const f = scoreRun(target, typed, finishElapsed);
    const finTrace = buildWpmTrace(
      [...samples.map((s) => ({ tSec: s.t, correctChars: s.correct, typedLen: s.typed })),
        { tSec: finishElapsed, correctChars: f.correctChars, typedLen: typed.length }],
      finishElapsed,
    );
    const finConsistency = Math.round(calcConsistency(finTrace.raw) * 10) / 10;
    saveResult({
      date: new Date().toISOString(),
      mode: cfg.saveMode,
      wpm: Math.round(f.wpm * 10) / 10,
      raw: Math.round(f.raw * 10) / 10,
      acc: Math.round(f.acc * 10) / 10,
      correctChars: f.correctChars,
      totalTyped: typed.length,
      durationSec: Math.round(finishElapsed * 10) / 10,
      consistency: finConsistency,
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
      // Stray cursor-position reports (from viewport probing) are never input.
      if (/^\x1b\[\d+;\d+R/.test(data)) return;

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
        // Word delete: Ctrl+W, plus ESC DEL / ESC BS which is what most
        // terminals send for Ctrl+Backspace and Alt+Backspace.
        // Must come before the generic ESC-sequence ignore below.
        if (isWordDeleteKey(data)) {
          if (typed.length > 0) {
            typed = deleteLastWord(typed);
            snapshot();
            lastKeyAt = Date.now();
            draw();
          }
          return;
        }
        if (data.startsWith("\x1b")) return;

        // Backspace (DEL or BS)
        if (data === "\x7f" || data === "\x08") {
          if (typed.length > 0) {
            typed = typed.slice(0, -1);
            snapshot();
            lastKeyAt = Date.now();
            draw();
          }
          return;
        }
        // Ctrl-U: clear all
        if (data === "\x15") {
          typed = "";
          snapshot();
          lastKeyAt = Date.now();
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
          snapshot();
          lastKeyAt = Date.now();
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

    const onResize = () => {
      // Re-derive from winsize, corrected by the DSR scale measured at startup.
      vpCols = termWidth();
      vpRows = Math.max(8, Math.min(500, Math.round(termHeight() * rowScale)));
      draw();
    };

    function cleanup() {
      clearInterval(tick);
      stdin.off("data", onData);
      process.stdout.off("resize", onResize);
      try {
        stdin.setRawMode(false);
      } catch {
        /* noop */
      }
      stdin.pause();
      stdout.write(LEAVE_ALT + ansi.showCursor);
    }

    stdin.on("data", onData);
    process.stdout.on("resize", onResize);
    // Replay anything typed during viewport calibration.
    if (cal.pending) onData(Buffer.from(cal.pending, "utf8"));

    const tick = setInterval(() => {
      if (!finished) {
        draw();
        checkEnd();
      }
    }, 250);

    draw();
  });
}
