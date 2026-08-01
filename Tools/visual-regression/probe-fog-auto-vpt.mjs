#!/usr/bin/env node
/**
 * FOG-AUTO-VPT probe (Batch 445 — item 4.13 FOG-AUTO-VPT). WebGPU-only.
 *
 * Verifies that `volumetricFog.quality = "auto"` resolves to a hardware-
 * appropriate tier (low/medium/high) via the VisualPerformanceTargetService
 * one-shot init benchmark — but ONLY when VPT is ENABLED (opt-in). Default
 * (VPT disabled) → auto → "low", verbatim as before this batch.
 *
 * The resolved fog tier is read back from
 *   scene._context.getRendererStatistics().volumetricFog.resolutionKey
 * (the fog renderer rebuilds its froxel resources keyed on the resolved tier).
 *
 * Checks:
 *   A. VPT DISABLED (default) + quality="auto" → resolutionKey === "low".
 *   B. VPT ENABLED + quality="auto" → resolutionKey === the device init tier
 *      (low/medium/high from device.limits) AND it equals
 *      scene.visualPerformanceTarget.resolveInitialQualityTier(device).
 *   C. The resolved tier with VPT on is >= the VPT-off "low" (never downgrades
 *      below low; on capable hardware it should upgrade to medium/high).
 *   D. 0 new console errors.
 *
 * Captures one screenshot per state for visual confirmation.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-fog-auto-vpt.mjs
 * Outputs: Tools/visual-regression/output/probe-fog-auto-vpt-{vptoff,vpton}.png
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
const OUT_DIR = "Tools/visual-regression/output";

// Configure a dense structured fog over alpine terrain (matches probe-fog-ms.mjs)
// so the froxel volume actually builds and the tier change is observable.
async function applyFog(page, vptEnabled) {
  return await page.evaluate(
    async ({ vptEnabled }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const s = v.scene;
      const ac = s.globe.atmosphericConditions;

      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T16:40:00Z");
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(7.6, 45.9, 2400),
        orientation: {
          heading: C.Math.toRadians(20),
          pitch: C.Math.toRadians(-14),
          roll: 0,
        },
      });

      // Opt-in VPT enable BEFORE the fog resolves so _resolveQuality sees it.
      s.visualPerformanceTarget.enabled = vptEnabled === true;

      // Dense fog at AUTO quality — the path under test.
      ac.volumetricFog.enabled = true;
      ac.volumetricFog.quality = "auto";
      ac.volumetricFog.density = 0.5;
      ac.volumetricFog.falloff = 0.0022;
      ac.volumetricFog.maxDistance = 26000;
      ac.volumetricFog.ambientStrength = 0.06;
      ac.volumetricFog.fogAnisotropy = 0.5;

      // Settle (build froxel resources + load tiles).
      let loaded = 0;
      for (let i = 0; i < 600; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (s.globe.tilesLoaded === true) {
          loaded++;
          if (loaded > 40) break;
        } else {
          loaded = 0;
        }
      }
      for (let i = 0; i < 30; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Read back the resolved fog tier + the VPT init tier + the device limits
      // used to classify it.
      const ctx = s._context;
      const rstats = ctx.getRendererStatistics
        ? ctx.getRendererStatistics()
        : null;
      const fog = rstats ? rstats.volumetricFog : null;
      const device = ctx.device ?? null;
      const vpt = s.visualPerformanceTarget;
      const initTier =
        device && typeof vpt.resolveInitialQualityTier === "function"
          ? vpt.resolveInitialQualityTier(device)
          : null;
      const lim = device && device.limits ? device.limits : {};
      return {
        vptEnabled: vpt.enabled,
        fogQuality: ac.volumetricFog.quality,
        fogResolutionKey: fog ? fog.resolutionKey : null,
        fogEnabled: fog ? fog.enabled : null,
        fogDimensions: fog ? fog.dimensions : null,
        vptInitTier: initTier,
        limits: {
          maxBufferSize: lim.maxBufferSize ?? null,
          maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize ?? null,
          maxComputeWorkgroupStorageSize:
            lim.maxComputeWorkgroupStorageSize ?? null,
          maxComputeInvocationsPerWorkgroup:
            lim.maxComputeInvocationsPerWorkgroup ?? null,
        },
      };
    },
    { vptEnabled },
  );
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(URL, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForFunction(() => !!(window.viewer && window.viewer.scene), {
    timeout: 90_000,
  });

  const canvas = await page.$("#cesiumContainer canvas, canvas");
  const shoot = async (file) => {
    const out = path.join(OUT_DIR, file);
    await canvas.screenshot({ path: out });
    return out;
  };

  // Pure unit test of resolveInitialQualityTier against SYNTHETIC limit sets so
  // the medium/high branches are exercised regardless of the headless adapter's
  // real capability (this CI adapter reports baseline mins → "low"). Each uses a
  // FRESH service instance so the per-instance tier cache doesn't bleed across.
  const tierUnit = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const Svc = C.VisualPerformanceTargetService;
    if (typeof Svc !== "function") {
      return { exported: false };
    }
    const tierFor = (limits) =>
      new Svc().resolveInitialQualityTier(limits ? { limits } : undefined);
    return {
      exported: true,
      nullDevice: new Svc().resolveInitialQualityTier(undefined),
      baseline: tierFor({
        // WebGPU spec baseline required minimums.
        maxBufferSize: 268435456,
        maxStorageBufferBindingSize: 134217728,
        maxComputeWorkgroupStorageSize: 16384,
        maxComputeInvocationsPerWorkgroup: 256,
      }),
      medium: tierFor({
        maxBufferSize: 536870912,
        maxStorageBufferBindingSize: 268435456,
        maxComputeWorkgroupStorageSize: 16384,
        maxComputeInvocationsPerWorkgroup: 256,
      }),
      high: tierFor({
        maxBufferSize: 1073741824,
        maxStorageBufferBindingSize: 536870912,
        maxComputeWorkgroupStorageSize: 32768,
        maxComputeInvocationsPerWorkgroup: 512,
      }),
    };
  });

  // A. VPT disabled (default) → auto → low.
  const vptOff = await applyFog(page, false);
  const pngOff = await shoot("probe-fog-auto-vpt-vptoff.png");

  // B. VPT enabled → auto → device init tier. NOTE: the fog renderer rebuilds
  // resources when the resolved tier changes, so toggling VPT on and re-resolving
  // picks up the new tier on the next update().
  const vptOn = await applyFog(page, true);
  const pngOn = await shoot("probe-fog-auto-vpt-vpton.png");

  const newErrs = errs.filter(
    (e) => !/AtmosphereLUT|default layout|favicon/.test(e),
  );

  console.log(
    JSON.stringify({ tierUnit, vptOff, vptOn, pngOff, pngOn }, null, 1),
  );

  const tiers = { low: 0, medium: 1, high: 2 };
  console.log("\n=== ANALYSIS ===");
  const checks = [
    [`TIER UNIT: service exported`, tierUnit.exported === true],
    [
      `TIER UNIT: null device → low (${tierUnit.nullDevice})`,
      tierUnit.nullDevice === "low",
    ],
    [
      `TIER UNIT: baseline mins → low (${tierUnit.baseline})`,
      tierUnit.baseline === "low",
    ],
    [
      `TIER UNIT: mid limits → medium (${tierUnit.medium})`,
      tierUnit.medium === "medium",
    ],
    [
      `TIER UNIT: high limits → high (${tierUnit.high})`,
      tierUnit.high === "high",
    ],
    [
      `A. VPT OFF + auto → fog tier "low" (got "${vptOff.fogResolutionKey}", vptEnabled=${vptOff.vptEnabled})`,
      vptOff.vptEnabled === false && vptOff.fogResolutionKey === "low",
    ],
    [
      `B. VPT ON + auto → fog tier == device init tier (fog="${vptOn.fogResolutionKey}", initTier="${vptOn.vptInitTier}", vptEnabled=${vptOn.vptEnabled})`,
      vptOn.vptEnabled === true &&
        vptOn.fogResolutionKey != null &&
        vptOn.fogResolutionKey === vptOn.vptInitTier,
    ],
    [
      `C. VPT ON tier >= VPT OFF tier (${vptOn.fogResolutionKey} >= ${vptOff.fogResolutionKey})`,
      tiers[vptOn.fogResolutionKey] >= tiers[vptOff.fogResolutionKey],
    ],
    [
      `init tier is a valid band (${vptOn.vptInitTier})`,
      ["low", "medium", "high"].includes(vptOn.vptInitTier),
    ],
    [`D. no new console errors`, newErrs.length === 0],
  ];
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) pass = false;
  }
  if (newErrs.length) {
    console.log("\n  console errors:");
    newErrs.slice(0, 6).forEach((e) => console.log(`    ${e}`));
  }
  console.log(
    `\nResolved tiers: VPT off => "${vptOff.fogResolutionKey}", VPT on => "${vptOn.fogResolutionKey}" (device init tier "${vptOn.vptInitTier}")`,
  );
  console.log(`Device limits used: ${JSON.stringify(vptOn.limits)}`);
  console.log(`\nPNGs: ${pngOff}, ${pngOn}`);
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
})();
