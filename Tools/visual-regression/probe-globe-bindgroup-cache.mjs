#!/usr/bin/env node
// Probe (Batch 241 — NEW-GLOBE-BINDGROUP-CACHE verify + regression gate):
// the globe surface renderer's per-tile bind-group cache must
//   (A) SETTLE — after tiles load at a fixed camera, bind-group
//       creations/frame must drop to ~0 over a 30-frame steady window
//       (HEAD-equivalent "before" number = requests/frame, since before
//       the cache every request was a device.createBindGroup call),
//   (B) PAN — moving the camera to a new tile set spikes creations
//       (new imagery views + new ring-allocator offsets), then settles
//       back to ~0 once tiles load,
//   (C) RENDER — the globe is visually present (non-black coverage with
//       imagery color diversity, not a flat clear color),
//   (D) produce ZERO console errors (incl. WebGPU validation errors —
//       a bad cached bind group would invalidate the whole pass).
//
// Stats source: `globalThis.__webgpuGlobeBindGroupCache` (published by
// WebGPUGlobeSurfaceRenderer.initialize; counters are debug-pragma'd so
// this probe must run against the unminified dev build, which keeps
// pragmas).
//
// Usage: node Tools/visual-regression/probe-globe-bindgroup-cache.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
);
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  // CesiumViewer runs requestRenderMode=true — at a settled camera the
  // loop stops rendering and per-frame stats freeze. Force continuous
  // renders so creations/frame is measurable.
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });

  const stats = () => {
    const cache = globalThis.__webgpuGlobeBindGroupCache;
    return cache ? cache.getStats() : null;
  };

  // Render frames until the globe reports tiles loaded AND the tile
  // path is actively requesting bind groups every frame. The second
  // condition is critical: `tilesLoaded` is vacuously true while the
  // imagery provider is still async-initializing, AND while the
  // central pipeline cache is asynchronously materializing the globe
  // pipeline variants `createTileCommands` early-`continue`s before
  // any bind-group request — both windows would let a hollow steady
  // measurement pass. Requiring a per-frame request delta > 0 across
  // the whole streak proves real tile commands are being emitted.
  // Hard cap so a stuck tile pipeline fails loudly instead of hanging.
  const renderUntilSettled = async (maxFrames, extraAfterLoaded) => {
    let loadedStreak = 0;
    let prevRequests = -1;
    for (let i = 0; i < maxFrames; i++) {
      await oncePostRender();
      const s = stats();
      const requests = s ? s.creates + s.hits : 0;
      const requestsTicking = prevRequests >= 0 && requests > prevRequests;
      prevRequests = requests;
      const rendering =
        (scene.globe._surface?._tilesToRender?.length ?? 0) > 0 &&
        requestsTicking;
      if (scene.globe.tilesLoaded && rendering) {
        loadedStreak++;
        if (loadedStreak >= extraAfterLoaded) return { settled: true, i };
      } else {
        loadedStreak = 0;
      }
    }
    return { settled: false, i: maxFrames };
  };

  // Measure creates + requests over a window of frames.
  const measure = async (frames) => {
    const s0 = stats();
    for (let i = 0; i < frames; i++) {
      await oncePostRender();
    }
    const s1 = stats();
    return {
      frames,
      creates: s1.creates - s0.creates,
      hits: s1.hits - s0.hits,
      createsPerFrame: (s1.creates - s0.creates) / frames,
      requestsPerFrame:
        (s1.creates - s0.creates + s1.hits - s0.hits) / frames,
      entries: s1.entries,
    };
  };

  // ── Phase A: fixed camera, settle, steady-state window ──
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(0.0, 20.0, 1.5e7),
  });
  const settleA = await renderUntilSettled(600, 30);
  const steadyA = await measure(30);

  // ── Phase B: pan to a new tile set, expect spike, then settle ──
  const statsBeforePan = stats();
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(80.0, -10.0, 1.5e7),
  });
  const settleB = await renderUntilSettled(600, 30);
  const statsAfterPan = stats();
  const panCreates = statsAfterPan.creates - statsBeforePan.creates;
  const steadyB = await measure(30);

  // ── Phase C: visual — globe present with imagery diversity ──
  // Readback inside postRender (WebGPU canvas clears on present).
  const img = await new Promise((resolve) => {
    const remove = scene.postRender.addEventListener(() => {
      remove();
      const c = scene.canvas;
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height;
      const cx = off.getContext("2d");
      cx.drawImage(c, 0, 0);
      resolve({
        data: cx.getImageData(0, 0, c.width, c.height).data,
        w: c.width,
        h: c.height,
      });
    });
  });
  let nonBlack = 0;
  const colorBuckets = new Set();
  for (let p = 0; p < img.w * img.h; p++) {
    const i = 4 * p;
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    if (r > 16 || g > 16 || b > 16) {
      nonBlack++;
      // 4-bit-per-channel bucket — imagery produces many distinct
      // buckets; a flat clear color produces ~1.
      colorBuckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }

  return {
    settledA: settleA.settled,
    settledB: settleB.settled,
    steadyA,
    steadyB,
    panCreates,
    cacheEntries: stats().entries,
    lifetime: stats(),
    nonBlackPct: nonBlack / (img.w * img.h),
    colorBuckets: colorBuckets.size,
  };
});

