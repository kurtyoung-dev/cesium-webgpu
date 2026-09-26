import { getAbsoluteUri, getBaseUri } from "../../index.js";

describe("Core/getAbsoluteUri", function () {
  it("works as expected", function () {
    let result = getAbsoluteUri(
      "http://www.mysite.com/awesome?makeitawesome=true",
    );
    expect(result).toEqual("http://www.mysite.com/awesome?makeitawesome=true");

    result = getAbsoluteUri("awesome.png", "http://test.com");
    expect(result).toEqual("http://test.com/awesome.png");

    result = getAbsoluteUri("awesome.png");
    expect(result).toEqual(`${getBaseUri(document.location.href)}awesome.png`);
  });

  it("document.baseURI is respected", function () {
    const fakeDocument = {
      baseURI: "http://test.com/index.html",
      location: document.location,
    };

    const result = getAbsoluteUri._implementation(
      "awesome.png",
      undefined,
      fakeDocument,
    );
    expect(result).toEqual("http://test.com/awesome.png");
  });

  // Every expected string below is what upstream CesiumJS returns for the
  // same input: `new Uri(relative).toString()` when the relative carries a
  // scheme, `new Uri(relative).absoluteTo(base).toString()` otherwise. These
  // run in a browser, which is the only place the difference shows — with no
  // `document` this function returns its argument and rewrites nothing.
  it("returns a uri that carries its own scheme as it was written", function () {
    const uris = [
      // The authority's case is what a CZML `billboard.image` is compared and
      // displayed as, and `Resource.parseUrl` reads a base's authority back
      // out of this string.
      [
        "http://someImage.invalid/image.png",
        "http://someImage.invalid/image.png",
      ],
      ["HTTP://Host.Invalid/Path", "HTTP://Host.Invalid/Path"],
      ["http://user:pw@Host.invalid/p", "http://user:pw@Host.invalid/p"],
      ["http://[2001:DB8::1]/p", "http://[2001:DB8::1]/p"],
      // Separator runs and dot segments belong to the caller.
      ["http://h/a//b.js", "http://h/a//b.js"],
      ["http://h/a/./b/../c", "http://h/a/./b/../c"],
      // Schemes the URL Standard does not treat as special.
      ["file:///C:/a/b.txt", "file:///C:/a/b.txt"],
      ["mailto:a@b.com", "mailto:a@b.com"],
      ["custom-scheme:opaque/Thing", "custom-scheme:opaque/Thing"],
      // An authority with no path serialises with a root path.
      ["http://h", "http://h/"],
    ];

    uris.forEach(function (pair) {
      expect(getAbsoluteUri(pair[0])).toEqual(pair[1]);
    });
  });

  it("resolves against a base without rewriting either one", function () {
    const uris = [
      [
        "image.png",
        "http://someImage.invalid/",
        "http://someImage.invalid/image.png",
      ],
      ["x.js", "HTTP://Host.Invalid/base/", "HTTP://Host.Invalid/base/x.js"],
      [
        "x.js",
        "http://user:pw@Host.invalid/base/",
        "http://user:pw@Host.invalid/base/x.js",
      ],
      // A base that is itself relative is merged onto, not discarded.
      ["x.js", "Data/KML/", "Data/KML/x.js"],
      ["Level2/doc.kml", "Level1/doc.kml", "Level1/Level2/doc.kml"],
      ["x.js", "//Host.Invalid/base/", "//Host.Invalid/base/x.js"],
      // Merging a relative path collapses separator runs; a root-relative
      // path replaces the base's path outright and keeps them.
      [
        "Workers//transferTypedArrayTest.js",
        "http://test.com/source/",
        "http://test.com/source/Workers/transferTypedArrayTest.js",
      ],
      ["/a//b.js", "http://h/base/", "http://h/a//b.js"],
      // A protocol-relative uri brings its own authority, as written.
      [
        "//other.Host/x.js",
        "http://test.com/source/",
        "http://other.Host/x.js",
      ],
    ];

    uris.forEach(function (triple) {
      expect(getAbsoluteUri(triple[0], triple[1])).toEqual(triple[2]);
    });
  });

  it("throws with undefined parameter", function () {
    expect(function () {
      getAbsoluteUri(undefined);
    }).toThrowDeveloperError();
  });
});
