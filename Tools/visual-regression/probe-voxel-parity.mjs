// PARITY-VOXEL-SHAPE-PARITY acceptance probe.
// @purpose Acceptance: the WebGPU voxel box renders at the correct world placement/extent (footprint IoU + color structure vs WebGL), not a flat quad.
// @status ACTIVE
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

// ---------------------------------------------------------------------------
// Part B — VOXEL-SHAPEUV-CONVENTION per-cell sample-frame scenario.
//
// Renders a CUSTOM single-tile box provider (dims 2×4×3, metadataOrder Y_UP —
// the same glTF-order convention the 3D Tiles voxel asset uses) whose alpha
// fills an axis-ASYMMETRIC staircase of cells:
//   filled(x,y,z) = (x==1 && y==z && y<=2) || (x==0 && y==3 && z==1)
// in the Z-up shape frame. Any axis swap / flip / mis-scale in the WebGPU
// sample-coordinate derivation rearranges WHICH cells appear filled on screen,
// so asserting the per-cell fill layout against WebGL verifies the sampled-cell
// frame — not just the aggregate footprint.
//
// WebGL renders with a customShader exposing the per-cell property color +
// alpha (its megatexture path is the ground truth). The WebGPU path renders
// its default gray with alpha-gated density — the assertion is the per-cell
// FILL LAYOUT (which cell regions are lit), identical on both backends.
//
// Expectations are derived per-ray IN-PAGE by sampling the exact camera→target
// ray against the authored cell grid (no hand-derived visibility reasoning);
// rays that merely graze a filled cell (<2% of in-box samples) are skipped.
// ---------------------------------------------------------------------------

const CELL_DIMS = { x: 2, y: 4, z: 3 };

function cellFilled(x, y, z) {
  return (x === 1 && y === z && y <= 2) || (x === 0 && y === 3 && z === 1);
}

