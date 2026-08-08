#!/usr/bin/env node
// capture-readme-screenshots.mjs — one command that produces every image the
// README's feature table references, into Documentation/Images/webgpu-fork/.
//
//   node Tools/readme-screenshots/capture-readme-screenshots.mjs
//   node Tools/readme-screenshots/capture-readme-screenshots.mjs --only celestial-moon
//   node Tools/readme-screenshots/capture-readme-screenshots.mjs --force
//   node Tools/readme-screenshots/capture-readme-screenshots.mjs --list
//
// WHAT DRIVES WHAT. `Tools/readme-screenshots/scenes.json` is the manifest:
// one entry per README row, naming the scene that renders that feature and the
// file it writes. Three scene kinds:
//
//   sandcastle — a fork gallery demo, addressed by its
//                `packages/sandcastle/gallery/<folder>` name and resolved to
//                the standalone `Apps/Sandcastle/gallery/<legacyId>` page.
//   viewer     — `Apps/CesiumViewer/index.html?renderer=webgpu` plus a
//                DECLARATIVE scene spec: pinned clock, camera, engine settings,
//                local tileset/model content, debug calls.
//   page       — any other fork page (the split-screen comparison harness).
//
// WHY THE DEMO PAGES NEED A LOADER FROM HERE. `Apps/Sandcastle/gallery/*.html`
// is still served — the dev server publishes the whole repo root as static
// files — but the two scripts every page references, `Sandcastle-header.js` and
// `load-cesium-es6.js`, were deleted with the legacy Sandcastle app. The third
// script tag carries `nomodule`, so a module-capable browser skips it too.
// Nothing then defines `Cesium`, the page's own `if (typeof Cesium !==
// "undefined")` tail never fires, and the page sits inert with an empty body.
// `legacySandcastleLoader` re-creates the deleted `Sandcastle` global before the
// page's scripts run, and `bootLegacyDemo` re-creates the module loader: import
// the engine bundle, publish it as `window.Cesium`, then call the demo's own
// `window.startup`. AWAITING that promise is a stronger readiness signal than
// the deleted loader ever had — it never set `window.startupCalled` at all on
// the module path, so waiting for that flag could only ever time out.
//
// WHY THE VIEWER SPEC IS DATA AND NOT A CLOSURE. `page.evaluate` serialises its
// argument and DROPS closures — a helper captured from module scope is simply
// not there in the page. Every viewer scene is therefore expressed as JSON that
// one in-page interpreter walks. That also makes the manifest auditable by
// `capture-readme-screenshots.spec.mjs` without a browser.
//
// WHY ENTITY CONTENT IS DRIVEN BY HAND. Entity visualizers are built inside the
// widget's clock tick, and pinning the clock turns that loop off. A scene that
// only calls `scene.render()` therefore renders a globe with no model on it,
// and `viewer.zoomTo(entity)` — whose promise settles in `scene.postRender` —
// can never settle from inside a loop that is awaiting it. The settle loop
// updates `dataSourceDisplay` itself and frames entities from their bounding
// sphere, so neither the missing model nor the deadlock can come back.
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
// TIME IS BOUNDED PER SCENE, NOT PER RUN. Every wait below is clamped to what
// is left of the scene's budget, and a scene whose URL does not answer is
// rejected by an HTTP pre-flight in milliseconds rather than by a 90-second
// wait for a page that will never load. The watchdog is then sized from the
// scene count, and prints what it captured and what it still owes.
//
// RESUMING. A scene whose PNG is already on disk at nonzero size is skipped by
// default, so an interrupted run is resumed by re-issuing the same command.
// `--force` re-captures everything; `--only <id>` always re-captures that one.
//
// Exit codes — the fleet's 0/1/2/3 contract:
//   0 every scene captured and passed its readiness thresholds
//   1 a scene RENDERED but failed: below its pixel thresholds, or console /
//     WebGPU-validation errors
//   2 watchdog fired, or the harness itself threw
//   3 STRUCTURAL — the run could not see its subject at all: the README/manifest
//     cross-check disagrees, a demo or asset is missing, a URL does not answer,
//     no canvas exists, no WebGPU device was created, or a declared setting
//     could not be applied
//
// Env: PROBE_BASE (default http://localhost:8080)
//      README_SHOTS_SCENE_BUDGET_MS (default 90_000)
//      README_SHOTS_WATCHDOG_MS (default: sized from the scene count)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  ENGINE_MODULE_URL,
  IMAGE_DIR,
  auditContract,
  resolveScene,
} from "./lib/readme-table.mjs";
import {
  DEFAULT_SCENE_BUDGET_MS,
  computeWatchdogMs,
  describeProgress,
  planRun,
  readPriorFailures,
} from "./lib/capture-plan.mjs";
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
const SCENE_BUDGET_MS =
  Number.parseInt(process.env.README_SHOTS_SCENE_BUDGET_MS ?? "", 10) ||
  DEFAULT_SCENE_BUDGET_MS;
