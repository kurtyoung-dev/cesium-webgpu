import assert from "node:assert/strict";
import test from "node:test";

import getAbsoluteUri from "../../Source/Core/getAbsoluteUri.js";

// `getAbsoluteUri` answers differently depending on whether a `document`
// exists, so this file is run twice: bare, and under
// `--import ./packages/engine/Specs/browserDocumentPreload.mjs`, which installs
// the `document` karma serves specs with before any engine module loads. Each
// row below carries both answers. A row measured in only one environment is not
// measured: with no document the function returns its argument untouched, which
// hides every rewrite it performs in a browser — the state that left two
// `DataSources/CzmlDataSource` specs red while a Node table read 0 failures.
//
// The environment is in every test name so a transcript says which run produced
// it; two runs that both report [node] are a preload that never loaded.
const environment = typeof document === "undefined" ? "node" : "document";
const hasDocument = environment === "document";
const documentBase = "http://localhost:9876/context.html";

// Every expected string is what upstream CesiumJS returns for the same input,
// measured by running upstream's implementation (`new Uri(relative).toString()`
// when the relative carries a scheme, otherwise
// `new Uri(relative).absoluteTo(base).toString()`) over the real urijs from
// node_modules. None is computed here, so this file can disagree with the
// engine.

// [relative, expected with a document, expected bare]. With no base, bare Node
// returns the argument untouched — upstream's own early return — so the third
// column is omitted wherever it is the argument itself.
const noBase = [
  // A uri that carries its own scheme never consults the base, and its text is
  // the answer: the authority's case is what a CZML `billboard.image` is
  // compared and displayed as.
  ["http://someImage.invalid/", "http://someImage.invalid/"],
  ["http://someImage.invalid/image.png", "http://someImage.invalid/image.png"],
  ["HTTP://Host.Invalid/Path", "HTTP://Host.Invalid/Path"],
  ["http://user:pw@Host.invalid/p", "http://user:pw@Host.invalid/p"],
  ["http://[2001:DB8::1]/p", "http://[2001:DB8::1]/p"],
  ["http://Host:8080/p", "http://Host:8080/p"],
  // Separator runs and dot segments are the caller's; nothing resolves them.
  ["http://h/a//b.js", "http://h/a//b.js"],
  ["http://h/a/./b/../c", "http://h/a/./b/../c"],
  // Schemes the URL Standard does not treat as special. `URL.origin` is the
  // literal string "null" for each of these.
  ["file:///C:/a/b.txt", "file:///C:/a/b.txt"],
  ["mailto:a@b.com", "mailto:a@b.com"],
  ["data:image/png;base64,AAA", "data:image/png;base64,AAA"],
  ["custom-scheme:opaque/Thing", "custom-scheme:opaque/Thing"],
  ["blob:https://Host/uuid", "blob:https://Host/uuid"],
  // An authority with no path of its own serialises with a root path — the one
  // change upstream's `toString()` makes to a scheme-carrying uri, and the
  // reason this is not simply `return relative`.
  ["http://h", "http://h/", "http://h"],
  ["http://h?q=1", "http://h/?q=1", "http://h?q=1"],
  // A protocol-relative uri has no scheme, so it is resolved: it keeps its own
  // authority, as written, and takes the document's scheme.
  ["//Host.Invalid/base/", "http://Host.Invalid/base/", "//Host.Invalid/base/"],
  // Ordinary relatives resolve against the document.
  ["Assets/foo", "http://localhost:9876/Assets/foo", "Assets/foo"],
  ["Data/KML/", "http://localhost:9876/Data/KML/", "Data/KML/"],
];

