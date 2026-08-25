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
 *       assignment now runs every frame (framesRun climbs, ranThisFrame=true).
 *       The allocator grows when commands expose a key it can use; a backend
 *       with no keyable commands is reported as structural. The rendered frame
 *       remains pixel-identical to the defaults frame because the default
 *       render path never reads materialSortId.
 *  C. Release the consumer: maintenance is gated off again (framesSkipped
 *       resumes climbing, ranThisFrame=false).
 *  D. A pick at screen center works and — because pick passes run with
 *       passes.render=false (front-to-back translucent material tiebreak is a
 *       real consumer) — bumps framesRun. This proves the pick-path consumer is
 *       demand-signalled so pick output is preserved.
 *  E. SceneOctree eligibility never admits terrain / 3D-Tiles / voxels, and a
 *       stable indexed command subsequence above the full-list threshold renders
 *       byte-identically OFF / ON / restored-OFF while the unchanged ON frame
 *       skips rebuilding.
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

import { exitCodeForS5Status } from "./lib/verdict-exit-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = path.join(__dirname, "output");
const VIEWPORT = { width: 800, height: 800 };
const HEADED = process.env.PROBE_HEADED === "1";
const DIFF_TOL = 4; // near-exact; render path must be byte-identical
const MAX_OCTREE_FIXTURE_COMMANDS = 512;
const WATCHDOG_MS = 600_000;

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
    const commands = scene.frameState.commandList;
    const defined = (value) => value !== undefined && value !== null;
    let keyableCommandCount = 0;
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      if (
        defined(command._shaderProgram) ||
        defined(command.shaderProgram?.id) ||
        defined(command.pipeline)
      ) {
        keyableCommandCount++;
      }
    }
    return {
      commandCount: commands.length,
      containment: snap.containment,
      keyableCommandCount,
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

async function captureCanvasElement(page, outPath) {
  const canvas = page.locator(".cesium-widget canvas").first();
  await canvas.screenshot({ path: outPath });
  return true;
}

async function presentSettle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
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
      const aData = A.data,
        bData = B.data;
      for (let i = 0; i < aData.length; i += 4) {
        const dr = Math.abs(aData[i] - bData[i]);
        const dg = Math.abs(aData[i + 1] - bData[i + 1]);
        const db = Math.abs(aData[i + 2] - bData[i + 2]);
        const da = Math.abs(aData[i + 3] - bData[i + 3]);
        const m = Math.max(dr, dg, db, da);
        if (m > maxDelta) maxDelta = m;
        if (m > tol) diffCount++;
      }
      const total = (aData.length / 4) | 0;
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

/** Create separate primitives so the fixture emits more than 200 commands. */
async function prepareOctreeParityFixture(page) {
  return await page.evaluate(
    async ({ maxFixtureCommands }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const octree = scene._renderScheduler.octree;
      const originalEnabled = octree.enabled;
      const originalMinCommandsForOctree = octree.minCommandsForOctree;
      const originalUseDefaultRenderLoop = v.useDefaultRenderLoop;
      const threshold = octree.minCommandsForOctree;
      const thresholdValid =
        Number.isInteger(threshold) && threshold >= 1 && threshold < Infinity;
      const fixtureCount = thresholdValid ? Math.max(201, threshold + 17) : 0;
      const primitives = [];
      const allowedPasses =
        Number.isFinite(C.Pass?.OPAQUE) && Number.isFinite(C.Pass?.TRANSLUCENT)
          ? [C.Pass.OPAQUE, C.Pass.TRANSLUCENT]
          : [];

      v.useDefaultRenderLoop = false;
      octree.enabled = false;
      window.__octreeDemandFixture = {
        allowedPasses,
        originalEnabled,
        originalMinCommandsForOctree,
        originalUseDefaultRenderLoop,
        primitives,
      };

      if (
        !thresholdValid ||
        fixtureCount <= threshold ||
        fixtureCount > maxFixtureCommands
      ) {
        return {
          counterAvailable:
            (octree.stats.rebuilds === undefined ||
              Number.isFinite(octree.stats.rebuilds)) &&
            (octree.stats.rebuildSkips === undefined ||
              Number.isFinite(octree.stats.rebuildSkips)),
          fixtureCommandCount: 0,
          fixtureCount,
          fullCommandCount: 0,
          indexedCommandCount: 0,
          firstInstability: {
            condition: "fixturePreparationUnavailable",
            field: thresholdValid ? "fixtureCommandCount" : "threshold",
            index: -1,
            pairPosition: "none",
            resolvedPass: null,
          },
          passAvailable: allowedPasses.length === 2,
          stableFrames: 0,
          threshold,
          thresholdValid: false,
        };
      }

      for (let i = 0; i < fixtureCount; i++) {
        const column = i % 18;
        const row = Math.floor(i / 18);
        const longitude = -123.08 + column * 0.08;
        const latitude = 37.31 + row * 0.08;
        const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
          C.Cartesian3.fromDegrees(longitude, latitude, 1500),
        );
        const geometry = C.BoxGeometry.fromDimensions({
          dimensions: new C.Cartesian3(3000, 3000, 3000),
          vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
        });
        const geometryInstance = new C.GeometryInstance({
          geometry,
          modelMatrix,
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              i % 2 === 0 ? C.Color.CYAN : C.Color.MAGENTA,
            ),
          },
        });
        primitives.push(
          scene.primitives.add(
            new C.Primitive({
              allowPicking: false,
              appearance: new C.PerInstanceColorAppearance({
                closed: true,
                flat: true,
                translucent: false,
              }),
              asynchronous: false,
              geometryInstances: geometryInstance,
            }),
          ),
        );
      }

      const isOctreeIndexedCommand = (command) =>
        command._moonPhysicalDepthRoute !== true &&
        command.boundingVolume !== undefined &&
        command.boundingVolume !== null &&
        allowedPasses.includes(command._pass ?? command.pass);
      const takeIndexedSnapshot = (commands) =>
        commands.filter(isOctreeIndexedCommand).map((command) => {
          const boundingVolume = command.boundingVolume;
          const center = boundingVolume?.center;
          const matrix = command.modelMatrix;
          const matrixValues = matrix
            ? Array.from({ length: 16 }, (_, index) => matrix[index])
            : [];
          const stableSphere =
            !boundingVolume ||
            (Number.isFinite(center?.x) &&
              Number.isFinite(center?.y) &&
              Number.isFinite(center?.z) &&
              Number.isFinite(boundingVolume.radius));
          const stableMatrix =
            !matrix || matrixValues.every((value) => Number.isFinite(value));
          return {
            boundingVolume,
            center,
            centerX: center?.x,
            centerY: center?.y,
            centerZ: center?.z,
            command,
            cull: command.cull,
            matrix,
            matrixValues,
            moonPhysicalDepthRoute: command._moonPhysicalDepthRoute === true,
            occlude: command.occlude,
            pass: command._pass ?? command.pass,
            radius: boundingVolume?.radius,
            stableShape: stableSphere && stableMatrix,
            visibilityMask: command.visibilityMask,
          };
        });
      const indexedSnapshotFields = [
        "boundingVolume",
        "center",
        "centerX",
        "centerY",
        "centerZ",
        "command",
        "cull",
        "matrix",
        "matrixValues",
        "moonPhysicalDepthRoute",
        "occlude",
        "pass",
        "radius",
        "stableShape",
        "visibilityMask",
      ];
      const describeIndexedInstability = (
        index,
        field,
        entry,
        details = {},
      ) => {
        const instability = {
          index,
          field,
          resolvedPass: entry?.pass ?? null,
          ...details,
        };
        const owner = entry?.command?.owner;
        if (owner !== undefined && owner !== null) {
          instability.ownerConstructorName = owner.constructor?.name ?? null;
        }
        return instability;
      };
      const firstIndexedInstability = (left, right) => {
        const sharedLength = Math.min(left.length, right.length);
        for (let index = 0; index < sharedLength; index++) {
          const entry = left[index];
          const other = right[index];
          for (const field of indexedSnapshotFields) {
            const same =
              field === "matrixValues"
                ? entry.matrixValues.length === other.matrixValues.length &&
                  entry.matrixValues.every(
                    (value, matrixIndex) =>
                      value === other.matrixValues[matrixIndex],
                  )
                : entry[field] === other[field];
            if (!same) {
              return describeIndexedInstability(index, field, other);
            }
          }
        }
        if (left.length !== right.length) {
          return describeIndexedInstability(
            sharedLength,
            "length",
            right[sharedLength] ?? left[sharedLength],
          );
        }
        return undefined;
      };
      const sameIndexedSnapshot = (left, right) =>
        firstIndexedInstability(left, right) === undefined;

      let previousIndexed = [];
      let stableFrames = 0;
      let fixtureCommands = [];
      let currentIndexed = [];
      let finalPairInstability;
      let fixtureReady = false;
      let fullCommandCount = 0;
      let indexedListReady = false;
      let lastIndexedMismatch;
      for (let i = 0; i < 60; i++) {
        scene.render();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        fixtureCommands = primitives.flatMap((primitive) =>
          primitive._colorCommands.filter(Boolean),
        );
        const commands = scene.frameState.commandList;
        fullCommandCount = commands.length;
        currentIndexed = takeIndexedSnapshot(commands);
        fixtureReady =
          fixtureCommands.length > threshold &&
          fixtureCommands.every(
            (command) =>
              isOctreeIndexedCommand(command) &&
              Number.isFinite(command.boundingVolume?.center?.x) &&
              Number.isFinite(command.boundingVolume?.center?.y) &&
              Number.isFinite(command.boundingVolume?.center?.z) &&
              Number.isFinite(command.boundingVolume?.radius),
          );
        indexedListReady = currentIndexed.every((entry) => entry.stableShape);
        const snapshotsMatch =
          i > 0 && sameIndexedSnapshot(previousIndexed, currentIndexed);
        const indexedMismatch =
          i > 0 && !snapshotsMatch
            ? firstIndexedInstability(previousIndexed, currentIndexed)
            : undefined;
        finalPairInstability = indexedMismatch
          ? {
              ...indexedMismatch,
              comparedSamples: { previous: i, current: i + 1 },
              condition: "indexedSnapshotMismatch",
            }
          : undefined;
        if (finalPairInstability) {
          lastIndexedMismatch = finalPairInstability;
        }
        stableFrames =
          fixtureReady && indexedListReady && snapshotsMatch
            ? stableFrames + 1
            : 0;
        previousIndexed = currentIndexed;
        if (stableFrames >= 2) {
          break;
        }
      }

      const describeReadinessFailure = () => {
        if (!fixtureReady) {
          const details = {
            condition: "fixtureNotReady",
            finalPairMatched: true,
            pairPosition: "none",
          };
          if (fixtureCommands.length <= threshold) {
            return describeIndexedInstability(
              -1,
              "fixtureCommandCount",
              undefined,
              details,
            );
          }
          for (let index = 0; index < fixtureCommands.length; index++) {
            const command = fixtureCommands[index];
            const boundingVolume = command.boundingVolume;
            const center = boundingVolume?.center;
            let field;
            if (command._moonPhysicalDepthRoute === true) {
              field = "_moonPhysicalDepthRoute";
            } else if (
              boundingVolume === undefined ||
              boundingVolume === null
            ) {
              field = "boundingVolume";
            } else if (!allowedPasses.includes(command._pass ?? command.pass)) {
              field = "pass";
            } else if (!Number.isFinite(center?.x)) {
              field = "center.x";
            } else if (!Number.isFinite(center?.y)) {
              field = "center.y";
            } else if (!Number.isFinite(center?.z)) {
              field = "center.z";
            } else if (!Number.isFinite(boundingVolume.radius)) {
              field = "radius";
            }
            if (field) {
              return describeIndexedInstability(
                index,
                field,
                { command, pass: command._pass ?? command.pass },
                details,
              );
            }
          }
          return describeIndexedInstability(
            -1,
            "fixtureReady",
            undefined,
            details,
          );
        }
        if (!indexedListReady) {
          const index = currentIndexed.findIndex((entry) => !entry.stableShape);
          return describeIndexedInstability(
            index,
            "stableShape",
            currentIndexed[index],
            {
              condition: "indexedShapeNotReady",
              finalPairMatched: true,
              pairPosition: "none",
            },
          );
        }
        return describeIndexedInstability(
          currentIndexed.length > 0 ? 0 : -1,
          "stableFrames",
          currentIndexed[0],
          {
            condition: "insufficientStableFrames",
            finalPairMatched: true,
            observedStableFrames: stableFrames,
            pairPosition: "none",
            requiredStableFrames: 2,
          },
        );
      };
      let firstInstability = null;
      if (stableFrames < 2) {
        if (finalPairInstability) {
          firstInstability = {
            ...finalPairInstability,
            fixtureReady,
            indexedListReady,
            pairPosition: "final",
          };
        } else if (!fixtureReady || !indexedListReady) {
          firstInstability = describeReadinessFailure();
        } else if (lastIndexedMismatch) {
          firstInstability = {
            ...lastIndexedMismatch,
            finalPairMatched: true,
            fixtureReady,
            indexedListReady,
            pairPosition: "prior",
          };
        } else {
          firstInstability = describeReadinessFailure();
        }
      }

      return {
        counterAvailable:
          (octree.stats.rebuilds === undefined ||
            Number.isFinite(octree.stats.rebuilds)) &&
          (octree.stats.rebuildSkips === undefined ||
            Number.isFinite(octree.stats.rebuildSkips)),
        firstInstability,
        fixtureCommandCount: fixtureCommands.length,
        fixtureCount,
        fixtureReady,
        fullCommandCount,
        indexedCommandCount: currentIndexed.length,
        indexedListReady,
        passAvailable: allowedPasses.length === 2,
        stableFrames,
        threshold,
        thresholdValid: true,
      };
    },
    { maxFixtureCommands: MAX_OCTREE_FIXTURE_COMMANDS },
  );
}

