// NEW-VOXEL-OCTREE-DEEP-LEVELS acceptance probe — octree traversal to LEVEL 3.
//
// Scenario: a CUSTOM FOUR-level box voxel provider (availableLevels = 4, 2x2x2
// cells per tile, metadataOrder Y_UP) from
// Tools/visual-regression/fixtures/voxel-octree-l4.mjs. The finest (level-3,
// combined 16x16x16) truth is the THIN diagonal y16 == z16 extruded along x;
// every coarser level is the honest conservative downsample (self-similar
// y == z at that level's own resolution). Small tiles keep the full 585-slot
// depth-3 atlas (root + 8 L1 + 64 L2 + 512 L3) within maxTextureDimension3D.
//
// Discriminator families fall out per adjacent-level pair (empty at the finer
// grid, filled at the coarser grid):
//   L2 disc: filled@4 (L1), empty@8 (L2)  — black once traversal reaches >= 2.
//   L3 disc: filled@8 (L2), empty@16 (L3) — black ONLY once traversal reaches
//     depth 3 (the capability this probe accepts). At HEAD (depth cap 2) the
//     WebGPU march would read these FILLED (spurious).
//
// Views + gates:
//   CLOSE view (6R — the SSE ladder refines to level 3 on WebGPU):
//     * WebGPU must match the LEVEL-3 grid with >= 4 L3 discriminators black;
//       internals slotCount = 585, 8 childSlots + 64 l2Slots + 512 l3Slots
//       uploaded, lastTargetLevel = 3.
//     * WebGL: upstream traversal refines PER-NODE here (mixed L2/L3 across the
//       volume is legitimate) — each cell must merely be consistent with
//       level 2 OR level 3; the strict WebGL gate lives at CLOSE2.
//   CLOSE2 view (3.5R — deep enough that upstream WebGL refines the center to
//     level 3):
//     * WebGL must match the LEVEL-3 grid with >= 4 L3 discriminators black —
//       proves the asset + discriminators actually discriminate.
//     * WebGPU must match LEVEL-3 with all L3 discriminators black — the
//       standing acceptance gate.
//   FAR view (700R — root SSE < screenSpaceError):
//     * WebGPU lastTargetLevel = 0 and the WebGL/WebGPU center-crop mean diff
//       stays small.
//   0 console errors on both backends.
//
// Expectations are derived per-ray IN-PAGE by sampling camera pick rays against
// the authored 16/8/4/2 grids (no hand-derived visibility reasoning) with a
// 5-ray CONE per target (center + four window corners) — a cell is only judged
// BLACK when the whole cone stays in empty space. READ the output PNGs in
// Tools/visual-regression/output/.
//
// Run:  PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-voxel-octree-l3plus.mjs
import { chromium } from "playwright";
import fs from "fs";
import { createVoxelOctreeL4Provider } from "./fixtures/voxel-octree-l4.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

