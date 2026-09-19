// widgets-teardown-contract.spec.mjs — Node acceptance for the widget teardown
// contract. Pure Node, no browser, no GPU, no build:
//
//   node --test Tools/visual-regression/widgets-teardown-contract.spec.mjs
//
// @purpose Pins that the three inspector mixins remove and destroy the panel they append to the caller's container, that FullscreenButtonViewModel unsubscribes from the document it subscribed to, that Geocoder removes every listener its constructor added, and that Animation removes the <style> node it inserted.
// @status ACTIVE
//
// ── WHY THE SOURCES ARE COMPILED RATHER THAN IMPORTED ───────────────────────
//
// `packages/widgets/Source/**` imports `@cesium/engine`, whose entry point
// `packages/engine/index.js` is a GENERATED barrel — it does not exist in a
// fresh clone (it is build output, and gitignored), so `import` of any widget
// module fails in Node before a build. The widgets also reach for `document`,
// `MutationObserver` and `window` at construction time.
//
// So this spec executes the REAL source text of each module through
// `vm.compileFunction`, with the module's imports turned into parameters that
// receive minimal stubs, and a minimal DOM whose elements count their own
// listeners and children. That is the real constructor and the real destroy()
// body running over a DOM the test can measure — not a grep of the source.
//
// The mutant leg re-points the source root: copy the file(s) under a temp
// root with the same relative paths, restore the pre-fix text, and run with
//
//   WIDGETS_TEARDOWN_SOURCE_ROOT=<temp root> node --test <this file>
//
// A restored (or `if (false && …)`-guarded) fix changes the numbers this spec
// reads — the panel stays a child, the listener count stays 1, the <style>
// node stays in <head> — so the mutant is RED on output, not on absence.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SOURCE_ROOT = process.env.WIDGETS_TEARDOWN_SOURCE_ROOT ?? REPO;

// ── the module loader ───────────────────────────────────────────────────────

/**
 * Compiles a widget module's real source with its imports replaced by
 * injected bindings, and returns its default export.
 */
function loadWidgetModule(relativePath, injected) {
  const file = path.join(SOURCE_ROOT, relativePath);
  const source = fs.readFileSync(file, "utf8");
  const body = source
    .replace(/^import\s[\s\S]*?from\s+"[^"]*";/gm, "")
    .replace(/^export default (\w+);/m, "return $1;");
  const names = Object.keys(injected);
  const factory = vm.compileFunction(body, names, { filename: file });
  return factory(...names.map((name) => injected[name]));
}

// ── the minimal DOM ─────────────────────────────────────────────────────────

class StubNode {
  constructor(ownerDocument, tagName, namespaceURI) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = [];
    this.attributes = Object.create(null);
    this.style = { cssText: "" };
    this.className = "";
    this.textContent = "";
    this.clientWidth = 0;
    this.clientHeight = 0;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get childElementCount() {
    return this.childNodes.length;
  }

  appendChild(child) {
    if (child.parentNode !== null) {
      child.parentNode.removeChild(child);
    }
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentNode !== null) {
      child.parentNode.removeChild(child);
    }
    const index = this.childNodes.indexOf(reference);
    if (index < 0) {
      this.childNodes.push(child);
    } else {
      this.childNodes.splice(index, 0, child);
    }
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index < 0) {
      throw new Error(`NotFoundError: ${child.tagName} is not a child`);
    }
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode !== null) {
      this.parentNode.removeChild(this);
    }
  }

  contains(node) {
    let current = node;
    while (current !== null && current !== undefined) {
      if (current === this) {
        return true;
      }
      current = current.parentNode;
    }
    return false;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  setAttributeNS(namespace, name, value) {
    this.attributes[name] = value;
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  addEventListener(type, listener, capture) {
    this.listeners.push({ type, listener, capture: capture === true });
  }

  removeEventListener(type, listener, capture) {
    const index = this.listeners.findIndex(
      (entry) =>
        entry.type === type &&
        entry.listener === listener &&
        entry.capture === (capture === true),
    );
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }
}

function makeDocument() {
  const document = {
    nodeType: 9,
    listeners: [],
    createElement(tagName) {
      return new StubNode(document, tagName);
    },
    createElementNS(namespaceURI, tagName) {
      return new StubNode(document, tagName, namespaceURI);
    },
    createTextNode(text) {
      const node = new StubNode(document, "#text");
      node.nodeType = 3;
      node.textContent = text;
      return node;
    },
    addEventListener(type, listener, capture) {
      document.listeners.push({ type, listener, capture: capture === true });
    },
    removeEventListener(type, listener, capture) {
      const index = document.listeners.findIndex(
        (entry) =>
          entry.type === type &&
          entry.listener === listener &&
          entry.capture === (capture === true),
      );
      if (index >= 0) {
        document.listeners.splice(index, 1);
      }
    },
  };
  document.head = new StubNode(document, "head");
  document.body = new StubNode(document, "body");
  return document;
}

class StubColor {
  constructor(red = 1, green = 1, blue = 1, alpha = 1) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    this.alpha = alpha;
  }
  static fromCssColorString() {
    return new StubColor();
  }
  toCssColorString() {
    return "rgba(255,255,255,1)";
  }
}

class StubMutationObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  disconnect() {}
}

// ── shared engine stubs ─────────────────────────────────────────────────────

const defined = (value) => value !== undefined && value !== null;
class DeveloperError extends Error {}
const Check = {
  typeOf: {
    object() {},
  },
};
const getElement = (element) => element;
const destroyObject = (object) => {
  object.isDestroyed = () => true;
  return object;
};

// The real `wrapFunction` (packages/engine/Source/Core/wrapFunction.js), whose
// contract the mixins depend on: the new function runs BEFORE the old one, so
// the inspector is torn down while the Viewer's scene is still alive.
function wrapFunction(object, oldFunction, newFunction) {
  return function () {
    newFunction.apply(object, arguments);
    oldFunction.apply(object, arguments);
  };
}

/** Stands in for CesiumInspector / Cesium3DTilesInspector / VoxelInspector. */
class StubInspector {
  constructor(container, scene) {
    this._container = container;
    this._scene = scene;
    this._destroyed = false;
    this._element = container.ownerDocument.createElement("div");
    container.appendChild(this._element);
  }
  isDestroyed() {
    return this._destroyed;
  }
  destroy() {
    this._container.removeChild(this._element);
    this._destroyed = true;
    return undefined;
  }
}

/**
 * Stands in for Viewer: `destroy()` removes only the Viewer's own element
 * (`Viewer.js:1466 this._container.removeChild(this._element);`), which is
 * the whole reason a mixin's panel survives teardown unless the mixin wraps
 * `destroy` itself.
 */
function makeViewer(document) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const element = document.createElement("div");
  container.appendChild(element);
  const viewer = {
    container: container,
    scene: {},
    _element: element,
    _destroyed: false,
    destroy() {
      container.removeChild(element);
      viewer._destroyed = true;
    },
  };
  return viewer;
}

function runInspectorMixinCase(relativePath, inspectorName) {
  const document = makeDocument();
  const mixin = loadWidgetModule(relativePath, {
    document,
    defined,
    DeveloperError,
    Check,
    wrapFunction,
    [inspectorName]: StubInspector,
  });

  const viewer = makeViewer(document);
  const panelsBefore = viewer.container.childElementCount;
  mixin(viewer);
  assert.equal(
    viewer.container.childElementCount,
    panelsBefore + 1,
    "the mixin appends its panel to the caller's container",
  );

  const panel = viewer.container.childNodes[panelsBefore];

  viewer.destroy();

  return { viewer, panel };
}

// ── widgets-10: the inspector mixins ────────────────────────────────────────

const INSPECTOR_MIXINS = [
  [
    "packages/widgets/Source/Viewer/viewerCesiumInspectorMixin.js",
    "CesiumInspector",
    "cesiumInspector",
  ],
  [
    "packages/widgets/Source/Viewer/viewerCesium3DTilesInspectorMixin.js",
    "Cesium3DTilesInspector",
    "cesium3DTilesInspector",
  ],
  [
    "packages/widgets/Source/Viewer/viewerVoxelInspectorMixin.js",
    "VoxelInspector",
    "voxelInspector",
  ],
];

for (const [relativePath, importName, accessor] of INSPECTOR_MIXINS) {
  test(`widgets-10: ${path.basename(relativePath)} leaves no panel in the caller's container after viewer.destroy()`, () => {
    const { viewer, panel } = runInspectorMixinCase(relativePath, importName);

    assert.equal(
      viewer._destroyed,
      true,
      "the wrapped destroy still runs the Viewer's own destroy",
    );
    assert.equal(
      viewer.container.childElementCount,
      0,
      "nothing the Viewer or the mixin added is left in the caller's container",
    );
    assert.equal(
      panel.parentNode === null,
      true,
      "the inspector panel is no longer in the caller's container",
    );
    assert.equal(
      viewer[accessor].isDestroyed(),
      true,
      "the inspector itself is destroyed",
    );
  });
}

