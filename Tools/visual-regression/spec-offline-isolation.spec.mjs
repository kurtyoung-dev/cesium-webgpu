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
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BLOCKED_REQUESTS_KEY,
  CURRENT_JASMINE_SPEC_KEY,
  NETWORK_LANE_SKIP_REASON,
  NETWORK_LANE_SUMMARY_KEY,
  NETWORK_LANE_SUMMARY_PREFIX,
  OFFLINE_LANE_FLAG,
  OUTSIDE_JASMINE_SPEC,
  SKIPPED_SUITES_KEY,
  createNetworkLaneRunSummary,
  describeRequiresNetwork,
  formatNetworkLaneRunSummary,
  installOfflineNetworkGuard,
  installOfflineNetworkRunAssertion,
  installOfflineNetworkSpecAttribution,
  isExternalRequestUrl,
  isOfflineLane,
  offlineViolationError,
  redactSensitiveRequestUrl,
  setOfflineLane,
  summarizeNetworkLane,
} from "../../Specs/networkPolicy.js";
import applyOfflineViewerNetworkDefaults from "../../packages/widgets/Specs/applyOfflineViewerNetworkDefaults.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readRepoFile = (relative) =>
  readFile(resolve(repoRoot, relative), "utf8");

const KARMA_ORIGIN = "http://localhost:9876";

const ENGINE_SPECS_ROOT = "packages/engine/Specs";

