import defined from "./defined.js";
import DeveloperError from "./DeveloperError.js";

// A uri's `<scheme>:` and `//<authority>` prefixes, exactly as they were
// written. `new URL(...)` can report back neither: the parser lower-cases both
// (the URL Standard requires it for every special scheme, which is most of
// them), and it rejects a base that is itself relative instead of merging onto
// it, which is what urijs's `absoluteTo` did.
const schemeAndAuthorityRegex = /^([a-zA-Z][a-zA-Z0-9+\-.]*:)?(\/\/[^/?#]*)?/;
const schemeRegex = /^[a-zA-Z][a-zA-Z0-9+\-.]*:/;

// A uri that stops at its authority; serialising one yields a root path.
const authorityOnlyRegex = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^/?#]*(?=[?#]|$)/;

// The two path halves are merged inside a placeholder origin, because the URL
// parser is the only RFC 3986 path merge on hand and it insists on an absolute
// base. A base carrying no authority of its own hangs off `relativeBasePath`,
// so a result still inside that directory is still relative — the form
// `absoluteTo` returned for a relative base.
const placeholderOrigin = "https://placeholder.invalid";
const relativeBasePath = "/relative-base/";

/**
 * Given a relative Uri and a base Uri, returns the absolute Uri of the relative Uri.
 * @function
 *
 * @param {string} relative The relative Uri.
 * @param {string} [base] The base Uri.
 * @returns {string} The absolute Uri of the given relative Uri.
 *
 * @example
 * //absolute Uri will be "https://test.com/awesome.png";
 * const absoluteUri = Cesium.getAbsoluteUri('awesome.png', 'https://test.com');
 */
function getAbsoluteUri(relative, base) {
  let documentObject;
  if (typeof document !== "undefined") {
    documentObject = document;
  }

  return getAbsoluteUri._implementation(relative, base, documentObject);
}

getAbsoluteUri._implementation = function (relative, base, documentObject) {
  //>>includeStart('debug', pragmas.debug);
  if (!defined(relative)) {
    throw new DeveloperError("relative uri is required.");
  }
  //>>includeEnd('debug');

  if (!defined(base)) {
    if (typeof documentObject === "undefined") {
      return relative;
    }
    base = documentObject.baseURI ?? documentObject.location.href;
  }

  // A uri that carries its own scheme is already absolute and never consults
  // the base, so it comes back the way the caller wrote it -- upstream returned
  // `new Uri(relative).toString()` here, whose only change is the root path an
  // authority-only uri serialises with. Rebuilding it as `new URL(...).href`
  // instead lower-cased the scheme, the host and any IPv6 literal and resolved
  // dot segments the caller had left alone, and since this runs on the base of
  // every relative resolution in Resource.parseUrl, every derived url in a
  // browser inherited the rewritten spelling.
  if (schemeRegex.test(relative)) {
    return relative.replace(authorityOnlyRegex, "$&/");
  }

  const fromRelative = schemeAndAuthorityRegex.exec(relative);
  const fromBase = schemeAndAuthorityRegex.exec(base);
  // A protocol-relative uri brings its own authority and takes the base's
  // scheme; everything else inherits both.
  const authority = fromRelative[2] ?? fromBase[2];
  const relativePath = relative.slice(fromRelative[0].length);
  const basePath = base.slice(fromBase[0].length);

  // A base with a scheme but no authority is opaque -- there is no hierarchy to
  // merge onto, and urijs threw rather than guess. The caller's own text is the
  // one answer that invents nothing.
  if (!defined(authority) && defined(fromBase[1])) {
    return relative;
  }

  let resolved;
  try {
    resolved = defined(fromRelative[2])
      ? // The base's path is gone the moment the uri names its own authority,
        // and what is left of the uri is a path even when it opens with the
        // separator run that would otherwise read as another authority.
        new URL(`${placeholderOrigin}${relativePath}`)
      : new URL(
          relativePath,
          new URL(
            basePath,
            defined(authority)
              ? `${placeholderOrigin}/`
              : `${placeholderOrigin}${relativeBasePath}`,
          ),
        );
  } catch {
    return relative;
  }

  // Merging a relative path onto the base's collapses runs of separators;
  // replacing that path outright, or leaving it alone, does not.
  const merged = relativePath.length > 0 && !/^[/?#]/.test(relativePath);
  const path = `${
    merged ? resolved.pathname.replace(/\/{2,}/g, "/") : resolved.pathname
  }${resolved.search}${resolved.hash}`;

  if (defined(authority)) {
    return `${fromBase[1] ?? ""}${authority}${path}`;
  }

  // Nothing supplied an authority, so the answer is as relative as the two
  // halves were: an absolute path if either of them opened with a separator,
  // and otherwise the merged path with the placeholder directory taken back
  // off -- or, for a path that walked above that directory, with the root
  // separator the placeholder contributed taken off instead.
  if (relativePath.startsWith("/") || basePath.startsWith("/")) {
    return path;
  }
  return path.startsWith(relativeBasePath)
    ? path.slice(relativeBasePath.length)
    : path.slice(1);
};
export default getAbsoluteUri;
