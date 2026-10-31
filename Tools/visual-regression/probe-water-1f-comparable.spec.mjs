// probe-water-1f-comparable.spec.mjs - lane Umbarto (DX-KIT-WATER-1F-CELL-NOT-COMPARABLE). Pure Node: no browser, no GPU.
//
// @purpose Pins that water cell 1f's two renderer arms are captured at ONE canvas size and with no viewer chrome over the canvas, so their frames can be pixel-compared: a fake Sandcastle 2 run frame that models the standalone shell (the console pane that opens by itself on the WebGPU arm and leaves its canvas 520 px tall against the WebGL arm's 687) runs the real demo-capture piece, with its own page functions and the real chrome-strip source executed in Node against a fake DOM, through probe-water-cells.mjs's descriptor.cells; asserts both arms' canvases measure the rig's declared size at the moment of the capture and the toolbar, navigation help, credit line and the demo's own toolbar are gone, that without the two dials the same world reproduces the unequal sizes and the chrome, that a canvas that never measures the declared size and a chrome element the strip does not know are each a refusal that reads the gate and captures nothing, that the dials are declared as data on the 1f rig, and that each 1f page's receipt names every console message that is not a plain log (what opens the shell's console pane), on the renderer that logged it only.
// @status ACTIVE
//
// The world is built from the Sandcastle 2 sources, not from the probe: the
// standalone page (`packages/sandcastle/src/Standalone/AppStandalone.tsx`)
// stacks the demo's iframe above a console pane that
// `ViewerConsoleStack.toggleExpanded` opens 200 px tall on any console message
// that is not a plain log (687 = 720 - the 33 px collapsed pane, 520 = 720 -
// 200), the demo's own HTML declares a `#toolbar` (`templates/bucket.css`), and
// the Cesium Viewer adds its toolbar, navigation help and credit line.

import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { ProbeRefusal } from "./lib/probe-runtime.mjs";
import {
  DEMO_SHELL_CHROME_SELECTORS,
  captureSandcastle2Demo,
  demoCaptureRequest,
} from "./lib/sandcastle2-demo-capture.mjs";
import { readRendererStateInPage } from "./lib/sandcastle2-renderer-gate.mjs";
import { descriptor } from "./probe-water-cells.mjs";
import waterMaskRig from "./rigs/sandcastle2-globe-materials-water-mask.mjs";

const ORIGIN = "http://localhost:8080";
const DEMO_ID = "globe-materials-water-mask-elevation-map";
const VIEWPORT = { width: 1280, height: 720 };
const CHROME_CLASSES = [
  "cesium-viewer-toolbar",
  "cesium-navigation-help",
  "cesium-widget-credits",
  "cesium-viewer-fullscreenContainer",
];

/** The shell's canvas height when its console is collapsed / opened. */
const CONSOLE_COLLAPSED_HEIGHT = 720 - 33;
const CONSOLE_OPEN_HEIGHT = 720 - 200;

const GLOBALS = ["window", "document", "getComputedStyle"];

/**
 * One renderer's run frame inside the standalone shell. `consoleOpen` is the
 * state the shell is in when the capture is taken (the WebGPU arm logged a
 * warning); `ignorePin` makes the shell refuse the top page's pinning;
 * `extraOverlay` adds a chrome element the strip does not know; `dropStrip`
 * makes the strip answer nothing. Everything the piece runs in the frame is
 * the piece's own function, executed against this fake DOM.
 */
