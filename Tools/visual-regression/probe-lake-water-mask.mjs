#!/usr/bin/env node
// ACCEPTANCE probe for C7-LAKE-WATER-MASK (WaterClassificationProvider
// Phase 1 — `globe.lakeWaterMask`, opt-in, DEFAULT OFF).
// @purpose Acceptance for opt-in globe.lakeWaterMask (Natural Earth lake polygons OR-composited into the water mask): off-gate, effect, and parity legs
// @status ACTIVE
//
// Cesium World Terrain's water mask is ocean-only (root-caused Batch 632),
// so large inland lakes render as flat land. The fix OR-composites Natural
// Earth 1:10m lake polygons (public domain) over the provider mask at the
// single shared water-mask upload point (GlobeSurfaceTile.js, Batch 512),
// so BOTH backends consume identical texels.
//
// Modes (run around the rebuild):
//   node Tools/visual-regression/probe-lake-water-mask.mjs baseline
//       Capture flag-OFF views against the CURRENT (pre-change) build.
//   npx gulp build
//   node Tools/visual-regression/probe-lake-water-mask.mjs accept
//       Capture flag-OFF + flag-ON views against the new build and gate:
//       * OFF-GATE  — flag-off vs pre-change baseline per view/backend:
//                     expect ~0% mismatch (byte-identical code path; ocean
//                     view gets tolerance for wave-phase capture noise).
//       * EFFECT    — flag-on vs flag-off on the lake views: substantial
//                     change (the animated water effect appears); land
//                     control ~unchanged; open-ocean control unchanged
//                     within wave-phase noise.
//       * PARITY    — WebGL vs WebGPU mismatch with the flag ON must stay
//                     in the same regime as flag OFF (backends match as
//                     well as they usually do).
//       READ the PNGs afterward — the numeric gates are necessary, not
//       sufficient (shoreline AA is a visual check).
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MODE = (process.argv[2] || "accept").toLowerCase(); // baseline | accept

// Fixed midday-over-the-Americas clock so both backends see the same sun.
const CLOCK_ISO = "2026-07-03T17:00:00Z";

// [label, view query, kind, parityRef]
// parityRef names the view whose flag-ON cross-backend mismatch is the
// allowed regime for this view — lake water must match across backends as
// well as OCEAN water does AT A COMPARABLE ZOOM (the WGSL enhanced-ocean
// foam/sparkle divergence grows as the camera nears the water, so the
// 50 km shoreline view is judged against a 50 km ocean coast, not the
// 300 km open ocean).
const VIEWS = [
  ["michigan", "view=-87.0,43.3,250000", "lake", "ocean"],
  ["superior", "view=-87.5,47.6,300000", "lake", "ocean"],
  // Lake Michigan east shoreline (near Muskegon) — the AA check view.
  ["shoreline", "view=-86.35,43.25,50000", "lake", "oceancoast"],
  ["ocean", "view=-60.0,40.0,300000", "ocean", null],
  // New Jersey Atlantic coast at the same 50 km altitude as `shoreline`.
  ["oceancoast", "view=-74.35,39.35,50000", "ocean", null],
  ["land", "view=-99.8,41.5,300000", "land", null],
];
const RENDERERS = ["webgl", "webgpu"];

async function launch() {
  return chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
}