// ── widgets-01: FullscreenButtonViewModel ───────────────────────────────────

function loadFullscreenButtonViewModel(document) {
  const knockout = makeKnockoutStub();
  return loadWidgetModule(
    "packages/widgets/Source/FullscreenButton/FullscreenButtonViewModel.js",
    {
      document,
      defined,
      destroyObject,
      DeveloperError,
      Fullscreen: {
        fullscreen: false,
        enabled: true,
        changeEventName: "fullscreenchange",
        requestFullscreen() {},
        exitFullscreen() {},
      },
      getElement,
      knockout,
      createCommand: () => function () {},
    },
  );
}

function makeKnockoutStub() {
  return {
    observable(value) {
      const observable = function (next) {
        if (arguments.length > 0) {
          value = next;
        }
        return value;
      };
      return observable;
    },
    defineProperty(object, name, accessor) {
      if (typeof accessor === "function") {
        Object.defineProperty(object, name, {
          configurable: true,
          get: accessor.bind(object),
        });
        return;
      }
      Object.defineProperty(object, name, {
        configurable: true,
        get: accessor.get,
        set: accessor.set ?? function () {},
      });
    },
    getObservable() {
      return function () {};
    },
    applyBindings() {},
    cleanNode() {},
  };
}

test("widgets-01: FullscreenButtonViewModel unsubscribes from the document it subscribed to", () => {
  const hostDocument = makeDocument();
  const frameDocument = makeDocument();
  const FullscreenButtonViewModel = loadFullscreenButtonViewModel(hostDocument);

  // The container lives in another document — an iframe or a popped-out
  // window — so `ownerDocument` is not the global `document`.
  const container = frameDocument.createElement("div");
  frameDocument.body.appendChild(container);

  const before = frameDocument.listeners.length;
  const viewModel = new FullscreenButtonViewModel(undefined, container);
  assert.equal(
    frameDocument.listeners.length,
    before + 1,
    "the constructor subscribes to the container's own document",
  );

  viewModel.destroy();

  assert.equal(
    frameDocument.listeners.length,
    before,
    "destroy() removes the listener from the document it was added to",
  );
  assert.equal(
    hostDocument.listeners.length,
    0,
    "the global document was never the subscriber and is left alone",
  );
});

// ── widgets-02: Geocoder ────────────────────────────────────────────────────

function loadGeocoder(document, supportsPointerEvents) {
  class StubGeocoderViewModel {
    constructor(options) {
      this.options = options;
      this._destroyed = false;
    }
    destroy() {
      this._destroyed = true;
    }
  }
  return loadWidgetModule("packages/widgets/Source/Geocoder/Geocoder.js", {
    document,
    defined,
    destroyObject,
    DeveloperError,
    FeatureDetection: {
      supportsPointerEvents: () => supportsPointerEvents,
    },
    getElement,
    knockout: makeKnockoutStub(),
    GeocoderViewModel: StubGeocoderViewModel,
  });
}

for (const supportsPointerEvents of [true, false]) {
  const branch = supportsPointerEvents ? "pointer" : "legacy mouse/touch";
  test(`widgets-02: Geocoder removes every listener its constructor added (${branch} branch)`, () => {
    const document = makeDocument();
    const Geocoder = loadGeocoder(document, supportsPointerEvents);

    // A caller-owned, long-lived container — the exposed case.
    const container = document.createElement("div");
    document.body.appendChild(container);

    const geocoder = new Geocoder({ container: container, scene: {} });
    const added = container.listeners.length + document.listeners.length;
    assert.ok(added > 0, "the constructor registered listeners");

    geocoder.destroy();

    assert.deepEqual(
      container.listeners.map((entry) => entry.type),
      [],
      "no listener registered on the caller's container survives destroy()",
    );
    assert.deepEqual(
      document.listeners.map((entry) => entry.type),
      [],
      "no listener registered on the document survives destroy()",
    );
  });
}

// ── widgets-04: Animation ───────────────────────────────────────────────────

