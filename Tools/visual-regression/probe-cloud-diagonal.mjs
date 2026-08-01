#!/usr/bin/env node
/**
 * Cloud-coverage DIAGONAL probe. WebGPU-only.
 *
 * The procedural-cloud fullscreen pass used a NON-oversized triangle (verts at
 * three NDC corners), so it rasterized only the lower-left half of the screen
 * and clouds appeared behind a hard corner-to-corner diagonal (long misfiled as
 * a "frustum-edge artifact"). Batch 406 swaps in the oversized fullscreen
 * triangle so the whole screen is shaded.
 *
 * This probe boots the Weather Inspector demo (gallery standalone-boot recipe),
 * applies the OVC St preset (8/8 overcast — a deck that SHOULD fill the sky),
 * settles, compositor-screenshots the canvas (page element screenshot, NOT
 * toDataURL), and measures the grey-cloud-deck fraction in the four screen
 * quadrants. The diagonal bug's signature is a stark TL→BR asymmetry: clouds in
 * the BOTTOM-LEFT quadrant, ~0 in the TOP-RIGHT. The fix makes the overcast deck
 * present in the TOP-RIGHT quadrant too.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-diagonal.mjs
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

const CLICK = async ({ id }) => {
  const el = document.getElementById(id);
  if (el) {
    el.click();
  }
  return { ok: !!el };
};

// Grey-cloud-deck fraction in each screen quadrant. "Deck" = mid/low luminance,
// low saturation (the overcast grey) — distinct from saturated-blue sky. The
// control panel occupies the left ~270px of the top, so the left quadrants are
// measured to the RIGHT of the panel to avoid counting UI chrome.
function quadrantDeck(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const Wd = c.width,
      Hd = c.height;
    const panelRight = Math.floor(Wd * 0.28); // skip the control panel
    function frac(x0, x1, y0, y1) {
      x0 = Math.max(x0, panelRight);
      if (x1 <= x0) {
        return { deck: 0, lum: 0, n: 0 };
      }
      const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let deck = 0,
        lum = 0,
        n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i],
          g = d[i + 1],
          b = d[i + 2];
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        const mx = Math.max(r, g, b),
          mn = Math.min(r, g, b);
        lum += L;
        // overcast grey deck: not strongly blue-saturated, mid luminance band
        const blueDom = b > r + 25 && b > 120; // clearly blue sky
        if (!blueDom && L > 80 && L < 215 && mx - mn < 55) {
          deck++;
        }
        n++;
      }
      return {
        deck: +((100 * deck) / n).toFixed(1),
        lum: +(lum / n).toFixed(0),
        n,
      };
    }
    const midX = Math.floor(Wd * 0.5),
      midY = Math.floor(Hd * 0.5),
      botCap = Math.floor(Hd * 0.86); // exclude the timeline strip at the very bottom
    return {
      topLeft: frac(0, midX, 0, midY),
      topRight: frac(midX, Wd, 0, midY),
      botLeft: frac(0, midX, midY, botCap),
      botRight: frac(midX, Wd, midY, botCap),
    };
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

  const canvas = await page.$(".cesium-widget canvas");
  const shot = async (name) => {
    await canvas.screenshot({ path: `${OUT}/${name}.png` });
    return (
      "data:image/png;base64," +
      fs.readFileSync(`${OUT}/${name}.png`).toString("base64")
    );
  };

  await page.waitForTimeout(9000);
  // OVC St = full 8/8 overcast: a deck that should fill the entire sky.
  await page.evaluate(CLICK, { id: "wi-preset-OVCst" });
  await page.waitForTimeout(7000);
  const du = await shot("cloud-diagonal-ovc");
  const q = await quadrantDeck(page, du);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter(
      (e) =>
        !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
          e,
        ),
    );

  console.log("quadrant deck%:", JSON.stringify(q, null, 0));

  // The diagonal bug rasterized only the lower-LEFT half: the deck filled the
  // bottom-LEFT but the bottom-RIGHT was empty (the corner-to-corner cut). The
  // fix (oversized triangle) makes the deck LEFT-RIGHT SYMMETRIC. The deck
  // legitimately thins toward the zenith (thin deck, short straight-up path), so
  // the TOP being lighter is expected — the regression signature is the
  // bottom-half asymmetry, not zenith fill.
  const lrBottom = Math.abs(q.botLeft.deck - q.botRight.deck);
  const lrTop = Math.abs(q.topLeft.deck - q.topRight.deck);
  const checks = [
    [
      `bottom-RIGHT now has the deck (was ~0 with the diagonal) (${q.botRight.deck}% > 50)`,
      q.botRight.deck > 50,
    ],
    [`bottom-LEFT has the deck (${q.botLeft.deck}% > 50)`, q.botLeft.deck > 50],
    [
      `deck is left-right symmetric in the bottom (|${q.botLeft.deck}-${q.botRight.deck}| = ${lrBottom.toFixed(1)} < 15) -> no TL->BR diagonal`,
      lrBottom < 15,
    ],
    [
      `top is left-right symmetric (|${q.topLeft.deck}-${q.topRight.deck}| = ${lrTop.toFixed(1)} < 15) -> no diagonal`,
      lrTop < 15,
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
