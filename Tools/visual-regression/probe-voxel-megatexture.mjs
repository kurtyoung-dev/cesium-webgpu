// PARITY-VOXEL-MEGATEXTURE-UPLOAD acceptance probe.
//
// Loads VoxelBox3DTiles on the WebGPU renderer, adds a VoxelPrimitive, and
// ray-marches the volume. Asserts that the REAL per-tile 'a' VEC4 property
// data was uploaded into the 3D megatexture (replacing the 4x4x4 gradient
// placeholder) AND that the volume renders non-empty pixels.
//
// Discriminators the probe checks:
//   1. cache.usingRealData === true and dataUpload.phase === 'done'
//      (the renderer swapped the placeholder for real tile content).
//   2. The uploaded texture dimensions match the tileset's [2,4,3] dims
//      (NOT the placeholder's 4x4x4).
//   3. The ray-march produces non-black pixels (the volume is visible).
//
// A FAIL/partial is reported honestly if only the placeholder still renders.
//
// PART 2 — NEW-VOXEL-STREAMING-UPLOAD (demand-driven descendant upload):
// loads the 3-level custom box provider (voxel-octree-l3 fixture, 73-slot
// atlas) on a fresh WebGPU page and asserts the streaming state machine:
//   FAR view (120R, SSE demand 0): root uploads, but NO descendant tiles do
//     (childSlots all -1, 0 l2 tiles, childPhase still "loading",
//     demandLevel 0) — the pre-B19 eager path would have uploaded all 72.
//   NEAR view (10R, SSE demand 2): level-1 + level-2 tiles STREAM IN on
//     demand (8 childSlots + 64 l2Slots uploaded, childPhase "done",
//     demandLevel 2, lastTargetLevel 2) and the refined volume renders.
//   RETURN-FAR view: demand recedes to 0 (targetLevel back to 0) but the
//     uploaded tiles stay RESIDENT (no eviction until
//     NEW-VOXEL-ATLAS-LRU-EVICT) — the same steady state the eager path
//     converged to (off-gate).
import { chromium } from "playwright";
import fs from "fs";
import { createVoxelOctreeL3Provider } from "./fixtures/voxel-octree-l3.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const consoleErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") consoleErrors.push(t);
  if (t.startsWith("PROBE:")) console.log(t);
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const res = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  if (!C.VoxelPrimitive || !C.Cesium3DTilesVoxelProvider) {
    return { error: "VoxelPrimitive / provider not exported" };
  }

  const provider = await C.Cesium3DTilesVoxelProvider.fromUrl(
    "/Apps/SampleData/Cesium3DTiles/Voxel/VoxelBox3DTiles/tileset.json",
  );
  const providerDims = {
    x: provider.dimensions.x,
    y: provider.dimensions.y,
    z: provider.dimensions.z,
  };
  // PARITY-VOXEL-SHAPE-PARITY (Batch 475) wired the shape/OBB transform into
  // the ray-march: the box is now placed by the provider's own compound
  // transform (an Earth-radius box at the origin for this asset), so the
  // historical 500 km modelMatrix hack + fromDegrees camera no longer frame
  // it. Use identity modelMatrix + the same fixed diagonal ECEF camera the
  // parity probe uses.
  const prim = new C.VoxelPrimitive({ provider });
  scene.primitives.add(prim);

  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  scene.backgroundColor = C.Color.BLACK;

  // Aim the camera at the Earth-sized box from a diagonal pose so the box
  // reads as a bounded silhouette.
  const dest = new C.Cartesian3(
    6378137.0 * 6.0,
    6378137.0 * 4.5,
    6378137.0 * 4.0,
  );
  v.camera.setView({
    destination: dest,
    orientation: {
      direction: C.Cartesian3.normalize(
        C.Cartesian3.negate(dest, new C.Cartesian3()),
        new C.Cartesian3(),
      ),
      up: C.Cartesian3.UNIT_Z,
    },
  });

  // Render many frames so the async root-tile request → glTF process → upload
  // state machine completes and the real-data bind group is swapped in.
  for (let i = 0; i < 300; i++) {
    scene.render();
    await new Promise((r) => setTimeout(r, 16));
  }

  // Inspect the WebGPU cache to confirm real data was uploaded.
  const cache = prim._webgpuCache || {};
  const du = cache.dataUpload || {};
  const upDims = du.texture
    ? {
        w: du.texture.width,
        h: du.texture.height,
        d: du.texture.depthOrArrayLayers,
      }
    : null;
  const upFormat = du.texture ? du.texture.format : null;
  const canvas = scene.canvas;

  return {
    providerDims,
    usingRealData: cache.usingRealData === true,
    uploadPhase: du.phase ?? null,
    uploadDims: upDims,
    uploadFormat: upFormat,
    canvasW: canvas.width,
    canvasH: canvas.height,
  };
});

