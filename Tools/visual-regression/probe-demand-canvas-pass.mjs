// C9-07-DEMAND-OPEN-CANVAS-PASS / FAR-405-C0 acceptance probe.
// @purpose Certifies deferred canvas-pass demand-open: present, empty-scene clear, requestRenderMode retention, resize, and debug-overlay legs on WebGPU.
// @status ACTIVE
//
// The WebGPU context used to open the "Scene Main Render Pass" (canvas
// swap-chain pass) unconditionally in beginFrame() and again after the
// post-process blit — 2 empty passes per frame on the default route
// (C9-05 API evidence: 2250/2250 empty over 1125 frames). The demand-open
// slice defers the canvas pass to its first real consumer and adds an
// endFrame clear/present fallback for frames where nothing touches the
// canvas (empty scene).
//
// This probe certifies the FEATURE side of the boundary (run it in both
// phases; the pass-count acceptance number comes from the API lane of
// run-performance-campaign.mjs):
//   1. default-globe   — normal render still presents: canvas-element-only
//                        capture, gated on BOTH whole-canvas nonBlack AND
//                        the center third (globe interior) so a black
//                        globe interior fails (2026-07-16 audit fix — the
//                        old full-page >20% gate passed on UI chrome alone)
//   2. empty-scene     — globe/sky/sun/moon hidden (numFrustums === 0):
//                        the canvas must still present the historical
//                        cleared background every rendered frame
//   3. request-render  — requestRenderMode retains the last presented frame
//                        between renders and updates after requestRender()
//   4. resize          — mid-run canvas resize keeps presenting
//   5. debug-overlays  — CesiumDebug showDepth / showFrustums produce
//                        non-black canvas output (canvas written outside
//                        the production PP path)
//   6. overlay-list    — records whether scene._overlayCommandList has any
//                        producer on the default route (consumer evidence)
//
// Usage:
//   node Tools/visual-regression/probe-demand-canvas-pass.mjs           (post-change, compares vs -PRECHANGE PNGs when present)
//   PHASE=pre node Tools/visual-regression/probe-demand-canvas-pass.mjs (capture -PRECHANGE baselines)

import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output/demand-canvas";
const PHASE = process.env.PHASE === "pre" ? "pre" : "post";
const SUFFIX = PHASE === "pre" ? "-PRECHANGE" : "";

const failures = [];
const notes = [];

// Pre-existing on the clean pre-change tree (captured 2026-07-16 BEFORE the
// C9-07 demand-open slice): resizing the canvas can race the scene-FB
// depth-resolve texture rebuild and emit one transient validation error
// ("...SceneFramebuffer-Color_depth_resolve_ss] match the expected sample
// types (Depth)"). Same family as NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION
// (QUEUE_2026-07-15_CAMPAIGN9.md §3.2). Allowlisted so this probe gates the
// demand-open slice, not that pre-existing race; any OTHER error still fails.
const PREEXISTING_ERROR_ALLOWLIST = ["SceneFramebuffer-Color_depth_resolve_ss"];

function filterErrors(errors) {
  return errors.filter(
    (e) => !PREEXISTING_ERROR_ALLOWLIST.some((allow) => e.includes(allow)),
  );
}

function ok(cond, label, detail = "") {
  const line = `${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`;
  console.log(`  ${line}`);
  if (!cond) failures.push(label + (detail ? ` (${detail})` : ""));
}

async function launch() {
  return chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
}

