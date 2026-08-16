#!/usr/bin/env node
/**
 * WebGL imagery-reprojection tolerance baseline guard.
 * @purpose Golden-PNG guard: pins the forked WebGL per-fragment Mercator->Geographic reprojection output to a stored baseline (--update, tolerance)
 * @status ACTIVE
 *
 * WHY THIS EXISTS
 * ---------------
 * Batch 66 (see migration_doc/IMAGERY_PROJECTION.md § "Batch 66 — WebGL
 * reproject FS rewritten to per-fragment math") intentionally FORKED the
 * WebGL Web-Mercator→Geographic reprojection from upstream Cesium: the
 * 64-row vertex-grid piecewise approximation was replaced with a 4-vertex
 * quad whose FS computes the exact per-fragment Mercator-Y. That forked our
 * WebGL reprojected-texture pixel output away from stock Cesium — but NO
 * visual-regression baseline captured that output, so an accidental drift in
 * `ReprojectWebMercatorFS.glsl` / `ReprojectWebMercatorVS.glsl` /
 * `ImageLayerHelpers.js` (the 4 quad uniforms) would ship silently. The
 * existing reproject probes (`probe-reprojected-texture-compare.mjs`,
 * `probe-source-mercator-compare.mjs`, `probe-globe-polar-stretch.mjs`) all
 * compare WebGL *against WebGPU* — if BOTH backends' reproject math drifted
 * together they would still pass. This probe closes that gap by pinning the
 * WebGL reproject output to a stored golden PNG with a channel tolerance.
 *
 * WHAT IT DOES
 * ------------
 * 1. Loads the WebGL CesiumViewer at a fixed polar view over WGS84 ellipsoid
 *    terrain (so Mercator base imagery must be reprojected to geographic).
 * 2. Deterministically selects the polar reproject tile (useWebMercatorT ===
 *    false, Mercator provider) with the lexicographically-smallest imagery
 *    key, and reads its full reprojected texture (`imagery.texture`) RGBA via
 *    an FBO readback.
 * 3. `--update`: writes the golden PNG + a metadata JSON (imagery l/x/y,
 *    dimensions, view). Default: decodes the golden, diffs the fresh capture
 *    against it with a per-channel tolerance, reports mismatch %, and exits
 *    non-zero when the mismatch fraction exceeds `--threshold`.
 *
 * This is a pure test-infra add — it touches NO engine source and imposes no
 * runtime cost. The default-off charter is satisfied trivially: nothing runs
 * unless this probe is invoked.
 *
 * Usage:
 *   node Tools/visual-regression/probe-reproject-baseline.mjs --update
 *   node Tools/visual-regression/probe-reproject-baseline.mjs
 *   node Tools/visual-regression/probe-reproject-baseline.mjs --threshold 0.05 --channel-tol 24 --headed
 *
 * Output:
 *   Tools/visual-regression/baseline/reproject-webgl.png   (golden)
 *   Tools/visual-regression/baseline/reproject-webgl.json  (golden metadata)
 *   Tools/visual-regression/output/reproject-webgl.actual.png  (this run)
 *   Tools/visual-regression/output/reproject-webgl.diff.png    (red = drift)
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = path.join(__dirname, "baseline");
const OUTPUT_DIR = path.join(__dirname, "output");
const GOLDEN_PNG = path.join(BASELINE_DIR, "reproject-webgl.png");
const GOLDEN_JSON = path.join(BASELINE_DIR, "reproject-webgl.json");

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
// Fixed polar view: latitude 80° forces geographic-projected polar tiles
// whose Mercator source imagery must be reprojected per-fragment.
const VIEW = { lon: 0, lat: 80, height: 12_000_000 };

function parseArgs(argv) {
  const args = {
    update: false,
    headless: true,
    threshold: 0.05, // fraction of pixels allowed to drift
    channelTol: 24, // per-channel intensity tolerance (absorbs JPEG jitter)
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update") args.update = true;
    else if (a === "--headed") args.headless = false;
    else if (a === "--threshold") args.threshold = Number(argv[++i]);
    else if (a === "--channel-tol") args.channelTol = Number(argv[++i]);
  }
  return args;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Encode a raw RGBA buffer to a minimal uncompressed PNG (zlib stored
 * blocks — larger than compressed but valid + zero-dep). Copied verbatim
 * from capture-and-diff.mjs to keep this probe self-contained.
 */
