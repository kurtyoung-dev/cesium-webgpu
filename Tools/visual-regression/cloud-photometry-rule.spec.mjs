// cloud-photometry-rule.spec.mjs — C13-N09. Pure Node: no browser, no GPU.
//
// @purpose Asserts the photometric path measures linear PRE-Reinhard radiance with the sun disc masked, that measuring after the tonemapper gives a different answer, and that the harness capture path supplies the live exposure rather than a default.
// @status ACTIVE
//
// WHAT THIS SPEC IS FOR. Campaign 13 v2 §1.3 makes one rule binding on every
// photometric bar (A1, A4, A5, G3, L1, O2):
//
//   "all photometric statistics are computed on linear, pre-tonemap HDR values,
//    with the sun disc masked out of every ROI. The march applies its own
//    Reinhard at ProceduralClouds.wgsl:2645-2646, so any ratio measured after
//    it is a ratio of the tonemapper."
//
// A spec that only asserted "the code calls inverseReinhard" would assert the
// instruction was followed. These assertions are about OUTCOMES instead: a
// known radiance ratio, pushed through the renderer's own operator and
// quantized to 8 bits, comes back out; the forbidden measurement on the same
// pixels does NOT come back out; a saturated pixel is refused rather than
// inverted; and a sun disc inside the ROI changes nothing once masked.
//
// WHY IT PINS SHADER SOURCE TOO. The inverse is only correct while the forward
// operator is Reinhard. If a later row swaps in ACES or a filmic curve, every
// number above becomes wrong in a way no arithmetic assertion here can see —
// so the operator itself is pinned at its real file, and that pin is the tripwire.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  DEFAULT_CLOUD_EXPOSURE,
  DEFAULT_SATURATION_CEILING,
  DEFAULT_TRANSFER,
  EXPOSURE_UNIFORM_SLOT,
  REINHARD_OPERATOR_PIN,
  TRANSFER_FUNCTIONS,
  circularMask,
  displaySpaceLuminanceMean,
  forwardReinhard,
  inverseReinhard,
  luminance,
  photometricRatio,
  photometricStats,
  rectRoi,
} from "./lib/cloud-photometry.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// ---------------------------------------------------------------------------
// Synthetic captures: a known radiance, through the REAL operator, to 8 bits
// ---------------------------------------------------------------------------

/**
 * Paint a capture whose left half holds `leftRadiance` and right half
 * `rightRadiance`, tone-mapped by the shader's operator and quantized the way
 * a `unorm` canvas quantizes. Grey, so luminance is the channel value.
 */
function paintTwoBandCapture({
  width,
  height,
  leftRadiance,
  rightRadiance,
  exposure,
}) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const radiance = x < width / 2 ? leftRadiance : rightRadiance;
      const byte = Math.round(forwardReinhard(radiance, exposure) * 255);
      const base = (y * width + x) * 4;
      rgba[base] = byte;
      rgba[base + 1] = byte;
      rgba[base + 2] = byte;
      rgba[base + 3] = 255;
    }
  }
  return rgba;
}

