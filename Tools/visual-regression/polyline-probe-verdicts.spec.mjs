// polyline-probe-verdicts.spec.mjs — the polyline family's migrated probes,
// asserted as behaviour (probe-kit harvest, DX-108). Pure Node: no browser, no
// GPU, no network; every file it writes lands under the lane temp root.
//
// @purpose Drives each migrated polyline probe's exported decision function on hand-built results (healthy, each defect, each refusal), and walks every migrated descriptor end to end through the real runProbe on a stubbed browser, so a probe that cannot reach its verdicts fails here rather than on an Edge leg.
// @status ACTIVE
//
// WHY BOTH HALVES. The decision functions are where each probe's unique
// assertions now live; part V proves every clause can fail, and fails for the
// defect it names, without another clause masking it. Part W proves the
// INSTRUMENT can reach those clauses: a stubbed browser answers each
// `page.evaluate` by the source it is handed and returns PNGs drawn here, and
// the real runtime walks argv -> lifecycle -> Edge slot -> cells -> capture
// seam -> verdicts -> receipt -> exit code. AR-752 lost an Edge leg to a
// descriptor shape no source-reading guard executed
// (`probe-descriptor-cells-contract.spec.mjs`); these walks are the same check
// for the nine probes this harvest moved.
//
// NOTHING HERE IS EVIDENCE ABOUT THE ENGINE. The frames are fixtures chosen to
// put each clause on a known side.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";
import {
  descriptor as modesDescriptor,
  evaluateAppearanceModes,
} from "./probe-polyline-appearance-2d.mjs";
import {
  descriptor as logDepthDescriptor,
  evaluateLogDepth,
} from "./probe-polyline-appearance-logdepth.mjs";
import {
  descriptor as pickDescriptor,
  evaluateAppearancePick,
} from "./probe-polyline-appearance-pick.mjs";
import {
  descriptor as primitiveDescriptor,
  evaluateAppearancePrimitive,
} from "./probe-polyline-appearance-primitive.mjs";
import {
  descriptor as consumeDescriptor,
  evaluateCloudConsume,
} from "./probe-polyline-cloud-consume.mjs";
import {
  descriptor as geodesicDescriptor,
  evaluateGeodesic,
  measureGeodesic,
} from "./probe-polyline-geodesic.mjs";
import {
  descriptor as imageDescriptor,
  diagnoseImageMaterial,
  splitTextureDataUri,
  RIG as IMAGE_RIG,
} from "./probe-polyline-image-material.mjs";
import {
  descriptor as materialDescriptor,
  evaluateMaterialPrimitive,
} from "./probe-polyline-material-primitive.mjs";
import { descriptor as multimaterialDescriptor } from "./probe-polyline-multimaterial.mjs";

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function blank(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

function fill(image, x0, y0, x1, y1, [r, g, b]) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
    }
  }
  return image;
}

const png = (image) =>
  Buffer.from(encodeRgbaPng(image.data, image.width, image.height));

const FRAME = {
  cyan: () => fill(blank(64, 48), 4, 4, 59, 19, [0, 255, 255]),
  dash: () => {
    // 16 dashes of 6 x 4 = 384 lit pixels, 16 runs a row.
    const image = blank(160, 20);
    for (let x = 0; x < 160; x++) {
      if (x % 10 < 6) fill(image, x, 8, x, 11, [0, 255, 255]);
    }
    return image;
  },
  cyanAndMagenta: () =>
    fill(
      fill(blank(64, 48), 2, 2, 61, 9, [0, 255, 255]),
      2,
      20,
      61,
      27,
      [255, 0, 255],
    ),
  split: () =>
    fill(
      fill(blank(100, 30), 10, 10, 49, 19, [255, 0, 0]),
      50,
      10,
      89,
      19,
      [0, 0, 255],
    ),
  arc: (bow = 25, width = 120) => {
    const image = blank(width, 60);
    for (let x = 10; x <= 110; x++) {
      const t = (x - 60) / 50;
      const y = 40 - Math.round(bow * (1 - t * t));
      fill(image, x, y, x, y + 1, [0, 255, 255]);
      fill(image, x, 45, x, 46, [255, 0, 0]);
    }
    return image;
  },
  multimaterial: () => {
    const image = blank(160, 64);
    fill(image, 10, 4, 150, 7, [255, 0, 0]);
    for (let x = 10; x <= 150; x++) {
      if ((x - 10) % 18 < 12) fill(image, x, 12, x, 15, [0, 255, 255]);
    }
    for (let y = 19; y <= 31; y++) {
      const v = Math.max(0, 255 - 40 * Math.abs(y - 25));
      fill(image, 10, y, 150, y, [v, v, 0]);
    }
    fill(image, 10, 37, 120, 40, [255, 0, 255]);
    for (let k = 0; k < 12; k++) {
      const half = 12 - k;
      fill(image, 121 + k, 39 - half, 121 + k, 38 + half, [255, 0, 255]);
    }
    fill(image, 10, 47, 150, 49, [0, 0, 255]);
    fill(image, 10, 50, 150, 53, [0, 255, 0]);
    fill(image, 10, 54, 150, 56, [0, 0, 255]);
    return image;
  },
};