await page.screenshot({
  path: join(OUT_DIR, "globe-bindgroup-cache.png"),
});
await browser.close();

// ── Assertions ──
// (A) steady-state creations ~0. Allow a hair of slack for a stray
//     late-loading imagery tile, but the expected value is exactly 0.
//     `requestsPerFrame > 10` guards against a vacuous pass — it proves
//     the tile path was actively requesting bind groups during the
//     window (pre-cache, every one of those requests was a create).
const aOK =
  out.settledA &&
  out.steadyA.createsPerFrame <= 0.5 &&
  out.steadyA.requestsPerFrame > 10;
// (B) pan spikes (new tiles MUST allocate new bind groups), then
//     settles back to ~0.
const bOK =
  out.settledB &&
  out.panCreates >= 10 &&
  out.steadyB.createsPerFrame <= 0.5 &&
  out.steadyB.requestsPerFrame > 10;
// (C) globe visually present: >8% non-black coverage + imagery color
//     diversity (flat clear ≈ 1 bucket; imagery ≫ 100).
const cOK = out.nonBlackPct > 0.08 && out.colorBuckets > 100;
// (D) zero console errors (incl. WebGPU validation errors).
const dOK = errors.length === 0;

console.log(
  `(A) steady-state @fixed camera: creates/frame=${out.steadyA.createsPerFrame.toFixed(3)} ` +
    `(requests/frame=${out.steadyA.requestsPerFrame.toFixed(1)} — pre-cache this WAS the creates/frame), ` +
    `window=${out.steadyA.frames}f, settled=${out.settledA} (threshold <=0.5) ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) pan: ${out.panCreates} creates during pan+load (threshold >=10), ` +
    `re-settled creates/frame=${out.steadyB.createsPerFrame.toFixed(3)} ` +
    `(requests/frame=${out.steadyB.requestsPerFrame.toFixed(1)}), settled=${out.settledB} ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) visual: nonBlack=${(out.nonBlackPct * 100).toFixed(1)}% (>8%), colorBuckets=${out.colorBuckets} (>100) ${cOK ? "OK" : "FAIL"}`,
);
console.log(`(D) console errors: ${errors.length} ${dOK ? "OK" : "FAIL"}`);
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 250)));
console.log(
  `    cache: entries=${out.cacheEntries}, lifetime creates=${out.lifetime.creates}, ` +
    `hits=${out.lifetime.hits}, hitRate=${(out.lifetime.hitRate * 100).toFixed(1)}%`,
);

const pass = aOK && bOK && cOK && dOK;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
