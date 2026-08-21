// weather-capture-doctrine.mjs — fail-closed static capture analysis shared by weather/eclipses specs.
// @purpose Census weather-pin consumers and prove awaited immutable capture, live-canvas exclusion, and same-origin metric/documentary use through aliases and aggregates.
// @status ACTIVE

import { parse } from "acorn";

export const WEATHER_CAPTURE_FAILURE = Object.freeze({
  ANALYSIS_NONCONVERGENT: "analysis-nonconvergent",
  ASYNC_CAPTURE_MISSING: "async-capture-missing",
  CANONICAL_HELPER_GUARD_MISSING: "canonical-helper-guard-missing",
  CANONICAL_IMPORT_MISSING: "canonical-import-missing",
  CANONICAL_INSTALLER_MISSING: "canonical-installer-missing",
  CAPTURE_ORDER: "capture-order",
  CONSUMER_LIVE_READ: "consumer-live-read",
  CONSUMER_RENDER: "consumer-render",
  DECODE_BEFORE_FREEZE: "decode-before-freeze",
  DOCUMENTARY_BYTE_SOURCE: "documentary-byte-source",
  DOCUMENTARY_ORIGIN_MISMATCH: "documentary-origin-mismatch",
  HELPER_LIVE_READ: "helper-live-read",
  METRIC_DECODE_SOURCE: "metric-decode-source",
  NO_CAPTURE: "no-capture",
  PARSE_ERROR: "parse-error",
  PINNED_RENDER_BYPASS: "pinned-render-bypass",
  SNAPSHOT_LIVE_REREAD: "snapshot-live-reread",
  SNAPSHOT_ORDER: "snapshot-order",
  UNAWAITED_CAPTURE: "unawaited-capture",
  UNSUPPORTED_CAPTURE_ESCAPE: "unsupported-capture-escape",
  UNTRACKED_CONSUMER: "untracked-consumer",
  UNRESOLVED_CAPTURE_IMPORT: "unresolved-capture-import",
  UNTRUSTED_INTRINSIC: "untrusted-intrinsic",
});

const WEATHER_PINNING_SUFFIX = "/weather-probe-pinning.mjs";
const WEATHER_PINNING_RELATIVE = "./lib/weather-probe-pinning.mjs";
const CAPTURE_INSTALLER = "installWeatherPinHarnessOnPage";

const LIVE_READ_METHODS = new Set([
  "copyTextureToBuffer",
  "createImageBitmap",
  "drawImage",
  "getCurrentTexture",
  "getImageData",
  "readPixels",
  "screenshot",
  "toBlob",
  "toDataURL",
  "transferToImageBitmap",
]);
const RENDER_METHODS = new Set(["render"]);
const PROMISE_CHAIN_METHODS = new Set(["catch", "finally", "then"]);
const CAPTURE_METRIC_REDUCERS = new Set([
  "bandMean",
  "brightFraction",
  "deckPercent",
  "groundBand",
  "skyBand",
]);
const PIXEL_FIELDS = new Set(["data", "height", "width"]);
const AST_METADATA = new Set(["end", "loc", "range", "start", "type"]);
const importInspectionCache = new Map();
const consumerAnalysisCache = new Map();

const makeFailure = (code, message, relative, node) => ({
  code,
  line: node?.loc?.start.line ?? null,
  message,
  relative,
});

export const formatWeatherCaptureFailures = (failures) =>
  failures
    .map((entry) => {
      const where = entry.relative
        ? `${entry.relative}${entry.line ? `:${entry.line}` : ""}: `
        : "";
      return `[${entry.code}] ${where}${entry.message}`;
    })
    .join("\n");

const parseModule = (source) =>
  parse(source, {
    allowAwaitOutsideFunction: true,
    ecmaVersion: "latest",
    locations: true,
    sourceType: "module",
  });

const walkAst = (node, parent, visitor) => {
  if (!node || typeof node !== "object") {
    return;
  }
  if (visitor(node, parent) === false) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (AST_METADATA.has(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walkAst(child, node, visitor);
      }
    } else {
      walkAst(value, node, visitor);
    }
  }
};

const isFunctionNode = (node) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionDeclaration" ||
  node?.type === "FunctionExpression";

const unwrapExpression = (expression) => {
  let node = expression;
  while (
    node?.type === "AwaitExpression" ||
    node?.type === "ChainExpression" ||
    node?.type === "ParenthesizedExpression"
  ) {
    node = node.type === "ChainExpression" ? node.expression : node.argument;
  }
  return node;
};

const isWeatherPinningSpecifier = (value) =>
  value === WEATHER_PINNING_RELATIVE ||
  value?.replaceAll("\\", "/").endsWith(WEATHER_PINNING_SUFFIX);

