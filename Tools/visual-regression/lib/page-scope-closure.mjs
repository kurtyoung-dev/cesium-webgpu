// page-scope-closure.mjs — the rule that a page callback carries no Node closure.
// @purpose Source-text analyzer finding bindings referenced inside a page.evaluate-family callback but declared outside it; fails closed on anything it cannot parse.
// @status ACTIVE
//
// WHY THIS EXISTS. `page.evaluate(fn)` does not send `fn` — it sends
// `fn.toString()`. The page re-parses that text in a realm holding none of the
// Node module's bindings, so a callback referencing one raises `ReferenceError`
// on the first line that reaches it. There is no warning, no partial result and
// no degraded mode: the probe dies where it stood.
//
// The rule was already written down. `lib/same-task-capture.mjs` explains it at
// length, `DEBUGGING_GUIDE` carries it as doctrine, and it was re-derived on the
// 2026-07-25 instrument-defect day. It was still violated on 2026-08-24 by
// `probe-eclipse-cloud-response.mjs`, which imported
// `describeRefreshCostLedgerClosure` at module scope and called it inside
// `RUN_IBL_SWEEP` — a callback handed to `page.evaluate`. The probe's OWN header
// comment stated the rule two thousand lines above the call that broke it, and
// the 161-test gate spec was green over the unreachable path because its
// coverage of the call site was substring counting.
//
// Prose in three files did not stop it. This module is the enforceable home:
// `probe-fleet-contract.spec.mjs` runs it over the population the F4
// prohibited-reader rule already uses — the probes AND `lib/`, because a shared
// harness can fan one leak out to every probe that imports it.
//
// WHAT COUNTS AS A LEAK. A reference inside the callback resolving to a binding
// declared OUTSIDE the callback's own scope chain: module scope, or an
// enclosing function scope. Three things deliberately do NOT count:
//
//   - A reference resolving to nothing. That is a browser or Node global
//     (`window`, `document`, `performance`); the page supplies its own.
//   - A named function expression referring to ITSELF. Playwright re-parses the
//     text as a function expression, so the name is bound again in the page.
//   - A first argument that is TEXT rather than a function. Shipping source text
//     is the prescribed fix, not the defect — `DET_BROWSER_SETUP` and the
//     `same-task-capture` blocks are the fleet's correct form.
//
// DETECTOR DISCIPLINE, inherited from `probe-fleet-contract.mjs`. Every path
// fails CLOSED. A file that will not parse is reported as a violation, not
// skipped. A callback passed by a name this module cannot resolve to a literal
// function is reported in `unresolvedCallbacks` rather than quietly dropped, so
// the spec can refuse a fleet the analyzer has stopped understanding. A
// detector that cannot detect is the failure this repo has paid for repeatedly.
//
// WHY ACORN AND A HAND-WRITTEN SCOPE WALKER. `acorn` is already the parser of
// record in this directory (`same-task-capture`, `weather-capture-doctrine`,
// `c12-29-s5-replacement-device-capture`, `celestial-capture-harness.spec`).
// `eslint-scope` would have supplied the scope analysis for free, but it is
// imported by no tracked file and declared in no manifest — it is reachable
// only as a transitive dependency of ESLint. Binding a fleet guard to a
// transitive is how a guard stops running after an unrelated upgrade, so the
// scope resolution below is written out. It was differentially tested against
// an `eslint-scope` implementation across the whole tree before landing.
//
// @module page-scope-closure

import { parse } from "acorn";

/** Playwright methods whose first argument is evaluated IN THE PAGE. */
export const EVAL_FAMILY_METHODS = Object.freeze([
  "evaluate",
  "evaluateHandle",
  "addInitScript",
  "waitForFunction",
  "exposeFunction",
  "exposeBinding",
  "$eval",
  "$$eval",
]);

const EVAL_FAMILY = new Set(EVAL_FAMILY_METHODS);

/**
 * Receiver names that are a Playwright page/frame/context by convention.
 *
 * This is the FALLBACK. The primary test is dataflow — a name assigned from
 * `newPage()` / `newContext()` — because the fleet aliases pages as `p`, `dp`
 * and `page2`, and a name-only heuristic silently drops those call sites.
 */