function makeShell({
  renderer,
  consoleOpen = false,
  ignorePin = false,
  extraOverlay = null,
  dropStrip = false,
} = {}) {
  for (const name of GLOBALS) {
    assert.equal(globalThis[name], undefined, `${name} leaked into the shell`);
  }
  const log = { steps: [], captures: [], stripReports: [] };
  const style = new Map();
  const iframe = {
    style: {
      setProperty(name, value) {
        style.set(name, value);
      },
    },
    getBoundingClientRect: () => iframeBox(),
  };
  const pinned = () =>
    !ignorePin &&
    style.get("position") === "fixed" &&
    style.get("width") === "100vw" &&
    style.get("height") === "100vh";
  const iframeBox = () => {
    const width = 1280;
    const height = pinned()
      ? VIEWPORT.height
      : consoleOpen
        ? CONSOLE_OPEN_HEIGHT
        : CONSOLE_COLLAPSED_HEIGHT;
    return {
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
    };
  };
  const element = (props, rect) => ({
    tagName: "DIV",
    id: "",
    className: "",
    contains: () => false,
    getBoundingClientRect: () => rect,
    remove() {
      const at = live.indexOf(this);
      if (at >= 0) {
        live.splice(at, 1);
      }
    },
    ...props,
  });
  const over = { left: 900, right: 1270, top: 10, bottom: 300 };
  const rectOf = (box) => ({
    ...box,
    width: box.right - box.left,
    height: box.bottom - box.top,
  });
  const canvas = element({ tagName: "CANVAS" }, null);
  canvas.getBoundingClientRect = iframeBox;
  Object.defineProperty(canvas, "width", { get: () => iframeBox().width });
  Object.defineProperty(canvas, "height", { get: () => iframeBox().height });
  const widget = element({ className: "cesium-widget" }, null);
  widget.getBoundingClientRect = iframeBox;
  widget.contains = (other) => other === canvas;
  const live = [
    widget,
    canvas,
    ...CHROME_CLASSES.map((className) => element({ className }, rectOf(over))),
    element({ id: "toolbar" }, rectOf({ ...over, left: 5, right: 30 })),
    // Present but hidden, as the shell leaves it once the demo has loaded.
    element({ id: "loadingOverlay" }, rectOf({ ...over, right: over.left })),
    ...(extraOverlay
      ? [element({ className: extraOverlay }, rectOf(over))]
      : []),
  ];
  const matches = (el, selector) =>
    selector.startsWith("#")
      ? el.id === selector.slice(1)
      : selector.startsWith(".")
        ? el.className.split(" ").includes(selector.slice(1))
        : false;
  globalThis.window = {
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    devicePixelRatio: 1,
  };
  globalThis.document = {
    querySelector: (selector) =>
      selector === "canvas" || selector === ".cesium-widget canvas"
        ? canvas
        : null,
    querySelectorAll: (selector) => live.filter((el) => matches(el, selector)),
    body: { querySelectorAll: () => [...live] },
  };
  globalThis.getComputedStyle = () => ({ visibility: "visible" });

  const frame = {
    tag: `run-frame-${renderer}`,
    async waitForFunction() {},
    async frameElement() {
      return {
        async evaluate(fn) {
          log.steps.push("pin");
          return fn(iframe);
        },
      };
    },
    async evaluate(fn, arg) {
      if (fn === readRendererStateInPage) {
        return {
          contexts: [{ id: `ctx-${renderer}`, rendererType: renderer }],
          frameNumbers: [900],
          note: "",
        };
      }
      if (typeof fn === "string") {
        log.steps.push("strip");
        if (dropStrip) {
          return undefined;
        }
        const report = vm.runInThisContext(fn);
        log.stripReports.push(report);
        return report;
      }
      if (arg?.selector !== undefined) {
        log.steps.push("size");
        return fn(arg);
      }
      if (arg?.selectors !== undefined) {
        log.steps.push("shell");
        return fn(arg);
      }
      if (arg?.timeoutMs !== undefined) {
        return {
          tokenPresent: true,
          terrainResolved: true,
          terrainProvider: "CesiumTerrainProvider",
          hasWaterMask: true,
          waitedMs: 5,
        };
      }
      if (arg?.iso !== undefined) {
        return { applied: true, observed: arg.iso };
      }
      if (arg?.frames !== undefined) {
        log.steps.push("settle");
        return {
          outcome: "done",
          frames: arg.frames,
          settledFrames: arg.frames,
          frameNumber: 900,
          tilesLoaded: true,
        };
      }
      return { found: 1, armed: 1, gateInstalled: true };
    },
  };
  const dependencies = {
    async open() {
      log.steps.push("open");
      return {
        url: `${ORIGIN}/stub`,
        finalUrl: `${ORIGIN}/stub`,
        bucketFrame: frame,
        bucketFinalUrl: "http://localhost:8081/stub",
        assertNoOriginBreach() {},
      };
    },
    async installDriver() {},
    async readGate() {
      log.steps.push("gate");
      return { errors: [], deviceLost: null, armedDevices: 1 };
    },
    async capture({ name }) {
      log.steps.push("capture");
      const box = iframeBox();
      log.captures.push({
        name,
        width: box.width,
        height: box.height,
        chromeLeft: live
          .filter(
            (el) =>
              CHROME_CLASSES.includes(el.className) ||
              el.id === "toolbar" ||
              el.className === extraOverlay,
          )
          .map((el) => el.className || el.id),
      });
      return {
        name,
        path: path.join("relative-out", `${name}.png`),
        sha256: "00ff",
        byteLength: 3,
        liveness: { state: "live", frameNumber: 900 },
      };
    },
  };
  const dispose = () => {
    for (const name of GLOBALS) {
      delete globalThis[name];
    }
  };
  return { frame, dependencies, log, dispose };
}

