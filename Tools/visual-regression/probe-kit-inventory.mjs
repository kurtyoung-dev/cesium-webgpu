#!/usr/bin/env node
// probe-kit-inventory.mjs — the generated inventory of the probe kit.
//
// @purpose Walks lib/, lib/metrics/, rigs/, the top-level probes and archive/, reads each file's @purpose/@status header and exports, classifies every probe as runtime or direct launcher with the fleet contract's own detectors, and prints (or --check / --write) the inventory region of migration_doc/PROBE_KIT_GUIDE.md.
// @status ACTIVE
//
// WHY THIS EXISTS. The maintainer's kit-first rule (CLAUDE.md, "Probe Kit -
// Kit First") makes "does a piece for this already exist?" the first question
// of every probe task. The answer has to be a list that is true at the tree
// being worked on, and a hand-maintained list of a library that grows with
// every family landing is stale by the next batch. So the guide's inventory is
// GENERATED from the files themselves, and `--check` fails when the guide and
// the tree disagree, the same shape `Tools/generate-tooling-catalog.mjs` uses
// for the tooling catalog.
//
// WHAT IT READS, AND HOW.
//   - Headers: `Tools/lib/purpose-header.mjs`'s `parsePurposeHeader`, the one
//     parser the purpose-header contract and the tooling catalog use. A file
//     with no `@purpose` is listed with that fact, never dropped.
//   - Exports and imports: read from the code with comments and string
//     interiors blanked (`blankNonCode`), the specifier read back from the
//     raw text between the quotes the import ends at, so an `import` inside a
//     comment or a printed string is not an edge.
//   - Probe classification: the fleet contract's own detectors,
//     `launchesThroughRuntime`, `launchesBrowserByBehaviour` and
//     `fleetExemption` (`lib/probe-fleet-contract.mjs`). Nothing here
//     re-implements them, so this inventory and the fleet census cannot
//     disagree about which probe launches how.
//   - Rigs: each `rigs/*.mjs` is imported, as `lib/rig-registry.mjs`'s
//     `loadRigs` does; a rig file is plain frozen data, so importing one runs
//     nothing.
//
// WHAT "RIGS" AND "SPECS" MEAN IN THE RUNTIME-PROBE TABLE. Static reading
// cannot see which scene a probe will build at run time, so the table links a
// rig to a probe by four rules, each one a fact in the source:
//   1. the probe's code holds the rig id as a whole string literal;
//   2. the probe imports the rig file (`./rigs/<id>.mjs`);
//   3. the rig names the probe: its `declaredBy` field, or the probe's file
//      name anywhere in the rig source;
//   4. the rig id is the probe's stem (`probe-<stem>.mjs`) or starts with
//      `<stem>-`, for rigs not tagged `wave-end` (the wave-end rigs belong to
//      `capture-and-diff.mjs` whatever their name).
// A spec covers a probe when the spec imports it, directly or through one
// support module under `fixtures/`. A `—` in either column is a measurement
// of the source, not a claim that the probe has no scene or no spec.
//
// IMPORTER COUNTS. Among the `.mjs` files under the root (`output/` and
// `archive/` excluded): `scripts` = top-level non-spec files, `specs` = any
// `*.spec.mjs` plus the non-spec support modules under `fixtures/`, `lib` =
// the other non-spec files under `lib/`. Callers outside
// `Tools/visual-regression/` are not counted.
//
// Usage:
//   node Tools/visual-regression/probe-kit-inventory.mjs                 # print the region body
//   node Tools/visual-regression/probe-kit-inventory.mjs --check <guide> # exit 1 with a diff on drift
//   node Tools/visual-regression/probe-kit-inventory.mjs --write <guide> # replace the region
//   node Tools/visual-regression/probe-kit-inventory.mjs --list-direct   # the direct-launch probes, one per line
//   [--root <dir>] points it at another tree (the spec's fixture); default: this file's directory.
// Exit: 0 ok; 1 drift (--check); 2 usage error, or a guide without the two markers.
// Spec: node --test Tools/visual-regression/probe-kit-inventory.spec.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePurposeHeader } from "../lib/purpose-header.mjs";
import {
  blankNonCode,
  fleetExemption,
  launchesBrowserByBehaviour,
  launchesThroughRuntime,
  stringLiteralSpans,
} from "./lib/probe-fleet-contract.mjs";

