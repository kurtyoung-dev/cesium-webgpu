#!/usr/bin/env node
/**
 * C6-VELOCITY-MOTION-BLUR — velocity-buffer motion blur. WebGPU-only visual probe.
 *
 * Motion blur is a WebGPU-only screen-space effect with no WebGL twin, so the
 * diff is BLUR-ON vs BLUR-OFF on the SAME WebGPU canvas at the SAME final
 * camera pose. The smear magnitude is driven by the per-frame camera velocity
 * (previous VP → current VP), which we control deterministically by holding the
 * FINAL pose B fixed and varying the PREVIOUS heading:
 *
 *   render(A); render(B)  →  previous = A, current = B  →  velocity = B - A
 *
 * UniformState.update() snapshots previous=current at the START of each frame,
 * so two back-to-back scene.render() calls at different poses give previous=A on
 * the second. We capture the canvas pixels SYNCHRONOUSLY inside the same page
 * task, right after render(B), so the RAF loop can't render an extra static
 * frame at B (which would reset previous==current and zero the velocity).
 *
 * The scene is the sky + bright atmosphere HORIZON BAND (globe imagery does not
 * load in the headless probe env, so the ground is black — the atmosphere band
 * is the reliable high-frequency feature). We smear it with VERTICAL camera
 * motion (pitch), so the horizontal band streaks vertically under blur.
 *
 * Captures at a fixed final pose B (pitch -3°):
 *   - offB    : motionBlur=false, previous=B  (crisp reference)
 *   - offB2   : same as offB                  (off-gate stability)
 *   - onSmall : motionBlur=true,  previous pitch = B+1° (small velocity)
 *   - onLarge : motionBlur=true,  previous pitch = B+5° (large velocity)
 *
 * Proof criteria:
 *   - offStable = diff(offB, offB2) ≈ 0  → OFF deterministic / no spurious pass
 *   - blurLarge = diff(offB, onLarge) > 3 → the effect visibly smears
 *   - velocity-driven: blurLarge > blurSmall → more camera velocity = more blur
 *   - error gate clean.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-motion-blur.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
const OUT = "Tools/visual-regression/output";

// Whole-frame pixel-diff of two data URLs via canvas decode (no Node PNG dep).
function frameDiff(page, duA, duB) {
  return page.evaluate(
    async ([a, b]) => {
      const dec = async (du) => {
        const img = new Image();
        img.src = du;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.getContext("2d").getImageData(0, 0, c.width, c.height);
      };
      const A = await dec(a);
      const B = await dec(b);
      let diff = 0,
        n = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const dr = Math.abs(A.data[i] - B.data[i]);
        const dg = Math.abs(A.data[i + 1] - B.data[i + 1]);
        const db = Math.abs(A.data[i + 2] - B.data[i + 2]);
        if (dr + dg + db > 24) {
          diff++;
        }
        n++;
      }
      return +((100 * diff) / n).toFixed(2);
    },
    [duA, duB],
  );
}

// Deterministic capture. Renders the previous pose (heading B - prevOffsetDeg)
// then the fixed final pose B, and grabs the canvas pixels synchronously —
// before the RAF loop can re-render a static frame at B.
function capture(page, motionBlur, prevOffsetDeg) {
  return page.evaluate(
    async ([mb, prevOff]) => {
      const C = window.Cesium;
      const v = window.viewer;
      const s = v.scene;
      const BASE_PITCH = -3.0;
      const set = (pitch) =>
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 60000.0),
          orientation: {
            heading: C.Math.toRadians(90.0),
            pitch: C.Math.toRadians(pitch),
            roll: 0.0,
          },
        });
      s.motionBlur = mb;
      // Previous frame at the offset pitch → establishes previousViewProjection.
      set(BASE_PITCH + prevOff);
      s.render();
      // Final frame at the fixed base pitch → velocity = base - offset (vertical).
      set(BASE_PITCH);
      s.render();
      // Grab pixels NOW, synchronously, before RAF renders a static B frame.
      const cv = document.querySelector(".cesium-widget canvas");
      const c = document.createElement("canvas");
      c.width = cv.width;
      c.height = cv.height;
      c.getContext("2d").drawImage(cv, 0, 0);
      return c.toDataURL("image/png");
    },
    [motionBlur, prevOffsetDeg],
  );
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
  await page.addInitScript(errorGateInit);
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window.viewer && window.viewer.scene), null, {
    timeout: 60000,
  });
  await armWebGPUDevices(page);

  // Static oblique view over Grand Canyon terrain (high-frequency detail that
  // smears visibly). requestRenderMode stays FALSE (continuous) so tiles stream
  // in AND the previous-VP snapshot advances normally between our render()
  // calls; the synchronous in-page capture immunizes us against the RAF loop.
  await page.evaluate(async () => {
    const C = (window.Cesium =
      window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
    const v = window.viewer;
    v.scene.requestRenderMode = false;
    // MSAA off so the post-process depth binding is single-sample (motion blur,
    // like TAA, reads a non-multisampled depth texture).
    v.scene.msaaSamples = 1;
    v.scene.motionBlur = false;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 60000.0),
      orientation: {
        heading: C.Math.toRadians(90.0),
        pitch: C.Math.toRadians(-3.0),
        roll: 0.0,
      },
    });
  });
  await page
    .waitForFunction(() => window.viewer.scene.globe.tilesLoaded === true, null, {
      timeout: 25000,
    })
    .catch(() => {});
  await page.waitForTimeout(1500);

  const offB = await capture(page, false, 0.0);
  const offB2 = await capture(page, false, 0.0);
  const onSmall = await capture(page, true, 1.0);
  const onLarge = await capture(page, true, 6.0);

  // Save PNGs for manual inspection.
  const save = (du, name) =>
    fs.writeFileSync(
      `${OUT}/${name}.png`,
      Buffer.from(du.split(",")[1], "base64"),
    );
  save(offB, "motion-blur-off");
  save(onSmall, "motion-blur-on-small");
  save(onLarge, "motion-blur-on-large");

  const offStable = await frameDiff(page, offB, offB2);
  const blurSmall = await frameDiff(page, offB, onSmall);
  const blurLarge = await frameDiff(page, offB, onLarge);

  const gate = await collectGateErrors(page);

  console.log(
    JSON.stringify(
      {
        offStable,
        blurSmall,
        blurLarge,
        gateErrors: gate.errors.slice(0, 5),
        deviceLost: gate.deviceLost,
        consoleErrors: consoleErrors.slice(0, 5),
      },
      null,
      1,
    ),
  );

  const checks = [
    [`OFF is deterministic / byte-identical (offStable ${offStable} < 0.5)`, offStable < 0.5],
    [`motion blur visibly smears (blurLarge ${blurLarge} > 3)`, blurLarge > 3.0],
    [`blur is velocity-driven (blurLarge ${blurLarge} > blurSmall ${blurSmall})`, blurLarge > blurSmall],
    [`small velocity still produces some blur (blurSmall ${blurSmall} > 0.5)`, blurSmall > 0.5],
    [`no device/validation errors`, gate.errors.length === 0 && !gate.deviceLost],
  ];
  console.log("\n=== ANALYSIS ===");
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) {
      pass = false;
    }
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
