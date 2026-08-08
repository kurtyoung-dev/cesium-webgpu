#!/usr/bin/env node
// capture-readme-screenshots.mjs — one command that produces every image the
// README's feature table references, into Documentation/Images/webgpu-fork/.
//
//   node Tools/readme-screenshots/capture-readme-screenshots.mjs
//   node Tools/readme-screenshots/capture-readme-screenshots.mjs --only celestial-moon
//   node Tools/readme-screenshots/capture-readme-screenshots.mjs --list
//
// WHAT DRIVES WHAT. `Tools/readme-screenshots/scenes.json` is the manifest:
// one entry per README row, naming the scene that renders that feature and the
// file it writes. Three scene kinds:
//
//   sandcastle — a fork gallery demo, addressed by its
//                `packages/sandcastle/gallery/<folder>` name and resolved to
//                the standalone `Apps/Sandcastle/gallery/<legacyId>` page the
//                probe fleet already drives.
//   viewer     — `Apps/CesiumViewer/index.html?renderer=webgpu` plus a
//                DECLARATIVE scene spec: pinned clock, camera, engine settings,
//                local tileset/model content, debug calls.
//   page       — any other fork page (the split-screen comparison harness).
//
// WHY THE VIEWER SPEC IS DATA AND NOT A CLOSURE. `page.evaluate` serialises its
// argument and DROPS closures — a helper captured from module scope is simply
// not there in the page. Every viewer scene is therefore expressed as JSON that
// one in-page interpreter walks. That also makes the manifest auditable by
// `capture-readme-screenshots.spec.mjs` without a browser.
//
// WHY A SETTING IS READ BACK AFTER IT IS WRITTEN. The failure this repo keeps
// paying for is not a crash, it is a confident wrong answer: a probe writes
// `scene.globe.enhancedOcean = true`, the property does not exist under that
// name, nothing throws, and a screenshot of the feature turned OFF is filed as
// evidence that the feature works. Every `settings[]` entry here must resolve
// to an existing parent object AND read back as the value that was written;
// either failure is STRUCTURAL (exit 3), never a silently wrong picture.
//
// WHY EVERY CAPTURE IS A PLAYWRIGHT ELEMENT SCREENSHOT. Reading a WebGPU canvas
// back in-page (`drawImage` into a 2D context) yields transparent pixels even
// within the same task — the compositor path is the only one that sees the
// presented texture. The PNG bytes are decoded in-page afterwards purely to
// compute statistics, which is decoding a file, not sampling a live canvas.
//
// READINESS IS MEASURED, NOT WAITED OUT. A viewer scene renders until the globe
// reports `tilesLoaded` and every added tileset reports ready, stable across
// consecutive frames; a demo scene waits for the fork demos' own
// `window.startupCalled` flag. Both then re-capture on a settle-jitter retry
// loop, because a straggling tile load is not a regression and a blank canvas
// stays blank across every attempt.
//
// Exit codes — the fleet's 0/1/2/3 contract:
//   0 every scene captured and passed its readiness thresholds
//   1 a scene RENDERED but failed: below its pixel thresholds, or console /
//     WebGPU-validation errors
//   2 watchdog fired, or the harness itself threw
//   3 STRUCTURAL — the run could not see its subject at all: the README/manifest
//     cross-check disagrees, a demo or asset is missing, no canvas exists, no
//     WebGPU device was created, or a declared setting could not be applied
//
// Env: PROBE_BASE (default http://localhost:8080)
//      README_SHOTS_WATCHDOG_MS (default 2_400_000)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { IMAGE_DIR, auditContract, resolveScene } from "./lib/readme-table.mjs";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = join(REPO_ROOT, IMAGE_DIR);
const REPORT_DIR = join(HERE, "output");
const WATCHDOG_MS =
  Number.parseInt(process.env.README_SHOTS_WATCHDOG_MS ?? "", 10) || 2_400_000;
const NAV_TIMEOUT_MS = 90_000;
const RETRY_ATTEMPTS = 3;
const RETRY_WAIT_MS = 5_000;