/** The markers that bound the generated region of the guide. */
export const REGION_BEGIN = "<!-- probe-kit-inventory:begin -->";
export const REGION_END = "<!-- probe-kit-inventory:end -->";

/** A direct-launch family with fewer probes than this is folded into one row. */
export const FAMILY_ROW_MINIMUM = 5;

const DEFAULT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKIPPED_DIRECTORIES = new Set(["output", "node_modules", "archive"]);
const IMPORT_PATTERNS = [
  // import x from "y"; import {a} from "y"; import * as n from "y"; import "y"
  /\bimport\s*(?:[A-Za-z_$][\w$]*\s*,?\s*)?(?:\{[^}]*\}|\*\s*as\s+[A-Za-z_$][\w$]*)?\s*(?:from\s*)?(?=["'`])/g,
  // export * from "y"; export * as n from "y"; export {a} from "y"
  /\bexport\s*(?:\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?|\{[^}]*\}\s*)from\s*(?=["'`])/g,
  // import("y")
  /\bimport\s*\(\s*(?=["'`])/g,
];

/** @param {string} text @returns {string} The text with CRLF folded to LF. */
function lf(text) {
  return String(text).replace(/\r\n/g, "\n");
}

/**
 * Every `.mjs` file under `directory`, as root-relative slash paths, sorted.
 *
 * @param {string} root The inventory root.
 * @param {string} directory Root-relative directory ("" for the root itself).
 * @param {{recursive: boolean}} options Whether to descend.
 * @returns {string[]} Paths.
 */
function listModules(root, directory, { recursive }) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  const out = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const rel = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recursive && !SKIPPED_DIRECTORIES.has(entry.name)) {
        out.push(...listModules(root, rel, { recursive }));
      }
    } else if (entry.name.endsWith(".mjs")) {
      out.push(rel);
    }
  }
  return out.sort();
}

const OPENING_BRACKETS = "({[";
const CLOSING_BRACKETS = ")}]";

/**
 * Index of the bracket that closes the one at `open`, counting all three
 * bracket kinds, or -1 when the code ends first.
 *
 * @param {string} code Comment/string-blanked source.
 * @param {number} open Index of an opening bracket.
 * @returns {number} Index of the matching closing bracket, or -1.
 */
function matchBracket(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (OPENING_BRACKETS.includes(code[i])) {
      depth += 1;
    } else if (CLOSING_BRACKETS.includes(code[i])) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * The pieces of `text` between top-level occurrences of `separator`, each
 * with its offset in `text`.
 *
 * @param {string} text Bracket-balanced code.
 * @param {string} separator One character.
 * @returns {Array<{start: number, text: string}>} The pieces.
 */
function splitTopLevel(text, separator) {
  const pieces = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (OPENING_BRACKETS.includes(text[i])) {
      depth += 1;
    } else if (CLOSING_BRACKETS.includes(text[i])) {
      depth -= 1;
    } else if (text[i] === separator && depth === 0) {
      pieces.push({ start, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  pieces.push({ start, text: text.slice(start) });
  return pieces;
}

/**
 * The names an object or array binding pattern binds, in source order:
 * `{ a, b: c, d = 1, ...e }` binds a, c, d and e; `[f, , [g]]` binds f and g.
 *
 * @param {string} pattern Blanked code from the opening `{` or `[` to its match.
 * @param {number} base Offset of the pattern in the module.
 * @returns {Array<{index: number, name: string}>} The bound names.
 */
function patternBindings(pattern, base) {
  const isObject = pattern[0] === "{";
  const bound = [];
  for (const piece of splitTopLevel(pattern.slice(1, -1), ",")) {
    let element = piece.text.trimStart();
    let at = base + 1 + piece.start + (piece.text.length - element.length);
    if (element.startsWith("...")) {
      const rest = element.slice(3);
      element = rest.trimStart();
      at += 3 + (rest.length - element.length);
    } else if (isObject) {
      // `key: target` renames; a colon after the first `=` belongs to a
      // default value's conditional, so the key is the binding then.
      const colon = splitTopLevel(element, ":");
      const equals = splitTopLevel(element, "=");
      if (
        colon.length > 1 &&
        (equals.length === 1 || colon[0].text.length < equals[0].text.length)
      ) {
        const target = element.slice(colon[1].start);
        element = target.trimStart();
        at += colon[1].start + (target.length - element.length);
      }
    }
    element = splitTopLevel(element, "=")[0].text.trimEnd();
    if (element.startsWith("{") || element.startsWith("[")) {
      bound.push(...patternBindings(element, at));
    } else if (/^[A-Za-z_$][\w$]*$/.test(element)) {
      bound.push({ index: at, name: element });
    }
  }
  return bound;
}

/**
 * The names a module exports, in source order, read from its code.
 *
 * @param {string} source Module source.
 * @param {string} [code] The source already blanked by `blankNonCode`.
 * @returns {string[]} Exported names; `default` for a default export, `*` for an unnamed star re-export.
 */
export function readExports(source, code = blankNonCode(lf(source))) {
  const found = [];
  const add = (index, name) => found.push({ index, name });
  const declaration =
    /\bexport\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s*([A-Za-z_$][\w$]*)/g;
  for (const m of code.matchAll(declaration)) {
    add(m.index, m[1]);
  }
  // `export const { a, b } = …` and `export const [c] = …` bind names through
  // a pattern rather than after the keyword.
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s*(?=[{[])/g)) {
    const open = m.index + m[0].length;
    const close = matchBracket(code, open);
    if (close !== -1) {
      for (const binding of patternBindings(
        code.slice(open, close + 1),
        open,
      )) {
        add(binding.index, binding.name);
      }
    }
  }
  for (const m of code.matchAll(/\bexport\s+default\b/g)) {
    add(m.index, "default");
  }
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const named =
        /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (named !== null) {
        add(m.index, named[2] ?? named[1]);
      }
    }
  }
  for (const m of code.matchAll(
    /\bexport\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\b/g,
  )) {
    add(m.index, m[1] ?? "*");
  }
  found.sort((a, b) => a.index - b.index);
  const names = [];
  for (const { name } of found) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * The module specifiers a source imports or re-exports, read from code.
 *
 * @param {string} source Module source.
 * @param {string} [code] The source already blanked by `blankNonCode` (the scan is the cost).
 * @returns {string[]} Specifiers, in source order.
 */
export function readImportSpecifiers(source, code = blankNonCode(lf(source))) {
  const text = lf(source);
  const hits = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const m of code.matchAll(pattern)) {
      // `blankNonCode` keeps a literal's quotes and blanks only its interior,
      // so the specifier is read back from the raw text between them. A
      // template specifier with a hole is not a static edge and is skipped.
      const open = m.index + m[0].length;
      const close = text.indexOf(text[open], open + 1);
      const specifier = close > open ? text.slice(open + 1, close) : "";
      if (specifier.length > 0 && !specifier.includes("${")) {
        hits.push({ index: m.index, specifier });
      }
    }
  }
  return hits.sort((a, b) => a.index - b.index).map((hit) => hit.specifier);
}

/**
 * Resolve a relative specifier to a root-relative path, or null for a bare
 * or absolute one.
 *
 * @param {string} fromRel Importing file, root-relative.
 * @param {string} specifier The specifier.
 * @returns {string|null} Root-relative target.
 */
function resolveSpecifier(fromRel, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(fromRel), specifier),
  );
}

