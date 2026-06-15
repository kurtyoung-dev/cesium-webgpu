// ComputeInstanceWebGLPickFS.glsl — WebGL2 PICK fragment shader for the
// CPU-kernel fallback path of `ComputeInstanceCollection`
// (NEW-COMPUTE-INSTANCE-PICKPOSITION).
//
// Writes the per-instance pick id color straight to the pick framebuffer. The
// circle discard mirrors the color FS so the pickable footprint matches the
// visible dot (a pick at the square corner outside the dot misses, just like
// the rendered dot is transparent there). Pick must be byte-exact — NO alpha
// blending of the pick color — so the readback reconstructs the integer key
// from the four channels.

in vec4 v_pickColor;
in vec2 v_uv;

void main()
{
    float dist = length(v_uv);
    if (dist > 1.0)
    {
        discard;
    }
    out_FragColor = v_pickColor;

    czm_writeLogDepth();
}
