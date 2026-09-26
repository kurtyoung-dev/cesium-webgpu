import assert from "node:assert/strict";
import test from "node:test";

import IonResource from "../../Source/Core/IonResource.js";
import Resource from "../../Source/Core/Resource.js";

// A credential reaches only the server it was minted for.
//
// Two credentials are carried through `Resource`: the ion access token, which
// `IonResource._makeRequest` attaches when the url it is about to request is
// served by the ion endpoint's own server, and a parent resource's request
// headers and query parameters, which `Resource.getDerivedResource` forwards to
// a derived url. Both decisions are the same decision -- "is this the same
// server?" -- and both are made about a url that came out of a document the
// application did not write (a CZML `uri`, a KML `<href>`, a 3D Tiles
// `content.uri`), so both are attackable by whoever wrote the document.
//
// The rule under test, stated as a round trip and not as an implementation:
//
//   The credential is attached IF AND ONLY IF the server the request will be
//   sent to is the server the credential belongs to.
//
// "The server the request will be sent to" is not a reading of the url's text.
// It is what the URL parser -- the same parser `fetch` and `XMLHttpRequest`
// resolve through -- says the host is, and for a special scheme that parser
// skips ANY run of `/` and `\` after the colon, strips tabs and newlines from
// anywhere in the url, trims leading and trailing C0 controls and spaces, folds
// case, percent-encoding, IDN and IPv4 spellings together, drops a default port,
// and ignores userinfo. Every row below is a spelling that a pattern over the
// text reads differently from the parser that will fetch it.
//
// Ground truth is taken from the platform, never from the engine: each row
// carries the host `new URL(sent, document)` answers, hand-authored, and the
// spec asserts it against the platform before it asks the engine anything. No
// row names either document's own host, because the one url shape whose
// destination genuinely cannot be settled without a document is an absolute url
// naming the document's own server; that gap is recorded as a DX row, not
// asserted here.

// Two documents differing only in scheme. A url whose destination depends on
// which one it was loaded from -- `https:host/x`, `http:host/x` -- answers a
// different host to each, and a destination that cannot be settled is not the
// endpoint's, so the credential does not travel with it.
const documents = ["http://doc.invalid/page/", "https://doc.invalid/page/"];

// The runner executes this file twice, and a leg that quietly lost its
// `document` would otherwise pass by measuring the same thing twice. The
// decisions under test are deliberately document-independent, so both legs are
// expected to agree -- which is only evidence if each leg proves which one it is.
const hasDocument = typeof document !== "undefined";
const documentBase = "http://localhost:9876/context.html";

const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const RETURN = String.fromCharCode(13);

/** What the platform says a url is addressed to, from each document. */
function destinationOf(url) {
  return documents.map((base) => {
    try {
      return new URL(url, base).host;
    } catch {
      return "<rejected>";
    }
  });
}

// Two urls are addressed to the same server when both documents agree on the
// host, compared the way RFC 3986 section 3.2.2 compares one: case-insensitively
// (the URL parser has already folded the case of every special scheme's host,
// but it preserves it for a scheme it treats as opaque). `""` is a url that
// names no server at all and `"<rejected>"` is one no parser will accept;
// neither is a server, so neither is ever the same server as anything, itself
// included.
function sameDestination(a, b) {
  if (a[0] === "" || a[0] === "<rejected>") {
    return false;
  }
  return (
    a[0].toLowerCase() === b[0].toLowerCase() &&
    a[1].toLowerCase() === b[1].toLowerCase()
  );
}

/** The options `IonResource` hands to `Resource.prototype._makeRequest`. */
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

const ACCESS_TOKEN = "not_really_an_access_token";

function ionResourceFor(endpointUrl) {
  const endpoint = {
    type: "3DTILES",
    url: endpointUrl,
    accessToken: ACCESS_TOKEN,
    attributions: [],
  };
  return new IonResource(endpoint, new Resource({ url: endpointUrl }));
}

