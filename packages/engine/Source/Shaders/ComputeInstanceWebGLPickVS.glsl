// ComputeInstanceWebGLPickVS.glsl — WebGL2 instanced PICK vertex shader for
// the CPU-kernel fallback path of `ComputeInstanceCollection`
// (NEW-COMPUTE-INSTANCE-PICKPOSITION; the WebGL counterpart of the WebGPU
// Batch-279 GPU pick path).
//
// Identical quad expansion + RTE + log depth to ComputeInstanceWebGLVS, but
// instead of the straight color it carries a per-instance PICK color (one
// `context.createPickId` per instance, packed as a vertex attribute) so the
// pick framebuffer readback decodes which instance is under the cursor. The
// dot shaping (v_uv) is forwarded so the pick FS can discard outside the
// circle and keep the pickable footprint matching the rendered dot.

in vec2 quadPos;          // attribute 0 — [-1,1] quad corner (NOT instanced)
in vec3 positionHigh;     // per-instance RTE high (absolute ECEF, AGI split)
in vec3 positionLow;      // per-instance RTE low
in vec4 pickColor;        // per-instance pick id color (Color.fromRgba(key))
in float pixelSize;       // per-instance dot diameter in pixels

out vec4 v_pickColor;
out vec2 v_uv;

void main()
{
    vec4 p = czm_translateRelativeToEye(positionHigh, positionLow);
    vec4 clipPos = czm_modelViewProjectionRelativeToEye * p;

    float size = max(pixelSize, 1.0) * czm_pixelRatio;
    vec2 viewport = czm_viewport.zw;
    clipPos.x += quadPos.x * size / viewport.x * clipPos.w;
    clipPos.y += quadPos.y * size / viewport.y * clipPos.w;

    gl_Position = clipPos;
    v_uv = quadPos;
    v_pickColor = pickColor;

    czm_vertexLogDepth();
}
