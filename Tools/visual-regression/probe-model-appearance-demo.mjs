#!/usr/bin/env node
// probe-model-appearance-demo — NEW-WEBGPU-MODEL-APPEARANCE-DEMO acceptance.
// @purpose End-to-end check of the webgpu-model-appearance demo scenario: signature-pixel asserts for color/silhouette/split, off-gate identity, thumbnail.
// @status ACTIVE
//
// Verifies the `webgpu-model-appearance` Sandcastle demo end-to-end on the
// WebGPU backend. New-format gallery main.js (bare `import "cesium"`) can't
// boot standalone on :8080, so — per the probe-pp-library-demo precedent —
// this probe replicates the demo's EXACT scenario (same milk-truck asset,
// same feature drives through the public Model API) inside the CesiumViewer
// page and cycles the demo's toolbar states:
//   (1) the demo's asset path (Apps/SampleData/models/CesiumMilkTruck/
//       CesiumMilkTruck.glb) SERVES,
//   (2) each of the three B483-485 features VISIBLY engages with a
//       signature-pixel assertion (not just "frame changed"):
//         - color red HIGHLIGHT / REPLACE collapse the model's mean green +
//           blue channels (<20) while the baseline truck is yellow/white
//           (healthy g/b); red MIX @0.5 raises mean red vs baseline but
//           keeps g/b alive; MIX @1.0 (the blend-amount slider's endpoint)
//           collapses g/b like REPLACE,
//         - silhouette LIME @6px adds a lime rim (g>150, r<110, b<110 pixel
//           count ≥ 300) that the baseline lacks (<50) — the truck's yellow
//           body has high red so it can't alias into the lime mask,
//         - split LEFT @0.5 empties the right-of-slider half (<2% of its
//           baseline coverage) while the left half keeps ≥50%,
//   (3) OFF-GATE: after resetting all three features to their defaults
//       (color undefined, silhouetteSize 0, split NONE) the frame is
//       BYTE-IDENTICAL to the pre-feature baseline,
//   (4) zero console errors + zero GPU uncapturederrors,
//   (5) writes a 512x384 thumbnail-source JPEG (silhouette+mix state) for
//       the gallery folder, plus a PNG per state for visual READ.
//
// Cross-backend pixel parity of the three features themselves is proven by
// probe-model-color / probe-model-silhouette / probe-model-splitter
// (B483-485); this probe proves the DEMO's wiring (asset, API drives,
// signature visuals, off-state).
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-model-appearance-demo.mjs

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "model-appearance-demo",
);
mkdirSync(OUT_DIR, { recursive: true });

const MODEL_URL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";

// Asset-serves check (the demo's ../../SampleData/... path target).
const head = await fetch(`${BASE}${MODEL_URL}`, { method: "HEAD" });
const assetServes = head.ok;

