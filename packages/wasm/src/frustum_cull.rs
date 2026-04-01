//! SIMD-accelerated batch frustum culling.
//!
//! Tests N bounding spheres against 6 frustum planes using WASM SIMD.
//! Each sphere-plane test is a dot product + distance comparison.
//! f32x4 SIMD processes 4 spheres per instruction cycle.
//!
//! Algorithm:
//!   For each sphere: visible = true
//!   For each of 6 planes:
//!     dot = plane.normal · sphere.center + plane.distance
//!     if dot < -sphere.radius: visible = false; break
//!   Write visibility to output buffer

use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

/// Batch frustum culling with WASM SIMD.
///
/// # Parameters
/// - `center_x`: Pointer to f32 array of sphere center X coords (ECEF)
/// - `center_y`: Pointer to f32 array of sphere center Y coords (ECEF)
/// - `center_z`: Pointer to f32 array of sphere center Z coords (ECEF)
/// - `radii`: Pointer to f32 array of sphere radii
/// - `planes`: Pointer to f32 array of 24 floats (6 planes × [nx, ny, nz, d])
/// - `visibility`: Pointer to u8 output array (0 = culled, 1 = visible)
/// - `count`: Number of spheres to test
///
/// # Returns
/// Number of visible spheres.
///
/// # Safety
/// All pointers must be valid and point to arrays of at least `count` elements.
/// `planes` must point to at least 24 f32 values.
#[wasm_bindgen]
pub unsafe fn frustum_cull_batch(
    center_x: *const f32,
    center_y: *const f32,
    center_z: *const f32,
    radii: *const f32,
    planes: *const f32,
    visibility: *mut u8,
    count: u32,
) -> u32 {
    let count = count as usize;
    let mut visible_count: u32 = 0;

    // Load 6 frustum planes into SIMD-friendly layout
    // Each plane is [nx, ny, nz, d]
    let mut plane_nx = [0.0f32; 6];
    let mut plane_ny = [0.0f32; 6];
    let mut plane_nz = [0.0f32; 6];
    let mut plane_d = [0.0f32; 6];

    for i in 0..6 {
        let offset = i * 4;
        plane_nx[i] = *planes.add(offset);
        plane_ny[i] = *planes.add(offset + 1);
        plane_nz[i] = *planes.add(offset + 2);
        plane_d[i] = *planes.add(offset + 3);
    }

    // Process spheres in batches of 4 (f32x4 SIMD)
    let batches = count / 4;
    let _remainder = count % 4;

    #[cfg(target_arch = "wasm32")]
    {
        for batch in 0..batches {
            let base = batch * 4;

            // Load 4 sphere centers and radii
            let cx = v128_load(center_x.add(base) as *const v128);
            let cy = v128_load(center_y.add(base) as *const v128);
            let cz = v128_load(center_z.add(base) as *const v128);
            let r = v128_load(radii.add(base) as *const v128);
            let neg_r = f32x4_neg(r);

            // Start with all visible (all bits set)
            let mut vis_mask = u32x4_splat(1);

            // Test against each frustum plane
            for p in 0..6 {
                let nx = f32x4_splat(plane_nx[p]);
                let ny = f32x4_splat(plane_ny[p]);
                let nz = f32x4_splat(plane_nz[p]);
                let d = f32x4_splat(plane_d[p]);

                // dot = nx*cx + ny*cy + nz*cz + d
                let dot = f32x4_add(
                    f32x4_add(f32x4_mul(nx, cx), f32x4_mul(ny, cy)),
                    f32x4_add(f32x4_mul(nz, cz), d),
                );

                // If dot < -radius, sphere is outside this plane
                let outside = f32x4_lt(dot, neg_r);

                // Clear visibility for spheres outside this plane
                vis_mask = v128_andnot(vis_mask, outside);
            }

            // Extract results: for each lane, write 1 if visible, 0 if culled
            let v0 = u32x4_extract_lane::<0>(vis_mask);
            let v1 = u32x4_extract_lane::<1>(vis_mask);
            let v2 = u32x4_extract_lane::<2>(vis_mask);
            let v3 = u32x4_extract_lane::<3>(vis_mask);

            *visibility.add(base) = (v0 != 0) as u8;
            *visibility.add(base + 1) = (v1 != 0) as u8;
            *visibility.add(base + 2) = (v2 != 0) as u8;
            *visibility.add(base + 3) = (v3 != 0) as u8;

            visible_count += v0.min(1) + v1.min(1) + v2.min(1) + v3.min(1);
        }
    }

    // Process remaining spheres (scalar fallback)
    let scalar_start = batches * 4;
    for i in scalar_start..count {
        let cx = *center_x.add(i);
        let cy = *center_y.add(i);
        let cz = *center_z.add(i);
        let r = *radii.add(i);
        let mut visible = true;

        for p in 0..6 {
            let dot = plane_nx[p] * cx + plane_ny[p] * cy + plane_nz[p] * cz + plane_d[p];
            if dot < -r {
                visible = false;
                break;
            }
        }

        *visibility.add(i) = visible as u8;
        if visible {
            visible_count += 1;
        }
    }

    visible_count
}