function loadAnimation(document) {
  return loadWidgetModule("packages/widgets/Source/Animation/Animation.js", {
    document,
    MutationObserver: StubMutationObserver,
    Color: StubColor,
    defined,
    destroyObject,
    DeveloperError,
    getElement,
    subscribeAndEvaluate: () => ({ dispose() {} }),
  });
}

function makeAnimationViewModel() {
  return {
    timeLabel: "",
    dateLabel: "",
    multiplierLabel: "",
    shuttleRingAngle: 0,
    shuttleRingDragging: false,
    pauseViewModel: { command: () => {} },
    playReverseViewModel: { command: () => {} },
    playForwardViewModel: { command: () => {} },
    playRealtimeViewModel: { command: () => {} },
    setShuttleRingTicks() {},
  };
}

test("widgets-04: Animation removes the <style> node it inserted into <head>", () => {
  const document = makeDocument();
  const Animation = loadAnimation(document);

  const baseline = document.head.childElementCount;

  const containerA = document.createElement("div");
  const animationA = new Animation(containerA, makeAnimationViewModel());
  assert.equal(
    document.head.childElementCount,
    baseline + 1,
    "the constructor inserts its own <style> node",
  );

  const containerB = document.createElement("div");
  const animationB = new Animation(containerB, makeAnimationViewModel());
  assert.equal(
    document.head.childElementCount,
    baseline + 2,
    "a second Animation inserts a second node — the nodes are not shared",
  );

  animationA.destroy();
  assert.equal(
    document.head.childElementCount,
    baseline + 1,
    "destroying one Animation removes only its own node",
  );

  animationB.destroy();
  assert.equal(
    document.head.childElementCount,
    baseline,
    "<head> is back to its prior child count after construct + destroy",
  );
});

// ── widgets-16: the shadowed suite variables ────────────────────────────────
//
// The four Jasmine suites below are the karma leg and cannot be run here. What
// CAN be run here is their own source, through a minimal Jasmine shim: the
// `describe`/`it`/`beforeEach`/`afterEach` bodies are the real ones, the
// widget constructors are counting stubs, and the assertion is a COUNT — how
// many instances the target `it` created, and how many of those the suite's
// `afterEach` destroyed. An inner `const` that shadows the suite variable
// leaves `afterEach` looking at the outer binding (undefined when the suite is
// run from the top, as here), so the count of destroyed instances is 0.
//
// The shim's `expect` is permissive by design — it runs the spec's control
// flow without adjudicating the spec's own expectations. Nothing below asserts
// anything about what those expectations claim; the assertions are only about
// construction and teardown counts, which the shim measures directly.

/** The identifiers a module's import statements bind. */
function importedNames(source) {
  const names = new Set();
  const statement = /^import\s+([\s\S]*?)\s+from\s+"[^"]*";/gm;
  let match;
  while ((match = statement.exec(source)) !== null) {
    const clause = match[1];
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced !== null) {
      for (const part of braced[1].split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          .trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) {
          names.add(name);
        }
      }
    }
    const withoutBraces = clause.replace(/\{[\s\S]*\}/, "");
    for (const part of withoutBraces.split(",")) {
      const name = part.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        names.add(name);
      }
    }
  }
  return names;
}

/** A stub for any imported symbol the spec body touches but this test does not. */
function autoStub(label) {
  const target = function () {};
  return new Proxy(target, {
    get(t, property) {
      if (
        property === "then" ||
        property === "prototype" ||
        property === "constructor" ||
        typeof property === "symbol"
      ) {
        return Reflect.get(t, property);
      }
      if (!(property in t)) {
        t[property] = autoStub(`${label}.${String(property)}`);
      }
      return t[property];
    },
    set(t, property, value) {
      t[property] = value;
      return true;
    },
    has() {
      return true;
    },
    apply() {
      return autoStub(`${label}()`);
    },
    construct() {
      return autoStub(`new ${label}`);
    },
  });
}

function makeExpect() {
  const matcher = () => undefined;
  const result = new Proxy(
    {},
    {
      get(target, property) {
        if (property === "not") {
          return result;
        }
        return matcher;
      },
    },
  );
  return () => result;
}

