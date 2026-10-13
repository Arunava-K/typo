// Minimal ANSI helpers — no dependencies.

export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
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
  clearScreen: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

export function c(code: string, text: string): string {
  return code + text + ansi.reset;
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
