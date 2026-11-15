// temp-root-census.mjs — where a tracked tool or spec builds a path directly
// under the system temp root.
// @purpose Static census of the tracked files under Tools/, scripts/, Specs/ and packages/*/Specs that build a path directly under os.tmpdir() (an mkdtemp sandbox, a fixed or computed name, a template or concatenated path) instead of taking it from Tools/lib/lane-tmp.mjs; temp-root-census.spec.mjs holds the result to a shrink-only allow-list.
// @status ACTIVE
//
// WHY THIS EXISTS. `Tools/lib/lane-tmp.mjs` puts every sandbox under one
// sweepable root per lane, `<tmp>/cesium-lane/<lane>`. A file that still calls
// `mkdtempSync(path.join(os.tmpdir(), prefix))` leaves its sandbox loose at the
// temp root when the run is killed, where nothing can tell it from another
// program's folder. This module finds those places so a spec can refuse new
// ones and keep the remaining ones visible by name.
//
// WHAT COUNTS AS A SITE. The source is parsed (TypeScript's parser, so a
// comment or a string that merely spells the call never counts). "The temp
// root" is a zero-argument `tmpdir()` call on any receiver or under any import
// alias, optionally wrapped in a one-argument `realpathSync`, `realpath`,
// `resolve` or `normalize`, or a variable whose initializer is exactly that
// (resolved lexically, so a `root` in one test does not taint a `root` in
// another). A site is one of:
//   mkdtemp-join      mkdtemp/mkdtempSync(join|resolve(<temp root>, ...))
//   mkdtemp-template  mkdtemp/mkdtempSync(`${<temp root>}...`)
//   mkdtemp-concat    mkdtemp/mkdtempSync(<temp root> + ...)
//   mkdtemp-bare-root mkdtemp/mkdtempSync(<temp root>)
//   mkdtemp-other     any other prefix that contains the temp root (a wrapper
//                     around the whole prefix, a conditional, an array join,
//                     a method called on the root)
//   join-fixed        join|resolve(<temp root>, "<name>", ...)
//   join-computed     join|resolve(<temp root>, <expression>, ...)
//   template-path     `...${<temp root>}/<name>...` (a path in a string)
//   concat-path       <temp root> + <more> outside an mkdtemp
// A join, template or concatenation whose first segment below the temp root is
// the lane namespace (`cesium-lane`, or the `LANE_TMP_NAMESPACE` export) is
// inside the sweepable root and is not a site; neither is `.` or `..`, nor a
// bare separator, when a path is all it is.
//
// INSIDE AN MKDTEMP there is no exemption. If the prefix argument contains the
// temp root anywhere in its expression (as defined above), the call is a site,
// whatever the form (the root first or not, a join or resolve, a template, a
// `+` chain, a wrapped prefix, a conditional, the root alone) and wherever the
// sandbox lands, the lane namespace included: a sandbox inside the namespace is
// taken from `Tools/lib/lane-tmp.mjs`, the one file exempt by name. The outermost
// form names the kind, and the call is one site: nothing inside its prefix is
// counted again, except an mkdtemp call inside it, which is its own site (the
// outer call counts only for a root outside the inner one). Only a reference to
// the root counts: not a property name, an object key, a declared name, a label
// or a type that spells the variable's name. Inside an mkdtemp prefix the census
// never misses a use of the root as a value, and where it cannot place a name it
// counts it (a false site costs a row or a rename; a missed sandbox is what the
// census exists to find).
//
// WHAT IT CANNOT SEE. A temp root handed as an argument to a helper that builds
// under it, a prefix that does not contain the root in its own text (a variable
// that holds a path, a helper's result), or one read from `process.env.TEMP`, is
// not followed, and an mkdtemp reached through an alias or a computed member
// (`const { mkdtempSync: make } = fs`, `fs["mkdtempSync"]`) is not seen; a new
// spelling of that kind needs a rule and a fixture here before it can be held.
// The calls read are `mkdtemp`, `mkdtempSync`, `mkdtempDisposable` and
// `mkdtempDisposableSync`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { LANE_TMP_NAMESPACE } from "./lane-tmp.mjs";

