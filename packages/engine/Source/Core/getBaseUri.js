import defined from "./defined.js";
import DeveloperError from "./DeveloperError.js";

/**
 * Given a URI, returns the base path of the URI.
 * @function
 *
 * @param {string} uri The Uri.
 * @param {boolean} [includeQuery = false] Whether or not to include the query string and fragment form the uri
 * @returns {string} The base path of the Uri.
 *
 * @example
 * // basePath will be "/Gallery/";
 * const basePath = Cesium.getBaseUri('/Gallery/simple.czml?value=true&example=false');
 *
 * // basePath will be "/Gallery/?value=true&example=false";
 * const basePath = Cesium.getBaseUri('/Gallery/simple.czml?value=true&example=false', true);
 */
function getBaseUri(uri, includeQuery) {
  //>>includeStart('debug', pragmas.debug);
  if (!defined(uri)) {
    throw new DeveloperError("uri is required.");
  }
  //>>includeEnd('debug');

  let basePath = "";
  const i = uri.lastIndexOf("/");
  if (i !== -1) {
    basePath = uri.substring(0, i + 1);
  }

  if (!includeQuery) {
    return basePath;
  }

  // Use native URL to extract query and fragment reliably.
  // Wrap in try/catch for relative URIs that can't be parsed standalone.
  try {
    const parsed = new URL(uri, "https://placeholder.invalid/");
    if (parsed.search.length > 0) {
      basePath += parsed.search;
    }
    if (parsed.hash.length > 0) {
      basePath += parsed.hash;
    }
  } catch {
    // If parsing fails, return basePath without query/fragment
  }

  return basePath;
}
export default getBaseUri;
