// @purpose node:test guard for capture-and-diff.mjs's root-binding seams: the additive --served-base origin override, the WAVE_END_SOURCE_* provenance preference and its baseline-promotion carve-out, and the CLI entry guard whose failure mode is a silent clean exit, and the per-run status box hidden before every capture unless asked for (round 5, K5-4).
// @status ACTIVE
//
// WHY THE ENTRY-GUARD CANARY EXISTS. `capture-and-diff.mjs` now wraps `main()`
// in the house entry-point comparison so a spec can import its pure helpers
// without launching a browser. If that comparison ever returns false — a
// rename, a symlink, a different launcher — the runner does NOTHING and exits
// 0, which a wave-end gate reads as "the visual gate certified". A silent clean
// pass is indistinguishable from a real one unless something asserts the
// difference, so the last test here spawns the real CLI and requires it to
// refuse a malformed argument with exit 2.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  bindRunPage,
  captureCanvases,
  parseArgs,
  resolveBaseUrl,
  resolveSourceProvenance,
  sceneIdentityForRun,
} from "./capture-and-diff.mjs";
import {
  PANE_STATUS_SELECTOR,
  restoreSceneClockInPage,
  setPaneStatusVisibilityInPage,
  snapshotSceneClockInPage,
} from "./lib/split-screen-page-state.mjs";
import { sha256 } from "./lib/visual-gate-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "capture-and-diff.mjs");
const REPOSITORY_ROOT = path.resolve(HERE, "../..");
const SCENES_BASE_URL = JSON.parse(
  readFileSync(path.join(HERE, "scenes.json"), "utf8"),
).baseUrl;

const ROOT_ENV = Object.freeze({
  WAVE_END_SOURCE_COMMIT: "a".repeat(40),
  WAVE_END_SOURCE_DIRTY: "false",
  WAVE_END_SOURCE_IDENTITY: "b".repeat(64),
});

function countingGitReader() {
  const calls = { value: 0 };
  const read = () => {
    calls.value += 1;
    return { sourceCommit: "f".repeat(40), sourceDirty: true };
  };
  return { calls, read };
}

test("(a) with no flag and no env the parsed configuration is what it always was", () => {
  const args = parseArgs(["node", "capture-and-diff.mjs"]);

  assert.deepEqual(args, {
    update: false,
    scene: null,
    threshold: 0.02,
    headless: true,
    browser: "msedge",
    confirmBaselinePromotion: false,
    updateRationale: null,
    reviewedBy: null,
    servedBase: null,
    // Lead correction (Celos, round 5, K5-4): the status box flag, off.
    showPaneStatus: false,
  });

  // The pre-existing flags keep parsing exactly as before, with the new one
  // inert alongside them.
  const populated = parseArgs([
    "node",
    "capture-and-diff.mjs",
    "--update",
    "--headed",
    "--scene",
    "globe-default",
    "--threshold",
    "0.05",
    "--browser",
    "chromium",
    "--confirm-baseline-promotion",
    "--update-rationale",
    "reviewed",
    "--reviewed-by",
    "someone",
  ]);
  assert.equal(populated.servedBase, null);
  assert.equal(populated.update, true);
  assert.equal(populated.headless, false);
  assert.equal(populated.scene, "globe-default");
  assert.equal(populated.threshold, 0.05);
  assert.equal(populated.browser, "chromium");
  assert.equal(populated.confirmBaselinePromotion, true);
  assert.equal(populated.updateRationale, "reviewed");
  assert.equal(populated.reviewedBy, "someone");

  // No override: the URL is the scene config's own, byte for byte.
  const resolved = resolveBaseUrl(SCENES_BASE_URL, populated.servedBase);
  assert.deepEqual(resolved, {
    url: SCENES_BASE_URL,
    origin: null,
    error: null,
  });
  assert.deepEqual(resolveBaseUrl(SCENES_BASE_URL), {
    url: SCENES_BASE_URL,
    origin: null,
    error: null,
  });
});

