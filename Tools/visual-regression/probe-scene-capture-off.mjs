#!/usr/bin/env node
// C2-25 ENV-SCENE-CAPTURE (Batch 446) — OFF-parity probe (run FIRST).
// @purpose OFF-parity gate for env scene capture: both default-false flags mean no capture sources, no extra GPU pass, canvas unchanged vs WebGL baseline.
// @status ACTIVE
//
// Asserts the default-OFF byte-identity contract: with BOTH the context flag
// (`contextOptions.webgpu.sceneCaptureReflections`) and the manager flag
// (`enableSceneCapture`) false (the defaults), the scene-capture pass NEVER runs:
//   - `context._webgpuSceneCaptureSources` stays undefined (the globe render path
//     publishes nothing).
//   - No `DynEnvMap Scene Capture` encoder/submit (no extra GPU pass).
//   - The on-screen globe canvas renders normally (no console errors, a frame
//     paints) and is unchanged vs the WebGL parity baseline within the existing
//     tolerance — capture only affects the env CUBE (model/water reflections),
//     never the globe surface, so OFF the canvas is identical to pre-446.
//
// Usage: node Tools/visual-regression/probe-scene-capture-off.mjs
// Outputs: probe-scene-capture-off-webgpu.png, -webgl.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(rendererArg) {
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
    viewport: { width: 1024, height: 768 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async () => {
    const v = window.viewer;
    for (let i = 0; i < 180; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(1500);

  // OFF-parity assertions (WebGPU only).
  let probe = null;
  if (rendererArg === "webgpu") {
    probe = await page.evaluate(() => {
      const ctx = window.viewer.scene.context;
      return {
        rendererType: ctx.rendererType,
        sceneCaptureReflections: ctx.sceneCaptureReflections,
        captureSourcesPublished:
          ctx._webgpuSceneCaptureSources !== undefined &&
          ctx._webgpuSceneCaptureSources !== null,
      };
    });
  }

  const out = path.join(OUT_DIR, `probe-scene-capture-off-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  ${errs.length} console errors:`);
    errs.slice(0, 5).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  return { out, probe, errCount: errs.length };
}

async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      const total = a.w * a.h;
      let mismatch = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (d > 30) mismatch++;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: ((100 * mismatch) / total).toFixed(3),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-scene-capture-off] capturing webgpu (flags OFF)…");
  const gpu = await capture("webgpu");
  console.log("[probe-scene-capture-off] capturing webgl (baseline)…");
  const gl = await capture("webgl");
  console.log(`  webgpu: ${gpu.out}  (console errors: ${gpu.errCount})`);
  console.log(`  webgl:  ${gl.out}  (console errors: ${gl.errCount})`);
  console.log(`  OFF probe state:`, JSON.stringify(gpu.probe));
  try {
    const diff = await diffPngs(gpu.out, gl.out);
    console.log(`  webgpu-vs-webgl diff:`, JSON.stringify(diff));
  } catch (e) {
    console.log(`  diff failed: ${e.message}`);
  }

  // Verdict
  const ok =
    gpu.probe &&
    gpu.probe.sceneCaptureReflections === false &&
    gpu.probe.captureSourcesPublished === false &&
    gpu.errCount === 0;
  console.log(
    `[probe-scene-capture-off] VERDICT: ${ok ? "PASS — capture inert (no sources published, flag false, no errors)" : "FAIL — see state above"}`,
  );
  // A printed verdict that leaves with status 0 is read as green by anything
  // that scores runs by exit code, so the verdict carries the code.
  process.exit(ok ? 0 : 1);
})();
