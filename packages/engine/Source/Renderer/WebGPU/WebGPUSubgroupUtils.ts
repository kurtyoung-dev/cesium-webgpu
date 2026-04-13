/**
 * @module WebGPUSubgroupUtils
 *
 * Subgroup operation utilities for SIMD-like GPU computation.
 * Requires the 'subgroups' feature (Chrome 132+ origin trial).
 *
 * Subgroups enable threads within a workgroup to communicate directly
 * via SIMD-style operations (broadcast, reduce, ballot, shuffle) without
 * going through shared memory. This is 2-4x faster for:
 *
 * - Prefix sum (for point cloud rendering)
 * - Reduction (for atmosphere scattering LUT computation)
 * - Histogram (for HDR tonemapping)
 * - Ballot (for conditional processing)
 *
 * WGSL subgroup operations:
 *   enable subgroups;
 *   subgroupBroadcast(value, id)
 *   subgroupAdd(value)   — sum across subgroup
 *   subgroupMin(value)   — min across subgroup
 *   subgroupMax(value)   — max across subgroup
 *   subgroupBallot(cond) — bitmask of threads where cond is true
 *   subgroupShuffle(value, id) — read another thread's value
 *   subgroupExclusiveAdd(value) — exclusive prefix sum
 *
 * @example
 * if (WebGPUSubgroupUtils.isSupported(device)) {
 *   const wgsl = WebGPUSubgroupUtils.generatePrefixSumWGSL();
 *   // Use in compute shader for point cloud rendering
 * }
 */

/// <reference types="@webgpu/types" />

/**
 * Subgroup feature information.
 */
export interface SubgroupInfo {
  /** Whether subgroups are supported */
  supported: boolean;
  /** Subgroup size (typically 32 on NVIDIA/Intel, 64 on AMD) */
  subgroupSize: number;
  /** Whether subgroups-f16 is also supported */
  supportsF16: boolean;
  /** Description string */
  description: string;
}

/**
 * Utilities for WebGPU subgroup operations.
 *
 * Subgroups provide SIMD-like communication between threads in the same
 * wave/warp without explicit shared memory. This enables efficient
 * parallel primitives like prefix sum, reduction, and ballot.
 */
export class WebGPUSubgroupUtils {
  /**
   * Check if the device supports subgroups.
   *
   * @param device - The GPU device
   * @returns Whether subgroups are available
   */
  static isSupported(device: GPUDevice): boolean {
    return device.features.has("subgroups" as GPUFeatureName);
  }

  /**
   * Get subgroup feature information.
   *
   * @param device - The GPU device
   * @param adapter - The GPU adapter (for limit queries)
   * @returns Subgroup capability info
   */
  static getInfo(device: GPUDevice, adapter?: GPUAdapter): SubgroupInfo {
    const supported = WebGPUSubgroupUtils.isSupported(device);
    const supportsF16 = device.features.has("subgroups-f16" as GPUFeatureName);

    // Subgroup size is typically reported via adapter limits
    // Default to 32 (NVIDIA/Intel typical)
    let subgroupSize = 32;
    if (adapter) {
      const limits = adapter.limits as GPUSupportedLimits & {
        minSubgroupSize?: number;
        maxSubgroupSize?: number;
      };
      if (limits.minSubgroupSize) {
        subgroupSize = limits.minSubgroupSize;
      }
    }

    return {
      supported,
      subgroupSize,
      supportsF16,
      description: supported
        ? `Subgroups enabled (size: ${subgroupSize}, f16: ${supportsF16})`
        : "Subgroups not available",
    };
  }

  /**
   * Generate WGSL code for a subgroup-based parallel reduction.
   * Computes the sum/min/max of values across a workgroup efficiently.
   *
   * @param operation - 'add' | 'min' | 'max'
   * @param valueType - 'f32' | 'u32' | 'i32'
   * @returns WGSL code snippet
   */
  static generateReductionWGSL(
    operation: "add" | "min" | "max" = "add",
    valueType: "f32" | "u32" | "i32" = "f32",
  ): string {
    const opMap = {
      add: "subgroupAdd",
      min: "subgroupMin",
      max: "subgroupMax",
    };
    const subgroupOp = opMap[operation];

    return `
enable subgroups;

// Subgroup reduction: computes ${operation} across all threads in the subgroup
fn subgroupReduce_${operation}(value: ${valueType}) -> ${valueType} {
  return ${subgroupOp}(value);
}
`.trim();
  }

