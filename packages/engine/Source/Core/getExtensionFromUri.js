import defined from "./defined.js";
import DeveloperError from "./DeveloperError.js";

/**
 * Given a URI, returns the extension of the URI.
 * @function getExtensionFromUri
 *
 * @param {string} uri The Uri.
 * @returns {string} The extension of the Uri.
 *
 * @example
 * //extension will be "czml";
 * const extension = Cesium.getExtensionFromUri('/Gallery/simple.czml?value=true&example=false');
 */
function getExtensionFromUri(uri) {
  //>>includeStart('debug', pragmas.debug);
  if (!defined(uri)) {
    throw new DeveloperError("uri is required.");
  }
  //>>includeEnd('debug');

  // Use native URL parsing to strip query/fragment and extract the path.
  // A placeholder base is needed because `uri` may be relative.
  let path;
  try {
    path = new URL(uri, "https://placeholder.invalid/").pathname;
  } catch {
    path = uri;
  }

  let index = path.lastIndexOf("/");
  if (index !== -1) {
    path = path.substring(index + 1);
  }
  index = path.lastIndexOf(".");
  if (index === -1) {
    return "";
  }
  return path.substring(index + 1);
}
export default getExtensionFromUri;
