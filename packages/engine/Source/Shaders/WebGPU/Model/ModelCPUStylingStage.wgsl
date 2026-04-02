/**
 * Applies CPU-driven per-feature styling (show/color) to model fragments.
 * Port of CPUStylingStageFS.glsl and CPUStylingStageVS.glsl.
 */

// Vertex stage: pass through feature color from instance/vertex attributes
fn csm_cpuStylingVertex(featureColor: vec4<f32>) -> vec4<f32> {
    return featureColor;
}

// Fragment stage: apply feature color to material
fn csm_cpuStylingFragment(
    materialColor: vec4<f32>,
    featureColor: vec4<f32>,
    isHighlighted: bool
) -> vec4<f32> {
    // Discard if feature is hidden (alpha = 0)
    if (featureColor.a == 0.0) {
        // Signal discard - caller should check alpha
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // MIX or REPLACE mode
    var result: vec4<f32> = materialColor;
    result = vec4<f32>(
        mix(materialColor.rgb, featureColor.rgb, featureColor.a),
        materialColor.a * featureColor.a
    );

    if (isHighlighted) {
        // Simple highlight: brighten
        result = vec4<f32>(result.rgb * 1.5, result.a);
    }

    return result;
}
