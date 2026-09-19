import CesiumMath from "../../Core/Math.js";

/**
 * A synthetic auroral oval, in the backend-agnostic Scene layer.
 *
 * The oval is where precipitating particles reach the upper atmosphere, and it
 * is neither a circle nor centred on the geomagnetic pole. It is pushed
 * antisunward, so it reaches furthest equatorward around magnetic midnight and
 * lies closest to the pole around magnetic noon, and it is widest on the
 * midnight side. Rising geomagnetic activity expands it equatorward and widens
 * it. Both hemispheres carry an oval at the same magnetic local time, mirrored
 * in geomagnetic latitude; because the dipole axis is tilted, that mirror is
 * emphatically not a mirror in geographic latitude.
 *
 * Boundaries are returned in the geomagnetic latitude of a
 * {@link GeomagneticFrame}, so a consumer converts them to positions through
 * that frame and extrudes curtains along
 * {@link GeomagneticFrame#dipoleFieldDirection}.
 *
 * What this model is and is not. It is an analytic shape driven by one
 * planetary-activity scalar, and it produces every visual state offline: it
 * fetches nothing, bundles no snapshot, and has no notion of a provider. It
 * bakes no intensity grid either — it supplies geometry, and the magnitude that
 * goes with it is the state packet's own activity scalar. A measured oval
 * field, when one is supplied, replaces this shape rather than multiplying it:
 * the operational forecast already consumes the solar-wind input that would
 * otherwise be applied twice.
 *
 * The oval is a function of one activity index on the planetary K range, 0
 * through 9, because that is the index the published viewline latitudes it is
 * anchored to are tabulated against. A space-weather state packet normalizes
 * the same quantity into `[0, 1]`, so {@link auroralActivityIndex} converts at
 * the seam and nothing downstream carries two scales. Activity moves the oval's
 * geometry; it is not applied to that geometry a second time as a brightness.
 * The harmonic terms that make the oval non-circular are a tuning, stated here
 * rather than buried in a shader so they can be replaced without touching
 * either backend.
 *
 * @see {@link https://www.spaceweather.gov/phenomena/aurora}
 * @see {@link https://www.spaceweather.gov/content/tips-viewing-aurora}
 */

/** Radians per hour of magnetic local time. */
const RADIANS_PER_HOUR = CesiumMath.TWO_PI / 24.0;

/** Lowest and highest activity indices the oval is defined over. */
export const MINIMUM_AURORAL_ACTIVITY_INDEX = 0.0;
export const MAXIMUM_AURORAL_ACTIVITY_INDEX = 9.0;

/**
 * Geomagnetic latitude, in degrees, of the equatorward edge of the auroral
 * oval at each whole step of the planetary K index, from 0 at the first entry
 * to 9 at the last. NOAA SWPC states the relation in prose rather than as a
 * table: about 66 degrees at K 0, moving equatorward about 2 degrees for each
 * step, reaching 48 degrees magnetic latitude at K 9. Those are the numbers
 * carried here. They are an average rather than a forecast, which is why they
 * are data a caller can replace and not a constant inside the shape. The model
 * anchors its magnetic-midnight equatorward boundary to them and interpolates
 * linearly between the steps.
 *
 * @see {@link https://www.spaceweather.gov/content/tips-viewing-aurora}
 */
export const AURORAL_VIEWLINE_LATITUDES_DEGREES: readonly number[] =
  Object.freeze([66.0, 64.0, 62.0, 60.0, 58.0, 56.0, 54.0, 52.0, 50.0, 48.0]);

/**
 * Which hemisphere's oval is being asked for. The two names are the two
 * single-hemisphere values a space-weather oval field is declared with, so a
 * field's hemisphere passes straight through; a field covering both means two
 * calls, because the two ovals are distinct geometry.
 */
export const AuroralOvalHemisphere: Readonly<
  Record<"NORTH" | "SOUTH", AuroralOvalHemisphereValue>
> = Object.freeze({
  NORTH: "north",
  SOUTH: "south",
});