// ---------------------------------------------------------------------------
// V. The decision functions
// ---------------------------------------------------------------------------

const failing = (verdicts) =>
  verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.id);

test("V1 appearance-primitive: four clauses per arc type; a 0px WebGPU line fails only its own draws and parity", () => {
  const healthy = (webgpuCyan = 1000) => ({
    webgl: { render: { cyan: 1000 } },
    webgpu: {
      render: { cyan: webgpuCyan },
      gate: { errorCount: 0, deviceLost: null },
    },
  });
  const all = { GEODESIC: healthy(), NONE: healthy() };
  assert.equal(evaluateAppearancePrimitive(all).length, 8);
  assert.deepEqual(failing(evaluateAppearancePrimitive(all)), []);
  assert.deepEqual(
    failing(evaluateAppearancePrimitive({ ...all, NONE: healthy(0) })),
    ["NONE/webgpu-draws", "NONE/parity"],
  );
  // 0.85 is inside the band, 0.84 is not.
  assert.deepEqual(
    failing(evaluateAppearancePrimitive({ ...all, NONE: healthy(850) })),
    [],
  );
  assert.deepEqual(
    failing(evaluateAppearancePrimitive({ ...all, NONE: healthy(840) })),
    ["NONE/parity"],
  );
  const lost = healthy();
  lost.webgpu.gate = {
    errorCount: 0,
    deviceLost: "device lost: reason=unknown",
  };
  assert.deepEqual(
    failing(evaluateAppearancePrimitive({ ...all, GEODESIC: lost })),
    ["GEODESIC/webgpu-error-free"],
  );
});

test("V2 material-primitive: a solid dash fails dashed-ness, not the count; a missing glow fails the glow", () => {
  const leg = (render) => ({ ...render });
  const results = (dashGpu, glowGpu) => ({
    PolylineDash: {
      webgl: { render: leg({ colored: 1000, runs: 60, runsPerRow: 5 }) },
      webgpu: {
        render: leg(dashGpu),
        gate: { errorCount: 0, deviceLost: null },
      },
    },
    PolylineGlow: {
      webgl: { render: leg({ colored: 2000 }) },
      webgpu: {
        render: leg(glowGpu),
        gate: { errorCount: 0, deviceLost: null },
      },
    },
  });
  const dashed = { colored: 1000, runs: 60, runsPerRow: 5 };
  assert.equal(
    evaluateMaterialPrimitive(results(dashed, { colored: 2000 })).length,
    10,
  );
  assert.deepEqual(
    failing(evaluateMaterialPrimitive(results(dashed, { colored: 2000 }))),
    [],
  );
  assert.deepEqual(
    failing(
      evaluateMaterialPrimitive(
        results({ colored: 1000, runs: 12, runsPerRow: 1 }, { colored: 2000 }),
      ),
    ),
    ["dash/webgpu-dashed"],
  );
  assert.deepEqual(
    failing(evaluateMaterialPrimitive(results(dashed, { colored: 0 }))),
    ["glow/webgpu-draws", "glow/parity"],
  );
});

