#!/usr/bin/env node
// Probe: does an ambient-occlusion uniform written AFTER the first enabled
// frame change what is on screen?
// @purpose Captures four canvases per backend — AO enabled, the numeric uniforms rewritten, the camera moved, then ambientOcclusionOnly rewritten — so runtime-config propagation is judged on pixels, with a control that says the capture observes canvas changes at all.
// @status ACTIVE
//
// WebGL reads a `PostProcessStage`'s uniforms through its uniform map on every
// draw, so a second write has always been live there. On WebGPU the effect's
// configuration is baked into uniform buffers, and before the propagation
// landed no later write reached the shader at all.
//
// ── WHY THIS PROBE HAS FOUR CAPTURES, NOT TWO ───────────────────────────────
//
// The two-capture form asked one question — does rewriting intensity, bias,
// lengthCap, directionCount and stepCount move pixels? — and that question is
// not answerable on its own, for two reasons found by reading its own output.
//
// First, the numeric uniforms only move pixels where the occlusion term is
// free to change. `AmbientOcclusionGenerate.wgsl` weights every sample by
// `1.0 - clamp(dist / lengthCap, 0.0, 1.0)`, with `dist` an eye-space distance
// in metres, while the same `lengthCap` sets the march step in pixels; when a
// one-pixel step spans more metres than `lengthCap`, every weight is zero, the
// occlusion term saturates at exactly 1.0 and the modulate pass multiplies the
// scene by one. Two configurations that both saturate produce byte-identical
// frames however faithfully the uniforms propagated. A zero on that leg
// therefore cannot, by itself, tell a dropped write apart from a view in which
// no configuration would change anything.
//
// Second, nothing in the two-capture form established that a capture on a
// given backend reflects a canvas change at all. A stale-capture path would
// produce the same zero.
//
// So the gate is now carried by two clauses that are free of both problems, on
// BOTH backends:
//
//   CAPTURE LIVENESS — the camera moves between two captures taken with
//   identical post-process settings. A backend whose captures cannot show a
//   moved camera cannot show anything, and every later clause on it is void.
//
//   AO RUNTIME REACH — `ambientOcclusionOnly` is written after the first
//   enabled frame. Both backends' modulate shaders return the occlusion term
//   in place of the scene when it is set (`AmbientOcclusionModulate.wgsl`
//   returns `vec3(ao)`; `AmbientOcclusionModulate.glsl` returns `ao`), so the
//   frame changes wherever there is depth — at any view scale, in any
//   lighting, and even where the occlusion term is saturated at 1.0. This is
//   the clause that answers the question the probe exists for.
//
// ── CAPTURE ORDER, AND WHY IT IS THIS ORDER ─────────────────────────────────
//
//   before  — AO enabled with the first configuration
//   numeric — the five generation uniforms rewritten, camera unchanged
//   moved   — camera retreated, post-process settings unchanged
//   aoonly  — `ambientOcclusionOnly` written, at the retreated camera
//
// Liveness is `numeric` → `moved` and runtime reach is `moved` → `aoonly`, so
// each clause's pair differs in exactly one thing: the camera for liveness,
// the flag for runtime reach.
//
// Taking the liveness pair BEFORE the flag is written is load-bearing, not
// stylistic. With `ambientOcclusionOnly` set, the modulate pass returns the
// occlusion term in place of the scene — and wherever that term is saturated
// at 1.0 the whole canvas is a constant white. Two such frames diff at ~0%
// however live the capture is, so a liveness clause measured on them would
// report a working backend as dead and void the very clause it exists to
// protect. Moving the camera before the flag is written also needs no camera
// restore, so no restore imprecision lands in a scored diff.
//
// The numeric leg is still captured and still scored, but it is now scored the
// way this file's own text always said it should be: WebGL is the control that
// the chosen delta is visible at all, and when that control is under its floor
// the WebGPU numeric clause is reported UNREADABLE instead of scored. The
// previous form scored it anyway, in the same run in which it had just
// declared the control void.
//
// The clock is pinned to a fixed daylight instant rather than left at whatever
// the page loaded with. The camera is over the Grand Canyon; a page loaded at
// night renders near-black terrain, which is what drove the control leg to
// 0.102% and made it a probe defect rather than a measurement. Pinning the
// clock removes the advancing simulation time that a request-render scene uses
// to decide it owes a frame, so request-render mode is turned off in the same
// step — a uniform write does not request a frame by itself, and without that
// the capture after a write would be the frame from before it.
//
// ── EXIT CODE ───────────────────────────────────────────────────────────────
//
// The exit code is 0 only when every readable clause holds, and at this view
// the WebGPU numeric clause is expected to read 0%. The fork's HBAO shader
// consumes `lengthCap` as a pixel march radius and as an eye-space metres
// falloff at the same time, so once a march step is a pixel or more, every
// sample lands outside the falloff wherever one pixel spans more metres than
// `lengthCap` — and the second configuration written below steps exactly one
// pixel, which is over ten metres at this camera. EXIT 1 is therefore the
// expected result on today's engine, and it is not a statement about runtime
// propagation: read that off the AO RUNTIME REACH row of the VERDICT block,
// which is printed on every run, pass or fail. The numeric clause is left
// blocking on purpose — it is a measured red against a real defect, and
// silencing it would hide a parity gap rather than fix it. That gap is filed
// in the deferred-work ledger, which is where its status lives.
//
// Usage: node Tools/visual-regression/probe-ao-runtime-config.mjs
//   The dev server must already be serving a BUILT tree on :8080. Clear
//   `output/probe-ao-runtime-config-*.png` first: the capture names have
//   changed since the last bank, and a stale file is not overwritten.
// Exit code: 0 when every scored clause holds, 1 otherwise — see EXIT CODE.
// Outputs: output/probe-ao-runtime-config-{webgl,webgpu}-{before,numeric,moved,aoonly}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Grand Canyon, low and oblique: deep terrain relief in frame, which is what
// ambient occlusion has anything to say about. A default orbital camera reads
// almost no AO at any settings and would pass this probe vacuously.
const VIEW = "view=-112.1129%2C36.0544%2C8000";

