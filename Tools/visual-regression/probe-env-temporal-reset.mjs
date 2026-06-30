#!/usr/bin/env node
// C2-25 ENV-TEMPORAL (Batch 449) — crossfade-vs-reset behavior probe.
//
// Directly exercises the two temporal behaviors that matter:
//
//   (A) SMOOTH CROSSFADE on a SMALL sun delta: drive the manager to a converged
//       cube for sun A, then nudge the sun a little (below the reset threshold)
//       and step ONE frame. The accumulated cube should land BETWEEN the sun-A
//       and sun-B single-frame captures (EMA blend) — i.e. it has NOT yet
//       snapped fully to sun-B (no popping; it crossfades over a few frames).
//
//   (B) HISTORY RESET on a LARGE sun delta: from the converged sun-A cube, jump
//       the sun WAY past the reset threshold and step ONE frame. The accumulated
//       cube should EQUAL the sun-B single-frame capture (alpha=1, history
//       discarded → no smear of sun-A across the jump).
//
// We control the sun by overriding `uniformState.sunDirectionWC` (the manager
// reads it). We get the "single-frame capture" reference by running a SEPARATE
// temporal-OFF manager at the same sun (one debounced fill, no blend).
//
// Output: console report with per-face crossfade fractions + reset equality.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
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
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
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
    const scene = window.viewer.scene;
    const ctx = scene.context;
    const device = ctx.device;
    if (!ctx._options) ctx._options = {};
    const surface = Cesium.Cartesian3.fromDegrees(-105.0, 40.0, 0);

    // CRITICAL: the procedural sky fill is sun-INDEPENDENT under the default
    // dynamicLighting=NONE (it resolves a radially-symmetric per-direction
    // zenith), so a sun change would produce NO cube change to crossfade.
    // Enable SUNLIGHT so the env sky is actually driven by sunDirectionWC —
    // giving the temporal blend a real sun-dependent signal to accumulate.
    scene.atmosphere.dynamicLighting =
      Cesium.DynamicAtmosphereLightingType.SUNLIGHT;

    // Override the sun direction the manager reads. uniformState.sunDirectionWC
    // is a Cartesian3 we can mutate in place.
    const us = ctx.uniformState;
    function setSun(x, y, z) {
      const n = 1 / Math.hypot(x, y, z);
      us.sunDirectionWC.x = x * n;
      us.sunDirectionWC.y = y * n;
      us.sunDirectionWC.z = z * n;
    }

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
  let face = gid.x; if (face >= 6u) { return; }
  var r=0.0; var g=0.0; var b=0.0; var n=0.0;
  for (var y:u32=0u;y<SIZE;y=y+1u){for(var x:u32=0u;x<SIZE;x=x+1u){
    let c=textureLoad(cubeArr,vec2<i32>(i32(x),i32(y)),i32(face),0);
    r=r+c.r;g=g+c.g;b=b+c.b;n=n+1.0;}}
  let base=face*4u;
  outBuf[base+0u]=r/max(n,1.0);outBuf[base+1u]=g/max(n,1.0);
  outBuf[base+2u]=b/max(n,1.0);outBuf[base+3u]=n;
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
      const out = [];
      for (let i = 0; i < 6; i++)
        out.push([f[i * 4] * 255, f[i * 4 + 1] * 255, f[i * 4 + 2] * 255]);
      return out;
    }

    // Step one frame with the sun pinned: render first (which would otherwise
    // overwrite sunDirectionWC), THEN override the sun, THEN update the manager
    // so the fill reads our pinned sun.
    async function stepWithSun(m, sun) {
      scene.render();
      setSun(sun[0], sun[1], sun[2]);
      m.update(scene._frameState);
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Single-frame OFF reference at a given sun: temporal-off manager, one fill.
    async function offRefAtSun(sun) {
      ctx._options.webgpu = Object.assign({}, ctx._options.webgpu, {
        envMapTemporalAccumulation: false,
        sceneCaptureReflections: false,
      });
      const m = new Cesium.DynamicEnvironmentMapManager();
      m.enabled = true;
      m.shouldUpdate = true;
      m._position = surface;
      await stepWithSun(m, sun);
      return readFaces(m._webgpuCache.cubemapTexture, m._webgpuCache.size);
    }

    // Normalize a raw vector to the unit sphere (sky-fill normalizes the sun).
    function unit(v) {
      const n = 1 / Math.hypot(v[0], v[1], v[2]);
      return [v[0] * n, v[1] * n, v[2] * n];
    }
    function dist(a, b) {
      const ua = unit(a),
        ub = unit(b);
      return Math.hypot(ua[0] - ub[0], ua[1] - ub[1], ua[2] - ub[2]);
    }
    const sunA = unit([0.3, 0.0, 0.95]);
    // Small delta: a nudge at ~0.045 unit-sphere distance — ABOVE the per-frame
    // refresh epsilon (0.005, so the fill re-runs and the blend ticks) but BELOW
    // the temporal reset threshold (0.05), so it crossfades rather than snapping.
    // Big enough to produce a VISIBLE sky change (unlike a sub-pixel nudge).
    const sunSmall = unit([0.345, 0.0, 0.9385]);
    // Large delta: flip sun across the sky (way past the reset threshold).
    const sunLarge = unit([-0.6, 0.2, 0.77]);
    // Surface these so the human can confirm small < 0.05 < large.
    window.__sunDeltas = {
      smallDist: dist(sunA, sunSmall),
      largeDist: dist(sunA, sunLarge),
    };

    const refA = await offRefAtSun(sunA);
    const refSmall = await offRefAtSun(sunSmall);
    const refLarge = await offRefAtSun(sunLarge);

    // ── ON manager: converge at sun A ──
    ctx._options.webgpu = Object.assign({}, ctx._options.webgpu, {
      envMapTemporalAccumulation: true,
      sceneCaptureReflections: false,
    });
    const on = new Cesium.DynamicEnvironmentMapManager();
    on.enabled = true;
    on.shouldUpdate = true;
    on._position = surface;
    for (let i = 0; i < 30; i++) await stepWithSun(on, sunA);
    const onConvergedA = await readFaces(
      on._webgpuCache.cubemapTexture,
      on._webgpuCache.size,
    );

    // (A) SMALL delta → step ONE frame → expect a BLEND between A and small.
    await stepWithSun(on, sunSmall);
    const onAfterSmall = await readFaces(
      on._webgpuCache.cubemapTexture,
      on._webgpuCache.size,
    );

    // Re-converge at A for a clean reset test.
    for (let i = 0; i < 30; i++) await stepWithSun(on, sunA);

    // (B) LARGE delta → step ONE frame → expect EQUAL to the single-frame
    // capture at sunLarge (history reset, alpha=1).
    await stepWithSun(on, sunLarge);
    const onAfterLarge = await readFaces(
      on._webgpuCache.cubemapTexture,
      on._webgpuCache.size,
    );

    return {
      refA,
      refSmall,
      refLarge,
      onConvergedA,
      onAfterSmall,
      onAfterLarge,
      sunDeltas: window.__sunDeltas,
    };
  });

  console.log(
    `[probe-env-temporal-reset] sun unit-sphere deltas: small=${report.sunDeltas.smallDist.toFixed(4)} (must be 0.005<d<0.05), large=${report.sunDeltas.largeDist.toFixed(4)} (must be >0.05)\n`,
  );

  // ── Analysis ──
  const r = report;
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  // For the CROSSFADE test pick the face whose OFF luminance differs MOST
  // between sunA and sunSMALL — that's where the sub-threshold nudge actually
  // moves the sky, so the EMA lag is measurable. (The reset test uses all
  // faces, so it doesn't need a single face.)
  let F = 0;
  let bestSpan = -1;
  for (let i = 0; i < 6; i++) {
    const span = Math.abs(lum(r.refA[i]) - lum(r.refSmall[i]));
    if (span > bestSpan) {
      bestSpan = span;
      F = i;
    }
  }
  const faceNames = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];
  console.log(
    `[probe-env-temporal-reset] crossfade face = ${F} (${faceNames[F]}), sunA↔sunSmall span = ${bestSpan.toFixed(2)} lum\n`,
  );

  const refAL = lum(r.refA[F]);
  const refSmallL = lum(r.refSmall[F]);
  const refLargeL = lum(r.refLarge[F]);
  const convAL = lum(r.onConvergedA[F]);
  const afterSmallL = lum(r.onAfterSmall[F]);
  const afterLargeL = lum(r.onAfterLarge[F]);

  console.log("[probe-env-temporal-reset] zenith (+Y face) luminance:\n");
  console.log(`  OFF ref @ sunA     : ${refAL.toFixed(2)}`);
  console.log(`  OFF ref @ sunSmall : ${refSmallL.toFixed(2)}`);
  console.log(`  OFF ref @ sunLarge : ${refLargeL.toFixed(2)}`);
  console.log(`  ON converged @ A   : ${convAL.toFixed(2)}`);
  console.log(`  ON after SMALL step: ${afterSmallL.toFixed(2)}`);
  console.log(`  ON after LARGE step: ${afterLargeL.toFixed(2)}`);

  // (A) crossfade: after the small step the value should sit BETWEEN convA and
  // refSmall (a partial blend, ~15% toward small). If it equalled refSmall it
  // would have popped; if it equalled convA nothing moved.
  const fadeSpan = refSmallL - convAL;
  const fadeMoved = afterSmallL - convAL;
  const fadeFrac =
    Math.abs(fadeSpan) > 0.01 ? fadeMoved / fadeSpan : 0;
  console.log(
    `\n(A) SMALL-delta crossfade fraction toward new sun: ${(fadeFrac * 100).toFixed(1)}%  (expect a PARTIAL blend ~10-30%, NOT ~100% pop)`,
  );

  // (B) reset: after the large step the cube should ≈ the single-frame capture
  // at sunLarge across ALL channels/faces.
  let maxResetDelta = 0;
  for (let i = 0; i < 6; i++)
    for (let c = 0; c < 3; c++)
      maxResetDelta = Math.max(
        maxResetDelta,
        Math.abs(r.onAfterLarge[i][c] - r.refLarge[i][c]),
      );
  console.log(
    `(B) LARGE-delta reset: max |ON-after-large − OFF-ref-large| over all faces = ${maxResetDelta.toFixed(2)} (0..255; expect ~0 → history discarded, no smear)`,
  );

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  const pass = [];
  // Crossfade must move SOME but not snap fully (allow jitter slack).
  pass.push([
    "SMALL delta crossfades partially (5% < frac < 80%)",
    fadeFrac > 0.05 && fadeFrac < 0.8,
  ]);
  pass.push([
    "LARGE delta resets to fresh capture (max delta <= 4)",
    maxResetDelta <= 4,
  ]);
  pass.push(["0 console/validation errors", errs.length === 0]);

  console.log("\nAssertions:");
  let allPass = true;
  pass.forEach(([n, ok]) => {
    console.log(`  ${ok ? "PASS" : "FAIL"} — ${n}`);
    if (!ok) allPass = false;
  });
  if (errs.length) {
    console.log(`\n${errs.length} console errors:`);
    errs.slice(0, 12).forEach((e) => console.log(`  ${e.t}: ${e.text}`));
  }
  console.log(allPass ? "\nALL ASSERTIONS PASS" : "\nSOME ASSERTIONS FAILED");

  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