const PAGE_LIKE_NAME =
  /^(?:page|frame|popup|worker|context|browserContext|ctx)$/u;

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "parent"]);

const isFunction = (node) => Boolean(node) && FUNCTION_TYPES.has(node.type);

/**
 * Visit every AST node, depth first, passing each node's parent.
 *
 * @param {object} node Root.
 * @param {object|null} parent Parent of `node`.
 * @param {(node: object, parent: object|null) => (boolean|void)} visitor
 *   Return false to skip the subtree.
 * @returns {void}
 */
function walk(node, parent, visitor) {
  if (!node || typeof node.type !== "string") {
    return;
  }
  if (visitor(node, parent) === false) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child, node, visitor);
      }
    } else if (value && typeof value.type === "string") {
      walk(value, node, visitor);
    }
  }
}

/**
 * Collect the identifier NODES a binding pattern declares.
 *
 * Returned as nodes rather than names so the reference pass can skip them by
 * identity: an identifier that IS a declaration target is never a reference,
 * and deciding that from parent shape alone is where these walkers
 * historically go wrong.
 *
 * @param {object} pattern Any binding pattern.
 * @param {object[]} out Accumulator.
 * @returns {object[]} `out`.
 */
function patternIdentifiers(pattern, out = []) {
  if (!pattern || typeof pattern.type !== "string") {
    return out;
  }
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          patternIdentifiers(property.argument, out);
        } else {
          patternIdentifiers(property.value, out);
        }
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        patternIdentifiers(element, out);
      }
      break;
    case "AssignmentPattern":
      // Only the target binds. The default is an expression evaluated in the
      // scope being declared, so it is a REFERENCE and must not be skipped.
      patternIdentifiers(pattern.left, out);
      break;
    case "RestElement":
      patternIdentifiers(pattern.argument, out);
      break;
    default:
      break;
  }
  return out;
}

function makeScope(node, parent, type) {
  return { node, parent, type, declared: new Map(), children: [] };
}

/** The nearest scope `var` and function declarations hoist to. */
function varScope(scope) {
  let current = scope;
  while (current && current.type === "block") {
    current = current.parent;
  }
  return current ?? scope;
}

function declareIn(scope, identifier, kind) {
  if (identifier && !scope.declared.has(identifier.name)) {
    scope.declared.set(identifier.name, { node: identifier, kind });
  }
}

/**
 * Build the scope tree, note every declaration with its kind, and record each
 * identifier reference against the scope it was written in.
 *
 * @param {object} ast Acorn Program node.
 * @returns {{moduleScope: object, references: object[], scopeOf: Map<object, object>}}
 *   The analysis.
 */
