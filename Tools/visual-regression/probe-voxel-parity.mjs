// PARITY-VOXEL-SHAPE-PARITY acceptance probe.
//
// Captures the SAME VoxelBox3DTiles VoxelPrimitive on BOTH the WebGL and the
// WebGPU renderer at an IDENTICAL camera, then pixel-diffs the two frames.
//
// What it verifies (resolves the Batch-474 open blocker):
//   * The WebGPU ray-march renders the voxel BOX at the correct WORLD
//     position / orientation / extent — i.e. the same screen footprint as
//     WebGL — NOT a flat, mis-placed quad. This is the increment-2 fix: the
//     shape/OBB transform is now wired into the ray-march (via the effective
//     model matrix derived from the shape's oriented bounding box).
//   * The colour structure (which hues appear inside the footprint) matches
//     WebGL within a tolerance.
//   * Zero device / console errors on both backends.
//
// The two renderers are NOT pixel-identical: WebGL runs the full octree
// traversal + megatexture; the WebGPU path (Batch 474) uploads only the ROOT
// tile. So the acceptance criterion is *footprint + colour-structure overlap*,
// not an exact diff. IoU (intersection-over-union) of the non-black masks is
// the primary discriminator; a mis-placed flat quad would have near-zero IoU.
//
// Reads BOTH PNGs (writes them to output/) so the operator can eyeball the box
// shape/placement.
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