async function captureCells(renderer) {
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

  const setupInfo = await page.evaluate(
    async ({ dims, filledSrc }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      // eslint-disable-next-line no-new-func
      const filled = new Function(`return (${filledSrc});`)();

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const R = 6378137.0;
      // Author the metadata in INPUT (glTF Y-up) order: a Z-up cell (x,y,z)
      // lands at input cell (x, z, dimsY-1-y), i.e. index
      // x + dimsX*(z + dimsZ*(dimsY-1-y)) — the inverse of Octree.glsl's
      // Y_UP_METADATA_ORDER + SHAPE_BOX swap/flip.
      const voxelCount = dims.x * dims.y * dims.z;
      const data = new Float32Array(voxelCount * 4);
      for (let z = 0; z < dims.z; z++) {
        for (let y = 0; y < dims.y; y++) {
          for (let x = 0; x < dims.x; x++) {
            const idx = x + dims.x * (z + dims.z * (dims.y - 1 - y));
            const d = idx * 4;
            data[d] = 0.35 + 0.65 * x;
            data[d + 1] = 0.15 + 0.28 * y;
            data[d + 2] = 0.2 + 0.4 * z;
            data[d + 3] = filled(x, y, z) ? 1.0 : 0.0;
          }
        }
      }

      const provider = {
        shape: C.VoxelShapeType.BOX,
        minBounds: new C.Cartesian3(-1, -1, -1),
        maxBounds: new C.Cartesian3(1, 1, 1),
        dimensions: new C.Cartesian3(dims.x, dims.y, dims.z),
        names: ["color"],
        types: [C.MetadataType.VEC4],
        componentTypes: [C.MetadataComponentType.FLOAT32],
        globalTransform: C.Matrix4.fromScale(new C.Cartesian3(R, R, R)),
        availableLevels: 1,
        metadataOrder: C.VoxelMetadataOrder.Y_UP,
        requestData: function (options) {
          if (options.tileLevel >= 1) {
            return Promise.reject("single tile");
          }
          return Promise.resolve(C.VoxelContent.fromMetadataArray([data]));
        },
      };

      // WebGL ground truth: expose the per-cell property color + alpha. The
      // WebGPU path ignores the customShader (default gray, alpha-gated) —
      // the comparison below is the per-cell FILL LAYOUT.
      const customShader = new C.CustomShader({
        fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    material.diffuse = fsInput.metadata.color.rgb;
    material.alpha = fsInput.metadata.color.a;
}`,
      });

      const prim = new C.VoxelPrimitive({ provider, customShader });
      prim.nearestSampling = true;
      scene.primitives.add(prim);

      for (let i = 0; i < 240; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }

      const cache = prim._webgpuCache || null;
      const du = (cache && cache.dataUpload) || null;
      window.__voxelProbe = { C, scene, prim, R, dims, filled };
      return {
        usingRealData: cache ? cache.usingRealData === true : null,
        uploadPhase: du ? du.phase : null,
        hasConvention: du ? !!du.convention : null,
        conventionYUp:
          du && du.convention ? du.convention.yUpBox === true : null,
      };
    },
    {
      dims: CELL_DIMS,
      filledSrc: cellFilled.toString(),
    },
  );

  // One view = set the camera, render, screenshot, then project each cell
  // target to window coords and analytically ray-sample the expected fill.
  async function captureView(name, dest, dir, up, targets) {
    const proj = await page.evaluate(
      async ({ dest, dir, up, targets }) => {
        const { C, scene, R, dims, filled } = window.__voxelProbe;
        window.viewer.camera.setView({
          destination: new C.Cartesian3(dest[0] * R, dest[1] * R, dest[2] * R),
          orientation: {
            direction: new C.Cartesian3(dir[0], dir[1], dir[2]),
            up: new C.Cartesian3(up[0], up[1], up[2]),
          },
        });
        for (let i = 0; i < 40; i++) {
          scene.render();
          await new Promise((r) => setTimeout(r, 8));
        }
        const out = [];
        for (const t of targets) {
          const world = new C.Cartesian3(t.p[0] * R, t.p[1] * R, t.p[2] * R);
          const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
          // Analytic expectation: sample the camera→target ray uniformly
          // inside the box and record the fraction of in-box samples landing
          // in filled cells (Z-up frame).
          const cam = window.viewer.camera.positionWC;
          const o = [cam.x / R, cam.y / R, cam.z / R];
          const q = [t.p[0], t.p[1], t.p[2]];
          const dv = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
          const len = Math.hypot(dv[0], dv[1], dv[2]);
          const rd = [dv[0] / len, dv[1] / len, dv[2] / len];
          let inBox = 0;
          let inFilled = 0;
          const S = 4000;
          const tMax = len * 3;
          for (let i = 0; i < S; i++) {
            const tt = (i / S) * tMax;
            const px = o[0] + rd[0] * tt;
            const py = o[1] + rd[1] * tt;
            const pz = o[2] + rd[2] * tt;
            if (px < -1 || px > 1 || py < -1 || py > 1 || pz < -1 || pz > 1) {
              continue;
            }
            inBox++;
            const cx = Math.min(
              dims.x - 1,
              Math.floor(((px + 1) / 2) * dims.x),
            );
            const cy = Math.min(
              dims.y - 1,
              Math.floor(((py + 1) / 2) * dims.y),
            );
            const cz = Math.min(
              dims.z - 1,
              Math.floor(((pz + 1) / 2) * dims.z),
            );
            if (filled(cx, cy, cz)) {
              inFilled++;
            }
          }
          const frac = inBox > 0 ? inFilled / inBox : 0;
          out.push({
            label: t.label,
            win: win ? [win.x, win.y] : null,
            filledFrac: frac,
            expected: frac >= 0.02 ? "filled" : frac === 0 ? "empty" : "skip",
          });
        }
        return out;
      },
      { dest, dir, up, targets },
    );

    const buf = await page.screenshot();
    fs.writeFileSync(`${OUT}/probe-voxel-cells-${renderer}-${name}.png`, buf);
    const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    const samples = await page.evaluate(
      async ({ url, points }) => {
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
        return points.map((pt) => {
          if (!pt) {
            return null;
          }
          const x = Math.round(pt[0]);
          const y = Math.round(pt[1]);
          const half = 3;
          const d = ctx.getImageData(
            x - half,
            y - half,
            2 * half + 1,
            2 * half + 1,
          ).data;
          let sr = 0;
          let sg = 0;
          let sb = 0;
          const n = d.length / 4;
          for (let i = 0; i < d.length; i += 4) {
            sr += d[i];
            sg += d[i + 1];
            sb += d[i + 2];
          }
          return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
        });
      },
      { url: dataUrl, points: proj.map((p) => p.win) },
    );

    return proj.map((p, i) => ({ ...p, rgb: samples[i] }));
  }

  const R1 = 1.0;
  const cy = (y) => -R1 + ((y + 0.5) * 2 * R1) / CELL_DIMS.y;
  const cz = (z) => -R1 + ((z + 0.5) * 2 * R1) / CELL_DIMS.z;
  const cx = (x) => -R1 + ((x + 0.5) * 2 * R1) / CELL_DIMS.x;

  // Front view (+X looking −X): the Y (horizontal) × Z (vertical) cell layout.
  const frontTargets = [];
  for (let z = 0; z < CELL_DIMS.z; z++) {
    for (let y = 0; y < CELL_DIMS.y; y++) {
      frontTargets.push({ label: `y${y}z${z}`, p: [0, cy(y), cz(z)] });
    }
  }
  const front = await captureView(
    "front",
    [4, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    frontTargets,
  );

  // Top view (+Z looking −Z): the X × Y cell layout (catches X mirroring the
  // front view cannot see).
  const topTargets = [];
  for (let y = 0; y < CELL_DIMS.y; y++) {
    for (let x = 0; x < CELL_DIMS.x; x++) {
      topTargets.push({ label: `x${x}y${y}`, p: [cx(x), cy(y), 0] });
    }
  }
  const top = await captureView(
    "top",
    [0, 0, 4],
    [0, 0, -1],
    [0, 1, 0],
    topTargets,
  );

  await page.close();
  return { setupInfo, front, top, consoleErrors };
}

function judgeCells(name, cells) {
  let pass = true;
  const rows = [];
  for (const c of cells) {
    const lum = c.rgb ? c.rgb[0] + c.rgb[1] + c.rgb[2] : -1;
    let verdict = "skip";
    if (c.expected === "filled") {
      verdict = lum > 40 ? "ok" : "MISSING";
    } else if (c.expected === "empty") {
      verdict = lum < 25 ? "ok" : "SPURIOUS";
    }
    if (verdict === "MISSING" || verdict === "SPURIOUS") {
      pass = false;
    }
    rows.push(
      `${c.label} expect=${c.expected} rgb=${c.rgb ? c.rgb.join(",") : "?"} ${verdict}`,
    );
  }
  console.log(`  [${name}] ${rows.join(" | ")}`);
  return pass;
}

const webgl = await capture("webgl");
const webgpu = await capture("webgpu");

const cellsWebgl = await captureCells("webgl");
const cellsWebgpu = await captureCells("webgpu");
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

const passA =
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
console.log(
  `colorMatch (colorL1 ${colorL1} <= ${COLOR_L1_TOLERANCE}):`,
  colorMatch,
);
console.log(
  `webgpuNeutral (channel spread ${webgpuChannelSpread} <= 40, not green-cast):`,
  webgpuNeutral,
);
console.log(passA ? "PART A (footprint+color): PASS" : "PART A: FAIL");

// Part B — per-cell sample-frame verdict (VOXEL-SHAPEUV-CONVENTION).
console.log("---");
console.log("WebGL  cells setup:", JSON.stringify(cellsWebgl.setupInfo));
console.log("WebGPU cells setup:", JSON.stringify(cellsWebgpu.setupInfo));
console.log("WebGL front:");
const glFrontOk = judgeCells("webgl-front", cellsWebgl.front);
console.log("WebGPU front:");
const gpFrontOk = judgeCells("webgpu-front", cellsWebgpu.front);
console.log("WebGL top:");
const glTopOk = judgeCells("webgl-top", cellsWebgl.top);
console.log("WebGPU top:");
const gpTopOk = judgeCells("webgpu-top", cellsWebgpu.top);
const cellErrors =
  cellsWebgl.consoleErrors.length + cellsWebgpu.consoleErrors.length;
if (cellErrors > 0) {
  console.log(
    "  cell-scenario console errors:",
    cellsWebgl.consoleErrors.slice(0, 3),
    cellsWebgpu.consoleErrors.slice(0, 3),
  );
}
const gpConventionActive =
  cellsWebgpu.setupInfo.usingRealData === true &&
  cellsWebgpu.setupInfo.hasConvention === true &&
  cellsWebgpu.setupInfo.conventionYUp === true;
const passB =
  glFrontOk &&
  gpFrontOk &&
  glTopOk &&
  gpTopOk &&
  gpConventionActive &&
  cellErrors === 0;
console.log("gpConventionActive:", gpConventionActive);
console.log(
  passB
    ? "PART B (per-cell sample frame): PASS"
    : "PART B (per-cell sample frame): FAIL",
);

const pass = passA && passB;
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL/PARTIAL");

process.exit(pass ? 0 : 1);