const WATCHDOG_OVERRIDE_MS =
  Number.parseInt(process.env.README_SHOTS_WATCHDOG_MS ?? "", 10) || 0;

// A URL that does not answer is decided by the pre-flight, so the in-page waits
// below only ever cover a page that IS being served. They are ceilings for a
// slow load, not the mechanism that detects a dead route.
const PREFLIGHT_TIMEOUT_MS = 8_000;
const NAV_TIMEOUT_MS = 45_000;
const READY_TIMEOUT_MS = 30_000;
const RETRY_ATTEMPTS = 3;
const RETRY_WAIT_MS = 2_000;
// Reserved out of each scene's budget for the capture itself: screenshot,
// in-page decode, GPU-error flush and teardown.
const CAPTURE_RESERVE_MS = 20_000;

const results = [];
let planned = [];
let skippedScenes = [];
let watchdog = null;

/**
 * Arm the force-exit watchdog, replacing any previously armed one.
 *
 * A wedged Edge/WebGPU device must never hold the machine; `unref` keeps the
 * timer from being the reason the process stays up. The delay is re-armed once
 * the scene list is known, because a watchdog sized from a constant turns "this
 * manifest grew" into "this run failed".
 *
 * @param {number} delayMs Milliseconds before the process is force-exited.
 * @returns {void}
 */
function armWatchdog(delayMs) {
  if (watchdog !== null) {
    clearTimeout(watchdog);
  }
  watchdog = setTimeout(() => {
    console.error(
      `[readme-screenshots] WATCHDOG FIRED after ${delayMs} ms — forcing exit`,
    );
    for (const line of describeProgress({
      planned,
      results,
      skipped: skippedScenes,
    })) {
      console.error(`[readme-screenshots] ${line}`);
    }
    process.exit(2);
  }, delayMs);
  watchdog.unref?.();
}

// Bootstrap window: covers the contract audit and the browser launch, before
// the scene count is known. Re-armed from the plan below.
armWatchdog(computeWatchdogMs({ sceneCount: 0 }));

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex >= 0 ? (argv[onlyIndex + 1] ?? "") : null;
const listOnly = argv.includes("--list");
const headed = argv.includes("--headed");
// Resuming is the default: an interrupted run is finished by re-issuing the
// same command. `--force` is the way to re-capture images that already exist.
const skipExisting = !(
  argv.includes("--force") || argv.includes("--no-skip-existing")
);

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

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

const REPORT_PATH = join(REPORT_DIR, "readme-screenshots-report.json");
const plan = planRun({
  scenes: allScenes,
  only,
  skipExisting,
  outDir: OUT_DIR,
  priorFailures: readPriorFailures(REPORT_PATH),
});
if (plan.errors.length > 0) {
  for (const error of plan.errors) {
    console.error(`[readme-screenshots] STRUCTURAL: ${error}`);
  }
  clearTimeout(watchdog);
  process.exit(3);
}