function encodePNG(rgba, width, height) {
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
  const ihdr = new Uint8Array(13);
  const ihdrDv = new DataView(ihdr.buffer);
  ihdrDv.setUint32(0, width);
  ihdrDv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowSize = width * 4 + 1;
  const raw = new Uint8Array(rowSize * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * rowSize + 1);
  }
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

/** Decode a PNG byte buffer to raw RGBA using the page's createImageBitmap. */
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
 * Load the WebGL viewer at the polar view over WGS84 terrain, pick the
 * deterministic reproject tile, and read its full reprojected texture RGBA.
 */
async function captureReprojectedTexture(headless) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ view }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }

      // Collect ALL polar reproject tiles (useWebMercatorT === false, Mercator
      // provider, has a reprojected texture) and pick deterministically by the
      // lexicographically-smallest imagery key so the golden is reproducible.
      const candidates = [];
      for (const t of v.scene._globe._surface._tilesToRender) {
        for (const skel of t.data?.imagery ?? []) {
          const im = skel?.readyImagery;
          if (!im?.imageryLayer) continue;
          if (skel.useWebMercatorT) continue;
          if (!im.texture || !im.texture._texture) continue;
          const isMercatorProvider = !(
            im.imageryLayer._imageryProvider.tilingScheme.projection instanceof
            C.GeographicProjection
          );
          if (!isMercatorProvider) continue;
          candidates.push(im);
        }
      }
      if (candidates.length === 0) {
        return { error: "no polar reproject tile with readable texture" };
      }
      // Deterministic pick: smallest (level, x, y) tuple. imagery.key is not a
      // stable string here, so tile coords are the reproducible identity.
      candidates.sort((a, b) => a.level - b.level || a.x - b.x || a.y - b.y);
      const im = candidates[0];

      const gl = v.scene.context._gl;
      const tex = im.texture;
      const w = tex.width;
      const h = tex.height;
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        tex._texture,
        0,
      );
      let data = null;
      if (
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
      ) {
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        data = Array.from(buf);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      if (!data) return { error: "FBO readback incomplete" };

      return {
        imagery: {
          id: `${im.level}/${im.x}/${im.y}`,
          level: im.level,
          x: im.x,
          y: im.y,
        },
        candidateCount: candidates.length,
        width: w,
        height: h,
        data,
      };
    },
    { view: VIEW },
  );

  await browser.close();
  return result;
}

/** Per-pixel diff (red = drift). Returns { diff, ratio }. */
function diffBuffers(a, b, width, height, tol) {
  const diff = new Uint8ClampedArray(a.length);
  let mismatches = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    if (dr > tol || dg > tol || db > tol) {
      mismatches++;
      diff[i] = 255;
      diff[i + 1] = 0;
      diff[i + 2] = 0;
      diff[i + 3] = 255;
    } else {
      const luma = (a[i] + a[i + 1] + a[i + 2]) / 3;
      const dim = luma * 0.25;
      diff[i] = dim;
      diff[i + 1] = dim;
      diff[i + 2] = dim;
      diff[i + 3] = 255;
    }
  }
  return { diff, ratio: mismatches / (width * height) };
}

