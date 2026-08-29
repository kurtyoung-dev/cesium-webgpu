#!/usr/bin/env node
// Acceptance probe for NS-SANDCASTLE2-WEBGPU-WONT-START.
// @purpose Acceptance for the Sandcastle2 frozen-module crash: Mars demo loads on both renderers, no 'Cannot assign to property Viewer', canvas renders.
// @status ACTIVE
//
// Repro: In Sandcastle2 (Apps/Sandcastle2) selecting WebGPU left the viewer stuck
// on "Loading..." and both backends logged:
//   Uncaught TypeError: Cannot assign to property "Viewer" of [object Module] (line 43)
// Root cause: the renderer preamble did `_Cesium.Viewer = proxy` where `_Cesium` is
// the FROZEN ES-module namespace from `await import("cesium")`. Assigning to it throws
// and aborts the whole demo module.
//
// This probe loads the Mars demo in Sandcastle2 for BOTH renderers, asserts:
//   (a) no "Cannot assign to property" / Uncaught TypeError in any frame's console,
//   (b) the bucket demo finished loading (no lingering sandcastle-loading overlay)
//       and a canvas exists with some non-black pixels (it actually renders),
//   (c) WebGL still works the same way.
//
// Opens the built app through `sandcastle2-origin-rewrite.mjs` /
// `openSandcastle2Url` — the built bundle bakes a top-level redirect to
// whatever origins it was built with, so a bare `page.goto` here would risk
// silently landing on whatever server happens to be running on the baked
// origin instead of the one this run asked for. `PROBE_BASE`/
// `PROBE_SANDCASTLE_BASE` select the run's own ports; neither defaults to
// 8080/8081.
//
// Usage: PROBE_BASE=http://localhost:8134 node Tools/visual-regression/probe-sandcastle2-webgpu-start.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

import {
  createGuardedPage,
  OriginRewriteRefusal,
} from "./lib/sandcastle2-origin-rewrite.mjs";
import { openSandcastle2Url } from "./lib/sandcastle2-renderer-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const BUCKET_BASE =
  process.env.PROBE_SANDCASTLE_BASE ||
  `http://localhost:${Number(new URL(BASE).port || 80) + 1}`;
const OUT_DIR = "Tools/visual-regression/output";
const DEMO_ID = "mars";

function settingsJson(rendererMode) {
  // Matches SettingsProvider serializer output; stored under key "sandcastle/settings".
  return JSON.stringify({
    theme: "dark",
    fontFamily: "droid-sans",
    fontSize: 14,
    fontLigatures: false,
    defaultPanel: "gallery",
    embeddingSearch: false,
    rendererMode,
    showFps: false,
  });
}