function buildScopes(ast) {
  const moduleScope = makeScope(ast, null, "module");
  const scopeOf = new Map();
  const declarationNodes = new Set();
  const collected = [];

  // Pass A — scopes and declarations. References are only COLLECTED here;
  // resolving them before every declaration is known would miss hoisting.
  const visit = (node, parent, scope) => {
    if (!node || typeof node.type !== "string") {
      return;
    }
    let inner = scope;

    if (isFunction(node)) {
      if (node.type === "FunctionExpression" && node.id) {
        // A named function expression binds its own name in a scope of its own,
        // which is why self-reference survives serialization into the page.
        inner = makeScope(node, scope, "function-expression-name");
        scope.children.push(inner);
        declareIn(inner, node.id, "function-expression-name");
        declarationNodes.add(node.id);
      }
      const fnScope = makeScope(node, inner, "function");
      inner.children.push(fnScope);
      scopeOf.set(node, fnScope);
      if (node.type === "FunctionDeclaration" && node.id) {
        declareIn(varScope(scope), node.id, "function");
        declarationNodes.add(node.id);
      }
      for (const param of node.params) {
        for (const identifier of patternIdentifiers(param)) {
          declareIn(fnScope, identifier, "param");
          declarationNodes.add(identifier);
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key) || key === "id") {
          continue;
        }
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) {
          visit(child, node, fnScope);
        }
      }
      return;
    }

    if (
      node.type === "BlockStatement" ||
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement" ||
      node.type === "SwitchStatement" ||
      node.type === "StaticBlock"
    ) {
      inner = makeScope(node, scope, "block");
      scope.children.push(inner);
    }

    if (node.type === "CatchClause") {
      inner = makeScope(node, scope, "block");
      scope.children.push(inner);
      for (const identifier of patternIdentifiers(node.param)) {
        declareIn(inner, identifier, "catch");
        declarationNodes.add(identifier);
      }
    }

    if (node.type === "ClassDeclaration" && node.id) {
      declareIn(scope, node.id, "class");
      declarationNodes.add(node.id);
    }
    if (node.type === "ClassExpression" && node.id) {
      declarationNodes.add(node.id);
    }

    if (node.type === "VariableDeclaration") {
      const target = node.kind === "var" ? varScope(inner) : inner;
      for (const declarator of node.declarations) {
        for (const identifier of patternIdentifiers(declarator.id)) {
          declareIn(target, identifier, node.kind);
          declarationNodes.add(identifier);
        }
      }
    }

    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        declareIn(moduleScope, specifier.local, "import");
        declarationNodes.add(specifier.local);
        if (specifier.imported && specifier.imported.type === "Identifier") {
          declarationNodes.add(specifier.imported);
        }
      }
    }
    if (node.type === "ExportSpecifier") {
      declarationNodes.add(node.exported);
    }

    if (node.type === "Identifier") {
      collected.push({ node, scope: inner, parent });
      return;
    }
    if (node.type === "MetaProperty" || node.type === "PrivateIdentifier") {
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) {
        continue;
      }
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        visit(child, node, inner);
      }
    }
  };

  visit(ast, null, moduleScope);

  // Pass B — keep only identifiers that are genuinely value references.
  const references = [];
  for (const entry of collected) {
    if (declarationNodes.has(entry.node)) {
      continue;
    }
    const { parent } = entry;
    if (!parent) {
      continue;
    }
    if (
      parent.type === "MemberExpression" &&
      parent.property === entry.node &&
      !parent.computed
    ) {
      continue;
    }
    // For a shorthand property acorn emits DISTINCT key and value nodes over
    // the same range; the value carries the reference, so the key is dropped
    // whether the property is a pattern target or an expression.
    if (
      parent.type === "Property" &&
      parent.key === entry.node &&
      !parent.computed
    ) {
      continue;
    }
    if (
      (parent.type === "MethodDefinition" ||
        parent.type === "PropertyDefinition") &&
      parent.key === entry.node &&
      !parent.computed
    ) {
      continue;
    }
    if (
      parent.type === "LabeledStatement" ||
      parent.type === "BreakStatement" ||
      parent.type === "ContinueStatement"
    ) {
      continue;
    }
    references.push(entry);
  }
  return { moduleScope, references, scopeOf };
}

/** Resolve `name` from `scope` outwards. */
function resolve(scope, name) {
  for (let current = scope; current; current = current.parent) {
    if (current.declared.has(name)) {
      return current;
    }
  }
  return null;
}

function receiverText(node) {
  if (!node) {
    return "?";
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "ThisExpression") {
    return "this";
  }
  if (node.type === "AwaitExpression") {
    return receiverText(node.argument);
  }
  if (node.type === "CallExpression") {
    return `${receiverText(node.callee)}()`;
  }
  if (node.type === "MemberExpression") {
    return node.computed
      ? `${receiverText(node.object)}[]`
      : `${receiverText(node.object)}.${node.property.name}`;
  }
  return node.type;
}

/**
 * Names in this module assigned a Playwright page or context.
 *
 * @param {object} ast Program node.
 * @returns {Set<string>} Page-like names.
 */
function pageBindings(ast) {
  const names = new Set();
  walk(ast, null, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") {
      return;
    }
    let init = node.init;
    if (init && init.type === "AwaitExpression") {
      init = init.argument;
    }
    if (!init || init.type !== "CallExpression") {
      return;
    }
    const callee = init.callee;
    if (callee.type !== "MemberExpression" || callee.computed) {
      return;
    }
    const method = callee.property.name;
    if (method === "newPage" || method === "newContext") {
      names.add(node.id.name);
    }
  });
  return names;
}

