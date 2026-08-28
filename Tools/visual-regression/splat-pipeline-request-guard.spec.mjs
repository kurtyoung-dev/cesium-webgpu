// @purpose Prove stale Gaussian-splat pipeline promises cannot publish after resource invalidation.
// @status ACTIVE

// EVIDENCE BOUNDARY:
// - The BEHAVIOURAL group executes WebGPUPipelineRequestGuard with modelled
//   completion handlers. It proves the leaf guard's generation and resource-
//   identity contract; deleting the guard wiring from the renderer leaves that
//   group green.
// - The WIRING group does not execute WebGPUGaussianSplatRenderer because Node
//   cannot load that TypeScript file's enum syntax in this unbuilt clone. The
//   renderer claim rests on the structural source scan and its absence and
//   inertness mutations.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLONE_ROOT = resolve(HERE, "../..");
const MUTATION_ROOT = join(CLONE_ROOT, ".tmp");
const WEBGPU_DIR = resolve(
  HERE,
  "../../packages/engine/Source/Renderer/WebGPU",
);
const GUARD_FILE = join(WEBGPU_DIR, "WebGPUPipelineRequestGuard.ts");
const RENDERER_FILE = join(WEBGPU_DIR, "WebGPUGaussianSplatRenderer.ts");
const CRLF = "\r\n";

enableEngineTsResolution();

const { WebGPUPipelineRequestGuard } = await import(
  pathToFileURL(GUARD_FILE).href
);

const STANDARD_SLOTS = [
  "pipeline",
  "pickPipeline",
  "depthWritePipeline",
  "oitPipeline",
];

class ControlledPipelineCache {
  constructor() {
    this.requests = [];
  }

  getPipeline(descriptor) {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      resolvePromise = resolveRequest;
      rejectPromise = rejectRequest;
    });
    this.requests.push({
      descriptor,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    });
    return promise;
  }
}

function makeResources(label) {
  return {
    colorDescriptor: { name: `${label}-color` },
    pickDescriptor: { name: `${label}-pick` },
    depthWriteDescriptor: { name: `${label}-depth-write` },
    oitDescriptor: { name: `${label}-oit` },
  };
}

function makeVelocityDescriptor(label) {
  return { name: `${label}-velocity` };
}

function makePipelines(label) {
  return {
    pipeline: { label: `${label}-color` },
    pickPipeline: { label: `${label}-pick` },
    depthWritePipeline: { label: `${label}-depth-write` },
    oitPipeline: { label: `${label}-oit` },
    velocityPipeline: { label: `${label}-velocity` },
  };
}

function makeCache() {
  return {
    pipeline: null,
    pickPipeline: null,
    depthWritePipeline: null,
    oitPipeline: null,
    velocityPipeline: null,
    pipelineRequestPending: false,
    velocityPipelineRequestPending: false,
  };
}

function queueStandardRequests(guard, pipelineCache, resources, cache) {
  const requestToken = guard.beginRequest(resources);
  const firstRequest = pipelineCache.requests.length;
  cache.pipelineRequestPending = true;
  const work = [
    pipelineCache.getPipeline(resources.colorDescriptor).then((pipeline) => {
      guard.publishIfCurrent(requestToken, () => {
        cache.pipeline = pipeline;
      });
    }),
    pipelineCache.getPipeline(resources.pickDescriptor).then((pipeline) => {
      guard.publishIfCurrent(requestToken, () => {
        cache.pickPipeline = pipeline;
      });
    }),
    pipelineCache
      .getPipeline(resources.depthWriteDescriptor)
      .then((pipeline) => {
        guard.publishIfCurrent(requestToken, () => {
          cache.depthWritePipeline = pipeline;
        });
      })
      .catch(() => {
        guard.publishIfCurrent(requestToken, () => {
          cache.depthWritePipeline = null;
        });
      }),
    pipelineCache
      .getPipeline(resources.oitDescriptor)
      .then((pipeline) => {
        guard.publishIfCurrent(requestToken, () => {
          cache.oitPipeline = pipeline;
        });
      })
      .catch(() => {
        guard.publishIfCurrent(requestToken, () => {
          cache.oitPipeline = null;
        });
      }),
  ];
  const completion = Promise.all(work)
    .then(() => {
      guard.publishIfCurrent(requestToken, () => {
        cache.pipelineRequestPending = false;
      });
    })
    .catch(() => {
      guard.publishIfCurrent(requestToken, () => {
        cache.pipelineRequestPending = false;
      });
    });
  return {
    completion,
    requests: pipelineCache.requests.slice(firstRequest),
    work,
  };
}

