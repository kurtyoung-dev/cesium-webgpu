#!/usr/bin/env node
// Probe (GLOBE-HDR-GAMMA): globe czm_gammaCorrect under the B479 HDR
// canvas-output path.
//
// WebGL's czm_gammaCorrect (gammaCorrect.glsl) decodes sRGB → linear under
// `#ifdef HDR` and no-ops otherwise. The WGSL globe port was a hard no-op
// (correct for the SDR pipeline) which became wrong once B479's HDR canvas
// mode landed: the tonemap is bypassed and the whole post-process chain
// works in unbounded LINEAR HDR (models already emit linear via the
// derived HDR commands), so the globe's still-gamma-encoded imagery was
// the one inconsistent producer. The fix gates a runtime sRGB → linear
// decode on `camera.hdrControl.x` (frameState.useHDR AND
// context.hdrCanvasOutput — the same effective gate as the pipeline's
// setHDROutputMode).
//
// Method: a SingleTileImageryProvider with two known uniform grays
// (sRGB 100 and 180) drapes the globe. The HDR canvas presents values
// through the display-p3 gamma transfer (verified empirically: clearing
// the rgba16float/extended canvas to 0.5 reads back 127, same as SDR),
// so through the drawImage readback:
//   SDR pass    → region means ≈ the source grays (no-op path)
//   HDR pass    → region means ≈ 255 · (gray/255)^2.2  (single decode)
//   missing fix → HDR means == SDR means
//   double fix  → HDR means ≈ 255 · (gray/255)^4.84
//
// Passes:
//   SDR — default path. Region means asserted ≈ source grays AND the
//         full capture byte-compared against a pre-change baseline
//         (run `--baseline` on the OLD build first) — the off-gate.
//   HDR — scene.highDynamicRange + scene.useHDRCanvasOutput. Asserts the
//         canvas path engaged (context.hdrCanvasOutput), region means
//         match the single-decode expectation, and 0 console/GPU errors.
//
// Usage:
//   node Tools/visual-regression/probe-globe-hdr-gamma.mjs --baseline
//   node Tools/visual-regression/probe-globe-hdr-gamma.mjs
// Env: PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const BASELINE_MODE = process.argv.includes("--baseline");
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "globe-hdr-gamma",
);
mkdirSync(OUT_DIR, { recursive: true });

