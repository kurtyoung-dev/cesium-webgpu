import defined from "./defined.js";
import DeveloperError from "./DeveloperError.js";

/**
 * Given a URI, returns the last segment of the URI, removing any path or query information.
 * @function getFilenameFromUri
 *
 * @param {string} uri The Uri.
 * @returns {string} The last segment of the Uri.
 *
 * @example
 * //fileName will be"simple.czml";
 * const fileName = Cesium.getFilenameFromUri('/Gallery/simple.czml?value=true&example=false');
 */
function getFilenameFromUri(uri) {
  //>>includeStart('debug', pragmas.debug);
  if (!defined(uri)) {
    throw new DeveloperError("uri is required.");
  }
  //>>includeEnd('debug');

  let path;
  try {
    path = new URL(uri, "https://placeholder.invalid/").pathname;
  } catch {
    path = uri;
  }

  // Normalize by decoding percent-encoded characters
  path = decodeURIComponent(path);
  const index = path.lastIndexOf("/");
  if (index !== -1) {
    path = path.substring(index + 1);
  }
  return path;
}
export default getFilenameFromUri;
