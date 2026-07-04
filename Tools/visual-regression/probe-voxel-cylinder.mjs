// NEW-VOXEL-CYLINDER-SHAPEUV (B24) acceptance probe.
//
// Renders the SAME procedural CYLINDER-shape VoxelPrimitive (hollow — a
// nonzero inner radius exercises the inner-cylinder hole interval AND the
// radial scale/offset shapeUv terms) on BOTH the WebGL and the WebGPU
// renderer at an identical fixed camera, then compares the
// footprint/silhouette masks AND the per-cell sampled colors.
//
// What it verifies:
//   * Intersection — the WebGPU ray-march intersects the BOUNDED CYLINDER
//     (outer radius x height slab, minus the inner-radius hole), not the box
//     OBB proxy: footprint IoU and coverage-area ratio are the
//     discriminators (a box silhouette against WebGL's rounded side + flat
//     caps lands well under the gate).
//   * shapeUv — interior per-cell content addressing: every voxel cell
//     carries a DISTINCT color (R = radius index, G = angle index,
//     B = height index) surfaced through a dual-language (GLSL +
//     native-WGSL) customShader, so the rendered color pattern IS the
//     radial/angle/height shapeUv mapping. Pre-B24 the WebGPU sample
//     coordinate derived through the box-affine `p + 0.5` fallback — a
//     completely different pattern from WebGL's cylindrical chain; post-B24
//     the per-grid-cell colors match. Gates: interior-cell color match
//     fraction + a WebGL-side color variance floor proving the gate
//     discriminates.
//   * Real data uploads + the color pipeline swaps to the USER-customShader
//     variant on the WebGPU path.
//   * Zero console/device errors on both backends.
//
// Reads BOTH PNGs (writes them to output/) so the operator can eyeball the
// cylinder silhouette + the radius/angle color pattern.
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

