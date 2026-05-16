#!/usr/bin/env node
// Probe: load the user's actual reproduction URL (with saved-view query
// param) and capture WebGL vs WebGPU side-by-side. This catches issues
// the default-camera probes miss — specific camera positions/altitudes
// trigger LOD-specific tile artifacts and sky-shell depth bugs.
//
// Usage: node Tools/visual-regression/probe-saved-view.mjs
// Outputs: probe-saved-view-{webgl,webgpu}-{label}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEWS = [
  {
    name: "default-3d",
    // No view query — exactly what user sees on a fresh load. The ring
    // artifact is most visible here (orbital altitude over default
    // camera position).
    query: "",
  },
  {
    name: "caribbean-orbit",
    // User's URL fragment: ?view=-70.10368589552938%2C18.485...
    // Try a typical orbital altitude (~12 Mm).
    query: "view=-70.10368589552938%2C18.485%2C12000000",
  },
  {
    name: "caribbean-mid",
    // Mid-altitude where LOD-specific artifacts appeared in the
    // user's zoom-in screenshots.
    query: "view=-70.10368589552938%2C18.485%2C2000000",
  },
];

async function capture(rendererArg, view) {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));
  // Surface SkyAtm diagnostic immediately so we see it during the run.
  page.on("console", (m) => {
    const txt = m.text();
    if (txt.includes("[SkyAtm]")) console.log(`    ${txt}`);
  });

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}${
    view.query ? "&" + view.query : ""
  }`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  // Let tiles + imagery + sky atmosphere settle
  await page.evaluate(async () => {
    const v = window.viewer;
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(2000);

  const out = path.join(OUT_DIR, `probe-saved-view-${view.name}-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  ${errs.length} errors:`);
    errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  return out;
}

// Compute pixel-level RGB diff between WebGL + WebGPU screenshots via
// Playwright's own canvas decode (avoids Node-side PNG dep). Renders
// both PNGs into a hidden canvas and compares ImageData. Returns a
// mismatch percentage at threshold-30 (skips tiny float diffs but
// catches visible artifacts like the ring / olive rectangle bug).
async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return { w: img.naturalWidth, h: img.naturalHeight, data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      const total = a.w * a.h;
      let mismatch = 0, sum = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const dr = Math.abs(a.data[i] - b.data[i]);
        const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
        const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
        const d = dr + dg + db;
        sum += d;
        if (d > 30) mismatch++;
      }
      return { totalPx: total, mismatchPx: mismatch, mismatchPct: (100 * mismatch / total).toFixed(2), meanDelta: (sum / total).toFixed(2) };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const view of VIEWS) {
    console.log(`[probe-saved-view] ${view.name}`);
    const gpu = await capture("webgpu", view);
    const gl = await capture("webgl", view);
    console.log(`  webgpu: ${gpu}`);
    console.log(`  webgl:  ${gl}`);
    try {
      const diff = await diffPngs(gpu, gl);
      console.log(`  diff:`, JSON.stringify(diff));
    } catch (e) {
      console.log(`  diff failed: ${e.message}`);
    }
  }
  console.log("[probe-saved-view] done");
})();
