// C11-134 — NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION.
//
// The exit gate (C11-137) is defined on truthful executed/skipped/failed counts
// with every skip reasoned. That is unreachable while specs reach Ion / Cesium
// World Terrain from a sandbox with no reliable outbound network: those specs
// time out at random, and a timeout is neither a pass nor a reasoned skip.
//
// This spec pins the two halves of the isolation without a browser:
//
//   * the URL classifier that decides what "external" means — including its
//     fail-closed behaviour, because "we could not tell" must never become
//     "allowed";
//   * the online-lane quarantine — a declared network suite is SKIPPED WITH A
//     REASON offline and runs normally online, so coverage is quarantined
//     rather than deleted.
//
// It also asserts the wiring anchors: the lane flag is published before spec
// modules evaluate, the flag travels as a token rather than a positional arg,
// and every spec that still reaches a live service is declared.
//
// Run: node --test Tools/visual-regression/spec-offline-isolation.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BLOCKED_REQUESTS_KEY,
  NETWORK_LANE_SKIP_REASON,
  OFFLINE_LANE_FLAG,
  SKIPPED_SUITES_KEY,
  describeRequiresNetwork,
  installOfflineNetworkGuard,
  isExternalRequestUrl,
  isOfflineLane,
  offlineViolationError,
  setOfflineLane,
  summarizeNetworkLane,
} from "../../Specs/networkPolicy.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readRepoFile = (relative) =>
  readFile(resolve(repoRoot, relative), "utf8");

const KARMA_ORIGIN = "http://localhost:9876";

/** A stand-in for `window` so the guard can be exercised in Node. */
function makeScope() {
  const scope = {
    location: { origin: KARMA_ORIGIN },
    describeCalls: [],
    xdescribeCalls: [],
    describe(name, suite, category) {
      scope.describeCalls.push({ name, suite, category });
    },
    xdescribe(name, suite) {
      scope.xdescribeCalls.push({ name, suite });
    },
  };
  return scope;
}

// ─────────────────────── the external-URL classifier ───────────────────────

test("same-origin and relative requests are local; foreign hosts are not", () => {
  const options = { origin: KARMA_ORIGIN };
  for (const local of [
    "base/Build/CesiumUnminified/Cesium.js",
    "/base/Specs/Data/tile.terrain",
    "Data/CesiumTerrainTileJson/Heightmap/layer.json",
    `${KARMA_ORIGIN}/base/Specs/Data/foo.json`,
    "data:application/json;base64,e30=",
    "blob:http://localhost:9876/1234-5678",
  ]) {
    assert.equal(
      isExternalRequestUrl(local, options),
      false,
      `${local} must be treated as local`,
    );
  }

  for (const external of [
    "https://assets.cesium.com/1/tileset.json",
    "https://api.cesium.com/v1/assets/1/endpoint",
    "https://assets.ion.cesium.com/google-credit.png",
    "http://localhost:8080/Apps/CesiumViewer/index.html", // different port
    "//example.com/protocol-relative.json",
  ]) {
    assert.equal(
      isExternalRequestUrl(external, options),
      true,
      `${external} must be treated as external`,
    );
  }
});

test("the classifier FAILS CLOSED on anything it cannot resolve", () => {
  const options = { origin: KARMA_ORIGIN };
  assert.equal(isExternalRequestUrl("", options), true);
  assert.equal(isExternalRequestUrl(undefined, options), true);
  assert.equal(isExternalRequestUrl(null, options), true);
  assert.equal(isExternalRequestUrl(42, options), true);
  // An unparseable value with no usable base must not be waved through.
  assert.equal(isExternalRequestUrl("http://", options), true);
});

test("explicitly allowed origins are honoured, and only those", () => {
  const options = {
    origin: KARMA_ORIGIN,
    allowedOrigins: ["http://localhost:8080"],
  };
  assert.equal(isExternalRequestUrl("http://localhost:8080/x", options), false);
  assert.equal(isExternalRequestUrl("http://localhost:8081/x", options), true);
});

// ───────────────────────── the online-lane quarantine ─────────────────────────

test("offline: a network suite is SKIPPED WITH A REASON, not silently passed", () => {
  const scope = makeScope();
  setOfflineLane(true, scope);
  assert.equal(isOfflineLane(scope), true);

  const body = function () {};
  describeRequiresNetwork(
    "Core/createWorldTerrainAsync",
    body,
    undefined,
    scope,
  );

  assert.equal(scope.describeCalls.length, 0, "must not run offline");
  assert.deepEqual(scope.xdescribeCalls, [
    { name: "Core/createWorldTerrainAsync", suite: body },
  ]);

  const summary = summarizeNetworkLane(scope);
  assert.equal(summary.offline, true);
  assert.deepEqual(summary.skippedSuites, [
    {
      name: "Core/createWorldTerrainAsync",
      reason: NETWORK_LANE_SKIP_REASON,
    },
  ]);
  assert.equal(NETWORK_LANE_SKIP_REASON, "requires network");
});

test("online: the same suite runs, keeping its existing category", () => {
  const scope = makeScope();
  setOfflineLane(false, scope);
  assert.equal(isOfflineLane(scope), false);

  const body = function () {};
  describeRequiresNetwork("Core/TerrainPicker", body, "WebGL", scope);

  assert.equal(scope.xdescribeCalls.length, 0);
  assert.deepEqual(scope.describeCalls, [
    { name: "Core/TerrainPicker", suite: body, category: "WebGL" },
  ]);
  // Quarantine is not deletion: coverage is preserved in the online lane.
  assert.deepEqual(summarizeNetworkLane(scope).skippedSuites, []);
});

