/**
 * EllipsoidPrimitive — Ray-marched ellipsoid for WebGPU
 *
 * This is a SLANG shader that cross-compiles to WGSL via `slangc`.
 * It renders a ray-marched ellipsoid (used by EllipsoidPrimitive.js)
 * with proper RTE (Relative-To-Eye) 64-bit emulated precision.
 *
 * Build: node scripts/slangToWgsl.js
 * Output: packages/engine/Source/Shaders/WebGPU/Generated/EllipsoidPrimitive.wgsl
 *
 * This demonstrates CesiumJS's Slang cross-compilation pipeline:
 * - Single source for both GLSL and WGSL (when extended to --target glsl)
 * - CesiumJS RTE pattern (positionHigh + positionLow)
 * - Per-frame / per-object uniform grouping (bind groups 0 + 1)
 * - Ray-sphere intersection in eye space
 */

// ═══════════════════════════════════════════════════════════
// Uniform Structures — CesiumJS conventions
// ═══════════════════════════════════════════════════════════

struct CameraUniforms {
    float4x4 modelViewProjectionRelativeToEye;
    float4x4 modelViewRelativeToEye;
    float3   encodedCameraPositionMCHigh;
    float    _pad0;
    float3   encodedCameraPositionMCLow;
    float    _pad1;
    float2   viewportSize;
    float    _pad2;
    float    _pad3;
};

struct EllipsoidUniforms {
    float3   radii;           // Ellipsoid semi-axes (a, b, c)
    float    _pad0;
    float3   oneOverRadiiSq;  // 1.0 / (radii * radii) for unit sphere mapping
    float    _pad1;
    float4   color;           // RGBA color
    float3   centerHigh;      // RTE center position (high part)
    float    _pad2;
    float3   centerLow;       // RTE center position (low part)
    float    _pad3;
};

// Bind group 0: per-frame (camera)
[[vk::binding(0, 0)]] ConstantBuffer<CameraUniforms> camera;

// Bind group 1: per-object (ellipsoid)
[[vk::binding(0, 1)]] ConstantBuffer<EllipsoidUniforms> ellipsoid;

// ═══════════════════════════════════════════════════════════
// CesiumJS RTE Helper — translateRelativeToEye
// ═══════════════════════════════════════════════════════════

float3 csm_translateRelativeToEye(
    float3 positionHigh, float3 positionLow,
    float3 cameraHigh,   float3 cameraLow
) {
    // Standard CesiumJS RTE: (posHigh - camHigh) + (posLow - camLow)
    float3 result = (positionHigh - cameraHigh) + (positionLow - cameraLow);
    return result;
}

// ═══════════════════════════════════════════════════════════
// Vertex Shader — Full-screen quad for ray marching
// ═══════════════════════════════════════════════════════════

struct VertexInput {
    [[vk::location(0)]] float2 position : POSITION;
};

struct VertexOutput {
    float4 position : SV_Position;
    float3 eyeDirection;  // Ray direction from eye through this pixel
    float3 ellipsoidCenter; // Ellipsoid center in eye space
};

[shader("vertex")]
VertexOutput vertexMain(VertexInput input) {
    VertexOutput output;

    // Full-screen quad: [-1,1] → clip space
    output.position = float4(input.position, 0.0, 1.0);

    // Compute ellipsoid center in eye space using RTE
    float3 centerRTE = csm_translateRelativeToEye(
        ellipsoid.centerHigh, ellipsoid.centerLow,
        camera.encodedCameraPositionMCHigh, camera.encodedCameraPositionMCLow
    );
    float3 centerEye = mul(camera.modelViewRelativeToEye, float4(centerRTE, 1.0)).xyz;
    output.ellipsoidCenter = centerEye;

    // Compute ray direction: unproject from clip to eye space
    // For a full-screen quad, the ray goes through each pixel
    float aspectRatio = camera.viewportSize.x / camera.viewportSize.y;
    output.eyeDirection = float3(input.position.x * aspectRatio, input.position.y, -1.0);

    return output;
}