/** The one file allowed to build under the temp root: the lane helper itself. */
export const LANE_TMP_MODULE = "Tools/lib/lane-tmp.mjs";

/** Top-level folders the census reads (packages only as `packages/<name>/Specs`). */
export const CENSUS_ROOTS = Object.freeze([
  "Tools",
  "scripts",
  "Specs",
  "packages",
]);

const SOURCE_EXTENSION = /\.(?:mjs|cjs|js|mts|cts|ts)$/u;
const TYPESCRIPT_EXTENSION = /\.(?:mts|cts|ts)$/u;
const MKDTEMP_CALLS = new Set([
  "mkdtemp",
  "mkdtempSync",
  "mkdtempDisposable",
  "mkdtempDisposableSync",
]);
const PATH_BUILDERS = new Set(["join", "resolve"]);
const ROOT_WRAPPERS = new Set([
  "realpathSync",
  "realpath",
  "resolve",
  "normalize",
]);

/**
 * True when `file` (repo-relative, forward slashes) is one the census reads.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isCensusPath(file) {
  if (!SOURCE_EXTENSION.test(file) || file.includes("/node_modules/")) {
    return false;
  }
  if (/^(?:Tools|scripts|Specs)\//u.test(file)) {
    return true;
  }
  return /^packages\/[^/]+\/Specs\//u.test(file);
}

/**
 * Tracked files the census reads. Untracked and ignored files never count.
 *
 * @param {string} root Repository root.
 * @param {{env?: object}} [options]
 * @returns {string[]}
 */
export function listCensusFiles(root, options = {}) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "-z", "--", ...CENSUS_ROOTS],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return output.split("\0").filter(Boolean).filter(isCensusPath).sort();
}

function unwrap(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function calleeName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function isScopeNode(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCaseBlock(node) ||
    ts.isFunctionLike(node)
  );
}

function scopeOf(node) {
  let current = node.parent;
  while (current !== undefined && !isScopeNode(current)) {
    current = current.parent;
  }
  return current ?? node.getSourceFile();
}

function firstSegment(text) {
  const parts = text.split(/[\\/]+/u).filter((part) => part.length > 0);
  return parts.length === 0 ? "" : parts[0];
}

function isNamedChild(segment) {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    segment !== LANE_TMP_NAMESPACE
  );
}

/**
 * Every site in one source text.
 *
 * @param {string} source File text.
 * @param {string} [fileName] Used for the script kind only.
 * @returns {{line: number, kind: string, text: string}[]}
 */
