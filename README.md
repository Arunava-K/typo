# typo — CLI typing practice & speed test

> Like Monkeytype / 10fastfingers, but in your terminal.
> Pure Node.js + TypeScript, **zero runtime dependencies**.

![node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-blue)
![deps](https://img.shields.io/badge/deps-0-brightgreen)

## ✨ Why typo?

- 🖥️ **Fullscreen canvas** — alternate-screen buffer, vertically + horizontally centered, no scrollback jitter
- ⌨️ **Monkeytype feel** — blinking block caret, dimmed history lines, active-word highlight, live burst ⚡ + consistency
- 📊 **Real stats** — WPM / raw / gross, accuracy, consistency, WPM trend sparkline, worst keys, CPM, corrections, char breakdown
- 🏆 **Progression** — XP + levels, daily streaks, milestone badges, per-mode personal bests
- ◉ **Daily challenge** — `--daily` is the same text all day on every machine (seeded, shareable)
- ▶️ **Replay** — `--replay` plays your last run back keystroke-by-keystroke with pause + speed control
- 📦 **Portable history** — `--export csv|json` / `--import` with dedupe, stored in `~/.typo/history.json`

## 📸 What it looks like

Setup menu (`typo` with no flags):

```text
╭────────────────────────────────────────╮
│   typo  ·  setup                       │
│   pick a setup, hit enter              │
│                                        │
│     ◷  mode                 ‹ time ›   │
│     ◔  duration              ‹ 30s ›   │
│     Aa punctuation             ○ off   │
│     #  numbers                 ○ off   │
│                                        │
│   ──────────────────────────────────   │
│                                        │
│   ▌ ▶  start test                      │
│     ↺  history                         │
│     ⎋  quit                            │
│                                        │
│   ──────────────────────────────────   │
│   lv 1  ▓▓░░░░░░  225 xp               │
│   1d streak  ·  ★ 62 best              │
╰────────────────────────────────────────╯

 [↑↓/jk] move  ·  [←→/hl] change  ·  [⏎] select  ·  [q] quit
```

Live typing HUD:

```text
typo  ·  time 30s  ·  ◔ 24s  ·  45 wpm  ·  98.2%  ·  ⚡82  ·  96% cons
██████▊░░░░░░░░░░░░░░░░░░░░░░  38%

the quick brown fox jumps over the lazy dog ...
```

Results panel:

```text
╭──────────────────────────────────────────╮
│               ✦ done ✦                   │
│  wpm    52.7   raw 55.0   gross 58.1      │
│  acc    98.0%   cons 96.1%                │
│  trend  ▂▄▅▇█▇▅▄▂                         │
│  weak   e 92% 120ms   a 95% 98ms          │
│  miss   teh → the                         │
│  ✦ ★ new personal best! (49.1 → 52.7) ★ ✦ │
│  saved to ~/.typo/history.json · +30 XP   │
│  [r] retry   [tab/n] next   [q/esc] quit   │
╰──────────────────────────────────────────╯
```

History (`typo --history`) is colorized: best/avg, last-10, totals,
14-day activity bar, level + streak, badges, WPM trend, histogram,
per-mode PBs, and a recent-runs table. The in-menu history viewer
splits the same data across four tabbed screens (`overview / trends /
bests / runs`) so it always fits: `[←→/tab]` switch tabs, `[↑↓]`
scroll long lists, `[esc]` back to setup.

## Install

Install globally to get the `typo` command:

```bash
npm install -g @reading_steiner/typo
typo
```

Or run it once without installing:

```bash
npx @reading_steiner/typo --time 30
```

### From source

```bash
git clone https://github.com/Arunava-K/typo.git
cd typo
npm install
npm run build
npm link        # makes `typo` available globally
```

## Usage

```bash
typo [options]
```

Just `typo` with no options opens the interactive setup menu —
pick mode, duration, word count, punctuation/numbers, custom file,
or history, all without memorizing flags. Your last setup is
remembered between tests, and your level / streak / best shows
under the panel.

| Option | Description |
|---|---|
| `--time <sec>` | Timed test, e.g. `--time 15/30/60/120` (default: 30, 1–600s) |
| `--words <n>` | Fixed word-count test, e.g. `--words 10/25/50/100` (1–1000) |
| `--quote` | Random quote / sentence ❝ |
| `--daily` | Shared daily text, same all day on every machine ◉ |
| `--code <lang>` | Code snippet test: python, javascript, typescript, go, rust, java, c, cpp, csharp, php, ruby, html |
| `--zen` | Free typing, no prompt — Esc finishes (15s+ saved) |
| `--custom <file>` | Practice with text from a file ✎ |
| `--text "..."` | Practice with inline custom text |
| `-p, --punctuation` | Add punctuation + capitals (words/time modes) |
| `--numbers` | Add numbers (words/time modes) |
| `--sudden-death` | First mistake ends the run as failed |
| `--no-backspace` | Corrections disabled, expert style |
| `--min-acc <n>` | Fail the run below n% accuracy (10-char grace) |
| `--pace <wpm>` | Race a ghost caret at n wpm (5–300) |
| `--history` | Show past results, PBs, averages & activity |
| `--history --mode <m>` | Filter history by mode, e.g. `"time"` (repeatable) |
| `--history --last <n>` | Show last n runs (default 10) |
| `--replay` | Replay your last run keystroke-by-keystroke ▶ |
| `--export <csv\|json>` | Print history to stdout (`> backup.csv`) |
| `--import <file>` | Merge exported runs back in (dedupes) |
| `--debug-keys` | Show key codes to diagnose shortcuts |
| `-h, --help` | Colorized help with examples |
| `--version` | Version |

### Examples

```bash
typo                    # interactive setup menu
typo --time 120         # 120s test (any 1–600s works)
typo --time 60 -p       # 60s with punctuation
typo --words 50         # 50 words
typo --quote            # random quote
typo --daily            # today's shared text
typo --code python      # python snippet
typo --zen               # free typing
typo --custom essay.txt # your own text
typo --history          # past scores (colorized)
typo --replay           # watch your last run back
```

### Keys

- **While typing:** just start typing to begin the timer · `[esc]` quit · `[⌫]` fix · `[ctrl+w]` / `ctrl+backspace` delete word · `ctrl+u` clear all · `[⏎]` newline in code mode · `[tab]` fill indent in code mode
- **On results:** `[r]` retry · `[tab/n]` next test · `[q/esc]` quit
- **In setup menu:** `[↑↓/jk]` move · `[←→/hl]` change · `[⏎]` select · `[q]` quit
- **In replay:** `[space]` pause · `[+/−]` speed · `[r]` restart · `[q]` quit
- **In code mode:** syntax highlighting, bracket-pair underlines, `[tab]` fills the exact expected indent, `[⏎]` auto-indents the new line, empty pairs like `()` auto-close. Assisted chars match the target and are counted on the results screen (`N assisted`) so practice stays honest.

Live HUD shows countdown (or elapsed), live WPM, accuracy, current-word burst and consistency plus a fractional progress bar. Results show WPM, raw + gross WPM, accuracy, consistency, WPM trend, worst keys, word mistakes, CPM, corrections and char breakdown, earn XP toward levels, and are saved to `~/.typo/history.json`.

### Shortcut not working?

Terminals disagree on what combos like Ctrl+Backspace send. Run
`typo --debug-keys`, press the combo, and check the `wordDelete=yes`
verdict. If it says `no`, paste the `bytes [...]` line in an issue and
we will add your terminal's sequence.

## 🗂️ Data & portability

- History lives in `~/.typo/history.json` (last 500 runs), replay in `~/.typo/last-replay.json`.
- `typo --export csv > backup.csv` for spreadsheets, `--export json` for full fidelity (weak keys, mistakes).
- `typo --import backup.csv` merges back in, skipping duplicates and rejecting bad rows with a count.

## How WPM is calculated

Standard formula: `(correct characters / 5) / minutes`. Raw WPM counts every typed character. Gross WPM counts every keystroke ever pressed (including deleted ones). Accuracy = correct keystrokes / total keystrokes. Consistency = `100 × (1 − stdev/mean)` over per-second raw WPM (steady pace → ~100).