function paintSaturatedDisc(rgba, { width, centreX, centreY, radiusPixels }) {
  const r2 = radiusPixels * radiusPixels;
  const height = rgba.length / 4 / width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - centreX;
      const dy = y + 0.5 - centreY;
      if (dx * dx + dy * dy <= r2) {
        const base = (y * width + x) * 4;
        rgba[base] = 255;
        rgba[base + 1] = 255;
        rgba[base + 2] = 255;
        rgba[base + 3] = 255;
      }
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// 1. The operator this module inverts is still the operator the shader applies
// ---------------------------------------------------------------------------

test("the pinned Reinhard operator is the one ProceduralClouds.wgsl applies", () => {
  const shaderPath = path.join(REPO_ROOT, REINHARD_OPERATOR_PIN.file);
  assert.ok(
    fs.existsSync(shaderPath),
    `pinned shader path does not exist: ${REINHARD_OPERATOR_PIN.file}`,
  );
  const source = fs.readFileSync(shaderPath, "utf8");
  const lines = source.split(/\r?\n/);
  const exposeIndex = lines.findIndex((line) =>
    line.includes(REINHARD_OPERATOR_PIN.exposeLine),
  );
  const mapIndex = lines.findIndex((line) =>
    line.includes(REINHARD_OPERATOR_PIN.mapLine),
  );
  assert.ok(
    exposeIndex >= 0,
    "the exposure multiply is no longer in the shader",
  );
  assert.ok(mapIndex >= 0, "the Reinhard map is no longer in the shader");
  // Adjacency matters: the inverse assumes the map consumes the exposed value
  // directly. Something inserted between them would break that assumption
  // without either line disappearing.
  assert.equal(
    mapIndex,
    exposeIndex + 1,
    `the exposure multiply (line ${exposeIndex + 1}) and the Reinhard map (line ${
      mapIndex + 1
    }) are no longer adjacent; lib/cloud-photometry.mjs inverts them as a pair`,
  );
  // And the shader tone-maps ONLY once on this path: two Reinhards in the
  // composite would make a single inverse a half-measure.
  const reinhardOccurrences = lines.filter((line) =>
    line.includes("exposed + vec3<f32>(1.0)"),
  ).length;
  assert.equal(
    reinhardOccurrences,
    1,
    "more than one Reinhard application found; the single-inverse assumption no longer holds",
  );
});

// ---------------------------------------------------------------------------
// 2. The inverse recovers radiance, and the forbidden measurement does not
// ---------------------------------------------------------------------------

test("the inverse recovers authored radiance through the real forward operator", () => {
  for (const radiance of [0.05, 0.5, 1.0, 4.0, 12.0, 30.0]) {
    const display = forwardReinhard(radiance, DEFAULT_CLOUD_EXPOSURE);
    const recovered = inverseReinhard(display, DEFAULT_CLOUD_EXPOSURE);
    assert.ok(
      Math.abs(recovered - radiance) <= 1e-9 * Math.max(1, radiance),
      `radiance ${radiance} recovered as ${recovered}`,
    );
  }
});

test("a radiance ratio survives the rule and is crushed without it", () => {
  // A1's shape: a silver-lining edge against an interior, ratio 8.0. The
  // renderer's own dual-lobe peak times a ~10 sun intensity is what puts these
  // in the region where Reinhard is strongly compressive, which is exactly why
  // the rule exists.
  const width = 64;
  const height = 16;
  const exposure = DEFAULT_CLOUD_EXPOSURE;
  const interior = 1.5;
  const edge = 12.0;
  const authoredRatio = edge / interior;

  const rgba = paintTwoBandCapture({
    width,
    height,
    leftRadiance: interior,
    rightRadiance: edge,
    exposure,
  });
  const interiorRoi = rectRoi({
    width,
    height,
    x: 0,
    y: 0,
    w: width / 2,
    h: height,
  });
  const edgeRoi = rectRoi({
    width,
    height,
    x: width / 2,
    y: 0,
    w: width / 2,
    h: height,
  });

  const interiorStats = photometricStats(rgba, {
    width,
    height,
    exposure,
    roi: interiorRoi,
  });
  const edgeStats = photometricStats(rgba, {
    width,
    height,
    exposure,
    roi: edgeRoi,
  });
  const recovered = photometricRatio(edgeStats, interiorStats);

  assert.equal(recovered.comparable, true);
  assert.equal(interiorStats.provenance.space, "linear-pre-reinhard");
  // Tolerance is 8-bit quantization, not slack. At exposure 0.22 the edge band
  // lands near display 0.725 where one byte is ~0.4% of the value and the
  // inverse amplifies that by 1/(1-t) ~ 3.6, so ~1.5% is the arithmetic floor;
  // 3% is that with one step of headroom and is still far tighter than the
  // discrepancy the next assertion measures.
  assert.ok(
    Math.abs(recovered.ratio - authoredRatio) / authoredRatio < 0.03,
    `recovered ratio ${recovered.ratio} vs authored ${authoredRatio}`,
  );

  // The forbidden measurement, on the SAME pixels.
  const displayRatio =
    displaySpaceLuminanceMean(rgba, { width, height, roi: edgeRoi }) /
    displaySpaceLuminanceMean(rgba, { width, height, roi: interiorRoi });
  assert.ok(
    displayRatio < authoredRatio * 0.5,
    `display-space ratio ${displayRatio} should be far below the authored ${authoredRatio}; ` +
      "if it is not, this capture no longer exercises the compressive region and the " +
      "assertion above proves nothing",
  );
  // And it must be a measurable disagreement, not a rounding difference: this
  // is the number that makes the rule load-bearing rather than stylistic.
  assert.ok(
    recovered.ratio / displayRatio > 2,
    `the rule changed the answer by only ${recovered.ratio / displayRatio}x`,
  );
});

// ---------------------------------------------------------------------------
// 3. Saturation is refused, counted, and never inverted into a number
// ---------------------------------------------------------------------------

test("a saturated display value is refused rather than inverted", () => {
  assert.throws(
    () => inverseReinhard(1, DEFAULT_CLOUD_EXPOSURE),
    /saturated/,
    "a display value of 1 has no recoverable radiance",
  );
  assert.throws(
    () => inverseReinhard(1.5, DEFAULT_CLOUD_EXPOSURE),
    /saturated/,
  );
  // Just below the ceiling is legal but enormous — which is why the ceiling
  // exists rather than only the hard bound at 1.
  const nearCeiling = inverseReinhard(
    DEFAULT_SATURATION_CEILING - 1e-6,
    DEFAULT_CLOUD_EXPOSURE,
  );
  assert.ok(nearCeiling > 100 * inverseReinhard(0.5, DEFAULT_CLOUD_EXPOSURE));
});

test("saturated pixels are excluded from the statistic and counted", () => {
  const width = 32;
  const height = 32;
  const exposure = DEFAULT_CLOUD_EXPOSURE;
  const clean = paintTwoBandCapture({
    width,
    height,
    leftRadiance: 2,
    rightRadiance: 2,
    exposure,
  });
  const cleanStats = photometricStats(clean, { width, height, exposure });
  assert.equal(cleanStats.excludedSaturated, 0);
  assert.equal(cleanStats.saturatedFraction, 0);

  const polluted = paintSaturatedDisc(Uint8Array.from(clean), {
    width,
    centreX: 16,
    centreY: 16,
    radiusPixels: 5,
  });
  const pollutedStats = photometricStats(polluted, { width, height, exposure });
  assert.ok(pollutedStats.excludedSaturated > 0, "the disc was not detected");
  assert.ok(Number.isFinite(pollutedStats.meanLuminance));
  // Excluded, so the surviving pixels are the clean ones and the mean is
  // unchanged — the disc did not leak an inverted 255 into the average.
  assert.ok(
    Math.abs(pollutedStats.meanLuminance - cleanStats.meanLuminance) < 1e-9,
    "excluding saturated pixels changed the mean of the pixels that remained",
  );

  // A fully saturated ROI is nulls, not NaN: a bar cannot be evaluated here and
  // must be able to say so.
  const allWhite = new Uint8Array(width * height * 4).fill(255);
  const blank = photometricStats(allWhite, { width, height, exposure });
  assert.equal(blank.counted, 0);
  assert.equal(blank.meanLuminance, null);
  assert.equal(blank.medianLuminance, null);
  assert.equal(blank.meanRadiance, null);
  assert.equal(blank.saturatedFraction, 1);
});

// ---------------------------------------------------------------------------
// 4. The sun disc is masked out of the ROI
// ---------------------------------------------------------------------------

test("a masked sun disc leaves the statistic identical to the unpolluted frame", () => {
  const width = 40;
  const height = 40;
  const exposure = DEFAULT_CLOUD_EXPOSURE;
  const clean = paintTwoBandCapture({
    width,
    height,
    leftRadiance: 3,
    rightRadiance: 3,
    exposure,
  });
  const cleanStats = photometricStats(clean, { width, height, exposure });

  // A sun that is bright but NOT saturated — the case the saturation ceiling
  // alone does not catch, and therefore the case that proves the mask is
  // doing work rather than the ceiling doing it for free.
  const sunDisplay = DEFAULT_SATURATION_CEILING - 0.01;
  const sunByte = Math.round(sunDisplay * 255);
  const polluted = Uint8Array.from(clean);
  const mask = circularMask({
    width,
    height,
    centreX: 20,
    centreY: 20,
    radiusPixels: 6,
  });
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] === 1) {
      polluted[i * 4] = sunByte;
      polluted[i * 4 + 1] = sunByte;
      polluted[i * 4 + 2] = sunByte;
    }
  }

  const unmasked = photometricStats(polluted, { width, height, exposure });
  assert.equal(unmasked.provenance.sunDiscMasked, false);
  assert.ok(
    unmasked.meanLuminance > cleanStats.meanLuminance * 1.5,
    "the unmasked sun must visibly contaminate the mean, or this test proves nothing",
  );

  const masked = photometricStats(polluted, {
    width,
    height,
    exposure,
    sunDiscMask: mask,
  });
  assert.equal(masked.provenance.sunDiscMasked, true);
  assert.equal(masked.excludedSunDisc, mask.count);
  assert.ok(
    Math.abs(masked.meanLuminance - cleanStats.meanLuminance) < 1e-9,
    `masked mean ${masked.meanLuminance} vs clean ${cleanStats.meanLuminance}`,
  );
});