planned = plan.run;
skippedScenes = plan.skipped;
for (const scene of skippedScenes) {
  console.log(
    `[SKIP] ${scene.id} — ${IMAGE_DIR}/${scene.output} already exists (${scene.existingBytes} bytes); pass --force to re-capture`,
  );
}
if (planned.length === 0) {
  console.log(
    `\n0/0 scenes needed capture; ${skippedScenes.length} already present in ${IMAGE_DIR}/`,
  );
  clearTimeout(watchdog);
  process.exit(0);
}

const watchdogMs =
  WATCHDOG_OVERRIDE_MS > 0
    ? WATCHDOG_OVERRIDE_MS
    : computeWatchdogMs({
        sceneCount: planned.length,
        sceneBudgetMs: SCENE_BUDGET_MS,
      });
armWatchdog(watchdogMs);
console.log(
  `[readme-screenshots] ${planned.length} scene(s) to capture; ${SCENE_BUDGET_MS} ms each, watchdog ${watchdogMs} ms`,
);

// ---------------------------------------------------------------------------
// Pre-flight — is the subject even being served?
// ---------------------------------------------------------------------------

/**
 * Ask the dev server for a URL and report whether it answers.
 *
 * This is the difference between a dead route costing milliseconds and costing
 * a full readiness timeout. It is also the fastest way to learn that the dev
 * server is not running at all, which would otherwise be paid once per scene.
 *
 * @param {string} url Absolute URL.
 * @returns {Promise<{ok: boolean, status: number, error: (string|null)}>} Result.
 */
async function urlAnswers(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return { ok: response.ok, status: response.status, error: null };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) };
  }
}

// Both scene kinds import the engine bundle, so a bundle the dev server cannot
// build is 39 identical failures. Deciding it once, here, costs one request.
const enginePreflight = await urlAnswers(`${BASE}${ENGINE_MODULE_URL}`);
if (!enginePreflight.ok) {
  console.error(
    `[readme-screenshots] STRUCTURAL: ${BASE}${ENGINE_MODULE_URL} does not answer (status ${enginePreflight.status}${enginePreflight.error ? `, ${enginePreflight.error}` : ""}) — is the dev server running?`,
  );
  clearTimeout(watchdog);
  process.exit(3);
}

// ---------------------------------------------------------------------------
// In-page loader for the standalone demo pages (STRINGS, evaluated in the page)
// ---------------------------------------------------------------------------

/**
 * Re-create the `Sandcastle` global the deleted `Sandcastle-header.js` provided.
 *
 * Installed with `addInitScript`, so it exists before the page's own inline
 * script runs. The behaviour that matters for a screenshot is the default
 * action: a menu's first entry is what the demo means by "the state to look at",
 * and `finishedLoading` is where the deleted header invoked it. A stub that
 * merely swallowed these calls would photograph an empty scene for every demo
 * whose content is built inside a menu handler.
 *
 * @returns {void}
 */