export function findTempRootSites(source, fileName = "file.mjs") {
  if (!/tmpdir/u.test(source)) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    TYPESCRIPT_EXTENSION.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );

  // Local names that call the temp-root function: `tmpdir`, plus any import or
  // destructuring alias of it.
  const tmpdirNames = new Set(["tmpdir"]);
  // Every identifier declaration, so an alias resolves lexically.
  const declarations = [];
  const collect = (node) => {
    if (
      (ts.isImportSpecifier(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const imported = node.propertyName ?? node.name;
      if (ts.isIdentifier(imported) && imported.text === "tmpdir") {
        tmpdirNames.add(node.name.text);
      }
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name)
    ) {
      declarations.push({
        name: node.name.text,
        initializer: ts.isVariableDeclaration(node)
          ? node.initializer
          : undefined,
        scope: scopeOf(node),
        alias: false,
      });
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const resolveDeclaration = (identifier) => {
    let best = null;
    for (const declaration of declarations) {
      if (declaration.name !== identifier.text) continue;
      const { scope } = declaration;
      if (identifier.pos < scope.pos || identifier.end > scope.end) continue;
      if (
        best === null ||
        scope.end - scope.pos < best.scope.end - best.scope.pos
      ) {
        best = declaration;
      }
    }
    return best;
  };

  const isTempRoot = (node) => {
    const target = unwrap(node);
    if (ts.isCallExpression(target)) {
      const name = calleeName(target);
      if (target.arguments.length === 0) {
        if (ts.isIdentifier(target.expression)) {
          return tmpdirNames.has(target.expression.text);
        }
        return name === "tmpdir";
      }
      if (ROOT_WRAPPERS.has(name) && target.arguments.length === 1) {
        return isTempRoot(target.arguments[0]);
      }
      return false;
    }
    if (ts.isIdentifier(target)) {
      const declaration = resolveDeclaration(target);
      return declaration !== null && declaration.alias;
    }
    return false;
  };

  // Aliases of aliases resolve in a few passes; the bound only guards a cycle.
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const declaration of declarations) {
      if (declaration.alias || declaration.initializer === undefined) continue;
      if (isTempRoot(declaration.initializer)) {
        declaration.alias = true;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const segmentArgumentIsChild = (argument) => {
    const target = unwrap(argument);
    if (
      ts.isStringLiteral(target) ||
      ts.isNoSubstitutionTemplateLiteral(target)
    ) {
      return isNamedChild(firstSegment(target.text));
    }
    if (ts.isTemplateExpression(target)) {
      const head = firstSegment(target.head.text);
      return head === "" || isNamedChild(head);
    }
    if (ts.isIdentifier(target) && target.text === "LANE_TMP_NAMESPACE") {
      return false;
    }
    if (
      ts.isPropertyAccessExpression(target) &&
      target.name.text === "LANE_TMP_NAMESPACE"
    ) {
      return false;
    }
    return true;
  };

  const isRootJoin = (node) =>
    ts.isCallExpression(node) &&
    PATH_BUILDERS.has(calleeName(node)) &&
    node.arguments.length >= 2 &&
    isTempRoot(node.arguments[0]) &&
    segmentArgumentIsChild(node.arguments[1]);

  // What follows the temp root in a template or a `+` chain, as text: a
  // literal is itself, `path.sep` / `sep` is "/", anything else is COMPUTED.
  // It names a child only when it starts with a separator and the first
  // segment after it is a name (a computed one counts) that is not the lane
  // namespace. `root + path.sep` alone, or `(tmpdir ${root})` in a message,
  // names nothing.
  const COMPUTED = "\u0000";
  const partText = (node) => {
    const target = unwrap(node);
    if (
      ts.isStringLiteral(target) ||
      ts.isNoSubstitutionTemplateLiteral(target)
    ) {
      return target.text;
    }
    if (
      (ts.isIdentifier(target) && target.text === "sep") ||
      (ts.isPropertyAccessExpression(target) && target.name.text === "sep")
    ) {
      return "/";
    }
    if (
      (ts.isIdentifier(target) && target.text === "LANE_TMP_NAMESPACE") ||
      (ts.isPropertyAccessExpression(target) &&
        target.name.text === "LANE_TMP_NAMESPACE")
    ) {
      return LANE_TMP_NAMESPACE;
    }
    return COMPUTED;
  };
  const restNamesChild = (rest) => {
    if (!/^[\\/]/u.test(rest)) return false;
    const segment = rest.replace(/^[\\/]+/u, "").split(/[\\/]/u)[0];
    if (segment.startsWith(COMPUTED)) return true;
    return isNamedChild(segment.split(COMPUTED)[0]);
  };

  const templateChild = (template) => {
    const spans = template.templateSpans;
    for (let index = 0; index < spans.length; index += 1) {
      if (!isTempRoot(spans[index].expression)) continue;
      let rest = spans[index].literal.text;
      for (const later of spans.slice(index + 1)) {
        rest += partText(later.expression) + later.literal.text;
      }
      if (restNamesChild(rest)) return true;
    }
    return false;
  };

  const plusOperands = (node) => {
    const target = unwrap(node);
    if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      return [...plusOperands(target.left), ...plusOperands(target.right)];
    }
    return [target];
  };

  const concatChild = (node) => {
    const operands = plusOperands(node);
    for (let index = 0; index < operands.length - 1; index += 1) {
      if (!isTempRoot(operands[index])) continue;
      const rest = operands
        .slice(index + 1)
        .map(partText)
        .join("");
      if (restNamesChild(rest)) return true;
    }
    return false;
  };

  const isPlus = (node) =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken;

  const sites = [];
  const consumed = new Set();
  const record = (node, kind) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    sites.push({
      line: line + 1,
      kind,
      text: node.getText(sourceFile).replace(/\s+/gu, " ").slice(0, 120),
    });
  };

  // INSIDE AN MKDTEMP there is no exemption: if the prefix argument contains the
  // temp root anywhere in its expression, the call is a site, whatever the form
  // and wherever the sandbox lands. The outermost form names the kind: a join
  // or resolve call, a template, a `+` chain, the root alone; any other form
  // (a wrapper around the whole prefix, a conditional, an array join, a method
  // called on the root) takes `mkdtemp-other`.
  // Only a reference counts: a name after a dot (`opts.root`), a key before a
  // colon (`{ root: 1 }`), a declared name or a label that spells the root
  // variable's name is not the root; a shorthand property (`{ root }`) is. An
  // mkdtemp call inside the prefix is its own site and is not looked into: the
  // outer call counts only for a root outside it.
  const isMkdtempCall = (node) =>
    ts.isCallExpression(node) &&
    MKDTEMP_CALLS.has(calleeName(node)) &&
    node.arguments.length >= 1;

  const isNotReference = (identifier) => {
    const parent = identifier.parent;
    if (parent === undefined || ts.isShorthandPropertyAssignment(parent)) {
      return false;
    }
    return (
      parent.name === identifier ||
      parent.propertyName === identifier ||
      parent.label === identifier
    );
  };

  // A type is never looked into (a type reference, a type argument, a type
  // query and everything below them): the compiler's own `isTypeNode`, but for
  // an instantiation expression, whose expression part is a value.
  const isTypeOnly = (node) =>
    ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node);

  const containsTempRoot = (node) => {
    if (isMkdtempCall(node)) return false;
    if (ts.isIdentifier(node) && isNotReference(node)) return false;
    return (
      isTempRoot(node) ||
      ts.forEachChild(
        node,
        (child) => !isTypeOnly(child) && containsTempRoot(child),
      ) === true
    );
  };

  const mkdtempPrefixKind = (prefix) => {
    if (!containsTempRoot(prefix)) return null;
    if (isTempRoot(prefix)) return "mkdtemp-bare-root";
    if (ts.isCallExpression(prefix) && PATH_BUILDERS.has(calleeName(prefix))) {
      return "mkdtemp-join";
    }
    if (ts.isTemplateExpression(prefix)) return "mkdtemp-template";
    if (isPlus(prefix)) return "mkdtemp-concat";
    return "mkdtemp-other";
  };

  // Nothing inside a counted prefix is counted again: one site per call.
  // A nested mkdtemp call is left for its own visit.
  const markConsumed = (node) => {
    if (isMkdtempCall(node)) return;
    consumed.add(node);
    ts.forEachChild(node, markConsumed);
  };

  const visit = (node) => {
    if (ts.isCallExpression(node) && !consumed.has(node)) {
      if (isMkdtempCall(node)) {
        const prefix = unwrap(node.arguments[0]);
        const kind = mkdtempPrefixKind(prefix);
        if (kind !== null) {
          record(node, kind);
          markConsumed(node.arguments[0]);
        }
      } else if (isRootJoin(node)) {
        const segment = unwrap(node.arguments[1]);
        const fixed =
          ts.isStringLiteral(segment) ||
          ts.isNoSubstitutionTemplateLiteral(segment) ||
          ts.isTemplateExpression(segment);
        record(node, fixed ? "join-fixed" : "join-computed");
      }
    } else if (
      ts.isTemplateExpression(node) &&
      !consumed.has(node) &&
      templateChild(node)
    ) {
      record(node, "template-path");
    } else if (
      isPlus(node) &&
      !consumed.has(node) &&
      !isPlus(node.parent) &&
      concatChild(node)
    ) {
      record(node, "concat-path");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites.sort((a, b) => a.line - b.line);
}

/**
 * Run the census over a file list.
 *
 * @param {{root: string, files?: string[], readFile?: (file: string) => string}} options
 * @returns {{file: string, sites: {line: number, kind: string, text: string}[]}[]}
 *   Files with at least one site, sorted; the lane helper is never listed.
 */
export function runTempRootCensus(options) {
  const { root } = options;
  const files = options.files ?? listCensusFiles(root);
  const readFile =
    options.readFile ??
    ((file) => fs.readFileSync(path.join(root, ...file.split("/")), "utf8"));
  const offenders = [];
  for (const file of files) {
    if (file === LANE_TMP_MODULE) continue;
    let source;
    try {
      source = readFile(file);
    } catch {
      continue;
    }
    const sites = findTempRootSites(source, file);
    if (sites.length > 0) {
      offenders.push({ file, sites });
    }
  }
  return offenders.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
}

/**
 * Compare a census with an allow-list of `{file: {sites, reason}}` rows.
 *
 * @param {ReturnType<typeof runTempRootCensus>} census
 * @param {Record<string, {sites: number, reason: string}>} allowlist
 * @param {{isTracked: (file: string) => boolean}} options
 * @returns {{unlisted: string[], gone: string[], clean: string[], drift: string[], badRows: string[]}}
 *   Each entry is one human-readable line; all five empty means the census agrees.
 */
export function compareWithAllowlist(census, allowlist, options) {
  const found = new Map(census.map((entry) => [entry.file, entry.sites]));
  const result = { unlisted: [], gone: [], clean: [], drift: [], badRows: [] };
  for (const [file, sites] of found) {
    if (!Object.hasOwn(allowlist, file)) {
      result.unlisted.push(
        `${file}: ${sites.map((site) => `${site.line} ${site.kind}`).join(", ")}`,
      );
    }
  }
  for (const [file, row] of Object.entries(allowlist)) {
    const reason = row?.reason;
    if (
      typeof reason !== "string" ||
      reason.trim().length === 0 ||
      /[\r\n]/u.test(reason) ||
      !Number.isInteger(row?.sites) ||
      row.sites < 1
    ) {
      result.badRows.push(
        `${file}: a row needs a positive integer site count and a one-line reason`,
      );
    }
    if (file === LANE_TMP_MODULE) {
      result.badRows.push(`${file}: the lane helper needs no row`);
      continue;
    }
    if (!options.isTracked(file)) {
      result.gone.push(`${file}: no tracked file of that name`);
      continue;
    }
    const sites = found.get(file);
    if (sites === undefined) {
      result.clean.push(`${file}: no temp-root site left; delete its row`);
      continue;
    }
    if (sites.length !== row.sites) {
      result.drift.push(
        `${file}: the row says ${row.sites} site(s), the file has ${sites.length} (${sites
          .map((site) => site.line)
          .join(
            ", ",
          )}); ${sites.length > row.sites ? "a new site is an offence: move it to Tools/lib/lane-tmp.mjs" : "lower the row to the new count"}`,
      );
    }
  }
  return result;
}

/**
 * One message naming every disagreement, or "" when there is none.
 *
 * @param {ReturnType<typeof compareWithAllowlist>} comparison
 * @returns {string}
 */
export function describeDisagreement(comparison) {
  const sections = [
    [
      "builds a path directly under the system temp root and has no allow-list row (take the sandbox from Tools/lib/lane-tmp.mjs instead)",
      comparison.unlisted,
    ],
    ["allow-list row names a file that is gone", comparison.gone],
    ["allow-list row names a file that no longer does it", comparison.clean],
    ["allow-list row's site count is not the file's", comparison.drift],
    ["malformed allow-list row", comparison.badRows],
  ];
  return sections
    .filter(([, lines]) => lines.length > 0)
    .map(([title, lines]) => `${title}:\n  ${lines.join("\n  ")}`)
    .join("\n");
}
