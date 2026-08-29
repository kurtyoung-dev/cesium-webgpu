// sandcastle2-renderer-gate.spec.mjs — pure-Node coverage for the Sandcastle2
// sweep helpers. No browser, no network, no GPU.
//
// @purpose Contract spec for the Sandcastle2 backend sweep helpers: id enumeration against the real gallery, URL construction, and the requested-vs-actual renderer predicate.
// @status ACTIVE
//
// WHAT THIS PROTECTS. The sweep's whole value is one predicate: a demo that
// renders beautifully on the wrong backend must FAIL. Everything else the sweep
// checks — no console errors, frames advanced — already passes in that state,
// which is exactly why the defect class survived. So the predicate is tested
// directly, including a mutant where it is made permissive and the failing case
// is required to stop failing.
//
// Id enumeration is tested against the REAL gallery rather than a fixture: the
// sweep's claim is "every demo the app can load", and a fixture would let the
// enumerator and the gallery drift apart without anything going red.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EVALUATE_TIMEOUT,
  NO_VIEWER_IDS,
  SWEEPABLE_RENDERERS,
  buildSandcastle2Url,
  deriveNoViewerIds,
  enumerateGalleryIds,
  evaluateFrameGate,
  evaluateRendererGate,
  evaluateWithDeadline,
  isDevelopmentDemo,
  isNoViewerId,
  readRendererStateInPage,
  stripJsSourceComments,
} from "./lib/sandcastle2-renderer-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GALLERY_DIR = resolve(
  HERE,
  "..",
  "..",
  "packages",
  "sandcastle",
  "gallery",
);

// --- Group A: id enumeration against the real gallery ---------------------

test("A1 every enumerated id is a real, loadable demo directory", () => {
  const ids = enumerateGalleryIds(GALLERY_DIR);
  assert.ok(ids.length > 300, `expected the full gallery, got ${ids.length}`);
  for (const id of ids) {
    assert.ok(
      existsSync(join(GALLERY_DIR, id, "main.js")),
      `${id} has no main.js`,
    );
  }
});

test("A2 the listing is sorted and free of duplicates", () => {
  const ids = enumerateGalleryIds(GALLERY_DIR);
  assert.deepEqual(ids, [...ids].sort(), "not sorted");
  assert.equal(new Set(ids).size, ids.length, "duplicate id");
});

test("A3 nothing loadable is missed", () => {
  // Independent recount straight off the filesystem: the enumerator's claim is
  // "every directory with a main.js", so the check is that claim, not a copy of
  // the enumerator.
  const expected = readdirSync(GALLERY_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(GALLERY_DIR, name, "main.js")))
    .sort();
  assert.deepEqual(enumerateGalleryIds(GALLERY_DIR), expected);
});

test("A4 development demos are included by default and excludable on request", () => {
  const all = enumerateGalleryIds(GALLERY_DIR);
  const published = enumerateGalleryIds(GALLERY_DIR, {
    includeDevelopment: false,
  });
  assert.ok(published.length < all.length, "nothing was excluded");
  for (const id of published) {
    assert.ok(all.includes(id), `${id} is not a subset member`);
  }

  // Every id the filter dropped must actually say so in its own metadata, and
  // every id it kept must not.
  const dropped = all.filter((id) => !published.includes(id));
  for (const id of dropped) {
    assert.match(
      readFileSync(join(GALLERY_DIR, id, "sandcastle.yaml"), "utf8"),
      /^development:\s*true\s*$/m,
      `${id} was dropped but is not marked development`,
    );
  }
  for (const id of published) {
    assert.equal(
      isDevelopmentDemo(join(GALLERY_DIR, id)),
      false,
      `${id} was kept but is marked development`,
    );
  }
});

// --- Group B: URL construction --------------------------------------------