function queueVelocityRequest(
  guard,
  pipelineCache,
  resources,
  velocityDescriptor,
  cache,
) {
  const requestToken = guard.beginRequest(resources);
  const firstRequest = pipelineCache.requests.length;
  cache.velocityPipelineRequestPending = true;
  const completion = pipelineCache
    .getPipeline(velocityDescriptor)
    .then((pipeline) => {
      guard.publishIfCurrent(requestToken, () => {
        cache.velocityPipeline = pipeline;
        cache.velocityPipelineRequestPending = false;
      });
    })
    .catch(() => {
      guard.publishIfCurrent(requestToken, () => {
        cache.velocityPipelineRequestPending = false;
      });
    });
  return {
    completion,
    request: pipelineCache.requests[firstRequest],
  };
}

async function resolveSelected(batch, indexes, pipelines) {
  for (const index of indexes) {
    batch.requests[index].resolve(pipelines[STANDARD_SLOTS[index]]);
  }
  await Promise.all(indexes.map((index) => batch.work[index]));
}

async function resolveStandard(batch, pipelines) {
  await resolveSelected(batch, [0, 1, 2, 3], pipelines);
  await batch.completion;
}

async function resolveVelocity(batch, pipeline) {
  batch.request.resolve(pipeline);
  await batch.completion;
}

function clearInvalidatedCache(cache) {
  for (const slot of [...STANDARD_SLOTS, "velocityPipeline"]) {
    cache[slot] = null;
  }
  cache.pipelineRequestPending = false;
  cache.velocityPipelineRequestPending = false;
}

function assertPublished(cache, pipelines, phase) {
  for (const slot of [...STANDARD_SLOTS, "velocityPipeline"]) {
    assert.equal(
      cache[slot],
      pipelines[slot],
      `BEHAVIOURAL: ${phase} must retain the current ${slot} object`,
    );
  }
}

async function assertColdStartOrdering(GuardConstructor) {
  const guard = new GuardConstructor();
  const pipelineCache = new ControlledPipelineCache();
  const cache = makeCache();
  const legacyResources = makeResources("legacy-64-byte");
  const packedResources = makeResources("packed-32-byte");
  const legacyVelocityDescriptor = makeVelocityDescriptor("legacy-64-byte");
  const packedVelocityDescriptor = makeVelocityDescriptor("packed-32-byte");
  const legacyPipelines = makePipelines("legacy-64-byte");
  const packedPipelines = makePipelines("packed-32-byte");

  const legacyStandard = queueStandardRequests(
    guard,
    pipelineCache,
    legacyResources,
    cache,
  );
  const legacyVelocity = queueVelocityRequest(
    guard,
    pipelineCache,
    legacyResources,
    legacyVelocityDescriptor,
    cache,
  );

  guard.invalidate();
  clearInvalidatedCache(cache);

  const packedStandard = queueStandardRequests(
    guard,
    pipelineCache,
    packedResources,
    cache,
  );
  const packedVelocity = queueVelocityRequest(
    guard,
    pipelineCache,
    packedResources,
    packedVelocityDescriptor,
    cache,
  );

  await resolveSelected(legacyStandard, [0, 1], legacyPipelines);
  assert.equal(
    cache.pipelineRequestPending,
    true,
    "BEHAVIOURAL: stale partial work must not unlatch the packed request",
  );

  await Promise.all([
    resolveStandard(packedStandard, packedPipelines),
    resolveVelocity(packedVelocity, packedPipelines.velocityPipeline),
  ]);
  assertPublished(cache, packedPipelines, "fresh publication");

  const packedRetry = queueStandardRequests(
    guard,
    pipelineCache,
    packedResources,
    cache,
  );
  const packedVelocityRetry = queueVelocityRequest(
    guard,
    pipelineCache,
    packedResources,
    packedVelocityDescriptor,
    cache,
  );

  legacyStandard.requests[2].reject(new Error("legacy depth-write rejection"));
  legacyStandard.requests[3].resolve(legacyPipelines.oitPipeline);
  legacyVelocity.request.resolve(legacyPipelines.velocityPipeline);
  await Promise.all([legacyStandard.completion, legacyVelocity.completion]);

  assertPublished(cache, packedPipelines, "late legacy completion");
  assert.equal(
    cache.pipelineRequestPending,
    true,
    "BEHAVIOURAL: stale aggregate settlement must not clear a current latch",
  );
  assert.equal(
    cache.velocityPipelineRequestPending,
    true,
    "BEHAVIOURAL: stale velocity settlement must not clear a current latch",
  );

  await Promise.all([
    resolveStandard(packedRetry, packedPipelines),
    resolveVelocity(packedVelocityRetry, packedPipelines.velocityPipeline),
  ]);
  assertPublished(cache, packedPipelines, "current retry settlement");
  assert.equal(cache.pipelineRequestPending, false);
  assert.equal(cache.velocityPipelineRequestPending, false);
}

