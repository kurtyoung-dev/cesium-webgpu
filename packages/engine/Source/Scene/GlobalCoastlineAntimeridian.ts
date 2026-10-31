import { type GeographicRectangle } from "./WaterClassificationProvider.js";

const TWO_PI = Math.PI * 2.0;

/**
 * One extra raster pass for a padded tile rectangle that reaches past the
 * antimeridian. `queryRect` is the part beyond the seam, in the coast
 * polygons' own longitudes (inside [-PI, PI]), for selecting polygons;
 * `rasterRect` is the padded rectangle shifted by a full turn into that frame,
 * so rasterizing a polygon over it lands the polygon on the padded texels
 * beyond the seam.
 */
export interface AntimeridianWrapPass {
  queryRect: GeographicRectangle;
  rasterRect: GeographicRectangle;
}

/**
 * The wrap passes a padded tile rectangle needs.
 *
 * Tiles never straddle the antimeridian, but their distance-field pad does: a
 * tile whose edge is +-180 deg pads past +-PI. The coast polygons there have
 * longitudes on the OTHER side of the seam, so without a wrapped pass the pad
 * reads as open water, and the coastal distance field draws a shoreline along
 * the seam through land (and drops the shore taper from water facing land
 * across it). At most one pass per side; none for a rectangle inside
 * [-PI, PI].
 *
 * @param paddedRect The padded tile rectangle, in radians, `west <= east`.
 * @returns The passes, possibly empty.
 */
export function antimeridianWrapPasses(
  paddedRect: GeographicRectangle,
): AntimeridianWrapPass[] {
  const passes: AntimeridianWrapPass[] = [];
  if (paddedRect.west < -Math.PI) {
    passes.push({
      queryRect: {
        west: Math.max(-Math.PI, paddedRect.west + TWO_PI),
        south: paddedRect.south,
        east: Math.PI,
        north: paddedRect.north,
      },
      rasterRect: {
        west: paddedRect.west + TWO_PI,
        south: paddedRect.south,
        east: paddedRect.east + TWO_PI,
        north: paddedRect.north,
      },
    });
  }
  if (paddedRect.east > Math.PI) {
    passes.push({
      queryRect: {
        west: -Math.PI,
        south: paddedRect.south,
        east: Math.min(Math.PI, paddedRect.east - TWO_PI),
        north: paddedRect.north,
      },
      rasterRect: {
        west: paddedRect.west - TWO_PI,
        south: paddedRect.south,
        east: paddedRect.east - TWO_PI,
        north: paddedRect.north,
      },
    });
  }
  return passes;
}
