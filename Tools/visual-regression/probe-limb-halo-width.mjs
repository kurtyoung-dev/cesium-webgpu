#!/usr/bin/env node
// Probe: NEW-VR2-3b-LIMB-HALO-RESIDUAL
//
// Reproduces the documented residual EXACTLY: the "Hello World" default view
// (default CesiumViewer camera, 800x600) with a HORIZONTAL pixel scan across
// the globe-disk row. The residual (DEFERRED_WORK NEW-VR2-3b) was measured as
// "~25 px of disk-edge halo width difference at x=275 (left) and x=425 (right)"
// — WebGPU's SkyAtmosphere shell rendered a wider faint blue haze ring past the
// solid disk edge.
//
// Method (per backend, skybox/stars OFF so space is PURE BLACK):
//   1. Load the default CesiumViewer view at 800x600.
//   2. Find the globe disk center + radius from the lit (non-black) pixels.
//   3. On the horizontal row through the disk center, walk OUTWARD from the
//      solid disk edge (last bright-lit pixel) until pure-black space. The run
//      of dim non-black pixels in between is the limb HAZE TAIL. Its length is
//      the ring WIDTH at that edge.
//   4. Measure the haze-tail width at BOTH the left and right disk edges, on a
//      few rows around the disk center, and assert WebGPU matches WebGL within
//      tolerance (was ~25 px wider).
//
// Usage:  node Tools/visual-regression/probe-limb-halo-width.mjs
// Output: probe-limb-halo-{webgl,webgpu}.png  (+ console table)
//
// Uses Edge (Chromium) — Playwright Firefox has no WebGPU.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const W = 800;
const H = 600;

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
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  // Default CesiumViewer view = the Hello World framing.
  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });

  // Fixed clock for deterministic lighting; pure-black space (skybox + bright-
  // star catalog + sun/moon billboards OFF) so the ONLY non-black pixels past
  // the solid disk edge are the SkyAtmosphere limb haze. SkyAtmosphere stays
  // ON — it is the thing under test.
  await page.evaluate(() => {
    const v = window.viewer;
    v.clock.shouldAnimate = false;
    const JulianDate = v.clock.currentTime.constructor;
    if (typeof JulianDate.fromIso8601 === "function") {
      v.clock.currentTime = JulianDate.fromIso8601("2024-06-21T12:00:00Z");
    }
    v.scene.requestRenderMode = false;
    if (v.scene.skyBox) {
      v.scene.skyBox.show = false;
      if (v.scene.skyBox.starField) v.scene.skyBox.starField.show = false;
    }
    if (v.scene.sun) v.scene.sun.show = false;
    if (v.scene.moon) v.scene.moon.show = false;
    // Isolate the SkyAtmosphere limb halo cleanly: flat NEUTRAL-gray globe
    // (imagery off → no blue ocean), ground atmosphere OFF and lighting OFF (so
    // the disk surface is uniform gray, no day/night or ground-atmo blue). Then
    // the ONLY blue in the frame is the SkyAtmosphere shell halo — the thing
    // under test. Its blue band at the disk perimeter is measured directly.
    const globe = v.scene.globe;
    if (globe) {
      if (globe.imageryLayers) globe.imageryLayers.removeAll();
      const Color = v.scene.backgroundColor.constructor;
      globe.baseColor = new Color(0.5, 0.5, 0.5, 1.0);
      globe.showGroundAtmosphere = true;
      globe.enableLighting = false;
    }
  });

  await page.evaluate(async () => {
    const v = window.viewer;
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(1500);

  const out = path.join(OUT_DIR, `probe-limb-halo-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  [${rendererArg}] ${errs.length} page errors:`);
    errs.slice(0, 3).forEach((e) => console.log(`     ${e.t}: ${e.text}`));
  }
  return out;
}

