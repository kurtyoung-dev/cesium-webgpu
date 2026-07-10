#!/usr/bin/env node
/**
 * WebGPU ↔ WebGL Visual Regression Runner
 *
 * Drives Playwright through the split-screen comparison page, applies each
 * scene from `scenes.json`, captures the WebGL canvas + WebGPU canvas, and
 * computes a per-pixel diff image showing where the two backends disagree.
 *
 * Usage:
 *   node Tools/visual-regression/capture-and-diff.mjs            # run all scenes
 *   node Tools/visual-regression/capture-and-diff.mjs --update   # write new baselines
 *   node Tools/visual-regression/capture-and-diff.mjs --scene globe-default
 *
 * Output layout:
 *   Tools/visual-regression/baseline/<scene>.webgl.png
 *   Tools/visual-regression/baseline/<scene>.webgpu.png
 *   Tools/visual-regression/output/<scene>.webgl.png
 *   Tools/visual-regression/output/<scene>.webgpu.png
 *   Tools/visual-regression/output/<scene>.diff.png   (red = mismatch)
 *   Tools/visual-regression/output/report.json        (per-scene diff stats)
 *
 * Requirements:
 *   - Playwright installed (already a dev tool via the MCP plugin marketplace).
 *     If not present, this script will print an install hint and exit non-zero.
 *   - The dev server (`npm run restart`) must be serving on the URL declared
 *     in scenes.json before running this script.
 *
 * Threshold:
 *   The exit code is 0 when every scene's diff ratio is below `--threshold`
 *   (default 0.02 = 2%) and non-zero otherwise — suitable for CI gating.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENES_PATH = path.join(__dirname, "scenes.json");
const BASELINE_DIR = path.join(__dirname, "baseline");
const OUTPUT_DIR = path.join(__dirname, "output");

function parseArgs(argv) {
  const args = {
    update: false,
    scene: null,
    threshold: 0.02,
    headless: true,
    browser: "msedge",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update") args.update = true;
    else if (a === "--headed") args.headless = false;
    else if (a === "--scene") args.scene = argv[++i];
    else if (a === "--threshold") args.threshold = Number(argv[++i]);
    else if (a === "--browser") args.browser = argv[++i];
  }
  return args;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (err) {
    console.error(
      "[visual-regression] Playwright is not installed.\n" +
        "Install it as a dev dep, or run via the bundled MCP plugin's runtime.",
    );
    process.exit(2);
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Per-pixel diff between two equally-sized RGBA buffers. Returns the diff
 * buffer (red on mismatch, black elsewhere) plus the fraction of pixels that
 * differ beyond `tolerance` channel intensity.
 */
function diffPixelBuffers(a, b, width, height, tolerance = 16) {
  if (a.length !== b.length) {
    throw new Error(
      `Buffer length mismatch: ${a.length} vs ${b.length} (width=${width} height=${height})`,
    );
  }
  const diff = new Uint8ClampedArray(a.length);
  let mismatches = 0;
  const totalPixels = width * height;
  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    if (dr > tolerance || dg > tolerance || db > tolerance) {
      mismatches++;
      diff[i] = 255;
      diff[i + 1] = 0;
      diff[i + 2] = 0;
      diff[i + 3] = 255;
    } else {
      // Faded grayscale of source A so visual context remains
      const luma = (a[i] + a[i + 1] + a[i + 2]) / 3;
      const dim = luma * 0.25;
      diff[i] = dim;
      diff[i + 1] = dim;
      diff[i + 2] = dim;
      diff[i + 3] = 255;
    }
  }
  return { diff, ratio: mismatches / totalPixels };
}