function isPageLike(node, names) {
  const last = receiverText(node).split(".").pop().split("(")[0].split("[")[0];
  return PAGE_LIKE_NAME.test(last) || names.has(last);
}

function parseModule(source) {
  return parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
    ranges: true,
    allowHashBang: true,
  });
}

/**
 * Bounded cache of parsed imported modules, keyed by source TEXT.
 *
 * `errorGateInit` alone is shipped into the page by roughly seventy probes, so
 * without this the same shared module is parsed once per importing probe.
 */
const IMPORTED_ANALYSIS_CACHE = new Map();
const IMPORTED_ANALYSIS_CACHE_LIMIT = 64;

function analyzeImportedModule(source) {
  const hit = IMPORTED_ANALYSIS_CACHE.get(source);
  if (hit) {
    return hit;
  }
  let entry;
  try {
    const ast = parseModule(source);
    entry = { ast, analysis: buildScopes(ast), error: null };
  } catch (error) {
    entry = { ast: null, analysis: null, error };
  }
  if (IMPORTED_ANALYSIS_CACHE.size >= IMPORTED_ANALYSIS_CACHE_LIMIT) {
    IMPORTED_ANALYSIS_CACHE.delete(IMPORTED_ANALYSIS_CACHE.keys().next().value);
  }
  IMPORTED_ANALYSIS_CACHE.set(source, entry);
  return entry;
}

function importSourceFor(ast, name) {
  let specifier = null;
  walk(ast, null, (node) => {
    if (node.type !== "ImportDeclaration") {
      return;
    }
    for (const entry of node.specifiers) {
      if (entry.local.name === name) {
        specifier = node.source.value;
      }
    }
  });
  return specifier;
}

/** Whether a declaration's initializer is source TEXT — the prescribed form. */
function initializerIsText(ast, declarationIdentifier) {
  let text = false;
  const isTextExpression = (node) => {
    if (!node) {
      return false;
    }
    if (node.type === "TemplateLiteral") {
      return true;
    }
    if (node.type === "Literal") {
      return typeof node.value === "string";
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      return isTextExpression(node.left) || isTextExpression(node.right);
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      return (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.name === "join"
      );
    }
    return false;
  };
  walk(ast, null, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id === declarationIdentifier
    ) {
      text = isTextExpression(node.init);
      return false;
    }
    return undefined;
  });
  return text;
}

/** The literal function a declaration identifier names, if any. */
function literalFunctionFor(ast, declarationIdentifier) {
  let found = null;
  walk(ast, null, (node) => {
    if (found) {
      return false;
    }
    if (
      node.type === "FunctionDeclaration" &&
      node.id === declarationIdentifier
    ) {
      found = node;
      return false;
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id === declarationIdentifier &&
      isFunction(node.init)
    ) {
      found = node.init;
      return false;
    }
    return undefined;
  });
  return found;
}

/**
 * Analyze one module for page-scope closure leaks.
 *
 * @param {string} source Module source text; line endings may be CRLF.
 * @param {object} [options] Options.
 * @param {string} [options.path] Label used in messages.
 * @param {(specifier: string) => (string|null)} [options.readImport]
 *   Resolve a RELATIVE import specifier to source text so a callback defined in
 *   another module is analyzed in ITS OWN scope. Without it, such callbacks are
 *   reported as unresolved rather than passing silently.
 * @returns {{findings: object[], violations: string[], unresolvedCallbacks: string[], evalSites: number, parsed: boolean}}
 *   The analysis.
 */
