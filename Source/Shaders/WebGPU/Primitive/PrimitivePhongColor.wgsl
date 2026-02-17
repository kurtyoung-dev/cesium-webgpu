// PrimitivePhongColor.wgsl
// Blinn-Phong lighting: position + normal + color
// Uniform: MVP(64) + ModelView(64) + NormalMatrix(64) + LightDir(16) = 208 bytes, padded to 256

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) viewPosition: vec3<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    modelView: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    lightDirection: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clipPosition = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.color = input.color;

    let transformedNormal = normalize(
        mat3x3<f32>(
            uniforms.normalMatrix[0].xyz,
            uniforms.normalMatrix[1].xyz,
            uniforms.normalMatrix[2].xyz
        ) * input.normal
    );
    output.worldNormal = transformedNormal;

    let viewPos = uniforms.modelView * vec4<f32>(input.position, 1.0);
    output.viewPosition = viewPos.xyz;

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(input.worldNormal);
    let lightDir = normalize(uniforms.lightDirection.xyz);

    // Ambient
    let ambient = 0.15;

    // Diffuse (Lambertian)
    let NdotL = max(dot(normal, lightDir), 0.0);
    let diffuse = NdotL * 0.7;

    // Specular (Blinn-Phong)
    let viewDir = normalize(-input.viewPosition);
    let halfDir = normalize(lightDir + viewDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdotH, 32.0) * 0.15;

    let lighting = ambient + diffuse + specular;
    let finalColor = input.color.rgb * lighting;

    return vec4<f32>(finalColor, input.color.a);
}
