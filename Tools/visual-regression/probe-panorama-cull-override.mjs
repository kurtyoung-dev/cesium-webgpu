#!/usr/bin/env node
// Probe: EquirectangularPanorama cull-override (#13369).
//
// An EquirectangularPanorama builds a closed sphere (closed: true) but
// explicitly sets `renderState.cull.enabled: false` so the viewer, placed
// INSIDE the sphere, sees the inner faces. Before the fix the WebGPU
// pipeline derived cullMode solely from `appearance.closed` → "back", so
// the interior was back-face culled and the panorama rendered blank.
// WebGL honors the cull-override and shows the interior. This probe puts
// the camera at the panorama center and captures both backends; after the
// fix the WebGPU capture should show the panorama imagery (non-blank,
// matching WebGL) instead of empty sky/black.
//
// Usage: node Tools/visual-regression/probe-panorama-cull-override.mjs
// Outputs: output/probe-panorama-cull-override-{webgl,webgpu}.png
//
// NOTE: requires a dev server on :8080 (npm run restart / gulp build first).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// The panorama image is baked in-page onto an offscreen canvas (see
// addPanoramaAndAim) so the probe is self-contained — no external asset,
// no network fetch. A 2:1 equirectangular gradient makes a culled-blank
// interior unmistakably different from a rendered interior.

async function addPanoramaAndAim(page) {
  await page.evaluate(async () => {
    const Cesium = window.Cesium;
    const v = window.viewer;

    // Bake a 2:1 equirectangular gradient onto an offscreen canvas so the
    // probe is self-contained (no network fetch, no external image asset).
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, c.width, c.height);
    grad.addColorStop(0, "#ff00aa");
    grad.addColorStop(0.5, "#ffee00");
    grad.addColorStop(1, "#00ddff");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, c.width, c.height);
    // Add a few bands so any culling/flip artifact is obvious.
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    for (let x = 0; x < c.width; x += 64) {
      ctx.fillRect(x, 0, 4, c.height);
    }

    const position = Cesium.Cartesian3.fromDegrees(-75.1699, 39.9522, 100.0);
    const hpr = new Cesium.HeadingPitchRoll(0, 0, 0);
    const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
      position,
      hpr,
      Cesium.Ellipsoid.WGS84,
      Cesium.Transforms.eastNorthUpToFixedFrame,
    );

    const pano = new Cesium.EquirectangularPanorama({
      transform: modelMatrix,
      image: c,
      radius: 1000.0,
    });
    v.scene.primitives.add(pano);
    window.__pano = pano;

    // Place the camera AT the panorama center (inside the sphere) looking
    // out along east — this is the view that the cull-override is meant
    // to make visible.
    v.scene.camera.setView({
      destination: position,
      orientation: { heading: 0, pitch: 0, roll: 0 },
    });
  });
}

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
  await page.waitForFunction(() => !!window.viewer && !!window.Cesium);

  await addPanoramaAndAim(page);

  // Let the panorama image upload + pipeline build settle.
  await page.evaluate(async () => {
    const v = window.viewer;
    for (let i = 0; i < 120; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(1000);

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  const out = path.join(
    OUT_DIR,
    `probe-panorama-cull-override-${rendererArg}.png`,
  );
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  ${rendererArg}: ${errs.length} errors:`);
    errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  return out;
}

// Count non-background (non-near-black) pixels so a blank/culled interior
// (near-empty) is distinguishable from a rendered panorama (lots of
// colored pixels). Reuses the Playwright canvas-decode trick — no Node
// PNG dependency.
async function coverageOf(pngPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const result = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const total = c.width * c.height;
    let colored = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (lum > 12) {
        colored++;
      }
    }
    return { total, colored, coveragePct: ((100 * colored) / total).toFixed(2) };
  }, b64);
  await browser.close();
  return result;
}

(async () => {
  console.log("[probe-panorama-cull-override] capturing WebGPU + WebGL");
  const gpu = await capture("webgpu");
  const gl = await capture("webgl");
  console.log(`  webgpu: ${gpu}`);
  console.log(`  webgl:  ${gl}`);
  try {
    const gpuCov = await coverageOf(gpu);
    const glCov = await coverageOf(gl);
    console.log(`  webgpu coverage:`, JSON.stringify(gpuCov));
    console.log(`  webgl  coverage:`, JSON.stringify(glCov));
    console.log(
      "  PASS criteria: webgpu coverage should be close to webgl " +
        "(panorama interior visible). A near-zero webgpu coverage with " +
        "non-zero webgl coverage means the interior is still being culled.",
    );
  } catch (e) {
    console.log(`  coverage failed: ${e.message}`);
  }
  console.log("[probe-panorama-cull-override] done");
})();