test("a mask sized for a different capture is refused", () => {
  const mask = circularMask({
    width: 8,
    height: 8,
    centreX: 4,
    centreY: 4,
    radiusPixels: 2,
  });
  assert.throws(
    () =>
      photometricStats(new Uint8Array(16 * 16 * 4), {
        width: 16,
        height: 16,
        exposure: DEFAULT_CLOUD_EXPOSURE,
        sunDiscMask: mask,
      }),
    /mask is 8x8 but the capture is 16x16/,
  );
});

// ---------------------------------------------------------------------------
// 5. The two premises a caller could get silently wrong
// ---------------------------------------------------------------------------

test("a photometric statistic without the live exposure is refused, not defaulted", () => {
  const rgba = new Uint8Array(4 * 4 * 4).fill(60);
  for (const exposure of [undefined, null, 0, -1, Number.NaN, "0.22"]) {
    assert.throws(
      () => photometricStats(rgba, { width: 4, height: 4, exposure }),
      new RegExp(`slot ${EXPOSURE_UNIFORM_SLOT}`),
      `exposure ${String(exposure)} should have been refused`,
    );
  }
});

test("the declared transfer function changes the answer, so it cannot be decoration", () => {
  const width = 32;
  const height = 8;
  const exposure = DEFAULT_CLOUD_EXPOSURE;
  const rgba = paintTwoBandCapture({
    width,
    height,
    leftRadiance: 1.5,
    rightRadiance: 12,
    exposure,
  });
  const left = rectRoi({ width, height, x: 0, y: 0, w: width / 2, h: height });
  const right = rectRoi({
    width,
    height,
    x: width / 2,
    y: 0,
    w: width / 2,
    h: height,
  });
  const identityRatio = photometricRatio(
    photometricStats(rgba, {
      width,
      height,
      exposure,
      roi: right,
      transfer: "identity",
    }),
    photometricStats(rgba, {
      width,
      height,
      exposure,
      roi: left,
      transfer: "identity",
    }),
  ).ratio;
  const srgbRatio = photometricRatio(
    photometricStats(rgba, {
      width,
      height,
      exposure,
      roi: right,
      transfer: "srgb",
    }),
    photometricStats(rgba, {
      width,
      height,
      exposure,
      roi: left,
      transfer: "srgb",
    }),
  ).ratio;
  assert.ok(
    Math.abs(identityRatio - srgbRatio) / identityRatio > 0.2,
    `the two decodes agree to within ${Math.abs(identityRatio - srgbRatio) / identityRatio}; ` +
      "if the choice did not matter it would not need declaring",
  );
  // And two statistics taken under different decodes are reported as not
  // comparable rather than silently ratioed.
  const crossed = photometricRatio(
    photometricStats(rgba, {
      width,
      height,
      exposure,
      roi: right,
      transfer: "srgb",
    }),
    photometricStats(rgba, {
      width,
      height,
      exposure,
      roi: left,
      transfer: "identity",
    }),
  );
  assert.equal(crossed.comparable, false);
  assert.equal(DEFAULT_TRANSFER, "identity");
  assert.ok(typeof TRANSFER_FUNCTIONS.srgb === "function");
  assert.ok(luminance(1, 1, 1) > 0.999);
});

