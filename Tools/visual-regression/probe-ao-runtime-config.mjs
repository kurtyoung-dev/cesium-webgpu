#!/usr/bin/env node
// Probe: does an ambient-occlusion uniform written AFTER the first enabled
// frame change what is on screen?
// @purpose Captures a canvas pair per backend — AO enabled at the AEC demo's settings, then the same uniforms rewritten at runtime — so the runtime-config propagation is judged on pixels rather than on state.
// @status ACTIVE
//
// WebGL reads a `PostProcessStage`'s uniforms through its uniform map on every
// draw, so the second write has always been live there. On WebGPU the effect's
// configuration was baked into uniform buffers at first enable and no later
// write reached the shader, so the pair was byte-identical while WebGL's pair
// differed. WebGL is therefore the control: it says the chosen uniform delta is
// visible at all, which is what makes a WebGPU zero meaningful.
//
// Pass criterion, encoded below as WEBGL_MIN_MISMATCH_PCT and
// WEBGPU_MIN_FRACTION_OF_WEBGL, and enforced by the exit code:
//   - WebGL before/after mismatch is well above the noise floor. If it is not,
//     the uniform delta below is too weak and the WebGPU leg proves nothing.
//   - WebGPU before/after mismatch is of the same order as WebGL's. Before the
//     propagation landed it was ~0.
//
// Usage: node Tools/visual-regression/probe-ao-runtime-config.mjs
//   The dev server must already be serving a BUILT tree on :8080.
// Exit code: 0 when both criteria hold, 1 otherwise. A WebGL leg under its
//   floor is a probe defect (too weak a delta, or a camera that reads no AO),
//   not a refutation of the propagation.
// Outputs: output/probe-ao-runtime-config-{webgl,webgpu}-{before,after}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Grand Canyon, low and oblique: deep terrain relief in frame, which is what
// ambient occlusion has anything to say about. A default orbital camera reads
// almost no AO at any settings and would pass this probe vacuously.
const VIEW = "view=-112.1129%2C36.0544%2C8000";

// The AEC design-model demo's ambient-occlusion settings, which is the
// configuration this row's cost discussion is about.
const FIRST_ENABLE = {
  intensity: 2.0,
  bias: 0.1,
  lengthCap: 0.5,
  directionCount: 16,
  stepCount: 32,
};

// A deliberately loud second write. The point is a visible difference, not a
// tasteful one: a subtle delta cannot distinguish "propagated" from "noise".
const RUNTIME_WRITE = {
  intensity: 8.0,
  bias: 0.0,
  lengthCap: 4.0,
  directionCount: 4,
  stepCount: 4,
};

// The WebGL control's floor, in percent of pixels differing by more than the
// per-pixel threshold in diffPngs. Both captures are of the same frozen scene
// at the same camera with the clock stopped, so a pair that changed nothing
// diffs at ~0%; half a percent is already far above that. A WebGL leg under
// this floor means the RUNTIME_WRITE delta is not visible in this frame at
// all, which makes the WebGPU number unreadable either way.
const WEBGL_MIN_MISMATCH_PCT = 0.5;

// How much of the control's mismatch the WebGPU leg must reach. The two
// backends do not compute identical occlusion, so an equal number is not
// expected; what is being separated here is "the write reached the shader"
// from the unfixed symptom, where WebGPU's pair was byte-identical at ~0%.
// A quarter of the control clears that gap by a wide margin in both
// directions.
const WEBGPU_MIN_FRACTION_OF_WEBGL = 0.25;

/**
 * Renders a fixed number of frames so tiles, imagery and the effect chain
 * settle before a capture.
 *
 * @param {import("playwright").Page} page The page.
 * @param {number} frames Frames to render.
 */
