//! SIMD-accelerated point cloud processing.
//!
//! Point cloud rendering requires octree traversal, LOD selection, and
//! distance-based sorting — all CPU-intensive for large datasets (>100K points).
//!
//! This module provides:
//! - Batch distance computation for LOD selection
//! - SIMD octree node visibility testing
//! - Distance-based point sorting for front-to-back rendering
//!
//! Expected speedup: 3-5x over JS for >50K point datasets.

use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

/// Batch compute squared distances from a camera position to N points.
///
/// Used for LOD selection — points beyond a distance threshold are culled
/// or rendered at lower detail. Squared distance avoids sqrt.
///
/// # Parameters
/// - `points_x/y/z`: Point positions (SOA, f32, count elements)
/// - `cam_x/y/z`: Camera position (f32)
/// - `count`: Number of points
/// - `out_dist_sq`: Output squared distances (f32, count elements)
#[wasm_bindgen]
pub unsafe fn batch_distance_squared(
    points_x: *const f32,
    points_y: *const f32,
    points_z: *const f32,
    cam_x: f32,
    cam_y: f32,
    cam_z: f32,
    count: u32,
    out_dist_sq: *mut f32,
) {
    let n = count as usize;

    #[cfg(target_arch = "wasm32")]
    {
        let cx = f32x4_splat(cam_x);
        let cy = f32x4_splat(cam_y);
        let cz = f32x4_splat(cam_z);

        let batches = n / 4;
        for batch in 0..batches {
            let base = batch * 4;

            let px = v128_load(points_x.add(base) as *const v128);
            let py = v128_load(points_y.add(base) as *const v128);
            let pz = v128_load(points_z.add(base) as *const v128);

            let dx = f32x4_sub(px, cx);
            let dy = f32x4_sub(py, cy);
            let dz = f32x4_sub(pz, cz);

            let dist_sq = f32x4_add(
                f32x4_add(f32x4_mul(dx, dx), f32x4_mul(dy, dy)),
                f32x4_mul(dz, dz),
            );

            v128_store(out_dist_sq.add(base) as *mut v128, dist_sq);
        }

        let start = batches * 4;
        for i in start..n {
            let dx = *points_x.add(i) - cam_x;
            let dy = *points_y.add(i) - cam_y;
            let dz = *points_z.add(i) - cam_z;
            *out_dist_sq.add(i) = dx * dx + dy * dy + dz * dz;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        for i in 0..n {
            let dx = *points_x.add(i) - cam_x;
            let dy = *points_y.add(i) - cam_y;
            let dz = *points_z.add(i) - cam_z;
            *out_dist_sq.add(i) = dx * dx + dy * dy + dz * dz;
        }
    }
}

/// LOD selection: filter points by distance threshold.
///
/// For each point, if dist² ≤ threshold², mark it visible (1), else culled (0).
/// Returns the number of visible points.
///
/// # Parameters
/// - `dist_sq`: Squared distances (from batch_distance_squared)
/// - `threshold_sq`: Maximum squared distance for visibility
/// - `count`: Number of points
/// - `visibility`: Output u8 array (1=visible, 0=culled)
///
/// # Returns
/// Number of visible points.
#[wasm_bindgen]
pub unsafe fn lod_filter(
    dist_sq: *const f32,
    threshold_sq: f32,
    count: u32,
    visibility: *mut u8,
) -> u32 {
    let n = count as usize;
    let mut visible_count: u32 = 0;

    #[cfg(target_arch = "wasm32")]
    {
        let thresh = f32x4_splat(threshold_sq);
        let batches = n / 4;

        for batch in 0..batches {
            let base = batch * 4;
            let d = v128_load(dist_sq.add(base) as *const v128);

            // d <= threshold → visible
            let mask = f32x4_le(d, thresh);

            let v0 = (u32x4_extract_lane::<0>(mask) != 0) as u8;
            let v1 = (u32x4_extract_lane::<1>(mask) != 0) as u8;
            let v2 = (u32x4_extract_lane::<2>(mask) != 0) as u8;
            let v3 = (u32x4_extract_lane::<3>(mask) != 0) as u8;

            *visibility.add(base) = v0;
            *visibility.add(base + 1) = v1;
            *visibility.add(base + 2) = v2;
            *visibility.add(base + 3) = v3;

            visible_count += (v0 + v1 + v2 + v3) as u32;
        }

        let start = batches * 4;
        for i in start..n {
            let vis = (*dist_sq.add(i) <= threshold_sq) as u8;
            *visibility.add(i) = vis;
            visible_count += vis as u32;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        for i in 0..n {
            let vis = (*dist_sq.add(i) <= threshold_sq) as u8;
            *visibility.add(i) = vis;
            visible_count += vis as u32;
        }
    }

    visible_count
}

/// Compact visible point indices into a dense output array.
///
/// After LOD filtering, this gathers only the visible point indices
/// into a contiguous array for efficient rendering.
///
/// # Parameters
/// - `visibility`: Visibility flags (from lod_filter)
/// - `count`: Total number of points
/// - `out_indices`: Output array of visible point indices
///
/// # Returns
/// Number of visible indices written.
#[wasm_bindgen]
pub unsafe fn compact_visible(
    visibility: *const u8,
    count: u32,
    out_indices: *mut u32,
) -> u32 {
    let n = count as usize;
    let mut write_idx: usize = 0;

    for i in 0..n {
        if *visibility.add(i) != 0 {
            *out_indices.add(write_idx) = i as u32;
            write_idx += 1;
        }
    }

    write_idx as u32
}

/// Batch octree node AABB-frustum test.
///
/// Tests N axis-aligned bounding boxes against 6 frustum planes.
/// Each AABB is defined by center + half-extents.
/// This is the octree node visibility test used during traversal.
///
/// # Parameters
/// - `center_x/y/z`: AABB center coordinates (f32, count elements)
/// - `half_x/y/z`: AABB half-extents (f32, count elements)
/// - `planes`: 6 frustum planes (24 f32: [nx,ny,nz,d] × 6)
/// - `count`: Number of AABBs
/// - `visibility`: Output u8 (1=visible, 0=culled)
///
/// # Returns
/// Number of visible nodes.
#[wasm_bindgen]
pub unsafe fn batch_aabb_frustum_test(
    center_x: *const f32,
    center_y: *const f32,
    center_z: *const f32,
    half_x: *const f32,
    half_y: *const f32,
    half_z: *const f32,
    planes: *const f32,
    count: u32,
    visibility: *mut u8,
) -> u32 {
    let n = count as usize;
    let mut visible_count: u32 = 0;

    // Load plane normals and distances
    let mut pnx = [0.0f32; 6];
    let mut pny = [0.0f32; 6];
    let mut pnz = [0.0f32; 6];
    let mut pd = [0.0f32; 6];
    for p in 0..6 {
        pnx[p] = *planes.add(p * 4);
        pny[p] = *planes.add(p * 4 + 1);
        pnz[p] = *planes.add(p * 4 + 2);
        pd[p] = *planes.add(p * 4 + 3);
    }

    for i in 0..n {
        let cx = *center_x.add(i);
        let cy = *center_y.add(i);
        let cz = *center_z.add(i);
        let hx = *half_x.add(i);
        let hy = *half_y.add(i);
        let hz = *half_z.add(i);

        let mut vis = true;
        for p in 0..6 {
            // Signed distance from AABB center to plane
            let dist = pnx[p] * cx + pny[p] * cy + pnz[p] * cz + pd[p];
            // Effective radius = dot(|normal|, half_extents)
            let eff_radius = pnx[p].abs() * hx + pny[p].abs() * hy + pnz[p].abs() * hz;
            if dist < -eff_radius {
                vis = false;
                break;
            }
        }

        *visibility.add(i) = vis as u8;
        if vis {
            visible_count += 1;
        }
    }

    visible_count
}