test("(b) --served-base replaces the origin and preserves everything else", () => {
  const args = parseArgs([
    "node",
    "capture-and-diff.mjs",
    "--served-base",
    "http://localhost:8094",
  ]);
  assert.equal(args.servedBase, "http://localhost:8094");

  const resolved = resolveBaseUrl(SCENES_BASE_URL, args.servedBase);
  assert.equal(resolved.error, null);
  assert.equal(resolved.origin, "http://localhost:8094");

  // The origin is the supplied one; the path the scene config named survives.
  const before = new URL(SCENES_BASE_URL);
  const after = new URL(resolved.url);
  assert.equal(after.origin, "http://localhost:8094");
  assert.notEqual(after.origin, before.origin);
  assert.equal(after.pathname, before.pathname);
  assert.equal(after.search, before.search);
  assert.equal(after.hash, before.hash);

  // Query and hash survive even when the scene config grows them.
  const rich = resolveBaseUrl(
    "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html?view=saved&n=2#frag",
    "https://example.test:4443",
  );
  assert.equal(
    rich.url,
    "https://example.test:4443/Apps/WebGPUTest/split-screen-comparison.html?view=saved&n=2#frag",
  );

  // A value-less --served-base is a refusal, never a silent fall-back to the
  // origin scenes.json hard-codes — which is the port the override exists to
  // escape, so falling back there quietly would be the worst outcome.
  assert.equal(
    parseArgs(["node", "capture-and-diff.mjs", "--served-base"]).servedBase,
    "",
  );
  assert.notEqual(resolveBaseUrl(SCENES_BASE_URL, "").error, null);

  // A malformed or non-http override is refused with a reason, and the
  // configured URL is left untouched rather than half-rewritten.
  for (const bad of ["not-a-url", "/Apps/x.html", "ftp://localhost:8094"]) {
    const refused = resolveBaseUrl(SCENES_BASE_URL, bad);
    assert.notEqual(refused.error, null, bad);
    assert.equal(refused.url, SCENES_BASE_URL, bad);
    assert.equal(refused.origin, null, bad);
  }
});

test("(c) root-supplied provenance is preferred and no Git shell-out is reached", () => {
  const { calls, read } = countingGitReader();

  const resolved = resolveSourceProvenance({
    env: { ...ROOT_ENV },
    promotionRequested: false,
    readGitMetadata: read,
  });

  // Observable: the Git seam was never entered.
  assert.equal(calls.value, 0);
  assert.equal(resolved.provenance, "wave-end-gate-env");
  assert.deepEqual(resolved.git, {
    sourceCommit: ROOT_ENV.WAVE_END_SOURCE_COMMIT,
    sourceDirty: false,
  });
  // The shape `report.candidate` is built from does not move, so scenes.json's
  // report schemaVersion does not have to either.
  assert.deepEqual(Object.keys(resolved.git), ["sourceCommit", "sourceDirty"]);

  // Env absent: the Git path runs exactly as it always did.
  const fallback = countingGitReader();
  const fromGit = resolveSourceProvenance({
    env: {},
    promotionRequested: false,
    readGitMetadata: fallback.read,
  });
  assert.equal(fallback.calls.value, 1);
  assert.equal(fromGit.provenance, "git");
  assert.deepEqual(fromGit.git, {
    sourceCommit: "f".repeat(40),
    sourceDirty: true,
  });

  // Partial or malformed root provenance is not trusted half-way — it falls
  // back to measuring, rather than binding to a tuple it cannot validate.
  for (const env of [
    { WAVE_END_SOURCE_COMMIT: "not-a-commit", WAVE_END_SOURCE_DIRTY: "false" },
    { WAVE_END_SOURCE_COMMIT: "a".repeat(40) },
    { WAVE_END_SOURCE_COMMIT: "a".repeat(40), WAVE_END_SOURCE_DIRTY: "maybe" },
    { WAVE_END_SOURCE_DIRTY: "false" },
  ]) {
    const partial = countingGitReader();
    const result = resolveSourceProvenance({
      env,
      promotionRequested: false,
      readGitMetadata: partial.read,
    });
    assert.equal(partial.calls.value, 1, JSON.stringify(env));
    assert.equal(result.provenance, "git", JSON.stringify(env));
  }
});