async function settle(page, frames) {
  await page.evaluate(async (count) => {
    const viewer = window.viewer;
    for (let i = 0; i < count; i++) {
      viewer.scene.render();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, frames);
}

/**
 * Loads one backend, enables AO, captures the canvas, rewrites the same
 * uniforms at runtime, and captures the canvas again.
 *
 * @param {string} renderer "webgl" or "webgpu".
 * @returns {Promise<object>} The two capture paths and any console errors.
 */
async function capturePair(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&${VIEW}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);
  // Freeze the clock so the sun does not move between the two captures; a
  // lighting drift would land in the diff and be read as propagation.
  await page.evaluate(() => {
    window.viewer.clock.shouldAnimate = false;
  });
  await settle(page, 240);

  const applied = await page.evaluate((uniforms) => {
    const ao = window.viewer.scene.postProcessStages.ambientOcclusion;
    ao.enabled = true;
    Object.assign(ao.uniforms, uniforms);
    return { enabled: ao.enabled };
  }, FIRST_ENABLE);
  await settle(page, 120);
  await page.waitForTimeout(1000);

  const canvas = page.locator("canvas").first();
  const before = path.join(
    OUT_DIR,
    `probe-ao-runtime-config-${renderer}-before.png`,
  );
  await canvas.screenshot({ path: before });

  // The write this probe exists for: the same uniforms, rewritten well after
  // the first enabled frame.
  await page.evaluate((uniforms) => {
    Object.assign(
      window.viewer.scene.postProcessStages.ambientOcclusion.uniforms,
      uniforms,
    );
  }, RUNTIME_WRITE);
  await settle(page, 120);
  await page.waitForTimeout(1000);

  const after = path.join(
    OUT_DIR,
    `probe-ao-runtime-config-${renderer}-after.png`,
  );
  await canvas.screenshot({ path: after });
  await browser.close();

  return {
    before,
    after,
    applied,
    errors: messages.filter((m) => m.t === "error" || m.t === "pageerror"),
  };
}

/**
 * Pixel-diffs two PNGs through a browser canvas decode, so no Node-side PNG
 * dependency is needed. Mirrors `probe-saved-view.mjs`.
 *
 * @param {string} a First PNG path.
 * @param {string} b Second PNG path.
 * @returns {Promise<object>} Mismatch counts.
 */
async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return {
          w: canvas.width,
          h: canvas.height,
          data: context.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      };
      const first = await decode(ba);
      const second = await decode(bb);
      if (first.w !== second.w || first.h !== second.h) {
        return { error: "size mismatch" };
      }
      const total = first.w * first.h;
      let mismatch = 0;
      let sum = 0;
      for (let i = 0; i < first.data.length; i += 4) {
        const d =
          Math.abs(first.data[i] - second.data[i]) +
          Math.abs(first.data[i + 1] - second.data[i + 1]) +
          Math.abs(first.data[i + 2] - second.data[i + 2]);
        sum += d;
        if (d > 30) mismatch++;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: Number(((100 * mismatch) / total).toFixed(3)),
        meanDelta: Number((sum / total).toFixed(3)),
      };
    },
    {
      ba: fs.readFileSync(a).toString("base64"),
      bb: fs.readFileSync(b).toString("base64"),
    },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  const report = {};
  for (const renderer of ["webgl", "webgpu"]) {
    console.log(`[probe-ao-runtime-config] ${renderer}`);
    const pair = await capturePair(renderer);
    console.log(`  before: ${pair.before}`);
    console.log(`  after:  ${pair.after}`);
    if (pair.errors.length) {
      console.log(`  ${pair.errors.length} console errors:`);
      pair.errors
        .slice(0, 3)
        .forEach((e) => console.log(`    ${e.t}: ${e.text}`));
    }
    report[renderer] = await diffPngs(pair.before, pair.after);
    console.log(`  before-vs-after: ${JSON.stringify(report[renderer])}`);
  }
  const webgl = report.webgl?.mismatchPct ?? 0;
  const webgpu = report.webgpu?.mismatchPct ?? 0;
  console.log(
    `[probe-ao-runtime-config] WebGL ${webgl}% vs WebGPU ${webgpu}% — ` +
      `WebGL is the control that the uniform delta is visible; a WebGPU value ` +
      `near zero beside a live WebGL value is the unfixed symptom.`,
  );

  const failures = [];
  if (report.webgl?.error || report.webgpu?.error) {
    failures.push(
      `a diff failed: webgl=${report.webgl?.error ?? "ok"}, ` +
        `webgpu=${report.webgpu?.error ?? "ok"}`,
    );
  }
  if (webgl < WEBGL_MIN_MISMATCH_PCT) {
    failures.push(
      `control too weak: WebGL before/after is ${webgl}%, under the ` +
        `${WEBGL_MIN_MISMATCH_PCT}% floor — the uniform delta is not visible ` +
        `in this frame, so the WebGPU leg proves nothing (probe defect)`,
    );
  }
  const webgpuFloor = Number((webgl * WEBGPU_MIN_FRACTION_OF_WEBGL).toFixed(3));
  if (webgpu < webgpuFloor) {
    failures.push(
      `WebGPU before/after is ${webgpu}%, under ${webgpuFloor}% ` +
        `(${WEBGPU_MIN_FRACTION_OF_WEBGL} of the control) — the runtime ` +
        `uniform write is not reaching the shader`,
    );
  }
  if (failures.length) {
    failures.forEach((reason) =>
      console.error(`[probe-ao-runtime-config] FAIL: ${reason}`),
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[probe-ao-runtime-config] PASS: control ${webgl}% >= ` +
      `${WEBGL_MIN_MISMATCH_PCT}%, WebGPU ${webgpu}% >= ${webgpuFloor}%.`,
  );
})();
