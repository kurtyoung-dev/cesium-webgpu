#!/usr/bin/env node
// Probe (DP-H44, Batch 360): WebGPU globe terrain picking, opt-in behind
// `globe.pickable`.
// @purpose Gates opt-in WebGPU globe terrain picking (globe.pickable): default stays unpickable, foreground picks unaffected, WebGL leg unaffected by the flag
// @status ACTIVE
//
// What it asserts (WebGPU leg):
//  1. pickable=false (default): pickAsync over the globe does NOT return the
//     globe (undefined) — WebGL parity.
//  2. pickable=false: a foreground Point primitive in front of the globe IS
//     pickable (the globe stays OUT of the pick pass when not pickable, so it
//     does not occlude foreground primitives — the "didn't break existing
//     picking" regression guard).
//  3. pickable=true: pickAsync over the globe returns an object whose
//     `.primitive === scene.globe`.
//  4. Zero console errors / WebGPU validation errors.
//
// WebGL reference leg:
//  5. pickAsync over the globe returns the globe in NEITHER pickable state
//     (the WebGL globe path has no pick ID — confirms `pickable` is a
//     WebGPU-only opt-in and the WebGL globe is unaffected by the flag).
//
// pickPosition over the globe is covered by probe-pickposition-webgpu.mjs and
// is NOT touched by this change (it reads the main-pass globe-depth texture,
// not the pick FBO).
//
// Uses pickAsync everywhere (sync scene.pick leaves the WebGPU pick buffer
// mapped, breaking subsequent picks — see probe-pick-basic.mjs).
//
// The scene is the rig `globe-pick-h44`.
//
// ON THE SHARED RUNTIME (probe-kit harvest, globe family). The browser, the
// origin (`--port`, a governed Edge port, never 8080), the served-build
// preflight, the Edge slot and the receipt belong to `lib/probe-runtime.mjs`.
// WebGPU validation errors are read from the shared error gate
// (`Tools/lib/webgpu-error-gate.mjs`, the device's `onuncapturederror`), which
// replaces the private `[GPUERR]` console hook this probe installed; console
// errors are still every `console.error` plus page errors, as before. This
// probe captures no pixels.
//
// Usage: node Tools/visual-regression/probe-globe-pick-h44.mjs [--port 8094]
// @runtime lib/probe-runtime.mjs

import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";

const LON = -75.0;
const LAT = 40.0;
const HEIGHT = 2_000_000.0;

async function runLeg(browser, origin, renderer) {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 700 },
  });
  try {
    return await measureLeg(context, origin, renderer);
  } finally {
    await context.close();
  }
}