test("(c2) a baseline promotion always measures Git, root provenance or not", () => {
  // Promotion proves source stability by measuring the worktree twice and
  // comparing (capture-and-diff.mjs:1156-1157). A constant handed in from
  // outside would make the second measurement vacuous, so the preference is
  // carved out rather than applied everywhere.
  const { calls, read } = countingGitReader();
  const resolved = resolveSourceProvenance({
    env: { ...ROOT_ENV },
    promotionRequested: true,
    readGitMetadata: read,
  });

  assert.equal(calls.value, 1);
  assert.equal(resolved.provenance, "git");
  assert.equal(resolved.git.sourceCommit, "f".repeat(40));

  // And the runner still re-measures immediately before promoting.
  const runnerSource = readFileSync(RUNNER, "utf8");
  assert.match(
    runnerSource,
    /const promotionGit = getGitMetadata\(\);\s*const sourceStability = validatePromotionSourceStability\(git, promotionGit\);/,
  );
});

test("(d) an inert override leaves the configured origin in place", async () => {
  // Inertness mutant. The override branch is made unreachable in a COPY of the
  // runner — the code, the flag and the parse all stay exactly where they are —
  // and assertion (b) must then fail. A spec that survives this is pinning text.
  const sandbox = mkdtempSync(
    path.join(os.tmpdir(), "cesium-capture-served-mutant-"),
  );
  assert.ok(
    path.resolve(sandbox).startsWith(path.resolve(os.tmpdir()) + path.sep),
    "the mutant sandbox must live under the OS temp directory",
  );

  try {
    const target =
      "const overrideRequested = servedBase !== null && servedBase !== undefined;";
    const source = readFileSync(RUNNER, "utf8");
    assert.equal(
      source.split(target).length - 1,
      1,
      "the override predicate mutation must have exactly one target",
    );
    const mutant = source
      .replace(
        target,
        "const overrideRequested = false && servedBase !== null && servedBase !== undefined;",
      )
      .replace(
        '"../lib/webgpu-error-gate.mjs"',
        JSON.stringify(
          pathToFileURL(path.join(HERE, "..", "lib", "webgpu-error-gate.mjs"))
            .href,
        ),
      )
      .replace(
        '"./lib/visual-gate-policy.mjs"',
        JSON.stringify(
          pathToFileURL(path.join(HERE, "lib", "visual-gate-policy.mjs")).href,
        ),
      )
      // Lead correction (Celos, round 5, K5-4/K5-5): the runner imports the
      // split-screen page-state piece too; the copy must resolve it.
      .replace(
        '"./lib/split-screen-page-state.mjs"',
        JSON.stringify(
          pathToFileURL(path.join(HERE, "lib", "split-screen-page-state.mjs"))
            .href,
        ),
      );
    const mutantPath = path.join(sandbox, "capture-and-diff.mutant.mjs");
    writeFileSync(mutantPath, mutant, "utf8");

    const mutated = await import(pathToFileURL(mutantPath).href);
    const resolved = mutated.resolveBaseUrl(
      SCENES_BASE_URL,
      "http://localhost:8094",
    );
    // With the branch unreachable the flag still parses and still arrives —
    // and changes nothing, which is precisely what assertion (b) forbids.
    assert.equal(
      mutated.parseArgs(["node", "x", "--served-base", "http://localhost:8094"])
        .servedBase,
      "http://localhost:8094",
    );
    assert.equal(resolved.url, SCENES_BASE_URL);
    assert.equal(resolved.origin, null);
    assert.notEqual(
      resolved.url,
      resolveBaseUrl(SCENES_BASE_URL, "http://localhost:8094").url,
      "the live module and the inert copy must not agree",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("(e) the CLI entry guard is live: the real runner still reaches main()", () => {
  // The canary. If the entry-point comparison breaks, this runner exits 0
  // having rendered nothing, and a wave-end gate reads that as certification.
  // A refused argument is the cheapest possible proof that main() ran: it costs
  // no browser, no build and no served origin.
  assert.ok(existsSync(RUNNER));
  const refused = spawnSync(
    process.execPath,
    [
      "Tools/visual-regression/capture-and-diff.mjs",
      "--served-base",
      "not-a-url",
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", timeout: 60_000 },
  );

  assert.equal(refused.error, undefined);
  assert.equal(
    refused.status,
    2,
    `expected the runner to refuse with exit 2; stdout=${refused.stdout} stderr=${refused.stderr}`,
  );
  assert.match(
    refused.stderr,
    /--served-base must be an absolute http\(s\) origin/,
  );
  // It refused BEFORE opening a browser, so the canary stays cheap.
  assert.equal(/navigating/.test(refused.stdout), false);
});

test("(e2) importing the module does not run the capture", () => {
  // The other half of the guard: a spec importing these helpers must not launch
  // Playwright or touch the network.
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(pathToFileURL(RUNNER).href)}).then((m) => {
         console.log("IMPORTED_NO_RUN", typeof m.parseArgs, typeof m.resolveBaseUrl, typeof m.resolveSourceProvenance);
       });`,
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", timeout: 60_000 },
  );

  assert.equal(imported.error, undefined);
  assert.equal(
    imported.status,
    0,
    `import must be side-effect free; stderr=${imported.stderr}`,
  );
  assert.match(imported.stdout, /IMPORTED_NO_RUN function function function/);
  assert.equal(/\[visual-regression\]/.test(imported.stdout), false);
  assert.equal(/\[visual-regression\]/.test(imported.stderr), false);
});

test("(f) the runner still derives Git provenance when nothing is handed down", () => {
  // resolveSourceProvenance's default reader is the module's own
  // getGitMetadata, so the no-env path is not merely untested plumbing.
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  const resolved = resolveSourceProvenance({ env: {} });
  assert.equal(resolved.provenance, "git");
  assert.equal(resolved.git.sourceCommit, head);
  assert.equal(typeof resolved.git.sourceDirty, "boolean");
});

// (g) Lead addition (Celos, lane KT round 4, seat item F2; Calenhad B3). The
// historical gates read NON_CERTIFYING (MANIFEST_MISMATCH:sceneIdentity) on the
// 2026-10-22 water leg because the served origin (ports 8094 / 8096) was folded
// into every scene identity. Observable: the identity a run computes for an
// accepted baseline equals the manifest's on ANY served origin, and the served
// origin is still recorded, apart from the identity.
test("(g) a scene identity is independent of the served origin, and the origin is recorded apart", () => {
  const scenes = JSON.parse(
    readFileSync(path.join(HERE, "scenes.json"), "utf8"),
  );
  const manifest = JSON.parse(
    readFileSync(path.join(HERE, "baseline", "manifest.json"), "utf8"),
  );
  const servedBases = [
    null,
    "http://localhost:8094",
    "http://localhost:8096",
    "http://127.0.0.1:9000",
    "https://example.test",
  ];
  let accepted = 0;
  for (const scene of scenes.scenes) {
    const entry = manifest.entries[`${scene.name}:webgl`];
    if (!entry) {
      continue;
    }
    accepted++;
    const run = {
      settleFrames: scenes.settleFrames,
      viewport: { width: 1600, height: 800 },
      setupFileSha256:
        typeof scene.setupFile === "string"
          ? sha256(readFileSync(path.join(HERE, scene.setupFile)))
          : null,
    };
    for (const servedBase of servedBases) {
      const binding = bindRunPage(scenes.baseUrl, servedBase);
      assert.equal(binding.error, null);
      assert.equal(
        sceneIdentityForRun(scene, binding, run),
        entry.sceneIdentity,
        `${scene.name} on ${servedBase ?? "the configured origin"} must keep the accepted baseline's identity`,
      );
    }
  }
  // Non-vacuous: the tracked manifest has accepted scenes to certify against.
  assert.ok(accepted >= 1, "the manifest names at least one accepted scene");

  const onDefault = bindRunPage(scenes.baseUrl, null);
  const on8094 = bindRunPage(scenes.baseUrl, "http://localhost:8094");
  assert.equal(onDefault.servedOrigin, new URL(scenes.baseUrl).origin);
  assert.equal(on8094.servedOrigin, "http://localhost:8094");
  assert.equal(on8094.configuredBaseUrl, scenes.baseUrl);
  // The page navigated still moves with the override (b) is unchanged.
  assert.equal(
    on8094.url,
    resolveBaseUrl(scenes.baseUrl, "http://localhost:8094").url,
  );
  assert.equal(new URL(on8094.url).port, "8094");
});