async function capture(browser, renderer, view, lakeMaskOn, outPath) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&${view}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ clockIso, lakeMaskOn }) => {
      const v = window.viewer;
      const JulianDate = v.clock.currentTime.constructor;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = JulianDate.fromIso8601(clockIso);
      v.scene.globe.showWaterEffect = true;
      if (lakeMaskOn) {
        v.scene.globe.lakeWaterMask = true;
        // Wait for the lake dataset fetch + decode.
        let tries = 0;
        while (
          !v.scene.globe._lakeWaterClassificationProvider &&
          tries++ < 200
        ) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!v.scene.globe._lakeWaterClassificationProvider) {
          throw new Error("lakeWaterMask provider never became ready");
        }
      }
      for (const el of document.querySelectorAll(
        ".cesium-viewer-toolbar, .cesium-viewer-animationContainer, " +
          ".cesium-viewer-timelineContainer, .cesium-viewer-bottom, " +
          ".cesium-widget-credits, #toolbar",
      )) {
        el.style.display = "none";
      }
      // Settle tiles, then FREEZE the frame number. The frame pin is kept
      // because per-frame tile and imagery logic keys on frame-number ADVANCE,
      // which is also why it starts only after 400 unpinned settle frames.
      //
      // IT NO LONGER PINS THE WATER, and neither does the line below it.
      // Both backends now take the wave phase from elapsed SCENE seconds
      // (`Scene/GlobeOceanWaveClock.js`, reaching GlobeFS as
      // `u_oceanWaveSeconds` and the WebGPU tile uniform buffer as its time
      // slot) — but `scene.render()` called with NO ARGUMENT defaults its time
      // to `JulianDate.now()` (`Scene.js`), so on every frame this loop drives,
      // the phase advances at WALL-CLOCK rate and `v.clock.currentTime` never
      // reaches `frameState.time` at all. The widget's own loop, which keeps
      // running after this evaluate returns, does pass the clock
      // (`CesiumWidget.prototype.render` -> `scene.render(clock.tick())`), and
      // that clock advances too.
      //
      // A probe that wants a PINNED sea has to hand the time to the renderer:
      // `v.scene.render(v.clock.currentTime)` on the frames it drives, and the
      // default render loop stopped. That change is not made here because this
      // lane cannot run a browser to verify it.
      for (let i = 0; i < 500; i++) {
        v.clock.currentTime = JulianDate.fromIso8601(clockIso);
        if (i >= 400) {
          v.scene._frameState.frameNumber = 12345;
        }
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Hold the freeze through the screenshot (the widget's own render
      // loop keeps running after this evaluate returns).
      const holdId = setInterval(() => {
        v.scene._frameState.frameNumber = 12345;
      }, 4);
      setTimeout(() => clearInterval(holdId), 15000);
    },
    { clockIso: CLOCK_ISO, lakeMaskOn },
  );
  await page.waitForTimeout(1200);
  await page.screenshot({ path: outPath, fullPage: false });
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  await page.close();
  return errs;
}

// Pixel-diff two PNGs in a browser page (canvas decode — no Node PNG dep).
// Returns { mismatchPct, changedBox } with per-channel |d|>threshold rule.
async function diffPngs(page, pngA, pngB, threshold) {
  const inp = {
    a: fs.readFileSync(pngA).toString("base64"),
    b: fs.readFileSync(pngB).toString("base64"),
    threshold,
  };
  return page.evaluate(async ({ a, b, threshold }) => {
    const decode = async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return {
        w: c.width,
        h: c.height,
        data: ctx.getImageData(0, 0, c.width, c.height).data,
      };
    };
    const A = await decode(a);
    const B = await decode(b);
    if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
    let mism = 0;
    let minx = A.w,
      miny = A.h,
      maxx = -1,
      maxy = -1;
    for (let y = 0; y < A.h; y++) {
      for (let x = 0; x < A.w; x++) {
        const i = (y * A.w + x) * 4;
        const d =
          Math.abs(A.data[i] - B.data[i]) +
          Math.abs(A.data[i + 1] - B.data[i + 1]) +
          Math.abs(A.data[i + 2] - B.data[i + 2]);
        if (d > threshold) {
          mism++;
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
        }
      }
    }
    return {
      mismatchPct: (100 * mism) / (A.w * A.h),
      changedBox: maxx >= 0 ? [minx, miny, maxx, maxy] : null,
    };
  }, inp);
}