/** Render one controlled frame and read the tree before another frame starts. */
async function sampleOctreeFrame(page, enabled) {
  return await page.evaluate(async (enabled) => {
    const scene = window.viewer.scene;
    const octree = scene._renderScheduler.octree;
    if (typeof enabled === "boolean") {
      octree.enabled = enabled;
    }
    scene.render();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const fixture = window.__octreeDemandFixture;
    const fixturePrimitives = new Set(fixture?.primitives ?? []);
    const snap = scene.getDebugSnapshot();
    const passes = new Set();
    let fixtureCommandsInserted = 0;
    const walk = (node) => {
      if (!node) return;
      const cmds = node._commands || node.commands || [];
      for (const command of cmds) {
        passes.add(command._pass ?? command.pass);
        if (fixturePrimitives.has(command.owner)) {
          fixtureCommandsInserted++;
        }
      }
      const kids = node._children || node.children || [];
      for (const k of kids) walk(k);
    };
    walk(octree._root);
    return {
      allowedPasses: fixture?.allowedPasses ?? [],
      commandsInserted: octree.stats.commandsInserted,
      fixtureCommandsInserted,
      insertedPasses: Array.from(passes),
      octreeContainment: snap.containment.renderScheduler.octree,
      rebuildSkips: octree.stats.rebuildSkips,
      rebuilds: octree.stats.rebuilds,
      tilesLoaded: scene.globe.tilesLoaded,
    };
  }, enabled);
}