async function run(rendererMode) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  // Seed localStorage for the app origin BEFORE any app script runs.
  await context.addInitScript(
    ([key, val]) => {
      try {
        window.localStorage.setItem(key, val);
      } catch (_e) {
        /* ignore */
      }
    },
    ["sandcastle/settings", settingsJson(rendererMode)],
  );

  // `createGuardedPage` attaches the persistent origin guard before the page
  // ever navigates, and wraps `close()` to assert no breach was ever
  // recorded. `browser.close()` does NOT invoke the JavaScript-level
  // `page.close()` wrapper — it tears the browser process down directly — so
  // every exit path below closes the PAGE (through the wrapper) before
  // closing the browser, never the other way around and never browser-only.
  const page = await createGuardedPage(context, {
    servedOrigin: new URL(BASE).origin,
    bucketOrigin: new URL(BUCKET_BASE).origin,
  });
  const messages = [];
  const record = (t, text) => messages.push({ t, text });
  page.on("console", (m) => record(m.type(), m.text()));
  page.on("pageerror", (e) => record("pageerror", e.message));

  // Set from either the navigation catch below or the close-time fail-closed
  // check in `finally` — whichever finds a structural refusal first. A
  // refusal found in the try body always wins over one `page.close()` finds
  // during cleanup (the same "refusal beats a cleanup-time throw" rule
  // `createGuardedPage` itself follows), and either way it is thrown only
  // AFTER cleanup has actually finished, at the very end of this function.
  let structuralRefusal = null;
  let cleanupError = null;
  let result;

  try {
    let bucketFrame;
    try {
      const opened = await openSandcastle2Url(
        page,
        {
          base: BASE,
          bucketBase: BUCKET_BASE,
          id: DEMO_ID,
          renderer: rendererMode,
        },
        { timeoutMs: 20000 },
      );
      bucketFrame = opened.bucketFrame;
    } catch (error) {
      if (error instanceof OriginRewriteRefusal) {
        // Distinct from "bucket iframe never appeared": this means the page
        // (or the bucket frame) landed on a server nobody asked for, which
        // this run cannot recover from — surfaced plainly rather than
        // reported as an ordinary FAIL a retry might paper over.
        structuralRefusal = error;
      } else {
        result = {
          rendererMode,
          ok: false,
          reason: `bucket iframe never appeared: ${String(error?.message ?? error)}`,
          messages,
        };
      }
    }

    if (!structuralRefusal && !result) {
      // Give the demo time to run (module load + Viewer construction + first frames).
      await page.waitForTimeout(9000);

      // Loading overlay gone + a canvas exists inside the bucket frame.
      let frameState = {
        hasCanvas: false,
        loading: true,
        nonBlackFrac: 0,
        mean: 0,
      };
      try {
        frameState = await bucketFrame.evaluate(() => ({
          hasCanvas: !!document.querySelector("canvas"),
          loading: document.body.classList.contains("sandcastle-loading"),
        }));
      } catch (e) {
        frameState.error = String(e);
      }

      const outPng = path.join(
        OUT_DIR,
        `sandcastle2-${rendererMode}-${DEMO_ID}.png`,
      );
      await page.screenshot({ path: outPng });

      // Live GPU canvases don't preserve their drawing buffer, so reading them
      // back yields black. Instead measure "does it render" from a rasterized
      // element screenshot of the bucket iframe, decoded back into a 2D canvas
      // (a PNG raster, not a live GPU surface, so getImageData is reliable).
      try {
        const shot = await page
          .locator("iframe.fullFrame")
          .first()
          .screenshot();
        const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;
        const stats = await page.evaluate(async (url) => {
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = url;
          });
          const w = 240;
          const h = 160;
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h).data;
          let nonBlack = 0;
          let sum = 0;
          const total = w * h;
          for (let i = 0; i < data.length; i += 4) {
            const lum = data[i] + data[i + 1] + data[i + 2];
            sum += lum;
            if (lum > 24) {
              nonBlack++;
            }
          }
          return { nonBlackFrac: nonBlack / total, mean: sum / total / 3 };
        }, dataUrl);
        frameState.nonBlackFrac = stats.nonBlackFrac;
        frameState.mean = stats.mean;
      } catch (e) {
        frameState.shotError = String(e);
      }

      const assignErr = messages.filter((m) =>
        /Cannot assign to property/i.test(m.text),
      );
      const typeErrs = messages.filter(
        (m) =>
          (m.t === "error" || m.t === "pageerror") &&
          /TypeError/i.test(m.text) &&
          !/ion|fetch|network|token|401|403|404/i.test(m.text),
      );

      result = {
        rendererMode,
        outPng,
        frameState,
        assignErr,
        typeErrs,
        errorCount: messages.filter(
          (m) => m.t === "error" || m.t === "pageerror",
        ).length,
        messages,
      };
    }
  } finally {
    try {
      await page.close();
    } catch (closeErr) {
      if (closeErr instanceof OriginRewriteRefusal) {
        structuralRefusal ??= closeErr;
      } else {
        cleanupError ??= closeErr;
      }
    }
    try {
      await browser.close();
    } catch (closeErr) {
      cleanupError ??= closeErr;
    }
  }

  if (structuralRefusal) {
    throw structuralRefusal;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  let pass = true;
  for (const mode of ["webgpu", "webgl"]) {
    console.log(`\n=== Sandcastle2 [${mode}] demo=${DEMO_ID} ===`);
    let r;
    try {
      r = await run(mode);
    } catch (error) {
      if (error instanceof OriginRewriteRefusal) {
        console.log(`\nREFUSED: [${mode}] ${error.code}: ${error.reason}`);
        process.exit(2);
      }
      throw error;
    }
    if (r.ok === false) {
      console.log(`  FAIL: ${r.reason}`);
      pass = false;
      continue;
    }
    console.log(`  screenshot: ${r.outPng}`);
    console.log(`  canvas: ${JSON.stringify(r.frameState)}`);
    console.log(`  "Cannot assign to property" errors: ${r.assignErr.length}`);
    r.assignErr
      .slice(0, 2)
      .forEach((e) => console.log(`     ! ${e.text.slice(0, 160)}`));
    console.log(`  non-ion TypeErrors: ${r.typeErrs.length}`);
    r.typeErrs
      .slice(0, 3)
      .forEach((e) => console.log(`     ! ${e.text.slice(0, 160)}`));

    const noAssign = r.assignErr.length === 0;
    const noTypeErr = r.typeErrs.length === 0;
    const rendered =
      r.frameState.hasCanvas &&
      !r.frameState.loading &&
      r.frameState.nonBlackFrac > 0.01;
    console.log(
      `  -> noAssignErr=${noAssign} noTypeErr=${noTypeErr} rendered=${rendered}`,
    );
    if (!(noAssign && noTypeErr && rendered)) {
      pass = false;
    }
  }

  console.log(`\n[probe-sandcastle2-webgpu-start] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
})();
