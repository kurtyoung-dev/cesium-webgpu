import assert from "node:assert/strict";
import test from "node:test";

import getAbsoluteUri from "../../Source/Core/getAbsoluteUri.js";
import IonResource from "../../Source/Core/IonResource.js";
import Resource from "../../Source/Core/Resource.js";

// A url has to come back out of a Resource the way its caller spelled it, and
// the only authority on "the way its caller spelled it" is upstream CesiumJS,
// whose `parseUrl` runs the input through urijs and returns `uri.toString()`.
// Every expected string below was measured by running that upstream algorithm
// over the same input; none is computed here, so this file can disagree with
// the engine.
//
// The interesting shapes are the ones `URL` cannot rebuild: `URL.origin` is the
// literal string "null" for every scheme the URL Standard does not treat as
// special, it drops userinfo, and the parser lower-cases scheme and host.

const absoluteUrls = [
  // The authority's case survives — a CZML `billboard.image` is compared and
  // displayed as written, not just resolved.
  ["http://someImage.invalid/image.png", "http://someImage.invalid/image.png"],
  ["HTTP://Host.Invalid/Path", "HTTP://Host.Invalid/Path"],
  ["http://user:pw@Host.invalid/p", "http://user:pw@Host.invalid/p"],
  ["http://[2001:DB8::1]/p", "http://[2001:DB8::1]/p"],
  ["http://host:8080/p", "http://host:8080/p"],
  // Path separators and dot segments are left alone; nothing resolves them.
  ["http://h/a//b.js", "http://h/a//b.js"],
  ["http://h/a/./b/../c", "http://h/a/./b/../c"],
  ["http://h/x%20y.js", "http://h/x%20y.js"],
  // An authority with no path serialises with a root path.
  ["http://h", "http://h/"],
  // Schemes the URL Standard does not treat as special.
  ["file:///C:/a/b.txt", "file:///C:/a/b.txt"],
  ["mailto:a@b.com", "mailto:a@b.com"],
  ["custom-scheme:opaque/thing", "custom-scheme:opaque/thing"],
  ["data:image/png;base64,AAA", "data:image/png;base64,AAA"],
  ["blob:https://h/uuid", "blob:https://h/uuid"],
  // The query and fragment are held separately, not in the url component.
  ["http://h/p?q=1#f", "http://h/p"],
];

// The two shapes the no-base branch exists for; both must stay as written.
const relativeUrls = [
  ["//host/path/x.png", "//host/path/x.png"],
  ["Assets/foo", "Assets/foo"],
  ["a/b#frag", "a/b"],
  ["a/b?q=1", "a/b"],
  ["", ""],
];

// [base, url, expected] for `parent.getDerivedResource({ url })`.
const derivedUrls = [
  [
    "http://someImage.invalid/",
    "image.png",
    "http://someImage.invalid/image.png",
  ],
  // Worker module ids are composed as `${prefix}/${id}.js` over a prefix that
  // already ends in a slash, so the merge has to collapse the run.
  [
    "http://test.com/source/",
    "Workers//transferTypedArrayTest.js",
    "http://test.com/source/Workers/transferTypedArrayTest.js",
  ],
  [
    "http://Host.Invalid/Build/Cesium/",
    "Assets/foo",
    "http://Host.Invalid/Build/Cesium/Assets/foo",
  ],
  [
    "http://user:pw@Host.invalid/base/",
    "x.js",
    "http://user:pw@Host.invalid/base/x.js",
  ],
  ["http://test.com/source/deep/", "../up.js", "http://test.com/source/up.js"],
  // A root-relative url replaces the base's path outright, so nothing was
  // merged onto the base's path and there is no separator run to collapse.
  ["http://test.com/source/", "/root.js", "http://test.com/root.js"],
  ["http://test.com/source/", "/a//b.js", "http://test.com/a//b.js"],
  // The base's scheme is reported the way the base spelled it.
  ["HTTP://Host.Invalid/base/", "x.js", "HTTP://Host.Invalid/base/x.js"],
  // A protocol-relative url brings its own authority and takes the scheme.
  ["http://test.com/source/", "//other.Host/x.js", "http://other.Host/x.js"],
  ["http://test.com:8080/source/", "x.js", "http://test.com:8080/source/x.js"],
  ["http://[2001:DB8::1]/source/", "x.js", "http://[2001:DB8::1]/source/x.js"],
  [
    "http://test.com/source/",
    "sub/x.js?a=1#f",
    "http://test.com/source/sub/x.js",
  ],
  // A url that carries its own scheme ignores the base entirely.
  [
    "http://test.com/source/",
    "http://elsewhere.Invalid/y.js",
    "http://elsewhere.Invalid/y.js",
  ],
];

