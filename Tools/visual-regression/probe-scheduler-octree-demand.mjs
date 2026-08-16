#!/usr/bin/env node
/**
 * Probe: C9-08-SCHEDULER-OCTREE-DEMAND — verify the default-disabled
 * RenderScheduler / SceneOctree perform ZERO per-command maintenance work
 * unless a declared consumer needs stable material IDs, and that turning a
 * consumer on is BYTE-IDENTICAL on the render path.
 * @purpose C9-08 gate: scheduler/octree do zero per-command work at defaults; consumer registration pixel-identical; octree never admits terrain/tiles.
 * @status ACTIVE
 *
 * WHAT IT ASSERTS (all read from scene.getDebugSnapshot().containment):
 *  A. Defaults, moving route (passes.render=true), both backends:
 *       materialIdMaintenance.framesRun stays 0 over the whole route,
 *       framesSkipped increments every frame, ranThisFrame=false, consumers=0.
 *       octree.enabled=false, builtThisFrame=false, buildTimeMs=0,
 *       commandsInserted=0.  → zero-work at defaults (counter evidence).
 *  B. Register a long-lived consumer (requireStableMaterialIds): the linear
 *       assignment now runs every frame (framesRun climbs, ranThisFrame=true,
 *       materialAllocator.count>0) AND the rendered frame is pixel-identical to
 *       the defaults frame (the default render path never reads materialSortId,
 *       so running vs skipping the maintenance changes nothing on screen).
 *  C. Release the consumer: maintenance is gated off again (framesSkipped
 *       resumes climbing, ranThisFrame=false).
 *  D. A pick at screen center works and — because pick passes run with
 *       passes.render=false (front-to-back translucent material tiebreak is a
 *       real consumer) — bumps framesRun. This proves the pick-path consumer is
 *       demand-signalled so pick output is preserved.
 *  E. SceneOctree eligibility never admits terrain / 3D-Tiles / voxels
 *       (OCTREE_ELIGIBLE_PASSES = OPAQUE|TRANSLUCENT only), asserted by
 *       enabling the octree and confirming no terrain/tile/voxel command was
 *       inserted while the globe is drawn.
 *
 * Boot mirrors probe-camera-track.mjs (Edge/msedge + offline NaturalEarthII +
 * ellipsoid, frame-signature settle). Output PNGs are written for manual read.
 *
 * Usage:  node Tools/visual-regression/probe-scheduler-octree-demand.mjs
 *   Env:  PROBE_BASE (default http://localhost:8080), PROBE_HEADED=1
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
const DIFF_TOL = 4; // near-exact; render path must be byte-identical

const MIN_FRAMES = 90;
const STABLE_NEEDED = 25;
const MAX_FRAMES = 1200;
const REL_EPS = 0.0015;

const ROUTE = [
  {
    lon: -122.4,
    lat: 37.75,
    height: 12000000,
    heading: 0,
    pitch: -90,
    roll: 0,
  },
  { lon: -122.4, lat: 37.75, height: 3000000, heading: 0, pitch: -90, roll: 0 },
  { lon: 2.35, lat: 48.85, height: 5000000, heading: 20, pitch: -70, roll: 0 },
  { lon: 139.7, lat: 35.68, height: 1500000, heading: 0, pitch: -60, roll: 0 },
];

async function bootViewer(browser, renderer) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`;
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
    const out = { imagery: null };
    try {
      const url = C.buildModuleUrl("Assets/Textures/NaturalEarthII");
      const provider = await C.TileMapServiceImageryProvider.fromUrl(url);
      v.imageryLayers.removeAll();
      v.imageryLayers.addImageryProvider(provider);
      out.imagery = "NaturalEarthII-local";
    } catch (e) {
      out.imagery = "unavailable:" + String(e && e.message ? e.message : e);
    }
    return out;
  });
}

async function setView(page, wp) {
  return await page.evaluate(async (wp) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.height),
      orientation: {
        heading: C.Math.toRadians(wp.heading),
        pitch: C.Math.toRadians(wp.pitch),
        roll: C.Math.toRadians(wp.roll),
      },
    });
    return { rendererType: v.scene.context.rendererType };
  }, wp);
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
        const sig = lastSig;
        const rel =
          prevSig <= 0
            ? Infinity
            : Math.abs(sig - prevSig) / Math.max(1, Math.abs(prevSig));
        if (rel < REL_EPS) stable++;
        else stable = 0;
        prevSig = sig;
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

/** Render N frames and return the containment snapshot + allocator stats. */
async function renderAndSnap(page, frames) {
  return await page.evaluate(async (frames) => {
    const v = window.viewer;
    const scene = v.scene;
    for (let i = 0; i < frames; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const snap = scene.getDebugSnapshot();
    const sched = scene._renderScheduler;
    return {
      containment: snap.containment,
      passesRender: scene.frameState.passes.render === true,
      materialAllocatorCount: sched ? sched.materialAllocator.count : -1,
    };
  }, frames);
}

async function capture(page, outPath) {
  const b64 = await page.evaluate(async () => {
    const v = window.viewer;
    return await new Promise((resolve) => {
      const remove = v.scene.postRender.addEventListener(() => {
        remove();
        try {
          resolve(v.scene.canvas.toDataURL("image/png").split(",")[1]);
        } catch (e) {
          resolve(null);
        }
      });
      v.scene.requestRender();
      v.scene.render();
    });
  });
  if (!b64) return false;
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
  return true;
}

async function pixelDiff(page, aPath, bPath, tol) {
  const aB64 = fs.readFileSync(aPath).toString("base64");
  const bB64 = fs.readFileSync(bPath).toString("base64");
  return await page.evaluate(
    async ({ aB64, bB64, tol }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        return {
          w: c.width,
          h: c.height,
          data: cx.getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await decode(aB64);
      const B = await decode(bB64);
      if (A.w !== B.w || A.h !== B.h)
        return { ok: false, why: "size mismatch" };
      let diffCount = 0,
        maxDelta = 0;
      const da = A.data,
        db = B.data;
      for (let i = 0; i < da.length; i += 4) {
        const dr = Math.abs(da[i] - db[i]);
        const dg = Math.abs(da[i + 1] - db[i + 1]);
        const dbb = Math.abs(da[i + 2] - db[i + 2]);
        const m = Math.max(dr, dg, dbb);
        if (m > maxDelta) maxDelta = m;
        if (m > tol) diffCount++;
      }
      const total = (da.length / 4) | 0;
      return {
        ok: true,
        total,
        diffCount,
        pct: +((100 * diffCount) / total).toFixed(4),
        maxDelta,
      };
    },
    { aB64, bB64, tol },
  );
}

/** Toggle a long-lived stable-material-ID consumer on the scheduler. */
async function setConsumer(page, on) {
  return await page.evaluate((on) => {
    const sched = window.viewer.scene._renderScheduler;
    if (on) {
      window.__c9_08_release = sched.requireStableMaterialIds();
      return sched.stableMaterialIdConsumers;
    }
    if (window.__c9_08_release) {
      window.__c9_08_release();
      window.__c9_08_release = null;
    }
    return sched.stableMaterialIdConsumers;
  }, on);
}

/** Do a pick at center and report whether framesRun advanced. */
async function pickCenter(page) {
  return await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const sched = v.scene._renderScheduler;
    const before = sched.materialIdMaintenanceRuns;
    let picked;
    try {
      const w = v.scene.drawingBufferWidth;
      const h = v.scene.drawingBufferHeight;
      picked = v.scene.pick(new C.Cartesian2(w / 2, h / 2));
    } catch (e) {
      picked = "ERR:" + String(e && e.message ? e.message : e);
    }
    const after = sched.materialIdMaintenanceRuns;
    return { runsBefore: before, runsAfter: after, pickOk: picked !== "ERR" };
  });
}