function makeSpyOn() {
  return function spyOn(object, name) {
    const original = object[name];
    let implementation = () => undefined;
    const spy = function (...args) {
      spy.calls._count += 1;
      return implementation.apply(object, args);
    };
    spy.calls = {
      _count: 0,
      count() {
        return spy.calls._count;
      },
      reset() {
        spy.calls._count = 0;
      },
      any() {
        return spy.calls._count > 0;
      },
    };
    spy.and = {
      callThrough() {
        implementation =
          typeof original === "function" ? original : () => undefined;
        return spy;
      },
      callFake(fake) {
        implementation = fake;
        return spy;
      },
      returnValue(value) {
        implementation = () => value;
        return spy;
      },
      stub() {
        implementation = () => undefined;
        return spy;
      },
    };
    object[name] = spy;
    return spy;
  };
}

/**
 * Runs one `it` of a real spec file, with its enclosing `beforeEach` and
 * `afterEach` hooks, and returns whether the hooks ran and what threw.
 */
async function runSpecCase(relativePath, testName, injected) {
  const root = { hooksBefore: [], hooksAfter: [], tests: [], parent: null };
  const registered = [];
  let current = root;

  const describe = (name, body) => {
    const suite = {
      name,
      hooksBefore: [],
      hooksAfter: [],
      tests: [],
      parent: current,
    };
    const previous = current;
    current = suite;
    body();
    current = previous;
  };
  const it = (name, body) => {
    const test = { name, body, suite: current };
    current.tests.push(test);
    registered.push(test);
  };
  const noop = () => undefined;

  const harness = {
    describe,
    fdescribe: describe,
    xdescribe: noop,
    it,
    fit: it,
    xit: noop,
    beforeEach: (fn) => current.hooksBefore.push(fn),
    afterEach: (fn) => current.hooksAfter.push(fn),
    beforeAll: (fn) => current.hooksBefore.push(fn),
    afterAll: noop,
    expect: makeExpect(),
    spyOn: makeSpyOn(),
    jasmine: autoStub("jasmine"),
    pollToPromise: () => Promise.resolve(),
  };

  // Every identifier the spec imports becomes a parameter; anything the test
  // does not care about gets an auto-stub so the describe body can run.
  const source = fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");
  const bindings = {};
  for (const name of importedNames(source)) {
    bindings[name] = autoStub(name);
  }
  Object.assign(bindings, harness, injected);

  loadWidgetModule(relativePath, bindings);

  const found = registered.filter((test) => test.name === testName);
  assert.equal(
    found.length,
    1,
    `exactly one it(${JSON.stringify(testName)}) in ${relativePath}`,
  );

  const test = found[0];
  const chain = [];
  for (let suite = test.suite; suite !== null; suite = suite.parent) {
    chain.unshift(suite);
  }

  let thrown;
  for (const suite of chain) {
    for (const hook of suite.hooksBefore) {
      await hook();
    }
  }
  try {
    await test.body();
  } catch (error) {
    thrown = error;
  }
  for (const suite of [...chain].reverse()) {
    for (const hook of suite.hooksAfter) {
      await hook();
    }
  }
  return { thrown };
}

/** A widget stub that counts its own construction and destruction. */
function makeCountingWidget(counters) {
  return class CountingWidget {
    constructor(container) {
      this._container = container;
      this._destroyed = false;
      counters.constructed += 1;
      if (
        container !== undefined &&
        container !== null &&
        typeof container.appendChild === "function" &&
        typeof container.ownerDocument?.createElement === "function"
      ) {
        this._element = container.ownerDocument.createElement("div");
        container.appendChild(this._element);
      }
      return new Proxy(this, {
        get(target, property) {
          if (property in target) {
            return target[property];
          }
          if (typeof property === "symbol" || property === "then") {
            return undefined;
          }
          target[property] = autoStub(`widget.${String(property)}`);
          return target[property];
        },
        set(target, property, value) {
          target[property] = value;
          return true;
        },
      });
    }
    isDestroyed() {
      return this._destroyed;
    }
    destroy() {
      if (this._destroyed !== true) {
        this._destroyed = true;
        counters.destroyed += 1;
      }
      return undefined;
    }
  };
}

// ── widgets-16 cases ────────────────────────────────────────────────────────

