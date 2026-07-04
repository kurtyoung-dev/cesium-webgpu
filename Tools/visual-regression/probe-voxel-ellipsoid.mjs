// NEW-VOXEL-ELLIPSOID-INTERSECT acceptance probe (B22, increment 1/2).
//
// Renders the SAME procedural ELLIPSOID-shape VoxelPrimitive (oblate radii —
// per-axis radii correction is part of what's under test) on BOTH the WebGL
// and the WebGPU renderer at an identical fixed camera, then compares the
// footprint/silhouette masks.
//
// What it verifies:
//   * The WebGPU ray-march intersects the ELLIPSOID SHELL (outer ellipsoid at
//     radii + maxHeight), not the box OBB proxy: pre-fix the WebGPU
//     silhouette is the OBB box (a squarish blob ~27%+ larger than the
//     ellipse), post-fix it is the same ellipse WebGL renders. Footprint IoU
//     and coverage-area ratio are the discriminators.
//   * Real data uploads + the color pipeline swaps to the customShader-parity
//     variant on the WebGPU path (same plumbing as BOX providers).
//   * Zero console/device errors on both backends.
//
// NOT gated here (B23 NEW-VOXEL-ELLIPSOID-SHAPEUV): interior per-cell content
// addressing — the sample coordinate still derives through the box-affine
// fallback this increment, so interior colors are reported but not asserted.
//
// Reads BOTH PNGs (writes them to output/) so the operator can eyeball the
// shell silhouette.
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

// Oblate ellipsoid: x/y radius R, z radius 0.6 R, shell heights 0..1e6 m.
const R = 6378137.0;
const CAMERA = {
  // Oblique so the oblateness reads in the silhouette (an axis-on view would
  // degenerate to a circle and weaken the box-vs-ellipse discriminator).
  destinationXYZ: [R * 2.6, R * 1.9, R * 1.7],
};

async function capture(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(
    async ({ camera, R }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      // Strip everything that would differ between backends so the diff is
      // dominated by the voxel shell itself.
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      // Procedural single-tile ELLIPSOID provider (the Sandcastle voxels-demo
      // construction): bounds are (longitude, latitude, height); the radii
      // come from the globalTransform scale. Oblate on purpose.
      const dims = { x: 8, y: 8, z: 8 };
      const voxelCount = dims.x * dims.y * dims.z;
      const data = new Float32Array(voxelCount * 4);
      for (let i = 0; i < voxelCount; i++) {
        const d = i * 4;
        data[d] = 0.5;
        data[d + 1] = 0.55;
        data[d + 2] = 0.6;
        data[d + 3] = 1.0; // every cell filled — the SHELL geometry is the gate
      }
      const provider = {
        shape: C.VoxelShapeType.ELLIPSOID,
        minBounds: new C.Cartesian3(-Math.PI, -Math.PI / 2, 0.0),
        maxBounds: new C.Cartesian3(Math.PI, Math.PI / 2, 1000000.0),
        dimensions: new C.Cartesian3(dims.x, dims.y, dims.z),
        names: ["color"],
        types: [C.MetadataType.VEC4],
        componentTypes: [C.MetadataComponentType.FLOAT32],
        globalTransform: C.Matrix4.fromScale(
          new C.Cartesian3(R, R, R * 0.6),
        ),
        availableLevels: 1,
        requestData: function (options) {
          if (options.tileLevel >= 1) {
            return Promise.reject("single tile");
          }
          return Promise.resolve(C.VoxelContent.fromMetadataArray([data]));
        },
      };

      const prim = new C.VoxelPrimitive({ provider });
      prim.nearestSampling = true;
      scene.primitives.add(prim);

      v.camera.setView({
        destination: new C.Cartesian3(
          camera.destinationXYZ[0],
          camera.destinationXYZ[1],
          camera.destinationXYZ[2],
        ),
        orientation: {
          direction: C.Cartesian3.normalize(
            C.Cartesian3.negate(
              new C.Cartesian3(
                camera.destinationXYZ[0],
                camera.destinationXYZ[1],
                camera.destinationXYZ[2],
              ),
              new C.Cartesian3(),
            ),
            new C.Cartesian3(),
          ),
          up: C.Cartesian3.UNIT_Z,
        },
      });

      // Render enough frames for the async provider resolve + the WebGPU
      // root-tile upload state machine + the parity pipeline swap.
      for (let i = 0; i < 240; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 12));
      }

      const cache = prim._webgpuCache || null;
      const du = (cache && cache.dataUpload) || null;
      return {
        renderer: scene.context.rendererType || null,
        usingRealData: cache ? cache.usingRealData === true : null,
        uploadPhase: du ? du.phase : null,
        colorDescName:
          cache && cache.colorDescriptor ? cache.colorDescriptor.name : null,
      };
    },
    { camera: CAMERA, R },
  );

  const buf = await page.screenshot();
  fs.writeFileSync(`${OUT}/probe-voxel-ellipsoid-${renderer}.png`, buf);

  // Decode the PNG back into the page to build a coarse non-black mask over a
  // centered region (same harness as probe-voxel-parity.mjs).
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
    const rx = Math.floor(w * 0.2);
    const ry = Math.floor(h * 0.2);
    const rw = Math.floor(w * 0.55);
    const rh = Math.floor(h * 0.6);
    const d = ctx.getImageData(rx, ry, rw, rh).data;
    const GW = 64;
    const GH = 48;
    const mask = new Uint8Array(GW * GH);
    let nonBlack = 0;
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const sx = rx + Math.floor((gx / GW) * rw);
        const sy = ry + Math.floor((gy / GH) * rh);
        const dd = ctx.getImageData(sx, sy, 1, 1).data;
        if (dd[0] + dd[1] + dd[2] > 20) {
          mask[gy * GW + gx] = 1;
          nonBlack++;
        }
      }
    }
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] + d[i + 1] + d[i + 2] > 20) {
        sr += d[i];
        sg += d[i + 1];
        sb += d[i + 2];
        n++;
      }
    }
    const nn = Math.max(1, n);
    return {
      mask: Array.from(mask),
      maskCells: nonBlack,
      avgColor: [Math.round(sr / nn), Math.round(sg / nn), Math.round(sb / nn)],
      coveragePct: (n / (d.length / 4)) * 100,
    };
  }, dataUrl);

  await page.close();
  return { info, px, consoleErrors };
}

