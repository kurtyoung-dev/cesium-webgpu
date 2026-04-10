/**
 * Analytic ray-ellipsoid intersection in model space.
 *
 * Returns `(t0, t1)` for the front and back hit parameters along the ray
 * `origin + t * dir`, or `(-1, -1)` on miss. The trick is to scale the ray
 * by `sqrt(oneOverRadiiSquared)` so the ellipsoid becomes a unit sphere
 * and we can do a plain quadratic sphere intersection.
 *
 * This is the same math used by Moon.wgsl (Phase 1.2c v2) and the
 * orphan `Generated/EllipsoidPrimitive.wgsl`. Extracting it into a chunk
 * lets future ellipsoid renderers (Sun-as-ellipsoid, custom planets,
 * asteroid models) share the implementation instead of copy-pasting.
 *
 * @chunk functions/csm_intersectEllipsoid
 */
fn csm_intersectEllipsoid(
    rayOriginMC: vec3<f32>,
    rayDirMC: vec3<f32>,
    oneOverRadiiSquared: vec3<f32>,
) -> vec2<f32> {
    let sqrtOORS = sqrt(oneOverRadiiSquared);
    let oScaled = rayOriginMC * sqrtOORS;
    let dScaled = rayDirMC * sqrtOORS;

    let a = dot(dScaled, dScaled);
    let b = 2.0 * dot(dScaled, oScaled);
    let c = dot(oScaled, oScaled) - 1.0;

    let disc = b * b - 4.0 * a * c;
    if (disc < 0.0) {
        return vec2<f32>(-1.0, -1.0);
    }
    let sqrtDisc = sqrt(disc);
    let t0 = (-b - sqrtDisc) / (2.0 * a);
    let t1 = (-b + sqrtDisc) / (2.0 * a);
    return vec2<f32>(t0, t1);
}
