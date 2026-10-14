import { ansi, c, keycap, logo, padCenter, progressBar, stripAnsi, termHeight, termWidth } from "./ui.js";
import {
  MIN_ZEN_SAVE_SEC,
  accumulateKeyStats,
  buildWpmTrace,
  calcBurst,
  calcConsistency,
  formatKey,
  normalizeKey,
  scoreRun,
  scoreZen,
  shortWord,
  sparkline,
  wordMistake,
  worstKeys,
  type KeyPressEvent,
} from "./stats.js";
import { levelForXp, totalXp, xpForDuration } from "./progression.js";
import { saveLastReplay, saveResult, loadHistory, type ReplayEvent } from "./history.js";
import {
  PAIRS,
  buildKindMap,
  codeIndentFor,
  findMate,
  kindColor,
  tabFillFor,
  type TokenKind,
} from "./syntax.js";
import type { CodeLang } from "./code.js";

export interface RunConfig {
  target: string;
  modeLabel: string; // e.g. "time 30s", "words 50", "quote", "custom"
  timeLimitSec: number | null; // null = no limit (ends at full text)
  saveMode: string;
  codeLang?: CodeLang | null; // set for code mode → syntax colors + editor assists
  zen?: boolean; // freestyle: no target, Esc finishes, 15s minimum to save
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

/**
 * Split global char indices into wrapped lines (greedy by words).
 * Newlines in the target (code mode) force line breaks; the "\n" index
 * itself is kept at the end of its visual line and renders as ⏎.
 */
export function layoutLines(target: string, width: number): number[][] {
  const w = Math.max(1, width);
  const lines: number[][] = [];
  let cur: number[] = [];
  const push = (): void => {
    lines.push(cur);
    cur = [];
  };
  let i = 0;
  while (i < target.length) {
    const ch = target[i]!;
    if (ch === "\n") {
      cur.push(i);
      push();
      i++;
      continue;
    }
    cur.push(i);
    i++;
    if (cur.length === w) {
      const next = target[i];
      if (next === undefined || next === "\n" || next === " " || target[cur[cur.length - 1]!] === " ") {
        // Line is exactly full; a separator (or the end) starts the next one.
        push();
      } else {
        // Backtrack to the last space so words don't split across lines.
        let k = cur.length - 1;
        while (k > 0 && target[cur[k]!] !== " ") k--;
        if (k > 0) {
          const overflow = cur.splice(k + 1);
          push();
          cur = overflow;
        } else {
          push(); // one long word — hard break instead of overflowing
        }
      }
    }
  }
  if (cur.length > 0) push();
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
 * Word under the cursor: [start, end) char range, delimited by spaces
 * and newlines. A cursor sitting on a separator belongs to the next
 * word; past-the-end (or empty target) yields null. Exported for tests.
 */
export function currentWordRange(target: string, pos: number): { start: number; end: number } | null {
  const isSep = (ch: string | undefined): boolean => ch === " " || ch === "\n";
  if (pos >= target.length || target.length === 0) return null;
  let s = pos;
  if (isSep(target[s])) {
    while (s < target.length && isSep(target[s])) s++;
    if (s >= target.length) return null;
  } else {
    while (s > 0 && !isSep(target[s - 1])) s--;
  }
  let e = s;
  while (e < target.length && !isSep(target[e])) e++;
  return { start: s, end: e };
}

/**
 * Frame content lines in a rounded box. Widths are measured by visible
 * characters so ANSI colors don't break alignment. `pad` is the horizontal
 * breathing room inside the borders (default 2; the setup menu uses 3).
 * Exported for tests.
 */
export function buildBox(content: string[], pad = 2): string[] {
  const widths = content.map((l) => stripAnsi(l).length);
  const inner = widths.length > 0 ? Math.max(...widths) : 0;
  const sides = " ".repeat(pad);
  const bar = "─".repeat(inner + pad * 2);
  const out = [c(ansi.cyan, `╭${bar}╮`)];
  for (const ln of content) {
    out.push(
      c(ansi.cyan, "│") + sides + ln + " ".repeat(inner - stripAnsi(ln).length) + sides + c(ansi.cyan, "│"),
    );
  }
  out.push(c(ansi.cyan, `╰${bar}╯`));
  return out;
}

/**
 * Delete the last word (plus any spaces/newlines before it), like
 * Ctrl+Backspace. Exported for tests and reused by the menu's path field.
 */
export function deleteLastWord(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === " " || s[end - 1] === "\n")) end--;
  while (end > 0 && s[end - 1] !== " " && s[end - 1] !== "\n") end--;
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

export function renderChar(
  target: string,
  typed: string,
  idx: number,
  isCursor: boolean,
  opts: CaretOpts,
  kind: TokenKind | null = null,
  match = false,
): string {
  const t = target[idx]!;
  const isTyped = idx < typed.length;
  const correct = isTyped && typed[idx] === t;
  const wrong = isTyped && typed[idx] !== t;
  const ul = match ? ansi.underline : "";
  const glyph = t === "\n" ? "⏎" : t;
  const tokenStyle = kind != null && t !== " " && t !== "\n" ? kindColor(kind) : null;
  let style: string;
  if (isCursor && !opts.caret) {
    // Blinked-off caret: plain pending look.
    if (tokenStyle != null) style = ansi.dim + tokenStyle;
    else if (t === " ") style = "";
    else style = opts.active ? ansi.white : ansi.gray;
  } else if (isCursor) {
    if (wrong) style = ansi.bgRed + ansi.white;
    else if (correct) style = ansi.inverse + ansi.green;
    else style = ansi.inverse;
  } else if (correct) {
    if (tokenStyle != null) style = (opts.dim ? ansi.dim : "") + tokenStyle;
    else if (t === "\n") style = (opts.dim ? ansi.dim : "") + ansi.green;
    else style = opts.dim ? ansi.dim + ansi.green : ansi.green;
  } else if (wrong) {
    if (t === " ") style = ansi.bgRed;
    else style = ansi.red;
  } else {
    // Pending: dimmed token color in code, gray/white elsewhere.
    if (tokenStyle != null) style = ansi.dim + tokenStyle;
    else if (t === "\n") style = (opts.dim ? ansi.dim : "") + ansi.gray;
    else if (t === " ") style = "";
    else style = opts.active ? ansi.white : ansi.gray;
  }
  return style ? c(ul + style, glyph) : glyph;
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

  // Pre-run best for this mode, for the results-screen PB badge (Task #6).
  // Loaded once up front so the just-finished run can't compare to itself.
  let priorBest: number | null = null;
  let priorXp = 0;
  try {
    const priorHist = await loadHistory();
    const prior = priorHist.filter((h) => h.mode === cfg.saveMode);
    if (prior.length > 0) priorBest = Math.max(...prior.map((h) => h.wpm));
    priorXp = totalXp(priorHist);
  } catch {
    /* history unreadable — results simply show no PB badge */
  }

  // True viewport size (don't trust winsize blindly for centering).
  const cal = await calibrateViewport();
  let vpCols = termWidth();
  let vpRows = cal.rows;
  const rowScale = cal.scale;

  let typed = "";
  let correctKeystrokes = 0;
  let totalKeystrokes = 0;
  let corrections = 0; // correction-key presses (Task #4)
  // Code mode targets span lines: Enter types "\n", rendered as ⏎.
  // Zen is freestyle multiline writing (target is empty by design).
  const multiline = target.includes("\n") || cfg.zen === true;
  // Syntax token map for code mode (null elsewhere → classic colors).
  const kindMap = cfg.codeLang ? buildKindMap(target, cfg.codeLang) : null;
  let assists = 0; // editor-assisted chars (tab fill, auto-indent, auto-close)
  let startTime: number | null = null;
  let finished = false;
  let finishElapsed = 0;
  let resultSaved = false;
  let lastKeyAt = 0;
  let xpNote = ""; // " · +30 XP" (+ level-up), baked at finish (Task #9)

  // Per-keystroke timeline for WPM trace + consistency (Task #1).
  const samples: { t: number; correct: number; typed: number }[] = [];
  // Per-key accuracy/latency events for worst-keys (Task #2).
  const keyEvents: KeyPressEvent[] = [];
  let lastKeyTime: number | null = null;
  // Active-word burst tracking (Task #3): word start index + entry time.
  // Updated in draw() (runs on every keystroke + 4x/sec tick).
  let burstWordStart: number | null = null;
  let burstStartTime: number | null = null;
  // Word-level mistake log + full keystroke log for replay (Task #5).
  const mistakes: { start: number; word: string; typed: string }[] = [];
  const inputLog: ReplayEvent[] = [];
  function logInput(type: ReplayEvent["type"], text?: string): void {
    if (startTime === null) return;
    if (inputLog.length >= 20000) return;
    const ev: ReplayEvent = { t: Date.now() - startTime, type };
    if (text != null) ev.text = text;
    inputLog.push(ev);
  }
  // Evaluate one completed word [start, end). Replaces any earlier entry
  // for the same word (user may backspace, fix it and re-complete).
  function checkWord(start: number, end: number): void {
    if (start >= end || end > typed.length) return;
    const m = wordMistake(target.slice(start, end), typed.slice(start, end));
    const i = mistakes.findIndex((x) => x.start === start);
    if (m == null) {
      if (i !== -1) mistakes.splice(i, 1);
      return;
    }
    const row = { start, word: m.word, typed: m.typed };
    if (i !== -1) mistakes[i] = row;
    else if (mistakes.length < 50) mistakes.push(row);
  }
  /**
   * Shared insertion path for printable input, Tab fill, Enter and
   * auto-close. Assisted chars (editor QOL) match the target by
   * construction and are counted separately so scoring stays honest.
   * With autoIndent, a correctly placed newline also pulls in the next
   * line's exact indentation as assisted chars.
   */
  function insertItems(items: { ch: string; assisted: boolean }[], autoIndent = false): void {
    if (autoIndent && items.length === 1 && items[0]!.ch === "\n") {
      const indent = codeIndentFor(target, typed.length);
      for (const ch of indent) items.push({ ch, assisted: true });
    }
    const batchAt = Date.now();
    let firstInBatch = true;
    let appended = "";
    // Assists only fire on single physical presses — never inside a paste,
    // where an auto-inserted closer would duplicate pasted characters.
    const allowClose = items.length === 1 || autoIndent;
    for (const item of items) {
      const ch = item.ch;
      if (typed.length >= target.length + 20) break;
      if (startTime === null) startTime = Date.now();
      const pos = typed.length;
      typed += ch;
      appended += ch;
      totalKeystrokes++;
      // Zen has no target: every char counts as correct by definition.
      const expected = cfg.zen === true ? ch : pos < target.length ? target[pos]! : ch;
      const hit = cfg.zen === true ? true : pos < target.length && ch === target[pos];
      if (hit) correctKeystrokes++;
      // Latency: time since previous keystroke batch. Chars after the
      // first in a batch get 0 (excluded from avg in stats).
      const latency = lastKeyTime == null || firstInBatch === false ? 0 : batchAt - lastKeyTime;
      keyEvents.push({ key: normalizeKey(expected), correct: hit, latencyMs: latency });
      if (item.assisted) assists++;
      firstInBatch = false;
      // Word completed: a separator typed where the target has one.
      if ((ch === " " || ch === "\n") && pos < target.length && target[pos] === ch) {
        let s = pos - 1;
        while (s >= 0 && target[s] !== " " && target[s] !== "\n") s--;
        checkWord(s + 1, pos);
      }
      // Auto-close (code only): a matched opener whose mate comes next
      // pulls the closer in as an assisted char (empty pairs like `()`).
      if (multiline && allowClose && hit && PAIRS[ch] !== undefined && target[typed.length] === PAIRS[ch]) {
        const closer = PAIRS[ch]!;
        if (typed.length < target.length + 20) {
          typed += closer;
          appended += closer;
          totalKeystrokes++;
          correctKeystrokes++;
          keyEvents.push({ key: normalizeKey(closer), correct: true, latencyMs: 0 });
          assists++;
        }
      }
    }
    if (appended) {
      logInput("insert", appended);
      snapshot();
      lastKeyAt = Date.now();
      lastKeyTime = batchAt;
      draw();
      checkEnd();
    }
  }
  function countCorrect(): number {
    if (cfg.zen === true) return typed.length; // freestyle: all typed counts
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
    const e = Math.max(elapsed(), 0.01);
    if (cfg.zen === true) return scoreZen(typed, e, totalKeystrokes, corrections);
    return scoreRun(target, typed, e);
  }

  function draw() {
    const contentWidth = Math.min(vpCols, 80);
    // Block caret blinks when idle (~530ms), stays solid while typing.
    const blinkOn = Date.now() - lastKeyAt < 600 || Math.floor(Date.now() / 530) % 2 === 0;
    const word = currentWordRange(target, Math.min(typed.length, target.length));
    // Bracket match (editor QOL): underline the pair when the cursor sits
    // on a bracket, or just after typing a closer.
    const cursorPos = Math.min(typed.length, target.length);
    let matchSet: Set<number> | null = null;
    const atCursor = target[cursorPos];
    if (atCursor !== undefined && "(){}[]".includes(atCursor)) {
      const mate = findMate(target, cursorPos);
      matchSet = new Set(mate != null ? [cursorPos, mate] : [cursorPos]);
    } else if (cursorPos > 0 && target[cursorPos - 1] !== undefined && ")}]".includes(target[cursorPos - 1]!)) {
      const mate = findMate(target, cursorPos - 1);
      if (mate != null) matchSet = new Set([cursorPos - 1, mate]);
    }
    const e = elapsed();
    const s = liveScore();
    // Live burst + consistency (Task #3). Burst resets on word change
    // (incl. backspacing into another word); idle draws before the first
    // keystroke leave burst state untouched so the first word isn't
    // diluted by pre-start idle time.
    const nowMs = Date.now();
    let burst = 0;
    let burstReady = false;
    if (startTime !== null) {
      const bw = currentWordRange(target, Math.min(typed.length, target.length));
      if (bw != null) {
        if (burstWordStart !== bw.start) {
          burstWordStart = bw.start;
          burstStartTime = nowMs;
        }
        if (burstStartTime != null) {
          let correctInWord = 0;
          for (let i = bw.start; i < typed.length && i < bw.end; i++) {
            if (typed[i] === target[i]) correctInWord++;
          }
          burst = calcBurst(correctInWord, (nowMs - burstStartTime) / 1000);
          burstReady = true;
        }
      }
    }
    // Live consistency needs a few seconds of trace to be meaningful.
    let liveCons: number | null = null;
    if (startTime !== null && e >= 3 && samples.length >= 2) {
      const cur = [
        ...samples.map((sm) => ({ tSec: sm.t, correctChars: sm.correct, typedLen: sm.typed })),
        { tSec: e, correctChars: countCorrect(), typedLen: typed.length },
      ];
      liveCons = calcConsistency(buildWpmTrace(cur, e).raw);
    }
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
    const bar = `${progressBar(progress, barW)} ${c(ansi.gray, `${Math.round(progress * 100)}%`)}`;

    // Build the screen as discrete lines, then center via composeScreen.
    const lines: string[] = [];
    // header — wordmark + mode + live stats
    lines.push(
      logo() +
        c(ansi.gray, `  ·  ${cfg.modeLabel}  ·  ◔ ${timeLabel}  ·  `) +
        c(ansi.bold + ansi.yellow, `${s.wpm.toFixed(0)} wpm`) +
        c(ansi.gray, "  ·  ") +
        c(s.acc >= 95 ? ansi.green : s.acc >= 85 ? ansi.yellow : ansi.red, `${s.acc.toFixed(1)}%`) +
        c(ansi.gray, "  ·  ") +
        (burstReady ? c(ansi.magenta, `⚡${burst.toFixed(0)}`) : c(ansi.gray, "⚡—")) +
        c(ansi.gray, "  ·  ") +
        (liveCons != null ? c(ansi.white, `${liveCons.toFixed(0)}% cons`) : c(ansi.gray, "— cons")),
    );
    lines.push(bar);
    lines.push("");

    if (!finished) {
      if (cfg.zen === true) {
        // Zen freestyle: the buffer IS the text — plain white with the
        // cursor parked at the end. Newlines render as ⏎ like code mode.
        if (startTime === null) {
          lines.push(c(ansi.gray, "Start typing to begin…"));
          lines.push("");
        } else {
          lines.push("");
        }
        const zenLines = layoutLines(typed.length > 0 ? typed : " ", contentWidth);
        const zenCursor = zenLines.length - 1;
        const zWin = textWindowSize(vpRows);
        let zStart = Math.max(0, zenCursor - 1);
        if (zStart + zWin > zenLines.length) zStart = Math.max(0, zenLines.length - zWin);
        const zEnd = Math.min(zenLines.length, zStart + zWin);
        for (let li = zStart; li < zEnd; li++) {
          const idxs = zenLines[li]!;
          let line = "";
          for (const idx of idxs) {
            if (idx >= typed.length) {
              line += c(ansi.inverse, " ");
              continue;
            }
            const ch = typed[idx]!;
            const glyph = ch === "\n" ? "⏎" : ch;
            line += c(li < zenCursor ? ansi.gray : ansi.white, glyph);
          }
          if (li === zenCursor) line += c(ansi.inverse, " ");
          lines.push(line);
        }
        if (zEnd < zenLines.length) lines.push(c(ansi.gray, `… +${zenLines.length - zEnd} more lines`));
        lines.push("");
        lines.push(
          `${keycap("esc")} ${c(ansi.gray, "finish")}   ${c(ansi.gray, "·")}   ${keycap("ctrl+w")} ${c(ansi.gray, "word")}   ${c(ansi.gray, "·")}   ${keycap("⌫")} ${c(ansi.gray, "fix")}   ${c(ansi.gray, "·")}   ${keycap("⏎")} ${c(ansi.gray, "newline")}`,
        );
      } else {
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
          line += renderChar(
            target,
            typed,
            idx,
            idx === typed.length,
            {
              caret: blinkOn,
              dim: li < cursorLine,
              active: word != null && idx >= word.start && idx < word.end,
            },
            kindMap ? (kindMap[idx] ?? null) : null,
            matchSet?.has(idx) ?? false,
          );
        }
        // cursor past end of text
        if (typed.length >= target.length && li === textLines.length - 1) {
          line += c(ansi.inverse, " ");
        }
        // extra chars beyond target
        if (li === textLines.length - 1 && typed.length > target.length) {
          const extra = typed.slice(target.length, target.length + 20);
          for (const ch of extra) {
            const glyph = ch === " " ? " " : ch === "\n" ? "⏎" : ch;
            line += c(ansi.bgRed + ansi.white, glyph);
          }
        }
        lines.push(line);
      }
      if (end < textLines.length) lines.push(c(ansi.gray, `… +${textLines.length - end} more lines`));
      lines.push("");
      lines.push(
        `${keycap("esc")} ${c(ansi.gray, "quit")}   ${c(ansi.gray, "·")}   ${keycap("ctrl+w")} ${c(ansi.gray, "word")}   ${c(ansi.gray, "·")}   ${keycap("⌫")} ${c(ansi.gray, "fix")}` +
          (multiline
            ? `   ${c(ansi.gray, "·")}   ${keycap("⏎")} ${c(ansi.gray, "newline")}   ${c(ansi.gray, "·")}   ${keycap("tab")} ${c(ansi.gray, "indent")}`
            : ""),
      );
      }
    } else {
      // results — framed panel
      const f =
        cfg.zen === true
          ? scoreZen(typed, finishElapsed, totalKeystrokes, corrections)
          : scoreRun(target, typed, finishElapsed, { totalKeystrokes, corrections });
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
      const weak = worstKeys(accumulateKeyStats(keyEvents), 5);
      const weakStr =
        weak.length === 0
          ? c(ansi.gray, "—")
          : weak
              .map((w) =>
                `${c(w.acc >= 95 ? ansi.green : w.acc >= 85 ? ansi.yellow : ansi.red, formatKey(w.key))}` +
                `${c(ansi.gray, ` ${w.acc.toFixed(0)}%`)}` +
                `${w.avgMs > 0 ? c(ansi.gray, ` ${w.avgMs.toFixed(0)}ms`) : ""}`,
              )
              .join(c(ansi.gray, "  "));
      const shownMistakes = mistakes.slice(0, 4);
      const mistakeStr =
        mistakes.length === 0
          ? c(ansi.gray, "—")
          : shownMistakes
              .map(
                (m) =>
                  `${c(ansi.red, shortWord(m.typed))}${c(ansi.gray, " → ")}${c(ansi.green, shortWord(m.word))}`,
              )
              .join(c(ansi.gray, "   ")) +
            (mistakes.length > shownMistakes.length
              ? c(ansi.gray, `   +${mistakes.length - shownMistakes.length} more`)
              : "");
      const body = [
        `${c(ansi.gray, "wpm".padEnd(6))}${c(ansi.bold + ansi.yellow, f.wpm.toFixed(1))}   ${c(ansi.gray, "raw " + f.raw.toFixed(1))}   ${c(ansi.gray, "gross " + f.gross.toFixed(1))}`,
        `${c(ansi.gray, "acc".padEnd(6))}${c(ansi.bold + ansi.white, f.acc.toFixed(1) + "%")}   ${c(ansi.gray, "cons ")}${c(ansi.bold + ansi.white, consistency.toFixed(1) + "%")}`,
        `${c(ansi.gray, "trend".padEnd(6))}${c(ansi.cyan, trend || "—")}`,
        `${c(ansi.gray, "weak".padEnd(6))}${weakStr}`,
        `${c(ansi.gray, "miss".padEnd(6))}${mistakeStr}`,
        "",
        `${c(ansi.gray, "chars".padEnd(6))}${c(ansi.green, String(f.correctChars))} correct  ${c(ansi.red, String(f.incorrectChars))} wrong  ${c(ansi.magenta, String(f.extraChars))} extra  ${c(ansi.gray, String(f.missedChars) + " missed")}`,
        `${c(ansi.gray, "cpm".padEnd(6))}${c(ansi.bold + ansi.white, f.cpm.toFixed(0))}   ${c(ansi.gray, "raw " + f.cpmRaw.toFixed(0))}   ${c(ansi.gray, String(f.corrections) + (f.corrections === 1 ? " correction" : " corrections"))}` +
          (assists > 0 ? c(ansi.gray, `   ${assists} assisted`) : ""),
        `${c(ansi.gray, "time".padEnd(6))}${finishElapsed.toFixed(1)}s   ${c(ansi.gray, "mode " + cfg.modeLabel)}`,
      ];
      if (priorBest == null) {
        body.push(c(ansi.gray, `★ first recorded ${cfg.saveMode} run`));
      } else if (f.wpm > priorBest) {
        body.push(c(ansi.bold + ansi.yellow, `✦ ★ new personal best! (${priorBest.toFixed(1)} → ${f.wpm.toFixed(1)}) ★ ✦`));
      }
      if (resultSaved) body.push(c(ansi.gray, `saved to ~/.typo/history.json${xpNote}`));
      if (cfg.zen === true && finishElapsed < MIN_ZEN_SAVE_SEC) {
        body.push(c(ansi.gray, `under ${MIN_ZEN_SAVE_SEC}s — not saved`));
      }
      body.push("");
      body.push(
        `${keycap("r")} ${c(ansi.gray, "retry")}   ${keycap("tab/n")} ${c(ansi.gray, "next")}   ${keycap("q/esc")} ${c(ansi.gray, "quit")}`,
      );
      const innerW = Math.max(...body.map((l) => stripAnsi(l).length));
      body.unshift(padCenter(c(ansi.bold + ansi.green, "✦ done ✦"), innerW));
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
    // Zen too short to save still shows results, just unrecorded.
    const tooShort = cfg.zen === true && finishElapsed < MIN_ZEN_SAVE_SEC;
    // Final word has no trailing separator — evaluate it explicitly.
    if (typed.length >= target.length && target.length > 0) {
      let s = target.length - 1;
      while (s >= 0 && target[s] !== " " && target[s] !== "\n") s--;
      checkWord(s + 1, target.length);
    }
    const f =
      cfg.zen === true
        ? scoreZen(typed, finishElapsed, totalKeystrokes, corrections)
        : scoreRun(target, typed, finishElapsed, { totalKeystrokes, corrections });
    const gained = xpForDuration(finishElapsed);
    const lvBefore = levelForXp(priorXp);
    const lvAfter = levelForXp(priorXp + gained);
    xpNote = ` · +${gained} XP` + (lvAfter > lvBefore ? ` · ★ level up → L${lvAfter}` : "");
    const finTrace = buildWpmTrace(
      [...samples.map((s) => ({ tSec: s.t, correctChars: s.correct, typedLen: s.typed })),
        { tSec: finishElapsed, correctChars: f.correctChars, typedLen: typed.length }],
      finishElapsed,
    );
    const finConsistency = Math.round(calcConsistency(finTrace.raw) * 10) / 10;
    const finWeak = worstKeys(accumulateKeyStats(keyEvents), 5).map((w) => ({
      key: w.key,
      acc: Math.round(w.acc * 10) / 10,
      avgMs: Math.round(w.avgMs),
      presses: w.presses,
    }));
    if (tooShort) {
      // Skip saving entirely — draw() notes it on the panel instead.
      draw();
      return;
    }
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
      weakKeys: finWeak,
      gross: Math.round(f.gross * 10) / 10,
      cpm: Math.round(f.cpm),
      corrections: f.corrections,
      mistakes: mistakes.slice(0, 20).map((m) => ({ word: m.word, typed: m.typed })),
      ...(assists > 0 ? { assists } : {}),
    })
      .then(() => {
        resultSaved = true;
        draw();
      })
      .catch(() => {
        draw();
      });
    // Keystroke log for `typo --replay` (fire-and-forget; never blocks UI).
    void saveLastReplay({
      version: 1,
      date: new Date().toISOString(),
      mode: cfg.saveMode,
      modeLabel: cfg.modeLabel,
      target,
      events: inputLog,
    });
    draw();
  }

  function checkEnd() {
    if (finished) return;
    if (cfg.zen === true) return; // freestyle ends only via Esc
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
        // Esc (bare) quits — except in zen, where it finishes the run
        // (Ctrl+C still bails without saving). Arrow/function keys
        // start with \x1b[ — ignore.
        if (data === "\x1b") {
          if (cfg.zen === true && startTime !== null) {
            finish();
            return;
          }
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
            corrections++;
            logInput("worddel");
            snapshot();
            lastKeyAt = Date.now();
            lastKeyTime = Date.now();
            draw();
          }
          return;
        }
        if (data.startsWith("\x1b")) return;

        // Backspace (DEL or BS)
        if (data === "\x7f" || data === "\x08") {
          if (typed.length > 0) {
            typed = typed.slice(0, -1);
            corrections++;
            logInput("back");
            snapshot();
            lastKeyAt = Date.now();
            lastKeyTime = Date.now();
            draw();
          }
          return;
        }
        // Ctrl-U: clear all
        if (data === "\x15") {
          if (typed.length > 0) {
            corrections++;
            logInput("clear");
          }
          typed = "";
          snapshot();
          lastKeyAt = Date.now();
          lastKeyTime = Date.now();
          draw();
          return;
        }
        // Tab fills expected indentation and Enter inserts newline (+ the
        // next line's exact indent) in code; elsewhere both keep their old
        // behavior (Tab ignored, Enter ignored) so stray keys can't corrupt
        // a single-line run.
        if (data === "\t" || data === "\r" || data === "\n") {
          if (!multiline) return;
          if (data === "\t") {
            const fill = tabFillFor(target, typed.length);
            if (fill === "") return;
            insertItems(fill.split("").map((ch) => ({ ch, assisted: true })));
            return;
          }
          insertItems([{ ch: "\n", assisted: false }], true);
          return;
        }

        // printable input (may contain multiple chars if pasted)
        const text = multiline ? data.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : data;
        const items: { ch: string; assisted: boolean }[] = [];
        for (const ch of text) {
          if (ch === "\t") continue; // bare Tab is handled above
          const code = ch.codePointAt(0)!;
          if (ch !== "\n" && (code < 32 || code === 127)) continue; // control
          items.push({ ch, assisted: false });
        }
        if (items.length === 0) return;
        insertItems(items);
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