// (h) ROUND 5, K5-4. Lead addition (Celos), written from the seat's item text
// and Calenhad's round-2 note 7: the split-screen page's per-run status box
// ("WebGPU — 342ms") sits over each canvas and an element screenshot captured
// its digits. It is hidden before every capture unless --show-pane-status.

function fakeStatusDocument() {
  const elements = [
    { id: "leftStatus", style: { visibility: "" } },
    { id: "rightStatus", style: { visibility: "" } },
  ];
  return {
    elements,
    querySelectorAll(selector) {
      return selector === ".pane-status" ? elements : [];
    },
  };
}

// A page whose evaluate runs the page function in Node against the fake
// document, and whose screenshots and PNG decodes are recorded in order.
function fakeCapturePage(doc) {
  const order = [];
  return {
    order,
    async evaluate(fn, arg) {
      if (fn === setPaneStatusVisibilityInPage) {
        const previous = globalThis.document;
        globalThis.document = doc;
        try {
          order.push(`status:${arg.show}`);
          return fn(arg);
        } finally {
          globalThis.document = previous;
        }
      }
      if (String(fn).includes("data-vr-tag")) {
        order.push("tag");
        return undefined;
      }
      order.push("decode");
      return { width: 1, height: 1, data: [0, 0, 0, 255] };
    },
    locator(selector) {
      return {
        async screenshot() {
          order.push(`shot:${selector}`);
          return Buffer.from([0]);
        },
      };
    },
  };
}

