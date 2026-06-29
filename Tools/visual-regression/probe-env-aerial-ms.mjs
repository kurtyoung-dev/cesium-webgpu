/**
 * Batch 430 — ENV-AERIAL-MS (item 2.2) probe.
 *
 * TWO jobs, selected by PROBE_MODE:
 *   PROBE_MODE=parity  (default): capture the FLAG-OFF env radiance cube +
 *      aerial-perspective canvas. Used for the stash-baseline byte-identical
 *      gate: run against the working tree, stash, rebuild main, run again, and
 *      diff the two JSON dumps — they MUST be identical (flag-off changes
 *      nothing). Emits a deterministic checksum + sampled floats of the
 *      prefiltered radiance cube AND the aerial canvas pixel histogram.
 *   PROBE_MODE=improve: capture env radiance cube + aerial canvas at flag-OFF
 *      AND flag-ON (envMapMultiScatter), and report the deltas:
 *        - env cube: ON reflections should be WARMER toward the sun (the
 *          sky-view + MS LUT is directional) → R/B ratio rises on the sun-side
 *          faces; the cube differs measurably from OFF.
 *        - aerial: the far/horizon band haze should match the visible sky
 *          (mean brightness rises, saturation drops), and the ON canvas differs
 *          from OFF.
 *      Also writes tonemapped radiance-cube strips + aerial canvas PNGs.
 *
 * The env path uses a metallic model lit ONLY by the procedural
 * DynamicEnvironmentMapManager (mirrors probe-ibl-hdr). It forces
 * dynamicLighting = SUNLIGHT so the LUT path (gated to non-NONE lighting) is
 * exercised, with a bright low sun so the directional warm-toward-sun signal is
 * strong.
 *
 * Usage:
 *   PROBE_MODE=parity  node Tools/visual-regression/probe-env-aerial-ms.mjs
 *   PROBE_MODE=improve node Tools/visual-regression/probe-env-aerial-ms.mjs
 *   PROBE_BASE (default http://localhost:8080), PROBE_TAG (output suffix).
 */
import { chromium } from "playwright";
import zlib from "zlib";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODE = process.env.PROBE_MODE || "parity";
const TAG = process.env.PROBE_TAG || MODE;
const MODEL = "/Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf";

