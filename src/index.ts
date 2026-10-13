#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { isWordDeleteKey, runTest, type RunConfig } from "./engine.js";
import { generateWords, generateQuote, generateDaily, dailyDateStr, normalizeCustom } from "./generator.js";
import {
  exportCsv,
  exportJson,
  importRows,
  loadHistory,
  parseCsvExport,
  parseJsonExport,
  summarize,
  writeHistory,
} from "./history.js";
import { runMenu, type MenuConfig } from "./menu.js";
import { runReplay } from "./replay.js";
import { ansi, c } from "./ui.js";

interface Mode {
  kind: "time" | "words" | "quote" | "custom" | "daily";
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
  typo                open the interactive setup menu (no flags needed)
  typo [options]      jump straight into a test

${c(ansi.bold, "Modes:")} ${c(ansi.gray, "(default: --time 30)")}
  --time <sec>       timed test (e.g. 15, 30, 60, 120)
  --words <n>        fixed word count test (e.g. 10, 25, 50, 100)
  --quote            random quote / sentence
  --daily            shared daily text (same all day, everywhere)
  --custom <file>    practice with text from a file
  --text "..."       practice with inline custom text

${c(ansi.bold, "Modifiers:")}
  -p, --punctuation  include punctuation + capitals (words/time modes)
  --numbers          include numbers (words/time modes)

${c(ansi.bold, "Other:")}
  --history          show past results, PBs, averages & activity
  --history --mode <m>   filter history by mode, e.g. "time" (repeatable)
  --history --last <n>   show last n runs (default 10)
  --export <csv|json>  print history to stdout (redirect to a file)
  --import <file>      merge exported runs back in (dedupes)
  --replay           replay your last run keystroke-by-keystroke
  --debug-keys       press keys to see their codes (diagnose shortcuts)
  -h, --help         show this help
  --version          show version

${c(ansi.bold, "Keys while typing:")}
  start typing to begin · esc quit · backspace fix · ctrl+w / ctrl+backspace delete word

${c(ansi.bold, "Keys on results:")}
  r retry · tab/n next · q/esc quit

${c(ansi.bold, "Examples:")}
  typo                      ${c(ansi.gray, "# 30s test")}
  typo --time 60 -p         ${c(ansi.gray, "# 60s with punctuation")}
  typo --words 50           ${c(ansi.gray, "# 50 words")}
  typo --quote              ${c(ansi.gray, "# random quote")}
  typo --daily              ${c(ansi.gray, "# today's shared text")}
  typo --custom essay.txt   ${c(ansi.gray, "# custom text from file")}
  typo --replay             ${c(ansi.gray, "# watch your last run back")}
`);
}

function parseArgs(argv: string[]): { mode: Mode; history: boolean; help: boolean; version: boolean; debugKeys: boolean; replay: boolean; historyModes: string[]; historyLast: number | null; exportFmt: "csv" | "json" | null; importFile: string | null } {
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
  let debugKeys = false;
  let replay = false;
  const historyModes: string[] = [];
  let historyLast: number | null = null;
  let exportFmt: "csv" | "json" | null = null;
  let importFile: string | null = null;
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
    } else if (a === "--daily" || a === "-d") {
      mode.kind = "daily";
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
    } else if (a === "--mode" || a === "-m") {
      const v = argv[++i];
      if (!v) {
        console.error("Missing value for --mode (e.g. --history --mode \"time 30s\")");
        process.exit(1);
      }
      historyModes.push(v);
    } else if (a === "--last" || a === "-n") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 500) {
        console.error(`Invalid --last value: ${argv[i]} (use 1–500)`);
        process.exit(1);
      }
      historyLast = v;
    } else if (a === "--replay") {
      replay = true;
    } else if (a === "--export") {
      const v = argv[++i];
      if (v !== "csv" && v !== "json") {
        console.error(`Invalid --export value: ${argv[i]} (use csv or json)`);
        process.exit(1);
      }
      exportFmt = v;
    } else if (a === "--import") {
      const f = argv[++i];
      if (!f) {
        console.error("Missing file for --import");
        process.exit(1);
      }
      importFile = f;
    } else if (a === "--debug-keys") {
      debugKeys = true;
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
  if ((historyModes.length > 0 || historyLast != null) && !history) {
    console.error("--mode and --last need --history (e.g. typo --history --mode quote)");
    process.exit(1);
  }
  const standaloneCount = [help, version, debugKeys, history, replay, exportFmt != null, importFile != null].filter(
    Boolean,
  ).length;
  if (standaloneCount > 1) {
    console.error("--history, --replay, --export, --import, --debug-keys, --help and --version can't be combined.");
    process.exit(1);
  }
  if ((exportFmt != null || importFile != null) && (modeSet || mode.punctuation || mode.numbers)) {
    console.error("--export and --import can't be combined with test options.");
    process.exit(1);
  }
  return { mode, history, help, version, debugKeys, replay, historyModes, historyLast, exportFmt, importFile };
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
  if (mode.kind === "daily") {
    const day = dailyDateStr();
    const text = generateDaily(day);
    return { text, label: `daily ${day}`, saveMode: "daily", timeLimit: null };
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

async function menuLoop(): Promise<void> {
  // Remembers your last setup between tests.
  const remembered: MenuConfig = {
    mode: "time",
    timeSec: 30,
    wordCount: 50,
    punctuation: false,
    numbers: false,
    customFile: "",
  };
  for (;;) {
    const m = await runMenu(remembered);
    if (m.kind === "quit") {
      console.log(c(ansi.gray, "Thanks for practicing. Type fast, stay calm."));
      break;
    }
    Object.assign(remembered, m.config);
    const mode: Mode = {
      kind: m.config.mode,
      timeSec: m.config.timeSec,
      wordCount: m.config.wordCount,
      customText: null,
      customFile: m.config.customFile || null,
      punctuation: m.config.punctuation,
      numbers: m.config.numbers,
    };
    // Test loop: quitting a result returns to the menu.
    for (;;) {
      const t = await buildTarget(mode);
      const cfg: RunConfig = {
        target: t.text,
        modeLabel: t.label,
        timeLimitSec: t.timeLimit,
        saveMode: t.saveMode,
      };
      const action = await runTest(cfg);
      if (action === "quit") break;
    }
  }
}

async function runDebugKeys(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("typo --debug-keys needs an interactive terminal (TTY).");
    process.exit(1);
  }
  console.log("Press keys to see their codes (ESC alone or Ctrl+C exits).");
  console.log("wordDelete=yes means the combo deletes a whole word in typo.");
  console.log("");
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  try {
    stdin.setRawMode(true);
  } catch { /* noop */ }
  stdin.resume();
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer): void => {
      const data = chunk.toString("utf8");
      const codes = Array.from(data)
        .map((ch) => String(ch.codePointAt(0)))
        .join(" ");
      console.log("  bytes [" + codes + "]  wordDelete=" + (isWordDeleteKey(data) ? "yes" : "no"));
      if (data.length === 1 && (data.charCodeAt(0) === 27 || data.charCodeAt(0) === 3)) {
        stdin.off("data", onData);
        try {
          stdin.setRawMode(false);
        } catch { /* noop */ }
        stdin.pause();
        resolve();
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // No flags → interactive setup menu.
  if (args.length === 0) {
    await menuLoop();
    return;
  }
  const { mode, history, help, version, debugKeys, replay, historyModes, historyLast, exportFmt, importFile } =
    parseArgs(args);
  if (help) {
    printHelp();
    return;
  }
  if (version) {
    console.log("typo 0.1.0");
    return;
  }
  if (debugKeys) {
    await runDebugKeys();
    return;
  }
  if (history) {
    const hist = await loadHistory();
    console.log(summarize(hist, { modes: historyModes, last: historyLast ?? 10 }));
    return;
  }
  if (replay) {
    await runReplay();
    return;
  }
  if (exportFmt) {
    const hist = await loadHistory();
    process.stdout.write(exportFmt === "csv" ? exportCsv(hist) : exportJson(hist));
    return;
  }
  if (importFile) {
    let text: string;
    try {
      text = await fs.readFile(importFile, "utf8");
    } catch {
      console.error(`Could not read file: ${importFile}`);
      process.exit(1);
    }
    let raw: unknown[];
    try {
      raw = text.trimStart().startsWith("[") ? parseJsonExport(text) : parseCsvExport(text);
    } catch (e) {
      console.error(`Could not import: ${(e as Error).message}`);
      process.exit(1);
    }
    const res = importRows(await loadHistory(), raw);
    await writeHistory(res.merged);
    const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
    console.log(
      `Imported ${plural(res.imported, "run")} (${plural(res.skipped, "duplicate")} skipped, ${plural(res.invalid, "invalid row")} rejected). Total: ${plural(res.merged.length, "run")}.`,
    );
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
      // runTest already restored the normal screen; just say goodbye.
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
    // ensure we leave the fullscreen canvas on a crash mid-test
    process.stdout.write("\x1b[?1049l");
  } catch { /* noop */ }
  try {
    process.stdin.setRawMode!(false);
  } catch { /* noop */ }
  console.error(err);
  process.exit(1);
});
