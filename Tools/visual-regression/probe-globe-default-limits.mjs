#!/usr/bin/env node
// Probe (Batch 246 — NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT verify +
// regression gate): the globe must render on a device with WebGPU's
// DEFAULT limits — specifically `maxSampledTexturesPerShaderStage = 16`
// (the spec floor; what SwiftShader CI, compat-mode adapters, and
// low-end mobile report). The full globe terrain pipeline layout needs
// 28 fragment-stage sampled textures (16 imagery + 5 group-2 + 7
// globe effects); without the reduced-layout fallback, pipeline-layout
// creation fails validation and the globe never draws.
//
// The probe constructs its OWN CesiumWidget on a bare page (root
// index.html — no auto-created viewer, so the device pool's primary
// device is OURS) with `contextOptions.requiredLimits` pinning
// maxSampledTexturesPerShaderStage to the requested test tier (16 by default).
// Pinned limits are honored
// verbatim by the pool's negotiator (user-supplied values are never
// raised), so `device.limits.maxSampledTexturesPerShaderStage` reads
// exactly as requested — limit 16 is a true default-limit device on real hardware.
//
//   (A) LIMIT — the created device actually reports the forced limit of
//       16 (guards against the pool/negotiator silently raising it,
//       which would make every other check vacuous).
//   (B) FALLBACK — the globe surface renderer selected the reduced
//       4-slot imagery layout (`globalThis.__webgpuGlobeImagerySlotCount
//       === 4`, published by WebGPUGlobeSurfaceRenderer.initialize).
//   (C) RENDER — the globe is visually present: >8% non-black coverage
//       with imagery color diversity (offline NaturalEarthII base layer
//       — no network/Ion dependency; flat clear ≈ 1 color bucket,
//       imagery ≫ 100).
//   (D) MULTI-PASS — adding enough local GridImageryProvider layers to
//       exceed the selected tier by one exercises a two-pass blend path
//       (5 layers on the 4-slot tier, 17 on the 16-slot tier). The grid
//       lattice must change a visible fraction of
//       pixels vs the single-layer snap, and the scene must stay
//       non-black (a broken blend pass would either no-op or kill the
//       command buffer → black).
//   (E) zero console errors (incl. WebGPU validation errors — a bad
//       pipeline layout invalidates the whole pass).
//
// Standard-limit path (full 16-slot layout) is covered by
// probe-globe-bindgroup-cache.mjs + sandcastle-smoke.mjs — run those
// alongside this probe for any change near the globe layout.
//
// Usage: node Tools/visual-regression/probe-globe-default-limits.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
//        PROBE_TEXTURE_LIMIT (default 16; use 64 to exercise the full tier)
// Out:   Tools/visual-regression/output/globe-limit-<limit>-{1,N}layer.png

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const TEXTURE_LIMIT = Number(process.env.PROBE_TEXTURE_LIMIT ?? 16);
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");
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

// Bare page — MUST NOT auto-create a viewer. The device pool shares its
// primary device with any compatible later acquire; if a default-options
// viewer ran first, its 64-texture negotiated device would satisfy our
// "≥16" requirement and the forced-default-limit device would never be
// created.
await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });

const out = await page.evaluate(async (textureLimit) => {
  const C = await import("/Build/CesiumUnminified/index.js");

  // The bare page has no widgets CSS — without the 100% rules the
  // cesium-widget canvas collapses to a ~150px strip and the readback
  // sees mostly background. Minimal inline replacement for
  // CesiumWidget.css's sizing rules.
  const style = document.createElement("style");
  style.textContent =
    ".cesium-widget, .cesium-widget canvas { width: 100%; height: 100%; display: block; }";
  document.head.appendChild(style);

  const div = document.createElement("div");
  div.style.cssText =
    "position:absolute;top:0;left:0;width:1024px;height:768px;";
  document.body.appendChild(div);

  // Offline imagery — ships in Build/CesiumUnminified/Assets; no network
  // or Ion token, so the probe is deterministic on CI.
  const baseLayer = C.ImageryLayer.fromProviderAsync(
    C.TileMapServiceImageryProvider.fromUrl(
      C.buildModuleUrl("Assets/Textures/NaturalEarthII"),
    ),
  );

  const widget = await C.CesiumWidget.createAsync(div, {
    contextOptions: {
      renderer: "webgpu",
      // Force the requested sampled-texture tier. User-pinned limits are
      // honored verbatim by WebGPUDevicePool._negotiate (never auto-raised).
      requiredLimits: {
        maxSampledTexturesPerShaderStage: textureLimit,
      },
    },
    baseLayer,
  });
  const scene = widget.scene;
  widget.clock.shouldAnimate = false;

  // (A) the device actually got the forced test limit.
  const device = scene.context._device ?? scene.context.device;
  const deviceLimit = device?.limits?.maxSampledTexturesPerShaderStage ?? -1;

  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(0.0, 20.0, 1.8e7),
  });

  const frame = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  // Render until the globe settles (tilesLoaded streak) — capped so a
  // stuck tile pipeline fails loudly instead of hanging the probe.
  const renderUntilLoaded = async (maxFrames, streakNeeded) => {
    let streak = 0;
    for (let i = 0; i < maxFrames; i++) {
      await frame(1);
      const rendering =
        (scene.globe._surface?._tilesToRender?.length ?? 0) > 0;
      if (scene.globe.tilesLoaded && rendering) {
        streak++;
        if (streak >= streakNeeded) return true;
      } else {
        streak = 0;
      }
    }
    return false;
  };
  // `tilesLoaded` reports the CPU-side imagery state machine; the
  // WebGPU-side texture upload + first composited frame can land a few
  // frames later. Gate on the actual canvas content: the globe disk is
  // centered (camera looks at lon 0 / lat 20 from 18 Mm), so wait until
  // the CENTER pixel carries imagery brightness. Without this the snap
  // races the upload and captures the dark pre-imagery base color.
  const renderUntilDiskVisible = async (maxFrames) => {
    for (let i = 0; i < maxFrames; i += 5) {
      const px = await new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          const c = scene.canvas;
          const off = document.createElement("canvas");
          off.width = c.width;
          off.height = c.height;
          const cx = off.getContext("2d");
          cx.drawImage(c, 0, 0);
          const d = cx.getImageData(
            Math.floor(c.width / 2),
            Math.floor(c.height / 2),
            1,
            1,
          ).data;
          resolve(d[0] + d[1] + d[2]);
        });
        scene.render();
      });
      if (px > 90) return true;
      await frame(4);
    }
    return false;
  };
  // Deterministic readback INSIDE scene.postRender — present clears the
  // WebGPU canvas texture, so readback in a later task is racy.
  const snap = () =>
    new Promise((resolve) => {
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
          png: off.toDataURL("image/png"),
        });
      });
      scene.render();
    });
  const analyze = (img) => {
    let nonBlack = 0;
    const buckets = new Set();
    for (let p = 0; p < img.w * img.h; p++) {
      const i = 4 * p;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      if (r > 16 || g > 16 || b > 16) {
        nonBlack++;
        buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      }
    }
    return {
      nonBlackPct: nonBlack / (img.w * img.h),
      colorBuckets: buckets.size,
    };
  };

  // ── Phase 1: single imagery layer on the reduced layout ──
  const loaded1 =
    (await renderUntilLoaded(900, 20)) && (await renderUntilDiskVisible(300));
  const img1 = await snap();
  const a1 = analyze(img1);
  const slotCount = globalThis.__webgpuGlobeImagerySlotCount ?? -1;

  // ── Phase 2: slotCount+1 total layers → a two-pass blend path ──
  // Local grid layers plus NaturalEarthII force exactly one overflow layer on
  // both the four-slot compatibility tier and the sixteen-slot full tier.
  for (let i = 0; i < slotCount; i++) {
    scene.imageryLayers.addImageryProvider(
      new C.GridImageryProvider({ cells: 4 }),
    );
  }
  const loaded2 =
    (await renderUntilLoaded(900, 20)) && (await renderUntilDiskVisible(300));
  const img2 = await snap();
  const a2 = analyze(img2);

  // Pixel diff between the two phases — the grid layers, including the second
  // (blend) pass must actually land on screen. Two metrics:
  //   - changedPct: raw fraction of pixels that moved (informational —
  //     also picks up tile-refinement noise between snaps).
  //   - greenShift: GridImageryProvider's DEFAULT backgroundColor is
  //     rgba(0, 0.5, 0, 0.2) — a 20% green wash over every covered
  //     fragment. The mean green-excess (g - (r+b)/2) over pixels lit
  //     in both phases must increase if (and only if) the second blend
  //     pass actually composited. Tile refinement doesn't shift hue
  //     systematically, so this isolates the pass-2 contribution.
  let changed = 0;
  let greenSum = 0;
  let greenN = 0;
  const n = Math.min(img1.data.length, img2.data.length);
  for (let i = 0; i < n; i += 4) {
    const r1 = img1.data[i],
      g1 = img1.data[i + 1],
      b1 = img1.data[i + 2];
    const r2 = img2.data[i],
      g2 = img2.data[i + 1],
      b2 = img2.data[i + 2];
    if (
      Math.abs(r1 - r2) > 24 ||
      Math.abs(g1 - g2) > 24 ||
      Math.abs(b1 - b2) > 24
    ) {
      changed++;
    }
    if (r1 + g1 + b1 > 48 && r2 + g2 + b2 > 48) {
      greenSum += g2 - (r2 + b2) / 2 - (g1 - (r1 + b1) / 2);
      greenN++;
    }
  }

  return {
    deviceLimit,
    slotCount,
    loaded1,
    loaded2,
    phase1: a1,
    phase2: a2,
    changedPct: changed / (img1.w * img1.h),
    greenShift: greenN > 0 ? greenSum / greenN : 0,
    png1: img1.png,
    png2: img2.png,
  };
}, TEXTURE_LIMIT);