const GRAY_LEFT = 100; // sRGB gray of the west half of the test tile
const GRAY_RIGHT = 180; // sRGB gray of the east half

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runPass(hdrOn) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ hdr, grayLeft, grayRight }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const context = scene.context;

      window.__gpuErrors = [];
      const dev = context._device || context.device;
      if (dev && dev.addEventListener) {
        dev.addEventListener("uncapturederror", (e) => {
          window.__gpuErrors.push(String(e.error && e.error.message));
        });
      }

      // ---- HDR canvas output (the feature under test) ----
      if (hdr) {
        scene.highDynamicRange = true;
        scene.useHDRCanvasOutput = true;
      }

      // ---- deterministic scene ----
      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T12:00:00Z");
      scene.fog.enabled = false;
      scene.globe.showGroundAtmosphere = false;
      scene.globe.enableLighting = false;
      scene.globe.showWaterEffect = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      scene.terrainProvider = new C.EllipsoidTerrainProvider();
      v.imageryLayers.removeAll();

      // Two-tone test tile: west half sRGB grayLeft, east half grayRight.
      const tile = document.createElement("canvas");
      tile.width = 256;
      tile.height = 256;
      const tcx = tile.getContext("2d");
      tcx.fillStyle = `rgb(${grayLeft},${grayLeft},${grayLeft})`;
      tcx.fillRect(0, 0, 128, 256);
      tcx.fillStyle = `rgb(${grayRight},${grayRight},${grayRight})`;
      tcx.fillRect(128, 0, 128, 256);
      // Full-globe rectangle (the default): the WebGPU globe renders
      // nothing at all for tiles with zero imagery layers, so a partial
      // rectangle (or no layer) leaves the whole globe invisible in this
      // stripped-down scene — a separate pre-existing quirk this probe
      // deliberately avoids.
      const provider = await C.SingleTileImageryProvider.fromUrl(
        tile.toDataURL("image/png"),
      );
      const layer = v.imageryLayers.addImageryProvider(provider);
      layer.gamma = 1.0; // default per-layer gamma → czm_gammaCorrect path
      layer.brightness = 1.0;
      layer.contrast = 1.0;

      // NOTE: no morphTo3D(0) here — the viewer already starts in 3D, and
      // issuing the no-duration morph left the WebGPU globe invisible in
      // this stripped-down scene while the camera/scene state read back
      // as perfectly normal (mode 3, tilesLoaded, straight-down camera).
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(0.0, 0.0, 3500000.0),
        orientation: {
          heading: 0.0,
          pitch: C.Math.toRadians(-90.0),
          roll: 0.0,
        },
      });

      const oncePostRender = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
        });
      const renderFrames = async (n) => {
        for (let i = 0; i < n; i++) await oncePostRender();
      };

      // Strip the async default ion imagery (CesiumViewer adds it late),
      // keep OUR layer, and wait for tiles to settle.
      let stable = 0;
      for (let i = 0; i < 600 && stable < 10; i++) {
        for (let li = v.imageryLayers.length - 1; li >= 0; li--) {
          const l = v.imageryLayers.get(li);
          if (l !== layer) v.imageryLayers.remove(l, true);
        }
        await oncePostRender();
        stable = scene.globe.tilesLoaded ? stable + 1 : 0;
      }
      await renderFrames(20);

      // Cold-browser guard: on the first page of a fresh browser the
      // globe pipelines can still be compiling long after tilesLoaded
      // reports true, leaving a black canvas (stars only). Wait until
      // the straight-down view actually shows the globe before
      // capturing, with a hard cap so a real regression still fails
      // loudly (means ≈ 0 in the assertions) instead of hanging.
      const centerPixel = () => {
        const c = scene.canvas;
        const off = document.createElement("canvas");
        off.width = 8;
        off.height = 8;
        const cx = off.getContext("2d");
        cx.drawImage(
          c,
          (c.width >> 1) - 4,
          (c.height >> 1) - 4,
          8,
          8,
          0,
          0,
          8,
          8,
        );
        const d = cx.getImageData(4, 4, 1, 1).data;
        return (d[0] + d[1] + d[2]) / 3;
      };
      for (let i = 0; i < 60; i++) {
        let visible = false;
        await new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            visible = centerPixel() > 5;
            resolve();
          });
        });
        if (visible) break;
        await renderFrames(20);
      }
      await renderFrames(10);

      const grab = () =>
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
              data: Array.from(
                new Uint8Array(
                  cx.getImageData(0, 0, c.width, c.height).data.buffer,
                ),
              ),
              png: off.toDataURL("image/png"),
              w: c.width,
              h: c.height,
            });
          });
        });
      const capture = await grab();

      // Region means: the two-tone tile spans the whole globe; from
      // 3.5 Mm straight down over (0, 0) the seam meridian runs through
      // screen center (blurred wide by bilinear filtering of the 256-px
      // texture). Sample two patches far left / far right of center,
      // well clear of the seam gradient.
      const region = (img, cx0, cy0, half) => {
        let sum = 0;
        let n = 0;
        for (let y = cy0 - half; y < cy0 + half; y++) {
          for (let x = cx0 - half; x < cx0 + half; x++) {
            const i = 4 * (y * img.w + x);
            sum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
            n++;
          }
        }
        return sum / n;
      };
      const cw = capture.w;
      const ch = capture.h;
      const leftMean = region(capture, Math.round(cw * 0.18), ch >> 1, 40);
      const rightMean = region(capture, Math.round(cw * 0.82), ch >> 1, 40);

      return {
        capture,
        leftMean,
        rightMean,
        hdrFlags: {
          sceneUseHDRCanvasOutput: scene.useHDRCanvasOutput,
          contextHDRCanvasOutput: !!context.hdrCanvasOutput,
          sceneHighDynamicRange: scene.highDynamicRange,
          presentationFormat: context.presentationFormat,
        },
        gpuErrors: window.__gpuErrors,
      };
    },
    { hdr: hdrOn, grayLeft: GRAY_LEFT, grayRight: GRAY_RIGHT },
  );

  await page.close();
  return { ...out, consoleErrors: errors };
}

// ---- helpers ----
function savePng(name, img) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(img.png.split(",")[1], "base64"),
  );
}
function saveBin(name, img) {
  writeFileSync(join(OUT_DIR, name), Buffer.from(Uint8Array.from(img.data)));
}
function diffVsBin(img, binPath) {
  const base = readFileSync(binPath);
  const cur = Buffer.from(Uint8Array.from(img.data));
  if (base.length !== cur.length) {
    return { identical: false, note: `size ${base.length} vs ${cur.length}` };
  }
  let diffBytes = 0;
  let maxDelta = 0;
  for (let i = 0; i < cur.length; i++) {
    const d = Math.abs(cur[i] - base[i]);
    if (d > 0) diffBytes++;
    if (d > maxDelta) maxDelta = d;
  }
  return {
    identical: diffBytes === 0,
    diffBytes,
    maxDelta,
    fracDiff: diffBytes / cur.length,
  };
}
const decode = (g) => 255 * Math.pow(g / 255, 2.2);

// ================= baseline mode =================
if (BASELINE_MODE) {
  console.log("=== BASELINE capture (SDR pass, pre-change build) ===");
  const sdr = await runPass(false);
  await browser.close();
  savePng("baseline-sdr.png", sdr.capture);
  saveBin("baseline-sdr.bin", sdr.capture);
  console.log(
    `SDR region means: left=${sdr.leftMean.toFixed(2)} right=${sdr.rightMean.toFixed(2)} ` +
      `(sources ${GRAY_LEFT} / ${GRAY_RIGHT})`,
  );
  console.log(
    `errors: console=${sdr.consoleErrors.length} gpu=${sdr.gpuErrors.length}`,
  );
  sdr.consoleErrors.slice(0, 5).forEach((e) => console.log("  ERR:", e));
  console.log(`Baseline saved to ${OUT_DIR}`);
  process.exit(0);
}

