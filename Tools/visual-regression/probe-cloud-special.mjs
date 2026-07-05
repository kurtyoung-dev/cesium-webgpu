#!/usr/bin/env node
/**
 * Batch 612 (E3 CLOUD-EXOTIC-SPECIAL) — the "special clouds" (noctilucent / nacreous)
 * as an iridescent SHADING tint on the WebGPU procedural-cloud arch. WebGPU-only.
 *
 * Unlike the E1/E2 density-shaping dials (species/features), this multiplies the
 * cloud COLOR by an iridescent tint:
 *   globe.defaultCloudCollection.volumetric.cloudSpecial ("noctilucent"/"nlc" | "nacreous"/"psc") (or numeric
 *   globe.defaultCloudCollection.volumetric.cloudSpecialShadeMode 1/2) tints the deck:
 *     mode 1 noctilucent — electric silvery-blue billow bands;
 *     mode 2 nacreous    — pastel mother-of-pearl iridescence keyed to sun/view angle.
 * Default OFF (cloudSpecial unset → specialShadeMode=0) → the WGSL specialShadeTint()
 * early-returns vec3(1.0) so the cloud color is multiplied by exactly 1.0 →
 * byte-identical to the pre-612 render.
 *
 * Boots the Weather Inspector on a dense deck, FREEZES the clock (so cloud advection
 * can't confound the off-gate), and checks:
 *   (1) OFF baseline vs a 2nd OFF capture → ~0 diff (grown 140→144 UBO does not
 *       perturb the OFF render);
 *   (2) noctilucent ON substantially changes the render AND shifts the deck BLUE;
 *   (3) nacreous ON substantially changes the render;
 *   (4) nacreous differs from noctilucent (different tint model);
 *   (5) restoring OFF returns to the OFF baseline (clean toggle, no residual);
 *   (6) 0 new device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-special.mjs
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

const CUMULONIMBUS = 10;

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

// Per-pixel coolward shift over the deck region. Compares two captures and, over
// the pixels that ACTUALLY CHANGED (|ΔL| > 10 — i.e. the cloud pixels the tint
// touched, NOT the static bright sky/atmosphere backdrop that a naive region mean
// is dominated by), returns mean(Δb) - mean(Δr). Positive → blue rose more (or fell
// less) than red → the changed cloud pixels shifted COOL, the noctilucent signature.
function coolShift(page, offUrl, onUrl) {
  return page.evaluate(
    async ([uo, un]) => {
      const load = async (u) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        return { d: cx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
      };
      const A = await load(uo),
        B = await load(un);
      const x0 = Math.floor(A.w * 0.42),
        x1 = Math.floor(A.w * 0.95),
        y0 = Math.floor(A.h * 0.08),
        y1 = Math.floor(A.h * 0.86);
      let sdr = 0,
        sdb = 0,
        n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * A.w + x) * 4;
          const dr = B.d[i] - A.d[i];
          const dg = B.d[i + 1] - A.d[i + 1];
          const db = B.d[i + 2] - A.d[i + 2];
          const dL = Math.abs(0.299 * dr + 0.587 * dg + 0.114 * db);
          if (dL > 10) {
            sdr += dr;
            sdb += db;
            n++;
          }
        }
      }
      if (n === 0) {
        return { dr: 0, db: 0, cool: 0, n: 0 };
      }
      return {
        dr: +(sdr / n).toFixed(2),
        db: +(sdb / n).toFixed(2),
        cool: +((sdb - sdr) / n).toFixed(2),
        n,
      };
    },
    [offUrl, onUrl],
  );
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

  // Dense deck. FREEZE the clock so cloud advection can't confound the OFF
  // byte-identity gate — with the clock stopped `cloud.time` is constant.
  await page.evaluate((cb) => {
    const v = window.viewer;
    const g = v.scene.globe;
    g.defaultCloudCollection.cloudType = cb;
    g.defaultCloudCollection.volumetric.cloudCoverage = 0.85;
    g.defaultCloudCollection.volumetric.cloudDensity = 0.5;
    g.defaultCloudCollection.volumetric.cloudSpecial = undefined; // OFF (default)
    g.defaultCloudCollection.volumetric.cloudSpecialShadeMode = undefined;
    v.clock.shouldAnimate = false;
    v.scene.requestRender();
  }, CUMULONIMBUS);
  await page.waitForTimeout(9000);

  const set = async (obj) => {
    await page.evaluate((o) => {
      const g = window.viewer.scene.globe;
      for (const k of Object.keys(o)) {
        g[k] = o[k] === "__undef__" ? undefined : o[k];
      }
      window.viewer.scene.requestRender();
    }, obj);
    await page.waitForTimeout(4000);
  };

  const duOff = await shot("special-off");

  // 2nd OFF capture (frozen clock) — determinism / grown-UBO off-gate.
  await set({ cloudSpecial: "__undef__", cloudSpecialShadeMode: "__undef__" });
  const duOff2 = await shot("special-off2");

  // Noctilucent — electric silvery-blue billow bands.
  await set({ cloudSpecial: "noctilucent", cloudSpecialShadeStrength: 0.9, cloudSpecialShadeScale: 1.0 });
  const duNlc = await shot("special-noctilucent");

  // Nacreous — pastel mother-of-pearl iridescence.
  await set({ cloudSpecial: "nacreous", cloudSpecialShadeStrength: 0.9, cloudSpecialShadeScale: 1.0 });
  const duNac = await shot("special-nacreous");

  // Restore OFF — clean toggle, no residual.
  await set({
    cloudSpecial: "__undef__",
    cloudSpecialShadeMode: "__undef__",
    cloudSpecialShadeStrength: "__undef__",
    cloudSpecialShadeScale: "__undef__",
    cloudSpecialShadeParam: "__undef__",
  });
  const duRestore = await shot("special-off-restored");

  const diffOffOff = await diff(page, duOff, duOff2);
  const diffNlc = await diff(page, duOff, duNlc);
  const diffNac = await diff(page, duOff, duNac);
  const diffNlcNac = await diff(page, duNlc, duNac);
  const diffRestore = await diff(page, duOff, duRestore);

  // Coolward shift on the CHANGED cloud pixels (ignores the static bright sky the
  // region mean is otherwise dominated by): Δb - Δr per changed pixel.
  const coolNlc = await coolShift(page, duOff, duNlc);

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
    `noctilucent cool-shift on changed pixels: Δr=${coolNlc.dr} Δb=${coolNlc.db} (Δb-Δr=${coolNlc.cool}, n=${coolNlc.n})`,
  );
  console.log(
    `diff: off-vs-off2=${diffOffOff} nlc=${diffNlc} nacreous=${diffNac} nlc-vs-nac=${diffNlcNac} restore=${diffRestore} | errs=${newErrs.length}`,
  );

  const checks = [
    [`OFF is deterministic w/ grown UBO (off-vs-off2 ${diffOffOff} < 0.25)`, diffOffOff < 0.25],
    [`noctilucent ON substantially changes the render (${diffNlc} > 1.0)`, diffNlc > 1.0],
    [`noctilucent COOLS the changed cloud pixels (Δb-Δr ${coolNlc.cool} > 3)`, coolNlc.cool > 3],
    [`nacreous ON substantially changes the render (${diffNac} > 1.0)`, diffNac > 1.0],
    [`nacreous differs from noctilucent (nlc-vs-nac ${diffNlcNac} > 0.5)`, diffNlcNac > 0.5],
    [`restoring OFF returns to baseline (restore-vs-off ${diffRestore} < 0.25)`, diffRestore < 0.25],
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
