import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import defined from "../../Source/Core/defined.js";
import Resource from "../../Source/Core/Resource.js";

// `KmlDataSource.js` cannot be imported into Node — it reaches the generated
// shader modules through the Scene graph — so the functions under test are
// lifted out of the real source text and evaluated. This is the shipped code,
// not a copy of it: edit the engine and this spec follows. Both consumers are
// lifted too, because a key that no consumer passes to `keys.indexOf` unchanged
// rewrites nothing, and a helper spec alone cannot see that.
const kmlDataSourceUrl = new URL(
  "../../Source/DataSources/KmlDataSource.js",
  import.meta.url,
);

const declarationMarker = "const kmzArchiveOrigin =";
const functionMarkers = [
  "function resolveKmzEntryName(",
  "function embedDataUris(",
  "function resolveHref(",
];

function endOfFunction(source, openBrace) {
  let depth = 0;
  for (let index = openBrace; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error("unterminated function body");
}

function sliceFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `marker not found: ${marker}`);
  return source.slice(
    start,
    endOfFunction(source, source.indexOf("{", start)) + 1,
  );
}

async function loadArchiveFunctions() {
  const source = await readFile(kmlDataSourceUrl, "utf8");
  const declaration = source.indexOf(declarationMarker);
  const firstFunction = source.indexOf(functionMarkers[0], declaration);
  assert.ok(
    declaration >= 0 && firstFunction > declaration,
    "markers not found",
  );
  const body = [
    source.slice(declaration, firstFunction),
    ...functionMarkers.map((marker) => sliceFunction(source, marker)),
  ].join("\n");
  return new Function(
    "defined",
    "Resource",
    `${body}\nreturn { resolveKmzEntryName, embedDataUris, resolveHref };`,
  )(defined, Resource);
}

const { resolveKmzEntryName, embedDataUris, resolveHref } =
  await loadArchiveFunctions();

// A KMZ's entries are keyed by their zip filenames. `Specs/Data/KML/simple.kmz`
// holds "image.png" and "simple.kml"; `multilevel.kmz` holds "doc.kml",
// "Level1/doc.kml" and "Level1/Level2/doc.kml". None of them has a leading
// slash, and the hrefs inside those documents are "Level1/doc.kml" and
// "Level2/doc.kml" respectively.
//
// Every expected string below except two is what upstream CesiumJS produces for
// the same input, measured by running its `new Uri(value).absoluteTo(base)` over
// the real urijs. The two exceptions are authored, each for a stated reason, and
// each marked at its row: the `data:` row, where urijs treats a scheme with no
// `//` as a URN and `absoluteTo` throws "URNs do not have any generally defined
// hierarchical components" (a throw is not an answer a lookup key can use), and
// the root-relative archive row, where upstream re-roots the href and the fork
// leaves it alone — neither spelling can name a zip entry, so the two behave
// identically and the row exists so nobody "fixes" one into the other.

// [href, base, expected key]. A base of undefined is the archive's own root,
// which is what `embedDataUris` resolves a balloon's `src`/`href` against.
const entryNames = [
  ["image.png", undefined, "image.png"],
  ["sub/image.png", undefined, "sub/image.png"],
  ["./image.png", undefined, "image.png"],
  ["a//b.png", undefined, "a/b.png"],
  // Nothing below can name an entry, so each is left exactly as written.
  ["../image.png", undefined, "../image.png"],
  ["/image.png", undefined, "/image.png"],
  ["http://h/image.png", undefined, "http://h/image.png"],
  ["http://Host.Invalid/image.png", undefined, "http://Host.Invalid/image.png"],
  // A protocol-relative href takes its scheme from whatever resolved it, so
  // resolving it inside the archive would hand the lookup a key carrying the
  // synthetic scheme.
  ["//host/x.png", undefined, "//host/x.png"],
  // AUTHORED. urijs reads a scheme with no `//` as a URN, and `absoluteTo`
  // throws "URNs do not have any generally defined hierarchical components" —
  // a throw is not an answer a lookup key can use. The href is left as written,
  // which no zip entry name can match, which is right for a data uri.
  ["data:image/png;base64,AAA", undefined, "data:image/png;base64,AAA"],
  // A nested document inside the archive, reached from a relative source url.
  ["Level1/doc.kml", "Data/KML/multilevel.kmz", "Data/KML/Level1/doc.kml"],
  ["Level2/doc.kml", "Level1/doc.kml", "Level1/Level2/doc.kml"],
  ["sub/img.png", "Data/KML/simple.kmz", "Data/KML/sub/img.png"],
  // The same archive served over http keeps the absolute form.
  [
    "Level2/doc.kml",
    "http://localhost:9876/Data/KML/Level1/doc.kml",
    "http://localhost:9876/Data/KML/Level1/Level2/doc.kml",
  ],
  ["/abs/x.kml", "Data/KML/multilevel.kmz", "/abs/x.kml"],
  // AUTHORED. An archive loaded by a root-relative url: upstream answers
  // "/abs/x.kml", this answers "x.kml", and no zip entry name carries a
  // leading slash, so both miss the archive and fall through to the network.
  ["x.kml", "/abs/base.kmz", "x.kml"],
];

