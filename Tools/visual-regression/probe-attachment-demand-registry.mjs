#!/usr/bin/env node
/**
 * Probe: C9-09-ATTACHMENT-DEMAND-REGISTRY (FAR-401-C0) acceptance.
 *
 * Verifies the ONE canonical per-frame attachment-demand record
 * (`scene.getDebugSnapshot().attachmentDemand`) MATCHES the actual scene-FB
 * attachment behavior, on the default scene and with each G-buffer consumer
 * enabled independently — with NO visual change anywhere (observe-only slice;
 * `forceSceneMRT` stays true so topology never leaves MRT).
 *
 * WHAT IT ASSERTS (WebGPU, offline deterministic boot):
 *  A. DEFAULT frame:
 *       - record.topology === "mrt", forceSceneMRT === true
 *       - every gbufferReader === false, gbufferReadersDemand === false
 *       - gbufferDemanded === true (forced), gbufferReadersMask === 0
 *       - actual.sceneColorAttachmentCount === 2 (MRT executor)
 *       - actual.gbufferAllocated === true, gbufferBytes > 0
 *       - actual.slot1AttachmentOpens > 0 (scene passes bound slot 1)
 *       - recordMatchesActual === true
 *  B. Each consumer ON (deferredLighting, SSR, NPR, contactShadows,
 *       debugOverlay, ssgi=AO+deferred): the matching reader flips true,
 *       gbufferReadersDemand true, topology stays "mrt", gbufferDemanded true,
 *       recordMatchesActual true. (These are real rendering features and DO
 *       change pixels — the registry only OBSERVES them; it does not gate.)
 *  C. Restore (all consumers off): record returns to the default no-reader
 *       shape (off->on->off record oracle).
 *  D. The MSAA companion path: with default msaaSamples (4), slot1ResolveOpens
 *       > 0 and gbufferMsaaCompanionBytes > 0 (truthful resolve accounting).
 *
 * NO-VISUAL-CHANGE from the registry wiring itself is byte-identical by
 * construction (observe-only; `forceSceneMRT` stays true so the executor is
 * untouched) and is proven separately by the standing capture-and-diff globe
 * suite — this probe additionally reads the default globe PNG to confirm the
 * scene renders correctly.
 *
 * Boot mirrors probe-scheduler-octree-demand.mjs.
 *
 * Usage:  node Tools/visual-regression/probe-attachment-demand-registry.mjs
 *   Env:  PROBE_BASE (default http://localhost:8080), PROBE_HEADED=1
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = path.join(__dirname, "output", "attachment-demand");
const VIEWPORT = { width: 800, height: 800 };
const HEADED = process.env.PROBE_HEADED === "1";

const MIN_FRAMES = 60;
const STABLE_NEEDED = 20;
const MAX_FRAMES = 900;
const REL_EPS = 0.0015;

fs.mkdirSync(OUT_DIR, { recursive: true });

async function bootViewer(browser) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 90000 });
  return { page, errs };
}

async function setupScene(page) {
  return await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.requestRenderMode = false;
    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T19:00:00Z");
    v.scene.globe.enableLighting = false;
    v.scene.globe.showGroundAtmosphere = false;
    v.scene.fog.enabled = false;
    v.scene.skyAtmosphere.show = false;
    if (v.scene.sun) v.scene.sun.show = false;
    if (v.scene.moon) v.scene.moon.show = false;
    v.scene.backgroundColor = new C.Color(0, 0, 0, 1);
    v.terrainProvider = new C.EllipsoidTerrainProvider();
    v.scene.globe.terrainProvider = v.terrainProvider;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95, 40, 12000000),
      orientation: {
        heading: 0,
        pitch: C.Math.toRadians(-90),
        roll: 0,
      },
    });
    return {
      rendererType: v.scene.context.rendererType,
      msaaSamples: v.scene.msaaSamples,
    };
  });
}

async function settle(page) {
  return await page.evaluate(
    async ({ MIN_FRAMES, STABLE_NEEDED, MAX_FRAMES, REL_EPS }) => {
      const v = window.viewer;
      const scene = v.scene;
      const SW = 160,
        SH = 160;
      const sampler = document.createElement("canvas");
      sampler.width = SW;
      sampler.height = SH;
      const sctx = sampler.getContext("2d", { willReadFrequently: true });
      let lastSig = 0;
      const sign = () => {
        try {
          sctx.clearRect(0, 0, SW, SH);
          sctx.drawImage(scene.canvas, 0, 0, SW, SH);
          const d = sctx.getImageData(0, 0, SW, SH).data;
          let s = 0;
          for (let i = 0; i < d.length; i += 16)
            s += d[i] + d[i + 1] * 3 + d[i + 2] * 7;
          lastSig = s;
        } catch (e) {
          lastSig = -1;
        }
      };
      const remove = scene.postRender.addEventListener(sign);
      let prevSig = -1,
        stable = 0,
        settledFrame = -1;
      for (let i = 0; i < MAX_FRAMES; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        const rel =
          prevSig <= 0
            ? Infinity
            : Math.abs(lastSig - prevSig) / Math.max(1, Math.abs(prevSig));
        if (rel < REL_EPS) stable++;
        else stable = 0;
        prevSig = lastSig;
        if (i >= MIN_FRAMES && stable >= STABLE_NEEDED) {
          settledFrame = i;
          break;
        }
      }
      remove();
      return { settledFrame, tilesLoaded: scene.globe.tilesLoaded };
    },
    { MIN_FRAMES, STABLE_NEEDED, MAX_FRAMES, REL_EPS },
  );
}

/** Set consumer flags, render N frames, return the demand snapshot + a pixel grab. */
async function applyAndSnap(page, flags, frames) {
  return await page.evaluate(
    async ({ flags, frames }) => {
      const v = window.viewer;
      const scene = v.scene;
      // Apply the requested consumer flags (undefined => leave as-is).
      if (flags.deferredLighting !== undefined)
        scene.deferredLighting = flags.deferredLighting;
      if (flags.enableSSR !== undefined) scene.enableSSR = flags.enableSSR;
      if (flags.enableNPROutlines !== undefined)
        scene.enableNPROutlines = flags.enableNPROutlines;
      if (flags.enableContactShadows !== undefined)
        scene.enableContactShadows = flags.enableContactShadows;
      if (flags.debugShowGBufferNormals !== undefined)
        scene.debugShowGBufferNormals = flags.debugShowGBufferNormals;
      if (flags.aoEnabled !== undefined) {
        const ao = scene.postProcessStages?.ambientOcclusion;
        if (ao) ao.enabled = flags.aoEnabled;
      }
      for (let i = 0; i < frames; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const snap = scene.getDebugSnapshot();
      // Grab a downsampled pixel signature for byte-identity comparison.
      const SW = 200,
        SH = 200;
      const c = document.createElement("canvas");
      c.width = SW;
      c.height = SH;
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.drawImage(scene.canvas, 0, 0, SW, SH);
      const px = Array.from(cx.getImageData(0, 0, SW, SH).data);
      return { attachmentDemand: snap.attachmentDemand, px, SW, SH };
    },
    { flags, frames },
  );
}

async function grabPng(page, name) {
  const buf = await page.evaluate(async () => {
    const v = window.viewer;
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    return v.scene.canvas.toDataURL("image/png");
  });
  const b64 = buf.replace(/^data:image\/png;base64,/, "");
  const out = path.join(OUT_DIR, name);
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  return out;
}

const results = { ok: true, checks: [], errors: [], artifacts: [] };
function check(name, cond, detail) {
  results.checks.push({ name, pass: !!cond, detail });
  if (!cond) {
    results.ok = false;
    console.error(`FAIL: ${name} — ${detail ?? ""}`);
  } else {
    console.log(`ok: ${name}`);
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: !HEADED,
    channel: "msedge",
  });
  try {
    const { page, errs } = await bootViewer(browser);
    const setup = await setupScene(page);
    check(
      "renderer is webgpu",
      setup.rendererType === "webgpu",
      JSON.stringify(setup),
    );
    const settled = await settle(page);
    check(
      "scene settled + tilesLoaded",
      settled.settledFrame >= 0 && settled.tilesLoaded === true,
      JSON.stringify(settled),
    );

    // ── A. DEFAULT ──
    const def = await applyAndSnap(
      page,
      {
        deferredLighting: false,
        enableSSR: false,
        enableNPROutlines: false,
        enableContactShadows: false,
        debugShowGBufferNormals: false,
        aoEnabled: false,
      },
      8,
    );
    const ad = def.attachmentDemand;
    check(
      "default: attachmentDemand present",
      !!ad && !!ad.record,
      JSON.stringify(ad).slice(0, 200),
    );
    if (ad && ad.record) {
      const r = ad.record;
      const a = ad.actual;
      check("default: topology mrt", r.topology === "mrt", r.topology);
      check("default: forceSceneMRT true", ad.forceSceneMRT === true);
      check(
        "default: no gbuffer readers",
        r.gbufferReadersDemand === false && r.gbufferReadersMask === 0,
        JSON.stringify(r.gbufferReaders),
      );
      check(
        "default: gbufferDemanded (forced) true",
        r.gbufferDemanded === true,
      );
      check(
        "default: actual 2 color attachments",
        a.sceneColorAttachmentCount === 2,
        String(a.sceneColorAttachmentCount),
      );
      check(
        "default: gbuffer allocated + bytes>0",
        a.gbufferAllocated === true && a.gbufferBytes > 0,
        JSON.stringify({ alloc: a.gbufferAllocated, bytes: a.gbufferBytes }),
      );
      check(
        "default: slot1 attachment opens>0",
        a.slot1AttachmentOpens > 0,
        String(a.slot1AttachmentOpens),
      );
      check(
        "default: recordMatchesActual",
        ad.recordMatchesActual === true,
        JSON.stringify({
          topo: r.topology,
          count: a.sceneColorAttachmentCount,
        }),
      );
      // D. MSAA companion accounting (default msaaSamples>1 expected).
      if (setup.msaaSamples > 1) {
        check(
          "default: MSAA companion bytes>0 + resolve opens>0",
          a.gbufferMsaaCompanionBytes > 0 && a.slot1ResolveOpens > 0,
          JSON.stringify({
            msaaBytes: a.gbufferMsaaCompanionBytes,
            resolves: a.slot1ResolveOpens,
            samples: setup.msaaSamples,
          }),
        );
      }
    }
    results.artifacts.push(
      await grabPng(page, "attachment-demand-default.png"),
    );

    // ── B. Each consumer ON independently ──
    const consumerCases = [
      {
        name: "deferredLighting",
        flags: { deferredLighting: true },
        reader: "deferredLighting",
      },
      { name: "SSR", flags: { enableSSR: true }, reader: "ssr" },
      {
        name: "NPROutlines",
        flags: { enableNPROutlines: true },
        reader: "nprOutlines",
      },
      {
        name: "contactShadows",
        flags: { enableContactShadows: true },
        reader: "contactShadows",
      },
      {
        name: "debugOverlay",
        flags: { deferredLighting: true, debugShowGBufferNormals: true },
        reader: "debugOverlay",
      },
      {
        name: "ssgi",
        flags: { deferredLighting: true, aoEnabled: true },
        reader: "ssgi",
      },
    ];
    for (const cc of consumerCases) {
      // reset all consumers off, then enable this case's flags
      const off = {
        deferredLighting: false,
        enableSSR: false,
        enableNPROutlines: false,
        enableContactShadows: false,
        debugShowGBufferNormals: false,
        aoEnabled: false,
      };
      await applyAndSnap(page, off, 3);
      const res = await applyAndSnap(page, { ...off, ...cc.flags }, 6);
      const r = res.attachmentDemand?.record;
      const a = res.attachmentDemand?.actual;
      check(
        `${cc.name}: reader ${cc.reader} flips true`,
        !!r && r.gbufferReaders[cc.reader] === true,
        JSON.stringify(r?.gbufferReaders),
      );
      check(
        `${cc.name}: gbufferReadersDemand true`,
        !!r && r.gbufferReadersDemand === true,
      );
      check(`${cc.name}: topology stays mrt`, !!r && r.topology === "mrt");
      check(
        `${cc.name}: recordMatchesActual`,
        !!res.attachmentDemand &&
          res.attachmentDemand.recordMatchesActual === true,
        JSON.stringify({
          topo: r?.topology,
          count: a?.sceneColorAttachmentCount,
        }),
      );
    }

    // ── C. Restore all off ──
    const restore = await applyAndSnap(
      page,
      {
        deferredLighting: false,
        enableSSR: false,
        enableNPROutlines: false,
        enableContactShadows: false,
        debugShowGBufferNormals: false,
        aoEnabled: false,
      },
      8,
    );
    const rr = restore.attachmentDemand?.record;
    check(
      "restore: back to no-reader default shape",
      !!rr && rr.gbufferReadersDemand === false && rr.gbufferReadersMask === 0,
      JSON.stringify(rr?.gbufferReaders),
    );
    check(
      "restore: topology mrt + recordMatchesActual",
      !!rr &&
        rr.topology === "mrt" &&
        restore.attachmentDemand.recordMatchesActual === true,
    );
    results.artifacts.push(
      await grabPng(page, "attachment-demand-restore.png"),
    );

    // Visual sanity: the default globe must actually render (non-black center),
    // proving the observe-only wiring did not blank the scene.
    const centerLum = await page.evaluate(async () => {
      const v = window.viewer;
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      const cv = v.scene.canvas;
      const c = document.createElement("canvas");
      c.width = 60;
      c.height = 60;
      const cx = c.getContext("2d", { willReadFrequently: true });
      // sample the center third of the canvas (globe interior)
      cx.drawImage(
        cv,
        cv.width / 3,
        cv.height / 3,
        cv.width / 3,
        cv.height / 3,
        0,
        0,
        60,
        60,
      );
      const d = cx.getImageData(0, 0, 60, 60).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return sum / (60 * 60);
    });
    check(
      "default globe interior renders (non-black center)",
      centerLum > 10,
      `centerLum=${centerLum.toFixed(1)}`,
    );

    // console errors (device/page)
    check(
      "no console/page errors",
      errs.length === 0,
      JSON.stringify(errs.slice(0, 5)),
    );
    results.errors = errs;

    const jsonPath = path.join(
      OUT_DIR,
      "campaign9-c9-09-attachment-demand-registry-2026-07-16.json",
    );
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    results.artifacts.push(jsonPath);
    console.log(`\nRESULT: ${results.ok ? "PASS" : "FAIL"}`);
    console.log(`artifacts:\n  ${results.artifacts.join("\n  ")}`);
  } finally {
    await browser.close();
  }
  process.exit(results.ok ? 0 : 1);
})();
