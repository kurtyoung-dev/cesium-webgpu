// VOXEL-OCTREE-LOD acceptance probe — octree traversal / LOD refinement.
// @purpose Acceptance: voxel octree LOD refinement to level 2 (73-slot atlas) with L1/L2 discriminator families and cone-sampled in-page expectations.
// @status ACTIVE
//
// Scenario (NEW-VOXEL-OCTREE-L2-ASSET-PROBE): a CUSTOM THREE-level box voxel
// provider (availableLevels = 3, 4x4x4 cells per tile, metadataOrder Y_UP)
// from Tools/visual-regression/fixtures/voxel-octree-l3.mjs. The finest
// (level-2, combined 16x16x16) truth is the THIN diagonal y16 == z16 extruded
// along x; every coarser level is the honest conservative downsample, which
// for this pattern is y == z at that level's own resolution (self-similar).
//
// Two discriminator families fall out:
//   L1 discriminators — empty at the 8^3 grid, filled at the 4^3 root:
//     black once traversal reaches depth 1 (SHIPPED, Batch 501).
//   L2 discriminators — empty at the 16^3 grid, filled at the 8^3 grid:
//     black once traversal reaches depth 2 (SHIPPED, B17
//     NEW-VOXEL-OCTREE-DEEP-TRAVERSAL: iterative octree walk over the
//     73-slot atlas — root + 8 level-1 + 64 level-2 tiles; the SSE refine
//     ladder halves per level and caps at the deepest uploaded level).
//     Deep traversal is now the DEFAULT gate; the pre-B17 depth-1-clamp
//     annotation mode (EXPECT_L2 env toggle) is retired.
//
// Views + gates:
//   CLOSE view (10R — the SSE ladder refines to level 2):
//     * WebGPU must match the LEVEL-2 grid exactly with >= 4 L1
//       discriminators black (empty-at-8 implies empty-at-16, so the L1
//       family stays gated at depth 2), internals slotCount = 73 /
//       8 childSlots + 64 l2Slots uploaded / lastTargetLevel = 2.
//     * WebGL: upstream traversal refines PER-NODE here (mixed L1/L2 across
//       the volume is legitimate), so each cell must merely be consistent
//       with level 1 OR level 2 — the strict single-level WebGL gate lives
//       at CLOSE2.
//   CLOSE2 view (5R — deep enough that upstream WebGL refines to level 2):
//     * WebGL must match the LEVEL-2 grid exactly with >= 4 L2
//       discriminators black — proves the asset + discriminators
//       discriminate.
//     * WebGPU must match LEVEL-2 with all L2 discriminators black — the
//       B17 acceptance gate, now standing.
//   FAR view (120R — root SSE < screenSpaceError):
//     * WebGPU lastTargetLevel = 0 and the WebGL/WebGPU center-crop mean
//       diff stays small. Unchanged gate.
//   0 console errors on both backends.
//
// Expectations are derived per-ray IN-PAGE by sampling camera pick rays
// against the authored 16/8/4 grids (no hand-derived visibility reasoning).
// Each target uses a 5-ray CONE — the center pixel plus the four sampling-
// window corners — because a cell is only reliably BLACK if the whole
// window's rays stay in empty space (perspective magnifies the box's near
// face, so filled columns adjacent to a boundary legitimately bleed into
// neighboring windows; single-midplane-ray expectations misjudge those).
// Cells whose cone straddles filled/empty are SKIPPED, never gated. READ the
// output PNGs in Tools/visual-regression/output/.
//
// Run:  node Tools/visual-regression/probe-voxel-octree.mjs
import { chromium } from "playwright";
import fs from "fs";
import { createVoxelOctreeL3Provider } from "./fixtures/voxel-octree-l3.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

