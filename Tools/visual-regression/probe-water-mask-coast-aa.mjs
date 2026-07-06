#!/usr/bin/env node
// ACCEPTANCE / REGRESSION probe for NS-WATER-MASK-COAST-AA.
//
// BUG 2 (both backends): the water-mask-driven ocean effect draws a
// PIXELATED / blocky water/land boundary at the coast. The low-resolution
// terrain water mask, sampled once per fragment, resolves the coastline at
// texel granularity, so at low/mid zoom the boundary aliases into a jagged
// staircase.
//
// The fix adds a screen-space anti-aliased coverage band
// (`smoothstep(0.5 - band, 0.5 + band, mask)`, `band = max(1.5*fwidth,0.2)`)
// at the coast on BOTH backends (GlobeFS.glsl SHOW_REFLECTIVE_OCEAN block +
// GlobeTerrain.wgsl fragmentMain water-mask block), feathering the boundary
// over ~1 screen pixel without moving the 0.5 isoline.
//
// Run TWICE around the rebuild:
//   node Tools/visual-regression/probe-water-mask-coast-aa.mjs before
//   npx gulp build
//   node Tools/visual-regression/probe-water-mask-coast-aa.mjs after
//
// Metrics per backend:
//   * hfEnergy  — mean Laplacian magnitude inside the coast bounding box
//                 (the changed region). Lower = smoother coast. Expect
//                 after < before.
//   * changedPct — fraction of frame pixels that moved between before/after
//                  (computed in the `after` run vs the saved `before`).
//                  Small + localized = interiors untouched.
// Cross-backend: WebGL vs WebGPU mismatch AFTER should not regress.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const LABEL = (process.argv[2] || "after").toLowerCase(); // "before" | "after"

// Dalmatian coast (Croatia) — one of the most jagged coastlines on Earth,
// dense with islands, so the water-mask staircase is maximally visible.
// Mid altitude so mask texels project to a few screen pixels (the aliasing
// regime). Daytime so the reflective-ocean effect is lit.
const VIEW = process.env.VIEW || "view=16.4,43.35,120000";
const DAY_ISO = process.env.DAY_ISO || "2026-07-04T08:30:00Z"; // Croatia ~10:30 local, sun up