test("(h) the status box is hidden by default and shown only with --show-pane-status", () => {
  assert.equal(
    parseArgs(["node", "capture-and-diff.mjs"]).showPaneStatus,
    false,
  );
  assert.equal(
    parseArgs(["node", "capture-and-diff.mjs", "--show-pane-status"])
      .showPaneStatus,
    true,
  );
  assert.equal(PANE_STATUS_SELECTOR, ".pane-status");
  const doc = fakeStatusDocument();
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    assert.equal(
      setPaneStatusVisibilityInPage({ selector: ".pane-status", show: false }),
      2,
    );
    assert.deepEqual(
      doc.elements.map((element) => element.style.visibility),
      ["hidden", "hidden"],
    );
    setPaneStatusVisibilityInPage({ selector: ".pane-status", show: true });
    assert.deepEqual(
      doc.elements.map((element) => element.style.visibility),
      ["", ""],
    );
  } finally {
    globalThis.document = previous;
  }
});

test("(h) every capture hides the status box before the first screenshot and reports it", async () => {
  const doc = fakeStatusDocument();
  const page = fakeCapturePage(doc);
  const cap = await captureCanvases(page);
  assert.equal(page.order[0], "status:false");
  assert.ok(
    page.order.indexOf("status:false") <
      page.order.findIndex((step) => step.startsWith("shot:")),
  );
  assert.deepEqual(
    doc.elements.map((element) => element.style.visibility),
    ["hidden", "hidden"],
    "both boxes are hidden while the canvases are captured",
  );
  assert.deepEqual(cap.paneStatus, {
    selector: ".pane-status",
    shown: false,
    elements: 2,
  });

  const shownDoc = fakeStatusDocument();
  const shownPage = fakeCapturePage(shownDoc);
  const shown = await captureCanvases(shownPage, { showPaneStatus: true });
  assert.equal(shownPage.order[0], "status:true");
  assert.deepEqual(
    shownDoc.elements.map((element) => element.style.visibility),
    ["", ""],
  );
  assert.equal(shown.paneStatus.shown, true);
});