const webgl = await capture("webgl");
const webgpu = await capture("webgpu");
await browser.close();

console.log("WebGL  info:", JSON.stringify(webgl.info));
console.log("WebGPU info:", JSON.stringify(webgpu.info));
console.log(
  "WebGL  px:",
  JSON.stringify({
    maskCells: webgl.px.maskCells,
    avgColor: webgl.px.avgColor,
    coveragePct: webgl.px.coveragePct.toFixed(2),
  }),
);
console.log(
  "WebGPU px:",
  JSON.stringify({
    maskCells: webgpu.px.maskCells,
    avgColor: webgpu.px.avgColor,
    coveragePct: webgpu.px.coveragePct.toFixed(2),
  }),
);
console.log("WebGL  console errors:", webgl.consoleErrors.length);
console.log("WebGPU console errors:", webgpu.consoleErrors.length);
if (webgl.consoleErrors.length) {
  console.log("  WebGL:", webgl.consoleErrors.slice(0, 5).join("\n  "));
}
if (webgpu.consoleErrors.length) {
  console.log("  WebGPU:", webgpu.consoleErrors.slice(0, 5).join("\n  "));
}

// Footprint IoU — the primary shell-silhouette discriminator. A box OBB
// silhouette against WebGL's ellipse lands well under the gate (the box's
// extra corner area both shrinks the intersection share and inflates the
// union); the fixed shell tracks the ellipse closely.
let inter = 0;
let uni = 0;
const a = webgl.px.mask;
const b = webgpu.px.mask;
for (let i = 0; i < a.length; i++) {
  if (a[i] && b[i]) inter++;
  if (a[i] || b[i]) uni++;
}
const iou = uni > 0 ? inter / uni : 0;

// Projected-area ratio — a box circumscribing the ellipse is ≥ ~27% larger
// (4/π for a sphere; more for the oblique oblate view), so require the two
// coverage areas to agree within 15%.
const covGL = webgl.px.coveragePct;
const covGPU = webgpu.px.coveragePct;
const areaRatioDelta = covGL > 0 ? Math.abs(covGPU - covGL) / covGL : 1;

console.log("---");
console.log("Footprint IoU (WebGL ∩ WebGPU):", iou.toFixed(3));
console.log(
  "Coverage areas (GL vs GPU):",
  covGL.toFixed(2),
  covGPU.toFixed(2),
  `delta ${(areaRatioDelta * 100).toFixed(1)}%`,
);

const bothRender = webgl.px.maskCells > 200 && webgpu.px.maskCells > 200;
const bounded =
  covGL < 92 && covGPU < 92 && covGL > 8 && covGPU > 8;
const footprintMatch = iou >= 0.85;
const areaMatch = areaRatioDelta <= 0.15;
const gpuParityPipeline =
  webgpu.info.usingRealData === true &&
  typeof webgpu.info.colorDescName === "string" &&
  webgpu.info.colorDescName.includes("customShader");
const noErrors =
  webgl.consoleErrors.length === 0 && webgpu.consoleErrors.length === 0;

console.log("---");
console.log("bothRender:", bothRender);
console.log("bounded (both 8%<coverage<92%):", bounded);
console.log("footprintMatch (IoU>=0.85):", footprintMatch);
console.log("areaMatch (|ΔA|/A<=15%):", areaMatch);
console.log("gpuParityPipeline (real data + parity color pipeline):", gpuParityPipeline);
console.log("noErrors:", noErrors);

const pass =
  bothRender &&
  bounded &&
  footprintMatch &&
  areaMatch &&
  gpuParityPipeline &&
  noErrors;
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
process.exit(pass ? 0 : 1);