test("B1 the editor URL carries both the id and the renderer", () => {
  const url = buildSandcastle2Url({
    base: "http://localhost:8134",
    id: "hello-world",
    renderer: "webgpu",
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/Apps/Sandcastle2/index.html");
  assert.equal(parsed.searchParams.get("id"), "hello-world");
  assert.equal(parsed.searchParams.get("renderer"), "webgpu");
});

test("B2 the standalone page is a distinct target", () => {
  const url = buildSandcastle2Url({
    base: "http://localhost:8134",
    id: "cesium-widget",
    renderer: "webgl",
    standalone: true,
  });
  assert.match(url, /\/Apps\/Sandcastle2\/standalone\.html\?/);
  assert.equal(new URL(url).searchParams.get("renderer"), "webgl");
});

test("B3 ids with URL-significant characters survive the round trip", () => {
  const id = "3d-tiles-feature-picking";
  const url = buildSandcastle2Url({
    base: "http://localhost:8134/",
    id,
    renderer: "webgpu",
  });
  assert.equal(new URL(url).searchParams.get("id"), id);
});

// --- Group C: the predicate that carries the whole sweep -------------------

test("C1 all contexts on the requested backend passes", () => {
  const verdict = evaluateRendererGate({
    contexts: [{ id: "ctx-a3f7", rendererType: "webgpu" }],
    requested: "webgpu",
  });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.deepEqual(verdict.observed, ["webgpu"]);
});

test("C2 a demo that silently ran WebGL fails", () => {
  const verdict = evaluateRendererGate({
    contexts: [{ id: "ctx-1", rendererType: "webgl" }],
    requested: "webgpu",
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /requested webgpu but ran webgl/);
});

test("C3 a compatibility fallback is reported, not waved through", () => {
  const verdict = evaluateRendererGate({
    contexts: [{ id: "ctx-1", rendererType: "webgpu-compat" }],
    requested: "webgpu",
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /webgpu-compat/);
});

test("C4 a mixed split - one pane on each backend - fails a single-pane sweep", () => {
  const verdict = evaluateRendererGate({
    contexts: [
      { id: "ctx-1", rendererType: "webgpu" },
      { id: "ctx-2", rendererType: "webgl" },
    ],
    requested: "webgpu",
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /1 of 2 contexts/);
});

test("C5 the three ways of learning nothing are distinguishable", () => {
  const unreadable = evaluateRendererGate({
    contexts: null,
    requested: "webgpu",
  });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.reason, /could not read the context registry/);

  const empty = evaluateRendererGate({ contexts: [], requested: "webgpu" });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no graphics context was created/);

  const unsupported = evaluateRendererGate({
    contexts: [{ rendererType: "webgl" }],
    requested: "split",
  });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.reason, /unsweepable renderer/);
});

test("C6 the sweepable set is the two single-pane backends", () => {
  assert.deepEqual([...SWEEPABLE_RENDERERS], ["webgl", "webgpu"]);
});

// --- Group C2: demos that legitimately build no viewer ---------------------

test("C2a the no-viewer list is derived from the gallery, not asserted about it", () => {
  // Re-derived here from the demo bodies via the SAME function the lib
  // exports (deriveNoViewerIds), so the list cannot quietly go stale: a new
  // viewer-less demo fails this until someone adds it, and a listed demo
  // that grows a viewer fails it until someone removes it. Prior to Q-129
  // this test carried its OWN copy of the construction regex applied to raw
  // (non-comment-stripped) source, which is why it missed `viewerless` —
  // that demo's only "construction" is a commented-out example line. Using
  // the shared, comment-aware derivation here means this test and the
  // runtime sweep can never derive two different answers.
  const viewerless = deriveNoViewerIds(GALLERY_DIR);
  assert.deepEqual([...NO_VIEWER_IDS].sort(), viewerless);
  for (const id of NO_VIEWER_IDS) {
    assert.equal(isNoViewerId(id), true, id);
  }
  assert.equal(isNoViewerId("hello-world"), false);
});

test("C2a-mutant a comment-blind derivation wrongly excludes viewerless (proves the fix matters)", () => {
  // Reproduces the exact defect Q-129 fixed: apply the construction regex to
  // RAW source (no comment-stripping) the way the old inline C2a derivation
  // did. `viewerless`'s commented-out `new Cesium.Viewer(...)` line makes it
  // match "constructs a viewer" under the naive scan, so it drops out of the
  // naive derivation's viewer-less set — which is why NO_VIEWER_IDS (now
  // correctly including "viewerless") disagrees with the naive result.
  const construction =
    /new\s+(Cesium\.)?(Viewer|CesiumWidget)\s*\(|(Viewer|CesiumWidget)\.createAsync/;
  const ids = enumerateGalleryIds(GALLERY_DIR);
  const naiveViewerless = ids
    .filter(
      (id) =>
        !construction.test(
          readFileSync(join(GALLERY_DIR, id, "main.js"), "utf8"),
        ),
    )
    .sort();
  assert.ok(
    !naiveViewerless.includes("viewerless"),
    "the naive (comment-blind) scan must still misclassify viewerless as having a viewer",
  );
  assert.notDeepEqual([...NO_VIEWER_IDS].sort(), naiveViewerless);

  // And the specific mechanism: stripping comments first changes the verdict
  // for viewerless's main.js from "matches" to "does not match".
  const viewerlessSource = readFileSync(
    join(GALLERY_DIR, "viewerless", "main.js"),
    "utf8",
  );
  assert.equal(
    construction.test(viewerlessSource),
    true,
    "raw source matches (the bug)",
  );
  assert.equal(
    construction.test(stripJsSourceComments(viewerlessSource)),
    false,
    "comment-stripped source does not match (the fix)",
  );
});

test("C2b a no-viewer demo passes ONLY when it reports zero contexts", () => {
  const verdict = evaluateRendererGate({
    contexts: [],
    requested: "webgpu",
    expectNoViewer: true,
  });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(verdict.reason, /no graphics context, as expected/);

  // The same empty reading is a FAILURE for an ordinary demo — which is what
  // makes this an inversion rather than a skip.
  assert.equal(
    evaluateRendererGate({ contexts: [], requested: "webgpu" }).ok,
    false,
  );
});

test("C2c a listed demo that DOES build a viewer goes red", () => {
  for (const rendererType of ["webgpu", "webgl"]) {
    const verdict = evaluateRendererGate({
      contexts: [{ id: "ctx-1", rendererType }],
      requested: "webgpu",
      expectNoViewer: true,
    });
    assert.equal(verdict.ok, false, rendererType);
    assert.match(verdict.reason, /expected no graphics context but found 1/);
    assert.match(verdict.reason, /list is stale/);
  }
});

test("C2d an unreadable registry never passes as no-viewer", () => {
  // "It built nothing" and "we could not ask" must not look alike: the demo
  // still has to prove the page booted.
  const verdict = evaluateRendererGate({
    contexts: null,
    requested: "webgpu",
    expectNoViewer: true,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /could not read the context registry/);
});

test("C2e the frame gate inverts for the same ids", () => {
  assert.equal(evaluateFrameGate([], { expectNoViewer: true }).ok, true);
  assert.equal(evaluateFrameGate([], {}).ok, false);

  const rendered = evaluateFrameGate([7], { expectNoViewer: true });
  assert.equal(rendered.ok, false);
  assert.match(rendered.reason, /expected no rendered frames but found 7/);

  assert.equal(
    evaluateFrameGate(undefined, { expectNoViewer: true }).ok,
    false,
    "an unreadable reading is not the same as an empty one",
  );
});

test("C2f a viewer-bearing demo still scores normally when not listed", () => {
  // Guards the default: the inversion must be opt-in per id, never ambient.
  assert.equal(
    evaluateRendererGate({
      contexts: [{ rendererType: "webgpu" }],
      requested: "webgpu",
    }).ok,
    true,
  );
  assert.equal(evaluateFrameGate([12]).ok, true);
  assert.equal(evaluateFrameGate([12], { minimum: 20 }).ok, false);
});

// --- Group D: the liveness gate -------------------------------------------

test("D1 a viewer that rendered passes, one that never did fails", () => {
  assert.equal(evaluateFrameGate([12, 12]).ok, true);
  assert.equal(evaluateFrameGate([1]).ok, false);
  assert.match(evaluateFrameGate([1]).reason, /did not reach 2/);
  assert.equal(evaluateFrameGate([]).ok, false);
  assert.match(evaluateFrameGate([]).reason, /no viewer instance/);
  assert.equal(evaluateFrameGate(undefined).ok, false);
});

// --- Group D2: the read deadline ------------------------------------------

test("D2a a frame that never answers yields a timeout, not a hang", async () => {
  // The failure this closes is a whole unattended gallery run stopping forever
  // on one wedged demo, so the assertion is that the call RETURNS.
  const wedged = { evaluate: () => new Promise(() => {}) };
  const started = Date.now();
  const result = await evaluateWithDeadline(wedged, () => 1, 50);
  assert.equal(result, EVALUATE_TIMEOUT);
  assert.ok(
    Date.now() - started < 5000,
    "the deadline did not actually cut the read short",
  );
});

test("D2b a frame that answers in time returns its answer", async () => {
  const ok = { evaluate: async () => ({ contexts: [], frameNumbers: [] }) };
  const result = await evaluateWithDeadline(ok, () => 1, 5000);
  assert.notEqual(result, EVALUATE_TIMEOUT);
  assert.deepEqual(result, { contexts: [], frameNumbers: [] });
});

test("D2c a real evaluation error is a distinct outcome from a timeout", async () => {
  // A detached frame and a wedged one are different findings; collapsing them
  // would hide a broken probe behind a plausible-looking TIMEOUT row.
  const broken = {
    evaluate: async () => {
      throw new Error("frame was detached");
    },
  };
  await assert.rejects(
    () => evaluateWithDeadline(broken, () => 1, 5000),
    /frame was detached/,
  );

  const throwsSynchronously = {
    evaluate: () => {
      throw new Error("execution context destroyed");
    },
  };
  await assert.rejects(
    () => evaluateWithDeadline(throwsSynchronously, () => 1, 5000),
    /execution context destroyed/,
  );
});

test("D2d losing the race leaves no unhandled rejection behind", async () => {
  const rejections = [];
  const onUnhandled = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const slowFailure = {
      evaluate: () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("late failure")), 40),
        ),
    };
    assert.equal(
      await evaluateWithDeadline(slowFailure, () => 1, 10),
      EVALUATE_TIMEOUT,
    );
    // Give the late rejection time to land and be noticed if it were unhandled.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// --- Group E: the in-page reader ------------------------------------------

test("E1 the reader survives a frame that never booted", () => {
  const saved = globalThis.Cesium;
  try {
    delete globalThis.Cesium;
    const state = readRendererStateInPage();
    assert.equal(state.contexts, null);
    assert.match(state.note, /no Cesium namespace/);
  } finally {
    if (saved !== undefined) {
      globalThis.Cesium = saved;
    }
  }
});

test("E2 the reader flattens the registry and the published instances", () => {
  const savedCesium = globalThis.Cesium;
  const savedInstances = globalThis.__sandcastleInstances;
  try {
    globalThis.Cesium = {
      GraphicsContext: {
        registry: {
          all: new Map([
            ["ctx-1", { id: "ctx-1", rendererType: "webgpu" }],
            ["ctx-2", { id: "ctx-2", rendererType: "webgpu" }],
          ]),
        },
      },
    };
    globalThis.__sandcastleInstances = [
      { scene: { frameState: { frameNumber: 41 } } },
      { scene: undefined },
    ];

    const state = readRendererStateInPage();
    assert.deepEqual(state.contexts, [
      { id: "ctx-1", rendererType: "webgpu" },
      { id: "ctx-2", rendererType: "webgpu" },
    ]);
    assert.deepEqual(state.frameNumbers, [41]);
    assert.equal(state.note, "");
  } finally {
    globalThis.Cesium = savedCesium;
    globalThis.__sandcastleInstances = savedInstances;
  }
});

test("E3 a namespace without the registry reports that, rather than throwing", () => {
  const saved = globalThis.Cesium;
  try {
    globalThis.Cesium = { GraphicsContext: {} };
    const state = readRendererStateInPage();
    assert.equal(state.contexts, null);
    assert.match(state.note, /no context registry/);
  } finally {
    globalThis.Cesium = saved;
  }
});

// --- Group F: inertness mutant --------------------------------------------

test("F1 making the predicate permissive un-fails the wrong-backend case", async () => {
  const modulePath = resolve(HERE, "lib", "sandcastle2-renderer-gate.mjs");
  const original = readFileSync(modulePath, "utf8");
  const mutated = original.replace(
    "  const wrong = observed.filter((type) => type !== requested);",
    "  const wrong = [];",
  );
  assert.notEqual(mutated, original, "mutation did not apply");

  const { build } = await import("esbuild");
  const result = await build({
    stdin: {
      contents: mutated,
      resolveDir: dirname(modulePath),
      sourcefile: "sandcastle2-renderer-gate.mutant.mjs",
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  const inert = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );

  // C2's premise, restated against the mutant and required to be false.
  const verdict = inert.evaluateRendererGate({
    contexts: [{ id: "ctx-1", rendererType: "webgl" }],
    requested: "webgpu",
  });
  assert.equal(
    verdict.ok,
    true,
    "C2 survived the mismatch check being made permissive",
  );

  // The other failure modes are untouched, so the mutation is scoped.
  assert.equal(
    inert.evaluateRendererGate({ contexts: [], requested: "webgpu" }).ok,
    false,
  );
});