async function capture(rendererArg, label) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}&${VIEW}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ clockIso }) => {
      const v = window.viewer;
      const JulianDate = v.clock.currentTime.constructor;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = JulianDate.fromIso8601(clockIso);
      // Ensure the reflective-ocean water effect is on (default true).
      v.scene.globe.showWaterEffect = true;
      for (const el of document.querySelectorAll(
        ".cesium-viewer-toolbar, .cesium-viewer-animationContainer, " +
          ".cesium-viewer-timelineContainer, .cesium-viewer-bottom, " +
          ".cesium-widget-credits, #toolbar",
      )) {
        el.style.display = "none";
      }
      // Settle tiles + hold the clock so both backends see identical sun.
      for (let i = 0; i < 500; i++) {
        v.clock.currentTime = JulianDate.fromIso8601(clockIso);
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { clockIso: DAY_ISO },
  );
  await page.waitForTimeout(1500);

  const out = path.join(OUT_DIR, `probe-coast-aa-${label}-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  return out;
}

// Decode a PNG to {w,h,data} and compute grayscale + Laplacian HF metrics
// inside an optional bounding box.
async function analyze(pngA, pngB, prevPng) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const inp = {
    a: fs.readFileSync(pngA).toString("base64"),
    b: fs.readFileSync(pngB).toString("base64"),
    prev: prevPng && fs.existsSync(prevPng) ? fs.readFileSync(prevPng).toString("base64") : null,
  };
  const result = await page.evaluate(async ({ a, b, prev }) => {
    const decode = async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      return { w: img.naturalWidth, h: img.naturalHeight, data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data };
    };
    const gray = (im) => {
      const g = new Float32Array(im.w * im.h);
      for (let p = 0, i = 0; p < g.length; p++, i += 4)
        g[p] = 0.2126 * im.data[i] + 0.7152 * im.data[i + 1] + 0.0722 * im.data[i + 2];
      return g;
    };
    // Mean Laplacian magnitude inside [x0,x1)x[y0,y1). Higher = more
    // high-frequency (jaggy) content.
    const hfEnergy = (g, w, h, box) => {
      const { x0, y0, x1, y1 } = box;
      let sum = 0, n = 0;
      for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
        for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) {
          const p = y * w + x;
          const lap = 4 * g[p] - g[p - 1] - g[p + 1] - g[p - w] - g[p + w];
          sum += Math.abs(lap);
          n++;
        }
      }
      return { hf: n ? sum / n : 0, n };
    };

    const A = await decode(a); // webgl this run
    const B = await decode(b); // webgpu this run
    if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch A/B" };
    const gA = gray(A), gB = gray(B);
    const full = { x0: 0, y0: 0, x1: A.w, y1: A.h };

    // Cross-backend mismatch (this run).
    let mism = 0;
    for (let i = 0; i < A.data.length; i += 4) {
      const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
      if (d > 30) mism++;
    }

    const out = {
      w: A.w, h: A.h,
      crossMismatchPct: (100 * mism / (A.w * A.h)).toFixed(3),
      webgl: { hfFull: hfEnergy(gA, A.w, A.h, full).hf.toFixed(3) },
      webgpu: { hfFull: hfEnergy(gB, B.w, B.h, full).hf.toFixed(3) },
    };

    // If a previous (before) capture exists, diff to find the changed
    // coast band, bound it, and report HF inside that box + changed area.
    if (prev) {
      const P = await decode(prev); // same backend, previous run
      // prev corresponds to arg order: caller passes prev matching pngA's backend.
      if (P.w === A.w && P.h === A.h) {
        let minx = A.w, miny = A.h, maxx = 0, maxy = 0, changed = 0;
        for (let y = 0; y < A.h; y++) {
          for (let x = 0; x < A.w; x++) {
            const i = (y * A.w + x) * 4;
            const d = Math.abs(A.data[i] - P.data[i]) + Math.abs(A.data[i + 1] - P.data[i + 1]) + Math.abs(A.data[i + 2] - P.data[i + 2]);
            if (d > 8) {
              changed++;
              if (x < minx) minx = x; if (x > maxx) maxx = x;
              if (y < miny) miny = y; if (y > maxy) maxy = y;
            }
          }
        }
        const box = changed ? { x0: minx, y0: miny, x1: maxx + 1, y1: maxy + 1 } : full;
        const gP = gray(P);
        out.changedPct = (100 * changed / (A.w * A.h)).toFixed(3);
        out.coastBox = box;
        out.hfCoast_before = hfEnergy(gP, P.w, P.h, box).hf.toFixed(3);
        out.hfCoast_after = hfEnergy(gA, A.w, A.h, box).hf.toFixed(3);
      }
    }
    return out;
  }, inp);
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`== NS-WATER-MASK-COAST-AA :: ${LABEL} :: Dalmatian coast ==`);
  const gl = await capture("webgl", LABEL);
  const gpu = await capture("webgpu", LABEL);

  // For the 'after' run, diff each backend against its own 'before' capture.
  const prevGl = LABEL === "after" ? path.join(OUT_DIR, "probe-coast-aa-before-webgl.png") : null;
  const prevGpu = LABEL === "after" ? path.join(OUT_DIR, "probe-coast-aa-before-webgpu.png") : null;

  const rGl = await analyze(gl, gpu, prevGl); // HF for both + coast box vs webgl-before
  // Re-run coast-box analysis for webgpu vs its own before:
  let coastGpu = null;
  if (prevGpu) {
    const rGpu = await analyze(gpu, gpu, prevGpu);
    coastGpu = { changedPct: rGpu.changedPct, coastBox: rGpu.coastBox, hfCoast_before: rGpu.hfCoast_before, hfCoast_after: rGpu.hfCoast_after };
  }

  console.log("cross-backend + webgl coast:");
  console.log(JSON.stringify(rGl, null, 2));
  if (coastGpu) {
    console.log("webgpu coast (vs webgpu-before):");
    console.log(JSON.stringify(coastGpu, null, 2));
  }
  console.log("PNGs:\n  " + gl + "\n  " + gpu);
})();
