/**
 * Decode one PNTS point color into normalized RGBA without allocating.
 *
 * This is a CPU descriptor operation shared by backend realizers: it knows
 * the PNTS RGB, RGBA, RGB565, and CONSTANT_RGBA encodings but creates no GPU
 * objects. Keeping it outside the WebGPU renderer makes the format contract
 * directly testable and prevents format interpretation from leaking into the
 * per-frame draw path.
 *
 * @param {object} options
 * @param {ArrayLike<number>} [options.colors] Encoded per-point colors.
 * @param {number} options.componentCount Three for RGB, four for RGBA.
 * @param {boolean} options.colorsAreBytes Whether RGB(A) needs /255 normalization.
 * @param {boolean} options.isRGB565 Whether each source element is packed RGB565.
 * @param {{red:number,green:number,blue:number,alpha:number}} options.constantColor Fallback/CONSTANT_RGBA color.
 * @param {number} index Point index.
 * @param {Float32Array|number[]} result Four-element result storage.
 * @returns {Float32Array|number[]} The supplied result.
 * @private
 */
function unpackPointCloudColor(options, index, result) {
  const colors = options.colors;
  if (options.isRGB565 && colors && index < colors.length) {
    let compressed = colors[index];
    const red = Math.floor(compressed / 2048);
    compressed -= red * 2048;
    const green = Math.floor(compressed / 32);
    compressed -= green * 32;
    // Match PointCloud.js's shader constants exactly. Cesium's legacy path
    // intentionally uses 1/32, 1/64, 1/32 rather than endpoint normalization.
    result[0] = red / 32;
    result[1] = green / 64;
    result[2] = compressed / 32;
    result[3] = 1.0;
    return result;
  }

  const componentCount = options.componentCount;
  const colorOffset = index * componentCount;
  if (colors && colorOffset + componentCount <= colors.length) {
    const normalization = options.colorsAreBytes ? 1.0 / 255.0 : 1.0;
    result[0] = colors[colorOffset] * normalization;
    result[1] = colors[colorOffset + 1] * normalization;
    result[2] = colors[colorOffset + 2] * normalization;
    result[3] =
      componentCount >= 4 ? colors[colorOffset + 3] * normalization : 1.0;
    return result;
  }

  const constant = options.constantColor;
  result[0] = constant.red;
  result[1] = constant.green;
  result[2] = constant.blue;
  result[3] = constant.alpha;
  return result;
}

export { unpackPointCloudColor };
export default { unpackPointCloudColor };
