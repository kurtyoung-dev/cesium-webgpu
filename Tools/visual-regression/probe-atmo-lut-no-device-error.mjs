#!/usr/bin/env node
/**
 * V0 — SkyAtmosphere extended-LUT device-error fix. WebGPU-only.
 *
 * The full-Bruneton extension passes (`computeMultipleScattering`,
 * `computeIrradiance`) were built with `layout:"auto"`, which derives a per-kernel
 * SUBSET group-1 layout (each kernel writes only one of the two storage textures).
 * Binding the full 6-binding `extendedBindGroup` against that subset layout raised
 * an invalid-command-buffer device error every time the sun LUT recomputed — the
 * `/Atmosphere ?LUT|SkyAtmosphere/` error every cloud probe used to filter. V0
 * gives the pipelines an explicit layout [emptyGroup0, extended], so the full
 * bind group is valid.
 *
 * This probe runs with skyAtmosphere ON (cloud probes turn it off, so they never
 * saw the error) and STEPS the sun so the LUT recomputes and the extended passes
 * fire repeatedly. It asserts ZERO device/console GPU errors with NO atmosphere
 * filter. Run it once on the fixed build (expect GREEN) and — for the A/B proof —
 * once on the pre-V0 build (git-stash the 3 files, rebuild; expect the error).
 *
 * PASS: 0 fatal GPU errors (gate + console + device-loss), no filter; the LUT
 * path actually ran (multipleScatter texture present). READ atmo-lut-sky.png —
 * blue globe + atmosphere limb glow.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-atmo-lut-no-device-error.mjs
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
const OUT = "Tools/visual-regression/output";

const SETUP = async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  v.useDefaultRenderLoop = false; // manual render so render(jd) drives the sun
  s.requestRenderMode = false;
  s.globe.show = true;
  s.skyAtmosphere.show = true; // the path under test
  // Whole-globe home view — the standard globe + blue atmosphere limb halo.
  v.camera.flyHome(0.0);
  return {
    hasCompute: !!(s.context && s.context.supportsComputeShaders),
    skyOn: s.skyAtmosphere.show,
  };
};

const RENDER_AT = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  for (let i = 0; i < 20; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  // Confirm the extended LUT path materialized its target (proves we exercised it).
  let lutPresent = false;
  try {
    const pm =
      s.context && s.context.performanceManager
        ? s.context.performanceManager
        : s.context && s.context._performanceManager;
    const res = pm && pm._atmosphereLutResources;
    lutPresent = !!(res && res.multipleScatter);
  } catch (e) {
    lutPresent = false;
  }
  return { lutPresent, dataUrl: s.canvas.toDataURL("image/png") };
};

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
  await armWebGPUDevices(page);
  const setup = await page.evaluate(SETUP);

  // Step the sun across a full day so the sun LUT recomputes repeatedly →
  // the extended (multiple-scatter + irradiance) passes fire each time.
  const times = [
    "2026-06-21T03:00:00Z",
    "2026-06-21T09:00:00Z",
    "2026-06-21T15:00:00Z",
    "2026-06-21T21:00:00Z",
    "2026-06-22T06:00:00Z",
  ];
  let lutPresent = false;
  let lastUrl = "";
  for (const iso of times) {
    const r = await page.evaluate(RENDER_AT, { iso });
    lutPresent = lutPresent || r.lutPresent;
    lastUrl = r.dataUrl;
  }
  fs.writeFileSync(
    `${OUT}/atmo-lut-sky.png`,
    Buffer.from(lastUrl.split(",")[1], "base64"),
  );

  const gate = await collectGateErrors(page);
  await browser.close();

  // NO atmosphere filter — this is the whole point of V0.
  const fatal = [
    ...consoleErrors,
    ...gate.errors,
    ...(gate.deviceLost ? [gate.deviceLost] : []),
  ];

  console.log("setup:", JSON.stringify(setup));
  console.log("lutPresent:", lutPresent, "| armedDevices:", gate.armedDevices);
  console.log("fatal GPU errors:", fatal.length);
  for (const e of fatal.slice(0, 5)) console.log("  -", e);

  const checks = [
    ["compute available + sky atmosphere on", setup.hasCompute && setup.skyOn],
    ["extended LUT path exercised (multipleScatter present)", lutPresent],
    ["ZERO GPU errors (no atmosphere filter)", fatal.length === 0],
  ];
  let pass = true;
  console.log("\n=== ANALYSIS ===");
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) pass = false;
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  process.exitCode = pass ? 0 : 1;
}
run();
