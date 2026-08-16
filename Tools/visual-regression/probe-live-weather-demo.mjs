#!/usr/bin/env node
/**
 * WebGPU Live Weather (EDR) gallery demo — wiring + graceful-fallback probe.
 * @purpose Verifies the live-EDR weather demo plumbing to the network boundary: provider wired through /proxy, graceful fallback + status panel on fetch failure
 * @status ACTIVE
 *
 * WebGPU-only.
 *
 * Verifies the live-EDR PLUMBING end-to-end up to the network boundary: the demo
 * boots, sets globe.defaultCloudCollection.volumetric.weatherProvider to a WeatherProvider(EdrWeatherSource) routed
 * through the dev server's same-origin /proxy, the cloud renderer kicks the fetch,
 * and — because this sandbox has NO outbound network to external hosts — the proxy
 * returns 502, EdrWeatherSource rejects, and the provider records lastError while
 * the cloud deck keeps rendering from the procedural map (graceful fallback, no
 * crash). The status panel reflects the failure.
 *
 * The LIVE DATA path (real NOAA cloud cover driving the deck) is NOT verifiable
 * here — it needs a networked browser. This probe proves everything else is wired
 * correctly so that, where the feed IS reachable, it just works.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-live-weather-demo.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const W = 1024,
  H = 768;
const OUT = "Tools/visual-regression/output";
const DEMO = "/Apps/Sandcastle/gallery/WebGPU%20Live%20Weather%20(EDR).html";

const SANDCASTLE_STUB = () => {
  window.Sandcastle = {
    finishedLoading() {
      document.body.classList.remove("sandcastle-loading");
      const o = document.getElementById("loadingOverlay");
      if (o) {
        o.style.display = "none";
      }
    },
    declare() {},
    highlight() {},
    reset() {},
    addToolbarButton() {},
    addToggleButton() {},
    addToolbarMenu() {},
  };
};

const BOOT = async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  window.Cesium = C;
  if (typeof window.startup !== "function") {
    return { ok: false, err: "window.startup not defined" };
  }
  try {
    await window.startup(C);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String((e && e.stack) || e) };
  }
};

const STATE = async () => {
  const g = window.viewer.scene.globe;
  const p = g.defaultCloudCollection.volumetric.weatherProvider;
  const src = p && p.getSource ? p.getSource() : null;
  const cap = src && src.getCapabilities ? src.getCapabilities() : null;
  const panel = document.getElementById("wxPanel");
  return {
    hasProvider: !!p,
    sourceId: cap ? cap.id : null,
    hasData: p ? p.hasData : null,
    lastError: p ? p.lastError : null,
    panelText: panel ? panel.textContent.slice(0, 200) : null,
  };
};

function cloudPct(page, dataUrl) {
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
    let cloud = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      if (L > 130 && mx - mn < 45) {
        cloud++;
      }
    }
    return +((100 * cloud) / n).toFixed(2);
  }, dataUrl);
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
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.addInitScript(SANDCASTLE_STUB);
  await page.goto(`${BASE}${DEMO}`, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({
    content:
      "#cesiumContainer{position:absolute;top:0;left:0;width:100%;height:100%;}#loadingOverlay{display:none;}",
  });
  const boot = await page.evaluate(BOOT);
  if (!boot.ok) {
    console.log("BOOT FAILED:", boot.err);
    await browser.close();
    process.exitCode = 1;
    return;
  }
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    {
      timeout: 60000,
    },
  );
  await armWebGPUDevices(page);
  // Let the render loop kick the provider fetch (→ proxy → 502) + settle clouds.
  await page.waitForTimeout(12000);

  const canvas = await page.$(".cesium-widget canvas");
  await canvas.screenshot({ path: `${OUT}/live-weather-demo.png` });
  const du =
    "data:image/png;base64," +
    fs.readFileSync(`${OUT}/live-weather-demo.png`).toString("base64");
  const pct = await cloudPct(page, du);
  const st = await page.evaluate(STATE);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter(
      (e) =>
        !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6|EDR fetch|proxy|502|Failed to fetch/i.test(
          e,
        ),
    );

  console.log("state", JSON.stringify(st));
  console.log("cloudPct", pct, "newErrs", newErrs.length);

  const reachedNetworkBoundary =
    typeof st.lastError === "string" &&
    /502|EDR fetch failed|fetch/i.test(st.lastError);

  const checks = [
    ["demo booted + weatherProvider set", st.hasProvider === true],
    [
      `provider source is EDR (${st.sourceId})`,
      typeof st.sourceId === "string" && st.sourceId.startsWith("edr:"),
    ],
    [
      `live fetch attempted + failed GRACEFULLY here (lastError: ${st.lastError}) — proves the proxy path; live data needs a networked browser`,
      st.hasData === false && reachedNetworkBoundary,
    ],
    [
      `clouds STILL render via procedural fallback (cloudPct ${pct} > 1)`,
      pct > 1,
    ],
    [
      `status panel shows the feed state`,
      typeof st.panelText === "string" && st.panelText.length > 0,
    ],
    [
      `no NEW (non-feed) device/runtime errors (${newErrs.length})`,
      newErrs.length === 0,
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
  if (newErrs.length) {
    console.log("  errors:", newErrs.slice(0, 5));
  }
  console.log(
    `\nRESULT: ${pass ? "GREEN" : "RED"}  (live DATA path unverified — needs network)`,
  );
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
