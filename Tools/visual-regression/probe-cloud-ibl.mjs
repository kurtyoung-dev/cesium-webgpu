/**
 * Item 4.2 (CLOUD-IBL, Batch 441) verification — cloud-aware dynamic IBL.
 * @purpose B441 cloud-aware IBL gate: overcast dims + flattens model ambient; coverage without the cloudContributesIBL opt-in leaves IBL identical to clear
 * @status ACTIVE
 *
 * Validates that folding procedural cloud cover into the WebGPU dynamic
 * environment map's SH-L2 / IBL ambient DIMS + FLATTENS the ambient that lights
 * a glTF model when the sky is overcast. Renders the SAME metallic/specular
 * test asset as probe-model-ibl, lit ONLY by IBL ambient (punctual sun killed,
 * globe hidden, black background), under three WebGPU configurations:
 *
 *   1. CLEAR     — clouds off (the shipped clear-sky atmosphere env source).
 *   2. OVERCAST  — globe.defaultCloudCollection.enableVolumetric + globe.defaultCloudCollection.volumetric.cloudContributesIBL on,
 *                  cloudCoverage = 1.0 (a dense overcast deck).
 *   3. FLAG-OFF  — cloudCoverage = 1.0 but cloudContributesIBL OFF (and clouds
 *                  NOT rendered, so no visible cloud composite confounds the
 *                  comparison). PARITY CONTROL: must be ~byte-identical to CLEAR
 *                  — proving a high coverage does NOT darken the IBL unless the
 *                  cloudContributesIBL opt-in gate is on.
 *
 * Assertions:
 *   - DIM: OVERCAST mean model luminance < CLEAR (overcast → dimmer ambient).
 *   - FLATTEN: OVERCAST top/bottom brightness RATIO closer to 1 than CLEAR
 *     (overcast → less directional, flatter ambient → top no longer much
 *     brighter than the sides/bottom).
 *   - PARITY: FLAG-OFF byte-identical (or <0.1% mismatch) to CLEAR — the opt-in
 *     gate is genuinely off when cloudContributesIBL is false.
 *   - No WebGPU device errors across all captures.
 *
 * Usage: node Tools/visual-regression/probe-cloud-ibl.mjs
 *   PROBE_BASE (default http://localhost:8080)
 */
import { chromium } from "playwright";
import zlib from "zlib";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODEL = "/Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf";

const HEADING = 0.2;
const PITCH = -0.35;

// One fresh page → one screenshot. `mode` selects the cloud-IBL config.
async function capture(mode) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(
    async ({ modelUrl, heading, pitch, mode }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      for (const sel of [
        ".cesium-viewer-toolbar",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-bottom",
        ".cesium-navigation-help",
        ".cesium-viewer-fullscreenContainer",
      ]) {
        document
          .querySelectorAll(sel)
          .forEach((e) => (e.style.display = "none"));
      }

      // Isolate the model: hide globe + sky atmosphere + skybox → black
      // background so captured non-black pixels are the MODEL only (the visible
      // sky atmosphere differs between clear/overcast scenes and would dominate
      // a whole-canvas luminance metric; the env-cube IBL is generated
      // independently of the visible sky's `show`, so hiding it does not affect
      // the IBL source under test).
      scene.globe.show = false;
      scene.skyBox.show = false;
      if (scene.skyAtmosphere) {
        scene.skyAtmosphere.show = false;
      }
      scene.sun.show = false;
      scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.light = new C.DirectionalLight({
        direction: new C.Cartesian3(0, 0, -1),
        color: C.Color.BLACK,
        intensity: 0.0,
      });

      // Cloud-IBL config. The publish path reads globe flags every frame at the
      // env-effects dispatch (independent of globe.show), so this drives the
      // env-cube darkening even with the globe hidden.
      const globe = scene.globe;
      if (mode === "overcast") {
        globe.defaultCloudCollection.enableVolumetric = true;
        globe.defaultCloudCollection.volumetric.cloudContributesIBL = true;
        globe.defaultCloudCollection.volumetric.cloudCoverage = 1.0;
        globe.defaultCloudCollection.volumetric.cloudDensity = 0.9;
      } else if (mode === "flagOff") {
        // High coverage but the IBL coupling OFF, clouds NOT rendered — isolates
        // the cloudContributesIBL gate (no visible cloud composite to confound
        // the comparison). Must match CLEAR.
        globe.defaultCloudCollection.enableVolumetric = false;
        globe.defaultCloudCollection.volumetric.cloudContributesIBL = false;
        globe.defaultCloudCollection.volumetric.cloudCoverage = 1.0;
        globe.defaultCloudCollection.volumetric.cloudDensity = 0.9;
      } else {
        // clear — everything off (the shipped clear-sky env source).
        globe.defaultCloudCollection.enableVolumetric = false;
        globe.defaultCloudCollection.volumetric.cloudContributesIBL = false;
      }

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 1.0,
      });
      const ibl = model.imageBasedLighting;
      ibl.imageBasedLightingFactor = new C.Cartesian2(1.0, 1.0);
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Let the env manager fill + prefilter + SH-project the cube. Extra frames
      // so the cloud-coverage publish (env-effects dispatch) lands and the
      // coverage-change gate re-fills the cube with the overcast darkening.
      for (let i = 0; i < 240; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      v.camera.viewBoundingSphere(
        model.boundingSphere,
        new C.HeadingPitchRange(
          heading,
          pitch,
          model.boundingSphere.radius * 3.0,
        ),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      for (let i = 0; i < 60; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-ibl", "1");
      return { ready: !!model.ready };
    },
    { modelUrl: MODEL, heading: HEADING, pitch: PITCH, mode },
  );

  const gateArm = await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);

  const png = await page
    .locator('canvas[data-ibl="1"]')
    .screenshot({ type: "png" });
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { w: bmp.width, h: bmp.height, data: Array.from(d) };
  }, Buffer.from(png).toString("base64"));

  await browser.close();
  return {
    ready: info.ready,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
    png,
    decoded,
  };
}

