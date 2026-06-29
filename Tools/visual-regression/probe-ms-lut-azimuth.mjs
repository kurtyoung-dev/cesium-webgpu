#!/usr/bin/env node
// Batch 429 — read back the MULTIPLE-SCATTERING + SKY-VIEW LUTs after the real
// renderer bakes them, and report how each varies across U (the relative
// view↔sun azimuth axis) at a near-horizon V row. After the A-LUT-REPARAM
// follow-up the MS LUT should vary with U (azimuth) the way the sky-view LUT
// does — confirming the directional all-azimuth re-param, not a flat veil.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const TIME_ISO = process.env.SKY_MS_TIME || "2026-05-19T23:30:00Z";
const VIEW = { lon: -80.0, lat: 40.0, height: 200.0 };

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ view, timeIso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const fixed = C.JulianDate.fromIso8601(timeIso);
      v.clock.currentTime = fixed.clone();
      v.clock.shouldAnimate = false;
      const sky = v.scene.skyAtmosphere;
      sky.show = true;
      sky.multipleScattering = true; // ensure the extended bake runs
      v.scene.globe.show = false;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(287.0),
          pitch: C.Math.toRadians(-2.0),
          roll: 0.0,
        },
      });
      // Render enough frames for the sun-move bake to settle.
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const ctx = v.scene.context;
      const device = ctx._device || ctx.device;
      const pm = ctx._performanceManager || ctx.performanceManager;
      const lut = pm && pm._atmosphereLutResources;
      if (!lut) return { fatal: "no _atmosphereLutResources" };

      function f16(bits) {
        const s = (bits & 0x8000) >> 15;
        const e = (bits & 0x7c00) >> 10;
        const f = bits & 0x03ff;
        if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
        if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
        return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
      }
      async function readTexture(tex, width, height) {
        const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
        const buf = device.createBuffer({
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer(
          { texture: tex },
          { buffer: buf, bytesPerRow, rowsPerImage: height },
          { width, height, depthOrArrayLayers: 1 },
        );
        device.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        const u16 = new Uint16Array(buf.getMappedRange().slice(0));
        buf.unmap();
        buf.destroy();
        const rowU16 = bytesPerRow / 2;
        const rows = [];
        for (let y = 0; y < height; y++) {
          const r = [];
          for (let x = 0; x < width; x++) {
            const b = y * rowU16 + x * 4;
            r.push([f16(u16[b]), f16(u16[b + 1]), f16(u16[b + 2])]);
          }
          rows.push(r);
        }
        return rows;
      }
      const W = lut.width,
        HI = lut.inscatterHeight;
      const ms = await readTexture(lut.multipleScatter, W, HI);
      const sv = await readTexture(lut.skyView, W, HI);
      const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

      // Sample U columns at a near-horizon-above row. V row: just above the
      // horizon (V≈0.55 → cosViewZenith small positive). HI=128 → row ~70.
      const vRow = Math.floor(HI * 0.55);
      function sweep(rows) {
        const cols = [0, 0.25, 0.5, 0.75, 0.99]; // U = azimuth fraction
        return cols.map((u) => {
          const x = Math.min(W - 1, Math.floor(u * W));
          return lum(rows[vRow][x]);
        });
      }
      const msSweep = sweep(ms);
      const svSweep = sweep(sv);
      function spread(a) {
        const mn = Math.min(...a),
          mx = Math.max(...a);
        return { min: mn, max: mx, ratio: mn > 1e-9 ? mx / mn : Infinity };
      }
      return {
        vRow,
        msSweep,
        svSweep,
        msSpread: spread(msSweep),
        svSpread: spread(svSweep),
      };
    },
    { view: VIEW, timeIso: TIME_ISO },
  );

  console.log(`[ms-lut-azimuth] time=${TIME_ISO}`);
  if (result.fatal) {
    console.log("  FATAL:", result.fatal);
  } else {
    const fmt = (a) => a.map((x) => x.toExponential(2)).join("  ");
    console.log(`  V row index = ${result.vRow} (near-horizon-above)`);
    console.log(`  U sweep cols = [0, 0.25, 0.5, 0.75, 0.99] (azimuth fraction)`);
    console.log(`  MS   LUT lum: ${fmt(result.msSweep)}`);
    console.log(
      `    spread min=${result.msSpread.min.toExponential(2)} max=${result.msSpread.max.toExponential(2)} max/min=${result.msSpread.ratio.toFixed(2)}`,
    );
    console.log(`  SKY  LUT lum: ${fmt(result.svSweep)}`);
    console.log(
      `    spread min=${result.svSpread.min.toExponential(2)} max=${result.svSpread.max.toExponential(2)} max/min=${result.svSpread.ratio.toFixed(2)}`,
    );
  }
  if (errs.length) {
    console.log(`  [console errors: ${errs.length}]`);
    errs.slice(0, 6).forEach((e) => console.log("    " + e));
  } else {
    console.log("  [0 console errors]");
  }
  await browser.close();
})();