async function readOctreeCounters(page) {
  return await page.evaluate(() => {
    const stats = window.viewer.scene._renderScheduler.octree.stats;
    return {
      rebuildSkips: stats.rebuildSkips ?? 0,
      rebuilds: stats.rebuilds ?? 0,
    };
  });
}

async function disableOctreeAndSample(page) {
  return await page.evaluate(async () => {
    const scene = window.viewer.scene;
    const octree = scene._renderScheduler.octree;
    const rebuildSkipsBeforeDisable = octree.stats.rebuildSkips;
    const rebuildsBeforeDisable = octree.stats.rebuilds;
    octree.enabled = false;
    scene.render();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      rebuildSkipsAfterDisabledFrame: octree.stats.rebuildSkips,
      rebuildSkipsBeforeDisable,
      rebuildsAfterDisabledFrame: octree.stats.rebuilds,
      rebuildsBeforeDisable,
    };
  });
}

async function removeOctreeParityFixture(page) {
  await page.evaluate(() => {
    const scene = window.viewer.scene;
    const octree = scene._renderScheduler.octree;
    const fixture = window.__octreeDemandFixture;
    if (!fixture) return;
    octree.enabled = fixture.originalEnabled;
    octree.minCommandsForOctree = fixture.originalMinCommandsForOctree;
    for (const primitive of fixture.primitives) {
      scene.primitives.remove(primitive);
    }
    delete window.__octreeDemandFixture;
    window.viewer.useDefaultRenderLoop = fixture.originalUseDefaultRenderLoop;
  });
}