test("widgets-16: AnimationSpec's afterEach destroys the Animation created by 'Can create with container not in the DOM'", async () => {
  const document = makeDocument();
  const counters = { constructed: 0, destroyed: 0 };
  const { thrown } = await runSpecCase(
    "packages/widgets/Specs/Animation/AnimationSpec.js",
    "Can create with container not in the DOM",
    {
      document,
      defined,
      Animation: makeCountingWidget(counters),
    },
  );

  assert.equal(thrown, undefined, "the it body ran to completion");
  assert.equal(counters.constructed, 1, "the test constructed one Animation");
  assert.equal(
    counters.destroyed,
    1,
    "the suite's afterEach destroyed the Animation the test created",
  );
});

test("widgets-16: InfoBoxSpec's afterEach destroys the InfoBox created by 'can set description body'", async () => {
  const document = makeDocument();
  const counters = { constructed: 0, destroyed: 0 };
  const { thrown } = await runSpecCase(
    "packages/widgets/Specs/InfoBox/InfoBoxSpec.js",
    "can set description body",
    {
      document,
      defined,
      InfoBox: makeCountingWidget(counters),
    },
  );

  assert.equal(thrown, undefined, "the it body ran to completion");
  assert.equal(counters.constructed, 1, "the test constructed one InfoBox");
  assert.equal(
    counters.destroyed,
    1,
    "the suite's afterEach destroyed the InfoBox the test created",
  );
});

test("widgets-16: CesiumWidgetSpec's afterEach destroys the widget created by 'zoomTo zooms to entity when globe is disabled'", async () => {
  const document = makeDocument();
  const counters = { constructed: 0, destroyed: 0 };
  const { thrown } = await runSpecCase(
    "packages/engine/Specs/Widget/CesiumWidgetSpec.js",
    "zoomTo zooms to entity when globe is disabled",
    {
      document,
      window: { webglStub: false, devicePixelRatio: 1 },
      defined,
      CesiumWidget: makeCountingWidget(counters),
      isOfflineLane: () => false,
    },
  );

  assert.equal(thrown, undefined, "the it body ran to completion");
  assert.equal(counters.constructed, 1, "the test constructed one widget");
  assert.equal(
    counters.destroyed,
    1,
    "the suite's afterEach destroyed the widget the test created",
  );
});

// The remaining four sites DO call destroy() at the end of the body — read at
// this lane's HEAD: `CesiumWidgetSpec.js:630 widget.destroy();`,
// `ViewerSpec.js:1199/:1225/:1258 viewer.destroy();`. Since
// `stopSpecOnExpectationFailure` is false repo-wide, a red expectation does
// NOT skip those lines; only a THROW between construction and the destroy
// does, and then the shadowed binding leaves the suite's afterEach with
// nothing to clean up. Each case below makes the body throw after the widget
// exists, which is the live failure mode.
const THROW_PATH_CASES = [
  [
    "packages/engine/Specs/Widget/CesiumWidgetSpec.js",
    "raises an event when the tracked entity changes",
    "CesiumWidget",
  ],
  [
    "packages/widgets/Specs/Viewer/ViewerSpec.js",
    "can get and set selectedEntity",
    "createViewer",
  ],
  [
    "packages/widgets/Specs/Viewer/ViewerSpec.js",
    "raises an event when the selected entity changes",
    "createViewer",
  ],
  [
    "packages/widgets/Specs/Viewer/ViewerSpec.js",
    "selectedEntity sets InfoBox properties",
    "createViewer",
  ],
];

for (const [relativePath, testName, factory] of THROW_PATH_CASES) {
  test(`widgets-16: ${path.basename(relativePath)}'s afterEach destroys the widget created by '${testName}' when the body throws`, async () => {
    const document = makeDocument();
    const counters = { constructed: 0, destroyed: 0 };
    const CountingWidget = makeCountingWidget(counters);

    class ThrowingEntity {
      constructor() {
        throw new Error("simulated failure after the widget was created");
      }
    }

    const injected = {
      document,
      window: { webglStub: false, devicePixelRatio: 1 },
      defined,
      Entity: ThrowingEntity,
      isOfflineLane: () => false,
    };
    if (factory === "createViewer") {
      injected.createViewer = (container) => new CountingWidget(container);
    } else {
      injected.CesiumWidget = CountingWidget;
    }

    const { thrown } = await runSpecCase(relativePath, testName, injected);

    assert.equal(
      thrown?.message,
      "simulated failure after the widget was created",
      "the body threw after the widget was created",
    );
    assert.equal(counters.constructed, 1, "the test constructed one widget");
    assert.equal(
      counters.destroyed,
      1,
      "the suite's afterEach destroyed the widget the test created",
    );
  });
}
