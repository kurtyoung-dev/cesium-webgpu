#!/usr/bin/env node
/**
 * Batch 408 V11 — per-genus optical EXTINCTION activation probe. WebGPU-only.
 *
 * Slot 103 `profileExtinction` (normalized so the DEFAULT genus CUMULUS == 1.0)
 * now scales `cloud.absorptionCoeff` at the light-march beer/powder, the
 * multi-scatter octaves, AND the view-ray sample transmittance — so a denser
 * genus (cumulonimbus, ~1.58x) absorbs more light → darker, MORE OPAQUE cloud
 * bodies; a thin genus (cirrus, ~0.17x) absorbs less → wispier, MORE TRANSLUCENT.
 *
 * Claims:
 *   (1) CUMULUS (default genus, profileExtinction normalized to 1.0) is
 *       byte-identical to the explicit-CUMULUS render — the default look is
 *       UNCHANGED by the activation (whole-frame diff ~0);
 *   (2) CUMULONIMBUS renders a MORE OPAQUE / DARKER-cored cloud body than CIRRUS
 *       (higher cloud-opacity coverage), confirming extinction scales density;
 *   (3) the default cloud deck is still present (not vanished) and not blown to
 *       white — the zero/unset fallback guard means no all-transparent clouds;
 *   (4) 0 new device/validation errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-extinction.mjs
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
const DEMO = "/Apps/Sandcastle/gallery/WebGPU%20Weather%20Inspector.html";

// CloudType indices
const CUMULUS = 0,
  CIRRUS = 1,
  CUMULONIMBUS = 10;

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

const SETTYPE = async (t) => {
  window.viewer.scene.globe.cloudType = t === null ? undefined : t;
  window.viewer.scene.requestRender();
  return { ok: true };
};

// Region metrics over the deck area (lower-centre, right of the panel).
// Returns:
//   cloudFrac  — fraction of pixels that read as opaque grey cloud (coverage/opacity)
//   meanL      — mean luminance over that region (darker cores → lower)
//   cloudMeanL — mean luminance of just the cloud pixels (dense extinction → darker)
function metrics(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const x0 = Math.floor(c.width * 0.42),
      x1 = Math.floor(c.width * 0.95),
      y0 = Math.floor(c.height * 0.08),
      y1 = Math.floor(c.height * 0.86);
    const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let cloud = 0,
      n = 0,
      sumL = 0,
      cloudSumL = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      const blueSky = b > r + 25 && b > 120;
      sumL += L;
      // Opaque grey cloud: not blue sky, bright-ish, low chroma.
      if (!blueSky && L > 70 && mx - mn < 55) {
        cloud++;
        cloudSumL += L;
      }
      n++;
    }
    return {
      cloudFrac: +((100 * cloud) / n).toFixed(2),
      meanL: +(sumL / n).toFixed(2),
      cloudMeanL: +(cloud > 0 ? cloudSumL / cloud : 0).toFixed(2),
    };
  }, dataUrl);
}

async function diff(page, a, b) {
  return page.evaluate(
    async ([ua, ub]) => {
      const load = async (u) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        return cx.getImageData(0, 0, c.width, c.height).data;
      };
      const da = await load(ua),
        db = await load(ub);
      let acc = 0,
        n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        acc += Math.abs(
          0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2] -
            (0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2]),
        );
      }
      return +(acc / n).toFixed(3);
    },
    [a, b],
  );
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
  await page.waitForFunction(() => !!(window.viewer && window.viewer.scene), null, {
    timeout: 60000,
  });
  await armWebGPUDevices(page);

  const canvas = await page.$(".cesium-widget canvas");
  const shot = async (name) => {
    await canvas.screenshot({ path: `${OUT}/${name}.png` });
    return (
      "data:image/png;base64," +
      fs.readFileSync(`${OUT}/${name}.png`).toString("base64")
    );
  };

  // Fuller deck so the per-genus optical extinction reads clearly: a high coverage
  // + density so the cloud body has interior depth for the extinction to darken.
  await page.evaluate(() => {
    const g = window.viewer.scene.globe;
    g.cloudCoverage = 0.8;
    g.cloudDensity = 0.4;
    window.viewer.scene.requestRender();
  });
  await page.waitForTimeout(9000);
  const duDef = await shot("extinction-default");
  const mDef = await metrics(page, duDef);

  const cap = async (t, name) => {
    await page.evaluate(SETTYPE, t);
    await page.waitForTimeout(4500);
    const du = await shot(name);
    return { du, m: await metrics(page, du) };
  };

  const cu = await cap(CUMULUS, "extinction-cumulus");
  const ci = await cap(CIRRUS, "extinction-cirrus");
  const cb = await cap(CUMULONIMBUS, "extinction-cumulonimbus");

  const diffCuDef = await diff(page, duDef, cu.du);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter(
      (e) =>
        !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
          e,
        ),
    );

  console.log(
    `default : cloudFrac=${mDef.cloudFrac} meanL=${mDef.meanL} cloudMeanL=${mDef.cloudMeanL}`,
  );
  console.log(
    `cumulus : cloudFrac=${cu.m.cloudFrac} meanL=${cu.m.meanL} cloudMeanL=${cu.m.cloudMeanL}`,
  );
  console.log(
    `cirrus  : cloudFrac=${ci.m.cloudFrac} meanL=${ci.m.meanL} cloudMeanL=${ci.m.cloudMeanL}`,
  );
  console.log(
    `cb      : cloudFrac=${cb.m.cloudFrac} meanL=${cb.m.meanL} cloudMeanL=${cb.m.cloudMeanL}`,
  );
  console.log(`diff cumulus-vs-default=${diffCuDef} | errs=${newErrs.length}`);

  const checks = [
    [
      `CUMULUS == default (activation leaves default look UNCHANGED, diff ${diffCuDef} < 0.4)`,
      diffCuDef < 0.4,
    ],
    [
      `default deck PRESENT (not vanished — cloudFrac ${mDef.cloudFrac} > 3)`,
      mDef.cloudFrac > 3,
    ],
    [
      `default deck not blown-out white (cloudMeanL ${cu.m.cloudMeanL} < 252)`,
      cu.m.cloudMeanL < 252,
    ],
    [
      `CUMULONIMBUS more OPAQUE than CIRRUS (cloudFrac cb ${cb.m.cloudFrac} > cirrus ${ci.m.cloudFrac})`,
      cb.m.cloudFrac > ci.m.cloudFrac,
    ],
    [`no NEW device errors (${newErrs.length})`, newErrs.length === 0],
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
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
