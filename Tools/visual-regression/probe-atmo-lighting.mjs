#!/usr/bin/env node
// Probe (Track V-A3 — NEW-ATMO-DERIVED-LIGHTING): a glTF model on the globe is
// lit by the SAME atmosphere that produces the unified aerial-perspective haze
// (V-A2) and the sky shell. When `scene.aerialPerspective = true` (WebGPU),
// Scene re-derives the directional SUN light (colour + intensity) and a SKY-
// IRRADIANCE ambient from the atmosphere per frame (the sun transmittance gives
// the colour: near-white at the zenith, warm + dim toward the horizon). Models
// then read this via `frameState.light` (sun) + `frameState.atmosphereSkyIrradiance`
// (ambient) — the Takram talk's "light-source lighting for the ISS", consistent
// with the post-process "lighting for the terrain".
//
// Reproduction: a metallic/diffuse glTF model placed ON the globe surface, the
// globe VISIBLE behind it (so we can read terrain + model in one frame and
// confirm they're consistently lit). Two sun states are compared with aerial
// perspective ON:
//    HIGH sun (local noon over the site) — sun near the zenith → near-white light.
//    LOW  sun (local early morning, sun near the horizon) — long sun-ray optical
//          path → blue/green extinguish → WARM (sunset/sunrise) sun colour + dimmer.
//
// Assertions:
//   (A) MODEL LIT — the model renders a substantial non-black region at both
//       sun states with aerial perspective ON (the derived light didn't black it).
//   (B) SUNSET HUE SHIFT — the model's lit pixels shift WARM (redder, R/B ratio
//       up) AND the overall lit brightness DROPS from HIGH→LOW sun. This is the
//       atmosphere-derived sun signature; a fixed white sun would not change hue.
//   (C) DERIVED-LIGHT LIVENESS — at LOW sun, aerial-perspective ON vs OFF changes
//       the model's lit hue (ON is warmer than OFF's fixed-white sun) — proves the
//       derived light is actually driving the model, not a no-op.
//   (D) MODEL↔TERRAIN CONSISTENCY — at LOW sun ON, the model's lit hue and the
//       sunlit globe terrain hue are BOTH warm (R/B > 1) — one coherent
//       atmosphere lights both (no mismatched white model on warm terrain).
//   (E) WEBGL COMPARISON — the same scene renders on WebGL (the reference
//       backend, which ignores aerialPerspective); the WebGPU ON frame is not
//       wildly darker/brighter than WebGL (sanity, not pixel parity — WebGPU adds
//       the derived sun + haze WebGL lacks). ON mean within [0.4×, 2.5×] WebGL.
//   (F) ZERO console errors (incl. WebGPU validation errors).
//
// Determinism: requestRenderMode off, clock pinned, readback inside postRender,
// warmup gated on model.ready + tilesLoaded + a frame floor.
//
// Usage: node Tools/visual-regression/probe-atmo-lighting.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODEL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";

// Site: a flat-ish area near Denver. We pin two simulation times that put the
// sun HIGH (local noon ≈ 19:00Z at ~105°W) vs LOW (early morning ≈ 12:30Z,
// sun just above the eastern horizon) over this longitude.
const SITE = { lon: -105.0, lat: 39.5 };
const TIME_HIGH = "2026-06-21T19:00:00Z"; // ~local noon, summer solstice
const TIME_LOW = "2026-06-21T12:20:00Z"; // sun near the horizon (sunrise-ish)