// Combined per-axis resolutions: level 0 = 2, 1 = 4, 2 = 8, 3 = 16.
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

  await page.evaluate(
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

      // CLOSE view during warm-up so the SSE test streams descendants in.
      window.viewer.camera.setView({
        destination: new C.Cartesian3(6 * R, 0, 0),
        orientation: {
          direction: new C.Cartesian3(-1, 0, 0),
          up: new C.Cartesian3(0, 0, 1),
        },
      });
      // 512 level-3 tiles stream in over many frames — warm generously.
      for (let i = 0; i < 500; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }
      window.__voxelProbe = { C, scene, prim, R };
    },
    { providerFactorySrc: createVoxelOctreeL4Provider.toString() },
  );

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
        for (let i = 0; i < 120; i++) {
          scene.render();
          await new Promise((r) => setTimeout(r, 8));
        }
        const du0 = prim._webgpuCache ? prim._webgpuCache.dataUpload : null;
        const internals = du0
          ? {
              usingRealData:
                prim._webgpuCache.usingRealData === true ? true : false,
              slotCount: du0.slotCount,
              childPhase: du0.childPhase,
              childSlots: du0.childSlots ? Array.from(du0.childSlots) : null,
              l2Uploaded: du0.l2Slots
                ? Array.from(du0.l2Slots).filter((x) => x >= 0).length
                : null,
              l3Uploaded: du0.l3Slots
                ? Array.from(du0.l3Slots).filter((x) => x >= 0).length
                : null,
              lastTargetLevel: du0.lastTargetLevel,
            }
          : null;
        if (!judgeTargets) {
          return {
            targets: [],
            half: 1,
            lastTargetLevel: du0 ? du0.lastTargetLevel : null,
            internals,
          };
        }

        // Self-similar fill truth: y === z per level.
        const filledAt = (n, x, y, z) => y === z;
        const cc = (i) => -1 + ((i + 0.5) * 2) / finest;
        const targets = [];
        for (let fz = 0; fz < finest; fz++) {
          for (let fy = 0; fy < finest; fy++) {
            targets.push({ label: `y${fy}z${fz}`, p: [0, cc(fy), cc(fz)] });
          }
        }

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

        const scratchWin = new C.Cartesian2();
        function rayHits(wx, wy) {
          scratchWin.x = wx;
          scratchWin.y = wy;
          const ray = window.viewer.camera.getPickRay(scratchWin);
          if (!ray) return null;
          const o = [ray.origin.x / R, ray.origin.y / R, ray.origin.z / R];
          const rd = [ray.direction.x, ray.direction.y, ray.direction.z];
          const len = Math.hypot(o[0], o[1], o[2]);
          const t0 = Math.max(0, len - 2);
          const t1 = len + 2;
          const S = 2500;
          let inBox = 0;
          const inGrid = [0, 0, 0, 0]; // levels 0 (2), 1 (4), 2 (8), 3 (16)
          for (let i = 0; i < S; i++) {
            const tt = t0 + ((t1 - t0) * i) / S;
            const px = o[0] + rd[0] * tt;
            const py = o[1] + rd[1] * tt;
            const pz = o[2] + rd[2] * tt;
            if (px < -1 || px > 1 || py < -1 || py > 1 || pz < -1 || pz > 1) {
              continue;
            }
            inBox++;
            for (let lvl = 0; lvl < 4; lvl++) {
              const n = 2 << lvl;
              const q = (val) =>
                Math.min(n - 1, Math.floor(((val + 1) / 2) * n));
              if (filledAt(n, q(px), q(py), q(pz))) inGrid[lvl]++;
            }
          }
          return { frac: inGrid.map((c) => (inBox > 0 ? c / inBox : 0)) };
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
              frac: [0, 0, 0, 0],
              coneAny: [true, true, true, true],
              discL2: false,
              discL3: false,
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
          const frac = center ? center.frac : [0, 0, 0, 0];
          const coneAny = [0, 1, 2, 3].map((lvl) =>
            rays.some((r) => r.frac[lvl] > 0),
          );
          out.push({
            label: t.label,
            win: [win.x, win.y],
            frac, // [l0Frac, l1Frac, l2Frac, l3Frac]
            coneAny,
            // L2 discriminator: cone empty in the 8-grid, center filled@4.
            discL2: !coneAny[2] && frac[1] >= 0.05,
            // L3 discriminator: cone empty in the 16-grid, center filled@8.
            discL3: !coneAny[3] && frac[2] >= 0.05,
          });
        }

        return {
          targets: out,
          half,
          lastTargetLevel: internals?.lastTargetLevel,
          internals,
        };
      },
      { destX, finest: FINEST, judgeTargets },
    );

    const buf = await page.screenshot();
    fs.writeFileSync(
      `${OUT}/probe-voxel-octree-l3plus-${renderer}-${name}.png`,
      buf,
    );
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
          const dd = ctx.getImageData(
            x - half,
            y - half,
            2 * half + 1,
            2 * half + 1,
          ).data;
          const px = [];
          for (let i = 0; i < dd.length; i += 4)
            px.push([dd[i], dd[i + 1], dd[i + 2]]);
          px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
          return px[Math.floor(px.length / 2)];
        });
      },
      { url: dataUrl, points: proj.targets.map((p) => p.win), half },
    );

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
      const dd = ctx.getImageData(rx, ry, rw, rh).data;
      const px = [];
      for (let i = 0; i < dd.length; i += 4)
        px.push(dd[i], dd[i + 1], dd[i + 2]);
      return px;
    }, dataUrl);

    return {
      cells: proj.targets.map((p, i) => ({ ...p, rgb: samples[i] })),
      lastTargetLevel: proj.lastTargetLevel,
      internals: proj.internals,
      crop,
    };
  }

  const close = await measureView("close", 6);
  const close2 = await measureView("close2", 3.5);
  const far = await measureView("far", 700, false);

  await page.close();
  return { close, close2, far, consoleErrors };
}

