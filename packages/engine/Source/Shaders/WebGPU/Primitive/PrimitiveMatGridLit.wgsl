// PrimitiveMatGridLit.wgsl
// Procedural grid material + Blinn-Phong lighting
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats = 44 bytes

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldNormal: vec3<f32>,
    @location(1) viewPosition: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct Uniforms {
    mvpRelativeToEye: mat4x4<f32>,
    modelViewRelativeToEye: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    lightDirection: vec4<f32>,
    gridColor: vec4<f32>,
    cellColor: vec4<f32>,
    cellCount: vec2<f32>,
    lineThickness: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - uniforms.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - uniforms.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.clipPosition = uniforms.mvpRelativeToEye * eyePos;
    output.texCoord = input.texCoord;

    let transformedNormal = normalize(
        mat3x3<f32>(
            uniforms.normalMatrix[0].xyz,
            uniforms.normalMatrix[1].xyz,
            uniforms.normalMatrix[2].xyz
        ) * input.normal
    );
    output.worldNormal = transformedNormal;
    output.viewPosition = (uniforms.modelViewRelativeToEye * eyePos).xyz;

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let uv = fract(input.texCoord * uniforms.cellCount);
    let threshold = uniforms.lineThickness;
    let onLine = step(uv, threshold) + step(vec2<f32>(1.0) - threshold, uv);
    let isGrid = max(onLine.x, onLine.y);
    let baseColor = mix(uniforms.cellColor, uniforms.gridColor, vec4<f32>(isGrid));

    let normal = normalize(input.worldNormal);
    let lightDir = normalize(uniforms.lightDirection.xyz);

    let ambient = 0.15;
    let NdotL = max(dot(normal, lightDir), 0.0);
    let diffuse = NdotL * 0.7;

    let viewDir = normalize(-input.viewPosition);
    let halfDir = normalize(lightDir + viewDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdotH, 32.0) * 0.15;

    let lighting = ambient + diffuse + specular;
    return vec4<f32>(baseColor.rgb * lighting, baseColor.a);
}