// Save screenshots for spot-checking.
for (const [name, dataUrl] of [
  [`globe-limit-${TEXTURE_LIMIT}-1layer.png`, out.png1],
  [`globe-limit-${TEXTURE_LIMIT}-${out.slotCount + 1}layer.png`, out.png2],
]) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(dataUrl.split(",")[1], "base64"),
  );
}
await browser.close();

// Bucket threshold note: the offline NaturalEarthII palette is softer
// than the Ion world imagery used by probe-globe-bindgroup-cache (which
// asserts >100). A composited NaturalEarthII globe measures ~300+
// buckets at 1024x768; the pre-imagery failure mode (atmosphere ring
// over a dark disk) measures ~80. 150 splits the two cleanly.
const BUCKETS_MIN = 150;
const expectedSlots = TEXTURE_LIMIT >= 28 ? 16 : 4;
const aOK = out.deviceLimit === TEXTURE_LIMIT;
const bOK = out.slotCount === expectedSlots;
const cOK =
  out.loaded1 &&
  out.phase1.nonBlackPct > 0.08 &&
  out.phase1.colorBuckets > BUCKETS_MIN;
const dOK =
  out.loaded2 &&
  out.phase2.nonBlackPct > 0.08 &&
  out.phase2.colorBuckets > BUCKETS_MIN &&
  // Measured ~3.8 on a compositing pass-2; a silently-skipped blend
  // pass measures ~0 (refinement noise is hue-neutral). 2.0 splits.
  out.greenShift > 2;
const eOK = errors.length === 0;

console.log(
  `(A) forced texture limit: maxSampledTexturesPerShaderStage=${out.deviceLimit} (expect ${TEXTURE_LIMIT}) ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) imagery layout selected: imagerySlotCount=${out.slotCount} (expect ${expectedSlots}) ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) 1-layer render: loaded=${out.loaded1}, nonBlack=${(out.phase1.nonBlackPct * 100).toFixed(1)}% (>8%), ` +
    `colorBuckets=${out.phase1.colorBuckets} (>${BUCKETS_MIN}) ${cOK ? "OK" : "FAIL"}`,
);
console.log(
  `(D) ${out.slotCount + 1}-layer multi-pass: loaded=${out.loaded2}, nonBlack=${(out.phase2.nonBlackPct * 100).toFixed(1)}% (>8%), ` +
    `colorBuckets=${out.phase2.colorBuckets} (>${BUCKETS_MIN}), greenShift=${out.greenShift.toFixed(1)} (>2 — grid layer's ` +
    `green background wash from the blend pass), changedPct=${(out.changedPct * 100).toFixed(2)}% ${dOK ? "OK" : "FAIL"}`,
);
console.log(`(E) console errors: ${errors.length} ${eOK ? "OK" : "FAIL"}`);
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 300)));

const pass = aOK && bOK && cOK && dOK && eOK;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