async function assertResourceIdentityOrdering(GuardConstructor) {
  const guard = new GuardConstructor();
  const pipelineCache = new ControlledPipelineCache();
  const cache = makeCache();
  const firstResources = makeResources("same-generation-first");
  const currentResources = makeResources("same-generation-current");
  const firstPipelines = makePipelines("same-generation-first");
  const currentPipelines = makePipelines("same-generation-current");

  const first = queueStandardRequests(
    guard,
    pipelineCache,
    firstResources,
    cache,
  );
  const current = queueStandardRequests(
    guard,
    pipelineCache,
    currentResources,
    cache,
  );

  await resolveStandard(current, currentPipelines);
  await resolveStandard(first, firstPipelines);

  for (const slot of STANDARD_SLOTS) {
    assert.equal(
      cache[slot],
      currentPipelines[slot],
      `BEHAVIOURAL: resource identity must retain the current ${slot} object`,
    );
  }
}

async function runBehaviouralContract(GuardConstructor) {
  await assertColdStartOrdering(GuardConstructor);
  await assertResourceIdentityOrdering(GuardConstructor);
}

function countLineEndings(source) {
  const bytes = Buffer.from(source, "utf8");
  let crlf = 0;
  let loneLf = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) {
      if (i > 0 && bytes[i - 1] === 13) {
        crlf++;
      } else {
        loneLf++;
      }
    }
  }
  return { crlf, loneLf };
}

function assertCrLfOnly(source, label) {
  const counts = countLineEndings(source);
  assert.ok(counts.crlf > 0, `${label} must contain CRLF line endings`);
  assert.equal(counts.loneLf, 0, `${label} must not contain lone LF endings`);
}