// Unref'd force-exit watchdog. A wedged Edge/WebGPU device must never hold the
// machine; `unref` keeps the timer from being the reason the process stays up.
const watchdog = setTimeout(() => {
  console.error(
    `[readme-screenshots] WATCHDOG FIRED after ${WATCHDOG_MS} ms — forcing exit`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex >= 0 ? (argv[onlyIndex + 1] ?? "") : null;
const listOnly = argv.includes("--list");
const headed = argv.includes("--headed");

// ---------------------------------------------------------------------------
// Contract audit — authoring-time truth before a single pixel is rendered
// ---------------------------------------------------------------------------

const readmeText = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
const manifest = JSON.parse(readFileSync(join(HERE, "scenes.json"), "utf8"));
const audit = auditContract(readmeText, manifest, REPO_ROOT);

if (audit.errors.length > 0) {
  console.error(
    "[readme-screenshots] STRUCTURAL: the README feature table and scenes.json disagree,",
  );
  console.error("  or a scene names a file that is not on disk:");
  for (const error of audit.errors) {
    console.error(`  - ${error}`);
  }
  clearTimeout(watchdog);
  process.exit(3);
}

const allScenes = audit.scenes;
if (listOnly) {
  for (const scene of allScenes) {
    console.log(
      `${scene.id.padEnd(28)} ${scene.kind.padEnd(11)} ${scene.group} / ${scene.row}`,
    );
  }
  clearTimeout(watchdog);
  process.exit(0);
}

const scenes =
  only === null ? allScenes : allScenes.filter((s) => s.id === only);
if (scenes.length === 0) {
  console.error(
    `[readme-screenshots] STRUCTURAL: --only "${only}" matches no scene. Run --list.`,
  );
  clearTimeout(watchdog);
  process.exit(3);
}

// ---------------------------------------------------------------------------
// In-page scene interpreter (a STRING, evaluated in the page)
// ---------------------------------------------------------------------------

/**
 * Apply a declarative viewer scene and render it to readiness.
 *
 * Runs inside the page. Returns a report rather than throwing so a failure to
 * reach the subject is reported as STRUCTURAL instead of as a harness crash.
 *
 * @param {object} spec The manifest scene, serialised.
 * @returns {Promise<object>} Applied settings, readiness state, structural notes.
 */
async function applyViewerScene(spec) {
  const structural = [];
  const applied = [];
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  if (!viewer) {
    return {
      structural: ["window.viewer never appeared"],
      applied,
      ready: false,
    };
  }
  const scene = viewer.scene;

  // Pin the clock AND kill the widget's own render loop. A bare `scene.render()`
  // renders at wall-clock now while the widget loop renders at the pinned time;
  // two different suns then interleave into whatever frame the compositor holds.
  const pinned =
    typeof spec.timeIso === "string"
      ? C.JulianDate.fromIso8601(spec.timeIso)
      : viewer.clock.currentTime.clone();
  viewer.clock.startTime = pinned.clone();
  viewer.clock.stopTime = pinned.clone();
  viewer.clock.currentTime = pinned.clone();
  viewer.clock.shouldAnimate = false;
  viewer.clock.multiplier = 0;
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  const at = () => viewer.clock.currentTime;

  const resolveParent = (root, path) => {
    const parts = path.split(".");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node === null || node === undefined) {
        return null;
      }
      node = node[parts[i]];
    }
    return node ?? null;
  };

  const writeSetting = (root, label, path, value) => {
    const parent = resolveParent(root, path);
    const leaf = path.split(".").pop();
    if (parent === null) {
      structural.push(`${label}: no object at ${path}`);
      return;
    }
    parent[leaf] = value;
    const readBack = parent[leaf];
    const stuck =
      typeof value === "number"
        ? typeof readBack === "number" && Math.abs(readBack - value) <= 1e-6
        : readBack === value;
    if (!stuck) {
      structural.push(
        `${label}: ${path} did not stick (wrote ${JSON.stringify(value)}, read ${JSON.stringify(readBack)})`,
      );
      return;
    }
    applied.push(path);
  };

  for (const setting of spec.settings ?? []) {
    writeSetting(viewer, "settings", setting.path, setting.value);
  }

  // Content: local tilesets / models only. Anything remote would make the
  // screenshot set depend on a network that the run cannot vouch for.
  const tilesets = [];
  let zoomTarget = null;
  for (const item of spec.content ?? []) {
    try {
      if (item.type === "tileset") {
        const tileset = await C.Cesium3DTileset.fromUrl(item.url);
        scene.primitives.add(tileset);
        tilesets.push(tileset);
        for (const setting of item.settings ?? []) {
          writeSetting(
            tileset,
            `content ${item.url}`,
            setting.path,
            setting.value,
          );
        }
        if (item.zoomTo === true) {
          zoomTarget = { kind: "tileset", value: tileset };
        }
      } else {
        const position = C.Cartesian3.fromDegrees(
          item.lon,
          item.lat,
          item.height ?? 0,
        );
        const entity = viewer.entities.add({
          position,
          orientation: C.Transforms.headingPitchRollQuaternion(
            position,
            new C.HeadingPitchRoll(0, 0, 0),
          ),
          model: { uri: item.url, scale: item.scale ?? 1 },
        });
        if (item.zoomTo === true) {
          zoomTarget = { kind: "entity", value: entity };
        }
      }
    } catch (error) {
      structural.push(`content ${item.url} failed to load: ${String(error)}`);
    }
  }

  // Camera. `aim` recipes settle an ephemeris direction first, which a static
  // lon/lat/height cannot express.
  const aim = spec.aim ?? "none";
  let aimReport = null;
  if (aim === "sun-disc" || aim === "moon-disc") {
    try {
      await C.Transforms.preloadIcrfFixed(
        new C.TimeInterval({
          start: C.JulianDate.addDays(pinned, -1, new C.JulianDate()),
          stop: C.JulianDate.addDays(pinned, 1, new C.JulianDate()),
        }),
      );
    } catch {
      // The TEME fallback below is accurate to well under the disc size here.
    }
    const rotation = new C.Matrix3();
    if (!C.defined(C.Transforms.computeIcrfToFixedMatrix(pinned, rotation))) {
      C.Transforms.computeTemeToPseudoFixedMatrix(pinned, rotation);
    }
    const inertial =
      aim === "sun-disc"
        ? C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
            pinned,
            new C.Cartesian3(),
          )
        : C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
            pinned,
            new C.Cartesian3(),
          );
    const fixed = C.Matrix3.multiplyByVector(rotation, inertial, inertial);
    const distance = C.Cartesian3.magnitude(fixed);
    const direction = C.Cartesian3.normalize(fixed, new C.Cartesian3());
    // Sun: stand well back from Earth on the anti-sun side so the disc is alone
    // in frame. Moon: park 20,000 km short of it, the standoff the LOLA-relief
    // probe uses to make a few degrees of terminator tilt readable.
    const standoff = aim === "sun-disc" ? 3.0e7 : 2.0e7;
    const destination =
      aim === "sun-disc"
        ? C.Cartesian3.multiplyByScalar(
            direction,
            -standoff,
            new C.Cartesian3(),
          )
        : C.Cartesian3.multiplyByScalar(
            direction,
            distance - standoff,
            new C.Cartesian3(),
          );
    let up = C.Cartesian3.cross(
      direction,
      C.Cartesian3.UNIT_Z,
      new C.Cartesian3(),
    );
    if (C.Cartesian3.magnitude(up) < 1e-6) {
      up = C.Cartesian3.cross(direction, C.Cartesian3.UNIT_X, up);
    }
    C.Cartesian3.normalize(up, up);
    scene.camera.setView({ destination, orientation: { direction, up } });
    aimReport = { aim, distance };
  } else if (spec.view) {
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        spec.view.lon,
        spec.view.lat,
        spec.view.height,
      ),
      orientation: {
        heading: C.Math.toRadians(spec.view.heading ?? 0),
        pitch: C.Math.toRadians(spec.view.pitch ?? -90),
        roll: C.Math.toRadians(spec.view.roll ?? 0),
      },
    });
  }

  for (const call of spec.calls ?? []) {
    const parent = resolveParent(window, call);
    const leaf = call.split(".").pop();
    if (parent === null || typeof parent[leaf] !== "function") {
      structural.push(`calls: ${call} is not a function on this page`);
      continue;
    }
    try {
      parent[leaf]();
      applied.push(`${call}()`);
    } catch (error) {
      structural.push(`calls: ${call} threw ${String(error)}`);
    }
  }

  // Render to readiness. `zoomTo` needs a frame with a real bounding volume, so
  // it is issued after the first render rather than before it.
  let zoomed = zoomTarget === null;
  let stable = 0;
  let frames = 0;
  const limit = spec.settleFrames ?? 480;
  while (frames < limit && stable < 12) {
    scene.render(at());
    frames++;
    if (!zoomed && frames > 4) {
      try {
        if (zoomTarget.kind === "tileset") {
          scene.camera.viewBoundingSphere(
            zoomTarget.value.boundingSphere,
            new C.HeadingPitchRange(
              C.Math.toRadians(30),
              C.Math.toRadians(-25),
              zoomTarget.value.boundingSphere.radius * 3.2,
            ),
          );
          scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
        } else {
          await viewer.zoomTo(zoomTarget.value);
        }
        zoomed = true;
      } catch (error) {
        structural.push(`zoomTo failed: ${String(error)}`);
        zoomed = true;
      }
    }
    const tilesetsReady = tilesets.every((t) => t.tilesLoaded);
    if (zoomed && scene.globe && scene.globe.tilesLoaded && tilesetsReady) {
      stable++;
    } else if (zoomed && !scene.globe && tilesetsReady) {
      stable++;
    } else {
      stable = 0;
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  // Trailing pinned render so the compositor holds a pinned-time frame for the
  // screenshot below — the widget's own loop is off.
  scene.render(at());

  return {
    structural,
    applied,
    aimReport,
    frames,
    ready: stable >= 12,
    renderer: scene.context?.rendererType ?? null,
    tilesLoaded: scene.globe ? scene.globe.tilesLoaded : null,
  };
}

/**
 * Re-render a viewer scene without re-applying its spec, for capture retries.
 *
 * @param {number} frames Frame count to advance.
 * @returns {Promise<boolean>} True when the scene was re-rendered.
 */
async function renderMoreFrames(frames) {
  const viewer = window.viewer;
  if (!viewer) {
    return false;
  }
  for (let i = 0; i < frames; i++) {
    viewer.scene.render(viewer.clock.currentTime);
    await new Promise((r) => requestAnimationFrame(r));
  }
  viewer.scene.render(viewer.clock.currentTime);
  return true;
}

/**
 * Decode already-captured PNG bytes and summarise them.
 *
 * This decodes a FILE, not a live canvas — the distinction matters, because
 * reading a WebGPU canvas back in-page yields transparent pixels.
 *
 * @param {string} b64 Base64 PNG bytes.
 * @returns {Promise<object>} Pixel statistics.
 */
async function pngStats(b64) {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const total = bitmap.width * bitmap.height;
  let nonBlack = 0;
  const colors = new Set();
  for (let p = 0; p < total; p++) {
    const i = 4 * p;
    if (data[i] > 16 || data[i + 1] > 16 || data[i + 2] > 16) {
      nonBlack++;
    }
    if (p % 997 === 0) {
      colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
    }
  }
  return {
    width: bitmap.width,
    height: bitmap.height,
    nonBlackPct: nonBlack / total,
    distinct: colors.size,
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

// Debug-pragma diagnostics from the unminified dev build are not regressions.
// Anything matching the WebGPU fault regex is collected independently by the
// error gate and stays fatal regardless of this list.
const SUPPRESSED_CONSOLE = [
  /\[WebGPU:/,
  /\[WebGPUPrimitiveCommands\]/,
  /\[CesiumJS:webgpu/,
  /powerPreference option is currently ignored/i,
  /favicon/i,
];

function isExternalResourceFailure(text, locationUrl) {
  if (!/Failed to load resource/i.test(text)) {
    return false;
  }
  return typeof locationUrl === "string" && !locationUrl.startsWith(BASE);
}

/**
 * Capture one scene.
 *
 * @param {import("playwright").Browser} browser Shared browser.
 * @param {object} scene A validated manifest scene.
 * @returns {Promise<object>} Per-scene result record.
 */
async function captureScene(browser, scene) {
  const resolved = resolveScene(scene, REPO_ROOT);
  const record = {
    id: scene.id,
    group: scene.group,
    row: scene.row,
    kind: scene.kind,
    url: `${BASE}${resolved.url}`,
    output: join(IMAGE_DIR, scene.output).replaceAll("\\", "/"),
    ok: false,
    structural: [...resolved.errors],
    errors: [],
    stats: null,
    attempts: 0,
    armedDevices: 0,
    applied: [],
  };
  if (record.structural.length > 0) {
    return record;
  }

  const viewport = scene.viewport ??
    manifest.viewport ?? { width: 1024, height: 576 };
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  const consoleErrors = [];
  const gateConsoleErrors = attachConsoleErrorGate(page);
  page.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }
    const text = message.text();
    if (
      SUPPRESSED_CONSOLE.some((re) => re.test(text)) ||
      isExternalResourceFailure(text, message.location()?.url)
    ) {
      return;
    }
    consoleErrors.push(`console.error: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (error) =>
    consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`),
  );

  await page.addInitScript(errorGateInit);
  // Sandcastle demos keep their viewer in a local const, so there is no global
  // to walk — patching `requestDevice` is the only hook that reaches the device
  // for every kind of page uniformly.
  await page.addInitScript(() => {
    if (typeof GPUAdapter === "undefined") {
      return;
    }
    const original = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await original.apply(this, args);
      try {
        window.__armWebGPUDevice?.(device, "readme-screenshots");
      } catch {
        /* arming must never break the page */
      }
      return device;
    };
  });

  try {
    await page.goto(record.url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    if (scene.kind === "viewer") {
      await page.waitForFunction(() => !!window.viewer, {
        timeout: NAV_TIMEOUT_MS,
      });
      await armWebGPUDevices(page);
      const report = await page.evaluate(applyViewerScene, scene);
      record.applied = report.applied;
      record.renderer = report.renderer;
      record.frames = report.frames;
      record.ready = report.ready;
      record.structural.push(...report.structural);
    } else {
      if (scene.kind === "sandcastle") {
        // Every fork gallery demo sets this at the end of its own startup —
        // a real readiness signal rather than a hopeful sleep.
        await page.waitForFunction(() => window.startupCalled === true, {
          timeout: NAV_TIMEOUT_MS,
        });
      }
      await page.waitForFunction(
        () => {
          const canvas = document.querySelector("canvas");
          return canvas !== null && canvas.width > 0 && canvas.height > 0;
        },
        { timeout: NAV_TIMEOUT_MS },
      );
      await page.waitForTimeout(scene.settleMs ?? 10_000);
    }

    const captureTarget = scene.captureTarget ?? "canvas";
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      record.attempts = attempt;
      let png;
      if (captureTarget === "page") {
        png = await page.screenshot({ type: "png", fullPage: false });
      } else {
        const canvas = await page.$(".cesium-widget canvas");
        if (canvas === null) {
          record.structural.push("no .cesium-widget canvas on the page");
          break;
        }
        png = await canvas.screenshot({ type: "png" });
      }
      writeFileSync(join(OUT_DIR, scene.output), png);
      record.stats = await page.evaluate(pngStats, png.toString("base64"));
      if (
        record.stats.nonBlackPct >= scene.minNonBlackPct &&
        record.stats.distinct >= scene.minDistinct
      ) {
        break;
      }
      if (attempt < RETRY_ATTEMPTS) {
        if (scene.kind === "viewer") {
          await page.evaluate(renderMoreFrames, 120);
        }
        await page.waitForTimeout(RETRY_WAIT_MS);
      }
    }

    // Let asynchronous GPU errors flush: `onuncapturederror` fires after queue
    // validation, so a capture that "succeeded" can still be invalid.
    await page.waitForTimeout(300);
    const gate = await collectGateErrors(page);
    record.armedDevices = gate.armedDevices;
    const fatal = new Set([
      ...consoleErrors,
      ...gateConsoleErrors,
      ...gate.errors,
    ]);
    if (gate.deviceLost) {
      fatal.add(gate.deviceLost);
    }
    record.errors = [...fatal];

    if (gate.armedDevices < 1) {
      record.structural.push(
        "no WebGPU device was created — the page fell back to WebGL, so this is not a WebGPU screenshot",
      );
    }
    const pixelsOK =
      record.stats !== null &&
      record.stats.nonBlackPct >= scene.minNonBlackPct &&
      record.stats.distinct >= scene.minDistinct;
    record.pixelsOK = pixelsOK;
    record.ok =
      pixelsOK && record.errors.length === 0 && record.structural.length === 0;
  } catch (error) {
    record.errors.push(`harness: ${String(error?.message ?? error)}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
  return record;
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

const results = [];
let fatal = null;
const browser = await chromium.launch({
  channel: "msedge",
  headless: !headed,
  args: ["--enable-unsafe-webgpu"],
});
try {
  for (const scene of scenes) {
    const record = await captureScene(browser, scene);
    results.push(record);
    const stats = record.stats;
    const pixelLine = stats
      ? `${(stats.nonBlackPct * 100).toFixed(1)}% non-black (min ${(scene.minNonBlackPct * 100).toFixed(0)}%), ${stats.distinct} distinct (min ${scene.minDistinct}), ${stats.width}x${stats.height}`
      : "NO CAPTURE";
    const verdict =
      record.structural.length > 0 ? "STRUCTURAL" : record.ok ? "OK" : "FAIL";
    console.log(`[${verdict}] ${record.id} — ${record.row}`);
    console.log(`    ${record.url}`);
    console.log(
      `    ${pixelLine}; attempts=${record.attempts}; devices=${record.armedDevices}`,
    );
    for (const note of record.structural) {
      console.log(`    STRUCTURAL: ${note}`);
    }
    for (const error of record.errors) {
      console.log(`    ERROR: ${error}`);
    }
  }
} catch (error) {
  fatal = error;
} finally {
  await browser.close().catch(() => {});
}

const structuralScenes = results.filter((r) => r.structural.length > 0);
const failedScenes = results.filter((r) => r.structural.length === 0 && !r.ok);

writeFileSync(
  join(REPORT_DIR, "readme-screenshots-report.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      base: BASE,
      requested: scenes.length,
      captured: results.filter((r) => r.ok).length,
      structural: structuralScenes.map((r) => r.id),
      failed: failedScenes.map((r) => r.id),
      results,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `\n${results.filter((r) => r.ok).length}/${scenes.length} scenes captured into ${IMAGE_DIR}/`,
);
console.log(
  "report: Tools/readme-screenshots/output/readme-screenshots-report.json",
);

clearTimeout(watchdog);

if (fatal !== null) {
  console.error(`[readme-screenshots] harness threw: ${String(fatal)}`);
  process.exit(2);
}
if (structuralScenes.length > 0) {
  console.error(
    `[readme-screenshots] ${structuralScenes.length} scene(s) could not see their subject: ${structuralScenes.map((r) => r.id).join(", ")}`,
  );
  process.exit(3);
}
if (failedScenes.length > 0) {
  console.error(
    `[readme-screenshots] ${failedScenes.length} scene(s) failed: ${failedScenes.map((r) => r.id).join(", ")}`,
  );
  process.exit(1);
}
process.exit(0);
