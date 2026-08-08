/**
 * Converts an RGB color to CIE Yxy.
 * <p>The conversion is described in
 * {@link http://content.gpwiki.org/index.php/D3DBook:High-Dynamic_Range_Rendering#Luminance_Transform|Luminance Transform}
 * </p>
 * 
 * @name czm_RGBToXYZ
 * @glslFunction
 * 
 * @param {vec3} rgb The color in RGB.
 *
 * @returns {vec3} The color in CIE Yxy.
 *
 * @example
 * vec3 xyz = czm_RGBToXYZ(rgb);
 * xyz.x = max(xyz.x - luminanceThreshold, 0.0);
 * rgb = czm_XYZToRGB(xyz);
 */
vec3 czm_RGBToXYZ(vec3 rgb)
{
    const mat3 RGB2XYZ = mat3(0.4124, 0.2126, 0.0193,
                              0.3576, 0.7152, 0.1192,
                              0.1805, 0.0722, 0.9505);
    vec3 xyz = RGB2XYZ * rgb;
    vec3 Yxy;
    Yxy.r = xyz.g;
    float temp = dot(vec3(1.0), xyz);
    // A lightless pixel has NO CHROMATICITY, and `xyz.rg / 0.0` is 0/0 = NaN,
    // not zero. Exact black is the only input that reaches it — every entry of
    // RGB2XYZ is positive, so `temp > 0` for any non-zero, non-negative rgb —
    // and it is also the most common pixel in a scene rendered against space.
    //
    // The NaN used to be laundered by the 8-bit output textures its one engine
    // consumer (`PostProcessStages/BrightPass.glsl`, run by `SunPostProcess`)
    // wrote into. C12-19 (Batch 937) gave those stages float storage so HDR
    // could reach them, and the NaN then survived, was spread over the whole
    // bright-pass scissor by the two Gaussian passes, and painted a black
    // rectangle around the Sun. Zero chromaticity keeps the `czm_XYZToRGB`
    // round trip at black, which is the honest answer for a pixel with no
    // light. Every non-black input is bit-for-bit unchanged.
    Yxy.gb = temp > 0.0 ? xyz.rg / temp : vec2(0.0);
    return Yxy;
}