async function withMutatedCopy(sourceFile, mutate, label, useCopy) {
  const original = await readFile(sourceFile, "utf8");
  assertCrLfOnly(original, sourceFile);
  const mutated = mutate(original);
  assert.notEqual(
    mutated,
    original,
    `the ${label} mutation did not change ${sourceFile}; its target text moved`,
  );
  assertCrLfOnly(mutated, `${label} mutant`);

  await mkdir(MUTATION_ROOT, { recursive: true });
  const directory = await mkdtemp(
    join(MUTATION_ROOT, "splat-pipeline-request-guard-"),
  );
  try {
    assert.equal(
      dirname(directory),
      MUTATION_ROOT,
      "mutation temp directory must stay under the clone-root .tmp directory",
    );
    const copy = join(directory, "Mutant.mts");
    await writeFile(copy, mutated, "utf8");
    return await useCopy(copy);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function importMutated(sourceFile, mutate, label) {
  return withMutatedCopy(
    sourceFile,
    mutate,
    label,
    async (copy) => import(pathToFileURL(copy).href),
  );
}

async function expectBehaviouralFailure(mutant, label) {
  await assert.rejects(
    () => runBehaviouralContract(mutant.WebGPUPipelineRequestGuard),
    (error) =>
      error?.code === "ERR_ASSERTION" &&
      /BEHAVIOURAL/.test(String(error.message)),
    `${label} must fail an observable behavioural assertion`,
  );
}

test("BEHAVIOURAL — packed pipelines survive late legacy standard and velocity completions", async () => {
  await assertColdStartOrdering(WebGPUPipelineRequestGuard);
});

test("BEHAVIOURAL — resource identity supersedes an earlier request in the same generation", async () => {
  await assertResourceIdentityOrdering(WebGPUPipelineRequestGuard);
});

test("MUTATION ABSENCE — removing guarded publication makes the behaviour fail", async () => {
  const target = [
    "    if (!this.isCurrent(token)) {",
    "      return false;",
    "    }",
    "",
  ].join(CRLF);
  const mutant = await importMutated(
    GUARD_FILE,
    (source) => source.replace(target, ""),
    "publication-guard absence",
  );
  await expectBehaviouralFailure(mutant, "publication-guard absence");
});

test("MUTATION INERTNESS — an always-current predicate makes the behaviour fail", async () => {
  const target = [
    "    return (",
    "      token.generation === this._generation &&",
    "      token.resources === this._resources",
    "    );",
  ].join(CRLF);
  const mutant = await importMutated(
    GUARD_FILE,
    (source) => source.replace(target, "    return true;"),
    "always-current predicate",
  );
  await expectBehaviouralFailure(mutant, "always-current predicate");
});

test("MUTATION INERTNESS — a false-wrapped decision makes the behaviour fail", async () => {
  const mutant = await importMutated(
    GUARD_FILE,
    (source) =>
      source.replace(
        "    if (!this.isCurrent(token))",
        "    if (false && !this.isCurrent(token))",
      ),
    "false-wrapped publication decision",
  );
  await expectBehaviouralFailure(mutant, "false-wrapped publication decision");
});

function maskNonCode(source) {
  const masked = source.split("");
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  const blank = (index) => {
    if (source[index] !== "\r" && source[index] !== "\n") {
      masked[index] = " ";
    }
  };

  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
      } else {
        blank(i);
      }
      continue;
    }
    if (blockComment) {
      blank(i);
      if (character === "*" && next === "/") {
        blank(i + 1);
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote !== null) {
      blank(i);
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      blank(i);
      blank(i + 1);
      lineComment = true;
      i++;
      continue;
    }
    if (character === "/" && next === "*") {
      blank(i);
      blank(i + 1);
      blockComment = true;
      i++;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      blank(i);
      quote = character;
    }
  }
  return masked.join("");
}

function findMatchingDelimiter(source, open, opening, closing) {
  assert.equal(
    source[open],
    opening,
    `WIRING: expected ${opening} at byte ${open}`,
  );
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === opening) {
      depth++;
    } else if (source[i] === closing) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  throw new Error(`WIRING: unmatched ${opening} at byte ${open}`);
}

function findCallRanges(source, marker) {
  const ranges = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) {
      break;
    }
    const open = start + marker.length - 1;
    const close = findMatchingDelimiter(source, open, "(", ")");
    ranges.push({ start, open, close });
    cursor = start + marker.length;
  }
  return ranges;
}

function trimRange(source, start, end) {
  while (start < end && /\s/.test(source[start])) {
    start++;
  }
  while (end > start && /\s/.test(source[end - 1])) {
    end--;
  }
  return { start, end };
}

function splitCallArguments(source, call) {
  const argumentsFound = [];
  let start = call.open + 1;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let i = start; i < call.close; i++) {
    switch (source[i]) {
      case "(":
        parentheses++;
        break;
      case ")":
        parentheses--;
        break;
      case "[":
        brackets++;
        break;
      case "]":
        brackets--;
        break;
      case "{":
        braces++;
        break;
      case "}":
        braces--;
        break;
      case ",":
        if (parentheses === 0 && brackets === 0 && braces === 0) {
          argumentsFound.push(trimRange(source, start, i));
          start = i + 1;
        }
        break;
    }
  }
  const finalArgument = trimRange(source, start, call.close);
  if (finalArgument.start !== finalArgument.end || argumentsFound.length > 0) {
    argumentsFound.push(finalArgument);
  }
  return argumentsFound;
}