/**
 * Capture both canvases via page.evaluate.
 *
 * **Batch 227 capture-method fix.** The previous direct-`drawImage`
 * → `getImageData` path returned an empty / undefined buffer for
 * WebGPU canvases — WebGPU canvases are bound to a swap chain,
 * present clears the texture immediately, and `drawImage(canvas)`
 * after present hits an undefined frame. The result was a 0%-diff
 * "PASS" comparing two identically-empty buffers (one rendered as
 * black, the other as white depending on alpha handling).
 *
 * Fix: route through `canvas.toDataURL()` first. Per the comment
 * in `bug-11-imagery-probe.mjs`, `toDataURL` forces the GPU to
 * flush + readback the canvas content synchronously, returning
 * actual rendered pixels. We then decode the data URL via an
 * Image element + 2D context to recover raw RGBA. Same diff path
 * after that.
 */
/**
 * Decode PNG bytes (browser-encoded) into raw RGBA via the page's
 * own canvas decoder. Avoids pulling in a Node-side PNG dep.
 */
async function decodePngInPage(page, pngBuffer) {
  const base64 = Buffer.from(pngBuffer).toString("base64");
  return await page.evaluate(async (b64) => {
    const blob = await (
      await fetch(`data:image/png;base64,${b64}`)
    ).blob();
    const bitmap = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, data: Array.from(data) };
  }, base64);
}

/**
 * Capture both canvases.
 *
 * **Batch 227b** — Use Playwright's element-level `screenshot()` to
 * capture each canvas. Element screenshots come from the browser's
 * compositor (post-present pixels) so they handle WebGPU swap chains
 * correctly. The two prior approaches both produced empty / wrong
 * captures:
 *   - direct `drawImage(canvas)` + `getImageData` → undefined for
 *     WebGPU swap chains.
 *   - `canvas.toDataURL` + `Image` decode → got a solid-color
 *     fallback state, possibly because the browser was using a
 *     reduced-fidelity readback path.
 *
 * Element screenshots return PNG bytes; we then decode those PNGs
 * back into raw RGBA via the same page's `createImageBitmap` so the
 * diff function can compare pixel buffers directly.
 */
/**
 * Capture both canvases via Playwright element screenshots.
 *
 * **The big fix (Batch 227c).** All previous capture attempts read
 * `canvas.toDataURL()` — which returns black on Cesium's canvases
 * because both the WebGL context (`preserveDrawingBuffer: false`,
 * the perf-tuned default) and the WebGPU swap chain invalidate
 * their backing store after present. The page IS rendering
 * correctly (verified with `page.screenshot()` of the full
 * `Apps/CesiumViewer/index.html` — visible globe + imagery), but
 * any code that reads pixels via `toDataURL` / `getImageData`
 * sees an empty post-present surface.
 *
 * Playwright's `locator.screenshot()` reads from the browser's
 * compositor, which reflects what the user actually sees on
 * screen (post-blit, post-composite). It returns PNG bytes; we
 * decode those back to raw RGBA in the page using
 * `createImageBitmap` so the diff comparator works byte-for-byte.
 */
async function captureCanvases(page) {
  // Tag both canvases so the locator can find them deterministically
  // even if the page has other canvases (FPS overlay etc.).
  await page.evaluate(() => {
    const wgl = window.webglViewer?.scene?.canvas;
    const wgpu = window.webgpuViewer?.scene?.canvas;
    if (!wgl || !wgpu) {
      throw new Error("split-screen viewers not exposed on window");
    }
    wgl.setAttribute("data-vr-tag", "webgl");
    wgpu.setAttribute("data-vr-tag", "webgpu");
  });
  const webglPng = await page
    .locator('canvas[data-vr-tag="webgl"]')
    .screenshot({ type: "png" });
  const webgpuPng = await page
    .locator('canvas[data-vr-tag="webgpu"]')
    .screenshot({ type: "png" });
  // Decode both PNGs back to raw RGBA via the page's
  // createImageBitmap. The decode is independent of the
  // canvas-capture path (it just decodes a PNG byte buffer).
  const [webgl, webgpu] = await Promise.all([
    decodePngInPage(page, webglPng),
    decodePngInPage(page, webgpuPng),
  ]);
  return { webgl, webgpu };
}

