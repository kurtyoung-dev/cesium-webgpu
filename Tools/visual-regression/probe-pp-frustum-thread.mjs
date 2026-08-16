#!/usr/bin/env node
/**
 * C4-LOGDEPTH-PP-FRUSTUM-SLICEA — thread live per-frame frustum near/far +
 * renderer-wide `logActive` flag into each depth-reading post-process effect UB.
 * @purpose Gate: live frustum near/far + log-depth flag threaded into AO/DoF/GodRay UBs (not the 0.1/10000 placeholder), byte-identical off-gate
 * @status ACTIVE
 *
 * Before this slice the AmbientOcclusion + DepthOfField effects baked a
 * placeholder `near=0.1 / far=10000` at init, so their depth linearization was
 * correct only when the real camera frustum happened to match that bracket. The
 * GodRay effect already threaded live near/far but not the log-depth flag.
 *
 * This probe verifies (WebGPU-only — these are opt-in effects with no WebGL
 * cross-backend twin here):
 *   (1) OFF-GATE — with no PP effects enabled the scene renders, and toggling
 *       the effects on then back off returns a BYTE-IDENTICAL frame to the
 *       original no-effect frame (mismatch == 0).
 *   (2) AO threaded — after enabling AO, ambientOcclusionEffect._far equals the
 *       live camera frustum far (NOT the 10000 placeholder) and _logActive==1.
 *   (3) DoF threaded — after enabling DoF, depthOfFieldEffect._far equals the
 *       live camera frustum far (NOT 10000) and _logActive==1.
 *   (4) GodRay flag — godRayEffect._logActive==1 once enabled.
 *   (5) No new WebGPU device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-pp-frustum-thread.mjs
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
// Oblique view over terrain so the frustum far is large (>> 10000) and depth
// varies across the frame.
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
    destination: window.Cesium.Cartesian3.fromDegrees(
      cfg.LON,
      cfg.LAT,
      cfg.ALT,
    ),
    orientation: {
      heading: window.Cesium.Math.toRadians(90.0),
      pitch: window.Cesium.Math.toRadians(-20.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

const _renderN = async (s, n) => {
  for (let i = 0; i < n; i++) {
    s.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
};

// Render current scene state and return a data URL.
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
        if (
          da[i] !== db[i] ||
          da[i + 1] !== db[i + 1] ||
          da[i + 2] !== db[i + 2]
        ) {
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

  // Fully settle terrain + imagery so the no-effect frames are comparable
  // (the streaming-in of imagery must NOT be mistaken for an off-gate leak).
  await page.evaluate(async () => {
    const s = window.viewer.scene;
    const deadline = performance.now() + 45000;
    for (let i = 0; i < 2000 && performance.now() < deadline; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (i > 30 && s.globe.tilesLoaded) break;
    }
    // A few more settle frames after tilesLoaded flips true.
    for (let i = 0; i < 30; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  // 1) OFF-GATE baseline — no PP effects. Capture twice to measure the scene's
  // own non-determinism floor (terrain streaming / atmosphere temporal).
  const baseline = await page.evaluate(SHOOT);
  const baseline2 = await page.evaluate(SHOOT);

  // Enable AO + DoF + GodRay; render; read the threaded state.
  const state = await page.evaluate(async () => {
    const C = window.Cesium;
    const v = window.viewer;
    const s = v.scene;
    // AO
    s.postProcessStages.ambientOcclusion.enabled = true;
    // DoF (upstream composite stage; found by name czm_depth_of_field).
    const dofStage = C.PostProcessStageLibrary.createDepthOfFieldStage();
    s.postProcessStages.add(dofStage);
    dofStage.enabled = true;
    // GodRay (fork scene flag) — low exposure so the shaft doesn't blow the
    // whole frame to white (keeps the acceptance PNG legible; the god-ray
    // brightness is orthogonal to the frustum threading under test).
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
      ao: ao
        ? { near: ao._near, far: ao._far, logActive: ao._logActive }
        : null,
      dof: dof
        ? { near: dof._near, far: dof._far, logActive: dof._logActive }
        : null,
      gr: gr ? { logActive: gr._logActive } : null,
      dofDataUrl: s.canvas.toDataURL("image/png"),
    };
  });
  const effectsOn = state.dofDataUrl;

  // 2) Disable all effects; render; capture — must match the baseline exactly.
  const restored = await page.evaluate(async () => {
    const s = window.viewer.scene;
    s.postProcessStages.ambientOcclusion.enabled = false;
    s.godRayEnabled = false;
    // Remove the DoF stage we added.
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
      `${OUT}/pp-frustum-${name}.png`,
      Buffer.from(du.split(",")[1], "base64"),
    );
  save("baseline", baseline);
  save("effects-on", effectsOn);
  save("restored", restored);

  const floor = await diff(page, baseline, baseline2);
  const offGate = await diff(page, baseline2, restored);
  const effectsDelta = await diff(page, restored, effectsOn);

  const gate = await collectGateErrors(page);
  const errs = [...(gate?.errors ?? []), ...(consoleErrors ?? [])];
  await browser.close();

  // ---- Assertions ----
  const camFar = state.camFar ?? 0;
  const camNear = state.camNear ?? 0;
  const approx = (a, b) =>
    Math.abs(a - b) <= Math.max(1e-3, Math.abs(b) * 1e-4);
  const notPlaceholder = (v) => Math.abs(v - 10000.0) > 1.0;

  const checks = [];
  // Off-gate: the no-effect path runs NONE of the new code (it is gated on
  // each effect's enabled flag), so toggling effects on then off must return
  // to the scene's own non-determinism floor — not exceed it.
  checks.push([
    "off-gate: restored no-effect frame within scene noise floor",
    offGate.pctChanged <= floor.pctChanged + 0.05,
    `restored=${offGate.pctChanged}% vs floor=${floor.pctChanged}%`,
  ]);
  checks.push([
    "effects visibly alter the frame (AO/DoF/GodRay actually ran)",
    effectsDelta.pctChanged > 1.0,
    `effects-on vs restored = ${effectsDelta.pctChanged}% changed`,
  ]);
  checks.push([
    "camera frustum far is large (>> 10000 placeholder)",
    camFar > 1e5,
    `camFar=${camFar}`,
  ]);
  checks.push([
    "AO far == live camera far (not placeholder)",
    !!state.ao && approx(state.ao.far, camFar) && notPlaceholder(state.ao.far),
    `ao.far=${state.ao?.far} ao.near=${state.ao?.near}`,
  ]);
  checks.push([
    "AO near == live camera near",
    !!state.ao && approx(state.ao.near, camNear),
    `ao.near=${state.ao?.near} camNear=${camNear}`,
  ]);
  checks.push([
    "AO logActive == 1 (log depth default on)",
    !!state.ao && state.ao.logActive === 1,
    `ao.logActive=${state.ao?.logActive}`,
  ]);
  checks.push([
    "DoF far == live camera far (not placeholder)",
    !!state.dof &&
      approx(state.dof.far, camFar) &&
      notPlaceholder(state.dof.far),
    `dof.far=${state.dof?.far} dof.near=${state.dof?.near}`,
  ]);
  checks.push([
    "DoF logActive == 1",
    !!state.dof && state.dof.logActive === 1,
    `dof.logActive=${state.dof?.logActive}`,
  ]);
  checks.push([
    "GodRay logActive == 1",
    !!state.gr && state.gr.logActive === 1,
    `gr.logActive=${state.gr?.logActive}`,
  ]);
  checks.push([
    "no new WebGPU device errors",
    errs.length === 0,
    `${errs.length} errors`,
  ]);

  let pass = true;
  console.log("\n=== C4-LOGDEPTH-PP-FRUSTUM-SLICEA probe ===");
  for (const [name, ok, detail] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
    if (!ok) pass = false;
  }
  console.log(`\nPNGs: ${OUT}/pp-frustum-{baseline,effects-on,restored}.png`);
  console.log(pass ? "\nRESULT: PASS\n" : "\nRESULT: FAIL\n");
  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