// A fixed daylight instant near local solar noon at this longitude
// (-112.11° ⇒ solar noon ≈ 19:28 UTC), at the solstice for a high sun. Pinning
// it does two things the wall clock did not: the terrain is lit, so the
// occlusion term has something to modulate, and all four captures on both
// backends share one lighting state, so nothing of the sun's motion lands in a
// diff and is read as propagation.
const CLOCK_UTC = "2026-06-21T19:30:00Z";

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

// The third write, and the one the gate rests on. It travels to a different
// uniform buffer than the five above — `AO-Modulate-UB`, not `AO-Generate-UB` —
// and its effect on the frame does not depend on how much occlusion the
// generation pass computed.
const AO_ONLY_WRITE = { ambientOcclusionOnly: true };

// Metres the camera retreats for the liveness capture. Large enough that the
// terrain rescales across the whole canvas, so a backend that renders and
// captures normally cannot land under the floor below.
const LIVENESS_MOVE_METERS = 4000;

// Floor for the two clauses that are scored on both backends, in percent of
// pixels differing by more than the per-pixel threshold in diffPngs. Both are
// whole-frame events: retreating 4 km rescales the terrain, and
// ambientOcclusionOnly replaces the scene with the occlusion term everywhere
// there is depth. The terrain fills well over half of the 1280×720 canvas —
// the timeline, animation widget and credit bar are composited over on the
// order of 60,000-70,000 px (about 7% of the canvas; the navigation-help
// panel is collapsed by default and does not count) and never change — so
// both are expected at or above 50%. The floor sits far below that on
// purpose: it is placed to separate a whole-frame event from the ~0.1% the
// numeric leg produced, not to
// pin the exact figure. A result between this floor and 50% is a real signal
// to read, not a pass to wave through.
const WHOLE_FRAME_MIN_MISMATCH_PCT = 15.0;

// The WebGL numeric control's floor. Both captures are of the same scene at
// the same camera with the clock pinned, so a pair that changed nothing diffs
// at ~0%. A WebGL leg under this floor means the RUNTIME_WRITE delta is not
// visible in this frame at all, which makes the WebGPU numeric number
// unreadable — so it is then reported unscored rather than counted.
const WEBGL_MIN_MISMATCH_PCT = 0.5;

// How much of the control's mismatch the WebGPU numeric leg must reach, when
// the control is readable. The two backends do not compute identical
// occlusion, so an equal number is not expected.
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
 * Loads one backend and captures the four frames the clauses compare.
 *
 * @param {string} renderer "webgl" or "webgpu".
 * @returns {Promise<object>} The capture paths and any console errors.
 */
