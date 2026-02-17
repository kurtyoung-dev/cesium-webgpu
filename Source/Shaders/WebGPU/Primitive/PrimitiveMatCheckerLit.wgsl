// PrimitiveMatCheckerLit.wgsl
// Procedural checkerboard material + Blinn-Phong lighting
// Vertex: position(3) + normal(3) + st(2) = 8 floats = 32 bytes
// Uniform: MVP(64) + ModelView(64) + NormalMatrix(64) + LightDir(16) + lightColor(16) + darkColor(16) + repeat(16) = 256 bytes

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldNormal: vec3<f32>,
    @location(1) viewPosition: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    modelView: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    lightDirection: vec4<f32>,
    lightColor: vec4<f32>,
    darkColor: vec4<f32>,
    repeat: vec2<f32>,
    _pad0: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clipPosition = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;

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

    let ambient = 0.15;
    let NdotL = max(dot(normal, lightDir), 0.0);
    let diffuse = NdotL * 0.7;

    let viewDir = normalize(-input.viewPosition);
    let halfDir = normalize(lightDir + viewDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdotH, 32.0) * 0.15;

    let lighting = ambient + diffuse + specular;

    let uv = input.texCoord * uniforms.repeat;
    let cx = floor(uv.x);
    let cy = floor(uv.y);
    let checker = ((cx + cy) % 2.0);
    var baseColor: vec4<f32>;
    if (checker < 0.5) {
        baseColor = uniforms.lightColor;
    } else {
        baseColor = uniforms.darkColor;
    }

    let finalColor = baseColor.rgb * lighting;
    return vec4<f32>(finalColor, baseColor.a);
}
