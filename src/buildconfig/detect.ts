import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Verdict = "confident" | "unsupported" | "unidentified" | "ambiguous";

export interface ServiceDetection {
  path: string;
  language?: string;
  toolchain?: string;
  commands: Partial<Record<"install" | "build" | "test" | "integrationTest" | "lint", string>>;
  commandsTrusted: boolean;
  verdict: Verdict;
  reason: string;
}

export interface DetectionResult {
  services: ServiceDetection[];
  confident: boolean;
}

export const LANGUAGE_MAP: Record<string, string> = {
  "package.json": "node",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "setup.py": "python",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "java",
  "Gemfile": "ruby",
  "composer.json": "php",
  "CMakeLists.txt": "cpp",
  "Package.swift": "swift",
  "mix.exs": "elixir",
};

const EXTENSION_MAP: Record<string, string> = {
  ".py": "python",
  ".cs": "dotnet",
  ".go": "go",
  ".rs": "rust",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".ts": "node",
  ".js": "node",
  ".mjs": "node",
};

export const TOOLCHAIN_MAP: Record<string, string> = {
  node: "node",
  python: "python",
  dotnet: "dotnet",
};

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "bin", "obj",
  "vendor", ".venv", "venv", "__pycache__", "coverage", ".next", "out",
]);

function resolveManifestLanguage(filename: string): string | undefined {
  if (LANGUAGE_MAP[filename]) return LANGUAGE_MAP[filename];
  if (filename.endsWith(".csproj") || filename.endsWith(".sln")) return "dotnet";
  return undefined;
}

function parsePackageJsonCommands(content: string): { commands: Partial<Record<string, string>>; trusted: boolean } {
  if (content.length === 0) return { commands: {}, trusted: false };
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return { commands: {}, trusted: false }; }
  if (typeof parsed !== "object" || parsed === null) return { commands: {}, trusted: false };
  const commands: Partial<Record<string, string>> = {};
  const scripts = (parsed as Record<string, unknown>).scripts;
  if (typeof scripts === "object" && scripts !== null) {
    const s = scripts as Record<string, unknown>;
    if (typeof s.test === "string") commands.test = s.test;
  }
  return { commands, trusted: true };
}

function parseManifestCommands(
  language: string,
  manifestPath: string,
): { commands: Partial<Record<string, string>>; trusted: boolean } {
  if (language !== "node") {
    // For non-node supported toolchains, we can parse but Phase 2 only extracts from package.json
    // Try to read; if parseable treat as trusted with empty commands
    let content: string;
    try { content = readFileSync(manifestPath, "utf8"); } catch { return { commands: {}, trusted: false }; }
    if (content.length === 0) return { commands: {}, trusted: false };
    return { commands: {}, trusted: true };
  }
  let content: string;
  try { content = readFileSync(manifestPath, "utf8"); } catch { return { commands: {}, trusted: false }; }
  return parsePackageJsonCommands(content);
}

interface DirAnalysis {
  manifestsByLanguage: Map<string, string>; // language -> first manifest path
}

function analyzeDir(dirPath: string, entries: string[]): DirAnalysis {
  const manifestsByLanguage = new Map<string, string>();
  for (const entry of entries) {
    const lang = resolveManifestLanguage(entry);
    if (lang && !manifestsByLanguage.has(lang)) {
      manifestsByLanguage.set(lang, join(dirPath, entry));
    }
  }
  return { manifestsByLanguage };
}

function toServicePath(rootDir: string, absDir: string): string {
  if (absDir === rootDir) return ".";
  const rel = relative(rootDir, absDir);
  return "./" + rel;
}

function walkTree(
  rootDir: string,
  currentDir: string,
  serviceMap: Map<string, DirAnalysis>,
  extCounts: Map<string, number>,
): void {
  let entries: string[];
  try { entries = readdirSync(currentDir); } catch { return; }

  // Separate directories from files
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;
    const fullPath = join(currentDir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) subdirs.push(entry);
    else files.push(entry);
  }

  // Count extensions for histogram (only at leaf level)
  for (const file of files) {
    const dot = file.lastIndexOf(".");
    if (dot !== -1) {
      const ext = file.slice(dot);
      if (EXTENSION_MAP[ext]) {
        extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
      }
    }
  }

  // Analyze manifests in this dir
  const analysis = analyzeDir(currentDir, files);
  if (analysis.manifestsByLanguage.size > 0) {
    serviceMap.set(currentDir, analysis);
  }

  for (const sub of subdirs) {
    walkTree(rootDir, join(currentDir, sub), serviceMap, extCounts);
  }
}

function buildServiceFromAnalysis(
  servicePath: string,
  analysis: DirAnalysis,
): ServiceDetection {
  const langs = [...analysis.manifestsByLanguage.keys()];

  if (langs.length > 1) {
    return {
      path: servicePath,
      commands: {},
      commandsTrusted: false,
      verdict: "ambiguous",
      reason: `conflicting manifests for languages: ${langs.join(", ")}`,
    };
  }

  const language = langs[0];
  const manifestPath = analysis.manifestsByLanguage.get(language)!;
  const toolchain = TOOLCHAIN_MAP[language];

  if (!toolchain) {
    return {
      path: servicePath,
      language,
      commands: {},
      commandsTrusted: false,
      verdict: "unsupported",
      reason: `language ${language} has no supported toolchain`,
    };
  }

  const { commands, trusted } = parseManifestCommands(language, manifestPath);
  return {
    path: servicePath,
    language,
    toolchain,
    commands,
    commandsTrusted: trusted,
    verdict: "confident",
    reason: `manifest ${manifestPath.split("/").pop()} detected ${language}`,
  };
}

export function detectToolchains(dir: string): DetectionResult {
  const serviceMap = new Map<string, DirAnalysis>();
  const extCounts = new Map<string, number>();

  walkTree(dir, dir, serviceMap, extCounts);

  if (serviceMap.size > 0) {
    const services: ServiceDetection[] = [];
    for (const [absDir, analysis] of serviceMap) {
      const servicePath = toServicePath(dir, absDir);
      services.push(buildServiceFromAnalysis(servicePath, analysis));
    }
    const confident = services.every(s => s.verdict === "confident" && s.commandsTrusted);
    return { services, confident };
  }

  // No manifests found — fall back to extension histogram
  if (extCounts.size === 0) {
    return {
      services: [{ path: ".", commands: {}, commandsTrusted: false, verdict: "unidentified", reason: "no language signal found" }],
      confident: false,
    };
  }

  // Find dominant language by extension
  const langCounts = new Map<string, number>();
  for (const [ext, count] of extCounts) {
    const lang = EXTENSION_MAP[ext]!;
    langCounts.set(lang, (langCounts.get(lang) ?? 0) + count);
  }

  const sorted = [...langCounts.entries()].sort((a, b) => b[1] - a[1]);
  const [topLang, topCount] = sorted[0];
  const runnerUp = sorted[1]?.[1] ?? 0;

  if (topCount >= 2 * (runnerUp || 1) || runnerUp === 0) {
    const toolchain = TOOLCHAIN_MAP[topLang];
    return {
      services: [{
        path: ".",
        language: topLang,
        toolchain,
        commands: {},
        commandsTrusted: false,
        verdict: "confident",
        reason: `extension histogram dominant: ${topLang}`,
      }],
      confident: false,
    };
  }

  return {
    services: [{ path: ".", commands: {}, commandsTrusted: false, verdict: "unidentified", reason: "no dominant language in extension histogram" }],
    confident: false,
  };
}