export function analyzePageScopeClosures(source, options = {}) {
  const label = options.path ?? "<source>";
  const readImport = options.readImport ?? null;
  const text = String(source ?? "")
    .split("\r\n")
    .join("\n");
  const findings = [];
  const unresolvedCallbacks = [];
  // Conservative prefilter: a module that never NAMES an eval-family method
  // cannot ship a callback into a page, so it need not be parsed. The test is
  // the bare name anywhere in the text — a mention inside a comment is enough
  // to keep the file — so this cannot skip a real call site. `evalSites` is the
  // canary: if a rename ever made the whole fleet skippable that count would
  // collapse to zero, and the spec refuses a fleet with no call sites at all.
  if (!EVAL_FAMILY_METHODS.some((method) => text.includes(method))) {
    return {
      findings,
      violations: [],
      unresolvedCallbacks,
      evalSites: 0,
      parsed: true,
      skipped: true,
    };
  }
  let ast;
  try {
    ast = parseModule(text);
  } catch (error) {
    // Fail CLOSED: an unparseable file is a hole in the guard, not a pass.
    return {
      findings,
      violations: [`${label}: source could not be parsed (${error.message})`],
      unresolvedCallbacks,
      evalSites: 0,
      parsed: false,
      skipped: false,
    };
  }

  const local = buildScopes(ast);
  const names = pageBindings(ast);
  const scopeOfIdentifier = new Map();
  for (const reference of local.references) {
    scopeOfIdentifier.set(reference.node, reference.scope);
  }

  // A helper whose parameter goes straight to an eval-family call makes every
  // call to that helper an eval site too. One hop covers the fleet's
  // `const apply = (fn) => page.evaluate(fn)` shape without turning this into a
  // whole-program taint analysis.
  const forwarders = new Map();
  walk(ast, null, (node, parent) => {
    if (!isFunction(node)) {
      return;
    }
    const params = node.params.map((p) =>
      p.type === "Identifier" ? p.name : null,
    );
    if (!params.some(Boolean)) {
      return;
    }
    let index = -1;
    walk(node.body, node, (inner) => {
      if (inner.type !== "CallExpression") {
        return;
      }
      const callee = inner.callee;
      if (callee.type !== "MemberExpression" || callee.computed) {
        return;
      }
      if (!EVAL_FAMILY.has(callee.property.name)) {
        return;
      }
      if (!isPageLike(callee.object, names)) {
        return;
      }
      const first = inner.arguments[0];
      if (first && first.type === "Identifier") {
        const at = params.indexOf(first.name);
        if (at >= 0) {
          index = at;
        }
      }
    });
    if (index < 0) {
      return;
    }
    let name = null;
    if (node.type === "FunctionDeclaration" && node.id) {
      name = node.id.name;
    } else if (
      parent &&
      parent.type === "VariableDeclarator" &&
      parent.id.type === "Identifier"
    ) {
      name = parent.id.name;
    }
    if (name) {
      forwarders.set(name, index);
    }
  });

  const targets = [];
  const addTarget = (argument, site, via) => {
    if (!argument) {
      return;
    }
    if (isFunction(argument)) {
      targets.push({ analysis: local, fn: argument, site, via });
      return;
    }
    if (argument.type !== "Identifier") {
      // A template literal, a string, or an expression this module does not
      // model. Text is the prescribed form, not a closure.
      return;
    }
    const owner = resolve(
      scopeOfIdentifier.get(argument) ?? local.moduleScope,
      argument.name,
    );
    const binding = owner ? owner.declared.get(argument.name) : null;
    if (!binding) {
      return;
    }
    if (binding.kind === "param") {
      // The value arrives at the call site; the forwarder pass analyzes it
      // there, where the actual callback is known.
      return;
    }
    if (binding.kind === "import") {
      const specifier = importSourceFor(ast, argument.name);
      const imported =
        specifier && specifier.startsWith(".") && readImport
          ? readImport(specifier)
          : null;
      if (typeof imported !== "string") {
        unresolvedCallbacks.push(
          `${label}:${site} ${via}(${argument.name}) — imported callback source was not available`,
        );
        return;
      }
      const importedEntry = analyzeImportedModule(
        String(imported).split("\r\n").join("\n"),
      );
      if (importedEntry.error) {
        unresolvedCallbacks.push(
          `${label}:${site} ${via}(${argument.name}) — imported module did not parse (${importedEntry.error.message})`,
        );
        return;
      }
      const importedAst = importedEntry.ast;
      const importedAnalysis = importedEntry.analysis;
      const importedBinding = importedAnalysis.moduleScope.declared.get(
        argument.name,
      );
      const fn = importedBinding
        ? literalFunctionFor(importedAst, importedBinding.node)
        : null;
      if (!fn) {
        if (
          importedBinding &&
          initializerIsText(importedAst, importedBinding.node)
        ) {
          return;
        }
        unresolvedCallbacks.push(
          `${label}:${site} ${via}(${argument.name}) — imported binding is not a literal function`,
        );
        return;
      }
      targets.push({
        analysis: importedAnalysis,
        fn,
        site,
        via: `${via}->${argument.name}`,
      });
      return;
    }
    const fn = literalFunctionFor(ast, binding.node);
    if (fn) {
      targets.push({
        analysis: local,
        fn,
        site,
        via: `${via}->${argument.name}`,
      });
      return;
    }
    if (initializerIsText(ast, binding.node)) {
      return;
    }
    unresolvedCallbacks.push(
      `${label}:${site} ${via}(${argument.name}) — callback binding is neither a literal function nor source text`,
    );
  };

  let evalSites = 0;
  walk(ast, null, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = node.callee;
    const site = node.loc.start.line;
    if (callee.type === "MemberExpression" && !callee.computed) {
      const method = callee.property.name;
      if (EVAL_FAMILY.has(method)) {
        if (!isPageLike(callee.object, names)) {
          return;
        }
        evalSites += 1;
        addTarget(node.arguments[0], site, method);
        return;
      }
    }
    if (callee.type === "Identifier" && forwarders.has(callee.name)) {
      evalSites += 1;
      addTarget(
        node.arguments[forwarders.get(callee.name)],
        site,
        `${callee.name}(forwarded)`,
      );
    }
  });

  const seen = new Set();
  for (const target of targets) {
    const key = `${target.analysis.moduleScope.node.start}#${target.fn.start}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const callbackScope = target.analysis.scopeOf.get(target.fn);
    if (!callbackScope) {
      continue;
    }
    const inside = new Set();
    const mark = (scope) => {
      inside.add(scope);
      for (const child of scope.children) {
        mark(child);
      }
    };
    mark(callbackScope);
    const reported = new Set();
    for (const reference of target.analysis.references) {
      if (!inside.has(reference.scope)) {
        continue;
      }
      const owner = resolve(reference.scope, reference.node.name);
      if (!owner || inside.has(owner)) {
        continue;
      }
      if (owner.type === "function-expression-name") {
        continue;
      }
      const seenKey = `${reference.node.name}@${reference.node.loc.start.line}`;
      if (reported.has(seenKey)) {
        continue;
      }
      reported.add(seenKey);
      const binding = owner.declared.get(reference.node.name);
      findings.push({
        name: reference.node.name,
        line: reference.node.loc.start.line,
        column: reference.node.loc.start.column,
        declaredLine: binding ? binding.node.loc.start.line : null,
        declaredKind: binding ? binding.kind : null,
        declaredIn: owner.type,
        via: target.via,
        site: target.site,
        crossModule: target.analysis !== local,
      });
    }
  }

  findings.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  const violations = findings.map(
    (finding) =>
      `${label}:${finding.line} references \`${finding.name}\` (declared at :${finding.declaredLine} in ${finding.declaredIn} scope) inside the callback shipped by ${finding.via} at :${finding.site}`,
  );
  return {
    findings,
    violations,
    unresolvedCallbacks,
    evalSites,
    parsed: true,
    skipped: false,
  };
}

/**
 * Convenience wrapper for callers that only need the messages.
 *
 * @param {string} source Module source text.
 * @param {object} [options] Same options as {@link analyzePageScopeClosures}.
 * @returns {string[]} Violations; empty means the module is clean.
 */
export function pageScopeClosureViolations(source, options = {}) {
  return analyzePageScopeClosures(source, options).violations;
}

export default {
  EVAL_FAMILY_METHODS,
  analyzePageScopeClosures,
  pageScopeClosureViolations,
};