test("V3 appearance-pick: the committed RED state fails exactly the WebGPU pick clause", () => {
  const backend = (picked, errs = []) => ({
    res: {
      cyan: 900,
      pickIds: 1,
      pickedPrimitive: picked,
      pickedId: false,
      hits: picked ? 3 : 0,
      nSamples: 4,
    },
    errs,
  });
  assert.deepEqual(
    failing(
      evaluateAppearancePick({ webgpu: backend(true), webgl: backend(true) }),
    ),
    [],
  );
  assert.deepEqual(
    failing(
      evaluateAppearancePick({ webgpu: backend(false), webgl: backend(true) }),
    ),
    ["webgpu-picks"],
  );
  assert.deepEqual(
    failing(
      evaluateAppearancePick({
        webgpu: backend(true, ["Validation error"]),
        webgl: backend(true),
      }),
    ),
    ["webgpu-no-new-errors"],
  );
  // No on-line pixels: the original's early return carries no pick fields.
  assert.deepEqual(
    failing(
      evaluateAppearancePick({
        webgpu: { res: { cyan: 0, pickIds: 0 }, errs: [] },
        webgl: backend(true),
      }),
    ),
    ["webgpu-renders-with-pick-ids", "webgpu-picks"],
  );
});

test("V4 appearance-2d: each cell carries its own band — 8 % passes GLOW2D and fails 3D", () => {
  const cells = (gpu) =>
    Object.fromEntries(
      ["3D", "CV", "2D", "GLOW2D"].map((k) => [k, { cyan: gpu[k] ?? 1000 }]),
    );
  const webgl = cells({});
  assert.equal(evaluateAppearanceModes({ webgl, webgpu: cells({}) }).length, 8);
  assert.deepEqual(
    failing(
      evaluateAppearanceModes({ webgl, webgpu: cells({ GLOW2D: 1080 }) }),
    ),
    [],
  );
  assert.deepEqual(
    failing(evaluateAppearanceModes({ webgl, webgpu: cells({ "3D": 1080 }) })),
    ["3D/webgpu-parity"],
  );
  assert.deepEqual(
    failing(evaluateAppearanceModes({ webgl, webgpu: cells({ CV: 0 }) })),
    ["CV/webgpu-parity"],
  );
});

test("V5 appearance-logdepth: the magenta band is 20 %, the cyan band 15 %, and an unbuilt cache fails its own clause", () => {
  const render = (over = {}) => ({
    cyan: 1000,
    magenta: 1000,
    logDepthOn: true,
    colorLogDepth: true,
    glowLogDepth: true,
    ...over,
  });
  const run = (gpu, errs = []) => ({
    webgl: { render: render() },
    webgpu: { render: render(gpu), newErrs: errs },
  });
  assert.equal(evaluateLogDepth(run({})).length, 10);
  assert.deepEqual(failing(evaluateLogDepth(run({ magenta: 820 }))), []);
  assert.deepEqual(failing(evaluateLogDepth(run({ cyan: 820 }))), [
    "cyan-parity",
  ]);
  assert.deepEqual(failing(evaluateLogDepth(run({ glowLogDepth: null }))), [
    "glow-cache-log-depth",
  ]);
  assert.deepEqual(failing(evaluateLogDepth(run({}, ["GPUValidationError"]))), [
    "webgpu-no-new-errors",
  ]);
});

