// Bundled code snippets for `--code <lang>` (Task #13). Offline by design:
// 12 languages × 2 snippets. Written with \n line breaks for readability;
// generateCode collapses them to single spaces (same as custom text),
// preserving the training value: brackets, operators, camelCase, symbols.
import { normalizeCustom } from "./generator.js";

export const CODE_LANGS = [
  "python",
  "javascript",
  "typescript",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "php",
  "ruby",
  "html",
] as const;
export type CodeLang = (typeof CODE_LANGS)[number];

/** Common aliases accepted by `--code` (case-insensitive). */
const CODE_ALIASES: Record<string, CodeLang> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  golang: "go",
  rs: "rust",
  "c++": "cpp",
  "c#": "csharp",
};

/** Canonical lang id, or null when unknown. */
export function normalizeCodeLang(input: string): CodeLang | null {
  const v = input.trim().toLowerCase();
  if ((CODE_LANGS as readonly string[]).includes(v)) return v as CodeLang;
  return CODE_ALIASES[v] ?? null;
}

export const CODE_SNIPPETS: Record<CodeLang, string[]> = {
  python: [
    `def calculate_average(scores):
    if not scores:
        return 0.0
    total = sum(scores)
    return round(total / len(scores), 2)`,
    `for i, name in enumerate(users):
    print(f"[{i}] {name}")
    if name.startswith("admin"):
        grant_access(user_id=i, level=2)`,
  ],
  javascript: [
    `async function fetchUser(id) {
  const res = await fetch("/api/users/" + id);
  if (!res.ok) throw new Error("request failed: " + res.status);
  return res.json();
}`,
    `const totals = cart
  .filter((item) => item.qty > 0)
  .map((item) => item.price * item.qty)
  .reduce((a, b) => a + b, 0);`,
  ],
  typescript: [
    `interface User {
  id: number;
  name: string;
  email?: string;
  roles: string[];
}`,
    `function pick<T>(arr: T[], n: number): T[] {
  const out: T[] = [];
  while (out.length < n && arr.length > 0) {
    out.push(arr.splice(Math.floor(Math.random() * arr.length), 1)[0]!);
  }
  return out;
}`,
  ],
  go: [
    `func Max(a, b int) int {
    if a > b {
        return a
    }
    return b
}`,
    `for _, line := range lines {
    fields := strings.Split(line, ",")
    if len(fields) != 3 {
        return fmt.Errorf("bad row: %q", line)
    }
}`,
  ],
  rust: [
    `fn average(nums: &[f64]) -> f64 {
    if nums.is_empty() {
        return 0.0;
    }
    nums.iter().sum::<f64>() / nums.len() as f64
}`,
    `match input.trim() {
    "" => println!("empty"),
    s if s.starts_with('#') => continue,
    s => println!("got: {}", s),
}`,
  ],
  java: [
    `public int add(int a, int b) {
    if (a < 0 || b < 0) {
        throw new IllegalArgumentException("negatives");
    }
    return a + b;
}`,
    `for (String name : names) {
    System.out.println("hello, " + name);
    count += 1;
}`,
  ],
  c: [
    `int max(int a, int b) {
    return (a > b) ? a : b;
}`,
    `for (int i = 0; i < n; i++) {
    sum += arr[i];
    printf("%d\\n", arr[i]);
}`,
  ],
  cpp: [
    `std::sort(v.begin(), v.end(), [](int a, int b) {
    return a > b;
});`,
    `for (const auto& [k, v] : counts) {
    std::cout << k << ": " << v << "\\n";
}`,
  ],
  csharp: [
    `public string Greet(string name) {
    return $"hello, {name}!";
}`,
    `var top = scores.Where(s => s > 50).OrderByDescending(s => s).Take(3).ToList();`,
  ],
  php: [
    `$total = 0;
foreach ($cart as $item) {
    $total += $item["price"] * $item["qty"];
}`,
    `function redirect(string $url, int $code = 302): void {
    http_response_code($code);
    header("Location: " . $url);
}`,
  ],
  ruby: [
    `users.each do |u|
  puts "#{u.name} <#{u.email}>"
end`,
    `def fib(n)
  return n if n < 2
  fib(n - 1) + fib(n - 2)
end`,
  ],
  html: [
    `<form action="/login" method="post">
  <input type="text" name="user" required />
  <button type="submit">sign in</button>
</form>`,
    `<ul class="nav">
  <li><a href="/">home</a></li>
  <li><a href="/about">about</a></li>
</ul>`,
  ],
};

/**
 * Random snippet for a language, whitespace-collapsed and ready to type.
 * Accepts an injectable rng for deterministic tests. Throws on unknown lang.
 */
export function generateCode(lang: string, rng: () => number = Math.random): string {
  const id = normalizeCodeLang(lang);
  if (id == null) throw new Error(`Unknown code language: ${lang} (try ${CODE_LANGS.join(", ")})`);
  const snippets = CODE_SNIPPETS[id];
  const text = snippets[Math.floor(rng() * snippets.length)]!;
  return normalizeCustom(text);
}