async function captureFrames(renderer) {
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
  // Stop the clock and pin it to the fixed daylight instant, so the sun sits in
  // one place for every capture on both backends. Request-render mode goes off
  // in the same step and for the same reason the clock is pinned: a scene in
  // that mode renders only when something asks it to, a pinned clock removes
  // the simulation-time change that would otherwise ask, and assigning a
  // post-process uniform does not ask — so every capture after a write would
  // otherwise be the frame from before it. The viewer app turns the mode ON by
  // default (`Apps/CesiumViewer/CesiumViewerStartupOptions.js`).
  await page.evaluate(async (clockUTC) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const viewer = window.viewer;
    viewer.scene.requestRenderMode = false;
    viewer.clock.shouldAnimate = false;
    viewer.clock.currentTime = C.JulianDate.fromIso8601(clockUTC);
  }, CLOCK_UTC);
  await settle(page, 240);

  const canvas = page.locator("canvas").first();
  const shot = async (name) => {
    const file = path.join(
      OUT_DIR,
      `probe-ao-runtime-config-${renderer}-${name}.png`,
    );
    await canvas.screenshot({ path: file });
    return file;
  };
  const applyAndSettle = async (uniforms) => {
    await page.evaluate((values) => {
      Object.assign(
        window.viewer.scene.postProcessStages.ambientOcclusion.uniforms,
        values,
      );
    }, uniforms);
    await settle(page, 120);
    await page.waitForTimeout(1000);
  };

  const applied = await page.evaluate((uniforms) => {
    const ao = window.viewer.scene.postProcessStages.ambientOcclusion;
    ao.enabled = true;
    Object.assign(ao.uniforms, uniforms);
    return { enabled: ao.enabled };
  }, FIRST_ENABLE);
  await settle(page, 120);
  await page.waitForTimeout(1000);
  const before = await shot("before");

  // The numeric write: the five generation parameters, rewritten well after
  // the first enabled frame.
  await applyAndSettle(RUNTIME_WRITE);
  const numeric = await shot("numeric");

  // Liveness: same post-process settings, different camera. Taken BEFORE the
  // ambientOcclusionOnly write, so neither frame of the pair can be the
  // constant canvas that a saturated occlusion term paints under that flag,
  // and after `numeric`, so no camera restore is needed.
  await page.evaluate((meters) => {
    window.viewer.camera.moveBackward(meters);
  }, LIVENESS_MOVE_METERS);
  await settle(page, 120);
  await page.waitForTimeout(1000);
  const moved = await shot("moved");

  // The write the gate rests on, applied alone and at the camera `moved` was
  // taken from, so the diff against it attributes the change to the flag and
  // to nothing else.
  await applyAndSettle(AO_ONLY_WRITE);
  const aoOnly = await shot("aoonly");

  await browser.close();

  return {
    before,
    numeric,
    aoOnly,
    moved,
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

const RENDERERS = ["webgl", "webgpu"];
const CLAUSES = ["numeric", "liveness", "aoOnly"];
const CAPTURES = ["before", "numeric", "moved", "aoOnly"];

// What each clause compares. Every pair differs in exactly one thing: the
// configuration for `numeric`, the camera for `liveness`, the
// ambientOcclusionOnly flag for `aoOnly`.
const CLAUSE_PAIRS = {
  numeric: ["before", "numeric"],
  liveness: ["numeric", "moved"],
  aoOnly: ["moved", "aoOnly"],
};

(async () => {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  const report = {};
  for (const renderer of RENDERERS) {
    console.log(`[probe-ao-runtime-config] ${renderer}`);
    const frames = await captureFrames(renderer);
    for (const name of CAPTURES) {
      console.log(`  ${name}: ${frames[name]}`);
    }
    if (frames.errors.length) {
      console.log(`  ${frames.errors.length} console errors:`);
      frames.errors
        .slice(0, 3)
        .forEach((e) => console.log(`    ${e.t}: ${e.text}`));
    }
    report[renderer] = {};
    for (const clause of CLAUSES) {
      const [first, second] = CLAUSE_PAIRS[clause];
      report[renderer][clause] = await diffPngs(frames[first], frames[second]);
    }
    for (const clause of CLAUSES) {
      console.log(`  ${clause}: ${JSON.stringify(report[renderer][clause])}`);
    }
  }

  const failures = [];
  const status = {};
  for (const renderer of RENDERERS) {
    status[renderer] = {};
  }
  const pct = (renderer, clause) =>
    report[renderer]?.[clause]?.mismatchPct ?? 0;
  for (const renderer of RENDERERS) {
    for (const clause of CLAUSES) {
      const error = report[renderer]?.[clause]?.error;
      if (error) {
        failures.push(`${renderer} ${clause} diff failed: ${error}`);
      }
    }
  }

  // CAPTURE LIVENESS — scored on both backends, and read first: every later
  // clause on a backend is void without it.
  const livenessDead = [];
  for (const renderer of RENDERERS) {
    const value = pct(renderer, "liveness");
    if (value < WHOLE_FRAME_MIN_MISMATCH_PCT) {
      livenessDead.push(renderer);
      status[renderer].liveness = "FAIL";
      failures.push(
        `${renderer} capture liveness is ${value}%, under the ` +
          `${WHOLE_FRAME_MIN_MISMATCH_PCT}% floor — a ${LIVENESS_MOVE_METERS} m ` +
          `camera move did not change the captured canvas, so nothing else ` +
          `measured on this backend is readable`,
      );
    } else {
      status[renderer].liveness = "PASS";
    }
  }

  // AO RUNTIME REACH — the clause this probe exists for, scored on both
  // backends wherever the capture is live.
  for (const renderer of RENDERERS) {
    if (livenessDead.includes(renderer)) {
      status[renderer].aoOnly = "UNREADABLE";
      continue;
    }
    const value = pct(renderer, "aoOnly");
    if (value < WHOLE_FRAME_MIN_MISMATCH_PCT) {
      status[renderer].aoOnly = "FAIL";
      failures.push(
        `${renderer} ambientOcclusionOnly written after the first enabled ` +
          `frame moved ${value}%, under the ${WHOLE_FRAME_MIN_MISMATCH_PCT}% ` +
          `floor — the modulate pass returns the occlusion term in place of ` +
          `the scene when it is set, so a frame with depth in it must change; ` +
          `the runtime write is not reaching the pass, or the pass is not ` +
          `reaching the canvas`,
      );
    } else {
      status[renderer].aoOnly = "PASS";
    }
  }

  // NUMERIC LEG — WebGL is the control that the chosen delta is visible at
  // all. When it is under its floor, or when a backend's capture is not live,
  // the number is reported UNREADABLE and not scored, because a saturated
  // occlusion term produces the same zero as a dropped write.
  const webglNumeric = pct("webgl", "numeric");
  const webgpuNumeric = pct("webgpu", "numeric");
  if (livenessDead.includes("webgl")) {
    status.webgl.numeric = "UNREADABLE";
    status.webgpu.numeric = "UNREADABLE";
  } else if (webglNumeric < WEBGL_MIN_MISMATCH_PCT) {
    status.webgl.numeric = "FAIL";
    status.webgpu.numeric = "UNREADABLE";
    failures.push(
      `numeric control too weak: WebGL before/after is ${webglNumeric}%, ` +
        `under the ${WEBGL_MIN_MISMATCH_PCT}% floor — the uniform delta is ` +
        `not visible in this frame (probe defect, not a WebGPU result)`,
    );
  } else {
    status.webgl.numeric = "PASS";
    if (livenessDead.includes("webgpu")) {
      status.webgpu.numeric = "UNREADABLE";
    } else {
      const webgpuFloor = Number(
        (webglNumeric * WEBGPU_MIN_FRACTION_OF_WEBGL).toFixed(3),
      );
      if (webgpuNumeric < webgpuFloor) {
        status.webgpu.numeric = "FAIL";
        // Which of the two candidate causes this is, settled from this run's
        // own measurement rather than assumed: a write that demonstrably
        // reaches the canvas cannot also be a dropped write.
        const cause =
          status.webgpu.aoOnly === "PASS"
            ? `a runtime write does reach the pass on this backend (AO ` +
              `runtime reach ${pct("webgpu", "aoOnly")}%), so this zero is ` +
              `the occlusion term saturating at this view scale — the HBAO ` +
              `shader marches in pixels and falls off in metres off one ` +
              `lengthCap — and not a propagation failure`
            : `either the generation uniforms are not reaching the shader, ` +
              `or the occlusion term is saturated at this view scale and no ` +
              `configuration would change the frame`;
        failures.push(
          `WebGPU numeric before/after is ${webgpuNumeric}%, under ` +
            `${webgpuFloor}% (${WEBGPU_MIN_FRACTION_OF_WEBGL} of the ` +
            `control) — ${cause}`,
        );
      } else {
        status.webgpu.numeric = "PASS";
      }
    }
  }

  // VERDICT — printed on every run, pass or fail. The exit code alone cannot
  // say which clause moved, and the numeric row is expected to be red on
  // today's engine, so the runtime-propagation question is answered by the AO
  // RUNTIME REACH row and by nothing else here.
  const row = (label, clause) =>
    `  ${label.padEnd(17)} webgl ${status.webgl[clause]} ` +
    `${pct("webgl", clause)}% / webgpu ${status.webgpu[clause]} ` +
    `${pct("webgpu", clause)}%`;
  console.log(`[probe-ao-runtime-config] VERDICT`);
  console.log(row("capture liveness", "liveness"));
  console.log(row("AO runtime reach", "aoOnly"));
  console.log(row("numeric response", "numeric"));
  console.log(
    `  a runtime ambientOcclusionOnly write reaches the canvas: webgl ` +
      `${status.webgl.aoOnly}, webgpu ${status.webgpu.aoOnly} — that is the ` +
      `runtime-propagation result; the numeric row is a separate parity gap`,
  );

  if (failures.length) {
    failures.forEach((reason) =>
      console.error(`[probe-ao-runtime-config] FAIL: ${reason}`),
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[probe-ao-runtime-config] PASS: both backends' captures are live and ` +
      `both take a runtime ambientOcclusionOnly write to the canvas.`,
  );
})();
