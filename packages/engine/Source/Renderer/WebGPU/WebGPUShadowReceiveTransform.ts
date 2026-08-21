import Matrix4 from "../../Core/Matrix4.js";

/**
 * The one place that converts Cesium's backend-neutral shadow receive
 * transform into the texture convention a WebGPU receive shader samples with.
 *
 * `ShadowMap._shadowMapMatrix` is
 * `ShadowMapCamera.getViewProjection() * sceneCamera.inverseViewMatrix`
 * (`Scene/ShadowMap.js`). `getViewProjection` already folds in an
 * NDC-to-texture scale/bias — `scaleBiasZeroToOneMatrix` under the WebGPU
 * clip convention and `scaleBiasNegativeOneToOneMatrix` under WebGL — so
 * after the perspective divide the result is already texture space:
 *
 *   x = 0.5 * ndc.x + 0.5   in [0, 1], left to right
 *   y = 0.5 * ndc.y + 0.5   in [0, 1], bottom to top (the GL image origin)
 *   z = ndc.z               in [0, 1]
 *                             (the depth range the WebGPU cast pass wrote)
 *
 * The only remaining divergence is the image origin. A WebGPU render pass
 * puts NDC +y at framebuffer row 0. `textureSampleCompare*` also addresses
 * row 0 at `v = 0`, so the receiver needs `v = 1 - y` and nothing else.
 *
 * Reapplying the full NDC-to-UV remap
 * (`uv = vec2(c.x * 0.5 + 0.5, 1.0 - (c.y * 0.5 + 0.5))`) would double-bias
 * this already scale-biased matrix. It would squeeze every lookup into
 * `u in [0.5, 1]`, `v in [0, 0.5]` — the wrong quadrant, mirrored — so the
 * receivers would sample cleared depth and report "lit" almost everywhere.
 * The cascaded path instead supplies a raw clip-space cascade view-projection
 * matrix and therefore performs the full remap in its receivers.
 *
 * Doing the flip here rather than in each shader keeps the convention in one
 * tested place: the four inline receivers sample `coord.xy` directly and
 * cannot drift from each other.
 *
 * @private
 */
const WEBGPU_TEXTURE_V_FLIP = Object.freeze(
  new Matrix4(
    1.0,
    0.0,
    0.0,
    0.0,
    0.0,
    -1.0,
    0.0,
    1.0,
    0.0,
    0.0,
    1.0,
    0.0,
    0.0,
    0.0,
    0.0,
    1.0,
  ),
);

/**
 * Converts a `ShadowMap._shadowMapMatrix` (eye space to GL-origin shadow
 * texture space) into the WebGPU-origin form a receive shader can sample with
 * `uv = coord.xy` after the perspective divide.
 *
 * The flip is applied before the divide, which is why the `w` column carries
 * the `+1`: for a clip vector `c`, the product is
 * `(c.x, w - c.y, c.z, w)`, and dividing through gives
 * `(c.x/w, 1 - c.y/w, c.z/w)`.
 *
 * @param shadowMapMatrix The scale-biased eye-to-texture receive transform.
 * @param result Storage for the converted matrix.
 * @returns `result`.
 * @private
 */
export function toWebGPUShadowReceiveMatrix(
  shadowMapMatrix: Matrix4,
  result: Matrix4,
): Matrix4 {
  return Matrix4.multiply(WEBGPU_TEXTURE_V_FLIP, shadowMapMatrix, result);
}

export { WEBGPU_TEXTURE_V_FLIP };