// ── env-cube radiance readback: bake a metallic model under procedural IBL,
// force SUNLIGHT dynamic lighting + a bright low sun, read back the prefiltered
// radiance cube (deterministic floats). ────────────────────────────────────
async function captureEnv(webgpuOptions, label) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });

  const info = await page.evaluate(
    async ({ modelUrl, webgpuOptions }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 512;
      canvas.style.cssText =
        "position:absolute;top:0;left:0;width:512px;height:512px;z-index:9999;";
      document.body.appendChild(canvas);

      const scene = await C.Scene.createAsync({
        canvas,
        contextOptions: { renderer: "webgpu", webgpu: webgpuOptions },
      });
      const flagOn = scene.context.envMapMultiScatter === true;
      if (scene.globe) scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.light = new C.DirectionalLight({
        direction: new C.Cartesian3(0, 0, -1),
        color: C.Color.BLACK,
        intensity: 0.0,
      });

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );
      const model = await C.Model.fromGltfAsync({ url: modelUrl, modelMatrix });
      model.imageBasedLighting.imageBasedLightingFactor = new C.Cartesian2(
        1.0,
        1.0,
      );
      // Force SUNLIGHT dynamic lighting so the env-cube LUT path (gated to
      // non-NONE lighting) is exercised. A low, bright sun maximizes the
      // directional warm-toward-sun signal.
      scene.atmosphere.dynamicLighting =
        C.DynamicAtmosphereLightingType.SUNLIGHT;
      const envMgr = model.environmentMapManager;
      envMgr.atmosphereScatteringIntensity = 2.0;
      scene.primitives.add(model);

      // DETERMINISM: pin the scene clock + DISABLE animation so the sun
      // direction is CONSTANT across every render. Without this the clock
      // advances each frame, drifting the sun past SUN_REFRESH_EPSILON and
      // re-baking the cube to a slightly different state on each capture (the
      // env-cube readback was ~1.3% noisy run-to-run otherwise). A pinned sun
      // makes the bake converge to a single fixed cube → byte-stable readback.
      const FIXED_TIME = C.JulianDate.fromIso8601("2026-06-15T23:30:00Z");
      const pinClock = () => {
        scene.clampToHeightSupported; // touch (no-op) to keep scene live
        if (scene.frameState && scene.frameState.time) {
          C.JulianDate.clone(FIXED_TIME, scene.frameState.time);
        }
      };

      for (let i = 0; i < 600 && !model.ready; i++) {
        pinClock();
        scene.initializeFrame();
        scene.render(FIXED_TIME);
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Settle the bake with the sun pinned — synchronous renders, fixed time.
      for (let i = 0; i < 240; i++) {
        scene.initializeFrame();
        scene.render(FIXED_TIME);
      }

      // The atmosphere sky-view + MS LUTs are baked by the SkyAtmosphere
      // renderer in a normal scene. This isolated Scene (no globe / sky shell)
      // never runs that path, so the LUTs would stay allocated-but-empty and
      // the env-cube LUT sample reads black. Bake them explicitly here — the
      // SAME dispatch the SkyAtmosphere renderer issues — so the flag-ON cube
      // samples real sky radiance. (Flag-OFF doesn't sample them, so this is
      // inert for parity; it only matters for the ON capture.)
      const perfMgr = scene.context.performanceManager;
      const dev = scene.context.device;
      if (perfMgr && dev && flagOn) {
        const us = scene.context.uniformState;
        const sun = us.sunDirectionWC;
        const atmo = scene.atmosphere;
        const innerR = 6378137.0;
        const enc = dev.createCommandEncoder({ label: "probe-lut-bake" });
        // sunCosZenith relative to the model observer's local up.
        const pos = C.Cartesian3.fromDegrees(-75, 40, 0);
        const up = C.Cartesian3.normalize(pos, new C.Cartesian3());
        const sunCos = C.Cartesian3.dot(
          new C.Cartesian3(sun.x, sun.y, sun.z),
          up,
        );
        perfMgr.dispatchAtmosphereLUT(
          enc,
          dev,
          {
            innerRadius: innerR,
            outerRadius: innerR + 111000.0,
            rayleighScaleHeight: atmo.rayleighScaleHeight ?? 10000.0,
            mieScaleHeight: atmo.mieScaleHeight ?? 3200.0,
            mieAnisotropy: atmo.mieAnisotropy ?? 0.9,
            intensity: atmo.lightIntensity ?? 10.0,
            rayleighCoefficient: [5.5e-6, 13.0e-6, 28.4e-6],
            mieCoefficient: [21e-6, 21e-6, 21e-6],
            sunDirection: [sun.x, sun.y, sun.z],
            sunCosZenith: sunCos,
          },
          "sun",
        );
        if (typeof perfMgr.dispatchAtmosphereExtendedLUT === "function") {
          perfMgr.dispatchAtmosphereExtendedLUT(enc, dev);
        }
        dev.queue.submit([enc.finish()]);
        // Force the env-cube to re-fill now that the LUTs are baked.
        if (envMgr._webgpuCache) envMgr._webgpuCache.needsUpdate = true;
        for (let i = 0; i < 30; i++) {
          scene.initializeFrame();
          scene.render(FIXED_TIME);
        }
      }

      // Read back the prefiltered RADIANCE cube directly (float, unmasked).
      const device = scene.context.device;
      const cache = envMgr && envMgr._webgpuCache;
      const radTex = cache && cache.iblCache ? cache.iblCache.radianceTexture : null;
      let radStats = {
        flagOn,
        usedLut: cache ? cache.lastUsedMultiScatterLut : null,
        cubemapFormat: cache ? cache.cubemapFormat : null,
        hasRadTex: !!radTex,
      };
      if (radTex && device) {
        const sz = radTex.width;
        const unpadded = sz * 8;
        const bytesPerRow = Math.ceil(unpadded / 256) * 256;
        const buf = device.createBuffer({
          size: bytesPerRow * sz * 6,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer(
          { texture: radTex, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
          { buffer: buf, bytesPerRow, rowsPerImage: sz },
          { width: sz, height: sz, depthOrArrayLayers: 6 },
        );
        device.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        const ab = buf.getMappedRange().slice(0);
        buf.unmap();
        buf.destroy();
        const dv = new DataView(ab);
        const getHalf = (off) => {
          const h = dv.getUint16(off, true);
          const s = (h & 0x8000) >> 15;
          const e = (h & 0x7c00) >> 10;
          const f = h & 0x03ff;
          let val;
          if (e === 0) val = (f / 1024) * Math.pow(2, -14);
          else if (e === 31) val = f ? NaN : 1e9;
          else val = (1 + f / 1024) * Math.pow(2, e - 15);
          return s ? -val : val;
        };
        // Per-face mean R/G/B + a stable rounded checksum over all texels.
        const faces = [];
        let checksum = 0;
        const W = sz * 6;
        const out = new Uint8ClampedArray(W * sz * 4);
        for (let layer = 0; layer < 6; layer++) {
          const base = layer * bytesPerRow * sz;
          let sr = 0,
            sg = 0,
            sb = 0,
            n = 0;
          for (let y = 0; y < sz; y++) {
            const rowBase = base + y * bytesPerRow;
            for (let x = 0; x < sz; x++) {
              const o = rowBase + x * 8;
              const r = Math.max(0, getHalf(o));
              const g = Math.max(0, getHalf(o + 2));
              const b = Math.max(0, getHalf(o + 4));
              sr += r;
              sg += g;
              sb += b;
              n++;
              // Stable checksum: quantize floats so f16 round-trips identically.
              checksum =
                (checksum +
                  Math.round(r * 4096) +
                  Math.round(g * 4096) * 3 +
                  Math.round(b * 4096) * 7) >>>
                0;
              // Tonemapped strip for the eyeball read.
              const px = (y * W + (layer * sz + x)) * 4;
              out[px] = Math.round(Math.pow(r / (1 + r), 1 / 2.2) * 255);
              out[px + 1] = Math.round(Math.pow(g / (1 + g), 1 / 2.2) * 255);
              out[px + 2] = Math.round(Math.pow(b / (1 + b), 1 / 2.2) * 255);
              out[px + 3] = 255;
            }
          }
          faces.push({
            r: +(sr / n).toFixed(5),
            g: +(sg / n).toFixed(5),
            b: +(sb / n).toFixed(5),
            rb: +(sr / Math.max(sb, 1e-6)).toFixed(4),
          });
        }
        radStats = {
          ...radStats,
          size: sz,
          checksum,
          faces,
          strip: { w: W, h: sz, data: Array.from(out) },
        };
      }
      return { ready: !!model.ready, radStatsJson: JSON.stringify(radStats) };
    },
    { modelUrl: MODEL, webgpuOptions },
  );
  await browser.close();
  let radStats = null;
  try {
    radStats = JSON.parse(info.radStatsJson);
  } catch {
    radStats = { parseError: true };
  }
  return { label, ready: info.ready, radStats, errors };
}

// ── aerial-perspective canvas: low oblique horizon view, capture far-band
// haze stats + a pixel histogram checksum at the given flag state. ──────────
async function captureAerial(webgpuOptions, label) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Pass webgpu options via query so the Viewer's WebGPU context gets them.
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ webgpuOptions }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      // Reflect the contextOptions flag onto the live context for the gate
      // read (the Viewer was created before we can pass contextOptions, but the
      // post-process configure reads context.envMapMultiScatter — which is a
      // getter off _options.webgpu. We can't mutate _options here, so this
      // probe instead drives the EFFECT's setter directly to emulate the flag,
      // matching how the configure pass would wire it).
      const wantOn = webgpuOptions.envMapMultiScatter === true;
      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-15T19:00:00Z");
      scene.globe.showGroundAtmosphere = true;
      scene.fog.enabled = true;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
      scene.aerialPerspective = true;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-106.5, 38.8, 6000.0),
        orientation: {
          heading: C.Math.toRadians(0.0),
          pitch: C.Math.toRadians(-8.0),
          roll: 0.0,
        },
      });

      const oncePostRender = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
        });

      // The per-frame configure pass (updateAerialPerspectiveFrameData) reads
      // `context.envMapMultiScatter` and RE-APPLIES the flag + LUT views every
      // frame — so a one-shot effect.setUseMultiScatterLut() gets clobbered.
      // Override the context getter so the configure pass itself drives the ON
      // state (this is exactly what contextOptions.webgpu.envMapMultiScatter
      // does in a real app; we can't pass contextOptions to a pre-built Viewer,
      // so we set the getter's backing instead). When `wantOn` is false we
      // leave the default (false) untouched.
      if (wantOn) {
        try {
          Object.defineProperty(scene.context, "envMapMultiScatter", {
            configurable: true,
            get() {
              return true;
            },
          });
        } catch (e) {
          /* ignore */
        }
      }

      // Drive the aerial effect's multi-scatter-LUT flag directly too (belt +
      // braces; the configure pass override above is the real driver). Reach
      // the effect through the post-process pipeline.
      function setFlag(on) {
        try {
          const ctx = scene.context;
          // The WebGPU post-process pipeline lives on the alternate scene
          // renderer (SCENE_RENDERER FR instance), not on the context.
          const sr = scene._alternateSceneRenderer;
          const pipeline =
            (sr && sr.postProcessPipeline) || ctx.postProcessPipeline || null;
          const fx = pipeline && pipeline.aerialPerspectiveEffect;
          if (fx && fx.setUseMultiScatterLut) {
            fx.setUseMultiScatterLut(on);
            // Push the real sky-view + MS LUT views (the configure pass only
            // does this when contextOptions.webgpu.envMapMultiScatter is set,
            // which a pre-built Viewer can't carry — so push directly here).
            const lut = ctx.performanceManager?._atmosphereLutResources;
            if (lut) {
              fx.setSkyViewView(lut.skyViewView ?? null);
              fx.setMultipleScatterView(lut.multipleScatterView ?? null);
            }
            return true;
          }
        } catch (e) {
          /* ignore */
        }
        return false;
      }

      let frames = 0;
      let loaded = 0;
      for (; frames < 900; frames++) {
        await oncePostRender();
        loaded = scene.globe.tilesLoaded ? loaded + 1 : 0;
        if (frames > 300 && loaded > 60) break;
      }
      const flagApplied = setFlag(wantOn);
      for (let i = 0; i < 30; i++) await oncePostRender();

      // Capture canvas pixels + far-band stats.
      const cap = await new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          const cv = scene.canvas;
          const off = document.createElement("canvas");
          off.width = cv.width;
          off.height = cv.height;
          const cx = off.getContext("2d");
          cx.drawImage(cv, 0, 0);
          const W = off.width;
          const H = off.height;
          const d = cx.getImageData(0, 0, W, H).data;
          // Far band = upper third (distant terrain toward horizon). Near band
          // = lower third. Compute mean brightness + saturation + a checksum.
          const band = (y0, y1) => {
            let br = 0,
              sat = 0,
              n = 0;
            for (let y = y0; y < y1; y++) {
              for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                const r = d[i] / 255,
                  g = d[i + 1] / 255,
                  b = d[i + 2] / 255;
                const mx = Math.max(r, g, b);
                const mn = Math.min(r, g, b);
                if (mx <= 0.04) continue;
                br += mx;
                sat += mx > 0 ? (mx - mn) / mx : 0;
                n++;
              }
            }
            return {
              mean: n ? +(br / n).toFixed(4) : 0,
              sat: n ? +(sat / n).toFixed(4) : 0,
              n,
            };
          };
          let checksum = 0;
          let nonBlack = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] + d[i + 1] + d[i + 2] > 12) nonBlack++;
            checksum =
              (checksum + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
          }
          // RGBA dump for PNG.
          resolve({
            W,
            H,
            far: band(0, (H / 3) | 0),
            near: band((2 * H) / 3 | 0, H),
            checksum,
            nonBlack,
            data: Array.from(d),
          });
        });
      });
      return { flagApplied, wantOn, cap };
    },
    { webgpuOptions },
  );
  await browser.close();
  return { label, ...out, errors };
}

