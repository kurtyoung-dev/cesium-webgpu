/**
 * Unpacks clipping plane extents from a packed texture. Port of czm_unpackClippingExtents.
 * @chunk functions/csm_unpackClippingExtents
 *
 * DISPOSITION (2026-09-06): KEEP, pending the same follow-up epic as
 * `csm_clipByPolygons.wgsl`. Zero callers repo-wide, re-verified as of this
 * date (the only other repo-wide hit is the batch generator script that
 * originally stamped this file out as a mechanical `czm_X` -> `csm_X` port
 * placeholder, not a caller). `czm_unpackClippingExtents` is one of the GLSL
 * builtins upstream 1.145 deleted along with the plane-based clipping path;
 * this pass-through body was never filled in with real unpack logic because
 * nothing in the live SDF-clipping path needs it. No removal date has ever
 * been set anywhere in the fork's records.
 *
 * AUTHORITY. The governing disposition row is `UP-1` in the upstream-absorb
 * table of the 2026-09-02 architecture review: it dispositions this whole
 * clipping-polygon cluster ABSORB/DEBT and unowned, names the sibling chunk
 * `csm_clipByPolygons.wgsl` explicitly, and lists `unpackClippingExtents.glsl`
 * among the GLSL files upstream 1.145 deleted. `UP-1`, not any worker-branch
 * record, is what KEEP rests on; re-derive from that row, never from an
 * illustrative anecdote in a governance document.
 *
 * Re-evaluate alongside `csm_clipByPolygons.wgsl` when `UP-1` is funded: wire
 * in only if the absorb design needs a packed-extents unpack step this shape
 * can serve, otherwise remove both chunks together then. Do not delete in
 * this patch.
 */
fn csm_unpackClippingExtents(packedExtents: vec4<f32>) -> vec4<f32> {
    return packedExtents;
}