// Decode a PNG and measure the limb haze-tail width at the left and right disk
// edges along several horizontal rows near the disk center.
async function measureRingWidth(pngPath) {
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
    const w = c.width, h = c.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    const at = (x, y) => {
      const i = (y * w + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const SPACE_LUM = 4;        // empty black sky
    const SURFACE_LUM = 120;    // solid lit globe surface
    // The visible limb HALO is the strongly-BLUE band hugging the disk's
    // perimeter (Rayleigh glow). We measure its radial thickness at the left &
    // right disk edges: from the outermost non-black pixel inward to where the
    // surface stops being blue-haze-dominated. HAZE_BLUE/SURFACE_BLUE give
    // hysteresis so a 1px speckle doesn't end the band.
    const HAZE_BLUE = 40;       // B - R >= this ⇒ haze-dominated blue band
    const SURFACE_BLUE = 28;    // B - R <  this ⇒ ordinary lit surface

    // Robust disk center: the disk+haze is one contiguous NON-BLACK blob
    // against pure-black space. Find the longest contiguous non-black run on a
    // band of rows/cols (the UI overlay in the top-right is a separate, shorter
    // blob, so the longest run is the globe). Allow small black gaps (dark
    // ocean / terminator) inside the run.
    const longestRun = (coords, read, gapTol) => {
      let bs = -1, be = -1, cs = -1, gap = 0;
      for (const i of coords) {
        if (read(i) > SPACE_LUM) { if (cs < 0) cs = i; gap = 0; }
        else if (cs >= 0) {
          gap++;
          if (gap > gapTol) { if (i - cs > be - bs) { bs = cs; be = i - gap; } cs = -1; gap = 0; }
        }
      }
      const last = coords[coords.length - 1];
      if (cs >= 0 && last - cs > be - bs) { bs = cs; be = last; }
      return [bs, be];
    };
    const xs = []; for (let x = 0; x < w; x++) xs.push(x);
    const ys = []; for (let y = 0; y < h; y++) ys.push(y);
    // average a few middle rows to find horizontal span robustly
    const midY = Math.round(h / 2);
    const [hx0, hx1] = longestRun(xs, (x) => lum(...at(x, midY)), 12);
    const cx = Math.round((hx0 + hx1) / 2);
    const [vy0, vy1] = longestRun(ys, (y) => lum(...at(cx, y)), 12);
    const cy = Math.round((vy0 + vy1) / 2);
    const diskRadiusPx = Math.round((hx1 - hx0) / 2);
    if (diskRadiusPx < 50) return { error: "no disk found", cx, cy, diskRadiusPx };

    // Per row, per side: find the outermost non-black pixel (outer haze edge),
    // then walk inward while the band stays blue. Halo width = outer - innerBlue.
    const measureSide = (y, dir) => {
      // outermost non-black on this side
      let outer = -1;
      for (let x = cx; x >= 0 && x < w; x += dir) {
        if (lum(...at(x, y)) > SPACE_LUM) outer = x;
      }
      if (outer < 0) return null;
      let innerBlue = outer, belowRun = 0;
      for (let x = outer; x >= 0 && x < w; x -= dir) {
        const [R, G, B] = at(x, y);
        const bias = B - R;
        if (bias >= HAZE_BLUE) { innerBlue = x; belowRun = 0; }
        else if (bias < SURFACE_BLUE) { belowRun++; if (belowRun >= 3) break; }
        if (Math.abs(x - outer) > diskRadiusPx) break; // safety
      }
      return { outer, innerBlue, width: Math.abs(outer - innerBlue) };
    };

    const rows = [];
    for (let dy = -24; dy <= 24; dy += 4) rows.push(cy + dy);
    const widths = [];
    const detail = [];
    for (const y of rows) {
      for (const dir of [-1, +1]) {
        const m = measureSide(y, dir);
        if (m && m.width >= 1 && m.width < diskRadiusPx) {
          widths.push(m.width);
          detail.push({ y, side: dir < 0 ? "L" : "R", outer: m.outer, innerBlue: m.innerBlue, width: m.width });
        }
      }
    }
    if (widths.length < 8) return { error: "too few rows", samples: widths.length, cx, cy };
    widths.sort((p, q) => p - q);
    const median = widths[Math.floor(widths.length / 2)];
    const mean = widths.reduce((s, v) => s + v, 0) / widths.length;
    return {
      cx, cy, diskRadiusPx,
      samples: widths.length,
      meanWidth: +mean.toFixed(2),
      medianWidth: median,
      minWidth: widths[0],
      maxWidth: widths[widths.length - 1],
      detail: detail.filter((d) => Math.abs(d.y - cy) <= 4),
    };
  }, b64);
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-limb-halo-width] capturing webgl …");
  const gl = await capture("webgl");
  console.log("[probe-limb-halo-width] capturing webgpu …");
  const gpu = await capture("webgpu");

  console.log(`  webgl  png: ${gl}`);
  console.log(`  webgpu png: ${gpu}`);

  const glM = await measureRingWidth(gl);
  const gpuM = await measureRingWidth(gpu);

  console.log("\n  WebGL  haze tail:", JSON.stringify(glM));
  console.log("  WebGPU haze tail:", JSON.stringify(gpuM));

  if (glM.error || gpuM.error) {
    console.log("\n  ✗ measurement error — inspect the PNGs above");
    process.exit(2);
  }

  const delta = +(gpuM.medianWidth - glM.medianWidth).toFixed(2);
  const TOL = 6; // px
  console.log(`\n  median limb haze-tail width  WebGL=${glM.medianWidth}px  WebGPU=${gpuM.medianWidth}px`);
  console.log(`  delta (WebGPU - WebGL) = ${delta}px  (tolerance ±${TOL}px)`);
  if (Math.abs(delta) <= TOL) {
    console.log("  ✓ PASS — limb haze-tail width matches WebGL within tolerance");
  } else {
    console.log(`  ✗ FAIL — WebGPU haze tail is ${delta > 0 ? "WIDER" : "NARROWER"} than WebGL by ${Math.abs(delta)}px`);
  }
})();
