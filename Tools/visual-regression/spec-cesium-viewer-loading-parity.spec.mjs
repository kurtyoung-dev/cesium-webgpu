// spec-cesium-viewer-loading-parity.spec.mjs — the loading presentation must
// be upstream's, on every backend.
// @purpose Loading-presentation parity: the async WebGPU viewer path adds no chrome of its own; the page indicator hides at first rendered frame on both.
// @status ACTIVE
//
// Pure Node: no browser, no network, no GPU.
//
// WHAT IS BEING PINNED. A viewer started on WebGPU cannot be constructed
// synchronously, so it reaches the page through `Viewer.createAsync` while a
// viewer started on WebGL reaches it through `new Viewer`. Two things must not
// follow from that:
//
//   * the asynchronous path must not put anything of its own on the page. It
//     used to build a progress card inside the viewer container — a scrim, a
//     title, a status line, a progress bar and a percentage — which meant the
//     default start of this fork showed loading chrome that upstream does not
//     have, stacked on top of the page's own indicator, and outliving it by the
//     length of a fade-out. The container must receive exactly the elements the
//     synchronous constructor creates.
//   * the indicator the page does have must come and go at the same observable
//     moment on both backends. Hiding it when the constructor returns is only
//     equivalent to hiding it when the scene appears on a backend whose first
//     frame follows the constructor immediately, so the removal point is the
//     first rendered frame and both backends run the same code to reach it.
//
// WHY THE DETECTORS ARE MUTATION-TESTED. Most assertions below are source
// anchors, and a source anchor that quietly stops matching still passes. Each
// one is therefore paired with a control that reintroduces the defect into a
// COPY of the real source and requires the detector to fire.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Every file read here is
// line-ending normalized before matching.
//
// Run: node --test Tools/visual-regression/spec-cesium-viewer-loading-parity.spec.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RENDER_WAIT_LIMIT_MS,
  whenScenesRendered,
} from "../../Apps/CesiumViewer/CesiumViewerLoadingIndicator.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(HERE, "../..");

/** Repository file text with line endings normalized. */
const read = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8").replaceAll("\r\n", "\n");

const VIEWER_PAGE = "Apps/CesiumViewer/index.html";
const VIEWER_STYLE = "Apps/CesiumViewer/CesiumViewer.css";
const VIEWER_SOURCE = "Apps/CesiumViewer/CesiumViewer.js";
const DEV_UI_SOURCE = "Apps/CesiumViewer/CesiumViewerDevUi.js";
const INDICATOR_SOURCE = "Apps/CesiumViewer/CesiumViewerLoadingIndicator.js";
const WIDGETS_VIEWER = "packages/widgets/Source/Viewer/Viewer.js";
const ENGINE_WIDGET = "packages/engine/Source/Widget/CesiumWidget.js";

// ─────────────────── the page's loading presentation ───────────────────