// Combined per-axis resolutions: level 0 root = 4, level 1 = 8, level 2 = 16.
const FINEST = 16;

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
    async ({ providerFactorySrc }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      // eslint-disable-next-line no-new-func
      const makeProvider = new Function(`return (${providerFactorySrc});`)();

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      // The star field can still slip through show=false (fork sky path);
      // stray star dots under a target window read as SPURIOUS fill.
      scene.skyBox = undefined;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const R = 6378137.0;
      const provider = makeProvider(C, R);

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
      // child tiles during warm-up.
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
      window.__voxelProbe = { C, scene, prim, R };
      return {
        usingRealData: cache ? cache.usingRealData === true : null,
        uploadPhase: du ? du.phase : null,
        slotCount: du ? du.slotCount : null,
        childPhase: du ? du.childPhase : null,
        childSlots: du && du.childSlots ? Array.from(du.childSlots) : null,
        // B17 — count of uploaded level-2 tiles (64 expected for this asset).
        l2Uploaded:
          du && du.l2Slots
            ? Array.from(du.l2Slots).filter((v) => v >= 0).length
            : null,
        lastTargetLevelClose: du ? du.lastTargetLevel : null,
      };
    },
    { providerFactorySrc: createVoxelOctreeL3Provider.toString() },
  );

  // Project each FINEST-cell target to window coords and analytically
  // sample a 5-ray cone (center pixel + the four sampling-window corners)
  // against ALL THREE grids (16 = level-2 expectation, 8 = level-1
  // expectation / L2-discriminator detection, 4 = root / L1-discriminator
  // detection). A cell only counts as expected-EMPTY when EVERY cone ray
  // stays out of that grid's filled cells — perspective magnification of the
  // box's near face legitimately bleeds filled columns into adjacent pixel
  // windows, and those cells must be SKIPPED, not failed.
  async function measureView(name, destX, judgeTargets = true) {
    const proj = await page.evaluate(
      async ({ destX, finest, judgeTargets }) => {
        const { C, scene, prim, R } = window.__voxelProbe;
        window.viewer.camera.setView({
          destination: new C.Cartesian3(destX * R, 0, 0),
          orientation: {
            direction: new C.Cartesian3(-1, 0, 0),
            up: new C.Cartesian3(0, 0, 1),
          },
        });
        for (let i = 0; i < 90; i++) {
          scene.render();
          await new Promise((r) => setTimeout(r, 8));
        }
        const du0 = prim._webgpuCache ? prim._webgpuCache.dataUpload : null;
        if (!judgeTargets) {
          return {
            targets: [],
            cellPx: 0,
            half: 1,
            lastTargetLevel: du0 ? du0.lastTargetLevel : null,
          };
        }

        // Same self-similar fill truth as the fixture: y === z per level.
        const filledAt = (n, x, y, z) => y === z;

        // Finest-cell centers on the x = 0 mid-plane, front (y,z) layout.
        const cc = (i) => -1 + ((i + 0.5) * 2) / finest;
        const targets = [];
        for (let fz = 0; fz < finest; fz++) {
          for (let fy = 0; fy < finest; fy++) {
            targets.push({ label: `y${fy}z${fz}`, p: [0, cc(fy), cc(fz)] });
          }
        }

        // Projected size of one finest cell → adaptive sample window (the
        // 16-grid cells are ~9 px at 10R; a fixed 5x5 window would bleed).
        const pa = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          new C.Cartesian3(0, cc(7) * R, cc(7) * R),
        );
        const pb = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          new C.Cartesian3(0, cc(8) * R, cc(8) * R),
        );
        const cellPx =
          pa && pb ? Math.hypot(pb.x - pa.x, pb.y - pa.y) / Math.SQRT2 : 8;
        const half = Math.max(1, Math.min(3, Math.floor(cellPx / 4)));

        // March one pick ray (unit-box space) against the three grids.
        const scratchWin = new C.Cartesian2();
        function rayHits(wx, wy) {
          scratchWin.x = wx;
          scratchWin.y = wy;
          const ray = window.viewer.camera.getPickRay(scratchWin);
          if (!ray) {
            return null;
          }
          const o = [ray.origin.x / R, ray.origin.y / R, ray.origin.z / R];
          const rd = [ray.direction.x, ray.direction.y, ray.direction.z];
          const len = Math.hypot(o[0], o[1], o[2]);
          const t0 = Math.max(0, len - 2);
          const t1 = len + 2;
          const S = 2500;
          let inBox = 0;
          const inGrid = [0, 0, 0]; // levels 0 (4), 1 (8), 2 (16)
          for (let i = 0; i < S; i++) {
            const tt = t0 + ((t1 - t0) * i) / S;
            const px = o[0] + rd[0] * tt;
            const py = o[1] + rd[1] * tt;
            const pz = o[2] + rd[2] * tt;
            if (px < -1 || px > 1 || py < -1 || py > 1 || pz < -1 || pz > 1) {
              continue;
            }
            inBox++;
            for (let lvl = 0; lvl < 3; lvl++) {
              const n = 4 << lvl;
              const q = (v) => Math.min(n - 1, Math.floor(((v + 1) / 2) * n));
              if (filledAt(n, q(px), q(py), q(pz))) inGrid[lvl]++;
            }
          }
          return {
            frac: inGrid.map((c) => (inBox > 0 ? c / inBox : 0)),
          };
        }

        const out = [];
        const d = half + 1;
        for (const t of targets) {
          const world = new C.Cartesian3(t.p[0] * R, t.p[1] * R, t.p[2] * R);
          const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
          if (!win) {
            out.push({
              label: t.label,
              win: null,
              frac: [0, 0, 0],
              coneAny: [true, true, true],
              discL1: false,
              discL2: false,
            });
            continue;
          }
          const center = rayHits(win.x, win.y);
          const corners = [
            rayHits(win.x - d, win.y - d),
            rayHits(win.x + d, win.y - d),
            rayHits(win.x - d, win.y + d),
            rayHits(win.x + d, win.y + d),
          ];
          const rays = [center, ...corners].filter((r) => r !== null);
          const frac = center ? center.frac : [0, 0, 0];
          // coneAny[lvl]: ANY cone ray touches a filled cell of that grid —
          // the window cannot be relied on to read black at that level.
          const coneAny = [0, 1, 2].map((lvl) =>
            rays.some((r) => r.frac[lvl] > 0),
          );
          out.push({
            label: t.label,
            win: [win.x, win.y],
            frac, // center ray: [rootFrac, l1Frac, l2Frac]
            coneAny,
            // L1 discriminator: whole cone empty in the 8-grid, center
            // solidly filled at root.
            discL1: !coneAny[1] && frac[0] >= 0.05,
            // L2 discriminator: whole cone empty in the 16-grid, center
            // solidly filled in the 8-grid.
            discL2: !coneAny[2] && frac[1] >= 0.05,
          });
        }

        const du = prim._webgpuCache ? prim._webgpuCache.dataUpload : null;
        return {
          targets: out,
          cellPx,
          half,
          lastTargetLevel: du ? du.lastTargetLevel : null,
        };
      },
      { destX, finest: FINEST, judgeTargets },
    );

    const buf = await page.screenshot();
    fs.writeFileSync(`${OUT}/probe-voxel-octree-${renderer}-${name}.png`, buf);
    const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    const half = proj.half;
    const samples = await page.evaluate(
      async ({ url, points, half }) => {
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
          const d = ctx.getImageData(
            x - half,
            y - half,
            2 * half + 1,
            2 * half + 1,
          ).data;
          // MEDIAN pixel by luminance — robust against 1-3 px star dots /
          // faint UI specks inside the window (a mean is not).
          const px = [];
          for (let i = 0; i < d.length; i += 4) {
            px.push([d[i], d[i + 1], d[i + 2]]);
          }
          px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
          return px[Math.floor(px.length / 2)];
        });
      },
      { url: dataUrl, points: proj.targets.map((p) => p.win), half },
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
      cellPx: proj.cellPx,
      lastTargetLevel: proj.lastTargetLevel,
      crop,
    };
  }

  const close = await measureView("close", 10);
  const close2 = await measureView("close2", 5);
  const far = await measureView("far", 120, false);

  await page.close();
  return { setupInfo, close, close2, far, consoleErrors };
}