function findCallbackRange(source, argument) {
  const trimmed = trimRange(source, argument.start, argument.end);
  const argumentSource = source.slice(trimmed.start, trimmed.end);
  if (/^(?:async\s+)?function\b/.test(argumentSource)) {
    const bodyOpen = source.indexOf("{", trimmed.start);
    if (bodyOpen < 0 || bodyOpen >= trimmed.end) {
      return null;
    }
    const bodyClose = findMatchingDelimiter(source, bodyOpen, "{", "}");
    if (bodyClose >= trimmed.end) {
      return null;
    }
    return {
      argumentEnd: trimmed.end,
      argumentStart: trimmed.start,
      end: bodyClose,
      start: bodyOpen + 1,
    };
  }

  const arrow = source.indexOf("=>", trimmed.start);
  if (arrow < 0 || arrow >= trimmed.end) {
    return null;
  }
  const bodyStart = trimRange(source, arrow + 2, trimmed.end).start;
  if (source[bodyStart] === "{") {
    const bodyClose = findMatchingDelimiter(source, bodyStart, "{", "}");
    if (bodyClose >= trimmed.end) {
      return null;
    }
    return {
      argumentEnd: trimmed.end,
      argumentStart: trimmed.start,
      end: bodyClose,
      start: bodyStart + 1,
    };
  }
  return {
    argumentEnd: trimmed.end,
    argumentStart: trimmed.start,
    end: trimmed.end,
    start: bodyStart,
  };
}

function findCallbackBodyRange(source, argument) {
  const callback = findCallbackRange(source, argument);
  return callback === null
    ? null
    : { start: callback.start, end: callback.end };
}

function findNamedFunctionRange(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `WIRING: did not find function ${name}`);
  const parametersOpen = start + marker.length - 1;
  const parametersClose = findMatchingDelimiter(
    source,
    parametersOpen,
    "(",
    ")",
  );
  const bodyOpen = source.indexOf("{", parametersClose + 1);
  assert.notEqual(bodyOpen, -1, `WIRING: did not find ${name}'s body`);
  const bodyClose = findMatchingDelimiter(source, bodyOpen, "{", "}");
  return { name, start, bodyOpen, bodyClose };
}

function findContainingFunction(functions, index) {
  return (
    functions.find(
      (candidate) => index > candidate.bodyOpen && index < candidate.bodyClose,
    )?.name ?? null
  );
}

function collectCompletionCallbacks(source) {
  const callbacks = [];
  for (const { marker, kind } of [
    { marker: ".then(", kind: "then" },
    { marker: ".catch(", kind: "catch" },
  ]) {
    for (const call of findCallRanges(source, marker)) {
      for (const argument of splitCallArguments(source, call)) {
        const callback = findCallbackRange(source, argument);
        if (callback !== null) {
          callbacks.push({ ...callback, callStart: call.start, kind });
        }
      }
    }
  }
  return callbacks.sort((left, right) => left.start - right.start);
}

function findEnclosingBraceRange(source, index) {
  const stack = [];
  for (let i = 0; i < index; i++) {
    if (source[i] === "{") {
      stack.push(i);
    } else if (source[i] === "}") {
      stack.pop();
    }
  }
  const open = stack.at(-1);
  assert.notEqual(open, undefined, `WIRING: no lexical scope at byte ${index}`);
  return {
    close: findMatchingDelimiter(source, open, "{", "}"),
    open,
  };
}

function collectRequestBindings(source, functions) {
  const bindings = [];
  const pattern =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*cache\.pipelineRequestGuard\.beginRequest\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const callOpen = pattern.lastIndex - 1;
    const callClose = findMatchingDelimiter(source, callOpen, "(", ")");
    const callMarkerOffset = match[0].lastIndexOf(
      "cache.pipelineRequestGuard.beginRequest",
    );
    const callStart = match.index + callMarkerOffset;
    const call = { start: callStart, open: callOpen, close: callClose };
    const argumentsFound = splitCallArguments(source, call);
    const scope = findEnclosingBraceRange(source, match.index);
    bindings.push({
      argument:
        argumentsFound.length === 1
          ? source.slice(argumentsFound[0].start, argumentsFound[0].end).trim()
          : null,
      callStart,
      declarationStart: match.index,
      functionName: findContainingFunction(functions, match.index),
      name: match[1],
      scope,
    });
  }
  return bindings;
}

function collectPublicationCalls(source, functions) {
  return findCallRanges(
    source,
    "cache.pipelineRequestGuard.publishIfCurrent(",
  ).map((call) => {
    const argumentsFound = splitCallArguments(source, call);
    return {
      ...call,
      callback:
        argumentsFound.length === 2
          ? findCallbackBodyRange(source, argumentsFound[1])
          : null,
      functionName: findContainingFunction(functions, call.start),
      token:
        argumentsFound.length > 0
          ? source.slice(argumentsFound[0].start, argumentsFound[0].end).trim()
          : null,
    };
  });
}

