// VOXEL-OCTREE-LOD acceptance probe — depth-1 octree traversal / two-level LOD.
//
// Scenario: a CUSTOM two-level box voxel provider (availableLevels = 2,
// 4x4x4 cells per tile, metadataOrder Y_UP). The level-1 children together
// form a FINE 8x8x8 grid filled along the thin diagonal fy == fz (extruded
// along x); the root tile is the honest conservative downsample — the FAT
// 4x4x4 diagonal y == z (each coarse diagonal block is fully filled).
//
// The discriminator: fine cells like (fy,fz) = (2k, 2k+1) / (2k+1, 2k) are
// EMPTY in the refined (level-1) render but sit INSIDE filled root-diagonal
// blocks, so a root-only render (the pre-change WebGPU state, B476) shows
// them FILLED. The probe:
//
//   CLOSE view (root SSE >> screenSpaceError, both backends refine):
//     * WebGL + WebGPU both must show the THIN fine diagonal — every fine
//       (fy,fz) target must match the analytic per-ray expectation, and at
//       least 4 discriminator targets (empty-at-fine / filled-at-root) must
//       be BLACK on WebGPU. Root-only sampling fails those as SPURIOUS.
//     * WebGPU internals: slotCount = 9 (atlas), all 8 childSlots >= 0,
//       lastTargetLevel = 1.
//   FAR view (root SSE < screenSpaceError):
//     * WebGPU lastTargetLevel = 0 (root path — unchanged from B476), and
//       the WebGL/WebGPU center-crop mean diff stays small.
//   0 console errors on both backends.
//
// Expectations are derived per-ray IN-PAGE by sampling the exact
// camera→target ray against the authored fine + coarse grids (no
// hand-derived visibility reasoning) — same method as probe-voxel-parity
// Part B. READ the output PNGs in Tools/visual-regression/output/.
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

// Per-tile dims (each of the 8 level-1 children AND the root are 4x4x4).
const TILE = 4;
const FINE = TILE * 2; // combined level-1 resolution

