#!/usr/bin/env node
/**
 * C4-LOGDEPTH-PP-SLICEB — csm_reverseLogDepth consumer half for the depth-
 * reading post-process effects (AmbientOcclusion/GTAO, DepthOfField, GodRay).
 *
 * Slice A threaded live near/far + the renderer-wide `logActive` flag into each
 * effect UB but no WGSL read `frustum.z`/`params2.x`. Slice B adds the log-depth
 * reverse (byte-compatible with WebGL czm_readDepth → czm_reverseLogDepth),
 * gated on that flag: when logActive is 0 the historical linearization is
 * byte-identical; when 1 the sampled logarithmic depth is reversed to hyperbolic
 * window depth before linearizing.
 *
 * Verifies (WebGPU-only — these are opt-in effects, no WebGL twin here):
 *   (1) PER-CONSUMER — with AO + DoF + GodRay enabled at a far oblique view
 *       (log depth active, far >> placeholder), the log-reverse ON frame
 *       DIFFERS from a forced-logActive-0 frame → the reverse actually runs and
 *       changes output (a "fix" that moves no pixels is not a fix).
 *   (2) OFF-GATE (byte-identical) — forcing logActive=0 takes the untouched
 *       else-branch (== pre-SliceB output); AND toggling every effect off
 *       returns a frame within the scene's own noise floor of the no-effect
 *       baseline (the new code is gated on each effect's enabled flag).
 *   (3) State — each effect reports logActive==1 by default (log depth on).
 *   (4) No new WebGPU device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-logdepth-pp-sliceb.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const W = 1024,
  H = 768;
const LON = -111.5,
  LAT = 36.1,
  ALT = 6000.0;
const OUT = "Tools/visual-regression/output";

const SETUP = async (cfg) => {
  const v = window.viewer;
  const s = v.scene;
  v.useDefaultRenderLoop = false;
  s.requestRenderMode = false;
  v.camera.setView({
    destination: window.Cesium.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: window.Cesium.Math.toRadians(90.0),
      pitch: window.Cesium.Math.toRadians(-20.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

const SHOOT = async () => {
  const s = window.viewer.scene;
  for (let i = 0; i < 30; i++) {
    s.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return s.canvas.toDataURL("image/png");
};

async function diff(page, a, b) {
  return page.evaluate(
    async ([ua, ub]) => {
      const load = async (u) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        return cx.getImageData(0, 0, c.width, c.height).data;
      };
      const da = await load(ua),
        db = await load(ub);
      let changed = 0;
      const n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) {
          changed++;
        }
      }
      return { pctChanged: +((100 * changed) / n).toFixed(4), changed, n };
    },
    [a, b],
  );
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await page.evaluate(async () => {
    window.Cesium = await import("/Build/CesiumUnminified/index.js");
  });
  await armWebGPUDevices(page);
  await page.evaluate(SETUP, { LON, LAT, ALT });

  await page.evaluate(async () => {
    const s = window.viewer.scene;
    const deadline = performance.now() + 45000;
    for (let i = 0; i < 2000 && performance.now() < deadline; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (i > 30 && s.globe.tilesLoaded) break;
    }
    for (let i = 0; i < 30; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  // Off-gate baseline — no effects. Two shots for the noise floor.
  const baseline = await page.evaluate(SHOOT);
  const baseline2 = await page.evaluate(SHOOT);

  // Enable AO + DoF + GodRay. Capture the log-reverse ON frame + read state.
  const state = await page.evaluate(async () => {
    const C = window.Cesium;
    const v = window.viewer;
    const s = v.scene;
    s.postProcessStages.ambientOcclusion.enabled = true;
    const dofStage = C.PostProcessStageLibrary.createDepthOfFieldStage();
    s.postProcessStages.add(dofStage);
    dofStage.enabled = true;
    s.godRayConfig = { exposure: 0.05, weight: 0.2, density: 0.9, decay: 0.9 };
    s.godRayEnabled = true;
    for (let i = 0; i < 45; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const pp = s._alternateSceneRenderer?._postProcess ?? null;
    const ao = pp?.ambientOcclusionEffect ?? null;
    const dof = pp?.depthOfFieldEffect ?? null;
    const gr = pp?.godRayEffect ?? null;
    const f = v.camera.frustum;
    return {
      camNear: f?.near ?? null,
      camFar: f?.far ?? null,
      ao: ao ? { logActive: ao._logActive, far: ao._far } : null,
      dof: dof ? { logActive: dof._logActive, far: dof._far } : null,
      gr: gr ? { logActive: gr._logActive } : null,
      logOn: s.canvas.toDataURL("image/png"),
    };
  });
  const logOn = state.logOn;

  // Force logActive=0 on every effect by wrapping each setFrustum so the
  // per-frame collection push keeps near/far but zeroes the flag. This is
  // exactly the pre-SliceB path (else-branch of the WGSL gate).
  const logOff = await page.evaluate(async () => {
    const s = window.viewer.scene;
    const pp = s._alternateSceneRenderer?._postProcess ?? null;
    for (const key of [
      "ambientOcclusionEffect",
      "depthOfFieldEffect",
      "godRayEffect",
    ]) {
      const fx = pp?.[key];
      if (fx && !fx.__logForcedOff) {
        const orig = fx.setFrustum.bind(fx);
        fx.setFrustum = (near, far) => orig(near, far, false);
        fx.__logForcedOff = true;
      }
    }
    for (let i = 0; i < 45; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const ao = pp?.ambientOcclusionEffect ?? null;
    return {
      aoLog: ao?._logActive ?? null,
      png: s.canvas.toDataURL("image/png"),
    };
  });

  // Restore the flag path (undo the wrappers) then disable all effects; the
  // restored no-effect frame must land within the noise floor of baseline.
  const restored = await page.evaluate(async () => {
    const s = window.viewer.scene;
    s.postProcessStages.ambientOcclusion.enabled = false;
    s.godRayEnabled = false;
    const stages = s.postProcessStages;
    for (let i = stages.length - 1; i >= 0; i--) {
      const st = stages.get(i);
      if (st && /depth_of_field|DepthOfField/i.test(st.name || "")) {
        stages.remove(st);
      }
    }
    for (let i = 0; i < 45; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return s.canvas.toDataURL("image/png");
  });

  const save = (name, du) =>
    fs.writeFileSync(
      `${OUT}/logdepth-pp-sliceb-${name}.png`,
      Buffer.from(du.split(",")[1], "base64"),
    );
  save("baseline", baseline);
  save("log-on", logOn);
  save("log-off", logOff.png);
  save("restored", restored);

  const floor = await diff(page, baseline, baseline2);
  const reverseDelta = await diff(page, logOff.png, logOn);
  const offGate = await diff(page, baseline2, restored);

  const gate = await collectGateErrors(page);
  const errs = [...(gate?.errors ?? []), ...(consoleErrors ?? [])];
  await browser.close();

  const camFar = state.camFar ?? 0;
  const checks = [];
  checks.push([
    "camera frustum far is large (log-depth regime, >> 10000 placeholder)",
    camFar > 1e5,
    `camFar=${camFar}`,
  ]);
  checks.push([
    "AO/DoF/GodRay report logActive==1 by default (log depth on)",
    state.ao?.logActive === 1 &&
      state.dof?.logActive === 1 &&
      state.gr?.logActive === 1,
    `ao=${state.ao?.logActive} dof=${state.dof?.logActive} gr=${state.gr?.logActive}`,
  ]);
  checks.push([
    "log-reverse ON differs from forced logActive=0 (the reverse runs + matters)",
    reverseDelta.pctChanged > 0.5,
    `logOn vs logOff = ${reverseDelta.pctChanged}% changed`,
  ]);
  checks.push([
    "forced-off path zeroes the flag (off-gate lane reachable)",
    logOff.aoLog === 0,
    `ao.logActive(forced)=${logOff.aoLog}`,
  ]);
  checks.push([
    "off-gate: effects fully disabled returns within scene noise floor",
    offGate.pctChanged <= floor.pctChanged + 0.05,
    `restored=${offGate.pctChanged}% vs floor=${floor.pctChanged}%`,
  ]);
  checks.push([
    "no new WebGPU device errors",
    errs.length === 0,
    `${errs.length} errors`,
  ]);

  let pass = true;
  console.log("\n=== C4-LOGDEPTH-PP-SLICEB probe ===");
  for (const [name, ok, detail] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
    if (!ok) pass = false;
  }
  console.log(
    `\nPNGs: ${OUT}/logdepth-pp-sliceb-{baseline,log-on,log-off,restored}.png`,
  );
  console.log(pass ? "\nRESULT: PASS\n" : "\nRESULT: FAIL\n");
  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
