// SAME-TASK CAPTURE — the fused render-and-read primitives, in one place.
//
// ★ WHAT THIS PREVENTS. A probe that renders, yields to the browser, and THEN
// reads the canvas is reading a buffer neither backend guarantees still exists.
// Both mechanisms have now cost a full executor cycle, in two different lanes,
// reached from opposite directions:
//
//   WebGL  — the drawing buffer is CLEARED after the compositor swap unless
//            `preserveDrawingBuffer` is set, so `drawImage(canvas)` reads
//            BLACK. Signature: every capture byte-identical across
//            configurations that should differ (C12-29 S6 measured four
//            identical 20,861-byte all-black PNGs).
//   WebGPU — the swap-chain texture is INVALIDATED after presentation, so a
//            deferred `drawImage(canvas)` can read an empty or stale surface.
//            Signature: same-task `toDataURL()` contains a 1.8 MB rendered PNG
//            while the later 2D-canvas read reports every pixel as zero.
//
// Neither is a rendering failure. In both cases the engine rendered correctly
// and the PROBE read the wrong thing — which is why the symptom (“the WebGL
// lane renders nothing”) points away from the cause.
//
// HOW THE TWO LANES GOT HERE, because the paths matter more than the fix:
//   - C12-29 S6 (sky) wrote `await frame(); await frame(); readPixels()` from
//     the start, and every helper inherited it.
//   - C12-29 S5 (umbra) made its settle helpers `async` to fix tile
//     starvation, which INSERTED yields between render and read.
// A correct probe can acquire this defect by fixing an unrelated bug. That is
// what makes it a class rather than a mistake, and why it gets an enforceable
// home rather than doctrine.
//
// ── THE CONSTRAINT THAT SHAPES THIS MODULE'S API ──────────────────────────
//
// The capture primitives MUST run inside `page.evaluate`, and module-scope
// bindings DO NOT cross that boundary — a Playwright page cannot import a Node
// ESM module. So this module cannot export functions for probes to call
// directly; exporting them that way produces a module neither probe can
// actually use.
//
// It therefore exports the CANONICAL SOURCE TEXT of the primitives, which each
// probe embeds inside its own `page.evaluate` callback between the markers
// below, plus Node-side validators that specs run against a probe's text. Drift
// is impossible because `checkEmbeddedCaptureIsCanonical` compares the embedded
// copy against this file byte-for-byte. That is the same shape the fleet
// already uses for `m1PointSourceCensus` and for `env-matrix-shape.spec.mjs`'s
// marker-delimited extraction — in-page code lives as text, and the spec holds
// it to the canonical copy.
//
// (An alternative — shipping the source and `new Function`-ing it in-page —
// was rejected: it adds an eval-shaped dependency on page CSP for no benefit,
// since the embedded-and-pinned form already makes drift a spec failure.)
//
// @module same-task-capture

import { parse } from "acorn";

/** Marker opening the embedded canonical block in a probe. */
export const CAPTURE_BEGIN = "// ==BEGIN same-task-capture==";

/** Marker closing the embedded canonical block in a probe. */
export const CAPTURE_END = "// ==END same-task-capture==";

/**
 * The canonical in-page primitives, as text.
 *
 * Contract, and the reason each exists:
 *   `renderNow()`   — render at the pinned instant. The ONLY renderer.
 *   `captureNow()`  — render + synchronously freeze a PNG in ONE task, then
 *                     asynchronously decode that immutable snapshot to
 *                     ImageData. The GPU canvas is never read after yielding.
 *   `grabNow()`     — render + synchronously freeze a PNG data URL in ONE task.
 *   `settleThen(n, done, capture)` — yields ONLY on the loading side: it awaits
 *                     `requestAnimationFrame` while `done()` is false, up to
 *                     `n` frames, rechecks `done()` after the final frame, and
 *                     then calls `capture()` with NO yield between the final
 *                     render and the read. This is the shape that lets a probe
 *                     fix tile starvation without reintroducing the defect —
 *                     the trap the umbra lane fell into.
 *
 * `scene`, `canvas` and `timeFn` are supplied by the probe; `timeFn` returns
 * the pinned instant so the clock discipline stays the probe's own.
 *
 * FORMATTING CONTRACT: every line below must stay short enough that Prettier
 * leaves it on one line at the deepest indentation any probe embeds it at
 * (`page.evaluate` callbacks add 2-6 columns). A line that Prettier wraps in
 * the probe but not here reads as drift to
 * `checkEmbeddedCaptureIsCanonical` even though the code is identical — that
 * is why `hasCapture` and `decodeFailed` exist as named intermediates rather
 * than inline expressions. Keep new lines under ~66 columns.
 */
