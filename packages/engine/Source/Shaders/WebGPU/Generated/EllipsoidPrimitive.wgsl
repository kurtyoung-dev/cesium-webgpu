// ═══════════════════════════════════════════════════════════
// EllipsoidPrimitive.wgsl — Ray-marched ellipsoid for WebGPU
//
// Source: packages/engine/Source/Shaders/Slang/EllipsoidPrimitive.slang
// This is the hand-written WGSL reference implementation that matches
// the Slang source. When slangc is available, this file is auto-generated.
// When slangc is NOT available, this pre-compiled version is used directly.
//
// Features:
// - RTE (Relative-To-Eye) 64-bit emulated precision
// - Ray-ellipsoid intersection in eye space
// - Phong directional lighting
// - Per-frame camera uniforms (bind group 0)
// - Per-object ellipsoid uniforms (bind group 1)
// ═══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────
// Uniform Structures
// ─────────────────────────────────────────────────────

struct CameraUniforms {
    modelViewProjectionRelativeToEye: mat4x4<f32>,
    modelViewRelativeToEye: mat4x4<f32>,
    encodedCameraPositionMCHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraPositionMCLow: vec3<f32>,
    _pad1: f32,
    viewportSize: vec2<f32>,
    _pad2: f32,
    _pad3: f32,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
};

struct EllipsoidUniforms {
    radii: vec3<f32>,
    _pad0: f32,
    oneOverRadiiSq: vec3<f32>,
    _pad1: f32,
    color: vec4<f32>,
    centerHigh: vec3<f32>,
    _pad2: f32,
    centerLow: vec3<f32>,
    _pad3: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> ellipsoid: EllipsoidUniforms;

// ─────────────────────────────────────────────────────
// CesiumJS RTE — translateRelativeToEye
// ─────────────────────────────────────────────────────

fn csm_translateRelativeToEye(
    positionHigh: vec3<f32>, positionLow: vec3<f32>,
    cameraHigh: vec3<f32>, cameraLow: vec3<f32>
) -> vec3<f32> {
    return (positionHigh - cameraHigh) + (positionLow - cameraLow);
}

// ─────────────────────────────────────────────────────
// Vertex IO
// ─────────────────────────────────────────────────────

struct VertexInput {
    @location(0) position: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) eyeDirection: vec3<f32>,
    @location(1) ellipsoidCenter: vec3<f32>,
};

// ─────────────────────────────────────────────────────
// Vertex Shader — Full-screen quad for ray marching
// ─────────────────────────────────────────────────────

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // Full-screen quad: [-1,1] → clip space
    output.position = vec4<f32>(input.position, 0.0, 1.0);

    // Compute ellipsoid center in eye space using RTE
    let centerRTE = csm_translateRelativeToEye(
        ellipsoid.centerHigh, ellipsoid.centerLow,
        camera.encodedCameraPositionMCHigh, camera.encodedCameraPositionMCLow
    );
    let centerEye = (camera.modelViewRelativeToEye * vec4<f32>(centerRTE, 1.0)).xyz;
    output.ellipsoidCenter = centerEye;

    // Compute ray direction: unproject from clip to eye space
    let aspectRatio = camera.viewportSize.x / camera.viewportSize.y;
    output.eyeDirection = vec3<f32>(input.position.x * aspectRatio, input.position.y, -1.0);

    return output;
}

// ─────────────────────────────────────────────────────
// Ray-Ellipsoid Intersection
// ─────────────────────────────────────────────────────

fn intersectEllipsoid(
    rayOrigin: vec3<f32>, rayDir: vec3<f32>,
    center: vec3<f32>, oneOverRadiiSq: vec3<f32>
) -> vec2<f32> {
    // Transform ray to unit-sphere space
    let oc = rayOrigin - center;
    let sqrtOORS = sqrt(oneOverRadiiSq);
    let ocScaled = oc * sqrtOORS;
    let dirScaled = rayDir * sqrtOORS;

    // Quadratic: |dirScaled*t + ocScaled|^2 = 1
    let a = dot(dirScaled, dirScaled);
    let b = 2.0 * dot(dirScaled, ocScaled);
    let c = dot(ocScaled, ocScaled) - 1.0;

    let discriminant = b * b - 4.0 * a * c;
    if (discriminant < 0.0) {
        return vec2<f32>(-1.0, -1.0);
    }

    let sqrtDisc = sqrt(discriminant);
    let t0 = (-b - sqrtDisc) / (2.0 * a);
    let t1 = (-b + sqrtDisc) / (2.0 * a);

    return vec2<f32>(t0, t1);
}

fn ellipsoidNormal(
    point: vec3<f32>, center: vec3<f32>, oneOverRadiiSq: vec3<f32>
) -> vec3<f32> {
    let local = point - center;
    let grad = local * oneOverRadiiSq;
    return normalize(grad);
}

// ─────────────────────────────────────────────────────
// Fragment Shader — Ray intersection + Phong lighting
// ─────────────────────────────────────────────────────

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) eyeDirection: vec3<f32>,
    @location(1) ellipsoidCenter: vec3<f32>,
};

@fragment
fn fragmentMain(input: FragmentInput) -> @location(0) vec4<f32> {
    // Ray from eye through this pixel
    let rayOrigin = vec3<f32>(0.0, 0.0, 0.0);
    let rayDir = normalize(input.eyeDirection);

    // Intersect with ellipsoid in eye space
    let tValues = intersectEllipsoid(
        rayOrigin, rayDir,
        input.ellipsoidCenter,
        ellipsoid.oneOverRadiiSq
    );

    // Discard if no intersection or behind camera
    if (tValues.x < 0.0 && tValues.y < 0.0) {
        discard;
    }

    // Use nearest intersection in front of camera
    var t = tValues.x;
    if (t < 0.0) {
        t = tValues.y;
    }
    if (t < 0.0) {
        discard;
    }

    // Hit point in eye space
    let hitPoint = rayOrigin + rayDir * t;

    // Surface normal
    let normal = ellipsoidNormal(hitPoint, input.ellipsoidCenter, ellipsoid.oneOverRadiiSq);

    // Simple directional lighting (sun from top-right)
    let lightDir = normalize(vec3<f32>(0.5, 1.0, 0.3));
    let NdotL = max(dot(normal, lightDir), 0.0);

    // Ambient + diffuse
    let ambient = ellipsoid.color.rgb * 0.3;
    let diffuse = ellipsoid.color.rgb * NdotL * 0.7;

    return vec4<f32>(ambient + diffuse, ellipsoid.color.a);
}
