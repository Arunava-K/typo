#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { runTest, type RunConfig } from "./engine.js";
import { generateWords, generateQuote, normalizeCustom } from "./generator.js";
import { loadHistory, summarize } from "./history.js";
import { ansi, c } from "./ui.js";

interface Mode {
  kind: "time" | "words" | "quote" | "custom";
  timeSec: number;
  wordCount: number;
  customText: string | null;
  customFile: string | null;
  punctuation: boolean;
  numbers: boolean;
}

function printHelp(): void {
  console.log(`${c(ansi.bold + ansi.cyan, "typo")} — CLI typing practice & speed test
${c(ansi.gray, "like Monkeytype / 10fastfingers, but in your terminal.")}

${c(ansi.bold, "Usage:")}
  typo [options]

${c(ansi.bold, "Modes:")} ${c(ansi.gray, "(default: --time 30)")}
  --time <sec>       timed test (e.g. 15, 30, 60, 120)
  --words <n>        fixed word count test (e.g. 10, 25, 50, 100)
  --quote            random quote / sentence
  --custom <file>    practice with text from a file
  --text "..."       practice with inline custom text

${c(ansi.bold, "Modifiers:")}
  -p, --punctuation  include punctuation + capitals (words/time modes)
  --numbers          include numbers (words/time modes)

${c(ansi.bold, "Other:")}
  --history          show past results + best/average
  -h, --help         show this help
  --version          show version

${c(ansi.bold, "Keys while typing:")}
  start typing to begin · esc quit · backspace fix · ctrl+w delete word

${c(ansi.bold, "Keys on results:")}
  r retry · tab/n next · q/esc quit

${c(ansi.bold, "Examples:")}
  typo                      ${c(ansi.gray, "# 30s test")}
  typo --time 60 -p         ${c(ansi.gray, "# 60s with punctuation")}
  typo --words 50           ${c(ansi.gray, "# 50 words")}
  typo --quote              ${c(ansi.gray, "# random quote")}
  typo --custom essay.txt   ${c(ansi.gray, "# custom text from file")}
`);
}

function parseArgs(argv: string[]): { mode: Mode; history: boolean; help: boolean; version: boolean } {
  const mode: Mode = {
    kind: "time",
    timeSec: 30,
    wordCount: 50,
    customText: null,
    customFile: null,
    punctuation: false,
    numbers: false,
  };
  let history = false;
  let help = false;
  let version = false;
  let modeSet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--time" || a === "-t") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0 || v > 600) {
        console.error(`Invalid --time value: ${argv[i]} (use 1–600 seconds)`);
        process.exit(1);
      }
      mode.kind = "time";
      mode.timeSec = Math.round(v);
      modeSet = true;
    } else if (a.startsWith("--time=")) {
      const v = Number(a.split("=")[1]);
      if (!Number.isFinite(v) || v <= 0 || v > 600) {
        console.error(`Invalid --time value`);
        process.exit(1);
      }
      mode.kind = "time";
      mode.timeSec = Math.round(v);
      modeSet = true;
    } else if (a === "--words" || a === "-w") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0 || v > 1000) {
        console.error(`Invalid --words value: ${argv[i]} (use 1–1000)`);
        process.exit(1);
      }
      mode.kind = "words";
      mode.wordCount = Math.round(v);
      modeSet = true;
    } else if (a.startsWith("--words=")) {
      const v = Number(a.split("=")[1]);
      if (!Number.isFinite(v) || v <= 0 || v > 1000) {
        console.error(`Invalid --words value`);
        process.exit(1);
      }
      mode.kind = "words";
      mode.wordCount = Math.round(v);
      modeSet = true;
    } else if (a === "--quote" || a === "-q") {
      mode.kind = "quote";
      modeSet = true;
    } else if (a === "--custom" || a === "-c") {
      const f = argv[++i];
      if (!f) {
        console.error(`Missing file for --custom`);
        process.exit(1);
      }
      mode.kind = "custom";
      mode.customFile = f;
      modeSet = true;
    } else if (a.startsWith("--custom=")) {
      mode.kind = "custom";
      mode.customFile = a.split("=").slice(1).join("=");
      modeSet = true;
    } else if (a === "--text") {
      const t = argv[++i];
      if (!t) {
        console.error(`Missing text for --text`);
        process.exit(1);
      }
      mode.kind = "custom";
      mode.customText = t;
      modeSet = true;
    } else if (a.startsWith("--text=")) {
      mode.kind = "custom";
      mode.customText = a.split("=").slice(1).join("=");
      modeSet = true;
    } else if (a === "--punctuation" || a === "-p") {
      mode.punctuation = true;
    } else if (a === "--numbers") {
      mode.numbers = true;
    } else if (a === "--history" || a === "--stats") {
      history = true;
    } else if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--version" || a === "-v") {
      version = true;
    } else {
      console.error(`Unknown option: ${a}\nRun \`typo --help\` for usage.`);
      process.exit(1);
    }
  }
  void modeSet;
  return { mode, history, help, version };
}

async function buildTarget(mode: Mode): Promise<{ text: string; label: string; saveMode: string; timeLimit: number | null }> {
  if (mode.kind === "time") {
    const count = Math.max(80, Math.ceil(mode.timeSec * 4));
    const text = generateWords(count, { punctuation: mode.punctuation, numbers: mode.numbers });
    const mods = [mode.punctuation ? ",punct" : "", mode.numbers ? ",num" : ""].join("");
    return { text, label: `time ${mode.timeSec}s${mods}`, saveMode: `time ${mode.timeSec}s`, timeLimit: mode.timeSec };
  }
  if (mode.kind === "words") {
    const text = generateWords(mode.wordCount, { punctuation: mode.punctuation, numbers: mode.numbers });
    return { text, label: `words ${mode.wordCount}`, saveMode: `words ${mode.wordCount}`, timeLimit: null };
  }
  if (mode.kind === "quote") {
    const text = generateQuote();
    return { text, label: "quote", saveMode: "quote", timeLimit: null };
  }
  // custom
  let raw = mode.customText ?? "";
  if (mode.customFile) {
    try {
      raw = await fs.readFile(mode.customFile, "utf8");
    } catch (e) {
      console.error(`Could not read file: ${mode.customFile}`);
      process.exit(1);
    }
  }
  const text = normalizeCustom(raw);
  if (!text) {
    console.error("Custom text is empty after trimming whitespace.");
    process.exit(1);
  }
  return { text, label: "custom", saveMode: "custom", timeLimit: null };
}

async function main(): Promise<void> {
  const { mode, history, help, version } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  if (version) {
    console.log("typo 0.1.0");
    return;
  }
  if (history) {
    const hist = await loadHistory();
    console.log(summarize(hist));
    return;
  }

  // main loop: retry / next / quit
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const t = await buildTarget(mode);
    const cfg: RunConfig = {
      target: t.text,
      modeLabel: t.label,
      timeLimitSec: t.timeLimit,
      saveMode: t.saveMode,
    };
    const action = await runTest(cfg);
    if (action === "quit") {
      process.stdout.write(ansi.clearScreen);
      console.log(c(ansi.gray, "Thanks for practicing. Type fast, stay calm."));
      break;
    }
    // restart & next both generate a fresh text in the same mode
    if (action === "restart" || action === "next") continue;
  }
}

main().catch((err) => {
  try {
    process.stdout.write(ansi.showCursor);
  } catch { /* noop */ }
  try {
    process.stdin.setRawMode!(false);
  } catch { /* noop */ }
  console.error(err);
  process.exit(1);
});