export const SAME_TASK_CAPTURE_SOURCE = `const makeSameTaskCapture = (scene, canvas, timeFn) => {
  const renderNow = () => scene.render(timeFn());
  const tmp = document.createElement("canvas");
  const ctx = tmp.getContext("2d", { willReadFrequently: true });
  const decodeSnapshot = async (snapshot) => {
    const image = new Image();
    const loaded = new Promise((resolve, reject) => {
      const decodeFailed = "same-task PNG decode failed";
      image.onload = resolve;
      image.onerror = () => reject(new Error(decodeFailed));
    });
    image.src = snapshot;
    await loaded;
    tmp.width = image.naturalWidth;
    tmp.height = image.naturalHeight;
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, tmp.width, tmp.height);
  };
  const snapshotNow = () => {
    renderNow();
    return canvas.toDataURL("image/png");
  };
  const captureNow = () => {
    const snapshot = snapshotNow();
    return decodeSnapshot(snapshot);
  };
  const grabNow = snapshotNow;
  const settleThen = async (maxFrames, done, capture) => {
    let settled = false;
    for (let k = 0; k < maxFrames; k++) {
      if (typeof done === "function" && done() === true) {
        settled = true;
        break;
      }
      renderNow();
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (!settled && typeof done === "function") {
      settled = done() === true;
    }
    const hasCapture = typeof capture === "function";
    const result = hasCapture ? await capture() : undefined;
    return { settled, result };
  };
  return { renderNow, captureNow, grabNow, settleThen };
};`;

/**
 * A two-read-path fault DISCRIMINATOR, as text.
 *
 * ── DELIBERATELY OUTSIDE THE CANONICAL BLOCK ──────────────────────────────
 * This is NOT part of `SAME_TASK_CAPTURE_SOURCE` and must never be embedded
 * between `CAPTURE_BEGIN` / `CAPTURE_END`. `checkEmbeddedCaptureIsCanonical`
 * compares that block byte-for-byte, so anything added inside it becomes drift
 * in every probe that has not also added it. This is opt-in, embedded
 * separately by the probes that want it, and carries no canonicity guarantee.
 * The FORMATTING CONTRACT above does not bind it either, for the same reason —
 * nothing compares this text against an embedded copy.
 *
 * ── WHAT IT ANSWERS, AND THE FAILURE THAT PAID FOR IT ─────────────────────
 * When a capture comes back black, there are two candidate faults and they
 * demand opposite responses:
 *
 *   render-fault           — the renderer genuinely drew nothing. Fix the scene.
 *   capture-fault-drawImage— the renderer drew correctly and the READER lost it.
 *                            Fix the instrument; the scene is innocent.
 *
 * ★ A DISCRIMINATOR MUST NOT BE BUILT FROM THE PRIMITIVE IT DISCRIMINATES.
 * The first version of this check ran through `captureNow()` — i.e. `drawImage`
 * + `getImageData` — reported 0% non-black over 24,909 samples, and concluded
 * "THE RENDERER DREW NOTHING". That was FALSE on WebGPU: `toDataURL` on the
 * SAME canvas in the SAME task returned a 1,394,273-byte PNG of a fully correct
 * render. A check that shares the suspect path can only ever confirm the
 * suspect path's own answer.
 *
 * So this reads BOTH ways and treats DISAGREEMENT as the signal. PNG byte
 * length is the independent measure and needs no decode: an all-black PNG of a
 * viewer-sized canvas is ~21 KB and a real render ~1.4 MB — two orders apart,
 * far outside any plausible compression variation.
 *
 * ── WHAT IT DOES NOT COVER ────────────────────────────────────────────────
 * The per-read ALLOCATION question (`readUnfused` allocating a fresh canvas per
 * read) is NOT answered here. Answering it would need a probe-local
 * `drawImage` + `getImageData` reader, which `checkFusedCaptureUsage` correctly
 * rejects — a second reader beside the shared primitives is exactly the shape
 * that rule exists to stop, and it does not stop being that because the second
 * reader is a diagnostic. That question is about the canonical primitive
 * itself, so it belongs to this module, not to a probe.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────
 * Embed inside `page.evaluate`, AFTER the canonical block (it needs
 * `captureNow` in scope), then call `canvasHasContent()`:
 *
 *   const { verdict, pathsDisagree } = canvasHasContent();
 *   if (verdict === "capture-fault-drawImage") { ... instrument is at fault ... }
 *
 * `luminanceStats` samples every 37th pixel — coprime with 4 and with common
 * widths, so it does not alias onto a column.
 *
 * ORIGIN: `probe-eclipse-umbra-globe.mjs` (C12-29 S5, worktree
 * `agent-a6de88899b2982d6c`), extracted here so the next probe inherits the
 * lesson instead of rediscovering it against a live WebGPU device.
 */
