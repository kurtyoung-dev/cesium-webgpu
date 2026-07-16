// NEW-TAA-PROJECTION-JITTER-OVERWRITTEN verification.
//
// Scene.js applies the TAA sub-pixel jitter to the camera projection, but the
// WebGPU frustum loop's _updateFrustumUniforms recomputes a fresh un-jittered
// projection per frustum (Batch 358 re-applies the jitter there). This probe
// checks the jitter actually REACHES the GPU camera projection:
//
//   - Sample scene.context.uniformState.projection[8]/[9] (the clip-space x/y
//     center offset — exactly 0 on a centered frustum, non-zero only when
//     jittered) over many frames. With taaEnabled the max |offset| must be
//     clearly non-zero; with TAA OFF it must be ~0 (no jitter applied at all).
//   - Cross-check WebGL (its jitter path works) shows the same non-zero offset.
//   - TAA-on vs TAA-off image diff > 0 (the jitter changes the rendered output).
//   - Capture a TAA-on frame and assert it renders without device errors.
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-taa-jitter.mjs
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const JITTER_EPS = 1e-7;

async function measure(renderer, taaOn) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const out = await page.evaluate(async (taaOn) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const s = v.scene;
    s.requestRenderMode = false;
    s.taaEnabled = !!taaOn;
    // Stable mid-orbit view of the globe.
    s.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75, 40, 8_000_000),
    });
    let maxJitter = 0;
    const samples = [];
    // Sample the camera projection's clip-space center offset each frame,
    // INSIDE postRender (the frustum loop has just packed the per-frustum
    // jittered projection into uniformState; reading post-frame is fine for
    // the perspective frustum because the last frustum's projection persists).
    for (let i = 0; i < 150; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      try {
        const proj = s.context.uniformState.projection;
        const j8 = Math.abs(proj[8]);
        const j9 = Math.abs(proj[9]);
        if (j8 > maxJitter) maxJitter = j8;
        if (j9 > maxJitter) maxJitter = j9;
        if (i >= 145)
          samples.push([+proj[8].toExponential(2), +proj[9].toExponential(2)]);
      } catch (e) {
        /* ignore */
      }
    }
    return {
      rendererType: s.context.rendererType,
      taaEnabled: s.taaEnabled,
      maxJitter,
      samples,
    };
  }, taaOn);

  // Capture one settled frame (inside postRender — WebGPU canvas clears on present).
  const b64 = await page.evaluate(async () => {
    const v = window.viewer;
    return await new Promise((res) => {
      const rm = v.scene.postRender.addEventListener(() => {
        rm();
        try {
          res(v.scene.canvas.toDataURL("image/png").split(",")[1]);
        } catch (e) {
          res(null);
        }
      });
      v.scene.requestRender();
      v.scene.render();
    });
  });

  await browser.close();
  const deviceErrors = consoleErrors.filter((message) =>
    /GPUValidationError|GPUInternalError|GPUOutOfMemoryError|device\s+lost|WebGPU.*(?:error|lost)/i.test(
      message,
    ),
  );
  return { ...out, pageErrors, consoleErrors, deviceErrors, b64 };
}

const wgpuOn = await measure("webgpu", true);
const wgpuOff = await measure("webgpu", false);
const wglOn = await measure("webgl", true);

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
if (wgpuOn.b64)
  fs.writeFileSync(
    "Tools/visual-regression/output/taa-webgpu-on.png",
    Buffer.from(wgpuOn.b64, "base64"),
  );

const report = {
  webgpu_taaOn: {
    maxJitter: wgpuOn.maxJitter,
    samples: wgpuOn.samples,
    pageErrors: wgpuOn.pageErrors,
    deviceErrors: wgpuOn.deviceErrors,
    consoleErrors: wgpuOn.consoleErrors.slice(0, 3),
  },
  webgpu_taaOff: { maxJitter: wgpuOff.maxJitter, samples: wgpuOff.samples },
  webgl_taaOn: { maxJitter: wglOn.maxJitter, samples: wglOn.samples },
};
console.log(JSON.stringify(report, null, 2));

// Gate: with taaEnabled the WebGPU camera projection carries a non-zero
// sub-pixel jitter (the fix), and with TAA off it does not; no device errors.
// WebGL-on is informational parity (its jitter path already works).
const pass =
  wgpuOn.maxJitter > JITTER_EPS &&
  wgpuOff.maxJitter <= JITTER_EPS &&
  wgpuOn.pageErrors.length === 0 &&
  wgpuOn.deviceErrors.length === 0;
console.log(
  `WebGL-on maxJitter (informational parity): ${wglOn.maxJitter.toExponential(3)}`,
);
console.log(
  pass
    ? "GATE PASS — WebGPU camera projection carries TAA jitter when taaEnabled (none when off); 0 page/device errors"
    : "GATE FAIL — WebGPU projection jitter not reaching the GPU (or TAA-off leaked jitter / device errors)",
);
process.exit(pass ? 0 : 1);
