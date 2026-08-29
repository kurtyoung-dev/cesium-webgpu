/**
 * `C12-12` — the star-cube-map **VRAM / streaming policy**: which face
 * resolution {@link SkyBox.createEarthSkyBox} serves by default, which one an
 * application may opt into, and what either costs in video memory.
 *
 * ## Why a policy module exists for what looks like a filename suffix
 *
 * The star cube map is the single largest fixed texture allocation in a
 * default scene, and it is allocated *uncompressed*. Both backends upload the
 * six JPEG faces as `rgba8unorm` with **one mip level**:
 *
 * - WebGPU — `Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js`
 *   `device.createTexture({ size: [size, size, 6], format: "rgba8unorm" })`,
 *   with no `mipLevelCount`, so the default of 1 applies.
 * - WebGL — `Renderer/loadCubeMap.js` builds a `CubeMap` with the constructor
 *   defaults (`PixelFormat.RGBA` + `PixelDatatype.UNSIGNED_BYTE`) and never
 *   calls `generateMipmap()`, so `_hasMipmap` stays false.
 *
 * That makes the cost exactly `6 × faceSize² × 4` bytes on **both** backends —
 * the JPEG's on-disk size is irrelevant once it is decoded:
 *
 * | tier   | VRAM (bytes) | MiB | decimal MB |
 * |--------|--------------|-----|------------|
 * | 1024   | 25,165,824   | 24  | 25.2       |
 * | 2048   | 100,663,296  | 96  | 100.7      |
 * | 4096   | 402,653,184  | 384 | 402.7      |
 *
 * A 4096 cube is therefore a **384 MiB** allocation for the sky alone, which
 * is why it is opt-in and 2048 is the default. This is the "4096/face RGBA8
 * uncompressed ≈ 402 MB" figure the `C12-12` queue row records, reproduced
 * here from the loader's actual format rather than from the row.
 *
 * ## What is bundled at HEAD (read from the tree, not assumed)
 *
 * {@link SKYBOX_BUNDLED_TIERS} is the authoritative table. At the time this
 * module landed the repository ships **one tier per variant**:
 *
 * - `TYCHO_T3` — 1024/face, JPEG 4:2:0, inherited from upstream CesiumJS
 *   (see `C12-13-T3-PROVENANCE-GAP`).
 * - `TYCHO_T5` — 2048/face, JPEG q90 4:4:4, baked by `Tools/skybox-bake/`.
 * - `TYCHO_T5_DIFFUSE` — 2048/face, same bake, low-passed; the default variant.
 *
 * **The 4096 tier is bundled for both t5 variants** (the opt-in tier of the
 * star-map ruling). The bake reprojects to a 4096 master
 * and lanczos3-downsamples to 2048 (`Tools/skybox-bake/skybox-manifest.json`
 * `encode.masterSize = 4096`, `encode.faceSize = 2048`), so the opt-in tier is
 * reproducible but not bundled. This module is the seam that makes installing
 * it a *data* change: add a `"4096"` entry to the variant's row in
 * {@link SKYBOX_BUNDLED_TIERS} with
 * `prefixSuffix: SKYBOX_OPT_IN_TIER_PREFIX_SUFFIX` and the six
 * `<prefix>_4096_<face>.jpg` files. Until then, an explicit 4096 request
 * resolves *down* to what is actually on disk and reports `fallback: true` —
 * it never fabricates a URL that would 404 the sky.
 *
 * The KTX2/compressed-texture half of the `C12-12` row is **not** in scope
 * here and remains tooling-blocked: no KTX2/Basis encoder exists in this repo
 * or on the build machine (`C12-12-KTX2-SKYBOX-NOT-BUNDLED`,
 * `MOON-ALBEDO-KTX2` in `DEFERRED_WORK.md`), and neither consumer path
 * transcodes KTX2 today.
 *
 * Backend-agnostic by construction: the policy chooses *URLs*, which both the
 * WebGL and WebGPU loaders consume identically. There is no shader change and
 * no per-backend branch.
 *
 * @module SkyBoxResolutionPolicy
 */

/**
 * Selectable star-cube-map face resolutions. String-valued to match the
 * {@link SkyBox.Variant} enum shape, so a typo fails loudly instead of
 * silently 404-ing the sky.
 */