// Cylinder: outer radius R, inner radius 0.3 R (hollow), half-height 0.5 R.
const R = 6378137.0;
const CAMERA = {
  // Oblique so the rounded side AND a cap read in the silhouette (an
  // axis-on view would degenerate to a disc and weaken the box-vs-cylinder
  // discriminator).
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
      // dominated by the voxel cylinder itself.
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      // Procedural single-tile CYLINDER provider: bounds are (radius, angle,
      // height); the world extents come from the globalTransform scale.
      // Hollow (minBounds.x = 0.3) so the inner-radius hole interval + the
      // radial scale/offset terms are exercised.
      // NEW-VOXEL-CYLINDER-SHAPEUV — every cell gets a DISTINCT color:
      // R encodes the radius index, G the angle index, B the height index.
      // The visible surface pattern is then exactly the shapeUv mapping
      // under test.
      const dims = { x: 8, y: 8, z: 8 };
      const voxelCount = dims.x * dims.y * dims.z;
      const data = new Float32Array(voxelCount * 4);
      for (let k = 0; k < dims.z; k++) {
        for (let j = 0; j < dims.y; j++) {
          for (let i = 0; i < dims.x; i++) {
            const d = (i + dims.x * (j + dims.y * k)) * 4;
            data[d] = i / (dims.x - 1);
            data[d + 1] = j / (dims.y - 1);
            data[d + 2] = k / (dims.z - 1);
            data[d + 3] = 1.0;
          }
        }
      }
      const provider = {
        shape: C.VoxelShapeType.CYLINDER,
        minBounds: new C.Cartesian3(0.3, -Math.PI, -1.0),
        maxBounds: new C.Cartesian3(1.0, Math.PI, 1.0),
        dimensions: new C.Cartesian3(dims.x, dims.y, dims.z),
        names: ["color"],
        types: [C.MetadataType.VEC4],
        componentTypes: [C.MetadataComponentType.FLOAT32],
        globalTransform: C.Matrix4.fromScale(
          new C.Cartesian3(R, R, R * 0.5),
        ),
        availableLevels: 1,
        requestData: function (options) {
          if (options.tileLevel >= 1) {
            return Promise.reject("single tile");
          }
          return Promise.resolve(C.VoxelContent.fromMetadataArray([data]));
        },
      };

      // The SAME authored mapping in both languages: unlit metadata color,
      // opaque — the rendered pattern is purely the sample-coordinate chain.
      const customShader = new C.CustomShader({
        fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    material.diffuse = fsInput.metadata.color.rgb;
    material.alpha = 1.0;
}`,
        wgslFragmentShaderText: `fn czm_voxelCustomFragmentMain(fsInput: czm_voxelCustomFragmentInput,
    material: ptr<function, czm_voxelCustomMaterial>) {
  (*material).diffuse = fsInput.metadata.color.xyz;
  (*material).alpha = 1.0;
}`,
      });

      const prim = new C.VoxelPrimitive({ provider, customShader });
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
  fs.writeFileSync(`${OUT}/probe-voxel-cylinder-${renderer}.png`, buf);

  // Decode the PNG back into the page to build a coarse mask + per-grid-cell
  // color record over a centered region (same harness as
  // probe-voxel-ellipsoid.mjs).
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
    const cellRGB = new Array(GW * GH).fill(null);
    let nonBlack = 0;
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const sx = rx + Math.floor((gx / GW) * rw);
        const sy = ry + Math.floor((gy / GH) * rh);
        const dd = ctx.getImageData(sx, sy, 1, 1).data;
        if (dd[0] + dd[1] + dd[2] > 20) {
          mask[gy * GW + gx] = 1;
          cellRGB[gy * GW + gx] = [dd[0], dd[1], dd[2]];
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
      GW,
      GH,
      mask: Array.from(mask),
      cellRGB,
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

// Footprint IoU — the primary silhouette discriminator. A box OBB silhouette
// against WebGL's rounded side + caps lands well under the gate; the bounded
// cylinder tracks it closely.
let inter = 0;
let uni = 0;
const a = webgl.px.mask;
const b = webgpu.px.mask;
for (let i = 0; i < a.length; i++) {
  if (a[i] && b[i]) inter++;
  if (a[i] || b[i]) uni++;
}
const iou = uni > 0 ? inter / uni : 0;

// Projected-area ratio.
const covGL = webgl.px.coveragePct;
const covGPU = webgpu.px.coveragePct;
const areaRatioDelta = covGL > 0 ? Math.abs(covGPU - covGL) / covGL : 1;

// Per-grid-cell color comparison over INTERIOR cells (all 4-neighbors masked
// in BOTH captures, keeping the silhouette-edge sampling noise out of the
// gate). A cell matches when the RGB Euclidean distance is under the
// tolerance; the box-affine pre-B24 mapping produces a wholly different
// radius/angle layout and fails hard.
const GW = webgl.px.GW;
const GH = webgl.px.GH;
let interiorCells = 0;
let matchedCells = 0;
let distSum = 0;
const glR = [];
const glG = [];
for (let gy = 1; gy < GH - 1; gy++) {
  for (let gx = 1; gx < GW - 1; gx++) {
    const idx = gy * GW + gx;
    const nbr = [idx - 1, idx + 1, idx - GW, idx + GW];
    const interior =
      a[idx] &&
      b[idx] &&
      nbr.every((nIdx) => a[nIdx] && b[nIdx]);
    if (!interior) continue;
    const ca = webgl.px.cellRGB[idx];
    const cb = webgpu.px.cellRGB[idx];
    if (!ca || !cb) continue;
    interiorCells++;
    glR.push(ca[0]);
    glG.push(ca[1]);
    const dist = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
    distSum += dist;
    if (dist < 60) matchedCells++;
  }
}
const matchFrac = interiorCells > 0 ? matchedCells / interiorCells : 0;
const meanDist = interiorCells > 0 ? distSum / interiorCells : 999;
const stddev = (arr) => {
  if (arr.length === 0) return 0;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length);
};
// Variance floor: the WebGL reference itself must show the radius/angle
// gradient (distinct R + G across the surface) or the color gate would be
// vacuous.
const glSpread = stddev(glR) + stddev(glG);

console.log("---");
console.log("Footprint IoU (WebGL ∩ WebGPU):", iou.toFixed(3));
console.log(
  "Coverage areas (GL vs GPU):",
  covGL.toFixed(2),
  covGPU.toFixed(2),
  `delta ${(areaRatioDelta * 100).toFixed(1)}%`,
);
console.log(
  "Per-cell colors: interior cells",
  interiorCells,
  "matched",
  matchedCells,
  `(${(matchFrac * 100).toFixed(1)}%)`,
  "meanDist",
  meanDist.toFixed(1),
  "GL R+G spread",
  glSpread.toFixed(1),
);

const bothRender = webgl.px.maskCells > 200 && webgpu.px.maskCells > 200;
const bounded =
  covGL < 92 && covGPU < 92 && covGL > 8 && covGPU > 8;
const footprintMatch = iou >= 0.85;
const areaMatch = areaRatioDelta <= 0.15;
// The color pipeline must be the USER-customShader variant (the probe
// supplies a dual-language customShader) on real data.
const gpuParityPipeline =
  webgpu.info.usingRealData === true &&
  typeof webgpu.info.colorDescName === "string" &&
  webgpu.info.colorDescName.includes("userCustomShader");
const cellColorsMatch = interiorCells >= 100 && matchFrac >= 0.85;
const colorGateDiscriminates = glSpread > 30;
const noErrors =
  webgl.consoleErrors.length === 0 && webgpu.consoleErrors.length === 0;

console.log("---");
console.log("bothRender:", bothRender);
console.log("bounded (both 8%<coverage<92%):", bounded);
console.log("footprintMatch (IoU>=0.85):", footprintMatch);
console.log("areaMatch (|ΔA|/A<=15%):", areaMatch);
console.log(
  "gpuParityPipeline (real data + user customShader pipeline):",
  gpuParityPipeline,
);
console.log(
  "cellColorsMatch (>=100 interior cells, >=85% match):",
  cellColorsMatch,
);
console.log("colorGateDiscriminates (GL R+G spread > 30):", colorGateDiscriminates);
console.log("noErrors:", noErrors);

const pass =
  bothRender &&
  bounded &&
  footprintMatch &&
  areaMatch &&
  gpuParityPipeline &&
  cellColorsMatch &&
  colorGateDiscriminates &&
  noErrors;
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
process.exit(pass ? 0 : 1);