// ═══════════════════════════════════════════════════════════
// Ray-Ellipsoid Intersection
// ═══════════════════════════════════════════════════════════

/**
 * Intersect a ray with an ellipsoid centered at `center` with semi-axes `radii`.
 *
 * Maps the ellipsoid to a unit sphere via scaling, intersects with the unit
 * sphere, then maps back. Returns the two t-values (near, far) or (-1, -1)
 * if no intersection.
 */
float2 intersectEllipsoid(float3 rayOrigin, float3 rayDir, float3 center, float3 oneOverRadiiSq) {
    // Transform ray to unit-sphere space
    float3 oc = rayOrigin - center;
    float3 ocScaled = oc * sqrt(oneOverRadiiSq);
    float3 dirScaled = rayDir * sqrt(oneOverRadiiSq);

    // Quadratic: |dirScaled*t + ocScaled|^2 = 1
    float a = dot(dirScaled, dirScaled);
    float b = 2.0 * dot(dirScaled, ocScaled);
    float c = dot(ocScaled, ocScaled) - 1.0;

    float discriminant = b * b - 4.0 * a * c;
    if (discriminant < 0.0) {
        return float2(-1.0, -1.0);
    }

    float sqrtDisc = sqrt(discriminant);
    float t0 = (-b - sqrtDisc) / (2.0 * a);
    float t1 = (-b + sqrtDisc) / (2.0 * a);

    return float2(t0, t1);
}

/**
 * Compute the ellipsoid normal at a surface point.
 * The gradient of the ellipsoid implicit surface x²/a² + y²/b² + z²/c² = 1
 * is (2x/a², 2y/b², 2z/c²), normalized.
 */
float3 ellipsoidNormal(float3 point, float3 center, float3 oneOverRadiiSq) {
    float3 local = point - center;
    float3 grad = local * oneOverRadiiSq;
    return normalize(grad);
}

// ═══════════════════════════════════════════════════════════
// Fragment Shader — Ray marching + Phong lighting
// ═══════════════════════════════════════════════════════════

struct FragmentInput {
    float4 position : SV_Position;
    float3 eyeDirection;
    float3 ellipsoidCenter;
};

struct FragmentOutput {
    float4 color : SV_Target0;
};

[shader("fragment")]
FragmentOutput fragmentMain(FragmentInput input) {
    FragmentOutput output;

    // Ray from eye through this pixel
    float3 rayOrigin = float3(0.0, 0.0, 0.0); // Eye is at origin in eye space
    float3 rayDir = normalize(input.eyeDirection);

    // Intersect with ellipsoid in eye space
    float2 tValues = intersectEllipsoid(
        rayOrigin, rayDir,
        input.ellipsoidCenter,
        ellipsoid.oneOverRadiiSq
    );

    // Discard if no intersection or behind camera
    if (tValues.x < 0.0 && tValues.y < 0.0) {
        discard;
    }

    // Use nearest intersection in front of camera
    float t = (tValues.x >= 0.0) ? tValues.x : tValues.y;
    if (t < 0.0) {
        discard;
    }

    // Hit point in eye space
    float3 hitPoint = rayOrigin + rayDir * t;

    // Surface normal
    float3 normal = ellipsoidNormal(hitPoint, input.ellipsoidCenter, ellipsoid.oneOverRadiiSq);

    // Simple directional lighting (sun from top-right)
    float3 lightDir = normalize(float3(0.5, 1.0, 0.3));
    float NdotL = max(dot(normal, lightDir), 0.0);

    // Ambient + diffuse
    float3 ambient = ellipsoid.color.rgb * 0.3;
    float3 diffuse = ellipsoid.color.rgb * NdotL * 0.7;

    output.color = float4(ambient + diffuse, ellipsoid.color.a);
    return output;
}