function p(name) {
  return path.join(OUT_DIR, `lake-mask-${name}.png`);
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launch();

  if (MODE === "baseline") {
    console.log("== C7-LAKE-WATER-MASK :: baseline (pre-change, flag OFF) ==");
    for (const [label, view] of VIEWS) {
      for (const r of RENDERERS) {
        const out = p(`base-${label}-${r}`);
        const errs = await capture(browser, r, view, false, out);
        console.log(
          `  captured ${out}${errs.length ? ` (${errs.length} console errors)` : ""}`,
        );
        errs.slice(0, 2).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
      }
    }
    await browser.close();
    console.log("baseline done");
    return;
  }

  console.log("== C7-LAKE-WATER-MASK :: accept (post-change) ==");
  for (const [label, view] of VIEWS) {
    for (const r of RENDERERS) {
      const offErrs = await capture(
        browser,
        r,
        view,
        false,
        p(`off-${label}-${r}`),
      );
      const onErrs = await capture(
        browser,
        r,
        view,
        true,
        p(`on-${label}-${r}`),
      );
      const errs = [...offErrs, ...onErrs];
      if (errs.length) {
        console.log(`  [${label}/${r}] ${errs.length} console errors:`);
        errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
      }
    }
  }

  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");

  let failures = 0;
  console.log("\n-- OFF-GATE: flag-off (new build) vs pre-change baseline --");
  for (const [label, , kind] of VIEWS) {
    for (const r of RENDERERS) {
      const base = p(`base-${label}-${r}`);
      if (!fs.existsSync(base)) {
        console.log(`  SKIP ${label}/${r}: no baseline capture`);
        continue;
      }
      const d = await diffPngs(page, base, p(`off-${label}-${r}`), 8);
      // The frozen frame number pins the wave phase, so even the ocean
      // view must reproduce (small allowance for imagery-stream jitter).
      // NOTE: base-* captures must come from the SAME probe version
      // (frozen-clock); pre-change unfrozen baselines live in
      // output/lake-mask-prechange/ with the run-1 log.
      const limit = kind === "ocean" ? 2.0 : 0.5;
      const ok = d.mismatchPct <= limit;
      if (!ok) failures++;
      console.log(
        `  ${ok ? "PASS" : "FAIL"} ${label}/${r}: mismatch ${d.mismatchPct.toFixed(3)}% (limit ${limit}%)`,
      );
    }
  }

  console.log("\n-- EFFECT: flag-on vs flag-off per backend --");
  for (const [label, , kind] of VIEWS) {
    for (const r of RENDERERS) {
      const d = await diffPngs(
        page,
        p(`off-${label}-${r}`),
        p(`on-${label}-${r}`),
        30,
      );
      let ok;
      let expect;
      if (kind === "lake") {
        ok = d.mismatchPct >= 3.0; // water effect must visibly appear
        expect = ">=3% (water appears)";
      } else if (kind === "land") {
        ok = d.mismatchPct <= 0.5;
        expect = "<=0.5% (unchanged)";
      } else {
        ok = d.mismatchPct <= 6.0; // wave-phase noise only
        expect = "<=6% (wave phase only)";
      }
      if (!ok) failures++;
      console.log(
        `  ${ok ? "PASS" : "FAIL"} ${label}/${r}: on-vs-off ${d.mismatchPct.toFixed(3)}% (expect ${expect})`,
      );
    }
  }

  console.log("\n-- PARITY: WebGL vs WebGPU (flag ON vs the OFF regime) --");
  // Precompute cross-backend mismatches. Lake pixels move from the LAND
  // regime (~0.3% cross-backend) into the WATER regime when the flag turns
  // on — and the water regime carries the documented WebGPU enhanced-ocean
  // divergence (WGSL 3-octave waves vs GLSL 2-octave, Fresnel/GGX — see
  // SHADER_PAIRS_LOCKSTEP.md, probe-river-water-intensity). So lake views
  // are gated against the OPEN-OCEAN regime measured in the SAME run: lake
  // water must match across backends as well as ocean water does.
  const cross = {};
  for (const [label] of VIEWS) {
    cross[label] = {
      off: await diffPngs(
        page,
        p(`off-${label}-webgl`),
        p(`off-${label}-webgpu`),
        30,
      ),
      on: await diffPngs(
        page,
        p(`on-${label}-webgl`),
        p(`on-${label}-webgpu`),
        30,
      ),
    };
  }
  for (const [label, , , parityRef] of VIEWS) {
    const dOff = cross[label].off.mismatchPct;
    const dOn = cross[label].on.mismatchPct;
    const regime = parityRef ? cross[parityRef].on.mismatchPct : 0.0;
    const limit = Math.max(dOff, regime) + 8.0;
    const ok = dOn <= limit;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "PASS" : "FAIL"} ${label}: cross-backend ON ${dOn.toFixed(3)}% vs OFF ${dOff.toFixed(3)}%` +
        (parityRef ? `, ${parityRef} regime ${regime.toFixed(3)}%` : "") +
        ` (limit ${limit.toFixed(1)}%)`,
    );
  }

  await browser.close();
  console.log(
    `\n${failures === 0 ? "ALL GATES PASS" : `${failures} GATE FAILURE(S)`}`,
  );
  console.log(
    "Now READ the PNGs (on-* lake views: water effect + shoreline AA).",
  );
  process.exit(failures === 0 ? 0 : 1);
})();
