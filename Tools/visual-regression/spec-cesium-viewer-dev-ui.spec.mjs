// spec-cesium-viewer-dev-ui.spec.mjs — the CesiumViewer start contract.
// @purpose CesiumViewer start contract: dev chrome built only under devUi (absent, not hidden), bare URL resolves WebGPU non-strict, fleet URLs stable.
// @status ACTIVE
//
// Pure Node: no browser, no network, no GPU.
//
// WHAT IS BEING PINNED. The CesiumViewer page has three start-time behaviours
// that are easy to break silently and expensive to notice:
//
//   * the fork's development chrome — the WebGL/WebGPU/Split switcher and the
//     FPS checkbox — must be BUILT ONLY for a page started with `devUi`. Not
//     hidden: absent. A `display: none` toolbar still shows up in the DOM an
//     integrator is comparing against upstream, so the gate has to sit at
//     construction time, and a spec that only checked visibility would pass
//     over exactly the regression it exists to catch.
//   * a viewer started with no query string must resolve to WebGPU, and must
//     do so through the engine's NON-STRICT request so a browser without
//     WebGPU degrades to WebGL instead of to a black page.
//   * every URL the probe fleet already points at this page must keep
//     resolving to the mode it resolved to before.
//
// WHY THE DETECTORS ARE MUTATION-TESTED. Two of the assertions below are
// source anchors, and a source anchor is precisely the shape of instrument
// this repo has repeatedly paid for: a regex that stopped matching the thing
// it was written for still passes as long as it also stopped matching the
// violation. Each anchor is therefore paired with a control that reintroduces
// the defect into a COPY of the real source and requires the detector to fire.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Every file read here
// is line-ending normalized before matching; no assertion anchors on a bare
// "\n" against unnormalized text.
//
// Run: node --test Tools/visual-regression/spec-cesium-viewer-dev-ui.spec.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_START_MODE,
  START_MODES,
  isDevUiEnabled,
  resolveStartMode,
} from "../../Apps/CesiumViewer/CesiumViewerStartMode.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(HERE, "../..");

/** Repository file text with line endings normalized. */
const read = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8").replaceAll("\r\n", "\n");

const VIEWER_SOURCE = "Apps/CesiumViewer/CesiumViewer.js";
const VIEWER_PAGE = "Apps/CesiumViewer/index.html";
const DEV_UI_SOURCE = "Apps/CesiumViewer/CesiumViewerDevUi.js";

/**
 * Stand-in for the engine's `queryToObject`, which the page uses to turn its
 * search string into the object these policy functions read. Last value wins
 * for a repeated key in both.
 *
 * @param {string} url A URL that may carry a query string.
 * @returns {object} Parsed query options.
 */
function parseQuery(url) {
  const questionMark = url.indexOf("?");
  const options = {};
  if (questionMark < 0) {
    return options;
  }
  for (const [key, value] of new URLSearchParams(url.slice(questionMark + 1))) {
    options[key] = value;
  }
  return options;
}

// ───────────────────────── the default renderer ─────────────────────────

test("a start with no renderer named resolves to WebGPU", () => {
  assert.equal(DEFAULT_START_MODE, "webgpu");
  assert.equal(resolveStartMode({}), "webgpu");
  assert.equal(resolveStartMode(undefined), "webgpu");
  assert.equal(resolveStartMode(parseQuery("index.html")), "webgpu");
  assert.equal(
    resolveStartMode(parseQuery("index.html?offline=true")),
    "webgpu",
  );
});

test("an explicit renderer always wins over the default", () => {
  for (const mode of START_MODES) {
    assert.equal(resolveStartMode({ renderer: mode }), mode);
  }
  assert.deepEqual([...START_MODES], ["webgl", "webgpu", "split"]);
});

test("an unusable renderer value degrades to the default rather than throwing", () => {
  // The viewer is reached by hand-edited URLs; a typo must still draw a globe.
  for (const value of ["", "vulkan", "WebGL", "webgl2", " webgl", "0"]) {
    assert.equal(resolveStartMode({ renderer: value }), DEFAULT_START_MODE);
  }
});