// ---------------------------------------------------------------------------
// 6. The harness capture path supplies what only the page knows
// ---------------------------------------------------------------------------

/**
 * Install the harness the way Playwright installs it: from the function's own
 * SOURCE, in a fresh context. A module-scope reference in the helper would
 * throw here exactly as it throws in the page — which is the whole reason the
 * constants live inside the function body.
 */
function installInStubPage(world) {
  const context = vm.createContext(world);
  vm.runInContext(`(${installCloudProbeHarness.toString()})()`, context);
  return context.__cloudProbe;
}

function stubWorld({
  exposure = 0.37,
  presentationFormat = "bgra8unorm",
  sunProjects = true,
  fovy = Math.PI / 3,
  width = 1000,
  height = 1000,
  clientWidth = 500,
  clientHeight = 500,
} = {}) {
  const uniformData = new Float32Array(256);
  if (exposure !== null) {
    uniformData[EXPOSURE_UNIFORM_SLOT] = exposure;
  }
  const world = {
    Cesium: {
      SceneTransforms: {
        worldToWindowCoordinates: () =>
          sunProjects ? { x: 100, y: 200 } : undefined,
      },
    },
    viewer: {
      scene: {
        canvas: { width, height, clientWidth, clientHeight },
        camera: { frustum: { fovy } },
        context: {
          rendererType: "webgpu",
          isWebGPU: true,
          _presentationFormat: presentationFormat,
          _cloudCache: { uniformData },
          uniformState: { sunPositionWC: { x: 1, y: 0, z: 0 } },
        },
      },
    },
  };
  world.globalThis = world;
  return world;
}