export const SkyBoxResolution = Object.freeze({
  /** 1024 px per face — 24 MiB. Only `TYCHO_T3` ships at this size. */
  SIZE_1024: "1024",
  /** 2048 px per face — 96 MiB. The default tier. */
  SIZE_2048: "2048",
  /** 4096 px per face — 384 MiB. Opt-in; see the module header for status. */
  SIZE_4096: "4096",
}) as Readonly<Record<string, string>>;

/**
 * The tier {@link resolveSkyBoxResolution} serves when the caller asks for
 * nothing. 2048 is the `C12-12` ruling: it is the size the bake actually
 * ships, and 4× that in VRAM is not something a default scene should spend.
 */
export const DEFAULT_SKYBOX_RESOLUTION: string = SkyBoxResolution.SIZE_2048;

/**
 * Filename infix a bundled 4096 tier must use: `tycho2t5_80_4096_px.jpg`.
 * Named rather than inlined so the follow-up bake and the policy table cannot
 * disagree about the convention.
 */
export const SKYBOX_OPT_IN_TIER_PREFIX_SUFFIX = "_4096";

/** Bytes per texel of the star cube map on both backends (`rgba8unorm`). */
export const SKYBOX_BYTES_PER_TEXEL = 4;

/** Faces in a cube map. */
export const CUBE_MAP_FACE_COUNT = 6;

/** One bundled resolution tier of one variant. */
export interface SkyBoxTierDescriptor {
  /** Edge length in pixels of each of the six faces. */
  faceSize: number;
  /**
   * Inserted between the variant prefix and the face suffix. Empty for the
   * historically-named tier of each variant, which is what keeps the default
   * URLs byte-identical to what shipped before `C12-12`.
   */
  prefixSuffix: string;
}

/** Variant name → tier value → descriptor. */
export type SkyBoxBundledTierTable = Readonly<
  Record<string, Readonly<Record<string, SkyBoxTierDescriptor>>>
>;

/**
 * The tiers actually present in `packages/engine/Source/Assets/Textures/SkyBox/`.
 *
 * This table is the *claim*; `Tools/visual-regression/skybox-resolution-policy.spec.mjs`
 * is the check — it enumerates the directory and fails if the table promises a
 * face that is not on disk, or if a face appears on disk under a tier the
 * table does not register.
 */
export const SKYBOX_BUNDLED_TIERS: SkyBoxBundledTierTable = Object.freeze({
  TYCHO_T3: Object.freeze({
    "1024": Object.freeze({ faceSize: 1024, prefixSuffix: "" }),
  }),
  TYCHO_T5: Object.freeze({
    "2048": Object.freeze({ faceSize: 2048, prefixSuffix: "" }),
    "4096": Object.freeze({
      faceSize: 4096,
      prefixSuffix: SKYBOX_OPT_IN_TIER_PREFIX_SUFFIX,
    }),
  }),
  TYCHO_T5_DIFFUSE: Object.freeze({
    "2048": Object.freeze({ faceSize: 2048, prefixSuffix: "" }),
    "4096": Object.freeze({
      faceSize: 4096,
      prefixSuffix: SKYBOX_OPT_IN_TIER_PREFIX_SUFFIX,
    }),
  }),
});

/** Why {@link resolveSkyBoxResolution} served the tier it served. */
export type SkyBoxResolutionReasonValue =
  | "exact"
  | "tier-not-bundled"
  | "unknown-variant"
  | "unknown-resolution"
  | "device-limit";

/** Enumerated {@link SkyBoxResolutionReasonValue} constants. */
export const SkyBoxResolutionReason = Object.freeze({
  /** The requested tier is bundled and fits the device. */
  EXACT: "exact",
  /** The requested tier is not bundled for this variant; served the closest. */
  TIER_NOT_BUNDLED: "tier-not-bundled",
  /** The variant has no entry in the tier table at all. */
  UNKNOWN_VARIANT: "unknown-variant",
  /** The requested value is not a {@link SkyBoxResolution} member. */
  UNKNOWN_RESOLUTION: "unknown-resolution",
  /** Stepped down because the tier exceeded `maximumCubeMapSize`. */
  DEVICE_LIMIT: "device-limit",
}) as Readonly<Record<string, SkyBoxResolutionReasonValue>>;

