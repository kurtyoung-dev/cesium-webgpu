/**
 * Camera uniform buffer structure
 * Contains view/projection matrices, camera position, and RTE (Relative-To-Eye)
 * uniforms for emulated 64-bit precision at planetary scale.
 *
 * RTE fields:
 *   encodedCameraPositionMCHigh/Low — Camera position in model coordinates,
 *     split into two 32-bit floats via EncodedCartesian3. Used by
 *     csm_translateRelativeToEye() to compute eye-relative positions.
 *   modelViewRelativeToEye — The modelView matrix with translation column zeroed.
 *     Used with RTE positions for view-space lighting calculations.
 *   modelViewProjectionRelativeToEye — projection × modelViewRelativeToEye.
 *     Used with RTE positions for clip-space output.
 *
 * Phase 5 WGF-4: position fields are vec4<f32> rather than vec3<f32> so the
 * layout is self-documenting (no implicit alignment pads) and the .w slots
 * are reachable by future code without rewriting the struct. The byte
 * offsets are unchanged from the historical vec3+pad layout, so the JS
 * packers in WebGPUBufferPrimitiveRenderer / WebGPUUniformGroupManager
 * still pack at the same float indices. The .w lanes carry zero today.
 *
 * @chunk structs/CameraUniforms
 */
struct CameraUniforms {
    // Standard matrices
    viewMatrix: mat4x4<f32>,                       // offset   0, size 64
    projectionMatrix: mat4x4<f32>,                 // offset  64, size 64
    viewProjectionMatrix: mat4x4<f32>,             // offset 128, size 64

    // Camera position (world space).
    // .w lane carries oneOverLog2FarDepthFromNearPlusOne (the log-depth factor)
    // when log depth is active — see WebGPULogDepth.ts / packCameraLogDepthLanes.
    cameraPosition: vec4<f32>,                     // offset 192, size 16

    // RTE: Encoded camera position in model coordinates (high/low split).
    // .w lanes carry the log-depth frustum near (High.w) and far (Low.w) when
    // log depth is active — see WebGPULogDepth.ts. Zero otherwise.
    encodedCameraPositionMCHigh: vec4<f32>,        // offset 208, size 16
    encodedCameraPositionMCLow: vec4<f32>,         // offset 224, size 16

    // RTE: Matrices with translation zeroed (for use with eye-relative positions)
    modelViewRelativeToEye: mat4x4<f32>,           // offset 240, size 64
    modelViewProjectionRelativeToEye: mat4x4<f32>, // offset 304, size 64
}
// Total size: 368 bytes — same as the vec3 layout, but no implicit pads.
// Any consumer that read .xyz before continues to work unchanged; .w lanes
// were previously implicit alignment pads that any sane shader ignored.
