/**
 * Voxel ray-volume intersection utilities.
 * Consolidated port of IntersectBox, IntersectCylinder, IntersectEllipsoid,
 * IntersectDepth, IntersectionUtils.glsl.
 */

struct VoxelIntersection {
    tNear: f32,
    tFar: f32,
    hit: bool,
};

fn csm_intersectBox(rayOrigin: vec3<f32>, rayDir: vec3<f32>, boxMin: vec3<f32>, boxMax: vec3<f32>) -> VoxelIntersection {
    var result: VoxelIntersection;
    let invDir: vec3<f32> = 1.0 / rayDir;
    let t0: vec3<f32> = (boxMin - rayOrigin) * invDir;
    let t1: vec3<f32> = (boxMax - rayOrigin) * invDir;
    let tmin: vec3<f32> = min(t0, t1);
    let tmax: vec3<f32> = max(t0, t1);
    result.tNear = max(max(tmin.x, tmin.y), tmin.z);
    result.tFar = min(min(tmax.x, tmax.y), tmax.z);
    result.hit = result.tNear <= result.tFar && result.tFar > 0.0;
    return result;
}

fn csm_intersectSphere(rayOrigin: vec3<f32>, rayDir: vec3<f32>, center: vec3<f32>, radius: f32) -> VoxelIntersection {
    var result: VoxelIntersection;
    let oc: vec3<f32> = rayOrigin - center;
    let a: f32 = dot(rayDir, rayDir);
    let b: f32 = 2.0 * dot(oc, rayDir);
    let c: f32 = dot(oc, oc) - radius * radius;
    let disc: f32 = b * b - 4.0 * a * c;
    if (disc < 0.0) {
        result.hit = false;
        result.tNear = -1.0;
        result.tFar = -1.0;
        return result;
    }
    let sd: f32 = sqrt(disc);
    result.tNear = (-b - sd) / (2.0 * a);
    result.tFar = (-b + sd) / (2.0 * a);
    result.hit = result.tFar > 0.0;
    return result;
}

fn csm_intersectCylinder(
    rayOrigin: vec3<f32>,
    rayDir: vec3<f32>,
    cylinderCenter: vec3<f32>,
    cylinderAxis: vec3<f32>,
    radius: f32,
    halfHeight: f32
) -> VoxelIntersection {
    var result: VoxelIntersection;
    let oc: vec3<f32> = rayOrigin - cylinderCenter;
    let dDotA: f32 = dot(rayDir, cylinderAxis);
    let ocDotA: f32 = dot(oc, cylinderAxis);
    let a: f32 = dot(rayDir, rayDir) - dDotA * dDotA;
    let b: f32 = 2.0 * (dot(oc, rayDir) - dDotA * ocDotA);
    let c: f32 = dot(oc, oc) - ocDotA * ocDotA - radius * radius;
    let disc: f32 = b * b - 4.0 * a * c;
    if (disc < 0.0) {
        result.hit = false;
        return result;
    }
    let sd: f32 = sqrt(disc);
    var t0: f32 = (-b - sd) / (2.0 * a);
    var t1: f32 = (-b + sd) / (2.0 * a);
    // Clamp to height
    let h0: f32 = ocDotA + t0 * dDotA;
    let h1: f32 = ocDotA + t1 * dDotA;
    if (abs(h0) > halfHeight) { t0 = t1; }
    if (abs(h1) > halfHeight) { t1 = t0; }
    result.tNear = t0;
    result.tFar = t1;
    result.hit = t1 > 0.0;
    return result;
}

fn csm_convertLocalToBoxUv(localPos: vec3<f32>, boxMin: vec3<f32>, boxMax: vec3<f32>) -> vec3<f32> {
    return (localPos - boxMin) / (boxMax - boxMin);
}
