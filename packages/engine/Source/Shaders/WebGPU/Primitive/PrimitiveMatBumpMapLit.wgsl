// PrimitiveMatBumpMapLit.wgsl
// Bump map material + Blinn-Phong lighting
// Perturbs surface normal using height differences from a texture
// Samples center, right, and top texels to compute tangent-space normal
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats = 44 bytes
// Matches CesiumJS Material.BumpMapType: image, channel, strength, repeat

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

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    modelViewRelativeToEye: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    lightDirection: vec4<f32>,
}

struct MaterialUniforms {
    repeat: vec2<f32>,
    channel: f32,  // 0=r, 1=g, 2=b, 3=a,
    strength: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var textureSampler: sampler;
@group(2) @binding(1) var bumpTexture: texture_2d<f32>;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

fn extractChannel(texColor: vec4<f32>, ch: f32) -> f32 {
    let c = i32(ch);
    if (c == 0) { return texColor.r; }
    if (c == 1) { return texColor.g; }
    if (c == 2) { return texColor.b; }
    return texColor.a;
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let posRTE = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.clipPosition = camera.mvpRelativeToEye * posRTE;
    output.worldNormal = (camera.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz;
    output.viewPosition = (camera.modelViewRelativeToEye * posRTE).xyz;
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Compute bumped normal from height map
    let texDims = vec2<f32>(textureDimensions(bumpTexture, 0));
    let uv = fract(input.texCoord * material.repeat);

    let centerBump = extractChannel(
        textureSample(bumpTexture, textureSampler, uv),
        material.channel
    );
    let rightBump = extractChannel(
        textureSample(bumpTexture, textureSampler, fract(uv + vec2<f32>(1.0 / texDims.x, 0.0))),
        material.channel
    );
    let topBump = extractChannel(
        textureSample(bumpTexture, textureSampler, fract(uv + vec2<f32>(0.0, 1.0 / texDims.y))),
        material.channel
    );

    // Tangent-space normal from height differences
    let bumpNormal = normalize(vec3<f32>(
        centerBump - rightBump,
        centerBump - topBump,
        clamp(1.0 - material.strength, 0.1, 1.0)
    ));

    // Approximate tangent-to-eye transformation using screen-space derivatives
    let N = normalize(input.worldNormal);
    let dPdx = dpdx(input.viewPosition);
    let dPdy = dpdy(input.viewPosition);
    let T = normalize(dPdx - N * dot(dPdx, N));
    let B = normalize(cross(N, T));
    let perturbedNormal = normalize(
        T * bumpNormal.x + B * bumpNormal.y + N * bumpNormal.z
    );

    // Blinn-Phong with perturbed normal
    let V = normalize(-input.viewPosition);
    let L = normalize(camera.lightDirection.xyz);

    let NdotL = max(dot(perturbedNormal, L), 0.0);
    let H = normalize(L + V);
    let NdotH = max(dot(perturbedNormal, H), 0.0);
    let specular = pow(NdotH, 64.0);

    let ambient = 0.15;
    // BumpMap only modifies normals — base diffuse is gray per GLSL (0.01)
    let baseDiffuse = vec3<f32>(0.5);
    let diffuse = baseDiffuse * (ambient + NdotL * 0.85);
    let spec = vec3<f32>(specular * 0.3);

    let finalColor = diffuse + spec;
    return vec4<f32>(finalColor, 1.0);
}
