// Diagnostic for NEW-WEBGPU-GLOBE-2D-REGIONAL-ZOOM.
// @purpose Entry-point diagnostic for a blank 2D globe: compares tile selection, load queues, 2D frustum and globe command counts across backends and zooms.
// @status ACTIVE
//
// The WebGPU globe renders at full-globe 2D zoom but vanishes at regional 2D
// zoom (~2.4 Mm). This probe captures, at BOTH a full-globe and a regional 2D
// camera, on WebGL vs WebGPU:
//   - scene.mode
//   - quadtree `_tilesToRender.length` (tiles SELECTED for render)
//   - tile load-queue depths
//   - the 2D orthographic frustum (left/right/top/bottom/near/far) + camera
//     cartographic height
//   - globe draw-command count in the frame command list
// to localize the failure: tile selection (0 tiles) vs frustum (degenerate)
// vs command emission/culling (tiles selected but no commands / culled).

import { chromium } from "playwright";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function sample(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (e) =>
    console.log(`>> [${renderer}] pageerror: ${e.message.slice(0, 160)}`),
  );
  await page.goto(
    `${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const s = v.scene;
    s.skyBox.show = false;
    s.skyAtmosphere.show = false;
    s.morphTo2D(0);
    s.completeMorph();

    const snapshot = (label) => {
      const surf = s.globe?._surface;
      const f = s.camera.frustum;
      // Count globe-ish draw commands in the frame command list (best-effort).
      let globeCmds = 0;
      const cl = s.frameState?.commandList ?? [];
      for (const c of cl) {
        const o = c?.owner?.constructor?.name ?? "";
        if (/Globe|QuadtreeTile|GlobeSurfaceTile/i.test(o)) globeCmds++;
      }
      return {
        label,
        mode: s.mode,
        tilesToRender: surf?._tilesToRender?.length ?? -1,
        loadHigh: surf?._tileLoadQueueHigh?.length ?? -1,
        loadMed: surf?._tileLoadQueueMedium?.length ?? -1,
        loadLow: surf?._tileLoadQueueLow?.length ?? -1,
        camHeight: Math.round(v.camera.positionCartographic?.height ?? -1),
        frustumType: f?.constructor?.name ?? "?",
        frustum: {
          left: f?.left,
          right: f?.right,
          top: f?.top,
          bottom: f?.bottom,
          near: f?.near,
          far: f?.far,
        },
        commandListLen: cl.length,
        globeCmds,
      };
    };

    const render = async (n) => {
      for (let i = 0; i < n; i++) {
        s.requestRender();
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    };

    // (A) Full-globe 2D — known good on WebGPU.
    v.camera.setView({
      destination: C.Rectangle.fromDegrees(-170, -80, 170, 80),
    });
    await render(220);
    const full = snapshot("full-globe");

    // (B) Regional 2D — known blank on WebGPU.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 2_400_000),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
    });
    await render(220);
    const regional = snapshot("regional");

    return { full, regional };
  });

  await browser.close();
  return out;
}

const wgl = await sample("webgl");
const wgpu = await sample("webgpu");

console.log("=== NEW-WEBGPU-GLOBE-2D-REGIONAL-ZOOM diagnostic ===\n");
for (const view of ["full", "regional"]) {
  console.log(`── ${view} 2D view ──`);
  for (const [name, r] of [
    ["webgl", wgl],
    ["webgpu", wgpu],
  ]) {
    const d = r[view];
    console.log(
      `  ${name}: mode=${d.mode} camH=${d.camHeight} tilesToRender=${d.tilesToRender} ` +
        `load(H/M/L)=${d.loadHigh}/${d.loadMed}/${d.loadLow} globeCmds=${d.globeCmds} cmdList=${d.commandListLen}`,
    );
    console.log(
      `         frustum[${d.frustumType}] L=${d.frustum.left?.toFixed?.(1)} R=${d.frustum.right?.toFixed?.(1)} ` +
        `T=${d.frustum.top?.toFixed?.(1)} B=${d.frustum.bottom?.toFixed?.(1)} near=${d.frustum.near?.toFixed?.(1)} far=${d.frustum.far?.toFixed?.(1)}`,
    );
  }
  console.log("");
}
