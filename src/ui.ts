// Minimal ANSI helpers — no dependencies.
// Extended with a small design system (palette, pills, keycaps, bars, logo)
// so menu / help / HUD share one look. All helpers degrade gracefully on
// terminals without truecolor (they're just ANSI codes).

export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  inverse: "\x1b[7m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  clearScreen: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

export function c(code: string, text: string): string {
  return code + text + ansi.reset;
}

/** Brand palette (16-color approximations so every terminal renders them). */
export const pal = {
  brand: ansi.cyan,
  accent: ansi.yellow,
  good: ansi.green,
  warn: ansi.yellow,
  bad: ansi.red,
  pop: ansi.magenta,
  ink: ansi.white,
  mute: ansi.gray,
};

/** Truecolor foreground: rgb(255, 180, 0) etc. Falls back gracefully. */
export function fgRGB(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** 256-color foreground. */
export function fg256(n: number): string {
  return `\x1b[38;5;${n}m`;
}

/** Gradient wordmark: "typo" in warm→cool tones. */
export function logo(): string {
  return (
    c(ansi.bold + fg256(213), "t") +
    c(ansi.bold + fg256(219), "y") +
    c(ansi.bold + fg256(159), "p") +
    c(ansi.bold + fg256(123), "o")
  );
}

/** Plain bold wordmark for narrow / non-color contexts. */
export function logoPlain(): string {
  return c(ansi.bold + ansi.cyan, "typo");
}

/** Keycap hint, e.g. keycap("↑↓") → [↑↓] in inverse-dim. */
export function keycap(label: string): string {
  return c(ansi.gray, "[") + c(ansi.bold + ansi.white, label) + c(ansi.gray, "]");
}

/** On/off pill: ● on (green) / ○ off (gray). */
export function onOffPill(v: boolean): string {
  return v ? c(ansi.bold + ansi.green, "● on") : c(ansi.gray, "○ off");
}

/** Cycler value: ‹ value › in bold yellow. */
export function cycler(value: string): string {
  return c(ansi.bold + ansi.yellow, `‹ ${value} ›`);
}

/** Fractional progress bar: █ + partial block + ░ track + pct. */
export function progressBar(frac: number, width: number): string {
  const w = Math.max(4, Math.floor(width));
  const f = Math.max(0, Math.min(1, frac));
  const total = f * w;
  const full = Math.floor(total);
  const rest = total - full;
  const parts = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const part = rest > 0.05 && full < w ? parts[Math.min(7, Math.round(rest * 7))]! : "";
  const used = full + (part ? 1 : 0);
  const bar =
    c(ansi.cyan, "█".repeat(full) + part) + c(ansi.gray, "░".repeat(Math.max(0, w - used)));
  return bar;
}

/** Small xp/level bar (green fill, gray track). */
export function xpBar(into: number, need: number, width = 14): string {
  const f = need > 0 ? Math.max(0, Math.min(1, into / need)) : 0;
  const w = Math.max(4, Math.floor(width));
  const filled = Math.round(f * w);
  return c(ansi.green, "▓".repeat(filled)) + c(ansi.gray, "░".repeat(Math.max(0, w - filled)));
}

/** Dim divider line. */
export function divider(width: number): string {
  return c(ansi.gray, "─".repeat(Math.max(1, Math.floor(width))));
}

export function termWidth(): number {
  return process.stdout.columns || 80;
}

export function termHeight(): number {
  return process.stdout.rows || 24;
}

export function padRight(s: string, n: number): string {
  // naive pad (assumes no ANSI inside); callers strip first if needed
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

/** Visible length of a string that may contain ANSI color codes. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;:]*m/g, "");
}

/** Center text (by visible width) in a field of `width` columns. */
export function padCenter(text: string, width: number): string {
  const len = stripAnsi(text).length;
  if (len >= width) return text;
  const left = Math.floor((width - len) / 2);
  return " ".repeat(left) + text + " ".repeat(width - len - left);
}
