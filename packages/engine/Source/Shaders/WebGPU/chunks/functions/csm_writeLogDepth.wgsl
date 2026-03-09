/**
 * WGSL Log Depth function for multi-frustum rendering.
 *
 * WebGPU uses 0-1 NDC depth range (vs WebGL's -1..1). Log depth maps
 * the clip-space depth to a logarithmic distribution, giving much better
 * precision for both near and far objects.
 *
 * Usage in vertex shader:
 *   out.logZ = csm_vertexLogDepth(clipPosition);
 *
 * Usage in fragment shader:
 *   csm_writeLogDepth(logZ, farPlane);
 *   // or in @fragment fn: return FragOutput with @builtin(frag_depth) set
 *
 * The log depth value is:
 *   fragDepth = log2(1 + clipZ) / log2(1 + far)
 *
 * where clipZ is the positive distance from the camera (w component
 * of clip-space position in perspective projection).
 */

// Log depth constant: 1.0 / log2(far + 1.0)
// This must be updated per-frustum as the far plane changes
// Typically passed via uniform buffer
struct LogDepthUniforms {
  oneOverLog2FarPlusOne: f32,
  farPlane: f32,
  _pad0: f32,
  _pad1: f32,
};

/**
 * Compute the log depth value in the vertex shader.
 * Returns the value to interpolate to the fragment shader.
 *
 * @param clipPosition The clip-space position (output of MVP * position)
 * @return The log2(1 + w) value for the fragment shader
 */
fn csm_vertexLogDepth(clipPosition: vec4<f32>) -> f32 {
  // clipPosition.w is the positive distance from camera in clip space
  // For WebGPU 0-1 depth, we compute: log2(1 + w)
  return log2(max(1e-6, 1.0 + clipPosition.w));
}

/**
 * Compute the final fragment depth for log depth rendering.
 *
 * @param logZ The interpolated log2(1+w) from the vertex shader
 * @param oneOverLog2FarPlusOne 1.0 / log2(1 + farPlane) — updated per frustum
 * @return The depth value to write to @builtin(frag_depth)
 */
fn csm_writeLogDepth(logZ: f32, oneOverLog2FarPlusOne: f32) -> f32 {
  return logZ * oneOverLog2FarPlusOne;
}
