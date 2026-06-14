// ComputeInstanceWebGLVS.glsl — WebGL2 instanced vertex shader for the
// CPU/WASM fallback path of `ComputeInstanceCollection`
// (NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK).
//
// WebGL2 has no compute shaders, so the WGSL kernel that the WebGPU backend
// runs each frame cannot execute here. Instead the engine runs the
// collection's `cpuKernel` over all instances on the CPU, RTE-splits each
// position with the SAME AGI high/low split the WebGPU scaffold uses, and
// uploads one instanced record per object. This shader vertex-pulls those
// records and expands each into a screen-space quad, mirroring
// ComputeInstanceRender.wgsl's `vertexMain` so one mental model serves both
// backends:
//   - per-instance attributes: positionHigh, positionLow, color, pixelSize
//   - a shared [-1,1] quad VB at attribute 0 (attribute 0 cannot be
//     instanced per the WebGL spec, so the quad corner takes that slot)
//   - RTE via czm_translateRelativeToEye + czm_modelViewProjectionRelativeToEye
//     (the CZM automatic uniforms already encode the camera high/low, so the
//     CPU records carry ABSOLUTE positions split high/low, exactly like the
//     WebGPU instance records the compute kernel writes)
//   - log depth via czm_vertexLogDepth (renderer-wide log depth parity)

in vec2 quadPos;          // attribute 0 — [-1,1] quad corner (NOT instanced)
in vec3 positionHigh;     // per-instance RTE high (absolute ECEF, AGI split)
in vec3 positionLow;      // per-instance RTE low
in vec4 color;            // per-instance straight RGBA in [0,1]
in float pixelSize;       // per-instance dot diameter in pixels

out vec4 v_color;
out vec2 v_uv;

void main()
{
    // RTE: emulated 64-bit camera-relative translation. czm_translateRelativeToEye
    // subtracts the encoded camera high/low (matching the WGSL highDiff/lowDiff),
    // and czm_modelViewProjectionRelativeToEye projects the result.
    vec4 p = czm_translateRelativeToEye(positionHigh, positionLow);
    vec4 clipPos = czm_modelViewProjectionRelativeToEye * p;

    // Screen-space quad expansion (identical to vertexMain in
    // ComputeInstanceRender.wgsl): quadPos in [-1,1], pixelSize is the dot
    // diameter, so the NDC corner offset is quadPos * pixelSize / viewport.
    // Multiply by w so the offset survives the perspective divide. Scale in
    // response to browser zoom like the other collections.
    float size = max(pixelSize, 1.0) * czm_pixelRatio;
    vec2 viewport = czm_viewport.zw;
    clipPos.x += quadPos.x * size / viewport.x * clipPos.w;
    clipPos.y += quadPos.y * size / viewport.y * clipPos.w;

    gl_Position = clipPos;
    v_uv = quadPos;
    v_color = color;

    czm_vertexLogDepth();
}