/** Exercise eligibility, unchanged rebuild skip, and OFF/ON/restored parity. */
async function octreeEligibilityAndParityCheck(page, renderer) {
  let preparation;
  try {
    preparation = await prepareOctreeParityFixture(page);
    await renderAndSnap(page, 4);
    const offPath = path.join(OUT_DIR, `octree-${renderer}-off.png`);
    const onPath = path.join(OUT_DIR, `octree-${renderer}-on.png`);
    const restoredPath = path.join(
      OUT_DIR,
      `octree-${renderer}-off-restored.png`,
    );
    await presentSettle(page);
    await captureCanvasElement(page, offPath);

    const countersBeforeOn = await readOctreeCounters(page);
    const firstOnFrame = await sampleOctreeFrame(page, true);
    const unchangedOnFrame = await sampleOctreeFrame(page);
    await renderAndSnap(page, 2);
    await presentSettle(page);
    await captureCanvasElement(page, onPath);

    const disabledFrame = await disableOctreeAndSample(page);
    await renderAndSnap(page, 3);
    await presentSettle(page);
    await captureCanvasElement(page, restoredPath);

    return {
      countersBeforeOn,
      disabledFrame,
      firstOnFrame,
      offOnDiff: await pixelDiff(page, offPath, onPath, 0),
      offRestoredDiff: await pixelDiff(page, offPath, restoredPath, 0),
      preparation,
      rebuildSkipDelta:
        unchangedOnFrame.rebuildSkips - firstOnFrame.rebuildSkips,
      unchangedOnFrame,
    };
  } finally {
    await removeOctreeParityFixture(page);
  }
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
  r.checks.B_commandCount = sB.commandCount;
  r.checks.B_keyableCommandCount = sB.keyableCommandCount;
  r.checks.B_materialAllocatorCount = sB.materialAllocatorCount;
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

  // --- E: >threshold eligibility, rebuild skip, and OFF/ON/restored parity ---
  // Attribute only errors raised by this case.
  const errsBeforeE = errs.length;
  const oe = await octreeEligibilityAndParityCheck(page, renderer);
  r.checks.E_octree = oe;
  const badPasses = oe.firstOnFrame.insertedPasses.filter(
    (pass) => !oe.firstOnFrame.allowedPasses.includes(pass),
  );
  r.checks.E_noTerrainTileVoxelInserted = badPasses.length === 0; // expect true
  r.checks.E_noPageErrors = errs.length === errsBeforeE;

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
  const structuralReasons = [];
  for (const r of results) {
    const c = r.checks;
    // eslint-disable-next-line no-loop-func -- the closure is consumed inside this iteration (or reads a shared kill switch), not a stale per-iteration binding
    const assert = (name, cond) => {
      if (!cond) {
        pass = false;
        fails.push(`${r.renderer}: ${name}`);
      }
    };
    const structural = (name, cond) => {
      if (!cond) {
        structuralReasons.push(`${r.renderer}: ${name}`);
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
    assert("B_commandsObserved", c.B_commandCount > 0);
    if (c.B_keyableCommandCount > 0) {
      assert("B_materialAllocatorCount>0", c.B_materialAllocatorCount > 0);
    } else {
      structural("B_no_keyable_commands", false);
    }
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
    structural(
      "E_fixture_stable_above_threshold",
      c.E_octree.preparation.thresholdValid === true &&
        c.E_octree.preparation.fixtureCommandCount > 200 &&
        c.E_octree.preparation.fixtureCommandCount >
          c.E_octree.preparation.threshold &&
        c.E_octree.preparation.fullCommandCount >
          c.E_octree.preparation.threshold &&
        c.E_octree.preparation.stableFrames >= 2,
    );
    structural(
      "E_pass_and_skip_counter_available",
      c.E_octree.preparation.passAvailable === true &&
        c.E_octree.preparation.counterAvailable === true &&
        c.E_octree.firstOnFrame.allowedPasses.length === 2 &&
        Number.isFinite(c.E_octree.firstOnFrame.rebuilds) &&
        Number.isFinite(c.E_octree.firstOnFrame.rebuildSkips),
    );
    structural(
      "E_fixture_inserted_above_threshold",
      c.E_octree.firstOnFrame.fixtureCommandsInserted >
        c.E_octree.preparation.threshold,
    );
    assert(
      "E_first_frame_rebuilt",
      c.E_octree.firstOnFrame.rebuilds ===
        c.E_octree.countersBeforeOn.rebuilds + 1,
    );
    assert(
      "E_unchanged_rebuild_skipped",
      c.E_octree.unchangedOnFrame.rebuilds ===
        c.E_octree.firstOnFrame.rebuilds && c.E_octree.rebuildSkipDelta === 1,
    );
    assert(
      "E_disabled_frame_did_no_octree_work",
      c.E_octree.disabledFrame.rebuildSkipsAfterDisabledFrame ===
        c.E_octree.disabledFrame.rebuildSkipsBeforeDisable &&
        c.E_octree.disabledFrame.rebuildsAfterDisabledFrame ===
          c.E_octree.disabledFrame.rebuildsBeforeDisable,
    );
    assert("E_no_page_errors", c.E_noPageErrors === true);
    assert(
      "E_off_restored_byte_identity",
      c.E_octree.offRestoredDiff?.ok === true &&
        c.E_octree.offRestoredDiff.diffCount === 0 &&
        c.E_octree.offRestoredDiff.maxDelta === 0,
    );
    assert(
      "E_off_on_byte_identity",
      c.E_octree.offOnDiff?.ok === true &&
        c.E_octree.offOnDiff.diffCount === 0 &&
        c.E_octree.offOnDiff.maxDelta === 0,
    );
  }

  const status =
    structuralReasons.length > 0 ? "STRUCTURAL" : pass ? "PASS" : "FAIL";
  console.log(
    JSON.stringify(
      { status, pass, fails, structuralReasons, results },
      null,
      2,
    ),
  );
  return status;
}

const watchdog = setTimeout(() => {
  console.error(
    `[probe-scheduler-octree-demand] watchdog fired after ${WATCHDOG_MS} ms`,
  );
  process.exit(exitCodeForS5Status("ERROR"));
}, WATCHDOG_MS);

main()
  .then((status) => {
    process.exitCode = exitCodeForS5Status(status);
  })
  .catch((error) => {
    console.error("PROBE ERROR:", error);
    process.exitCode = exitCodeForS5Status("ERROR");
  })
  .finally(() => clearTimeout(watchdog));
