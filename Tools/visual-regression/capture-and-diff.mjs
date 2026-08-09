#!/usr/bin/env node
/**
 * Historical WebGL + historical WebGPU + current parity regression runner
 *
 * Drives Playwright through the split-screen comparison page, applies each
 * scene from `scenes.json`, captures the WebGL canvas + WebGPU canvas, and
 * evaluates three independent visual gates:
 *   1. current WebGL against its reviewed historical WebGL baseline;
 *   2. current WebGPU against its reviewed historical WebGPU baseline;
 *   3. current WebGL against current WebGPU.
 *
 * Usage:
 *   node Tools/visual-regression/capture-and-diff.mjs            # run all scenes
 *   node Tools/visual-regression/capture-and-diff.mjs --update \
 *     --confirm-baseline-promotion \
 *     --update-rationale "reviewed change" --reviewed-by "name"
 *   node Tools/visual-regression/capture-and-diff.mjs --scene globe-default
 *
 * Output layout:
 *   Tools/visual-regression/baseline/<scene>.webgl.png
 *   Tools/visual-regression/baseline/<scene>.webgpu.png
 *   Tools/visual-regression/output/<scene>.webgl.png
 *   Tools/visual-regression/output/<scene>.webgpu.png
 *   Tools/visual-regression/output/<scene>.diff.png   (red = mismatch)
 *   Tools/visual-regression/output/<scene>.webgl-vs-historical.diff.png
 *   Tools/visual-regression/output/<scene>.webgpu-vs-historical.diff.png
 *   Tools/visual-regression/output/report.json        (per-gate outcomes)
 *
 * Requirements:
 *   - Playwright installed (already a dev tool via the MCP plugin marketplace).
 *     If not present, this script will print an install hint and exit non-zero.
 *   - The dev server (`npm run restart`) must be serving on the URL declared
 *     in scenes.json before running this script.
 *
 * Threshold:
 *   The exit code is 0 only when all three visual gates certify every scene
 *   and the WebGPU error gate is clean. Missing, stale, or unreviewed baseline
 *   provenance is NON_CERTIFYING and exits 1 rather than silently passing.
 */

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import {
  ExpectationOutcome,
  GateStatus,
  annotateGateExpectation,
  createSceneIdentity,
  evaluatePixelGate,
  resolveSceneExpectations,
  resolveSceneThresholds,
  sha256,
  summarizeExpectations,
  summarizeSceneGates,
  validateManifestEntry,
  validatePromotionRequest,
} from "./lib/visual-gate-policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENES_PATH = path.join(__dirname, "scenes.json");
const BASELINE_DIR = path.join(__dirname, "baseline");
const BASELINE_MANIFEST_PATH = path.join(BASELINE_DIR, "manifest.json");
const OUTPUT_DIR = path.join(__dirname, "output");
const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const VIEWPORT = Object.freeze({ width: 1600, height: 800 });

function parseArgs(argv) {
  const args = {
    update: false,
    scene: null,
    threshold: 0.02,
    headless: true,
    browser: "msedge",
    confirmBaselinePromotion: false,
    updateRationale: null,
    reviewedBy: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update") args.update = true;
    else if (a === "--headed") args.headless = false;
    else if (a === "--scene") args.scene = argv[++i];
    else if (a === "--threshold") args.threshold = Number(argv[++i]);
    else if (a === "--browser") args.browser = argv[++i];
    else if (a === "--confirm-baseline-promotion") {
      args.confirmBaselinePromotion = true;
    } else if (a === "--update-rationale") {
      args.updateRationale = argv[++i];
    } else if (a === "--reviewed-by") {
      args.reviewedBy = argv[++i];
    }
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

function reportPath(filePath) {
  return path.relative(__dirname, filePath).replaceAll("\\", "/");
}

function manifestEntryKey(sceneName, renderer) {
  return `${sceneName}:${renderer}`;
}

/** Console suffix for a gate's pre-registered expectation. Formatting only. */
function describeExpectation(expectation) {
  if (!expectation) return "";
  const tracker = expectation.trackedBy
    ? ` tracked=${expectation.trackedBy}`
    : "";
  if (expectation.outcome === ExpectationOutcome.FIRST_RECORD) {
    return ` expected=UNMEASURED (first recorded value)${tracker}`;
  }
  if (expectation.outcome === ExpectationOutcome.UNMET) {
    return ` expected=${expectation.expect} UNMET${tracker}`;
  }
  return ` expected=${expectation.expect} met${tracker}`;
}

function getGitMetadata() {
  try {
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }).trim();
    const sourceDirty =
      execFileSync("git", ["status", "--porcelain"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
      }).trim().length > 0;
    return { sourceCommit, sourceDirty };
  } catch (error) {
    throw new Error(`Unable to capture Git provenance: ${error.message}`, {
      cause: error,
    });
  }
}

