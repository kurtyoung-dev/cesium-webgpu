// StarFieldFS.glsl — WebGL Yale Bright Star Catalog point starfield.
//
// GLSL parity port of Shaders/WebGPU/Catalog/StarField.wgsl (fragmentMain).
// Soft radial falloff → a round, anti-aliased point with a bright core and
// a softer halo. The output rgb is PREMULTIPLIED by the falloff (so the
// additive blend uses srcRGB = ONE, matching the WGSL pipeline's
// premultiplied additive blend — using SOURCE_ALPHA would attenuate by the
// falloff twice and crush every star to a sub-threshold smudge).

in vec2 v_corner;   // [-1, 1] quad-local coordinate
in vec3 v_color;    // HDR color (already intensity-weighted in the VS)

void main()
{
    // dist in [0, √2]; a wide Gaussian core (so the disc is visibly filled,
    // not a single hot texel) plus a smoothstep cutoff at the quad edge for
    // anti-aliasing. The additive blend reads the result as a glowing star.
    float dist = length(v_corner);
    float core = exp(-dist * dist * 2.2);
    float edge = smoothstep(1.0, 0.45, dist); // fade the outer half of the quad
    float alpha = core * edge;

    // Additive output: RGB is the blackbody color already weighted by Pogson
    // intensity in the VS, premultiplied by the radial falloff. Values above
    // 1.0 clip at the ROP on the default LDR target (highDynamicRange=false,
    // bloom off); only with HDR enabled does the float scene target preserve
    // the overflow for the bloom bright-pass (when bloom is also enabled).
    vec3 rgb = v_color * alpha;
    out_FragColor = vec4(rgb, alpha);
}