test("setOfflineLane resets the per-run rosters so runs cannot bleed together", () => {
  const scope = makeScope();
  setOfflineLane(true, scope);
  describeRequiresNetwork("A", function () {}, undefined, scope);
  assert.equal(summarizeNetworkLane(scope).skippedSuites.length, 1);
  setOfflineLane(true, scope);
  assert.equal(summarizeNetworkLane(scope).skippedSuites.length, 0);
  assert.equal(scope[OFFLINE_LANE_FLAG], true);
  assert.deepEqual(scope[SKIPPED_SUITES_KEY], []);
  assert.deepEqual(scope[BLOCKED_REQUESTS_KEY], []);
});

// ─────────────────────────── the fetch guard ───────────────────────────

test("the guard blocks foreign hosts loudly, records them, and passes locals through", async () => {
  const scope = makeScope();
  setOfflineLane(true, scope);

  const fetched = [];
  scope.fetch = async (input) => {
    fetched.push(String(input));
    return { ok: true };
  };
  const opened = [];
  scope.XMLHttpRequest = class {
    open(method, url) {
      opened.push(`${method} ${url}`);
    }
  };

  const uninstall = installOfflineNetworkGuard({
    origin: KARMA_ORIGIN,
    scope,
  });

  // Local traffic is untouched — the guard must not break the offline suite.
  await scope.fetch("base/Build/CesiumUnminified/Cesium.js");
  new scope.XMLHttpRequest().open("GET", "Data/tile.terrain");
  assert.equal(fetched.length, 1);
  assert.equal(opened.length, 1);

  // External traffic fails LOUDLY, naming the URL and the remedy.
  await assert.rejects(
    () => scope.fetch("https://assets.cesium.com/1/tileset.json"),
    /blocked request to https:\/\/assets\.cesium\.com/,
  );
  assert.throws(
    () =>
      new scope.XMLHttpRequest().open(
        "GET",
        "https://api.cesium.com/v1/assets/1/endpoint",
      ),
    /describeRequiresNetwork/,
  );
  assert.equal(
    fetched.length,
    1,
    "the blocked fetch must not reach the network",
  );
  assert.equal(opened.length, 1);

  const summary = summarizeNetworkLane(scope);
  assert.deepEqual(
    summary.blockedRequests.map((entry) => entry.api),
    ["fetch", "xhr"],
  );
  assert.match(summary.blockedRequests[0].url, /assets\.cesium\.com/);

  uninstall();
  await scope.fetch("https://assets.cesium.com/1/tileset.json");
  assert.equal(fetched.length, 2, "uninstall must restore the originals");

  assert.match(
    offlineViolationError("https://example.com/x").message,
    /offline lane/,
  );
});

// ─────────────────────────── wiring anchors ───────────────────────────

test("the lane flag is published before any spec module evaluates", async () => {
  const customizeJasmine = await readRepoFile("Specs/customizeJasmine.js");
  assert.match(customizeJasmine, /setOfflineLane\(offline === true\)/);
  assert.match(customizeJasmine, /installOfflineNetworkGuard\(\{/);

  // karma-main.js runs ahead of SpecList.js, and it is the caller — so the flag
  // is set before the first `describeRequiresNetwork()` declaration executes.
  const karmaMain = await readRepoFile("Specs/karma-main.js");
  assert.match(karmaMain, /customizeJasmine\(/);
  // Token, not position: the tail of the karma client args is shared with the
  // jasmine adapter's `--grep` pair.
  assert.match(karmaMain, /args\.includes\("--offline"\)/);

  const gulpfile = await readRepoFile("gulpfile.js");
  assert.match(gulpfile, /const offline = argv\.offline !== false;/);
  assert.match(gulpfile, /offline \? \["--offline"\] : \[\]/);
});

test("every spec that still reaches a live service is declared", async () => {
  // The enumeration the guide pins: anything touching Ion / world terrain /
  // world imagery. Each hit must either be mocked or quarantined — a NEW hit
  // that is neither should fail here the day it lands.
  const liveServiceSpecs = [
    "packages/engine/Specs/Core/createWorldTerrainAsyncSpec.js",
    "packages/engine/Specs/Core/sampleTerrainMostDetailedSpec.js",
    "packages/engine/Specs/Core/sampleTerrainSpec.js",
    "packages/engine/Specs/Core/TerrainPickerSpec.js",
  ];
  for (const specPath of liveServiceSpecs) {
    const source = await readRepoFile(specPath);
    assert.match(
      source,
      /import \{ describeRequiresNetwork \} from "\.\.\/\.\.\/\.\.\/\.\.\/Specs\/networkPolicy\.js";/,
      `${specPath} must import the quarantine helper`,
    );
    assert.match(
      source,
      /describeRequiresNetwork\(/,
      `${specPath} must declare its online-lane suite`,
    );
  }

  // The specs that merely NAME Ion types but mock every request stay in the
  // offline lane; quarantining them would remove real offline coverage.
  for (const mockedSpec of [
    "packages/engine/Specs/Core/IonResourceSpec.js",
    "packages/engine/Specs/Scene/IonImageryProviderSpec.js",
    "packages/engine/Specs/Scene/createWorldImageryAsyncSpec.js",
    "packages/engine/Specs/Core/GoogleGeocoderServicesSpec.js",
  ]) {
    const source = await readRepoFile(mockedSpec);
    assert.doesNotMatch(
      source,
      /describeRequiresNetwork/,
      `${mockedSpec} mocks its transport and must stay in the offline lane`,
    );
    assert.match(
      source,
      /spyOn\(/,
      `${mockedSpec} is only offline-safe because it mocks its transport`,
    );
  }
});
