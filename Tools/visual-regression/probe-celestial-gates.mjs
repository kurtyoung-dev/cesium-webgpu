#!/usr/bin/env node
// probe-celestial-gates.mjs — Campaign 12 celestial gate harness (C12-01 + C12-02).
//
// WHAT THIS IS
// ------------
// The measured, never-eyeballed gate probe for the celestial appearance work.
// It captures the star field on BOTH backends (WebGL + WebGPU) under the exact
// framing each gate needs and evaluates the second-order metrics from
// Tools/visual-regression/lib/celestial-metrics.mjs (the node --test trust
// anchor). Mean luminance is reported but is EXPLICITLY non-certifying — a
// normalized-kernel convolution (mip/bilinear/MSAA/JPEG) moves the mean by
// zero, so a mean diff cannot see any of these gates.
//
// GATE G1 (default run) — skybox fade regression gate.
//   Camera on the SUNLIT side with the Sun >= 25 deg above the camera's local
//   horizon (the only framing that reaches the C11-176 failure state); globe /
//   sun / moon / skyAtmosphere / fog OFF; >= 30 settle renders. Captured three
//   ways per M6 source-split (see below). PASS requires, on the default pair:
//     M1 point-source count ratio (WebGPU/WebGL) >= 0.90
//     M2a RMS-contrast ratio in [0.85, 1.15]
//     M2b (P99.9 - P50) ratio in [0.85, 1.15]
//     M3 median chroma >= 0.85 x WebGL
//   and, on EACH M6 mode, the M1 count ratio >= 0.90 (so a cubemap-only or
//   sprites-only regression cannot be masked by the other source).
//
// M6 SOURCE-SPLIT — the true isolation toggles (determined from SkyBox.js +
// Scene.updateEnvironment, NOT guessed):
//   * `skyBox.show`      delegates to the CubeMapPanorama's show only
//     (SkyBox.js get/set show -> _panorama.show). It gates the CUBEMAP command.
//   * `skyBox.starField.show` gates the SPRITE catalogue. StarField.update
//     (StarField.js:142-149) early-returns solely on its own `.show`; the
//     starfield is driven independently in Scene.updateEnvironment
//     (Scene.js:3746-3765), NOT inside SkyBox.update. So `skyBox.show=false`
//     does NOT kill the sprites — it kills only the cubemap.
//   Therefore:
//     default      : skyBox.show=true,  starField.show=true   (cubemap+sprites)
//     cubemap-only : skyBox.show=true,  starField.show=false  (cubemap alone)
//     sprites-only : skyBox.show=false, starField.show=true   (sprites alone —
//                    the cubemap command is dropped; both backends execute the
//                    single returned star command)
//
// GATE EVIDENCE — EXPOSURE BRACKET (--bracket, C12-02).
//   An 8-bit readback cannot measure a halo to 1e-3 of peak — the halo is
//   exactly the part the 8-bit capture discards. The bracket restores ~5 decades
//   of range with no engine change:
//     * scene.highDynamicRange = true  (exposure only takes effect on the HDR
//       path — PostProcessStageCollection.exposure -> tonemap uniform), RECORDED
//       in the manifest as `hdr:true`. Bracket evidence is HDR-lane evidence,
//       distinct from the SDR G1 lanes.
//     * capture at scene.postProcessStages.exposure = 1x, 8x, 64x.
//   STITCH MATH (per pixel, per channel):
//     For a pixel, among the three exposures pick the HIGHEST factor f whose
//     captured 8-bit channel value v is UNCLIPPED (v < 250). The linear estimate
//     is  L = (v / 255) / f. Picking the highest unclipped exposure maximises the
//     signal-to-quantization ratio at that pixel; dividing by f removes the
//     exposure gain. This assumes the display transform is locally LINEAR in the
//     unclipped region (v < 250) — true to good approximation for PBR-Neutral's
//     near-identity low/mid response, and sufficient because M4 measures the
//     RELATIVE radial falloff, which the near-linear low end preserves. The
//     composite spans ~ (1/1) down to (1/255)/64 ~ 6e-5, i.e. > 4 decades, which
//     an 8-bit readback (1/255 ~ 4e-3, ~2.4 decades) cannot reach. The composite
//     is a linear-light float image fed to M4 (brightest source) and M5
//     (curated bright-star cross-match). Both are reported as DIAGNOSTIC — the
//     PSF gates G2/G4 land in W2/W4; the bracket's own PASS is that the range
//     extension is REAL (halo signal recovered below the 8-bit floor).
//
// BINDING PROBE RULES (defect class root-caused Batch 744):
//   1. Pinned clock: viewer.useDefaultRenderLoop=false; EVERY render passes the
//      pinned time — scene.render(viewer.clock.currentTime) — never bare
//      scene.render() (which renders at wall-clock NOW).
//   2. Same-task capture: the final scene.render() and the drawImage/getImageData
//      run in the SAME task with NO await between them (the WebGPU drawing buffer
//      clears once the compositor consumes a presented frame).
//   3. Bounded sun-direction settle loop before any sun-relative aiming (ICRF
//      loads async): <= 180 frames, stable when 10 consecutive deltas < 1e-9.
//   4. Unref'd force-exit watchdog + try/finally browser close.
//   5. HARD exit codes: 0 only on PASS, 1 on gate FAIL, 2 on structural error.
//
// Usage:
//   node Tools/visual-regression/probe-celestial-gates.mjs            # G1 (SDR)
//   node Tools/visual-regression/probe-celestial-gates.mjs --bracket  # C12-02 HDR bracket
//   PROBE_BASE=http://localhost:8080 node ... (override server)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { execSync } from "node:child_process";
import {
  m1PointSourceCensus,
  m2ContrastTail,
  m2eSkyFloor,
  m3Chroma,
  m4RadialFalloff,
  m5MagnitudeFidelity,
} from "./lib/celestial-metrics.mjs";
import { sha256, createSceneIdentity } from "./lib/visual-gate-policy.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const PINNED_ISO = "2026-05-19T18:00:00Z";
const VIEWPORT = { width: 1280, height: 720 };
const CROP = { width: 1000, height: 640 };
const SETTLE_FRAMES = 32;

