// Regex-style tokenizer for code-mode syntax highlighting.
// Single-pass scanner: comments/strings win over code (so `//` inside a
// string or `#` inside a char literal never misfires). Per-language keyword
// sets + comment/string rules; html gets tag-name tokens. Zero dependencies.
import type { CodeLang } from "./code.js";
import { ansi } from "./ui.js";

export type TokenKind = "keyword" | "string" | "comment" | "number" | "func" | "tag";

export interface Token {
  start: number;
  end: number;
  kind: TokenKind;
}

interface LangSpec {
  keywords: string[];
  lineComments: string[];
  blockComments: [string, string][];
  quotes: string[];
  tags: boolean;
}

const C_LIKE = ["//"];
const C_BLOCK: [string, string][] = [["/*", "*/"]];
const DQUOTES = ['"', "'"];

const SPECS: Record<CodeLang, LangSpec> = {
  python: {
    keywords: ["def", "return", "if", "else", "elif", "for", "while", "in", "not", "and", "or", "None", "True", "False", "import", "from", "as", "with", "class", "lambda", "pass", "break", "continue", "raise", "try", "except", "finally", "is", "print"],
    lineComments: ["#"],
    blockComments: [],
    quotes: DQUOTES,
    tags: false,
  },
  javascript: {
    keywords: ["async", "await", "function", "return", "if", "else", "for", "while", "const", "let", "var", "new", "throw", "try", "catch", "finally", "typeof", "of", "in", "do", "break", "continue", "switch", "case", "default", "this", "null", "undefined", "true", "false", "class", "extends"],
    lineComments: C_LIKE,
    blockComments: C_BLOCK,
    quotes: ['"', "'", "`"],
    tags: false,
  },
  typescript: {
    keywords: ["async", "await", "function", "return", "if", "else", "for", "while", "const", "let", "var", "new", "throw", "try", "catch", "finally", "typeof", "of", "in", "do", "break", "continue", "switch", "case", "default", "this", "null", "undefined", "true", "false", "class", "extends", "interface", "type", "implements", "private", "public", "readonly", "string", "number", "boolean", "void", "never", "enum", "abstract", "static"],
    lineComments: C_LIKE,
    blockComments: C_BLOCK,
    quotes: ['"', "'", "`"],
    tags: false,
  },
  go: {
    keywords: ["func", "return", "if", "else", "for", "range", "var", "const", "type", "struct", "interface", "map", "go", "defer", "package", "import", "nil", "true", "false", "break", "continue", "switch", "case", "default"],
    lineComments: C_LIKE,
    blockComments: C_BLOCK,
    quotes: ['"', "`"],
    tags: false,
  },
  rust: {
    keywords: ["fn", "return", "if", "else", "match", "for", "while", "in", "let", "mut", "const", "struct", "enum", "impl", "trait", "pub", "use", "mod", "loop", "break", "continue", "where", "as", "ref", "true", "false", "self", "Self", "None", "Some", "Ok", "Err"],
    lineComments: C_LIKE,
    blockComments: C_BLOCK,
    quotes: DQUOTES,
    tags: false,
  },
  java: {
    keywords: ["public", "private", "protected", "static", "final", "class", "interface", "extends", "implements", "new", "return", "if", "else", "for", "while", "int", "long", "double", "boolean", "void", "String", "var", "null", "true", "false", "this", "throw", "throws", "try", "catch", "finally", "import", "package"],
    lineComments: C_LIKE,
    blockComments: C_BLOCK,
    quotes: DQUOTES,
    tags: false,
  },
  c: {
    keywords: ["int", "char", "float", "double", "void", "long", "short", "unsigned", "signed", "const", "static", "struct", "enum", "return", "if", "else", "for", "while", "sizeof", "typedef", "break", "continue", "switch", "case", "default", "NULL"],
    lineComments: C_LIKE,
    blockComments: C_BLOCK,
    quotes: DQUOTES,
    tags: false,
  },
  cpp: {
    keywords: ["int", "char", "float", "double", "void", "long", "unsigned", "const", "static", "struct", "class", "return", "if", "else", "for", "while", "sizeof", "break", "continue", "switch", "case", "default", "namespace", "using", "template", "typename", "public", "private", "new", "delete", "virtual", "override", "auto", "nullptr", "true", "false", "for"],
    lineComments: C_LIKE,
    blockComments: C_BLOCK,
    quotes: DQUOTES,
    tags: false,
  },
  csharp: {
    keywords: ["public", "private", "string", "int", "var", "new", "return", "if", "else", "foreach", "for", "while", "using", "namespace", "class", "void", "null", "true", "false", "this", "get", "set", "out", "ref", "in", "as", "is", "double", "bool"],
    lineComments: C_LIKE,
    blockComments: C_BLOCK,
    quotes: ['"', "'"],
    tags: false,
  },
  php: {
    keywords: ["function", "return", "if", "else", "foreach", "for", "while", "as", "echo", "new", "null", "true", "false", "static", "public", "private", "protected", "const", "require", "include", "namespace", "use", "string", "int", "void"],
    lineComments: C_LIKE,
    blockComments: C_BLOCK,
    quotes: DQUOTES,
    tags: false,
  },
  ruby: {
    keywords: ["def", "end", "do", "return", "if", "else", "elsif", "for", "while", "in", "nil", "true", "false", "self", "class", "module", "require", "puts", "yield", "break", "next", "unless", "case", "when", "then"],
    lineComments: ["#"],
    blockComments: [],
    quotes: DQUOTES,
    tags: false,
  },
  html: {
    keywords: [],
    lineComments: [],
    blockComments: [["<!--", "-->"]],
    quotes: DQUOTES,
    tags: true,
  },
};