const W = 1024;
const H = 768;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const consoleErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("favicon")) {
    consoleErrors.push(t.slice(0, 240));
  }
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const out = await page.evaluate(
  async ({ modelUrl }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;

    window.__gpuErrors = [];
    const dev = scene.context._device || scene.context.device;
    if (dev && dev.addEventListener) {
      dev.addEventListener("uncapturederror", (e) => {
        window.__gpuErrors.push(String(e.error && e.error.message));
      });
    }

    // ── demo scene, made deterministic for pixel gates: the interactive
    // demo keeps the globe; the probe isolates the model on black so the
    // signature-pixel masks (lime rim, red tint, split coverage) are exact.
    scene.requestRenderMode = false;
    v.clock.shouldAnimate = false;
    scene.globe.show = false;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = C.Color.BLACK;
    v.imageryLayers.removeAll();
    for (const sel of [
      ".cesium-viewer-toolbar",
      ".cesium-viewer-animationContainer",
      ".cesium-viewer-timelineContainer",
      ".cesium-viewer-bottom",
      ".cesium-navigation-help",
      ".cesium-viewer-fullscreenContainer",
    ]) {
      document.querySelectorAll(sel).forEach((e) => (e.style.display = "none"));
    }

    // ── the demo's model, verbatim (position, scale, asset) ──
    const position = C.Cartesian3.fromDegrees(-123.0744619, 44.0503706, 0.0);
    const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(position);
    const model = await C.Model.fromGltfAsync({
      url: modelUrl,
      modelMatrix: modelMatrix,
      scale: 4.0,
    });
    scene.primitives.add(model);
    for (let i = 0; i < 600 && !model.ready; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // The demo flies to the same bounding-sphere offset; the probe uses the
    // equivalent FIXED pose (flight easing is not frame-deterministic).
    v.camera.viewBoundingSphere(
      model.boundingSphere,
      new C.HeadingPitchRange(
        C.Math.toRadians(35.0),
        C.Math.toRadians(-18.0),
        model.boundingSphere.radius * 3.2,
      ),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

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
          const u8 = new Uint8Array(
            cx.getImageData(0, 0, c.width, c.height).data.buffer,
          );
          let bin = "";
          const chunk = 0x8000;
          for (let i = 0; i < u8.length; i += chunk) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
          }
          resolve({
            w: c.width,
            h: c.height,
            b64: btoa(bin),
            png: off.toDataURL("image/png"),
          });
        });
      });
    const settleAndGrab = async () => {
      let prev = await grab();
      for (let i = 0; i < 30; i++) {
        await renderFrames(8);
        const cur = await grab();
        if (prev.b64 === cur.b64) return cur;
        prev = cur;
      }
      return prev;
    };

    await renderFrames(60);

    const captures = {};
    // ── the demo's toolbar states, driven through the same public API ──
    captures.baseline = await settleAndGrab();

    // Color: red HIGHLIGHT
    model.color = C.Color.RED;
    model.colorBlendMode = C.ColorBlendMode.HIGHLIGHT;
    model.colorBlendAmount = 0.5;
    await renderFrames(10);
    captures.colorHighlight = await settleAndGrab();

    // Color: red REPLACE
    model.colorBlendMode = C.ColorBlendMode.REPLACE;
    await renderFrames(10);
    captures.colorReplace = await settleAndGrab();

    // Color: red MIX @ 0.5 (the blend-amount slider's default)
    model.colorBlendMode = C.ColorBlendMode.MIX;
    model.colorBlendAmount = 0.5;
    await renderFrames(10);
    captures.colorMixHalf = await settleAndGrab();

    // Blend-amount slider endpoint: MIX @ 1.0 == pure color
    model.colorBlendAmount = 1.0;
    await renderFrames(10);
    captures.colorMixFull = await settleAndGrab();

    // Color menu back to "none (default)"
    model.color = undefined;
    await renderFrames(10);

    // Silhouette: lime @ 6px (menu + size slider)
    model.silhouetteColor = C.Color.LIME;
    model.silhouetteSize = 6.0;
    await renderFrames(10);
    captures.silhouette = await settleAndGrab();

    // Thumbnail-source state: red MIX + lime silhouette together
    model.color = C.Color.RED;
    model.colorBlendMode = C.ColorBlendMode.MIX;
    model.colorBlendAmount = 0.5;
    await renderFrames(10);
    captures.thumbSource = await settleAndGrab();
    // 512x384 JPEG for the gallery thumbnail
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = 512;
    thumbCanvas.height = 384;
    {
      const img = new Image();
      await new Promise((resolve) => {
        img.onload = resolve;
        img.src = captures.thumbSource.png;
      });
      const tcx = thumbCanvas.getContext("2d");
      // center-crop to 4:3 before scaling
      const srcAspect = img.width / img.height;
      const dstAspect = 512 / 384;
      let sx = 0;
      let sy = 0;
      let sw = img.width;
      let sh = img.height;
      if (srcAspect > dstAspect) {
        sw = img.height * dstAspect;
        sx = (img.width - sw) / 2;
      } else {
        sh = img.width / dstAspect;
        sy = (img.height - sh) / 2;
      }
      tcx.drawImage(img, sx, sy, sw, sh, 0, 0, 512, 384);
    }
    const thumbJpeg = thumbCanvas.toDataURL("image/jpeg", 0.85);
    model.color = undefined;
    model.silhouetteSize = 0.0;
    await renderFrames(10);

    // Split: LEFT @ 0.5 (menu + split-position slider)
    model.splitDirection = C.SplitDirection.LEFT;
    scene.splitPosition = 0.5;
    await renderFrames(10);
    captures.splitLeft = await settleAndGrab();

    // Back to the demo's defaults — all three features off
    model.splitDirection = C.SplitDirection.NONE;
    await renderFrames(10);
    captures.restored = await settleAndGrab();

    return { captures, thumbJpeg, gpuErrors: window.__gpuErrors };
  },
  { modelUrl: MODEL_URL },
);

await browser.close();

// ---- adjudicate ----
function savePng(name, img) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(img.png.split(",")[1], "base64"),
  );
}
function raw(img) {
  return Buffer.from(img.b64, "base64"); // RGBA rows, w*h*4
}

const SKIP_TOP = 60; // CesiumViewer renderer badge overlays the canvas top

// Mean RGB over model pixels (lum > 12), like probe-model-color.
function meanModelColor(img) {
  const d = raw(img);
  let n = 0,
    r = 0,
    g = 0,
    b = 0;
  for (let y = SKIP_TOP; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      const lum = d[i] + d[i + 1] + d[i + 2];
      if (lum > 12) {
        n++;
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
      }
    }
  }
  return n
    ? {
        n,
        r: +(r / n).toFixed(1),
        g: +(g / n).toFixed(1),
        b: +(b / n).toFixed(1),
      }
    : { n: 0, r: 0, g: 0, b: 0 };
}

// Lime-rim signature: green-dominant pixels the yellow truck can't produce.
function limeCount(img) {
  const d = raw(img);
  let n = 0;
  for (let y = SKIP_TOP; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (d[i + 1] > 150 && d[i] < 110 && d[i + 2] < 110) n++;
    }
  }
  return n;
}

