#!/usr/bin/env node
// Item 3-C (CLOUD-IBL-FULL, Batch 450) — full per-face cloud-march in the env cube.
//
// Verifies the opt-in `contextOptions.webgpu.cloudsInReflections` path: a low-res
// procedural cloud raymarch is composited OVER the env-sky faces (before the IBL
// prefilter), so a cloudy sky produces visible cloud STRUCTURE in the env cube
// (not just the 4.2 coarse darkening).
//
//   OFF (default, cloudsInReflections unset): the sky-fill march branch is never
//     taken (cloudMarch flag = 0, placeholder noise bound) → the env-cube faces
//     are byte-identical to the 4.2 coarse-darkening fill. The bind group binds a
//     1×1×1 placeholder noise; the cloud noise textures are never sampled.
//   ON: cloudsInReflections=true + procedural clouds rendering with real coverage
//     → the per-face march composites cloud structure over the sky. The env-cube
//     faces DIFFER from OFF (cloudier / more spatial variation across faces).
//   ON + envMapTemporalAccumulation: the march composes with temporal accumulation
//     (history+accum cube allocated, blend pipeline built, converges without
//     device errors).
//
// Strategy mirrors probe-env-temporal.mjs: one page / one shared WebGPU device,
// render the scene with procedural clouds ON so the cloud renderer bakes its 3D
// noise + publishes iblCoverage, then build a fresh DynamicEnvironmentMapManager
// per sub-test, patch the context flags, drive `.update()`, and read back the 6
// cube-face mean RGB via a compute reduction.
//
// Output: probe-cloud-ibl-full-faces.png (OFF vs ON vs ON+temporal tiled), console.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const report = await page.evaluate(async () => {
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    const viewer = window.viewer;
    const scene = viewer.scene;
    const ctx = scene.context;
    const device = ctx.device;
    if (!ctx._options) ctx._options = {};

    const lon = -105.0;
    const lat = 40.0;
    const surface = Cesium.Cartesian3.fromDegrees(lon, lat, 0);

    // Turn ON procedural clouds with a dense overcast deck so the cloud renderer
    // bakes its 3D noise + publishes a non-zero iblCoverage every frame.
    const globe = scene.globe;
    globe.defaultCloudCollection.enableVolumetric = true;
    globe.defaultCloudCollection.volumetric.cloudContributesIBL = true;
    globe.defaultCloudCollection.volumetric.cloudCoverage = 0.85;
    globe.defaultCloudCollection.volumetric.cloudDensity = 0.6;

    // Park over terrain, looking down, let tiles + clouds render so the cloud
    // noise bake runs and _cloudCache.noise + iblCoverage are populated.
    scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1_500_000),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
    for (let i = 0; i < 180; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Read back 6 cube-face mean RGB via a compute reduction (cube lacks COPY_SRC).
    async function readFaces(cubeTex, size) {
      const arrayView = cubeTex.createView({
        dimension: "2d-array",
        baseArrayLayer: 0,
        arrayLayerCount: 6,
        baseMipLevel: 0,
        mipLevelCount: 1,
      });
      const outBuf = device.createBuffer({
        size: 6 * 4 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const wgsl = `
@group(0) @binding(0) var cubeArr: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> outBuf: array<f32>;
const SIZE: u32 = ${size}u;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let face = gid.x;
  if (face >= 6u) { return; }
  var rsum = 0.0; var gsum = 0.0; var bsum = 0.0; var n = 0.0;
  for (var y: u32 = 0u; y < SIZE; y = y + 1u) {
    for (var x: u32 = 0u; x < SIZE; x = x + 1u) {
      let c = textureLoad(cubeArr, vec2<i32>(i32(x), i32(y)), i32(face), 0);
      rsum = rsum + c.r; gsum = gsum + c.g; bsum = bsum + c.b; n = n + 1.0;
    }
  }
  let base = face * 4u;
  outBuf[base + 0u] = rsum / max(n, 1.0);
  outBuf[base + 1u] = gsum / max(n, 1.0);
  outBuf[base + 2u] = bsum / max(n, 1.0);
  outBuf[base + 3u] = n;
}`;
      const module = device.createShaderModule({ code: wgsl });
      const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
      const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: arrayView },
          { binding: 1, resource: { buffer: outBuf } },
        ],
      });
      const enc = device.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(pipeline);
      cp.setBindGroup(0, bg);
      cp.dispatchWorkgroups(6);
      cp.end();
      const readBuf = device.createBuffer({
        size: 6 * 4 * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, 6 * 4 * 4);
      device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      const f = new Float32Array(readBuf.getMappedRange().slice(0));
      readBuf.unmap();
      outBuf.destroy();
      readBuf.destroy();
      const faces = [];
      for (let i = 0; i < 6; i++) {
        faces.push([
          Math.round(f[i * 4] * 255),
          Math.round(f[i * 4 + 1] * 255),
          Math.round(f[i * 4 + 2] * 255),
        ]);
      }
      return faces;
    }

    // Build + drive a manager. `clouds` toggles cloudsInReflections; `temporal`
    // toggles envMapTemporalAccumulation. We force NONE→SUNLIGHT dynamic lighting
    // path independent of this; the march only needs the flag + coverage + noise.
    async function runManager({ clouds, temporal, frames }) {
      ctx._options.webgpu = Object.assign({}, ctx._options.webgpu, {
        cloudsInReflections: clouds,
        envMapTemporalAccumulation: temporal,
      });
      const manager = new Cesium.DynamicEnvironmentMapManager();
      manager.enabled = true;
      manager.shouldUpdate = true;
      manager._position = surface;
      for (let i = 0; i < frames; i++) {
        scene.render(); // keeps publishCloudIblCoverage + cloud bake fresh
        manager.update(scene._frameState);
        await new Promise((r) => requestAnimationFrame(r));
      }
      const cache = manager._webgpuCache;
      const faces =
        cache && cache.cubemapTexture
          ? await readFaces(cache.cubemapTexture, cache.size)
          : null;
      return {
        faces,
        size: cache ? cache.size : 0,
        lastUsedCloudMarch: cache ? cache.lastUsedCloudMarch : null,
        hasCloudPlaceholder: !!(cache && cache.cloudPlaceholderView),
        hasHistoryCube: !!(cache && cache.historyCube),
        hasAccumCube: !!(cache && cache.accumCube),
        hasBlendPipeline: !!(cache && cache.blendPipeline),
      };
    }

    // Diagnostics: confirm the cloud renderer actually baked noise + published
    // a non-zero coverage (the march's preconditions).
    const cc = ctx._cloudCache;
    const cloudDiag = {
      iblCoverage: cc ? cc.iblCoverage : null,
      hasNoise: !!(cc && cc.noise),
      hasShapeView: !!(cc && cc.noise && cc.noise.shapeSampleView),
      hasDetailView: !!(cc && cc.noise && cc.noise.detailSampleView),
    };

    // ── Sub-test 1: OFF (default — cloudsInReflections unset) ──
    const off = await runManager({ clouds: false, temporal: false, frames: 24 });
    // ── Sub-test 2: ON (full march) with the DEFAULT deck/wind/density ──
    const on = await runManager({ clouds: true, temporal: false, frames: 24 });

    // ── Sub-test 2b (Batch 450 FIX 1 — the KEY new verification): ON with a
    // CUSTOM cloud config. Mutate the globe's live cloud deck/wind/density to
    // distinctly non-default values, re-render so publishCloudIblCoverage
    // republishes them onto _cloudCache, then run an ON manager. If the march
    // params now flow from _cloudCache (not the frozen frameState.globe default),
    // the env faces must DIFFER from the default-config ON faces. A much higher
    // deck + far denser cloud changes the shell geometry + opacity the per-face
    // march integrates, so the reflected cloud structure must shift.
    globe.defaultCloudCollection.volumetric.cloudLayerBottom = 6000.0; // default 1500
    globe.defaultCloudCollection.volumetric.cloudLayerTop = 11000.0; // default 4000
    globe.defaultCloudCollection.volumetric.cloudDensity = 0.95; // default 0.6 (already set above)
    globe.defaultCloudCollection.volumetric.cloudWindDirection = { x: -0.6, y: 0.8 }; // default { 0.7, 0.3 }
    globe.defaultCloudCollection.volumetric.cloudWindSpeed = 40.0; // default 15
    // Re-render so the cloud renderer republishes the new params (it bakes off
    // the same noise; only the deck/wind/density the manager reads change).
    for (let i = 0; i < 30; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const onCustom = await runManager({
      clouds: true,
      temporal: false,
      frames: 24,
    });
    // Snapshot what the cache now holds so the report can prove the values flow.
    const ccCustom = ctx._cloudCache;
    const customParams = {
      deckBottom: ccCustom ? ccCustom.iblDeckBottom : null,
      deckTop: ccCustom ? ccCustom.iblDeckTop : null,
      density: ccCustom ? ccCustom.iblDensity : null,
      windX: ccCustom ? ccCustom.iblWindX : null,
      windY: ccCustom ? ccCustom.iblWindY : null,
      windSpeed: ccCustom ? ccCustom.iblWindSpeed : null,
    };
    // Restore the default deck so the temporal sub-test runs the same geometry
    // the default ON sub-test did.
    globe.defaultCloudCollection.volumetric.cloudLayerBottom = 1500.0;
    globe.defaultCloudCollection.volumetric.cloudLayerTop = 4000.0;
    globe.defaultCloudCollection.volumetric.cloudWindDirection = { x: 0.7, y: 0.3 };
    globe.defaultCloudCollection.volumetric.cloudWindSpeed = 15.0;
    for (let i = 0; i < 20; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // ── Sub-test 3: ON + temporal accumulation ──
    const onTemporal = await runManager({
      clouds: true,
      temporal: true,
      frames: 36,
    });

    return { cloudDiag, off, on, onCustom, customParams, onTemporal };
  });

  // ── Console report + assertions ──
  const { cloudDiag, off, on, onCustom, customParams, onTemporal } = report;
  console.log("[probe-cloud-ibl-full] report:\n");
  console.log(
    `cloud renderer: iblCoverage=${cloudDiag.iblCoverage} noise=${cloudDiag.hasNoise} shape=${cloudDiag.hasShapeView} detail=${cloudDiag.hasDetailView}`,
  );
  console.log(
    `custom cloud params now on _cloudCache: deckBottom=${customParams.deckBottom} deckTop=${customParams.deckTop} density=${customParams.density} wind=(${customParams.windX},${customParams.windY}) speed=${customParams.windSpeed}`,
  );

  const dumpFaces = (label, r) => {
    console.log(`\n${label}:`);
    console.log(
      `  size=${r.size} lastUsedCloudMarch=${r.lastUsedCloudMarch} placeholder=${r.hasCloudPlaceholder} history=${r.hasHistoryCube} accum=${r.hasAccumCube} blendPipe=${r.hasBlendPipeline}`,
    );
    r.faces?.forEach((f, i) =>
      console.log(`  face ${i}: rgb=${JSON.stringify(f)}`),
    );
  };
  dumpFaces("OFF (default)", off);
  dumpFaces("ON (default config)", on);
  dumpFaces("ON (CUSTOM config)", onCustom);
  dumpFaces("ON + temporal", onTemporal);

  // Generic per-channel face delta between two face sets.
  const facesDelta = (a, b) => {
    let mx = 0,
      sum = 0,
      n = 0;
    if (a && b) {
      for (let i = 0; i < 6; i++) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(a[i][c] - b[i][c]);
          mx = Math.max(mx, d);
          sum += d;
          n++;
        }
      }
    }
    return { max: mx, mean: sum / Math.max(n, 1) };
  };

  // OFF vs ON delta — the march should visibly change the faces.
  const offOn = facesDelta(off.faces, on.faces);
  const maxDelta = offOn.max;
  console.log(
    `\nOFF↔ON face delta: max=${offOn.max} mean=${offOn.mean.toFixed(2)} (0..255 per channel)`,
  );

  // ON-default vs ON-custom delta — the KEY check. If the march params now flow
  // from _cloudCache, a custom deck/wind/density must change the env faces. A
  // zero delta would mean the params are still frozen at the default (the bug).
  const onCustomDelta = facesDelta(on.faces, onCustom.faces);
  console.log(
    `ON(default)↔ON(custom) face delta: max=${onCustomDelta.max} mean=${onCustomDelta.mean.toFixed(2)} (0..255 per channel)`,
  );

  // Per-face spatial variation (cloud structure makes faces differ from each
  // other more than a flat overcast dome does).
  const faceSpread = (faces) => {
    if (!faces) return 0;
    let mn = 255,
      mx = 0;
    faces.forEach((f) => {
      const lum = (f[0] + f[1] + f[2]) / 3;
      mn = Math.min(mn, lum);
      mx = Math.max(mx, lum);
    });
    return mx - mn;
  };
  const offSpread = faceSpread(off.faces);
  const onSpread = faceSpread(on.faces);
  console.log(
    `face-to-face luminance spread: OFF=${offSpread.toFixed(1)} ON=${onSpread.toFixed(1)}`,
  );

  const pass = [];
  pass.push([
    "cloud renderer baked noise",
    cloudDiag.hasNoise && cloudDiag.hasShapeView && cloudDiag.hasDetailView,
  ]);
  pass.push([
    "cloud renderer published non-zero iblCoverage",
    typeof cloudDiag.iblCoverage === "number" && cloudDiag.iblCoverage > 0,
  ]);
  pass.push(["OFF: lastUsedCloudMarch === false", off.lastUsedCloudMarch === false]);
  pass.push(["ON: lastUsedCloudMarch === true", on.lastUsedCloudMarch === true]);
  pass.push(["OFF: placeholder noise present", off.hasCloudPlaceholder === true]);
  pass.push([
    "OFF: no temporal resources",
    off.hasHistoryCube === false && off.hasBlendPipeline === false,
  ]);
  pass.push([
    "ON: env faces DIFFER from OFF (march composited)",
    off.faces && on.faces ? maxDelta > 3 : false,
  ]);
  pass.push([
    "ON: custom deck/wind/density flowed onto _cloudCache",
    customParams.deckBottom === 6000 &&
      customParams.deckTop === 11000 &&
      customParams.density === 0.95 &&
      customParams.windX === -0.6 &&
      customParams.windSpeed === 40,
  ]);
  pass.push([
    "ON: custom-config env faces DIFFER from default-config (params flow, not frozen)",
    on.faces && onCustom.faces ? onCustomDelta.max > 3 : false,
  ]);
  pass.push([
    "ON(custom): march still ran (clouds didn't break on the new deck)",
    onCustom.lastUsedCloudMarch === true,
  ]);
  pass.push([
    "ON+temporal: history+accum+blend allocated",
    onTemporal.hasHistoryCube === true &&
      onTemporal.hasAccumCube === true &&
      onTemporal.hasBlendPipeline === true,
  ]);
  pass.push([
    "ON+temporal: still used the march",
    onTemporal.lastUsedCloudMarch === true,
  ]);

  console.log("\nAssertions:");
  let allPass = true;
  pass.forEach(([name, ok]) => {
    console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
    if (!ok) allPass = false;
  });

  // Tile OFF / ON(default) / ON(custom) / ON+temporal face means into a PNG.
  if (off.faces && on.faces && onCustom.faces && onTemporal.faces) {
    const tile = await page.evaluate(
      ([offF, onF, customF, tF]) => {
        const c = document.createElement("canvas");
        const sw = 40;
        const rows = 4;
        c.width = 6 * (sw + 4) + 4;
        c.height = rows * (sw + 18) + 8;
        const g = c.getContext("2d");
        g.fillStyle = "#222";
        g.fillRect(0, 0, c.width, c.height);
        const names = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];
        const drawRow = (rgbs, y0, label) => {
          rgbs.forEach((rgb, i) => {
            g.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
            const x = 4 + i * (sw + 4);
            g.fillRect(x, y0, sw, sw);
            g.fillStyle = "#fff";
            g.font = "9px monospace";
            g.fillText(names[i], x + 2, y0 + sw + 10);
          });
          g.fillStyle = "#fff";
          g.font = "9px monospace";
          g.fillText(label, 4, y0 - 2);
        };
        drawRow(offF, 14, "OFF (default)");
        drawRow(onF, 14 + (sw + 18), "ON (default config)");
        drawRow(customF, 14 + 2 * (sw + 18), "ON (CUSTOM config)");
        drawRow(tF, 14 + 3 * (sw + 18), "ON + temporal");
        return c.toDataURL("image/png");
      },
      [off.faces, on.faces, onCustom.faces, onTemporal.faces],
    );
    const b64 = tile.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(
      path.join(OUT_DIR, "probe-cloud-ibl-full-faces.png"),
      Buffer.from(b64, "base64"),
    );
  }

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`\n${errs.length} console/validation errors:`);
    errs.slice(0, 12).forEach((e) => console.log(`  ${e.t}: ${e.text}`));
  } else {
    console.log("\n0 console/validation errors.");
  }
  console.log(
    "\noutput: Tools/visual-regression/output/probe-cloud-ibl-full-faces.png",
  );
  console.log(allPass ? "\nALL ASSERTIONS PASS" : "\nSOME ASSERTIONS FAILED");

  await browser.close();
  process.exit(allPass && errs.length === 0 ? 0 : 1);
})();
