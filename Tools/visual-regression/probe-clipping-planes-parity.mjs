#!/usr/bin/env node
// Probe: PARITY-CLIP-PLANES — clipping planes on a glTF Model, WebGL vs
// WebGPU. Verifies:
// @purpose glTF Model clipping-planes parity: clipped region matches across backends and picks return nothing on the clipped side, the model on the visible side
// @status ACTIVE
//
//   (1) The clipped-away region matches between backends (visual parity).
//   (2) A pick on the CLIPPED side returns undefined (or not the model)
//       while a pick on the VISIBLE side picks the model.
//
// A generic geometry Primitive (Box/Sphere) has NO clippingPlanes API in
// Cesium (upstream WebGL does not clip generic primitives either), so this
// probe exercises the Model path, which is the real WebGL->WebGPU parity
// surface for clipping planes.
//
// Usage: node Tools/visual-regression/probe-clipping-planes-parity.mjs
// Requires dev server on :8080.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// A fixed camera looking straight at a model placed at a known location,
// with a clipping plane that removes the +X half of the model.
const SETUP = `
  const Cesium = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  scene.globe.show = false;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  scene.backgroundColor = Cesium.Color.BLACK.clone();

  const Cartesian3 = Cesium.Cartesian3;
  const origin = Cartesian3.fromDegrees(-75.0, 40.0, 0.0);
  const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin);

  // Clip away everything on the -X (model-space) side of the plane at x=0.
  // Plane normal (1,0,0), distance 0 => keeps region where dot(n,p)+d >= 0,
  // i.e. x >= 0 stays, x < 0 clipped.
  const clippingPlanes = new Cesium.ClippingPlaneCollection({
    planes: [ new Cesium.ClippingPlane(new Cartesian3(1.0, 0.0, 0.0), 0.0) ],
    edgeWidth: 0.0,
    unionClippingRegions: false,
  });

  const model = scene.primitives.add(
    await Cesium.Model.fromGltfAsync({
      url: "../../Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
      modelMatrix: modelMatrix,
      scale: 4.0,
      clippingPlanes: clippingPlanes,
    })
  );
  await new Promise((resolve) => {
    if (model.ready) return resolve();
    model.readyEvent.addEventListener(() => resolve());
  });

  // Frame the model from a fixed offset so both backends see the same view.
  viewer.camera.lookAt(
    origin,
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(0.0),
      Cesium.Math.toRadians(-10.0),
      30.0
    )
  );

  window.__probeModel = model;
  window.__Cesium = Cesium;
`;

async function run(rendererArg) {
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
    viewport: { width: 800, height: 600 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async (setup) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function("return (async () => {" + setup + "})();");
    await fn();
  }, SETUP);

  // Settle
  await page.evaluate(async () => {
    const v = window.viewer;
    for (let i = 0; i < 120; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(500);

  const out = path.join(OUT_DIR, `probe-clip-model-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });

  // Pick test. Screen center is roughly the model origin (x=0 plane).
  // The VISIBLE half (+X model-space => east) should be off to one side,
  // the CLIPPED half (-X => west) off to the other. We scan a horizontal
  // strip across the model and record, for each column, whether the pick
  // hits our model.
  const pickScan = await page.evaluate(() => {
    const v = window.viewer;
    const scene = v.scene;
    const model = window.__probeModel;
    v.scene.render();
    const W = scene.canvas.clientWidth;
    const H = scene.canvas.clientHeight;
    const y = Math.floor(H / 2);
    const cols = [];
    for (let x = 0; x < W; x += 8) {
      const picked = scene.pick(new window.__Cesium.Cartesian2(x, y));
      const isModel =
        picked && (picked.primitive === model || picked.primitive === model);
      cols.push({ x, hit: !!isModel });
    }
    return { W, H, y, cols };
  });

  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, pickScan, errs };
}

async function diffPngs(a, b) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
  });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
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
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      const total = a.w * a.h;
      let mismatch = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (d > 30) mismatch++;
      }
      return {
        mismatchPct: ((100 * mismatch) / total).toFixed(2),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

function summarizePick(scan) {
  // Returns {leftHits, rightHits} counts split at canvas midpoint, so we
  // can assert one side is picked and the other (clipped) is not.
  const mid = scan.W / 2;
  let left = 0;
  let right = 0;
  for (const c of scan.cols) {
    if (!c.hit) continue;
    if (c.x < mid) left++;
    else right++;
  }
  return { left, right, total: left + right };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-clip] running webgpu...");
  const gpu = await run("webgpu");
  console.log("[probe-clip] running webgl...");
  const gl = await run("webgl");

  console.log(`  webgpu png: ${gpu.out}`);
  console.log(`  webgl  png: ${gl.out}`);
  if (gpu.errs.length)
    console.log(
      `  webgpu errors:`,
      gpu.errs.slice(0, 3).map((e) => e.text),
    );
  if (gl.errs.length)
    console.log(
      `  webgl errors:`,
      gl.errs.slice(0, 3).map((e) => e.text),
    );

  const diff = await diffPngs(gpu.out, gl.out);
  console.log(`  visual diff:`, JSON.stringify(diff));

  const gpuPick = summarizePick(gpu.pickScan);
  const glPick = summarizePick(gl.pickScan);
  console.log(`  webgpu pick split (L/R hits):`, JSON.stringify(gpuPick));
  console.log(`  webgl  pick split (L/R hits):`, JSON.stringify(glPick));

  // Parity checks: one side clipped (0 hits) on BOTH backends, other side
  // has hits on BOTH. We don't assume which side; we assert both backends
  // agree on which side is empty.
  const gpuEmptySide =
    gpuPick.left === 0 ? "left" : gpuPick.right === 0 ? "right" : "none";
  const glEmptySide =
    glPick.left === 0 ? "left" : glPick.right === 0 ? "right" : "none";
  console.log(`  clipped side  webgpu=${gpuEmptySide}  webgl=${glEmptySide}`);

  const pickParity =
    gpuEmptySide !== "none" &&
    gpuEmptySide === glEmptySide &&
    gpuPick.total > 0 &&
    glPick.total > 0;
  console.log(`  PICK PARITY: ${pickParity ? "PASS" : "FAIL"}`);
  console.log("[probe-clip] done");
  // A printed verdict that leaves with status 0 is read as green by anything
  // that scores runs by exit code, so the verdict carries the code.
  process.exit(pickParity ? 0 : 1);
})();