test("the default reaches the engine as a NON-STRICT request, so it cannot black-page", () => {
  // Two halves have to hold together. The application asks for WebGPU without
  // opting into hard-fail...
  const viewer = read(VIEWER_SOURCE);
  assert.match(viewer, /contextOptions: \{ renderer: "webgpu" \}/);
  assert.doesNotMatch(
    viewer,
    /strictRenderer/,
    "opting into strictRenderer would turn an unsupported browser into a failed start",
  );

  // ...and a non-strict WebGPU request is planned as WebGPU-then-WebGL by the
  // engine's renderer policy. That is the fallback the default depends on, so
  // it is pinned here rather than assumed.
  const policy = read("packages/engine/Source/Renderer/RendererType.ts");
  assert.match(
    policy,
    /if \(options\.strictRenderer !== true && buildCapabilities\.webgl\) \{\s*return \{\s*requestedRenderer: requested,\s*attempts: Object\.freeze\(\[RendererType\.WEBGPU, RendererType\.WEBGL\]\),/,
  );
});

test("the synchronous constructor is still WebGL-only, which is why the app resolves the mode itself", () => {
  // The page cannot delegate the choice to engine AUTO inside `new Viewer`:
  // anything but WebGL requires the asynchronous constructor, so the mode has
  // to be known before the constructor is picked.
  const policy = read("packages/engine/Source/Renderer/RendererType.ts");
  assert.match(policy, /export function getSynchronousRendererType\(/);
  assert.match(
    policy,
    /requires asynchronous initialization\. Use createAsync instead\./,
  );

  const viewer = read(VIEWER_SOURCE);
  assert.match(
    viewer,
    /function createWebGLViewer\(container\) \{\s*const opts = getCommonOptions\(\);\s*const viewer = new Viewer\(/,
  );
  assert.match(
    viewer,
    /async function createWebGPUViewer\(container\) \{\s*const opts = getCommonOptions\(\);\s*const viewer = await Viewer\.createAsync\(/,
  );
});

// ───────────────────────────── the dev-UI gate ─────────────────────────────

/** Tokens that would betray fork-only chrome baked into the served page. */
const FORK_CHROME_TOKENS = Object.freeze([
  "rendererToolbar",
  "renderer-toolbar",
  "btnWebGL",
  "btnWebGPU",
  "btnSplit",
  "fpsToggle",
  "switchRenderer",
  "toggleFps",
  "split-container",
  "split-pane",
  "split-divider",
  "split-label",
]);

/**
 * True when the page text contains no fork-only chrome.
 *
 * @param {string} pageText Normalized page source.
 * @returns {boolean} Whether the page is free of fork chrome.
 */
function pageIsFreeOfForkChrome(pageText) {
  return FORK_CHROME_TOKENS.every((token) => !pageText.includes(token));
}

test("devUi accepts true and 1, and nothing else", () => {
  assert.equal(isDevUiEnabled(parseQuery("index.html?devUi=true")), true);
  assert.equal(isDevUiEnabled(parseQuery("index.html?devUi=1")), true);
  assert.equal(isDevUiEnabled({ devUi: "true" }), true);
  assert.equal(isDevUiEnabled({ devUi: "1" }), true);

  for (const options of [
    {},
    undefined,
    parseQuery("index.html"),
    parseQuery("index.html?devUi"), // a bare flag carries the empty string
    parseQuery("index.html?devUi=false"),
    parseQuery("index.html?devUi=0"),
    parseQuery("index.html?devUi=TRUE"),
    parseQuery("index.html?renderer=webgpu"),
    { devUi: true },
  ]) {
    assert.equal(isDevUiEnabled(options), false);
  }
});

test("the served page carries no fork chrome at all", () => {
  const page = read(VIEWER_PAGE);
  for (const token of FORK_CHROME_TOKENS) {
    assert.equal(
      page.includes(token),
      false,
      `${VIEWER_PAGE} must not ship "${token}"`,
    );
  }
  // No fork stylesheet either: the switcher and the split panes both style
  // themselves at construction time.
  assert.doesNotMatch(page, /<style[\s>]/);

  // What remains is upstream's body: one container, one loading indicator,
  // one module script.
  assert.match(page, /<div id="cesiumContainer" class="fullWindow"><\/div>/);
  assert.match(
    page,
    /<div id="loadingIndicator" class="loadingIndicator"><\/div>/,
  );
  assert.match(page, /<script src="CesiumViewer\.js" type="module"><\/script>/);
});

test("MUTATION: putting the toolbar back in the page is detected", () => {
  const page = read(VIEWER_PAGE);
  assert.equal(pageIsFreeOfForkChrome(page), true);

  const withToolbar = page.replace(
    '<div id="cesiumContainer" class="fullWindow"></div>',
    '<div id="rendererToolbar" class="renderer-toolbar">\n' +
      '<button id="btnWebGL" onclick="switchRenderer(\'webgl\')">WebGL</button>\n' +
      "</div>\n" +
      '<div id="cesiumContainer" class="fullWindow"></div>',
  );
  assert.notEqual(
    withToolbar,
    page,
    "the mutation must actually change the page",
  );
  assert.equal(
    pageIsFreeOfForkChrome(withToolbar),
    false,
    "a detector that cannot see a restored toolbar is not a detector",
  );
});

/**
 * True when the application builds its toolbar from exactly one call site and
 * that call site is guarded by the dev-UI predicate.
 *
 * @param {string} source Normalized application source.
 * @returns {boolean} Whether toolbar construction is gated.
 */
function toolbarConstructionIsGated(source) {
  const callSites = source.match(/createRendererToolbar\(/g) ?? [];
  if (callSites.length !== 1) {
    return false;
  }
  return /if \(isDevUiEnabled\(endUserOptions\)\) \{\s*rendererToolbar = createRendererToolbar\(\{/.test(
    source,
  );
}

test("the toolbar is constructed only under the dev-UI gate", () => {
  const viewer = read(VIEWER_SOURCE);
  assert.equal(toolbarConstructionIsGated(viewer), true);

  // The gate is construction, not visibility: nothing in the application hides
  // the chrome after building it.
  assert.doesNotMatch(viewer, /rendererToolbar[^\n]*style\.display/);
});

test("MUTATION: an ungated or duplicated toolbar call site is detected", () => {
  const viewer = read(VIEWER_SOURCE);

  const ungated = viewer.replace("if (isDevUiEnabled(endUserOptions)) {", "{");
  assert.notEqual(
    ungated,
    viewer,
    "the mutation must actually remove the guard",
  );
  assert.equal(toolbarConstructionIsGated(ungated), false);

  const duplicated = viewer.replace(
    "  try {",
    "  createRendererToolbar({});\n  try {",
  );
  assert.notEqual(duplicated, viewer);
  assert.equal(toolbarConstructionIsGated(duplicated), false);
});

test("the chrome stylesheet is injected by the gated module, never by the page", () => {
  const devUi = read(DEV_UI_SOURCE);
  // Both families of rules live behind a function call rather than in a file
  // the page links unconditionally.
  assert.match(devUi, /export function ensureForkChromeStyles\(\)/);
  assert.match(devUi, /\.renderer-toolbar \{/);
  assert.match(devUi, /\.split-container \{/);
  assert.match(devUi, /document\.head\.appendChild\(style\)/);

  // Split panes need the same rules and can be requested without the toolbar,
  // so the layout path asks for them itself.
  const viewer = read(VIEWER_SOURCE);
  assert.match(
    viewer,
    /function createSplitContainers\(\) \{[\s\S]{0,400}?ensureForkChromeStyles\(\);/,
  );

  // A sibling stylesheet would have to be registered as an application build
  // entry point to exist in `Build/`; carrying the rules in the module keeps
  // the dev server and the bundled application identical.
  const appBuild = read("gulpfile.apps.js");
  assert.match(appBuild, /"Apps\/CesiumViewer\/CesiumViewer\.css",/);
  assert.equal(appBuild.includes("CesiumViewerDevUi.css"), false);
});

// ───────────────────── the ungated programmatic switch API ─────────────────

test("switchRenderer and toggleFps are published whether or not the chrome was built", () => {
  const viewer = read(VIEWER_SOURCE);
  // Assigned at module top level — column zero, so neither sits inside the
  // dev-UI branch.
  assert.match(viewer, /\nwindow\.switchRenderer = async function \(mode\) \{/);
  assert.match(viewer, /\nwindow\.toggleFps = function \(enabled\) \{/);

  // The toolbar is one caller of that API, not its owner.
  const devUi = read(DEV_UI_SOURCE);
  assert.equal(devUi.includes("window.switchRenderer"), false);
  assert.match(
    viewer,
    /onSelectMode: \(mode\) => window\.switchRenderer\(mode\)/,
  );

  // Nothing may reach for a toolbar element that a default start does not have.
  assert.doesNotMatch(viewer, /getElementById\("btn(WebGL|WebGPU|Split)"\)/);
  assert.doesNotMatch(viewer, /getElementById\("fpsToggle"\)/);
});

test("`stats` stays an upstream option, independent of the fork chrome", () => {
  // Upstream documents `stats=true` as the FPS display switch. Only the
  // checkbox mirroring it is development-only, so the option is read outside
  // the gate.
  const viewer = read(VIEWER_SOURCE);
  assert.match(viewer, /let showFps = !!endUserOptions\.stats;/);
  const gateIndex = viewer.indexOf("if (isDevUiEnabled(endUserOptions)) {");
  const statsIndex = viewer.indexOf("let showFps = !!endUserOptions.stats;");
  assert.ok(statsIndex >= 0 && gateIndex >= 0);
  assert.ok(statsIndex < gateIndex, "stats must be resolved before the gate");
});

// ──────────────────────── probe-URL compatibility ────────────────────────

// Every URL shape the tooling under `Tools/` points at this page, with the
// mode it must resolve to. Template placeholders are instantiated with the
// values their probes actually pass.
const PROBE_URL_CONTRACT = Object.freeze([
  ["Apps/CesiumViewer/index.html", "webgpu"],
  ["Apps/CesiumViewer/index.html?offline=true", "webgpu"],
  ["Apps/CesiumViewer/index.html?renderer=webgl", "webgl"],
  ["Apps/CesiumViewer/index.html?renderer=webgl&offline=true", "webgl"],
  ["Apps/CesiumViewer/index.html?renderer=webgpu", "webgpu"],
  ["Apps/CesiumViewer/index.html?renderer=webgpu&offline=true", "webgpu"],
  [
    "Apps/CesiumViewer/index.html?renderer=webgpu&view=-95.0,38.0,8000000.0",
    "webgpu",
  ],
  ["Apps/CesiumViewer/index.html?renderer=webgpu&devUi=true", "webgpu"],
  ["Apps/CesiumViewer/index.html?devUi=true", "webgpu"],
]);

test("every probe URL shape still resolves to a working mode", () => {
  for (const [url, expected] of PROBE_URL_CONTRACT) {
    const options = parseQuery(url);
    assert.equal(resolveStartMode(options), expected, url);
    assert.ok(START_MODES.includes(resolveStartMode(options)), url);
  }
});

test("an explicit renderer resolves the same with and without the dev UI", () => {
  // Tooling navigates without `devUi`; the chrome must not be a precondition
  // for backend selection.
  for (const mode of START_MODES) {
    assert.equal(resolveStartMode({ renderer: mode }), mode);
    assert.equal(resolveStartMode({ renderer: mode, devUi: "true" }), mode);
  }
});

/**
 * Tool sources that may point a browser at the viewer page.
 *
 * `.spec.mjs` files are excluded: they are browser-free guards, and this one
 * has to quote the very identifiers it forbids the fleet from using, so
 * including them would make the scan report itself.
 *
 * @returns {string[]} Repository-relative paths.
 */
function toolSources() {
  const files = [];
  for (const entry of readdirSync(HERE, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /\.(mjs|json)$/.test(entry.name) &&
      !entry.name.endsWith(".spec.mjs")
    ) {
      files.push(join("Tools/visual-regression", entry.name));
    }
  }
  for (const entry of readdirSync(join(HERE, "lib"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(join("Tools/visual-regression/lib", entry.name));
    }
  }
  return files;
}

test("no tool asks the viewer for a renderer the page cannot resolve", () => {
  // A live scan, so a NEW probe naming a bogus backend fails here the day it
  // lands rather than silently falling back to the default.
  let inspected = 0;
  for (const file of toolSources()) {
    const source = read(file);
    for (const match of source.matchAll(
      /Apps\/CesiumViewer\/index\.html\?[^"'`\s]*/g,
    )) {
      // Literal values only. A template placeholder (`${renderer}`) or a prose
      // alternation (`{webgl|webgpu}`) carries no single value to check, and
      // the character class declines to match either.
      for (const pair of match[0].matchAll(/[?&]renderer=([A-Za-z0-9_-]+)/g)) {
        inspected += 1;
        assert.ok(
          START_MODES.includes(pair[1]),
          `${file} requests renderer "${pair[1]}", which is not a start mode`,
        );
      }
    }
  }
  assert.ok(
    inspected > 0,
    "the scan found no literal renderer requests to check",
  );
});

test("no tool depends on the gated chrome existing", () => {
  // The switcher buttons and the FPS checkbox are absent for every URL the
  // fleet uses, so an interaction with them would be a latent failure.
  for (const file of toolSources()) {
    const source = read(file);
    for (const id of ["btnWebGL", "btnWebGPU", "btnSplit", "fpsToggle"]) {
      assert.equal(
        source.includes(`#${id}`) || source.includes(`"${id}"`),
        false,
        `${file} reaches for the gated element ${id}`,
      );
    }
  }
});

test("the one probe that drives a renderer change uses the ungated API", () => {
  const probe = read("Tools/visual-regression/probe-webgpu-reinit-switch.mjs");
  assert.match(probe, /window\.switchRenderer/);
  assert.match(probe, /index\.html\?renderer=webgl/);
  // It never clicks the toolbar, which its URL does not build.
  assert.equal(probe.includes("btnWebGL"), false);
});

// ────────────────────────── script and server wiring ──────────────────────

test("the dev-UI npm script starts the server and asks it for the URL", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["start-dev-ui"], "node server.js --devUi");
  // Mirrors the existing start conventions rather than inventing a new runner.
  assert.equal(pkg.scripts["start"], "node server.js");
  assert.equal(pkg.scripts["start-public"], "node server.js --public");
});

test("the server prints the dev-UI URL once it is actually listening", () => {
  const server = read("server.js");
  assert.match(server, /devUi: \{\s*type: "boolean",/);
  assert.match(
    server,
    /const DEV_UI_VIEWER_PATH = "\/Apps\/CesiumViewer\/index\.html\?devUi=true";/,
  );
  // Inside the listen callback: a message printed before `app.listen` would
  // race the development build, and there is no "after" for a server that
  // does not exit.
  assert.match(
    server,
    /const server = app\.listen\([\s\S]*?if \(argv\.devUi\) \{[\s\S]*?DEV_UI_VIEWER_PATH/,
  );
});

test("the README documents the script and the gate", () => {
  const readme = read("README.md");
  assert.match(readme, /### Development/);
  assert.match(readme, /npm run start-dev-ui/);
  assert.match(readme, /\?devUi=true/);
  assert.match(readme, /starts on WebGPU/);
});

test("Sandcastle is untouched by this contract", () => {
  // The Sandcastle renderer switcher is a separate application and out of
  // scope; nothing here may reach into it.
  const viewer = read(VIEWER_SOURCE);
  const devUi = read(DEV_UI_SOURCE);
  for (const source of [viewer, devUi]) {
    assert.equal(source.includes("sandcastle"), false);
    assert.equal(source.includes("Sandcastle"), false);
  }
});