  /**
   * Generate WGSL code for subgroup-based exclusive prefix sum.
   * Each thread gets the sum of all values from threads with lower IDs.
   *
   * This is the core primitive for stream compaction (used in point cloud
   * rendering, particle emission, and GPU-driven draw call generation).
   *
   * @param valueType - 'f32' | 'u32' | 'i32'
   * @returns WGSL code snippet
   */
  static generatePrefixSumWGSL(
    valueType: "f32" | "u32" | "i32" = "u32",
  ): string {
    return `
enable subgroups;

// Exclusive prefix sum within a subgroup
// Thread i gets sum of values from threads 0..i-1
fn subgroupPrefixSum(value: ${valueType}) -> ${valueType} {
  return subgroupExclusiveAdd(value);
}

// Inclusive prefix sum (includes own value)
fn subgroupInclusivePrefixSum(value: ${valueType}) -> ${valueType} {
  return subgroupExclusiveAdd(value) + value;
}
`.trim();
  }

  /**
   * Generate WGSL code for subgroup ballot operation.
   * Returns a bitmask indicating which threads satisfy a condition.
   *
   * Useful for conditional processing: count how many threads need
   * a particular path, then process them efficiently.
   *
   * @returns WGSL code snippet
   */
  static generateBallotWGSL(): string {
    return `
enable subgroups;

// Ballot: returns bitmask of threads where condition is true
// Use countOneBits() to count how many threads satisfy the condition
fn subgroupCountTrue(condition: bool) -> u32 {
  let ballot = subgroupBallot(condition);
  // ballot is vec4<u32>, count bits in first component for subgroup size <= 32
  return countOneBits(ballot.x);
}

// Broadcast a value from a specific thread to all others
fn subgroupBroadcastFrom(value: f32, sourceId: u32) -> f32 {
  return subgroupBroadcast(value, sourceId);
}
`.trim();
  }

  /**
   * Generate WGSL code for a complete workgroup reduction using subgroups.
   * Handles workgroup sizes larger than the subgroup size by combining
   * subgroup reductions with shared memory.
   *
   * @param workgroupSize - The workgroup size (e.g., 256)
   * @param subgroupSize - Expected subgroup size (e.g., 32)
   * @returns WGSL code for a full workgroup reduction
   */
  static generateWorkgroupReductionWGSL(
    workgroupSize: number = 256,
    subgroupSize: number = 32,
  ): string {
    const numSubgroups = Math.ceil(workgroupSize / subgroupSize);

    return `
enable subgroups;

var<workgroup> subgroupResults: array<f32, ${numSubgroups}>;

// Full workgroup reduction using subgroups + shared memory
// Step 1: Each subgroup reduces internally (fast, no shared memory)
// Step 2: First subgroup reduces the partial results (shared memory)
fn workgroupReduceAdd(
  value: f32,
  localId: u32,
  subgroupId: u32,
  subgroupLocalId: u32,
) -> f32 {
  // Step 1: Subgroup-level reduction
  let subgroupSum = subgroupAdd(value);

  // Step 2: Write subgroup results to shared memory
  if (subgroupLocalId == 0u) {
    subgroupResults[subgroupId] = subgroupSum;
  }
  workgroupBarrier();

  // Step 3: First subgroup reduces the partial results
  var total = 0.0;
  if (subgroupId == 0u && subgroupLocalId < ${numSubgroups}u) {
    total = subgroupAdd(subgroupResults[subgroupLocalId]);
  }

  return total;
}
`.trim();
  }

  /**
   * Get the list of WebGPU features needed for subgroup support.
   * Use these when requesting the device.
   *
   * @returns Array of feature names to request
   */
  static getRequiredFeatures(): GPUFeatureName[] {
    return ["subgroups" as GPUFeatureName];
  }
}

export default WebGPUSubgroupUtils;