test("an href resolves to the archive entry name that can match a zip filename", () => {
  for (const [href, base, expected] of entryNames) {
    assert.equal(
      resolveKmzEntryName(href, base),
      expected,
      `href ${href} against base ${base}`,
    );
  }
});

test("a relative entry name never gains a leading slash", () => {
  for (const href of ["image.png", "sub/image.png", "./image.png"]) {
    assert.ok(
      !resolveKmzEntryName(href).startsWith("/"),
      `href ${href} gained a leading slash`,
    );
  }
});

// The consumers. `embedDataUris` and `resolveHref` are the only readers of the
// key, and a key that is right on its own but wrong by the time it reaches
// `keys.indexOf` rewrites nothing at all — which is the state the balloon
// rewrite was in.

function fakeElement(attributes) {
  return {
    getAttribute(name) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
    setAttribute(name, value) {
      attributes[name] = value;
    },
  };
}

function fakeDiv(elements) {
  return { querySelectorAll: () => elements };
}

const imageDataUri = "data:image/png;base64,AAA";

function simpleKmzResolver() {
  const resolver = { "image.png": imageDataUri };
  resolver.keys = Object.keys(resolver);
  return resolver;
}

test("a balloon's relative image is rewritten to the archive entry's data uri", () => {
  const image = fakeElement({ src: "image.png" });
  embedDataUris(fakeDiv([image]), "img", "src", simpleKmzResolver());
  assert.equal(image.getAttribute("src"), imageDataUri);
});

test("a balloon's relative link is rewritten and gains the entry name as its download", () => {
  const link = fakeElement({ href: "./image.png" });
  embedDataUris(fakeDiv([link]), "a", "href", simpleKmzResolver());
  assert.equal(link.getAttribute("href"), imageDataUri);
  assert.equal(link.getAttribute("download"), "image.png");
});

test("a balloon's link to something outside the archive is left exactly as written", () => {
  const outside = ["http://h/image.png", "../image.png", "/image.png"];
  for (const value of outside) {
    const element = fakeElement({ src: value });
    embedDataUris(fakeDiv([element]), "img", "src", simpleKmzResolver());
    assert.equal(element.getAttribute("src"), value, `src ${value}`);
  }
});

test("a nested document's href resolves to its archive entry rather than the network", () => {
  const uriResolver = { "Level1/Level2/doc.kml": "blob:level2" };
  const resource = resolveHref(
    "Level2/doc.kml",
    new Resource({ url: "Level1/doc.kml" }),
    uriResolver,
  );
  assert.equal(resource.url, "blob:level2");
});

test("an href the archive does not hold still resolves against the source", () => {
  const uriResolver = { "Level1/Level2/doc.kml": "blob:level2" };
  const resource = resolveHref(
    "http://h/elsewhere.kml",
    new Resource({ url: "Level1/doc.kml" }),
    uriResolver,
  );
  assert.equal(resource.url, "http://h/elsewhere.kml");
});