async function measureLeg(context, origin, renderer) {
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.addInitScript(errorGateInit);

  await page.goto(
    `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    {
      waitUntil: "networkidle",
      timeout: 90000,
    },
  );
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });
  await armWebGPUDevices(page);

  const out = await page.evaluate(
    async ({ LON, LAT, HEIGHT }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      v.terrainProvider = new C.EllipsoidTerrainProvider();
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(LON, LAT, HEIGHT),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const center = new C.Cartesian2(
        Math.floor(scene.canvas.clientWidth / 2),
        Math.floor(scene.canvas.clientHeight / 2),
      );
      const renderN = async (n) => {
        for (let i = 0; i < n; i++) {
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      };
      const describePick = (p) => {
        if (!C.defined(p)) return { defined: false };
        return {
          defined: true,
          isGlobe: p.primitive === scene.globe,
          primCtor: p.primitive?.constructor?.name ?? null,
          id: typeof p.id === "string" ? p.id : (p.id?.id ?? null),
        };
      };
      const pickStable = async () => {
        let last;
        for (let i = 0; i < 8; i++) {
          scene.render();
          const r = await scene.pickAsync(center, 3, 3);
          if (C.defined(r)) return describePick(r);
          last = r;
          await new Promise((rr) => requestAnimationFrame(rr));
        }
        return describePick(last);
      };

      await renderN(150);

      // ── A) pickable=false (default): globe NOT picked ──
      scene.globe.pickable = false;
      await renderN(3);
      const pickGlobeFalse = await pickStable();

      // ── B) pickable=false: foreground point IS pickable (regression guard) ──
      v.entities.add({
        id: "fg-point",
        position: C.Cartesian3.fromDegrees(LON, LAT, 500_000.0),
        point: {
          pixelSize: 40,
          color: C.Color.YELLOW,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      await renderN(5);
      const pickPoint = await pickStable();
      v.entities.removeById("fg-point");
      await renderN(3);

      // ── C) pickable=true: globe IS picked ──
      scene.globe.pickable = true;
      await renderN(5);
      const pickGlobeTrue = await pickStable();

      return {
        rendererType: scene.context?.rendererType,
        pickGlobeFalse,
        pickPoint,
        pickGlobeTrue,
      };
    },
    { LON, LAT, HEIGHT },
  );

  const gate = await collectGateErrors(page);
  const gpuErrors = [
    ...gate.errors,
    ...(gate.deviceLost ? [gate.deviceLost] : []),
  ];
  return { ...out, errors: [...errors], gpuErrors };
}

function printLeg(name, leg) {
  console.log(`\n=== ${name} (${leg.rendererType}) ===`);
  console.log(`  pickable=false globe : ${JSON.stringify(leg.pickGlobeFalse)}`);
  console.log(`  pickable=false point : ${JSON.stringify(leg.pickPoint)}`);
  console.log(`  pickable=true  globe : ${JSON.stringify(leg.pickGlobeTrue)}`);
  console.log(
    `  console errors: ${leg.errors.length}  gpuErrors: ${leg.gpuErrors.length}`,
  );
  leg.errors.slice(0, 6).forEach((e) => console.log("   ERR:", e));
  leg.gpuErrors.slice(0, 4).forEach((e) => console.log("   ", e));
}
/**
 * The DP-H44 clauses over one run's two legs, with the original bars: on
 * WebGPU the default leaves the globe unpicked, a foreground point stays
 * pickable, `pickable=true` returns the globe, and there are no console or
 * validation errors; on WebGL the globe is never returned in either state, the
 * point is pickable, and there are no console errors.
 *
 * Pure and exported so `globe-probe-verdicts.spec.mjs` can drive every clause
 * without a browser.
 *
 * @param {Array<{run: number, webgl: object, webgpu: object}>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluatePickH44(cells) {
  const verdicts = [];
  for (const { run, webgl, webgpu } of cells) {
    const suffix = `run${run}`;
    const pointOk = (leg) =>
      leg.pickPoint.defined === true && leg.pickPoint.id === "fg-point";
    verdicts.push(
      {
        id: `webgpu-default-unpickable/${suffix}`,
        claim: "WebGPU pickable=false does not return the globe",
        pass: !webgpu.pickGlobeFalse.isGlobe,
        detail: { pick: webgpu.pickGlobeFalse },
      },
      {
        id: `webgpu-foreground-point-pickable/${suffix}`,
        claim: "WebGPU foreground point pickable with pickable=false",
        pass: pointOk(webgpu),
        detail: { pick: webgpu.pickPoint },
      },
      {
        id: `webgpu-pickable-returns-globe/${suffix}`,
        claim: "WebGPU pickable=true returns the globe",
        pass:
          webgpu.pickGlobeTrue.defined === true &&
          webgpu.pickGlobeTrue.isGlobe === true,
        detail: { pick: webgpu.pickGlobeTrue },
      },
      {
        id: `webgpu-console-errors/${suffix}`,
        claim: `WebGPU console errors: ${webgpu.errors.length}`,
        pass: webgpu.errors.length === 0,
        detail: { errors: webgpu.errors.slice(0, 6) },
      },
      {
        id: `webgpu-validation-errors/${suffix}`,
        claim: `WebGPU validation errors: ${webgpu.gpuErrors.length}`,
        pass: webgpu.gpuErrors.length === 0,
        detail: { errors: webgpu.gpuErrors.slice(0, 4) },
      },
      {
        id: `webgl-never-returns-globe/${suffix}`,
        claim: "WebGL never returns the globe from scene.pick",
        pass: !webgl.pickGlobeFalse.isGlobe && !webgl.pickGlobeTrue.isGlobe,
        detail: { off: webgl.pickGlobeFalse, on: webgl.pickGlobeTrue },
      },
      {
        id: `webgl-foreground-point-pickable/${suffix}`,
        claim: "WebGL foreground point pickable",
        pass: pointOk(webgl),
        detail: { pick: webgl.pickPoint },
      },
      {
        id: `webgl-console-errors/${suffix}`,
        claim: `WebGL console errors: ${webgl.errors.length}`,
        pass: webgl.errors.length === 0,
        detail: { errors: webgl.errors.slice(0, 6) },
      },
    );
  }
  return verdicts;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "globe-pick-h44",
  title: "DP-H44 — opt-in WebGPU globe terrain picking (globe.pickable)",
  outputSubdirectory: "globe-pick-h44",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  // The CesiumViewer page and every in-page import here read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  async cells({ browser, run, options, origin }) {
    if (
      !options.renderers.includes("webgl") ||
      !options.renderers.includes("webgpu")
    ) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "DP-H44 judges the WebGPU opt-in against the WebGL reference leg, so " +
          `both renderers are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const webgl = await runLeg(browser, origin, "webgl");
    const webgpu = await runLeg(browser, origin, "webgpu");
    printLeg("WebGL", webgl);
    printLeg("WebGPU", webgpu);
    return [{ run, webgl, webgpu }];
  },
  verdicts(cells) {
    return evaluatePickH44(cells);
  },
  receipt(cells, context) {
    for (const verdict of context.verdicts) {
      console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    }
    return { cells, verdicts: context.verdicts };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
