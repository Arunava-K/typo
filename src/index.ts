#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { isWordDeleteKey, runTest, type RunConfig } from "./engine.js";
import { generateWords, generateQuote, generateDaily, dailyDateStr, normalizeCustom } from "./generator.js";
import { CODE_LANGS, generateCode, normalizeCodeLang, type CodeLang } from "./code.js";
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
import { ansi, c, divider, keycap, logo } from "./ui.js";

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require("../package.json") as { version: string };

interface Mode {
  kind: "time" | "words" | "quote" | "custom" | "daily" | "code" | "zen";
  timeSec: number;
  wordCount: number;
  customText: string | null;
  customFile: string | null;
  codeLang: string | null;
  suddenDeath: boolean;
  noBackspace: boolean;
  minAcc: number | null;
  pace: number | null;
  punctuation: boolean;
  numbers: boolean;
}

function printHelp(): void {
  const H = (t: string): string => c(ansi.bold + ansi.white, t);
  const D = (t: string): string => c(ansi.gray, t);
  const flag = (t: string): string => c(ansi.bold + ansi.cyan, t);
  console.log(`${logo()}  ${D("·  CLI typing practice & speed test")}
  ${D("like Monkeytype / 10fastfingers, but in your terminal. Zero dependencies.")}

${H("Usage:")}
  ${c(ansi.bold + ansi.green, "typo")}                ${D("open the interactive setup menu (no flags needed)")}
  ${c(ansi.bold + ansi.green, "typo")} ${flag("[options]")}      ${D("jump straight into a test")}

${H("Modes:")} ${D("(default: --time 30)")}
  ${flag("--time <sec>")}       ${D("timed test (e.g. 15, 30, 60, 120)")}
  ${flag("--words <n>")}        ${D("fixed word count test (e.g. 10, 25, 50, 100)")}
  ${flag("--quote")}            ${D("random quote / sentence  ❝")}
  ${flag("--daily")}            ${D("shared daily text (same all day, everywhere)  ◉")}
  ${flag("--code <lang>")}       ${D("code snippet test (python, javascript, go, rust…)  <>")}
  ${flag("--zen")}             ${D("free typing, no prompt — esc finishes  ∞")}
  ${flag("--custom <file>")}    ${D("practice with text from a file  ✎")}
  ${flag('--text "..."')}       ${D("practice with inline custom text")}

${H("Modifiers:")}
  ${flag("-p, --punctuation")}  ${D("include punctuation + capitals (words/time modes)")}
  ${flag("--numbers")}          ${D("include numbers (words/time modes)")}
  ${flag("--sudden-death")}     ${D("first mistake ends the run as failed  ✗")}
  ${flag("--no-backspace")}     ${D("corrections disabled, expert style")}
  ${flag("--min-acc <n>")}      ${D("fail the run below n% accuracy (10-char grace)")}
  ${flag("--pace <wpm>")}        ${D("race a ghost caret at n wpm  »")}

${H("Progress:")}
  ${flag("--history")}          ${D("show past results, PBs, averages & activity")}
  ${flag("--history --mode <m>")}   ${D('filter history by mode, e.g. "time" (repeatable)')}
  ${flag("--history --last <n>")}   ${D("show last n runs (default 10)")}
  ${flag("--export <csv|json>")}  ${D("print history to stdout (redirect to a file)")}
  ${flag("--import <file>")}      ${D("merge exported runs back in (dedupes)")}
  ${flag("--replay")}           ${D("replay your last run keystroke-by-keystroke  ▶")}
  ${flag("--debug-keys")}       ${D("press keys to see their codes (diagnose shortcuts)")}
  ${flag("-h, --help")}         ${D("show this help")}
  ${flag("--version")}          ${D("show version")}

${H("Keys while typing:")}
  ${keycap("type")} ${D("begin")}  ${D("·")}  ${keycap("esc")} ${D("quit")}  ${D("·")}  ${keycap("⌫")} ${D("fix")}  ${D("·")}  ${keycap("ctrl+w")} ${D("delete word")}  ${D("·")}  ${keycap("⏎")} ${D("newline (code)")}  ${D("·")}  ${keycap("tab")} ${D("indent (code)")}

${H("Keys on results:")}
  ${keycap("r")} ${D("retry")}  ${D("·")}  ${keycap("tab/n")} ${D("next")}  ${D("·")}  ${keycap("q/esc")} ${D("quit")}

${H("Examples:")}
  ${D("$")} typo                      ${D("# interactive setup menu")}
  ${D("$")} typo --time 60 -p         ${D("# 60s with punctuation")}
  ${D("$")} typo --words 50           ${D("# 50 words")}
  ${D("$")} typo --quote              ${D("# random quote")}
  ${D("$")} typo --daily              ${D("# today's shared text")}
  ${D("$")} typo --code python        ${D("# python snippet")}
  ${D("$")} typo --zen                ${D("# free typing")}
  ${D("$")} typo --custom essay.txt   ${D("# custom text from file")}
  ${D("$")} typo --replay             ${D("# watch your last run back")}
  ${divider(56)}
`);
}

