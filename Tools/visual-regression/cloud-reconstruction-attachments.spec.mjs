// cloud-reconstruction-attachments.spec.mjs — C13-09 (cloud reconstruction
// attachments: front depth, weighted depth, velocity, moments).
// @purpose C13-09: attachment table add-only, march shader content-hash pin enforcing the C13-39 static-register constraint, stage default-OFF byte/cost neutral.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no adapter.
//
// WHAT THIS EXISTS TO CATCH.
//
//   - THE C13-39 CONSTRAINT ERODING. C13-39's negative result established that
//     WGSL register allocation is STATIC: anything added to
//     `ProceduralClouds.wgsl` inflates EVERY pipeline compiled from it — the
//     visible march, the shadow map, the cascade atlas, the god-ray mask. The
//     constraint is therefore not advice, it is a measurable property, and
//     group F enforces it MECHANICALLY: the march shader is pinned by content
//     hash and line count, the producer module is required not to embed it,
//     and the producer pipeline is required to compile from the new module
//     ALONE. A row that must change the shared density law (`C13-10`, or
//     C13-16's visible/shadow/base-consistency correction) updates the pin
//     deliberately and records why a separate module cannot satisfy it;
//
//   - THE ROW QUIETLY BECOMING A VISUAL CHANGE. This is infrastructure: the
//     producer writes, nothing reads. Group E pins that the composite source
//     is unchanged (the upscale still reads the half-res target or the temporal
//     history, never an attachment) and that the whole stage is DEFAULT OFF, so
//     the shipped path is identical in pixels AND in cost;
//
//   - THE LAYOUT DRIFTING FROM ADD-ONLY. Slots, keys, formats and byte sizes
//     are the identity the debug snapshot, the byte accounting and every future
//     bind group key on. Group A executes the real table, so a reorder or a
//     silent format change fails here rather than in a C13-12 probe;
//
//   - A STALE GENERATION BEING SERVED. Group B executes the real lifecycle:
//     first use, resize, device swap, release. The monotonic-generation
//     property is the one C13-40's post-submit retirement work depends on, so
//     a release that rewinds the counter (letting a retired bind group's key
//     collide with a future one) fails here;
//
//   - THE DEPTH ESTIMATOR BEING WRONG WHERE IT MATTERS. Group C executes it
//     over its whole domain: it must stay inside the interval, tend to the
//     midpoint as alpha vanishes and to the front face as alpha saturates, and
//     be translation-invariant. Group F additionally pins that the WGSL and the
//     TS twin are the SAME EXPRESSION, character for character, because a
//     silently diverging CPU twin is how the fleet has been misled before;
//
//   - THE COUNTERS DRIFTING FROM THE ENCODE. Group E pins the registered pass
//     label against the literal at the encode site, and the counter writes
//     against the values the pass actually used.
//
// Run: node --test Tools/visual-regression/cloud-reconstruction-attachments.spec.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";
// C13-10 — ONE loader for "what does a pipeline actually compile", shared with
// `cloud-march-emission.spec.mjs` and the rest of the cloud lane.
import {
  defaultVariant,
  preprocess,
  ShaderDefineHi,
} from "./lib/wgsl-variant.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);

// Multi-line source anchors below are written with LF. The checkout is CRLF on
// Windows working trees, so normalize or every anchor silently misses.
const readEngine = (p) =>
  fs.readFileSync(enginePath(p), "utf8").replace(/\r\n/g, "\n");

const cloudRenderer = readEngine(
  "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const attachmentModuleSource = readEngine(
  "Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts",
);
const observabilitySource = readEngine(
  "Renderer/WebGPU/WebGPUCloudObservability.ts",
);
const debugSource = readEngine("Scene/CesiumDebug.js");
const producerWgsl = readEngine(
  "Shaders/WebGPU/Environment/CloudReconstructionAttachments.wgsl",
);
const marchWgsl = readEngine(
  "Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
);
const temporalResolveWgsl = readEngine(
  "Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl",
);
const upscaleWgsl = readEngine("Shaders/WebGPU/Environment/CloudUpscale.wgsl");

const toDataUrl = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

/** Transpiles one LEAF engine TS module (no relative imports) to a data: URL. */
async function transpileLeaf(relativePath) {
  const { code } = await transform(
    fs.readFileSync(enginePath(relativePath), "utf8"),
    {
      loader: "ts",
      format: "esm",
      target: "es2022",
    },
  );
  return toDataUrl(code);
}

const attachments = await import(
  await transpileLeaf("Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts")
);
const {
  CLOUD_ATTACHMENT_DEFAULT_DEPTH_NORMALIZATION_METERS,
  CLOUD_ATTACHMENT_PASS_LABEL,
  CLOUD_ATTACHMENT_UNIFORM_BYTES,
  CLOUD_ATTACHMENT_UNIFORM_FLOATS,
  CLOUD_EMITTED_ATTACHMENTS,
  CLOUD_OWNED_ATTACHMENTS,
  CLOUD_RECONSTRUCTION_ATTACHMENTS,
  CloudAttachmentSlot,
  cloudAttachmentBytes,
  cloudAttachmentGenerationIsCurrent,
  cloudAttachmentSetBytes,
  cloudAttachmentsNeedAllocation,
  cloudOwnedAttachmentBytes,
  cloudTransmittanceWeightedDepth,
  commitCloudAttachmentGeneration,
  createCloudAttachmentGeneration,
  packCloudAttachmentUniforms,
  releaseCloudAttachmentGeneration,
} = attachments;