/** Inputs to {@link resolveSkyBoxResolution}. */
export interface SkyBoxResolutionInput {
  /** A {@link SkyBox.Variant} value, already resolved to a known variant. */
  variant: string;
  /** A {@link SkyBoxResolution} value, or `undefined` for the default. */
  requested?: string;
  /**
   * Overrides {@link SKYBOX_BUNDLED_TIERS}. Only the spec passes this — it is
   * how the "a 4096 tier was installed" future is tested without inventing
   * assets in the tree.
   */
  bundled?: SkyBoxBundledTierTable;
  /**
   * `context.limits.maximumCubeMapSize` when the caller knows it
   * (`Scene#maximumCubeMapSize`). `undefined` or `0` means "unknown" and
   * disables the clamp. Both backends publish it: WebGL from
   * `MAX_CUBE_MAP_TEXTURE_SIZE`, WebGPU from `maxTextureDimension2D`.
   */
  maximumCubeMapSize?: number;
}

/** Output of {@link resolveSkyBoxResolution}. */
export interface SkyBoxResolutionDecision {
  /** The tier actually served. */
  resolution: string;
  /** Edge length of each served face, in pixels. `0` for an unknown variant. */
  faceSize: number;
  /** Infix for the served tier's filenames. */
  prefixSuffix: string;
  /** The tier that was asked for, after defaulting. */
  requested: string;
  /** True when `resolution !== requested`. */
  fallback: boolean;
  /**
   * True when even the smallest bundled tier exceeds `maximumCubeMapSize`.
   * The decision still names that tier — there is nothing smaller to serve —
   * so the caller can surface a real error rather than a silent black sky.
   */
  exceedsDeviceLimit: boolean;
  /** `6 × faceSize² × 4`, the uncompressed single-mip cost on both backends. */
  estimatedVramBytes: number;
  /** Why. */
  reason: SkyBoxResolutionReasonValue;
  /** Every tier bundled for this variant, ascending. */
  availableResolutions: string[];
}

/**
 * Video memory a cube map of `faceSize` occupies.
 *
 * Defaults model what the engine actually allocates for the star cube map:
 * `rgba8unorm`, six faces, **one** mip level. `mipmapped: true` computes the
 * exact sum over the full chain (not the 4/3 approximation) for callers
 * modelling a future mipmapped variant — nothing in the engine requests it for
 * the sky box today.
 */
export function estimateCubeMapVramBytes(
  faceSize: number,
  options?: { bytesPerTexel?: number; mipmapped?: boolean },
): number {
  if (!(faceSize > 0)) {
    return 0;
  }
  const bytesPerTexel = options?.bytesPerTexel ?? SKYBOX_BYTES_PER_TEXEL;
  const base = CUBE_MAP_FACE_COUNT * faceSize * faceSize * bytesPerTexel;
  if (options?.mipmapped !== true) {
    return base;
  }
  let total = 0;
  // Bounded: `size` at least halves each iteration and terminates at 1.
  for (
    let size = Math.floor(faceSize);
    size >= 1;
    size = Math.floor(size / 2)
  ) {
    total += CUBE_MAP_FACE_COUNT * size * size * bytesPerTexel;
    if (size === 1) {
      break;
    }
  }
  return total;
}

/**
 * Ascending list of the tiers bundled for a variant.
 *
 * Sorted numerically, not lexically — `"1024" < "2048" < "4096"` happens to
 * agree lexically today, but `"512"` would not, and the step-down search
 * depends on the order being real.
 */
export function bundledResolutions(
  variant: string,
  bundled?: SkyBoxBundledTierTable,
): string[] {
  const table = bundled ?? SKYBOX_BUNDLED_TIERS;
  const tiers = table[variant];
  if (tiers === undefined || tiers === null) {
    return [];
  }
  return Object.keys(tiers).sort((a, b) => Number(a) - Number(b));
}

function isKnownResolution(value: string): boolean {
  const values = Object.values(SkyBoxResolution);
  // Bounded: the enum has three members.
  for (let i = 0; i < values.length; i++) {
    if (values[i] === value) {
      return true;
    }
  }
  return false;
}