export const TWO_READ_PATH_DISCRIMINATOR_SOURCE = `const makeReadPathDiscriminator = (captureNow, grabNow) => {
  const luminanceStats = (image) => {
    const data = image.data;
    let nonBlack = 0;
    let max = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4 * 37) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum > max) {
        max = lum;
      }
      if (lum > 8) {
        nonBlack++;
      }
      n++;
    }
    const fraction = n > 0 ? nonBlack / n : 0;
    return { nonBlackFraction: fraction, maxLuminance: max, samples: n };
  };
  const canvasHasContent = async () => {
    const viaFreshDrawImage = luminanceStats(await captureNow());
    const url = grabNow();
    const pngBytes = typeof url === "string" ? url.length : 0;
    const AN_ALL_BLACK_PNG_IS_SMALLER_THAN = 100000;
    const dataUrlHasContent = pngBytes > AN_ALL_BLACK_PNG_IS_SMALLER_THAN;
    const drawImageSeesContent = viaFreshDrawImage.nonBlackFraction > 0.05;
    const disagree = drawImageSeesContent !== dataUrlHasContent;
    const verdict = drawImageSeesContent
      ? "sampler-ok"
      : dataUrlHasContent
        ? "capture-fault-drawImage"
        : "render-fault";
    return {
      viaFreshDrawImage,
      viaDataUrl: { pngBytes, hasContent: dataUrlHasContent },
      pathsDisagree: disagree,
      verdict,
    };
  };
  return { canvasHasContent, luminanceStats };
};`;

/**
 * Extract a probe's embedded canonical block.
 *
 * @param {string} probeSource
 * @returns {string|null} The embedded text, or null when the markers are absent.
 */
export function extractEmbeddedCapture(probeSource) {
  const text = String(probeSource ?? "").replace(/\r\n/g, "\n");
  const start = text.indexOf(CAPTURE_BEGIN);
  const end = text.indexOf(CAPTURE_END);
  if (start < 0 || end <= start) {
    return null;
  }
  const block = text
    .slice(start + CAPTURE_BEGIN.length, end)
    .replace(/^\n/, "")
    .replace(/\n[ \t]*$/, "");

  // DEDENT before comparing. A probe embeds this inside a `page.evaluate`
  // callback and will indent it to match its surroundings; requiring
  // column-0 embedding would be a formatting trap of exactly the kind this
  // fleet keeps paying for. The comparison is about the CODE, so the common
  // leading indentation is removed and the canonical form is column-0.
  const lines = block.split("\n");
  let common = null;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const indent = line.match(/^[ \t]*/)[0];
    if (common === null || indent.length < common.length) {
      common = indent;
    }
  }
  if (!common) {
    return block;
  }
  return lines
    .map((l) => (l.startsWith(common) ? l.slice(common.length) : l))
    .join("\n");
}

/**
 * The embedded copy must be byte-identical to the canonical source, so the two
 * cannot drift.
 *
 * @param {string} probeSource
 * @returns {string[]} Failures; empty means the probe carries the canonical copy.
 */
export function checkEmbeddedCaptureIsCanonical(probeSource) {
  const embedded = extractEmbeddedCapture(probeSource);
  if (embedded === null) {
    return [
      `the probe does not embed the canonical block — expected it between ${CAPTURE_BEGIN} and ${CAPTURE_END}`,
    ];
  }
  if (embedded !== SAME_TASK_CAPTURE_SOURCE) {
    return [
      "the embedded capture block has DRIFTED from lib/same-task-capture.mjs — " +
        "re-copy it rather than editing the probe's copy",
    ];
  }
  return [];
}