test("the capture path reports the LIVE exposure, not the packer default", () => {
  const probe = installInStubPage(stubWorld({ exposure: 0.37 }));
  const context = probe.photometricContext();
  assert.equal(context.ok, true, context.reasons.join("; "));
  assert.equal(context.exposureSlot, EXPOSURE_UNIFORM_SLOT);
  assert.ok(Math.abs(context.exposure - 0.37) < 1e-6);
  assert.notEqual(context.exposure, DEFAULT_CLOUD_EXPOSURE);
  // The statistic it enables is therefore computed against 0.37.
  const rgba = paintTwoBandCapture({
    width: 8,
    height: 8,
    leftRadiance: 2,
    rightRadiance: 2,
    exposure: 0.37,
  });
  const stats = photometricStats(rgba, {
    width: 8,
    height: 8,
    exposure: context.exposure,
    transfer: context.transfer,
  });
  assert.ok(Math.abs(stats.meanLuminance - 2) / 2 < 0.02);
});

test("the capture path refuses when the exposure uniform has not been packed", () => {
  const probe = installInStubPage(stubWorld({ exposure: null }));
  const context = probe.photometricContext();
  assert.equal(context.ok, false);
  assert.equal(context.exposure, null);
  assert.ok(
    context.reasons.some((reason) =>
      reason.includes(`slot ${EXPOSURE_UNIFORM_SLOT}`),
    ),
    `reasons did not name the slot: ${context.reasons.join("; ")}`,
  );
});