/** Assert `re` matches `source`, and that it STOPS matching a mutated copy. */
function pinWithMutant(source, re, mutate, label) {
  assert.match(source, re, `missing: ${label}`);
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation was a no-op for: ${label}`);
  assert.doesNotMatch(
    mutated,
    re,
    `the check for "${label}" does not actually detect its own mutant`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The attachment contract
// ─────────────────────────────────────────────────────────────────────────────

test("A1 the table is the four-attachment contract the row specifies, in slot order", () => {
  assert.equal(CLOUD_RECONSTRUCTION_ATTACHMENTS.length, 4);
  assert.deepEqual(
    CLOUD_RECONSTRUCTION_ATTACHMENTS.map((spec) => spec.key),
    ["color", "depth", "velocity", "moments"],
    "the row asks for premultiplied colour/transmittance, front AND weighted depth, motion, and moments",
  );
  CLOUD_RECONSTRUCTION_ATTACHMENTS.forEach((spec, index) => {
    assert.equal(spec.slot, index, `${spec.key} slot must equal its index`);
  });
  assert.equal(CloudAttachmentSlot.COLOR, 0);
  assert.equal(CloudAttachmentSlot.DEPTH, 1);
  assert.equal(CloudAttachmentSlot.VELOCITY, 2);
  assert.equal(CloudAttachmentSlot.MOMENTS, 3);
});

test("A2 slot 0 is the EXISTING march target, not a second allocation", () => {
  const color = CLOUD_RECONSTRUCTION_ATTACHMENTS[CloudAttachmentSlot.COLOR];
  assert.equal(color.ownedHere, false);
  assert.equal(color.producer, "ProceduralClouds half-res pass");
  assert.equal(
    color.format,
    "rgba16float",
    "must match the half-res target the march writes",
  );
  // ...and the renderer must not create a fourth texture for it.
  assert.equal(CLOUD_OWNED_ATTACHMENTS.length, 3);
  assert.deepEqual(
    CLOUD_OWNED_ATTACHMENTS.map((spec) => spec.key),
    ["depth", "velocity", "moments"],
  );
});

test("A3 depth is 32-bit — half-float metres cannot separate what C13-12 rejects", () => {
  const depth = CLOUD_RECONSTRUCTION_ATTACHMENTS[CloudAttachmentSlot.DEPTH];
  assert.equal(depth.format, "rg32float");
  assert.equal(depth.bytesPerTexel, 8);
  // The quantum this format choice exists to avoid: an 11-bit mantissa at
  // 100 km is ~50 m, which is thicker than a cloud deck's own vertical extent.
  const halfFloatQuantumAt100km = 100000 / 2 ** 11;
  assert.ok(
    halfFloatQuantumAt100km > 40,
    "if half-float were fine here the rationale in the module would be wrong",
  );
  assert.match(
    depth.channels,
    /front .*metres.*weighted.*metres/i,
    "BOTH depths must be carried — one mean depth cannot separate overlapping volumes",
  );
  assert.match(
    depth.channels,
    /-1/,
    "the no-cloud sentinel must be part of the published contract",
  );
});

test("A4 velocity carries VALIDITY — two channels cannot say 'could not reproject'", () => {
  const velocity =
    CLOUD_RECONSTRUCTION_ATTACHMENTS[CloudAttachmentSlot.VELOCITY];
  assert.equal(velocity.format, "rgba16float");
  assert.match(velocity.channels, /validity/i);
  assert.equal(
    velocity.clearValue.b,
    0,
    "an unwritten texel must read invalid",
  );
});

test("A5 moments are NORMALIZED — raw metre-squared moments overflow rgba16float", () => {
  const moments = CLOUD_RECONSTRUCTION_ATTACHMENTS[CloudAttachmentSlot.MOMENTS];
  assert.equal(moments.format, "rgba16float");
  assert.match(moments.channels, /normalized depth/i);
  assert.match(moments.channels, /coverage/i);
  // The overflow the normalization avoids, derived rather than asserted:
  // half-float saturates at 65504, so a RAW metre-squared moment stops being
  // representable a couple of hundred metres out.
  const halfFloatMax = 65504;
  const rawMetreCeiling = Math.sqrt(halfFloatMax);
  assert.ok(
    rawMetreCeiling < 300,
    `a raw metre-squared moment saturates at ${rawMetreCeiling} m`,
  );
  assert.ok(
    rawMetreCeiling <
      CLOUD_ATTACHMENT_DEFAULT_DEPTH_NORMALIZATION_METERS / 1000,
    "the ceiling must be orders of magnitude short of the distances this attachment carries",
  );
});

test("A6 the depth clear is the no-cloud sentinel, and no other clear is negative", () => {
  const depth = CLOUD_RECONSTRUCTION_ATTACHMENTS[CloudAttachmentSlot.DEPTH];
  assert.equal(depth.clearValue.r, -1);
  assert.equal(depth.clearValue.g, -1);
  for (const spec of CLOUD_RECONSTRUCTION_ATTACHMENTS) {
    if (spec.key === "depth") continue;
    for (const channel of ["r", "g", "b", "a"]) {
      assert.ok(
        spec.clearValue[channel] >= 0,
        `${spec.key}.${channel} clears negative — a negative moment or motion reads as data`,
      );
    }
  }
});

// ★ UPDATED BY C13-10 (was "NOTHING CONSUMES THE OWNED SET"). At C13-09 every
//   owned attachment carried an EMPTY consumer list, and that emptiness was the
//   row's honest state. C13-10 gave the set its first reader — the temporal
//   resolve, under `ShaderDefineHi.CLOUD_RECONSTRUCTION_CONSUME` — so the list
//   is no longer empty and the test now pins WHO reads it. C13-12 is expected
//   to leave this unchanged: it adds POLICY inside that same pass, not a new
//   reader, so a third consumer appearing here is a signal to re-read the row.
test("A7 the owned set's ONE consumer is the temporal resolve", () => {
  for (const spec of CLOUD_OWNED_ATTACHMENTS) {
    assert.deepEqual(
      spec.consumers,
      ["CloudTemporalResolve pass"],
      `${spec.key} does not name the C13-10 consumer`,
    );
    assert.equal(spec.producer, CLOUD_ATTACHMENT_PASS_LABEL);
  }
  // The pre-existing colour target DOES have consumers; that asymmetry is the
  // point, and a table that lost it would be hiding the row's actual state.
  assert.ok(
    CLOUD_RECONSTRUCTION_ATTACHMENTS[CloudAttachmentSlot.COLOR].consumers
      .length > 0,
  );
  // C13-10 — ownership of the DEPTH slot, and only that slot, moves to the
  // march under the emission variant. An `variantProducer` appearing on a
  // second slot means a second target changed hands and the pass topology
  // below no longer describes what runs.
  const withVariantProducer = CLOUD_RECONSTRUCTION_ATTACHMENTS.filter(
    (spec) => spec.variantProducer !== undefined,
  ).map((spec) => spec.key);
  assert.deepEqual(withVariantProducer, ["depth"]);
  assert.equal(
    CLOUD_RECONSTRUCTION_ATTACHMENTS[CloudAttachmentSlot.DEPTH].variantProducer,
    "ProceduralClouds half-res pass",
  );
});

test("A8b the owned set fits WebGPU's per-sample colour-attachment byte budget", () => {
  // A fourth owned attachment, or a widening of one, would silently exceed
  // `maxColorAttachmentBytesPerSample` (32 by default) and the producer
  // pipeline would fail validation at creation rather than here.
  const perSampleBytes = CLOUD_OWNED_ATTACHMENTS.reduce(
    (total, spec) => total + spec.bytesPerTexel,
    0,
  );
  assert.equal(perSampleBytes, 24);
  assert.ok(
    perSampleBytes <= 32,
    `the MRT set costs ${perSampleBytes} B/sample, over the default WebGPU limit of 32`,
  );
  assert.ok(CLOUD_OWNED_ATTACHMENTS.length <= 8, "max colour attachments");
});

test("A8 byte accounting separates what the row ADDED from what the set costs", () => {
  const w = 960;
  const h = 540;
  assert.equal(cloudOwnedAttachmentBytes(w, h), w * h * 24);
  assert.equal(cloudAttachmentSetBytes(w, h), w * h * 32);
  assert.ok(
    cloudOwnedAttachmentBytes(w, h) < cloudAttachmentSetBytes(w, h),
    "folding the shared colour target into the owned figure would overstate the row's footprint",
  );
  assert.equal(
    cloudAttachmentBytes(CLOUD_OWNED_ATTACHMENTS[0], w, h),
    w * h * 8,
  );
  // Degenerate sizes report zero rather than a negative or NaN byte count.
  assert.equal(cloudOwnedAttachmentBytes(0, 0), 0);
  assert.equal(cloudOwnedAttachmentBytes(-4, 10), 0);
});

test("A9 the pass label is registered with the observability table", () => {
  assert.equal(
    CLOUD_ATTACHMENT_PASS_LABEL,
    "CloudReconstructionAttachments pass",
  );
  assert.ok(
    observabilitySource.includes(`"${CLOUD_ATTACHMENT_PASS_LABEL}"`),
    "an unregistered pass lands in passCount but never in the per-pass breakdown or the GPU union",
  );
  assert.ok(
    cloudRenderer.includes(`label: "${CLOUD_ATTACHMENT_PASS_LABEL}"`),
    "the encode site's literal must equal the registered constant",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Generation and lifecycle
// ─────────────────────────────────────────────────────────────────────────────

const deviceA = { id: "device-a" };
const deviceB = { id: "device-b" };

test("B1 first use needs allocation and advances the generation to 1", () => {
  const state = createCloudAttachmentGeneration();
  assert.equal(state.generation, 0);
  assert.equal(state.liveBytes, 0);
  assert.ok(cloudAttachmentsNeedAllocation(state, 480, 270, deviceA));
  assert.equal(commitCloudAttachmentGeneration(state, 480, 270, deviceA), 1);
  assert.equal(state.liveBytes, 480 * 270 * 24);
  assert.ok(!cloudAttachmentsNeedAllocation(state, 480, 270, deviceA));
  assert.ok(cloudAttachmentGenerationIsCurrent(state, 1));
});

test("B2 a RESIZE reallocates — the previous contents describe a different grid", () => {
  const state = createCloudAttachmentGeneration();
  commitCloudAttachmentGeneration(state, 480, 270, deviceA);
  assert.ok(cloudAttachmentsNeedAllocation(state, 960, 270, deviceA));
  assert.ok(cloudAttachmentsNeedAllocation(state, 480, 540, deviceA));
  assert.equal(commitCloudAttachmentGeneration(state, 960, 540, deviceA), 2);
  assert.equal(state.liveBytes, 960 * 540 * 24);
  assert.ok(
    !cloudAttachmentGenerationIsCurrent(state, 1),
    "a bind group built under generation 1 must not read as current",
  );
});

test("B3 a DEVICE SWAP reallocates even at an unchanged size", () => {
  const state = createCloudAttachmentGeneration();
  commitCloudAttachmentGeneration(state, 480, 270, deviceA);
  assert.ok(
    cloudAttachmentsNeedAllocation(state, 480, 270, deviceB),
    "textures created on a lost device are unusable regardless of size",
  );
  assert.equal(commitCloudAttachmentGeneration(state, 480, 270, deviceB), 2);
});

test("B4 RELEASE never rewinds the generation — a retired key must not be reusable", () => {
  const state = createCloudAttachmentGeneration();
  commitCloudAttachmentGeneration(state, 480, 270, deviceA);
  commitCloudAttachmentGeneration(state, 960, 540, deviceA);
  releaseCloudAttachmentGeneration(state);
  assert.equal(state.generation, 2, "the counter is monotonic across release");
  assert.equal(state.liveBytes, 0);
  assert.equal(state.deviceKey, null);
  assert.ok(!cloudAttachmentGenerationIsCurrent(state, 2));
  assert.ok(cloudAttachmentsNeedAllocation(state, 960, 540, deviceA));
  assert.equal(
    commitCloudAttachmentGeneration(state, 960, 540, deviceA),
    3,
    "the next generation must be NEW, not a reuse of 2",
  );
});

test("B5 a non-positive size always reports 'needs allocation'", () => {
  const state = createCloudAttachmentGeneration();
  commitCloudAttachmentGeneration(state, 480, 270, deviceA);
  assert.ok(cloudAttachmentsNeedAllocation(state, 0, 270, deviceA));
  assert.ok(cloudAttachmentsNeedAllocation(state, 480, 0, deviceA));
  assert.ok(
    !cloudAttachmentGenerationIsCurrent(state, 0),
    "generation 0 means 'nothing allocated' and can never be current",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The transmittance-weighted depth estimator
// ─────────────────────────────────────────────────────────────────────────────

test("C1 an empty or inverted interval reports -1, never a plausible zero", () => {
  assert.equal(cloudTransmittanceWeightedDepth(1000, 1000, 0.5), -1);
  assert.equal(cloudTransmittanceWeightedDepth(2000, 1000, 0.5), -1);
});

test("C2 zero alpha is no-cloud; positive alpha->0 is the midpoint without a snap", () => {
  assert.equal(cloudTransmittanceWeightedDepth(1000, 2000, 0), -1);
  // The low-alpha branch must be CONTINUOUS with the formula it replaces: the
  // two terms diverge together there, so the branch exists for significant
  // digits, not because the limit differs.
  const atBranch = cloudTransmittanceWeightedDepth(1000, 2000, 1e-4);
  const justAbove = cloudTransmittanceWeightedDepth(1000, 2000, 1.01e-4);
  assert.ok(
    Math.abs(atBranch - 1500) < 1e-9,
    `the branch itself must be the exact midpoint, got ${atBranch}`,
  );
  assert.ok(
    Math.abs(justAbove - atBranch) < 1,
    `discontinuous at the low-alpha branch: ${atBranch} then ${justAbove}`,
  );
  // At full opacity the estimate must be NEAR the front face — but there is
  // deliberately no snap to t0, because the approach is logarithmic and a snap
  // would put a tenth-of-a-deck jump exactly at full opacity.
  const opaque = cloudTransmittanceWeightedDepth(1000, 2000, 1);
  assert.ok(
    opaque > 1000 && opaque - 1000 < 0.1 * 1000,
    `alpha=1 should sit just inside the deck, got ${opaque}`,
  );
  const nearlyOpaque = cloudTransmittanceWeightedDepth(1000, 2000, 1 - 1e-6);
  assert.ok(
    Math.abs(nearlyOpaque - opaque) < 1,
    "the transmittance floor must not introduce a step at full opacity",
  );
});

test("C3 every positive-alpha estimate stays inside the interval and decreases", () => {
  const t0 = 12000;
  const t1 = 19000;
  let previous = Number.POSITIVE_INFINITY;
  for (let i = 1; i <= 200; i++) {
    const alpha = i / 200;
    const depth = cloudTransmittanceWeightedDepth(t0, t1, alpha);
    assert.ok(
      depth >= t0 - 1e-6 && depth <= t1 + 1e-6,
      `alpha=${alpha} produced ${depth}, outside [${t0}, ${t1}]`,
    );
    assert.ok(
      depth <= previous + 1e-6,
      `alpha=${alpha} increased the depth — more opacity must move the mass FORWARD`,
    );
    previous = depth;
  }
});

test("C4 the estimator is translation-invariant, as a distance along a ray must be", () => {
  for (const alpha of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const near = cloudTransmittanceWeightedDepth(1000, 4000, alpha);
    const far = cloudTransmittanceWeightedDepth(801000, 804000, alpha);
    assert.ok(
      Math.abs(far - near - 800000) < 1e-3,
      `alpha=${alpha}: ${far} - ${near} should be exactly the 800 km offset`,
    );
  }
});

test("C5 out-of-range alpha is clamped rather than producing NaN", () => {
  assert.equal(cloudTransmittanceWeightedDepth(1000, 2000, -5), -1);
  assert.equal(
    cloudTransmittanceWeightedDepth(1000, 2000, 5),
    cloudTransmittanceWeightedDepth(1000, 2000, 1),
    "an over-range alpha must land exactly where alpha = 1 does",
  );
  for (const alpha of [-5, 0, 0.5, 1, 5, Number.EPSILON]) {
    assert.ok(
      Number.isFinite(cloudTransmittanceWeightedDepth(1000, 2000, alpha)),
      `alpha=${alpha} produced a non-finite depth`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Uniform packing
// ─────────────────────────────────────────────────────────────────────────────

const identity16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const ramp16 = Array.from({ length: 16 }, (_, i) => 100 + i);

function baseInputs(overrides = {}) {
  return {
    previousViewProjectionRelativeToEye: identity16,
    inverseCurrentViewProjectionRelativeToEye: ramp16,
    encodedCameraHighX: 1,
    encodedCameraHighY: 2,
    encodedCameraHighZ: 3,
    encodedCameraLowX: 4,
    encodedCameraLowY: 5,
    encodedCameraLowZ: 6,
    cameraGeodeticHeight: 7,
    cameraDeltaX: 8,
    cameraDeltaY: 9,
    cameraDeltaZ: 10,
    depthNormalizationMeters: 11,
    width: 12,
    height: 13,
    reprojectionValid: true,
    deckBottom: 14,
    deckTop: 15,
    deckLowBottom: 16,
    deckLowTop: 17,
    deckMidBottom: 18,
    deckMidTop: 19,
    deckHighBottom: 20,
    deckHighTop: 21,
    multiDeck: true,
    generation: 22,
    ...overrides,
  };
}

test("D1 the block is 56 floats — mat4 + mat4 + six vec4 rows", () => {
  assert.equal(CLOUD_ATTACHMENT_UNIFORM_FLOATS, 16 + 16 + 6 * 4);
  assert.equal(CLOUD_ATTACHMENT_UNIFORM_BYTES, 224);
  assert.ok(
    CLOUD_ATTACHMENT_UNIFORM_BYTES <= 256,
    "the block must fit WebGPU's 256-byte minimum allocation without growing it",
  );
  // ...and the WGSL struct must declare exactly that shape.
  const structBody = producerWgsl.slice(
    producerWgsl.indexOf("struct AttachmentUniforms"),
    producerWgsl.indexOf("@group(0) @binding(0)"),
  );
  const mat4Count = (structBody.match(/mat4x4<f32>/g) ?? []).length;
  const vec4Count = (structBody.match(/vec4<f32>/g) ?? []).length;
  assert.equal(mat4Count, 2);
  assert.equal(vec4Count, 6);
  assert.equal(
    mat4Count * 16 + vec4Count * 4,
    CLOUD_ATTACHMENT_UNIFORM_FLOATS,
    "the WGSL struct and the packer disagree — the block is byte-locked",
  );
});

test("D2 every field lands at its documented offset", () => {
  const out = new Float32Array(CLOUD_ATTACHMENT_UNIFORM_FLOATS);
  packCloudAttachmentUniforms(out, baseInputs());
  assert.deepEqual(Array.from(out.slice(0, 16)), identity16);
  assert.deepEqual(Array.from(out.slice(16, 32)), ramp16);
  assert.deepEqual(Array.from(out.slice(32, 36)), [1, 2, 3, 11]);
  assert.deepEqual(Array.from(out.slice(36, 40)), [4, 5, 6, 7]);
  assert.deepEqual(Array.from(out.slice(40, 44)), [8, 9, 10, 12]);
  assert.deepEqual(Array.from(out.slice(44, 48)), [14, 15, 13, 1]);
  assert.deepEqual(Array.from(out.slice(48, 52)), [16, 17, 18, 19]);
  assert.deepEqual(Array.from(out.slice(52, 56)), [20, 21, 1, 22]);
});

test("D3 a missing transform zeroes its rows instead of reusing the last valid frame", () => {
  const out = new Float32Array(CLOUD_ATTACHMENT_UNIFORM_FLOATS);
  packCloudAttachmentUniforms(out, baseInputs());
  // Same array, second frame, previous transform gone.
  packCloudAttachmentUniforms(
    out,
    baseInputs({ previousViewProjectionRelativeToEye: null }),
  );
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    new Array(16).fill(0),
    "a stale matrix would reproject this frame through last frame's camera",
  );
  assert.deepEqual(
    Array.from(out.slice(16, 32)),
    ramp16,
    "the still-valid rows must keep packing",
  );
});

test("D4 packing is allocation-free and idempotent into a caller-owned array", () => {
  const out = new Float32Array(CLOUD_ATTACHMENT_UNIFORM_FLOATS).fill(-999);
  packCloudAttachmentUniforms(out, baseInputs());
  const first = Array.from(out);
  packCloudAttachmentUniforms(out, baseInputs());
  assert.deepEqual(Array.from(out), first);
  assert.ok(
    !first.includes(-999),
    "the fill(0) up front must clear every slot the packer does not write",
  );
});

test("D5 booleans reach the shader as 1/0, not as coincidence", () => {
  const out = new Float32Array(CLOUD_ATTACHMENT_UNIFORM_FLOATS);
  packCloudAttachmentUniforms(
    out,
    baseInputs({ reprojectionValid: false, multiDeck: false }),
  );
  assert.equal(out[47], 0);
  assert.equal(out[54], 0);
});

test("D6 the far-cap fallback is a real planetary distance, not zero", () => {
  assert.ok(CLOUD_ATTACHMENT_DEFAULT_DEPTH_NORMALIZATION_METERS > 1.0e6);
  // Dividing by the fallback must keep a visible cloud's depth inside [0, 1],
  // which is what makes the rgba16float moment pair exact enough.
  assert.ok(400000 / CLOUD_ATTACHMENT_DEFAULT_DEPTH_NORMALIZATION_METERS < 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Renderer wiring — default OFF, produced but NOT consumed
// ─────────────────────────────────────────────────────────────────────────────

test("E1 the stage is DEFAULT OFF in the source, so the shipped path pays nothing", () => {
  pinWithMutant(
    cloudRenderer,
    /attachmentsEnabled: false,/,
    (s) => s.replace("attachmentsEnabled: false,", "attachmentsEnabled: true,"),
    "the cloud cache initialises the attachment stage to off",
  );
  // ★ UPDATED BY C13-10. The gate used to be inline on the producer block;
  //   C13-10 hoisted it above the raymarch (the emitting march needs contract
  //   slot 1 to exist as one of its OWN colour attachments) and named it. The
  //   flag it reads is unchanged, and so is the property: with the stage off,
  //   nothing allocates and no pass is encoded.
  pinWithMutant(
    cloudRenderer,
    /const attachmentStageActive = cache\.attachmentsEnabled && !!cache\.halfView;/,
    (s) =>
      s.replace(
        "const attachmentStageActive = cache.attachmentsEnabled && !!cache.halfView;",
        "const attachmentStageActive = !!cache.halfView;",
      ),
    "the attachment stage is gated on the opt-in flag",
  );
  assert.match(
    cloudRenderer,
    /if \(attachmentStageActive\) \{\n\s*if \(attachmentsReady && cache\.attachmentUniformBuffer\) \{/,
    "the producer block must still be inside the stage gate",
  );
  // C13-10's own flag is a SECOND opt-in, also default off. Folding the two
  // into one would make C13-09's "produced but not consumed" leg untestable,
  // because no build would produce without consuming.
  pinWithMutant(
    cloudRenderer,
    /reconstructionEnabled: false,/,
    (s) =>
      s.replace(
        "reconstructionEnabled: false,",
        "reconstructionEnabled: true,",
      ),
    "the cloud cache initialises march-emitted reconstruction to off",
  );
});

test("E2 the producer is encoded BETWEEN the march and the temporal resolve", () => {
  const marchEnd = cloudRenderer.indexOf("halfPass.end();");
  const producer = cloudRenderer.indexOf(
    `label: "${CLOUD_ATTACHMENT_PASS_LABEL}"`,
  );
  const resolve = cloudRenderer.indexOf('label: "CloudTemporalResolve pass"');
  const upscale = cloudRenderer.indexOf('label: "CloudUpscale composite pass"');
  assert.ok(marchEnd > 0 && producer > 0 && resolve > 0 && upscale > 0);
  assert.ok(
    marchEnd < producer,
    "the producer reads the freshly marched target, so it must follow the march",
  );
  assert.ok(
    producer < resolve && resolve < upscale,
    "C13-12 will read the set INSIDE the resolve, so the producer must precede it",
  );
});

test("E3 THE COMPOSITE IS UNCHANGED — the upscale never reads an attachment", () => {
  // The upscale source is still the half-res target, reassigned only by the
  // temporal resolve. This is the single check that keeps C13-09 a
  // pixel-identical infrastructure row.
  assert.match(
    cloudRenderer,
    /let upscaleSourceView: GPUTextureView = cache\.halfView;/,
  );
  const upscaleAssignments = [
    ...cloudRenderer.matchAll(/upscaleSourceView = ([^;]+);/g),
  ].map((m) => m[1].trim());
  assert.deepEqual(
    upscaleAssignments,
    ["writeView"],
    "the ONLY reassignment of the composite source must remain the temporal history",
  );
  const upscaleCall = cloudRenderer.slice(
    cloudRenderer.indexOf(
      "const upscaleBindGroup = getOrCreateCloudUpscaleBindGroup(",
    ),
    cloudRenderer.indexOf("const upscalePass = encoder.beginRenderPass("),
  );
  assert.ok(upscaleCall.length > 0 && upscaleCall.length < 600);
  assert.ok(
    !upscaleCall.includes("attachment"),
    "the upscale bind group must not bind a reconstruction attachment",
  );
});

// ★ UPDATED BY C13-10 (was "NO CONSUMER EXISTS YET"). The resolve is now the
//   set's reader — but ONLY inside its `CLOUD_RECONSTRUCTION_CONSUME` variant.
//   The property this test defends is unchanged in substance: the DEFAULT
//   resolve, and the upscale in every variant, must remain attachment-free, so
//   a build that does not compile the bit is the pre-C13-10 shader.
test("E4 the DEFAULT resolve and the upscale remain attachment-free", () => {
  const attachmentTokens = [
    "reconstructionDepthTex",
    "reconstructionVelocityTex",
    "reconstructionMomentsTex",
  ];
  // The upscale never reads an attachment in ANY variant — it carries no
  // `//>>ifdef` for one, so the raw source is the whole story.
  for (const token of attachmentTokens) {
    assert.ok(
      !upscaleWgsl.includes(token),
      `CloudUpscale.wgsl samples ${token} — the composite must stay attachment-free`,
    );
  }
  // The resolve declares them, but every declaration and every read must sit
  // inside the consumption variant. Strip the ifdef branches and nothing may
  // remain: that is the default pipeline's source.
  const defaultResolve = defaultVariant(temporalResolveWgsl);
  for (const token of attachmentTokens) {
    assert.ok(
      temporalResolveWgsl.includes(token),
      `CloudTemporalResolve.wgsl no longer declares ${token} — C13-10's consumer is gone`,
    );
    assert.ok(
      !defaultResolve.includes(token),
      `${token} is read OUTSIDE the CLOUD_RECONSTRUCTION_CONSUME variant — the default pipeline would change`,
    );
  }
  // The default path still describes its own depth as a PROXY. C13-10 retired
  // that statement only inside the variant; the fallback is still a proxy.
  assert.match(defaultResolve, /representative geometric proxy/);
});

