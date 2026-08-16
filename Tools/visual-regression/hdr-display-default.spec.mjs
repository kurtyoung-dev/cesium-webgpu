// hdr-display-default.spec.mjs — browser-free trust anchor for C12-28
// (NEW-HDR-DEFAULT-ON-HDR-CAPABLE-DISPLAYS). Run with:
// @purpose Acceptance for HDR-defaults-on on HDR displays: pins the pure decision function because headless Edge cannot synthesize (dynamic-range: high).
// @status ACTIVE
//
//   node --test Tools/visual-regression/hdr-display-default.spec.mjs
//
// ── WHY THIS SPEC IS THE ACCEPTANCE, NOT A PROBE ────────────────────────────
//
// The feature's headline behaviour — "highDynamicRange defaults ON" — fires
// only on a display that reports `(dynamic-range: high)`. Headless Edge on
// this machine reports the opposite, and a Playwright probe CANNOT synthesize
// the media feature (there is no CDP override for `dynamic-range`, unlike
// `prefers-color-scheme`). So a probe could only ever confirm the SDR leg,
// which is the leg required to be byte-identical to the old behaviour — i.e.
// it would pass identically with the feature reverted. That is a vacuous gate.
//
// The falsifiable content is therefore moved into a pure decision function and
// pinned here, over all five inputs, including the three mutants the C12 row's
// constraints name:
//
//   1. a user-set value must win, permanently and in both directions;
//   2. a non-HDR display must not flip anything;
//   3. a host without `matchMedia` must not throw.
//
// What remains owed is a MANUAL maintainer check on real HDR hardware: open
// the viewer on an HDR display and confirm `scene.highDynamicRange === true`
// without touching anything. That is recorded in the C12-28 ledger row.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  HDR_DISPLAY_MEDIA_QUERIES,
  HdrDecisionReason,
  HdrDisplayPolicy,
  anyListMatches,
  normalizeHdrDisplayPolicy,
  observeHdrDisplay,
  queryHdrDisplay,
  resolveHdrDefault,
} from "../../packages/engine/Source/Scene/HdrDisplayCapability.ts";