// Fine 8x8x8 grid: thin diagonal in (y,z), extruded along x.
function filledFine(fx, fy, fz) {
  return fy === fz;
}
// Root 4x4x4 grid: conservative downsample — coarse block filled iff ANY
// contained fine cell is filled. For the fy==fz diagonal that is Y == Z.
function filledRoot(x, y, z) {
  return y === z;
}

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

  const setupInfo = await page.evaluate(
    async ({ tile, fine, filledFineSrc, filledRootSrc }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      // eslint-disable-next-line no-new-func
      const filledFine = new Function(`return (${filledFineSrc});`)();
      // eslint-disable-next-line no-new-func
      const filledRoot = new Function(`return (${filledRootSrc});`)();

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const R = 6378137.0;

      // Author one tile's 4x4x4 metadata in INPUT (glTF Y-up) order: Z-up
      // cell (x,y,z) lands at input index x + dims*(z + dims*(dims-1-y)) —
      // the inverse of Octree.glsl's Y_UP_METADATA_ORDER + SHAPE_BOX
      // swap/flip (same authoring as probe-voxel-parity Part B).
      function makeTile(fillFn) {
        const data = new Float32Array(tile * tile * tile * 4);
        for (let z = 0; z < tile; z++) {
          for (let y = 0; y < tile; y++) {
            for (let x = 0; x < tile; x++) {
              const idx = x + tile * (z + tile * (tile - 1 - y));
              const d = idx * 4;
              data[d] = 0.7;
              data[d + 1] = 0.7;
              data[d + 2] = 0.7;
              data[d + 3] = fillFn(x, y, z) ? 1.0 : 0.0;
            }
          }
        }
        return data;
      }

      const rootData = makeTile((x, y, z) => filledRoot(x, y, z));
      // Level-1 child (cx,cy,cz): local cell (lx,ly,lz) → fine cell
      // (cx*tile+lx, cy*tile+ly, cz*tile+lz).
      function makeChild(cx, cy, cz) {
        return makeTile((lx, ly, lz) =>
          filledFine(cx * tile + lx, cy * tile + ly, cz * tile + lz),
        );
      }

      const provider = {
        shape: C.VoxelShapeType.BOX,
        minBounds: new C.Cartesian3(-1, -1, -1),
        maxBounds: new C.Cartesian3(1, 1, 1),
        dimensions: new C.Cartesian3(tile, tile, tile),
        names: ["color"],
        types: [C.MetadataType.VEC4],
        componentTypes: [C.MetadataComponentType.FLOAT32],
        globalTransform: C.Matrix4.fromScale(new C.Cartesian3(R, R, R)),
        availableLevels: 2,
        metadataOrder: C.VoxelMetadataOrder.Y_UP,
        requestData: function (options) {
          const level = options.tileLevel ?? 0;
          if (level === 0) {
            return Promise.resolve(C.VoxelContent.fromMetadataArray([rootData]));
          }
          if (level === 1) {
            return Promise.resolve(
              C.VoxelContent.fromMetadataArray([
                makeChild(options.tileX, options.tileY, options.tileZ),
              ]),
            );
          }
          return Promise.reject("no tiles beyond level 1");
        },
      };

      // WebGL ground truth: expose the per-cell alpha (the WebGPU path
      // renders its default gray with alpha-gated density; the comparison is
      // the per-cell FILL LAYOUT, judged by luminance thresholds).
      const customShader = new C.CustomShader({
        fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    material.diffuse = vec3(0.7);
    material.alpha = fsInput.metadata.color.a;
}`,
      });

      const prim = new C.VoxelPrimitive({ provider, customShader });
      prim.nearestSampling = true;
      scene.primitives.add(prim);

      // CLOSE view immediately, so the WebGL traversal's SSE test requests
      // the level-1 children during warm-up.
      window.viewer.camera.setView({
        destination: new C.Cartesian3(10 * R, 0, 0),
        orientation: {
          direction: new C.Cartesian3(-1, 0, 0),
          up: new C.Cartesian3(0, 0, 1),
        },
      });

      for (let i = 0; i < 300; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }

      const cache = prim._webgpuCache || null;
      const du = (cache && cache.dataUpload) || null;
      window.__voxelProbe = { C, scene, prim, R, fine, filledFine, filledRoot };
      return {
        usingRealData: cache ? cache.usingRealData === true : null,
        uploadPhase: du ? du.phase : null,
        slotCount: du ? du.slotCount : null,
        childPhase: du ? du.childPhase : null,
        childSlots: du && du.childSlots ? Array.from(du.childSlots) : null,
        lastTargetLevelClose: du ? du.lastTargetLevel : null,
      };
    },
    {
      tile: TILE,
      fine: FINE,
      filledFineSrc: filledFine.toString(),
      filledRootSrc: filledRoot.toString(),
    },
  );

  // Project each fine-cell target to window coords and analytically
  // ray-sample the expected fill against BOTH grids (fine = expectation,
  // root = discriminator detection).
  async function measureView(name, destX) {
    const proj = await page.evaluate(
      async ({ destX, fine }) => {
        const { C, scene, prim, R, filledFine, filledRoot } =
          window.__voxelProbe;
        window.viewer.camera.setView({
          destination: new C.Cartesian3(destX * R, 0, 0),
          orientation: {
            direction: new C.Cartesian3(-1, 0, 0),
            up: new C.Cartesian3(0, 0, 1),
          },
        });
        for (let i = 0; i < 60; i++) {
          scene.render();
          await new Promise((r) => setTimeout(r, 8));
        }

        // Fine-cell centers on the x = 0 mid-plane, front (y,z) layout.
        const targets = [];
        const cc = (i) => -1 + ((i + 0.5) * 2) / fine;
        for (let fz = 0; fz < fine; fz++) {
          for (let fy = 0; fy < fine; fy++) {
            targets.push({ label: `y${fy}z${fz}`, p: [0, cc(fy), cc(fz)] });
          }
        }

        const cam = window.viewer.camera.positionWC;
        const out = [];
        for (const t of targets) {
          const world = new C.Cartesian3(t.p[0] * R, t.p[1] * R, t.p[2] * R);
          const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
          const o = [cam.x / R, cam.y / R, cam.z / R];
          const dv = [t.p[0] - o[0], t.p[1] - o[1], t.p[2] - o[2]];
          const len = Math.hypot(dv[0], dv[1], dv[2]);
          const rd = [dv[0] / len, dv[1] / len, dv[2] / len];
          let inBox = 0;
          let inFine = 0;
          let inRoot = 0;
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
            const f = (v) => Math.min(fine - 1, Math.floor(((v + 1) / 2) * fine));
            const g = (v) =>
              Math.min(fine / 2 - 1, Math.floor(((v + 1) / 2) * (fine / 2)));
            if (filledFine(f(px), f(py), f(pz))) inFine++;
            if (filledRoot(g(px), g(py), g(pz))) inRoot++;
          }
          const fineFrac = inBox > 0 ? inFine / inBox : 0;
          const rootFrac = inBox > 0 ? inRoot / inBox : 0;
          out.push({
            label: t.label,
            win: win ? [win.x, win.y] : null,
            fineFrac,
            rootFrac,
            expected: fineFrac >= 0.02 ? "filled" : fineFrac === 0 ? "empty" : "skip",
            discriminator: fineFrac === 0 && rootFrac >= 0.05,
          });
        }
        const du = prim._webgpuCache ? prim._webgpuCache.dataUpload : null;
        return { targets: out, lastTargetLevel: du ? du.lastTargetLevel : null };
      },
      { destX, fine: FINE },
    );

    const buf = await page.screenshot();
    fs.writeFileSync(`${OUT}/probe-voxel-octree-${renderer}-${name}.png`, buf);
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
          if (!pt) return null;
          const x = Math.round(pt[0]);
          const y = Math.round(pt[1]);
          const half = 2;
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
      { url: dataUrl, points: proj.targets.map((p) => p.win) },
    );

    // Center-crop mean color (for the far-view backend diff).
    const crop = await page.evaluate(async (url) => {
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
      const rw = Math.floor(img.width * 0.4);
      const rh = Math.floor(img.height * 0.4);
      const d = ctx.getImageData(rx, ry, rw, rh).data;
      const px = [];
      for (let i = 0; i < d.length; i += 4) {
        px.push(d[i], d[i + 1], d[i + 2]);
      }
      return px;
    }, dataUrl);

    return {
      cells: proj.targets.map((p, i) => ({ ...p, rgb: samples[i] })),
      lastTargetLevel: proj.lastTargetLevel,
      crop,
    };
  }

  const close = await measureView("close", 10);
  const far = await measureView("far", 120);

  await page.close();
  return { setupInfo, close, far, consoleErrors };
}

function judgeCells(name, cells) {
  let pass = true;
  let discriminatorsOk = 0;
  let discriminators = 0;
  const failures = [];
  for (const c of cells) {
    const lum = c.rgb ? c.rgb[0] + c.rgb[1] + c.rgb[2] : -1;
    let verdict = "skip";
    if (c.expected === "filled") {
      verdict = lum > 40 ? "ok" : "MISSING";
    } else if (c.expected === "empty") {
      verdict = lum < 25 ? "ok" : "SPURIOUS";
    }
    if (c.discriminator) {
      discriminators++;
      if (verdict === "ok") discriminatorsOk++;
    }
    if (verdict === "MISSING" || verdict === "SPURIOUS") {
      pass = false;
      failures.push(
        `${c.label} expect=${c.expected}${c.discriminator ? " (DISCRIMINATOR)" : ""} rgb=${c.rgb ? c.rgb.join(",") : "?"} ${verdict}`,
      );
    }
  }
  console.log(
    `  [${name}] cells=${cells.length} discriminators=${discriminatorsOk}/${discriminators} failures=${failures.length}`,
  );
  if (failures.length) {
    console.log(`    ${failures.slice(0, 12).join("\n    ")}`);
  }
  return { pass, discriminators, discriminatorsOk };
}

const webgl = await capture("webgl");
const webgpu = await capture("webgpu");
await browser.close();

console.log("WebGL  setup:", JSON.stringify(webgl.setupInfo));
console.log("WebGPU setup:", JSON.stringify(webgpu.setupInfo));
console.log("WebGL  console errors:", webgl.consoleErrors.length);
console.log("WebGPU console errors:", webgpu.consoleErrors.length);
if (webgl.consoleErrors.length) {
  console.log("  WebGL:", webgl.consoleErrors.slice(0, 5).join("\n  "));
}
if (webgpu.consoleErrors.length) {
  console.log("  WebGPU:", webgpu.consoleErrors.slice(0, 5).join("\n  "));
}

console.log("--- CLOSE view (refined) ---");
console.log("WebGL close:");
const glClose = judgeCells("webgl-close", webgl.close.cells);
console.log("WebGPU close:");
const gpClose = judgeCells("webgpu-close", webgpu.close.cells);

// WebGPU internals: real refinement machinery engaged.
const s = webgpu.setupInfo;
const atlasActive =
  s.usingRealData === true &&
  s.slotCount === 9 &&
  s.childPhase === "done" &&
  Array.isArray(s.childSlots) &&
  s.childSlots.every((v) => v >= 0);
const refinedClose = webgpu.close.lastTargetLevel === 1;
const rootFar = webgpu.far.lastTargetLevel === 0;

// FAR view: WebGL-vs-WebGPU center-crop mean abs diff (both render the ROOT
// level; the box is small on screen, so the diff must be tiny).
let farDiff = 0;
{
  const a = webgl.far.crop;
  const b = webgpu.far.crop;
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  farDiff = sum / Math.max(1, n);
}
console.log("--- FAR view (root) ---");
console.log(
  `WebGPU lastTargetLevel: close=${webgpu.close.lastTargetLevel} far=${webgpu.far.lastTargetLevel}`,
);
console.log(`Far-view center-crop mean abs diff: ${farDiff.toFixed(2)}`);

const noErrors =
  webgl.consoleErrors.length === 0 && webgpu.consoleErrors.length === 0;
// The refinement is REAL only if enough discriminator cells (empty at fine,
// filled at root) exist and read black on WebGPU.
const discriminatorsMeaningful =
  gpClose.discriminators >= 4 &&
  gpClose.discriminatorsOk === gpClose.discriminators;

console.log("---");
console.log("atlasActive (slotCount=9, 8 children uploaded):", atlasActive);
console.log("refinedClose (WebGPU targetLevel=1 at close view):", refinedClose);
console.log("rootFar (WebGPU targetLevel=0 at far view):", rootFar);
console.log(
  `discriminators (>=4, all black on WebGPU): ${gpClose.discriminatorsOk}/${gpClose.discriminators}`,
);
console.log("webglCellsPass:", glClose.pass);
console.log("webgpuCellsPass:", gpClose.pass);
console.log("farDiffSmall (<6):", farDiff < 6);
console.log("noErrors:", noErrors);

const pass =
  atlasActive &&
  refinedClose &&
  rootFar &&
  discriminatorsMeaningful &&
  glClose.pass &&
  gpClose.pass &&
  farDiff < 6 &&
  noErrors;
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL/PARTIAL");
process.exit(pass ? 0 : 1);
