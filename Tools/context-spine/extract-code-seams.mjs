// extract-code-seams.mjs — Deterministic AST/regex extractor for JS, TS, WGSL, GLSL, and Cesium seams.
// @purpose Deterministic extractor for JS, TS, WGSL, and GLSL symbols, FeatureRendererKey bridges, 3-word ShaderDefine/ifdef consumers, and coordinate/precision contracts.
// @status ACTIVE

import fs from "node:fs";
import path from "node:path";
import { sha256Hex, toPosixRel } from "./schema.mjs";
import { auditGisAndAssetContracts } from "./spatial-v2.mjs";
import {
  analyzeWgslUniformStructs,
  extractUniformAndCrsContracts,
} from "./uniform-crs-validator.mjs";

const CODE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".wgsl", ".glsl"]);

const SKIP_DIRS = new Set([
  ".git",
  ".cache",
  ".claude",
  ".codex-tmp",
  "node_modules",
  "Build",
  "ThirdParty",
  "GltfPipeline",
  "output",
  "archive",
  "patch-prototype",
  "naga-wasm-tools",
  "_review",
  "_lane-out",
  "graphify-out",
]);

/**
 * Ubiquitous Cesium low-level utilities flagged so architectural hub rankings
 * surface genuine subsystem bottlenecks rather than `defined()` or `Check`.
 */
export const CESIUM_UTILITY_NAMES = new Set([
  "defined",
  "Check",
  "DeveloperError",
  "RuntimeError",
  "Frozen",
  "defaultValue",
  "destroyObject",
  "isDestroyed",
  "CesiumMath",
  "Cartesian2",
  "Cartesian3",
  "Cartesian4",
  "Cartographic",
  "Matrix2",
  "Matrix3",
  "Matrix4",
  "Quaternion",
  "BoundingSphere",
  "Rectangle",
  "Color",
  "Event",
  "combine",
  "clone",
]);

/**
 * Walk code/shader directories deterministically.
 *
 * @param {string} repoRoot
 * @param {string[]} scanRoots
 * @returns {string[]} Repo-relative POSIX paths
 */
export function collectCodeFiles(repoRoot, scanRoots) {
  const results = [];
  function walk(absDir) {
    if (!fs.existsSync(absDir)) return;
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;
        const rel = toPosixRel(repoRoot, full);
        // Skip generated shader JS wrappers when unbuilt or built; raw .wgsl/.glsl are authoritative.
        if (
          rel.startsWith("packages/engine/Source/Shaders/") &&
          ext === ".js"
        ) {
          continue;
        }
        results.push(rel);
      }
    }
  }
  for (const r of scanRoots) {
    walk(path.resolve(repoRoot, r));
  }
  return results;
}

/**
 * Classify a repo-relative path into a logical domain.
 *
 * @param {string} relPath
 * @returns {string}
 */
function classifyDomain(relPath) {
  if (relPath.includes("/Shaders/WebGPU/")) return "shader-wgsl";
  if (relPath.includes("/Shaders/")) return "shader-glsl";
  if (relPath.includes("/Renderer/WebGPU/")) return "renderer-webgpu";
  if (relPath.includes("/Renderer/")) return "renderer-shared";
  if (relPath.includes("/Scene/")) return "scene";
  if (relPath.includes("/Core/")) return "core";
  if (relPath.includes("/DataSources/")) return "datasources";
  if (
    relPath.includes("/Widgets/") ||
    relPath.startsWith("packages/widgets/")
  ) {
    return "widgets";
  }
  if (relPath.startsWith("Tools/visual-regression/")) return "probe-kit";
  if (relPath.startsWith("Tools/")) return "tools";
  return "other";
}

/**
 * Find the closing brace line for a block starting near `startIdx` (0-based).
 * Caps scan window to keep worst-case runtime linear on 9,000-line files.
 *
 * @param {string[]} lines
 * @param {number} startIdx
 * @param {number} [maxLines]
 * @returns {number} 1-based inclusive end line
 */
function findBlockEndLine(lines, startIdx, maxLines = 600) {
  let depth = 0;
  let opened = false;
  const limit = Math.min(lines.length, startIdx + maxLines);
  for (let i = startIdx; i < limit; i += 1) {
    const line = lines[i];
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (ch === "/" && line[c + 1] === "/") break;
      if (ch === "{") {
        depth += 1;
        opened = true;
      } else if (ch === "}") {
        depth -= 1;
        if (opened && depth <= 0) {
          return i + 1;
        }
      }
    }
    if (!opened && line.includes(";") && i > startIdx) {
      return i + 1;
    }
  }
  return Math.min(lines.length, startIdx + 25);
}

/**
 * Resolve a relative JS/TS import specifier to a repo-relative file if present.
 *
 * @param {string} fromRelPath
 * @param {string} specifier
 * @param {Set<string>} knownFiles
 * @returns {string | null}
 */
function resolveImportTarget(fromRelPath, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return null;
  const baseDir = path.posix.dirname(fromRelPath);
  const joined = path.posix.normalize(path.posix.join(baseDir, specifier));
  if (knownFiles.has(joined)) return joined;
  const stem = joined.replace(/\.(js|ts|mjs)$/, "");
  for (const ext of [".ts", ".js", ".mjs", ".wgsl", ".glsl"]) {
    if (knownFiles.has(`${stem}${ext}`)) return `${stem}${ext}`;
  }
  // Generated shader wrapper import `../../Shaders/WebGPU/Foo.js` -> `.wgsl` or `.glsl`
  if (stem.includes("/Shaders/")) {
    if (knownFiles.has(`${stem}.wgsl`)) return `${stem}.wgsl`;
    if (knownFiles.has(`${stem}.glsl`)) return `${stem}.glsl`;
  }
  return null;
}

/**
 * Strip `/* ... *\/` and `// ...` comments while preserving exact `\n` line breaks
 * so multi-line regex offsets map 1:1 back to 1-based source line numbers.
 *
 * @param {string} text
 * @returns {string}
 */
