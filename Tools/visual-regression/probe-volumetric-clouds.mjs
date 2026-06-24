#!/usr/bin/env node
/**
 * REPRODUCTION/SCOUT probe (probe-FIRST): does the WebGPU procedural volumetric
 * cloud raymarcher render at all? (Tier 4 — C2-15/16/17 prerequisite.)
 *
 * The cloud fidelity upgrades (Perlin-Worley noise, weather map, dual-lobe HG)
 * are only verifiable if the raymarcher actually produces cloud pixels on
 * WebGPU. This probe enables procedural clouds (globe.showProceduralClouds),
 * cranks coverage/density, frames a cloud-covered region from altitude, and
 * counts bright cloud-ish pixels on WebGPU vs WebGL.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-volumetric-clouds.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function run(renderer, fs) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const res = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene;
    const g = s.globe;

    // Enable the procedural volumetric clouds + crank visibility.
    const info = {};
    try {
      g.showProceduralClouds = true;
      info.showProceduralClouds = g.showProceduralClouds;
      // Moderate coverage frames distinct clouds against the sky. NB: high
      // coverage (≥0.8) + a camera INSIDE the 1500-4000m layer white-outs the
      // sky (physically a fog-out, not a bug — confirmed by the coverage sweep).
      if ("cloudCoverage" in g) g.cloudCoverage = 0.5;
      if ("cloudDensity" in g) g.cloudDensity = 0.8;
      info.cloudCoverage = g.cloudCoverage;
      info.cloudDensity = g.cloudDensity;
      info.cloudLayerBottom = g.cloudLayerBottom;
      info.cloudLayerTop = g.cloudLayerTop;
    } catch (e) {
      info.enableErr = e.message;
    }

    // Frame the cloud layer (1500-4000m) against the SKY — camera BELOW the
    // layer (800m) looking UP at the horizon so clouds appear as distinct
    // shapes over a blue sky (the regime where shape/lighting fidelity reads).
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 800.0),
      orientation: {
        heading: C.Math.toRadians(0.0),
        pitch: C.Math.toRadians(10.0),
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
    // Cloud-ish = bright, low-saturation (white/grey) pixels in the UPPER half
    // (sky region), excluding pure-blue sky.
    let cloudish = 0,
      upperBright = 0;
    for (let y = 0; y < Math.floor(h / 2); y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = px[i],
          gg = px[i + 1],
          b = px[i + 2];
        const mx = Math.max(r, gg, b),
          mn = Math.min(r, gg, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        if (mx > 150) upperBright++;
        // whitish/grey + bright → cloud
        if (mx > 150 && sat < 0.18) cloudish++;
      }
    }
    return {
      renderer: s.context?.rendererType,
      ...info,
      cloudish,
      upperBright,
      width: w,
      height: h,
    };
  });

  const buf = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    `Tools/visual-regression/output/volumetric-clouds-${renderer}.png`,
    buf,
  );
  await browser.close();
  return { res, errs: errs.filter((e) => !/AtmosphereLUT|default layout/.test(e)) };
}

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
const wgl = await run("webgl", fs);
const wgpu = await run("webgpu", fs);
console.log("WEBGL :", JSON.stringify(wgl.res));
console.log("WEBGPU:", JSON.stringify(wgpu.res));
if (wgpu.errs.length) console.log("  webgpu errs:", wgpu.errs.slice(0, 4));
console.log("\n=== DIAGNOSIS ===");
console.log(
  `webgl cloudish=${wgl.res.cloudish}  webgpu cloudish=${wgpu.res.cloudish}`,
);
console.log(
  `webgpu clouds render? ${wgpu.res.cloudish > 500 ? "YES" : "NO / negligible"}`,
);