function collectCompletionAssignments(
  source,
  functions,
  callbacks,
  publications,
) {
  const assignments = [];
  const pattern =
    /\bcache\.(pipelineRequestPending|velocityPipelineRequestPending|pipeline|pickPipeline|depthWritePipeline|oitPipeline|velocityPipeline)\s*=/g;
  for (const callback of callbacks) {
    pattern.lastIndex = callback.start;
    let match;
    while (
      (match = pattern.exec(source)) !== null &&
      match.index < callback.end
    ) {
      const assignmentIndex = match.index;
      const slot = match[1];
      const publicationMatches = publications.filter(
        (publication) =>
          publication.callback !== null &&
          publication.start > callback.start &&
          publication.close < callback.end &&
          assignmentIndex > publication.callback.start &&
          assignmentIndex < publication.callback.end,
      );
      assignments.push({
        callback,
        functionName: findContainingFunction(functions, assignmentIndex),
        line: source.slice(0, assignmentIndex).split("\n").length,
        publication:
          publicationMatches.length === 1 ? publicationMatches[0] : null,
        publicationCount: publicationMatches.length,
        slot,
      });
    }
  }
  return assignments;
}

function assertRequestBindings(source, functions, callbacks) {
  const requestCalls = findCallRanges(
    source,
    "cache.pipelineRequestGuard.beginRequest(",
  );
  const nestedCalls = requestCalls
    .filter((call) =>
      callbacks.some(
        (callback) =>
          call.start >= callback.argumentStart &&
          call.close <= callback.argumentEnd,
      ),
    )
    .map((call) => source.slice(0, call.start).split("\n").length);
  assert.deepEqual(
    nestedCalls,
    [],
    `WIRING: beginRequest must not appear inside then/catch callbacks: ${nestedCalls.join(", ")}`,
  );

  const bindings = collectRequestBindings(source, functions);
  const unboundCalls = requestCalls
    .filter(
      (call) => !bindings.some((binding) => binding.callStart === call.start),
    )
    .map((call) => source.slice(0, call.start).split("\n").length);
  assert.deepEqual(
    unboundCalls,
    [],
    `WIRING: beginRequest calls must be const bindings: ${unboundCalls.join(", ")}`,
  );
  assert.deepEqual(
    bindings.map(({ argument, functionName }) => ({ argument, functionName })),
    [
      {
        argument: "resources",
        functionName: "tryResolveSplatPipelines",
      },
      {
        argument: "resources",
        functionName: "attachSplatVelocityCommand",
      },
    ],
    "WIRING: both request-token minting sites must bind resources before completion callbacks",
  );
  return bindings;
}

function assertCompletionPublications(assignments, bindings, publications) {
  const expectedAssignments = [
    "attachSplatVelocityCommand:catch:velocityPipelineRequestPending",
    "attachSplatVelocityCommand:then:velocityPipeline",
    "attachSplatVelocityCommand:then:velocityPipelineRequestPending",
    "tryResolveSplatPipelines:catch:depthWritePipeline",
    "tryResolveSplatPipelines:catch:oitPipeline",
    "tryResolveSplatPipelines:catch:pipelineRequestPending",
    "tryResolveSplatPipelines:then:depthWritePipeline",
    "tryResolveSplatPipelines:then:oitPipeline",
    "tryResolveSplatPipelines:then:pickPipeline",
    "tryResolveSplatPipelines:then:pipeline",
    "tryResolveSplatPipelines:then:pipelineRequestPending",
  ].sort();
  const observedAssignments = assignments
    .map(
      (assignment) =>
        `${assignment.functionName}:${assignment.callback.kind}:${assignment.slot}`,
    )
    .sort();
  assert.deepEqual(
    observedAssignments,
    expectedAssignments,
    "WIRING: completion coverage must include fulfilled, rejected, aggregate, and velocity settlements",
  );

  const unguarded = assignments
    .filter((assignment) => assignment.publicationCount !== 1)
    .map((assignment) => `${assignment.slot}:${assignment.line}`);
  assert.deepEqual(
    unguarded,
    [],
    `WIRING: assignments must be inside publishIfCurrent's second-argument callback: ${unguarded.join(", ")}`,
  );

  const unresolvedTokens = [];
  for (const assignment of assignments) {
    const publication = assignment.publication;
    if (!/^[A-Za-z_$][\w$]*$/.test(publication.token ?? "")) {
      unresolvedTokens.push(`${assignment.slot}:${assignment.line}`);
      continue;
    }
    const binding = bindings
      .filter(
        (candidate) =>
          candidate.name === publication.token &&
          candidate.functionName === assignment.functionName &&
          candidate.declarationStart < assignment.callback.callStart &&
          candidate.scope.open < assignment.callback.callStart &&
          candidate.scope.close > assignment.callback.callStart,
      )
      .sort((left, right) => right.declarationStart - left.declarationStart)[0];
    if (!binding) {
      unresolvedTokens.push(`${assignment.slot}:${assignment.line}`);
    }
  }
  assert.deepEqual(
    unresolvedTokens,
    [],
    `WIRING: publish tokens must resolve to beginRequest bindings declared outside and before their completion callbacks: ${unresolvedTokens.join(", ")}`,
  );

  assert.equal(
    publications.length,
    10,
    `WIRING: expected ten guarded completion publications, found ${publications.length}`,
  );
  const malformedPublications = publications
    .filter(
      (publication) =>
        publication.callback === null ||
        !assignments.some(
          (assignment) => assignment.publication === publication,
        ),
    )
    .map((publication) => publication.functionName ?? "unknown");
  assert.deepEqual(
    malformedPublications,
    [],
    "WIRING: every publishIfCurrent call must use a second-argument callback that publishes a covered completion",
  );
}

