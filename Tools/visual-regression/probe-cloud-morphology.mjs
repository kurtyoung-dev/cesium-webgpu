#!/usr/bin/env node
/**
 * Batch 439 — cloud morphology probe for 4.7 CLOUD-CURL + 4.8 CLOUD-PW-NOISE.
 * @purpose B439 morphology modes: curl erosion and perlin-worley cores A/B'd against an in-run default baseline, plus a stash-pair parity mode for default flags
 * @status ACTIVE
 *
 * MODES (env MODE):
 *   parity — default flags (curl amplitude 0, noiseMorphology 'value'). Run on the
 *            modified build (TAG=modified) and on the stash-reverted main build
 *            (TAG=main); the two PNGs MUST be byte-identical (zero drift).
 *   curl   — globe.defaultCloudCollection.volumetric.cloudCurlAmplitude > 0 → wispy/turbulent erosion edges.
 *   pw     — globe.defaultCloudCollection.volumetric.cloudNoiseMorphology = 'perlin-worley' → billowy connected cores.
 *
 * Each non-parity mode ALSO captures a baseline (default flags) so the A/B is
 * computed in one run: it dumps both PNGs + a luminance-structure stat comparison.
 *
 * Uses the SAME deterministic scene as probe-cloud-noisecore (BAKED default tier at
 * low altitude). Cinematic full-res (cloudVolumetricQuality='high' → T3, no half-res
 * / no temporal) so we verify at the full-res default per the batch spec.
 *
 * Output: output/cloud-morph/<MODE>-<TAG>.png (+ -<MODE>.json stats).
 *
 * Usage:
 *   MODE=parity TAG=modified node Tools/visual-regression/probe-cloud-morphology.mjs
 *   MODE=curl node Tools/visual-regression/probe-cloud-morphology.mjs
 *   MODE=pw   node Tools/visual-regression/probe-cloud-morphology.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODE = process.env.MODE || "parity";
const TAG = process.env.TAG || MODE;
const W = 1024,
  H = 768;
const LON = -95.0,
  LAT = 39.0,
  ALT = 800.0;
const NOON = "2026-06-21T18:20:00Z";
const OUT = "Tools/visual-regression/output/cloud-morph";

// Deterministic scene: BAKED tier (auto@800m → high), weather map OFF, sky off so
// the canvas is cloud-over-black (isolates the cloud morphology).
const SETUP = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const g = s.globe;
  v.useDefaultRenderLoop = false;
  s.requestRenderMode = false;
  g.defaultCloudCollection.enableVolumetric = true;
  g.defaultCloudCollection.volumetric.cloudCoverage = 0.55;
  g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
  g.defaultCloudCollection.volumetric.cloudDensity = 0.8;
  g.defaultCloudCollection.volumetric.cloudVolumetricQuality = "high"; // T3 cinematic full-res (no half-res/temporal)
  // Apply the per-mode flag (only when the property exists on this build).
  if (cfg.mode === "curl" && "cloudCurlAmplitude" in g) {
    g.defaultCloudCollection.volumetric.cloudCurlAmplitude = cfg.curlAmplitude;
  }
  if (cfg.mode === "pw" && "cloudNoiseMorphology" in g) {
    g.defaultCloudCollection.volumetric.cloudNoiseMorphology = "perlin-worley";
  }
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(16.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

const RENDER = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  const device = s.context.device;
  for (let i = 0; i < 120; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  if (device) await device.queue.onSubmittedWorkDone();
  return s.canvas.toDataURL("image/png");
};

// Decode a data URL to RGBA bytes in-page (no Node PNG dep).
function decodeStats(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const lums = [];
    let cloudPx = 0;
    // Local-contrast / edge metric: mean abs luminance gradient (filaments &
    // cauliflower edges raise it; smooth blobs lower it).
    let edgeSum = 0,
      edgeN = 0;
    const wpx = c.width;
    const lumAt = (i) =>
      (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    for (let i = 0; i < d.length; i += 4) {
      const lum = lumAt(i);
      if (lum >= 30 / 255) {
        cloudPx++;
        lums.push(lum);
      }
    }
    for (let y = 1; y < c.height - 1; y++) {
      for (let x = 1; x < wpx - 1; x++) {
        const i = (y * wpx + x) * 4;
        const l = lumAt(i);
        if (l < 30 / 255) continue;
        const gx = Math.abs(lumAt(i + 4) - lumAt(i - 4));
        const gy = Math.abs(lumAt(i + wpx * 4) - lumAt(i - wpx * 4));
        edgeSum += gx + gy;
        edgeN++;
      }
    }
    if (!lums.length) return { cloudPx: 0 };
    lums.sort((a, b) => a - b);
    const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
    const p = (q) =>
      lums[Math.min(lums.length - 1, Math.floor(q * lums.length))];
    let vs = 0;
    for (const l of lums) vs += (l - mean) * (l - mean);
    return {
      cloudPx,
      mean: +mean.toFixed(4),
      p10: +p(0.1).toFixed(4),
      p50: +p(0.5).toFixed(4),
      p90: +p(0.9).toFixed(4),
      stdev: +Math.sqrt(vs / lums.length).toFixed(4),
      edgeMean: +(edgeN ? edgeSum / edgeN : 0).toFixed(5),
    };
  }, dataUrl);
}

async function capture(page, cfg) {
  await page.evaluate(SETUP, cfg);
  const dataUrl = await page.evaluate(RENDER, { iso: NOON });
  return dataUrl;
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });

  const writePng = (name, dataUrl) =>
    fs.writeFileSync(
      `${OUT}/${name}.png`,
      Buffer.from(dataUrl.split(",")[1], "base64"),
    );

  if (MODE === "parity") {
    const dataUrl = await capture(page, { mode: "parity", LON, LAT, ALT });
    writePng(`parity-${TAG}`, dataUrl);
    const stats = await decodeStats(page, dataUrl);
    fs.writeFileSync(
      `${OUT}/parity-${TAG}.json`,
      JSON.stringify({ tag: TAG, ...stats }, null, 2),
    );
    console.log(`[parity:${TAG}]`, JSON.stringify(stats));
  } else {
    // Capture default baseline THEN the flag-on, in the same browser session.
    const baseUrl = await capture(page, { mode: "parity", LON, LAT, ALT });
    writePng(`${MODE}-baseline`, baseUrl);
    const baseStats = await decodeStats(page, baseUrl);
    const onUrl = await capture(page, {
      mode: MODE,
      LON,
      LAT,
      ALT,
      curlAmplitude: 1.0,
    });
    writePng(`${MODE}-on`, onUrl);
    const onStats = await decodeStats(page, onUrl);
    // Pixel-diff baseline vs on (proves the flag actually changed pixels).
    const diff = await page.evaluate(
      async ([a, b]) => {
        const dec = async (du) => {
          const img = new Image();
          img.src = du;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const cx = c.getContext("2d");
          cx.drawImage(img, 0, 0);
          return cx.getImageData(0, 0, c.width, c.height).data;
        };
        const da = await dec(a);
        const db = await dec(b);
        let changed = 0;
        const total = da.length / 4;
        for (let i = 0; i < da.length; i += 4) {
          if (
            Math.abs(da[i] - db[i]) > 3 ||
            Math.abs(da[i + 1] - db[i + 1]) > 3 ||
            Math.abs(da[i + 2] - db[i + 2]) > 3
          )
            changed++;
        }
        return { changedPct: +((100 * changed) / total).toFixed(2) };
      },
      [baseUrl, onUrl],
    );
    const rec = { mode: MODE, baseline: baseStats, on: onStats, ...diff };
    fs.writeFileSync(`${OUT}/${MODE}.json`, JSON.stringify(rec, null, 2));
    console.log(`[${MODE}] baseline`, JSON.stringify(baseStats));
    console.log(`[${MODE}] on      `, JSON.stringify(onStats));
    console.log(
      `[${MODE}] changedPct=${diff.changedPct}  edge base→on ${baseStats.edgeMean}→${onStats.edgeMean}`,
    );
  }

  const newErrs = errs.filter(
    (e) => !/AtmosphereLUT|SkyAtmosphere|default layout|favicon/i.test(e),
  );
  if (newErrs.length) console.log("NEW errs:", newErrs.slice(0, 4));
  else console.log("no new console errors");
  await browser.close();
}
run();