// Per-cell expectation at ONE level: FILLED when the center ray passes
// SOLIDLY through that grid's filled cells (>= 15% of its in-box path — a
// mere graze can legitimately render near-black in a fixed-step marcher);
// EMPTY only when the whole 5-ray cone misses them; SKIP otherwise
// (boundary/bleed/graze cells are never gated).
function expectAt(c, level) {
  if (c.frac[level] >= 0.15) {
    return "filled";
  }
  if (!c.coneAny[level]) {
    return "empty";
  }
  return "skip";
}

// Luminance (r+g+b) verdict for one expectation. Real fills read >= ~130;
// the empty threshold leaves headroom for faint viewer-UI overlap.
function verdictFor(expected, lum) {
  if (expected === "filled") {
    return lum > 60 ? "ok" : "MISSING";
  }
  if (expected === "empty") {
    return lum < 40 ? "ok" : "SPURIOUS";
  }
  return "skip";
}

// Judge the rendered cells against ONE level's analytic grid expectation.
// discFamily: "L1" counts empty-at-8/filled-at-root cells, "L2" counts
// empty-at-16/filled-at-8 cells; discriminator cells must read BLACK for the
// judged level to be considered truly rendered.
function judgeCells(name, cells, level, discFamily) {
  let pass = true;
  let discriminatorsOk = 0;
  let discriminators = 0;
  const failures = [];
  for (const c of cells) {
    const expected = expectAt(c, level);
    const lum = c.rgb ? c.rgb[0] + c.rgb[1] + c.rgb[2] : -1;
    const verdict = verdictFor(expected, lum);
    const isDisc = discFamily === "L1" ? c.discL1 : c.discL2;
    if (isDisc && expected !== "skip") {
      discriminators++;
      if (verdict === "ok") discriminatorsOk++;
    }
    if (verdict === "MISSING" || verdict === "SPURIOUS") {
      pass = false;
      failures.push(
        `${c.label} L${level}-expect=${expected}${isDisc ? ` (${discFamily} DISCRIMINATOR)` : ""} rgb=${c.rgb ? c.rgb.join(",") : "?"} ${verdict}`,
      );
    }
  }
  console.log(
    `  [${name} vs level ${level}] cells=${cells.length} ${discFamily}-discriminators=${discriminatorsOk}/${discriminators} failures=${failures.length}`,
  );
  if (failures.length) {
    console.log(`    ${failures.slice(0, 12).join("\n    ")}`);
  }
  return { pass, discriminators, discriminatorsOk };
}