function expectAt(c, level) {
  if (c.frac[level] >= 0.15) return "filled";
  if (!c.coneAny[level]) return "empty";
  return "skip";
}
function verdictFor(expected, lum) {
  if (expected === "filled") return lum > 60 ? "ok" : "MISSING";
  if (expected === "empty") return lum < 40 ? "ok" : "SPURIOUS";
  return "skip";
}
function judgeCells(name, cells, level, discFamily) {
  let pass = true;
  let discriminatorsOk = 0;
  let discriminators = 0;
  const failures = [];
  for (const c of cells) {
    const expected = expectAt(c, level);
    const lum = c.rgb ? c.rgb[0] + c.rgb[1] + c.rgb[2] : -1;
    const verdict = verdictFor(expected, lum);
    const isDisc = discFamily === "L2" ? c.discL2 : c.discL3;
    if (isDisc && expected !== "skip") {
      discriminators++;
      if (verdict === "ok") discriminatorsOk++;
    }
    if (verdict === "MISSING" || verdict === "SPURIOUS") {
      pass = false;
      failures.push(
        `${c.label} L${level}-expect=${expected}${isDisc ? ` (${discFamily} DISC)` : ""} rgb=${c.rgb ? c.rgb.join(",") : "?"} ${verdict}`,
      );
    }
  }
  console.log(
    `  [${name} vs level ${level}] cells=${cells.length} ${discFamily}-disc=${discriminatorsOk}/${discriminators} failures=${failures.length}`,
  );
  if (failures.length)
    console.log(`    ${failures.slice(0, 12).join("\n    ")}`);
  return { pass, discriminators, discriminatorsOk };
}
function judgeCellsEither(name, cells, la, lb) {
  let pass = true;
  const failures = [];
  for (const c of cells) {
    const lum = c.rgb ? c.rgb[0] + c.rgb[1] + c.rgb[2] : -1;
    const va = verdictFor(expectAt(c, la), lum);
    const vb = verdictFor(expectAt(c, lb), lum);
    if (va !== "ok" && va !== "skip" && vb !== "ok" && vb !== "skip") {
      pass = false;
      failures.push(
        `${c.label} rgb=${c.rgb ? c.rgb.join(",") : "?"} vsL${la}=${va} vsL${lb}=${vb}`,
      );
    }
  }
  console.log(
    `  [${name} vs level ${la} OR ${lb} per cell] cells=${cells.length} failures=${failures.length}`,
  );
  if (failures.length)
    console.log(`    ${failures.slice(0, 12).join("\n    ")}`);
  return { pass };
}

const webgl = await capture("webgl");
const webgpu = await capture("webgpu");
await browser.close();