// [relative, base, expected]. An explicit base is read the same way in both
// environments, so these rows assert one answer in each run.
const withBase = [
  // The base's authority reaches the answer as the base spelled it. This row is
  // CI rows 1-2: `CzmlDataSource` resolves a packet's image exactly this way.
  [
    "image.png",
    "http://someImage.invalid/",
    "http://someImage.invalid/image.png",
  ],
  // ...and so does the base's scheme.
  ["x.js", "HTTP://Host.Invalid/base/", "HTTP://Host.Invalid/base/x.js"],
  [
    "x.js",
    "http://user:pw@Host.invalid/base/",
    "http://user:pw@Host.invalid/base/x.js",
  ],
  ["x.js", "http://[2001:DB8::1]/base/", "http://[2001:DB8::1]/base/x.js"],
  // A base that is itself relative is merged onto, not discarded. `new URL`
  // rejects one outright, and the rejection used to be caught and answered with
  // the relative alone — the base silently gone.
  ["x.js", "Data/KML/", "Data/KML/x.js"],
  ["Level2/doc.kml", "Level1/doc.kml", "Level1/Level2/doc.kml"],
  ["x.js", "//Host.Invalid/base/", "//Host.Invalid/base/x.js"],
  ["x.js", "/abs/base/", "/abs/base/x.js"],
  ["", "Data/KML/", "Data/KML/"],
  ["?q=2", "Data/KML/f.kml", "Data/KML/f.kml?q=2"],
  ["../../../up.js", "a/b/", "up.js"],
  // Merging a relative path onto the base's collapses separator runs; a
  // root-relative path replaces that path outright and keeps them. This is the
  // pair `absoluteTo` drew and `new URL` does not.
  [
    "Workers//transferTypedArrayTest.js",
    "http://test.com/source/",
    "http://test.com/source/Workers/transferTypedArrayTest.js",
  ],
  ["/a//b.js", "http://h/base/", "http://h/a//b.js"],
  ["x.js", "http://h/a//b/", "http://h/a/b/x.js"],
  // A uri that brings its own authority keeps it and takes only the scheme.
  ["//other.Host/x.js", "http://test.com/source/", "http://other.Host/x.js"],
  ["//Host//x.js", "http://h/base/", "http://Host//x.js"],
  [
    "http://Elsewhere.Invalid/y.js",
    "http://test.com/source/",
    "http://Elsewhere.Invalid/y.js",
  ],
  ["x.js", "file:///C:/base/", "file:///C:/base/x.js"],
];

// Where the fork deliberately does not follow upstream. Pinned so the choice is
// visible rather than discovered.
const deliberateDivergences = [
  // A base with a scheme but no authority is opaque: there is no hierarchy to
  // merge onto. urijs invents one (`mailto:///x.js`); the caller's own text
  // invents nothing, and it is what this function already answered when
  // `new URL` threw on the same input.
  ["x.js", "mailto:a@b.com", "x.js"],
  ["x.js", "urn:isbn:0451450523", "x.js"],
  // The two rows above are answered the same way whether the opaque-base early
  // return is reached or the merge below runs, so neither can tell that it was.
  // This one can: an opaque base whose text carries a `/` is merged onto if the
  // branch is skipped, and `x.js` comes back as `text/x.js` — a path built out
  // of half a media type.
  ["x.js", "data:text/plain,hi", "x.js"],
];

test(`[${environment}] a uri with no base`, () => {
  for (const [relative, withDocument, bare] of noBase) {
    assert.equal(
      getAbsoluteUri(relative),
      hasDocument ? withDocument : (bare ?? relative),
      `relative ${relative}`,
    );
  }
});

test(`[${environment}] a uri resolved against an explicit base`, () => {
  for (const [relative, base, expected] of withBase) {
    assert.equal(
      getAbsoluteUri(relative, base),
      expected,
      `relative ${relative} against base ${base}`,
    );
  }
});

test(`[${environment}] a base that cannot be merged onto answers with the relative`, () => {
  for (const [relative, base, expected] of deliberateDivergences) {
    assert.equal(
      getAbsoluteUri(relative, base),
      expected,
      `relative ${relative} against base ${base}`,
    );
  }
});

// The environment itself is the premise every other row rests on, so it is
// asserted rather than assumed. Without this, a run whose preload failed to
// load would quietly take the bare column and report a pass.
test(`[${environment}] the environment is the one the runner intended`, () => {
  assert.equal(typeof document === "undefined", !hasDocument);
  if (hasDocument) {
    assert.equal(globalThis.document.baseURI, documentBase);
    assert.notEqual(getAbsoluteUri("Assets/foo"), "Assets/foo");
  } else {
    assert.equal(getAbsoluteUri("Assets/foo"), "Assets/foo");
  }
});

// `_implementation` takes the document as an argument, which is how the engine
// reaches the browser path from anywhere. The same rows through that door.
test(`[${environment}] the implementation reads the document it is handed`, () => {
  const fakeDocument = { baseURI: "http://Test.Invalid/index.html" };
  assert.equal(
    getAbsoluteUri._implementation("awesome.png", undefined, fakeDocument),
    "http://Test.Invalid/awesome.png",
  );
  assert.equal(
    getAbsoluteUri._implementation(
      "http://someImage.invalid/image.png",
      undefined,
      fakeDocument,
    ),
    "http://someImage.invalid/image.png",
  );
});