async function newViewerPage(browser, renderer) {
  const page = await browser.newPage({
    viewport: { width: 960, height: 640 },
  });
  const errors = [];
  page.on("pageerror", (e) =>
    errors.push(`pageerror: ${e.message.slice(0, 200)}`),
  );
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  await page.goto(
    `${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);
  return { page, errors };
}

async function renderFrames(page, n) {
  await page.evaluate(async (count) => {
    const s = window.viewer.scene;
    for (let i = 0; i < count; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, n);
}

// Decode a PNG inside the page and return simple stats: nonBlack count +
// a cheap content hash. With { centerClip: true } the stats are computed
// over the CENTRAL third of the image only (the globe interior at the
// default camera) — returned w/h are the clip dimensions.
async function pngStats(page, file, opts = {}) {
  const b64 = (await fs.promises.readFile(file)).toString("base64");
  return page.evaluate(
    async ({ b, centerClip }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      let rx = 0;
      let ry = 0;
      let rw = c.width;
      let rh = c.height;
      if (centerClip) {
        rw = Math.max(1, Math.floor(c.width / 3));
        rh = Math.max(1, Math.floor(c.height / 3));
        rx = Math.floor((c.width - rw) / 2);
        ry = Math.floor((c.height - rh) / 2);
      }
      const d = x.getImageData(rx, ry, rw, rh).data;
      let nonBlack = 0;
      let hash = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 24) nonBlack++;
        hash = (hash * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) >>> 0;
        rSum += d[i];
        gSum += d[i + 1];
        bSum += d[i + 2];
      }
      const n = rw * rh;
      return {
        w: rw,
        h: rh,
        nonBlack,
        hash,
        avgRGB: [
          Math.round(rSum / n),
          Math.round(gSum / n),
          Math.round(bSum / n),
        ],
      };
    },
    { b: b64, centerClip: !!opts.centerClip },
  );
}

async function diffPngs(page, a, b) {
  const ba = (await fs.promises.readFile(a)).toString("base64");
  const bb = (await fs.promises.readFile(b)).toString("base64");
  return page.evaluate(
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
          w: c.width,
          h: c.height,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await decode(ba);
      const B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      let mismatch = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const d =
          Math.abs(A.data[i] - B.data[i]) +
          Math.abs(A.data[i + 1] - B.data[i + 1]) +
          Math.abs(A.data[i + 2] - B.data[i + 2]);
        if (d > 30) mismatch++;
      }
      return {
        totalPx: A.w * A.h,
        mismatchPx: mismatch,
        mismatchPct: +((100 * mismatch) / (A.w * A.h)).toFixed(3),
      };
    },
    { ba, bb },
  );
}

async function run(renderer) {
  console.log(`\n[demand-canvas] renderer=${renderer} phase=${PHASE}`);
  const browser = await launch();
  const shots = {};

  // ── Case 1: default globe ──
  {
    const { page, errors } = await newViewerPage(browser, renderer);
    await renderFrames(page, 120);
    const f = `${OUT_DIR}/demand-canvas-default-${renderer}${SUFFIX}.png`;
    // CANVAS-ONLY element screenshot (2026-07-16 audit fix): the original
    // full-page capture passed its >20% nonBlack smoke assertion even with a
    // completely BLACK globe interior — UI chrome + the atmosphere ring +
    // stars alone carry ~22%. Capture the Cesium canvas element (like
    // case 2) and gate additionally on the CENTER third of the canvas (the
    // globe interior at the default camera) so a black-globe regression
    // actually fails this gate. Known pre-existing bimodal failure this now
    // gates: the offline-route WebGPU black globe interior (queue row
    // NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION — center avgRGB 2,2,2
    // with tilesLoaded=true and zero errors, deterministic within a
    // session, reproduced on the pre-change tree). A FAIL here with zero
    // console errors and dark center avgRGB is that ledgered bug, not a
    // demand-open regression.
    await page.locator(".cesium-widget canvas").screenshot({ path: f });
    const st = await pngStats(page, f);
    const stCenter = await pngStats(page, f, { centerClip: true });
    shots.default = f;
    ok(
      st.nonBlack > st.w * st.h * 0.2,
      `${renderer} default-globe canvas presents`,
      `nonBlack=${st.nonBlack}/${st.w * st.h}`,
    );
    ok(
      stCenter.nonBlack > stCenter.w * stCenter.h * 0.5,
      `${renderer} default-globe canvas CENTER non-black (globe interior)`,
      `centerNonBlack=${stCenter.nonBlack}/${stCenter.w * stCenter.h} avgRGB=${stCenter.avgRGB.join(",")}`,
    );
    ok(errors.length === 0, `${renderer} default-globe zero errors`, errors[0]);

    // ── Case 6 (same page): overlay command list producer evidence ──
    const overlayLen = await page.evaluate(
      () => window.viewer.scene._overlayCommandList.length,
    );
    notes.push(
      `${renderer} default route _overlayCommandList.length=${overlayLen}`,
    );

    // ── Case 5 (same page, webgpu only): debug overlays ──
    if (renderer === "webgpu") {
      await page.evaluate(() => window.CesiumDebug?.showDepth?.(true));
      await renderFrames(page, 10);
      const fd = `${OUT_DIR}/demand-canvas-debugdepth-${renderer}${SUFFIX}.png`;
      await page.screenshot({ path: fd });
      const std = await pngStats(page, fd);
      shots.debugDepth = fd;
      ok(
        std.nonBlack > std.w * std.h * 0.1,
        `${renderer} debug depth overlay presents`,
        `nonBlack=${std.nonBlack}`,
      );
      await page.evaluate(() => window.CesiumDebug?.showDepth?.(false));
      await page.evaluate(() => window.CesiumDebug?.showFrustums?.(true));
      await renderFrames(page, 10);
      const ff = `${OUT_DIR}/demand-canvas-debugfrustums-${renderer}${SUFFIX}.png`;
      await page.screenshot({ path: ff });
      const stf = await pngStats(page, ff);
      shots.debugFrustums = ff;
      ok(
        stf.nonBlack > stf.w * stf.h * 0.1,
        `${renderer} debug frustum overlay presents`,
        `nonBlack=${stf.nonBlack}`,
      );
      await page.evaluate(() => window.CesiumDebug?.showFrustums?.(false));
    }

    // ── Case 4 (same page): resize mid-run ──
    await page.setViewportSize({ width: 800, height: 500 });
    await renderFrames(page, 60);
    const fr = `${OUT_DIR}/demand-canvas-resized-${renderer}${SUFFIX}.png`;
    await page.screenshot({ path: fr });
    const str = await pngStats(page, fr);
    shots.resized = fr;
    ok(
      str.nonBlack > str.w * str.h * 0.2,
      `${renderer} post-resize presents`,
      `nonBlack=${str.nonBlack}`,
    );
    const resizeErrs = filterErrors(errors);
    ok(
      resizeErrs.length === 0,
      `${renderer} resize zero non-allowlisted errors`,
      resizeErrs[0],
    );
    await page.close();
  }

  // ── Case 2: empty scene (numFrustums === 0) ──
  {
    const { page, errors } = await newViewerPage(browser, renderer);
    await page.evaluate(async () => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const s = v.scene;
      s.globe.show = false;
      s.skyBox.show = false;
      s.skyAtmosphere.show = false;
      if (s.sun) s.sun.show = false;
      if (s.moon) s.moon.show = false;
      // Freeze the clock at a fixed epoch so the capture is byte-stable
      // across runs: the animation-widget clock text, timeline highlight,
      // and any time-driven sky content (star field) all become
      // deterministic.
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-07-16T12:00:00Z");
    });
    // Hide every DOM overlay (toolbar, clock, timeline, credits, help,
    // app switcher) so the element screenshot is CANVAS PIXELS ONLY —
    // the overlays carry wall-clock-dependent text that breaks byte
    // comparison across runs.
    await page.addStyleTag({
      content:
        ".cesium-viewer > *:not(.cesium-viewer-cesiumWidgetContainer)" +
        "{ display: none !important; } " +
        "body > *:not(#cesiumContainer):not(script)" +
        "{ display: none !important; }",
    });
    await renderFrames(page, 30);
    const f = `${OUT_DIR}/demand-canvas-empty-${renderer}${SUFFIX}.png`;
    // Element screenshot of the Cesium canvas only — the full page
    // includes the animation-widget clock text, which changes every
    // second and would fake a byte-identity failure.
    await page.locator(".cesium-widget canvas").screenshot({ path: f });
    const st = await pngStats(page, f);
    shots.empty = f;
    notes.push(
      `${renderer} empty-scene stats nonBlack=${st.nonBlack} hash=${st.hash}`,
    );
    ok(errors.length === 0, `${renderer} empty-scene zero errors`, errors[0]);
    // In post phase, byte-compare against the pre-change capture.
    const pre = `${OUT_DIR}/demand-canvas-empty-${renderer}-PRECHANGE.png`;
    if (PHASE === "post" && fs.existsSync(pre)) {
      const d = await diffPngs(page, pre, f);
      ok(
        !d.error && d.mismatchPx === 0,
        `${renderer} empty-scene byte-identical to pre-change`,
        JSON.stringify(d),
      );
    }
    await page.close();
  }

  // ── Case 3: request-render mode ──
  {
    const { page, errors } = await newViewerPage(browser, renderer);
    await page.evaluate(async () => {
      const s = window.viewer.scene;
      s.requestRenderMode = true;
      s.maximumRenderTimeChange = Infinity;
      // Settle until the (offline ellipsoid) terrain quadtree stops
      // refining — every newly-ready tile calls requestRender(), which
      // would legitimately change pixels during the idle-hold phase and
      // fake a retention failure (observed 22.9% on the pre-change tree).
      for (let i = 0; i < 600; i++) {
        s.requestRender();
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (i > 60 && s.globe.tilesLoaded) break;
      }
      // A few extra frames after tilesLoaded so the last refinement
      // definitely presented.
      for (let i = 0; i < 10; i++) {
        s.requestRender();
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    // WebGPU keeps rendering for a few seconds after tilesLoaded (async
    // pipeline warm-ups etc. call requestRender) — pre-existing behavior
    // observed on the pre-change tree (frameNumber 125→208 over ~1.5 s
    // before stabilizing). Wait until the frame number is stable for
    // 800 ms so the idle-hold comparison measures RETENTION, not the
    // legitimate warm-up tail.
    await page.waitForFunction(
      async () => {
        const s = window.viewer.scene;
        const before = s.frameState.frameNumber;
        await new Promise((r) => setTimeout(r, 800));
        return s.frameState.frameNumber === before;
      },
      undefined,
      { timeout: 30000, polling: 100 },
    );
    // Idle for a bit WITHOUT requesting renders (default loop keeps
    // calling render(), which early-outs in requestRenderMode).
    await page.waitForTimeout(700);
    const fa = `${OUT_DIR}/demand-canvas-reqrender-hold-${renderer}${SUFFIX}.png`;
    await page.screenshot({ path: fa });
    await page.waitForTimeout(700);
    const fb = `${OUT_DIR}/demand-canvas-reqrender-hold2-${renderer}${SUFFIX}.png`;
    await page.screenshot({ path: fb });
    const dHold = await diffPngs(page, fa, fb);
    shots.reqHold = fa;
    ok(
      !dHold.error && dHold.mismatchPx === 0,
      `${renderer} request-render retains last frame while idle`,
      JSON.stringify(dHold),
    );
    // Now mutate the camera + requestRender: the canvas must update.
    await page.evaluate(async () => {
      const v = window.viewer;
      v.camera.zoomIn(4.0e6);
      v.scene.requestRender();
      for (let i = 0; i < 12; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    const fc = `${OUT_DIR}/demand-canvas-reqrender-after-${renderer}${SUFFIX}.png`;
    await page.screenshot({ path: fc });
    const dAfter = await diffPngs(page, fa, fc);
    ok(
      !dAfter.error && dAfter.mismatchPx > 1000,
      `${renderer} request-render updates after requestRender()`,
      JSON.stringify(dAfter),
    );
    const stc = await pngStats(page, fc);
    ok(
      stc.nonBlack > stc.w * stc.h * 0.2,
      `${renderer} request-render frame presents`,
      `nonBlack=${stc.nonBlack}`,
    );
    ok(
      errors.length === 0,
      `${renderer} request-render zero errors`,
      errors[0],
    );
    await page.close();
  }

  await browser.close();
  return shots;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await run("webgpu");
  await run("webgl");
  console.log("\nNotes:");
  for (const n of notes) console.log(`  - ${n}`);
  if (failures.length) {
    console.log(`\n[demand-canvas] FAIL (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("\n[demand-canvas] ALL PASS");
})();