export const inspectWeatherCaptureConsumerImport = (source) => {
  const cached = importInspectionCache.get(source);
  if (cached) {
    return cached;
  }
  let ast;
  try {
    ast = parseModule(source);
  } catch (error) {
    const result = {
      consumes: false,
      failures: [
        makeFailure(
          WEATHER_CAPTURE_FAILURE.PARSE_ERROR,
          `capture census could not parse source: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      ],
      modes: [],
    };
    importInspectionCache.set(source, result);
    return result;
  }

  const lexical = createLexicalModel(ast);
  const parents = new WeakMap();
  const nodes = [];
  walkAst(ast, undefined, (node, parent) => {
    nodes.push(node);
    if (parent) {
      parents.set(node, parent);
    }
  });

  const dynamicImportIsConsumerRelevant = (importExpression) => {
    const raw = source.slice(
      importExpression.source.start,
      importExpression.source.end,
    );
    if (/weather|pinning|installWeatherPinHarnessOnPage/u.test(raw)) {
      return true;
    }

    let value = importExpression;
    let parent = parents.get(value);
    while (
      parent &&
      ((parent.type === "AwaitExpression" && parent.argument === value) ||
        (parent.type === "ChainExpression" && parent.expression === value) ||
        (parent.type === "ParenthesizedExpression" &&
          parent.expression === value))
    ) {
      value = parent;
      parent = parents.get(value);
    }
    if (parent?.type === "VariableDeclarator" && parent.init === value) {
      if (parent.id.type === "ObjectPattern") {
        return parent.id.properties.some(
          (property) =>
            property.type === "Property" &&
            (property.computed
              ? lexical.staticValue(property.key).value
              : (property.key.name ?? property.key.value)) ===
              "installWeatherPinHarnessOnPage",
        );
      }
      const bindingKey = lexical.refKey(parent.id);
      if (bindingKey) {
        return nodes.some(
          (node) =>
            node.type === "MemberExpression" &&
            lexical.refKey(node.object) === bindingKey &&
            lexical.staticProperty(node) === "installWeatherPinHarnessOnPage",
        );
      }
    }
    return false;
  };

  const modes = new Set();
  const failures = [];
  for (const node of nodes) {
    if (
      node.type === "ImportDeclaration" &&
      isWeatherPinningSpecifier(node.source.value)
    ) {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          modes.add("namespace");
        } else if (
          specifier.type === "ImportSpecifier" &&
          (specifier.imported.name ?? specifier.imported.value) ===
            CAPTURE_INSTALLER
        ) {
          modes.add("named");
        }
      }
    } else if (node.type === "ImportExpression") {
      const specifier = lexical.staticValue(node.source);
      if (
        specifier.known &&
        typeof specifier.value === "string" &&
        isWeatherPinningSpecifier(specifier.value)
      ) {
        modes.add("dynamic");
      } else if (!specifier.known && dynamicImportIsConsumerRelevant(node)) {
        modes.add("dynamic-unresolved");
        failures.push(
          makeFailure(
            WEATHER_CAPTURE_FAILURE.UNRESOLVED_CAPTURE_IMPORT,
            "a capture-relevant dynamic import cannot be resolved statically",
            undefined,
            node,
          ),
        );
      }
    }
  }
  const result = {
    consumes: modes.size > 0,
    failures,
    modes: [...modes].sort(),
  };
  importInspectionCache.set(source, result);
  return result;
};

export const censusWeatherCaptureConsumers = (candidateSources) => {
  const consumers = {};
  const failures = [];
  const modes = {};
  for (const [relative, source] of Object.entries(candidateSources).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const inspected = inspectWeatherCaptureConsumerImport(source);
    for (const entry of inspected.failures) {
      failures.push({ ...entry, relative });
    }
    if (inspected.consumes) {
      consumers[relative] = source;
      modes[relative] = inspected.modes;
    }
  }
  return {
    consumers: Object.freeze(consumers),
    failures,
    modes: Object.freeze(modes),
    paths: Object.freeze(Object.keys(consumers)),
  };
};

const createLexicalModel = (ast) => {
  let nextScopeId = 0;
  let nextBindingId = 0;
  const scopeForNode = new WeakMap();
  const bindingForDeclaration = new WeakMap();
  const initializerForBinding = new Map();

  const makeScope = (parent, kind) => ({
    bindings: new Map(),
    id: nextScopeId++,
    kind,
    parent,
  });
  const rootScope = makeScope(undefined, "program");

  const declareIdentifier = (identifier, scope, kind, initializer) => {
    if (identifier?.type !== "Identifier") {
      return;
    }
    let binding = scope.bindings.get(identifier.name);
    if (!binding) {
      binding = {
        id: nextBindingId++,
        kind,
        name: identifier.name,
        scope,
      };
      scope.bindings.set(identifier.name, binding);
    }
    bindingForDeclaration.set(identifier, binding);
    if (
      kind === "const" &&
      initializer &&
      !initializerForBinding.has(binding)
    ) {
      initializerForBinding.set(binding, initializer);
    }
  };

  const nearestVarScope = (scope) => {
    let candidate = scope;
    while (candidate.kind !== "function" && candidate.kind !== "program") {
      candidate = candidate.parent;
    }
    return candidate;
  };

  const declarePattern = (pattern, scope, kind, initializer) => {
    if (!pattern) {
      return;
    }
    if (pattern.type === "Identifier") {
      declareIdentifier(pattern, scope, kind, initializer);
    } else if (pattern.type === "AssignmentPattern") {
      declarePattern(pattern.left, scope, kind);
    } else if (pattern.type === "RestElement") {
      declarePattern(pattern.argument, scope, kind);
    } else if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements) {
        declarePattern(element, scope, kind);
      }
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        if (property.type === "Property") {
          declarePattern(property.value, scope, kind);
        } else if (property.type === "RestElement") {
          declarePattern(property.argument, scope, kind);
        }
      }
    }
  };

  const genericVisit = (node, scope, visit) => {
    for (const [key, value] of Object.entries(node)) {
      if (AST_METADATA.has(key)) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          visit(child, scope);
        }
      } else {
        visit(value, scope);
      }
    }
  };

  const visit = (node, scope) => {
    if (!node || typeof node !== "object") {
      return;
    }
    scopeForNode.set(node, scope);
    if (node.type === "Program") {
      for (const statement of node.body) {
        visit(statement, scope);
      }
      return;
    }
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        declareIdentifier(specifier.local, scope, "import");
        scopeForNode.set(specifier, scope);
        scopeForNode.set(specifier.local, scope);
      }
      visit(node.source, scope);
      return;
    }
    if (node.type === "VariableDeclaration") {
      const declarationScope =
        node.kind === "var" ? nearestVarScope(scope) : scope;
      for (const declarator of node.declarations) {
        scopeForNode.set(declarator, scope);
        declarePattern(
          declarator.id,
          declarationScope,
          node.kind,
          declarator.id.type === "Identifier" ? declarator.init : undefined,
        );
        visit(declarator.id, scope);
        visit(declarator.init, scope);
      }
      return;
    }
    if (node.type === "FunctionDeclaration") {
      declareIdentifier(node.id, scope, "function", node);
      const functionScope = makeScope(scope, "function");
      scopeForNode.set(node.id, scope);
      for (const parameter of node.params) {
        declarePattern(parameter, functionScope, "parameter");
        visit(parameter, functionScope);
      }
      visit(node.body, functionScope);
      return;
    }
    if (
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      const functionScope = makeScope(scope, "function");
      if (node.id) {
        declareIdentifier(node.id, functionScope, "function", node);
        scopeForNode.set(node.id, functionScope);
      }
      for (const parameter of node.params) {
        declarePattern(parameter, functionScope, "parameter");
        visit(parameter, functionScope);
      }
      visit(node.body, functionScope);
      return;
    }
    if (node.type === "BlockStatement") {
      const blockScope = makeScope(scope, "block");
      for (const statement of node.body) {
        visit(statement, blockScope);
      }
      return;
    }
    if (node.type === "CatchClause") {
      const catchScope = makeScope(scope, "block");
      declarePattern(node.param, catchScope, "catch");
      visit(node.param, catchScope);
      visit(node.body, catchScope);
      return;
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.type === "ClassDeclaration") {
        declareIdentifier(node.id, scope, "class", node);
      }
      genericVisit(node, scope, visit);
      return;
    }
    genericVisit(node, scope, visit);
  };
  visit(ast, rootScope);

  const resolveIdentifier = (identifier) => {
    const declared = bindingForDeclaration.get(identifier);
    if (declared) {
      return declared;
    }
    let scope = scopeForNode.get(identifier) ?? rootScope;
    while (scope) {
      const binding = scope.bindings.get(identifier.name);
      if (binding) {
        return binding;
      }
      scope = scope.parent;
    }
    return { id: `global:${identifier.name}`, name: identifier.name };
  };

  const staticValue = (expression, seen = new Set()) => {
    const node = unwrapExpression(expression);
    if (!node) {
      return { known: false };
    }
    if (node.type === "Literal") {
      return { known: true, value: node.value };
    }
    if (node.type === "TemplateLiteral") {
      let value = node.quasis[0]?.value.cooked ?? "";
      for (const [index, expression] of node.expressions.entries()) {
        const part = staticValue(expression, seen);
        if (!part.known) {
          return { known: false };
        }
        value += String(part.value);
        value += node.quasis[index + 1]?.value.cooked ?? "";
      }
      return { known: true, value };
    }
    if (node.type === "SequenceExpression") {
      return staticValue(node.expressions.at(-1), seen);
    }
    if (node.type === "Identifier") {
      const binding = resolveIdentifier(node);
      if (seen.has(binding)) {
        return { known: false };
      }
      const initializer = initializerForBinding.get(binding);
      if (!initializer) {
        return { known: false };
      }
      const nextSeen = new Set(seen);
      nextSeen.add(binding);
      return staticValue(initializer, nextSeen);
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = staticValue(node.left, seen);
      const right = staticValue(node.right, seen);
      if (left.known && right.known) {
        return { known: true, value: left.value + right.value };
      }
    }
    if (node.type === "UnaryExpression") {
      const argument = staticValue(node.argument, seen);
      if (argument.known) {
        if (node.operator === "+") {
          return { known: true, value: +argument.value };
        }
        if (node.operator === "-") {
          return { known: true, value: -argument.value };
        }
      }
    }
    if (node.type === "ConditionalExpression") {
      const consequent = staticValue(node.consequent, seen);
      const alternate = staticValue(node.alternate, seen);
      if (
        consequent.known &&
        alternate.known &&
        Object.is(consequent.value, alternate.value)
      ) {
        return consequent;
      }
    }
    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "URL" &&
      resolveIdentifier(node.callee).id === "global:URL"
    ) {
      const relative = staticValue(node.arguments[0], seen);
      if (relative.known && typeof relative.value === "string") {
        return relative;
      }
    }
    return { known: false };
  };

  const staticProperty = (member) => {
    if (member?.type !== "MemberExpression") {
      return undefined;
    }
    if (!member.computed && member.property.type === "Identifier") {
      return member.property.name;
    }
    const value = staticValue(member.property);
    return value.known && ["number", "string"].includes(typeof value.value)
      ? String(value.value)
      : undefined;
  };

  const memberKey = (base, property) => `${base}/${JSON.stringify(property)}`;
  const refKey = (expression) => {
    const node = unwrapExpression(expression);
    if (node?.type === "SequenceExpression") {
      return refKey(node.expressions.at(-1));
    }
    if (node?.type === "Identifier") {
      return `binding:${resolveIdentifier(node).id}`;
    }
    if (node?.type === "ThisExpression") {
      let scope = scopeForNode.get(node);
      while (scope?.kind !== "function" && scope?.kind !== "program") {
        scope = scope.parent;
      }
      return `this:${scope?.id ?? "global"}`;
    }
    if (node?.type !== "MemberExpression") {
      return undefined;
    }
    const base = refKey(node.object);
    const property = staticProperty(node);
    return base && property !== undefined
      ? memberKey(base, property)
      : undefined;
  };

  return {
    bindingForDeclaration,
    initializerForBinding,
    memberKey,
    refKey,
    resolveIdentifier,
    scopeForNode,
    staticProperty,
    staticValue,
  };
};

const emptyFacts = () => ({
  bypass: new Set(),
  callable: false,
  classes: new Set(),
  containedBypass: new Set(),
  containedCallable: false,
  containedClasses: new Set(),
  containedFunctions: new Set(),
  containedInstances: new Set(),
  containedObjects: new Set(),
  containedProvenance: new Map(),
  functions: new Set(),
  instances: new Set(),
  objects: new Set(),
  provenance: new Map(),
});

const addSet = (target, value) => {
  const before = target.size;
  target.add(value);
  return target.size !== before;
};

const mergeProvenance = (target, incoming) => {
  let changed = false;
  for (const [origin, kinds] of incoming) {
    let targetKinds = target.get(origin);
    if (!targetKinds) {
      targetKinds = new Set();
      target.set(origin, targetKinds);
      changed = true;
    }
    for (const kind of kinds) {
      changed = addSet(targetKinds, kind) || changed;
    }
  }
  return changed;
};

const mergeFacts = (target, incoming) => {
  let changed = false;
  if (incoming.callable && !target.callable) {
    target.callable = true;
    changed = true;
  }
  if (incoming.containedCallable && !target.containedCallable) {
    target.containedCallable = true;
    changed = true;
  }
  for (const kind of incoming.bypass) {
    changed = addSet(target.bypass, kind) || changed;
  }
  for (const klass of incoming.classes) {
    changed = addSet(target.classes, klass) || changed;
  }
  for (const kind of incoming.containedBypass) {
    changed = addSet(target.containedBypass, kind) || changed;
  }
  for (const klass of incoming.containedClasses) {
    changed = addSet(target.containedClasses, klass) || changed;
  }
  for (const fn of incoming.containedFunctions) {
    changed = addSet(target.containedFunctions, fn) || changed;
  }
  for (const instance of incoming.containedInstances) {
    changed = addSet(target.containedInstances, instance) || changed;
  }
  for (const kind of incoming.containedObjects) {
    changed = addSet(target.containedObjects, kind) || changed;
  }
  for (const fn of incoming.functions) {
    changed = addSet(target.functions, fn) || changed;
  }
  for (const instance of incoming.instances) {
    changed = addSet(target.instances, instance) || changed;
  }
  for (const kind of incoming.objects) {
    changed = addSet(target.objects, kind) || changed;
  }
  changed = mergeProvenance(target.provenance, incoming.provenance) || changed;
  changed =
    mergeProvenance(target.containedProvenance, incoming.containedProvenance) ||
    changed;
  return changed;
};

const cloneFacts = (incoming) => {
  const cloned = emptyFacts();
  mergeFacts(cloned, incoming);
  return cloned;
};

const provenanceAs = (incoming, kind) => {
  const mapped = new Map();
  for (const origin of incoming.keys()) {
    mapped.set(origin, new Set([kind]));
  }
  return mapped;
};

const containsNonPixelProvenance = (facts) => {
  for (const provenance of [facts.provenance, facts.containedProvenance]) {
    for (const kinds of provenance.values()) {
      if ([...kinds].some((kind) => kind !== "pixels")) {
        return true;
      }
    }
  }
  return false;
};

const factsContainSensitiveValue = (facts) =>
  facts.callable ||
  facts.containedCallable ||
  facts.bypass.size > 0 ||
  facts.containedBypass.size > 0 ||
  facts.provenance.size > 0 ||
  facts.containedProvenance.size > 0 ||
  facts.objects.has("weather-pin") ||
  facts.objects.has("scene") ||
  facts.objects.has("live-canvas") ||
  facts.objects.has("canvas-context") ||
  facts.containedObjects.has("weather-pin") ||
  facts.containedObjects.has("scene") ||
  facts.containedObjects.has("live-canvas") ||
  facts.containedObjects.has("canvas-context");

const provenanceOriginsOfKind = (facts, wantedKind) => {
  const origins = new Set();
  for (const provenance of [facts.provenance, facts.containedProvenance]) {
    for (const [origin, kinds] of provenance) {
      if (kinds.has(wantedKind)) {
        origins.add(origin);
      }
    }
  }
  return origins;
};

const nodeLabel = (source, node) =>
  node?.start === undefined || node?.end === undefined
    ? "capture callable"
    : source.slice(node.start, node.end).replaceAll(/\s+/gu, " ").slice(0, 100);

const isPropertyRead = (node, parent) =>
  !(
    (parent?.type === "AssignmentExpression" && parent.left === node) ||
    (parent?.type === "UnaryExpression" &&
      parent.operator === "delete" &&
      parent.argument === node) ||
    (parent?.type === "UpdateExpression" && parent.argument === node)
  );

const isTransparentSequenceValue = (sequence, value) =>
  sequence.type === "SequenceExpression" &&
  sequence.expressions.at(-1) === value;

const isWeatherPinRoot = (node, lexical) => {
  const member = unwrapExpression(node);
  if (member?.type !== "MemberExpression") {
    return false;
  }
  if (lexical.staticProperty(member) !== "__weatherPin") {
    return false;
  }
  const object = unwrapExpression(member.object);
  return (
    object?.type === "Identifier" &&
    (object.name === "globalThis" || object.name === "window")
  );
};

const isPageEvaluateCall = (node, lexical) =>
  node?.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  lexical.staticProperty(node.callee) === "evaluate";

const syntacticPath = (expression, lexical) => {
  const node = unwrapExpression(expression);
  if (node?.type === "Identifier") {
    return [node.name];
  }
  if (node?.type !== "MemberExpression") {
    return undefined;
  }
  const object = syntacticPath(node.object, lexical);
  const property = lexical.staticProperty(node);
  return object && property !== undefined ? [...object, property] : undefined;
};

const pathEndsWith = (path, expected) =>
  path &&
  path.length >= expected.length &&
  expected.every(
    (part, index) => path[path.length - expected.length + index] === part,
  );

const trustedIntrinsicPath = (expression, lexical, expected) => {
  const path = syntacticPath(expression, lexical);
  if (!pathEndsWith(path, expected) || path.length !== expected.length) {
    return false;
  }
  let root = unwrapExpression(expression);
  while (root?.type === "MemberExpression") {
    root = unwrapExpression(root.object);
  }
  return (
    root?.type === "Identifier" &&
    lexical.resolveIdentifier(root).id === `global:${expected[0]}`
  );
};

const isPromiseAllCall = (node, lexical) =>
  node?.type === "CallExpression" &&
  trustedIntrinsicPath(node.callee, lexical, ["Promise", "all"]);

const createConsumerAnalyzer = (ast, source, relative) => {
  const lexical = createLexicalModel(ast);
  const parents = new WeakMap();
  const functions = [];
  const calls = [];
  const members = [];
  walkAst(ast, undefined, (node, parent) => {
    if (parent) {
      parents.set(node, parent);
    }
    if (isFunctionNode(node)) {
      functions.push(node);
    } else if (node.type === "CallExpression") {
      calls.push(node);
    } else if (node.type === "MemberExpression") {
      members.push(node);
    }
  });

  const factsByReference = new Map();
  const functionSummaries = new Map(
    functions.map((fn) => [
      fn,
      {
        bypass: new Set(),
        capture: false,
        documentaryParameters: new Set(),
        metricParameters: new Set(),
        returnFacts: emptyFacts(),
      },
    ]),
  );
  const originNodes = new Map();

  const factsAtReference = (key) =>
    key && factsByReference.has(key) ? factsByReference.get(key) : emptyFacts();

  const putReferenceFacts = (key, incoming) => {
    if (!key) {
      return false;
    }
    let current = factsByReference.get(key);
    if (!current) {
      current = emptyFacts();
      factsByReference.set(key, current);
    }
    return mergeFacts(current, incoming);
  };

  const copyReferenceDescendants = (targetKey, sourceKey) => {
    if (!targetKey || !sourceKey || targetKey === sourceKey) {
      return false;
    }
    let changed = false;
    const prefix = `${sourceKey}/`;
    for (const [key, facts] of [...factsByReference]) {
      if (key.startsWith(prefix)) {
        changed =
          putReferenceFacts(
            `${targetKey}${key.slice(sourceKey.length)}`,
            facts,
          ) || changed;
      }
    }
    return changed;
  };

  const originFor = (call) => {
    const origin = `${relative}:${call.loc?.start.line ?? "?"}:${call.start}`;
    originNodes.set(origin, call);
    return origin;
  };

  const captureFactsFor = (call) => {
    const facts = emptyFacts();
    facts.provenance.set(originFor(call), new Set(["frame"]));
    return facts;
  };

  const aggregateFacts = (values) => {
    const aggregate = emptyFacts();
    for (const value of values) {
      const facts = factsOfExpression(value);
      aggregate.containedCallable =
        aggregate.containedCallable ||
        facts.callable ||
        facts.containedCallable;
      for (const bypass of [...facts.bypass, ...facts.containedBypass]) {
        aggregate.containedBypass.add(bypass);
      }
      for (const klass of [...facts.classes, ...facts.containedClasses]) {
        aggregate.containedClasses.add(klass);
      }
      for (const fn of [...facts.functions, ...facts.containedFunctions]) {
        aggregate.containedFunctions.add(fn);
      }
      for (const instance of [
        ...facts.instances,
        ...facts.containedInstances,
      ]) {
        aggregate.containedInstances.add(instance);
      }
      for (const kind of [...facts.objects, ...facts.containedObjects]) {
        aggregate.containedObjects.add(kind);
      }
      mergeProvenance(aggregate.containedProvenance, facts.provenance);
      mergeProvenance(aggregate.containedProvenance, facts.containedProvenance);
    }
    return aggregate;
  };

  const aggregateFactsFromFacts = (...values) => {
    const aggregate = emptyFacts();
    for (const facts of values) {
      aggregate.containedCallable =
        aggregate.containedCallable ||
        facts.callable ||
        facts.containedCallable;
      for (const bypass of [...facts.bypass, ...facts.containedBypass]) {
        aggregate.containedBypass.add(bypass);
      }
      for (const klass of [...facts.classes, ...facts.containedClasses]) {
        aggregate.containedClasses.add(klass);
      }
      for (const fn of [...facts.functions, ...facts.containedFunctions]) {
        aggregate.containedFunctions.add(fn);
      }
      for (const instance of [
        ...facts.instances,
        ...facts.containedInstances,
      ]) {
        aggregate.containedInstances.add(instance);
      }
      for (const kind of [...facts.objects, ...facts.containedObjects]) {
        aggregate.containedObjects.add(kind);
      }
      mergeProvenance(aggregate.containedProvenance, facts.provenance);
      mergeProvenance(aggregate.containedProvenance, facts.containedProvenance);
    }
    return aggregate;
  };

  const extractedAggregateFacts = (facts) => {
    const extracted = emptyFacts();
    extracted.callable = facts.containedCallable;
    for (const bypass of facts.containedBypass) {
      extracted.bypass.add(bypass);
    }
    for (const klass of facts.containedClasses) {
      extracted.classes.add(klass);
    }
    for (const fn of facts.containedFunctions) {
      extracted.functions.add(fn);
    }
    for (const instance of facts.containedInstances) {
      extracted.instances.add(instance);
    }
    for (const kind of facts.containedObjects) {
      extracted.objects.add(kind);
    }
    mergeProvenance(extracted.provenance, facts.containedProvenance);
    return extracted;
  };

  const objectLiteralProperty = (object, property) => {
    if (object?.type === "ArrayExpression" && /^\d+$/u.test(property)) {
      return object.elements[Number(property)];
    }
    if (object?.type !== "ObjectExpression") {
      return undefined;
    }
    for (const entry of object.properties) {
      if (entry.type !== "Property") {
        continue;
      }
      const key = entry.computed
        ? lexical.staticValue(entry.key)
        : {
            known: true,
            value:
              entry.key.type === "Identifier"
                ? entry.key.name
                : entry.key.value,
          };
      if (key.known && String(key.value) === property) {
        return entry.value;
      }
    }
    return undefined;
  };

  const classMethod = (klass, property) => {
    for (const definition of klass?.body?.body ?? []) {
      if (definition.type !== "MethodDefinition") {
        continue;
      }
      const key = definition.computed
        ? lexical.staticValue(definition.key)
        : {
            known: true,
            value: definition.key.name ?? definition.key.value,
          };
      if (key.known && String(key.value) === property) {
        return definition.value;
      }
    }
    return undefined;
  };

  const factsForProperty = (objectExpression, property) => {
    const object = unwrapExpression(objectExpression);
    const literalProperty = objectLiteralProperty(object, property);
    if (literalProperty) {
      return factsOfExpression(literalProperty);
    }

    const facts = emptyFacts();
    const objectKey = lexical.refKey(object);
    if (objectKey) {
      mergeFacts(
        facts,
        factsAtReference(lexical.memberKey(objectKey, property)),
      );
    }
    const base = factsOfExpression(object);
    for (const klass of base.instances) {
      const method = classMethod(klass, property);
      if (method) {
        mergeFacts(facts, factsOfExpression(method));
      }
    }
    if (property === "capture" && base.objects.has("weather-pin")) {
      facts.callable = true;
    }
    if (property === "scene") {
      facts.objects.add("scene");
    } else if (property === "viewer") {
      facts.objects.add("viewer");
    } else if (
      property === "canvas" &&
      (base.objects.has("scene") || base.objects.has("viewer"))
    ) {
      facts.objects.add("live-canvas");
    }
    if (LIVE_READ_METHODS.has(property) || RENDER_METHODS.has(property)) {
      facts.bypass.add(property);
    }
    if (base.provenance.size > 0) {
      const baseIsPixelData = [...base.provenance.values()].some((kinds) =>
        kinds.has("pixels"),
      );
      const kind =
        property === "png"
          ? "png"
          : PIXEL_FIELDS.has(property) || baseIsPixelData
            ? "pixels"
            : "metadata";
      mergeProvenance(facts.provenance, provenanceAs(base.provenance, kind));
    }
    return facts;
  };

  const directPinCallee = (callee) => {
    let node = unwrapExpression(callee);
    if (node?.type === "SequenceExpression") {
      node = unwrapExpression(node.expressions.at(-1));
    }
    return (
      node?.type === "MemberExpression" &&
      lexical.staticProperty(node) === "capture" &&
      factsOfExpression(node.object).objects.has("weather-pin")
    );
  };

  const classifyCall = (call) => {
    const result = {
      bypass: new Set(),
      capture: false,
      directPin: false,
      target: nodeLabel(source, call.callee),
    };
    const callee = unwrapExpression(call.callee);
    const memberName =
      callee?.type === "MemberExpression"
        ? lexical.staticProperty(callee)
        : undefined;
    const identifierName =
      callee?.type === "Identifier" ? callee.name : undefined;

    if (LIVE_READ_METHODS.has(memberName ?? identifierName)) {
      result.bypass.add(memberName ?? identifierName);
    } else if (RENDER_METHODS.has(memberName ?? identifierName)) {
      result.bypass.add(memberName ?? identifierName);
    }

    if (
      trustedIntrinsicPath(callee, lexical, ["Reflect", "apply"]) &&
      call.arguments.length >= 1
    ) {
      const callable = factsOfExpression(call.arguments[0]);
      result.capture = callable.callable;
      for (const bypass of callable.bypass) {
        result.bypass.add(bypass);
      }
      return result;
    }

    if (
      memberName &&
      ["apply", "call"].includes(memberName) &&
      callee.type === "MemberExpression"
    ) {
      const callable = factsOfExpression(callee.object);
      result.capture = callable.callable;
      for (const bypass of callable.bypass) {
        result.bypass.add(bypass);
      }
      return result;
    }

    if (
      trustedIntrinsicPath(callee, lexical, [
        "Function",
        "prototype",
        "bind",
        "call",
      ])
    ) {
      return result;
    }

    const callable = factsOfExpression(callee);
    result.capture = callable.callable;
    result.directPin = result.capture && directPinCallee(callee);
    for (const bypass of callable.bypass) {
      result.bypass.add(bypass);
    }
    return result;
  };

  function factsOfCall(call) {
    const callee = unwrapExpression(call.callee);
    const path = syntacticPath(callee, lexical);
    const memberName =
      callee?.type === "MemberExpression"
        ? lexical.staticProperty(callee)
        : undefined;

    if (
      trustedIntrinsicPath(callee, lexical, ["Reflect", "get"]) &&
      call.arguments.length >= 2
    ) {
      const property = lexical.staticValue(call.arguments[1]);
      if (property.known) {
        return factsForProperty(call.arguments[0], String(property.value));
      }
      return emptyFacts();
    }

    if (
      trustedIntrinsicPath(callee, lexical, [
        "Function",
        "prototype",
        "bind",
        "call",
      ]) &&
      call.arguments.length >= 1
    ) {
      const sourceFacts = factsOfExpression(call.arguments[0]);
      const bound = emptyFacts();
      bound.callable = sourceFacts.callable;
      bound.containedCallable = sourceFacts.containedCallable;
      for (const bypass of sourceFacts.bypass) {
        bound.bypass.add(bypass);
      }
      for (const fn of sourceFacts.functions) {
        bound.functions.add(fn);
      }
      return bound;
    }

    if (
      callee?.type === "MemberExpression" &&
      ["at", "pop"].includes(memberName)
    ) {
      const aggregate = factsOfExpression(callee.object);
      const extracted = extractedAggregateFacts(aggregate);
      if (memberName === "at" && call.arguments.length > 0) {
        const requested = lexical.staticValue(call.arguments[0]);
        const object = unwrapExpression(callee.object);
        if (requested.known && Number.isInteger(Number(requested.value))) {
          let index = Number(requested.value);
          if (object?.type === "ArrayExpression" && index < 0) {
            index += object.elements.length;
          }
          if (index >= 0) {
            mergeFacts(
              extracted,
              factsForProperty(callee.object, String(index)),
            );
          }
        }
      }
      return extracted;
    }

    if (callee?.type === "MemberExpression" && memberName === "get") {
      const receiver = factsOfExpression(callee.object);
      if (receiver.objects.has("map")) {
        return extractedAggregateFacts(receiver);
      }
    }

    if (memberName === "bind" && callee.type === "MemberExpression") {
      const sourceFacts = factsOfExpression(callee.object);
      const bound = emptyFacts();
      bound.callable = sourceFacts.callable;
      bound.containedCallable = sourceFacts.containedCallable;
      for (const bypass of sourceFacts.bypass) {
        bound.bypass.add(bypass);
      }
      for (const fn of sourceFacts.functions) {
        bound.functions.add(fn);
      }
      return bound;
    }

    const classification = classifyCall(call);
    if (classification.capture) {
      return captureFactsFor(call);
    }

    const facts = emptyFacts();
    const calleeFacts = factsOfExpression(callee);
    for (const fn of calleeFacts.functions) {
      const summary = functionSummaries.get(fn);
      if (summary) {
        mergeFacts(facts, summary.returnFacts);
      }
    }

    if (
      callee?.type === "MemberExpression" &&
      ["filter", "map", "slice"].includes(memberName)
    ) {
      mergeFacts(facts, factsOfExpression(callee.object));
      const callback = factsOfExpression(call.arguments[0]);
      for (const fn of callback.functions) {
        const summary = functionSummaries.get(fn);
        if (summary) {
          mergeFacts(facts, aggregateFactsFromFacts(summary.returnFacts));
        }
      }
    }

    let intrinsicRoot = callee;
    while (intrinsicRoot?.type === "MemberExpression") {
      intrinsicRoot = unwrapExpression(intrinsicRoot.object);
    }
    if (
      intrinsicRoot?.type === "Identifier" &&
      ["Math", "Number"].includes(intrinsicRoot.name) &&
      lexical.resolveIdentifier(intrinsicRoot).id ===
        `global:${intrinsicRoot.name}`
    ) {
      for (const argument of call.arguments) {
        mergeFacts(facts, factsOfExpression(argument));
      }
    }

    if (memberName === "getContext") {
      facts.objects.add("canvas-context");
    }
    if (
      pathEndsWith(path, ["document", "createElement"]) &&
      lexical.staticValue(call.arguments[0]).value === "canvas"
    ) {
      facts.objects.add("scratch-canvas");
    }
    return facts;
  }

  function factsOfNew(newExpression) {
    const facts = emptyFacts();
    const calleeFacts = factsOfExpression(newExpression.callee);
    for (const klass of calleeFacts.classes) {
      facts.instances.add(klass);
    }
    if (
      newExpression.callee.type === "Identifier" &&
      lexical.resolveIdentifier(newExpression.callee).id === "global:Map"
    ) {
      facts.objects.add("map");
    }
    if (newExpression.arguments.length > 0) {
      mergeFacts(facts, aggregateFacts(newExpression.arguments));
    }
    return facts;
  }

  function factsOfExpression(expression) {
    const node = unwrapExpression(expression);
    if (!node) {
      return emptyFacts();
    }
    if (node.type === "SequenceExpression") {
      return factsOfExpression(node.expressions.at(-1));
    }
    if (node.type === "Identifier" || node.type === "ThisExpression") {
      return cloneFacts(factsAtReference(lexical.refKey(node)));
    }
    if (node.type === "MemberExpression") {
      const property = lexical.staticProperty(node);
      if (property === undefined) {
        const dynamic = emptyFacts();
        const base = factsOfExpression(node.object);
        dynamic.containedCallable = base.callable || base.containedCallable;
        for (const bypass of [...base.bypass, ...base.containedBypass]) {
          dynamic.containedBypass.add(bypass);
        }
        for (const klass of [...base.classes, ...base.containedClasses]) {
          dynamic.containedClasses.add(klass);
        }
        for (const fn of [...base.functions, ...base.containedFunctions]) {
          dynamic.containedFunctions.add(fn);
        }
        for (const instance of [
          ...base.instances,
          ...base.containedInstances,
        ]) {
          dynamic.containedInstances.add(instance);
        }
        for (const kind of [...base.objects, ...base.containedObjects]) {
          dynamic.containedObjects.add(kind);
        }
        mergeProvenance(dynamic.provenance, base.provenance);
        mergeProvenance(dynamic.provenance, base.containedProvenance);
        mergeProvenance(dynamic.containedProvenance, base.provenance);
        mergeProvenance(dynamic.containedProvenance, base.containedProvenance);
        return dynamic;
      }
      const facts = factsForProperty(node.object, property);
      if (isWeatherPinRoot(node, lexical)) {
        facts.objects.add("weather-pin");
      }
      return facts;
    }
    if (
      node.type === "ConditionalExpression" ||
      node.type === "LogicalExpression"
    ) {
      const facts = emptyFacts();
      mergeFacts(
        facts,
        factsOfExpression(
          node.type === "ConditionalExpression" ? node.consequent : node.left,
        ),
      );
      mergeFacts(
        facts,
        factsOfExpression(
          node.type === "ConditionalExpression" ? node.alternate : node.right,
        ),
      );
      return facts;
    }
    if (node.type === "BinaryExpression") {
      const facts = emptyFacts();
      mergeFacts(facts, factsOfExpression(node.left));
      mergeFacts(facts, factsOfExpression(node.right));
      return facts;
    }
    if (node.type === "UnaryExpression") {
      return ["delete", "typeof", "void"].includes(node.operator)
        ? emptyFacts()
        : factsOfExpression(node.argument);
    }
    if (node.type === "UpdateExpression") {
      return factsOfExpression(node.argument);
    }
    if (node.type === "AssignmentExpression") {
      return factsOfExpression(node.right);
    }
    if (node.type === "CallExpression") {
      return factsOfCall(node);
    }
    if (node.type === "NewExpression") {
      return factsOfNew(node);
    }
    if (isFunctionNode(node)) {
      const facts = emptyFacts();
      facts.functions.add(node);
      const summary = functionSummaries.get(node);
      if (summary?.capture) {
        facts.callable = true;
      }
      for (const bypass of summary?.bypass ?? []) {
        facts.bypass.add(bypass);
      }
      return facts;
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      const facts = emptyFacts();
      facts.classes.add(node);
      return facts;
    }
    if (node.type === "ArrayExpression") {
      return aggregateFacts(node.elements.filter(Boolean));
    }
    if (node.type === "ObjectExpression") {
      return aggregateFacts(
        node.properties.map((property) =>
          property.type === "SpreadElement"
            ? property.argument
            : property.value,
        ),
      );
    }
    return emptyFacts();
  }

  const bindExpressionToKey = (targetKey, expression) => {
    const node = unwrapExpression(expression);
    if (!targetKey || !node) {
      return false;
    }
    let changed = putReferenceFacts(targetKey, factsOfExpression(node));
    const sourceKey = lexical.refKey(node);
    changed = copyReferenceDescendants(targetKey, sourceKey) || changed;

    if (node.type === "SequenceExpression") {
      return bindExpressionToKey(targetKey, node.expressions.at(-1)) || changed;
    }
    if (
      node.type === "ConditionalExpression" ||
      node.type === "LogicalExpression"
    ) {
      changed =
        bindExpressionToKey(
          targetKey,
          node.type === "ConditionalExpression" ? node.consequent : node.left,
        ) || changed;
      changed =
        bindExpressionToKey(
          targetKey,
          node.type === "ConditionalExpression" ? node.alternate : node.right,
        ) || changed;
      return changed;
    }
    if (node.type === "ArrayExpression") {
      for (const [index, element] of node.elements.entries()) {
        if (element) {
          changed =
            bindExpressionToKey(
              lexical.memberKey(targetKey, String(index)),
              element,
            ) || changed;
        }
      }
    } else if (node.type === "ObjectExpression") {
      for (const property of node.properties) {
        if (property.type !== "Property") {
          continue;
        }
        const key = property.computed
          ? lexical.staticValue(property.key)
          : {
              known: true,
              value:
                property.key.type === "Identifier"
                  ? property.key.name
                  : property.key.value,
            };
        if (key.known) {
          changed =
            bindExpressionToKey(
              lexical.memberKey(targetKey, String(key.value)),
              property.value,
            ) || changed;
        }
      }
    }
    return changed;
  };

  const bindPatternValue = (
    pattern,
    sourceExpression,
    sourceKey,
    sourceFacts,
  ) => {
    if (!pattern) {
      return false;
    }
    if (pattern.type === "AssignmentPattern") {
      return bindPatternValue(
        pattern.left,
        sourceExpression,
        sourceKey,
        sourceFacts,
      );
    }
    if (pattern.type === "RestElement") {
      return false;
    }
    if (pattern.type === "Identifier" || pattern.type === "MemberExpression") {
      const targetKey = lexical.refKey(pattern);
      let changed = putReferenceFacts(targetKey, sourceFacts);
      changed = copyReferenceDescendants(targetKey, sourceKey) || changed;
      if (sourceExpression) {
        changed = bindExpressionToKey(targetKey, sourceExpression) || changed;
      }
      return changed;
    }

    const entries =
      pattern.type === "ArrayPattern"
        ? pattern.elements.map((value, index) => [String(index), value])
        : pattern.type === "ObjectPattern"
          ? pattern.properties.map((property) => {
              if (property.type !== "Property") {
                return [undefined, property];
              }
              const key = property.computed
                ? lexical.staticValue(property.key)
                : {
                    known: true,
                    value:
                      property.key.type === "Identifier"
                        ? property.key.name
                        : property.key.value,
                  };
              return [
                key.known ? String(key.value) : undefined,
                property.value,
              ];
            })
          : [];
    let changed = false;
    for (const [property, childPattern] of entries) {
      if (property === undefined || !childPattern) {
        continue;
      }
      const childExpression = objectLiteralProperty(
        unwrapExpression(sourceExpression),
        property,
      );
      const childKey = sourceKey
        ? lexical.memberKey(sourceKey, property)
        : undefined;
      const childFacts = childExpression
        ? factsOfExpression(childExpression)
        : (() => {
            const facts = cloneFacts(factsAtReference(childKey));
            if (sourceExpression) {
              mergeFacts(facts, factsForProperty(sourceExpression, property));
            }
            if (
              facts.provenance.size === 0 &&
              sourceFacts.provenance.size > 0
            ) {
              const kind =
                property === "png"
                  ? "png"
                  : PIXEL_FIELDS.has(property)
                    ? "pixels"
                    : "metadata";
              mergeProvenance(
                facts.provenance,
                provenanceAs(sourceFacts.provenance, kind),
              );
            }
            return facts;
          })();
      changed =
        bindPatternValue(childPattern, childExpression, childKey, childFacts) ||
        changed;
    }
    return changed;
  };

  const bindPattern = (pattern, expression) =>
    bindPatternValue(
      pattern,
      expression,
      lexical.refKey(expression),
      factsOfExpression(expression),
    );

  const ownFunctionWalk = (fn, visitor) => {
    const root = fn.body;
    walkAst(root, fn, (node, parent) => {
      if (node !== root && isFunctionNode(node)) {
        return false;
      }
      return visitor(node, parent);
    });
  };

  const parameterIndexFor = (fn, expression) => {
    const key = lexical.refKey(expression);
    if (!key) {
      return undefined;
    }
    for (const [index, parameter] of fn.params.entries()) {
      const parameterKey = lexical.refKey(
        parameter.type === "AssignmentPattern" ? parameter.left : parameter,
      );
      if (
        parameterKey &&
        (key === parameterKey || key.startsWith(`${parameterKey}/`))
      ) {
        return index;
      }
    }
    return undefined;
  };

  const reducerName = (callee) => {
    const node = unwrapExpression(callee);
    if (node?.type === "Identifier") {
      return node.name;
    }
    return node?.type === "MemberExpression"
      ? lexical.staticProperty(node)
      : undefined;
  };

  const updateFunctionSummary = (fn) => {
    const summary = functionSummaries.get(fn);
    let changed = false;
    const returns = [];
    const parent = parents.get(fn);
    const declaredName =
      fn.id?.name ??
      (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier"
        ? parent.id.name
        : undefined);
    const reducerPixelParameters = new Set();
    let reducerHasIteration = false;
    if (
      fn.type === "ArrowFunctionExpression" &&
      fn.body.type !== "BlockStatement"
    ) {
      returns.push(fn.body);
    }
    ownFunctionWalk(fn, (node, parent) => {
      if (
        [
          "DoWhileStatement",
          "ForInStatement",
          "ForOfStatement",
          "ForStatement",
          "WhileStatement",
        ].includes(node.type)
      ) {
        reducerHasIteration = true;
      }
      if (
        node.type === "MemberExpression" &&
        isPropertyRead(node, parent) &&
        !(parent?.type === "UnaryExpression" && parent.operator === "void") &&
        PIXEL_FIELDS.has(lexical.staticProperty(node))
      ) {
        const index = parameterIndexFor(fn, node.object);
        if (index !== undefined) {
          reducerPixelParameters.add(index);
        }
      }
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "ObjectPattern"
      ) {
        const index = parameterIndexFor(fn, node.init);
        if (
          index !== undefined &&
          node.id.properties.some(
            (property) =>
              property.type === "Property" &&
              PIXEL_FIELDS.has(propertyName(property, lexical)),
          )
        ) {
          reducerPixelParameters.add(index);
        }
      }
      if (node.type === "ReturnStatement" && node.argument) {
        returns.push(node.argument);
      }
      if (node.type === "CallExpression") {
        const classification = classifyCall(node);
        if (classification.capture && !summary.capture) {
          summary.capture = true;
          changed = true;
        }
        for (const bypass of classification.bypass) {
          changed = addSet(summary.bypass, bypass) || changed;
        }

        const directReducer = reducerName(node.callee);
        const reducerCallee = unwrapExpression(node.callee);
        if (
          CAPTURE_METRIC_REDUCERS.has(directReducer) &&
          reducerCallee?.type === "MemberExpression" &&
          factsOfExpression(reducerCallee.object).objects.has("weather-pin")
        ) {
          for (const argument of node.arguments) {
            const index = parameterIndexFor(fn, argument);
            if (index !== undefined) {
              changed = addSet(summary.metricParameters, index) || changed;
            }
          }
        }
        const calleeFacts = factsOfExpression(node.callee);
        for (const calleeFunction of calleeFacts.functions) {
          const calleeSummary = functionSummaries.get(calleeFunction);
          if (!calleeSummary) {
            continue;
          }
          for (const index of calleeSummary.metricParameters) {
            const parameter = parameterIndexFor(fn, node.arguments[index]);
            if (parameter !== undefined) {
              changed = addSet(summary.metricParameters, parameter) || changed;
            }
          }
          for (const index of calleeSummary.documentaryParameters) {
            const parameter = parameterIndexFor(fn, node.arguments[index]);
            if (parameter !== undefined) {
              changed =
                addSet(summary.documentaryParameters, parameter) || changed;
            }
          }
        }
      }
      if (node.type === "MemberExpression" && isPropertyRead(node, parent)) {
        const property = lexical.staticProperty(node);
        const index = parameterIndexFor(fn, node.object);
        if (index !== undefined && property === "png") {
          changed = addSet(summary.documentaryParameters, index) || changed;
        }
      }
    });
    for (const returned of returns) {
      changed =
        mergeFacts(summary.returnFacts, factsOfExpression(returned)) || changed;
    }
    if (CAPTURE_METRIC_REDUCERS.has(declaredName) && reducerHasIteration) {
      for (const index of reducerPixelParameters) {
        changed = addSet(summary.metricParameters, index) || changed;
      }
    }
    const returnedPixels = provenanceOriginsOfKind(
      summary.returnFacts,
      "pixels",
    );
    if (returnedPixels.size > 0) {
      for (const [index, parameter] of fn.params.entries()) {
        const parameterFacts = factsAtReference(
          lexical.refKey(
            parameter.type === "AssignmentPattern" ? parameter.left : parameter,
          ),
        );
        const parameterOrigins = new Set([
          ...parameterFacts.provenance.keys(),
          ...parameterFacts.containedProvenance.keys(),
        ]);
        if (
          [...parameterOrigins].some((origin) => returnedPixels.has(origin))
        ) {
          changed = addSet(summary.metricParameters, index) || changed;
        }
      }
    }
    return changed;
  };

  const bindKnownFunctionArguments = (call) => {
    const callee = unwrapExpression(call.callee);
    let callable = factsOfExpression(callee);
    let argumentsToBind = call.arguments;
    if (
      callee?.type === "MemberExpression" &&
      ["apply", "call"].includes(lexical.staticProperty(callee))
    ) {
      callable = factsOfExpression(callee.object);
      argumentsToBind =
        lexical.staticProperty(callee) === "call"
          ? call.arguments.slice(1)
          : unwrapExpression(call.arguments[1])?.type === "ArrayExpression"
            ? call.arguments[1].elements.filter(Boolean)
            : [];
    } else if (trustedIntrinsicPath(callee, lexical, ["Reflect", "apply"])) {
      callable = factsOfExpression(call.arguments[0]);
      argumentsToBind =
        unwrapExpression(call.arguments[2])?.type === "ArrayExpression"
          ? call.arguments[2].elements.filter(Boolean)
          : [];
    }

    let changed = false;
    for (const fn of callable.functions) {
      for (const [index, parameter] of fn.params.entries()) {
        if (argumentsToBind[index]) {
          changed = bindPattern(parameter, argumentsToBind[index]) || changed;
        }
      }
    }
    return changed;
  };

  const bindAggregateCallback = (call) => {
    const callee = unwrapExpression(call.callee);
    if (
      callee?.type !== "MemberExpression" ||
      ![
        "every",
        "filter",
        "find",
        "findLast",
        "forEach",
        "map",
        "some",
      ].includes(lexical.staticProperty(callee))
    ) {
      return false;
    }
    const elementFacts = extractedAggregateFacts(
      factsOfExpression(callee.object),
    );
    const callbackFacts = factsOfExpression(call.arguments[0]);
    let changed = false;
    for (const fn of callbackFacts.functions) {
      if (fn.params[0]) {
        changed =
          bindPatternValue(fn.params[0], undefined, undefined, elementFacts) ||
          changed;
      }
    }
    return changed;
  };

  const bindConstructorArguments = (expression) => {
    const calleeFacts = factsOfExpression(expression.callee);
    let changed = false;
    for (const klass of calleeFacts.classes) {
      const constructor = classMethod(klass, "constructor");
      for (const [index, parameter] of constructor?.params?.entries() ?? []) {
        if (expression.arguments[index]) {
          changed =
            bindPattern(parameter, expression.arguments[index]) || changed;
        }
      }
    }
    return changed;
  };

  let converged = false;
  for (let iteration = 0; iteration < 96; iteration++) {
    let changed = false;
    walkAst(ast, undefined, (node) => {
      if (node.type === "FunctionDeclaration" && node.id) {
        changed = bindExpressionToKey(lexical.refKey(node.id), node) || changed;
      } else if (node.type === "ClassDeclaration" && node.id) {
        changed = bindExpressionToKey(lexical.refKey(node.id), node) || changed;
      } else if (node.type === "VariableDeclarator" && node.init) {
        changed = bindPattern(node.id, node.init) || changed;
      } else if (node.type === "AssignmentExpression") {
        changed = bindPattern(node.left, node.right) || changed;
        if (
          node.left.type === "MemberExpression" &&
          node.left.computed &&
          lexical.staticProperty(node.left) === undefined
        ) {
          changed =
            putReferenceFacts(
              lexical.refKey(node.left.object),
              aggregateFacts([node.right]),
            ) || changed;
        }
      } else if (node.type === "CallExpression") {
        changed = bindKnownFunctionArguments(node) || changed;
        changed = bindAggregateCallback(node) || changed;
        const callee = unwrapExpression(node.callee);
        if (callee?.type === "MemberExpression") {
          const method = lexical.staticProperty(callee);
          const receiverKey = lexical.refKey(callee.object);
          const values =
            method === "set" ? node.arguments.slice(1) : node.arguments;
          if (["push", "set", "unshift"].includes(method) && values.length) {
            changed =
              putReferenceFacts(receiverKey, aggregateFacts(values)) || changed;
          }
        }
      } else if (node.type === "NewExpression") {
        changed = bindConstructorArguments(node) || changed;
      }
    });
    for (const fn of functions) {
      changed = updateFunctionSummary(fn) || changed;
    }
    if (!changed) {
      converged = true;
      break;
    }
  }

  const captureAdopted = (call) => {
    let cursor = call;
    for (;;) {
      const parent = parents.get(cursor);
      if (!parent) {
        return false;
      }
      if (parent.type === "AwaitExpression" && parent.argument === cursor) {
        return true;
      }
      if (parent.type === "ChainExpression" && parent.expression === cursor) {
        cursor = parent;
        continue;
      }
      if (isTransparentSequenceValue(parent, cursor)) {
        cursor = parent;
        continue;
      }
      if (
        (parent.type === "ConditionalExpression" &&
          (parent.consequent === cursor || parent.alternate === cursor)) ||
        (parent.type === "LogicalExpression" &&
          (parent.left === cursor || parent.right === cursor))
      ) {
        cursor = parent;
        continue;
      }
      if (parent.type === "ReturnStatement" && parent.argument === cursor) {
        return true;
      }
      if (parent.type === "ArrowFunctionExpression" && parent.body === cursor) {
        return true;
      }
      if (parent.type === "ArrayExpression") {
        const aggregate = parents.get(parent);
        if (
          aggregate?.type === "CallExpression" &&
          isPromiseAllCall(aggregate, lexical) &&
          aggregate.arguments.includes(parent)
        ) {
          cursor = aggregate;
          continue;
        }
        return false;
      }
      if (
        parent.type === "MemberExpression" &&
        parent.object === cursor &&
        PROMISE_CHAIN_METHODS.has(lexical.staticProperty(parent))
      ) {
        const chained = parents.get(parent);
        if (chained?.type === "CallExpression" && chained.callee === parent) {
          cursor = chained;
          continue;
        }
      }
      return false;
    }
  };

  const failures = [];
  const failureKeys = new Set();
  const addFailure = (code, message, node) => {
    const key = `${code}:${node?.start ?? "none"}:${message}`;
    if (!failureKeys.has(key)) {
      failureKeys.add(key);
      failures.push(makeFailure(code, message, relative, node));
    }
  };

  if (!converged) {
    addFailure(
      WEATHER_CAPTURE_FAILURE.ANALYSIS_NONCONVERGENT,
      "capture dataflow did not converge",
      ast,
    );
  }

  let captureCalls = 0;
  let directPinCaptures = 0;
  for (const call of calls) {
    const classification = classifyCall(call);
    if (
      trustedIntrinsicPath(call.callee, lexical, ["Reflect", "get"]) &&
      !lexical.staticValue(call.arguments[1]).known
    ) {
      const reflected = factsOfExpression(call.arguments[0]);
      if (
        reflected.callable ||
        reflected.containedCallable ||
        reflected.objects.has("weather-pin") ||
        containsNonPixelProvenance(reflected)
      ) {
        addFailure(
          WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
          "dynamic Reflect.get can hide a capture callable or frame origin",
          call,
        );
      }
      if (reflected.bypass.size > 0 || reflected.containedBypass.size > 0) {
        const bypasses = new Set([
          ...reflected.bypass,
          ...reflected.containedBypass,
        ]);
        if ([...bypasses].some((entry) => RENDER_METHODS.has(entry))) {
          addFailure(
            WEATHER_CAPTURE_FAILURE.CONSUMER_RENDER,
            "dynamic Reflect.get can hide a consumer-local scene render",
            call,
          );
        }
        if ([...bypasses].some((entry) => LIVE_READ_METHODS.has(entry))) {
          addFailure(
            WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
            "dynamic Reflect.get can hide a live-canvas readback",
            call,
          );
        }
      }
      if (reflected.objects.has("scene")) {
        addFailure(
          WEATHER_CAPTURE_FAILURE.CONSUMER_RENDER,
          "dynamic Reflect.get can hide a consumer-local scene render",
          call,
        );
      }
      if (
        reflected.objects.has("canvas-context") ||
        reflected.objects.has("live-canvas")
      ) {
        addFailure(
          WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
          "dynamic Reflect.get can hide a live-canvas readback",
          call,
        );
      }
    }
    for (const bypass of classification.bypass) {
      if (RENDER_METHODS.has(bypass)) {
        addFailure(
          WEATHER_CAPTURE_FAILURE.CONSUMER_RENDER,
          `a consumer-local render creates a second capture source (${bypass})`,
          call,
        );
      } else {
        addFailure(
          WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
          `${bypass} bypasses the canonical immutable capture`,
          call,
        );
      }
    }
    if (classification.capture) {
      captureCalls++;
      directPinCaptures += Number(classification.directPin);
      if (!captureAdopted(call)) {
        addFailure(
          WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
          `${classification.target} invocation is not awaited or returned by a thin wrapper`,
          call,
        );
      }
    }
  }

  const expressionCarriesCallable = (expression) => {
    const facts = factsOfExpression(expression);
    return facts.callable || facts.containedCallable;
  };
  const expressionCarriesLiveCanvas = (expression) => {
    const facts = factsOfExpression(expression);
    return (
      facts.objects.has("live-canvas") ||
      facts.containedObjects.has("live-canvas")
    );
  };

  for (const member of members) {
    if (!member.computed || lexical.staticProperty(member) !== undefined) {
      continue;
    }
    const base = factsOfExpression(member.object);
    if (
      base.callable ||
      base.containedCallable ||
      base.bypass.size > 0 ||
      base.containedBypass.size > 0 ||
      base.objects.has("weather-pin") ||
      containsNonPixelProvenance(base)
    ) {
      addFailure(
        WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
        "dynamic computed access can hide a capture callable or frame origin",
        member,
      );
    }
    if (base.objects.has("scene")) {
      addFailure(
        WEATHER_CAPTURE_FAILURE.CONSUMER_RENDER,
        "dynamic scene method access can hide a consumer-local render",
        member,
      );
    }
    if (base.objects.has("canvas-context") || base.objects.has("live-canvas")) {
      addFailure(
        WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
        "dynamic canvas method access can hide a live-canvas readback",
        member,
      );
    }
    const parent = parents.get(member);
    if (
      parent?.type === "CallExpression" &&
      parent.callee === member &&
      parent.arguments.some(expressionCarriesLiveCanvas)
    ) {
      addFailure(
        WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
        "dynamic method receives the live scene canvas",
        parent,
      );
    }
  }

  walkAst(ast, undefined, (node, parent) => {
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression" &&
      node.left.computed &&
      lexical.staticProperty(node.left) === undefined &&
      expressionCarriesCallable(node.right)
    ) {
      addFailure(
        WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
        "capture callable is assigned through a dynamic property",
        node,
      );
    }
    if (
      node.type === "SpreadElement" &&
      expressionCarriesCallable(node.argument)
    ) {
      addFailure(
        WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
        "capture callable escapes through an unanalyzable spread",
        node,
      );
    }
    if (node.type === "CallExpression") {
      const callee = unwrapExpression(node.callee);
      const bindFactory = trustedIntrinsicPath(node.callee, lexical, [
        "Function",
        "prototype",
        "bind",
        "call",
      ]);
      const reflectApply = trustedIntrinsicPath(node.callee, lexical, [
        "Reflect",
        "apply",
      ]);
      const calleeFunctions = factsOfExpression(node.callee).functions;
      const memberMethod =
        callee?.type === "MemberExpression"
          ? lexical.staticProperty(callee)
          : undefined;
      const modeledAggregateCall = [
        "every",
        "filter",
        "find",
        "findLast",
        "forEach",
        "map",
        "push",
        "set",
        "some",
        "unshift",
      ].includes(memberMethod);
      for (const [index, argument] of node.arguments.entries()) {
        const argumentFacts = factsOfExpression(argument);
        const allowedPageCallback =
          isPageEvaluateCall(node, lexical) && index === 0;
        const allowedBindTarget = bindFactory && index === 0;
        const allowedReflectTarget = reflectApply && index === 0;
        const allowedKnownFunction = calleeFunctions.size > 0;
        const allowedAggregateValue =
          modeledAggregateCall && (memberMethod !== "set" || index > 0);
        const modeled =
          allowedPageCallback ||
          allowedBindTarget ||
          allowedReflectTarget ||
          allowedKnownFunction ||
          allowedAggregateValue;
        if (expressionCarriesCallable(argument) && !modeled) {
          addFailure(
            WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
            "capture callable is passed to an unsupported call target",
            argument,
          );
        }
        if (!modeled && argumentFacts.bypass.size > 0) {
          for (const bypass of argumentFacts.bypass) {
            addFailure(
              RENDER_METHODS.has(bypass)
                ? WEATHER_CAPTURE_FAILURE.CONSUMER_RENDER
                : WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
              `${bypass} enters an unmodelled call target`,
              argument,
            );
          }
        }
      }

      const path = syntacticPath(node.callee, lexical);
      const rootName = path?.[0];
      let root = unwrapExpression(node.callee);
      while (root?.type === "MemberExpression") {
        root = unwrapExpression(root.object);
      }
      if (
        ["Function", "Promise", "Reflect"].includes(rootName) &&
        root?.type === "Identifier" &&
        lexical.resolveIdentifier(root).id !== `global:${rootName}` &&
        node.arguments.some((argument) =>
          factsContainSensitiveValue(factsOfExpression(argument)),
        )
      ) {
        addFailure(
          WEATHER_CAPTURE_FAILURE.UNTRUSTED_INTRINSIC,
          `${rootName} is shadowed while handling capture-sensitive data`,
          node,
        );
      }
    }
    if (node.type === "NewExpression") {
      const constructor = factsOfExpression(node.callee);
      const modeled =
        constructor.classes.size > 0 ||
        (node.callee.type === "Identifier" &&
          lexical.resolveIdentifier(node.callee).id === "global:Map");
      if (
        !modeled &&
        node.arguments.some((argument) =>
          factsContainSensitiveValue(factsOfExpression(argument)),
        )
      ) {
        addFailure(
          WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
          "capture-sensitive data enters an unmodelled constructor",
          node,
        );
      }
    }
    if (
      [
        "BinaryExpression",
        "TaggedTemplateExpression",
        "YieldExpression",
      ].includes(parent?.type) &&
      expressionCarriesCallable(node)
    ) {
      addFailure(
        WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
        "capture callable enters an unsupported expression",
        node,
      );
    }
    if (
      parent?.type === "ExpressionStatement" &&
      node.type !== "AssignmentExpression" &&
      expressionCarriesCallable(node)
    ) {
      addFailure(
        WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
        "capture callable is evaluated without a tracked invocation or binding",
        node,
      );
    }
  });

  const documentaryOrigins = new Set();
  const metricOrigins = new Set();
  const markOrigins = (target, facts) => {
    for (const origin of [
      ...facts.provenance.keys(),
      ...facts.containedProvenance.keys(),
    ]) {
      target.add(origin);
    }
  };
  const markPixelOrigins = (target, facts) => {
    for (const provenance of [facts.provenance, facts.containedProvenance]) {
      for (const [origin, kinds] of provenance) {
        if (kinds.has("pixels")) {
          target.add(origin);
        }
      }
    }
  };

  walkAst(ast, undefined, (node, parent) => {
    if (node.type === "MemberExpression" && isPropertyRead(node, parent)) {
      const property = lexical.staticProperty(node);
      const base = factsOfExpression(node.object);
      if (property === "png") {
        markOrigins(documentaryOrigins, base);
      }
    }
    if (node.type === "CallExpression") {
      const reducer = reducerName(node.callee);
      const reducerCallee = unwrapExpression(node.callee);
      if (
        CAPTURE_METRIC_REDUCERS.has(reducer) &&
        reducerCallee?.type === "MemberExpression" &&
        factsOfExpression(reducerCallee.object).objects.has("weather-pin")
      ) {
        for (const argument of node.arguments) {
          markOrigins(metricOrigins, factsOfExpression(argument));
        }
      }
      const calleeFacts = factsOfExpression(node.callee);
      for (const fn of calleeFacts.functions) {
        const summary = functionSummaries.get(fn);
        if (!summary) {
          continue;
        }
        for (const index of summary.metricParameters) {
          markOrigins(metricOrigins, factsOfExpression(node.arguments[index]));
        }
        for (const index of summary.documentaryParameters) {
          markOrigins(
            documentaryOrigins,
            factsOfExpression(node.arguments[index]),
          );
        }
      }
    }
    if (
      node.type === "ReturnStatement" &&
      node.argument?.type === "ObjectExpression"
    ) {
      for (const property of node.argument.properties) {
        if (
          property.type === "Property" &&
          propertyName(property, lexical) !== "png"
        ) {
          markPixelOrigins(metricOrigins, factsOfExpression(property.value));
        }
      }
    }
    if (
      (node.type === "VariableDeclarator" ||
        (node.type === "AssignmentExpression" && node.operator === "=")) &&
      (node.type === "VariableDeclarator" ? node.id : node.left).type ===
        "ObjectPattern"
    ) {
      const pattern = node.type === "VariableDeclarator" ? node.id : node.left;
      const value = node.type === "VariableDeclarator" ? node.init : node.right;
      const base = factsOfExpression(value);
      for (const property of pattern.properties) {
        if (property.type !== "Property") {
          continue;
        }
        const key = property.computed
          ? lexical.staticValue(property.key)
          : {
              known: true,
              value:
                property.key.type === "Identifier"
                  ? property.key.name
                  : property.key.value,
            };
        if (key.known && key.value === "png") {
          markOrigins(documentaryOrigins, base);
        }
      }
    }
  });

  for (const origin of documentaryOrigins) {
    if (!metricOrigins.has(origin)) {
      addFailure(
        WEATHER_CAPTURE_FAILURE.DOCUMENTARY_ORIGIN_MISMATCH,
        `documentary PNG uses a separate capture at ${origin} without a metric read from the same bytes`,
        originNodes.get(origin),
      );
    }
  }

  if (captureCalls === 0) {
    addFailure(
      WEATHER_CAPTURE_FAILURE.NO_CAPTURE,
      "no statically traceable weather capture exists",
      ast,
    );
  }

  return { captureCalls, directPinCaptures, failures };
};

export const analyzeWeatherCaptureConsumer = (
  source,
  { relative = "weather capture consumer" } = {},
) => {
  let relativeCache = consumerAnalysisCache.get(relative);
  if (!relativeCache) {
    relativeCache = new Map();
    consumerAnalysisCache.set(relative, relativeCache);
  }
  const cached = relativeCache.get(source);
  if (cached) {
    return cached;
  }
  let ast;
  try {
    ast = parseModule(source);
  } catch (error) {
    const result = {
      captureCalls: 0,
      directPinCaptures: 0,
      failures: [
        makeFailure(
          WEATHER_CAPTURE_FAILURE.PARSE_ERROR,
          `capture guard could not parse source: ${
            error instanceof Error ? error.message : String(error)
          }`,
          relative,
        ),
      ],
    };
    relativeCache.set(source, result);
    return result;
  }
  const result = createConsumerAnalyzer(ast, source, relative);
  relativeCache.set(source, result);
  return result;
};

const astNodes = (root) => {
  const nodes = [];
  walkAst(root, undefined, (node, parent) => {
    nodes.push({ node, parent });
  });
  return nodes;
};

const functionExecutionNodes = (fn) => {
  const nodes = [];
  const root = fn.body;
  walkAst(root, fn, (node, parent) => {
    if (node !== root && isFunctionNode(node)) {
      return false;
    }
    nodes.push({ node, parent });
    return undefined;
  });
  return nodes;
};

const propertyName = (property, lexical) => {
  if (!property) {
    return undefined;
  }
  const key = property.key ?? property.property;
  if (!property.computed && key?.type === "Identifier") {
    return key.name;
  }
  const value = lexical.staticValue(key);
  return value.known ? String(value.value) : undefined;
};

const hasThrow = (statement) =>
  astNodes(statement).some(({ node }) => node.type === "ThrowStatement");

const sameReference = (left, right, lexical) => {
  const leftKey = lexical.refKey(left);
  return leftKey !== undefined && leftKey === lexical.refKey(right);
};

const objectProperty = (object, name, lexical) =>
  object?.type === "ObjectExpression"
    ? object.properties.find(
        (property) =>
          property.type === "Property" &&
          propertyName(property, lexical) === name,
      )
    : undefined;

// Architecture disposition: the lexical model and taint lattice are not yet a
// generic core. Their facts deliberately encode weather-pin roots, scene/canvas
// escape classes, capture-origin kinds, and the weather reducer contract; the
// canonical helper proof consumes those same lexical identities. Extracting only
// the traversal would replace local invariants with a callback-heavy cross-module
// protocol despite there being no second consumer. The mechanism/policy seams
// below are explicit pure functions instead. If a second policy needs this
// analysis, extract the lattice and both policies together with a shared
// conformance suite rather than declaring this weather-shaped API reusable.
const inspectCanonicalSnapshot = (snapshot) => {
  const failures = [];
  let ast;
  try {
    ast = parseModule(snapshot);
  } catch (error) {
    return [
      makeFailure(
        WEATHER_CAPTURE_FAILURE.SNAPSHOT_ORDER,
        `canonical snapshot source is not parseable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    ];
  }
  const lexical = createLexicalModel(ast);
  const entries = astNodes(ast);
  const factoryDeclaration = entries.find(
    ({ node }) =>
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === "makeFusedSnapshotCapture" &&
      isFunctionNode(node.init),
  )?.node;
  const factory = factoryDeclaration?.init;
  const captureDeclaration = factory
    ? astNodes(factory.body).find(
        ({ node }) =>
          node.type === "VariableDeclarator" &&
          node.id.type === "Identifier" &&
          node.id.name === "captureSnapshot" &&
          isFunctionNode(node.init),
      )?.node
    : undefined;
  const capture = captureDeclaration?.init;
  const bodyEntries = capture ? functionExecutionNodes(capture) : [];
  const render = bodyEntries.find(({ node }) => {
    const callee = unwrapExpression(node.callee);
    return (
      node.type === "CallExpression" &&
      callee?.type === "MemberExpression" &&
      lexical.staticProperty(callee) === "render" &&
      sameReference(callee.object, factory.params[0], lexical) &&
      node.arguments[0]?.type === "CallExpression" &&
      sameReference(node.arguments[0].callee, factory.params[2], lexical)
    );
  })?.node;
  const freezeDeclaration = bodyEntries.find(({ node }) => {
    const init = unwrapExpression(node.init);
    const callee = unwrapExpression(init?.callee);
    return (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      init?.type === "CallExpression" &&
      callee?.type === "MemberExpression" &&
      lexical.staticProperty(callee) === "toDataURL" &&
      sameReference(callee.object, factory.params[1], lexical) &&
      lexical.staticValue(init.arguments[0]).value === "image/png"
    );
  })?.node;
  const decodeDeclaration = bodyEntries.find(({ node }) => {
    const init = node.type === "VariableDeclarator" ? node.init : undefined;
    const awaited =
      init?.type === "AwaitExpression" ? init.argument : undefined;
    return (
      awaited?.type === "CallExpression" &&
      freezeDeclaration &&
      sameReference(awaited.arguments[0], freezeDeclaration.id, lexical)
    );
  })?.node;
  const firstAwait = bodyEntries
    .filter(({ node }) => node.type === "AwaitExpression")
    .map(({ node }) => node)
    .sort((left, right) => left.start - right.start)[0];

  if (
    !capture?.async ||
    !render ||
    !freezeDeclaration ||
    !decodeDeclaration ||
    !(
      render.start < freezeDeclaration.start &&
      freezeDeclaration.start < decodeDeclaration.start
    )
  ) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.SNAPSHOT_ORDER,
        "canonical snapshot does not execute render, freeze, then decode",
        undefined,
        capture ?? ast,
      ),
    );
  }
  if (
    firstAwait &&
    freezeDeclaration &&
    firstAwait.start < freezeDeclaration.start
  ) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.DECODE_BEFORE_FREEZE,
        "canonical snapshot yields before freezing the live canvas",
        undefined,
        firstAwait,
      ),
    );
  }
  const liveReread = entries.find(({ node }) => {
    const callee = unwrapExpression(node.callee);
    return (
      node.type === "CallExpression" &&
      callee?.type === "MemberExpression" &&
      lexical.staticProperty(callee) === "drawImage" &&
      node.arguments.some(
        (argument) =>
          factory && sameReference(argument, factory.params[1], lexical),
      )
    );
  })?.node;
  if (liveReread) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.SNAPSHOT_LIVE_REREAD,
        "canonical snapshot decodes by rereading the live canvas",
        undefined,
        liveReread,
      ),
    );
  }
  return failures;
};