// Judge cells accepting EITHER level 1 or level 2 per cell — upstream WebGL
// legitimately renders a mixed-refinement volume at intermediate distances
// (per-node SSE), so any cell consistent with one of the two levels is ok.
function judgeCellsEither(name, cells) {
  let pass = true;
  const failures = [];
  for (const c of cells) {
    const lum = c.rgb ? c.rgb[0] + c.rgb[1] + c.rgb[2] : -1;
    const v1 = verdictFor(expectAt(c, 1), lum);
    const v2 = verdictFor(expectAt(c, 2), lum);
    if (v1 !== "ok" && v1 !== "skip" && v2 !== "ok" && v2 !== "skip") {
      pass = false;
      failures.push(
        `${c.label} rgb=${c.rgb ? c.rgb.join(",") : "?"} vsL1=${v1} vsL2=${v2}`,
      );
    }
  }
  console.log(
    `  [${name} vs level 1 OR 2 per cell] cells=${cells.length} failures=${failures.length}`,
  );
  if (failures.length) {
    console.log(`    ${failures.slice(0, 12).join("\n    ")}`);
  }
  return { pass };
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

// --- CLOSE view (10R): deep traversal refines to level 2 (B17) ---
console.log("--- CLOSE view (10R, refines to level 2 post-B17) ---");
console.log("WebGPU close (must match level 2; L1 discriminators stay black):");
const gpClose = judgeCells("webgpu-close", webgpu.close.cells, 2, "L1");
console.log(
  "WebGL close (mixed per-node refinement allowed — L1 or L2 per cell):",
);
const glClose = judgeCellsEither("webgl-close", webgl.close.cells);

// --- CLOSE2 view (5R): the L2 discriminator gate (B17 acceptance) ---
console.log("--- CLOSE2 view (5R, depth-2 refinement on both backends) ---");
console.log("WebGL close2 (must match level 2 — proves asset+discriminators):");
const glClose2 = judgeCells("webgl-close2", webgl.close2.cells, 2, "L2");
console.log("WebGPU close2 vs level 2 (the B17 deep-traversal gate):");
const gpClose2L2 = judgeCells("webgpu-close2", webgpu.close2.cells, 2, "L2");

// WebGPU internals: the 73-slot deep atlas fully engaged (root + 8 level-1 +
// 64 level-2 tiles uploaded) and the SSE ladder refining to level 2 up close.
const s = webgpu.setupInfo;
const atlasActive =
  s.usingRealData === true &&
  s.slotCount === 73 &&
  s.childPhase === "done" &&
  Array.isArray(s.childSlots) &&
  s.childSlots.every((v) => v >= 0) &&
  s.l2Uploaded === 64;
const refinedClose =
  webgpu.close.lastTargetLevel === 2 && webgpu.close2.lastTargetLevel === 2;
const rootFar = webgpu.far.lastTargetLevel === 0;

// FAR view: WebGL-vs-WebGPU center-crop mean abs diff (both render the ROOT
// level; the box is small on screen, so the diff must be tiny).
let farDiff;
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
  `WebGPU lastTargetLevel: close=${webgpu.close.lastTargetLevel} close2=${webgpu.close2.lastTargetLevel} far=${webgpu.far.lastTargetLevel}`,
);
console.log(`Far-view center-crop mean abs diff: ${farDiff.toFixed(2)}`);