test("E5 the generation is committed only AFTER every owned texture exists", () => {
  const ensure = cloudRenderer.slice(
    cloudRenderer.indexOf("function ensureCloudAttachmentResources("),
    cloudRenderer.indexOf("function ensureHalfResResources("),
  );
  assert.ok(ensure.length > 0);
  const createIndex = ensure.lastIndexOf("cache.attachmentViews[i] =");
  const commitIndex = ensure.indexOf("commitCloudAttachmentGeneration(");
  assert.ok(
    createIndex > 0 && commitIndex > createIndex,
    "a partially built set must never advertise itself as a complete generation",
  );
  // The bind group is invalidated on reallocation AND on a new source view.
  assert.match(ensure, /cache\.attachmentBindGroup = null;/);
  assert.match(
    ensure,
    /cache\.attachmentBindGroupSourceView !== sourceView/,
    "a reallocated half-res target must rebuild the group, not sample a destroyed texture",
  );
});

test("E6 the set frees itself on teardown AND when the flag is cleared", () => {
  pinWithMutant(
    cloudRenderer,
    /if \(!cache\.attachmentsEnabled && cache\.attachmentGeneration\.liveBytes > 0\) \{\n\s*releaseCloudAttachmentResources\(cache\);/,
    (s) =>
      s.replace(
        "  if (!cache.attachmentsEnabled && cache.attachmentGeneration.liveBytes > 0) {\n    releaseCloudAttachmentResources(cache);\n  }\n",
        "",
      ),
    "a disabled set releases itself on the next execute",
  );
  const destroy = cloudRenderer.slice(
    cloudRenderer.indexOf("export function destroyProceduralCloudResources("),
  );
  assert.match(destroy, /releaseCloudAttachmentResources\(cache\);/);
  assert.match(destroy, /cache\.attachmentPipeline = null;/);
  assert.match(destroy, /cache\.attachmentUniformBuffer\?\.destroy\(\);/);
});

test("E7 a culled frame cannot hand a consumer a stale attachment set", () => {
  pinWithMutant(
    cloudRenderer,
    /existingCache\.attachmentRenderedThisFrame = false;/,
    (s) => s.replace("existingCache.attachmentRenderedThisFrame = false;", ""),
    "the per-frame produced flag is reset up front",
  );
  assert.match(
    cloudRenderer,
    /if \(!cache \|\| !cache\.attachmentRenderedThisFrame\) return null;/,
    "the accessor must refuse to publish a set this frame did not produce",
  );
});

test("E8 the counters record what the pass ACTUALLY used", () => {
  const block = cloudRenderer.slice(
    cloudRenderer.indexOf("attachmentPass.end();"),
    cloudRenderer.indexOf("attachmentPass.end();") + 900,
  );
  assert.match(block, /counters\.attachmentWidth = cache\.halfWidth;/);
  assert.match(block, /counters\.attachmentHeight = cache\.halfHeight;/);
  assert.match(
    block,
    /counters\.attachmentPixels = cache\.halfWidth \* cache\.halfHeight;/,
  );
  assert.match(
    block,
    /counters\.attachmentGeneration = cache\.attachmentGeneration\.generation;/,
  );
  // liveBytes is RESIDENT, so it is published every execute rather than only
  // on frames the producer ran.
  assert.match(
    cloudRenderer,
    /counters\.attachmentLiveBytes = cache\.attachmentGeneration\.liveBytes;/,
  );
  assert.ok(
    observabilitySource.includes("attachmentLiveBytes: number;"),
    "the resident byte figure must exist on the counter record",
  );
  // The RESET list holds QUOTED field names; a prose mention of the field in a
  // comment beside it is not a reset. Matching the quoted form is what makes
  // this check about the code rather than about the commentary (C13-10 added
  // exactly such a comment, and a substring test failed on it).
  assert.ok(
    !observabilitySource
      .slice(
        observabilitySource.indexOf("const RESET_FIELDS"),
        observabilitySource.indexOf("createCloudFrameCounters"),
      )
      .includes('"attachmentLiveBytes"'),
    "zeroing the resident figure would report the set as freed every quiescent frame",
  );
});

test("E9 the debug surface reaches the set without a static import of the lazy renderer", () => {
  assert.match(debugSource, /cloudReconstructionAttachments\(enabled\) \{/);
  assert.match(debugSource, /cache\.attachmentsEnabled = enabled;/);
  assert.ok(
    !debugSource.includes("WebGPUProceduralCloudRenderer"),
    "CesiumDebug must not statically import the lazily-chunked cloud renderer",
  );
  assert.ok(
    debugSource.includes(
      "CesiumDebug.cloudReconstructionAttachments(t/f) — C13-09 attachment set",
    ),
    "a command that is not in help() is a command nobody finds",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F. The C13-39 constraint, enforced mechanically
// ─────────────────────────────────────────────────────────────────────────────

// Content pin of the shared march module. C13-39's negative result makes this a
// MEASURED property rather than a style rule: WGSL register allocation is
// static, so a single line added here inflates the register footprint of the
// visible march, the shadow map, the cascade atlas and the god-ray mask alike.
//
// ★ THE PIN WAS UPDATED BY C13-10 ON 2026-08-07, DELIBERATELY.
//
//   The note this test used to carry said: "IF THIS FAILS AND YOU ARE C13-10,
//   that is expected — C13-10 is the row permitted to change the march, and it
//   updates these two constants in the same commit that changes the shader."
//   That is what happened. The march now carries ONE compile-time variant,
//   `CLOUD_MARCH_EMIT_RECONSTRUCTION`, which accumulates the front and
//   transmittance-weighted depth and writes contract slot 1 as a second colour
//   target. The previous pin was
//   `8cc74fbb020fa873a3d61004b809655052b46cd88e92c6fb338fea4af28fa1bf` at 2962
//   lines.
//
//   ★ THE CONSTRAINT DID NOT WEAKEN — ITS ENFORCEMENT MOVED UP A LEVEL. A raw
//     content hash can no longer say what C13-39 needs said, because the file
//     now legitimately contains code four of the five pipelines compiled from
//     it never see. So F1a pins the raw file (any change to the march is
//     visible and deliberate) and F1b pins the thing that actually bounds the
//     register footprint: the DEFAULT variant's non-comment text must be
//     byte-identical to the pre-C13-10 module. `MARCH_DEFAULT_CODE_SHA256` was
//     computed from the 8cc74fbb… file itself, so F1b is an equality against
//     the historical shader, not against a snapshot of the new one.
//
//   ★ UPDATED AGAIN BY C13-16 U2 ON 2026-08-09, DELIBERATELY. The approved
//     budget -> fibre carve -> erosion law must be identical in the visible
//     march, base oracle, beer shadows, cascade atlas and god-ray mask. Moving
//     it to a private visible pipeline would break `base >= full` and
//     shadow/visible agreement. The change adds no uniform slots and is exact
//     identity for default CUMULUS; the focused composition spec pins its 47
//     executable lines and rejects old-order/missing-call mutants.
//
//   IF F1a FAILS without an approved shared-density-law change, the change
//   belongs in a separate module and pipeline, the way this row's producer does.
//   IF F1b FAILS, every pipeline compiled at `definesHi = 0` changed; re-freeze
//   only with a recorded cross-consumer reason like the one above.
const MARCH_WGSL_SHA256 =
  "03c524493456f448e3cf5f29daf9c423219253be57323ccf1ebdcd577787897d";
// Re-frozen 2026-08-21 at the C13-16 landing: the U2 A/B bundle flips rewrote
// this file in the main tree after the mid-lane pin was computed, drifting
// comment bytes only — the code-only pin below never moved and the line count
// is unchanged, so the compiler-visible content is the approved baseline.
const MARCH_WGSL_LINES = 3156;
// SHA-256 of the C13-16-approved default variant with blank lines and all line
// comments removed. The prior C13-10 baseline was 1798 executable lines; the 47
// added lines are the shared density-law correction described above.
const MARCH_DEFAULT_CODE_SHA256 =
  "83d6e4592f1bf3089673fbe54da4eab6c47db3621e98a3ad7e5948c0e7b538e3";
const MARCH_DEFAULT_CODE_LINES = 1845;

/** Blank- and line-comment-stripped source: the text a compiler acts on. */
function codeOnly(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

test("F1a ProceduralClouds.wgsl matches its pin — any change here is deliberate", () => {
  const digest = crypto.createHash("sha256").update(marchWgsl).digest("hex");
  assert.equal(
    marchWgsl.split("\n").length,
    MARCH_WGSL_LINES,
    "the march shader gained or lost lines — see the note above this test",
  );
  assert.equal(
    digest,
    MARCH_WGSL_SHA256,
    "the march shader changed — C13-39 binds: unless you are the row that owns the march, this goes in a SEPARATE module and pipeline",
  );
});

test("F1b the DEFAULT march variant matches the approved C13-16 baseline", () => {
  // This is the check that enforces C13-39 from the approved U2 baseline. Four
  // of the five
  // pipelines compiled from this module (full-resolution march, beer-shadow
  // map, cascade atlas, god-ray mask) compile it at `definesHi = 0`. They must
  // share the corrected density law, but may not silently grow beyond it,
  // whatever the emitting variant costs.
  const code = codeOnly(defaultVariant(marchWgsl));
  assert.equal(
    codeOnly("let sentinel = 1.0; // rewritten prose"),
    "let sentinel = 1.0;",
    "the code-only pin must ignore trailing comments as well as whole lines",
  );
  assert.equal(
    code.split("\n").length,
    MARCH_DEFAULT_CODE_LINES,
    "the default variant gained or lost CODE lines — review the shared-density-law constraint",
  );
  assert.equal(
    crypto.createHash("sha256").update(code).digest("hex"),
    MARCH_DEFAULT_CODE_SHA256,
    "the default march variant drifted from the approved C13-16 baseline",
  );
  // ...and the variant must actually DO something, or the pin above is
  // pinning a no-op.
  const emitCode = codeOnly(
    preprocess(marchWgsl, 0, ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION),
  );
  assert.ok(
    emitCode.split("\n").length > MARCH_DEFAULT_CODE_LINES,
    "the emission variant emits no more code than the default — the ifdef blocks are empty",
  );
});

test("F2 the producer is a SEPARATE module that does not embed the march", () => {
  for (const token of ["marchDeck", "fn cloudDensity", "QF_OCTAVES_SHIFT"]) {
    assert.ok(
      !producerWgsl.includes(token),
      `the producer pulls in "${token}" — that is the shared march module leaking back in`,
    );
  }
  // ...and the pipeline compiles from the new module ALONE, not from the
  // concatenated march source the visible/shadow/mask pipelines share.
  const ensure = cloudRenderer.slice(
    cloudRenderer.indexOf("function ensureCloudAttachmentResources("),
    cloudRenderer.indexOf("function ensureHalfResResources("),
  );
  // Batch 942: the compile routes through preprocess at defines=0 (raw
  // ifdef-bearing text is invalid WGSL — the post-C13-10 regression); the
  // separate-module property this test protects is unchanged.
  assert.match(
    ensure,
    /code: preprocess\(CloudReconstructionAttachmentsWGSL, 0, 0\),/,
  );
  assert.ok(
    !ensure.includes("PROCEDURAL_CLOUDS_SOURCE"),
    "compiling the march source into this pipeline would reintroduce exactly the register pressure C13-39 measured",
  );
  // The march's own source composition is untouched.
  assert.match(
    cloudRenderer,
    /const PROCEDURAL_CLOUDS_SOURCE = `\$\{CloudDensityDomainWGSL\}\\n\$\{ProceduralCloudsWGSL\}`;/,
  );
});

test("F3 the WGSL and the TS twin are the SAME estimator, character for character", () => {
  const expression = "t0 + 1.0 / sigma - (span * oneMinusA) / a";
  assert.ok(
    producerWgsl.includes(`return ${expression};`),
    "the WGSL estimator drifted from the pinned expression",
  );
  assert.ok(
    attachmentModuleSource.includes(`return ${expression};`),
    "the CPU twin drifted from the WGSL — a silently diverging twin is how a spec stops testing the shader",
  );
  for (const [name, source] of [
    ["WGSL", producerWgsl],
    ["TS", attachmentModuleSource],
  ]) {
    assert.ok(
      source.includes("return t0 + 0.5 * span;"),
      `${name} positive alpha->0 limit`,
    );
    assert.ok(
      source.includes("return -1.0;"),
      `${name} empty-interval sentinel`,
    );
    // NEITHER implementation may snap to the front face: the approach is
    // logarithmic, so a snap is a tenth-of-a-deck discontinuity at full
    // opacity. Both floor the transmittance instead.
    assert.ok(
      !/return\s+t0;/.test(source),
      `${name} snaps to t0 — see the estimator's own note on why that is a discontinuity`,
    );
  }
  assert.ok(
    producerWgsl.includes("interval.x >= 0.0 && alpha > 0.0"),
    "the fallback producer must keep both depth channels at -1 for zero alpha",
  );
  // Both floors are the SAME numbers, or the twin stops predicting the shader.
  assert.ok(producerWgsl.includes("MIN_RESOLVED_ALPHA: f32 = 1.0e-4;"));
  assert.ok(producerWgsl.includes("MIN_RESOLVED_TRANSMITTANCE: f32 = 1.0e-6;"));
  assert.ok(
    attachmentModuleSource.includes("CLOUD_WEIGHTED_DEPTH_MIN_ALPHA = 1.0e-4;"),
  );
  assert.ok(
    attachmentModuleSource.includes(
      "CLOUD_WEIGHTED_DEPTH_MIN_TRANSMITTANCE = 1.0e-6;",
    ),
  );
});

/** MRT outputs of `AttachmentOutput` in one PREPROCESSED producer variant. */
function producerOutputs(source) {
  // Scoped to the fragment output struct: `VertexOutput` also declares a
  // `@location(0)`, and a whole-file scan would silently include it.
  const start = source.indexOf("struct AttachmentOutput {");
  assert.ok(start > 0, "no AttachmentOutput struct in this variant");
  const body = source.slice(start, source.indexOf("};", start));
  return [...body.matchAll(/@location\((\d)\) (\w+):/g)].map((m) => ({
    location: Number(m[1]),
    name: m[2],
  }));
}

// ★ UPDATED BY C13-10. The producer used to have ONE output layout; it now has
//   two, and which one is correct depends on who wrote the depth slot.
test("F4 each producer variant writes exactly the attachments IT owns, in slot order", () => {
  // DEFAULT — the producer owns all three, and slot N maps to @location(N-1)
  // because slot 0 is the shared march target.
  const defaultOutputs = producerOutputs(defaultVariant(producerWgsl));
  assert.deepEqual(defaultOutputs, [
    { location: 0, name: "depth" },
    { location: 1, name: "velocity" },
    { location: 2, name: "moments" },
  ]);
  defaultOutputs.forEach((out, index) => {
    assert.equal(
      out.name,
      CLOUD_OWNED_ATTACHMENTS[index].key,
      "MRT order must follow the owned contract, or the formats bind to the wrong target",
    );
    assert.equal(
      CLOUD_OWNED_ATTACHMENTS[index].slot,
      out.location + 1,
      "owned slot N maps to @location(N-1); slot 0 is the shared march target",
    );
  });

  // EMISSION — the march wrote slot 1, so the producer must NOT list it. A
  // producer that kept the depth output here would be writing a target it also
  // samples, which is not expressible in one render pass.
  const emitOutputs = producerOutputs(
    preprocess(producerWgsl, 0, ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION),
  );
  assert.deepEqual(emitOutputs, [
    { location: 0, name: "velocity" },
    { location: 1, name: "moments" },
  ]);
  emitOutputs.forEach((out, index) => {
    assert.equal(
      out.name,
      CLOUD_EMITTED_ATTACHMENTS[index].key,
      "the emitting MRT order must follow CLOUD_EMITTED_ATTACHMENTS",
    );
  });
  assert.deepEqual(
    CLOUD_EMITTED_ATTACHMENTS.map((spec) => spec.key),
    ["velocity", "moments"],
    "the emitted list must be the owned list MINUS the slot the march took over",
  );

  // The renderer derives BOTH pipelines' targets from the SAME tables.
  assert.match(
    cloudRenderer,
    /targets: CLOUD_OWNED_ATTACHMENTS\.map\(\(spec\) => \(\{\n\s*format: spec\.format,\n\s*\}\)\),/,
  );
  assert.match(
    cloudRenderer,
    /targets: CLOUD_EMITTED_ATTACHMENTS\.map\(\(spec\) => \(\{\n\s*format: spec\.format,\n\s*\}\)\),/,
  );
});

test("F5 the producer reads the march target UNFILTERED — a blur would erase the moments", () => {
  assert.ok(
    producerWgsl.includes("textureLoad(currentTex,"),
    "the moment pair measures the signal, so the fetch must not filter it",
  );
  assert.ok(
    !producerWgsl.includes("textureSample"),
    "a sampled fetch at 1:1 resolution only adds filtering error",
  );
  // ...and therefore the bind group declares no sampler at all.
  const ensure = cloudRenderer.slice(
    cloudRenderer.indexOf("function ensureCloudAttachmentResources("),
    cloudRenderer.indexOf("function ensureHalfResResources("),
  );
  assert.ok(!ensure.includes("sampler("));
});

// ─────────────────────────────────────────────────────────────────────────────
// G. naga
// ─────────────────────────────────────────────────────────────────────────────

test("G1 the producer shader passes naga validation", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  // ★ UPDATED BY C13-10: naga must see what the PIPELINE sees, not the raw
  //   file. Since the producer gained `//>>ifdef` branches that redefine
  //   `AttachmentOutput` and `weighted`, the raw text is deliberately not valid
  //   WGSL on its own — both branches are present at once. Validating it
  //   unpreprocessed would fail for a reason that has nothing to do with either
  //   shader being wrong.
  //
  // The producer is a STANDALONE module: this is the exact text each pipeline
  // compiles, with no density-domain or march prelude concatenated in.
  assert.doesNotThrow(() => naga.validate_wgsl(defaultVariant(producerWgsl)));
  assert.doesNotThrow(() =>
    naga.validate_wgsl(
      preprocess(
        producerWgsl,
        0,
        ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION,
      ),
    ),
  );
  // ...and the march still validates in BOTH variants.
  const densityDomain = readEngine(
    "Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
  );
  assert.doesNotThrow(() =>
    naga.validate_wgsl(`${densityDomain}\n${defaultVariant(marchWgsl)}`),
  );
  assert.doesNotThrow(() =>
    naga.validate_wgsl(
      `${densityDomain}\n${preprocess(marchWgsl, 0, ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION)}`,
    ),
  );
});
