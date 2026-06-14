// ComputeInstanceWebGLFS.glsl — WebGL2 fragment shader for the CPU/WASM
// fallback path of `ComputeInstanceCollection`
// (NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK).
//
// Anti-aliased circular dot, byte-for-byte the same shaping as
// ComputeInstanceRender.wgsl's `fragmentMain`: v_uv is [-1,1] across the
// quad, the dot is a smoothstep falloff from 0.7 to 1.0 in radius, and the
// fragment is discarded where the alpha is negligible. Log depth via
// czm_writeLogDepth keeps depth parity with the WebGPU leg.

in vec4 v_color;
in vec2 v_uv;

void main()
{
    float dist = length(v_uv);
    float alpha = (1.0 - smoothstep(0.7, 1.0, dist)) * v_color.a;
    if (alpha < 0.01)
    {
        discard;
    }
    out_FragColor = vec4(v_color.rgb, alpha);

    czm_writeLogDepth();
}
