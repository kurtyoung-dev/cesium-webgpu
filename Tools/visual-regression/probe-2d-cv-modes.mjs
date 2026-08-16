#!/usr/bin/env node
// Probe: verify SCENE2D and COLUMBUS_VIEW render the globe on WebGPU
// after the camera-UB tileRectangle + rtc projected-meters fix.
// @purpose Verifies SCENE2D and Columbus View render the globe on WebGPU after the camera-UB tileRectangle/projected-meters fix, per mode and backend.
// @status ACTIVE
//
// Pre-fix symptom (reported by user): "The 2D and 2.5D projections also
// don't work and result in the globe just disappearing."
//
// Pre-fix root cause: the camera UBO packed `tile.rectangle` in radians
// and used `mesh.center` (ECEF) as rtc for `modifiedModelView`. The 2D
// vertex path's `mix(west, east, st.x)` then produced values in [-π, π]
// while the projection matrix expected projected meters — every planar
// vertex collapsed to ~0 in clip space.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const SCENE_MODES = [
  { name: "scene3d", id: 3 },
  { name: "columbus", id: 1 },
  { name: "scene2d", id: 2 },
];

async function captureFrame(rendererArg, label, modeId) {
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
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async (modeId) => {
    const v = window.viewer;
    // Force a fixed camera and known mode. SceneMode: 0=MORPH, 1=CV, 2=2D, 3=3D.
    // morphTo*() animates by default; pass 0 for instant.
    if (modeId === 1) v.scene.morphToColumbusView(0);
    else if (modeId === 2) v.scene.morphTo2D(0);
    else v.scene.morphTo3D(0);

    // Let the scene settle (morph + tile loads + reprojection)
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const fs = v.scene.frameState;
    const fcs = v.scene._view?.frustumCommandsList || [];
    let totalCmds = 0;
    let globeCmds = 0;
    for (const fc of fcs) {
      const commands = fc.commands || [];
      for (const pass of commands) {
        if (Array.isArray(pass)) totalCmds += pass.length;
      }
      // Pass.GLOBE = 2 in Cesium
      if (commands[2] && Array.isArray(commands[2]))
        globeCmds += commands[2].length;
    }
    const tilesRendered =
      v.scene._globe?._surface?._tilesToRender?.length ?? -1;
    const us = fs?.context?.uniformState;
    const view = us?.view;
    const proj = us?.projection;
    const frust = v.camera.frustum;
    console.log(
      `[probe] mode=${v.scene.mode} morphTime=${fs?.morphTime} cameraPos=(${v.camera.position.x?.toFixed?.(0)},${v.camera.position.y?.toFixed?.(0)},${v.camera.position.z?.toFixed?.(0)}) frustumType=${frust?.constructor?.name} tilesToRender=${tilesRendered} numFrustums=${fcs.length} totalCmds=${totalCmds} globeCmds=${globeCmds}`,
    );
    if (view) {
      console.log(
        `[probe]   view diag=[${view[0]?.toFixed?.(3)},${view[5]?.toFixed?.(3)},${view[10]?.toFixed?.(3)}] t=[${view[12]?.toFixed?.(0)},${view[13]?.toFixed?.(0)},${view[14]?.toFixed?.(0)}]`,
      );
    }
    if (proj) {
      console.log(
        `[probe]   proj diag=[${proj[0]?.toFixed?.(6)},${proj[5]?.toFixed?.(6)},${proj[10]?.toFixed?.(6)},${proj[15]?.toFixed?.(6)}] t=[${proj[12]?.toFixed?.(3)},${proj[13]?.toFixed?.(3)},${proj[14]?.toFixed?.(3)}]`,
      );
    }
    if (frust) {
      console.log(
        `[probe]   frust left=${frust.left?.toFixed?.(0)} right=${frust.right?.toFixed?.(0)} top=${frust.top?.toFixed?.(0)} bottom=${frust.bottom?.toFixed?.(0)} near=${frust.near?.toFixed?.(3)} far=${frust.far?.toFixed?.(3)}`,
      );
    }
    try {
      const convention = fs?.context?.clipSpaceConvention;
      console.log(
        `[probe]   clipSpaceConvention=${convention?.name} nearDepth=${convention?.nearDepth}`,
      );
      // Read the projection for the owning context, not the WebGL-compatible
      // context-free property.
      const fpm =
        typeof frust?.getProjectionMatrix === "function"
          ? frust.getProjectionMatrix(convention)
          : frust?.projectionMatrix;
      if (fpm)
        console.log(
          `[probe]   frust.projectionMatrix[10,14]=[${fpm[10]?.toFixed?.(8)}, ${fpm[14]?.toFixed?.(8)}]`,
        );
    } catch (e) {
      console.log(`[probe]   err reading projection: ${e.message}`);
    }
  }, modeId);

  await page.waitForTimeout(1500);

  const out = path.join(OUT_DIR, `probe-2d-cv-${label}.png`);
  await page.screenshot({ path: out, fullPage: false });
  // Read canvas pixel stats — distinguish "globe rendered somewhere" from "fully blank"
  const stats = await page.evaluate(() => {
    const c = window.viewer?.scene?.canvas;
    if (!c) return { ok: false };
    const w = c.width,
      h = c.height;
    // Read via 2D canvas (works for WebGPU canvas via OffscreenCanvas blit)
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d");
    try {
      ctx.drawImage(c, 0, 0);
    } catch (e) {
      return { ok: false, err: e.message };
    }
    const data = ctx.getImageData(0, 0, w, h).data;
    let nonBlack = 0,
      totalR = 0,
      totalG = 0,
      totalB = 0;
    const sampleEvery = 16;
    let samples = 0;
    for (let i = 0; i < data.length; i += 4 * sampleEvery) {
      samples++;
      totalR += data[i];
      totalG += data[i + 1];
      totalB += data[i + 2];
      if (data[i] > 5 || data[i + 1] > 5 || data[i + 2] > 5) nonBlack++;
    }
    return {
      ok: true,
      w,
      h,
      samples,
      nonBlack,
      avgR: totalR / samples,
      avgG: totalG / samples,
      avgB: totalB / samples,
    };
  });
  console.log(`  canvas stats:`, JSON.stringify(stats));
  await browser.close();
  console.log(`  saved ${out}`);
  const errors = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errors.length) {
    console.log(`  errors: ${errors.length}`);
    errors.slice(0, 5).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  const probeLogs = messages.filter((m) => m.text.includes("[probe]"));
  probeLogs.forEach((m) => console.log(`  ${m.text}`));
  return { messages };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const mode of SCENE_MODES) {
    console.log(`[probe-2d-cv-modes] mode=${mode.name} capturing WebGPU…`);
    await captureFrame("webgpu", `${mode.name}-webgpu`, mode.id);
    console.log(`[probe-2d-cv-modes] mode=${mode.name} capturing WebGL…`);
    await captureFrame("webgl", `${mode.name}-webgl`, mode.id);
  }
  console.log("[probe-2d-cv-modes] done");
})();