const BRACKET = process.argv.includes("--bracket");

// Curated bright stars (J2000 RA/Dec deg, Johnson V) spanning ~3.5 mag around
// the Sirius field — the M5 cross-match set. Projected in-page at the pinned
// clock via the same TEME->pseudo-fixed transform the renderer uses, so render
// and projection share any precession offset and it cancels in the match.
const CATALOG_EXPECTATIONS = [
  { name: "Sirius", ra: 101.287, dec: -16.716, vmag: -1.46 },
  { name: "Canopus", ra: 95.988, dec: -52.696, vmag: -0.74 },
  { name: "Rigel", ra: 78.634, dec: -8.202, vmag: 0.13 },
  { name: "Procyon", ra: 114.825, dec: 5.225, vmag: 0.34 },
  { name: "Betelgeuse", ra: 88.793, dec: 7.407, vmag: 0.42 },
  { name: "Aldebaran", ra: 68.98, dec: 16.509, vmag: 0.85 },
  { name: "Adhara", ra: 104.656, dec: -28.972, vmag: 1.5 },
  { name: "Bellatrix", ra: 81.283, dec: 6.35, vmag: 1.64 },
  { name: "Alnilam", ra: 84.053, dec: -1.202, vmag: 1.69 },
  { name: "Mirzam", ra: 95.674, dec: -17.956, vmag: 1.98 },
];

