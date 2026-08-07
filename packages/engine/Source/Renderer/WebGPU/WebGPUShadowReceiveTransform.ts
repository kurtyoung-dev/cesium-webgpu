import Matrix4 from "../../Core/Matrix4.js";

/**
 * The one place that converts Cesium's backend-neutral shadow RECEIVE
 * transform into the texture convention a WebGPU receive shader samples with.
 *
 * `ShadowMap._shadowMapMatrix` is
 * `ShadowMapCamera.getViewProjection() * sceneCamera.inverseViewMatrix`
 * (`Scene/ShadowMap.js`). `getViewProjection` already folds in an
 * NDC-to-texture scale/bias — `scaleBiasZeroToOneMatrix` under the WebGPU clip
 * convention, `scaleBiasNegativeOneToOneMatrix` under WebGL — so after the
 * perspective divide the result is ALREADY texture space:
 *
 *   x = 0.5 * ndc.x + 0.5   in [0, 1], left to right
 *   y = 0.5 * ndc.y + 0.5   in [0, 1], BOTTOM to top (the GL image origin)
 *   z = ndc.z               in [0, 1] (the WebGPU depth range the cast pass wrote)
 *
 * The only remaining divergence is the image origin. A WebGPU render pass puts
 * NDC +y at framebuffer row 0, and `textureSampleCompare*` addresses row 0 at
 * `v = 0`, so the receiver needs `v = 1 - y` and nothing else.
 *
 * Every WebGPU single-shadow-map receiver used to re-apply the FULL NDC-to-UV
 * remap (`uv = vec2(c.x * 0.5 + 0.5, 1.0 - (c.y * 0.5 + 0.5))`) on top of a
 * matrix that had already been scale-biased. That double bias squeezes every
 * lookup into `u in [0.5, 1]`, `v in [0, 0.5]` — the wrong quadrant, mirrored —
 * so receivers sampled cleared depth and reported "lit" almost everywhere
 * (`NEW-WEBGPU-GLOBE-SUN-SHADOW-RECEIVE-DEAD`). The cascaded path was never
 * affected because it feeds its receivers a RAW clip-space cascade VP and does
 * the full remap itself.
 *
 * Doing the flip here rather than in each shader keeps the convention in one
 * tested place: the four inlined receivers now sample `coord.xy` directly and
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
 * The flip is applied BEFORE the divide, which is why the `w` column carries
 * the `+1`: for a clip vector `c`, the product is `(c.x, w - c.y, c.z, w)` and
 * dividing through gives `(c.x/w, 1 - c.y/w, c.z/w)`.
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