// ── PNG encoder (zlib stored deflate) ──
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePNG({ w, W, h, H, data }) {
  const ww = w ?? W;
  const hh = h ?? H;
  const bpr = ww * 4;
  const raw = Buffer.alloc((bpr + 1) * hh);
  for (let y = 0; y < hh; y++) {
    raw[y * (bpr + 1)] = 0;
    Buffer.from(data.slice(y * bpr, (y + 1) * bpr)).copy(raw, y * (bpr + 1) + 1);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const tb = Buffer.from(type, "ascii");
    const cb = Buffer.alloc(4);
    cb.writeUInt32BE(crc32(Buffer.concat([tb, body])), 0);
    return Buffer.concat([len, tb, body, cb]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ww, 0);
  ihdr.writeUInt32BE(hh, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
const OD = "Tools/visual-regression/output";

if (MODE === "parity") {
  // Flag-OFF capture of BOTH paths — the byte-identical baseline.
  const env = await captureEnv({}, "env-off");
  const aerial = await captureAerial({}, "aerial-off");
  const summary = {
    mode: "parity",
    tag: TAG,
    env: {
      ready: env.ready,
      checksum: env.radStats?.checksum,
      faces: env.radStats?.faces,
      usedLut: env.radStats?.usedLut,
      errors: env.errors,
    },
    aerial: {
      checksum: aerial.cap?.checksum,
      nonBlack: aerial.cap?.nonBlack,
      far: aerial.cap?.far,
      near: aerial.cap?.near,
      flagApplied: aerial.flagApplied,
      errors: aerial.errors,
    },
  };
  fs.writeFileSync(
    `${OD}/env-aerial-ms-parity-${TAG}.json`,
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} else {
  // OFF vs ON for both paths — the improvement read.
  const envOff = await captureEnv({}, "env-off");
  const envOn = await captureEnv({ envMapMultiScatter: true }, "env-on");
  const aerialOff = await captureAerial({}, "aerial-off");
  const aerialOn = await captureAerial({ envMapMultiScatter: true }, "aerial-on");

  if (envOff.radStats?.strip)
    fs.writeFileSync(
      `${OD}/env-aerial-ms-radiance-off.png`,
      encodePNG(envOff.radStats.strip),
    );
  if (envOn.radStats?.strip)
    fs.writeFileSync(
      `${OD}/env-aerial-ms-radiance-on.png`,
      encodePNG(envOn.radStats.strip),
    );
  if (aerialOff.cap)
    fs.writeFileSync(`${OD}/env-aerial-ms-aerial-off.png`, encodePNG(aerialOff.cap));
  if (aerialOn.cap)
    fs.writeFileSync(`${OD}/env-aerial-ms-aerial-on.png`, encodePNG(aerialOn.cap));

  // Env cube delta: sun-side faces (+X/+Z roughly toward a low east sun) should
  // warm (R/B up). Report per-face R/B + the checksum delta.
  const envDiff = {
    checksumOff: envOff.radStats?.checksum,
    checksumOn: envOn.radStats?.checksum,
    cubeChanged: envOff.radStats?.checksum !== envOn.radStats?.checksum,
    usedLutOff: envOff.radStats?.usedLut,
    usedLutOn: envOn.radStats?.usedLut,
    facesOff: envOff.radStats?.faces,
    facesOn: envOn.radStats?.faces,
  };
  const aerialDiff = {
    checksumOff: aerialOff.cap?.checksum,
    checksumOn: aerialOn.cap?.checksum,
    canvasChanged: aerialOff.cap?.checksum !== aerialOn.cap?.checksum,
    flagAppliedOn: aerialOn.flagApplied,
    farOff: aerialOff.cap?.far,
    farOn: aerialOn.cap?.far,
    farMeanDelta: +(
      (aerialOn.cap?.far.mean ?? 0) - (aerialOff.cap?.far.mean ?? 0)
    ).toFixed(4),
    farSatDelta: +(
      (aerialOn.cap?.far.sat ?? 0) - (aerialOff.cap?.far.sat ?? 0)
    ).toFixed(4),
  };
  const report = {
    mode: "improve",
    env: envDiff,
    aerial: aerialDiff,
    errors: [
      ...envOff.errors,
      ...envOn.errors,
      ...aerialOff.errors,
      ...aerialOn.errors,
    ],
  };
  fs.writeFileSync(
    `${OD}/env-aerial-ms-improve.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