/**
 * Encode a raw RGBA buffer to a minimal uncompressed PNG. We avoid pulling
 * in a dependency by hand-rolling deflate-stored chunks. The output is
 * larger than zlib-compressed PNGs but valid and viewable.
 */
function encodePNG(rgba, width, height) {
  // CRC32 table
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function adler32(buf) {
    let a = 1,
      b = 0;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }
  function chunk(type, data) {
    const len = data.length;
    const out = new Uint8Array(8 + len + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(data, 8);
    const crcInput = new Uint8Array(4 + len);
    crcInput.set(out.subarray(4, 8 + len));
    dv.setUint32(8 + len, crc32(crcInput));
    return out;
  }

  // IHDR
  const ihdr = new Uint8Array(13);
  const ihdrDv = new DataView(ihdr.buffer);
  ihdrDv.setUint32(0, width);
  ihdrDv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw scanlines with filter byte 0
  const rowSize = width * 4 + 1;
  const raw = new Uint8Array(rowSize * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * rowSize + 1);
  }

  // Wrap raw in zlib stored blocks (no compression)
  const blocks = [];
  const MAX = 65535;
  for (let i = 0; i < raw.length; i += MAX) {
    const len = Math.min(MAX, raw.length - i);
    const last = i + len === raw.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = last;
    header[1] = len & 0xff;
    header[2] = (len >>> 8) & 0xff;
    header[3] = ~len & 0xff;
    header[4] = (~len >>> 8) & 0xff;
    blocks.push(header, raw.subarray(i, i + len));
  }
  const totalBlocks = blocks.reduce((s, b) => s + b.length, 0);
  const idatPayload = new Uint8Array(2 + totalBlocks + 4);
  idatPayload[0] = 0x78;
  idatPayload[1] = 0x01;
  let off = 2;
  for (const b of blocks) {
    idatPayload.set(b, off);
    off += b.length;
  }
  const adler = adler32(raw);
  const dv = new DataView(idatPayload.buffer);
  dv.setUint32(idatPayload.length - 4, adler);

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = chunk("IHDR", ihdr);
  const idatChunk = chunk("IDAT", idatPayload);
  const iendChunk = chunk("IEND", new Uint8Array(0));
  const total = new Uint8Array(
    sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  total.set(sig, 0);
  total.set(ihdrChunk, sig.length);
  total.set(idatChunk, sig.length + ihdrChunk.length);
  total.set(iendChunk, sig.length + ihdrChunk.length + idatChunk.length);
  return total;
}

async function writeRGBAPng(filePath, capture) {
  const rgba = new Uint8ClampedArray(capture.data);
  const png = encodePNG(rgba, capture.width, capture.height);
  await fs.writeFile(filePath, png);
}

async function applyScene(page, scene, settleFrames) {
  // Batch 224 — optional setup script that runs in the page context
  // before the camera is positioned. Used for synthetic high-density
  // scenes that procedurally generate test geometry. The script
  // receives `webglViewer` + `webgpuViewer` via `window.*` and any
  // params via the second arg.
  //
  // Batch 225 cosmetic — `setupFile` (path relative to scenes.json)
  // is preferred over the inline `setup` string for any non-trivial
  // generator. The file is read at runtime and treated as if it
  // were inline in `setup`. Inline `setup` still works for one-line
  // helpers.
  let setupSrc = null;
  if (typeof scene.setupFile === "string") {
    const filePath = path.resolve(
      path.dirname(SCENES_PATH),
      scene.setupFile,
    );
    setupSrc = await fs.readFile(filePath, "utf8");
  } else if (typeof scene.setup === "string") {
    setupSrc = scene.setup;
  }
  if (setupSrc !== null) {
    await page.evaluate(
      ({ src, params }) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function("params", src);
        return fn(params);
      },
      { src: setupSrc, params: scene.setupParams ?? {} },
    );
  }
  if (scene.camera) {
    await page.evaluate((cam) => {
      function setCam(viewer) {
        if (!viewer) return;
        viewer.camera.setView({
          destination: window.Cesium.Cartesian3.fromDegrees(...cam.destination),
          orientation: cam.orientation,
        });
      }
      setCam(window.webglViewer);
      setCam(window.webgpuViewer);
    }, scene.camera);
  }
  // Sync-1144 hardening: a camera move invalidates the loaded tile
  // set, and the fixed rAF settle below undershoots when tiles (or a
  // cold WebGPU pipeline cache) are slow. Wait for both quadtrees to
  // report tilesLoaded again — bounded, and non-fatal for synthetic
  // scenes that never flip the flag (they fall through to the settle).
  try {
    await page.waitForFunction(
      () => {
        function tilesDone(viewer) {
          const globe = viewer?.scene?.globe;
          return !globe || globe.tilesLoaded === true;
        }
        return (
          tilesDone(window.webglViewer) && tilesDone(window.webgpuViewer)
        );
      },
      null,
      { timeout: 90_000 },
    );
  } catch {
    console.warn(
      "[visual-regression] tilesLoaded wait timed out — capturing anyway",
    );
  }
  // Let the renderers settle (terrain LOD swap, imagery loads, atmosphere LUT…)
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let count = 0;
        function tick() {
          if (count++ >= n) resolve();
          else requestAnimationFrame(tick);
        }
        tick();
      }),
    settleFrames,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = JSON.parse(await fs.readFile(SCENES_PATH, "utf8"));
  const scenes = args.scene
    ? cfg.scenes.filter((s) => s.name === args.scene)
    : cfg.scenes;
  if (scenes.length === 0) {
    console.error(`No scene matched --scene ${args.scene}`);
    process.exit(2);
  }

  await ensureDir(BASELINE_DIR);
  await ensureDir(OUTPUT_DIR);

  const playwright = await loadPlaywright();
  const browserType =
    args.browser === "firefox"
      ? playwright.firefox
      : args.browser === "webkit"
        ? playwright.webkit
        : playwright.chromium;

  const browser = await browserType.launch({
    headless: args.headless,
    channel: args.browser === "msedge" ? "msedge" : undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 800 },
  });
  const page = await context.newPage();

  // WebGPU error/crash gate — this runner previously captured NO console
  // errors, so a backend that emitted validation errors / lost its device
  // still "passed" as long as the pixel diff stayed under threshold. The gate
  // turns those faults into a run failure (FORK-34 class).
  const gateConsoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  console.log(`[visual-regression] navigating ${cfg.baseUrl}`);
  await page.goto(cfg.baseUrl, { waitUntil: "networkidle" });
  // The split-screen page gates viewer creation behind a "Launch
  // Both" button so users can choose when to spin up two WebGPU
  // adapters. For automation we click it programmatically.
  await page.waitForSelector("#btnLaunch", { timeout: 10_000 });
  await page.click("#btnLaunch");
  // Give the WebGPU adapter a beat to come up
  await page.waitForFunction(
    () => !!(window.webglViewer && window.webgpuViewer),
    null,
    { timeout: 60000 },
  );
  // Arm the WebGPU error/crash gate now that both devices exist, so faults
  // during scene rendering below are captured.
  const gateArm = await armWebGPUDevices(page);
  console.log(
    `[visual-regression] webgpu-gate armed=${gateArm.armed} found=${gateArm.found}`,
  );
  // Batch 227b — wait for both globes to actually render at least
  // one non-black frame. Bing imagery + terrain tiles take real
  // wall-clock time to download, and the previous fixed-frame
  // settle (30 rAF ticks ≈ 0.5s) was nowhere near enough.
  //
  // Sync-1144 hardening: the old gate accepted ANY single non-black
  // pixel in the center 32×32 — a lone star in the skybox satisfied
  // it while the WebGPU viewer was still cold-compiling pipelines
  // (slow first launch after a browser/driver update), so captures
  // fired before terrain arrived (stars-only "black globe" false
  // FAIL). Now require globe.tilesLoaded on BOTH viewers AND ≥16
  // non-black center pixels, with a longer timeout for cold starts.
  await page.waitForFunction(
    () => {
      function globeReady(viewer) {
        if (!viewer?.scene?.canvas) return false;
        if (viewer.scene.globe && viewer.scene.globe.tilesLoaded !== true) {
          return false;
        }
        const c = viewer.scene.canvas;
        try {
          const off = new OffscreenCanvas(32, 32);
          const ctx = off.getContext("2d");
          // Sample center 32×32 to keep this cheap.
          ctx.drawImage(
            c,
            (c.width - 32) / 2,
            (c.height - 32) / 2,
            32,
            32,
            0,
            0,
            32,
            32,
          );
          const d = ctx.getImageData(0, 0, 32, 32).data;
          let lit = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] | d[i + 1] | d[i + 2]) lit++;
          }
          // A globe fills the center; a starfield leaves it ~black.
          return lit >= 16;
        } catch {
          return false;
        }
      }
      return (
        globeReady(window.webglViewer) && globeReady(window.webgpuViewer)
      );
    },
    null,
    { timeout: 120_000 },
  );

  const report = { startedAt: new Date().toISOString(), threshold: args.threshold, scenes: [] };
  let anyFail = false;
  for (const scene of scenes) {
    console.log(`[visual-regression] scene: ${scene.name}`);
    await applyScene(page, scene, cfg.settleFrames);
    const cap = await captureCanvases(page);

    const webglPath = path.join(OUTPUT_DIR, `${scene.name}.webgl.png`);
    const webgpuPath = path.join(OUTPUT_DIR, `${scene.name}.webgpu.png`);
    const diffPath = path.join(OUTPUT_DIR, `${scene.name}.diff.png`);
    await writeRGBAPng(webglPath, cap.webgl);
    await writeRGBAPng(webgpuPath, cap.webgpu);

    const a = new Uint8ClampedArray(cap.webgl.data);
    const b = new Uint8ClampedArray(cap.webgpu.data);
    const { diff, ratio } = diffPixelBuffers(
      a,
      b,
      cap.webgl.width,
      cap.webgl.height,
    );
    const diffPng = encodePNG(diff, cap.webgl.width, cap.webgl.height);
    await fs.writeFile(diffPath, diffPng);

    if (args.update) {
      await fs.copyFile(
        webglPath,
        path.join(BASELINE_DIR, `${scene.name}.webgl.png`),
      );
      await fs.copyFile(
        webgpuPath,
        path.join(BASELINE_DIR, `${scene.name}.webgpu.png`),
      );
    }

    const status = ratio <= args.threshold ? "PASS" : "FAIL";
    if (status === "FAIL") anyFail = true;
    console.log(
      `  ${status} diff=${(ratio * 100).toFixed(2)}%  threshold=${(args.threshold * 100).toFixed(2)}%`,
    );
    report.scenes.push({ name: scene.name, ratio, status });
  }

  // WebGPU error/crash gate verdict. Let async GPU errors / device-lost
  // rejections flush, then fold uncaptured GPU errors + device-loss +
  // WebGPU-fault console prints into the run result. Any fault FAILS the run
  // regardless of the pixel diff — a backend that renders the right pixels
  // while spewing validation errors is not actually healthy.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);
  const gateFaults = [
    ...gate.errors,
    ...(gate.deviceLost ? [gate.deviceLost] : []),
    ...gateConsoleErrors,
  ];
  report.webgpuGate = {
    armedDevices: gate.armedDevices,
    uncapturedErrors: gate.errors,
    deviceLost: gate.deviceLost,
    faultConsole: gateConsoleErrors,
  };
  if (gateFaults.length > 0) {
    anyFail = true;
    console.log(`\n[visual-regression] WebGPU gate FAILED — ${gateFaults.length} fault(s):`);
    for (const f of gateFaults.slice(0, 30)) console.log(`  · ${f}`);
  } else {
    console.log(
      `[visual-regression] WebGPU gate clean (armedDevices=${gate.armedDevices})`,
    );
  }

  await fs.writeFile(
    path.join(OUTPUT_DIR, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
