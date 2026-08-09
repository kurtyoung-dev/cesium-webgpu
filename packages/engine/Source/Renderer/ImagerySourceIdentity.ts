/**
 * Backend-neutral imagery source identity.
 *
 * A single immutable image source (an `HTMLCanvasElement`, `ImageBitmap`, …)
 * can be handed to the renderer once per terrain tile — `GridImageryProvider`
 * draws its grid canvas once in its constructor and returns that same object
 * for every tile. Without a source-identity concept the WebGPU globe realizes
 * an identical full-mip `GPUTexture` per tile coordinate: 513 identical
 * realizations, 173 MiB retained and 4104 private mip passes on a measured
 * three-altitude grid-imagery route.
 *
 * This module gives each source object a stable identity and a shareability
 * verdict without hashing pixels, which is both a false-aliasing correctness
 * trap and a performance trap. Identity is object identity plus an explicit,
 * monotonically-bumped revision. A source is shareable only when it is provably
 * immutable:
 *
 *   - `ImageBitmap` — immutable by spec, so shareable by object identity at
 *     revision 0.
 *   - A canvas, image or other object that a provider has explicitly declared
 *     immutable via {@link declareImmutableImagerySource}.
 *
 * Undeclared sources are never shared; they keep one owned texture per imagery,
 * so mutable or unknown demand always stays distinct.
 *
 * The module lives under `Renderer/` rather than `Renderer/WebGPU/` so it is
 * available to Scene providers in every build variant without stub redirection,
 * and so the WebGL path can adopt the same identity contract.
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
 * sharing that used the previous revision. This exists for mutable-snapshot
 * providers — one that redraws its canvas and wants a single new shared
 * realization rather than N distinct ones. Nothing in the tree calls it, so
 * declared sources stay at revision 0.
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