const HARD_LIMIT_MS = 300000;
const watchdog = setTimeout(() => {
  console.error("[probe-celestial-gates] WATCHDOG FIRED (300s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) {
  watchdog.unref();
}

const r3 = (x) => (!Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const ratio = (a, b) =>
  Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null;

function getGit() {
  const run = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
  try {
    const sourceCommit = run("git rev-parse HEAD");
    const sourceDirty = run("git status --porcelain").length > 0;
    return { sourceCommit, sourceDirty };
  } catch {
    return { sourceCommit: "0".repeat(40), sourceDirty: true };
  }
}

function normalizeHardwareClass(parts) {
  const populated = parts
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim().toLowerCase().replaceAll(/\s+/g, "-"));
  return populated.length > 0 ? populated.join(":") : "unknown";
}

// --------------------------------------------------------------------------
// In-page: configure the G1 scene, settle the sun direction, aim the camera.
// Returns the stable sun direction, sky brightness, adapter provenance, and the
// canvas/crop geometry. Runs entirely at the pinned clock.
// --------------------------------------------------------------------------
async function setupScene(page, { aim }) {
  return page.evaluate(
    async ({ pinnedIso, aimMode, crop, settleFrames, catalog }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;

      // RULE 1 — kill the default loop, render only at the pinned clock.
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = C.JulianDate.fromIso8601(pinnedIso);
      viewer.useDefaultRenderLoop = false;
      scene.requestRenderMode = false;
      const pinnedTime = () => viewer.clock.currentTime;

      // G1 scene: pure star field, nothing else emitting light.
      scene.backgroundColor = C.Color.BLACK;
      if (scene.globe) {
        scene.globe.show = false;
      }
      if (scene.sun) {
        scene.sun.show = false;
      }
      if (scene.moon) {
        scene.moon.show = false;
      }
      if (scene.skyAtmosphere) {
        scene.skyAtmosphere.show = false;
      }
      if (scene.fog) {
        scene.fog.enabled = false;
      }

      // RULE 3 — bounded sun-direction settle (ICRF loads async).
      let prev = null;
      let stableRun = 0;
      for (let i = 0; i < 180 && stableRun < 10; i++) {
        scene.render(pinnedTime());
        const cur = C.Cartesian3.clone(
          scene.context.uniformState.sunDirectionWC,
        );
        if (prev && C.Cartesian3.distance(cur, prev) < 1e-9) {
          stableRun++;
        } else {
          stableRun = 0;
        }
        prev = cur;
        await new Promise((r) => requestAnimationFrame(r));
      }
      const sunDir = prev;

      const dist = 5.0e7;
      let cameraUp;
      if (aimMode === "sirius") {
        // Aim at the brightest catalogue star so the bracket lane has a bright
        // source dead centre. Same RA/Dec -> TEME -> pseudo-fixed transform the
        // renderer uses (probe-starfield-webgl-parity pattern).
        const s = catalog[0];
        const ra = C.Math.toRadians(s.ra);
        const dec = C.Math.toRadians(s.dec);
        const teme = new C.Cartesian3(
          Math.cos(dec) * Math.cos(ra),
          Math.cos(dec) * Math.sin(ra),
          Math.sin(dec),
        );
        const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
          pinnedTime(),
          new C.Matrix3(),
        );
        const dir = C.Matrix3.multiplyByVector(
          temeToFixed,
          teme,
          new C.Cartesian3(),
        );
        C.Cartesian3.normalize(dir, dir);
        const eye = C.Cartesian3.multiplyByScalar(
          dir,
          -dist,
          new C.Cartesian3(),
        );
        let up = C.Cartesian3.UNIT_Z;
        if (Math.abs(C.Cartesian3.dot(dir, up)) > 0.95) {
          up = C.Cartesian3.UNIT_X;
        }
        const right = C.Cartesian3.normalize(
          C.Cartesian3.cross(dir, up, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        const realUp = C.Cartesian3.normalize(
          C.Cartesian3.cross(right, dir, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        scene.camera.setView({
          destination: eye,
          orientation: { direction: dir, up: realUp },
        });
        cameraUp = C.Cartesian3.normalize(eye, new C.Cartesian3());
      } else {
        // SUNLIT G1: camera ALONG the sun direction => local up == sunDir =>
        // the Sun sits at the local zenith (elevation ~90deg, >> 25deg). Aim
        // perpendicular to the sun so neither the sun disc nor Earth is in view.
        const axis = sunDir;
        const position = C.Cartesian3.multiplyByScalar(
          axis,
          dist,
          new C.Cartesian3(),
        );
        const seed =
          Math.abs(axis.z) < 0.9
            ? new C.Cartesian3(0, 0, 1)
            : new C.Cartesian3(1, 0, 0);
        const perp = C.Cartesian3.normalize(
          C.Cartesian3.cross(axis, seed, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        const up = C.Cartesian3.normalize(
          C.Cartesian3.cross(perp, axis, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        scene.camera.setView({
          destination: position,
          orientation: { direction: perp, up },
        });
        cameraUp = C.Cartesian3.normalize(position, new C.Cartesian3());
      }

      // Sun elevation above the camera's local horizon (deg).
      const sunElevationDeg =
        (Math.asin(
          Math.max(-1, Math.min(1, C.Cartesian3.dot(sunDir, cameraUp))),
        ) *
          180) /
        Math.PI;

      // Adapter provenance (C12-03 substrate): WebGPU adapter.info, else the
      // WebGL UNMASKED_RENDERER string.
      let adapter = {
        vendor: null,
        architecture: null,
        device: null,
        description: null,
      };
      const ctx = scene.context;
      const gpuAdapter = ctx.adapter ?? ctx._adapter;
      if (gpuAdapter && gpuAdapter.info) {
        const info = gpuAdapter.info;
        adapter = {
          vendor: info.vendor ?? null,
          architecture: info.architecture ?? null,
          device: info.device ?? null,
          description: info.description ?? null,
        };
      } else {
        try {
          const gl = ctx._gl || ctx._originalGLContext || ctx.gl;
          if (gl) {
            const ext = gl.getExtension("WEBGL_debug_renderer_info");
            if (ext) {
              adapter.description = gl.getParameter(
                ext.UNMASKED_RENDERER_WEBGL,
              );
              adapter.vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
            }
          }
        } catch {
          // leave adapter unknown
        }
      }

      for (let i = 0; i < settleFrames; i++) {
        scene.render(pinnedTime());
        await new Promise((r) => requestAnimationFrame(r));
      }

      const canvas = scene.canvas;
      const cw = Math.min(crop.width, canvas.width);
      const ch = Math.min(crop.height, canvas.height);
      const ox = Math.floor((canvas.width - cw) / 2);
      const oy = Math.floor((canvas.height - ch) / 2);

      // Project the curated bright-star list to canvas, keep the ones inside the
      // crop; positions are crop-relative for M5.
      const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
        pinnedTime(),
        new C.Matrix3(),
      );
      const expectations = [];
      for (const s of catalog) {
        const ra = C.Math.toRadians(s.ra);
        const dec = C.Math.toRadians(s.dec);
        const teme = new C.Cartesian3(
          Math.cos(dec) * Math.cos(ra),
          Math.cos(dec) * Math.sin(ra),
          Math.sin(dec),
        );
        const dir = C.Matrix3.multiplyByVector(
          temeToFixed,
          teme,
          new C.Cartesian3(),
        );
        C.Cartesian3.normalize(dir, dir);
        const far = C.Cartesian3.multiplyByScalar(
          dir,
          1.0e12,
          new C.Cartesian3(),
        );
        const win = scene.cartesianToCanvasCoordinates(far, new C.Cartesian2());
        if (win && Number.isFinite(win.x) && Number.isFinite(win.y)) {
          const sx = win.x - ox;
          const sy = win.y - oy;
          if (sx >= 0 && sy >= 0 && sx < cw && sy < ch) {
            expectations.push({
              name: s.name,
              vmag: s.vmag,
              screenX: sx,
              screenY: sy,
            });
          }
        }
      }

      return {
        rendererType: scene.context.rendererType,
        skyBrightness: scene.frameState
          ? (scene.frameState.skyBrightness ?? null)
          : null,
        sunElevationDeg,
        adapter,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        crop: { x: ox, y: oy, width: cw, height: ch },
        expectations,
      };
    },
    {
      pinnedIso: PINNED_ISO,
      aimMode: aim,
      crop: CROP,
      settleFrames: SETTLE_FRAMES,
      catalog: CATALOG_EXPECTATIONS,
    },
  );
}

// --------------------------------------------------------------------------
// In-page: apply the M6 toggles (or the bracket exposure), settle, and capture
// the crop in the SAME task as the final render (RULE 2).
// --------------------------------------------------------------------------
async function captureMode(page, { mode, crop, exposure, hdr }) {
  return page.evaluate(
    async ({ captureMode, cropRect, exposureFactor, useHdr, settleFrames }) => {
      await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;
      const pinnedTime = () => viewer.clock.currentTime;

      const skyBox = scene.skyBox;
      if (skyBox) {
        if (captureMode === "default") {
          skyBox.show = true;
          if (skyBox.starField) {
            skyBox.starField.show = true;
          }
        } else if (captureMode === "cubemap-only") {
          skyBox.show = true;
          if (skyBox.starField) {
            skyBox.starField.show = false;
          }
        } else if (
          captureMode === "sprites-only" ||
          captureMode === "bracket"
        ) {
          // sprites-only AND bracket are catalogue-only: cubemap off, sprites on.
          skyBox.show = false;
          if (skyBox.starField) {
            skyBox.starField.show = true;
          }
        }
      }

      let hdrEngaged = null;
      if (useHdr) {
        scene.highDynamicRange = true;
        hdrEngaged = scene.highDynamicRange === true;
        if (scene.postProcessStages) {
          scene.postProcessStages.exposure = exposureFactor;
        }
      }

      for (let i = 0; i < settleFrames; i++) {
        scene.render(pinnedTime());
        await new Promise((r) => requestAnimationFrame(r));
      }

      // RULE 2 — final render + readback in ONE task, no await between.
      scene.render(pinnedTime());
      const canvas = scene.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx = tmp.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const full = ctx.getImageData(
        cropRect.x,
        cropRect.y,
        cropRect.width,
        cropRect.height,
      );

      return {
        width: cropRect.width,
        height: cropRect.height,
        data: Array.from(full.data),
        skyBrightness: scene.frameState
          ? (scene.frameState.skyBrightness ?? null)
          : null,
        hdrEngaged,
        exposureFactor: useHdr ? exposureFactor : null,
        cubemapOn: !!(skyBox && skyBox.show),
        spritesOn: !!(skyBox && skyBox.starField && skyBox.starField.show),
      };
    },
    {
      captureMode: mode,
      cropRect: crop,
      exposureFactor: exposure ?? 1,
      useHdr: !!hdr,
      settleFrames: SETTLE_FRAMES,
    },
  );
}

function toImage(capture) {
  return {
    data: new Uint8ClampedArray(capture.data),
    width: capture.width,
    height: capture.height,
  };
}

// EncodePNG — copied verbatim from capture-and-diff.mjs so the written PNG is
// byte-identical to the pixels the metrics measured (imageSha256 covers exactly
// what was gated).
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
    let a = 1;
    let b = 0;
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

// Build the 14-field provenance manifest entry (visual-gate-policy.mjs:9-24).
function buildManifestEntry({
  scene,
  image,
  pngBytes,
  renderer,
  env,
  git,
  sceneIdentity,
  extra,
}) {
  return {
    scene,
    image,
    imageSha256: sha256(pngBytes),
    renderer,
    provenanceClass: "probe-evidence",
    sourceCommit: git.sourceCommit,
    sourceDirty: git.sourceDirty,
    width: CROP.width,
    height: CROP.height,
    sceneIdentity,
    browserClass: env.browserClass,
    browserVersion: env.browserVersion,
    adapterClass: env.adapterClass,
    capturedAt: new Date().toISOString(),
    ...extra,
  };
}

// Stitch the 1x/8x/64x captures into a linear-light float composite.
function stitchBracket(captures) {
  const { width, height } = captures[0];
  const n = width * height * 4;
  const out = new Float64Array(n);
  // Highest factor first so the first unclipped sample wins.
  const ordered = captures
    .slice()
    .sort((a, b) => b.exposureFactor - a.exposureFactor);
  for (let i = 0; i < n; i += 4) {
    for (let c = 0; c < 3; c++) {
      let linear = 0;
      for (const cap of ordered) {
        const v = cap.data[i + c];
        if (v < 250) {
          linear = v / 255 / cap.exposureFactor;
          break;
        }
      }
      // Every exposure clipped (v>=250 everywhere): fall back to the lowest
      // exposure's normalized value so a saturated core still reads as bright.
      if (linear === 0) {
        const lowest = ordered[ordered.length - 1];
        linear = lowest.data[i + c] / 255 / lowest.exposureFactor;
      }
      out[i + c] = linear;
    }
    out[i + 3] = 1;
  }
  return { data: out, width, height };
}

async function runBackend(browser, renderer, { aim, hdr }) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      consoleErrors.push(m.text().slice(0, 200));
    }
  });
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      },
    );
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      { timeout: 90000 },
    );
    await page.waitForTimeout(5000);

    const setup = await setupScene(page, { aim });
    const captures = {};
    if (hdr) {
      for (const [factor, label] of [
        [1, "1x"],
        [8, "8x"],
        [64, "64x"],
      ]) {
        captures[label] = await captureMode(page, {
          mode: "bracket",
          crop: setup.crop,
          exposure: factor,
          hdr: true,
        });
      }
    } else {
      for (const mode of ["default", "cubemap-only", "sprites-only"]) {
        captures[mode] = await captureMode(page, {
          mode,
          crop: setup.crop,
          hdr: false,
        });
      }
    }
    return {
      ok: true,
      renderer,
      setup,
      captures,
      consoleErrors: consoleErrors.slice(0, 6),
    };
  } catch (e) {
    return {
      ok: false,
      renderer,
      error: String((e && e.message) || e).slice(0, 400),
      consoleErrors: consoleErrors.slice(0, 6),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function metricsForImage(image) {
  const m1 = m1PointSourceCensus(image);
  const m2 = m2ContrastTail(image);
  const m2e = m2eSkyFloor(image);
  const m3 = m3Chroma(image, m1.sources);
  return { m1, m2, m2e, m3 };
}

function writeCapturePng(image, name) {
  const png = encodePNG(image.data, image.width, image.height);
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, png);
  return { file, png };
}

async function runG1(browser, git) {
  const gl = await runBackend(browser, "webgl", { aim: "sunlit", hdr: false });
  const gpu = await runBackend(browser, "webgpu", {
    aim: "sunlit",
    hdr: false,
  });
  if (!gl.ok || !gpu.ok) {
    return { fatal: true, gl, gpu };
  }

  const browserVersion = browser.version();
  const envOf = (lane) => ({
    browserClass: "msedge",
    browserVersion,
    adapterClass: normalizeHardwareClass([
      lane.setup.adapter.vendor,
      lane.setup.adapter.architecture,
      lane.setup.adapter.device,
      lane.setup.adapter.description,
    ]),
  });

  const manifest = {};
  const modes = ["default", "cubemap-only", "sprites-only"];
  const perMode = {};
  for (const mode of modes) {
    const glImg = toImage(gl.captures[mode]);
    const gpuImg = toImage(gpu.captures[mode]);
    const glM = metricsForImage(glImg);
    const gpuM = metricsForImage(gpuImg);
    perMode[mode] = {
      webgl: glM,
      webgpu: gpuM,
      m1CountRatio: ratio(gpuM.m1.count, glM.m1.count),
      m2aRatio: ratio(gpuM.m2.rmsContrast, glM.m2.rmsContrast),
      m2bRatio: ratio(gpuM.m2.p999MinusP50, glM.m2.p999MinusP50),
      m3ChromaRatio: ratio(gpuM.m3.medianSaturation, glM.m3.medianSaturation),
      meanLumRatio_DIAGNOSTIC: ratio(gpuM.m2.mean, glM.m2.mean),
    };
    for (const [renderer, lane, img] of [
      ["webgl", gl, glImg],
      ["webgpu", gpu, gpuImg],
    ]) {
      const sceneName = `celestial-g1-${mode}`;
      const pngName = `celestial-g1-${mode}-${renderer}.png`;
      const { png } = writeCapturePng(img, pngName);
      const sceneDescriptor = {
        name: sceneName,
        camera: { aim: "sunlit", distance: 5.0e7, pinnedIso: PINNED_ISO },
        setup: "celestial-gate-g1",
        setupParams: {
          mode,
          globeOff: true,
          sunOff: true,
          skyAtmosphereOff: true,
        },
      };
      const sceneIdentity = createSceneIdentity(sceneDescriptor, {
        baseUrl: BASE,
        settleFrames: SETTLE_FRAMES,
        viewport: VIEWPORT,
      });
      manifest[`${sceneName}:${renderer}`] = buildManifestEntry({
        scene: sceneName,
        image: pngName,
        pngBytes: png,
        renderer,
        env: envOf(lane),
        git,
        sceneIdentity,
        extra: {
          hdr: false,
          skyBrightness: r3(lane.captures[mode].skyBrightness),
          sunElevationDeg: r3(lane.setup.sunElevationDeg),
        },
      });
    }
  }

  // ---- G1 pass evaluation ----
  // ratio() returns null when a denominator is absent, and `null >= n` is
  // false, so a missing ratio fails its criterion without an explicit guard.
  const inBand = (x, lo, hi) => x >= lo && x <= hi;
  const def = perMode.default;
  const criteria = {
    default_m1CountRatio_ge_0_90: def.m1CountRatio >= 0.9,
    default_m2a_in_band: inBand(def.m2aRatio, 0.85, 1.15),
    default_m2b_in_band: inBand(def.m2bRatio, 0.85, 1.15),
    default_m3Chroma_ge_0_85: def.m3ChromaRatio >= 0.85,
    cubemapOnly_m1CountRatio_ge_0_90:
      perMode["cubemap-only"].m1CountRatio >= 0.9,
    spritesOnly_m1CountRatio_ge_0_90:
      perMode["sprites-only"].m1CountRatio >= 0.9,
  };
  // Sunlit framing must actually be reached, else the gate is meaningless.
  const framingReached =
    gl.setup.sunElevationDeg >= 25 && gpu.setup.sunElevationDeg >= 25;
  const pass = framingReached && Object.values(criteria).every(Boolean);

  return {
    fatal: false,
    gate: "G1",
    pass,
    framingReached,
    sunElevationDeg: {
      webgl: r3(gl.setup.sunElevationDeg),
      webgpu: r3(gpu.setup.sunElevationDeg),
    },
    skyBrightness: {
      webgl: r3(gl.setup.skyBrightness),
      webgpu: r3(gpu.setup.skyBrightness),
    },
    criteria,
    perMode: Object.fromEntries(
      modes.map((m) => [
        m,
        {
          m1CountRatio: r3(perMode[m].m1CountRatio),
          m2aRatio: r3(perMode[m].m2aRatio),
          m2bRatio: r3(perMode[m].m2bRatio),
          m3ChromaRatio: r3(perMode[m].m3ChromaRatio),
          meanLumRatio_DIAGNOSTIC: r3(perMode[m].meanLumRatio_DIAGNOSTIC),
          webgl_m1Count: perMode[m].webgl.m1.count,
          webgpu_m1Count: perMode[m].webgpu.m1.count,
          webgl_skyFloor: r3(perMode[m].webgl.m2e.skyFloor),
          webgpu_skyFloor: r3(perMode[m].webgpu.m2e.skyFloor),
        },
      ]),
    ),
    manifest,
    gl,
    gpu,
    consoleErrors: { webgl: gl.consoleErrors, webgpu: gpu.consoleErrors },
  };
}

function bracketDiagnostics(setup, composite) {
  const m1 = m1PointSourceCensus(composite, { alreadyLinear: true });
  if (m1.count === 0) {
    return { m1Count: 0, m4: null, m5: null };
  }
  // Brightest detected source for M4.
  let brightest = m1.sources[0];
  for (const s of m1.sources) {
    if (s.peak > brightest.peak) {
      brightest = s;
    }
  }
  const m4 = m4RadialFalloff(
    composite,
    { x: brightest.x, y: brightest.y },
    {
      alreadyLinear: true,
    },
  );
  const m5 = m5MagnitudeFidelity(setup.expectations, m1.sources, {
    maxDistance: 3,
  });
  return {
    m1Count: m1.count,
    brightest: { x: brightest.x, y: brightest.y, peak: brightest.peak },
    m4: {
      rCore: r3(m4.rCore),
      r1e2: r3(m4.r1e2),
      r1e3: r3(m4.r1e3),
      ratio1e3: r3(m4.ratio1e3),
      slopeInner: r3(m4.slopeInner),
      slopeOuter: r3(m4.slopeOuter),
      peak: r3(m4.peak),
    },
    m5: {
      matched: m5.matched.length,
      spearman: r3(m5.spearman),
      exponent: r3(m5.exponent),
      brightestFaintestRatio: r3(m5.brightestFaintestRatio),
    },
  };
}

async function runBracket(browser, git) {
  const gl = await runBackend(browser, "webgl", { aim: "sirius", hdr: true });
  const gpu = await runBackend(browser, "webgpu", { aim: "sirius", hdr: true });
  if (!gl.ok || !gpu.ok) {
    return { fatal: true, gl, gpu };
  }

  const browserVersion = browser.version();
  const lanes = {};
  const manifest = {};
  let structuralPass = true;
  for (const [renderer, lane] of [
    ["webgl", gl],
    ["webgpu", gpu],
  ]) {
    const caps = [
      lane.captures["1x"],
      lane.captures["8x"],
      lane.captures["64x"],
    ];
    const hdrEngaged = caps.every((c) => c.hdrEngaged === true);
    const composite = stitchBracket(caps);

    // Range-extension proof: the 64x lane must reveal signal where the 1x lane
    // read hard 0 (below the 8-bit floor), around the brightest source.
    const oneX = toImage(caps.find((c) => c.exposureFactor === 1));
    const diag = bracketDiagnostics(lane.setup, composite);
    let rangeExtended = false;
    if (diag.m1Count > 0 && diag.brightest) {
      const { x, y } = diag.brightest;
      // ring at radius ~12 px from the core, where the 8-bit 1x capture is 0.
      let oneXFloorZero = false;
      let compositeSignal = false;
      for (let a = 0; a < 8; a++) {
        const px = Math.round(x + 12 * Math.cos((a / 8) * Math.PI * 2));
        const py = Math.round(y + 12 * Math.sin((a / 8) * Math.PI * 2));
        if (px >= 0 && py >= 0 && px < oneX.width && py < oneX.height) {
          const i = (py * oneX.width + px) * 4;
          const lum8 = oneX.data[i] + oneX.data[i + 1] + oneX.data[i + 2];
          const cl =
            composite.data[i] + composite.data[i + 1] + composite.data[i + 2];
          if (lum8 === 0) {
            oneXFloorZero = true;
          }
          if (cl > 1e-4) {
            compositeSignal = true;
          }
        }
      }
      rangeExtended = oneXFloorZero && compositeSignal;
    }

    const laneOk = hdrEngaged && diag.m1Count > 0;
    if (!laneOk) {
      structuralPass = false;
    }

    // Manifest per bracket exposure step (HDR-lane evidence).
    for (const cap of caps) {
      const img = toImage(cap);
      const label = `${cap.exposureFactor}x`;
      const sceneName = `celestial-bracket-${label}`;
      const pngName = `celestial-bracket-${label}-${renderer}.png`;
      const { png } = writeCapturePng(img, pngName);
      const sceneDescriptor = {
        name: sceneName,
        camera: { aim: "sirius", distance: 5.0e7, pinnedIso: PINNED_ISO },
        setup: "celestial-gate-bracket",
        setupParams: {
          exposure: cap.exposureFactor,
          hdr: true,
          spritesOnly: true,
        },
      };
      const sceneIdentity = createSceneIdentity(sceneDescriptor, {
        baseUrl: BASE,
        settleFrames: SETTLE_FRAMES,
        viewport: VIEWPORT,
      });
      manifest[`${sceneName}:${renderer}`] = buildManifestEntry({
        scene: sceneName,
        image: pngName,
        pngBytes: png,
        renderer,
        env: {
          browserClass: "msedge",
          browserVersion,
          adapterClass: normalizeHardwareClass([
            lane.setup.adapter.vendor,
            lane.setup.adapter.architecture,
            lane.setup.adapter.device,
            lane.setup.adapter.description,
          ]),
        },
        git,
        sceneIdentity,
        extra: {
          hdr: true,
          exposureFactor: cap.exposureFactor,
          hdrEngaged: cap.hdrEngaged,
        },
      });
    }

    lanes[renderer] = { hdrEngaged, rangeExtended, ...diag };
  }

  return {
    fatal: false,
    gate: "bracket",
    structuralPass,
    lanes,
    manifest,
    gl,
    gpu,
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const git = getGit();
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let result;
  let exitCode;
  try {
    result = BRACKET
      ? await runBracket(browser, git)
      : await runG1(browser, git);
  } finally {
    await browser.close().catch(() => {});
  }

  if (result.fatal) {
    console.error(
      "[probe-celestial-gates] STRUCTURAL FAILURE — a backend lane did not run",
    );
    for (const lane of [result.gl, result.gpu]) {
      if (lane && !lane.ok) {
        console.error(`  ${lane.renderer}: ${lane.error}`);
        for (const e of lane.consoleErrors || []) {
          console.error(`    console: ${e}`);
        }
      }
    }
    clearTimeout(watchdog);
    process.exit(2);
  }

  const outName = BRACKET ? "celestial-bracket.json" : "celestial-g1.json";
  const outPath = path.join(OUT_DIR, outName);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  if (BRACKET) {
    const summary = {
      gate: "bracket (C12-02 evidence, HDR lane)",
      structuralPass: result.structuralPass,
      lanes: Object.fromEntries(
        Object.entries(result.lanes).map(([k, v]) => [
          k,
          {
            hdrEngaged: v.hdrEngaged,
            rangeExtended: v.rangeExtended,
            m1Count: v.m1Count,
            m4_ratio1e3_DIAGNOSTIC: v.m4 ? v.m4.ratio1e3 : null,
            m5_spearman_DIAGNOSTIC: v.m5 ? v.m5.spearman : null,
            m5_matched: v.m5 ? v.m5.matched : null,
          },
        ]),
      ),
    };
    console.log(JSON.stringify(summary, null, 2));
    console.log(`\n[full report: ${outPath}]`);
    exitCode = result.structuralPass ? 0 : 1;
    console.log(
      exitCode === 0
        ? "bracket PASS — HDR engaged, sources detected, range extended on both backends"
        : "bracket FAIL — HDR not engaged and/or no source detected on a backend",
    );
  } else {
    console.log(
      JSON.stringify(
        {
          gate: result.gate,
          pass: result.pass,
          framingReached: result.framingReached,
          sunElevationDeg: result.sunElevationDeg,
          skyBrightness: result.skyBrightness,
          criteria: result.criteria,
          perMode: result.perMode,
        },
        null,
        2,
      ),
    );
    console.log(`\n[full report: ${outPath}]`);
    exitCode = result.pass ? 0 : 1;
    console.log(
      exitCode === 0
        ? "G1 PASS — WebGPU/WebGL at parity across all three M6 source splits"
        : "G1 FAIL — see criteria/perMode above",
    );
  }

  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-celestial-gates] FATAL", e);
  clearTimeout(watchdog);
  process.exit(2);
});
