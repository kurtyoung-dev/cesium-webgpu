// mat-logdepth-encode-stash.spec.mjs — browser-free durable guard for
// NEW-WEBGPU-MAT-LOGDEPTH-MULTI-PRIMITIVE-DEPTH-LOSS.
// @purpose Executes the real writeLogDepthTail packer to pin stash-first log-depth encoding for the Mat/Primitive family; replays the 2-primitive defect.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// `WebGPUPrimitiveCommands.writeLogDepthTail` — the ONE helper that packs the
// log-depth tail (near, far, factor, reserved) for the entire geometry-
// Primitive family (Mat*/PBR/Basic/Phong camera UBs at floats 40/80, the
// polyline-appearance UB at float 92, and the pick camera UBs) — used to read
// the LIVE `uniformState.currentFrustum` + `oneOverLog2FarDepthFromNearPlusOne`
// pair at whatever moment the pack happened to run. That pair is a MOVING
// TARGET: `_updateFrustumUniforms` re-slices it once per frustum slice, the
// translucent near refresh re-slices it again, and the pick loops re-slice it
// for the pick mini-frame. Every OTHER renderer-wide log-depth producer
// (globe, depth plane, Billboard, Label, PointPrimitive, Polyline,
// GroundPolyline, GroundPrimitive, Vector3DTile×3, Voxel, GaussianSplat,
// EllipsoidPrimitive, SSR, ContactShadows) already encodes against the
// frame-stable FULL-camera stash `uniformState._logDepthEncodeNearFar`,
// published by the globe camera-UB pack and by BOTH frustum loops BEFORE any
// slice remap (see NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT in
// `WebGPUDepthPlane.ts`). The Mat path was the LAST producer off that
// contract, so its frag_depth curve depended on pack timing — and
// `probe-logdepth-zfight.mjs` measured the signature failure: with a SECOND
// Mat primitive in the scene, a slab 5 m ABOVE the globe lost ~11% of its
// pixels to the globe (check 2 ratio 0.868) in a stable, spatially-coherent
// region, log-ON only.
//
// WHAT THIS SPEC PINS — three different kinds of fact
// ---------------------------------------------------
//   A. The EXECUTED packer semantics: the REAL `writeLogDepthTail` source is
//      extracted from `WebGPUPrimitiveCommands.ts` and executed. Stash-first
//      when the stash is valid (with the factor published from the SAME pair
//      so encode + factor stay self-consistent and the packer avoids repeated
//      logarithms), live-pair fallback before
//      the stash exists. A depth-compare oracle replays the two-primitive
//      defect numerically: under re-sliced live state, the OLD semantics put
//      the slab BEHIND the globe; the stash-first tail restores the true 5-m
//      win.
//   B. SOURCE facts about `WebGPUPrimitiveCommands.ts`: the tail is packed by
//      exactly this one helper at the three pinned offsets, and no other code
//      in the file reads the live log-depth factor.
//   C. The CONTRACT PAIRING: the real publisher
//      (`publishLogDepthEncodeNearFar`) is executed and must write the exact
//      field the packer reads — a one-sided rename of either half breaks this
//      pairing test, not just a comment.
//
// Group A carries a MUTATION test that re-introduces the defect (packer
// ignores the stash) and requires the stash-first assertion AND the depth
// oracle to detect it. Without it, a green result here is unfalsifiable.
//
// Run: node --test Tools/visual-regression/mat-logdepth-encode-stash.spec.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const WEBGPU_DIR = resolve(ROOT, "packages/engine/Source/Renderer/WebGPU");
const COMMANDS = join(WEBGPU_DIR, "WebGPUPrimitiveCommands.ts");

const commandsSource = readFileSync(COMMANDS, "utf8");

enableEngineTsResolution();
const { publishLogDepthEncodeNearFar } = await import(
  pathToFileURL(join(WEBGPU_DIR, "WebGPUSceneRendererFrustumState.ts")).href
);

// ─── lexical helpers ─────────────────────────────────────────────────────────

/** Remove comments so a source scan cannot be satisfied — or defeated — by prose. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Extract a top-level `function name(...) {...}` — signature through the
 * matching closing brace — from a source string.
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const bodyOpen = source.indexOf("{", start);
  assert.notEqual(bodyOpen, -1, `function ${name} has no body`);
  let depth = 0;
  for (let i = bodyOpen; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  assert.fail(`function ${name} has unbalanced braces`);
}

/**
 * Erase the TS parameter annotations from an extracted function so Node can
 * execute it. Only the signature (up to the body's `{`) carries annotations —
 * the body is deliberately annotation-free (no casts) so this stays exact.
 */