async function capture({ renderer, aerialOn, isoTime, pngName }) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(
    async ({ modelUrl, aerialOn, isoTime, site }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      for (const sel of [
        ".cesium-viewer-toolbar",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-bottom",
        ".cesium-navigation-help",
        ".cesium-viewer-fullscreenContainer",
      ]) {
        document
          .querySelectorAll(sel)
          .forEach((e) => (e.style.display = "none"));
      }

      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(isoTime);

      scene.globe.show = true;
      scene.globe.showGroundAtmosphere = true;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
      scene.aerialPerspective = aerialOn;

      // Large model on the globe surface so it covers a meaningful pixel area.
      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(site.lon, site.lat, 0),
      );
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 4000.0, // exaggerate so it's clearly visible from the framing
      });
      scene.primitives.add(model);

      // Camera: low oblique, looking at the model with terrain behind/around it
      // and the lit hemisphere toward the sun azimuth in frame.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          site.lon - 0.18,
          site.lat - 0.18,
          9000.0,
        ),
        orientation: {
          heading: C.Math.toRadians(35.0),
          pitch: C.Math.toRadians(-14.0),
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

      let frames = 0;
      let consecutiveLoaded = 0;
      for (; frames < 900; frames++) {
        await oncePostRender();
        consecutiveLoaded =
          scene.globe.tilesLoaded && model.ready ? consecutiveLoaded + 1 : 0;
        if (frames > 200 && consecutiveLoaded > 40) break;
      }

      return new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          const c = scene.canvas;
          const off = document.createElement("canvas");
          off.width = c.width;
          off.height = c.height;
          const cx = off.getContext("2d");
          cx.drawImage(c, 0, 0);
          const w = c.width;
          const h = c.height;
          const d = cx.getImageData(0, 0, w, h).data;

          // The model is a bright, saturated, near-white/diffuse object centred
          // in the frame. Classify pixels:
          //   MODEL  — the brightest cluster around frame centre (the truck).
          //   GLOBE  — mid-frame terrain pixels (lit ground), excluding sky.
          // We use simple heuristics robust to framing: model = the brightest
          // ~lit pixels in the central crop; terrain = lit pixels in a band.
          const cx0 = Math.floor(w * 0.3);
          const cx1 = Math.floor(w * 0.7);
          const cyM0 = Math.floor(h * 0.4);
          const cyM1 = Math.floor(h * 0.8);

          // MODEL: the LIT (bright) pixels in the central crop. The truck body
          // is the brightest object near centre; threshold on luminance to
          // isolate its sunlit faces from darker terrain behind it.
          let mR = 0;
          let mG = 0;
          let mB = 0;
          let mN = 0;
          let centralMaxLum = 0;
          for (let y = cyM0; y < cyM1; y++) {
            for (let x = cx0; x < cx1; x++) {
              const i = (y * w + x) * 4;
              const lum = d[i] + d[i + 1] + d[i + 2];
              if (lum > centralMaxLum) centralMaxLum = lum;
            }
          }
          const litThresh = Math.max(centralMaxLum * 0.55, 120);
          for (let y = cyM0; y < cyM1; y++) {
            for (let x = cx0; x < cx1; x++) {
              const i = (y * w + x) * 4;
              const lum = d[i] + d[i + 1] + d[i + 2];
              if (lum >= litThresh) {
                mR += d[i];
                mG += d[i + 1];
                mB += d[i + 2];
                mN++;
              }
            }
          }

          // GLOBE terrain band: a mid-low region (lit ground), excluding the
          // central model crop. Lit (non-shadow, non-sky) pixels only.
          let gR = 0;
          let gG = 0;
          let gB = 0;
          let gN = 0;
          const gy0 = Math.floor(h * 0.55);
          const gy1 = Math.floor(h * 0.95);
          for (let y = gy0; y < gy1; y++) {
            for (let x = 0; x < w; x++) {
              if (x >= cx0 && x <= cx1 && y >= cyM0 && y <= cyM1) continue;
              const i = (y * w + x) * 4;
              const lum = d[i] + d[i + 1] + d[i + 2];
              if (lum > 90 && lum < 700) {
                gR += d[i];
                gG += d[i + 1];
                gB += d[i + 2];
                gN++;
              }
            }
          }

          let sumB = 0;
          let nonBlack = 0;
          const total = w * h;
          for (let p = 0; p < total; p++) {
            const i = 4 * p;
            const bright = (d[i] + d[i + 1] + d[i + 2]) / 3;
            sumB += bright / 255;
            if (d[i] + d[i + 1] + d[i + 2] > 45) nonBlack++;
          }

          // Direct read of the atmosphere-derived sun light Scene computed for
          // THIS frame (set in updateFrameState when aerialPerspective is on).
          // Lets us assert the sun's colour + intensity numerically, free of
          // the pixel-luminance confound (the haze inscatter adds brightness at
          // low sun, so composited model luminance is NOT a clean intensity
          // proxy — the derived light values are).
          const dl = scene._atmosphereDerivedLight;
          const derivedSun = dl
            ? {
                r: dl.color.red,
                g: dl.color.green,
                b: dl.color.blue,
                intensity: dl.intensity,
              }
            : null;

          resolve({
            w,
            h,
            mean: sumB / total,
            nonBlack,
            total,
            derivedSun,
            modelN: mN,
            modelR: mN ? mR / mN : 0,
            modelG: mN ? mG / mN : 0,
            modelB: mN ? mB / mN : 0,
            globeN: gN,
            globeR: gN ? gR / gN : 0,
            globeG: gN ? gG / gN : 0,
            globeB: gN ? gB / gN : 0,
            modelReady: !!model.ready,
            tilesLoaded: !!scene.globe.tilesLoaded,
            warmupFrames: frames,
          });
        });
      });
    },
    { modelUrl: MODEL, aerialOn, isoTime, site: SITE },
  );

  await page.screenshot({ path: `${OUT_DIR}/${pngName}` });
  await browser.close();
  return { ...info, errors };
}