function parseArgs(argv: string[]): { mode: Mode; history: boolean; help: boolean; version: boolean; debugKeys: boolean; replay: boolean; historyModes: string[]; historyLast: number | null; exportFmt: "csv" | "json" | null; importFile: string | null } {
  const mode: Mode = {
    kind: "time",
    timeSec: 30,
    wordCount: 50,
    customText: null,
    customFile: null,
    codeLang: null,
    suddenDeath: false,
    noBackspace: false,
    minAcc: null,
    pace: null,
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
    } else if (a === "--zen" || a === "-z") {
      mode.kind = "zen";
      modeSet = true;
    } else if (a === "--sudden-death") {
      mode.suddenDeath = true;
    } else if (a === "--no-backspace") {
      mode.noBackspace = true;
    } else if (a === "--min-acc") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0 || v > 100) {
        console.error(`Invalid --min-acc value: ${argv[i]} (use 1–100)`);
        process.exit(1);
      }
      mode.minAcc = v;
    } else if (a === "--pace") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 5 || v > 300) {
        console.error(`Invalid --pace value: ${argv[i]} (use 5–300 wpm)`);
        process.exit(1);
      }
      mode.pace = Math.round(v);
    } else if (a === "--code") {
      const lang = argv[++i];
      const id = lang ? normalizeCodeLang(lang) : null;
      if (!id) {
        console.error(`Invalid --code value: ${lang ?? "(missing)"} (use ${CODE_LANGS.join(", ")})`);
        process.exit(1);
      }
      mode.kind = "code";
      mode.codeLang = id;
      modeSet = true;
    } else if (a.startsWith("--code=")) {
      const id = normalizeCodeLang(a.split("=").slice(1).join("="));
      if (!id) {
        console.error(`Invalid --code value (use ${CODE_LANGS.join(", ")})`);
        process.exit(1);
      }
      mode.kind = "code";
      mode.codeLang = id;
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

/** Fail-modifier suffixes: distinct saveModes keep PBs comparable. */
function modSuffix(mode: Mode): { label: string; save: string } {
  const parts: string[] = [];
  if (mode.suddenDeath) parts.push("sudden");
  if (mode.noBackspace) parts.push("noback");
  if (mode.minAcc != null) parts.push(`minacc${mode.minAcc}`);
  if (parts.length === 0) return { label: "", save: "" };
  return { label: ` · ${parts.join(" ")}`, save: ` ${parts.join(" ")}` };
}

async function buildTarget(mode: Mode): Promise<{ text: string; label: string; saveMode: string; timeLimit: number | null; codeLang: CodeLang | null; zen: boolean }> {
  const ms = modSuffix(mode);
  if (mode.kind === "time") {
    const count = Math.max(80, Math.ceil(mode.timeSec * 4));
    const text = generateWords(count, { punctuation: mode.punctuation, numbers: mode.numbers });
    const mods = [mode.punctuation ? ",punct" : "", mode.numbers ? ",num" : ""].join("");
    return { text, label: `time ${mode.timeSec}s${mods}${ms.label}`, saveMode: `time ${mode.timeSec}s${ms.save}`, timeLimit: mode.timeSec, codeLang: null, zen: false };
  }
  if (mode.kind === "words") {
    const text = generateWords(mode.wordCount, { punctuation: mode.punctuation, numbers: mode.numbers });
    return { text, label: `words ${mode.wordCount}${ms.label}`, saveMode: `words ${mode.wordCount}${ms.save}`, timeLimit: null, codeLang: null, zen: false };
  }
  if (mode.kind === "quote") {
    const text = generateQuote();
    return { text, label: `quote${ms.label}`, saveMode: `quote${ms.save}`, timeLimit: null, codeLang: null, zen: false };
  }
  if (mode.kind === "daily") {
    const day = dailyDateStr();
    const text = generateDaily(day);
    return { text, label: `daily ${day}${ms.label}`, saveMode: `daily${ms.save}`, timeLimit: null, codeLang: null, zen: false };
  }
  if (mode.kind === "code") {
    const lang = normalizeCodeLang(mode.codeLang ?? "python") ?? "python";
    const text = generateCode(lang);
    return { text, label: `code ${lang}${ms.label}`, saveMode: `code ${lang}${ms.save}`, timeLimit: null, codeLang: lang, zen: false };
  }
  if (mode.kind === "zen") {
    return { text: "", label: `zen${ms.label}`, saveMode: `zen${ms.save}`, timeLimit: null, codeLang: null, zen: true };
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
  return { text, label: `custom${ms.label}`, saveMode: `custom${ms.save}`, timeLimit: null, codeLang: null, zen: false };
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
    codeLang: "python",
    suddenDeath: false,
    noBackspace: false,
    minAcc: null,
    pace: null,
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
      codeLang: m.config.codeLang || "python",
      suddenDeath: m.config.suddenDeath,
      noBackspace: m.config.noBackspace,
      minAcc: m.config.minAcc,
      pace: m.config.pace,
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
        codeLang: t.codeLang,
        zen: t.zen,
        suddenDeath: mode.suddenDeath,
        noBackspace: mode.noBackspace,
        minAcc: mode.minAcc,
        pace: mode.pace,
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
    console.log(`typo ${pkgVersion}`);
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
      codeLang: t.codeLang,
      zen: t.zen,
      suddenDeath: mode.suddenDeath,
      noBackspace: mode.noBackspace,
      minAcc: mode.minAcc,
      pace: mode.pace,
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