function assertInvalidationWiring(source, functions, callbacks) {
  const invalidations = findCallRanges(
    source,
    "cache.pipelineRequestGuard.invalidate(",
  );
  assert.equal(
    invalidations.length,
    1,
    `WIRING: expected one pipeline request invalidation, found ${invalidations.length}`,
  );
  const invalidation = invalidations[0];
  assert.equal(
    splitCallArguments(source, invalidation).length,
    0,
    "WIRING: pipeline request invalidation must take no arguments",
  );
  assert.equal(
    findContainingFunction(functions, invalidation.start),
    "updateWebGPUGaussianSplats",
    "WIRING: pipeline request invalidation must stay in the resource invalidation sweep",
  );
  assert.equal(
    callbacks.some(
      (callback) =>
        invalidation.start >= callback.argumentStart &&
        invalidation.close <= callback.argumentEnd,
    ),
    false,
    "WIRING: pipeline request invalidation must not be deferred",
  );
  const lineStart = source.lastIndexOf("\n", invalidation.start) + 1;
  const lineEnd = source.indexOf("\n", invalidation.close);
  assert.equal(
    source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).trim(),
    "cache.pipelineRequestGuard.invalidate();",
    "WIRING: pipeline request invalidation must be an unconditional statement",
  );
}

function assertRendererWiring(source) {
  assertCrLfOnly(source, "renderer source");
  const masked = maskNonCode(source);
  const functions = [
    findNamedFunctionRange(masked, "tryResolveSplatPipelines"),
    findNamedFunctionRange(masked, "updateWebGPUGaussianSplats"),
    findNamedFunctionRange(masked, "attachSplatVelocityCommand"),
  ];
  const callbacks = collectCompletionCallbacks(masked);
  const bindings = assertRequestBindings(masked, functions, callbacks);
  const publications = collectPublicationCalls(masked, functions);
  const assignments = collectCompletionAssignments(
    masked,
    functions,
    callbacks,
    publications,
  );
  assertCompletionPublications(assignments, bindings, publications);
  assertInvalidationWiring(masked, functions, callbacks);
}

async function expectRendererWiringFailure(mutate, label) {
  await assert.rejects(
    () =>
      withMutatedCopy(RENDERER_FILE, mutate, label, async (copy) =>
        assertRendererWiring(await readFile(copy, "utf8")),
      ),
    (error) =>
      error?.code === "ERR_ASSERTION" && /WIRING/.test(String(error.message)),
    `the wiring scanner must reject the ${label} mutant`,
  );
}

test("WIRING — defense-in-depth: every pipeline-slot completion is guarded", async () => {
  assertRendererWiring(await readFile(RENDERER_FILE, "utf8"));
});

test("WIRING MUTATION ABSENCE — fulfilled publication cannot lose its guard", async () => {
  const target = [
    "          cache.pipelineRequestGuard.publishIfCurrent(requestToken, () => {",
    "            cache.pipeline = p;",
    "          });",
  ].join(CRLF);
  await expectRendererWiringFailure(
    (source) => source.replace(target, "          cache.pipeline = p;"),
    "fulfilled publication absence",
  );
});