/** The consoleOpen state the shell is in on each renderer's arm. */
const consoleOpenOn = (renderer) => renderer === "webgpu";

/** Run the real piece for one renderer in a shell, with the dials given. */
async function runPiece(shellOptions, requestOverrides = {}) {
  const shell = makeShell(shellOptions);
  try {
    const result = await captureSandcastle2Demo({
      page: { tag: "top-page" },
      request: {
        origin: ORIGIN,
        demoId: DEMO_ID,
        renderer: shellOptions.renderer,
        frames: 240,
        ...requestOverrides,
      },
      outputDirectory: "never-written",
      captures: [],
      dependencies: shell.dependencies,
    });
    return { result, log: shell.log };
  } finally {
    shell.dispose();
  }
}

const refusalOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProbeRefusal, `expected a refusal: ${error}`);
    return error;
  }
  return assert.fail("expected a refusal");
};

/** Cell 1f through descriptor.cells on both renderers; one shell per page. */
async function runCell1f({
  shellFor = () => ({}),
  consoleFor = () => [],
} = {}) {
  const contexts = [];
  const shells = new Map();
  const browser = {
    async newContext(options) {
      contexts.push(options);
      return {
        async addInitScript() {},
        async newPage() {
          // Playwright's page events, so the probe's diagnostics listener
          // hears what the run frame logs.
          const listeners = new Map();
          return {
            on(event, fn) {
              listeners.set(event, [...(listeners.get(event) ?? []), fn]);
            },
            off(event, fn) {
              listeners.set(
                event,
                (listeners.get(event) ?? []).filter((f) => f !== fn),
              );
            },
            emit(event, payload) {
              for (const fn of listeners.get(event) ?? []) {
                fn(payload);
              }
            },
            context: () => ({}),
          };
        },
        async close() {},
      };
    },
  };
  // One shell per opened page: the opener builds it for the renderer asked.
  const dependencies = {
    async open(page, urlOptions, navigation) {
      const renderer = urlOptions.renderer;
      // What the demo logs in its run frame, as Playwright delivers it.
      for (const [type, text] of consoleFor(renderer)) {
        page.emit("console", {
          type: () => type,
          text: () => text,
          location: () => ({ url: `${ORIGIN}/demo.html` }),
        });
      }
      // One page at a time owns the frame's globals.
      for (const earlier of shells.values()) {
        earlier.dispose();
      }
      const shell = makeShell({
        renderer,
        consoleOpen: consoleOpenOn(renderer),
        ...shellFor(renderer),
      });
      shells.set(renderer, shell);
      const opened = await shell.dependencies.open(
        page,
        urlOptions,
        navigation,
      );
      return opened;
    },
    installDriver: async () => {},
    readGate: async (frame) => {
      const shell = [...shells.values()].find((s) => s.frame === frame);
      return shell.dependencies.readGate(frame);
    },
    capture: async (args) => {
      const shell = [...shells.values()].find((s) => s.frame === args.page);
      return shell.dependencies.capture(args);
    },
  };
  try {
    const records = await withLaneTmp("water-1f-comparable-", (directory) =>
      descriptor.cells({
        browser,
        run: 0,
        options: {
          arm: "before",
          cells: "1f",
          renderers: ["webgl", "webgpu"],
        },
        origin: ORIGIN,
        outputDirectory: directory,
        captures: [],
        demoCaptureDependencies: dependencies,
      }),
    );
    return { records, contexts, shells };
  } finally {
    // One shell owns the globals at a time; the last opened is the survivor.
    for (const shell of shells.values()) {
      shell.dispose();
    }
  }
}

// ---------------------------------------------------------------------------

test("W1: the 1f rig declares the one canvas size and the chrome strip as data, and the size is the viewport", () => {
  assert.deepEqual(waterMaskRig.dials.canvasSize, VIEWPORT);
  assert.deepEqual(waterMaskRig.viewport, VIEWPORT);
  assert.equal(waterMaskRig.dials.stripChrome, true);
});

