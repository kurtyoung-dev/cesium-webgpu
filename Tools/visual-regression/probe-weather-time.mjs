#!/usr/bin/env node
/**
 * Weather ingest Phase 2 — TIME MODEL. Logic probe (no network, no WebGPU).
 * @purpose Weather time-model logic probe (no render): slice quantization, version-on-slice-change, historical/projected resolve, LRU scrub-back hit.
 * @status ACTIVE
 *
 * The time model is pure provider logic (resolve a quantized time slice, LRU
 * cache, version-only-on-slice-change), so it's verified by the PACKED BYTES +
 * version counter, not a render. Drives a deterministic time-varying
 * SyntheticWeatherSource("drift") through the WeatherProvider and asserts:
 *   - live `tick` advances the field (advancing the clock changes the bytes);
 *   - a sub-quantum tick does NOT bump version (slice unchanged);
 *   - historical / projected resolve distinct slices;
 *   - scrubbing back to a fetched slice is an instant LRU cache hit;
 *   - a provider with no time mode keeps the legacy "latest" behavior.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-time.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html`;

const TEST = async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const W = 256,
    H = 128;
  const HOUR = 3600000;
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);

  const out = {
    hasApi:
      typeof C.WeatherProvider === "function" &&
      typeof C.SyntheticWeatherSource === "function" &&
      typeof new C.WeatherProvider().setTimeMode === "function" &&
      typeof new C.WeatherProvider().tick === "function",
  };
  if (!out.hasApi) {
    return out;
  }

  const hash = (b) => {
    let h = 0;
    for (let i = 0; i < b.length; i += 137) {
      h = (h * 31 + b[i]) >>> 0;
    }
    return h;
  };
  const poll = async (p) => {
    for (let i = 0; i < 60; i++) {
      const b = p.getPackedTexture(W, H);
      if (b) {
        return b;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    return null;
  };

  const src = new C.SyntheticWeatherSource("drift");
  out.supportsTime = src.getCapabilities().supportsTime;
  const p = new C.WeatherProvider(src);

  // LIVE — advance the clock, the drift field must change.
  p.setTimeMode("live");
  p.tick(t0);
  const b0 = await poll(p);
  const v0 = p.version;
  p.tick(t0 + 6 * HOUR);
  const b6 = await poll(p);
  const v6 = p.version;
  // sub-quantum tick (+1 min, same hour slice) → no byte change, no version bump.
  p.tick(t0 + 6 * HOUR + 60000);
  const vSame = p.version;

  // HISTORICAL — a fixed past instant, distinct field. (-9h: NOT a multiple of
  // the drift period, so the sinusoid is at a different phase than t0.)
  p.setTimeMode("historical");
  p.setTime(new Date(t0 - 9 * HOUR));
  const bH = await poll(p);
  const effHist = String(p.getEffectiveTime());

  // PROJECTED — now + 18h (also off the period, distinct from t0).
  p.setTimeMode("projected");
  p.setForecastOffsetHours(18);
  p.tick(t0);
  const bP = await poll(p);

  // CACHE REUSE — scrub live back to the already-fetched 6h slice (instant hit).
  p.setTimeMode("live");
  p.tick(t0 + 6 * HOUR);
  const vBack = p.version;
  const bBack = p.getPackedTexture(W, H); // must be non-null immediately (cache hit)

  // LEGACY — no time mode, "latest" behavior unchanged.
  const legacy = new C.WeatherProvider(new C.SyntheticWeatherSource("drift"));
  const bL = await poll(legacy);

  out.timeMode = p.getTimeMode();
  out.legacyMode = legacy.getTimeMode();
  out.legacyHasData = !!bL;
  out.cacheHitImmediate = !!bBack;
  out.h = {
    h0: b0 ? hash(b0) : null,
    h6: b6 ? hash(b6) : null,
    hH: bH ? hash(bH) : null,
    hP: bP ? hash(bP) : null,
    hBack: bBack ? hash(bBack) : null,
  };
  out.v = { v0, v6, vSame, vBack };
  out.effHist = effHist;
  return out;
};

async function run() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  const r = await page.evaluate(TEST);
  console.log(JSON.stringify(r, null, 1));

  const h = r.h || {};
  const v = r.v || {};
  const checks = [
    [
      "time-model API exported (setTimeMode/tick/setTime/...)",
      r.hasApi === true,
    ],
    [
      'SyntheticWeatherSource("drift") advertises supportsTime',
      r.supportsTime === true,
    ],
    [
      `live tick advances the field (h0 ${h.h0} != h6 ${h.h6})`,
      h.h0 != null && h.h6 != null && h.h0 !== h.h6,
    ],
    [
      `sub-quantum tick does NOT bump version (vSame ${v.vSame} === v6 ${v.v6})`,
      v.vSame === v6Safe(v),
    ],
    [
      `historical resolves a distinct slice (hH ${h.hH} != h0 ${h.h0})`,
      h.hH != null && h.hH !== h.h0,
    ],
    [
      `projected resolves a distinct slice (hP ${h.hP} != h0 ${h.h0})`,
      h.hP != null && h.hP !== h.h0,
    ],
    [
      `scrub-back is an instant LRU cache hit (immediate=${r.cacheHitImmediate}, hBack ${h.hBack} === h6)`,
      r.cacheHitImmediate === true && h.hBack === h.h6,
    ],
    [
      `slice change on scrub-back bumped version (vBack ${v.vBack} > v6 ${v.v6})`,
      v.vBack > v.v6,
    ],
    [
      `legacy provider has no time mode + still serves data (mode=${r.legacyMode}, data=${r.legacyHasData})`,
      r.legacyMode === null && r.legacyHasData === true,
    ],
  ];
  console.log("\n=== ANALYSIS ===");
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) {
      pass = false;
    }
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
function v6Safe(v) {
  return v.v6;
}
run();