// [url, the two hosts it is addressed to, whether the token travels with it]
const endpoints = [
  {
    name: "an endpoint on its own host",
    url: "https://api.cesium.invalid/v1/assets/1/",
    destination: ["api.cesium.invalid", "api.cesium.invalid"],
    rows: [
      // The endpoint's own server, however the url spells it.
      [
        "https://api.cesium.invalid/v1/assets/1/layer.json",
        ["api.cesium.invalid", "api.cesium.invalid"],
        true,
      ],
      [
        "https://API.CESIUM.INVALID/v1/x",
        ["api.cesium.invalid", "api.cesium.invalid"],
        true,
      ],
      [
        "HTTPS://api.cesium.invalid/v1/x",
        ["api.cesium.invalid", "api.cesium.invalid"],
        true,
      ],
      // A default port is the same server as no port at all.
      [
        "https://api.cesium.invalid:443/v1/x",
        ["api.cesium.invalid", "api.cesium.invalid"],
        true,
      ],
      // Userinfo names a credential, not a server, so it does not participate.
      [
        "https://user:pw@api.cesium.invalid/v1/x",
        ["api.cesium.invalid", "api.cesium.invalid"],
        true,
      ],
      // Percent-encoding inside the host is decoded before the host is read.
      [
        "https://api.cesium.%69nvalid/v1/x",
        ["api.cesium.invalid", "api.cesium.invalid"],
        true,
      ],
      // A slash run after the scheme is skipped, so this really is the
      // endpoint's own server and the token belongs on it.
      [
        "https:///api.cesium.invalid/v1/x",
        ["api.cesium.invalid", "api.cesium.invalid"],
        true,
      ],
      // A tab inside the scheme is stripped: `Resource` reads the url as
      // relative, the parser reads it as the endpoint's own host, and the
      // parser is the one that will fetch it.
      [
        `htt${TAB}ps://api.cesium.invalid/v1/x`,
        ["api.cesium.invalid", "api.cesium.invalid"],
        true,
      ],

      // Another port is another server.
      [
        "https://api.cesium.invalid:8443/v1/x",
        ["api.cesium.invalid:8443", "api.cesium.invalid:8443"],
        false,
      ],
      // A host an attacker can register that ends with the endpoint's.
      [
        "https://evilapi.cesium.invalid/x",
        ["evilapi.cesium.invalid", "evilapi.cesium.invalid"],
        false,
      ],
      // ... and one that begins with it.
      [
        "https://api.cesium.invalid.evil.invalid/x",
        ["api.cesium.invalid.evil.invalid", "api.cesium.invalid.evil.invalid"],
        false,
      ],
      // ... and one that contains it with the endpoint's name as userinfo.
      [
        "https://api.cesium.invalid@evil.invalid/x",
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      // A trailing dot is a different host to the URL Standard.
      [
        "https://api.cesium.invalid./x",
        ["api.cesium.invalid.", "api.cesium.invalid."],
        false,
      ],
      // The endpoint's name after a fragment or a query is not the host.
      [
        "https://evil.invalid#@api.cesium.invalid",
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      [
        "https://evil.invalid?@api.cesium.invalid",
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      // Slash runs, backslashes and a bare scheme all reach a server that no
      // `//` in the text announces.
      ["https:///evil.invalid/x", ["evil.invalid", "evil.invalid"], false],
      ["https://///evil.invalid/x", ["evil.invalid", "evil.invalid"], false],
      [
        `https:/${BACKSLASH}evil.invalid/x`,
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      [
        `https:${BACKSLASH}${BACKSLASH}evil.invalid/x`,
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      // Whether this one is absolute depends on the scheme of the page it was
      // loaded from, so its destination is not settled and it gets nothing.
      ["https:evil.invalid/x", ["evil.invalid", "doc.invalid"], false],
      // ... and the same shape naming the endpoint's OWN host, which is the
      // only spelling that says the ambiguity is still visible: a check that
      // asked two pages of one scheme would read both of these as settled on
      // the endpoint's server and hand them the token.
      [
        "https:api.cesium.invalid/x",
        ["api.cesium.invalid", "doc.invalid"],
        false,
      ],
      [
        "http:api.cesium.invalid/x",
        ["doc.invalid", "api.cesium.invalid"],
        false,
      ],
      // Scheme-relative, in every spelling the parser accepts.
      ["//evil.invalid/x", ["evil.invalid", "evil.invalid"], false],
      ["///evil.invalid/x", ["evil.invalid", "evil.invalid"], false],
      [
        `${BACKSLASH}${BACKSLASH}evil.invalid/x`,
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      [`/${BACKSLASH}evil.invalid/x`, ["evil.invalid", "evil.invalid"], false],
      // A tab inside the host, and a newline before an `@`.
      [
        `https://api.cesium.invalid${TAB}.evil.invalid/x`,
        ["api.cesium.invalid.evil.invalid", "api.cesium.invalid.evil.invalid"],
        false,
      ],
      [
        `https://api.cesium.invalid${NEWLINE}@evil.invalid/x`,
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      // Leading and trailing spaces and C0 controls are trimmed away.
      ["  https://evil.invalid/x  ", ["evil.invalid", "evil.invalid"], false],
      [
        `${RETURN}${NEWLINE}https://evil.invalid/x`,
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      // A scheme of its own that names a server, and schemes that name none.
      [
        "custom-scheme://evil.invalid/x",
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      ["file:///C:/x.txt", ["", ""], false],
      ["mailto:a@b.com", ["", ""], false],
      ["data:text/plain,hi", ["", ""], false],
      ["urn:isbn:1", ["", ""], false],
      // A url no parser will accept is a url no request will reach.
      ["https://[bad", ["<rejected>", "<rejected>"], false],
    ],
  },
  {
    // The configuration this lane exists to make constructible, and the one the
    // text-reading check was wrong about: a self-hosted or proxied endpoint,
    // whose url is relative and whose authority is therefore empty.
    name: "a self-hosted endpoint whose url is relative",
    url: "Data/ion/assets/1/",
    destination: ["doc.invalid", "doc.invalid"],
    rows: [
      ["layer.json", ["doc.invalid", "doc.invalid"], true],
      ["Data/ion/assets/1/layer.json", ["doc.invalid", "doc.invalid"], true],
      ["/root/layer.json", ["doc.invalid", "doc.invalid"], true],
      ["", ["doc.invalid", "doc.invalid"], true],
      // Every shape whose empty text authority used to match the endpoint's.
      ["https:///evil.invalid/x", ["evil.invalid", "evil.invalid"], false],
      ["https://///evil.invalid/x", ["evil.invalid", "evil.invalid"], false],
      [
        `https:/${BACKSLASH}evil.invalid/x`,
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      [
        `https:${BACKSLASH}${BACKSLASH}evil.invalid/x`,
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      ["https:evil.invalid/x", ["evil.invalid", "doc.invalid"], false],
      // A url with no scheme at all still reaches a server of its own when the
      // page it was loaded from has a special scheme, which every page has.
      ["//evil.invalid/x", ["evil.invalid", "evil.invalid"], false],
      ["///evil.invalid/x", ["evil.invalid", "evil.invalid"], false],
      [
        `${BACKSLASH}${BACKSLASH}evil.invalid/x`,
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      [`/${BACKSLASH}evil.invalid/x`, ["evil.invalid", "evil.invalid"], false],
      // Absolute under one document's scheme, relative under the other's.
      ["http:evil.invalid/x", ["doc.invalid", "evil.invalid"], false],
      [
        "https://api.cesium.invalid/v1/x",
        ["api.cesium.invalid", "api.cesium.invalid"],
        false,
      ],
      [
        "custom-scheme://evil.invalid/x",
        ["evil.invalid", "evil.invalid"],
        false,
      ],
      ["file:///C:/x.txt", ["", ""], false],
      ["data:text/plain,hi", ["", ""], false],
      // A url no parser accepts is not "the same nowhere" as a relative one.
      ["https://[bad", ["<rejected>", "<rejected>"], false],
    ],
  },
  {
    // A desktop host serving its tiles over a registered application scheme.
    // The URL Standard leaves such a host opaque, so the parser hands back the
    // case the url was written in and the comparison has to fold it itself.
    name: "an endpoint served over an application scheme",
    url: "app://Tiles.Internal/v1/",
    destination: ["Tiles.Internal", "Tiles.Internal"],
    rows: [
      ["app://TILES.internal/v1/x", ["TILES.internal", "TILES.internal"], true],
      ["app://evil.internal/x", ["evil.internal", "evil.internal"], false],
      ["app:opaque/thing", ["", ""], false],
    ],
  },
  {
    // An application scheme's host is an opaque string the embedder resolves,
    // not a domain the URL Standard folds: the parser does NOT read
    // `3232235777` here as the address `192.168.1.1`, and neither may the
    // check. Folding a host the platform left alone would invent an
    // equivalence between two servers only the embedder can tell apart.
    name: "an endpoint whose application-scheme host looks like an address",
    url: "app://192.168.1.1/v1/",
    destination: ["192.168.1.1", "192.168.1.1"],
    rows: [
      ["app://192.168.1.1/v1/x", ["192.168.1.1", "192.168.1.1"], true],
      ["app://3232235777/x", ["3232235777", "3232235777"], false],
      ["app://0xC0A80101/x", ["0xC0A80101", "0xC0A80101"], false],
    ],
  },
  {
    // A misconfigured endpoint whose url no parser will accept names no server,
    // and neither does an opaque url -- but they are not therefore each other.
    name: "an endpoint url the URL parser rejects",
    url: "https://[bad",
    destination: ["<rejected>", "<rejected>"],
    rows: [
      ["https://[bad", ["<rejected>", "<rejected>"], false],
      ["mailto:a@b.com", ["", ""], false],
      ["layer.json", ["doc.invalid", "doc.invalid"], false],
      [
        "https://api.cesium.invalid/v1/x",
        ["api.cesium.invalid", "api.cesium.invalid"],
        false,
      ],
    ],
  },
  {
    name: "an endpoint url that names no server",
    url: "mailto:endpoint@example.invalid",
    destination: ["", ""],
    rows: [
      ["mailto:a@b.com", ["", ""], false],
      ["data:text/plain,hi", ["", ""], false],
      ["mailto:endpoint@example.invalid", ["", ""], false],
      ["layer.json", ["doc.invalid", "doc.invalid"], false],
    ],
  },
  {
    // One host, two spellings, and a Latin homograph of it.
    name: "an endpoint whose host is an internationalised name",
    url: "https://\u0430\u0440\u0456.cesium.invalid/v1/",
    destination: ["xn--80a6a1d.cesium.invalid", "xn--80a6a1d.cesium.invalid"],
    rows: [
      [
        "https://\u0430\u0440\u0456.cesium.invalid/v1/x",
        ["xn--80a6a1d.cesium.invalid", "xn--80a6a1d.cesium.invalid"],
        true,
      ],
      [
        "https://xn--80a6a1d.cesium.invalid/v1/x",
        ["xn--80a6a1d.cesium.invalid", "xn--80a6a1d.cesium.invalid"],
        true,
      ],
      [
        "https://api.cesium.invalid/v1/x",
        ["api.cesium.invalid", "api.cesium.invalid"],
        false,
      ],
    ],
  },
  {
    // The same address written four ways, and its neighbour.
    name: "an endpoint addressed by IPv4 literal",
    url: "https://192.168.1.1/v1/",
    destination: ["192.168.1.1", "192.168.1.1"],
    rows: [
      ["https://192.168.1.1/v1/x", ["192.168.1.1", "192.168.1.1"], true],
      ["https://3232235777/x", ["192.168.1.1", "192.168.1.1"], true],
      ["https://0xC0A80101/x", ["192.168.1.1", "192.168.1.1"], true],
      ["https://0300.0250.0001.0001/x", ["192.168.1.1", "192.168.1.1"], true],
      ["https://192.168.1.2/x", ["192.168.1.2", "192.168.1.2"], false],
    ],
  },
  {
    name: "an endpoint addressed by IPv6 literal",
    url: "https://[2001:DB8::1]/v1/",
    destination: ["[2001:db8::1]", "[2001:db8::1]"],
    rows: [
      [
        "https://[2001:db8:0:0:0:0:0:1]/x",
        ["[2001:db8::1]", "[2001:db8::1]"],
        true,
      ],
      ["https://[2001:DB8::1]:443/x", ["[2001:db8::1]", "[2001:db8::1]"], true],
      ["https://[2001:db8::2]/x", ["[2001:db8::2]", "[2001:db8::2]"], false],
      [
        "https://[2001:db8::1]:8443/x",
        ["[2001:db8::1]:8443", "[2001:db8::1]:8443"],
        false,
      ],
    ],
  },
];

// Before the engine is asked anything: the table's own two columns have to be
// consistent with the rule, or a row could assert a leak and call it correct.
test("the ion attack table states the rule it is testing", () => {
  for (const endpoint of endpoints) {
    assert.deepEqual(
      destinationOf(endpoint.url),
      endpoint.destination,
      `endpoint ${endpoint.url}`,
    );
    for (const [url, destination, attached] of endpoint.rows) {
      assert.deepEqual(
        destinationOf(url),
        destination,
        `${endpoint.name}: ${JSON.stringify(url)}`,
      );
      assert.equal(
        attached,
        sameDestination(destination, endpoint.destination),
        `${endpoint.name}: ${JSON.stringify(url)} — the row's "attached" column disagrees with its destination`,
      );
      // No row may name a document's own host: an absolute url that does is
      // the one shape whose destination cannot be settled without a document,
      // and it is recorded as a DX row rather than asserted here.
      assert.equal(
        url.includes("doc.invalid"),
        false,
        `${endpoint.name}: ${JSON.stringify(url)} names a document host`,
      );
    }
  }
});

test("the ion access token travels only to the endpoint's own server", () => {
  for (const endpoint of endpoints) {
    for (const [url, , attached] of endpoint.rows) {
      const resource = ionResourceFor(endpoint.url);
      resource.url = url;

      const sent = requestOptionsFor(resource).headers?.Authorization;
      assert.equal(
        sent,
        attached ? `Bearer ${ACCESS_TOKEN}` : undefined,
        `${endpoint.name}: ${JSON.stringify(url)} — the url the request carries is ${JSON.stringify(resource.url)}`,
      );
    }
  }
});

// The table sets the url on the resource directly, which is the narrowest way
// to reach the comparison. A tile url arrives by derivation instead, so the
// same attack is replayed through the path a document actually takes.
test("a derived ion resource does not launder an attacker's host past the check", () => {
  const attacks = [
    "https:///evil.invalid/x",
    `https:${BACKSLASH}${BACKSLASH}evil.invalid/x`,
    "https:evil.invalid/x",
    "//evil.invalid/x",
    "https://evilapi.cesium.invalid/x",
  ];

  for (const endpointUrl of [
    "https://api.cesium.invalid/v1/assets/1/",
    "Data/ion/assets/1/",
  ]) {
    for (const url of attacks) {
      const derived = ionResourceFor(endpointUrl).getDerivedResource({ url });
      assert.equal(
        requestOptionsFor(derived).headers?.Authorization,
        undefined,
        `endpoint ${endpointUrl} derived ${JSON.stringify(url)} → ${JSON.stringify(derived.url)}`,
      );
    }
  }

  // ... and the derivation a real deployment makes still gets its token.
  const layer = ionResourceFor(
    "https://api.cesium.invalid/v1/assets/1/",
  ).getDerivedResource({ url: "layer.json" });
  assert.equal(
    requestOptionsFor(layer).headers.Authorization,
    `Bearer ${ACCESS_TOKEN}`,
  );
});

// ---------------------------------------------------------------------------
// The axis two special schemes cannot see.
//
// Both documents above are loaded over a scheme the URL Standard calls
// SPECIAL. Under a special scheme the parser folds `\` into an authority
// separator and skips any run of `/` and `\` where an authority may begin;
// under a scheme it leaves opaque it does neither. So one url can be addressed
// to the endpoint's own server from every special page and somewhere else
// entirely from the page a desktop host serves over its own registered scheme
// -- and a check that only ever asks special pages never sees the second
// reading, so the token follows the first.
//
// A url whose server depends on what KIND of page it came from has no settled
// server, and an unsettled server gets nothing.

const opaquePage = "app-scheme://doc.invalid/page/";

/** What the platform says a url is addressed to, from a page of each kind. */
function readingsOf(url) {
  return [...documents, opaquePage].map((base) => {
    try {
      return new URL(url, base).host;
    } catch {
      return "<rejected>";
    }
  });
}

/**
 * The server an opaque scheme's host names, spelled the way a special scheme
 * spells it. Two hosts are one server when this agrees. It is the platform's
 * own answer, asked of the platform, not a rule this file invents.
 */
function asOneServer(host) {
  try {
    return new URL(`https://${host}/`).host;
  } catch {
    return "<not a server>";
  }
}

// [url, the host a special page reads, the host an opaque-scheme page reads]
const pageKindSensitive = [
  // A backslash ends the authority for a special scheme; for an opaque one it
  // is an ordinary userinfo character, so the `@` after it is what ends it.
  [
    `//api.cesium.invalid${BACKSLASH}@evil.invalid/x`,
    "api.cesium.invalid",
    "evil.invalid",
  ],
  [
    `//api.cesium.invalid${BACKSLASH}@evil.invalid/v1/assets/1/layer.json`,
    "api.cesium.invalid",
    "evil.invalid",
  ],
  // Without the `@` the backslash lands inside the host, which an opaque
  // scheme forbids outright.
  [
    `//api.cesium.invalid${BACKSLASH}evil.invalid/x`,
    "api.cesium.invalid",
    "<rejected>",
  ],
  // A special scheme skips the whole slash run and finds a host behind it; an
  // opaque one reads an empty authority and a path.
  ["///api.cesium.invalid/x", "api.cesium.invalid", ""],
  // Backslashes before the host are separators to a special scheme and
  // ordinary path characters to an opaque one, which leaves the page's own
  // server named instead.
  [
    `${BACKSLASH}${BACKSLASH}api.cesium.invalid/x`,
    "api.cesium.invalid",
    "doc.invalid",
  ],
  [`/${BACKSLASH}api.cesium.invalid/x`, "api.cesium.invalid", "doc.invalid"],
];

test("the page-kind table states the disagreement it is testing", () => {
  for (const [url, special, opaque] of pageKindSensitive) {
    assert.deepEqual(
      readingsOf(url),
      [special, special, opaque],
      `${JSON.stringify(url)}`,
    );
    // The point of every row: the two readings are not one server written two
    // ways, they are two different answers to "where does this go?".
    assert.notEqual(
      asOneServer(opaque),
      special,
      `${JSON.stringify(url)} — the row claims a disagreement it does not have`,
    );
  }
});

test("a url that different kinds of page address differently carries no token", () => {
  for (const endpointUrl of [
    "https://api.cesium.invalid/v1/assets/1/",
    "//api.cesium.invalid/v1/assets/1/",
  ]) {
    for (const [url] of pageKindSensitive) {
      const resource = ionResourceFor(endpointUrl);
      resource.url = url;
      assert.equal(
        requestOptionsFor(resource).headers?.Authorization,
        undefined,
        `endpoint ${endpointUrl} url ${JSON.stringify(url)}`,
      );
    }
  }
});

// Asking a page of the other kind has to cost nothing, and it is not free by
// default: an opaque scheme takes its host verbatim, so one server is spelled
// one way from an `https` page and another from an application-scheme page --
// an IDN label left unfolded, a decimal IPv4 literal left unfolded, a
// percent-encoded label left undecoded, the case kept. Those are spellings of
// ONE server, not a disagreement about which server, and an endpoint that names
// its host without a scheme keeps its token however its own urls spell it.
//
// [url, the host a special page reads, the host an opaque-scheme page reads,
//  whether the token travels with it]
const hostSpellingEndpoints = [
  {
    name: "an endpoint named without a scheme",
    url: "//api.cesium.invalid/v1/assets/1/",
    host: "api.cesium.invalid",
    rows: [
      [
        "//api.cesium.invalid/v1/x",
        "api.cesium.invalid",
        "api.cesium.invalid",
        true,
      ],
      [
        "//API.CESIUM.INVALID/v1/x",
        "api.cesium.invalid",
        "API.CESIUM.INVALID",
        true,
      ],
      [
        "//api.cesium.inval%69d/v1/x",
        "api.cesium.invalid",
        "api.cesium.inval%69d",
        true,
      ],
      // The endpoint's host under a scheme of the url's own. Whether that is
      // the endpoint's scheme depends on the page (it is from an `https`
      // page, not from an `http` or an application-scheme one), so it is not
      // settled and carries nothing.
      [
        "https://api.cesium.invalid/v1/x",
        "api.cesium.invalid",
        "api.cesium.invalid",
        false,
      ],
      // Another port is another server, whoever is reading.
      [
        "//api.cesium.invalid:8443/v1/x",
        "api.cesium.invalid:8443",
        "api.cesium.invalid:8443",
        false,
      ],
      ["//evil.invalid/x", "evil.invalid", "evil.invalid", false],
    ],
  },
  {
    name: "an endpoint addressed by IPv4 literal without a scheme",
    url: "//192.168.1.1/v1/assets/1/",
    host: "192.168.1.1",
    rows: [
      ["//192.168.1.1/v1/x", "192.168.1.1", "192.168.1.1", true],
      ["//3232235777/v1/x", "192.168.1.1", "3232235777", true],
      ["//0xC0A80101/v1/x", "192.168.1.1", "0xC0A80101", true],
      ["//192.168.1.2/x", "192.168.1.2", "192.168.1.2", false],
    ],
  },
  {
    name: "an endpoint whose internationalised host is named without a scheme",
    url: "//арі.cesium.invalid/v1/assets/1/",
    host: "xn--80a6a1d.cesium.invalid",
    rows: [
      [
        "//арі.cesium.invalid/v1/x",
        "xn--80a6a1d.cesium.invalid",
        "%D0%B0%D1%80%D1%96.cesium.invalid",
        true,
      ],
      [
        "//xn--80a6a1d.cesium.invalid/v1/x",
        "xn--80a6a1d.cesium.invalid",
        "xn--80a6a1d.cesium.invalid",
        true,
      ],
      [
        "//api.cesium.invalid/x",
        "api.cesium.invalid",
        "api.cesium.invalid",
        false,
      ],
    ],
  },
];

test("the host-spelling table states the rule it is testing", () => {
  for (const endpoint of hostSpellingEndpoints) {
    const endpointReadings = readingsOf(endpoint.url);
    assert.deepEqual(
      [endpointReadings[0], endpointReadings[1]],
      [endpoint.host, endpoint.host],
      `endpoint ${endpoint.url}`,
    );
    assert.equal(
      asOneServer(endpointReadings[2]),
      endpoint.host,
      `endpoint ${endpoint.url} — an opaque-scheme page reads another server`,
    );

    for (const [url, special, opaque, attached] of endpoint.rows) {
      assert.deepEqual(
        readingsOf(url),
        [special, special, opaque],
        `${endpoint.name}: ${JSON.stringify(url)}`,
      );
      // Every row here is one server under two spellings: that is what makes
      // the row a cost and not a disagreement.
      assert.equal(
        asOneServer(opaque),
        special,
        `${endpoint.name}: ${JSON.stringify(url)} — not one server after all`,
      );
      // Like the endpoint, the url must take the page's scheme: each kind of
      // page then reads it under its own, as it reads the endpoint.
      const inheritsScheme = [...documents, opaquePage].every(
        (base) => new URL(url, base).protocol === new URL(base).protocol,
      );
      assert.equal(
        attached,
        inheritsScheme && special === endpoint.host,
        `${endpoint.name}: ${JSON.stringify(url)} — the row's "attached" column disagrees with its scheme and host`,
      );
    }
  }
});

test("an endpoint named without a scheme keeps its token across host spellings", () => {
  for (const endpoint of hostSpellingEndpoints) {
    for (const [url, , , attached] of endpoint.rows) {
      const resource = ionResourceFor(endpoint.url);
      resource.url = url;
      assert.equal(
        requestOptionsFor(resource).headers?.Authorization,
        attached ? `Bearer ${ACCESS_TOKEN}` : undefined,
        `${endpoint.name}: ${JSON.stringify(url)}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The second credential: a parent resource's headers and query parameters.
// `Resource.getDerivedResource` drops them when the derived url names a server
// that is not the parent's. `URL.origin` cannot decide that: Node serialises
// it as the literal string "null" for every scheme the URL Standard does not
// treat as special -- including one that names a server -- and Chromium
// serialises every `file:` url's as "file://", host or no host. So the
// comparison is of the scheme and the host, which both engines serialise
// alike, and a url that names no server is known by its scheme alone.

const PARENT = "https://parent.invalid/a/tileset.json";
const PARENT_ORIGIN = "https://parent.invalid";
const PARENT_HEADER = "Bearer parent-secret";

// [derived url, the origin it is addressed to (null = it names no server, and
//  is known by its scheme alone), whether the parent's credentials go with it]
const derivations = [
  ["content.b3dm", PARENT_ORIGIN, true],
  ["https://parent.invalid/a/other.b3dm", PARENT_ORIGIN, true],
  ["https://evil.invalid/x", "https://evil.invalid", false],
  ["//evil.invalid/x", "https://evil.invalid", false],
  ["https:///evil.invalid/x", "https://evil.invalid", false],
  [
    `https:${BACKSLASH}${BACKSLASH}evil.invalid/x`,
    "https://evil.invalid",
    false,
  ],
  ["blob:https://evil.invalid/uuid", "https://evil.invalid", false],
  // Opaque origin, but a server is named all the same.
  ["custom-scheme://evil.invalid/x", "custom-scheme://evil.invalid", false],
  ["file://evil.invalid/share/x", "file://evil.invalid", false],
  // No server named: a url that is not the parent's server either. None of
  // these is fetched with request headers at all (`data:` and `file:` never
  // carry them), so the drop costs nothing and keeps the rule one rule.
  ["custom-scheme:opaque/thing", null, false],
  ["mailto:a@b.com", null, false],
  ["file:///C:/x.txt", null, false],
  ["data:text/plain,hi", null, false],
];

function parentResource() {
  return new Resource({
    url: PARENT,
    headers: { Authorization: PARENT_HEADER },
  });
}

test("the derived-credential table states the rule it is testing", () => {
  assert.equal(new URL(PARENT).origin, PARENT_ORIGIN);

  for (const [url, origin, forwarded] of derivations) {
    const parsed = new URL(url, PARENT);
    if (origin === null) {
      assert.equal(parsed.origin, "null", `${url} origin`);
      assert.equal(parsed.host, "", `${url} host`);
    } else if (parsed.origin === "null") {
      // A scheme the URL Standard leaves opaque, but with a server in it.
      assert.equal(
        `${parsed.protocol}//${parsed.host}`,
        origin,
        `${url} opaque origin`,
      );
    } else {
      assert.equal(parsed.origin, origin, `${url} origin`);
    }

    assert.equal(
      forwarded,
      origin === PARENT_ORIGIN,
      `${url} — the row's "forwarded" column disagrees with its origin`,
    );
  }
});

test("a parent's credentials travel only to the parent's own server", () => {
  for (const [url, , forwarded] of derivations) {
    const derived = parentResource().getDerivedResource({ url });
    assert.equal(
      derived.headers?.Authorization,
      forwarded ? PARENT_HEADER : undefined,
      `derived ${JSON.stringify(url)} → ${JSON.stringify(derived._url)}`,
    );
  }
});

// Every row in the table above is separated from `https://parent.invalid` by
// its SCHEME as well as its host, so not one of them can tell whether the
// comparison reads the host at all. Take the host out of the opaque-origin
// arm and the whole table stays green while a parent's Authorization header
// travels to any other host under the same scheme. These rows can tell: the
// parent's own origin is the literal string "null", and each derived url
// differs from it in the host alone.
//
// [parent url, derived url, whether the parent's credentials go with it]
const opaqueParentDerivations = [
  // An application scheme a desktop host registers. The URL Standard leaves
  // its host opaque, so the parser hands back the case it was written in and
  // the comparison is the one that has to fold it.
  [
    "custom-scheme://parent.invalid/a/tileset.json",
    "other.b3dm",
    "custom-scheme://parent.invalid/a/other.b3dm",
    true,
  ],
  [
    "custom-scheme://parent.invalid/a/tileset.json",
    "custom-scheme://parent.invalid/a/other.b3dm",
    "custom-scheme://parent.invalid/a/other.b3dm",
    true,
  ],
  [
    "custom-scheme://parent.invalid/a/tileset.json",
    "custom-scheme://PARENT.INVALID/a/other.b3dm",
    "custom-scheme://PARENT.INVALID/a/other.b3dm",
    true,
  ],
  [
    "custom-scheme://parent.invalid/a/tileset.json",
    "custom-scheme://evil.invalid/x",
    "custom-scheme://evil.invalid/x",
    false,
  ],
  // Another scheme entirely is another server too, opaque origin or not.
  [
    "custom-scheme://parent.invalid/a/tileset.json",
    "https://evil.invalid/x",
    "https://evil.invalid/x",
    false,
  ],
  // `file://host/share/…` is a Windows UNC share, which is how a `file:` url
  // names a server. `file:` is special, so the parser folds this host's case
  // itself and the two spellings are already one host by the time the
  // comparison sees them.
  [
    "file://parent.invalid/share/tileset.json",
    "other.b3dm",
    "file://parent.invalid/share/other.b3dm",
    true,
  ],
  [
    "file://parent.invalid/share/tileset.json",
    "file://PARENT.INVALID/share/other.b3dm",
    "file://PARENT.INVALID/share/other.b3dm",
    true,
  ],
  [
    "file://parent.invalid/share/tileset.json",
    "file://evil.invalid/share/x",
    "file://evil.invalid/share/x",
    false,
  ],
  // A scheme is half of a server, and two application schemes that share a
  // host name are two servers -- the embedder hands each one its own protocol
  // handler. These rows differ from their parent on the scheme ALONE, which is
  // what makes the scheme half of the key decide something (Beldis, W2-L11
  // round four, F3).
  [
    "custom-scheme://parent.invalid/a/tileset.json",
    "file://parent.invalid/share/x",
    "file://parent.invalid/share/x",
    false,
  ],
  [
    "custom-scheme://parent.invalid/a/tileset.json",
    "other-scheme://parent.invalid/x",
    "other-scheme://parent.invalid/x",
    false,
  ],
  [
    "file://parent.invalid/share/tileset.json",
    "custom-scheme://parent.invalid/x",
    "custom-scheme://parent.invalid/x",
    false,
  ],
  // A parent that names no server is known by its scheme alone: another url
  // of that scheme that names none is its own, and a url that names a server
  // is not. Round five pinned the second row as forwarded ("nothing to
  // compare"); that was Node's reading only -- Chromium's origin compared it
  // as "file://" against "file://" and forwarded it, and compared the third
  // as "file://" against "https://evil.invalid" and DROPPED it -- so it is
  // decided here once, the same way in both, and closed.
  [
    "file:///C:/a/tileset.json",
    "file:///C:/a/other.b3dm",
    "file:///C:/a/other.b3dm",
    true,
  ],
  [
    "file:///C:/a/tileset.json",
    "file://evil.invalid/share/x",
    "file://evil.invalid/share/x",
    false,
  ],
  [
    "file:///C:/a/tileset.json",
    "https://evil.invalid/x",
    "https://evil.invalid/x",
    false,
  ],
];

test("the opaque-parent table states the rule it is testing", () => {
  for (const [parentUrl, url, resolved, forwarded] of opaqueParentDerivations) {
    const parsedParent = new URL(parentUrl);
    const parsedDerived = new URL(url, parentUrl);
    // The premise of every row: the parent is a url `URL.origin` calls "null".
    assert.equal(parsedParent.origin, "null", `${parentUrl} origin`);
    assert.equal(
      parsedDerived.href,
      new URL(resolved).href,
      `${parentUrl} + ${url}`,
    );
    assert.equal(
      forwarded,
      parsedParent.protocol === parsedDerived.protocol &&
        parsedParent.host.toLowerCase() === parsedDerived.host.toLowerCase(),
      `${parentUrl} + ${url} — the row's "forwarded" column disagrees with its scheme and host`,
    );
  }
});

test("a parent whose own origin is opaque keeps its credentials to its own server", () => {
  for (const [parentUrl, url, , forwarded] of opaqueParentDerivations) {
    const derived = new Resource({
      url: parentUrl,
      headers: { Authorization: PARENT_HEADER },
    }).getDerivedResource({ url });
    assert.equal(
      derived.headers?.Authorization,
      forwarded ? PARENT_HEADER : undefined,
      `parent ${JSON.stringify(parentUrl)} derived ${JSON.stringify(url)} → ${JSON.stringify(derived._url)}`,
    );
  }
});

// A url the URL parser rejects is one no request can be sent to, so it is not
// the parent's server. Reading it as "unknown" forwarded the parent's
// credentials, and the engines do not agree on which urls those are: Chromium
// rejects `custom-scheme://` with a non-ASCII host that Node percent-encodes,
// so the same derivation forwarded in one engine and dropped in the other.
// These rows are rejected by both.
const unfetchableDerivations = [
  "https://parent.invalid:99999/x",
  "https://parent.invalid:-1/x",
  "http://parent%zzinvalid/x",
];

test("the unfetchable table states the rule it is testing", () => {
  for (const url of unfetchableDerivations) {
    assert.throws(() => new URL(url), TypeError, url);
    assert.throws(() => new URL(url, PARENT), TypeError, url);
  }
});

test("a url no parser accepts takes none of its parent's credentials", () => {
  for (const url of unfetchableDerivations) {
    const derived = parentResource().getDerivedResource({ url });
    assert.equal(
      derived.headers?.Authorization,
      undefined,
      `derived ${JSON.stringify(url)} → ${JSON.stringify(derived._url)}`,
    );
  }
});

// Chromium serialises `URL.origin` differently from Node -- "file://" for
// every `file:` url -- and the decision must not move with it. Node cannot
// produce that serialisation, so this reproduces it: `origin` is made to
// answer the way Chromium does, and both tables above are replayed. A check
// that read `origin` would forward `file://parent.invalid/share/…`'s header to
// `file://evil.invalid/share/x` here, exactly as it did in Chromium.
function withChromiumFileOrigin(run) {
  const descriptor = Object.getOwnPropertyDescriptor(URL.prototype, "origin");
  Object.defineProperty(URL.prototype, "origin", {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      return this.protocol === "file:" ? "file://" : descriptor.get.call(this);
    },
  });
  try {
    run();
  } finally {
    Object.defineProperty(URL.prototype, "origin", descriptor);
  }
}

test("a parent's credentials are decided the same way under Chromium's origin serialisation", () => {
  withChromiumFileOrigin(() => {
    assert.equal(new URL("file://parent.invalid/share/x").origin, "file://");
    for (const [parentUrl, url, , forwarded] of opaqueParentDerivations) {
      const derived = new Resource({
        url: parentUrl,
        headers: { Authorization: PARENT_HEADER },
      }).getDerivedResource({ url });
      assert.equal(
        derived.headers?.Authorization,
        forwarded ? PARENT_HEADER : undefined,
        `parent ${JSON.stringify(parentUrl)} derived ${JSON.stringify(url)}`,
      );
    }
    for (const [url, , forwarded] of derivations) {
      const derived = parentResource().getDerivedResource({ url });
      assert.equal(
        derived.headers?.Authorization,
        forwarded ? PARENT_HEADER : undefined,
        `derived ${JSON.stringify(url)}`,
      );
    }
  });
  assert.equal(new URL("file://parent.invalid/share/x").origin, "null");
});

// ---------------------------------------------------------------------------
// The scheme is half of "which server" for the ion token too. Chromium on
// Windows reads a url that begins with two backslashes as a UNC path whatever
// the page -- `\\api.cesium.invalid/x` is `file://api.cesium.invalid/x` there
// -- so a host-only comparison sent the token to a `file:` share in Chromium
// and not in Node. The `file:` rows below are that destination written out, so
// the decision is pinned in Node as well.
//
// [endpoint url, url, whether the token travels with it]
const schemeRows = [
  [
    "https://api.cesium.invalid/v1/assets/1/",
    "https://api.cesium.invalid/v1/x",
    true,
  ],
  [
    "https://api.cesium.invalid/v1/assets/1/",
    "HTTPS://api.cesium.invalid:443/v1/x",
    true,
  ],
  [
    "https://api.cesium.invalid/v1/assets/1/",
    "file://api.cesium.invalid/v1/x",
    false,
  ],
  [
    "https://api.cesium.invalid/v1/assets/1/",
    "http://api.cesium.invalid/v1/x",
    false,
  ],
  [
    "https://api.cesium.invalid/v1/assets/1/",
    "wss://api.cesium.invalid/v1/x",
    false,
  ],
  [
    "https://api.cesium.invalid/v1/assets/1/",
    "custom-scheme://api.cesium.invalid/v1/x",
    false,
  ],
  // A url that takes the page's scheme beside an endpoint that names its own:
  // the same scheme only from an `https` page.
  [
    "https://api.cesium.invalid/v1/assets/1/",
    "//api.cesium.invalid/v1/x",
    false,
  ],
  [
    "//api.cesium.invalid/v1/assets/1/",
    "https://api.cesium.invalid/v1/x",
    false,
  ],
  ["//api.cesium.invalid/v1/assets/1/", "//api.cesium.invalid/v1/x", true],
  [
    "http://api.cesium.invalid/v1/assets/1/",
    "http://api.cesium.invalid/v1/x",
    true,
  ],
  [
    "http://api.cesium.invalid/v1/assets/1/",
    "https://api.cesium.invalid/v1/x",
    false,
  ],
  [
    "file://api.cesium.invalid/v1/assets/1/",
    "file://API.cesium.invalid/v1/x",
    true,
  ],
];

// Ground truth from the platform: from every kind of page, the url and the
// endpoint resolve to one scheme and one server.
test("the scheme table states the rule it is testing", () => {
  for (const [endpointUrl, url, attached] of schemeRows) {
    const same = [...documents, opaquePage].every((base) => {
      const a = new URL(url, base);
      const b = new URL(endpointUrl, base);
      return (
        a.protocol === b.protocol && asOneServer(a.host) === asOneServer(b.host)
      );
    });
    assert.equal(
      attached,
      same,
      `endpoint ${endpointUrl} url ${JSON.stringify(url)} — the row's "attached" column disagrees with its scheme and host`,
    );
  }
});

test("the ion access token travels only under the endpoint's own scheme", () => {
  for (const [endpointUrl, url, attached] of schemeRows) {
    const resource = ionResourceFor(endpointUrl);
    resource.url = url;
    assert.equal(
      requestOptionsFor(resource).headers?.Authorization,
      attached ? `Bearer ${ACCESS_TOKEN}` : undefined,
      `endpoint ${endpointUrl} url ${JSON.stringify(url)}`,
    );
  }
});

// A url that takes the page's scheme, or names no server of its own, is
// settled only up to the page -- and in a browser the page is known. An
// endpoint named `//host/v1/` is fetched as `https://host/v1/` from an `https`
// page, and the urls derived from it reach the check already written that way,
// because `getDerivedResource` resolves against the document. Without reading
// both sides on the document, every tile of such an endpoint -- and of a
// self-hosted relative one -- lost its token in a browser. Each case sets its
// own document and restores whatever was there.
function onDocument(baseURI, run) {
  const saved = globalThis.document;
  globalThis.document = { baseURI, location: { href: baseURI } };
  try {
    run();
  } finally {
    globalThis.document = saved;
  }
}

// [document, endpoint url, how the url is reached, url, whether the token travels]
const pageRows = [
  [
    "https://app.example/page/",
    "//api.cesium.invalid/v1/assets/1/",
    "derived",
    "layer.json",
    true,
  ],
  [
    "http://app.example/page/",
    "//api.cesium.invalid/v1/assets/1/",
    "derived",
    "layer.json",
    true,
  ],
  [
    "https://app.example/page/",
    "//api.cesium.invalid/v1/assets/1/",
    "set",
    "https://api.cesium.invalid/v1/x",
    true,
  ],
  [
    "http://app.example/page/",
    "//api.cesium.invalid/v1/assets/1/",
    "set",
    "https://api.cesium.invalid/v1/x",
    false,
  ],
  [
    "https://app.example/page/",
    "https://api.cesium.invalid/v1/assets/1/",
    "set",
    "//api.cesium.invalid/v1/x",
    true,
  ],
  [
    "http://app.example/page/",
    "https://api.cesium.invalid/v1/assets/1/",
    "set",
    "//api.cesium.invalid/v1/x",
    false,
  ],
  [
    "https://app.example/page/",
    "Data/ion/assets/1/",
    "derived",
    "layer.json",
    true,
  ],
  [
    "https://app.example/page/",
    "Data/ion/assets/1/",
    "set",
    "https://app.example/x",
    true,
  ],
  [
    "https://app.example/page/",
    "Data/ion/assets/1/",
    "set",
    "http://app.example/x",
    false,
  ],
  [
    "https://app.example/page/",
    "Data/ion/assets/1/",
    "set",
    "https://evil.invalid/x",
    false,
  ],
  [
    "https://api.cesium.invalid/page/",
    "https://api.cesium.invalid/v1/assets/1/",
    "set",
    "x",
    true,
  ],
  [
    "https://app.example/page/",
    "https://api.cesium.invalid/v1/assets/1/",
    "set",
    "x",
    false,
  ],
  // The page resolves only what the three probes settled; a url whose reading
  // depends on the kind of page stays unsettled on every page.
  [
    "https://app.example/page/",
    "//api.cesium.invalid/v1/assets/1/",
    "set",
    `//api.cesium.invalid${BACKSLASH}@evil.invalid/x`,
    false,
  ],
];

test("the page table states the rule it is testing", () => {
  for (const [page, endpointUrl, how, url, attached] of pageRows) {
    const endpointOnPage = new URL(endpointUrl, page);
    const fetched =
      how === "derived" ? new URL(url, endpointOnPage) : new URL(url, page);
    // On a special page the backslash row reads as the endpoint's server; the
    // row is false because another kind of page reads it elsewhere.
    const pageKindSensitive = url.includes(BACKSLASH);
    assert.equal(
      attached,
      !pageKindSensitive &&
        fetched.protocol === endpointOnPage.protocol &&
        fetched.host === endpointOnPage.host,
      `${page} ${endpointUrl} ${how} ${JSON.stringify(url)}`,
    );
  }
});

test("an endpoint's token is read on the page the request is made from", () => {
  for (const [page, endpointUrl, how, url, attached] of pageRows) {
    onDocument(page, () => {
      let resource = ionResourceFor(endpointUrl);
      if (how === "derived") {
        resource = resource.getDerivedResource({ url });
      } else {
        resource.url = url;
      }
      assert.equal(
        requestOptionsFor(resource).headers?.Authorization,
        attached ? `Bearer ${ACCESS_TOKEN}` : undefined,
        `page ${page} endpoint ${endpointUrl} ${how} ${JSON.stringify(url)} → ${JSON.stringify(resource.url)}`,
      );
    });
  }
});

// A url that carries a special scheme but no `//` after it is RELATIVE to a
// page of that scheme: `https:parent.invalid/x` from an `https` page is the
// path `/parent.invalid/x` on the page's own server. `getAbsoluteUri` returns a
// scheme-bearing url as written, so the request is resolved by the browser,
// against the page; read with no base, the same text names the parent's server,
// and the parent's Authorization header went to the page's. From a page of
// another scheme the url is absolute and does reach the parent. The page here
// is neither the parent's server nor the endpoint's.
//
// [document, derived url, whether the parent's credentials go with it]
const slashlessRows = [
  ["https://app.example/page/", "https:parent.invalid/x", false],
  ["https://app.example/page/", "HTTPS:/parent.invalid/x", false],
  [
    "https://app.example/page/",
    `https:${BACKSLASH}parent.invalid${BACKSLASH}x`,
    false,
  ],
  // Another scheme's page: the url is absolute and names the parent.
  ["http://app.example/page/", "https:parent.invalid/x", true],
  // The page is on the parent's own server, so the path is the parent's too.
  ["https://parent.invalid/page/", "https:parent.invalid/x", true],
  ["https://app.example/page/", "https://parent.invalid/a/other.b3dm", true],
  ["https://app.example/page/", "content.b3dm", true],
];

test("the slashless-scheme table states the rule it is testing", () => {
  for (const [page, url, forwarded] of slashlessRows) {
    const derived = parentResource().getDerivedResource({ url });
    // What the browser fetches: the derived url, resolved against the page.
    const fetched = new URL(derived.url, page);
    const parent = new URL(PARENT, page);
    assert.equal(
      forwarded,
      fetched.protocol === parent.protocol && fetched.host === parent.host,
      `${page} ${JSON.stringify(url)} → ${fetched.href}`,
    );
  }
});

test("a parent's credentials follow a slashless url to the server the page sends it to", () => {
  for (const [page, url, forwarded] of slashlessRows) {
    onDocument(page, () => {
      const derived = parentResource().getDerivedResource({ url });
      assert.equal(
        derived.headers?.Authorization,
        forwarded ? PARENT_HEADER : undefined,
        `page ${page} derived ${JSON.stringify(url)} → ${JSON.stringify(derived.url)}`,
      );
    });
  }
});

// The environment this file is being run in, asserted rather than assumed.
test("the environment is the one the runner intended", () => {
  assert.equal(typeof document === "undefined", !hasDocument);
  if (hasDocument) {
    assert.equal(globalThis.document.baseURI, documentBase);
  }
});