console.log(JSON.stringify(res, null, 2));

const buf = await page.screenshot();
fs.writeFileSync(
  "Tools/visual-regression/output/probe-voxel-megatexture.png",
  buf,
);
console.log("PNG bytes:", buf.length);
console.log("Console errors:", consoleErrors.length);
if (consoleErrors.length) {
  console.log(consoleErrors.slice(0, 8).join("\n"));
}

// Decode the screenshot PNG back into the page (WebGPU canvases don't read
// reliably via drawImage without preserveDrawingBuffer, but the composited
// Playwright screenshot always contains the rendered frame). Sample the
// center region where the ray-marched cube sits.
const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
const px = await page.evaluate(async (url) => {
  const img = new Image();
  await new Promise((r) => {
    img.onload = r;
    img.src = url;
  });
  const cv = document.createElement("canvas");
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const w = img.width;
  const h = img.height;
  // Sample a centered region (avoids the top toolbar + right help panel).
  const rx = Math.floor(w * 0.28);
  const ry = Math.floor(h * 0.28);
  const rw = Math.floor(w * 0.4);
  const rh = Math.floor(h * 0.4);
  const d = ctx.getImageData(rx, ry, rw, rh).data;
  let nonBlack = 0;
  let maxLum = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const colorSet = new Set();
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] + d[i + 1] + d[i + 2];
    if (lum > 12) {
      nonBlack++;
      sumR += d[i];
      sumG += d[i + 1];
      sumB += d[i + 2];
      colorSet.add(`${d[i] >> 4}_${d[i + 1] >> 4}_${d[i + 2] >> 4}`);
    }
    if (lum > maxLum) maxLum = lum;
  }
  const n = Math.max(1, nonBlack);
  return {
    nonBlackPixels: nonBlack,
    sampled: (d.length / 4) | 0,
    maxLum,
    avgColor: [
      Math.round(sumR / n),
      Math.round(sumG / n),
      Math.round(sumB / n),
    ],
    distinctColors: colorSet.size,
  };
}, dataUrl);
console.log("Pixel analysis:", JSON.stringify(px));

// Verdict. The placeholder gradient (rgba8unorm R=x/G=y/B=z, alpha≈0.5) would
// render a smooth multi-hue ramp; the real 'a' data (rgba32float, dims 2x4x3,
// min[0,0,0,1]..max[1,1,1,1]) renders the actual property structure. We assert
// the uploaded texture is the REAL tile (dims match + phase done + real-data
// flag) AND the ray-march produced visible pixels.
// VOXEL-SHAPEUV-CONVENTION: the texture is sized with the INPUT-orientation
// dimensions — the metadata array's own layout (glTF Y-up for this 3D Tiles
// box asset → provider dims [2,4,3] upload as [2,3,4]). Still a hard
// discriminator against the 4x4x4 placeholder.
const passPart1 =
  !res.error &&
  res.usingRealData === true &&
  res.uploadPhase === "done" &&
  res.uploadDims &&
  res.uploadDims.w === res.providerDims.x &&
  res.uploadDims.h === res.providerDims.z &&
  res.uploadDims.d === res.providerDims.y &&
  px.nonBlackPixels > 500 &&
  consoleErrors.length === 0;
console.log(
  passPart1
    ? "PART 1 (root megatexture upload): PASS"
    : "PART 1 (root megatexture upload): FAIL/PARTIAL",
);
await page.close();

// ---------------------------------------------------------------------------
// PART 2 — NEW-VOXEL-STREAMING-UPLOAD: demand-driven descendant tile upload.
// ---------------------------------------------------------------------------
const page2 = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const consoleErrors2 = [];
page2.on("console", (m) => {
  if (m.type() === "error") consoleErrors2.push(m.text());
});
page2.on("pageerror", (e) => consoleErrors2.push(String(e)));

