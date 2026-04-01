//! SIMD-accelerated batch matrix operations.
//!
//! CesiumJS computes a 4×4 model matrix per entity per frame. For scenes with
//! thousands of entities (billboards, points, models), this is a major CPU cost.
//!
//! This module provides batch Matrix4 × Vector4 multiplication using WASM SIMD.
//! Each mat4×vec4 multiply is 4 dot products — f32x4 does one row at a time.
//!
//! Expected speedup: 2-4x over JS Matrix4.multiplyByPoint for batch operations.

use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

/// Batch multiply a single 4×4 matrix by N 3D points (w=1 implied).
///
/// This is the common case: one model matrix applied to many vertices.
/// Output is 3D (xyz), discarding the w component.
///
/// # Parameters
/// - `matrix`: Pointer to 16 f32 values (column-major, matching CesiumJS Matrix4)
/// - `points_x/y/z`: Input point coordinates (SOA layout, count elements each)
/// - `count`: Number of points
/// - `out_x/y/z`: Output transformed coordinates (count elements each)
#[wasm_bindgen]
pub unsafe fn batch_transform_points(
    matrix: *const f32,
    points_x: *const f32,
    points_y: *const f32,
    points_z: *const f32,
    count: u32,
    out_x: *mut f32,
    out_y: *mut f32,
    out_z: *mut f32,
) {
    let n = count as usize;

    // Load matrix columns (CesiumJS uses column-major order)
    // Column 0: m[0], m[1], m[2], m[3]
    // Column 1: m[4], m[5], m[6], m[7]
    // Column 2: m[8], m[9], m[10], m[11]
    // Column 3: m[12], m[13], m[14], m[15]
    let m00 = *matrix.add(0);
    let m01 = *matrix.add(4);
    let m02 = *matrix.add(8);
    let m03 = *matrix.add(12);
    let m10 = *matrix.add(1);
    let m11 = *matrix.add(5);
    let m12 = *matrix.add(9);
    let m13 = *matrix.add(13);
    let m20 = *matrix.add(2);
    let m21 = *matrix.add(6);
    let m22 = *matrix.add(10);
    let m23 = *matrix.add(14);

    #[cfg(target_arch = "wasm32")]
    {
        let vm00 = f32x4_splat(m00);
        let vm01 = f32x4_splat(m01);
        let vm02 = f32x4_splat(m02);
        let vm03 = f32x4_splat(m03);
        let vm10 = f32x4_splat(m10);
        let vm11 = f32x4_splat(m11);
        let vm12 = f32x4_splat(m12);
        let vm13 = f32x4_splat(m13);
        let vm20 = f32x4_splat(m20);
        let vm21 = f32x4_splat(m21);
        let vm22 = f32x4_splat(m22);
        let vm23 = f32x4_splat(m23);

        let batches = n / 4;
        for batch in 0..batches {
            let base = batch * 4;

            let px = v128_load(points_x.add(base) as *const v128);
            let py = v128_load(points_y.add(base) as *const v128);
            let pz = v128_load(points_z.add(base) as *const v128);

            // result.x = m00*px + m01*py + m02*pz + m03
            let rx = f32x4_add(
                f32x4_add(f32x4_mul(vm00, px), f32x4_mul(vm01, py)),
                f32x4_add(f32x4_mul(vm02, pz), vm03),
            );
            // result.y = m10*px + m11*py + m12*pz + m13
            let ry = f32x4_add(
                f32x4_add(f32x4_mul(vm10, px), f32x4_mul(vm11, py)),
                f32x4_add(f32x4_mul(vm12, pz), vm13),
            );
            // result.z = m20*px + m21*py + m22*pz + m23
            let rz = f32x4_add(
                f32x4_add(f32x4_mul(vm20, px), f32x4_mul(vm21, py)),
                f32x4_add(f32x4_mul(vm22, pz), vm23),
            );

            v128_store(out_x.add(base) as *mut v128, rx);
            v128_store(out_y.add(base) as *mut v128, ry);
            v128_store(out_z.add(base) as *mut v128, rz);
        }

        let start = batches * 4;
        for i in start..n {
            let px = *points_x.add(i);
            let py = *points_y.add(i);
            let pz = *points_z.add(i);
            *out_x.add(i) = m00 * px + m01 * py + m02 * pz + m03;
            *out_y.add(i) = m10 * px + m11 * py + m12 * pz + m13;
            *out_z.add(i) = m20 * px + m21 * py + m22 * pz + m23;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        for i in 0..n {
            let px = *points_x.add(i);
            let py = *points_y.add(i);
            let pz = *points_z.add(i);
            *out_x.add(i) = m00 * px + m01 * py + m02 * pz + m03;
            *out_y.add(i) = m10 * px + m11 * py + m12 * pz + m13;
            *out_z.add(i) = m20 * px + m21 * py + m22 * pz + m23;
        }
    }
}

/// Batch multiply N different 4×4 matrices by their corresponding 3D points.
///
/// Each entity has its own model matrix. This processes them all at once.
/// Matrices are packed contiguously: [mat0(16 floats), mat1(16 floats), ...]
///
/// # Parameters
/// - `matrices`: Pointer to N×16 f32 values (N column-major matrices packed)
/// - `points_x/y/z`: Input point coordinates (count elements each)
/// - `count`: Number of point/matrix pairs
/// - `out_x/y/z`: Output transformed coordinates (count elements each)
#[wasm_bindgen]
pub unsafe fn batch_transform_per_entity(
    matrices: *const f32,
    points_x: *const f32,
    points_y: *const f32,
    points_z: *const f32,
    count: u32,
    out_x: *mut f32,
    out_y: *mut f32,
    out_z: *mut f32,
) {
    let n = count as usize;

    for i in 0..n {
        let m = matrices.add(i * 16);
        let px = *points_x.add(i);
        let py = *points_y.add(i);
        let pz = *points_z.add(i);

        // Column-major: m[col*4 + row]
        *out_x.add(i) = *m.add(0) * px + *m.add(4) * py + *m.add(8) * pz + *m.add(12);
        *out_y.add(i) = *m.add(1) * px + *m.add(5) * py + *m.add(9) * pz + *m.add(13);
        *out_z.add(i) = *m.add(2) * px + *m.add(6) * py + *m.add(10) * pz + *m.add(14);
    }
}

/// Batch multiply two 4×4 matrices: result = A × B for N matrix pairs.
///
/// Used for computing modelView = view × model for each entity.
///
/// # Parameters
/// - `a_matrices`: N column-major 4×4 matrices (16*N floats)
/// - `b_matrix`: Single column-major 4×4 matrix (16 floats) — applied to all
/// - `count`: Number of A matrices
/// - `out_matrices`: Output N column-major 4×4 matrices (16*N floats)
#[wasm_bindgen]
pub unsafe fn batch_mat4_multiply(
    a_matrices: *const f32,
    b_matrix: *const f32,
    count: u32,
    out_matrices: *mut f32,
) {
    let n = count as usize;

    for i in 0..n {
        let a = a_matrices.add(i * 16);
        let o = out_matrices.add(i * 16);

        // Standard 4×4 matrix multiply (column-major)
        for col in 0..4 {
            for row in 0..4 {
                let mut sum: f32 = 0.0;
                for k in 0..4 {
                    sum += *a.add(k * 4 + row) * *b_matrix.add(col * 4 + k);
                }
                *o.add(col * 4 + row) = sum;
            }
        }
    }
}