// Sample the dominant background color from the four screen corners (the
// procedural-cloud overcast layer paints a near-uniform sky in the overcast
// case; the clear case is black). The model metric excludes pixels close to
// this background so the cloud BACKGROUND never pollutes the model luminance.
function backgroundColor(img) {
  const corners = [
    0,
    (img.w - 1) * 4,
    (img.h - 1) * img.w * 4,
    ((img.h - 1) * img.w + (img.w - 1)) * 4,
  ];
  let r = 0,
    g = 0,
    b = 0;
  for (const c of corners) {
    r += img.data[c];
    g += img.data[c + 1];
    b += img.data[c + 2];
  }
  return [r / 4, g / 4, b / 4];
}

// True when a pixel is the model (NOT background and NOT the toolbar). The
// toolbar lives in the top ~40px; we skip it. A pixel is "model" when it is
// far enough (per-channel) from the sampled background.
function isModelPixel(img, x, y, bg) {
  if (y < 44) return false; // skip the WebGL/WebGPU/Split toolbar strip
  const i = (y * img.w + x) * 4;
  const dr = Math.abs(img.data[i] - bg[0]);
  const dg = Math.abs(img.data[i + 1] - bg[1]);
  const db = Math.abs(img.data[i + 2] - bg[2]);
  // 18/channel separates the dark teal cube from both the black (clear) and the
  // flat grey-blue (overcast cloud) backgrounds.
  return dr + dg + db > 54;
}

// Mean luminance over the MODEL pixels only (background-masked).
function meanLuminance(img) {
  const bg = backgroundColor(img);
  let sum = 0,
    n = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (!isModelPixel(img, x, y, bg)) continue;
      const i = (y * img.w + x) * 4;
      sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
      n++;
    }
  }
  return n ? sum / n : 0;
}

// Top-half vs bottom-half mean luminance — directionality of the ambient. A
// directional clear sky brightens the world-up-facing top of the model; a flat
// overcast dome lights all facets more evenly (ratio → 1).
function topBottomRatio(img) {
  const bg = backgroundColor(img);
  let topSum = 0,
    topN = 0,
    botSum = 0,
    botN = 0;
  const half = (img.h / 2) | 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (!isModelPixel(img, x, y, bg)) continue;
      const i = (y * img.w + x) * 4;
      const lum = img.data[i] + img.data[i + 1] + img.data[i + 2];
      if (y < half) {
        topSum += lum;
        topN++;
      } else {
        botSum += lum;
        botN++;
      }
    }
  }
  const top = topN ? topSum / topN : 0;
  const bottom = botN ? botSum / botN : 0;
  return { top, bottom, ratio: bottom > 0 ? top / bottom : 0 };
}