// Model coverage (lum > 12) per canvas half, for the split gate.
function halfCoverage(img) {
  const d = raw(img);
  const mid = Math.floor(img.w / 2);
  let left = 0,
    right = 0;
  for (let y = SKIP_TOP; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] > 12) {
        if (x < mid) left++;
        else right++;
      }
    }
  }
  return { left, right };
}

function diffBytes(a, b) {
  const A = raw(a);
  const B = raw(b);
  if (A.length !== B.length) return -1;
  let n = 0;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) n++;
  return n;
}

const fails = [];
if (!assetServes) fails.push(`asset does not serve: ${MODEL_URL}`);

for (const [name, img] of Object.entries(out.captures)) {
  savePng(`demo-${name}.png`, img);
}
writeFileSync(
  join(OUT_DIR, "thumbnail.jpg"),
  Buffer.from(out.thumbJpeg.split(",")[1], "base64"),
);

const cap = out.captures;
const baseMean = meanModelColor(cap.baseline);
console.log(
  `baseline model px=${baseMean.n} mean rgb=(${baseMean.r},${baseMean.g},${baseMean.b})`,
);
if (baseMean.n < 5000)
  fails.push(
    `baseline model coverage too small (${baseMean.n} px) — model not rendering`,
  );
// baseline truck is yellow/white: healthy green + blue means
if (!(baseMean.g > 30 && baseMean.b > 30)) {
  fails.push(
    "baseline is channel-collapsed — scene not in the expected default state",
  );
}

// (2a) color signatures
for (const key of ["colorHighlight", "colorReplace", "colorMixFull"]) {
  const m = meanModelColor(cap[key]);
  console.log(
    `${key.padEnd(14)} model px=${m.n} mean rgb=(${m.r},${m.g},${m.b})`,
  );
  if (!(m.g < 20 && m.b < 20)) {
    fails.push(
      `${key}: green/blue not collapsed (g=${m.g} b=${m.b}) — red tint not applied`,
    );
  }
  if (m.n < baseMean.n * 0.5) {
    fails.push(
      `${key}: model coverage collapsed (${m.n} vs baseline ${baseMean.n})`,
    );
  }
}
{
  const m = meanModelColor(cap.colorMixHalf);
  console.log(`colorMixHalf   model px=${m.n} mean rgb=(${m.r},${m.g},${m.b})`);
  if (!(m.r > baseMean.r + 5)) {
    fails.push(
      `colorMixHalf: mean red ${m.r} not raised vs baseline ${baseMean.r}`,
    );
  }
  if (!(m.g < baseMean.g - 5 && m.g > 5)) {
    fails.push(
      `colorMixHalf: mean green ${m.g} not in the half-mix band (baseline ${baseMean.g})`,
    );
  }
}

// (2b) silhouette signature
{
  const baseLime = limeCount(cap.baseline);
  const rimLime = limeCount(cap.silhouette);
  console.log(`lime px baseline=${baseLime} silhouette=${rimLime}`);
  if (baseLime >= 50)
    fails.push(`baseline already has ${baseLime} lime px — mask invalid`);
  if (rimLime < 300)
    fails.push(`silhouette: lime rim too small (${rimLime} px)`);
}

// (2c) split signature
{
  const baseHalf = halfCoverage(cap.baseline);
  const splitHalf = halfCoverage(cap.splitLeft);
  console.log(
    `coverage baseline L=${baseHalf.left} R=${baseHalf.right} | splitLeft L=${splitHalf.left} R=${splitHalf.right}`,
  );
  if (baseHalf.right < 500) {
    fails.push(
      "baseline has no right-half coverage — camera pose can't discriminate the split",
    );
  }
  if (splitHalf.right > baseHalf.right * 0.02) {
    fails.push(
      `splitLeft: right half not emptied (${splitHalf.right} vs baseline ${baseHalf.right})`,
    );
  }
  if (splitHalf.left < baseHalf.left * 0.5) {
    fails.push(
      `splitLeft: left half lost coverage (${splitHalf.left} vs baseline ${baseHalf.left})`,
    );
  }
}

// (3) OFF-GATE: defaults restored ⇒ byte-identical to baseline
{
  const d = diffBytes(cap.restored, cap.baseline);
  console.log(
    `off-gate restored vs baseline: ${d === 0 ? "BYTE-IDENTICAL" : `diffBytes=${d}`}`,
  );
  if (d !== 0)
    fails.push(
      `off-gate: restored not byte-identical to baseline (diffBytes=${d})`,
    );
}

// (4) zero errors
const allErrors = [...consoleErrors, ...out.gpuErrors];
if (allErrors.length)
  fails.push(`errors: ${allErrors.slice(0, 3).join(" | ")}`);

console.log(`assetServes=${assetServes} errors=${allErrors.length}`);
console.log(`PNGs + thumbnail: ${OUT_DIR}`);
console.log(fails.length ? `FAILS:\n  ${fails.join("\n  ")}` : "");
console.log(fails.length ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