function eraseSignatureTypes(fnSource) {
  const bodyOpen = fnSource.indexOf("{");
  const signature = fnSource
    .slice(0, bodyOpen)
    .replace(/:\s*[A-Za-z_$][\w$.]*/g, "");
  return signature + fnSource.slice(bodyOpen);
}

/** Cesium's `defined` — the one runtime dependency of the extracted packer. */
const definedImpl = (value) => value !== undefined && value !== null;

/** Compile the (possibly mutated) packer source into a callable. */
function compileTail(fnSource) {
  const runnable = eraseSignatureTypes(fnSource);
  // eslint-disable-next-line no-new-func
  return new Function("defined", `${runnable}\nreturn writeLogDepthTail;`)(
    definedImpl,
  );
}

const tailSource = extractFunction(
  stripComments(commandsSource),
  "writeLogDepthTail",
);
const writeLogDepthTail = compileTail(tailSource);

// ─── the two-primitive scene's numbers ──────────────────────────────────────
// Camera: log-depth camera frustum (0.1, 1e10) — the published frame encode.
// Re-sliced live state: a content-fit slice (177 km, 350 km) — what
// `_updateFrustumUniforms` leaves in `currentFrustum` after a slice remap.
// Slab 5 m above the globe at a 220 km nadir camera.
const STASH_NEAR = 0.1;
const STASH_FAR = 1.0e10;
const SLICE_NEAR = 177000.0;
const SLICE_FAR = 350000.0;
const W_GLOBE = 220000.0;
const W_SLAB = W_GLOBE - 5.0;

const factorOf = (near, far) => 1.0 / Math.log2(far - near + 1.0);
/** The WGSL pair: csm_vertexLogDepth + csm_writeLogDepth. */
const shaderDepth = (w, near, factor) => Math.log2(w - near + 1.0) * factor;

const stashedState = () => ({
  currentFrustum: { x: SLICE_NEAR, y: SLICE_FAR },
  oneOverLog2FarDepthFromNearPlusOne: factorOf(SLICE_NEAR, SLICE_FAR),
  _logDepthEncodeNearFar: new Float32Array([STASH_NEAR, STASH_FAR]),
  _logDepthEncodeFactor: factorOf(
    Math.fround(STASH_NEAR),
    Math.fround(STASH_FAR),
  ),
});