/**
 * The `C12-12` decision: which bundled face resolution to serve.
 *
 * Pure — no filesystem, no network, no engine objects — so
 * `Tools/visual-regression/skybox-resolution-policy.spec.mjs` can pin every
 * branch in Node.
 *
 * Rules, in order:
 *
 * 1. An unrecognised `requested` value is reported (`unknown-resolution`) and
 *    treated as the default. It never becomes a filename.
 * 2. A variant with no tiers yields `unknown-variant` and `faceSize: 0`. The
 *    caller ({@link SkyBox.createEarthSkyBox}) resolves the variant first, so
 *    this is reachable only by direct use.
 * 3. When the requested tier is bundled, it is served.
 * 4. Otherwise the largest bundled tier **at or below** the request is served;
 *    if the request is below every bundled tier, the smallest is served. Both
 *    report `tier-not-bundled` with `fallback: true`. This is the branch an
 *    explicit `SIZE_4096` takes at HEAD.
 * 5. A known `maximumCubeMapSize` then steps the choice down to the largest
 *    tier that fits, reporting `device-limit`. If nothing fits,
 *    `exceedsDeviceLimit` is set and the smallest tier is named — WebGL2's
 *    floor for `MAX_CUBE_MAP_TEXTURE_SIZE` is 2048 and WebGPU's
 *    `maxTextureDimension2D` floor is 8192, so this is a defensive branch, not
 *    an expected one.
 */
export function resolveSkyBoxResolution(
  input: SkyBoxResolutionInput,
): SkyBoxResolutionDecision {
  const table = input.bundled ?? SKYBOX_BUNDLED_TIERS;
  const available = bundledResolutions(input.variant, table);

  const rawRequest = input.requested ?? DEFAULT_SKYBOX_RESOLUTION;
  const requestKnown = isKnownResolution(rawRequest);
  const requested = requestKnown ? rawRequest : DEFAULT_SKYBOX_RESOLUTION;

  if (available.length === 0) {
    return {
      resolution: requested,
      faceSize: 0,
      prefixSuffix: "",
      requested,
      fallback: false,
      exceedsDeviceLimit: false,
      estimatedVramBytes: 0,
      reason: SkyBoxResolutionReason.UNKNOWN_VARIANT,
      availableResolutions: available,
    };
  }

  const tiers = table[input.variant];
  let reason: SkyBoxResolutionReasonValue = requestKnown
    ? SkyBoxResolutionReason.EXACT
    : SkyBoxResolutionReason.UNKNOWN_RESOLUTION;

  let chosen = requested;
  if (tiers[chosen] === undefined) {
    chosen = largestAtOrBelow(available, Number(requested)) ?? available[0];
    if (requestKnown) {
      reason = SkyBoxResolutionReason.TIER_NOT_BUNDLED;
    }
  }

  let exceedsDeviceLimit = false;
  const limit = input.maximumCubeMapSize ?? 0;
  if (limit > 0 && tiers[chosen].faceSize > limit) {
    const fitted = largestAtOrBelow(available, limit);
    if (fitted === undefined) {
      chosen = available[0];
      exceedsDeviceLimit = true;
    } else {
      chosen = fitted;
    }
    reason = SkyBoxResolutionReason.DEVICE_LIMIT;
  }

  const descriptor = tiers[chosen];
  return {
    resolution: chosen,
    faceSize: descriptor.faceSize,
    prefixSuffix: descriptor.prefixSuffix,
    requested,
    fallback: chosen !== requested,
    exceedsDeviceLimit,
    estimatedVramBytes: estimateCubeMapVramBytes(descriptor.faceSize),
    reason,
    availableResolutions: available,
  };
}

/**
 * Largest entry of an ascending tier list whose numeric value is `<= ceiling`,
 * or `undefined` when every entry is larger.
 */
function largestAtOrBelow(
  ascending: readonly string[],
  ceiling: number,
): string | undefined {
  let best: string | undefined;
  // Bounded by the tier-list length (three at most today).
  for (let i = 0; i < ascending.length; i++) {
    if (Number(ascending[i]) <= ceiling) {
      best = ascending[i];
    }
  }
  return best;
}