async function loadBaselineManifest() {
  try {
    const manifest = JSON.parse(
      await fs.readFile(BASELINE_MANIFEST_PATH, "utf8"),
    );
    if (
      manifest.schemaVersion !== 1 ||
      typeof manifest.entries !== "object" ||
      manifest.entries === null ||
      Array.isArray(manifest.entries)
    ) {
      throw new Error("expected schemaVersion=1 with an entries object");
    }
    return { manifest, error: null };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        manifest: { schemaVersion: 1, entries: {} },
        error: "BASELINE_MANIFEST_MISSING",
      };
    }
    return {
      manifest: { schemaVersion: 1, entries: {} },
      error: `BASELINE_MANIFEST_INVALID:${error.message}`,
    };
  }
}

function normalizeHardwareClass(parts) {
  const populated = parts
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim().toLowerCase().replaceAll(/\s+/g, "-"));
  return populated.length > 0 ? populated.join(":") : "unknown";
}

async function collectRunEnvironment(browser, page, browserClass) {
  const adapter = await page.evaluate(() => {
    const context = window.webgpuViewer?.scene?.context;
    const gpuAdapter = context?.adapter ?? context?._adapter;
    const info = gpuAdapter?.info;
    return {
      vendor: info?.vendor ?? null,
      architecture: info?.architecture ?? null,
      device: info?.device ?? null,
      description: info?.description ?? null,
    };
  });
  return {
    browserClass,
    browserVersion: browser.version(),
    adapterClass: normalizeHardwareClass([
      adapter.vendor,
      adapter.architecture,
      adapter.device,
      adapter.description,
    ]),
    adapter,
    platform: process.platform,
    nodeVersion: process.version,
    viewport: VIEWPORT,
  };
}

