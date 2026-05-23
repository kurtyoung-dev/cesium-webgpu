/**
 * Globe-fragment debug-mode registry. Each entry maps a string name to a
 * `tile.time` sentinel that `GlobeTerrain.wgsl` reads to short-circuit
 * `fragmentMain` and return a visualization of an intermediate value.
 *
 * The whole system is pragma-stripped from production builds: the
 * `applyDebugModeToTileTime` writer below sits inside a debug-pragma
 * block in the caller (see `scripts/build.js` stripPragmaPlugin), and the
 * WGSL branches are guarded by `tile.time > 1e9` (the real `tile.time`
 * is `secsSinceEpoch % 1_000_000` so it never crosses that threshold in
 * normal rendering — the dead-code cost is one compare per pixel).
 *
 * Adding a new mode:
 *   1. Append an entry to `GLOBE_FRAGMENT_DEBUG_MODES` with a fresh
 *      sentinel (1e9 apart from the others so the WGSL guards stay
 *      unambiguous).
 *   2. Add the matching `if (tile.time > N - 0.5e9 && tile.time < N + 0.5e9)`
 *      branch in `GlobeTerrain.wgsl::fragmentMain` that returns the
 *      visualization.
 *   3. Bump the WGSL pre-warm if the new branch changes the shader hash
 *      meaningfully.
 *
 * Reachable from user-facing code via `CesiumDebug.globeFragmentDebug(name)`.
 */

export interface GlobeFragmentDebugMode {
  /** Short kebab-case key used by callers. */
  readonly name: string;
  /** Sentinel written to `tile.time` (UB field) — must match the WGSL guard. */
  readonly sentinel: number;
  /** One-line description for help output. */
  readonly description: string;
}

/**
 * Registry of all globe-fragment debug visualizations. Order is irrelevant
 * (lookup is by name); sentinel values must remain stable (the WGSL guards
 * are baked in shader source).
 */
export const GLOBE_FRAGMENT_DEBUG_MODES: ReadonlyArray<GlobeFragmentDebugMode> =
  [
    {
      name: "uv",
      sentinel: 1.2e9,
      description: "RGB = (geoU, geoV, webMercatorT) — vertex UV diagnostic",
    },
    {
      name: "alpha",
      sentinel: 2.0e9,
      description: "Layer 0 texCoordsAlpha mask as R; G = geoV; B = rect.y",
    },
    {
      name: "layer-count",
      sentinel: 3.0e9,
      description:
        "R = layerCount/16, G = layer0 mask, B = layer1 mask (verifies tile straddle)",
    },
    {
      name: "sample0",
      sentinel: 4.0e9,
      description:
        "Raw `sampleImagery(dayTexture0).rgb` — bypasses composite/mask",
    },
    {
      name: "sample1",
      sentinel: 5.0e9,
      description:
        "Raw `sampleImagery(dayTexture1).rgb` — bypasses composite/mask",
    },
    {
      name: "tex0-alpha",
      sentinel: 6.0e9,
      description:
        "Layer 0 `texSample.a` as grayscale — checks reprojection-target alpha",
    },
    {
      name: "tex1-alpha",
      sentinel: 7.0e9,
      description: "Layer 1 `texSample.a` as grayscale",
    },
    {
      name: "post-composite-color",
      sentinel: 8.0e9,
      description:
        "Composited imagery color BEFORE material / atmosphere / fog / HSB",
    },
    {
      name: "post-composite-alpha",
      sentinel: 9.0e9,
      description: "Accumulated composite alpha as grayscale",
    },
    {
      name: "fade-amount",
      sentinel: 10.0e9,
      description:
        "Ground-atmosphere `fadeAmount` (= 1 fully replaces imagery with drape)",
    },
    {
      name: "draped",
      sentinel: 11.0e9,
      description:
        "Post-tonemap `draped` color used in mix(imagery, draped, fadeAmount)",
    },
    {
      name: "atmo-color",
      sentinel: 12.0e9,
      description:
        "`groundAtmoColor` — per-fragment Rayleigh+Mie composited via phase functions",
    },
    {
      name: "transmittance",
      sentinel: 13.0e9,
      description: "Drape `transmittance / 5` as grayscale (capped 0..1)",
    },
    {
      name: "rayleigh-v",
      sentinel: 14.0e9,
      description:
        "Per-vertex `v_atmosphereRayleighColor` varying (currently unused at orbit; kept for close-camera optimization)",
    },
    {
      name: "mie-v",
      sentinel: 15.0e9,
      description: "Per-vertex `v_atmosphereMieColor` varying",
    },
    {
      name: "view-dir",
      sentinel: 16.0e9,
      description:
        "`normalize(positionWC - cameraWC) * 0.5 + 0.5` per fragment (verifies RTE camera reconstruction)",
    },
    {
      name: "mip4",
      sentinel: 17.0e9,
      description:
        "Explicit textureSampleLevel(LOD=4) of layer 0. If this matches `sample0` the mipmaps aren't being picked; if different the chain is valid and the gap is LOD selection.",
    },
    {
      name: "lod-magnitude",
      sentinel: 18.0e9,
      description:
        "Approximate sampler LOD as grayscale: log2(max derivative × 256) / 10 + 0.5. Should grow with camera distance.",
    },
    {
      name: "force-red",
      sentinel: 19.0e9,
      description:
        "End-of-fragment force `(1,0,0,1)`. If displayed canvas is dim red, dimming is downstream of FS (canvas format / color space). If bright red, dimming is in FS shading path.",
    },
    {
      name: "water-effect-trigger",
      sentinel: 20.0e9,
      description:
        "Visualize `tile.flags.x` (showReflectiveOcean) per fragment. Red = water + reflective-ocean enabled (computeEnhancedOcean runs). Yellow = tile has water mask but fragment is land. Green = no reflective ocean.",
    },
  ];