test("the sun-disc mask is sized from this frame's fovy and the capture's pixel scale", () => {
  const probe = installInStubPage(stubWorld({ fovy: Math.PI / 3 }));
  const context = probe.photometricContext();
  assert.equal(context.sunDisc.visible, true);
  // CSS 500px wide, drawing buffer 1000px: the projected (100, 200) must land
  // at (200, 400) in capture pixels or the mask sits somewhere the sun is not.
  assert.ok(Math.abs(context.sunDisc.x - 200) < 1e-6);
  assert.ok(Math.abs(context.sunDisc.y - 400) < 1e-6);
  const pixelsPerRadian = 1000 / 2 / Math.tan(Math.PI / 6);
  const expected = context.sunDisc.angularRadiusRadians * pixelsPerRadian * 3;
  assert.ok(
    Math.abs(context.sunDisc.radiusPixels - expected) < 1e-6,
    `radius ${context.sunDisc.radiusPixels} vs ${expected}`,
  );
  // Halving the field of view doubles the pixels per radian, so the same sun
  // must be masked with twice the radius.
  const narrow = installInStubPage(
    stubWorld({ fovy: Math.PI / 3 }),
  ).photometricContext({
    sunDiscRadiusScale: 6,
  });
  assert.ok(Math.abs(narrow.sunDisc.radiusPixels - expected * 2) < 1e-6);
  // The mask it describes is directly constructible.
  const mask = circularMask({
    width: context.width,
    height: context.height,
    centreX: context.sunDisc.x,
    centreY: context.sunDisc.y,
    radiusPixels: context.sunDisc.radiusPixels,
  });
  assert.ok(mask.count > 0);
});

test("a sun that does not project is reported as absent, not as a failure", () => {
  const context = installInStubPage(
    stubWorld({ sunProjects: false }),
  ).photometricContext();
  assert.equal(context.ok, true);
  assert.equal(context.sunDisc.visible, false);
});

test("the transfer function follows the presentation format rather than a preference", () => {
  assert.equal(
    installInStubPage(
      stubWorld({ presentationFormat: "bgra8unorm" }),
    ).photometricContext().transfer,
    "identity",
  );
  assert.equal(
    installInStubPage(
      stubWorld({ presentationFormat: "rgba8unorm" }),
    ).photometricContext().transfer,
    "identity",
  );
  assert.equal(
    installInStubPage(
      stubWorld({ presentationFormat: "bgra8unorm-srgb" }),
    ).photometricContext().transfer,
    "srgb",
  );
});

test("the capture path does not touch the readiness path L1 owns", () => {
  // One defect, one owner: this lane added `photometricContext` and nothing
  // else. If a later edit makes the capture path call into readiness, the two
  // lanes stop being separable and this assertion is where that is noticed.
  // `* text=auto` with `core.autocrlf=true` means the working-tree source may
  // arrive with either line ending, so normalize before anchoring on one.
  const source = fs
    .readFileSync(path.join(HERE, "lib", "cloud-probe-harness.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  const start = source.indexOf("photometricContext(options = {})");
  const end = source.indexOf("proceduralRealization,\n  });", start);
  assert.ok(
    start > 0 && end > start,
    "photometricContext is no longer where it was added",
  );
  const body = source.slice(start, end);
  for (const forbidden of [
    "awaitProceduralReady",
    "proceduralRealization",
    "executeCalls",
  ]) {
    assert.ok(
      !body.includes(forbidden),
      `the capture path references the readiness path's ${forbidden}`,
    );
  }
});