function diffPixels(a, b) {
  let modelPx = 0,
    mismatch = 0;
  if (a.w !== b.w || a.h !== b.h) {
    return { modelPx: 0, mismatch: 0, mismatchPct: null };
  }
  for (let i = 0; i < a.data.length; i += 4) {
    const aLum = a.data[i] + a.data[i + 1] + a.data[i + 2];
    const bLum = b.data[i] + b.data[i + 1] + b.data[i + 2];
    if (aLum > 12 || bLum > 12) {
      modelPx++;
      if (
        Math.abs(a.data[i] - b.data[i]) > 4 ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > 4 ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > 4
      ) {
        mismatch++;
      }
    }
  }
  return {
    modelPx,
    mismatch,
    mismatchPct: modelPx ? +((100 * mismatch) / modelPx).toFixed(3) : null,
  };
}

// ── PNG encoder (zlib stored deflate) — zero external dep ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePNG({ w, h, data }) {
  const bpr = w * 4;
  const raw = Buffer.alloc((bpr + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (bpr + 1)] = 0;
    Buffer.from(data.slice(y * bpr, (y + 1) * bpr)).copy(
      raw,
      y * (bpr + 1) + 1,
    );
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const tb = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([tb, body])), 0);
    return Buffer.concat([len, tb, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Captures ──
const clear = await capture("clear");
const overcast = await capture("overcast");
const flagOff = await capture("flagOff");

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
fs.writeFileSync(
  "Tools/visual-regression/output/cloud-ibl-clear.png",
  encodePNG(clear.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/cloud-ibl-overcast.png",
  encodePNG(overcast.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/cloud-ibl-flagOff.png",
  encodePNG(flagOff.decoded),
);

const clearLum = meanLuminance(clear.decoded);
const overcastLum = meanLuminance(overcast.decoded);
const clearTB = topBottomRatio(clear.decoded);
const overcastTB = topBottomRatio(overcast.decoded);
const parityFlagOff = diffPixels(clear.decoded, flagOff.decoded);
const overcastVsClear = diffPixels(clear.decoded, overcast.decoded);

const gateErrors = [
  ...clear.gateErrors,
  ...overcast.gateErrors,
  ...flagOff.gateErrors,
];
const deviceLost =
  clear.deviceLost || overcast.deviceLost || flagOff.deviceLost;

const dimFactor = clearLum > 0 ? overcastLum / clearLum : 1;
// "Flatness": how much closer overcast's top/bottom ratio is to 1 than clear's.
const clearDir = Math.abs(clearTB.ratio - 1);
const overcastDir = Math.abs(overcastTB.ratio - 1);

const report = {
  ready: {
    clear: clear.ready,
    overcast: overcast.ready,
    flagOff: flagOff.ready,
  },
  gateArmed: clear.gateArmed,
  gateErrors,
  deviceLost,
  consoleFaults: clear.consoleFaults.slice(0, 5),
  meanLuminance: {
    clear: +clearLum.toFixed(1),
    overcast: +overcastLum.toFixed(1),
    dimFactor: +dimFactor.toFixed(3),
  },
  directionality: {
    clearTopBottomRatio: +clearTB.ratio.toFixed(3),
    overcastTopBottomRatio: +overcastTB.ratio.toFixed(3),
    clearDirectionality: +clearDir.toFixed(3),
    overcastDirectionality: +overcastDir.toFixed(3),
  },
  overcastVsClear_mismatchPct: overcastVsClear.mismatchPct,
  parity_flagOff_vs_clear: parityFlagOff,
};
console.log(JSON.stringify(report, null, 2));

// Gates:
//  - all ready, no device errors
//  - DIM: overcast clearly dimmer than clear (dimFactor < 0.9)
//  - FLATTEN: overcast less directional than clear (overcastDir < clearDir)
//  - the overcast image actually differs from clear (the coupling is live)
//  - PARITY: flag-off ≈ clear (<0.1% mismatch — the gate is genuinely off)
const pass =
  clear.ready &&
  overcast.ready &&
  flagOff.ready &&
  gateErrors.length === 0 &&
  !deviceLost &&
  dimFactor < 0.9 &&
  overcastDir < clearDir &&
  overcastVsClear.mismatchPct !== null &&
  overcastVsClear.mismatchPct > 1.0 &&
  parityFlagOff.mismatchPct !== null &&
  parityFlagOff.mismatchPct < 0.1;

console.log(
  pass
    ? "GATE PASS — overcast cloud cover DIMS + FLATTENS the model IBL ambient; cloudContributesIBL=false is byte-parity with clear sky"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
