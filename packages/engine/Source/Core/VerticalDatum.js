import defined from "./defined.js";
import EllipsoidTerrainProvider from "./EllipsoidTerrainProvider.js";

/**
 * VerticalDatum — the reference surface that "height 0" means for a rendered
 * water surface (C6-FFT-OCEAN-TIDE-DATUM, Design A slice 1).
 *
 * Ratified by maintainer ruling **T2** (`migration_doc/TIDES_FEASIBILITY_2026-07-24.md`
 * §5a, expanded scope): the ocean anchor must support ellipsoid AND geoid AND
 * further vertical datums, DERIVED from the selected terrain/imagery, with a
 * manual override. This enum plus {@link VerticalDatum.fromTerrainProvider} is
 * that derivation; the offset itself is applied in
 * `Scene/OceanSurfacePrimitive.js`.
 *
 * WHY IT EXISTS. Elevation data is orthometric — a DEM's "0" is mean sea
 * level, i.e. the GEOID, which departs from the WGS84 ellipsoid by up to
 * ±107 m. `Tools/visual-regression/probe-ocean-datum.mjs` (Batch 759) measured
 * Cesium World Terrain's ocean lid at six open-ocean sites and classified it
 * GEOID (slope 1.049 against EGM2008, r² 0.999, spread 171 m); cross-checked
 * against the true 2.5' EGM2008 grid at those same sites the residuals are
 * 0.03–0.31 m. The shipped FFT ocean anchored at ELLIPSOIDAL 0, so at the Sri
 * Lanka coast it floated a measured 101.64 m above the baked sea — a visible
 * raised-water plateau. That is a defect, not a missing feature, which is why
 * the derived datum is applied by DEFAULT rather than behind an opt-in.
 *
 * AUTO DERIVATION TABLE
 *
 * | provider                                            | datum     | basis |
 * |-----------------------------------------------------|-----------|-------|
 * | none / `undefined`                                  | ELLIPSOID | nothing to agree with |
 * | {@link EllipsoidTerrainProvider}                    | ELLIPSOID | STRUCTURAL — every height it returns is exactly 0 on the ellipsoid |
 * | Cesium World Terrain (`CesiumTerrainProvider`, ion 1) | GEOID   | MEASURED — Batch 759 probe + EGM2008 cross-check |
 * | any other terrain provider                          | GEOID     | ASSUMED — published DEMs are orthometric; override with `scene.globe.water.oceanVerticalDatum` |
 *
 * The "ASSUMED" row is stated plainly because it is the one row not backed by
 * a measurement. It is the right default (an ellipsoidal-height DEM is rare
 * and would be unusable for most GIS work), and the manual override is the
 * documented escape hatch. Additional per-provider datum metadata — regional
 * vertical datums riding the same offset, per T2 — extends this table without
 * changing the offset plumbing.
 *
 * @enum {string}
 */
const VerticalDatum = {
  /**
   * Derive the datum from the globe's terrain provider (see the table above).
   * The default.
   * @type {string}
   * @constant
   */
  AUTO: "AUTO",

  /**
   * Pin the water surface to ellipsoidal height 0. This is the pre-Batch-763
   * behaviour of the FFT ocean and the correct choice for terrain whose
   * heights really are ellipsoidal.
   * @type {string}
   * @constant
   */
  ELLIPSOID: "ELLIPSOID",

  /**
   * Pin the water surface to the geoid, using the bundled EGM2008 undulation
   * grid ({@link GeoidUndulationGrid}).
   * @type {string}
   * @constant
   */
  GEOID: "GEOID",
};

/**
 * Resolve a possibly-`AUTO` datum against a terrain provider.
 *
 * @param {string} datum One of {@link VerticalDatum}. Unrecognised values are
 *   treated as `AUTO` rather than throwing, so a typo degrades to the derived
 *   behaviour instead of breaking the render.
 * @param {TerrainProvider} [terrainProvider] The globe's terrain provider.
 * @returns {string} Either {@link VerticalDatum.ELLIPSOID} or
 *   {@link VerticalDatum.GEOID} — never `AUTO`.
 */
VerticalDatum.resolve = function (datum, terrainProvider) {
  if (datum === VerticalDatum.ELLIPSOID || datum === VerticalDatum.GEOID) {
    return datum;
  }
  return VerticalDatum.fromTerrainProvider(terrainProvider);
};

/**
 * The datum implied by a terrain provider — the AUTO branch of
 * {@link VerticalDatum.resolve}.
 *
 * @param {TerrainProvider} [terrainProvider] The provider.
 * @returns {string} {@link VerticalDatum.ELLIPSOID} or {@link VerticalDatum.GEOID}.
 */
VerticalDatum.fromTerrainProvider = function (terrainProvider) {
  if (!defined(terrainProvider)) {
    return VerticalDatum.ELLIPSOID;
  }
  // `instanceof`, not a name check: the release build minifies class names, so
  // `constructor.name` would silently stop matching and quietly re-introduce
  // the 101 m defect in exactly the shipped bundle.
  if (terrainProvider instanceof EllipsoidTerrainProvider) {
    return VerticalDatum.ELLIPSOID;
  }
  return VerticalDatum.GEOID;
};

export default Object.freeze(VerticalDatum);