const warmRatio = (s) => (s.modelB > 1 ? s.modelR / s.modelB : 0);
const warmRatioGlobe = (s) => (s.globeB > 1 ? s.globeR / s.globeB : 0);

// ── Captures ──
const highOn = await capture({
  renderer: "webgpu",
  aerialOn: true,
  isoTime: TIME_HIGH,
  pngName: "atmo-lighting-high-on.png",
});
const lowOn = await capture({
  renderer: "webgpu",
  aerialOn: true,
  isoTime: TIME_LOW,
  pngName: "atmo-lighting-low-on.png",
});
const lowOff = await capture({
  renderer: "webgpu",
  aerialOn: false,
  isoTime: TIME_LOW,
  pngName: "atmo-lighting-low-off.png",
});
const lowWebgl = await capture({
  renderer: "webgl",
  aerialOn: false,
  isoTime: TIME_LOW,
  pngName: "atmo-lighting-low-webgl.png",
});

const allErrors = [
  ...highOn.errors,
  ...lowOn.errors,
  ...lowOff.errors,
  ...lowWebgl.errors,
];

// ── Evaluate ──
// (A) model lit at both sun states ON.
const aOK = highOn.modelN > 300 && lowOn.modelN > 300;

// (B) sunset signature: the model's lit pixels shift WARM (R/B up) from HIGH→
// LOW sun, AND the DERIVED SUN itself reddens (its colour R/B up) and DIMS (its
// intensity down) toward the horizon. The hue shift is read from pixels (the
// visible result); the colour-warmth + intensity-dimming are read from the
// derived light values directly (free of the haze-inscatter brightness
// confound that makes composited model luminance an unreliable intensity proxy).
const warmHigh = warmRatio(highOn);
const warmLow = warmRatio(lowOn);
const sunHigh = highOn.derivedSun;
const sunLow = lowOn.derivedSun;
const sunWarmHigh = sunHigh && sunHigh.b > 1e-4 ? sunHigh.r / sunHigh.b : 0;
const sunWarmLow = sunLow && sunLow.b > 1e-4 ? sunLow.r / sunLow.b : 0;
const bPixelWarm = warmLow > warmHigh + 0.05; // visible warm shift on the model
const bSunWarm = sunWarmLow > sunWarmHigh + 0.05; // derived sun colour reddens
const bSunDim = !!sunHigh && !!sunLow && sunLow.intensity < sunHigh.intensity; // sun dims
const bOK = bPixelWarm && bSunWarm && bSunDim;