test("an absolute url survives a Resource unchanged", () => {
  for (const [url, expected] of absoluteUrls) {
    assert.equal(
      new Resource({ url: url }).getUrlComponent(false),
      expected,
      `input ${url}`,
    );
  }
});

test("a relative url with no base survives a Resource unchanged", () => {
  for (const [url, expected] of relativeUrls) {
    assert.equal(
      new Resource({ url: url }).getUrlComponent(false),
      expected,
      `input ${url}`,
    );
  }
});

test("a derived url resolves against its parent the way absoluteTo did", () => {
  for (const [base, url, expected] of derivedUrls) {
    assert.equal(
      new Resource({ url: base })
        .getDerivedResource({ url: url })
        .getUrlComponent(false),
      expected,
      `base ${base} + ${url}`,
    );
  }
});

// The same table again, with the `document` a browser supplies. It is not a
// redundant run: `getAbsoluteUri` consults `document.baseURI` when no explicit
// base is given and then returns `new URL(base, document.baseURI).href`, which
// lower-cases the scheme and the host. Without this test a base-resolved url
// can be correct in Node and wrong in every browser, which is the state that
// produced the two `DataSources/CzmlDataSource` CI failures.
test("a derived url resolves the same way when a document is present", () => {
  const saved = globalThis.document;
  globalThis.document = { baseURI: "http://localhost:9876/context.html" };
  try {
    for (const [base, url, expected] of derivedUrls) {
      assert.equal(
        new Resource({ url: base })
          .getDerivedResource({ url: url })
          .getUrlComponent(false),
        expected,
        `base ${base} + ${url}`,
      );
    }
  } finally {
    globalThis.document = saved;
  }
});

// `getAbsoluteUri._implementation` is a seam: the engine's own jasmine spec
// replaces it, and an embedder can. A Resource url is its caller's text, so it
// must not move when that function's spelling does -- which is also what keeps
// the two halves of the ion authority check reading the same string.
test("a derived url keeps its parent authority even when getAbsoluteUri rewrites", () => {
  const original = getAbsoluteUri._implementation;
  getAbsoluteUri._implementation = (relative, base) =>
    new URL(relative, base ?? "http://localhost:9876/context.html").href;
  try {
    assert.equal(
      new Resource({ url: "http://someImage.invalid/" })
        .getDerivedResource({ url: "image.png" })
        .getUrlComponent(false),
      "http://someImage.invalid/image.png",
    );
  } finally {
    getAbsoluteUri._implementation = original;
  }
});
test("a query string is still parsed out of an absolute url", () => {
  const resource = new Resource({ url: "http://Host.invalid/p?a=1&b=2#f" });
  assert.deepEqual(resource.queryParameters, { a: "1", b: "2" });
  assert.equal(resource.url, "http://Host.invalid/p?a=1&b=2");
});

// `IonResource` compares the server the endpoint is served by against the one
// the url it is about to request will be fetched from, to decide whether the ion
// token may travel with it. Both sides are read off the URL parser, so a host is
// the parser's spelling of it: lower-cased, a default port dropped, the userinfo
// left out. An endpoint url that is not absolute names no server of its own,
// which is not an error -- it is the self-hosted and proxied deployment.
// `CredentialDestinationSpec.mjs` holds the attack table for the comparison
// itself; these rows pin only what is read off the endpoint.

const ionEndpointDestinations = [
  // A self-hosted or proxied endpoint, and the shape the terrain suite builds.
  ["Data/CesiumTerrainTileJson/QuantizedMeshWithOctVertexNormals", ""],
  ["", ""],
  // The scheme is part of the answer: the same host under another scheme is
  // not the endpoint (`file://host` is a UNC share, `http://host` is
  // cleartext).
  ["https://API.cesium.invalid/v1/assets/1/", "https://api.cesium.invalid"],
  ["https://api.cesium.invalid:8443/v1/", "https://api.cesium.invalid:8443"],
  ["https://api.cesium.invalid:443/v1/", "https://api.cesium.invalid"],
  ["https://User:Pw@api.cesium.invalid/v1/", "https://api.cesium.invalid"],
];