const inspectCanonicalPinning = (pinning, snapshot) => {
  const failures = [];
  let ast;
  try {
    ast = parseModule(pinning);
  } catch (error) {
    return [
      makeFailure(
        WEATHER_CAPTURE_FAILURE.PARSE_ERROR,
        `weather pinning is not parseable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    ];
  }
  const lexical = createLexicalModel(ast);
  const entries = astNodes(ast);
  const canonicalImport = entries.find(
    ({ node }) =>
      node.type === "ImportDeclaration" &&
      node.source.value === "./same-task-capture.mjs" &&
      node.specifiers.some(
        (specifier) =>
          specifier.type === "ImportSpecifier" &&
          (specifier.imported.name ?? specifier.imported.value) ===
            "FUSED_SNAPSHOT_CAPTURE_SOURCE",
      ),
  )?.node;
  const canonicalLocal = canonicalImport?.specifiers.find(
    (specifier) =>
      specifier.type === "ImportSpecifier" &&
      (specifier.imported.name ?? specifier.imported.value) ===
        "FUSED_SNAPSHOT_CAPTURE_SOURCE",
  )?.local;
  if (!canonicalLocal) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.CANONICAL_IMPORT_MISSING,
        "weather pinning does not import the canonical snapshot source",
      ),
    );
  }

  const installer = entries.find(
    ({ node }) =>
      node.type === "FunctionDeclaration" &&
      node.id?.name === "installWeatherPinHarness",
  )?.node;
  const installerParameter = installer?.params[0];
  const guard = installer
    ? astNodes(installer.body).find(({ node }) => {
        const test = node.type === "IfStatement" ? node.test : undefined;
        return (
          test?.type === "BinaryExpression" &&
          test.operator === "!==" &&
          test.left.type === "UnaryExpression" &&
          test.left.operator === "typeof" &&
          sameReference(test.left.argument, installerParameter, lexical) &&
          lexical.staticValue(test.right).value === "function" &&
          hasThrow(node.consequent)
        );
      })?.node
    : undefined;
  if (!guard) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.CANONICAL_HELPER_GUARD_MISSING,
        "a missing canonical snapshot helper is not rejected",
        undefined,
        installer ?? ast,
      ),
    );
  }

  const installerEntries = installer ? astNodes(installer.body) : [];
  const fusedFactoryDeclaration = installerEntries.find(
    ({ node }) =>
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === "fusedCaptureFor" &&
      isFunctionNode(node.init),
  )?.node;
  const fusedCall = fusedFactoryDeclaration
    ? functionExecutionNodes(fusedFactoryDeclaration.init).find(
        ({ node }) =>
          node.type === "CallExpression" &&
          sameReference(node.callee, installerParameter, lexical),
      )?.node
    : undefined;
  const renderProperty = objectProperty(
    fusedCall?.arguments[0],
    "render",
    lexical,
  );
  if (
    !fusedCall ||
    !renderProperty ||
    unwrapExpression(renderProperty.value)?.type !== "Identifier" ||
    unwrapExpression(renderProperty.value).name !== "renderAt"
  ) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.PINNED_RENDER_BYPASS,
        "canonical capture bypasses the pinned renderAt clock driver",
        undefined,
        fusedCall ?? installer ?? ast,
      ),
    );
  }

  const captureProperty = installerEntries.find(
    ({ node }) =>
      node.type === "Property" &&
      propertyName(node, lexical) === "capture" &&
      isFunctionNode(node.value),
  )?.node;
  const capture = captureProperty?.value;
  if (!capture?.async) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.ASYNC_CAPTURE_MISSING,
        "weather capture is not asynchronous",
        undefined,
        captureProperty ?? installer ?? ast,
      ),
    );
  }

  const captureEntries = capture ? functionExecutionNodes(capture) : [];
  const fusedDeclaration = captureEntries.find(({ node }) => {
    const init = unwrapExpression(node.init);
    return (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      init?.type === "CallExpression" &&
      fusedFactoryDeclaration &&
      sameReference(init.callee, fusedFactoryDeclaration.id, lexical)
    );
  })?.node;
  const snapshotDeclaration = captureEntries.find(({ node }) => {
    const init = unwrapExpression(node.init);
    const callee = unwrapExpression(init?.callee);
    return (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      init?.type === "CallExpression" &&
      callee?.type === "MemberExpression" &&
      lexical.staticProperty(callee) === "captureSnapshot" &&
      fusedDeclaration &&
      sameReference(callee.object, fusedDeclaration.id, lexical)
    );
  })?.node;
  const slotsDeclaration = captureEntries.find(({ node }) => {
    const init = unwrapExpression(node.init);
    return (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      init?.type === "CallExpression" &&
      unwrapExpression(init.callee)?.type === "Identifier" &&
      unwrapExpression(init.callee).name === "slotSnapshot"
    );
  })?.node;
  const decodedDeclaration = captureEntries.find(({ node }) => {
    const init = node.type === "VariableDeclarator" ? node.init : undefined;
    return (
      node.id?.type === "ObjectPattern" &&
      init?.type === "AwaitExpression" &&
      snapshotDeclaration &&
      sameReference(init.argument, snapshotDeclaration.id, lexical)
    );
  })?.node;
  if (
    !snapshotDeclaration ||
    !slotsDeclaration ||
    !decodedDeclaration ||
    !(
      snapshotDeclaration.start < slotsDeclaration.start &&
      slotsDeclaration.start < decodedDeclaration.start
    )
  ) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.CAPTURE_ORDER,
        "canonical capture execution does not freeze, snapshot slots, then await decode",
        undefined,
        capture ?? ast,
      ),
    );
  }

  const decodedBindings = new Map();
  for (const property of decodedDeclaration?.id?.properties ?? []) {
    if (property.type === "Property") {
      decodedBindings.set(propertyName(property, lexical), property.value);
    }
  }
  const returnObject = captureEntries.find(
    ({ node }) =>
      node.type === "ReturnStatement" &&
      node.argument?.type === "ObjectExpression",
  )?.node.argument;
  const dataProperty = objectProperty(returnObject, "data", lexical);
  const widthProperty = objectProperty(returnObject, "width", lexical);
  const heightProperty = objectProperty(returnObject, "height", lexical);
  const pngProperty = objectProperty(returnObject, "png", lexical);
  const imageData = decodedBindings.get("imageData");
  const dataValue = unwrapExpression(dataProperty?.value);
  const widthValue = unwrapExpression(widthProperty?.value);
  const heightValue = unwrapExpression(heightProperty?.value);
  const metricFieldsAreCanonical = [
    [dataValue, "data"],
    [widthValue, "width"],
    [heightValue, "height"],
  ].every(
    ([value, name]) =>
      value?.type === "MemberExpression" &&
      lexical.staticProperty(value) === name &&
      sameReference(value.object, imageData, lexical),
  );
  if (!metricFieldsAreCanonical) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.METRIC_DECODE_SOURCE,
        "metrics are not returned from the canonical decoded snapshot",
        undefined,
        returnObject ?? capture ?? ast,
      ),
    );
  }
  const pngValue = unwrapExpression(pngProperty?.value);
  if (
    pngValue?.type !== "ConditionalExpression" ||
    !sameReference(
      pngValue.consequent,
      decodedBindings.get("dataUrl"),
      lexical,
    ) ||
    lexical.staticValue(pngValue.alternate).value !== null
  ) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.DOCUMENTARY_BYTE_SOURCE,
        "documentary PNG is not the same dataUrl used for metrics",
        undefined,
        pngProperty ?? returnObject ?? capture ?? ast,
      ),
    );
  }

  const liveRead = entries.find(({ node }) => {
    const callee = unwrapExpression(node.callee);
    return (
      node.type === "CallExpression" &&
      callee?.type === "MemberExpression" &&
      ["drawImage", "getImageData"].includes(lexical.staticProperty(callee))
    );
  })?.node;
  if (liveRead) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.HELPER_LIVE_READ,
        "weather pinning reads the live WebGPU canvas outside the canonical snapshot helper",
        undefined,
        liveRead,
      ),
    );
  }

  const onPage = entries.find(
    ({ node }) =>
      node.type === "FunctionDeclaration" &&
      node.id?.name === "installWeatherPinHarnessOnPage",
  )?.node;
  const onPageEntries = onPage ? astNodes(onPage.body) : [];
  const contentDeclaration = onPageEntries.find(
    ({ node }) =>
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "TemplateLiteral",
  )?.node;
  const contentTemplate = contentDeclaration?.init;
  const canonicalExpression = contentTemplate?.expressions[0];
  const installerExpression = contentTemplate?.expressions[1];
  const installerToString = unwrapExpression(installerExpression);
  const installerToStringCallee = unwrapExpression(installerToString?.callee);
  const templateBindingsAreCanonical =
    canonicalLocal &&
    sameReference(canonicalExpression, canonicalLocal, lexical) &&
    installerToString?.type === "CallExpression" &&
    installerToStringCallee?.type === "MemberExpression" &&
    lexical.staticProperty(installerToStringCallee) === "toString" &&
    sameReference(installerToStringCallee.object, installer?.id, lexical);
  let generatedInstallsCanonical = false;
  if (templateBindingsAreCanonical) {
    const substitutions = [
      snapshot,
      pinning.slice(installer.start, installer.end),
    ];
    let generated = contentTemplate.quasis[0].value.cooked;
    for (const [index, substitution] of substitutions.entries()) {
      generated += substitution;
      generated += contentTemplate.quasis[index + 1].value.cooked;
    }
    try {
      const generatedAst = parseModule(generated);
      generatedInstallsCanonical = astNodes(generatedAst).some(({ node }) => {
        const callee = unwrapExpression(node.callee);
        return (
          node.type === "CallExpression" &&
          callee?.type === "FunctionExpression" &&
          callee.id?.name === "installWeatherPinHarness" &&
          node.arguments[0]?.type === "Identifier" &&
          node.arguments[0].name === "makeFusedSnapshotCapture"
        );
      });
    } catch {
      generatedInstallsCanonical = false;
    }
  }
  const addInitScript = onPageEntries.find(({ node }) => {
    const callee = unwrapExpression(node.callee);
    const content = objectProperty(node.arguments?.[0], "content", lexical);
    return (
      node.type === "CallExpression" &&
      callee?.type === "MemberExpression" &&
      lexical.staticProperty(callee) === "addInitScript" &&
      contentDeclaration &&
      sameReference(content?.value, contentDeclaration.id, lexical)
    );
  })?.node;
  if (!generatedInstallsCanonical || !addInitScript) {
    failures.push(
      makeFailure(
        WEATHER_CAPTURE_FAILURE.CANONICAL_INSTALLER_MISSING,
        "the canonical snapshot factory is not installed as executable harness code",
        undefined,
        onPage ?? ast,
      ),
    );
  }
  return failures;
};

export const analyzeWeatherCaptureDoctrine = ({
  candidateSources,
  consumers,
  pinning,
  snapshot,
}) => {
  const failures = [
    ...inspectCanonicalPinning(pinning, snapshot),
    ...inspectCanonicalSnapshot(snapshot),
  ];

  if (candidateSources) {
    const census = censusWeatherCaptureConsumers(candidateSources);
    failures.push(...census.failures);
    const tracked = new Set(Object.keys(consumers));
    for (const relative of census.paths) {
      if (!tracked.has(relative)) {
        failures.push(
          makeFailure(
            WEATHER_CAPTURE_FAILURE.UNTRACKED_CONSUMER,
            "direct weather capture consumer is absent from the analyzed set",
            relative,
          ),
        );
      }
    }
  }

  for (const [relative, consumerSource] of Object.entries(consumers)) {
    failures.push(
      ...analyzeWeatherCaptureConsumer(consumerSource, { relative }).failures,
    );
  }
  return failures;
};