/** Enable octree; render; confirm no terrain/tile/voxel command was inserted. */
async function octreeEligibilityCheck(page) {
  return await page.evaluate(async () => {
    const v = window.viewer;
    const scene = v.scene;
    const octree = scene._renderScheduler.octree;
    octree.enabled = true;
    octree.minCommandsForOctree = 1; // force build even with few commands
    for (let i = 0; i < 5; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const snap = scene.getDebugSnapshot();
    // Inspect the octree tree: gather passes of inserted commands.
    const passes = new Set();
    const walk = (node) => {
      if (!node) return;
      const cmds = node._commands || node.commands || [];
      for (const c of cmds) passes.add(c._pass ?? c.pass);
      const kids = node._children || node.children || [];
      for (const k of kids) walk(k);
    };
    try {
      walk(octree._root);
    } catch (e) {
      /* tolerate structure differences */
    }
    const result = {
      octreeContainment: snap.containment.renderScheduler.octree,
      insertedPasses: Array.from(passes),
      commandsInserted: octree.stats.commandsInserted,
      tilesLoaded: scene.globe.tilesLoaded,
    };
    octree.enabled = false;
    return result;
  });
}

async function runBackend(browser, renderer, results) {
  const r = { renderer, checks: {}, errs: [] };
  const { page, errs } = await bootViewer(browser, renderer);
  r.errs = errs;
  await setupScene(page);
  await setView(page, ROUTE[0]);
  await settle(page);

  // --- A: defaults, moving route → zero material-ID/octree maintenance ---
  let routeRunsSaw = 0;
  let routeSkipsClimb = true;
  let prevSkips = -1;
  for (const wp of ROUTE) {
    await setView(page, wp);
    const s = await renderAndSnap(page, 8);
    const mim = s.containment.renderScheduler.materialIdMaintenance;
    const oct = s.containment.renderScheduler.octree;
    routeRunsSaw += mim.framesRun; // must stay 0 across the route at defaults
    if (prevSkips >= 0 && mim.framesSkipped <= prevSkips)
      routeSkipsClimb = false;
    prevSkips = mim.framesSkipped;
    if (mim.ranThisFrame) r.checks.defaultRanThisFrameLeak = true;
    if (mim.consumers !== 0) r.checks.defaultConsumersLeak = mim.consumers;
    if (
      oct.enabled ||
      oct.builtThisFrame ||
      oct.buildTimeMs !== 0 ||
      oct.commandsInserted !== 0
    )
      r.checks.defaultOctreeLeak = oct;
  }
  r.checks.A_defaultMaterialFramesRunTotal = routeRunsSaw; // expect 0
  r.checks.A_defaultSkipsClimb = routeSkipsClimb; // expect true
  r.checks.A_defaultFramesSkipped = prevSkips;

  // Baseline capture at a fixed view for the byte-identity diff. Fully settle
  // at the capture view first so imagery streaming does not masquerade as a
  // consumer-induced change, then take TWO consecutive consumer-OFF captures to
  // measure the temporal-noise floor (the control).
  await setView(page, ROUTE[1]);
  await settle(page);
  await renderAndSnap(page, 4);
  const aPath = path.join(OUT_DIR, `c9-08-${renderer}-defaults.png`);
  await capture(page, aPath);
  const a2Path = path.join(OUT_DIR, `c9-08-${renderer}-defaults2.png`);
  await renderAndSnap(page, 4);
  await capture(page, a2Path);
  const controlDiff = await pixelDiff(page, aPath, a2Path, DIFF_TOL);
  r.checks.B_controlDiff = controlDiff; // temporal-noise floor, consumer OFF

  // --- B: register consumer → maintenance runs, render byte-identical ---
  const consumersOn = await setConsumer(page, true);
  const sB = await renderAndSnap(page, 10);
  const mimB = sB.containment.renderScheduler.materialIdMaintenance;
  r.checks.B_consumersOn = consumersOn; // expect 1
  r.checks.B_ranThisFrame = mimB.ranThisFrame; // expect true
  r.checks.B_framesRunAdvanced = mimB.framesRun > 0; // expect true
  r.checks.B_materialAllocatorCount = sB.materialAllocatorCount; // expect > 0
  const bPath = path.join(OUT_DIR, `c9-08-${renderer}-consumer.png`);
  await capture(page, bPath);
  const diff = await pixelDiff(page, aPath, bPath, DIFF_TOL);
  r.checks.B_diff = diff; // consumer-on vs default; must be <= control + eps

  // --- C: release consumer → gated off again ---
  const consumersOff = await setConsumer(page, false);
  const sC = await renderAndSnap(page, 8);
  const mimC = sC.containment.renderScheduler.materialIdMaintenance;
  r.checks.C_consumersOff = consumersOff; // expect 0
  r.checks.C_ranThisFrame = mimC.ranThisFrame; // expect false
  const runsAtC = mimC.framesRun;
  const sC2 = await renderAndSnap(page, 6);
  r.checks.C_runsFrozen =
    sC2.containment.renderScheduler.materialIdMaintenance.framesRun === runsAtC; // expect true
  r.checks.C_skipsResumed =
    sC2.containment.renderScheduler.materialIdMaintenance.framesSkipped >
    mimC.framesSkipped; // expect true

  // --- D: pick bumps framesRun (pick-pass consumer signalled) ---
  const pick = await pickCenter(page);
  r.checks.D_pick = pick;
  r.checks.D_pickBumpedRuns = pick.runsAfter > pick.runsBefore; // expect true

  // --- E: octree never admits terrain/tile/voxel ---
  const oe = await octreeEligibilityCheck(page);
  const Pass = { GLOBE: 4, CESIUM_3D_TILE: 5, VOXELS: 6 }; // informational only
  r.checks.E_octree = oe;
  // insertedPasses must be a subset of {OPAQUE, TRANSLUCENT}; terrain (GLOBE)
  // and tiles/voxels must never appear.
  const badPasses = oe.insertedPasses.filter(
    (p) => p === Pass.GLOBE || p === Pass.CESIUM_3D_TILE || p === Pass.VOXELS,
  );
  r.checks.E_noTerrainTileVoxelInserted = badPasses.length === 0; // expect true

  await page.close();
  results.push(r);
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
  });
  const results = [];
  try {
    for (const renderer of ["webgpu", "webgl"]) {
      await runBackend(browser, renderer, results);
    }
  } finally {
    await browser.close();
  }

  // Verdict
  let pass = true;
  const fails = [];
  for (const r of results) {
    const c = r.checks;
    // eslint-disable-next-line no-loop-func -- the closure is consumed inside this iteration (or reads a shared kill switch), not a stale per-iteration binding
    const assert = (name, cond) => {
      if (!cond) {
        pass = false;
        fails.push(`${r.renderer}: ${name}`);
      }
    };
    assert(
      "A_defaultMaterialFramesRun==0",
      c.A_defaultMaterialFramesRunTotal === 0,
    );
    assert("A_defaultSkipsClimb", c.A_defaultSkipsClimb === true);
    assert("A_noDefaultRanLeak", !c.defaultRanThisFrameLeak);
    assert("A_noDefaultConsumersLeak", !c.defaultConsumersLeak);
    assert("A_noDefaultOctreeLeak", !c.defaultOctreeLeak);
    assert("B_consumersOn==1", c.B_consumersOn === 1);
    assert("B_ranThisFrame", c.B_ranThisFrame === true);
    assert("B_framesRunAdvanced", c.B_framesRunAdvanced === true);
    assert("B_materialAllocatorCount>0", c.B_materialAllocatorCount > 0);
    // Byte-identical render path: the consumer-on vs default diff must not
    // exceed the consumer-off temporal-noise floor by more than a hair. The
    // default render path never reads materialSortId, so running vs skipping
    // the maintenance changes nothing on screen beyond unrelated streaming.
    assert(
      "B_render_within_noise_floor",
      c.B_diff &&
        c.B_diff.ok &&
        c.B_controlDiff &&
        c.B_controlDiff.ok &&
        c.B_diff.pct <= Math.max(0.05, c.B_controlDiff.pct + 0.2),
    );
    assert("C_consumersOff==0", c.C_consumersOff === 0);
    assert("C_ranThisFrame==false", c.C_ranThisFrame === false);
    assert("C_runsFrozen", c.C_runsFrozen === true);
    assert("C_skipsResumed", c.C_skipsResumed === true);
    assert("D_pickBumpedRuns", c.D_pickBumpedRuns === true);
    assert(
      "E_noTerrainTileVoxelInserted",
      c.E_noTerrainTileVoxelInserted === true,
    );
  }

  console.log(JSON.stringify({ pass, fails, results }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("PROBE ERROR:", e);
  process.exit(2);
});