function legacySandcastleLoader() {
  window.CESIUM_BASE_URL = "/Build/CesiumUnminified/";
  let defaultAction;
  const toolbarFor = (toolbarId) =>
    document.getElementById(toolbarId || "toolbar") ?? document.body;
  window.Sandcastle = {
    declare() {},
    highlight() {},
    reset() {},
    finishedLoading() {
      window.Sandcastle.reset();
      if (defaultAction) {
        const action = defaultAction;
        defaultAction = undefined;
        action();
      }
      document.body.classList.remove("sandcastle-loading");
      const overlay = document.getElementById("loadingOverlay");
      if (overlay) {
        overlay.style.display = "none";
      }
    },
    addToolbarButton(text, onclick, toolbarId) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cesium-button";
      button.textContent = text;
      button.onclick = () => onclick();
      toolbarFor(toolbarId).appendChild(button);
    },
    addDefaultToolbarButton(text, onclick, toolbarId) {
      window.Sandcastle.addToolbarButton(text, onclick, toolbarId);
      defaultAction = onclick;
    },
    addToggleButton(text, checked, onchange, toolbarId) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      const label = document.createElement("label");
      label.appendChild(input);
      label.appendChild(document.createTextNode(text));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cesium-button";
      button.appendChild(label);
      button.onclick = () => {
        input.checked = !input.checked;
        onchange(input.checked);
      };
      toolbarFor(toolbarId).appendChild(button);
    },
    addToolbarMenu(options, toolbarId) {
      const menu = document.createElement("select");
      menu.className = "cesium-button";
      menu.onchange = () => {
        const item = options[menu.selectedIndex];
        if (item && typeof item.onselect === "function") {
          item.onselect();
        }
      };
      toolbarFor(toolbarId).appendChild(menu);
      if (!defaultAction && typeof options[0]?.onselect === "function") {
        defaultAction = options[0].onselect;
      }
      for (const option of options) {
        const element = document.createElement("option");
        element.textContent = option.text;
        element.value = option.value;
        menu.appendChild(element);
      }
    },
    addDefaultToolbarMenu(options, toolbarId) {
      window.Sandcastle.addToolbarMenu(options, toolbarId);
      defaultAction = options[0].onselect;
    },
  };
}

/**
 * Re-create the module half of the deleted loader and run the demo.
 *
 * Returns a report rather than throwing so "the page could not be booted" lands
 * in the STRUCTURAL tier instead of looking like a harness crash.
 *
 * @param {string} moduleUrl Root-relative URL of the engine ES module bundle.
 * @returns {Promise<object>} Boot result and any structural note.
 */
async function bootLegacyDemo(moduleUrl) {
  if (typeof window.startup !== "function") {
    return {
      started: false,
      structural: "the demo page defines no window.startup",
    };
  }
  let namespace;
  try {
    namespace = await import(moduleUrl);
  } catch (error) {
    return {
      started: false,
      structural: `${moduleUrl} did not import: ${String(error)}`,
    };
  }
  window.Cesium = namespace;
  window.startupCalled = true;
  // The demo's promise is PARKED on the page rather than awaited here.
  // `page.evaluate` has no timeout of its own, so awaiting a demo that never
  // settles would hang past the scene's budget and past every later scene; the
  // driver polls this flag with a bounded wait instead.
  window.__readmeShotsBoot = { state: "running" };
  window.startup(namespace).then(
    () => {
      window.__readmeShotsBoot = { state: "done" };
      try {
        window.Sandcastle?.finishedLoading();
      } catch {
        // The demo calls this itself at the end of startup; a second call is a
        // no-op, and a throw here must not mask a scene that already rendered.
      }
    },
    (error) => {
      window.__readmeShotsBoot = {
        state: "failed",
        error: String(error?.stack ?? error),
      };
    },
  );
  return { started: true };
}

/**
 * Read the parked boot outcome from the page.
 *
 * @returns {object} `{state}` plus an `error` when the demo's startup rejected.
 */
