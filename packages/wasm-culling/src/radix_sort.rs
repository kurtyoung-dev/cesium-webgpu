//! O(N) radix sort for packed 64-bit sort keys.
//!
//! Sort keys are packed as two 32-bit integers:
//!   High: [layer:4][priority:12][material:16]
//!   Low:  [distance as float32 bit pattern]
//!
//! Radix sort makes 8 byte-passes (4 per word), each O(N).
//! Total: O(8N) = O(N), significantly faster than comparison-based
//! O(N log N) for large command counts.
//!
//! WASM i64 native operations make 64-bit key handling efficient.
//! No BigInt overhead like in JavaScript.

use wasm_bindgen::prelude::*;

/// Radix sort on packed 64-bit keys (high + low 32-bit words).
///
/// Sorts the `indices` array in-place based on the corresponding key values.
/// Uses 8-bit radix (256 buckets) for 8 passes total.
///
/// # Parameters
/// - `indices`: Pointer to u32 array of command indices to sort
/// - `keys_high`: Pointer to u32 array of high 32-bit key words
/// - `keys_low`: Pointer to u32 array of low 32-bit key words
/// - `count`: Number of elements to sort
/// - `temp`: Pointer to u32 scratch array (must be at least `count` elements)
///
/// # Safety
/// All pointers must be valid and point to arrays of at least `count` elements.
#[wasm_bindgen]
pub unsafe fn radix_sort_keys(
    indices: *mut u32,
    keys_high: *const u32,
    keys_low: *const u32,
    count: u32,
    temp: *mut u32,
) {
    let count = count as usize;
    if count <= 1 {
        return;
    }

    // 4 byte-passes for the low word (least significant first)
    for byte in 0..4u32 {
        radix_pass(indices, keys_low, count, byte, temp);
    }

    // 4 byte-passes for the high word (most significant last)
    for byte in 0..4u32 {
        radix_pass(indices, keys_high, count, byte, temp);
    }
}

/// Single radix pass: counting sort on one byte of the key.
///
/// # Safety
/// Same requirements as radix_sort_keys.
#[inline]
unsafe fn radix_pass(
    indices: *mut u32,
    keys: *const u32,
    count: usize,
    byte_index: u32,
    temp: *mut u32,
) {
    let shift = byte_index * 8;

    // Count occurrences of each byte value (0-255)
    let mut counts = [0u32; 256];
    for i in 0..count {
        let idx = *indices.add(i);
        let key_byte = ((*keys.add(idx as usize)) >> shift) & 0xFF;
        counts[key_byte as usize] += 1;
    }

    // Prefix sum (exclusive) — converts counts to offsets
    let mut sum: u32 = 0;
    for i in 0..256 {
        let c = counts[i];
        counts[i] = sum;
        sum += c;
    }

    // Scatter: place each element at its sorted position
    for i in 0..count {
        let idx = *indices.add(i);
        let key_byte = ((*keys.add(idx as usize)) >> shift) & 0xFF;
        let dest = counts[key_byte as usize] as usize;
        *temp.add(dest) = idx;
        counts[key_byte as usize] += 1;
    }

    // Copy sorted result back to indices
    core::ptr::copy_nonoverlapping(temp, indices, count);
}

/// Packs a sort key from its components into high and low 32-bit words.
/// Utility function callable from JS for key preparation.
///
/// # Parameters
/// - `layer`: 0-15 (4 bits)
/// - `priority`: 0-4095 (12 bits)
/// - `material`: 0-65535 (16 bits)
/// - `distance`: float32 distance to camera
/// - `back_to_front`: if true, flip distance bits for reverse sort
///
/// # Returns
/// Packed key as [high_word, low_word] via output pointer.
#[wasm_bindgen]
pub unsafe fn pack_sort_key(
    layer: u32,
    priority: u32,
    material: u32,
    distance: f32,
    back_to_front: bool,
    out_high: *mut u32,
    out_low: *mut u32,
) {
    // High 32 bits: [layer:4][priority:12][material:16]
    let high = ((layer & 0xF) << 28) | ((priority & 0xFFF) << 16) | (material & 0xFFFF);

    // Low 32 bits: distance as float32 bit pattern
    let mut dist_bits = distance.to_bits();
    if back_to_front {
        dist_bits = !dist_bits; // Flip bits for reverse sort order
    }

    *out_high = high;
    *out_low = dist_bits;
}
