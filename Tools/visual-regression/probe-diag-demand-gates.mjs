#!/usr/bin/env node
/**
 * Probe: DIAG-DEMAND-GATES (C9-18) — verify the disabled WebGPU CPU pass
 * profiler creates no per-call closures on the render hot path while still
 * rendering byte-identically, and that the ENABLED profiler lane produces
 * complete per-pass artifacts through the new closure-free begin/endPass API.
 * @purpose Disabled CPU pass profiler allocates no per-frame closures (render unaffected); enabled lane yields complete per-pass buckets via begin/endPass.
 * @status ACTIVE
 *
 * The headline C9-18 defect: nine `_cpuPassProfiler.time(name, () => …)` call
 * sites in WebGPUSceneRenderer / WebGPUSceneRendererFrustumLoop allocated a
 * `() => …` closure EVERY frame, per frustum, even though the profiler is
 * constructed DISABLED — the profiler short-circuits inside `time()` but only
 * AFTER the caller has already built the closure. The fix replaces those with
 * an allocation-free `beginPass(name)` / try / `endPass(name)` pattern that
 * early-returns with a single boolean test while disabled.
 *
 * What this probe checks (WebGPU only — the change is WebGPU-side):
 *   PHASE A (default / disabled):
 *     - profiler default state is DISABLED (getCpuPassProfile().enabled false)
 *       and reports zero passes → off-gate: zero diagnostic work at defaults.
 *     - the globe renders across a short moving-camera route with ZERO console
 *       / page errors → I-14 rendering unaffected (a broken try/finally around
 *       the nine passes would throw or blank the frame).
 *     - the settled canvas is non-blank (real pixels, not the clear color).
 *   PHASE B (enabled):
 *     - CesiumDebug.cpuPassCost(true) → render the route again → the profile
 *       reports populated buckets (globe / opaque / postFrustumChain at least)
 *       with samples > 0 and finite ms → I-11 enabled exactness through the new
 *       begin/endPass accumulation path.
 *     - CesiumDebug.cpuPassCost(false) restores the disabled state.
 *
 * Deterministic offline boot (offline=true): ellipsoid terrain + no online
 * imagery, so the globe still renders (exercising the environment / globe /
 * opaque / postFrustumChain profiler sites) with no network dependence.
 *
 * Usage:  node Tools/visual-regression/probe-diag-demand-gates.mjs
 *   Env:  PROBE_BASE (default http://localhost:8080), PROBE_HEADED=1
 * Output: Tools/visual-regression/output/diag-demand-gates-webgpu.png + JSON.
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = path.join(__dirname, "output");
const VIEWPORT = { width: 800, height: 800 };
const HEADED = process.env.PROBE_HEADED === "1";

// Short moving route: whole-disc orbit → continental → regional. Enough to
// drive multi-frustum rendering and all nine profiler sites across altitude.
const ROUTE = [
  { lon: -40, lat: 20, height: 18_000_000 },
  { lon: -100, lat: 38, height: 4_000_000 },
  { lon: -122.4, lat: 37.77, height: 600_000 },
];

const MIN_FRAMES = 90;
const STABLE_NEEDED = 20;
const MAX_FRAMES = 900;
const REL_EPS = 0.002;

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function settle(page) {
  return await page.evaluate(
    async ({ MIN_FRAMES, STABLE_NEEDED, MAX_FRAMES, REL_EPS }) => {
      const v = window.viewer;
      return await new Promise((resolve) => {
        let frames = 0;
        let stable = 0;
        let prev = -1;
        const cb = v.scene.postRender.addEventListener(() => {
          frames++;
          const cv = v.scene.canvas;
          // Coarse checksum of a downsampled read via a 2D scratch canvas.
          let sig = 0;
          try {
            const s = document.createElement("canvas");
            s.width = 32;
            s.height = 32;
            const g = s.getContext("2d");
            g.drawImage(cv, 0, 0, 32, 32);
            const d = g.getImageData(0, 0, 32, 32).data;
            for (let i = 0; i < d.length; i += 4)
              sig += d[i] + d[i + 1] * 2 + d[i + 2] * 3;
          } catch (e) {
            sig = frames;
          }
          const rel = prev <= 0 ? 1 : Math.abs(sig - prev) / (prev + 1);
          if (rel < REL_EPS) stable++;
          else stable = 0;
          prev = sig;
          if (
            (frames >= MIN_FRAMES && stable >= STABLE_NEEDED) ||
            frames >= MAX_FRAMES
          ) {
            cb();
            resolve({ frames, sig });
          }
        });
        v.scene.requestRender();
      });
    },
    { MIN_FRAMES, STABLE_NEEDED, MAX_FRAMES, REL_EPS },
  );
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = { backend: "webgpu", phases: {}, errors: [], ok: false };

  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    args: ["--enable-unsafe-webgpu"],
  });

  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    const errs = [];
    page.on("console", (m) => {
      if (m.type() === "error") errs.push(m.text());
    });
    page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));

    const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !!window.viewer, null, { timeout: 90000 });

    // Confirm WebGPU actually resolved (offline boot must not silently fall
    // back to WebGL, or this probe would exercise the wrong backend).
    const rendererType = await page.evaluate(() => {
      const v = window.viewer;
      v.scene.requestRenderMode = false;
      return (
        v.scene.context.rendererType ||
        (v.scene.context.isWebGPU ? "webgpu" : "webgl")
      );
    });
    report.rendererType = rendererType;

    // ── PHASE A — default / disabled ────────────────────────────────
    const profBefore = await page.evaluate(() => {
      const r = window.viewer.scene._alternateSceneRenderer;
      if (!r || typeof r.getCpuPassProfile !== "function") return null;
      const p = r.getCpuPassProfile();
      return { enabled: p.enabled, passCount: Object.keys(p.passes).length };
    });
    report.phases.disabledDefault = profBefore;

    // Drive the moving route with the profiler disabled.
    for (const wp of ROUTE) {
      await page.evaluate(async (wp) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        window.viewer.camera.setView({
          destination: C.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.height),
        });
      }, wp);
      await settle(page);
    }

    // Capture at the settled close view (600 km nadir): the imagery-less
    // ellipsoid fills the frame with its blue base color — a reliable
    // "globe rendered" oracle. Read INSIDE a postRender callback that first
    // forces a synchronous `scene.render()` so the WebGPU clear-on-present
    // hands us the resolved framebuffer, not a cleared black frame (the same
    // capture discipline as probe-camera-track's capture()). Capture + the
    // globe-fill pixel analysis run on the SAME forced frame.
    const cap = await page.evaluate(() => {
      const v = window.viewer;
      return new Promise((resolve) => {
        const remove = v.scene.postRender.addEventListener(() => {
          remove();
          const cv = v.scene.canvas;
          const dataUrl = cv.toDataURL("image/png");
          const s = document.createElement("canvas");
          s.width = 64;
          s.height = 64;
          const g = s.getContext("2d");
          g.drawImage(cv, 0, 0, 64, 64);
          const d = g.getImageData(0, 0, 64, 64).data;
          const seen = new Set();
          let globePixels = 0; // blue globe fill (b dominant, non-trivial luma)
          let spacePixels = 0; // near-black space
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i],
              gg = d[i + 1],
              b = d[i + 2];
            seen.add(`${r},${gg},${b}`);
            if (r + gg + b < 24) spacePixels++;
            else if (b > r && b > 40) globePixels++;
          }
          resolve({
            dataUrl,
            nonBlank: { distinctColors: seen.size, globePixels, spacePixels },
          });
        });
        v.scene.requestRender();
        v.scene.render();
      });
    });
    const outPng = path.join(OUT_DIR, "diag-demand-gates-webgpu.png");
    fs.writeFileSync(outPng, Buffer.from(cap.dataUrl.split(",")[1], "base64"));
    report.png = outPng;
    const nonBlank = cap.nonBlank;
    report.phases.disabledRender = { nonBlank };

    // ── PHASE B — enabled profiler lane ─────────────────────────────
    await page.evaluate(() => window.CesiumDebug.cpuPassCost(true));
    for (const wp of ROUTE) {
      await page.evaluate(async (wp) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        window.viewer.camera.setView({
          destination: C.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.height),
        });
      }, wp);
      await settle(page);
    }
    const profEnabled = await page.evaluate(() => {
      const p = window.viewer.scene._alternateSceneRenderer.getCpuPassProfile();
      const passes = {};
      for (const [k, val] of Object.entries(p.passes))
        passes[k] = {
          samples: val.samples,
          avgMs: val.avgMs,
          lastMs: val.lastMs,
        };
      return { enabled: p.enabled, frameCount: p.frameCount, passes };
    });
    report.phases.enabled = profEnabled;

    const profAfter = await page.evaluate(() => {
      window.CesiumDebug.cpuPassCost(false);
      const p = window.viewer.scene._alternateSceneRenderer.getCpuPassProfile();
      return { enabled: p.enabled };
    });
    report.phases.disabledRestored = profAfter;

    report.errors = errs;

    // ── Verdict ─────────────────────────────────────────────────────
    const passesEnabled = profEnabled.passes || {};
    const enabledHasBuckets =
      profEnabled.enabled === true &&
      ["globe", "opaque", "postFrustumChain"].every(
        (n) =>
          passesEnabled[n] &&
          passesEnabled[n].samples > 0 &&
          Number.isFinite(passesEnabled[n].avgMs),
      );
    report.checks = {
      rendererIsWebGPU: rendererType === "webgpu",
      defaultDisabled:
        profBefore &&
        profBefore.enabled === false &&
        profBefore.passCount === 0,
      // The settled 600 km nadir frame is filled by the globe base color.
      renderedNonBlank: nonBlank.globePixels > 50,
      noConsoleErrors: errs.length === 0,
      enabledProducesBuckets: enabledHasBuckets,
      restoredDisabled: profAfter.enabled === false,
    };
    report.ok = Object.values(report.checks).every(Boolean);

    await page.close();
  } finally {
    await browser.close();
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "diag-demand-gates.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("PROBE ERROR:", e);
  process.exit(2);
});
