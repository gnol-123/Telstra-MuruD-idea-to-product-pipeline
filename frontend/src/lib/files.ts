// Small, dependency-free helpers for the code preview: what a file is, how
// to label it, and how to hand a blob to the browser as a download.

export const WORKSPACE_ROOT = "/home/user/workspace";

const EXT_LANG: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  css: "css",
  scss: "scss",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  env: "bash",
  sql: "sql",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  kt: "kotlin",
  swift: "swift",
};

const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "bash",
  ".env": "bash",
  "requirements.txt": "plaintext",
};

export function extOf(name: string): string {
  const base = name.toLowerCase();
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1) : "";
}

export function languageFor(name: string): string {
  const lower = name.toLowerCase();
  return NAME_LANG[lower] ?? EXT_LANG[extOf(lower)] ?? "plaintext";
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);

export function isImage(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name));
}

export function isHtml(name: string): boolean {
  const e = extOf(name);
  return e === "html" || e === "htm";
}

// Folders that are huge, regenerated, and almost never what someone is
// looking for. Shown, but dimmed and sorted last.
const NOISE_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", ".next", ".cache", "dist", "build"]);

export function isNoise(name: string): boolean {
  return NOISE_DIRS.has(name);
}

// A glyph per file kind for the tree. Monochrome on purpose — the app's
// icon language is text glyphs, not emoji.
export function fileGlyph(name: string): string {
  const e = extOf(name);
  if (isImage(name)) return "◩";
  if (e === "html" || e === "htm") return "◇";
  if (e === "css" || e === "scss") return "◈";
  if (e === "md" || e === "txt") return "¶";
  if (e === "json" || e === "yml" || e === "yaml" || e === "toml") return "{}";
  if (["js", "jsx", "ts", "tsx", "mjs", "py", "go", "rs", "java", "rb", "sh", "c", "cpp"].includes(e)) return "‹›";
  if (e === "zip" || e === "gz" || e === "tar") return "▤";
  return "▪";
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;
}

// Path relative to the workspace root, for breadcrumbs and labels.
export function relToWorkspace(path: string): string {
  if (path === WORKSPACE_ROOT) return "";
  if (path.startsWith(WORKSPACE_ROOT + "/")) return path.slice(WORKSPACE_ROOT.length + 1);
  return path;
}

// Hand a blob to the browser as a file download.
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a moment to start before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
