/**
 * Tone mapping functions for HDR to LDR conversion
 * 
 * @chunk functions/csm_tonemapping
 */

// References:
//   - Erik Reinhard, Michael Stark, Peter Shirley and James Ferwerda,
//     "Photographic Tone Reproduction for Digital Images" (SIGGRAPH 2002) —
//     the c / (1 + c) operator.
//   - Krzysztof Narkowicz, "ACES Filmic Tone Mapping Curve" (2016) —
//     https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/
//     The rational fit to the Academy Color Encoding System RRT and ODT whose
//     five constants appear below.
//   - John Hable, "Filmic Tonemapping Operators" (2010) — the Uncharted 2
//     curve. Ported from this project's own GLSL builtins, which carry the
//     same citations.

// Simple Reinhard tone mapping
fn csm_reinhardTonemap(color: vec3<f32>) -> vec3<f32> {
    return color / (color + vec3<f32>(1.0));
}

// ACES filmic tone mapping (approximation)
fn csm_acesTonemap(color: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

// Uncharted 2 tone mapping helper
fn csm_uncharted2Helper(x: vec3<f32>) -> vec3<f32> {
    let A = 0.15;
    let B = 0.50;
    let C = 0.10;
    let D = 0.20;
    let E = 0.02;
    let F = 0.30;
    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

fn csm_uncharted2Tonemap(color: vec3<f32>) -> vec3<f32> {
    let W = 11.2;
    let exposureBias = 2.0;
    let curr = csm_uncharted2Helper(exposureBias * color);
    let whiteScale = vec3<f32>(1.0) / csm_uncharted2Helper(vec3<f32>(W));
    return curr * whiteScale;
}