const noErrors =
  webgl.consoleErrors.length === 0 && webgpu.consoleErrors.length === 0;

// L1 family still gated at depth 2 (empty-at-8 implies empty-at-16): the
// refinement is REAL only if enough L1 discriminator cells exist and read
// black on WebGPU at the close view.
const l1DiscriminatorsMeaningful =
  gpClose.discriminators >= 4 &&
  gpClose.discriminatorsOk === gpClose.discriminators;

// L2 asset gates: WebGL at close2 must render true level-2 data with
// enough L2 discriminators black — otherwise the asset/discriminators are
// not actually discriminating and the WebGPU gate would run on noise.
const webglL2Proven =
  glClose2.pass &&
  glClose2.discriminators >= 4 &&
  glClose2.discriminatorsOk === glClose2.discriminators;

// WebGPU at close2 must match level 2 with ALL L2 discriminators black —
// the B17 deep-traversal acceptance gate, now the standing regression gate.
const gpL2DiscBlack =
  gpClose2L2.discriminators >= 4 &&
  gpClose2L2.discriminatorsOk === gpClose2L2.discriminators;
const webgpuClose2Gate = gpClose2L2.pass && gpL2DiscBlack;

console.log("---");
console.log(
  "atlasActive (slotCount=73, 8 L1 + 64 L2 tiles uploaded):",
  atlasActive,
);
console.log(
  "refinedClose (WebGPU targetLevel=2 at close + close2 views):",
  refinedClose,
);
console.log("rootFar (WebGPU targetLevel=0 at far view):", rootFar);
console.log(
  `L1 discriminators (>=4, all black on WebGPU close): ${gpClose.discriminatorsOk}/${gpClose.discriminators}`,
);
console.log(
  `L2 discriminators on WebGL close2 (>=4, all black): ${glClose2.discriminatorsOk}/${glClose2.discriminators}`,
);
console.log(
  `L2 discriminators on WebGPU close2 (>=4, all black): ${gpClose2L2.discriminatorsOk}/${gpClose2L2.discriminators}`,
);
console.log("webglClosePass (L1-or-L2 per cell):", glClose.pass);
console.log("webglL2Proven (close2 matches level 2):", webglL2Proven);
console.log("webgpuClosePass (level 2):", gpClose.pass);
console.log("webgpuClose2Gate (level 2 required):", webgpuClose2Gate);
console.log("farDiffSmall (<6):", farDiff < 6);
console.log("noErrors:", noErrors);

const pass =
  atlasActive &&
  refinedClose &&
  rootFar &&
  l1DiscriminatorsMeaningful &&
  gpClose.pass &&
  glClose.pass &&
  webglL2Proven &&
  webgpuClose2Gate &&
  farDiff < 6 &&
  noErrors;
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL/PARTIAL");
process.exit(pass ? 0 : 1);
