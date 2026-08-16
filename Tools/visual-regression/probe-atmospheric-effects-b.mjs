#!/usr/bin/env node
/**
 * Atmospheric effects — unified conditions→effects HIERARCHY + auto master
 * (Batch 417a). Logic probe.
 * @purpose Logic probe for the conditions-to-effects hierarchy + effects.auto master: pure mapper cases, effects tree, auto on/off byte-neutrality.
 * @status ACTIVE
 *
 * The hierarchy + the `effects.auto` derivation are backend-agnostic logic, so
 * they're verified by the effect STATE the mapper produces, not a render
 * (whether a backend renders each effect is separate — heat shimmer lands in
 * 417b). Boots a Viewer (for the atmosphericConditions facade), then:
 *   (1) tests the PURE Cesium.computeAtmosphericEffects (hot→shimmer,
 *       cold→optics, humid+small-spread→groundFog, neutral→all off);
 *   (2) tests the new scene.globe.atmosphericConditions.effects hierarchy;
 *   (3) tests the auto master: off = byte-neutral, on = derive effects + push
 *       the scene.heatShimmerEnabled flag from the conditions.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-atmospheric-effects-b.mjs
 */
import { chromium } from "playwright";
import { errorGateInit, armWebGPUDevices } from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;

const TEST = async () => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const out = { api: {}, pure: {}, hierarchy: {}, auto: {} };
  out.api.hasComputeEffects = typeof C.computeAtmosphericEffects === "function";
  out.api.hasApply = typeof C.applyAtmosphericConditions === "function";
  if (!out.api.hasComputeEffects || !out.api.hasApply) {
    return out;
  }

  // (1) pure mapper.
  const hot = C.computeAtmosphericEffects({ temperatureC: 45, dewpointC: 30 });
  const cold = C.computeAtmosphericEffects({
    temperatureC: -10,
    dewpointC: -15,
  });
  const foggy = C.computeAtmosphericEffects({
    temperatureC: 12,
    dewpointC: 11,
    humidity: 0.9,
  });
  const neutral = C.computeAtmosphericEffects({});
  out.pure = {
    hotShimmer: hot.shimmer.enabled,
    hotShimmerI: hot.shimmer.intensity,
    coldOptics: cold.optics.enabled,
    coldHalo: cold.optics.halo,
    foggyGroundFog: foggy.groundFog.enabled,
    neutralShimmer: neutral.shimmer.enabled,
    neutralOptics: neutral.optics.enabled,
    neutralGroundFog: neutral.groundFog.enabled,
  };

  // (2) hierarchy on the facade.
  const s = window.viewer.scene;
  s.render();
  const cond = s.globe.atmosphericConditions;
  const eff = cond.effects;
  out.hierarchy = {
    hasEffects: !!eff,
    autoDefault: eff ? eff.auto : null,
    hasShimmer: !!(eff && eff.shimmer),
    hasGroundFog: !!(eff && eff.groundFog),
    hasOptics: !!(eff && eff.optics),
    hasPrecip: !!(eff && eff.precipitation),
  };

  // (3) auto master. OFF = byte-neutral.
  cond.weather.temperature = 45;
  cond.weather.dewpoint = 30;
  eff.auto = false;
  s.heatShimmerEnabled = false;
  eff.shimmer.enabled = false;
  C.applyAtmosphericConditions(s);
  const offShimmer = s.heatShimmerEnabled;
  const offLeaf = eff.shimmer.enabled;
  // ON → derive from hot conditions.
  eff.auto = true;
  C.applyAtmosphericConditions(s);
  const onLeaf = eff.shimmer.enabled;
  const onSceneFlag = s.heatShimmerEnabled;
  const onIntensity = eff.shimmer.intensity;
  const onSceneIntensity = s.heatShimmerIntensity;
  // Cold → optics on, shimmer off.
  cond.weather.temperature = -10;
  cond.weather.dewpoint = -15;
  C.applyAtmosphericConditions(s);
  const coldShimmer = eff.shimmer.enabled;
  const coldOptics = eff.optics.enabled;
  const coldSceneFlag = s.heatShimmerEnabled;
  out.auto = {
    offShimmer,
    offLeaf,
    onLeaf,
    onSceneFlag,
    onIntensity,
    onSceneIntensity,
    coldShimmer,
    coldOptics,
    coldSceneFlag,
  };
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
  const hy = r.hierarchy;
  const a = r.auto;
  const checks = [
    [
      "computeAtmosphericEffects + applyAtmosphericConditions exported",
      r.api.hasComputeEffects && r.api.hasApply,
    ],
    [
      `hot → shimmer on (intensity ${p.hotShimmerI} > 0)`,
      p.hotShimmer === true && p.hotShimmerI > 0,
    ],
    [
      `cold → optics on (halo ${p.coldHalo} > 0)`,
      p.coldOptics === true && p.coldHalo > 0,
    ],
    [`humid + small spread → groundFog on`, p.foggyGroundFog === true],
    [
      `neutral → all effects off`,
      p.neutralShimmer === false &&
        p.neutralOptics === false &&
        p.neutralGroundFog === false,
    ],
    [
      `effects hierarchy present (shimmer/groundFog/optics/precipitation)`,
      hy.hasEffects &&
        hy.hasShimmer &&
        hy.hasGroundFog &&
        hy.hasOptics &&
        hy.hasPrecip,
    ],
    [`auto defaults OFF (byte-neutral)`, hy.autoDefault === false],
    [
      `auto OFF → applyAtmosphericConditions does NOT touch shimmer (scene=${a.offShimmer}, leaf=${a.offLeaf})`,
      a.offShimmer === false && a.offLeaf === false,
    ],
    [
      `auto ON + hot → shimmer leaf + scene flag set (leaf=${a.onLeaf}, flag=${a.onSceneFlag}, I=${a.onIntensity})`,
      a.onLeaf === true &&
        a.onSceneFlag === true &&
        a.onIntensity > 0 &&
        a.onSceneIntensity > 0,
    ],
    [
      `auto ON + cold → shimmer off, optics on (shimmer=${a.coldShimmer}, optics=${a.coldOptics}, flag=${a.coldSceneFlag})`,
      a.coldShimmer === false &&
        a.coldOptics === true &&
        a.coldSceneFlag === false,
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