const SCENE_JS = fileURLToPath(
  new URL("../../packages/engine/Source/Scene/Scene.js", import.meta.url),
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A `MediaQueryList` stand-in with a controllable `matches` and a real
// listener registry, so the change path can be driven deterministically.
function fakeList(media, matches, { legacy = false } = {}) {
  const listeners = new Set();
  const list = {
    media,
    matches,
    dispatch() {
      for (const l of [...listeners]) {
        l({ matches: list.matches });
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
  if (legacy) {
    list.addListener = (l) => listeners.add(l);
    list.removeListener = (l) => listeners.delete(l);
  } else {
    list.addEventListener = (type, l) => {
      if (type === "change") {
        listeners.add(l);
      }
    };
    list.removeEventListener = (type, l) => {
      if (type === "change") {
        listeners.delete(l);
      }
    };
  }
  return list;
}

// A `window` stand-in whose `matchMedia` answers from a query→list map.
// Anything absent from the map is answered the way a browser answers an
// unknown media feature: `media === "not all"`, `matches === false`.
function fakeWindow(map, { throwOn = null } = {}) {
  return {
    matchMedia(query) {
      if (throwOn !== null && query === throwOn) {
        throw new Error("matchMedia exploded");
      }
      return map[query] ?? fakeList("not all", false);
    },
  };
}

// Baseline resolver input: HDR display, capable context, nothing user-set,
// scene currently SDR, policy at its default.
function baseInput(overrides = {}) {
  return {
    displayIsHdr: true,
    contextSupportsHdr: true,
    policy: HdrDisplayPolicy.SCENE,
    canvasExtendedRangeSupported: true,
    sceneHdrUserSet: false,
    canvasOutputUserSet: false,
    currentSceneHdr: false,
    currentCanvasOutput: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The decision function
// ---------------------------------------------------------------------------

describe("resolveHdrDefault — the C12-28 decision", () => {
  test("HDR display + capable context + untouched ⇒ flips ON", () => {
    const d = resolveHdrDefault(baseInput());
    assert.equal(d.applySceneHdr, true);
    assert.equal(d.sceneHdr, true);
    assert.equal(d.reason, HdrDecisionReason.HDR_DISPLAY);
  });

  test("is idempotent — a re-resolve after applying changes nothing", () => {
    const d = resolveHdrDefault(baseInput({ currentSceneHdr: true }));
    assert.equal(d.applySceneHdr, false);
    assert.equal(d.sceneHdr, true, "reports the current value, not a flip");
    assert.equal(d.reason, HdrDecisionReason.HDR_DISPLAY);
  });

  // MUTANT 1 — the constraint "must remain explicitly overridable by the app".
  test("MUTANT: a user-set value wins on an HDR display", () => {
    const d = resolveHdrDefault(
      baseInput({ sceneHdrUserSet: true, currentSceneHdr: false }),
    );
    assert.equal(d.applySceneHdr, false);
    assert.equal(d.sceneHdr, false);
    assert.equal(
      d.reason,
      HdrDecisionReason.HDR_DISPLAY,
      "the reason still reports the display truth — only the apply is vetoed",
    );
  });

  test("MUTANT: a user-set value wins in the other direction too", () => {
    // App pinned HDR ON; the window then moves to an SDR monitor. Detection
    // must NOT turn it off — the app owns the value.
    const d = resolveHdrDefault(
      baseInput({
        displayIsHdr: false,
        sceneHdrUserSet: true,
        currentSceneHdr: true,
      }),
    );
    assert.equal(d.applySceneHdr, false);
    assert.equal(d.sceneHdr, true);
  });

  // MUTANT 2 — "must not change behaviour on SDR displays".
  test("MUTANT: an SDR display does not flip anything ON", () => {
    const d = resolveHdrDefault(baseInput({ displayIsHdr: false }));
    assert.equal(d.applySceneHdr, false);
    assert.equal(d.sceneHdr, false);
    assert.equal(d.applyCanvasOutput, false);
    assert.equal(d.reason, HdrDecisionReason.SDR_DISPLAY);
  });

  test("moving from an HDR to an SDR monitor turns detection's own value back OFF", () => {
    const d = resolveHdrDefault(
      baseInput({ displayIsHdr: false, currentSceneHdr: true }),
    );
    assert.equal(d.applySceneHdr, true);
    assert.equal(d.sceneHdr, false);
    assert.equal(d.reason, HdrDecisionReason.SDR_DISPLAY);
  });

  // MUTANT 3's resolver half — see the queryHdrDisplay group for the no-throw
  // half. `undefined` must never be coerced to a decision.
  test("MUTANT: unknown display capability applies NOTHING", () => {
    for (const currentSceneHdr of [false, true]) {
      const d = resolveHdrDefault(
        baseInput({ displayIsHdr: undefined, currentSceneHdr }),
      );
      assert.equal(d.applySceneHdr, false);
      assert.equal(d.applyCanvasOutput, false);
      assert.equal(d.sceneHdr, currentSceneHdr);
      assert.equal(d.reason, HdrDecisionReason.DETECTION_UNAVAILABLE);
    }
  });

  test("a context that cannot do HDR vetoes the flip", () => {
    const d = resolveHdrDefault(baseInput({ contextSupportsHdr: false }));
    assert.equal(d.applySceneHdr, false);
    assert.equal(d.reason, HdrDecisionReason.CONTEXT_UNSUPPORTED);
  });

  test("an incapable context turns a detection-set value back OFF", () => {
    const d = resolveHdrDefault(
      baseInput({ contextSupportsHdr: false, currentSceneHdr: true }),
    );
    assert.equal(d.applySceneHdr, true);
    assert.equal(d.sceneHdr, false);
    assert.equal(d.reason, HdrDecisionReason.CONTEXT_UNSUPPORTED);
  });

  test("policy 'off' is a total escape hatch", () => {
    const d = resolveHdrDefault(baseInput({ policy: HdrDisplayPolicy.OFF }));
    assert.equal(d.applySceneHdr, false);
    assert.equal(d.applyCanvasOutput, false);
    assert.equal(d.reason, HdrDecisionReason.POLICY_OFF);
  });
});

describe("resolveHdrDefault — the canvas half", () => {
  test("default policy 'scene' never touches the canvas flag", () => {
    const d = resolveHdrDefault(baseInput());
    assert.equal(d.applySceneHdr, true);
    assert.equal(
      d.applyCanvasOutput,
      false,
      "extended-range canvas output stays opt-in",
    );
  });

  test("policy 'scene-and-canvas' enables both on an HDR display", () => {
    const d = resolveHdrDefault(
      baseInput({ policy: HdrDisplayPolicy.SCENE_AND_CANVAS }),
    );
    assert.equal(d.applySceneHdr, true);
    assert.equal(d.applyCanvasOutput, true);
    assert.equal(d.canvasOutput, true);
  });

  test("MUTANT: a context without canvas-extended-range support (WebGL) is skipped", () => {
    const d = resolveHdrDefault(
      baseInput({
        policy: HdrDisplayPolicy.SCENE_AND_CANVAS,
        canvasExtendedRangeSupported: false,
      }),
    );
    assert.equal(d.applySceneHdr, true, "the scene half still ships");
    assert.equal(d.applyCanvasOutput, false);
  });

  test("MUTANT: canvas output never outruns a user-pinned SDR scene", () => {
    // The app pinned `highDynamicRange = false`. An extended-range canvas fed
    // by an 8-bit framebuffer would be a strictly worse image.
    const d = resolveHdrDefault(
      baseInput({
        policy: HdrDisplayPolicy.SCENE_AND_CANVAS,
        sceneHdrUserSet: true,
        currentSceneHdr: false,
      }),
    );
    assert.equal(d.applySceneHdr, false);
    assert.equal(d.applyCanvasOutput, false);
  });

  test("MUTANT: a user-set canvas flag wins", () => {
    const d = resolveHdrDefault(
      baseInput({
        policy: HdrDisplayPolicy.SCENE_AND_CANVAS,
        canvasOutputUserSet: true,
      }),
    );
    assert.equal(d.applyCanvasOutput, false);
  });

  test("an SDR display turns a detection-set canvas flag back OFF", () => {
    const d = resolveHdrDefault(
      baseInput({
        policy: HdrDisplayPolicy.SCENE_AND_CANVAS,
        displayIsHdr: false,
        currentSceneHdr: true,
        currentCanvasOutput: true,
      }),
    );
    assert.equal(d.applySceneHdr, true);
    assert.equal(d.sceneHdr, false);
    assert.equal(d.applyCanvasOutput, true);
    assert.equal(d.canvasOutput, false);
  });
});

// ---------------------------------------------------------------------------
// Media-query probing
// ---------------------------------------------------------------------------

describe("queryHdrDisplay", () => {
  test("queries dynamic-range first, then video-dynamic-range", () => {
    assert.deepEqual(
      [...HDR_DISPLAY_MEDIA_QUERIES],
      ["(dynamic-range: high)", "(video-dynamic-range: high)"],
    );
  });

  test("an HDR display is detected", () => {
    const q = queryHdrDisplay(
      fakeWindow({
        "(dynamic-range: high)": fakeList("(dynamic-range: high)", true),
      }),
    );
    assert.equal(q.detectionAvailable, true);
    assert.equal(q.displayIsHdr, true);
    assert.equal(q.lists.length, 1);
  });

  test("an SDR display is detected as SDR, not as unknown", () => {
    const q = queryHdrDisplay(
      fakeWindow({
        "(dynamic-range: high)": fakeList("(dynamic-range: high)", false),
      }),
    );
    assert.equal(q.detectionAvailable, true);
    assert.equal(q.displayIsHdr, false);
  });

  test("falls back to video-dynamic-range when only that feature is understood", () => {
    const q = queryHdrDisplay(
      fakeWindow({
        "(video-dynamic-range: high)": fakeList(
          "(video-dynamic-range: high)",
          true,
        ),
      }),
    );
    assert.equal(q.detectionAvailable, true);
    assert.equal(q.displayIsHdr, true);
  });

  test("MUTANT: 'not all' is unknown, NOT SDR", () => {
    // Both features unrecognised — every list normalizes to "not all".
    const q = queryHdrDisplay(fakeWindow({}));
    assert.equal(q.detectionAvailable, false);
    assert.equal(q.displayIsHdr, undefined);
    assert.equal(q.lists.length, 0);
  });

  // MUTANT 3 — "missing matchMedia must not throw".
  test("MUTANT: hosts without matchMedia never throw", () => {
    for (const host of [
      undefined,
      null,
      {},
      { matchMedia: null },
      { matchMedia: 42 },
      { matchMedia: () => null },
      { matchMedia: () => ({}) },
      { matchMedia: () => ({ matches: "yes" }) },
    ]) {
      const q = queryHdrDisplay(host);
      assert.equal(
        q.detectionAvailable,
        false,
        `host: ${JSON.stringify(host)}`,
      );
      assert.equal(q.displayIsHdr, undefined);
      // And the resolver must then apply nothing — the two halves compose.
      const d = resolveHdrDefault(baseInput({ displayIsHdr: q.displayIsHdr }));
      assert.equal(d.applySceneHdr, false);
      assert.equal(d.reason, HdrDecisionReason.DETECTION_UNAVAILABLE);
    }
  });

  test("a matchMedia that throws is survived, and the other query still counts", () => {
    const q = queryHdrDisplay(
      fakeWindow(
        {
          "(video-dynamic-range: high)": fakeList(
            "(video-dynamic-range: high)",
            true,
          ),
        },
        { throwOn: "(dynamic-range: high)" },
      ),
    );
    assert.equal(q.detectionAvailable, true);
    assert.equal(q.displayIsHdr, true);
  });

  test("anyListMatches is an OR over the understood lists", () => {
    const a = fakeList("(dynamic-range: high)", false);
    const b = fakeList("(video-dynamic-range: high)", true);
    assert.equal(anyListMatches([]), false);
    assert.equal(anyListMatches([a]), false);
    assert.equal(anyListMatches([a, b]), true);
  });
});

describe("observeHdrDisplay", () => {
  test("fires on change and detaches on dispose", () => {
    const list = fakeList("(dynamic-range: high)", false);
    const seen = [];
    const dispose = observeHdrDisplay(
      fakeWindow({
        "(dynamic-range: high)": list,
      }),
      (v) => seen.push(v),
    );

    assert.equal(list.listenerCount(), 1);
    list.matches = true;
    list.dispatch();
    list.matches = false;
    list.dispatch();
    assert.deepEqual(seen, [true, false], "the monitor-move path is live");

    dispose();
    assert.equal(list.listenerCount(), 0);
    list.matches = true;
    list.dispatch();
    assert.deepEqual(seen, [true, false], "no callbacks after dispose");
  });

  test("supports the legacy addListener API (Safari < 14)", () => {
    const list = fakeList("(dynamic-range: high)", false, { legacy: true });
    const seen = [];
    const dispose = observeHdrDisplay(
      fakeWindow({
        "(dynamic-range: high)": list,
      }),
      (v) => seen.push(v),
    );
    list.matches = true;
    list.dispatch();
    assert.deepEqual(seen, [true]);
    dispose();
    assert.equal(list.listenerCount(), 0);
  });

  test("MUTANT: returns a usable disposer when detection is unavailable", () => {
    const dispose = observeHdrDisplay(undefined, () => {
      throw new Error("must not be called");
    });
    assert.equal(typeof dispose, "function");
    dispose();
    dispose(); // idempotent
  });

  test("a throwing callback does not escape into the browser's dispatch", () => {
    const list = fakeList("(dynamic-range: high)", false);
    const dispose = observeHdrDisplay(
      fakeWindow({
        "(dynamic-range: high)": list,
      }),
      () => {
        throw new Error("scene blew up");
      },
    );
    list.matches = true;
    assert.doesNotThrow(() => list.dispatch());
    dispose();
  });
});

describe("normalizeHdrDisplayPolicy", () => {
  test("passes through the three known values", () => {
    assert.equal(normalizeHdrDisplayPolicy("off"), "off");
    assert.equal(normalizeHdrDisplayPolicy("scene"), "scene");
    assert.equal(
      normalizeHdrDisplayPolicy("scene-and-canvas"),
      "scene-and-canvas",
    );
  });

  test("anything else becomes the documented default", () => {
    for (const bad of [undefined, null, "", "SCENE", true, 1, {}]) {
      assert.equal(normalizeHdrDisplayPolicy(bad), "scene");
    }
  });
});

// ---------------------------------------------------------------------------
// Scene wiring — the plumbing the pure half cannot see
// ---------------------------------------------------------------------------
//
// `Scene.js` cannot be imported in Node (it pulls the whole engine and needs a
// canvas), so the wiring is pinned structurally. Each assertion below maps to a
// way the feature could be silently defeated while every test above still
// passes.

describe("Scene.js wiring", () => {
  const source = readFileSync(SCENE_JS, "utf8");

  test("the constructor runs detection", () => {
    assert.match(source, /this\._initializeHdrDisplayDetection\(\);/);
    assert.match(
      source,
      /this\.highDynamicRange = false;[\s\S]{0,900}?this\._hdrUserSet = false;/,
      "the constructor's own SDR assignment must not count as a user override",
    );
  });

  test("both public setters record the override", () => {
    assert.match(
      source,
      /set highDynamicRange\(value\) \{[\s\S]{0,400}?this\._hdrUserSet = true;/,
    );
    assert.match(
      source,
      /set useHDRCanvasOutput\(value\) \{[\s\S]{0,400}?this\._useHDRCanvasOutputUserSet = true;/,
    );
  });

  test("the useHDRCanvasOutput override is recorded BEFORE the no-change early return", () => {
    const setter = source.slice(
      source.indexOf("set useHDRCanvasOutput(value)"),
    );
    const flagAt = setter.indexOf("_useHDRCanvasOutputUserSet = true");
    const returnAt = setter.indexOf("return;");
    assert.ok(flagAt >= 0 && returnAt >= 0);
    assert.ok(
      flagAt < returnAt,
      "assigning the value it already has is still an override",
    );
  });

  test("the detection write does not masquerade as a user override", () => {
    assert.match(
      source,
      /this\.highDynamicRange = decision\.sceneHdr;\s*\r?\n\s*this\._hdrUserSet = wasUserSet;/,
    );
    assert.match(
      source,
      /this\.useHDRCanvasOutput = decision\.canvasOutput;\s*\r?\n\s*this\._useHDRCanvasOutputUserSet = wasUserSet;/,
    );
  });

  test("the media-query listener is detached on destroy", () => {
    assert.match(source, /removeCallback\("_hdrDisplayUnsub"\);/);
  });

  test("the tonemap default is NOT touched (C12-28 constraint)", () => {
    assert.doesNotMatch(
      source,
      /Tonemapper\.ACES|tonemapper\s*=\s*['"]aces/i,
      "C12-28 explicitly forbids switching the default operator to ACES",
    );
  });

  test("the Jasmine suite stays display-independent", () => {
    // `Specs/createScene.js` already pinned `highDynamicRange = false` right
    // after construction, and under C12-28's detect-only-until-touched rule
    // that pin now STICKS — which is what keeps `gulp test` deterministic when
    // it runs on a maintainer's HDR monitor. Every engine spec routes through
    // this factory, so removing the line would silently make ~17k render
    // assertions depend on the dev machine's display.
    const createSceneJs = readFileSync(
      fileURLToPath(new URL("../../Specs/createScene.js", import.meta.url)),
      "utf8",
    );
    assert.match(createSceneJs, /scene\.highDynamicRange = false;/);
  });
});