test("V6 image-material: a diagnosis, never a verdict", () => {
  assert.equal(diagnoseImageMaterial({ red: 101, blue: 101 }), "TEXTURED");
  assert.equal(
    diagnoseImageMaterial({ red: 100, blue: 5000 }),
    "SOLID_OR_OTHER",
  );
  assert.equal(imageDescriptor.verdicts, undefined);
  // The texture the page receives is the split the page used to draw.
  const texture = decodePng(
    Buffer.from(
      splitTextureDataUri(IMAGE_RIG.dials.texture).split(",")[1],
      "base64",
    ),
  );
  assert.deepEqual([texture.width, texture.height], [64, 8]);
  assert.deepEqual([...texture.data.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual(
    [...texture.data.slice(32 * 4, 32 * 4 + 4)],
    [0, 0, 255, 255],
  );
});

test("V7 cloud-consume: the cloud pipeline message is admitted, every other error and each counter is not", () => {
  const out = (over = {}) => ({
    plCallsPerFrame: 0,
    cloudCallsPerFrame: 0,
    plQueue: 0,
    cloudQueue: 0,
    movingCalls: 1,
    cyan: 3996,
    cloudish: 0,
    ...over,
  });
  assert.equal(evaluateCloudConsume({ out: out(), errors: [] }).length, 6);
  assert.deepEqual(
    failing(
      evaluateCloudConsume({
        out: out(),
        errors: ["CloudCollection pipeline mismatch"],
      }),
    ),
    [],
  );
  assert.deepEqual(
    failing(evaluateCloudConsume({ out: out(), errors: ["other"] })),
    ["no-non-cloud-errors"],
  );
  assert.deepEqual(
    failing(
      evaluateCloudConsume({ out: out({ plCallsPerFrame: 1 }), errors: [] }),
    ),
    ["polyline-settled"],
  );
  assert.deepEqual(
    failing(evaluateCloudConsume({ out: out({ cloudQueue: 2 }), errors: [] })),
    ["queues-drained"],
  );
  assert.deepEqual(
    failing(evaluateCloudConsume({ out: out({ movingCalls: 0 }), errors: [] })),
    ["moved-polyline-reenqueues"],
  );
  assert.deepEqual(
    failing(evaluateCloudConsume({ out: out({ cyan: 100 }), errors: [] })),
    ["polyline-renders"],
  );
});

test("V8 geodesic: a straight WebGPU line fails the curve clauses, and frames of different sizes FAIL the mismatch clause", () => {
  const arc = { image: FRAME.arc(), subdividedCount: 3 };
  assert.deepEqual(
    failing(evaluateGeodesic(measureGeodesic(arc, { image: FRAME.arc() }))),
    [],
  );
  const flat = measureGeodesic(
    { image: FRAME.arc(0), subdividedCount: 3 },
    { image: FRAME.arc() },
  );
  assert.ok(failing(evaluateGeodesic(flat)).includes("webgpu-curves"));
  assert.ok(failing(evaluateGeodesic(flat)).includes("bow-parity"));
  // A pair that cannot be compared is not a pass. The original's private diff
  // compared the overlapping bytes and could read 0 here.
  const resized = measureGeodesic(arc, { image: FRAME.arc(25, 121) });
  assert.equal(resized.raw.diffPct, null);
  assert.equal(resized.webgpuVsWebglDiffPct, null);
  assert.deepEqual(failing(evaluateGeodesic(resized)), [
    "low-overall-mismatch",
  ]);
});

// ---------------------------------------------------------------------------
// W. The descriptors, walked through the real runtime on a stubbed browser
// ---------------------------------------------------------------------------

const STRIP_MARKER = "leftovers";

/**
 * A page that answers by source: the widget strip (a string), the capture
 * seam's liveness read, the error gate's arm and collect, and every Cesium
 * page function through `answer`. Screenshots come from `frameFor`.
 */
function stubPage(world, options) {
  let renderer = null;
  let scene = null;
  let url = "about:blank";
  const shot = async () => png(world.frameFor({ renderer, scene, options }));
  return {
    on() {},
    off() {},
    async addInitScript() {},
    async goto(target) {
      url = target;
      renderer = new URL(target).searchParams.get("renderer");
      world.log.push(`goto:${renderer}`);
    },
    url: () => url,
    async waitForFunction() {},
    async evaluate(fn, arg) {
      const source = String(fn);
      if (typeof fn === "string" && source.includes(STRIP_MARKER)) {
        world.log.push("strip");
        return { removed: 9, leftovers: world.leftovers ?? [] };
      }
      if (source.includes("__captureLiveness")) {
        return { gateArmed: false, deviceLost: null, frameNumber: null };
      }
      if (source.includes("__armWebGPUDevice")) {
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        return { errors: [], deviceLost: null, armedDevices: 1 };
      }
      if (source.includes("/Build/CesiumUnminified/index.js")) {
        if (!source.includes(".pick(")) scene = arg;
        world.log.push(`scene:${renderer}`);
        return world.answer({ renderer, arg, source });
      }
      throw new Error(`unstubbed page.evaluate: ${source.slice(0, 100)}`);
    },
    locator(selector) {
      world.selectors.push(selector);
      return {
        count: async () => 1,
        nth: () => ({ screenshot: shot }),
        screenshot: shot,
      };
    },
    async close() {},
  };
}

function stubLaunch(world) {
  return async () => {
    world.launches += 1;
    let connected = true;
    const newPage = async (options = {}) => stubPage(world, options);
    return {
      isConnected: () => connected,
      async close() {
        connected = false;
      },
      newPage,
      async newContext(options = {}) {
        return { newPage: () => newPage(options), async close() {} };
      },
    };
  };
}

async function walk(descriptor, world, extraArgv = []) {
  return withLaneTmp("polyline-walk-", async (root) => {
    const out = path.join(root, "out");
    world.log = [];
    world.selectors = [];
    world.launches = 0;
    const code = await runProbe(descriptor, {
      argv: [
        "--repository-root",
        root,
        "--output",
        out,
        "--no-serve-built",
        ...extraArgv,
      ],
      launch: stubLaunch(world),
    });
    const files = fs.existsSync(out) ? fs.readdirSync(out).sort() : [];
    const read = (name) =>
      JSON.parse(fs.readFileSync(path.join(out, name), "utf8"));
    const report = files.includes(`${descriptor.name}-report.json`)
      ? read(`${descriptor.name}-report.json`)
      : null;
    const refusal = files.includes(`${descriptor.name}-refusal.json`)
      ? read(`${descriptor.name}-refusal.json`)
      : null;
    return { code, files, report, refusal, world };
  });
}

/** Per probe: a healthy page answer and frame, and what the walk must show. */
const WALKS = [
  {
    descriptor: primitiveDescriptor,
    answer: ({ arg }) => ({
      renderer: "stub",
      primitiveReady: true,
      arcType: arg.arcType,
    }),
    frameFor: () => FRAME.cyan(),
    pngs: 4,
    verdicts: 8,
  },
  {
    descriptor: materialDescriptor,
    answer: ({ arg }) => ({
      renderer: "stub",
      primitiveReady: true,
      material: arg.material.type,
    }),
    frameFor: ({ scene }) =>
      scene.material.type === "PolylineDash" ? FRAME.dash() : FRAME.cyan(),
    pngs: 4,
    verdicts: 10,
  },
  {
    descriptor: pickDescriptor,
    answer: ({ arg, source }) =>
      source.includes(".pick(")
        ? {
            ready: true,
            pickIds: 1,
            nSamples: arg.samples.length,
            hits: 2,
            pickedPrimitive: arg.samples.length > 0,
            pickedId: true,
          }
        : { ready: true, pickIds: 1 },
    frameFor: () => FRAME.cyan(),
    pngs: 2,
    verdicts: 4,
  },
  {
    descriptor: modesDescriptor,
    answer: ({ arg }) => ({
      mode: arg.cell,
      material: false,
      sceneMode: 3,
      morphTime: 1,
      renderer: "stub",
      ready: true,
    }),
    frameFor: () => FRAME.cyan(),
    pngs: 8,
    verdicts: 8,
  },
  {
    descriptor: logDepthDescriptor,
    answer: () => ({
      renderer: "stub",
      logDepthOn: true,
      colorReady: true,
      glowReady: true,
      colorLogDepth: true,
      glowLogDepth: true,
    }),
    frameFor: () => FRAME.cyanAndMagenta(),
    pngs: 2,
    verdicts: 10,
  },
  {
    descriptor: imageDescriptor,
    answer: () => ({ renderer: "stub", ready: true }),
    frameFor: () => FRAME.split(),
    pngs: 2,
    verdicts: 0,
  },
  {
    descriptor: consumeDescriptor,
    answer: () => ({
      plCallsPerFrame: 0,
      cloudCallsPerFrame: 0,
      plQueue: 0,
      cloudQueue: 0,
      movingCalls: 1,
    }),
    frameFor: () => FRAME.cyan(),
    pngs: 1,
    verdicts: 6,
  },
  {
    descriptor: geodesicDescriptor,
    answer: () => ({ subdividedCount: 3 }),
    frameFor: () => FRAME.arc(),
    pngs: 2,
    verdicts: 8,
  },
  {
    descriptor: multimaterialDescriptor,
    answer: () => ({ renderer: "stub", devicePixelRatio: 1 }),
    frameFor: () => FRAME.multimaterial(),
    pngs: 4,
    verdicts: null,
  },
];

for (const spec of WALKS) {
  const name = spec.descriptor.name;

  test(`W ${name}: a healthy walk reaches its verdicts through the seam and exits 0`, async () => {
    const result = await walk(spec.descriptor, {
      answer: spec.answer,
      frameFor: spec.frameFor,
    });
    assert.equal(
      result.code,
      PROBE_EXIT_CODES.OK,
      JSON.stringify(result.refusal ?? result.files),
    );
    assert.equal(result.world.launches, 1, "one browser, the runtime's");
    const pngs = result.files.filter((file) => file.endsWith(".png"));
    assert.equal(pngs.length, spec.pngs, pngs.join(", "));
    assert.ok(
      result.world.log.includes("strip"),
      "the viewer chrome is stripped before any capture",
    );
    assert.equal(
      result.world.log.indexOf("strip") <
        result.world.log.findIndex((entry) => entry.startsWith("scene:")),
      true,
    );
    assert.ok(
      result.world.selectors.length >= spec.pngs,
      "every frame came through a locator",
    );
    if (spec.verdicts !== null) {
      assert.equal(result.report.verdicts.length, spec.verdicts);
      assert.ok(result.report.verdicts.every((verdict) => verdict.pass));
      assert.ok(
        result.report.captures.length === spec.pngs,
        "every capture is recorded with its digest",
      );
    }
  });

  test(`W ${name}: viewer chrome left over the canvas is a refusal, not a measurement`, async () => {
    const result = await walk(spec.descriptor, {
      answer: spec.answer,
      frameFor: spec.frameFor,
      leftovers: ["cesium-viewer-toolbar"],
    });
    assert.equal(result.code, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(result.report, null, "a refused run writes no receipt");
    assert.equal(result.refusal.refusal.reason, "viewer-chrome-over-canvas");
  });
}

test("W polyline-appearance-primitive: a 0px WebGPU line walks to exit 1, not 0", async () => {
  const result = await walk(primitiveDescriptor, {
    answer: WALKS[0].answer,
    frameFor: ({ renderer }) =>
      renderer === "webgpu" ? blank(64, 48) : FRAME.cyan(),
  });
  assert.equal(result.code, PROBE_EXIT_CODES.FAILURE);
  assert.deepEqual(
    result.report.verdicts
      .filter((verdict) => !verdict.pass)
      .map((verdict) => verdict.id),
    [
      "GEODESIC/webgpu-draws/run0",
      "GEODESIC/parity/run0",
      "NONE/webgpu-draws/run0",
      "NONE/parity/run0",
    ],
  );
});

test("W polyline-geodesic: captures of different sizes walk to exit 1 on the mismatch clause", async () => {
  const result = await walk(geodesicDescriptor, {
    answer: WALKS[7].answer,
    frameFor: ({ renderer }) =>
      renderer === "webgpu" ? FRAME.arc() : FRAME.arc(25, 121),
  });
  assert.equal(result.code, PROBE_EXIT_CODES.FAILURE);
  assert.deepEqual(
    result.report.verdicts
      .filter((verdict) => !verdict.pass)
      .map((verdict) => verdict.id),
    ["low-overall-mismatch/run0"],
  );
});

test("W polyline-appearance-pick: the page is asked to pick at the every-200th cyan pixels of the capture", async () => {
  const asked = [];
  const result = await walk(pickDescriptor, {
    answer: (call) => {
      if (call.source.includes(".pick(")) asked.push(call.arg.samples);
      return WALKS[2].answer(call);
    },
    frameFor: () => FRAME.cyan(),
  });
  assert.equal(result.code, PROBE_EXIT_CODES.OK);
  // 56 cyan pixels a row from x 4, rows 4-19 (896 in all). The n-th match
  // sits in row 4 + floor((n - 1) / 56) at x 3 + (n - 56 * floor((n - 1) / 56)):
  // n = 200 -> (35, 7), 400 -> (11, 11), 600 -> (43, 14), 800 -> (19, 18).
  const expected = [
    [35, 7],
    [11, 11],
    [43, 14],
    [19, 18],
  ];
  assert.deepEqual(asked, [expected, expected]);
});

test("W pair-requiring probes refuse a single renderer before they measure", async () => {
  for (const descriptor of [
    primitiveDescriptor,
    materialDescriptor,
    pickDescriptor,
    modesDescriptor,
    logDepthDescriptor,
    geodesicDescriptor,
  ]) {
    const result = await walk(
      descriptor,
      { answer: () => ({}), frameFor: () => FRAME.cyan() },
      ["--renderer", "webgpu"],
    );
    assert.equal(result.code, PROBE_EXIT_CODES.REFUSAL, descriptor.name);
    assert.equal(
      result.refusal.refusal.reason,
      "renderer-pair-required",
      descriptor.name,
    );
  }
  const consume = await walk(
    consumeDescriptor,
    { answer: () => ({}), frameFor: () => FRAME.cyan() },
    ["--renderer", "webgl"],
  );
  assert.equal(consume.refusal.refusal.reason, "renderer-unavailable");
});