function packTail(fn, uniformState, offset = 40) {
  const ud = new Float32Array(offset + 4);
  fn(ud, offset, uniformState);
  return {
    near: ud[offset + 0],
    far: ud[offset + 1],
    factor: ud[offset + 2],
    reserved: ud[offset + 3],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// A. THE PACKER — executed, not described
// ═══════════════════════════════════════════════════════════════════════════

test("PACKER — a tail packed while currentFrustum holds re-sliced state still encodes the published frame encode", () => {
  const tail = packTail(writeLogDepthTail, stashedState());
  assert.equal(
    tail.near,
    Math.fround(STASH_NEAR),
    "near must come from the _logDepthEncodeNearFar stash, not the live slice",
  );
  assert.equal(
    tail.far,
    Math.fround(STASH_FAR),
    "far must come from the _logDepthEncodeNearFar stash, not the live slice",
  );
  assert.equal(tail.reserved, 0.0);
});

test("PACKER — when the stash drives, its factor matches the SAME pair (never the live per-slice factor)", () => {
  const tail = packTail(writeLogDepthTail, stashedState());
  const stashFactor = factorOf(STASH_NEAR, STASH_FAR);
  assert.equal(
    tail.factor,
    Math.fround(stashFactor),
    "factor must be derived from the stash near/far so encode + factor are " +
      "self-consistent",
  );
  // Non-vacuity: the live factor is genuinely different in this scenario, so
  // the assertion above cannot pass by coincidence.
  assert.notEqual(
    Math.fround(factorOf(SLICE_NEAR, SLICE_FAR)),
    Math.fround(stashFactor),
  );
});

test("PACKER — a published encode factor avoids per-command Math.log2 work", () => {
  const state = stashedState();
  const originalLog2 = Math.log2;
  Math.log2 = () => {
    throw new Error("writeLogDepthTail recalculated the frame-stable factor");
  };
  try {
    const tail = packTail(writeLogDepthTail, state);
    assert.equal(tail.factor, Math.fround(state._logDepthEncodeFactor));
  } finally {
    Math.log2 = originalLog2;
  }
});

test("PACKER — before the stash exists, the legacy live-pair fallback is unchanged", () => {
  const liveFactor = factorOf(SLICE_NEAR, SLICE_FAR);
  for (const stashless of [
    {
      currentFrustum: { x: SLICE_NEAR, y: SLICE_FAR },
      oneOverLog2FarDepthFromNearPlusOne: liveFactor,
    },
    {
      currentFrustum: { x: SLICE_NEAR, y: SLICE_FAR },
      oneOverLog2FarDepthFromNearPlusOne: liveFactor,
      _logDepthEncodeNearFar: null,
    },
  ]) {
    const tail = packTail(writeLogDepthTail, stashless);
    assert.equal(tail.near, Math.fround(SLICE_NEAR));
    assert.equal(tail.far, Math.fround(SLICE_FAR));
    assert.equal(tail.factor, Math.fround(liveFactor));
  }
  // Factor derivation when UniformState hasn't populated it yet.
  const derived = packTail(writeLogDepthTail, {
    currentFrustum: { x: SLICE_NEAR, y: SLICE_FAR },
    oneOverLog2FarDepthFromNearPlusOne: 0.0,
  });
  assert.equal(derived.factor, Math.fround(liveFactor));
});

test("PACKER — an INVALID stash (far <= near) is ignored, not encoded", () => {
  const state = stashedState();
  state._logDepthEncodeNearFar = new Float32Array([0.0, 0.0]);
  const tail = packTail(writeLogDepthTail, state);
  assert.equal(
    tail.near,
    Math.fround(SLICE_NEAR),
    "a zeroed stash must fall back to the live pair — encoding (0, 0) would " +
      "produce factor 0 and a constant frag_depth",
  );
});

test("PACKER — the tail lands at all three pinned offsets (flat 40 / lit 80 / polyline 92)", () => {
  for (const offset of [40, 80, 92]) {
    const tail = packTail(writeLogDepthTail, stashedState(), offset);
    assert.equal(tail.near, Math.fround(STASH_NEAR), `offset ${offset}`);
    assert.equal(tail.far, Math.fround(STASH_FAR), `offset ${offset}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// A2. THE DEPTH-COMPARE ORACLE — the two-primitive defect, executed
// ═══════════════════════════════════════════════════════════════════════════

test("ORACLE — with the stash-first tail, a slab 5 m above the globe WINS the depth test everywhere", () => {
  // The globe packs `currentFrustum` at scene-update — the exact values it
  // publishes as the stash — so its curve IS the stash curve.
  const globeDepth = shaderDepth(
    W_GLOBE,
    STASH_NEAR,
    factorOf(STASH_NEAR, STASH_FAR),
  );
  const tail = packTail(writeLogDepthTail, stashedState());
  const slabDepth = shaderDepth(W_SLAB, tail.near, tail.factor);
  assert.ok(
    slabDepth < globeDepth,
    `slab (${slabDepth}) must be nearer than the globe (${globeDepth}) — it ` +
      `is physically 5 m in front`,
  );
  // And the margin must be resolvable in a 24-bit depth buffer, or the win is
  // a quantization coin-flip rather than a fix.
  assert.ok(
    globeDepth - slabDepth > Math.pow(2, -24),
    "the 5-m margin collapsed below one depth quantum",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// A3. MUTATION — re-introduce the defect and require detection
// ═══════════════════════════════════════════════════════════════════════════

test("MUTATION — a packer that ignores the stash is caught by the stash-first check AND loses the depth oracle", () => {
  // Precondition: the real packer reads the stash.
  assert.match(
    tailSource,
    /_logDepthEncodeNearFar/,
    "precondition: the extracted packer must read the stash",
  );

  // THE DEFECT, re-introduced: sever the stash read so the packer is
  // live-pair-only — exactly the pre-fix semantics.
  const mutatedSource = tailSource.replace(
    /const ldEncode = defined\(usLog\) \? usLog\._logDepthEncodeNearFar : undefined;/,
    "const ldEncode = undefined;",
  );
  assert.notEqual(
    mutatedSource,
    tailSource,
    "the mutation matched nothing — the stash-read expression changed " +
      "spelling, so this spec is unfalsifiable until the mutation is re-aimed",
  );
  const mutatedTail = compileTail(mutatedSource);

  // (a) The stash-first semantic check FAILS on the mutant.
  const tail = packTail(mutatedTail, stashedState());
  assert.notEqual(
    tail.near,
    Math.fround(STASH_NEAR),
    "the mutant still encodes the stash near — the stash-first checks above " +
      "cannot detect a severed stash read",
  );
  assert.equal(
    tail.near,
    Math.fround(SLICE_NEAR),
    "the mutant should reproduce the pre-fix live-pair packing",
  );

  // (b) The depth oracle reproduces the measured defect: the slab — 5 m IN
  // FRONT of the globe — lands BEHIND it, because the two surfaces are on
  // different log curves.
  const globeDepth = shaderDepth(
    W_GLOBE,
    STASH_NEAR,
    factorOf(STASH_NEAR, STASH_FAR),
  );
  const slabDepth = shaderDepth(W_SLAB, tail.near, tail.factor);
  assert.ok(
    slabDepth > globeDepth,
    "the mutated (pre-fix) packer no longer reproduces the defect — the " +
      "oracle's scenario has drifted and proves nothing",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// B. SOURCE FACTS — one packer, three routed writers, no bypass
// ═══════════════════════════════════════════════════════════════════════════

test("SOURCE — the three camera writers route the tail through writeLogDepthTail at the pinned offsets", () => {
  const src = stripComments(commandsSource);
  for (const call of [
    /writeLogDepthTail\(\s*ud,\s*40,\s*uniformState\s*,?\s*\)/, // flat + pick
    /writeLogDepthTail\(\s*ud,\s*LIT_LOG_DEPTH_OFFSET,\s*uniformState\s*,?\s*\)/, // lit
    /writeLogDepthTail\(\s*ud,\s*92,\s*uniformState\s*,?\s*\)/, // polyline
  ]) {
    assert.match(
      src,
      call,
      "a camera writer stopped routing its log-depth tail through the shared " +
        "helper — a bypass re-opens the per-writer encode-drift this spec closes",
    );
  }
  assert.match(
    src,
    /const LIT_LOG_DEPTH_OFFSET = 80;/,
    "the LIT tail offset moved — the WGSL CameraUniforms structs pin floats 80-83",
  );
});

test("SOURCE — no code outside writeLogDepthTail reads the live log-depth factor", () => {
  const src = stripComments(commandsSource);
  const outside = src.replace(tailSource, "");
  assert.ok(
    !/\.\s*oneOverLog2FarDepthFromNearPlusOne\b/.test(outside),
    "another site in WebGPUPrimitiveCommands.ts reads " +
      "`oneOverLog2FarDepthFromNearPlusOne` directly — a second, unguarded " +
      "log-depth encode path",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// C. THE CONTRACT PAIRING — the real publisher writes the field the packer reads
// ═══════════════════════════════════════════════════════════════════════════

test("CONTRACT — publishLogDepthEncodeNearFar writes the exact field the packer prefers", () => {
  const uniformState = {};
  publishLogDepthEncodeNearFar(
    { camera: { frustum: { near: STASH_NEAR, far: STASH_FAR } } },
    uniformState,
  );
  const stash = uniformState._logDepthEncodeNearFar;
  assert.ok(
    stash instanceof Float32Array,
    "the publisher no longer stashes a Float32Array on " +
      "`uniformState._logDepthEncodeNearFar` — the packer's read is dangling",
  );
  assert.equal(stash[0], Math.fround(STASH_NEAR));
  assert.equal(stash[1], Math.fround(STASH_FAR));
  assert.equal(
    uniformState._logDepthEncodeFactor,
    factorOf(stash[0], stash[1]),
    "the publisher must derive one reusable factor from the exact stored pair",
  );

  // Feed the REAL published stash straight into the REAL packer — the two
  // halves of the contract must meet on the same field, end to end.
  const tail = packTail(writeLogDepthTail, {
    currentFrustum: { x: SLICE_NEAR, y: SLICE_FAR },
    oneOverLog2FarDepthFromNearPlusOne: factorOf(SLICE_NEAR, SLICE_FAR),
    _logDepthEncodeNearFar: stash,
    _logDepthEncodeFactor: uniformState._logDepthEncodeFactor,
  });
  assert.equal(tail.near, Math.fround(STASH_NEAR));
  assert.equal(tail.far, Math.fround(STASH_FAR));
});

test("CONTRACT — a camera without a numeric frustum publishes nothing (no poisoned stash)", () => {
  const uniformState = {};
  publishLogDepthEncodeNearFar({ camera: { frustum: {} } }, uniformState);
  assert.equal(
    uniformState._logDepthEncodeNearFar,
    undefined,
    "an invalid camera frustum must not seed the stash — producers would " +
      "encode against garbage instead of falling back to currentFrustum",
  );
  assert.equal(
    uniformState._logDepthEncodeFactor,
    undefined,
    "an invalid camera must not publish a factor without its paired range",
  );
});
