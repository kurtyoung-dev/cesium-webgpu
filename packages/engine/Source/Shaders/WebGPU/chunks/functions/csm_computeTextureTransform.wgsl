/**
 * Applies a KHR_texture_transform 3x3 matrix to 2D texture coordinates.
 * WGSL equivalent of czm_computeTextureTransform (computeTextureTransform.glsl).
 *
 * @param {vec2<f32>} texCoord - Input texture coordinates.
 * @param {mat3x3<f32>} textureTransform - The 3x3 transform from KHR_texture_transform.
 * @returns {vec2<f32>} Transformed texture coordinates.
 */
fn csm_computeTextureTransform(texCoord: vec2<f32>, textureTransform: mat3x3<f32>) -> vec2<f32> {
  return (textureTransform * vec3<f32>(texCoord, 1.0)).xy;
}