function isAstNode(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.type === "string"
  );
}

function visitAst(node, parent, visitor) {
  if (!isAstNode(node)) {
    return;
  }
  if (visitor(node, parent) === false) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "type" ||
      key === "start" ||
      key === "end" ||
      key === "loc" ||
      key === "range"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        visitAst(child, node, visitor);
      }
    } else {
      visitAst(value, node, visitor);
    }
  }
}

function isFunctionNode(node) {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression" ||
    node?.type === "FunctionDeclaration"
  );
}

function memberPropertyName(member) {
  if (member?.type !== "MemberExpression") {
    return undefined;
  }
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  if (
    member.computed &&
    member.property.type === "Literal" &&
    typeof member.property.value === "string"
  ) {
    return member.property.value;
  }
  return undefined;
}

function callIdentifierName(call) {
  return call?.type === "CallExpression" && call.callee.type === "Identifier"
    ? call.callee.name
    : undefined;
}

function isPromiseAllCall(call) {
  return (
    call?.type === "CallExpression" &&
    call.callee.type === "MemberExpression" &&
    call.callee.object.type === "Identifier" &&
    call.callee.object.name === "Promise" &&
    memberPropertyName(call.callee) === "all"
  );
}

/**
 * A capture is handled only when its promise is awaited without passing
 * through an arbitrary function. These are the deliberately supported forms:
 *
 *   await captureNow()
 *   await captureAlias()
 *   await Promise.all([captureNow(), captureAlias()])
 *   await captureNow().then(...)
 *
 * An unawaited Promise.all or `.then` chain is still a floating capture and is
 * rejected. Storing the promise for a later await is intentionally forbidden:
 * the validator cannot prove that every control-flow path reaches that await.
 */
function isCaptureCallAwaited(call, parents) {
  let cursor = call;
  for (;;) {
    const parent = parents.get(cursor);
    if (!parent || isFunctionNode(parent)) {
      return false;
    }
    if (parent.type === "AwaitExpression" && parent.argument === cursor) {
      return true;
    }
    if (parent.type === "ChainExpression" && parent.expression === cursor) {
      cursor = parent;
      continue;
    }

    // Promise.all is transparent only for a direct array entry and only when
    // the aggregate itself eventually reaches an await.
    if (parent.type === "ArrayExpression") {
      const aggregate = parents.get(parent);
      if (
        aggregate &&
        isPromiseAllCall(aggregate) &&
        aggregate.arguments.includes(parent)
      ) {
        cursor = aggregate;
        continue;
      }
      return false;
    }

    // A .then/.catch/.finally chain adopts the source promise, but the chain
    // must itself be awaited. Merely attaching a callback is not completion.
    if (
      parent.type === "MemberExpression" &&
      parent.object === cursor &&
      ["then", "catch", "finally"].includes(memberPropertyName(parent))
    ) {
      const chainedCall = parents.get(parent);
      if (
        chainedCall?.type === "CallExpression" &&
        chainedCall.callee === parent
      ) {
        cursor = chainedCall;
        continue;
      }
      return false;
    }

    return false;
  }
}