const gpi = webgpu.close.internals || {};
console.log("WebGPU close internals:", JSON.stringify(gpi));
console.log("WebGL  console errors:", webgl.consoleErrors.length);
console.log("WebGPU console errors:", webgpu.consoleErrors.length);
if (webgl.consoleErrors.length)
  console.log("  WebGL:", webgl.consoleErrors.slice(0, 5).join("\n  "));
if (webgpu.consoleErrors.length)
  console.log("  WebGPU:", webgpu.consoleErrors.slice(0, 5).join("\n  "));

console.log("--- CLOSE view (6R, refines to level 3) ---");
console.log("WebGPU close (must match level 3; L3 discriminators black):");
const gpClose = judgeCells("webgpu-close", webgpu.close.cells, 3, "L3");
console.log(
  "WebGL close (mixed per-node refinement allowed — level 2 OR 3 per cell):",
);
const glClose = judgeCellsEither("webgl-close", webgl.close.cells, 2, 3);

console.log("--- CLOSE2 view (3.5R, depth-3 refinement on both backends) ---");
console.log(
  "WebGL close2 (must match level 3 — proves asset + discriminators):",
);
const glClose2 = judgeCells("webgl-close2", webgl.close2.cells, 3, "L3");
console.log("WebGPU close2 vs level 3 (the deep-levels acceptance gate):");
const gpClose2 = judgeCells("webgpu-close2", webgpu.close2.cells, 3, "L3");

const atlasActive =
  gpi.usingRealData === true &&
  gpi.slotCount === 585 &&
  gpi.childPhase === "done" &&
  Array.isArray(gpi.childSlots) &&
  gpi.childSlots.every((x) => x >= 0) &&
  gpi.l2Uploaded === 64 &&
  gpi.l3Uploaded === 512;
const refinedClose =
  webgpu.close.lastTargetLevel === 3 && webgpu.close2.lastTargetLevel === 3;
const rootFar = webgpu.far.lastTargetLevel === 0;

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

const webglL3Proven =
  glClose2.pass &&
  glClose2.discriminators >= 4 &&
  glClose2.discriminatorsOk === glClose2.discriminators;
const gpL3DiscBlack =
  gpClose2.discriminators >= 4 &&
  gpClose2.discriminatorsOk === gpClose2.discriminators;
const webgpuClose2Gate = gpClose2.pass && gpL3DiscBlack;
const closeL3Meaningful =
  gpClose.discriminators >= 4 &&
  gpClose.discriminatorsOk === gpClose.discriminators;

console.log("---");
console.log(
  "atlasActive (slotCount=585, 8 L1 + 64 L2 + 512 L3 uploaded):",
  atlasActive,
);
console.log(
  "refinedClose (WebGPU targetLevel=3 at close + close2):",
  refinedClose,
);
console.log("rootFar (WebGPU targetLevel=0 at far):", rootFar);
console.log(
  `L3 disc on WebGPU close (>=4, all black): ${gpClose.discriminatorsOk}/${gpClose.discriminators}`,
);
console.log(
  `L3 disc on WebGL close2 (>=4, all black): ${glClose2.discriminatorsOk}/${glClose2.discriminators}`,
);
console.log(
  `L3 disc on WebGPU close2 (>=4, all black): ${gpClose2.discriminatorsOk}/${gpClose2.discriminators}`,
);
console.log("webglClosePass (L2-or-L3 per cell):", glClose.pass);
console.log("webglL3Proven (close2 matches level 3):", webglL3Proven);
console.log("webgpuClosePass (level 3):", gpClose.pass);
console.log("webgpuClose2Gate (level 3 required):", webgpuClose2Gate);
console.log("farDiffSmall (<6):", farDiff < 6);
console.log("noErrors:", noErrors);

const pass =
  atlasActive &&
  refinedClose &&
  rootFar &&
  closeL3Meaningful &&
  gpClose.pass &&
  glClose.pass &&
  webglL3Proven &&
  webgpuClose2Gate &&
  farDiff < 6 &&
  noErrors;
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL/PARTIAL");
process.exit(pass ? 0 : 1);
