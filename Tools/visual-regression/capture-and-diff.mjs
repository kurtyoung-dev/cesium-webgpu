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
 * Capture both canvases via page.evaluate. The split-screen page exposes
 * `window.webglViewer` and `window.webgpuViewer`; we read each viewer's
 * canvas raw pixels via a 2D context. We return raw RGBA + dimensions so
 * the diff is independent of PNG encoding noise.
 */
async function captureCanvases(page) {
  return await page.evaluate(() => {
    function readCanvas(canvas) {
      // Use OffscreenCanvas 2D — the cesium canvas is webgl/webgpu, so we
      // need to copy via drawImage onto a CPU 2D context to read pixels.
      const w = canvas.width;
      const h = canvas.height;
      const off = new OffscreenCanvas(w, h);
      const ctx = off.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      return { width: w, height: h, data: Array.from(data) };
    }
    const wgl = window.webglViewer?.scene?.canvas;
    const wgpu = window.webgpuViewer?.scene?.canvas;
    if (!wgl || !wgpu) {
      throw new Error("split-screen viewers not exposed on window");
    }
    return { webgl: readCanvas(wgl), webgpu: readCanvas(wgpu) };
  });
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
  if (typeof scene.setup === "string") {
    await page.evaluate(
      ({ src, params }) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function("params", src);
        return fn(params);
      },
      { src: scene.setup, params: scene.setupParams ?? {} },
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

  console.log(`[visual-regression] navigating ${cfg.baseUrl}`);
  await page.goto(cfg.baseUrl, { waitUntil: "networkidle" });
  // Give the WebGPU adapter a beat to come up
  await page.waitForFunction(
    () => !!(window.webglViewer && window.webgpuViewer),
    null,
    { timeout: 30000 },
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
