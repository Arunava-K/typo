# typo — CLI typing practice & speed test

Like Monkeytype / 10fastfingers, but in your terminal. Pure Node.js + TypeScript, zero runtime dependencies.

## Install

```bash
npm install
npm run build
npm link        # optional: makes `typo` available globally
```

Or run directly without linking:

```bash
node dist/index.js --time 30
```

## Usage

```bash
typo [options]
```

Just `typo` with no options opens the interactive setup menu —
pick mode, duration (15s–240s), word count, punctuation/numbers,
custom file, or history, all without memorizing flags.

| Option | Description |
|---|---|
| `--time <sec>` | Timed test, e.g. `--time 15/30/60/120` (default: 30) |
| `--words <n>` | Fixed word-count test, e.g. `--words 10/25/50/100` |
| `--quote` | Random quote / sentence |
| `--custom <file>` | Practice with text from a file |
| `--text "..."` | Practice with inline custom text |
| `-p, --punctuation` | Add punctuation + capitals (words/time modes) |
| `--numbers` | Add numbers (words/time modes) |
| `--history` | Show past results, per-mode PBs & averages |
| `--replay` | Replay your last run keystroke-by-keystroke |
| `--debug-keys` | Show key codes to diagnose shortcuts |
| `-h, --help` | Help |
| `--version` | Version |

### Examples

```bash
typo                    # interactive setup menu
typo --time 120         # 120s test (any 1–600s works)
typo --time 60 -p       # 60s with punctuation
typo --words 50         # 50 words
typo --quote            # random quote
typo --custom essay.txt # your own text
typo --history          # past scores
```

### Keys

- **While typing:** just start typing to begin the timer · `esc` quit · `backspace` fix · `ctrl+w` / `ctrl+backspace` delete word · `ctrl+u` clear
- **On results:** `r` retry · `tab`/`n` next test · `q`/`esc` quit

Live HUD shows countdown (or elapsed), live WPM, accuracy, current-word burst and consistency. Results show WPM, raw + gross WPM, accuracy, consistency, WPM trend, worst keys, CPM, corrections and char breakdown, and are saved to `~/.typo/history.json`.

### Shortcut not working?

Terminals disagree on what combos like Ctrl+Backspace send. Run
`typo --debug-keys`, press the combo, and check the `wordDelete=yes`
verdict. If it says `no`, paste the `bytes [...]` line in an issue and
we will add your terminal's sequence.

## How WPM is calculated
Standard formula: `(correct characters / 5) / minutes`. Raw WPM counts every typed character. Accuracy = correct keystrokes / total keystrokes.