function functionCallsCapture(functionNode, captureFunctionNames) {
  let found = false;
  visitAst(functionNode.body, functionNode, (node) => {
    if (node !== functionNode.body && isFunctionNode(node)) {
      return false;
    }
    if (
      node.type === "CallExpression" &&
      captureFunctionNames.has(callIdentifierName(node))
    ) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

function collectCaptureFunctionNames(ast) {
  const names = new Set(["captureNow"]);
  let changed = true;
  while (changed) {
    changed = false;
    // eslint-disable-next-line no-loop-func -- the closure is consumed inside this iteration (or reads a shared kill switch), not a stale per-iteration binding
    visitAst(ast, undefined, (node) => {
      let name;
      let value;
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        name = node.id.name;
        value = node.init;
      } else if (
        node.type === "AssignmentExpression" &&
        node.operator === "=" &&
        node.left.type === "Identifier"
      ) {
        name = node.left.name;
        value = node.right;
      } else if (node.type === "FunctionDeclaration" && node.id) {
        name = node.id.name;
        value = node;
      }

      if (!name || !value || names.has(name)) {
        return;
      }
      const isDirectAlias =
        value.type === "Identifier" && names.has(value.name);
      const isCaptureWrapper =
        isFunctionNode(value) && functionCallsCapture(value, names);
      if (isDirectAlias || isCaptureWrapper) {
        names.add(name);
        changed = true;
      }
    });
  }
  return names;
}

function sourceOutsideCanonical(text) {
  const start = text.indexOf(CAPTURE_BEGIN);
  const end = text.indexOf(CAPTURE_END);
  if (start < 0 || end <= start) {
    return text;
  }

  // Preserve line numbers so AST diagnostics still point at the probe.
  const removed = text.slice(start, end + CAPTURE_END.length);
  const blankLines = removed.replace(/[^\n]/g, "");
  return `${text.slice(0, start)}${blankLines}${text.slice(
    end + CAPTURE_END.length,
  )}`;
}

/**
 * The general, fleet-wide guarantees: no unfused read survives, there is a
 * single immutable pixel source, and async ImageData captures are awaited.
 * Probe-specific assertions stay in the probe's own spec; these belong to
 * every probe that captures pixels.
 *
 * @param {string} probeSource
 * @returns {string[]} Failures; empty means the probe is fused correctly.
 */
export function checkFusedCaptureUsage(probeSource) {
  const failures = [];
  const text = String(probeSource ?? "").replace(/\r\n/g, "\n");
  const code = sourceOutsideCanonical(text);
  let ast;
  try {
    ast = parse(code, {
      allowAwaitOutsideFunction: true,
      ecmaVersion: "latest",
      locations: true,
      sourceType: "module",
    });
  } catch (error) {
    return [
      `capture validator could not parse the probe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }

  const parents = new WeakMap();
  visitAst(ast, undefined, (node, parent) => {
    if (parent) {
      parents.set(node, parent);
    }
  });

  // (1) No ad-hoc canvas read may bypass the immutable-snapshot primitives.
  visitAst(ast, undefined, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const identifierName =
      node.callee.type === "Identifier" ? node.callee.name : undefined;
    const propertyName = memberPropertyName(node.callee);
    let why;
    if (
      ["getImageData", "toDataURL", "toBlob", "transferToImageBitmap"].includes(
        identifierName ?? propertyName,
      )
    ) {
      why = identifierName ?? propertyName;
    } else if (
      (identifierName === "drawImage" || propertyName === "drawImage") &&
      node.arguments[0]?.type === "Identifier" &&
      node.arguments[0].name === "canvas"
    ) {
      why = "drawImage(canvas";
    } else if (
      identifierName === "createImageBitmap" &&
      node.arguments[0]?.type === "Identifier" &&
      node.arguments[0].name === "canvas"
    ) {
      why = "createImageBitmap(canvas";
    }
    if (why) {
      failures.push(
        `${why} appears outside the canonical block at line ${
          node.loc?.start.line ?? "?"
        } — a probe-local reader is bypassing the immutable snapshot`,
      );
    }
  });

  // (2) `captureNow` and every statically discoverable wrapper/alias return a
  // Promise. Requiring the invocation itself (or its Promise.all/.then chain)
  // to reach `await` prevents an awaited wrapper body from disguising an
  // unawaited wrapper call.
  const captureFunctionNames = collectCaptureFunctionNames(ast);
  visitAst(ast, undefined, (node) => {
    if (
      node.type !== "CallExpression" ||
      !captureFunctionNames.has(callIdentifierName(node)) ||
      isCaptureCallAwaited(node, parents)
    ) {
      return;
    }
    const name = callIdentifierName(node);
    failures.push(
      `${name}() is not awaited at line ${
        node.loc?.start.line ?? "?"
      } — await it directly, through awaited Promise.all([...]), or through an awaited .then chain`,
    );
  });

  return failures;
}

export default {
  CAPTURE_BEGIN,
  CAPTURE_END,
  SAME_TASK_CAPTURE_SOURCE,
  TWO_READ_PATH_DISCRIMINATOR_SOURCE,
  extractEmbeddedCapture,
  checkEmbeddedCaptureIsCanonical,
  checkFusedCaptureUsage,
};
