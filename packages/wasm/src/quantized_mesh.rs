//! SIMD-accelerated quantized mesh terrain decoding.
//!
//! Quantized mesh terrain tiles encode vertex positions as Uint16 values
//! (0-32767) with delta+zigzag encoding for compression. The decode loop
//! is a hotspot: zigzag decode → delta accumulate → denormalize.
//!
//! WASM SIMD processes 4 vertices per cycle for the denormalization step.
//! The zigzag+delta accumulation is sequential (data dependency) but the
//! subsequent normalization and ECEF conversion benefit from SIMD.
//!
//! Expected speedup: 3-8x over JS for typical quantized mesh tiles.

use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

/// Zigzag decode: maps unsigned to signed (0→0, 1→-1, 2→1, 3→-2, ...)
#[inline(always)]
fn zigzag_decode(val: u16) -> i16 {
    let v = val as i32;
    ((v >> 1) ^ (-(v & 1))) as i16
}

/// Decode quantized mesh vertex data with zigzag + delta encoding.
///
/// Input is three Uint16Arrays (u, v, height) with zigzag+delta encoding.
/// Output is three Float32Arrays with normalized values in [0, 1] range.
///
/// # Parameters
/// - `encoded_u`: Pointer to Uint16 zigzag+delta encoded U coordinates
/// - `encoded_v`: Pointer to Uint16 zigzag+delta encoded V coordinates
/// - `encoded_h`: Pointer to Uint16 zigzag+delta encoded height values
/// - `vertex_count`: Number of vertices
/// - `out_u`: Output f32 array for normalized U [0,1]
/// - `out_v`: Output f32 array for normalized V [0,1]
/// - `out_h`: Output f32 array for normalized height [0,1]
///
/// # Returns
/// Number of vertices decoded.
#[wasm_bindgen]
pub unsafe fn decode_quantized_mesh(
    encoded_u: *const u16,
    encoded_v: *const u16,
    encoded_h: *const u16,
    vertex_count: u32,
    out_u: *mut f32,
    out_v: *mut f32,
    out_h: *mut f32,
) -> u32 {
    let count = vertex_count as usize;
    if count == 0 {
        return 0;
    }

    // Quantized mesh normalization constant: 1/32767
    let norm: f32 = 1.0 / 32767.0;

    // Phase 1: Zigzag decode + delta accumulation (sequential — data dependency)
    let mut u_acc: i32 = 0;
    let mut v_acc: i32 = 0;
    let mut h_acc: i32 = 0;

    for i in 0..count {
        u_acc += zigzag_decode(*encoded_u.add(i)) as i32;
        v_acc += zigzag_decode(*encoded_v.add(i)) as i32;
        h_acc += zigzag_decode(*encoded_h.add(i)) as i32;

        // Store as u16 intermediate (will normalize in SIMD pass)
        *out_u.add(i) = u_acc as f32;
        *out_v.add(i) = v_acc as f32;
        *out_h.add(i) = h_acc as f32;
    }

    // Phase 2: SIMD normalization (parallel — independent per vertex)
    #[cfg(target_arch = "wasm32")]
    {
        let norm_v = f32x4_splat(norm);
        let batches = count / 4;

        for batch in 0..batches {
            let base = batch * 4;

            let u_ptr = out_u.add(base) as *mut v128;
            let v_ptr = out_v.add(base) as *mut v128;
            let h_ptr = out_h.add(base) as *mut v128;

            let u_vals = v128_load(u_ptr as *const v128);
            let v_vals = v128_load(v_ptr as *const v128);
            let h_vals = v128_load(h_ptr as *const v128);

            v128_store(u_ptr, f32x4_mul(u_vals, norm_v));
            v128_store(v_ptr, f32x4_mul(v_vals, norm_v));
            v128_store(h_ptr, f32x4_mul(h_vals, norm_v));
        }

        // Scalar remainder
        let start = batches * 4;
        for i in start..count {
            *out_u.add(i) *= norm;
            *out_v.add(i) *= norm;
            *out_h.add(i) *= norm;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        for i in 0..count {
            *out_u.add(i) *= norm;
            *out_v.add(i) *= norm;
            *out_h.add(i) *= norm;
        }
    }

    count as u32
}

/// Decode triangle indices with high-watermark encoding.
///
/// Quantized mesh uses delta+high-watermark encoding for triangle indices.
/// This is sequential but benefits from WASM's integer arithmetic speed.
///
/// # Parameters
/// - `encoded`: Pointer to encoded Uint16/Uint32 index data
/// - `index_count`: Number of indices (must be multiple of 3)
/// - `is_32bit`: true if indices are Uint32, false for Uint16
/// - `out_indices`: Output Uint32 decoded indices
///
/// # Returns
/// Number of indices decoded.
#[wasm_bindgen]
pub unsafe fn decode_indices(
    encoded: *const u8,
    index_count: u32,
    is_32bit: bool,
    out_indices: *mut u32,
) -> u32 {
    let count = index_count as usize;
    let mut highest: u32 = 0;

    for i in 0..count {
        let code: u32 = if is_32bit {
            let ptr = encoded as *const u32;
            *ptr.add(i)
        } else {
            let ptr = encoded as *const u16;
            *ptr.add(i) as u32
        };

        // High-watermark decode: if code == 0, use highest+1 (new vertex)
        // Otherwise, use highest - code (back-reference)
        if code == 0 {
            *out_indices.add(i) = highest;
            highest += 1;
        } else {
            *out_indices.add(i) = highest - code;
        }
    }

    count as u32
}