/** @see {@link AuroralOvalHemisphere} */
export type AuroralOvalHemisphereValue = "north" | "south";

/**
 * The shape terms that turn the viewline anchor into an oval, in degrees.
 *
 * Each pair is a value at zero activity and a change per unit of activity. The
 * per-unit terms are small against the roughly two degrees per unit the anchor
 * itself moves, which is what keeps a quieter oval poleward of a more active
 * one at every magnetic local time rather than only on average.
 */
export interface AuroralOvalShape {
  /** Antisunward displacement: the first harmonic in magnetic local time. */
  readonly noonMidnightAmplitudeDegrees: number;
  readonly noonMidnightAmplitudePerActivity: number;
  /** The second harmonic, which keeps the oval from closing as an ellipse. */
  readonly secondHarmonicDegrees: number;
  readonly secondHarmonicPerActivity: number;
  /** Mean separation of the two boundaries. */
  readonly widthDegrees: number;
  readonly widthPerActivity: number;
  /** How much of that separation moves from the noon side to the night side. */
  readonly widthAsymmetryDegrees: number;
  readonly widthAsymmetryPerActivity: number;
}

/**
 * The shipped tuning. The night side is about three times as wide as the day
 * side at low activity and broadens with it, which is the asymmetry the shape
 * exists to carry.
 */
export const DEFAULT_AURORAL_OVAL_SHAPE: AuroralOvalShape = Object.freeze({
  noonMidnightAmplitudeDegrees: 3.0,
  noonMidnightAmplitudePerActivity: 0.15,
  secondHarmonicDegrees: 0.8,
  secondHarmonicPerActivity: 0.05,
  widthDegrees: 3.0,
  widthPerActivity: 0.2,
  widthAsymmetryDegrees: 1.5,
  widthAsymmetryPerActivity: 0.1,
});

/** The two boundaries of the oval at one magnetic local time, in radians. */
export interface AuroralOvalBoundaries {
  /**
   * Geomagnetic latitude of the equatorward edge, signed by hemisphere: the
   * edge of the oval nearest the geomagnetic equator.
   */
  equatorwardLatitude: number;
  /** Geomagnetic latitude of the poleward edge, signed by hemisphere. */
  polewardLatitude: number;
  /** Angular separation of the two edges; always positive. */
  width: number;
}

/**
 * The geomagnetic part of a space-weather state packet, narrowed to what the
 * oval reads. It is a structural view rather than an import, so this module
 * depends on the packet's shape and not on the module that builds it.
 */
export interface AuroralActivityView {
  readonly geomagnetic?: {
    /** Normalized activity in `[0, 1]`; the renderer-facing scalar. */
    readonly activity?: number;
    /** The same quantity on the planetary K range, when carried. */
    readonly kpIndex?: number;
  };
}

/**
 * Reduce a state packet to the single index the oval is a function of.
 *
 * The packet normalizes activity into `[0, 1]` and the viewline table it drives
 * is tabulated against the planetary K index, so the conversion is the nine the
 * two scales differ by. The packet's own `kpIndex` is a diagnostic held
 * consistent with `activity`, so `activity` is what is read; an absent or
 * nonfinite one falls back to the quietest geometry rather than propagating a
 * NaN into vertex positions, because validating the packet belongs to whatever
 * produced it.
 *
 * @param state The packet, or undefined.
 * @returns The activity index, in `[0, 9]`.
 */
export function auroralActivityIndex(state?: AuroralActivityView): number {
  const activity = state?.geomagnetic?.activity;
  if (typeof activity === "number" && isFinite(activity)) {
    return (
      CesiumMath.clamp(activity, 0.0, 1.0) * MAXIMUM_AURORAL_ACTIVITY_INDEX
    );
  }
  return MINIMUM_AURORAL_ACTIVITY_INDEX;
}

/**
 * Geomagnetic latitude of the magnetic-midnight equatorward boundary at an
 * activity index, interpolated across the published viewline table.
 *
 * @param activityIndex The activity index, clamped into `[0, 9]`.
 * @returns The latitude, in radians.
 */