test("WIRING MUTATION INERTNESS — assignment in the token argument is not guarded publication", async () => {
  const target = [
    "          cache.pipelineRequestGuard.publishIfCurrent(requestToken, () => {",
    "            cache.pipeline = p;",
    "          });",
  ].join(CRLF);
  const inert = [
    "          cache.pipelineRequestGuard.publishIfCurrent(",
    "            (cache.pipeline = p, requestToken),",
    "            () => {},",
    "          );",
  ].join(CRLF);
  await expectRendererWiringFailure(
    (source) => source.replace(target, inert),
    "first-argument publication inertness",
  );
});

test("WIRING MUTATION INERTNESS — completion callback cannot remint its stale resource token", async () => {
  const target =
    "        pipelineCache.getPipeline(resources.colorDescriptor).then((p) => {";
  const inert = [
    target,
    "          const requestToken =",
    "            cache.pipelineRequestGuard.beginRequest(resources);",
  ].join(CRLF);
  await expectRendererWiringFailure(
    (source) => source.replace(target, inert),
    "completion-local request-token remint",
  );
});

test("WIRING MUTATION ABSENCE — depth-write rejection publication is covered", async () => {
  const target = [
    "            cache.pipelineRequestGuard.publishIfCurrent(requestToken, () => {",
    "              cache.depthWritePipeline = null;",
    "            });",
  ].join(CRLF);
  await expectRendererWiringFailure(
    (source) =>
      source.replace(target, "            cache.depthWritePipeline = null;"),
    "depth-write rejection publication absence",
  );
});

test("WIRING MUTATION ABSENCE — OIT rejection publication is covered", async () => {
  const target = [
    "              cache.pipelineRequestGuard.publishIfCurrent(requestToken, () => {",
    "                cache.oitPipeline = null;",
    "              });",
  ].join(CRLF);
  await expectRendererWiringFailure(
    (source) =>
      source.replace(target, "              cache.oitPipeline = null;"),
    "OIT rejection publication absence",
  );
});

test("WIRING MUTATION ABSENCE — aggregate pending settlement is covered", async () => {
  const target = [
    "          cache.pipelineRequestGuard.publishIfCurrent(requestToken, () => {",
    "            cache.pipelineRequestPending = false;",
    "          });",
  ].join(CRLF);
  await expectRendererWiringFailure(
    (source) =>
      source.replace(target, "          cache.pipelineRequestPending = false;"),
    "aggregate pending settlement absence",
  );
});

test("WIRING MUTATION ABSENCE — velocity rejection settlement is covered", async () => {
  const target = [
    "            cache.pipelineRequestGuard.publishIfCurrent(requestToken, () => {",
    "              cache.velocityPipelineRequestPending = false;",
    "            });",
  ].join(CRLF);
  await expectRendererWiringFailure(
    (source) =>
      source.replace(
        target,
        "            cache.velocityPipelineRequestPending = false;",
      ),
    "velocity rejection settlement absence",
  );
});

test("WIRING MUTATION ABSENCE — standard request-token minting is covered", async () => {
  const target =
    "      const requestToken = cache.pipelineRequestGuard.beginRequest(resources);" +
    CRLF;
  await expectRendererWiringFailure(
    (source) => source.replace(target, ""),
    "standard request-token minting absence",
  );
});

test("WIRING MUTATION ABSENCE — velocity request-token minting is covered", async () => {
  const target =
    "        const requestToken = cache.pipelineRequestGuard.beginRequest(resources);" +
    CRLF;
  await expectRendererWiringFailure(
    (source) => source.replace(target, ""),
    "velocity request-token minting absence",
  );
});

test("WIRING MUTATION ABSENCE — resource sweep cannot lose request invalidation", async () => {
  const target = "    cache.pipelineRequestGuard.invalidate();" + CRLF;
  await expectRendererWiringFailure(
    (source) => source.replace(target, ""),
    "request invalidation absence",
  );
});

test("WIRING MUTATION INERTNESS — resource invalidation cannot be false-wrapped", async () => {
  await expectRendererWiringFailure(
    (source) =>
      source.replace(
        "    cache.pipelineRequestGuard.invalidate();",
        "    false && cache.pipelineRequestGuard.invalidate();",
      ),
    "false-wrapped request invalidation",
  );
});
