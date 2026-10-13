// Session replay viewer for `typo --replay` — plays back the latest
// finished run keystroke-by-keystroke from ~/.typo/last-replay.json.

import {
  buildBox,
  composeScreen,
  currentWordRange,
  deleteLastWord,
  enterFullscreen,
  layoutLines,
  leaveFullscreen,
  renderChar,
  textWindowSize,
} from "./engine.js";
import { loadLastReplay, type ReplayEvent } from "./history.js";
import { ansi, c, termHeight, termWidth } from "./ui.js";

/** Apply one recorded event to the replay buffer (pure, unit-testable). */
export function applyReplayEvent(typed: string, target: string, ev: ReplayEvent): string {
  switch (ev.type) {
    case "insert": {
      const room = target.length + 20 - typed.length;
      if (room <= 0) return typed;
      return typed + (ev.text ?? "").slice(0, room);
    }
    case "back":
      return typed.slice(0, -1);
    case "worddel":
      return deleteLastWord(typed);
    case "clear":
      return "";
  }
}

const SPEEDS = [0.5, 1, 2, 4];

export async function runReplay(): Promise<void> {
  const rep = await loadLastReplay();
  if (!rep) {
    console.error("No replay yet. Finish a test first, then run `typo --replay`.");
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("typo --replay needs an interactive terminal (TTY).");
    return;
  }

  const { target, events, modeLabel } = rep;
  const duration = events.length > 0 ? events[events.length - 1]!.t : 0;

  const stdin = process.stdin;
  const stdout = process.stdout;
  stdin.setEncoding("utf8");
  try {
    stdin.setRawMode(true);
  } catch {
    /* noop */
  }
  stdin.resume();
  enterFullscreen();

  let vt = 0; // virtual clock, ms
  let vi = 0; // next event index
  let typed = "";
  let speedIdx = 1; // 1x
  let paused = false;
  let done = events.length === 0;

  function draw(): void {
    const vpCols = termWidth();
    const vpRows = Math.max(10, termHeight());
    const contentWidth = Math.min(vpCols, 80);
    const speed = SPEEDS[speedIdx]!;
    const lines: string[] = [];
    lines.push(
      c(ansi.bold + ansi.cyan, "typo") +
        c(ansi.gray, `  │  replay ${modeLabel}  │  ${paused ? "⏸" : "▶"} ${speed}x  │  `) +
        c(ansi.gray, `${(vt / 1000).toFixed(1)}s / ${(duration / 1000).toFixed(1)}s`),
    );
    const barW = Math.min(30, contentWidth - 20);
    const progress = duration > 0 ? Math.min(1, vt / duration) : 1;
    const filled = Math.round(progress * barW);
    lines.push(c(ansi.gray, "█".repeat(filled) + "░".repeat(Math.max(0, barW - filled))));
    lines.push("");

    const word = currentWordRange(target, Math.min(typed.length, target.length));
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
          caret: true,
          dim: li < cursorLine,
          active: word != null && idx >= word.start && idx < word.end,
        });
      }
      if (typed.length >= target.length && li === textLines.length - 1) {
        line += c(ansi.inverse, " ");
      }
      lines.push(line);
    }
    if (end < textLines.length) lines.push(c(ansi.gray, `… +${textLines.length - end} more lines`));
    lines.push("");
    if (done) {
      for (const bl of buildBox([
        c(ansi.bold + ansi.green, "replay finished"),
        c(ansi.gray, "r restart   ·   q/esc quit"),
      ])) {
        lines.push(bl);
      }
    } else {
      lines.push(c(ansi.gray, "space pause   ·   +/− speed   ·   r restart   ·   q quit"));
    }
    stdout.write(composeScreen(lines, vpCols, vpRows, contentWidth));
  }

  function cleanup(): void {
    clearInterval(tick);
    stdin.off("data", onData);
    stdout.off("resize", onResize);
    try {
      stdin.setRawMode(false);
    } catch {
      /* noop */
    }
    stdin.pause();
    leaveFullscreen();
  }

  const onData = (chunk: Buffer): void => {
    const data = chunk.toString("utf8");
    if (/^\x1b\[\d+;\d+R/.test(data)) return;
    if (data === "\x03" || data === "\x1b" || data === "q" || data === "Q") {
      cleanup();
      resolve();
      return;
    }
    if (data === " ") {
      paused = !paused;
      draw();
      return;
    }
    if (data === "+" || data === "=") {
      speedIdx = Math.min(SPEEDS.length - 1, speedIdx + 1);
      draw();
      return;
    }
    if (data === "-" || data === "_") {
      speedIdx = Math.max(0, speedIdx - 1);
      draw();
      return;
    }
    if (data === "r" || data === "R") {
      vt = 0;
      vi = 0;
      typed = "";
      done = events.length === 0;
      draw();
      return;
    }
  };

  const onResize = (): void => draw();

  let resolve!: () => void;
  const finished = new Promise<void>((res) => {
    resolve = res;
  });

  stdin.on("data", onData);
  stdout.on("resize", onResize);

  const tick = setInterval(() => {
    if (!paused && !done) {
      vt += 30 * SPEEDS[speedIdx]!;
      while (vi < events.length && events[vi]!.t <= vt) {
        typed = applyReplayEvent(typed, target, events[vi]!);
        vi++;
      }
      if (vi >= events.length && vt >= duration) {
        done = true;
        vt = Math.max(vt, duration);
      }
      draw();
    }
  }, 30);

  draw();
  await finished;
}