function readLegacyBootState() {
  return window.__readmeShotsBoot ?? { state: "missing" };
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
 * @param {object} spec The manifest scene, serialised, plus `settleBudgetMs`.
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
          zoomTarget = { kind: "tileset", value: tileset, url: item.url };
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
          zoomTarget = { kind: "entity", value: entity, url: item.url };
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

  // Render to readiness. Framing needs a frame with a real bounding volume, so
  // it is issued after the first render rather than before it — and it is polled
  // rather than awaited: an entity's sphere only becomes available once the
  // visualizer has built its model, which happens in THIS loop.
  const display = viewer.dataSourceDisplay;
  const entitySphere = new C.BoundingSphere();
  let zoomed = zoomTarget === null;
  let stable = 0;
  let frames = 0;
  const limit = spec.settleFrames ?? 480;
  const settleDeadline = performance.now() + (spec.settleBudgetMs ?? 45_000);
  let budgetExhausted = false;
  // Reported once, not once per frame: a display that throws throws every time,
  // and hundreds of identical notes would bury the rest of the report.
  let displayThrew = false;
  while (frames < limit && stable < 12) {
    if (performance.now() >= settleDeadline) {
      budgetExhausted = true;
      break;
    }
    // Entity visualizers are built here because the pinned clock never ticks.
    try {
      display?.update(at());
    } catch (error) {
      if (!displayThrew) {
        displayThrew = true;
        structural.push(`dataSourceDisplay.update threw ${String(error)}`);
      }
    }
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
          zoomed = true;
        } else {
          const state = display.getBoundingSphere(
            zoomTarget.value,
            false,
            entitySphere,
          );
          if (state === C.BoundingSphereState.DONE) {
            scene.camera.viewBoundingSphere(
              entitySphere,
              new C.HeadingPitchRange(
                C.Math.toRadians(30),
                C.Math.toRadians(-25),
                entitySphere.radius * 3.2,
              ),
            );
            scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
            zoomed = true;
          } else if (state === C.BoundingSphereState.FAILED) {
            structural.push(
              `content ${zoomTarget.url} has no visualization to frame`,
            );
            zoomed = true;
          }
        }
      } catch (error) {
        structural.push(`framing failed: ${String(error)}`);
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
  if (!zoomed) {
    // The subject never became framable, so whatever is in frame is not it.
    structural.push(
      `content ${zoomTarget?.url ?? "(unknown)"} never produced a bounding sphere`,
    );
  }
  // Trailing pinned render so the compositor holds a pinned-time frame for the
  // screenshot below — the widget's own loop is off.
  try {
    display?.update(at());
  } catch {
    // Already reported above if it throws consistently.
  }
  scene.render(at());

  return {
    structural,
    applied,
    aimReport,
    frames,
    budgetExhausted,
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
    viewer.dataSourceDisplay?.update(viewer.clock.currentTime);
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
  // The gallery pages still reference the two loader scripts that were deleted
  // with the legacy Sandcastle app; this script supplies both itself, so their
  // 404s are expected rather than a fault in the scene. The third tag they
  // carry is `nomodule`, which a module-capable browser never even fetches.
  /Sandcastle-header\.js/,
  /load-cesium-es6\.js/,
];

function isExternalResourceFailure(text, locationUrl) {
  if (!/Failed to load resource/i.test(text)) {
    return false;
  }
  return typeof locationUrl === "string" && !locationUrl.startsWith(BASE);
}

/**
 * Capture one scene, within its own wall-clock budget.
 *
 * @param {import("playwright").Browser} browser Shared browser.
 * @param {object} scene A validated manifest scene.
 * @returns {Promise<object>} Per-scene result record.
 */
async function captureScene(browser, scene) {
  const startedAt = Date.now();
  const budgetLeft = () => SCENE_BUDGET_MS - (Date.now() - startedAt);
  // Every wait is clamped to what the scene has left, minus what the capture
  // itself will need. A wait that outlives the budget cannot be the reason a
  // later scene is never attempted.
  const allow = (ceiling) =>
    Math.max(1_000, Math.min(ceiling, budgetLeft() - CAPTURE_RESERVE_MS));

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
    elapsedMs: 0,
  };
  if (record.structural.length > 0) {
    record.elapsedMs = Date.now() - startedAt;
    return record;
  }

  const preflight = await urlAnswers(record.url);
  if (!preflight.ok) {
    record.structural.push(
      `the dev server does not serve ${resolved.url} (status ${preflight.status}${preflight.error ? `, ${preflight.error}` : ""})`,
    );
    record.elapsedMs = Date.now() - startedAt;
    return record;
  }

  const viewport = scene.viewport ??
    manifest.viewport ?? { width: 1024, height: 576 };
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(READY_TIMEOUT_MS);

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
  if (scene.kind === "sandcastle") {
    await page.addInitScript(legacySandcastleLoader);
  }

  try {
    await page.goto(record.url, {
      waitUntil: "domcontentloaded",
      timeout: allow(NAV_TIMEOUT_MS),
    });

    if (scene.kind === "viewer") {
      await page.waitForFunction(() => !!window.viewer, {
        timeout: allow(READY_TIMEOUT_MS),
      });
      await armWebGPUDevices(page);
      const report = await page.evaluate(applyViewerScene, {
        ...scene,
        settleBudgetMs: allow(READY_TIMEOUT_MS * 2),
      });
      record.applied = report.applied;
      record.renderer = report.renderer;
      record.frames = report.frames;
      record.ready = report.ready;
      record.budgetExhausted = report.budgetExhausted === true;
      record.structural.push(...report.structural);
    } else {
      let booted = true;
      if (scene.kind === "sandcastle") {
        // The page's inline script is synchronous in the body, so the demo's
        // entry point exists as soon as the document has parsed; anything
        // longer than a brief wait means the page is not the page we think.
        await page.waitForFunction(() => typeof window.startup === "function", {
          timeout: allow(READY_TIMEOUT_MS),
        });
        const boot = await page.evaluate(bootLegacyDemo, ENGINE_MODULE_URL);
        booted = boot.started === true;
        if (boot.structural) {
          record.structural.push(boot.structural);
        }
        if (booted) {
          try {
            await page.waitForFunction(
              () => window.__readmeShotsBoot?.state !== "running",
              { timeout: allow(READY_TIMEOUT_MS) },
            );
          } catch {
            record.structural.push(
              "the demo's startup never settled within this scene's budget",
            );
            booted = false;
          }
        }
        if (booted) {
          const state = await page.evaluate(readLegacyBootState);
          record.bootState = state.state;
          if (state.state === "failed") {
            record.errors.push(`demo startup threw: ${state.error}`);
          }
        }
      }
      // A demo that never booted has no canvas to wait for; waiting anyway
      // spends the rest of the budget confirming what is already known.
      if (booted) {
        await page.waitForFunction(
          () => {
            const canvas = document.querySelector("canvas");
            return canvas !== null && canvas.width > 0 && canvas.height > 0;
          },
          { timeout: allow(READY_TIMEOUT_MS) },
        );
        // The demo drives its own render loop, so this settle is the scene
        // loading its content — capped by the budget rather than by hope.
        await page.waitForTimeout(allow(scene.settleMs ?? 8_000));
      }
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
      // A retry is only worth its wall-clock while the scene still has budget;
      // past that, three identical black frames are not more informative.
      if (attempt < RETRY_ATTEMPTS && budgetLeft() > CAPTURE_RESERVE_MS) {
        if (scene.kind === "viewer") {
          await page.evaluate(renderMoreFrames, 120);
        }
        await page.waitForTimeout(RETRY_WAIT_MS);
      } else {
        break;
      }
    }

    // Let asynchronous GPU errors flush: `onuncapturederror` fires after queue
    // validation, so a capture that "succeeded" can still be invalid.
    await page.waitForTimeout(300);
    const gate = await collectGateErrors(page);
    record.armedDevices = gate.armedDevices;
    const fatal = new Set([
      ...record.errors,
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
  record.elapsedMs = Date.now() - startedAt;
  return record;
}

let fatal = null;
const browser = await chromium.launch({
  channel: "msedge",
  headless: !headed,
  args: ["--enable-unsafe-webgpu"],
});
try {
  for (const scene of planned) {
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
      `    ${pixelLine}; attempts=${record.attempts}; devices=${record.armedDevices}; ${(record.elapsedMs / 1000).toFixed(1)}s`,
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
  REPORT_PATH,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      base: BASE,
      sceneBudgetMs: SCENE_BUDGET_MS,
      watchdogMs,
      requested: planned.length,
      skipped: skippedScenes.map((s) => s.id),
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
  `\n${results.filter((r) => r.ok).length}/${planned.length} scenes captured into ${IMAGE_DIR}/`,
);
for (const line of describeProgress({
  planned,
  results,
  skipped: skippedScenes,
})) {
  console.log(line);
}
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