test("W2: demoCaptureRequest defaults both dials off and validates them", () => {
  const base = {
    origin: ORIGIN,
    demoId: DEMO_ID,
    renderer: "webgl",
    frames: 1,
  };
  const plain = demoCaptureRequest(base);
  assert.equal(plain.canvasSize, null);
  assert.equal(plain.stripChrome, false);
  const set = demoCaptureRequest({
    ...base,
    canvasSize: { width: 1280, height: 720 },
    stripChrome: true,
  });
  assert.deepEqual(set.canvasSize, VIEWPORT);
  assert.equal(set.stripChrome, true);
  for (const bad of [
    { width: 0, height: 720 },
    { width: 1280.5, height: 720 },
    { width: 1280 },
    { width: "1280", height: "720" },
  ]) {
    assert.throws(
      () => demoCaptureRequest({ ...base, canvasSize: bad }),
      TypeError,
    );
  }
  assert.throws(
    () => demoCaptureRequest({ ...base, stripChrome: "yes" }),
    TypeError,
  );
});

test("W3 (the defect): with neither dial the same world is 687 px tall on WebGL and 520 on WebGPU, with the chrome over both", async () => {
  const gl = await runPiece({ renderer: "webgl" });
  const gpu = await runPiece({ renderer: "webgpu", consoleOpen: true });
  const glShot = gl.log.captures[0];
  const gpuShot = gpu.log.captures[0];
  assert.deepEqual(
    [glShot.width, glShot.height],
    [1280, CONSOLE_COLLAPSED_HEIGHT],
  );
  assert.deepEqual(
    [gpuShot.width, gpuShot.height],
    [1280, CONSOLE_OPEN_HEIGHT],
  );
  assert.equal(CONSOLE_COLLAPSED_HEIGHT, 687);
  assert.equal(CONSOLE_OPEN_HEIGHT, 520);
  for (const shot of [glShot, gpuShot]) {
    assert.ok(shot.chromeLeft.includes("cesium-navigation-help"));
    assert.ok(shot.chromeLeft.includes("toolbar"));
  }
  assert.equal(gl.result.layout, null);
  assert.equal(gl.result.chrome, null);
  assert.ok(!gl.log.steps.includes("pin") && !gl.log.steps.includes("strip"));
});

test("W4: cell 1f through descriptor.cells captures both renderers at the rig's size, in equal contexts, with no chrome left over the canvas", async () => {
  const { records, contexts } = await runCell1f();
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.renderer),
    ["webgl", "webgpu"],
  );
  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts[0].viewport, contexts[1].viewport);
  assert.deepEqual(contexts[0].viewport, VIEWPORT);
  for (const record of records) {
    assert.equal(record.notRun, null, `${record.renderer}: ${record.notRun}`);
    assert.ok(record.capture, `${record.renderer} captured`);
    assert.deepEqual(record.demo.layout.declared, VIEWPORT);
    for (const measured of [
      record.demo.layout.measured,
      record.demo.layout.beforeCapture,
    ]) {
      assert.equal(measured.cssWidth, VIEWPORT.width);
      assert.equal(measured.cssHeight, VIEWPORT.height);
    }
    assert.deepEqual(record.demo.chrome.leftovers, []);
    assert.ok(record.demo.chrome.shellRemoved >= 1, "the demo's toolbar went");
    assert.ok(record.demo.chrome.removed >= CHROME_CLASSES.length);
  }
});

test("W5: at the moment of the capture both arms' canvases are the same size and nothing the strip knows is left in the frame", async () => {
  const { shells } = await runCell1f();
  const webgl = shells.get("webgl").log.captures;
  const webgpu = shells.get("webgpu").log.captures;
  assert.equal(webgl.length, 1);
  assert.equal(webgpu.length, 1);
  assert.deepEqual(
    [webgpu[0].width, webgpu[0].height],
    [webgl[0].width, webgl[0].height],
  );
  assert.deepEqual([webgl[0].width, webgl[0].height], [1280, 720]);
  assert.deepEqual(webgl[0].chromeLeft, []);
  assert.deepEqual(webgpu[0].chromeLeft, []);
});

test("W6: the pin runs before the settle and the strip before the capture, and the size is read again after the strip", async () => {
  const { shells } = await runCell1f();
  for (const shell of shells.values()) {
    const steps = shell.log.steps;
    assert.ok(steps.indexOf("pin") < steps.indexOf("settle"), steps.join(">"));
    assert.ok(
      steps.indexOf("settle") < steps.indexOf("shell") &&
        steps.indexOf("shell") < steps.indexOf("strip") &&
        steps.indexOf("strip") < steps.indexOf("capture"),
      steps.join(">"),
    );
    assert.equal(
      steps.filter((step) => step === "size").length,
      2,
      "measured once after the pin and once before the capture",
    );
    assert.ok(
      steps.lastIndexOf("size") > steps.indexOf("strip") &&
        steps.lastIndexOf("size") < steps.indexOf("capture"),
      steps.join(">"),
    );
  }
});