(async () => {
  const args = parseArgs(process.argv);
  await ensureDir(BASELINE_DIR);
  await ensureDir(OUTPUT_DIR);

  console.log("[reproject-baseline] capturing WebGL reprojected texture");
  console.log(`  base=${BASE} view=lat${VIEW.lat} height=${VIEW.height}`);
  const cap = await captureReprojectedTexture(args.headless);
  if (cap.error) {
    console.error(`[reproject-baseline] FAIL: ${cap.error}`);
    process.exit(3);
  }
  console.log(
    `  tile imagery=${cap.imagery.id} size=${cap.width}x${cap.height} candidates=${cap.candidateCount}`,
  );

  const rgba = new Uint8ClampedArray(cap.data);

  if (args.update) {
    await fs.writeFile(GOLDEN_PNG, encodePNG(rgba, cap.width, cap.height));
    await fs.writeFile(
      GOLDEN_JSON,
      JSON.stringify(
        {
          description:
            "WebGL Web-Mercator→Geographic reproject tolerance baseline " +
            "(Batch 66 forked FS). Guards ReprojectWebMercatorFS/VS.glsl + " +
            "ImageLayerHelpers.js quad uniforms against accidental drift.",
          imagery: cap.imagery,
          width: cap.width,
          height: cap.height,
          view: VIEW,
          channelTol: args.channelTol,
          threshold: args.threshold,
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`[reproject-baseline] wrote golden → ${GOLDEN_PNG}`);
    console.log(`[reproject-baseline] wrote metadata → ${GOLDEN_JSON}`);
    process.exit(0);
  }

  // Compare mode.
  let goldenMeta;
  let goldenPngBuf;
  try {
    goldenMeta = JSON.parse(await fs.readFile(GOLDEN_JSON, "utf8"));
    goldenPngBuf = await fs.readFile(GOLDEN_PNG);
  } catch {
    console.error(
      "[reproject-baseline] no golden baseline found. Run once with --update first.",
    );
    process.exit(4);
  }

  if (
    goldenMeta.width !== cap.width ||
    goldenMeta.height !== cap.height ||
    goldenMeta.imagery.id !== cap.imagery.id
  ) {
    console.error(
      "[reproject-baseline] FAIL: capture identity diverged from golden.\n" +
        `  golden: tile=${goldenMeta.imagery.id} ${goldenMeta.width}x${goldenMeta.height}\n` +
        `  actual: tile=${cap.imagery.id} ${cap.width}x${cap.height}\n` +
        "  (imagery tiling changed, or scene setup drifted — re-baseline with --update if intended.)",
    );
    process.exit(5);
  }

  // Decode the golden PNG back to RGBA using a headless page.
  const browser = await chromium.launch({
    channel: "msedge",
    headless: args.headless,
  });
  const page = await browser.newPage();
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
    waitUntil: "domcontentloaded",
  });
  const golden = await decodePngInPage(page, goldenPngBuf);
  await browser.close();

  const goldenRgba = new Uint8ClampedArray(golden.data);
  const { diff, ratio } = diffBuffers(
    goldenRgba,
    rgba,
    cap.width,
    cap.height,
    args.channelTol,
  );

  const actualPath = path.join(OUTPUT_DIR, "reproject-webgl.actual.png");
  const diffPath = path.join(OUTPUT_DIR, "reproject-webgl.diff.png");
  await fs.writeFile(actualPath, encodePNG(rgba, cap.width, cap.height));
  await fs.writeFile(diffPath, encodePNG(diff, cap.width, cap.height));

  const pct = (ratio * 100).toFixed(3);
  const threshold = args.threshold;
  console.log(
    `[reproject-baseline] mismatch=${pct}% (channelTol=${args.channelTol}) ` +
      `threshold=${(threshold * 100).toFixed(1)}%`,
  );
  console.log(`  actual → ${actualPath}`);
  console.log(`  diff   → ${diffPath}`);

  if (ratio > threshold) {
    console.error(
      `[reproject-baseline] FAIL: WebGL reproject output drifted ${pct}% (> ${(threshold * 100).toFixed(1)}%). ` +
        "Inspect the diff PNG; if the change is intentional re-baseline with --update.",
    );
    process.exit(1);
  }
  console.log(
    "[reproject-baseline] PASS: WebGL reproject output within tolerance.",
  );
  process.exit(0);
})();