const _MODE_BY_NAME: ReadonlyMap<string, GlobeFragmentDebugMode> = new Map(
  GLOBE_FRAGMENT_DEBUG_MODES.map((m) => [m.name, m]),
);

// Publish the registry on globalThis so `CesiumDebug.globeFragmentDebug()`
// (which lives in the Scene layer and can't import from Renderer/WebGPU/
// without violating the backend-agnostic Scene rule) can iterate the
// modes for `--help` output. The registry is plain data so this is safe.
//>>includeStart('debug', pragmas.debug);
(
  globalThis as {
    __webgpuGlobeFragmentDebugRegistry?: ReadonlyArray<GlobeFragmentDebugMode>;
  }
).__webgpuGlobeFragmentDebugRegistry = GLOBE_FRAGMENT_DEBUG_MODES;
//>>includeEnd('debug');

/**
 * Reads the active debug mode from `globalThis._webgpuGlobeDebugMode` (set
 * by `CesiumDebug.globeFragmentDebug(name)`) and returns the matching
 * sentinel, or `null` if no mode (or an unknown mode) is active.
 *
 * Intentionally lenient on unknown names — returns null and lets the
 * caller fall through to the production `waveTime` write. We log a one-shot
 * warning on unknown names so typos surface in DevTools without breaking
 * rendering.
 */
export function getActiveDebugSentinel(): number | null {
  const g = globalThis as { _webgpuGlobeDebugMode?: string | null };
  const name = g._webgpuGlobeDebugMode;
  if (!name) return null;
  const mode = _MODE_BY_NAME.get(name);
  if (!mode) {
    _warnUnknownModeOnce(name);
    return null;
  }
  return mode.sentinel;
}

const _warnedNames = new Set<string>();
function _warnUnknownModeOnce(name: string): void {
  if (_warnedNames.has(name)) return;
  _warnedNames.add(name);
  console.warn(
    `[CesiumDebug] Unknown globeFragmentDebug mode '${name}'. ` +
      `Known modes: ${GLOBE_FRAGMENT_DEBUG_MODES.map((m) => m.name).join(", ")}`,
  );
}
