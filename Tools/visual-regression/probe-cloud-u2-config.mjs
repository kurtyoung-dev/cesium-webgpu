#!/usr/bin/env node
/**
 * Probe (CLOUD-U2-CONFIG-INDIRECTION acceptance): slice 2 of the cloud-
 * unification epic makes the WebGPU procedural cloud renderer's
 * `executeProceduralClouds` + `publishCloudIblCoverage` take a structurally-
 * typed `CloudVolumetricsConfig` argument instead of a `CesiumGlobe`. It is a
 * PURE PLUMBING refactor — same field reads, same `?? default` fallbacks, the
 * legacy call site still passes `globe` (identical field names). Therefore the
 * rendered clouds MUST be BYTE-IDENTICAL before vs after the change.
 *
 * This probe renders a deterministic WebGPU procedural-cloud scene (clock
 * frozen at a fixed JulianDate so the wind advection — driven by
 * `frameState.time` — is reproducible across separate browser sessions) and
 * emits an FNV-1a hash of the canvas plus a PNG. Run it against the build
 * WITH the change and against a build reverted to HEAD; the ON-cloud hashes
 * must match exactly. Also emits an OFF hash (clouds disabled) as the trivial
 * off-gate check.
 *
 * Clouds are WebGPU-only, so this probe only exercises the WebGPU backend.
 *
 * Usage:  node Tools/visual-regression/probe-cloud-u2-config.mjs
 * Env:    PROBE_BASE (default http://localhost:8080)
 *         U2_TAG     (label folded into the PNG name, e.g. "after" / "before")
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.U2_TAG || "after";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERR:" + e.message));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90_000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

const result = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer,
    s = v.scene,
    g = s.globe;

  // Deterministic frame: stop the auto loop, freeze the clock, render every
  // frame at ONE fixed simulated time so cloud wind advection is reproducible.
  v.useDefaultRenderLoop = false;
  v.clock.shouldAnimate = false;
  const fixedTime = C.JulianDate.fromIso8601("2026-01-01T12:00:00Z");
  v.clock.currentTime = fixedTime;

  // Deterministic camera below the cloud layer looking toward the horizon.
  s.camera.setView({
    destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 800.0),
    orientation: {
      heading: C.Math.toRadians(0.0),
      pitch: C.Math.toRadians(10.0),
      roll: 0.0,
    },
  });

  function fnv(str) {
    let hh = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hh ^= str.charCodeAt(i);
      hh = Math.imul(hh, 0x01000193);
    }
    return hh >>> 0;
  }

  async function settle(n) {
    // Yield between frames so the lazily-imported PROCEDURAL_CLOUDS feature-
    // renderer module (dynamic import → microtask) resolves + registers, and
    // any temporal accumulation converges. A fully-synchronous loop would never
    // let the import land.
    for (let i = 0; i < n; i++) {
      s.render(fixedTime);
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  function capture() {
    // One FRESH synchronous render with NO trailing rAF, so the WebGPU canvas
    // back-buffer is still intact for readback (a compositor frame boundary
    // clears it). The PNG dataURL bytes are the byte-identical gate — identical
    // pixels encode to an identical (timestamp-free) PNG. The drawImage pixel
    // stats are a sanity metric (clouds actually present, not a black frame).
    s.render(fixedTime);
    const url = s.canvas.toDataURL("image/png");
    const canvas = s.canvas,
      w = canvas.width,
      h = canvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const cx = tmp.getContext("2d");
    cx.drawImage(canvas, 0, 0);
    const px = cx.getImageData(0, 0, w, h).data;
    let cloudish = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i],
        gg = px[i + 1],
        b = px[i + 2];
      const mx = Math.max(r, gg, b),
        mn = Math.min(r, gg, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      if (mx > 150 && sat < 0.18) cloudish++;
    }
    return { hash: fnv(url), cloudish, w, h, url };
  }

  // ── OFF path: clouds disabled → the trivial off-gate baseline. ──
  g.showProceduralClouds = false;
  await settle(20);
  const off = capture();

  // ── ON path: exercise a broad set of read sites, incl. the cast-only
  // expanded knobs (species / mammatus / weather-channel / genus profile). ──
  g.showProceduralClouds = true;
  g.cloudCoverage = 0.55;
  g.cloudDensity = 0.8;
  g.cloudLayerBottom = 1500.0;
  g.cloudLayerTop = 4000.0;
  g.cloudWindSpeed = 22.0;
  g.cloudWindDirection = new C.Cartesian2(0.7, 0.3);
  g.cloudContributesIBL = true;
  g.cloudCastShadows = true;
  g.cloudSilverLiningIntensity = 0.85;
  g.cloudPhaseForwardG = 0.85;
  g.cloudPhaseBackG = -0.3;
  g.cloudPhaseBlend = 0.7;
  g.cloudAmbientIntensity = 1.5;
  g.cloudErosionStrength = 0.18;
  g.cloudCurlAmplitude = 0.4;
  g.cloudCurlFrequency = 2.0;
  g.cloudAerialStrength = 1.0;
  g.cloudExposure = 0.22;
  g.cloudType = C.CloudType.CUMULONIMBUS;
  g.cloudWeatherChannelStrength = 1.0;
  // Cast-only expanded knobs (read via `config as unknown as {…}` in the
  // renderer) — exercise the species / mammatus density-shaping branches.
  g.cloudSpecies = "lenticularis";
  g.cloudMammatusStrength = 0.5;
  await settle(120);
  const on = capture();

  const shotUrl = on.url;
  delete off.url;
  delete on.url;
  return {
    renderer: s.context?.rendererType,
    off,
    on,
    shotUrl,
  };
});

const b64 = result.shotUrl.split(",")[1];
writeFileSync(
  `Tools/visual-regression/out-cloud-u2-${TAG}.png`,
  Buffer.from(b64, "base64"),
);
delete result.shotUrl;

await browser.close();

const filtered = errors.filter((e) => !/AtmosphereLUT|default layout/.test(e));
console.log(`=== CLOUD-U2 (${TAG}) ===`);
console.log(`  renderer=${result.renderer}`);
console.log(
  `  OFF hash=${result.off.hash} cloudish=${result.off.cloudish}`,
);
console.log(
  `  ON  hash=${result.on.hash} cloudish=${result.on.cloudish} (${result.on.w}x${result.on.h})`,
);
console.log(`  console errors: ${filtered.length}`);
if (filtered.length) console.log("  " + JSON.stringify(filtered.slice(0, 5)));
// Machine-readable line for the before/after comparison.
console.log(
  `U2_RESULT ${TAG} onHash=${result.on.hash} offHash=${result.off.hash} onCloudish=${result.on.cloudish}`,
);
process.exit(0);
