import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import DefaultProxy from "../../Source/Core/DefaultProxy.js";
import Request from "../../Source/Core/Request.js";
import Resource from "../../Source/Core/Resource.js";

// AR-757 / L2-DAT-1. `Resource.getDerivedResource` is reached with a url taken
// straight out of a loaded document - CZML `uri`, KML `<href>`, 3D Tiles
// `content.uri` all call it as `parent.getDerivedResource({ url })` and nothing
// else. This spec measures what a *server* receives, not what the Resource
// object holds, so it fails if the derived request carries the parent's
// credentials to a host the document named.
//
// Both "hosts" here are local http servers on ephemeral 127.0.0.1 ports; two
// different ports are two different origins, which is all the check compares.

const PROBE_HEADER = "x-probe";
const TOKEN_PARAMETER = "token=";

async function startRecordingServer() {
  const received = [];
  const server = http.createServer((request, response) => {
    received.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    received,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

function countCarryingProbeHeader(received) {
  return received.filter((entry) => PROBE_HEADER in entry.headers).length;
}

function countCarryingTokenParameter(received) {
  return received.filter((entry) => entry.url.includes(TOKEN_PARAMETER)).length;
}

/**
 * An authenticated parent resource on the application's own origin: a request
 * header and a query parameter, both of the kind that carry credentials.
 */
function createAuthenticatedParent(appOrigin) {
  return new Resource({
    url: `${appOrigin}/app/scene.czml`,
    headers: { "X-Probe": "probe-value" },
    queryParameters: { token: "spec-only-token" },
  });
}

test("AR-757 derived-resource credentials stop at the origin boundary", async (t) => {
  const app = await startRecordingServer();
  const far = await startRecordingServer();
  t.after(async () => {
    await app.close();
    await far.close();
  });

  await t.test(
    "a document-chosen cross-origin url receives neither the header nor the query parameter",
    async () => {
      const parent = createAuthenticatedParent(app.origin);
      const derived = parent.getDerivedResource({
        url: `${far.origin}/tiles/billboard.png`,
      });

      await derived.fetchText();

      assert.equal(far.received.length, 1, "the far host was reached once");
      assert.equal(
        countCarryingProbeHeader(far.received),
        0,
        "no request to the far host carried the parent's header",
      );
      assert.equal(
        countCarryingTokenParameter(far.received),
        0,
        "no request to the far host carried the parent's query parameter",
      );
    },
  );

  await t.test(
    "the same-origin control still carries both, one for one",
    async () => {
      const parent = createAuthenticatedParent(app.origin);
      const derived = parent.getDerivedResource({
        url: "images/billboard.png",
      });

      await derived.fetchText();

      assert.equal(app.received.length, 1, "the app host was reached once");
      assert.equal(countCarryingProbeHeader(app.received), 1);
      assert.equal(countCarryingTokenParameter(app.received), 1);
      app.received.length = 0;
    },
  );

  await t.test(
    "a three-deep same-origin derivation chain still carries the headers",
    async () => {
      const parent = createAuthenticatedParent(app.origin);
      const third = parent
        .getDerivedResource({ url: "a/" })
        .getDerivedResource({ url: "b/" })
        .getDerivedResource({ url: "c.json" });

      assert.equal(
        third.url,
        `${app.origin}/app/a/b/c.json?token=spec-only-token`,
      );

      await third.fetchText();

      assert.equal(app.received.length, 1);
      assert.equal(countCarryingProbeHeader(app.received), 1);
      assert.equal(countCarryingTokenParameter(app.received), 1);
      app.received.length = 0;
    },
  );

  await t.test(
    "headers and query parameters passed to the derivation itself survive a cross-origin url",
    async () => {
      const parent = createAuthenticatedParent(app.origin);
      const derived = parent.getDerivedResource({
        url: `${far.origin}/explicit.png`,
        headers: { "X-Explicit": "caller-intent" },
        queryParameters: { explicit: "caller-intent" },
      });

      far.received.length = 0;
      await derived.fetchText();

      assert.equal(far.received.length, 1);
      assert.equal(
        far.received[0].headers["x-explicit"],
        "caller-intent",
        "the caller's own header reached the far host",
      );
      assert.match(
        far.received[0].url,
        /explicit=caller-intent/,
        "the caller's own query parameter reached the far host",
      );
      assert.equal(countCarryingProbeHeader(far.received), 0);
      assert.equal(countCarryingTokenParameter(far.received), 0);
    },
  );

  await t.test(
    "a cross-origin derived url keeps the query string it carries itself",
    async () => {
      const parent = createAuthenticatedParent(app.origin);
      const derived = parent.getDerivedResource({
        url: `${far.origin}/own-query.png?q=1`,
      });

      far.received.length = 0;
      await derived.fetchText();

      assert.equal(far.received.length, 1);
      assert.match(far.received[0].url, /[?&]q=1/);
      assert.equal(countCarryingTokenParameter(far.received), 0);
    },
  );
});

test("AR-757 an origin that cannot be determined is not treated as different", () => {
  // A parent with no resolvable origin (a relative url outside a browser) keeps
  // the behaviour it has today: the check only fires when both origins are known
  // and differ.
  const parent = new Resource({
    url: "Assets/scene.czml",
    headers: { "X-Probe": "probe-value" },
    queryParameters: { token: "spec-only-token" },
  });

  const derived = parent.getDerivedResource({ url: "images/billboard.png" });

  assert.equal(derived.headers["X-Probe"], "probe-value");
  assert.equal(derived.queryParameters.token, "spec-only-token");
});

// Principle 1. `Core/Resource.js` is upstream code, and the upstream
// `getDerivedResource` expectations live in a Jasmine suite
// (`packages/engine/Specs/Core/ResourceSpec.js`) that only runs in a browser.
// All thirty-three expectations of that suite's seven `getDerivedResource`
// cases (`:208`, `:231`, `:299`, `:376`, `:390`, `:404`, `:422` at
// `dcf7c9c069`) are replayed here verbatim - the parent-construction ones as
// well as the derivation ones - so the runner this lane can actually execute
// pins the preserved behaviour instead of prose asserting it.
// Every one of them derives same-origin or relative, which is why none of them
// moves: the origin check fires only on a positively-established difference.
test("AR-757 the upstream getDerivedResource expectations are unchanged", async (t) => {
  await t.test(
    "ResourceSpec:208 — multiple query-parameter values, without preserveQueryParameters",
    () => {
      const resource = new Resource(
        "http://test.com/tileset/endpoint?a=1&a=2&b=3&a=4",
      );
      assert.deepEqual(resource.queryParameters.a, ["1", "2", "4"]);
      assert.equal(resource.queryParameters.b, "3");
      assert.equal(
        resource.url,
        "http://test.com/tileset/endpoint?a=1&a=2&a=4&b=3",
      );
      const derived = resource.getDerivedResource({
        url: "other_endpoint?a=5&b=6&a=7",
      });

      assert.deepEqual(derived.queryParameters.a, ["5", "7"]);
      assert.equal(derived.queryParameters.b, "6");
      assert.equal(
        derived.url,
        "http://test.com/tileset/other_endpoint?a=5&a=7&b=6",
      );
    },
  );

  await t.test(
    "ResourceSpec:231 — multiple query-parameter values, with preserveQueryParameters",
    () => {
      const resource = new Resource(
        "http://test.com/tileset/endpoint?a=1&a=2&b=3&a=4",
      );
      assert.deepEqual(resource.queryParameters.a, ["1", "2", "4"]);
      assert.equal(resource.queryParameters.b, "3");
      assert.equal(
        resource.url,
        "http://test.com/tileset/endpoint?a=1&a=2&a=4&b=3",
      );
      const derived = resource.getDerivedResource({
        url: "other_endpoint?a=5&b=6&a=7",
        preserveQueryParameters: true,
      });

      assert.deepEqual(derived.queryParameters.a, ["5", "7", "1", "2", "4"]);
      assert.deepEqual(derived.queryParameters.b, ["6", "3"]);
      assert.equal(
        derived.url,
        "http://test.com/tileset/other_endpoint?a=5&a=7&a=1&a=2&a=4&b=6&b=3",
      );
    },
  );

  await t.test(
    "ResourceSpec:299 — getDerivedResource sets correct properties",
    () => {
      const proxy = new DefaultProxy("/proxy/");
      const request = new Request();
      function retryFunc() {}

      const parent = new Resource({
        url: "http://test.com/tileset?key=value",
        queryParameters: { foo: "bar" },
        templateValues: { key5: "value5", key6: "value6" },
      });
      parent.appendForwardSlash();

      const resource = parent.getDerivedResource({
        url: "tileset.json",
        queryParameters: { key1: "value1", key2: "value2" },
        templateValues: { key3: "value3", key4: "value4" },
        headers: { Accept: "application/test-type" },
        proxy: proxy,
        retryCallback: retryFunc,
        retryAttempts: 4,
        request: request,
      });

      const expectedUrl = "http://test.com/tileset/tileset.json";
      const expectedUrlWithQuery = `${expectedUrl}?key1=value1&key2=value2&key=value&foo=bar`;

      assert.equal(resource.getUrlComponent(false, false), expectedUrl);
      assert.equal(resource.getUrlComponent(true, false), expectedUrlWithQuery);
      assert.equal(
        resource.getUrlComponent(false, true),
        proxy.getURL(expectedUrl),
      );
      assert.equal(
        resource.getUrlComponent(true, true),
        proxy.getURL(expectedUrlWithQuery),
      );
      assert.equal(resource.url, proxy.getURL(expectedUrlWithQuery));
      assert.deepEqual(resource.queryParameters, {
        foo: "bar",
        key: "value",
        key1: "value1",
        key2: "value2",
      });
      assert.deepEqual(resource.templateValues, {
        key5: "value5",
        key6: "value6",
        key3: "value3",
        key4: "value4",
      });
      assert.deepEqual(resource.headers, { Accept: "application/test-type" });
      assert.equal(resource.proxy, proxy);
      assert.equal(resource.retryCallback, retryFunc);
      assert.equal(resource.retryAttempts, 4);
      assert.equal(resource._retryCount, 0);
      assert.equal(resource.request, request);
    },
  );

  await t.test("ResourceSpec:376 — directory parent resource", () => {
    const parent = new Resource({ url: "http://test.com/tileset/" });

    assert.equal(parent.url, "http://test.com/tileset/");
    const resource = parent.getDerivedResource({ url: "tileset.json" });

    assert.equal(resource.url, "http://test.com/tileset/tileset.json");
  });

  await t.test("ResourceSpec:390 — file parent resource", () => {
    const parent = new Resource({
      url: "http://test.com/tileset/tileset.json",
    });

    assert.equal(parent.url, "http://test.com/tileset/tileset.json");
    const resource = parent.getDerivedResource({ url: "0/0/0.b3dm" });

    assert.equal(resource.url, "http://test.com/tileset/0/0/0.b3dm");
  });

  await t.test("ResourceSpec:404 — only template values", () => {
    const parent = new Resource({
      url: "http://test.com/terrain/{z}/{x}/{y}.terrain",
    });

    assert.equal(parent.url, "http://test.com/terrain/{z}/{x}/{y}.terrain");
    const resource = parent.getDerivedResource({
      templateValues: { x: 1, y: 2, z: 0 },
    });

    assert.equal(resource.url, "http://test.com/terrain/0/1/2.terrain");
  });

  await t.test("ResourceSpec:422 — only query parameters", () => {
    const parent = new Resource({ url: "http://test.com/terrain" });

    assert.equal(parent.url, "http://test.com/terrain");
    const resource = parent.getDerivedResource({
      queryParameters: { x: 1, y: 2, z: 0 },
    });

    assert.equal(resource.url, "http://test.com/terrain?x=1&y=2&z=0");
  });
});