function stripCommentsPreservingNewlines(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function lineNumberAtOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function hasPrecedingExperimentalTag(lines, lineIdx) {
  for (let k = lineIdx - 1; k >= Math.max(0, lineIdx - 30); k -= 1) {
    const t = lines[k].trim();
    if (t.length === 0) continue;
    if (
      t.startsWith("//") ||
      t.startsWith("*") ||
      t.startsWith("/*") ||
      t.endsWith("*/")
    ) {
      if (/@experimental\b/.test(t)) return true;
      continue;
    }
    break;
  }
  return false;
}

/**
 * Line count as `wc -l` reports it for a file ending in a newline: a trailing
 * newline does not start another line.
 *
 * @param {string[]} lines the file split on line breaks
 * @returns {number}
 */
function countLines(lines) {
  return lines.length > 0 && lines[lines.length - 1] === ""
    ? lines.length - 1
    : lines.length;
}

/**
 * Classify a direct `High + Low` or `Low + High` addition on split RTE world/camera stems
 * (`posHigh + posLow`, `camera.encodedCameraHigh + camera.encodedCameraLow`, `camHigh.x + camLow.x`)
 * in SHADER source (`.wgsl`, `.glsl`, WGSL template strings in `.ts`). Callers never pass plain
 * JS/TS lines: that arithmetic is f64 and cannot lose f32 precision.
 *
 * The sum is the AGENTS.md §1 target only when it is the argument of a projection on the same
 * line (`mvp` / `modelViewProjection` / `viewProjection` `* vec4(...)`), i.e. a vertex position
 * reaches clip space without the camera subtracted first. Every other sum reconstructs an absolute
 * position in f32 - the camera's own `encodedCameraHigh + encodedCameraLow` is the common case - and
 * is only a review lead: about 0.5 m at Earth radius, fine for a direction or a LUT altitude.
 *
 * @param {string} rawLine
 * @returns {{ expr: string, projectedBy: string | null } | null}
 */
function matchDirectHighPlusLow(rawLine) {
  const clean = rawLine.replace(/\/\/.*$/, "");
  if (clean.trim().startsWith("*")) return null;
  const re =
    /(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*\b((?:pos|position|cam|camera|anchor|center|eye|origin|world|rtc|vertex|encoded[A-Za-z0-9_]*)[A-Za-z0-9_]*)(High|Low)(?:\.[xyzwrgba]{1,4}|\[\d+\])?\s*\+\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*\b\1(High|Low)\b/g;
  const sums = [];
  for (const m of clean.matchAll(re)) {
    if (m[2] !== m[3]) {
      sums.push({ start: m.index, end: m.index + m[0].length, expr: m[0] });
    }
  }
  if (sums.length === 0) return null;
  const projections = findProjectionArguments(clean);
  for (const s of sums) {
    const proj = projections.find(
      (p) => s.start >= p.argStart && s.end <= p.argEnd,
    );
    if (proj) return { expr: s.expr.trim(), projectedBy: proj.matrix };
  }
  return { expr: sums[0].expr.trim(), projectedBy: null };
}

/**
 * Argument spans of `<...mvp|modelViewProjection|viewProjection...> * vec4(...)` on one line
 * (WGSL `vec4<f32>(` / `vec4f(` and GLSL `vec4(`). An unclosed argument runs to the end of the line.
 *
 * @param {string} line comment-stripped source line
 * @returns {{ matrix: string, argStart: number, argEnd: number }[]}
 */
function findProjectionArguments(line) {
  const re =
    /([A-Za-z0-9_$.]*(?:mvp|modelViewProjection|viewProjection)[A-Za-z0-9_]*)(?:\[[^\]]*\])?\s*\*\s*vec4(?:\s*<\s*f32\s*>|f)?\s*\(/gi;
  const spans = [];
  for (const m of line.matchAll(re)) {
    const argStart = m.index + m[0].length;
    let depth = 1;
    let k = argStart;
    for (; k < line.length && depth > 0; k += 1) {
      if (line[k] === "(") depth += 1;
      else if (line[k] === ")") depth -= 1;
    }
    spans.push({
      matrix: m[1],
      argStart,
      argEnd: depth === 0 ? k - 1 : line.length,
    });
  }
  return spans;
}

/**
 * 0-based indexes of the lines that carry template-literal text (the string part of a backtick
 * literal, not its `${...}` expressions). WGSL embedded in `.ts` lives there; the rest of a `.ts`
 * file is f64 JavaScript arithmetic.
 *
 * @param {string} text
 * @returns {Set<number>}
 */
function templateLiteralLines(text) {
  const marked = new Set();
  const exprDepths = [];
  let mode = "code";
  let line = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const nx = text[i + 1];
    if (ch === "\n") {
      line += 1;
      // A quote string cannot span lines, so a quote met inside a regex literal resyncs here.
      if (mode === "line" || mode === "sq" || mode === "dq") mode = "code";
      if (mode === "tpl") marked.add(line);
      continue;
    }
    if (mode === "line") continue;
    if (mode === "block") {
      if (ch === "*" && nx === "/") {
        mode = "code";
        i += 1;
      }
      continue;
    }
    if (mode === "sq" || mode === "dq") {
      if (ch === "\\" && nx !== "\n") i += 1;
      else if (ch === (mode === "sq" ? "'" : '"')) mode = "code";
      continue;
    }
    if (mode === "tpl") {
      marked.add(line);
      if (ch === "\\" && nx !== "\n") i += 1;
      else if (ch === "`") mode = "code";
      else if (ch === "$" && nx === "{") {
        exprDepths.push(0);
        mode = "code";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && nx === "/") {
      mode = "line";
      i += 1;
    } else if (ch === "/" && nx === "*") {
      mode = "block";
      i += 1;
    } else if (ch === "'") mode = "sq";
    else if (ch === '"') mode = "dq";
    else if (ch === "`") mode = "tpl";
    else if (exprDepths.length > 0) {
      const top = exprDepths.length - 1;
      if (ch === "{") exprDepths[top] += 1;
      else if (ch === "}") {
        if (exprDepths[top] === 0) {
          exprDepths.pop();
          mode = "tpl";
        } else exprDepths[top] -= 1;
      }
    }
  }
  return marked;
}

/**
 * The `precision_rte` contract row for a classified High+Low sum: `hazard` when it is projected,
 * `review` otherwise. The output is a scoping lead, never a gate.
 *
 * @param {string} relPath
 * @param {number} lineNum 1-based
 * @param {{ expr: string, projectedBy: string | null }} match
 */
function highPlusLowContract(relPath, lineNum, match) {
  return match.projectedBy
    ? {
        filePath: relPath,
        line: lineNum,
        category: "precision_rte",
        contractType: "DIRECT_HIGH_PLUS_LOW_HAZARD",
        severity: "hazard",
        detail: `Projects '${match.expr}' through '${match.projectedBy}' after summing High+Low in f32, before the camera is subtracted (AGENTS.md §1: use the RelativeToEye matrix with translateRelativeToEye)`,
      }
    : {
        filePath: relPath,
        line: lineNum,
        category: "precision_rte",
        contractType: "DIRECT_HIGH_PLUS_LOW_HAZARD",
        severity: "review",
        detail: `'${match.expr}' reconstructs an absolute position in f32 (~0.5 m at Earth radius): fine for a direction or a LUT altitude, not for projection`,
      };
}

/**
 * Parse JS/TS/MJS symbols, imports (single-line, Prettier multi-line, re-exports, dynamic `import()`),
 * inheritance, and WebGPU coordinate/lifecycle contracts.
 */
function parseJsTsFile(relPath, lines, knownFiles, out) {
  const fileNodeId = `file:${relPath}`;
  const rawText = lines.join("\n");
  const blanked = stripCommentsPreservingNewlines(rawText);
  const seenImportKeys = new Set();
  const wgslTemplateLines = relPath.endsWith(".ts")
    ? templateLiteralLines(rawText)
    : null;

  // 1. Multi-line & single-line static `import ... from "..."` and `export ... from "..."`
  // The clause is restricted to the characters an import/export-from clause can
  // hold (identifiers, braces, commas, `*`, whitespace). The earlier `[\s\S]*?`
  // let every `export function` / `export const` scan lazily to the next
  // `from "..."` in the file: quadratic (68 s of a 94 s full build, measured
  // 2026-10-29), and wrong, because such a match swallowed the real re-export
  // that followed and recorded it at the earlier export's line.
  const staticImportRe =
    /(?:^|\n)[ \t]*(import|export)\s+(?:type\s+)?([\w$\s{},*]*?)\s+from\s+["']([^"'\n]+)["']/g;
  for (const m of blanked.matchAll(staticImportRe)) {
    const kw = m[1];
    const clause = m[2].replace(/\s+/g, " ").trim();
    const specifier = m[3];
    const target = resolveImportTarget(relPath, specifier, knownFiles);
    if (!target) continue;
    const kwOffset = (m.index ?? 0) + m[0].indexOf(kw);
    const lineNum = lineNumberAtOffset(blanked, kwOffset);
    const dedupKey = `${target}@${lineNum}`;
    if (!seenImportKeys.has(dedupKey)) {
      seenImportKeys.add(dedupKey);
      out.edges.push({
        src: fileNodeId,
        dst: `file:${target}`,
        relation: "imports",
        provenance: "ast-scan",
        detail: (kw === "export" ? `re-export ${clause}` : clause).slice(
          0,
          120,
        ),
        filePath: relPath,
        line: lineNum,
      });
    }
  }

  // 2. Dynamic `import("...")` expressions
  const dynImportRe = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
  for (const m of blanked.matchAll(dynImportRe)) {
    const target = resolveImportTarget(relPath, m[1], knownFiles);
    if (!target) continue;
    const lineNum = lineNumberAtOffset(blanked, m.index ?? 0);
    const dedupKey = `${target}@${lineNum}`;
    if (!seenImportKeys.has(dedupKey)) {
      seenImportKeys.add(dedupKey);
      out.edges.push({
        src: fileNodeId,
        dst: `file:${target}`,
        relation: "imports",
        provenance: "ast-scan",
        detail: "dynamic import()",
        filePath: relPath,
        line: lineNum,
      });
    }
  }

  // 3. Collect deferred `export default <Ident>` and `export { a, b as c }` (without `from`)
  const defaultExportedNames = new Set();
  const namedExportedNames = new Set();
  for (const m of blanked.matchAll(
    /\bexport\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g,
  )) {
    if (!["class", "function", "async"].includes(m[1])) {
      defaultExportedNames.add(m[1]);
    }
  }
  for (const m of blanked.matchAll(/\bexport\s*\{([^}]+)\}(?!\s*from\b)/g)) {
    for (const part of m[1].split(",")) {
      const clean = part.replace(/\btype\s+/, "").trim();
      if (!clean) continue;
      const localName = clean.split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(localName)) {
        namedExportedNames.add(localName);
      }
    }
  }

  function decorateSignature(baseSig, symName, lineIdx) {
    let sig = baseSig;
    if (!sig.startsWith("export ")) {
      if (defaultExportedNames.has(symName)) {
        sig = `export default ${sig}`;
      } else if (namedExportedNames.has(symName)) {
        sig = `export ${sig}`;
      }
    }
    if (hasPrecedingExperimentalTag(lines, lineIdx)) {
      sig = `${sig} [@experimental]`;
    }
    return sig.slice(0, 180);
  }

  const CONTROL_KEYWORDS = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "typeof",
    "delete",
    "await",
    "import",
  ]);
  let activeMethodName = null;
  let activeMethodEndLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    if (i + 1 > activeMethodEndLine) {
      activeMethodName = null;
    }
    const line = lines[i];
    const trimmed = line.trim();
    if (
      trimmed.length === 0 ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }

    if (/^\s*import\s+/.test(line) && /\bfrom\s+["']/.test(line)) {
      continue;
    }

    // Class / Interface / Type / Enum declarations
    const classMatch = line.match(
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+extends\s+([A-Za-z0-9_$.]+))?(?:\s+implements\s+([A-Za-z0-9_$,\s]+))?/,
    );
    if (classMatch) {
      const kind = classMatch[1];
      const name = classMatch[2];
      const endLine = findBlockEndLine(lines, i, 2500);
      const symId = `${relPath}::${name}`;
      out.symbols.push({
        id: symId,
        name,
        kind,
        filePath: relPath,
        startLine: i + 1,
        endLine,
        signature: decorateSignature(trimmed.replace(/\s*\{$/, ""), name, i),
        isUtility: CESIUM_UTILITY_NAMES.has(name) ? 1 : 0,
      });
      if (classMatch[3]) {
        out.edges.push({
          src: symId,
          dst: `symbol:${classMatch[3].trim()}`,
          relation: "extends",
          provenance: "ast-scan",
          detail: null,
          filePath: relPath,
          line: i + 1,
        });
      }
      if (classMatch[4]) {
        for (const iface of classMatch[4].split(",")) {
          const clean = iface.trim();
          if (clean) {
            out.edges.push({
              src: symId,
              dst: `symbol:${clean}`,
              relation: "implements",
              provenance: "ast-scan",
              detail: null,
              filePath: relPath,
              line: i + 1,
            });
          }
        }
      }
      continue;
    }

    // Top-level or exported functions & constants
    const fnMatch = line.match(
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)/,
    );
    if (fnMatch) {
      const name = fnMatch[1];
      const endLine = findBlockEndLine(lines, i, 600);
      if (name === "destroy") {
        activeMethodName = "destroy";
        activeMethodEndLine = endLine;
      }
      out.symbols.push({
        id: `${relPath}::${name}`,
        name,
        kind: "function",
        filePath: relPath,
        startLine: i + 1,
        endLine,
        signature: decorateSignature(trimmed.replace(/\s*\{$/, ""), name, i),
        isUtility: CESIUM_UTILITY_NAMES.has(name) ? 1 : 0,
      });
      continue;
    }

    const constMatch = line.match(
      /^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
    );
    if (
      constMatch &&
      (trimmed.startsWith("export ") ||
        defaultExportedNames.has(constMatch[1]) ||
        namedExportedNames.has(constMatch[1]))
    ) {
      const name = constMatch[1];
      const endLine = findBlockEndLine(lines, i, 400);
      out.symbols.push({
        id: `${relPath}::${name}`,
        name,
        kind: "const",
        filePath: relPath,
        startLine: i + 1,
        endLine,
        signature: decorateSignature(trimmed, name, i),
        isUtility: CESIUM_UTILITY_NAMES.has(name) ? 1 : 0,
      });
      continue;
    }

    // Class methods (2-space indented inside classes in Cesium/TS style)
    const methodMatch = line.match(
      /^ {2}(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{/,
    );
    if (methodMatch && !CONTROL_KEYWORDS.has(methodMatch[1])) {
      const name = methodMatch[1];
      const endLine = findBlockEndLine(lines, i, 400);
      activeMethodName = name;
      activeMethodEndLine = endLine;
      out.symbols.push({
        id: `${relPath}::#${name}@L${i + 1}`,
        name,
        kind: "method",
        filePath: relPath,
        startLine: i + 1,
        endLine,
        signature: trimmed.replace(/\s*\{$/, "").slice(0, 160),
        isUtility: 0,
      });
    }

    if (
      relPath.includes("/Renderer/WebGPU/") ||
      relPath.includes("/Scene/") ||
      relPath.includes("/Core/")
    ) {
      // Only WGSL template text in `.ts` is shader source; plain JS/TS sums are f64.
      const rteMatch = wgslTemplateLines?.has(i)
        ? matchDirectHighPlusLow(line)
        : null;
      if (rteMatch) {
        out.contracts.push(highPlusLowContract(relPath, i + 1, rteMatch));
      }
      if (
        /\bMath\.asin\s*\(\s*(?:CesiumMath\.clamp\s*\(\s*)?[A-Za-z0-9_$.]+\.z\s*(?:\/|,|\))/.test(
          line,
        ) &&
        /lat|Latitude|normal|posWC|positionWC/i.test(line)
      ) {
        out.contracts.push({
          filePath: relPath,
          line: i + 1,
          category: "precision_rte",
          contractType: "GEOCENTRIC_ASIN_LATITUDE_HAZARD",
          severity: "review",
          detail:
            "Computes latitude via geocentric asin(z / r) rather than WGS84 geodetic normal (~0.19 deg mid-latitude shift)",
        });
      }
    }

    // Coordinate, Shader-Cache & Lifecycle Contracts inside WebGPU Renderer TS/JS files
    if (relPath.includes("/Renderer/WebGPU/")) {
      if (line.includes("_logDepthEncodeNearFar")) {
        out.contracts.push({
          filePath: relPath,
          line: i + 1,
          category: "depth_encoding",
          contractType: "LOG_DEPTH_GLOBAL_NEAR_FAR",
          severity: "positive",
          detail:
            "Encodes log depth against global uniformState._logDepthEncodeNearFar",
        });
      }
      if (
        line.includes("currentFrustum") &&
        /[Ll]ogDepth|far|near/.test(line)
      ) {
        out.contracts.push({
          filePath: relPath,
          line: i + 1,
          category: "depth_encoding",
          contractType: "LOG_DEPTH_SLICE_FRUSTUM",
          severity: "review",
          detail:
            "References per-slice currentFrustum near/far near depth logic; verify parity with global _logDepthEncodeNearFar",
        });
      }
      if (
        line.includes("encodedCameraPositionMCHigh") ||
        line.includes("encodedCameraHigh")
      ) {
        out.contracts.push({
          filePath: relPath,
          line: i + 1,
          category: "precision_rte",
          contractType: "RTE_CAMERA_SPLIT_PACK",
          severity: "positive",
          detail: "Packs split f32x2 Relative-To-Eye camera high/low uniform",
        });
      }
      if (
        /\.createShaderModule\s*\(/.test(line) &&
        !relPath.endsWith("WebGPUShaderModuleCache.ts")
      ) {
        out.contracts.push({
          filePath: relPath,
          line: i + 1,
          category: "shader_cache",
          contractType: "SHADER_SOURCE_ID_BYPASS",
          severity: "review",
          detail:
            "Calls device.createShaderModule() directly outside WebGPUShaderModuleCache (bypasses ShaderSourceId & 3-word preprocessor cache)",
        });
      }
      if (
        /\bnew\s+WebGPUShaderModuleCache\s*\(/.test(line) &&
        !relPath.endsWith("WebGPUContext.ts")
      ) {
        out.contracts.push({
          filePath: relPath,
          line: i + 1,
          category: "shader_cache",
          contractType: "SHADER_PRIVATE_CACHE_INSTANCE",
          severity: "review",
          detail:
            "Instantiates a private WebGPUShaderModuleCache outside WebGPUContext",
        });
      }
      if (
        /(?<!scheduleTexture)\b[A-Za-z0-9_$.]*Texture[A-Za-z0-9_$]*\.destroy\s*\(/.test(
          line,
        ) &&
        activeMethodName !== "destroy" &&
        !relPath.endsWith("WebGPUTexturePool.ts") &&
        !relPath.endsWith("WebGPUTexture.ts") &&
        !relPath.endsWith("WebGPUContext.ts")
      ) {
        out.contracts.push({
          filePath: relPath,
          line: i + 1,
          category: "gpu_lifecycle",
          contractType: "GPU_TEXTURE_INLINE_DESTROY",
          severity: "review",
          detail: `Calls GPUTexture.destroy() inside '${activeMethodName ?? "module-scope"}' instead of context.scheduleTextureDestroy() (mid-encoder hazard if still bound)`,
        });
      }
      if (
        /(?:definesHi\s*(?:\||&|\|=)\s*ShaderDefine(?:Ext)?\.|defines\s*(?:\||&|\|=)\s*ShaderDefine(?:Hi|Ext)\.|definesExt\s*(?:\||&|\|=)\s*ShaderDefine(?:Hi)?\.)/.test(
          line,
        )
      ) {
        out.contracts.push({
          filePath: relPath,
          line: i + 1,
          category: "shader_cache",
          contractType: "CROSS_WORD_DEFINE_BIT_ALIAS",
          severity: "hazard",
          detail:
            "Mixes define bitmasks from different 32-bit words (ShaderDefine vs ShaderDefineHi vs ShaderDefineExt)",
        });
      }
    }
  }
}

/**
 * Validate `CameraUniforms.previousViewProjection` placement against verified WebGPU packer families.
 *
 * @param {string} relPath
 * @param {string} structName
 * @param {Array<{ name: string, line: number, floatOffset?: number }>} fields
 * @param {{ contracts: object[] }} out
 * @param {number} structLine
 */
function auditCameraUniformsPackerTail(
  relPath,
  structName,
  fields,
  out,
  structLine,
) {
  const pvpIdx = fields.findIndex((f) => f.name === "previousViewProjection");
  if (pvpIdx === -1) {
    out.contracts.push({
      filePath: relPath,
      line: structLine,
      category: "camera_uniform_tail",
      contractType: "CAMERA_PREVIOUS_VP_MISSING",
      severity: "review",
      detail: `${structName} has no previousViewProjection field`,
    });
    return;
  }

  const pvpField = fields[pvpIdx];
  const floatOffset = pvpField.floatOffset ?? null;
  const trailingNames = fields.slice(pvpIdx + 1).map((f) => f.name);

  let validPackerFamily = false;
  let familyLabel = "struct tail";

  if (trailingNames.length === 0) {
    validPackerFamily = true;
    familyLabel = `struct tail (floatOffset=${floatOffset ?? "?"})`;
  } else if (relPath.endsWith("/Globe/GlobeTerrain.wgsl")) {
    validPackerFamily = floatOffset === 100;
    familyLabel = `GlobeTerrain grandfathered floatOffset=${floatOffset ?? "?"} (expected 100)`;
  } else if (relPath.includes("/Shaders/WebGPU/Model/")) {
    validPackerFamily =
      floatOffset === 84 && trailingNames.every((n) => n === "hdrControl");
    familyLabel = `Model packer family floatOffset=${floatOffset ?? "?"} + [hdrControl]`;
  } else if (
    /PrimitiveMatElev(?:Band|Contour|Ramp)(?:Flat|Lit)\.wgsl$/.test(relPath)
  ) {
    const allowedElev = new Set([
      "inverseViewQuaternion",
      "logDepth",
      "ellipsoidOneOverRadii",
      "modelMatrixColumn0",
      "modelMatrixColumn1",
      "modelMatrixColumn2",
      "encodedCameraWorldHigh",
      "encodedCameraWorldLow",
      "pixelRatio",
    ]);
    validPackerFamily =
      (floatOffset === 24 || floatOffset === 60) &&
      trailingNames.every((n) => allowedElev.has(n));
    familyLabel = `PrimitiveElev packer family floatOffset=${floatOffset ?? "?"}`;
  } else if (relPath.includes("/Shaders/WebGPU/Collections/PointPrimitive")) {
    validPackerFamily =
      floatOffset === 52 && trailingNames.every((n) => n === "logDepth");
    familyLabel = `PointPrimitive packer family floatOffset=${floatOffset ?? "?"} + [${trailingNames.join(", ")}]`;
  } else if (relPath.includes("/Shaders/WebGPU/Primitive/")) {
    validPackerFamily =
      (floatOffset === 24 || floatOffset === 56 || floatOffset === 60) &&
      trailingNames.every(
        (n) => n === "inverseViewQuaternion" || n === "logDepth",
      );
    familyLabel = `Primitive packer family floatOffset=${floatOffset ?? "?"} + [${trailingNames.join(", ")}]`;
  }

  out.contracts.push({
    filePath: relPath,
    line: pvpField.line,
    category: "camera_uniform_tail",
    contractType: validPackerFamily
      ? "CAMERA_PREVIOUS_VP_TAIL"
      : "CAMERA_PREVIOUS_VP_MID_STRUCT",
    severity: validPackerFamily ? "positive" : "hazard",
    detail: validPackerFamily
      ? `${structName}.previousViewProjection verified (${familyLabel}, field ${pvpIdx + 1}/${fields.length})`
      : `${structName}.previousViewProjection at unauthorized offset/position (floatOffset=${floatOffset ?? "?"}, field ${pvpIdx + 1}/${fields.length}, trailing=[${trailingNames.join(", ")}])`,
  });
}

/**
 * Parse WGSL shader structs, functions, bindings, //>>ifdef blocks, and RTE/depth/tail/stage contracts.
 */
function parseWgslFile(relPath, lines, out) {
  const ifdefStack = [];
  const { structs: uniformStructs } = analyzeWgslUniformStructs(relPath, lines);
  let sampledTextureCount = 0;
  let storageBufferCount = 0;
  let firstBindingLine = 1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // Preprocessor //>>ifdef / //>>ifndef / //>>endif tracking
    const ifdefMatch = trimmed.match(/^\/\/>>\s*ifn?def\s+([A-Z0-9_]+)/);
    if (ifdefMatch) {
      ifdefStack.push({ flag: ifdefMatch[1], startLine: i + 1 });
      out.edges.push({
        src: `file:${relPath}`,
        dst: `define:${ifdefMatch[1]}`,
        relation: "ifdef_guards",
        provenance: "wgsl-preprocessor",
        detail: trimmed,
        filePath: relPath,
        line: i + 1,
      });
      continue;
    }
    if (/^\/\/>>\s*endif\b/.test(trimmed)) {
      const opened = ifdefStack.pop();
      if (opened) {
        out.symbols.push({
          id: `${relPath}::ifdef_${opened.flag}@L${opened.startLine}`,
          name: `ifdef:${opened.flag}`,
          kind: "wgsl-ifdef",
          filePath: relPath,
          startLine: opened.startLine,
          endLine: i + 1,
          signature: `//>>ifdef ${opened.flag} (lines ${opened.startLine}-${i + 1})`,
          isUtility: 0,
        });
      }
      continue;
    }

    if (trimmed.startsWith("//")) continue;

    if (/diagnostic\s*\(\s*off\s*,\s*derivative_uniformity\s*\)/.test(line)) {
      out.contracts.push({
        filePath: relPath,
        line: i + 1,
        category: "shader_uniformity",
        contractType: "WGSL_DERIVATIVE_UNIFORMITY_SUPPRESSED",
        severity: "review",
        detail:
          "Suppresses WGSL derivative_uniformity diagnostic; verify non-uniform dpdx/dpdy/textureSample control flow",
      });
    }

    // @group(G) @binding(B)
    const bindMatch = line.match(
      /@group\(\s*(\d+)\s*\)\s*@binding\(\s*(\d+)\s*\)\s*var(?:<([^>]+)>)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;]+)/,
    );
    if (bindMatch) {
      const [, grp, bnd, addrSpace, varName, varType] = bindMatch;
      if (sampledTextureCount === 0 && storageBufferCount === 0) {
        firstBindingLine = i + 1;
      }
      if (/\btexture_(?!storage_)[A-Za-z0-9_]+/.test(varType)) {
        sampledTextureCount += 1;
      }
      if (addrSpace && /\bstorage\b/.test(addrSpace)) {
        storageBufferCount += 1;
      }
      out.symbols.push({
        id: `${relPath}::binding_g${grp}_b${bnd}_${varName}`,
        name: varName,
        kind: "wgsl-binding",
        filePath: relPath,
        startLine: i + 1,
        endLine: i + 1,
        signature: `@group(${grp}) @binding(${bnd}) var${addrSpace ? `<${addrSpace}>` : ""} ${varName}: ${varType.trim()}`,
        isUtility: 0,
      });
      out.contracts.push({
        filePath: relPath,
        line: i + 1,
        category: "bind_group_layout",
        contractType: `GROUP_${grp}_BINDING_${bnd}`,
        severity: "positive",
        detail: `${varName}: ${varType.trim()}`,
      });
    }

    // WGSL struct + CameraUniforms packer-family previousViewProjection audit
    const structMatch = line.match(
      /^\s*struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/,
    );
    if (structMatch) {
      const structName = structMatch[1];
      const endLine = findBlockEndLine(lines, i, 400);
      out.symbols.push({
        id: `${relPath}::${structName}`,
        name: structName,
        kind: "wgsl-struct",
        filePath: relPath,
        startLine: i + 1,
        endLine,
        signature: `struct ${structName}`,
        isUtility: 0,
      });

      if (/CameraUniforms/i.test(structName)) {
        const analyzed = uniformStructs.get(structName);
        let fields = analyzed?.logDepthFields ?? analyzed?.fields ?? null;
        if (!fields || fields.length === 0) {
          fields = [];
          for (let k = i + 1; k < endLine - 1 && k < lines.length; k += 1) {
            if (lines[k].trim().startsWith("//>>")) continue;
            const fl = lines[k].replace(/\/\/.*$/, "").trim();
            const fm = fl.match(
              /^(?:@[A-Za-z0-9_()]+?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/,
            );
            if (fm) fields.push({ name: fm[1], line: k + 1 });
          }
        }
        auditCameraUniformsPackerTail(relPath, structName, fields, out, i + 1);
      }
      continue;
    }

    // WGSL functions (including @vertex / @fragment / @compute on preceding or same line)
    const fnMatch = line.match(
      /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?/,
    );
    if (fnMatch) {
      const fnName = fnMatch[1];
      const prevLine = i > 0 ? lines[i - 1].trim() : "";
      const stageMatch = (prevLine + " " + trimmed).match(
        /@(vertex|fragment|compute)/,
      );
      const startLine = stageMatch && prevLine.startsWith("@") ? i : i + 1;
      const endLine = findBlockEndLine(lines, i, 500);
      out.symbols.push({
        id: `${relPath}::${fnName}`,
        name: fnName,
        kind: stageMatch ? `wgsl-${stageMatch[1]}` : "wgsl-fn",
        filePath: relPath,
        startLine,
        endLine,
        signature:
          `${stageMatch ? `@${stageMatch[1]} ` : ""}fn ${fnName}(${fnMatch[2].trim()})${fnMatch[3] ? ` -> ${fnMatch[3].trim()}` : ""}`.slice(
            0,
            180,
          ),
        isUtility: 0,
      });
    }

    // Precision / RTE / Geodetic Contract Checks in WGSL
    if (line.includes("translateRelativeToEye")) {
      out.contracts.push({
        filePath: relPath,
        line: i + 1,
        category: "precision_rte",
        contractType: "RTE_TRANSLATE_RELATIVE_TO_EYE",
        severity: "positive",
        detail: "Uses 64-bit emulated translateRelativeToEye()",
      });
    }
    if (/\b(?:positionHigh|posHigh|encodedCameraHigh)\b/.test(line)) {
      out.contracts.push({
        filePath: relPath,
        line: i + 1,
        category: "precision_rte",
        contractType: "RTE_SPLIT_HIGH_LOW",
        severity: "positive",
        detail: "Declares or reads split High/Low vertex/camera position",
      });
    }
    // Direct High + Low addition: a hazard when projected, a review lead otherwise
    const rteMatchWgsl = matchDirectHighPlusLow(line);
    if (rteMatchWgsl) {
      out.contracts.push(highPlusLowContract(relPath, i + 1, rteMatchWgsl));
    }
    // Geocentric asin(p.z / r) latitude approximation check
    if (
      /\basin\s*\(\s*(?:clamp\s*\(\s*)?[A-Za-z0-9_.]+\.z\s*(?:\/|,|\))/.test(
        line,
      )
    ) {
      out.contracts.push({
        filePath: relPath,
        line: i + 1,
        category: "precision_rte",
        contractType: "GEOCENTRIC_ASIN_LATITUDE_HAZARD",
        severity: "review",
        detail:
          "Computes latitude via geocentric asin(*.z) rather than WGS84 geodetic surface normal",
      });
    }
    // Hazard 2: Raw mvp * vec4<f32>(position, 1.0) without RelativeToEye
    if (
      /\bmvp\s*\*\s*vec4(?:<f32>)?\s*\(\s*(?:in\.)?position\s*,\s*1\.0/.test(
        line,
      ) &&
      !line.includes("RelativeToEye")
    ) {
      out.contracts.push({
        filePath: relPath,
        line: i + 1,
        category: "precision_rte",
        contractType: "RAW_MVP_POSITION_HAZARD",
        severity: "hazard",
        detail:
          "Multiplies mvp * vec4(position, 1.0) directly instead of mvpRelativeToEye * translateRelativeToEye(...)",
      });
    }
    // Clip / UV convention markers
    if (/\bfrag_depth\b|\blogDepth\b/.test(line)) {
      out.contracts.push({
        filePath: relPath,
        line: i + 1,
        category: "depth_encoding",
        contractType: "WGSL_LOG_DEPTH_WRITE_OR_SAMPLE",
        severity: "positive",
        detail: trimmed.slice(0, 140),
      });
    }
  }

  if (sampledTextureCount > 16) {
    out.contracts.push({
      filePath: relPath,
      line: firstBindingLine,
      category: "bind_group_layout",
      contractType: "STAGE_SAMPLED_TEXTURES_OVER_WEBGPU_FLOOR",
      severity: "review",
      detail: `Declares ${sampledTextureCount} sampled texture bindings across file (> 16 WebGPU maxSampledTexturesPerShaderStage floor; verify per-stage/ifdef cap)`,
    });
  }
  if (storageBufferCount > 8) {
    out.contracts.push({
      filePath: relPath,
      line: firstBindingLine,
      category: "bind_group_layout",
      contractType: "STAGE_STORAGE_BUFFERS_OVER_WEBGPU_FLOOR",
      severity: "review",
      detail: `Declares ${storageBufferCount} storage buffer bindings across file (> 8 WebGPU maxStorageBuffersPerShaderStage floor)`,
    });
  }
}

/**
 * Parse GLSL shader functions, structs, and uniforms for parity cross-referencing.
 */
function parseGlslFile(relPath, lines, out) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const rteMatchGlsl = matchDirectHighPlusLow(line);
    if (rteMatchGlsl) {
      out.contracts.push(highPlusLowContract(relPath, i + 1, rteMatchGlsl));
    }

    const structMatch = trimmed.match(
      /^struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{?/,
    );
    if (structMatch) {
      const endLine = findBlockEndLine(lines, i, 150);
      out.symbols.push({
        id: `${relPath}::${structMatch[1]}`,
        name: structMatch[1],
        kind: "glsl-struct",
        filePath: relPath,
        startLine: i + 1,
        endLine,
        signature: `struct ${structMatch[1]}`,
        isUtility: 0,
      });
      continue;
    }

    const fnMatch = trimmed.match(
      /^(?:void|float|vec[234]|mat[234]|int|uint|bool|czm_[A-Za-z0-9_]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{?$/,
    );
    if (fnMatch) {
      const endLine = findBlockEndLine(lines, i, 400);
      out.symbols.push({
        id: `${relPath}::${fnMatch[1]}`,
        name: fnMatch[1],
        kind: "glsl-fn",
        filePath: relPath,
        startLine: i + 1,
        endLine,
        signature: trimmed.replace(/\s*\{$/, "").slice(0, 160),
        isUtility: 0,
      });
    }
  }
}

/**
 * Extract the 4 Cesium-specific cross-boundary seams:
 * 1. FeatureRendererKey (Scene consumer <-> key <-> WebGPU registration)
 * 2. ShaderSourceId (registry <-> renderer getOrCreate/prewarm)
 * 3. ShaderDefine / ShaderDefineHi / ShaderDefineExt (registry <-> TS readers <-> WGSL //>>ifdef)
 * 4. GLSL <-> WGSL stem parity pairs
 */
function extractCesiumSeams(repoRoot, fileContentsMap, out) {
  // 1. FeatureRendererKey enum + registrations + consumers
  const frKeyPath = "packages/engine/Source/Renderer/FeatureRendererKey.js";
  const frKeyText = fileContentsMap.get(frKeyPath);
  if (frKeyText) {
    const frLines = frKeyText.split(/\r?\n/);
    for (let i = 0; i < frLines.length; i += 1) {
      const m = frLines[i].match(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*(\d+)/);
      if (m && m[1] !== "COUNT") {
        out.symbols.push({
          id: `frkey:${m[1]}`,
          name: `FeatureRendererKey.${m[1]}`,
          kind: "feature-renderer-key",
          filePath: frKeyPath,
          startLine: i + 1,
          endLine: i + 1,
          signature: `FeatureRendererKey.${m[1]} = ${m[2]}`,
          isUtility: 0,
        });
      }
    }
  }

  // 2. ShaderDefine, ShaderDefineHi, ShaderDefineExt, ShaderSourceId
  const definesPath =
    "packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts";
  const definesText = fileContentsMap.get(definesPath);
  const layoutPath = path.resolve(
    repoRoot,
    "Tools/visual-regression/fixtures/shader-registry-layout.json",
  );
  let layoutRanges = [];
  if (fs.existsSync(layoutPath)) {
    try {
      layoutRanges =
        JSON.parse(fs.readFileSync(layoutPath, "utf8")).ranges ?? [];
    } catch {}
  }

  function findRangeOwner(word, bitIdx) {
    const hit = layoutRanges.find(
      (r) => r.word === word && bitIdx >= r.start && bitIdx <= r.end,
    );
    return hit ? `${hit.owner} (${hit.name})` : word;
  }

  if (definesText) {
    const defLines = definesText.split(/\r?\n/);
    let currentBlock = null;
    for (let i = 0; i < defLines.length; i += 1) {
      const line = defLines[i];
      if (line.includes("export const ShaderDefine =")) currentBlock = "lo";
      else if (line.includes("export const ShaderDefineHi ="))
        currentBlock = "hi";
      else if (line.includes("export const ShaderDefineExt ="))
        currentBlock = "ext";
      else if (line.includes("export const ShaderSourceId =")) {
        currentBlock = "sourceId";
      } else if (currentBlock && /^\s*\}\s*(?:as const)?\s*\)?;/.test(line)) {
        currentBlock = null;
      }

      if (
        currentBlock === "lo" ||
        currentBlock === "hi" ||
        currentBlock === "ext"
      ) {
        const dm = line.match(
          /^\s*([A-Z][A-Z0-9_]*)\s*:\s*(?:1\s*<<\s*(\d+)|(?:hi|ext)DefineBit\(\s*(\d+)\s*\))/,
        );
        if (dm) {
          const flagName = dm[1];
          const bitIdx = Number(dm[2] ?? dm[3]);
          const owner = findRangeOwner(currentBlock, bitIdx);
          out.symbols.push({
            id: `define:${flagName}`,
            name: flagName,
            kind: `shader-define-${currentBlock}`,
            filePath: definesPath,
            startLine: i + 1,
            endLine: i + 1,
            signature: `${currentBlock}[bit ${bitIdx}] ${flagName} — owner: ${owner}`,
            isUtility: 0,
          });
        }
      } else if (currentBlock === "sourceId") {
        const sm = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*(\d+)/);
        if (sm) {
          out.symbols.push({
            id: `shader-source:${sm[1]}`,
            name: `ShaderSourceId.${sm[1]}`,
            kind: "shader-source-id",
            filePath: definesPath,
            startLine: i + 1,
            endLine: i + 1,
            signature: `ShaderSourceId.${sm[1]} = ${sm[2]}`,
            isUtility: 0,
          });
        }
      }
    }
  }

  // Scan JS/TS files for FeatureRendererKey, ShaderDefine*, and ShaderSourceId references
  for (const [relPath, text] of fileContentsMap.entries()) {
    if (relPath === frKeyPath || relPath === definesPath) continue;
    if (!/\.(js|ts|mjs)$/.test(relPath)) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

      if (line.includes("FeatureRendererKey.")) {
        for (const m of line.matchAll(/FeatureRendererKey\.([A-Z0-9_]+)/g)) {
          const key = m[1];
          const isReg = /registerFeatureRenderer/.test(
            lines.slice(Math.max(0, i - 2), i + 2).join(" "),
          );
          out.edges.push({
            src: isReg ? `frkey:${key}` : `file:${relPath}`,
            dst: isReg ? `file:${relPath}` : `frkey:${key}`,
            relation: isReg
              ? "registers_feature_renderer"
              : "consumes_feature_renderer",
            provenance: "cesium-seam",
            detail: line.trim().slice(0, 140),
            filePath: relPath,
            line: i + 1,
          });
        }
      }

      if (line.includes("ShaderDefine")) {
        for (const m of line.matchAll(
          /ShaderDefine(?:Hi|Ext)?\.([A-Z0-9_]+)/g,
        )) {
          out.edges.push({
            src: `file:${relPath}`,
            dst: `define:${m[1]}`,
            relation: "reads_shader_define",
            provenance: "cesium-seam",
            detail: line.trim().slice(0, 140),
            filePath: relPath,
            line: i + 1,
          });
        }
      }

      if (line.includes("ShaderSourceId.")) {
        for (const m of line.matchAll(/ShaderSourceId\.([A-Z0-9_]+)/g)) {
          out.edges.push({
            src: `file:${relPath}`,
            dst: `shader-source:${m[1]}`,
            relation: "uses_shader_source",
            provenance: "cesium-seam",
            detail: line.trim().slice(0, 140),
            filePath: relPath,
            line: i + 1,
          });
        }
      }
    }
  }

  // 4. Pair GLSL <-> WGSL shaders by normalized stem
  const glslByStem = new Map();
  const wgslFiles = [];
  for (const relPath of fileContentsMap.keys()) {
    if (relPath.endsWith(".glsl")) {
      const base = path.posix
        .basename(relPath, ".glsl")
        .replace(/(?:VS|FS|Common|Stage)$/i, "")
        .toLowerCase();
      if (base.length >= 3) {
        const list = glslByStem.get(base) ?? [];
        list.push(relPath);
        glslByStem.set(base, list);
      }
    } else if (relPath.endsWith(".wgsl")) {
      wgslFiles.push(relPath);
    }
  }

  for (const wgslPath of wgslFiles) {
    const stem = path.posix
      .basename(wgslPath, ".wgsl")
      .replace(/(?:Stage|Complete|Terrain)$/i, "")
      .toLowerCase();
    const rawStem = path.posix.basename(wgslPath, ".wgsl").toLowerCase();
    const candidates = new Set([
      ...(glslByStem.get(rawStem) ?? []),
      ...(stem.length >= 4 ? (glslByStem.get(stem) ?? []) : []),
    ]);
    for (const glslPath of candidates) {
      out.edges.push({
        src: `file:${wgslPath}`,
        dst: `file:${glslPath}`,
        relation: "glsl_wgsl_parity",
        provenance: "cesium-seam",
        detail: "Stem-matched WebGPU WGSL <-> WebGL GLSL shader pair",
        filePath: wgslPath,
        line: 1,
      });
    }
  }
}

/**
 * Populate `files`, `symbols`, `symbols_fts`, `edges`, and `contracts` inside a transaction.
 * Supports fast SHA-256 delta updates when `options.incremental === true`.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} repoRoot
 * @param {{ scanRoots?: string[], incremental?: boolean }} [options]
 */
export function indexCodeAndSeams(db, repoRoot, options = {}) {
  const scanRoots = options.scanRoots ?? [
    "packages/engine/Source",
    "packages/widgets/Source",
    "Tools",
  ];

  const relFiles = collectCodeFiles(repoRoot, scanRoots);
  const knownFiles = new Set(relFiles);

  const existingHashes = new Map();
  if (options.incremental) {
    for (const row of db.prepare("SELECT path, sha256 FROM files").all()) {
      existingHashes.set(row.path, row.sha256);
    }
  }

  const buffersByPath = new Map();
  const hashesByPath = new Map();
  const changedPaths = [];
  for (const relPath of relFiles) {
    const absPath = path.resolve(repoRoot, relPath);
    const buf = fs.readFileSync(absPath);
    const hash = sha256Hex(buf);
    buffersByPath.set(relPath, buf);
    hashesByPath.set(relPath, hash);
    if (options.incremental && existingHashes.get(relPath) !== hash) {
      changedPaths.push(relPath);
    }
  }

  const deletedPaths = [];
  if (options.incremental && existingHashes.size > 0) {
    for (const oldPath of existingHashes.keys()) {
      if (!knownFiles.has(oldPath)) {
        deletedPaths.push(oldPath);
      }
    }

    if (changedPaths.length === 0 && deletedPaths.length === 0) {
      return {
        fileCount: Number(
          db.prepare("SELECT COUNT(*) AS n FROM files").get().n,
        ),
        symbolCount: Number(
          db.prepare("SELECT COUNT(*) AS n FROM symbols").get().n,
        ),
        edgeCount: Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM edges WHERE provenance != 'graphify-ast'",
            )
            .get().n,
        ),
        contractCount: Number(
          db.prepare("SELECT COUNT(*) AS n FROM contracts").get().n,
        ),
        incremental: true,
        changedFiles: 0,
        deletedFiles: 0,
      };
    }

    const seamRegistryTouched = changedPaths.some(
      (p) =>
        p.endsWith("FeatureRendererKey.js") ||
        p.endsWith("WebGPUShaderDefines.ts") ||
        p.endsWith("shader-registry-layout.json"),
    );

    if (
      !seamRegistryTouched &&
      changedPaths.length + deletedPaths.length <= 200
    ) {
      const deltaOut = { files: [], symbols: [], edges: [], contracts: [] };
      const deltaContents = new Map();

      for (const relPath of changedPaths) {
        const buf = buffersByPath.get(relPath);
        const text = buf.toString("utf8");
        const lines = text.split(/\r?\n/);
        const ext = path.posix.extname(relPath).toLowerCase();
        deltaContents.set(relPath, text);

        deltaOut.files.push({
          path: relPath,
          sha256: hashesByPath.get(relPath),
          bytes: buf.byteLength,
          lineCount: countLines(lines),
          ext,
          domain: classifyDomain(relPath),
        });
        deltaOut.symbols.push({
          id: `file:${relPath}`,
          name: path.posix.basename(relPath),
          kind: "file",
          filePath: relPath,
          startLine: 1,
          endLine: lines.length,
          signature: `${classifyDomain(relPath)} (${lines.length} lines)`,
          isUtility: 0,
        });

        if (ext === ".wgsl") {
          parseWgslFile(relPath, lines, deltaOut);
        } else if (ext === ".glsl") {
          parseGlslFile(relPath, lines, deltaOut);
        } else {
          parseJsTsFile(relPath, lines, knownFiles, deltaOut);
        }

        // Single-file FeatureRendererKey / ShaderDefine / ShaderSourceId references
        if (/\.(js|ts|mjs)$/.test(relPath)) {
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (line.trim().startsWith("//") || line.trim().startsWith("*")) {
              continue;
            }
            for (const m of line.matchAll(
              /FeatureRendererKey\.([A-Z0-9_]+)/g,
            )) {
              const isReg = /registerFeatureRenderer/.test(
                lines.slice(Math.max(0, i - 2), i + 2).join(" "),
              );
              deltaOut.edges.push({
                src: isReg ? `frkey:${m[1]}` : `file:${relPath}`,
                dst: isReg ? `file:${relPath}` : `frkey:${m[1]}`,
                relation: isReg
                  ? "registers_feature_renderer"
                  : "consumes_feature_renderer",
                provenance: "cesium-seam",
                detail: line.trim().slice(0, 140),
                filePath: relPath,
                line: i + 1,
              });
            }
            for (const m of line.matchAll(
              /ShaderDefine(?:Hi|Ext)?\.([A-Z0-9_]+)/g,
            )) {
              deltaOut.edges.push({
                src: `file:${relPath}`,
                dst: `define:${m[1]}`,
                relation: "reads_shader_define",
                provenance: "cesium-seam",
                detail: line.trim().slice(0, 140),
                filePath: relPath,
                line: i + 1,
              });
            }
            for (const m of line.matchAll(/ShaderSourceId\.([A-Z0-9_]+)/g)) {
              deltaOut.edges.push({
                src: `file:${relPath}`,
                dst: `shader-source:${m[1]}`,
                relation: "uses_shader_source",
                provenance: "cesium-seam",
                detail: line.trim().slice(0, 140),
                filePath: relPath,
                line: i + 1,
              });
            }
          }
        }
      }

      // Also include cited .wgsl files in deltaContents so TS uniform size cross-checks resolve on incremental edits
      for (const text of [...deltaContents.values()]) {
        for (const m of text.matchAll(/([A-Za-z0-9_]+\.wgsl)/g)) {
          for (const rel of relFiles) {
            if (rel.endsWith(`/${m[1]}`) && !deltaContents.has(rel)) {
              deltaContents.set(rel, buffersByPath.get(rel).toString("utf8"));
            }
          }
        }
      }

      extractUniformAndCrsContracts(deltaContents, deltaOut);
      auditGisAndAssetContracts(repoRoot, deltaContents, deltaOut);

      // Preserve existing Graphify Leiden `community_id` on symbols in edited files across `--incremental`
      const preservedDeltaCommunities = new Map();
      const selFileComm = db.prepare(
        "SELECT id, name, community_id FROM symbols WHERE file_path = ? AND community_id IS NOT NULL",
      );
      for (const p of changedPaths) {
        for (const row of selFileComm.all(p)) {
          preservedDeltaCommunities.set(row.id, row.community_id);
          preservedDeltaCommunities.set(
            `${p}::name::${row.name}`,
            row.community_id,
          );
        }
      }

      const delFile = db.prepare("DELETE FROM files WHERE path = ?");
      const delSym = db.prepare("DELETE FROM symbols WHERE file_path = ?");
      const delFts = db.prepare("DELETE FROM symbols_fts WHERE file_path = ?");
      const delEdge = db.prepare(
        "DELETE FROM edges WHERE file_path = ? AND provenance NOT IN ('graphify-ast', 'gis-asset')",
      );
      const delContract = db.prepare(
        "DELETE FROM contracts WHERE file_path = ? OR category = 'gis_datum' AND contract_type = 'UNTRACKED_ASSET_RESIDUE'",
      );
      const pruneOrphanGraphifyEdges = db.prepare(`
        DELETE FROM edges
        WHERE provenance = 'graphify-ast'
          AND (
            (src_id LIKE ? AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = edges.src_id))
            OR (dst_id LIKE ? AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = edges.dst_id))
          )
      `);
      const insFile = db.prepare(`
        INSERT OR REPLACE INTO files(path, sha256, bytes, line_count, ext, domain)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insSym = db.prepare(`
        INSERT OR REPLACE INTO symbols(id, name, kind, file_path, start_line, end_line, signature, community_id, is_utility)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insFts = db.prepare(`
        INSERT INTO symbols_fts(id, name, file_path, signature, kind)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insEdge = db.prepare(`
        INSERT OR IGNORE INTO edges(src_id, dst_id, relation, provenance, detail, file_path, line)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insContract = db.prepare(`
        INSERT INTO contracts(file_path, line, category, contract_type, severity, detail)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      db.exec("BEGIN;");
      try {
        for (const p of [...changedPaths, ...deletedPaths]) {
          delFile.run(p);
          delSym.run(p);
          delFts.run(p);
          delEdge.run(p);
          delContract.run(p);
        }
        for (const f of deltaOut.files) {
          insFile.run(f.path, f.sha256, f.bytes, f.lineCount, f.ext, f.domain);
        }
        const seenDeltaSyms = new Set();
        for (const s of deltaOut.symbols) {
          if (s.kind === "crs-frame" || seenDeltaSyms.has(s.id)) continue;
          seenDeltaSyms.add(s.id);
          const restoredComm =
            preservedDeltaCommunities.get(s.id) ??
            preservedDeltaCommunities.get(`${s.filePath}::name::${s.name}`) ??
            null;
          insSym.run(
            s.id,
            s.name,
            s.kind,
            s.filePath,
            s.startLine,
            s.endLine,
            s.signature ?? null,
            restoredComm,
            s.isUtility ?? 0,
          );
          insFts.run(s.id, s.name, s.filePath, s.signature ?? "", s.kind);
        }
        for (const p of [...changedPaths, ...deletedPaths]) {
          pruneOrphanGraphifyEdges.run(`${p}::%`, `${p}::%`);
        }
        for (const e of deltaOut.edges) {
          insEdge.run(
            e.src,
            e.dst,
            e.relation,
            e.provenance,
            e.detail ?? null,
            e.filePath ?? null,
            e.line ?? null,
          );
        }
        for (const c of deltaOut.contracts) {
          insContract.run(
            c.filePath,
            c.line,
            c.category,
            c.contractType,
            c.severity,
            c.detail,
          );
        }
        db.exec("COMMIT;");
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }

      return {
        fileCount: Number(
          db.prepare("SELECT COUNT(*) AS n FROM files").get().n,
        ),
        symbolCount: Number(
          db.prepare("SELECT COUNT(*) AS n FROM symbols").get().n,
        ),
        edgeCount: Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM edges WHERE provenance != 'graphify-ast'",
            )
            .get().n,
        ),
        contractCount: Number(
          db.prepare("SELECT COUNT(*) AS n FROM contracts").get().n,
        ),
        incremental: true,
        changedFiles: changedPaths.length,
        deletedFiles: deletedPaths.length,
      };
    }
  }

  const fileContentsMap = new Map();
  const out = {
    files: [],
    symbols: [],
    edges: [],
    contracts: [],
  };

  for (const relPath of relFiles) {
    const buf = buffersByPath.get(relPath);
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    const ext = path.posix.extname(relPath).toLowerCase();
    fileContentsMap.set(relPath, text);

    out.files.push({
      path: relPath,
      sha256: hashesByPath.get(relPath),
      bytes: buf.byteLength,
      lineCount: countLines(lines),
      ext,
      domain: classifyDomain(relPath),
    });

    // Every file also gets a top-level file symbol so file searches resolve cleanly.
    out.symbols.push({
      id: `file:${relPath}`,
      name: path.posix.basename(relPath),
      kind: "file",
      filePath: relPath,
      startLine: 1,
      endLine: lines.length,
      signature: `${classifyDomain(relPath)} (${lines.length} lines)`,
      isUtility: 0,
    });

    if (ext === ".wgsl") {
      parseWgslFile(relPath, lines, out);
    } else if (ext === ".glsl") {
      parseGlslFile(relPath, lines, out);
    } else {
      parseJsTsFile(relPath, lines, knownFiles, out);
    }
  }

  extractCesiumSeams(repoRoot, fileContentsMap, out);
  extractUniformAndCrsContracts(fileContentsMap, out);
  auditGisAndAssetContracts(repoRoot, fileContentsMap, out);

  // Preserve previously imported Graphify Leiden `community_id` assignments across rebuilds.
  const preservedCommunities = new Map();
  try {
    for (const r of db
      .prepare(
        "SELECT id, community_id FROM symbols WHERE community_id IS NOT NULL",
      )
      .all()) {
      preservedCommunities.set(r.id, r.community_id);
    }
  } catch {
    // Table empty or fresh DB.
  }

  const insertFile = db.prepare(`
    INSERT OR REPLACE INTO files(path, sha256, bytes, line_count, ext, domain)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertSymbol = db.prepare(`
    INSERT OR REPLACE INTO symbols(id, name, kind, file_path, start_line, end_line, signature, community_id, is_utility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO symbols_fts(id, name, file_path, signature, kind)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges(src_id, dst_id, relation, provenance, detail, file_path, line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertContract = db.prepare(`
    INSERT INTO contracts(file_path, line, category, contract_type, severity, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN;");
  try {
    db.exec("DELETE FROM files;");
    db.exec("DELETE FROM symbols;");
    db.exec("DELETE FROM symbols_fts;");
    db.exec("DELETE FROM edges WHERE provenance != 'graphify-ast';");
    db.exec("DELETE FROM contracts;");

    for (const f of out.files) {
      insertFile.run(f.path, f.sha256, f.bytes, f.lineCount, f.ext, f.domain);
    }
    const seenSymIds = new Set();
    for (const s of out.symbols) {
      if (seenSymIds.has(s.id)) continue;
      seenSymIds.add(s.id);
      insertSymbol.run(
        s.id,
        s.name,
        s.kind,
        s.filePath,
        s.startLine,
        s.endLine,
        s.signature ?? null,
        preservedCommunities.get(s.id) ?? null,
        s.isUtility ?? 0,
      );
      insertFts.run(s.id, s.name, s.filePath, s.signature ?? "", s.kind);
    }
    for (const e of out.edges) {
      insertEdge.run(
        e.src,
        e.dst,
        e.relation,
        e.provenance,
        e.detail ?? null,
        e.filePath ?? null,
        e.line ?? null,
      );
    }
    for (const c of out.contracts) {
      insertContract.run(
        c.filePath,
        c.line,
        c.category,
        c.contractType,
        c.severity,
        c.detail,
      );
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }

  // Report the rows stored, not the rows offered: duplicate symbol ids and
  // duplicate edges are dropped on insert, and an --incremental run reports
  // stored rows, so the two paths must agree for the same tree.
  return {
    fileCount: Number(db.prepare("SELECT COUNT(*) AS n FROM files").get().n),
    symbolCount: Number(
      db.prepare("SELECT COUNT(*) AS n FROM symbols").get().n,
    ),
    edgeCount: Number(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM edges WHERE provenance != 'graphify-ast'",
        )
        .get().n,
    ),
    contractCount: Number(
      db.prepare("SELECT COUNT(*) AS n FROM contracts").get().n,
    ),
    incremental: false,
  };
}