/** @param {string} rel Root-relative path. @returns {"scripts"|"specs"|"lib"|null} Importer bucket. */
function importerBucket(rel) {
  if (rel.endsWith(".spec.mjs") || rel.startsWith("fixtures/")) {
    return "specs";
  }
  if (rel.startsWith("lib/")) {
    return "lib";
  }
  if (!rel.includes("/")) {
    return "scripts";
  }
  return null;
}

/** @param {string} rel A top-level probe path. @returns {string} Its family token. */
export function probeFamily(rel) {
  const m = /^probe-([a-z0-9]+)/.exec(path.posix.basename(rel));
  return m === null ? "(not named probe-*)" : m[1];
}

/**
 * Read one module's header, exports and imports.
 *
 * @param {string} root Inventory root.
 * @param {string} rel Root-relative path.
 * @returns {{path: string, source: string, purpose: string|null, status: string|null, supersededBy: string|null, exports: string[], imports: string[]}} Module facts.
 */
function readModule(root, rel) {
  const source = fs.readFileSync(path.join(root, rel), "utf8");
  const header = parsePurposeHeader(source);
  // Rigs are data and import nothing; skipping their scan is most of the
  // difference between a ten-second run and a twenty-second one.
  const code = rel.startsWith("rigs/") ? null : blankNonCode(lf(source));
  return {
    path: rel,
    source,
    purpose: header.purpose,
    status: header.status,
    exports:
      code !== null && rel.startsWith("lib/") ? readExports(source, code) : [],
    imports:
      code === null
        ? []
        : readImportSpecifiers(source, code)
            .map((specifier) => resolveSpecifier(rel, specifier))
            .filter((target) => target !== null),
  };
}