async function loadHistoricalCapture(page, filePath) {
  try {
    const png = await fs.readFile(filePath);
    return {
      capture: await decodePngInPage(page, png),
      imageSha256: sha256(png),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function getManifestValidation(manifestState, key, actual) {
  if (manifestState.error) {
    return { certifying: false, reasons: [manifestState.error] };
  }
  return validateManifestEntry(manifestState.manifest.entries[key], actual);
}

async function writeDiffArtifact(filePath, diff, width, height) {
  if (!diff) {
    await fs.rm(filePath, { force: true });
    return null;
  }
  await fs.writeFile(filePath, encodePNG(diff, width, height));
  return reportPath(filePath);
}

async function atomicCopy(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.copyFile(source, temporary);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function writeManifestAtomically(manifest) {
  const temporary = `${BASELINE_MANIFEST_PATH}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    await fs.rename(temporary, BASELINE_MANIFEST_PATH);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function promoteBaselineCandidates({
  candidates,
  manifestState,
  environment,
  git,
  args,
}) {
  if (environment.adapterClass === "unknown") {
    throw new Error("Cannot promote without a resolved WebGPU adapter class");
  }

  const now = new Date().toISOString();
  const entries = { ...manifestState.manifest.entries };
  for (const candidate of candidates) {
    const imageName = path.basename(candidate.baselinePath);
    await atomicCopy(candidate.outputPath, candidate.baselinePath);
    const imageBytes = await fs.readFile(candidate.baselinePath);
    entries[manifestEntryKey(candidate.scene.name, candidate.renderer)] = {
      scene: candidate.scene.name,
      renderer: candidate.renderer,
      provenanceClass: "accepted-current",
      image: imageName,
      imageSha256: sha256(imageBytes),
      width: candidate.capture.width,
      height: candidate.capture.height,
      sourceCommit: git.sourceCommit,
      sourceDirty: git.sourceDirty,
      sceneIdentity: candidate.sceneIdentity,
      browserClass: environment.browserClass,
      browserVersion: environment.browserVersion,
      adapterClass: environment.adapterClass,
      capturedAt: now,
      review: {
        status: "approved",
        reviewedBy: args.reviewedBy.trim(),
        rationale: args.updateRationale.trim(),
        reviewedAt: now,
      },
    };
  }

  await writeManifestAtomically({
    $schema: "../baseline-manifest.schema.json",
    schemaVersion: 1,
    updatedAt: now,
    entries,
  });
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
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return {
      width: bitmap.width,
      height: bitmap.height,
      data: Array.from(data),
    };
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
    const filePath = path.resolve(path.dirname(SCENES_PATH), scene.setupFile);
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
        return tilesDone(window.webglViewer) && tilesDone(window.webgpuViewer);
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
  const promotionRequest = validatePromotionRequest(args);
  if (!Number.isFinite(args.threshold) || args.threshold < 0) {
    console.error("--threshold must be a non-negative number");
    process.exit(2);
  }
  if (promotionRequest.errors.length > 0) {
    console.error(
      `[visual-regression] baseline promotion denied:\n${promotionRequest.errors
        .map((error) => `  - ${error}`)
        .join("\n")}`,
    );
    process.exit(2);
  }

  const cfg = JSON.parse(await fs.readFile(SCENES_PATH, "utf8"));
  const scenes = args.scene
    ? cfg.scenes.filter((s) => s.name === args.scene)
    : cfg.scenes;
  if (scenes.length === 0) {
    console.error(`No scene matched --scene ${args.scene}`);
    process.exit(2);
  }

  // Validate every pre-registered expectation BEFORE launching a browser. A
  // malformed declaration — an unknown gate, a predicted FAIL with no tracker
  // ID behind it — is an argument-class error, and finding it after a
  // multi-minute capture run would just make it easier to ignore.
  const sceneExpectations = new Map();
  const expectationErrors = [];
  for (const scene of scenes) {
    const resolved = resolveSceneExpectations(scene);
    sceneExpectations.set(scene.name, resolved.byGate);
    expectationErrors.push(...resolved.errors);
  }
  if (expectationErrors.length > 0) {
    console.error(
      `[visual-regression] invalid expectedMismatch declarations:\n${expectationErrors
        .map((error) => `  - ${error}`)
        .join("\n")}`,
    );
    process.exit(2);
  }

  await ensureDir(BASELINE_DIR);
  await ensureDir(OUTPUT_DIR);
  const baselineManifest = await loadBaselineManifest();
  const git = getGitMetadata();
  if (promotionRequest.requested && git.sourceDirty) {
    console.error(
      "[visual-regression] baseline promotion denied: candidate Git worktree is dirty",
    );
    process.exit(2);
  }

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
    viewport: VIEWPORT,
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
      return globeReady(window.webglViewer) && globeReady(window.webgpuViewer);
    },
    null,
    { timeout: 120_000 },
  );

  const environment = await collectRunEnvironment(browser, page, args.browser);
  const report = {
    // 3 — additive only: each gate gained an `expectation` field (null when
    // the scene declares none) and the run gained `expectations` plus
    // `summary.expectationCounts`. A version that does not move when the
    // schema does is worse than no version at all.
    schemaVersion: 3,
    startedAt: new Date().toISOString(),
    threshold: args.threshold,
    thresholdRole: "migration-fallback",
    candidate: git,
    environment,
    baselineManifest: {
      path: reportPath(BASELINE_MANIFEST_PATH),
      schemaVersion: baselineManifest.manifest.schemaVersion,
      valid: baselineManifest.error === null,
      error: baselineManifest.error,
    },
    promotion: {
      requested: promotionRequest.requested,
      authorized: promotionRequest.authorized,
      performed: false,
      rationale: args.updateRationale,
      reviewedBy: args.reviewedBy,
      requiresFollowupVerification: promotionRequest.requested,
    },
    scenes: [],
  };
  const promotionCandidates = [];
  for (const scene of scenes) {
    console.log(`[visual-regression] scene: ${scene.name}`);
    await applyScene(page, scene, cfg.settleFrames);
    const cap = await captureCanvases(page);

    const webglPath = path.join(OUTPUT_DIR, `${scene.name}.webgl.png`);
    const webgpuPath = path.join(OUTPUT_DIR, `${scene.name}.webgpu.png`);
    const crossDiffPath = path.join(OUTPUT_DIR, `${scene.name}.diff.png`);
    const historicalWebglDiffPath = path.join(
      OUTPUT_DIR,
      `${scene.name}.webgl-vs-historical.diff.png`,
    );
    const historicalWebgpuDiffPath = path.join(
      OUTPUT_DIR,
      `${scene.name}.webgpu-vs-historical.diff.png`,
    );
    const baselineWebglPath = path.join(
      BASELINE_DIR,
      `${scene.name}.webgl.png`,
    );
    const baselineWebgpuPath = path.join(
      BASELINE_DIR,
      `${scene.name}.webgpu.png`,
    );
    await writeRGBAPng(webglPath, cap.webgl);
    await writeRGBAPng(webgpuPath, cap.webgpu);

    const [historicalWebgl, historicalWebgpu] = await Promise.all([
      loadHistoricalCapture(page, baselineWebglPath),
      loadHistoricalCapture(page, baselineWebgpuPath),
    ]);
    const thresholds = resolveSceneThresholds(scene, args.threshold);
    const sceneIdentity = createSceneIdentity(scene, {
      baseUrl: cfg.baseUrl,
      settleFrames: cfg.settleFrames,
      viewport: VIEWPORT,
    });

    const historicalWebglValidation = historicalWebgl
      ? getManifestValidation(
          baselineManifest,
          manifestEntryKey(scene.name, "webgl"),
          {
            scene: scene.name,
            image: path.basename(baselineWebglPath),
            imageSha256: historicalWebgl.imageSha256,
            renderer: "webgl",
            width: historicalWebgl.capture.width,
            height: historicalWebgl.capture.height,
            sceneIdentity,
            browserClass: environment.browserClass,
            adapterClass: environment.adapterClass,
          },
        )
      : { certifying: false, reasons: ["HISTORICAL_BASELINE_MISSING"] };
    const historicalWebgpuValidation = historicalWebgpu
      ? getManifestValidation(
          baselineManifest,
          manifestEntryKey(scene.name, "webgpu"),
          {
            scene: scene.name,
            image: path.basename(baselineWebgpuPath),
            imageSha256: historicalWebgpu.imageSha256,
            renderer: "webgpu",
            width: historicalWebgpu.capture.width,
            height: historicalWebgpu.capture.height,
            sceneIdentity,
            browserClass: environment.browserClass,
            adapterClass: environment.adapterClass,
          },
        )
      : { certifying: false, reasons: ["HISTORICAL_BASELINE_MISSING"] };

    const historicalWebglResult = evaluatePixelGate({
      id: "historicalWebgl",
      current: cap.webgl,
      reference: historicalWebgl?.capture ?? null,
      threshold: thresholds.historicalWebgl,
      manifestValidation: historicalWebglValidation,
    });
    const historicalWebgpuResult = evaluatePixelGate({
      id: "historicalWebgpu",
      current: cap.webgpu,
      reference: historicalWebgpu?.capture ?? null,
      threshold: thresholds.historicalWebgpu,
      manifestValidation: historicalWebgpuValidation,
    });
    const crossBackendResult = evaluatePixelGate({
      id: "crossBackend",
      current: cap.webgl,
      reference: cap.webgpu,
      threshold: thresholds.crossBackend,
    });

    const historicalWebglDiff = await writeDiffArtifact(
      historicalWebglDiffPath,
      historicalWebglResult.diff,
      cap.webgl.width,
      cap.webgl.height,
    );
    const historicalWebgpuDiff = await writeDiffArtifact(
      historicalWebgpuDiffPath,
      historicalWebgpuResult.diff,
      cap.webgpu.width,
      cap.webgpu.height,
    );
    const crossDiff = await writeDiffArtifact(
      crossDiffPath,
      crossBackendResult.diff,
      cap.webgl.width,
      cap.webgl.height,
    );

    const expectations = sceneExpectations.get(scene.name) ?? {};
    const gates = {
      historicalWebgl: annotateGateExpectation(
        {
          ...historicalWebglResult.gate,
          artifacts: {
            current: reportPath(webglPath),
            historical: historicalWebgl ? reportPath(baselineWebglPath) : null,
            expectedHistorical: reportPath(baselineWebglPath),
            diff: historicalWebglDiff,
          },
        },
        expectations.historicalWebgl,
      ),
      historicalWebgpu: annotateGateExpectation(
        {
          ...historicalWebgpuResult.gate,
          artifacts: {
            current: reportPath(webgpuPath),
            historical: historicalWebgpu
              ? reportPath(baselineWebgpuPath)
              : null,
            expectedHistorical: reportPath(baselineWebgpuPath),
            diff: historicalWebgpuDiff,
          },
        },
        expectations.historicalWebgpu,
      ),
      crossBackend: annotateGateExpectation(
        {
          ...crossBackendResult.gate,
          artifacts: {
            webgl: reportPath(webglPath),
            webgpu: reportPath(webgpuPath),
            diff: crossDiff,
          },
        },
        expectations.crossBackend,
      ),
    };
    const summary = summarizeSceneGates(gates);
    for (const gate of Object.values(gates)) {
      const ratioText =
        gate.ratio === null ? "n/a" : `${(gate.ratio * 100).toFixed(2)}%`;
      console.log(
        `  ${gate.id}: ${gate.status} comparison=${gate.comparisonStatus} diff=${ratioText} threshold=${(gate.threshold * 100).toFixed(2)}%${describeExpectation(gate.expectation)}`,
      );
    }
    console.log(`  scene: ${summary.status}`);
    report.scenes.push({
      name: scene.name,
      sceneIdentity,
      thresholds,
      status: summary.status,
      certifying: summary.certifying,
      ratio: gates.crossBackend.ratio,
      crossBackendStatus: gates.crossBackend.status,
      gateCounts: summary.gateCounts,
      gates,
    });

    promotionCandidates.push(
      {
        scene,
        sceneIdentity,
        renderer: "webgl",
        capture: cap.webgl,
        outputPath: webglPath,
        baselinePath: baselineWebglPath,
      },
      {
        scene,
        sceneIdentity,
        renderer: "webgpu",
        capture: cap.webgpu,
        outputPath: webgpuPath,
        baselinePath: baselineWebgpuPath,
      },
    );
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
    id: "webgpuErrorGate",
    status: gateFaults.length > 0 ? GateStatus.FAIL : GateStatus.PASS,
    certifying: gateFaults.length === 0,
    armedDevices: gate.armedDevices,
    uncapturedErrors: gate.errors,
    deviceLost: gate.deviceLost,
    faultConsole: gateConsoleErrors,
  };
  if (gateFaults.length > 0) {
    console.log(
      `\n[visual-regression] WebGPU gate FAILED — ${gateFaults.length} fault(s):`,
    );
    for (const f of gateFaults.slice(0, 30)) console.log(`  · ${f}`);
  } else {
    console.log(
      `[visual-regression] WebGPU gate clean (armedDevices=${gate.armedDevices})`,
    );
  }

  if (promotionRequest.requested) {
    const crossBackendFailures = report.scenes.filter(
      (scene) => scene.gates.crossBackend.status !== GateStatus.PASS,
    );
    const promotionBlockers = [];
    if (gateFaults.length > 0) {
      promotionBlockers.push("WebGPU error gate failed");
    }
    if (crossBackendFailures.length > 0) {
      promotionBlockers.push(
        `cross-backend gate failed for: ${crossBackendFailures
          .map((scene) => scene.name)
          .join(", ")}`,
      );
    }
    if (promotionBlockers.length === 0) {
      await promoteBaselineCandidates({
        candidates: promotionCandidates,
        manifestState: baselineManifest,
        environment,
        git,
        args,
      });
      report.promotion.performed = true;
      console.log(
        "[visual-regression] baselines promoted; run again without --update to certify against the locked manifest",
      );
    } else {
      report.promotion.blockers = promotionBlockers;
      console.log(
        `[visual-regression] baseline promotion blocked: ${promotionBlockers.join("; ")}`,
      );
    }
  }

  const sceneCounts = Object.fromEntries(
    Object.values(GateStatus).map((status) => [
      status,
      report.scenes.filter((scene) => scene.status === status).length,
    ]),
  );
  const runStatus =
    gateFaults.length > 0 || sceneCounts.FAIL > 0
      ? GateStatus.FAIL
      : sceneCounts.NON_CERTIFYING > 0
        ? GateStatus.NON_CERTIFYING
        : GateStatus.PASS;
  // Expectation accounting. This never moves `runStatus` — a scene that is red
  // on purpose is still red, and a suite that could be talked out of a failure
  // by a manifest field would not be a gate. What the block adds is the
  // reviewer's shortcut to the finding: every gate whose observed status
  // contradicts what the scene pre-registered about it.
  const expectations = summarizeExpectations(report.scenes);
  report.expectations = expectations;
  if (expectations.counts.declared > 0) {
    console.log(
      `\n[visual-regression] expectations: ${expectations.counts.MET} met, ` +
        `${expectations.counts.UNMET} unmet, ` +
        `${expectations.counts.FIRST_RECORD} first-record ` +
        `(of ${expectations.counts.declared} declared)`,
    );
    for (const entry of expectations.unmet) {
      console.log(
        `  · ${entry.scene}/${entry.gate}: expected ${entry.expected}, observed ${entry.observed}` +
          `${entry.trackedBy ? ` (tracked=${entry.trackedBy})` : ""}`,
      );
    }
  }

  report.completedAt = new Date().toISOString();
  report.summary = {
    status: runStatus,
    certifying: runStatus === GateStatus.PASS,
    sceneCounts,
    expectationCounts: expectations.counts,
    promotionPerformed: report.promotion.performed,
  };

  await fs.writeFile(
    path.join(OUTPUT_DIR, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await browser.close();
  process.exit(runStatus === GateStatus.PASS ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