await page2.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page2.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const stream = await page2.evaluate(
  async ({ providerFactorySrc }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    // eslint-disable-next-line no-new-func
    const makeProvider = new Function(`return (${providerFactorySrc});`)();

    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    scene.skyBox = undefined;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = C.Color.BLACK;
    scene.fog.enabled = false;

    const R = 6378137.0;
    const provider = makeProvider(C, R);
    const prim = new C.VoxelPrimitive({ provider });
    prim.nearestSampling = true;
    scene.primitives.add(prim);

    const setCam = (destX) => {
      v.camera.setView({
        destination: new C.Cartesian3(destX * R, 0, 0),
        orientation: {
          direction: new C.Cartesian3(-1, 0, 0),
          up: new C.Cartesian3(0, 0, 1),
        },
      });
    };
    const renderFrames = async (n) => {
      for (let i = 0; i < n; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }
    };
    const snap = () => {
      const cache = prim._webgpuCache || {};
      const du = cache.dataUpload || {};
      return {
        usingRealData: cache.usingRealData === true,
        phase: du.phase ?? null,
        slotCount: du.slotCount ?? null,
        childPhase: du.childPhase ?? null,
        childUploaded: du.childSlots
          ? Array.from(du.childSlots).filter((s) => s >= 0).length
          : null,
        l2Uploaded: du.l2Slots
          ? Array.from(du.l2Slots).filter((s) => s >= 0).length
          : null,
        demandLevel: du.demandLevel ?? null,
        lastTargetLevel: du.lastTargetLevel ?? null,
      };
    };

    // FAR: root uploads; demand 0 → NO descendant tiles stream.
    setCam(120);
    await renderFrames(300);
    const far = snap();

    // NEAR: demand jumps to 2 → level-1 + level-2 tiles stream in. Poll
    // until fully streamed (bounded).
    setCam(10);
    let near = null;
    for (let iter = 0; iter < 40; iter++) {
      await renderFrames(15);
      near = snap();
      if (near.childPhase === "done" && near.l2Uploaded === 64) {
        break;
      }
    }
    // A few extra frames so lastTargetLevel reflects the fully-uploaded atlas.
    await renderFrames(30);
    near = snap();

    // RETURN-FAR: demand recedes; tiles stay resident (no eviction yet).
    setCam(120);
    await renderFrames(60);
    const returnFar = snap();

    // Back to near for the visible-pixels screenshot.
    setCam(10);
    await renderFrames(30);

    return { far, near, returnFar };
  },
  { providerFactorySrc: createVoxelOctreeL3Provider.toString() },
);

console.log("PART 2 streaming states:", JSON.stringify(stream, null, 2));

const buf2 = await page2.screenshot();
fs.writeFileSync(
  "Tools/visual-regression/output/probe-voxel-megatexture-streaming.png",
  buf2,
);
const px2 = await page2.evaluate(async (url) => {
  const img = new Image();
  await new Promise((r) => {
    img.onload = r;
    img.src = url;
  });
  const cv = document.createElement("canvas");
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const rx = Math.floor(img.width * 0.3);
  const ry = Math.floor(img.height * 0.3);
  const d = ctx.getImageData(
    rx,
    ry,
    Math.floor(img.width * 0.4),
    Math.floor(img.height * 0.4),
  ).data;
  let nonBlack = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] + d[i + 1] + d[i + 2] > 12) nonBlack++;
  }
  return { nonBlackPixels: nonBlack };
}, `data:image/png;base64,${buf2.toString("base64")}`);
console.log("PART 2 near-view pixels:", JSON.stringify(px2));
console.log("PART 2 console errors:", consoleErrors2.length);
if (consoleErrors2.length) {
  console.log(consoleErrors2.slice(0, 8).join("\n"));
}
await page2.close();

// FAR gate: root uploaded (real data bound) but zero descendants streamed —
// the demand-driven discriminator against the pre-B19 eager upload.
const farRootOnly =
  stream.far.usingRealData === true &&
  stream.far.phase === "done" &&
  stream.far.slotCount === 73 &&
  stream.far.childPhase === "loading" &&
  stream.far.childUploaded === 0 &&
  stream.far.l2Uploaded === 0 &&
  stream.far.demandLevel === 0 &&
  stream.far.lastTargetLevel === 0;
// NEAR gate: full stream-in under demand (the eager path's steady state).
const nearStreamed =
  stream.near.childPhase === "done" &&
  stream.near.childUploaded === 8 &&
  stream.near.l2Uploaded === 64 &&
  stream.near.demandLevel === 2 &&
  stream.near.lastTargetLevel === 2;
// RETURN-FAR gate: demand recedes, tiles stay resident (no eviction).
const residentAfterRecede =
  stream.returnFar.demandLevel === 0 &&
  stream.returnFar.lastTargetLevel === 0 &&
  stream.returnFar.childUploaded === 8 &&
  stream.returnFar.l2Uploaded === 64;
const passPart2 =
  farRootOnly &&
  nearStreamed &&
  residentAfterRecede &&
  px2.nonBlackPixels > 500 &&
  consoleErrors2.length === 0;
console.log("farRootOnly (demand 0 → no descendant upload):", farRootOnly);
console.log("nearStreamed (demand 2 → 8+64 tiles stream in):", nearStreamed);
console.log(
  "residentAfterRecede (no eviction, targetLevel back to 0):",
  residentAfterRecede,
);
console.log(
  passPart2
    ? "PART 2 (demand-driven streaming): PASS"
    : "PART 2 (demand-driven streaming): FAIL/PARTIAL",
);

const pass = passPart1 && passPart2;
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL/PARTIAL");

await browser.close();
process.exit(pass ? 0 : 1);