// (i) ROUND 5, K5-5. Lead addition (Celos). A setup that pins the page clock
// (the clock-pinned twins) must not leave it pinned for the scenes after it in
// a sweep: the runner snapshots the clock before each scene's setup and
// restores it after the capture.

// A minimal JulianDate over plain seconds, and the page's two viewers.
function fakeClockWindow({ now = 1000, animate = true, current = 990 } = {}) {
  class JulianDate {
    constructor(seconds = 0) {
      this.s = seconds;
    }
    static now() {
      return new JulianDate(now);
    }
    static secondsDifference(a, b) {
      return a.s - b.s;
    }
    static addSeconds(a, seconds, result) {
      result.s = a.s + seconds;
      return result;
    }
    static clone(a) {
      return new JulianDate(a.s);
    }
    static toIso8601(a) {
      return `t${a.s}`;
    }
    static fromIso8601(text) {
      return new JulianDate(Number(text.slice(1)));
    }
  }
  const viewer = (shouldAnimate, s) => ({
    clock: { shouldAnimate, currentTime: new JulianDate(s) },
  });
  return {
    Cesium: { JulianDate },
    webglViewer: viewer(animate, current),
    webgpuViewer: viewer(false, current),
    setNow(value) {
      now = value;
    },
  };
}

function withWindow(fakeWindow, body) {
  const previous = globalThis.window;
  globalThis.window = fakeWindow;
  try {
    return body();
  } finally {
    globalThis.window = previous;
  }
}

test("(i) a pinned clock is put back to animating at its old wall-clock offset", () => {
  const page = fakeClockWindow({ now: 1000, animate: true, current: 990 });
  withWindow(page, () => {
    const before = snapshotSceneClockInPage();
    assert.deepEqual(before, {
      shouldAnimate: true,
      offsetSeconds: -10,
      instant: "t990",
      iso: "t990",
      webgpuIso: "t990",
    });
    // A twin's setup pins both clocks at another instant ...
    page.webglViewer.clock.shouldAnimate = false;
    page.webglViewer.clock.currentTime = new page.Cesium.JulianDate(5);
    page.webgpuViewer.clock.currentTime = new page.Cesium.JulianDate(5);
    assert.equal(snapshotSceneClockInPage().iso, "t5");
    // ... and 30 s later the capture is done.
    page.setNow(1030);
    assert.equal(restoreSceneClockInPage(before), true);
    assert.equal(page.webglViewer.clock.shouldAnimate, true);
    assert.equal(page.webglViewer.clock.currentTime.s, 1020);
    assert.equal(page.webgpuViewer.clock.currentTime.s, 1020);
    assert.equal(page.webgpuViewer.clock.shouldAnimate, false);
  });
});

test("(i) a clock a scene left frozen stays frozen; no viewers, nothing restored", () => {
  const page = fakeClockWindow({ now: 50, animate: false, current: 20 });
  withWindow(page, () => {
    const before = snapshotSceneClockInPage();
    page.setNow(80);
    page.webglViewer.clock.currentTime = new page.Cesium.JulianDate(5);
    restoreSceneClockInPage(before);
    assert.equal(page.webglViewer.clock.shouldAnimate, false);
    assert.equal(page.webglViewer.clock.currentTime.s, 20);
    assert.equal(page.webgpuViewer.clock.currentTime.s, 20);
  });
  withWindow({}, () => {
    assert.equal(snapshotSceneClockInPage(), null);
    assert.equal(
      restoreSceneClockInPage({ shouldAnimate: true, offsetSeconds: 0 }),
      false,
    );
  });
});
