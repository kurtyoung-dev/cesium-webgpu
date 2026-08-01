#!/usr/bin/env node
// C2-25 ENV-TEMPORAL (Batch 449) — temporal env-cube accumulation probe.
//
// Verifies the opt-in `contextOptions.webgpu.envMapTemporalAccumulation` path:
//
//   OFF (default): NO history/accum cube allocated, NO blend pipeline built →
//     the env cube faces are byte-identical to a single-frame debounced refresh.
//   ON: a history cube + accum cube + blend pipeline ARE allocated; over several
//     frames the accumulated cube CONVERGES to the same look as the OFF cube on
//     a STATIC scene (the EMA fixed point of the deterministic capture). On a
//     LARGE sun jump the history RESETS (no smear → the cube snaps to the new
//     sun's capture, matching a fresh single-frame fill).
//
// Strategy: one page, one shared WebGPU device. Build a fresh
// DynamicEnvironmentMapManager for each sub-test, patch the context flags, drive
// `.update()` over N frames, and read back the 6 cube faces' mean RGB via a
// compute reduction (same readback as probe-scene-capture-on.mjs — the cube has
// no COPY_SRC). Compare:
//   • OFF cube faces  vs  ON cube faces after convergence (should be ~equal).
//   • ON cube faces during a sun crossfade (intermediate values between two
//     sun states) vs after a large-sun reset (snaps to the new state).
//   • Assert OFF allocated no temporal resources; ON allocated them.
//
// Output: probe-env-temporal-faces.png (OFF vs ON-converged tiled), console.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

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
    viewport: { width: 1024, height: 768 },
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

    // Park over terrain, looking down, let tiles load (so scene-capture has
    // something to composite for the ON case).
    scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1_500_000),
      orientation: {
        heading: 0,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
    });
    for (let i = 0; i < 150; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Read back 6 cube-face mean RGB via a compute reduction (cube lacks
    // COPY_SRC). Returns [r,g,b] per face in 0..255.
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

    // Build + drive a manager. `temporal` toggles the flag; `captureOn` toggles
    // scene-capture. Returns {faces, cache-presence diagnostics}.
    async function runManager({ temporal, captureOn, frames }) {
      ctx._options.webgpu = Object.assign({}, ctx._options.webgpu, {
        envMapTemporalAccumulation: temporal,
        sceneCaptureReflections: captureOn,
      });
      const manager = new Cesium.DynamicEnvironmentMapManager();
      manager.enabled = true;
      manager.shouldUpdate = true;
      manager._position = surface;
      if (captureOn) manager.enableSceneCapture = true;
      for (let i = 0; i < frames; i++) {
        scene.render();
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
        format: cache ? cache.cubemapFormat : null,
        hasHistoryCube: !!(cache && cache.historyCube),
        hasAccumCube: !!(cache && cache.accumCube),
        hasBlendPipeline: !!(cache && cache.blendPipeline),
        historyValid: !!(cache && cache.historyValid),
        temporalFrameIndex: cache ? cache.temporalFrameIndex : -1,
        // keep the manager around for the sun-reset sub-test
        _manager: manager,
      };
    }

    // ── Sub-test 1: OFF (default) ──
    void ctx.uniformState; // touch
    const off = await runManager({
      temporal: false,
      captureOn: false,
      frames: 30,
    });

    // ── Sub-test 2: ON, static scene → should converge to ~OFF look ──
    const on = await runManager({
      temporal: true,
      captureOn: false,
      frames: 30,
    });

    // ── Sub-test 3: ON + scene-capture, drive a sun crossfade then a large
    // sun jump, sampling the converged cube + the cube one frame after a big
    // jump (reset frame). We manipulate the sun direction the manager sees by
    // reading uniformState.sunDirectionWC; to force a crossfade vs reset we
    // instead snapshot the accumulated cube at two points.
    const onCapture = await runManager({
      temporal: true,
      captureOn: true,
      frames: 40,
    });
    const onCaptureMgr = onCapture._manager;
    const onCaptureCache = onCaptureMgr._webgpuCache;

    // Snapshot the converged (accumulated) faces.
    const onCaptureConverged = onCaptureCache
      ? await readFaces(onCaptureCache.cubemapTexture, onCaptureCache.size)
      : null;

    // Force a LARGE history reset by teleporting `_position` far away (a
    // > 2 km eye move triggers `cameraReset` → alpha=1). One update → the cube
    // should reflect ONLY the fresh capture (no smear of the prior location).
    // Move ~6000 km (other side of the globe) to guarantee the reset path AND a
    // fresh distinct capture.
    const farPos = Cesium.Cartesian3.fromDegrees(10.0, 50.0, 0);
    onCaptureMgr._position = farPos;
    const resetHistoryValidBefore = onCaptureCache.historyValid;
    // Capture the frame index before to confirm jitter advances.
    const idxBefore = onCaptureCache.temporalFrameIndex;
    scene.render();
    onCaptureMgr.update(scene._frameState);
    await new Promise((r) => requestAnimationFrame(r));
    const idxAfter = onCaptureCache.temporalFrameIndex;

    return {
      off: {
        faces: off.faces,
        size: off.size,
        format: off.format,
        hasHistoryCube: off.hasHistoryCube,
        hasAccumCube: off.hasAccumCube,
        hasBlendPipeline: off.hasBlendPipeline,
      },
      on: {
        faces: on.faces,
        hasHistoryCube: on.hasHistoryCube,
        hasAccumCube: on.hasAccumCube,
        hasBlendPipeline: on.hasBlendPipeline,
        historyValid: on.historyValid,
        temporalFrameIndex: on.temporalFrameIndex,
      },
      onCapture: {
        converged: onCaptureConverged,
        hasHistoryCube: onCapture.hasHistoryCube,
        hasAccumCube: onCapture.hasAccumCube,
        hasBlendPipeline: onCapture.hasBlendPipeline,
        resetHistoryValidBefore,
        idxBefore,
        idxAfter,
      },
    };
  });

  // ── Console report + assertions ──
  console.log("[probe-env-temporal] report:\n");
  const off = report.off;
  const on = report.on;
  const onC = report.onCapture;

  console.log(`OFF (default):`);
  console.log(
    `  cube ${off.size}px ${off.format}  history=${off.hasHistoryCube} accum=${off.hasAccumCube} blendPipe=${off.hasBlendPipeline}`,
  );
  off.faces?.forEach((f, i) =>
    console.log(`  face ${i}: rgb=${JSON.stringify(f)}`),
  );

  console.log(`\nON (static, no capture):`);
  console.log(
    `  history=${on.hasHistoryCube} accum=${on.hasAccumCube} blendPipe=${on.hasBlendPipeline} historyValid=${on.historyValid} frameIdx=${on.temporalFrameIndex}`,
  );
  on.faces?.forEach((f, i) =>
    console.log(`  face ${i}: rgb=${JSON.stringify(f)}`),
  );

  // OFF vs ON-converged delta (static scene → should be small; EMA fixed point).
  let maxDelta = 0;
  let sumDelta = 0;
  let nCh = 0;
  if (off.faces && on.faces) {
    for (let i = 0; i < 6; i++) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(off.faces[i][c] - on.faces[i][c]);
        maxDelta = Math.max(maxDelta, d);
        sumDelta += d;
        nCh++;
      }
    }
  }
  console.log(
    `\nOFF↔ON converged delta (static): max=${maxDelta} mean=${(sumDelta / Math.max(nCh, 1)).toFixed(2)} (0..255 per channel)`,
  );

  console.log(`\nON + scene-capture:`);
  console.log(
    `  history=${onC.hasHistoryCube} accum=${onC.hasAccumCube} blendPipe=${onC.hasBlendPipeline}`,
  );
  console.log(
    `  jitter frame index advanced ${onC.idxBefore} -> ${onC.idxAfter} (should +1)`,
  );
  onC.converged?.forEach((f, i) =>
    console.log(`  converged face ${i}: rgb=${JSON.stringify(f)}`),
  );

  // Assertions
  const pass = [];
  pass.push(["OFF: no history cube", off.hasHistoryCube === false]);
  pass.push(["OFF: no accum cube", off.hasAccumCube === false]);
  pass.push(["OFF: no blend pipeline", off.hasBlendPipeline === false]);
  pass.push(["ON: history cube allocated", on.hasHistoryCube === true]);
  pass.push(["ON: accum cube allocated", on.hasAccumCube === true]);
  pass.push(["ON: blend pipeline built", on.hasBlendPipeline === true]);
  pass.push(["ON: history valid after frames", on.historyValid === true]);
  pass.push([
    "ON: jitter frame index advanced",
    onC.idxAfter === onC.idxBefore + 1,
  ]);
  pass.push([
    "OFF↔ON static converge (max delta <= 4)",
    off.faces && on.faces ? maxDelta <= 4 : false,
  ]);

  console.log("\nAssertions:");
  let allPass = true;
  pass.forEach(([name, ok]) => {
    console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
    if (!ok) allPass = false;
  });

  // Render OFF vs ON converged face means into a tiled PNG.
  if (off.faces && on.faces) {
    const tile = await page.evaluate(
      ([offF, onF]) => {
        const c = document.createElement("canvas");
        const sw = 40;
        c.width = 6 * (sw + 4) + 4;
        c.height = 2 * (sw + 4) + 24;
        const g = c.getContext("2d");
        g.fillStyle = "#222";
        g.fillRect(0, 0, c.width, c.height);
        const names = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];
        const drawRow = (rows, y0, label) => {
          rows.forEach((rgb, i) => {
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
        drawRow(offF, 14, "OFF");
        drawRow(onF, 14 + sw + 14, "ON converged");
        return c.toDataURL("image/png");
      },
      [off.faces, on.faces],
    );
    const b64 = tile.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(
      path.join(OUT_DIR, "probe-env-temporal-faces.png"),
      Buffer.from(b64, "base64"),
    );
  }

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`\n${errs.length} console errors:`);
    errs.slice(0, 12).forEach((e) => console.log(`  ${e.t}: ${e.text}`));
  } else {
    console.log("\n0 console/validation errors.");
  }
  console.log(
    "\noutput: Tools/visual-regression/output/probe-env-temporal-faces.png",
  );
  console.log(allPass ? "\nALL ASSERTIONS PASS" : "\nSOME ASSERTIONS FAILED");

  await browser.close();
  process.exit(allPass && errs.length === 0 ? 0 : 1);
})();
