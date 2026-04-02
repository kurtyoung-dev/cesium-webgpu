// Model Color Stage — WGSL equivalent of ModelColorStageFS.glsl
// Applies model color tint and alpha blending.
// This is a shader function meant to be called from the main model fragment shader.

fn modelColorStage(
    color: vec4<f32>,
    modelColor: vec4<f32>,
    modelColorBlend: f32
) -> vec4<f32> {
    // modelColorBlend:
    //   0.0 = HIGHLIGHT (multiply model color by diffuse, keep vertex alpha)
    //   1.0 = REPLACE (replace diffuse entirely)
    //   0.5 = MIX (mix between model color and diffuse)

    var outColor = color;

    // Apply color blend
    let blendedColor = mix(color.rgb * modelColor.rgb, modelColor.rgb, modelColorBlend);
    outColor = vec4<f32>(blendedColor, color.a * modelColor.a);

    return outColor;
}
