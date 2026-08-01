#!/usr/bin/env node
/**
 * Atmospheric effects — Phase A (conditions→knobs mapper). Logic probe.
 *
 * Phase A is a backend-agnostic mapper (weather conditions → Scene visual knobs),
 * so it's verified by the KNOB VALUES, not a render (whether a backend renders
 * each knob is separate, pre-existing functionality). Boots a Viewer (for the
 * weather facade), then:
 *   (1) tests the PURE Cesium.computeAtmosphericKnobs for warm-moist vs cold-dry;
 *   (2) tests Cesium.applyAtmosphericConditions writing the scene knobs.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-atmospheric-effects.mjs
 */
import { chromium } from "playwright";
import { errorGateInit, armWebGPUDevices } from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;

const TEST = async () => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const out = { api: {}, pure: {}, applied: {} };
  out.api.hasCompute = typeof C.computeAtmosphericKnobs === "function";
  out.api.hasApply = typeof C.applyAtmosphericConditions === "function";
  if (!out.api.hasCompute || !out.api.hasApply) {
    return out;
  }

  // (1) pure mapper — warm-moist (hazy, small spread) vs cold-dry (crisp).
  const humid = C.computeAtmosphericKnobs({
    humidity: 1.0,
    airQuality: 0.5,
    temperatureC: 12,
    dewpointC: 11,
  });
  const crisp = C.computeAtmosphericKnobs({
    humidity: 0.0,
    airQuality: 1.0,
    temperatureC: -15,
    dewpointC: -25,
  });
  const neutral = C.computeAtmosphericKnobs({});
  out.pure = {
    humidFog: humid.fogDensity,
    crispFog: crisp.fogDensity,
    humidSat: humid.atmosphereSaturationShift,
    crispSat: crisp.atmosphereSaturationShift,
    humidType: humid.cloudType,
    crispType: crisp.cloudType,
    neutralFog: neutral.fogDensity,
    neutralSat: neutral.atmosphereSaturationShift,
    stratus: C.CloudType ? C.CloudType.STRATUS : 7,
  };

  // (2) applied to the scene — write conditions onto the weather facade, apply,
  // read the knobs back.
  const s = window.viewer.scene;
  s.render(); // ensure the atmosphericConditions facade is built
  const w = s.globe.atmosphericConditions.weather;
  w.humidity = 1.0;
  w.airQuality = 0.5;
  w.temperature = 12;
  w.dewpoint = 11;
  C.applyAtmosphericConditions(s);
  const humidApplied = {
    fog: s.fog.density,
    sat: s.globe.atmosphereSaturationShift,
    bright: s.globe.atmosphereBrightnessShift,
    cloudType: s.globe.defaultCloudCollection.cloudType,
  };
  w.humidity = 0.0;
  w.airQuality = 1.0;
  w.temperature = -15;
  w.dewpoint = -25;
  s.globe.defaultCloudCollection.cloudType = undefined;
  C.applyAtmosphericConditions(s);
  const crispApplied = {
    fog: s.fog.density,
    sat: s.globe.atmosphereSaturationShift,
    cloudType: s.globe.defaultCloudCollection.cloudType,
  };
  out.applied = { humidApplied, crispApplied };
  return out;
};

async function run() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.addInitScript(errorGateInit);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    {
      timeout: 60000,
    },
  );
  await armWebGPUDevices(page);
  const r = await page.evaluate(TEST);
  console.log(JSON.stringify(r, null, 1));

  const p = r.pure;
  const a = r.applied;
  const checks = [
    [
      "mapper API exported (compute + apply)",
      r.api.hasCompute && r.api.hasApply,
    ],
    [
      `neutral conditions → ~no shift (sat ${p.neutralSat} ~0)`,
      Math.abs(p.neutralSat) < 0.02,
    ],
    [
      `warm-moist → denser fog than cold-dry (${p.humidFog} > ${p.crispFog})`,
      p.humidFog > p.crispFog,
    ],
    [
      `warm-moist desaturates, cold-dry saturates (${p.humidSat} < 0 < ${p.crispSat})`,
      p.humidSat < 0 && p.crispSat > 0,
    ],
    [
      `warm-moist near-saturated → STRATUS bias (${p.humidType} === ${p.stratus})`,
      p.humidType === p.stratus,
    ],
    [
      `cold-dry → no genus bias (${p.crispType} undefined)`,
      p.crispType === undefined || p.crispType === null,
    ],
    [
      `apply writes the scene: humid fog ${a.humidApplied.fog} > crisp fog ${a.crispApplied.fog}`,
      a.humidApplied.fog > a.crispApplied.fog,
    ],
    [
      `apply writes saturation: humid ${a.humidApplied.sat} < crisp ${a.crispApplied.sat}`,
      a.humidApplied.sat < a.crispApplied.sat,
    ],
    [
      `apply writes cloudType STRATUS for humid (${a.humidApplied.cloudType} === ${p.stratus})`,
      a.humidApplied.cloudType === p.stratus,
    ],
  ];
  console.log("\n=== ANALYSIS ===");
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) {
      pass = false;
    }
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