export function auroralViewlineLatitude(activityIndex: number): number {
  const clamped = CesiumMath.clamp(
    activityIndex,
    MINIMUM_AURORAL_ACTIVITY_INDEX,
    MAXIMUM_AURORAL_ACTIVITY_INDEX,
  );
  const lower = Math.min(
    Math.floor(clamped),
    AURORAL_VIEWLINE_LATITUDES_DEGREES.length - 2,
  );
  const fraction = clamped - lower;
  const degrees =
    AURORAL_VIEWLINE_LATITUDES_DEGREES[lower] * (1.0 - fraction) +
    AURORAL_VIEWLINE_LATITUDES_DEGREES[lower + 1] * fraction;
  return CesiumMath.toRadians(degrees);
}

/**
 * The synthetic oval, evaluated on demand.
 *
 * Instances are immutable and hold only the shape terms, so a scene may keep
 * one and call it per sample without allocating.
 */
class AuroralOvalModel {
  private readonly _shape: AuroralOvalShape;

  /**
   * @param shape The shape terms; the shipped tuning by default.
   */
  constructor(shape: AuroralOvalShape = DEFAULT_AURORAL_OVAL_SHAPE) {
    this._shape = shape;
  }

  /** The shape terms this model evaluates. */
  get shape(): AuroralOvalShape {
    return this._shape;
  }

  /**
   * The oval's two boundaries at one magnetic local time.
   *
   * @param activityIndex The activity index, on the planetary K range.
   * @param magneticLocalTime Magnetic local time in hours; 0 is magnetic
   *        midnight and 12 is magnetic noon.
   * @param hemisphere Which hemisphere's oval to return.
   * @param result The object to store the result in.
   * @returns The boundaries, in geomagnetic latitude signed by hemisphere.
   */
  boundaries(
    activityIndex: number,
    magneticLocalTime: number,
    hemisphere: AuroralOvalHemisphereValue = AuroralOvalHemisphere.NORTH,
    result?: AuroralOvalBoundaries,
  ): AuroralOvalBoundaries {
    const shape = this._shape;
    const clamped = CesiumMath.clamp(
      activityIndex,
      MINIMUM_AURORAL_ACTIVITY_INDEX,
      MAXIMUM_AURORAL_ACTIVITY_INDEX,
    );
    const sign = hemisphere === AuroralOvalHemisphere.SOUTH ? -1.0 : 1.0;

    const first = CesiumMath.toRadians(
      shape.noonMidnightAmplitudeDegrees +
        shape.noonMidnightAmplitudePerActivity * clamped,
    );
    const second = CesiumMath.toRadians(
      shape.secondHarmonicDegrees + shape.secondHarmonicPerActivity * clamped,
    );
    const width = CesiumMath.toRadians(
      shape.widthDegrees + shape.widthPerActivity * clamped,
    );
    const widthAsymmetry = CesiumMath.toRadians(
      shape.widthAsymmetryDegrees + shape.widthAsymmetryPerActivity * clamped,
    );

    // Measured from magnetic midnight, so the first harmonic is at its maximum
    // exactly where the anchor is stated and the anchor is reproduced there.
    const phase = magneticLocalTime * RADIANS_PER_HOUR;
    const cosPhase = Math.cos(phase);

    const midnightColatitude =
      CesiumMath.PI_OVER_TWO - auroralViewlineLatitude(clamped);
    const equatorwardColatitude =
      midnightColatitude -
      first -
      second +
      first * cosPhase +
      second * Math.cos(2.0 * phase);
    const localWidth = width + widthAsymmetry * cosPhase;

    const out = result ?? {
      equatorwardLatitude: 0.0,
      polewardLatitude: 0.0,
      width: 0.0,
    };
    out.equatorwardLatitude =
      sign * (CesiumMath.PI_OVER_TWO - equatorwardColatitude);
    out.polewardLatitude =
      sign * (CesiumMath.PI_OVER_TWO - (equatorwardColatitude - localWidth));
    out.width = localWidth;
    return out;
  }
}

export default AuroralOvalModel;