// ================= verify mode =================
console.log("=== Pass 1: SDR (default path — off-gate) ===");
const sdr = await runPass(false);
console.log("=== Pass 2: HDR canvas output (feature path) ===");
const hdr = await runPass(true);
await browser.close();

savePng("sdr.png", sdr.capture);
savePng("hdr.png", hdr.capture);
console.log("HDR flags:", JSON.stringify(hdr.hdrFlags));

// (A) HDR canvas path engaged on this device?
const engaged =
  hdr.hdrFlags.sceneUseHDRCanvasOutput &&
  hdr.hdrFlags.contextHDRCanvasOutput &&
  hdr.hdrFlags.sceneHighDynamicRange;
console.log(
  `(A) HDR canvas path engaged: ${engaged ? "OK" : "DEVICE-BLOCKED (canvas demoted to SDR)"}`,
);

// (B) SDR pass shows the raw source grays (identity czm_gammaCorrect).
const sdrLeftOK = Math.abs(sdr.leftMean - GRAY_LEFT) <= 6;
const sdrRightOK = Math.abs(sdr.rightMean - GRAY_RIGHT) <= 6;
const bOK = sdrLeftOK && sdrRightOK;
console.log(
  `(B) SDR region means: left=${sdr.leftMean.toFixed(2)} (exp ${GRAY_LEFT}) ` +
    `right=${sdr.rightMean.toFixed(2)} (exp ${GRAY_RIGHT}) ${bOK ? "OK" : "FAIL"}`,
);

// (C) HDR pass = single sRGB→linear decode of the SDR tone (and NOT the
// unchanged/missing or double-decoded value).
let cOK = true;
if (engaged) {
  const cases = [
    ["left", sdr.leftMean, hdr.leftMean],
    ["right", sdr.rightMean, hdr.rightMean],
  ];
  for (const [name, s, h] of cases) {
    const expected = decode(s);
    const single = Math.abs(h - expected) <= 10;
    const notMissing = Math.abs(h - s) >= 20;
    const doubled = 255 * Math.pow(s / 255, 4.84);
    const notDouble = Math.abs(h - doubled) >= 15;
    const ok = single && notMissing && notDouble;
    cOK = cOK && ok;
    console.log(
      `(C) ${name}: hdr=${h.toFixed(2)} expectedSingleDecode=${expected.toFixed(2)} ` +
        `missingWouldBe=${s.toFixed(2)} doubleWouldBe=${doubled.toFixed(2)} ${ok ? "OK" : "FAIL"}`,
    );
  }
} else {
  console.log("(C) skipped (device-blocked)");
}

// (D) zero errors across both passes.
const allErrors = [
  ...sdr.consoleErrors,
  ...sdr.gpuErrors,
  ...hdr.consoleErrors,
  ...hdr.gpuErrors,
];
const dOK = allErrors.length === 0;
console.log(
  `(D) errors: sdr console=${sdr.consoleErrors.length} gpu=${sdr.gpuErrors.length}, ` +
    `hdr console=${hdr.consoleErrors.length} gpu=${hdr.gpuErrors.length} ${dOK ? "OK" : "FAIL"}`,
);
allErrors.slice(0, 10).forEach((e) => console.log("  ERR:", e.slice(0, 300)));

// (E) SDR off-gate: byte-compare vs pre-change baseline.
let eOK;
const binPath = join(OUT_DIR, "baseline-sdr.bin");
if (!existsSync(binPath)) {
  console.log(
    `(E) NO BASELINE (${binPath}) — run --baseline on the pre-change build`,
  );
  eOK = false;
} else {
  const d = diffVsBin(sdr.capture, binPath);
  eOK = d.identical;
  console.log(
    `(E) sdr vs baseline: ${
      d.identical
        ? "BYTE-IDENTICAL"
        : `diffBytes=${d.diffBytes} (${(100 * d.fracDiff).toFixed(4)}%) maxDelta=${d.maxDelta} ${d.note ?? ""}`
    } ${eOK ? "OK" : "FAIL"}`,
  );
}

console.log(`PNGs: ${OUT_DIR}`);
const pass = bOK && cOK && dOK && eOK;
if (!engaged) {
  console.log(
    "NOTE: HDR canvas path did not engage — decode assertions skipped; " +
      "treat as DEVICE-BLOCKED and rely on (B) + off-gate (E).",
  );
}
console.log(pass ? (engaged ? "PASS" : "PASS (DEVICE-BLOCKED)") : "FAIL");
process.exit(pass ? 0 : 1);
