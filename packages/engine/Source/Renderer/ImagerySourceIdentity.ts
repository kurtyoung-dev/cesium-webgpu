/**
 * Backend-neutral imagery source identity (C9-12A-IMAGERY-SOURCE-REALIZATION-DEDUP-AND-MIP-PREP).
 *
 * A single immutable image source (an `HTMLCanvasElement`, `ImageBitmap`, …)
 * can be handed to the renderer once per terrain tile — the `GridImageryProvider`
 * draws its grid canvas ONCE in its constructor and returns that same object for
 * every tile. Without a source-identity concept the WebGPU globe realizes an
 * identical full-mip `GPUTexture` per tile coordinate (measured: 513 identical
 * realizations, 173 MiB retained, 4104 private mip passes).
 *
 * This module gives each source object a stable identity and a shareability
 * verdict WITHOUT hashing pixels (a false-aliasing correctness trap and a perf
 * trap). Identity is object identity plus an explicit, monotonically-bumped
 * revision. A source is shareable only when it is provably immutable:
 *
 *   - `ImageBitmap` — immutable by spec → shareable by object identity, revision 0.
 *   - A canvas/image/other object that a provider has EXPLICITLY declared
 *     immutable via {@link declareImmutableImagerySource}. Undeclared sources are
 *     never shared: they keep the historical one-owned-texture-per-imagery
 *     behavior exactly (C9 hard rule 3 — mutable/unknown demand stays distinct).
 *
 * The module lives under `Renderer/` (NOT `Renderer/WebGPU/`) so it is available
 * to Scene providers in every build variant without stub redirection, and so the
 * WebGL path can adopt the same identity contract in a later slice.
 *
 * @module ImagerySourceIdentity
 */

let _nextSourceId = 1;
const _sourceIds = new WeakMap<object, number>();
const _revisions = new WeakMap<object, number>();
const _immutableDeclared = new WeakSet<object>();

/**
 * Stable, process-unique id for a source object. First call assigns; later calls
 * for the same object return the same id. Distinct objects always get distinct
 * ids, so real per-tile streamed imagery (distinct `ImageBitmap`s from
 * `Resource.fetchImage`) is never conflated.
 */
export function getImagerySourceId(source: object): number {
  let id = _sourceIds.get(source);
  if (id === undefined) {
    id = _nextSourceId++;
    _sourceIds.set(source, id);
  }
  return id;
}

/**
 * Declare that a source object's pixel content is immutable for the remainder of
 * its lifetime. Providers call this for a source they draw exactly once and never
 * mutate (e.g. `GridImageryProvider`'s constructor-drawn canvas). Never call this
 * for a user-supplied canvas or a per-tile freshly-drawn canvas.
 */
export function declareImmutableImagerySource(source: object): void {
  _immutableDeclared.add(source);
}

/**
 * Bump the immutable-snapshot revision of a source, invalidating any realization
 * sharing that used the previous revision. Provided for future mutable-snapshot
 * providers per FAR-205 slice 2 (a provider that redraws its canvas and wants a
 * NEW shared realization rather than N distinct ones). Nothing in the tree calls
 * it yet; declared sources currently stay at revision 0.
 */
export function bumpImagerySourceRevision(source: object): void {
  _revisions.set(source, (_revisions.get(source) ?? 0) + 1);
}

/**
 * Resolve the shareable identity of a source, or `null` when the source must not
 * be shared. Non-null only for a live `ImageBitmap` or an explicitly-declared
 * immutable object.
 */
export function getShareableImagerySourceIdentity(
  source: unknown,
): { sourceId: number; revision: number } | null {
  if (source === null || typeof source !== "object") {
    return null;
  }
  const isImageBitmap =
    typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap;
  if (!isImageBitmap && !_immutableDeclared.has(source)) {
    return null;
  }
  return {
    sourceId: getImagerySourceId(source),
    revision: _revisions.get(source) ?? 0,
  };
}

export default {
  getImagerySourceId,
  declareImmutableImagerySource,
  bumpImagerySourceRevision,
  getShareableImagerySourceIdentity,
};
