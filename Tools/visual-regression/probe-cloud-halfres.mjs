#!/usr/bin/env node
/**
 * Cloud half-res (V9 / CLOUD-HALFRES, Batch 432) probe.
 * @purpose B432 half-res tier quality gate: 0.5x march + bilateral upscale vs full-res at identical camera/time; no blocky pixelation or edge halos
 * @status ACTIVE
 *
 * Captures the WebGPU procedural clouds at the DEFAULT/cinematic FULL-RES tier
 * (cloudVolumetricQuality='high' → T3, renderResScale=1.0) vs a HALF-RES tier
 * (cloudVolumetricQuality='medium' → T2, renderResScale=0.5 → 0.5× raymarch +
 * depth-aware bilateral upscale), at an identical camera/time, so the two PNGs can
 * be read side by side.
 *
 * Gates:
 *  - No new WebGPU console errors in either tier.
 *  - Half-res clouds visually close to full-res (slightly softer ok); NO blocky 2×
 *    pixelation, NO dark/bright edge halos at cloud/terrain/sky silhouettes.
 *
 * Output: output/cloud-halfres/{fullres,halfres}-webgpu.png + a metric table.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-halfres.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

// Scattered cumulus over plains, look-up, noon — clouds against terrain + sky so
// the bilateral silhouette is exercised.
const SCENE = {
  proc: { coverage: 0.45, density: 0.75, bottom: 1500, top: 3800 },
  camera: { lon: -95, lat: 39, height: 1200, heading: 0, pitch: 12 },
  timeIso: "2026-06-21T18:20:00Z",
};

async function setupAndCapture(page, quality) {
  return page.evaluate(
    async ({ scene, quality }) => {
      const v = window.viewer,
        s = v.scene,
        g = s.globe;
      s.skyBox.show = true;
      s.sun.show = true;
      s.skyAtmosphere.show = true;
      s.globe.show = true;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = window.Cesium
        ? window.Cesium.JulianDate.fromIso8601(scene.timeIso)
        : v.clock.currentTime;

      g.defaultCloudCollection.enableVolumetric = true;
      g.defaultCloudCollection.volumetric.cloudCoverage = scene.proc.coverage;
      g.defaultCloudCollection.volumetric.cloudDensity = scene.proc.density;
      g.defaultCloudCollection.volumetric.cloudLayerBottom = scene.proc.bottom;
      g.defaultCloudCollection.volumetric.cloudLayerTop = scene.proc.top;
      // Force the tier: 'high' = cinematic full-res (renderResScale 1.0);
      // 'medium' = T2 half-res (renderResScale 0.5).
      g.defaultCloudCollection.volumetric.cloudVolumetricQuality = quality;

      const C = await import("/Build/CesiumUnminified/index.js");
      v.clock.currentTime = C.JulianDate.fromIso8601(scene.timeIso);
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          scene.camera.lon,
          scene.camera.lat,
          scene.camera.height,
        ),
        orientation: {
          heading: C.Math.toRadians(scene.camera.heading),
          pitch: C.Math.toRadians(scene.camera.pitch),
          roll: 0.0,
        },
      });

      for (let i = 0; i < 160; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const canvas = s.canvas,
        w = canvas.width,
        h = canvas.height;
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      const cx = tmp.getContext("2d");
      cx.drawImage(canvas, 0, 0);
      const px = cx.getImageData(0, 0, w, h).data;
      let cloudish = 0,
        lumSum = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i],
          gg = px[i + 1],
          b = px[i + 2];
        const mx = Math.max(r, gg, b),
          mn = Math.min(r, gg, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        if (mx > 150 && sat < 0.2) {
          cloudish++;
          lumSum += mx;
        }
      }
      return {
        renderer: s.context?.rendererType,
        cloudish,
        cloudMeanLum: cloudish ? Math.round(lumSum / cloudish) : 0,
        width: w,
        height: h,
      };
    },
    { scene: SCENE, quality },
  );
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output/cloud-halfres", {
    recursive: true,
  });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const out = {};
  for (const [label, quality] of [
    ["fullres", "high"],
    ["halfres", "medium"],
  ]) {
    const res = await setupAndCapture(page, quality);
    const buf = await page.screenshot({ omitBackground: false });
    const path = `Tools/visual-regression/output/cloud-halfres/${label}-webgpu.png`;
    fs.writeFileSync(path, buf);
    out[label] = res;
    console.log(
      `  [${label}] q=${quality} cloudish=${res.cloudish} meanLum=${res.cloudMeanLum} renderer=${res.renderer} → ${path}`,
    );
  }
  await browser.close();

  const newErrs = errs.filter(
    (e) => !/AtmosphereLUT|default layout|favicon/.test(e),
  );
  console.log("\n=== SUMMARY ===");
  console.log("fullres:", JSON.stringify(out.fullres));
  console.log("halfres:", JSON.stringify(out.halfres));
  if (out.fullres && out.halfres) {
    const dCloud =
      out.halfres.cloudish && out.fullres.cloudish
        ? (
            (100 * Math.abs(out.halfres.cloudish - out.fullres.cloudish)) /
            out.fullres.cloudish
          ).toFixed(1)
        : "n/a";
    console.log(`cloudish delta (half vs full): ${dCloud}%`);
  }
  console.log(
    newErrs.length
      ? `\nNEW console errors:\n${newErrs.slice(0, 6).join("\n")}`
      : "\nNo new console errors.",
  );
  console.log(
    "\nPNGs: Tools/visual-regression/output/cloud-halfres/{fullres,halfres}-webgpu.png",
  );
})();