test("the page ships upstream's single loading element and nothing else", () => {
  const page = read(VIEWER_PAGE);

  assert.match(
    page,
    /<div id="loadingIndicator" class="loadingIndicator"><\/div>/,
  );
  // One element carrying the word, so a second presentation cannot hide in the
  // page next to the first.
  assert.equal((page.match(/loadingIndicator/g) ?? []).length, 2);
  assert.equal(/id="(?!loadingIndicator|cesiumContainer)/.test(page), false);
  assert.doesNotMatch(page, /<style[\s>]/);
  assert.doesNotMatch(page, /splash/i);
});

test("its styling is upstream's centered indeterminate indicator", () => {
  const style = read(VIEWER_STYLE);
  assert.match(
    style,
    /\.loadingIndicator \{\n\s*display: block;\n\s*position: absolute;\n\s*top: 50%;\n\s*left: 50%;/,
  );
  assert.match(style, /background-image: url\(Images\/ajax-loader\.gif\);/);
  assert.ok(
    existsSync(resolve(repoRoot, "Apps/CesiumViewer/Images/ajax-loader.gif")),
    "the indicator's image must ship with the page",
  );
});

test("MUTATION: a second loading element in the page is detected", () => {
  const page = read(VIEWER_PAGE);
  const withSplash = page.replace(
    '<div id="loadingIndicator" class="loadingIndicator"></div>',
    '<div id="forkSplash" class="fork-splash">Initializing Renderer</div>\n' +
      '    <div id="loadingIndicator" class="loadingIndicator"></div>',
  );
  assert.notEqual(withSplash, page, "the mutation must change the page");
  assert.equal(
    /id="(?!loadingIndicator|cesiumContainer)/.test(withSplash),
    true,
    "a detector that cannot see an added start-time element is not a detector",
  );
});

// ──────────────── no fork-only loading chrome in the source ────────────────

/** Markers of a loading presentation this fork once injected of its own. */
const FORK_LOADING_TOKENS = Object.freeze([
  "LoadingOverlay",
  "cesium-loading-overlay",
  "cesium-loading-content",
  "cesium-loading-title",
  "cesium-loading-status",
  "cesium-loading-progress-container",
  "cesium-loading-progress-bar",
  "cesium-loading-percentage",
  "cesium-loading-error",
  "Initializing Renderer",
  "Initialization Failed",
]);

/**
 * True when a source file carries no marker of fork-only loading chrome.
 *
 * @param {string} sourceText Normalized source.
 * @returns {boolean} Whether the source is clean.
 */
function isFreeOfForkLoadingChrome(sourceText) {
  return FORK_LOADING_TOKENS.every((token) => !sourceText.includes(token));
}

test("no shipped source builds a loading presentation of its own", () => {
  for (const file of [
    WIDGETS_VIEWER,
    ENGINE_WIDGET,
    VIEWER_SOURCE,
    DEV_UI_SOURCE,
    INDICATOR_SOURCE,
    VIEWER_PAGE,
    VIEWER_STYLE,
  ]) {
    const source = read(file);
    for (const token of FORK_LOADING_TOKENS) {
      assert.equal(
        source.includes(token),
        false,
        `${file} must not ship "${token}"`,
      );
    }
  }

  // The module that built it is gone rather than merely unreferenced.
  assert.equal(
    existsSync(
      resolve(repoRoot, "packages/widgets/Source/Viewer/LoadingOverlay.js"),
    ),
    false,
  );
});

test("MUTATION: reintroducing the progress card is detected", () => {
  const widgetsViewer = read(WIDGETS_VIEWER);
  assert.equal(isFreeOfForkLoadingChrome(widgetsViewer), true);

  const withOverlay = widgetsViewer.replace(
    "  const containerEl = getElement(container);\n",
    "  const containerEl = getElement(container);\n" +
      "  const overlay = new LoadingOverlay(containerEl);\n",
  );
  assert.notEqual(
    withOverlay,
    widgetsViewer,
    "the mutation must actually restore the overlay",
  );
  assert.equal(
    isFreeOfForkLoadingChrome(withOverlay),
    false,
    "a detector that cannot see a restored overlay is not a detector",
  );
});

// ───────────── the asynchronous path adds no element of its own ─────────────

/**
 * The body of `Viewer.createAsync`, from its assignment to the closing brace.
 *
 * @param {string} sourceText Normalized `Viewer.js` source.
 * @returns {string} The function body.
 */
function createAsyncBody(sourceText) {
  const start = sourceText.indexOf("Viewer.createAsync = async function");
  assert.ok(start >= 0, "Viewer.createAsync must exist");
  const end = sourceText.indexOf("\n};", start);
  assert.ok(end > start, "Viewer.createAsync must be a function expression");
  return sourceText.slice(start, end);
}

/**
 * True when a function body creates or attaches no DOM.
 *
 * @param {string} body Normalized function body.
 * @returns {boolean} Whether the body is DOM-free.
 */
function isDomFree(body) {
  return (
    !body.includes("document.createElement") &&
    !body.includes("appendChild") &&
    !body.includes("insertBefore") &&
    !body.includes("innerHTML") &&
    // Anything but the constructor being handed the container is a second
    // owner of the page's contents.
    !/new (?!Viewer\()[A-Z]\w*\(container/.test(body)
  );
}

test("Viewer.createAsync puts nothing on the page while the context is acquired", () => {
  const body = createAsyncBody(read(WIDGETS_VIEWER));
  assert.equal(isDomFree(body), true);

  // The one element-producing call it makes is the constructor, which is the
  // same one the synchronous path makes.
  assert.match(body, /viewer = new Viewer\(container, \{/);
});

test("MUTATION: an element added during acquisition is detected", () => {
  const body = createAsyncBody(read(WIDGETS_VIEWER));
  const withOverlay = body.replace(
    "  let transaction;",
    "  const overlay = new LoadingOverlay(containerEl);\n  let transaction;",
  );
  assert.notEqual(withOverlay, body, "the mutation must change the body");
  assert.equal(isDomFree(withOverlay), false);
});

test("both asynchronous factories report progress the same way and own no chrome", () => {
  // Progress is reported to the caller, which is what lets an application that
  // wants a progress display build one without the library deciding for it.
  const widgetsViewer = read(WIDGETS_VIEWER);
  const engineWidget = read(ENGINE_WIDGET);

  assert.match(
    widgetsViewer,
    /Viewer\.createAsync = async function \(container, options, onProgress\) \{/,
  );
  assert.match(
    engineWidget,
    /CesiumWidget\.createAsync = async function \(container, options, onProgress\) \{/,
  );

  const body = createAsyncBody(widgetsViewer);
  assert.match(
    body,
    /transaction = await CesiumWidget\._createAsyncContext\(\s*containerEl,\s*options,\s*onProgress,\s*\)/,
  );
  assert.match(
    body,
    /if \(defined\(onProgress\)\) \{\s*onProgress\(100, "Ready"\);/,
  );
});

// ───────────────── the element set is the upstream element set ─────────────

// Every class name the two constructors put on the page. Pinned as a set so a
// new start-time element has to be justified here before it can ship.
const VIEWER_ELEMENT_CLASSES = Object.freeze([
  "cesium-viewer",
  "cesium-viewer-animationContainer",
  "cesium-viewer-bottom",
  "cesium-viewer-cesiumWidgetContainer",
  "cesium-viewer-fullscreenContainer",
  "cesium-viewer-geocoderContainer",
  "cesium-viewer-infoBoxContainer",
  "cesium-viewer-timelineContainer",
  "cesium-viewer-toolbar",
  "cesium-viewer-vrContainer",
]);

const WIDGET_ELEMENT_CLASSES = Object.freeze([
  "cesium-button",
  "cesium-widget",
  "cesium-widget-credits",
  "cesium-widget-errorPanel",
  "cesium-widget-errorPanel-buttonPanel",
  "cesium-widget-errorPanel-content",
  "cesium-widget-errorPanel-content expanded",
  "cesium-widget-errorPanel-header",
  "cesium-widget-errorPanel-message",
  "cesium-widget-errorPanel-more-details",
  "cesium-widget-errorPanel-scroll",
]);

/**
 * Sorted, de-duplicated class names assigned by a source file.
 *
 * @param {string} sourceText Normalized source.
 * @returns {string[]} Class names.
 */
function assignedClassNames(sourceText) {
  const names = new Set();
  for (const match of sourceText.matchAll(/className = "([^"]+)"/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

test("the constructors create exactly the upstream element set", () => {
  assert.deepEqual(assignedClassNames(read(WIDGETS_VIEWER)), [
    ...VIEWER_ELEMENT_CLASSES,
  ]);
  assert.deepEqual(assignedClassNames(read(ENGINE_WIDGET)), [
    ...WIDGET_ELEMENT_CLASSES,
  ]);
});

test("MUTATION: an extra element class is detected", () => {
  const widgetsViewer = read(WIDGETS_VIEWER);
  const withOverlay = widgetsViewer.replace(
    '      viewerContainer.className = "cesium-viewer";',
    '      viewerContainer.className = "cesium-viewer";\n' +
      '      const splash = document.createElement("div");\n' +
      '      splash.className = "cesium-loading-overlay";',
  );
  assert.notEqual(withOverlay, widgetsViewer);
  assert.notDeepEqual(assignedClassNames(withOverlay), [
    ...VIEWER_ELEMENT_CLASSES,
  ]);
});

// ─────────────────────── the readiness removal point ───────────────────────

/**
 * A stand-in for the engine's `Event`, carrying only what the policy uses.
 *
 * @returns {object} A raisable event with listener bookkeeping.
 */
function fakeEvent() {
  const listeners = [];
  return {
    listeners,
    addEventListener(listener) {
      listeners.push(listener);
    },
    removeEventListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
      return index >= 0;
    },
    raise() {
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

/** A stand-in for a Scene, carrying only its post-render event. */
const fakeScene = () => ({ postRender: fakeEvent() });

/** A controllable timer pair. */
function fakeClock() {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      pending.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    expire() {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) {
        entry.callback();
      }
    },
  };
}

test("readiness is the first rendered frame, not the constructor returning", () => {
  const scene = fakeScene();
  const clock = fakeClock();
  let ready = 0;

  whenScenesRendered([scene], () => (ready += 1), clock);

  // The viewer exists and the wait has been armed; nothing has been drawn.
  assert.equal(ready, 0);
  assert.equal(scene.postRender.listeners.length, 1);

  scene.postRender.raise();
  assert.equal(ready, 1);
  // The listener detaches with the wait, so a per-frame event costs nothing
  // once the question it answered has been answered.
  assert.equal(scene.postRender.listeners.length, 0);
  assert.equal(clock.pending.size, 0);

  scene.postRender.raise();
  assert.equal(ready, 1);
});

test("a split start waits for every scene, so neither pane is uncovered early", () => {
  const left = fakeScene();
  const right = fakeScene();
  const clock = fakeClock();
  let ready = 0;

  whenScenesRendered([left, right], () => (ready += 1), clock);

  left.postRender.raise();
  assert.equal(ready, 0, "one pane drawn is not both panes drawn");
  left.postRender.raise();
  assert.equal(ready, 0, "a second frame from the same pane does not count");

  right.postRender.raise();
  assert.equal(ready, 1);
  assert.equal(left.postRender.listeners.length, 0);
  assert.equal(right.postRender.listeners.length, 0);
});

test("a start that produces no scene reports ready at once", () => {
  const clock = fakeClock();
  let ready = 0;
  whenScenesRendered([], () => (ready += 1), clock);
  assert.equal(ready, 1);
  assert.equal(clock.pending.size, 0, "nothing to wait for arms no timer");

  ready = 0;
  whenScenesRendered(
    [undefined, null, {}, { postRender: {} }],
    () => {
      ready += 1;
    },
    clock,
  );
  assert.equal(ready, 1);
});

test("a scene that never renders cannot hold the indicator open", () => {
  const scene = fakeScene();
  const clock = fakeClock();
  let ready = 0;

  whenScenesRendered([scene], () => (ready += 1), clock);
  assert.equal(clock.pending.size, 1);
  assert.equal([...clock.pending.values()][0].delayMs, RENDER_WAIT_LIMIT_MS);

  clock.expire();
  assert.equal(ready, 1, "the bounded wait degrades to hiding it anyway");
  assert.equal(scene.postRender.listeners.length, 0);

  scene.postRender.raise();
  assert.equal(ready, 1, "a late frame does not report ready twice");
});

test("an abandoned wait neither reports ready nor leaves anything attached", () => {
  const scene = fakeScene();
  const clock = fakeClock();
  let ready = 0;

  const cancel = whenScenesRendered([scene], () => (ready += 1), clock);
  cancel();

  assert.equal(scene.postRender.listeners.length, 0);
  assert.equal(clock.pending.size, 0);
  scene.postRender.raise();
  clock.expire();
  assert.equal(ready, 0);

  // Abandoning an already-settled wait is a no-op rather than an error.
  const settled = fakeScene();
  const cancelSettled = whenScenesRendered(
    [settled],
    () => (ready += 1),
    clock,
  );
  settled.postRender.raise();
  cancelSettled();
  assert.equal(ready, 1);
});

test("the wait limit is a documented constant, not a literal at the call site", () => {
  assert.equal(typeof RENDER_WAIT_LIMIT_MS, "number");
  assert.ok(RENDER_WAIT_LIMIT_MS > 0);
  const source = read(INDICATOR_SOURCE);
  assert.match(source, /export const RENDER_WAIT_LIMIT_MS = \d+;/);
});

// ───────────────────── the wiring the policy is reached by ─────────────────

/**
 * True when every success path hides the indicator through the frame-gated
 * helper rather than directly.
 *
 * @param {string} source Normalized application source.
 * @returns {boolean} Whether the wiring is gated.
 */
function removalIsFrameGated(source) {
  const helper = source.match(/hideLoadingIndicatorWhenRendered\(\);/g) ?? [];
  if (helper.length !== 2) {
    return false;
  }
  // Direct hides remain only where no frame is coming: the two failure paths.
  const direct =
    source.match(/loadingIndicator\.style\.display = "none";/g) ?? [];
  return direct.length === 3;
}

test("both starts remove the indicator at the first rendered frame", () => {
  const source = read(VIEWER_SOURCE);
  assert.equal(removalIsFrameGated(source), true);

  // One helper, used by the first start and by a renderer change alike, so the
  // two cannot drift apart.
  assert.match(
    source,
    /function hideLoadingIndicatorWhenRendered\(\) \{[\s\S]*?whenScenesRendered\(scenes, function \(\) \{[\s\S]*?loadingIndicator\.style\.display = "none";/,
  );
  // It watches whichever viewers a start produced, which is one on either
  // backend and two in split mode.
  assert.match(
    source,
    /\[webglViewer, webgpuViewer\]\s*\.filter\(\(viewer\) => viewer && !viewer\.isDestroyed\(\)\)\s*\.map\(\(viewer\) => viewer\.scene\)/,
  );
});

test("a failed start still hides the indicator immediately", () => {
  // A start that threw has no frame to wait for, and upstream's page always
  // ends with the indicator gone.
  const source = read(VIEWER_SOURCE);
  const failurePaths = source.match(
    /\} catch \(exception\) \{\n\s*loadingIndicator\.style\.display = "none";/g,
  );
  assert.equal(failurePaths?.length, 2);
});

test("MUTATION: hiding the indicator without waiting for a frame is detected", () => {
  const source = read(VIEWER_SOURCE);
  const ungated = source.replace(
    "  hideLoadingIndicatorWhenRendered();\n}",
    '  loadingIndicator.style.display = "none";\n}',
  );
  assert.notEqual(
    ungated,
    source,
    "the mutation must actually remove the gate",
  );
  assert.equal(removalIsFrameGated(ungated), false);
});

// ───────────────────────── the dev-UI path is the same ─────────────────────

test("the loading presentation does not depend on the dev-UI flag", () => {
  const source = read(VIEWER_SOURCE);

  // Neither the helper nor its call sites sit inside the gate, and the gated
  // module knows nothing about the indicator.
  const gateIndex = source.indexOf("if (isDevUiEnabled(endUserOptions)) {");
  assert.ok(gateIndex >= 0);
  const gateEnd = source.indexOf("\n  }\n", gateIndex);
  const gateBody = source.slice(gateIndex, gateEnd);
  assert.equal(gateBody.includes("loadingIndicator"), false);
  assert.equal(gateBody.includes("hideLoadingIndicatorWhenRendered"), false);

  const devUi = read(DEV_UI_SOURCE);
  assert.equal(devUi.includes("loadingIndicator"), false);
  assert.equal(devUi.includes("whenScenesRendered"), false);
  assert.equal(devUi.includes("loading"), false);
});