// A fixed camera (ECEF destination + orientation) computed once so BOTH
// renderers view the Earth-sized voxel box from exactly the same pose. The
// VoxelBox3DTiles box is centered at the Earth's origin with WGS84-radius
// half-extents, so we sit well outside it looking back at the origin.
const CAMERA = {
  // Far enough out that the Earth-sized voxel box reads as a bounded silhouette
  // against black (not a full-frame fill) so the footprint IoU is a meaningful
  // shape-parity discriminator, and offset off-axis so the box shows an angled
  // 3-D silhouette (edges + corners) rather than a face-on flat quad.
  destinationXYZ: [6378137.0 * 6.0, 6378137.0 * 4.5, 6378137.0 * 4.0],
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
    async ({ camera }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      if (!C.VoxelPrimitive || !C.Cesium3DTilesVoxelProvider) {
        return { error: "VoxelPrimitive / provider not exported" };
      }

      // Strip everything that would differ between backends so the diff is
      // dominated by the voxel box itself.
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const provider = await C.Cesium3DTilesVoxelProvider.fromUrl(
        "/Apps/SampleData/Cesium3DTiles/Voxel/VoxelBox3DTiles/tileset.json",
      );
      // Default modelMatrix (identity) — the provider's globalTransform places
      // the Earth-sized box. This is the same construction the Sandcastle demo
      // uses, so WebGL and WebGPU get identical placement inputs.
      const prim = new C.VoxelPrimitive({ provider });
      prim.nearestSampling = true;
      scene.primitives.add(prim);

      // Identical fixed camera pose for both backends.
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

      // Render enough frames for the async voxel provider/traversal + the
      // WebGPU root-tile upload state machine to complete.
      for (let i = 0; i < 300; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 16));
      }

      const cache = prim._webgpuCache || null;
      const du = (cache && cache.dataUpload) || null;
      return {
        renderer: scene.context.rendererType || null,
        usingRealData: cache ? cache.usingRealData === true : null,
        uploadPhase: du ? du.phase : null,
        // PARITY-VOXEL-COLOR-PARITY — confirm the COLOR pipeline was swapped to
        // the customShader-parity variant (the label carries the define) and
        // the drawn command is bound to it. `cmdPipelineIsColor === false`
        // would mean the command is still on the stale placeholder pipeline
        // (the raw-texel green path).
        colorDescName:
          cache && cache.colorDescriptor ? cache.colorDescriptor.name : null,
        cmdPipelineLabel:
          cache && cache.command && cache.command.pipeline
            ? cache.command.pipeline.label || "no-label"
            : null,
        cmdPipelineIsColor:
          cache && cache.command && cache.pipeline
            ? cache.command.pipeline === cache.pipeline
            : null,
        obb: prim.orientedBoundingBox
          ? {
              cx: prim.orientedBoundingBox.center.x,
              cy: prim.orientedBoundingBox.center.y,
              cz: prim.orientedBoundingBox.center.z,
            }
          : null,
      };
    },
    { camera: CAMERA },
  );

  const buf = await page.screenshot();
  fs.writeFileSync(`${OUT}/probe-voxel-parity-${renderer}.png`, buf);

  // Decode the PNG back into the page to sample the centered scene region.
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
    // Sample a centered region that avoids the top toolbar + right help panel.
    const rx = Math.floor(w * 0.2);
    const ry = Math.floor(h * 0.2);
    const rw = Math.floor(w * 0.55);
    const rh = Math.floor(h * 0.6);
    const d = ctx.getImageData(rx, ry, rw, rh).data;
    // Build a coarse boolean mask (non-black) so we can compute IoU against
    // the other backend. Downsample to a 64x48 grid for a compact comparison.
    const GW = 64;
    const GH = 48;
    const mask = new Uint8Array(GW * GH);
    const colorSet = new Set();
    let nonBlack = 0;
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const sx = rx + Math.floor((gx / GW) * rw);
        const sy = ry + Math.floor((gy / GH) * rh);
        const dd = ctx.getImageData(sx, sy, 1, 1).data;
        const lum = dd[0] + dd[1] + dd[2];
        if (lum > 20) {
          mask[gy * GW + gx] = 1;
          nonBlack++;
          colorSet.add(`${dd[0] >> 5}_${dd[1] >> 5}_${dd[2] >> 5}`);
        }
      }
    }
    // Region average color over non-black pixels (full-res region).
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i] + d[i + 1] + d[i + 2];
      if (lum > 20) {
        sr += d[i];
        sg += d[i + 1];
        sb += d[i + 2];
        n++;
      }
    }
    const nn = Math.max(1, n);
    return {
      mask: Array.from(mask),
      gw: GW,
      gh: GH,
      maskCells: nonBlack,
      distinctColors: colorSet.size,
      avgColor: [Math.round(sr / nn), Math.round(sg / nn), Math.round(sb / nn)],
      coveragePct: (n / (d.length / 4)) * 100,
    };
  }, dataUrl);

  await page.close();
  return { info, px, consoleErrors, pngBytes: buf.length };
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
    distinctColors: webgl.px.distinctColors,
    avgColor: webgl.px.avgColor,
    coveragePct: webgl.px.coveragePct.toFixed(2),
  }),
);
console.log(
  "WebGPU px:",
  JSON.stringify({
    maskCells: webgpu.px.maskCells,
    distinctColors: webgpu.px.distinctColors,
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

// IoU of the two coarse non-black masks — the primary footprint discriminator.
let inter = 0;
let uni = 0;
const a = webgl.px.mask;
const b = webgpu.px.mask;
for (let i = 0; i < a.length; i++) {
  const av = a[i];
  const bv = b[i];
  if (av && bv) inter++;
  if (av || bv) uni++;
}
const iou = uni > 0 ? inter / uni : 0;

// Color-structure delta: L1 distance between the two region average colors.
const ac = webgl.px.avgColor;
const bc = webgpu.px.avgColor;
const colorL1 =
  Math.abs(ac[0] - bc[0]) + Math.abs(ac[1] - bc[1]) + Math.abs(ac[2] - bc[2]);

console.log("---");
console.log("Footprint IoU (WebGL ∩ WebGPU):", iou.toFixed(3));
console.log("Avg-color L1 distance:", colorL1);

// Verdict.
//
// PRIMARY gate (this task = shape/OBB placement parity): a correctly
// shaped+placed WebGPU box overlaps the WebGL footprint heavily (high IoU) and
// leaves a non-trivial amount of BLACK background (so the box is a bounded
// silhouette, not a full-frame fill that would make IoU trivially 1.0). A flat
// mis-placed quad (the pre-fix defect: a tiny [-0.5,0.5] cube at the ECEF
// origin) would have near-zero footprint overlap with WebGL's Earth-sized box.
//
// COLOR is reported but NOT a hard gate: WebGL applies its voxel-shader colormap
// over the `a` VEC4 property while the WebGPU root-tile path renders the raw
// RGBA sample, so exact hue parity is a SEPARATE data-path increment (a known
// follow-up, not a shape-parity defect). We assert only that both produce
// color (non-black) — the placement is what this increment fixes.
const bothRender = webgl.px.maskCells > 200 && webgpu.px.maskCells > 200;
// Guard against the trivial full-frame-fill case that makes IoU meaningless:
// require a meaningful black margin on BOTH so the box is a bounded shape.
const bounded =
  webgl.px.coveragePct < 92 &&
  webgpu.px.coveragePct < 92 &&
  webgl.px.coveragePct > 8 &&
  webgpu.px.coveragePct > 8;
const footprintMatch = iou >= 0.85;
const noErrors =
  webgl.consoleErrors.length === 0 && webgpu.consoleErrors.length === 0;

// PARITY-VOXEL-COLOR-PARITY — COLOR is now a HARD gate. The WebGPU ray-march
// applies the default voxel customShader colour mapping + WebGL-matching
// front-to-back accumulation, so the mean colour of the voxel footprint must
// match WebGL's within a tolerance (gray box on BOTH backends, not gray-vs-
// green). Tolerance is generous — WebGL runs the full octree megatexture while
// the WebGPU path uploads only the ROOT tile, so per-voxel sampling differs
// slightly — but a raw-texel green/teal (the pre-fix defect, colorL1 ~433)
// blows well past it while a matched gray sits comfortably under.
const COLOR_L1_TOLERANCE = 90;
const colorMatch = colorL1 <= COLOR_L1_TOLERANCE;
// Also require the WebGPU box to be near-gray (r≈g≈b) — the pre-fix defect was
// a strong green cast (g >> r, b). Max pairwise channel spread guards hue.
const bc2 = webgpu.px.avgColor;
const webgpuChannelSpread =
  Math.max(bc2[0], bc2[1], bc2[2]) - Math.min(bc2[0], bc2[1], bc2[2]);
const webgpuNeutral = webgpuChannelSpread <= 40;

const pass =
  bothRender &&
  bounded &&
  footprintMatch &&
  noErrors &&
  colorMatch &&
  webgpuNeutral;
console.log("---");
console.log("bothRender:", bothRender);
console.log(
  "bounded (both 8%<coverage<92%, box is a silhouette not a fill):",
  bounded,
);
console.log("footprintMatch (IoU>=0.85):", footprintMatch);
console.log("noErrors:", noErrors);
console.log(`colorMatch (colorL1 ${colorL1} <= ${COLOR_L1_TOLERANCE}):`, colorMatch);
console.log(
  `webgpuNeutral (channel spread ${webgpuChannelSpread} <= 40, not green-cast):`,
  webgpuNeutral,
);
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL/PARTIAL");

process.exit(pass ? 0 : 1);
