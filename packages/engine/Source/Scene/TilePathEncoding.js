/**
 * Supported encodings for tile paths inside a 3D Tiles live invalidation feed.
 *
 * Each {@link Cesium3DTileset} may own its own invalidator with its own
 * encoding, so a single Cesium scene can simultaneously stream invalidations
 * from multiple producers that disagree on how tiles are addressed (e.g. a
 * terrain tileset streamed from a child-index producer and an objects tileset
 * streamed from a Bing-style quadkey producer). Parsing/walking logic is
 * selected via {@link createTilePathResolver}, not baked into the feed.
 *
 * - CHILD_INDEX — slash-separated integer child indices (producer default).
 * - QUADKEY     — Bing-style base-4 single-string quadkey.
 * - MORTON      — "level/morton-int" pair where morton interleaves x/y bits.
 * - LEVEL_XY    — OGC / TMS implicit tiling "level/x/y" (or "level/x/y/z").
 *
 * @private
 */
const TilePathEncoding = Object.freeze({
  CHILD_INDEX: "CHILD_INDEX", // "5/0/1/3/2" — slash-separated child indices, one per level
  QUADKEY: "QUADKEY", // "01321133" — Bing-style base-4 single string
  MORTON: "MORTON", // "13/38" — level/morton-int (interleaved x/y bits)
  LEVEL_XY: "LEVEL_XY", // "13/5119/2734" or "13/5119/2734/100" — TMS / OGC implicit tiling
});

export default TilePathEncoding;
