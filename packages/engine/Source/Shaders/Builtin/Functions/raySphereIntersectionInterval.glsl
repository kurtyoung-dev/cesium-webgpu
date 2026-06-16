/**
 * Compute the intersection interval of a ray with a sphere.
 *
 * @name czm_raySphereIntersectionInterval
 * @glslFunction
 *
 * @param {czm_ray} ray The ray.
 * @param {vec3} center The center of the sphere.
 * @param {float} radius The radius of the sphere.
 * @return {czm_raySegment} The intersection interval of the ray with the sphere.
 */
czm_raySegment czm_raySphereIntersectionInterval(czm_ray ray, vec3 center, float radius)
{
    vec3 o = ray.origin;
    vec3 d = ray.direction;

    vec3 oc = o - center;

    // NEW-RAYSPHERE-PRECISION-BACKPORT (Batch 304): the naive form
    // computes `c = dot(oc, oc) - radius * radius`. At Cesium scale the
    // camera origin sits ~6.4e6 m from the ellipsoid centre, so `dot(oc,
    // oc)` is ~4e13 and `radius * radius` is ~4e13 — subtracting two near-
    // equal numbers beyond f32's 24-bit mantissa integer range (2^24 ≈
    // 1.6e7) loses ~10 m of precision in `c`, which propagates into the
    // discriminant and the t-interval (visible as a wobbling atmosphere
    // limb / banded scattering at orbital altitude). The WebGPU
    // `GlobeTerrain.wgsl::raySphereIntersectionInterval` already scales
    // the origin by 1/radius to keep every intermediate in the [-10, 10]
    // range where f32 precision is ~1e-6; this is the same fix ported back
    // so every GLSL ray-sphere consumer (sky atmosphere, ground
    // atmosphere, radiance map, computeScattering) benefits. The general
    // (non-normalized-direction) form is preserved: dividing the whole
    // quadratic by radius^2 yields A = a/radius^2, B = b/radius^2, and the
    // precision-stable C = dot(ocScaled, ocScaled) - 1; the radius^2 factor
    // cancels in the root ratio so the returned t-values stay in world
    // units.
    float invR = 1.0 / max(radius, czm_epsilon7);
    vec3 ocScaled = oc * invR;

    float a = dot(d, d);
    float b = 2.0 * dot(d, oc) * (invR * invR);
    float aScaled = a * (invR * invR);
    float c = dot(ocScaled, ocScaled) - 1.0;

    float det = (b * b) - (4.0 * aScaled * c);

    if (det < 0.0) {
        return czm_emptyRaySegment;
    }

    float sqrtDet = sqrt(det);

    float t0 = (-b - sqrtDet) / (2.0 * aScaled);
    float t1 = (-b + sqrtDet) / (2.0 * aScaled);

    czm_raySegment result = czm_raySegment(t0, t1);
    return result;
}
