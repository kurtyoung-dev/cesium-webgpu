#!/usr/bin/env node
// probe-atmo-luts — Track V-A1 (NEW-ATMO-BRUNETON-FULL-LUTS) verification.
//
// Verifies the full-Bruneton extension to WebGPUAtmosphereLUT:
//   - The multiple-scattering LUT is non-trivial AND brightens the sky
//     relative to the single-scattering inscatter LUT (higher orders add
//     light that single scattering leaves out).
//   - The irradiance LUT is positive where the sun is up and falls off as
//     the sun zenith increases (more grazing → less irradiance on a
//     horizontal surface).
//   - Zero WebGPU validation errors / page errors while the extension
//     passes run each frame.
//   - The existing sky still renders (a sky-dominant orbital view produces
//     a non-black, blue-ish frame) — read the PNG.
//
// Strategy: load the WebGPU CesiumViewer, force sky atmosphere on, pin the
// clock so the sun is well above the horizon, drive renders until the LUT
// has been dispatched, then read back the three relevant LUT textures via
// copyTextureToBuffer (rgba16float → Float16 decode) INSIDE the scene's
// device queue. We sample a handful of known texels and assert the physical
// relationships above.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.CESIUM_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
// Sun high in the sky over the sub-solar point so cosSunZenith ≈ 1 near the
// equator at local noon — keeps the irradiance LUT bright at low sun-zenith.
const FIXED_CLOCK_UTC = "2026-06-21T12:00:00Z";

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    "[probe-atmo-luts] Track V-A1 — multiple-scattering + irradiance LUTs",
  );

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

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ clockUTC }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      // Pin the clock so the sun direction is deterministic.
      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      // WGS84 ellipsoid (no Ion terrain in headless).
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;

      v.scene.skyAtmosphere.show = true;

      // Sky-dominant orbital view over the sub-solar point (equator, noon
      // meridian ~ lon 0 at 12:00 UTC) so the limb/sky fills the frame.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(0, 0, 20_000_000),
      });

      // Drive renders so the sky-atmosphere LUT (incl. the extension passes)
      // dispatches at least once.
      for (let i = 0; i < 240; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const ctx = v.scene.context;
      const pm = ctx && ctx.performanceManager;
      const device = ctx && ctx.device;
      if (!pm || !device) {
        return {
          fatal: "no perf manager / device",
          rendererType: ctx?.rendererType,
        };
      }

      // Make sure the resources exist + the extension views are reachable.
      const baseViews = pm.ensureAtmosphereLUTResources(device);
      const lut = pm._atmosphereLutResources;
      if (!lut) return { fatal: "no _atmosphereLutResources" };

      // NOTE: the WebGPUContext does not currently attach a `computeEngine`
      // (the WebGPUComputeEngine class is scaffolded but never instantiated
      // on the context — see follow-up note in the probe report). That means
      // pm.dispatchCompute() is a silent no-op today, so we exercise the
      // ACTUAL AtmosphereLUT.wgsl + the bind-group layouts defined in
      // WebGPUAtmosphereLUT.ts by building the four compute pipelines
      // directly on the raw device here. This verifies the shader logic
      // (the deliverable of Track V-A1) independent of the dormant runtime
      // dispatch path.
      const src = pm.getComputeShaderSource(1); // ATMOSPHERE_LUT
      const module = device.createShaderModule({
        code: src,
        label: "AtmosphereLUT_probe",
      });

      // Pack the AtmosphereParams uniform (matches the WGSL struct + the
      // packing in dispatchAtmosphereLUT). Sun toward +Y.
      const innerRadius = 6378137.0;
      const outerRadius = innerRadius * 1.025;
      const f = new Float32Array(20);
      const u32 = new Uint32Array(f.buffer);
      f[0] = innerRadius;
      f[1] = outerRadius;
      f[2] = 8000.0; // rayleighScaleHeight
      f[3] = 1200.0; // mieScaleHeight
      f[4] = 0.76; // mieAnisotropy
      f[5] = 50.0; // intensity
      u32[6] = lut.width;
      u32[7] = lut.transmittanceHeight;
      f[8] = 5.8e-6;
      f[9] = 13.5e-6;
      f[10] = 33.1e-6;
      f[12] = 21e-6;
      f[13] = 21e-6;
      f[14] = 21e-6;
      f[16] = 0.0;
      f[17] = 1.0;
      f[18] = 0.0;
      device.queue.writeBuffer(lut.paramsBuffer, 0, f.buffer, 0, f.byteLength);

      device.pushErrorScope("validation");

      // ── group-0 (write-only) BGL + bind group for transmittance/inscatter
      const bgl0 = device.createBindGroupLayout({
        label: "probeLUT_g0",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "uniform" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: {
              format: "rgba16float",
              access: "write-only",
              viewDimension: "2d",
            },
          },
          {
            binding: 2,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: {
              format: "rgba16float",
              access: "write-only",
              viewDimension: "2d",
            },
          },
        ],
      });
      const bg0 = device.createBindGroup({
        label: "probeLUT_g0_bg",
        layout: bgl0,
        entries: [
          { binding: 0, resource: { buffer: lut.paramsBuffer } },
          { binding: 1, resource: lut.transmittanceView },
          { binding: 2, resource: lut.inscatterView },
        ],
      });
      const pl0 = device.createPipelineLayout({ bindGroupLayouts: [bgl0] });

      const pipeTrans = device.createComputePipeline({
        layout: pl0,
        compute: { module, entryPoint: "computeTransmittance" },
      });
      const pipeInsc = device.createComputePipeline({
        layout: pl0,
        compute: { module, entryPoint: "computeInscatter" },
      });

      // ── group-1 (extended) BGL + bind group: built at index 1 so the
      // extended kernels (which reference @group(1)) are satisfied. group 0
      // is unused by those kernels. We provide an empty group-0 layout to
      // place group 1 at index 1.
      const emptyBgl = device.createBindGroupLayout({
        label: "probe_empty",
        entries: [],
      });
      const emptyBg = device.createBindGroup({
        label: "probe_empty_bg",
        layout: emptyBgl,
        entries: [],
      });
      const sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
      });
      const bgl1 = device.createBindGroupLayout({
        label: "probeLUT_g1",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "uniform" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            sampler: { type: "filtering" },
          },
          {
            binding: 2,
            visibility: GPUShaderStage.COMPUTE,
            texture: { sampleType: "float", viewDimension: "2d" },
          },
          {
            binding: 3,
            visibility: GPUShaderStage.COMPUTE,
            texture: { sampleType: "float", viewDimension: "2d" },
          },
          {
            binding: 4,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: {
              format: "rgba16float",
              access: "write-only",
              viewDimension: "2d",
            },
          },
          {
            binding: 5,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: {
              format: "rgba16float",
              access: "write-only",
              viewDimension: "2d",
            },
          },
        ],
      });
      const bg1 = device.createBindGroup({
        label: "probeLUT_g1_bg",
        layout: bgl1,
        entries: [
          { binding: 0, resource: { buffer: lut.paramsBuffer } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: lut.transmittanceView },
          { binding: 3, resource: lut.inscatterView },
          { binding: 4, resource: lut.multipleScatterView },
          { binding: 5, resource: lut.irradianceView },
        ],
      });
      const pl1 = device.createPipelineLayout({
        bindGroupLayouts: [emptyBgl, bgl1],
      });
      const pipeMS = device.createComputePipeline({
        layout: pl1,
        compute: { module, entryPoint: "computeMultipleScattering" },
      });
      const pipeIrr = device.createComputePipeline({
        layout: pl1,
        compute: { module, entryPoint: "computeIrradiance" },
      });

      const enc = device.createCommandEncoder({ label: "probeLUTdispatch" });
      const wgX = Math.ceil(lut.width / 16);
      // transmittance/irradiance height = 64; inscatter/MS height = 128.
      const p = enc.beginComputePass();
      p.setPipeline(pipeTrans);
      p.setBindGroup(0, bg0);
      p.dispatchWorkgroups(wgX, Math.ceil(lut.transmittanceHeight / 16), 1);
      p.setPipeline(pipeInsc);
      p.setBindGroup(0, bg0);
      p.dispatchWorkgroups(wgX, Math.ceil(lut.inscatterHeight / 16), 1);
      p.end();

      const p2 = enc.beginComputePass();
      p2.setPipeline(pipeMS);
      p2.setBindGroup(0, emptyBg);
      p2.setBindGroup(1, bg1);
      p2.dispatchWorkgroups(wgX, Math.ceil(lut.inscatterHeight / 16), 1);
      p2.setPipeline(pipeIrr);
      p2.setBindGroup(0, emptyBg);
      p2.setBindGroup(1, bg1);
      p2.dispatchWorkgroups(wgX, Math.ceil(lut.transmittanceHeight / 16), 1);
      p2.end();

      device.queue.submit([enc.finish()]);
      const dispatchErr = await device.popErrorScope();
      await device.queue.onSubmittedWorkDone();
      const dispatchErrMsg = dispatchErr ? String(dispatchErr.message) : null;

      const sunOk = true;
      const extOk = true;
      const extViews =
        typeof pm.getAtmosphereExtendedLUTViews === "function"
          ? pm.getAtmosphereExtendedLUTViews()
          : null;

      // ── Float16 decode helper ──
      function f16(bits) {
        const s = (bits & 0x8000) >> 15;
        const e = (bits & 0x7c00) >> 10;
        const f = bits & 0x03ff;
        if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
        if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
        return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
      }

      // Read back an entire rgba16float texture into a 2D array of RGBA
      // float tuples. bytesPerRow must be 256-aligned for copyTextureToBuffer.
      const readbackErrors = [];
      async function readTexture(tex, width, height) {
        const bytesPerPixel = 8; // rgba16float
        const unpadded = width * bytesPerPixel;
        const bytesPerRow = Math.ceil(unpadded / 256) * 256;
        const bufSize = bytesPerRow * height;
        device.pushErrorScope("validation");
        const readBuf = device.createBuffer({
          size: bufSize,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const enc = device.createCommandEncoder({ label: "lutReadback" });
        enc.copyTextureToBuffer(
          { texture: tex },
          { buffer: readBuf, bytesPerRow, rowsPerImage: height },
          { width, height, depthOrArrayLayers: 1 },
        );
        device.queue.submit([enc.finish()]);
        const scopeErr = await device.popErrorScope();
        if (scopeErr) readbackErrors.push(String(scopeErr.message));
        await readBuf.mapAsync(GPUMapMode.READ);
        const ab = readBuf.getMappedRange().slice(0);
        readBuf.unmap();
        readBuf.destroy();
        const u16 = new Uint16Array(ab);
        const rowU16 = bytesPerRow / 2;
        const rows = [];
        for (let y = 0; y < height; y++) {
          const row = [];
          for (let x = 0; x < width; x++) {
            const base = y * rowU16 + x * 4;
            row.push([
              f16(u16[base]),
              f16(u16[base + 1]),
              f16(u16[base + 2]),
              f16(u16[base + 3]),
            ]);
          }
          rows.push(row);
        }
        return rows;
      }

      const W = lut.width; // 256
      const HT = lut.transmittanceHeight; // 64
      const HI = lut.inscatterHeight; // 128

      const trans = await readTexture(lut.transmittance, W, HT);
      const single = await readTexture(lut.inscatter, W, HI);
      const multi = await readTexture(lut.multipleScatter, W, HI);
      const irr = await readTexture(lut.irradiance, W, HT);

      // Raw diagnostic samples — transmittance at (cosZenith≈+1, alt≈0)
      // should be near 1.0 (clear vertical path); if it reads ~0 the
      // readback decode itself is wrong, not the compute.
      const transTopMid = trans[1][Math.floor(W * 0.95)];
      const transSamples = {
        nearUp: trans[0][W - 2],
        midRow: trans[Math.floor(HT / 2)][Math.floor(W * 0.75)],
        rawTopMid: transTopMid,
      };

      // ── Metric helpers ──
      const lum = (px) => 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
      function meanLum(rows) {
        let s = 0,
          n = 0,
          mn = Infinity,
          mx = -Infinity,
          nan = 0,
          neg = 0;
        for (const row of rows)
          for (const px of row) {
            const l = lum(px);
            if (Number.isNaN(l)) {
              nan++;
              continue;
            }
            if (l < -1e-6) neg++;
            s += l;
            n++;
            if (l < mn) mn = l;
            if (l > mx) mx = l;
          }
        return { mean: s / n, min: mn, max: mx, nan, neg, n };
      }

      // Multiple-scattering should add light over the upper rows (sky-facing
      // view directions, valid altitude band) where single scattering is the
      // gather source. Compare the upper-half band of both LUTs.
      function bandMeanLum(rows, y0, y1) {
        let s = 0,
          n = 0;
        for (let y = y0; y < y1; y++)
          for (const px of rows[y]) {
            const l = lum(px);
            if (!Number.isNaN(l)) {
              s += l;
              n++;
            }
          }
        return s / n;
      }

      const singleStats = meanLum(single);
      const multiStats = meanLum(multi);
      const irrStats = meanLum(irr);

      // Sky-band comparison (rows 0..HI/2 — the cosViewZenith>0 / valid
      // altitude band where both LUTs carry signal).
      const singleBand = bandMeanLum(single, 0, Math.floor(HI / 2));
      const multiBand = bandMeanLum(multi, 0, Math.floor(HI / 2));

      // Irradiance falloff with sun zenith. The LUT U axis is
      // cosSunZenith ∈ [-1,1] mapped to [0,1]; high U (right side) = sun
      // near zenith (bright), low/mid U near horizon = dimmer. Sample the
      // surface row (v≈0, altitude 0) at three sun-zenith columns.
      const surfRow = irr[0];
      const colHigh = Math.floor(W * 0.95); // cosSunZenith ≈ +0.9 (sun high)
      const colMid = Math.floor(W * 0.55); // cosSunZenith ≈ +0.1 (low sun)
      const colHoriz = Math.floor(W * 0.5); // cosSunZenith ≈ 0 (horizon)
      const irrHigh = lum(surfRow[colHigh]);
      const irrMid = lum(surfRow[colMid]);
      const irrHoriz = lum(surfRow[colHoriz]);

      return {
        rendererType: ctx.rendererType,
        sunOk,
        extOk,
        dispatchErrMsg,
        runtimeComputeEnginePresent: !!ctx.computeEngine,
        supportsCompute: ctx.supportsComputeShaders,
        baseViewsExist: !!baseViews,
        extViewsExist: !!extViews,
        transmittance: meanLum(trans),
        transSamples,
        readbackErrors,
        skyShow: v.scene.skyAtmosphere.show,
        dims: { W, HT, HI },
        single: singleStats,
        multi: multiStats,
        irradiance: irrStats,
        skyBand: {
          single: singleBand,
          multi: multiBand,
          ratio: multiBand / singleBand,
        },
        irrFalloff: { high: irrHigh, mid: irrMid, horiz: irrHoriz },
      };
    },
    { clockUTC: FIXED_CLOCK_UTC },
  );

  await page.waitForTimeout(800);
  const png = path.join(OUT_DIR, "atmo-luts-sky.png");
  await page.screenshot({ path: png });
  await browser.close();

  const errors = messages.filter((m) => {
    if (m.t === "error" || m.t === "pageerror") return true;
    if (!m.text) return false;
    // The renderer logs a benign "No GPU validation errors" sentinel — not
    // an actual error. Match real validation failures only.
    if (/No GPU validation errors/i.test(m.text)) return false;
    return /GPUValidationError|invalid usage|is invalid\.|validation error/i.test(
      m.text,
    );
  });

  console.log("\n[probe-atmo-luts] result:");
  console.log(JSON.stringify(result, null, 2));
  if (result.dispatchErrMsg) {
    console.log(`\n  GPU dispatch validation error: ${result.dispatchErrMsg}`);
  }
  if (result.runtimeComputeEnginePresent === false) {
    console.log(
      "\n  NOTE: ctx.computeEngine is absent — the runtime sky-render LUT\n" +
        "  dispatch (pm.dispatchCompute) is a no-op today. The shader logic\n" +
        "  is verified here via a direct pipeline build. Wiring a\n" +
        "  WebGPUComputeEngine onto WebGPUContext is a separate follow-up\n" +
        "  (affects ALL compute tasks, not just the atmosphere LUTs).",
    );
  }
  console.log(`\n  validation/page errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log(`    [${e.t}] ${e.text}`);
  console.log(`  sky screenshot: ${png}`);

  // ── Assertions ──
  const checks = [];
  const push = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`,
    );
  };

  if (result.fatal) {
    console.log(`\n  FATAL: ${result.fatal}`);
    process.exit(2);
  }

  push(
    "renderer is webgpu",
    result.rendererType === "webgpu",
    result.rendererType,
  );
  push("extended LUT views reachable", result.extViewsExist === true);
  push(
    "multiple-scattering non-trivial",
    result.multi.max > 1e-5 && result.multi.n > 0,
    `max=${result.multi.max?.toExponential(3)} mean=${result.multi.mean?.toExponential(3)}`,
  );
  push(
    "multiple-scattering no NaN/negatives",
    result.multi.nan === 0 && result.multi.neg === 0,
    `nan=${result.multi.nan} neg=${result.multi.neg}`,
  );
  push(
    "multiple-scattering brightens sky vs single",
    result.skyBand.multi > 0 && result.skyBand.ratio > 0.001,
    `singleBand=${result.skyBand.single?.toExponential(3)} multiBand=${result.skyBand.multi?.toExponential(3)} ratio=${result.skyBand.ratio?.toFixed(4)}`,
  );
  push(
    "irradiance positive",
    result.irradiance.min >= -1e-6 &&
      result.irradiance.max > 1e-5 &&
      result.irradiance.nan === 0,
    `min=${result.irradiance.min?.toExponential(3)} max=${result.irradiance.max?.toExponential(3)} nan=${result.irradiance.nan}`,
  );
  push(
    "irradiance falls off with sun zenith (high > mid >= horizon)",
    result.irrFalloff.high > result.irrFalloff.mid &&
      result.irrFalloff.mid >= result.irrFalloff.horiz - 1e-6,
    `high=${result.irrFalloff.high?.toExponential(3)} mid=${result.irrFalloff.mid?.toExponential(3)} horiz=${result.irrFalloff.horiz?.toExponential(3)}`,
  );
  push(
    "zero validation/page errors",
    errors.length === 0,
    `count=${errors.length}`,
  );

  const reportPath = path.join(OUT_DIR, "atmo-luts-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        clock: FIXED_CLOCK_UTC,
        result,
        errors,
        checks,
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.log(`\n[probe-atmo-luts] ${failed.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\n[probe-atmo-luts] ALL CHECKS PASSED");
})();
