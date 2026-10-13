// Pure stat functions — easy to unit-test.

export interface KeystrokeStats {
  correctChars: number; // correct incl. spaces
  totalTyped: number; // all typed chars (excl. backspaces themselves)
  correctKeystrokes: number;
  totalKeystrokes: number;
  elapsedSec: number;
}

/** Standard WPM: (correctChars / 5) / minutes. */
export function calcWpm(correctChars: number, elapsedSec: number): number {
  if (elapsedSec <= 0) return 0;
  return correctChars / 5 / (elapsedSec / 60);
}

/** Raw WPM counts every typed char. */
export function calcRawWpm(totalTyped: number, elapsedSec: number): number {
  if (elapsedSec <= 0) return 0;
  return totalTyped / 5 / (elapsedSec / 60);
}

export function calcAccuracy(correctKeystrokes: number, totalKeystrokes: number): number {
  if (totalKeystrokes === 0) return 100;
  return (correctKeystrokes / totalKeystrokes) * 100;
}

/**
 * Score a finished (or in-progress) run by comparing typed vs target
 * char-by-char. Extra chars beyond target count as incorrect.
 */
export function scoreRun(
  target: string,
  typed: string,
  elapsedSec: number,
): {
  wpm: number;
  raw: number;
  acc: number;
  correctChars: number;
  incorrectChars: number;
  extraChars: number;
  missedChars: number;
} {
  let correct = 0;
  let incorrect = 0;
  const n = Math.max(target.length, typed.length);
  for (let i = 0; i < typed.length; i++) {
    if (i < target.length && typed[i] === target[i]) correct++;
    else incorrect++;
  }
  void n;
  const extra = Math.max(0, typed.length - target.length);
  const missed = Math.max(0, target.length - typed.length);
  // typed-vs-target per-keystroke accuracy here equals correct / typed
  const acc = typed.length === 0 ? 100 : (correct / typed.length) * 100;
  return {
    wpm: calcWpm(correct, elapsedSec),
    raw: calcRawWpm(typed.length, elapsedSec),
    acc,
    correctChars: correct,
    incorrectChars: incorrect - extra < 0 ? 0 : incorrect - extra,
    extraChars: extra,
    missedChars: missed,
  };
}
