/**
 * Renderer-neutral raster-to-frustum math shared by ordinary picking and
 * Scene.snap. Inputs use drawing-buffer pixels with a bottom-left origin.
 * Keeping this scalar-only prevents viewport, DPR, and off-center projection
 * rules from drifting between the two mini-frame paths.
 *
 * @private
 */

function drawingBufferToFrustumCoordinates(
  drawingBufferX,
  drawingBufferY,
  viewportX,
  viewportY,
  viewportWidth,
  viewportHeight,
  left,
  right,
  bottom,
  top,
  result,
) {
  const u = (drawingBufferX - viewportX) / viewportWidth;
  const v = (drawingBufferY - viewportY) / viewportHeight;
  result.x = left + u * (right - left);
  result.y = bottom + v * (top - bottom);
  return result;
}

function pickFrustumHalfExtents(
  left,
  right,
  bottom,
  top,
  viewportWidth,
  viewportHeight,
  pickWidth,
  pickHeight,
  result,
) {
  result.x = ((right - left) * pickWidth) / viewportWidth / 2.0;
  result.y = ((top - bottom) * pickHeight) / viewportHeight / 2.0;
  return result;
}

export { drawingBufferToFrustumCoordinates, pickFrustumHalfExtents };

export default {
  drawingBufferToFrustumCoordinates,
  pickFrustumHalfExtents,
};