test("W7: a canvas that never measures the declared size refuses demo-canvas-size with the sizes it saw and the gate it read, and captures nothing", async () => {
  const outcome = await refusalOf(
    runPiece(
      { renderer: "webgpu", consoleOpen: true, ignorePin: true },
      {
        canvasSize: VIEWPORT,
        stripChrome: true,
        budgets: { sizeMs: 1 },
      },
    ),
  );
  assert.equal(outcome.reason, "demo-canvas-size");
  assert.equal(outcome.details.measured.cssHeight, CONSOLE_OPEN_HEIGHT);
  assert.deepEqual(outcome.details.declared, VIEWPORT);
  assert.deepEqual(outcome.details.gate, {
    errors: [],
    deviceLost: null,
    armedDevices: 1,
  });
  assert.ok(outcome.message.includes("1280x520"), outcome.message);
});

test("W8: a chrome element the strip does not know refuses demo-chrome-leftover naming it, reads the gate and captures nothing", async () => {
  const shell = makeShell({ renderer: "webgl", extraOverlay: "mystery-panel" });
  try {
    const outcome = await refusalOf(
      captureSandcastle2Demo({
        page: { tag: "top-page" },
        request: {
          origin: ORIGIN,
          demoId: DEMO_ID,
          renderer: "webgl",
          frames: 240,
          canvasSize: VIEWPORT,
          stripChrome: true,
        },
        outputDirectory: "never-written",
        captures: [],
        dependencies: shell.dependencies,
      }),
    );
    assert.equal(outcome.reason, "demo-chrome-leftover");
    assert.deepEqual(outcome.details.chrome.leftovers, ["mystery-panel"]);
    assert.equal(outcome.details.gate.armedDevices, 1);
    assert.ok(!shell.log.steps.includes("capture"));
  } finally {
    shell.dispose();
  }
});

test("W9: a strip that answers nothing is a refusal, never a pass", async () => {
  const outcome = await refusalOf(
    runPiece(
      { renderer: "webgl", dropStrip: true },
      { canvasSize: VIEWPORT, stripChrome: true },
    ),
  );
  assert.equal(outcome.reason, "demo-chrome-leftover");
  assert.equal(outcome.details.chrome.leftovers, null);
});

test("W10: a chrome refusal on 1f is a cell-level NOT RUN with its reason and leaves no capture for that page", async () => {
  const { records } = await runCell1f({
    shellFor: (renderer) =>
      renderer === "webgpu" ? { extraOverlay: "mystery-panel" } : {},
  });
  const webgl = records.find((record) => record.renderer === "webgl");
  const webgpu = records.find((record) => record.renderer === "webgpu");
  assert.equal(webgl.notRun, null);
  assert.ok(webgl.capture);
  assert.ok(
    webgpu.notRun.startsWith("demo-chrome-leftover:"),
    String(webgpu.notRun),
  );
  assert.ok(!webgpu.capture);
});

test("W11: the demo shell's own chrome is a declared list", () => {
  assert.deepEqual(
    [...DEMO_SHELL_CHROME_SELECTORS],
    ["#toolbar", "#loadingOverlay"],
  );
});

test("W12: a console warning the WebGPU run frame logs, with both dials on, is in that page's receipt and not in the WebGL page's", async () => {
  const { records } = await runCell1f({
    consoleFor: (renderer) =>
      renderer === "webgpu"
        ? [
            ["log", "a plain log the pane ignores"],
            ["warning", "WebGPU: a warning that opens the pane"],
          ]
        : [["log", "a plain log the pane ignores"]],
  });
  const webgl = records.find((record) => record.renderer === "webgl");
  const webgpu = records.find((record) => record.renderer === "webgpu");
  // Both dials were on: the canvas was pinned, so the frame shows no trace.
  for (const record of [webgl, webgpu]) {
    assert.equal(record.notRun, null, `${record.renderer}: ${record.notRun}`);
    assert.equal(record.demo.layout.measured.cssHeight, VIEWPORT.height);
  }
  assert.equal(webgpu.console.count, 1);
  assert.deepEqual(webgpu.console.byType, { warning: 1 });
  assert.equal(webgpu.console.messages[0].type, "warning");
  assert.equal(
    webgpu.console.messages[0].text,
    "WebGPU: a warning that opens the pane",
  );
  assert.equal(webgl.console.count, 0);
  assert.deepEqual(webgl.console.messages, []);
});