/**
 * Collect the whole inventory of a probe tree.
 *
 * @param {object} [options] Options.
 * @param {string} [options.root] The `Tools/visual-regression` directory (or a fixture shaped like it).
 * @returns {Promise<object>} The inventory.
 */
export async function collectInventory({ root = DEFAULT_ROOT } = {}) {
  const all = listModules(root, "", { recursive: true });
  const modules = new Map(all.map((rel) => [rel, readModule(root, rel)]));

  const importersOf = new Map();
  for (const module of modules.values()) {
    const bucket = importerBucket(module.path);
    if (bucket === null) {
      continue;
    }
    for (const target of new Set(module.imports)) {
      if (!importersOf.has(target)) {
        importersOf.set(target, {
          scripts: new Set(),
          specs: new Set(),
          lib: new Set(),
        });
      }
      importersOf.get(target)[bucket].add(module.path);
    }
  }
  const pieceRow = (module) => {
    const importers = importersOf.get(module.path) ?? {
      scripts: new Set(),
      specs: new Set(),
      lib: new Set(),
    };
    return {
      path: module.path,
      purpose: module.purpose,
      status: module.status,
      exports: module.exports,
      importers: {
        scripts: importers.scripts.size,
        specs: importers.specs.size,
        lib: [...importers.lib].filter((rel) => rel !== module.path).length,
      },
    };
  };
  const isSpec = (rel) => rel.endsWith(".spec.mjs");
  const lib = all
    .filter(
      (rel) =>
        rel.startsWith("lib/") &&
        !rel.startsWith("lib/metrics/") &&
        !isSpec(rel),
    )
    .map((rel) => pieceRow(modules.get(rel)));
  const metrics = all
    .filter((rel) => rel.startsWith("lib/metrics/") && !isSpec(rel))
    .map((rel) => pieceRow(modules.get(rel)));

  const rigs = [];
  for (const rel of listModules(root, "rigs", { recursive: false })) {
    const loaded = await import(pathToFileURL(path.join(root, rel)).href);
    const rig = loaded.default;
    if (rig === undefined || typeof rig !== "object" || rig === null) {
      throw new TypeError(
        `${rel} must default-export a plain object rig record`,
      );
    }
    const module = modules.get(rel);
    const pageKind = Object.hasOwn(rig, "url") ? "url" : "page";
    rigs.push({
      path: rel,
      id: String(rig.id),
      tags: Array.isArray(rig.tags) ? [...rig.tags] : [],
      renderers: Array.isArray(rig.renderers) ? [...rig.renderers] : [],
      page: pageKind === "url" ? rig.url : rig.page,
      pageKind,
      declaredBy:
        typeof rig.declaredBy === "string"
          ? rig.declaredBy.split(/\s*,\s*/)
          : [],
      purpose: module.purpose,
      status: module.status,
      source: module.source,
    });
  }
  rigs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rigByPath = new Map(rigs.map((rig) => [rig.path, rig]));
  const rigIds = new Set(rigs.map((rig) => rig.id));

  // Spec coverage: the spec's own imports plus one hop through fixtures/.
  const specReach = new Map();
  for (const module of modules.values()) {
    if (!isSpec(module.path)) {
      continue;
    }
    const reach = new Set(module.imports);
    for (const target of module.imports) {
      if (target.startsWith("fixtures/") && modules.has(target)) {
        for (const next of modules.get(target).imports) {
          reach.add(next);
        }
      }
    }
    specReach.set(module.path, reach);
  }

  const runtime = [];
  const direct = [];
  const unlaunched = [];
  const topLevel = all.filter((rel) => !rel.includes("/") && !isSpec(rel));
  for (const rel of topLevel) {
    const module = modules.get(rel);
    const named = /^probe-.*\.mjs$/.test(rel);
    if (launchesThroughRuntime(module.source)) {
      const literals = new Set(
        stringLiteralSpans(lf(module.source)).map((s) => s.content),
      );
      const base = rel.replace(/\.mjs$/, "");
      const stem = base.replace(/^probe-/, "");
      const linked = new Set();
      for (const rig of rigs) {
        if (
          literals.has(rig.id) ||
          rig.declaredBy.includes(base) ||
          rig.source.includes(rel) ||
          (named &&
            !rig.tags.includes("wave-end") &&
            (rig.id === stem || rig.id.startsWith(`${stem}-`)))
        ) {
          linked.add(rig.id);
        }
      }
      for (const target of module.imports) {
        const rig = rigByPath.get(target);
        if (rig !== undefined) {
          linked.add(rig.id);
        }
      }
      const specs = [...specReach.entries()]
        .filter(([, reach]) => reach.has(rel))
        .map(([spec]) => spec)
        .sort();
      runtime.push({
        path: rel,
        family: probeFamily(rel),
        purpose: module.purpose,
        status: module.status,
        rigs: [...linked].filter((id) => rigIds.has(id)).sort(),
        specs,
      });
    } else if (launchesBrowserByBehaviour(module.source)) {
      const exemption = fleetExemption(
        `Tools/visual-regression/${rel}`,
        module.source,
      );
      if (exemption === null) {
        direct.push({ path: rel, family: probeFamily(rel) });
      } else if (named) {
        unlaunched.push({
          path: rel,
          reason: `exempt from the live fleet: ${exemption}`,
        });
      }
    } else if (named) {
      unlaunched.push({ path: rel, reason: "no browser launch detected" });
    }
  }

  const archive = listModules(root, "archive", { recursive: false }).map(
    (rel) => {
      const header = parsePurposeHeader(
        fs.readFileSync(path.join(root, rel), "utf8"),
      );
      return { path: rel, family: probeFamily(rel), status: header.status };
    },
  );

  return {
    lib,
    metrics,
    rigs: rigs.map(({ source, ...rest }) => rest),
    probes: {
      topLevelNamed: topLevel.filter((rel) => /^probe-.*\.mjs$/.test(rel))
        .length,
      runtime,
      direct,
      unlaunched,
    },
    archive,
    archiveReadme: fs.existsSync(path.join(root, "archive", "README.md")),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** @param {string|null} text Cell text. @returns {string} Table-safe text. */
function cell(text) {
  return String(text ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} name A name. @returns {string} The name as a markdown code span. */
function codeSpan(name) {
  // A helper rather than a template nested in a template's hole: the fleet
  // contract's own tokenizer (lib/prohibited-reader-rule.mjs) reads a nested
  // template as an unterminated one and reports the file as unparseable.
  return `\`${name}\``;
}

/** @param {string[]} names Names. @returns {string} Code-span list, or `—`. */
function codeList(names) {
  return names.length === 0 ? "—" : names.map(codeSpan).join(", ");
}

/** @param {{purpose: string|null, status: string|null}} row A module row. @returns {string} Purpose cell. */
function purposeCell(row) {
  const purpose =
    row.purpose === null ? "(no `@purpose` header)" : cell(row.purpose);
  return row.status === null ||
    row.status === undefined ||
    row.status === "ACTIVE"
    ? purpose
    : `${purpose} (\`@status ${row.status}\`)`;
}

/** @param {object[]} rows Piece rows. @param {string} title Heading. @returns {string[]} Lines. */
function pieceTable(rows, title) {
  const lines = [
    `### ${title}`,
    "",
    "| piece | purpose | exports | scripts | specs | lib |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| \`${row.path}\` | ${purposeCell(row)} | ${codeList(row.exports)} | ${row.importers.scripts} | ${row.importers.specs} | ${row.importers.lib} |`,
    );
  }
  lines.push("");
  return lines;
}

/** @param {object} rig A rig row. @returns {string} Page cell. */
function pageCell(rig) {
  if (rig.page === null || rig.page === undefined) {
    return "none (`page: null`)";
  }
  return rig.pageKind === "url"
    ? `url \`${cell(rig.page)}\``
    : `\`${cell(rig.page)}\``;
}

/** @param {Map<string, number>} counts Count per key. @returns {[string, number][]} Sorted by count, then key. */
function byCount(counts) {
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
}

/**
 * Render the inventory as the body of the guide's generated region.
 *
 * @param {object} inventory From {@link collectInventory}.
 * @returns {string} Markdown, LF line endings, ending in a newline.
 */
export function renderInventory(inventory) {
  const { lib, metrics, rigs, probes, archive } = inventory;
  const lines = [
    "<!-- Generated by `node Tools/visual-regression/probe-kit-inventory.mjs --write migration_doc/PROBE_KIT_GUIDE.md`. Do not edit by hand: `--check` fails on drift. -->",
    "",
    "### Totals",
    "",
    "| what | count |",
    "| --- | --- |",
    `| kit pieces under \`lib/\` (outside \`lib/metrics/\`) | ${lib.length} |`,
    `| metrics under \`lib/metrics/\` | ${metrics.length} |`,
    `| rigs under \`rigs/\` | ${rigs.length} |`,
    `| top-level \`probe-*.mjs\` | ${probes.topLevelNamed} |`,
    `| top-level scripts on the runtime (\`runProbe\`) | ${probes.runtime.length} |`,
    `| top-level scripts launching a browser directly | ${probes.direct.length} |`,
    `| top-level \`probe-*.mjs\` that are exempt or launch nothing detectable | ${probes.unlaunched.length} |`,
    `| files under \`archive/\` | ${archive.length} |`,
    "",
  ];

  lines.push(...pieceTable(lib, "Kit pieces (`lib/`)"));
  lines.push(...pieceTable(metrics, "Metrics (`lib/metrics/`)"));

  lines.push("### Rigs by tag", "");
  const tags = [...new Set(rigs.flatMap((rig) => rig.tags))].sort();
  for (const tag of tags) {
    const tagged = rigs.filter((rig) => rig.tags.includes(tag));
    lines.push(
      `#### \`${tag}\` (${tagged.length})`,
      "",
      "| rig | renderers | page | purpose |",
      "| --- | --- | --- | --- |",
    );
    for (const rig of tagged) {
      lines.push(
        `| \`${rig.id}\` | ${rig.renderers.join(", ")} | ${pageCell(rig)} | ${purposeCell(rig)} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "### Probes on the runtime",
    "",
    "| probe | family | purpose | rigs | specs |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const probe of probes.runtime) {
    lines.push(
      `| \`${probe.path}\` | ${cell(probe.family)} | ${purposeCell(probe)} | ${codeList(probe.rigs)} | ${codeList(probe.specs)} |`,
    );
  }
  lines.push("");

  const families = new Map();
  for (const probe of probes.direct) {
    families.set(probe.family, (families.get(probe.family) ?? 0) + 1);
  }
  const ranked = byCount(families);
  const shown = ranked.filter(([, count]) => count >= FAMILY_ROW_MINIMUM);
  const folded = ranked.filter(([, count]) => count < FAMILY_ROW_MINIMUM);
  lines.push(
    "### Direct-launch scripts still outside the runtime",
    "",
    "List them with `node Tools/visual-regression/probe-kit-inventory.mjs --list-direct`.",
    "",
    "| family | scripts |",
    "| --- | --- |",
  );
  for (const [family, count] of shown) {
    lines.push(`| ${cell(family)} | ${count} |`);
  }
  if (folded.length > 0) {
    const total = folded.reduce((sum, [, count]) => sum + count, 0);
    lines.push(
      `| ${folded.length} other families, fewer than ${FAMILY_ROW_MINIMUM} each | ${total} |`,
    );
  }
  lines.push(`| total | ${probes.direct.length} |`, "");

  lines.push(
    "### Top-level probes that are exempt or launch nothing detectable",
    "",
    "| probe | why |",
    "| --- | --- |",
  );
  for (const probe of probes.unlaunched) {
    lines.push(`| \`${probe.path}\` | ${cell(probe.reason)} |`);
  }
  lines.push("");

  const archiveFamilies = new Map();
  const statuses = [
    ...new Set(archive.map((row) => row.status ?? "(none)")),
  ].sort();
  for (const row of archive) {
    const counts = archiveFamilies.get(row.family) ?? new Map();
    const status = row.status ?? "(none)";
    counts.set(status, (counts.get(status) ?? 0) + 1);
    archiveFamilies.set(row.family, counts);
  }
  lines.push(
    "### Archive",
    "",
    `| family | files | ${statuses.map(codeSpan).join(" | ")} |`,
    `| --- | --- | ${statuses.map(() => "---").join(" | ")} |`,
  );
  for (const family of [...archiveFamilies.keys()].sort()) {
    const counts = archiveFamilies.get(family);
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    lines.push(
      `| ${cell(family)} | ${total} | ${statuses.map((s) => counts.get(s) ?? 0).join(" | ")} |`,
    );
  }
  lines.push(
    `| total | ${archive.length} | ${statuses.map((s) => archive.filter((row) => (row.status ?? "(none)") === s).length).join(" | ")} |`,
    "",
  );

  return `${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// The guide's region
// ---------------------------------------------------------------------------

/**
 * The text between the two markers, LF-normalised, or null when the markers
 * are missing, duplicated or out of order.
 *
 * @param {string} guide Guide text.
 * @returns {string|null} Region body.
 */
export function extractRegion(guide) {
  const text = lf(guide);
  const begin = text.indexOf(REGION_BEGIN);
  const end = text.indexOf(REGION_END);
  if (
    begin < 0 ||
    end < 0 ||
    end < begin ||
    text.indexOf(REGION_BEGIN, begin + 1) >= 0 ||
    text.indexOf(REGION_END, end + 1) >= 0
  ) {
    return null;
  }
  return text.slice(begin + REGION_BEGIN.length, end).replace(/^\n/, "");
}

/**
 * Replace the region body, keeping everything outside it byte-for-byte and
 * writing the new body in the file's own line-ending style.
 *
 * @param {string} guide Guide text.
 * @param {string} body New region body (LF).
 * @returns {string|null} The new guide text, or null when the markers are unusable.
 */
export function replaceRegion(guide, body) {
  if (extractRegion(guide) === null) {
    return null;
  }
  const eol = guide.includes("\r\n") ? "\r\n" : "\n";
  const begin = guide.indexOf(REGION_BEGIN) + REGION_BEGIN.length;
  const end = guide.indexOf(REGION_END);
  return `${guide.slice(0, begin)}${eol}${body.replace(/\n/g, eol)}${guide.slice(end)}`;
}

/**
 * A short line diff between the guide's region and the generated one: lines
 * only in the guide (`-`) and lines only in the generation (`+`), each with
 * its multiplicity respected, in order of appearance.
 *
 * @param {string} actual Region body in the guide.
 * @param {string} expected Generated body.
 * @param {number} [limit] Lines printed per side.
 * @returns {string[]} Diff lines.
 */
export function regionDiff(actual, expected, limit = 40) {
  const count = (lines) => {
    const counts = new Map();
    for (const line of lines) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return counts;
  };
  const a = lf(actual).split("\n");
  const e = lf(expected).split("\n");
  const only = (lines, otherCounts) => {
    const remaining = new Map(otherCounts);
    const out = [];
    for (const line of lines) {
      const n = remaining.get(line) ?? 0;
      if (n > 0) {
        remaining.set(line, n - 1);
      } else {
        out.push(line);
      }
    }
    return out;
  };
  const removed = only(a, count(e));
  const added = only(e, count(a));
  const out = [];
  for (const line of removed.slice(0, limit)) {
    out.push(`- ${line}`);
  }
  if (removed.length > limit) {
    out.push(`- ... ${removed.length - limit} more`);
  }
  for (const line of added.slice(0, limit)) {
    out.push(`+ ${line}`);
  }
  if (added.length > limit) {
    out.push(`+ ... ${added.length - limit} more`);
  }
  if (out.length === 0 && a.join("\n") !== e.join("\n")) {
    // The multiset compare above cannot see a pure reordering.
    out.push("  (same lines, different order)");
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Run the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {{stdout?: Function, stderr?: Function}} [io] Output sinks.
 * @returns {Promise<number>} Exit code.
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  let root = DEFAULT_ROOT;
  let mode = "print";
  let guidePath = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" || arg === "--check" || arg === "--write") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        stderr(`${arg} requires a value\n`);
        return 2;
      }
      i++;
      if (arg === "--root") {
        root = path.resolve(value);
      } else {
        if (mode !== "print") {
          stderr("give one of --check, --write or --list-direct\n");
          return 2;
        }
        mode = arg.slice(2);
        guidePath = path.resolve(value);
      }
    } else if (arg === "--list-direct") {
      if (mode !== "print") {
        stderr("give one of --check, --write or --list-direct\n");
        return 2;
      }
      mode = "list-direct";
    } else {
      stderr(`unknown argument: ${arg}\n`);
      return 2;
    }
  }

  const inventory = await collectInventory({ root });
  if (mode === "list-direct") {
    stdout(inventory.probes.direct.map((probe) => `${probe.path}\n`).join(""));
    return 0;
  }
  const body = renderInventory(inventory);
  if (mode === "print") {
    stdout(body);
    return 0;
  }
  if (!fs.existsSync(guidePath)) {
    stderr(`${guidePath}: no such guide\n`);
    return 2;
  }
  const guide = fs.readFileSync(guidePath, "utf8");
  const region = extractRegion(guide);
  if (region === null) {
    stderr(
      `${guidePath}: needs exactly one ${REGION_BEGIN} followed by one ${REGION_END}\n`,
    );
    return 2;
  }
  if (mode === "write") {
    fs.writeFileSync(guidePath, replaceRegion(guide, body));
    stdout(`${path.basename(guidePath)}: inventory region written\n`);
    return 0;
  }
  if (region === body) {
    stdout(`${path.basename(guidePath)}: inventory region matches the tree\n`);
    return 0;
  }
  stderr(
    `${path.basename(guidePath)}: the inventory region has drifted from the tree; regenerate with --write\n${regionDiff(region, body).join("\n")}\n`,
  );
  return 1;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await main(process.argv.slice(2));
}