// Candidate discovery is intentionally separate from classification. The
// scanner owns the known live-service entry points; the manifest owns the
// reviewed disposition of each matching file. A new matching spec therefore
// cannot disappear merely because it was omitted from a hand-maintained list.
const LIVE_SERVICE_CALL_PATTERNS = [
  ["createWorldBathymetryAsync", /\bcreateWorldBathymetryAsync\s*\(/],
  ["createWorldTerrainAsync", /\bcreateWorldTerrainAsync\s*\(/],
  ["createWorldImageryAsync", /\bcreateWorldImageryAsync\s*\(/],
  ["IonResource.fromAssetId", /\bIonResource\.fromAssetId\s*\(/],
  ["IonImageryProvider.fromAssetId", /\bIonImageryProvider\.fromAssetId\s*\(/],
  ["GoogleGeocoderService", /\bnew\s+GoogleGeocoderService\s*\(/],
];

const NETWORK_DECLARATION_IMPORT =
  /import\s*\{\s*describeRequiresNetwork\s*\}\s*from\s*["'][^"']*Specs\/networkPolicy\.js["'];/;

const LIVE_SERVICE_SPEC_CLASSIFICATIONS = new Map([
  [
    "packages/engine/Specs/Core/createWorldBathymetryAsyncSpec.js",
    { disposition: "requires-network" },
  ],
  [
    "packages/engine/Specs/Core/createWorldTerrainAsyncSpec.js",
    { disposition: "requires-network" },
  ],
  [
    "packages/engine/Specs/Core/sampleTerrainMostDetailedSpec.js",
    { disposition: "requires-network" },
  ],
  [
    "packages/engine/Specs/Core/sampleTerrainSpec.js",
    { disposition: "requires-network" },
  ],
  [
    "packages/engine/Specs/Core/TerrainPickerSpec.js",
    { disposition: "requires-network" },
  ],
  [
    "packages/engine/Specs/Core/IonResourceSpec.js",
    {
      disposition: "mocked-transport",
      transportMocks: [
        /spyOn\s*\(\s*IonResource\s*,\s*"_createEndpointResource"\s*\)/,
      ],
    },
  ],
  [
    "packages/engine/Specs/Scene/IonImageryProviderSpec.js",
    {
      disposition: "mocked-transport",
      transportMocks: [
        /spyOn\s*\(\s*IonResource\s*,\s*"_createEndpointResource"\s*\)/,
      ],
    },
  ],
  [
    "packages/engine/Specs/Scene/createWorldImageryAsyncSpec.js",
    {
      disposition: "mocked-transport",
      // Both layers are required: the ion endpoint lookup and the external
      // provider metadata request. A generic loadWithXhr spy alone is partial
      // if it delegates the endpoint lookup to the original implementation.
      transportMocks: [
        /spyOn\s*\(\s*IonResource\s*,\s*"_createEndpointResource"\s*\)/,
        /spyOn\s*\(\s*endpointResource\s*,\s*"fetchJson"\s*\)/,
        /spyOn\s*\(\s*Resource\._Implementations\s*,\s*"loadWithXhr"\s*\)/,
      ],
    },
  ],
  [
    "packages/engine/Specs/Core/GoogleGeocoderServicesSpec.js",
    {
      disposition: "mocked-transport",
      transportMocks: [
        /spyOn\s*\(\s*Resource\.prototype\s*,\s*"fetchJson"\s*\)/,
      ],
    },
  ],
]);

async function enumerateEngineSpecSources() {
  const sources = new Map();

  async function visit(relativeDirectory) {
    const absoluteDirectory = resolve(repoRoot, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile() && entry.name.endsWith("Spec.js")) {
        sources.set(relativePath, await readRepoFile(relativePath));
      }
    }
  }

  await visit(ENGINE_SPECS_ROOT);
  return sources;
}

function findLiveServiceCalls(source) {
  return LIVE_SERVICE_CALL_PATTERNS.filter(([, pattern]) =>
    pattern.test(source),
  ).map(([name]) => name);
}

function auditLiveServiceSpecInventory(
  specSources,
  classifications = LIVE_SERVICE_SPEC_CLASSIFICATIONS,
) {
  const candidates = new Map(
    [...specSources].filter(
      ([, source]) => findLiveServiceCalls(source).length,
    ),
  );
  const findings = [];

  for (const [specPath, source] of candidates) {
    const classification = classifications.get(specPath);
    const calls = findLiveServiceCalls(source).join(", ");
    if (!classification) {
      findings.push(
        `${specPath}: unclassified live-service spec (${calls}); declare it ` +
          `requires-network or document its transport mock`,
      );
      continue;
    }

    if (classification.disposition === "requires-network") {
      if (!NETWORK_DECLARATION_IMPORT.test(source)) {
        findings.push(`${specPath}: missing describeRequiresNetwork import`);
      }
      if (!/\bdescribeRequiresNetwork\s*\(/.test(source)) {
        findings.push(
          `${specPath}: missing describeRequiresNetwork declaration`,
        );
      }
    } else if (classification.disposition === "mocked-transport") {
      if (/\bdescribeRequiresNetwork\b/.test(source)) {
        findings.push(
          `${specPath}: mocked coverage must remain in the offline lane`,
        );
      }
      for (const transportMock of classification.transportMocks ?? []) {
        if (!transportMock.test(source)) {
          findings.push(`${specPath}: reviewed transport mock is missing`);
        }
      }
    } else {
      findings.push(
        `${specPath}: unknown live-service disposition ${classification.disposition}`,
      );
    }
  }

  for (const specPath of classifications.keys()) {
    if (!candidates.has(specPath)) {
      findings.push(
        `${specPath}: stale classification (no live-service call was discovered)`,
      );
    }
  }

  if (findings.length) {
    findings.sort();
    throw new Error(`live-service inventory rejected:\n${findings.join("\n")}`);
  }

  return [...candidates.keys()].sort();
}

const OFFLINE_ESCAPE_REPAIR_ANCHORS = new Map([
  [
    "packages/engine/Specs/Widget/CesiumWidgetSpec.js",
    [
      /import \{ isOfflineLane \} from "\.\.\/\.\.\/\.\.\/\.\.\/Specs\/networkPolicy\.js";/,
      /isOfflineLane\(window\)[\s\S]*?options\.globe !== false[\s\S]*?options\.baseLayer === undefined[\s\S]*?options\.baseLayer = false/,
    ],
  ],
  [
    "packages/engine/Specs/Scene/IonImageryProviderSpec.js",
    [
      /function installFakeTileMapServiceRequest\(\)/,
      /expect\(url\)\.toMatch\(\/\\\/tilemapresource\\\.xml\$\/\)/,
      /describe\("TMS"[\s\S]*?beforeEach\(function \(\) \{[\s\S]*?installFakeTileMapServiceRequest\(\)/,
    ],
  ],
  [
    "packages/engine/Specs/Core/GoogleEarthEnterpriseMetadataSpec.js",
    [
      /expect\(url\)\.toEqual\("http:\/\/test\.server\/dbRoot\.v5\?output=proto"\)[\s\S]*?deferred\.reject\(\)/,
    ],
  ],
  [
    "packages/engine/Specs/Scene/GoogleEarthEnterpriseImageryProviderSpec.js",
    [
      /function installMockDbRootFallback\(expectedUrl\)/,
      /installMockDbRootFallback\(url\)/,
    ],
  ],
  [
    "packages/engine/Specs/Scene/ArcGisMapServerImageryProviderSpec.js",
    [
      /it\("fromUrl throws if request fails"[\s\S]*?spyOn\(Resource\._Implementations, "loadWithXhr"\)[\s\S]*?deferred\.reject\(\)/,
    ],
  ],
  [
    "packages/engine/Specs/Scene/BingMapsImageryProviderSpec.js",
    [
      /it\("fromUrl throws if request fails"[\s\S]*?Resource\._Implementations\.loadWithXhr = function[\s\S]*?deferred\.reject\(\)/,
    ],
  ],
  [
    "packages/engine/Specs/Scene/GoogleEarthEnterpriseMapsProviderSpec.js",
    [
      /it\("fromUrl throws with invalid url"[\s\S]*?Resource\._Implementations\.loadWithXhr = function[\s\S]*?deferred\.reject\(\)/,
    ],
  ],
  [
    "packages/engine/Specs/Scene/SpecularEnvironmentCubeMapSpec.js",
    [/"Data\/Images\/does-not-exist\.ktx2"/],
  ],
]);

function auditOfflineEscapeRepairAnchors(sources) {
  const findings = [];
  for (const [specPath, anchors] of OFFLINE_ESCAPE_REPAIR_ANCHORS) {
    const source = sources.get(specPath);
    if (typeof source !== "string") {
      findings.push(`${specPath}: source missing`);
      continue;
    }
    anchors.forEach((anchor, index) => {
      if (!anchor.test(source)) {
        findings.push(`${specPath}: repair anchor ${index + 1} missing`);
      }
    });
  }
  if (findings.length) {
    throw new Error(
      `offline escape repair audit rejected:\n${findings.join("\n")}`,
    );
  }
}

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
  assert.equal(scope[NETWORK_LANE_SUMMARY_KEY], undefined);
  assert.equal(scope[CURRENT_JASMINE_SPEC_KEY], OUTSIDE_JASMINE_SPEC);
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

test("a test-only foreign URL cannot bypass native transport without interception", async () => {
  const scope = makeScope();
  setOfflineLane(true, scope);

  const nativeFetches = [];
  scope.fetch = async (input) => {
    nativeFetches.push(String(input));
    return { ok: true };
  };
  const nativeOpens = [];
  scope.XMLHttpRequest = class {
    open(method, url) {
      nativeOpens.push(`${method} ${url}`);
    }
  };

  installOfflineNetworkGuard({
    origin: KARMA_ORIGIN,
    // Adversarial legacy-shaped option: a URL allowlist must not authorize
    // native transport. Only a fake that intercepts above the guard may pass.
    allowedOrigins: ["http://example.invalid"],
    scope,
  });

  await assert.rejects(
    () => scope.fetch("http://example.invalid/testuri"),
    /blocked request/,
  );
  assert.throws(
    () =>
      new scope.XMLHttpRequest().open("GET", "http://example.invalid/testuri"),
    /blocked request/,
  );
  assert.deepEqual(nativeFetches, []);
  assert.deepEqual(nativeOpens, []);
  assert.equal(summarizeNetworkLane(scope).blockedRequests.length, 2);

  const interceptedFetches = [];
  scope.fetch = async (input) => {
    interceptedFetches.push(String(input));
    return { ok: true };
  };
  const interceptedOpens = [];
  scope.XMLHttpRequest = class FakeXMLHttpRequest {
    open(method, url) {
      interceptedOpens.push(`${method} ${url}`);
    }
  };

  await scope.fetch("http://example.invalid/mock-fetch");
  new scope.XMLHttpRequest().open("GET", "http://example.invalid/mock-xhr");
  assert.deepEqual(interceptedFetches, ["http://example.invalid/mock-fetch"]);
  assert.deepEqual(interceptedOpens, ["GET http://example.invalid/mock-xhr"]);
  assert.equal(
    summarizeNetworkLane(scope).blockedRequests.length,
    2,
    "test-local fakes must prevent the native boundary from being reached",
  );
});

test("the fetch guard handles URL and Request inputs without false local blocks", async () => {
  const scope = makeScope();
  setOfflineLane(true, scope);

  const fetched = [];
  scope.fetch = async (input) => {
    fetched.push(input);
    return { ok: true };
  };

  const uninstall = installOfflineNetworkGuard({
    origin: KARMA_ORIGIN,
    scope,
  });
  const localUrl = new URL("/base/Specs/Data/local.json", KARMA_ORIGIN);
  const localRequest = new Request(
    new URL("/base/Specs/Data/local-request.json", KARMA_ORIGIN),
  );
  const externalUrl = new URL("https://assets.cesium.com/url-input.json");
  const externalRequest = new Request(
    "https://api.cesium.com/request-input.json",
  );

  await scope.fetch(localUrl);
  await scope.fetch(localRequest);
  assert.deepEqual(fetched, [localUrl, localRequest]);

  await assert.rejects(
    () => scope.fetch(externalUrl),
    /blocked request to https:\/\/assets\.cesium\.com\/url-input\.json/,
  );
  await assert.rejects(
    () => scope.fetch(externalRequest),
    /blocked request to https:\/\/api\.cesium\.com\/request-input\.json/,
  );
  assert.deepEqual(summarizeNetworkLane(scope).blockedRequests, [
    { url: externalUrl.href, api: "fetch", spec: OUTSIDE_JASMINE_SPEC },
    { url: externalRequest.url, api: "fetch", spec: OUTSIDE_JASMINE_SPEC },
  ]);

  uninstall();
});

test("blocked evidence redacts credentials, attributes specs, and aggregates exact counts", async () => {
  const scope = makeScope();
  setOfflineLane(true, scope);
  scope.fetch = async () => ({ ok: true });
  const reporters = [];
  installOfflineNetworkSpecAttribution(
    { addReporter: (reporter) => reporters.push(reporter) },
    scope,
  );
  const uninstall = installOfflineNetworkGuard({
    origin: KARMA_ORIGIN,
    scope,
  });

  reporters[0].specStarted({ fullName: "Scene/credential adversary" });
  const secretUrl =
    "https://api.cesium.com/v1/assets/2/endpoint?access_token=jwt-secret&key=api-secret&token=session-secret&plain=kept#fragment";
  let firstError;
  await scope.fetch(secretUrl).catch((error) => {
    firstError = error;
  });
  await scope.fetch(secretUrl).catch(() => {});
  reporters[0].specDone();
  await scope.fetch(secretUrl).catch(() => {});

  const rawLedger = summarizeNetworkLane(scope).blockedRequests;
  assert.equal(rawLedger.length, 3, "the ledger must retain total attempts");
  assert.deepEqual(
    rawLedger.map(({ spec }) => spec),
    [
      "Scene/credential adversary",
      "Scene/credential adversary",
      OUTSIDE_JASMINE_SPEC,
    ],
  );
  for (const entry of rawLedger) {
    assert.match(entry.url, /access_token=\[REDACTED\]/);
    assert.match(entry.url, /key=\[REDACTED\]/);
    assert.match(entry.url, /token=\[REDACTED\]/);
    assert.match(entry.url, /plain=kept/);
    assert.doesNotMatch(entry.url, /jwt-secret|api-secret|session-secret/);
  }
  assert.doesNotMatch(
    firstError.message,
    /jwt-secret|api-secret|session-secret/,
    "request-time errors must not leak credentials",
  );

  const summary = createNetworkLaneRunSummary(scope);
  assert.equal(summary.blockedRequestCount, 3);
  assert.deepEqual(summary.blockedRequests, [
    {
      api: "fetch",
      url: "https://api.cesium.com/v1/assets/2/endpoint?access_token=[REDACTED]&key=[REDACTED]&token=[REDACTED]&plain=kept#fragment",
      spec: OUTSIDE_JASMINE_SPEC,
      count: 1,
    },
    {
      api: "fetch",
      url: "https://api.cesium.com/v1/assets/2/endpoint?access_token=[REDACTED]&key=[REDACTED]&token=[REDACTED]&plain=kept#fragment",
      spec: "Scene/credential adversary",
      count: 2,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /jwt-secret|api-secret|session-secret/,
  );
  assert.equal(scope[CURRENT_JASMINE_SPEC_KEY], OUTSIDE_JASMINE_SPEC);
  assert.equal(
    redactSensitiveRequestUrl("/x?ACCESS_TOKEN=secret&ok=yes"),
    "/x?ACCESS_TOKEN=[REDACTED]&ok=yes",
  );
  assert.equal(
    redactSensitiveRequestUrl("/x?%E0%A4%A=malformed-secret&ok=yes"),
    "/x?%E0%A4%A=[REDACTED]&ok=yes",
    "an undecodable query name must fail closed instead of leaking its value",
  );
  uninstall();
});

test("every repository credential query alias is redacted before errors and evidence", async () => {
  const scope = makeScope();
  setOfflineLane(true, scope);
  scope.fetch = async () => ({ ok: true });
  const uninstall = installOfflineNetworkGuard({
    origin: KARMA_ORIGIN,
    scope,
  });
  const credentialUrl =
    "https://credentials.invalid/resource?subscription-key=azure-secret&API_KEY=pelias-secret&se%73sion=google-session&sig%6Eature=street-secret&client%5Fsecret=oauth-secret&plain=kept";
  let requestError;
  await scope.fetch(credentialUrl).catch((error) => {
    requestError = error;
  });

  const forbiddenValues =
    /azure-secret|pelias-secret|google-session|street-secret|oauth-secret/;
  assert.doesNotMatch(requestError.message, forbiddenValues);
  const rawLedger = summarizeNetworkLane(scope).blockedRequests;
  assert.equal(rawLedger.length, 1);
  assert.doesNotMatch(JSON.stringify(rawLedger), forbiddenValues);
  const summary = createNetworkLaneRunSummary(scope);
  assert.equal(summary.blockedRequestCount, 1);
  assert.doesNotMatch(JSON.stringify(summary), forbiddenValues);
  assert.equal(
    summary.blockedRequests[0].url,
    "https://credentials.invalid/resource?subscription-key=[REDACTED]&API_KEY=[REDACTED]&se%73sion=[REDACTED]&sig%6Eature=[REDACTED]&client%5Fsecret=[REDACTED]&plain=kept",
  );
  uninstall();
});

test("spec attribution is fail-closed when the reporter is unavailable", () => {
  const scope = makeScope();
  setOfflineLane(true, scope);
  assert.throws(
    () => installOfflineNetworkSpecAttribution({}, scope),
    /attribution reporter is unavailable/,
  );
  assert.equal(scope[CURRENT_JASMINE_SPEC_KEY], OUTSIDE_JASMINE_SPEC);
});

test("the root hook publishes a stable, reasoned skip summary and stays inert online", () => {
  const scope = makeScope();
  setOfflineLane(true, scope);

  const afterAllHooks = [];
  const reports = [];
  installOfflineNetworkRunAssertion(
    {
      afterAll(callback) {
        afterAllHooks.push(callback);
      },
    },
    { scope, report: (message) => reports.push(message) },
  );

  // Deliberately declare these out of order. The published report must remain
  // stable when module evaluation order changes.
  describeRequiresNetwork("Zulu/service", function () {}, undefined, scope);
  describeRequiresNetwork("Alpha/service", function () {}, undefined, scope);

  assert.doesNotThrow(() => afterAllHooks[0]());
  const expected = {
    offline: true,
    skippedSuiteCount: 2,
    blockedRequestCount: 0,
    skippedSuites: [
      { name: "Alpha/service", reason: NETWORK_LANE_SKIP_REASON },
      { name: "Zulu/service", reason: NETWORK_LANE_SKIP_REASON },
    ],
    blockedRequests: [],
  };
  assert.deepEqual(scope[NETWORK_LANE_SUMMARY_KEY], expected);
  assert.deepEqual(createNetworkLaneRunSummary(scope), expected);
  assert.equal(
    reports[0],
    `${NETWORK_LANE_SUMMARY_PREFIX}${JSON.stringify(expected)}`,
  );
  assert.equal(formatNetworkLaneRunSummary(expected), reports[0]);

  // `--no-offline` reaches customizeJasmine as false. Even if the helper were
  // installed accidentally, its end hook must not impose offline semantics.
  setOfflineLane(false, scope);
  scope[BLOCKED_REQUESTS_KEY].push({
    api: "fetch",
    url: "https://online.example.test/allowed",
  });
  assert.doesNotThrow(() => afterAllHooks[0]());
  assert.equal(scope[NETWORK_LANE_SUMMARY_KEY], undefined);
  assert.equal(reports.length, 1);
});

test("the root hook FAILS a caught blocked request at end of run", async () => {
  const scope = makeScope();
  setOfflineLane(true, scope);
  scope.fetch = async () => ({ ok: true });

  const afterAllHooks = [];
  const reports = [];
  installOfflineNetworkRunAssertion(
    {
      afterAll(callback) {
        afterAllHooks.push(callback);
      },
    },
    { scope, report: (message) => reports.push(message) },
  );
  const uninstall = installOfflineNetworkGuard({
    origin: KARMA_ORIGIN,
    scope,
  });

  // Adversarial control: product/spec code handles the request-time rejection,
  // so the only remaining failure path is the root ledger assertion.
  let caught;
  await scope
    .fetch("https://assets.cesium.com/adversarial/tileset.json")
    .catch((error) => {
      caught = error;
    });
  assert.match(caught.message, /blocked request/);

  assert.throws(
    () => afterAllHooks[0](),
    /1 blocked request\(s\).*end-of-run ledger.*fail-closed/s,
  );
  assert.equal(scope[NETWORK_LANE_SUMMARY_KEY].blockedRequestCount, 1);
  assert.match(reports[0], /"blockedRequestCount":1/);
  assert.match(reports[0], /adversarial\/tileset\.json/);

  uninstall();
});

// ─────────────────────────── wiring anchors ───────────────────────────

test("the lane flag is published before any spec module evaluates", async () => {
  const customizeJasmine = await readRepoFile("Specs/customizeJasmine.js");
  assert.match(customizeJasmine, /setOfflineLane\(offline === true\)/);
  assert.match(customizeJasmine, /installOfflineNetworkGuard\(\{/);
  assert.match(customizeJasmine, /installOfflineNetworkSpecAttribution\(env/);
  assert.match(customizeJasmine, /installOfflineNetworkRunAssertion\(env/);
  assert.match(customizeJasmine, /window\.__karma__\.info\(\{/);

  const karmaConfig = await readRepoFile("Specs/karma.conf.cjs");
  assert.match(karmaConfig, /captureConsole:\s*false/);
  assert.match(
    karmaConfig,
    /browserConsoleLogOptions:\s*\{[\s\S]*?level:\s*"info"[\s\S]*?terminal:\s*true/,
  );

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

test("the widgets Viewer helper suppresses only implicit network defaults offline", async () => {
  const pickerDefaults = {};
  assert.equal(
    applyOfflineViewerNetworkDefaults(pickerDefaults, true),
    pickerDefaults,
  );
  assert.deepEqual(pickerDefaults.imageryProviderViewModels, []);
  assert.equal(pickerDefaults.baseLayer, false);

  const pickerDisabled = { baseLayerPicker: false };
  applyOfflineViewerNetworkDefaults(pickerDisabled, true);
  assert.equal(pickerDisabled.baseLayer, false);

  const explicitModels = [{ name: "local fixture" }];
  const explicitBaseLayer = { name: "local layer" };
  const explicitPicker = { imageryProviderViewModels: explicitModels };
  const explicitLayer = {
    baseLayerPicker: false,
    baseLayer: explicitBaseLayer,
  };
  applyOfflineViewerNetworkDefaults(explicitPicker, true);
  applyOfflineViewerNetworkDefaults(explicitLayer, true);
  assert.equal(explicitPicker.imageryProviderViewModels, explicitModels);
  assert.equal(
    explicitPicker.baseLayer,
    false,
    "an explicit roster still needs the pre-picker CesiumWidget layer suppressed",
  );
  assert.equal(explicitLayer.baseLayer, explicitBaseLayer);

  const explicitSelection = {
    selectedImageryProviderViewModel: { name: "selected local fixture" },
  };
  applyOfflineViewerNetworkDefaults(explicitSelection, true);
  assert.equal("imageryProviderViewModels" in explicitSelection, false);
  assert.equal(
    "baseLayer" in explicitSelection,
    false,
    "Viewer already suppresses its initial layer for an explicit selection",
  );

  const noGlobe = { globe: false };
  applyOfflineViewerNetworkDefaults(noGlobe, true);
  assert.deepEqual(noGlobe, { globe: false });

  const online = {};
  applyOfflineViewerNetworkDefaults(online, false);
  assert.deepEqual(online, {}, "the online lane must keep production defaults");

  const createViewer = await readRepoFile(
    "packages/widgets/Specs/createViewer.js",
  );
  assert.match(
    createViewer,
    /applyOfflineViewerNetworkDefaults\(options, isOfflineLane\(window\)\)/,
  );

  const viewerSource = await readRepoFile(
    "packages/widgets/Source/Viewer/Viewer.js",
  );
  const cesiumWidgetSource = await readRepoFile(
    "packages/engine/Source/Widget/CesiumWidget.js",
  );
  assert.match(
    viewerSource,
    /baseLayer:[\s\S]*?defined\(options\.baseLayer\)[\s\S]*?\? false[\s\S]*?: undefined/,
    "Viewer must translate a defined offline baseLayer override to CesiumWidget false",
  );
  assert.match(
    cesiumWidgetSource,
    /options\.globe !== false && baseLayer !== false[\s\S]*?ImageryLayer\.fromWorldImagery\(\)/,
    "the false override must suppress CesiumWidget's implicit World Imagery",
  );
});

test("the live-service inventory dynamically scans every engine spec", async () => {
  const specSources = await enumerateEngineSpecSources();
  assert.ok(
    specSources.size > LIVE_SERVICE_SPEC_CLASSIFICATIONS.size,
    "the scanner must inspect the engine spec tree, not only the manifest",
  );

  const candidates = auditLiveServiceSpecInventory(specSources);
  assert.deepEqual(
    candidates,
    [...LIVE_SERVICE_SPEC_CLASSIFICATIONS.keys()].sort(),
  );
  assert.deepEqual(
    candidates.filter(
      (specPath) =>
        LIVE_SERVICE_SPEC_CLASSIFICATIONS.get(specPath).disposition ===
        "requires-network",
    ),
    [
      "packages/engine/Specs/Core/createWorldBathymetryAsyncSpec.js",
      "packages/engine/Specs/Core/createWorldTerrainAsyncSpec.js",
      "packages/engine/Specs/Core/sampleTerrainMostDetailedSpec.js",
      "packages/engine/Specs/Core/sampleTerrainSpec.js",
      "packages/engine/Specs/Core/TerrainPickerSpec.js",
    ].sort(),
  );
});

test("every observed engine escape has a source-pinned offline repair", async () => {
  const sources = new Map();
  for (const specPath of OFFLINE_ESCAPE_REPAIR_ANCHORS.keys()) {
    sources.set(specPath, await readRepoFile(specPath));
  }
  assert.doesNotThrow(() => auditOfflineEscapeRepairAnchors(sources));

  // Mutation control: every individual mechanism is necessary. Removing any
  // reviewed anchor must make the source audit red, including the shared helper
  // mechanisms that cover several runtime tests.
  for (const [specPath, anchors] of OFFLINE_ESCAPE_REPAIR_ANCHORS) {
    for (const anchor of anchors) {
      const mutated = new Map(sources);
      const source = mutated.get(specPath);
      const match = source.match(anchor);
      assert.ok(match, `${specPath}: mutation precondition must match`);
      const mutationPattern = new RegExp(
        anchor.source,
        anchor.flags.includes("g") ? anchor.flags : `${anchor.flags}g`,
      );
      mutated.set(
        specPath,
        source.replace(mutationPattern, "/* removed repair */"),
      );
      assert.throws(
        () => auditOfflineEscapeRepairAnchors(mutated),
        new RegExp(specPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
  }

  const ionSource = sources.get(
    "packages/engine/Specs/Scene/IonImageryProviderSpec.js",
  );
  assert.equal(
    ionSource.match(/installFakeTileMapServiceRequest\(\);/g).length,
    3,
    "two direct TMS constructions plus one beforeEach cover exactly three generated TMS tests (five total)",
  );
  const geeImagerySource = sources.get(
    "packages/engine/Specs/Scene/GoogleEarthEnterpriseImageryProviderSpec.js",
  );
  assert.equal(
    geeImagerySource.match(/installMockDbRootFallback\(url\);/g).length,
    4,
    "four imagery-provider tests plus the metadata populateSubtree test cover all five dbRoot escapes",
  );
});

test("a partial world-imagery transport mock is REJECTED", async () => {
  const specSources = await enumerateEngineSpecSources();
  const specPath = "packages/engine/Specs/Scene/createWorldImageryAsyncSpec.js";
  const source = specSources.get(specPath);
  const partialMock = source.replace(
    'spyOn(endpointResource, "fetchJson")',
    "void endpointResource.fetchJson",
  );
  assert.notEqual(
    partialMock,
    source,
    "the negative control must mutate source",
  );
  specSources.set(specPath, partialMock);

  assert.throws(
    () => auditLiveServiceSpecInventory(specSources),
    (error) => {
      assert.match(error.message, /createWorldImageryAsyncSpec\.js/);
      assert.match(error.message, /reviewed transport mock is missing/);
      return true;
    },
  );
});

test("a newly added unclassified live-service spec is REJECTED", async () => {
  const specSources = await enumerateEngineSpecSources();
  const adversarialPath =
    "packages/engine/Specs/Core/AdversarialNewLiveServiceSpec.js";
  specSources.set(
    adversarialPath,
    `import { createWorldTerrainAsync } from "../../index.js";
describe("Core/adversarial", function () {
  it("loads live terrain", async function () {
    await createWorldTerrainAsync();
  });
});`,
  );

  assert.throws(
    () => auditLiveServiceSpecInventory(specSources),
    (error) => {
      assert.match(error.message, /live-service inventory rejected/);
      assert.match(error.message, /AdversarialNewLiveServiceSpec\.js/);
      assert.match(error.message, /unclassified live-service spec/);
      assert.match(error.message, /createWorldTerrainAsync/);
      return true;
    },
  );
});