/** Tokenize a code target into kinded spans (pure, unit-testable). */
export function tokenize(target: string, lang: CodeLang): Token[] {
  const spec = SPECS[lang];
  const keySet = new Set(spec.keywords);
  const toks: Token[] = [];
  const n = target.length;
  let i = 0;
  while (i < n) {
    // line comments (checked before strings would matter only if a
    // comment token could open inside one — strings are consumed whole)
    let matched = false;
    for (const lc of spec.lineComments) {
      if (target.startsWith(lc, i)) {
        let e = i + lc.length;
        while (e < n && target[e] !== "\n") e++;
        toks.push({ start: i, end: e, kind: "comment" });
        i = e;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const [o, c] of spec.blockComments) {
      if (target.startsWith(o, i)) {
        const found = target.indexOf(c, i + o.length);
        const e = found === -1 ? n : found + c.length;
        toks.push({ start: i, end: e, kind: "comment" });
        i = e;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const ch = target[i]!;
    // strings (backslash escapes; unterminated stops at newline)
    if (spec.quotes.includes(ch)) {
      let e = i + 1;
      while (e < n) {
        if (target[e] === "\\") {
          e += 2;
          continue;
        }
        if (target[e] === ch) {
          e++;
          break;
        }
        if (target[e] === "\n") break;
        e++;
      }
      toks.push({ start: i, end: e, kind: "string" });
      i = e;
      continue;
    }
    // html tag names — attributes and values scan normally afterwards
    if (spec.tags && ch === "<" && /[A-Za-z\/!]/.test(target[i + 1] ?? "")) {
      let e = i + 1;
      if (target[e] === "/") e++;
      if (target[e] === "!") {
        while (e < n && target[e] !== ">") e++;
        i = e;
        continue;
      }
      const ns = e;
      while (e < n && /[A-Za-z0-9-]/.test(target[e]!)) e++;
      if (e > ns) toks.push({ start: ns, end: e, kind: "tag" });
      i = e;
      continue;
    }
    // numbers (ints + decimals)
    if (/[0-9]/.test(ch)) {
      let e = i;
      while (e < n && /[0-9_]/.test(target[e]!)) e++;
      if (target[e] === "." && /[0-9]/.test(target[e + 1] ?? "")) {
        e++;
        while (e < n && /[0-9_]/.test(target[e]!)) e++;
      }
      toks.push({ start: i, end: e, kind: "number" });
      i = e;
      continue;
    }
    // identifiers: keyword, call (name followed by `(`), macro call
    // (`name!(`, Rust), or plain
    if (/[A-Za-z_]/.test(ch)) {
      let e = i + 1;
      while (e < n && /[A-Za-z0-9_]/.test(target[e]!)) e++;
      const word = target.slice(i, e);
      if (keySet.has(word)) toks.push({ start: i, end: e, kind: "keyword" });
      else if (target[e] === "(") toks.push({ start: i, end: e, kind: "func" });
      else if (target[e] === "!" && (target[e + 1] === "(" || target[e + 1] === "[")) {
        toks.push({ start: i, end: e, kind: "func" });
      }
      i = e;
      continue;
    }
    i++;
  }
  return toks;
}

/** Per-index token kinds for a target (null = default coloring). */
export function buildKindMap(target: string, lang: CodeLang): (TokenKind | null)[] {
  const map: (TokenKind | null)[] = new Array(target.length).fill(null);
  for (const t of tokenize(target, lang)) {
    for (let i = t.start; i < t.end && i < map.length; i++) map[i] = t.kind;
  }
  return map;
}

/** Terminal color for a token kind (pending chars render dimmed). */
export function kindColor(kind: TokenKind): string {
  switch (kind) {
    case "keyword":
      return ansi.magenta;
    case "string":
      return ansi.green;
    case "comment":
      return ansi.gray;
    case "number":
      return ansi.yellow;
    case "func":
      return ansi.cyan;
    case "tag":
      return ansi.cyan;
  }
}

/** Bracket pairs eligible for match-highlighting and auto-close. */
export const PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
};

const REVERSE_PAIRS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

/**
 * Mate of the bracket at pos (nest-aware, pure). Openers scan forward,
 * closers backward; null when unbalanced or not a bracket.
 */
export function findMate(text: string, pos: number): number | null {
  const ch = text[pos];
  if (ch === '"' || ch === "'" || ch === "`") {
    // Quotes pair with themselves — nesting is ambiguous, so only match
    // an immediately adjacent pair (empty string) to avoid false mates.
    return text[pos + 1] === ch ? pos + 1 : null;
  }
  if (ch == null) return null;
  const mate = PAIRS[ch] ?? REVERSE_PAIRS[ch];
  if (mate == null) return null;
  const fwd = "([{".includes(ch);
  let depth = 0;
  if (fwd) {
    for (let i = pos; i < text.length; i++) {
      if (text[i] === ch) depth++;
      else if (text[i] === mate) {
        depth--;
        if (depth === 0) return i;
      }
    }
  } else {
    for (let i = pos; i >= 0; i--) {
      if (text[i] === ch) depth++;
      else if (text[i] === mate) {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return null;
}

/**
 * Spaces Tab should fill at pos: the target's own space run, max 4.
 * "" means Tab is a no-op there (nothing expected).
 */
export function tabFillFor(target: string, pos: number): string {
  let s = "";
  while (s.length < 4 && target[pos + s.length] === " ") s += " ";
  return s;
}

/**
 * Auto-indent for a newline just typed at pos (target[pos] === "\n"):
 * the next target line's leading spaces, max 24. "" when misplaced.
 */
export function codeIndentFor(target: string, pos: number): string {
  if (target[pos] !== "\n") return "";
  let s = "";
  while (s.length < 24 && target[pos + 1 + s.length] === " ") s += " ";
  return s;
}