function makeEndpoint(url) {
  return {
    type: "TERRAIN",
    url: url,
    accessToken: "not_really_an_access_token",
    attributions: [],
  };
}

/**
 * The options `IonResource` hands down to `Resource.prototype._makeRequest`,
 * which is where the ion token either is or is not attached.
 */
function requestOptionsFor(resource) {
  const original = Resource.prototype._makeRequest;
  let seen;
  Resource.prototype._makeRequest = function (options) {
    seen = options;
    return undefined;
  };
  try {
    resource._makeRequest({ responseType: "text" });
  } finally {
    Resource.prototype._makeRequest = original;
  }
  return seen;
}

test("an ion endpoint url that is not absolute constructs and names no server of its own", () => {
  for (const [url, expected] of ionEndpointDestinations) {
    const endpoint = makeEndpoint(url);
    const resource = new IonResource(endpoint, new Resource({ url: url }));
    assert.equal(resource._ionEndpointDomain, expected, `endpoint url ${url}`);
  }
});

test("the ion token travels with a request to the endpoint's own authority", () => {
  const endpoint = makeEndpoint("https://API.cesium.invalid/v1/assets/1/tile");
  const resource = new IonResource(
    endpoint,
    new Resource({ url: endpoint.url }),
  );

  assert.equal(
    requestOptionsFor(resource).headers.Authorization,
    "Bearer not_really_an_access_token",
  );
});

// The authority check has two sides and they are read off two different
// strings: the endpoint's own text, and the url of the resource about to be
// requested. A tile request is a DERIVED resource, and a derived url is the one
// that goes through `getAbsoluteUri` — so this is the case where the two sides
// can be made to disagree, and it only happens when a document is present.
test("the ion token travels with a derived resource of a mixed-case endpoint", () => {
  const saved = globalThis.document;
  globalThis.document = { baseURI: "http://localhost:9876/context.html" };
  try {
    const endpoint = makeEndpoint("https://API.cesium.invalid/v1/assets/1/");
    const resource = new IonResource(
      endpoint,
      new Resource({ url: endpoint.url }),
    );
    const derived = resource.getDerivedResource({ url: "layer.json" });

    assert.equal(
      derived.url,
      "https://API.cesium.invalid/v1/assets/1/layer.json",
    );
    assert.equal(
      requestOptionsFor(derived).headers.Authorization,
      "Bearer not_really_an_access_token",
    );
  } finally {
    globalThis.document = saved;
  }
});

test("the ion token travels with a relative endpoint, which has no authority to differ from", () => {
  const endpoint = makeEndpoint(
    "Data/CesiumTerrainTileJson/QuantizedMeshWithOctVertexNormals",
  );
  const resource = new IonResource(
    endpoint,
    new Resource({ url: endpoint.url }),
  );

  assert.equal(
    requestOptionsFor(resource).headers.Authorization,
    "Bearer not_really_an_access_token",
  );
});

// RFC 3986 section 3.2.2 makes a host case-insensitive, so one host spelled
// two ways is one host. Upstream compared the two authorities as text and
// dropped the token here; a 401 with nothing in it that says why is worse
// than a header reaching the server it was minted for. This is a deliberate
// departure from upstream, and it is why both sides are read off the URL
// parser, which folds the spellings of one host together rather than leaving
// two strings to stay in step by hand.
test("the ion token travels to the same host spelled a different way", () => {
  const endpoint = makeEndpoint("https://API.cesium.invalid/v1/assets/1/tile");
  const resource = new IonResource(
    endpoint,
    new Resource({ url: endpoint.url }),
  );
  resource.url = "https://api.CESIUM.invalid/v1/assets/1/tile";

  assert.equal(
    requestOptionsFor(resource).headers.Authorization,
    "Bearer not_really_an_access_token",
  );
});
test("the ion token does not travel to another authority", () => {
  const endpoint = makeEndpoint("https://API.cesium.invalid/v1/assets/1/tile");
  const resource = new IonResource(
    endpoint,
    new Resource({ url: endpoint.url }),
  );
  resource.url = "https://somewhere.else.invalid/v1/assets/1/tile";

  const options = requestOptionsFor(resource);
  assert.equal(options.headers?.Authorization, undefined);
});
