#!/usr/bin/env node
/**
 * Probe: OIT-COLLECTION-REACHABLE (C11-157 Slice B).
 * @purpose C11-157 Slice B: MRT-OIT accumulation reachable for translucent billboard/point/polyline collections under the runtime-flipped FAR-003 gate.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * Proves the WebGPU MRT-OIT accumulation path is now REACHABLE for standard
 * translucent COLLECTIONS (billboard / point / polyline). Slice A did the
 * PRIMITIVE family; Slice B wires the collection translucent color commands to
 * carry `_shaderCode` + `_pipelineConfig` so `executeTranslucentPass`
 * auto-builds the MRT accumulation pipeline under the FAR-003 gate.
 *
 * FAR-003 stays DEFAULT-OFF — this probe FLIPS the gate at runtime via
 * CesiumDebug.webgpuOIT(true); it does not change the default.
 *
 * Scenes (WebGPU, msaaSamples=1 so the single-sample OIT accumulation targets
 * are sample-consistent):
 *   - point    : 3 large overlapping translucent PointPrimitives (α0.5 R/G/B).
 *   - polyline  : 3 crossing wide translucent polylines (α0.5 R/G/B).
 *   - billboard : 3 overlapping translucent billboards (a soft disc image, α0.5).
 * All three collection color shaders return a `FragOutput` struct
 * (@location(0) color) — handled by injectOITOutput's struct branch.
 *
 * Per scene: capture gate-OFF (sorted alpha, the default), flip the gate ON,
 * render, read `_webgpuOITActiveThisFrame`, capture gate-ON, restore.
 *
 * HARD GATES: gate-ON `_webgpuOITActiveThisFrame === true` (was ALWAYS false),
 * 0 device/validation errors, gate-ON non-black, and gate-ON visibly DIFFERS
 * from gate-OFF (the accumulation path actually changed the pixels).
 *
 * WHAT THE SHARED RUNTIME OWNS (DX-06 migration onto `lib/probe-runtime.mjs`).
 * Edge launch, the single-Edge-slot lock, the served-build preflight and the
 * receipt/summary writer now live in the runtime; this file keeps the scene
 * setup, the per-scene capture math, and the machine-safety watchdog below,
 * which is now expressed as a `ProbeRefusal` (exit 3, same code the prior
 * ad hoc `process.exit(3)` watchdog used) rather than a raw process exit, so a
 * budget trip now closes the browser cleanly instead of killing the process
 * mid-flight — and, unlike the old top-level `setTimeout`, it is armed before
 * `browser.newPage`/`page.goto`/`waitForFunction` too, not just the scene
 * loop, so the covered budget did not shrink in the move. `--port` replaces
 * the old `PROBE_BASE` env var (default 8094, not 8080 — the runtime refuses
 * 8080 because the default dev server there serves a live esbuild of the
 * source tree, not the build this probe means to measure); pass `--port <n>`
 * to point at a different served build. The served-build assertion defaults
 * ON (`--no-serve-built` waives it): serve the built tree first (`node
 * server.js --port 8094 --serve-built`) or the bare command below REFUSES
 * (exit 3) rather than measuring a live esbuild of the source tree.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-oit-collection-reachable.mjs
 *   SCENE=point|polyline|billboard selects one (default all — but run ONE per
 *   invocation for machine safety).
 * Out:   Tools/visual-regression/output/oitcoll-*.png + oitcoll-report.json +
 *        oitcoll-runtime.json + oitcoll-summary.md
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";

const VIEWPORT = { width: 800, height: 600 };
const CLOCK_ISO = "2026-06-21T18:00:00Z";

// Machine safety: kill a hung Edge/device rather than wedge the box. Was a raw
// `process.exit(3)` from a top-level `setTimeout` before this file's runtime
// migration; a `ProbeRefusal` racing the scene loop reaches the exact same
// exit code (3) through the runtime's exit-code table, but lets the runtime's
// `finally` close the browser instead of killing the process out from under it.
const WATCHDOG_BUDGET_MS = 3 * 60 * 1000;

async function setupViewer(page, { sceneKind }) {
  return await page.evaluate(
    async ({ sceneKind, clockIso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      if (window.viewer && !window.viewer.isDestroyed()) {
        try {
          window.viewer.destroy();
        } catch (e) {
          void e;
        }
      }
      window.viewer = undefined;
      let container = document.getElementById("cesiumContainer");
      if (!container) {
        container = document.createElement("div");
        container.id = "cesiumContainer";
        document.body.appendChild(container);
      }
      container.innerHTML = "";
      Object.assign(container.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "800px",
        height: "600px",
      });

      const v = await C.Viewer.createAsync("cesiumContainer", {
        contextOptions: { renderer: "webgpu" },
        msaaSamples: 1,
        baseLayerPicker: false,
        geocoder: false,
        timeline: false,
        animation: false,
        fullscreenButton: false,
        navigationHelpButton: false,
        homeButton: false,
        sceneModePicker: false,
        infoBox: false,
        selectionIndicator: false,
        shouldAnimate: false,
      });
      window.__probeViewer = v;
      window.viewer = v;
      if (typeof C.CesiumDebug === "function") {
        try {
          C.CesiumDebug(v);
        } catch (e) {
          void e;
        }
      }

      const scene = v.scene;
      scene.msaaSamples = 1;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(clockIso);

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = new C.Color(0.02, 0.02, 0.04, 1.0);
      scene.fog.enabled = false;
      if (scene.postProcessStages && scene.postProcessStages.fxaa) {
        scene.postProcessStages.fxaa.enabled = false;
      }

      const LON = -75.0;
      const LAT = 40.0;
      const H = 200.0;
      const dLon = 0.00042;
      const dLat = 0.00032;
      const cols = [
        [1.0, 0.15, 0.15],
        [0.15, 1.0, 0.2],
        [0.2, 0.35, 1.0],
      ];
      const offs = [
        [0, dLat],
        [-dLon, -dLat * 0.6],
        [dLon, -dLat * 0.6],
      ];

      if (sceneKind === "point") {
        const pts = scene.primitives.add(new C.PointPrimitiveCollection());
        pts.blendOption = C.BlendOption.TRANSLUCENT;
        for (let i = 0; i < 3; i++) {
          pts.add({
            position: C.Cartesian3.fromDegrees(
              LON + offs[i][0],
              LAT + offs[i][1],
              H,
            ),
            color: new C.Color(cols[i][0], cols[i][1], cols[i][2], 0.5),
            pixelSize: 260,
          });
        }
      } else if (sceneKind === "polyline") {
        const lines = scene.primitives.add(new C.PolylineCollection());
        lines.blendOption = C.BlendOption.TRANSLUCENT;
        const s = 0.0011;
        const segs = [
          [
            [LON - s, LAT - s],
            [LON + s, LAT + s],
          ],
          [
            [LON - s, LAT + s],
            [LON + s, LAT - s],
          ],
          [
            [LON - s, LAT],
            [LON + s, LAT],
          ],
        ];
        for (let i = 0; i < 3; i++) {
          lines.add({
            positions: [
              C.Cartesian3.fromDegrees(segs[i][0][0], segs[i][0][1], H),
              C.Cartesian3.fromDegrees(segs[i][1][0], segs[i][1][1], H),
            ],
            width: 60,
            material: C.Material.fromType("Color", {
              color: new C.Color(cols[i][0], cols[i][1], cols[i][2], 0.5),
            }),
          });
        }
      } else {
        // billboard — soft translucent disc image, 3 overlapping instances.
        const cv = document.createElement("canvas");
        cv.width = 128;
        cv.height = 128;
        const cx = cv.getContext("2d");
        const g = cx.createRadialGradient(64, 64, 8, 64, 64, 62);
        g.addColorStop(0, "rgba(255,255,255,1)");
        g.addColorStop(0.7, "rgba(255,255,255,0.95)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        cx.fillStyle = g;
        cx.beginPath();
        cx.arc(64, 64, 62, 0, Math.PI * 2);
        cx.fill();
        const bb = scene.primitives.add(new C.BillboardCollection());
        bb.blendOption = C.BlendOption.TRANSLUCENT;
        for (let i = 0; i < 3; i++) {
          bb.add({
            position: C.Cartesian3.fromDegrees(
              LON + offs[i][0],
              LAT + offs[i][1],
              H,
            ),
            image: cv,
            color: new C.Color(cols[i][0], cols[i][1], cols[i][2], 0.5),
            scale: 2.4,
          });
        }
      }

      const center = C.Cartesian3.fromDegrees(LON, LAT, H);
      v.camera.lookAt(
        center,
        new C.HeadingPitchRange(
          C.Math.toRadians(0),
          C.Math.toRadians(-90),
          620,
        ),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);

      for (let i = 0; i < 45; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-oitcoll", "1");
      return {
        renderer: scene.context.rendererType,
        msaa: scene.msaaSamples,
        hasAlternateRenderer: !!scene._alternateSceneRenderer,
      };
    },
    { sceneKind, clockIso: CLOCK_ISO },
  );
}

async function grabCanvas(page) {
  // Render fresh frames immediately before the screenshot — a WebGPU canvas has
  // no preserveDrawingBuffer, so it can read back black if the last present was
  // a while ago. Does not change the OIT gate.
  await page.evaluate(async () => {
    const scene = window.__probeViewer.scene;
    for (let i = 0; i < 3; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const png = await page
    .locator('canvas[data-oitcoll="1"]')
    .screenshot({ type: "png" });
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { w: bmp.width, h: bmp.height, data: Array.from(d) };
  }, Buffer.from(png).toString("base64"));
  return { decoded };
}

function nonBlackFrac(img) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] > 14 || img.data[i + 1] > 14 || img.data[i + 2] > 14) n++;
  }
  return +((100 * n) / (img.data.length / 4)).toFixed(2);
}

function diffPixels(a, b, thr = 16) {
  if (!a || !b || a.w !== b.w || a.h !== b.h)
    return { mismatch: 0, pct: null, maxDelta: null };
  let px = 0;
  let mismatch = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    px++;
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    const m = Math.max(dr, dg, db);
    if (m > maxDelta) maxDelta = m;
    if (dr > thr || dg > thr || db > thr) mismatch++;
  }
  return {
    mismatch,
    pct: px ? +((100 * mismatch) / px).toFixed(3) : null,
    maxDelta,
  };
}

function centralMean(img) {
  const x0 = Math.floor(img.w * 0.35);
  const x1 = Math.floor(img.w * 0.65);
  const y0 = Math.floor(img.h * 0.35);
  const y1 = Math.floor(img.h * 0.65);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
    }
  }
  return {
    r: +(r / n).toFixed(1),
    g: +(g / n).toFixed(1),
    b: +(b / n).toFixed(1),
  };
}

// ── zero-dep PNG encoder ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePNG({ w, h, data }) {
  const bpr = w * 4;
  const raw = Buffer.alloc((bpr + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (bpr + 1)] = 0;
    Buffer.from(data.slice(y * bpr, (y + 1) * bpr)).copy(
      raw,
      y * (bpr + 1) + 1,
    );
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const tb = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([tb, body])), 0);
    return Buffer.concat([len, tb, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BENIGN_TEARDOWN_RE =
  /reason:\s*destroyed|Device was destroyed|Device lost: destroyed/i;
function realFaults(consoleErrors) {
  return consoleErrors.filter((e) => !BENIGN_TEARDOWN_RE.test(e));
}

async function runScene(page, consoleErrors, sceneKind, outputDirectory) {
  const setup = await setupViewer(page, { sceneKind });
  await armWebGPUDevices(page);

  const off1 = await grabCanvas(page);
  fs.writeFileSync(
    path.join(outputDirectory, `oitcoll-${sceneKind}-off.png`),
    encodePNG(off1.decoded),
  );
  await page.evaluate(async () => {
    const scene = window.__probeViewer.scene;
    for (let i = 0; i < 8; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const off2 = await grabCanvas(page);
  const noiseFloor = diffPixels(off1.decoded, off2.decoded, 0);

  const status = await page.evaluate(async () => {
    const cd = window.CesiumDebug;
    const toggled = cd.webgpuOIT(true);
    const scene = window.__probeViewer.scene;
    const sr = scene._alternateSceneRenderer;
    let sawActive = false;
    for (let i = 0; i < 30; i++) {
      scene.render();
      if (sr && sr._webgpuOITActiveThisFrame) sawActive = true;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      toggled,
      live: cd.webgpuOIT(),
      sawOITActiveAnyFrame: sawActive,
      activeThisFrame: !!(sr && sr._webgpuOITActiveThisFrame),
    };
  });
  const on = await grabCanvas(page);
  fs.writeFileSync(
    path.join(outputDirectory, `oitcoll-${sceneKind}-on.png`),
    encodePNG(on.decoded),
  );

  await page.evaluate(async () => {
    window.CesiumDebug.webgpuOIT(false);
    const scene = window.__probeViewer.scene;
    for (let i = 0; i < 20; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const restored = await grabCanvas(page);
  const restoreDiff = diffPixels(off1.decoded, restored.decoded, 0);

  const gate = await collectGateErrors(page);
  const faults = realFaults(consoleErrors);
  const errors = gate.errors.length + faults.length + (gate.deviceLost ? 1 : 0);

  const offNB = nonBlackFrac(off1.decoded);
  const onNB = nonBlackFrac(on.decoded);
  const onVsOff = diffPixels(on.decoded, off1.decoded, 16);

  const result = {
    sceneKind,
    setup,
    status,
    errors,
    gateErrorsSample: gate.errors.slice(0, 6),
    consoleFaults: faults.slice(0, 6),
    offNonBlack: offNB,
    onNonBlack: onNB,
    offMean: centralMean(off1.decoded),
    onMean: centralMean(on.decoded),
    onVsOff_diffPct: onVsOff.pct,
    onVsOff_maxDelta: onVsOff.maxDelta,
    noiseFloor_mismatchPx: noiseFloor.mismatch,
    noiseFloor_maxDelta: noiseFloor.maxDelta,
    restoreVsOff_mismatchPx: restoreDiff.mismatch,
    restoreVsOff_maxDelta: restoreDiff.maxDelta,
  };
  const pass =
    result.status.activeThisFrame === true &&
    result.errors === 0 &&
    result.onNonBlack > 6 &&
    result.onVsOff_diffPct !== null &&
    result.onVsOff_diffPct > 0.3 &&
    result.restoreVsOff_mismatchPx <=
      Math.max(result.noiseFloor_mismatchPx * 3, 3);
  result.pass = pass;
  return result;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "oitcoll",
  title: "OIT collection reachability (C11-157 Slice B)",
  outputSubdirectory: "",
  receiptEnvelope: "probe-owned",
  // This MRT-OIT accumulation path is WebGPU-only (the scenes assert
  // `_webgpuOITActiveThisFrame`, which does not exist on the WebGL renderer),
  // so the default narrows the shared `["webgl","webgpu"]` core default to
  // just the backend this probe can measure. An explicit `--renderer webgl`
  // is still accepted by `parseProbeArgs` (it is a fleet-wide flag) but is
  // refused below rather than silently ignored.
  args: { defaults: { renderers: ["webgpu"] } },
  async cells({ browser, origin, outputDirectory, options }) {
    if (options.renderers.length !== 1 || options.renderers[0] !== "webgpu") {
      throw new ProbeRefusal(
        "renderer-not-webgpu",
        `probe-oit-collection-reachable only measures webgpu (the scene navigates ?renderer=webgpu unconditionally); got --renderer ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    if (options.runs !== 1) {
      // receipt() re-keys cells by sceneKind; a second run's cells would
      // silently overwrite the first run's under the same keys.
      throw new ProbeRefusal(
        "multi-run-not-supported",
        `probe-oit-collection-reachable's receipt keys cells by sceneKind, so --runs ${options.runs} would silently drop every run but the last; pass --runs 1 (the default)`,
        { runs: options.runs },
      );
    }
    // The runtime resolves `outputDirectory` before calling `cells()` but
    // does not create it until a measured run reaches the receipt writer (or
    // an incident is banked) — both AFTER this function returns. `--output
    // <dir>` therefore names a directory that may not exist yet the first
    // time a scene writes a PNG into it.
    fs.mkdirSync(outputDirectory, { recursive: true });

    const only = (process.env.SCENE || "").trim();
    const all = ["point", "polyline", "billboard"];
    const kinds = all.includes(only) ? [only] : all;

    // Everything that can hang — the page open, the navigation, the wait for
    // `window.viewer`, and the scene loop — runs inside `work`, so the
    // watchdog below covers the full machine-safety budget rather than only
    // the scene loop.
    const work = (async () => {
      const page = await browser.newPage({ viewport: VIEWPORT });
      const consoleErrors = attachConsoleErrorGate(page);
      await page.addInitScript(errorGateInit);
      await page.goto(
        `${origin}/Apps/CesiumViewer/index.html?renderer=webgpu`,
        { waitUntil: "networkidle", timeout: 90000 },
      );
      await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

      const produced = [];
      for (const kind of kinds) {
        produced.push(
          await runScene(page, consoleErrors, kind, outputDirectory),
        );
      }
      return produced;
    })();
    // A watchdog loss leaves `work` still running against a page the runtime
    // is about to close; that trailing rejection has no one left to read it,
    // so it is swallowed here rather than left to surface as an unhandled
    // rejection warning after this function has already returned.
    work.catch(() => {});
    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-oit-collection-reachable exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
              { budgetMs: WATCHDOG_BUDGET_MS, kinds },
            ),
          ),
        WATCHDOG_BUDGET_MS,
      );
    });
    try {
      return await Promise.race([work, watchdog]);
    } finally {
      clearTimeout(watchdogTimer);
    }
  },
  receipt(cells, context) {
    const scenes = {};
    for (const cell of cells) {
      scenes[cell.sceneKind] = cell;
    }
    return { base: context.origin, scenes };
  },
  verdicts(cells) {
    return cells.map((cell) => ({
      id: cell.sceneKind,
      claim:
        "C11-157 Slice B — the translucent collection reaches WebGPU MRT-OIT accumulation",
      pass: cell.pass,
    }));
  },
  summary(receipt) {
    const scenes = Object.values(receipt.scenes);
    const passed = scenes.filter((s) => s.pass).length;
    return [
      "# OIT collection reachability (C11-157 Slice B)",
      "",
      `Base: \`${receipt.base}\``,
      "",
      `Scenes: ${passed}/${scenes.length} passed.`,
      "",
    ].join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