// (C) derived-light liveness: LOW sun ON warmer than LOW sun OFF (OFF = fixed
// white scene.light). Proves the derived light drives the model.
const warmLowOff = warmRatio(lowOff);
const cOK = warmLow > warmLowOff + 0.02;

// (D) model↔terrain consistency at LOW sun ON: BOTH warm (R/B > 1).
const warmGlobeLowOn = warmRatioGlobe(lowOn);
const dOK = warmLow > 1.0 && warmGlobeLowOn > 1.0;

// (E) WebGL comparison sanity: WebGPU ON mean within a sane band of WebGL.
const eOK =
  lowOn.mean >= lowWebgl.mean * 0.4 && lowOn.mean <= lowWebgl.mean * 2.5;

// (F) zero console errors.
const fOK = allErrors.length === 0;

const fmt = (s) =>
  `model(n=${s.modelN} rgb=${s.modelR.toFixed(0)},${s.modelG.toFixed(0)},${s.modelB.toFixed(0)} R/B=${warmRatio(s).toFixed(3)}) globe(n=${s.globeN} R/B=${warmRatioGlobe(s).toFixed(3)}) mean=${s.mean.toFixed(4)} ready=${s.modelReady} tiles=${s.tilesLoaded} f=${s.warmupFrames}`;

console.log(`HIGH ON  : ${fmt(highOn)}`);
console.log(`LOW  ON  : ${fmt(lowOn)}`);
console.log(`LOW  OFF : ${fmt(lowOff)}`);
console.log(`LOW WEBGL: ${fmt(lowWebgl)}`);
console.log(
  `(A) model lit ON both states (modelN>300): ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `    derived sun HIGH: rgb=${sunHigh ? `${sunHigh.r.toFixed(3)},${sunHigh.g.toFixed(3)},${sunHigh.b.toFixed(3)}` : "null"} I=${sunHigh ? sunHigh.intensity.toFixed(3) : "null"}  LOW: rgb=${sunLow ? `${sunLow.r.toFixed(3)},${sunLow.g.toFixed(3)},${sunLow.b.toFixed(3)}` : "null"} I=${sunLow ? sunLow.intensity.toFixed(3) : "null"}`,
);
console.log(
  `(B) sunset signature: pixel warm ${warmLow.toFixed(3)}>${warmHigh.toFixed(3)}+0.05 [${bPixelWarm ? "y" : "n"}] AND sun colour warm ${sunWarmLow.toFixed(3)}>${sunWarmHigh.toFixed(3)}+0.05 [${bSunWarm ? "y" : "n"}] AND sun dims [${bSunDim ? "y" : "n"}] ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) derived-light liveness: warmLow ON ${warmLow.toFixed(3)} > warmLow OFF ${warmLowOff.toFixed(3)}+0.02 ${cOK ? "OK" : "FAIL"}`,
);
console.log(
  `(D) model↔terrain consistency: model R/B ${warmLow.toFixed(3)}>1 AND globe R/B ${warmGlobeLowOn.toFixed(3)}>1 ${dOK ? "OK" : "FAIL"}`,
);
console.log(
  `(E) WebGL sanity: ON mean ${lowOn.mean.toFixed(4)} in [0.4x,2.5x] WebGL ${lowWebgl.mean.toFixed(4)} ${eOK ? "OK" : "FAIL"}`,
);
console.log(`(F) console errors: ${allErrors.length} ${fOK ? "OK" : "FAIL"}`);
allErrors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 220)));
console.log(
  `PNGs: ${OUT_DIR}/atmo-lighting-{high-on,low-on,low-off,low-webgl}.png`,
);

const pass = aOK && bOK && cOK && dOK && eOK && fOK;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
