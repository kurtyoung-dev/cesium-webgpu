/**
 * C13-01 cloud-tour FIXTURES and SEQUENCES — the deterministic definition half
 * of the repaired tour. Pure data plus pure functions: this module imports no
 * browser API, launches nothing, and is fully executable under `node --test`.
 * @purpose Deterministic C13-01 tour definitions: pinned local-solar clocks, absolute camera stations, replay keys, three-lane wind/time discriminators.
 * @status ACTIVE
 *
 * WHY THIS IS A SEPARATE MODULE. The C13-01 row's remaining tail is
 * "climate/region/type/same-type fixtures, wind/time and temporal-reset
 * sequences, complete per-sequence metrics, and GPU timing". Those are
 * DEFINITIONS, and a definition that lives inside a Playwright probe can only be
 * checked by running Edge. Keeping the table here means the coverage the queue
 * row demands — four-plus climates, three-plus genera, same-type formations,
 * both dateline directions, both poles, ground/inside-deck/above-deck/orbital —
 * is asserted by `cloud-tour-sequences.spec.mjs` in milliseconds, before a
 * browser is ever launched. The probe consumes this table; it does not own it.
 *
 * DETERMINISM CONTRACT. Every value that reaches the renderer is authored:
 *   - the clock is a PINNED UTC instant derived from a fixed solstice date plus
 *     the fixture's declared LOCAL SOLAR hour (`utcIsoForLocalSolarHour`), so a
 *     "noon" fixture is local noon at its own longitude on every run;
 *   - a sequence that must advance time does so by a FIXED number of seconds per
 *     frame from a FIXED frame schedule, never from wall time;
 *   - camera stations are absolute, never relative to wherever a previous phase
 *     left the camera;
 *   - `replayKeyFor()` hashes the determinism-relevant subset of a definition so
 *     two runs can PROVE they replayed the same definition rather than assuming
 *     it. A changed fixture changes the key, and a manifest pair whose keys
 *     disagree is not comparable.
 *
 * WIND ADVECTION IS TIME-DRIVEN — the fact that shapes the wind sequences.
 * `resolveCloudTimeSeconds` (WebGPUProceduralCloudRenderer.ts) derives cloud
 * time from `frameState.time` relative to the first visible cloud frame, so a
 * PINNED clock freezes the field no matter what `cloudWindSpeed` says. A wind
 * lane must therefore advance the clock, which means a wind lane alone cannot
 * distinguish advection from the sun moving. The `wind-time` sequences are
 * consequently a THREE-LANE set differing by exactly one variable each
 * (pinned/no wind, advancing/no wind, advancing/wind), so the discriminator is
 * built from the difference between lanes and not from the lane under test.
 *
 * @module cloud-tour-fixtures
 */

import CloudType from "../../../packages/engine/Source/Scene/CloudType.js";

/** Bumped whenever the fixture/sequence shape changes incompatibly. */
export const CLOUD_TOUR_SCHEMA_VERSION = "c13-01-tour/1";

/**
 * Fixed capture date. The June solstice gives both poles a determinate sun
 * (north lit, south dark), which is what makes the polar fixtures readable
 * rather than a coin flip.
 */
export const TOUR_EPOCH_DATE = "2026-06-21";

/** Camera regimes the queue row enumerates for the moving tour. */
export const STATION_REGIMES = Object.freeze([
  "ground",
  "inside-deck",
  "above-deck",
  "orbital",
]);

/** Phase actions the probe must implement. Adding one here without a probe
 * branch is a spec failure, not an Edge-cycle discovery. */
export const PHASE_ACTIONS = Object.freeze([
  "hold",
  "pan",
  "teleport",
  "return",
  "disable-clouds",
  "enable-clouds",
  "set-deck",
  "resize",
]);

/** Sequence kinds. */
export const SEQUENCE_KINDS = Object.freeze([
  "wind-time",
  "teleport",
  "history-reset",
  "temporal-ghost",
]);

const GENUS_NAME_BY_VALUE = Object.freeze(
  Object.fromEntries(
    Object.entries(CloudType)
      .filter(([, value]) => typeof value === "number")
      .map(([name, value]) => [value, name]),
  ),
);

/** Human-readable genus name for a {@link CloudType} value. */
export function genusName(cloudType) {
  return GENUS_NAME_BY_VALUE[cloudType] ?? `UNKNOWN(${String(cloudType)})`;
}

// ── Deterministic clock ────────────────────────────────────────────────────

/**
 * UTC instant at which `localSolarHour` is the mean solar time at `lonDegrees`.
 *
 * Mean solar time, deliberately: the equation of time would make the instant
 * depend on the date in a way no probe reader can verify by inspection, and the
 * tour needs a REPRODUCIBLE sun, not an ephemeris-grade one. The result is
 * quantized to whole seconds so the ISO string — and therefore the JulianDate
 * the renderer's advection epoch is measured from — is byte-stable.
 *
 * @param {number} lonDegrees Longitude in degrees, any wrapping.
 * @param {number} localSolarHour Target local solar hour in [0, 24).
 * @param {string} [dateIso] Base UTC date, `YYYY-MM-DD`.
 * @returns {string} An ISO-8601 UTC instant.
 */
export function utcIsoForLocalSolarHour(
  lonDegrees,
  localSolarHour,
  dateIso = TOUR_EPOCH_DATE,
) {
  if (!Number.isFinite(lonDegrees)) {
    throw new Error("utcIsoForLocalSolarHour requires a finite longitude");
  }
  if (!(localSolarHour >= 0 && localSolarHour < 24)) {
    throw new Error(`localSolarHour out of range: ${String(localSolarHour)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso))) {
    throw new Error(`dateIso must be YYYY-MM-DD, received ${String(dateIso)}`);
  }
  const wrappedLon = ((((lonDegrees + 180) % 360) + 360) % 360) - 180;
  const offsetSeconds = Math.round((localSolarHour - wrappedLon / 15) * 3600);
  const base = Date.parse(`${dateIso}T00:00:00Z`);
  return new Date(base + offsetSeconds * 1000)
    .toISOString()
    .replace(/\.000Z$/, "Z");
}

// ── Stable identity ────────────────────────────────────────────────────────

/**
 * Canonical JSON: object keys sorted, so two structurally equal definitions
 * serialize identically regardless of authoring order.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * FNV-1a/32 over the canonical JSON. Not a security hash — an EQUALITY TOKEN.
 * Its only job is to make "did both halves of the A/B replay the same
 * definition?" a comparison instead of an assumption.
 *
 * @param {unknown} value
 * @returns {string} Eight lowercase hex digits.
 */
export function replayKeyFor(value) {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    const high = text.charCodeAt(i) >>> 8;
    if (high !== 0) {
      hash ^= high;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The determinism-relevant subset of a fixture — what the replay key covers.
 *
 * `gate` is deliberately EXCLUDED. The key answers "did both halves of an A/B
 * render the same thing?", and a threshold is a judgement applied afterwards,
 * not a render input. Folding it in would invalidate a banked baseline every
 * time a threshold was revised, which is how a determinism token becomes
 * something people work around.
 */
export function fixtureReplaySubset(fixture) {
  return {
    id: fixture.id,
    schema: CLOUD_TOUR_SCHEMA_VERSION,
    cloudType: fixture.cloudType,
    anchor: fixture.anchor,
    localSolarHour: fixture.localSolarHour,
    clockIso: fixtureClockIso(fixture),
    volumetric: fixture.volumetric,
    stations: fixture.stations,
  };
}

/** The determinism-relevant subset of a sequence. */
export function sequenceReplaySubset(sequence) {
  return {
    id: sequence.id,
    schema: CLOUD_TOUR_SCHEMA_VERSION,
    kind: sequence.kind,
    fixtureId: sequence.fixtureId,
    clock: sequence.clock,
    volumetric: sequence.volumetric ?? null,
    phases: sequence.phases,
    gpuPasses: sequence.gpuPasses,
  };
}

/**
 * Pinned UTC instant for a fixture, from its anchor longitude + solar hour.
 *
 * `clockAnchorLon` exists for DECLARED TWINS only. A twin pair must be lit
 * identically or the pair measures illumination instead of the one variable it
 * is supposed to isolate, and the antimeridian twins sit 0.8 degrees apart —
 * three minutes of solar time — on opposite sides of the ISO date wrap. Pinning
 * the western twin's clock to its partner's anchor longitude puts both at the
 * SAME instant, at which each is still within four minutes of its own local
 * noon.
 */
export function fixtureClockIso(fixture) {
  return utcIsoForLocalSolarHour(
    fixture.clockAnchorLon ?? fixture.anchor.lon,
    fixture.localSolarHour,
    fixture.dateIso ?? TOUR_EPOCH_DATE,
  );
}

// ── Fixture table ──────────────────────────────────────────────────────────
//
// Each entry answers one of the row's coverage words. `formation` and
// `volumetric` differ WITHIN a genus wherever two fixtures share `cloudType` —
// that is what makes them "multiple same-type formations" instead of the same
// scene twice, and `validateFixtureSet` refuses a same-genus pair whose
// configuration is identical.
//
// Deck altitudes are the fixture's own meteorology, not a preset: a marine
// stratocumulus sheet really does sit at 600-1400 m while an ITCZ tower spans
// 800-14000 m, and the station regimes are validated AGAINST those bounds so an
// "inside-deck" station cannot silently sit above the deck it claims to be in.

const FIXTURES = [
  {
    id: "plains-fairweather-cumulus",
    gate: {
      minChangedFraction: 0.02,
      why: "The original floor, restored 2026-08-01 when CLOUD-LOW-COVERAGE-CUTOFF closed. Its ceiling pinned a renderer defect — the coverage->density gate thresholded a base noise whose support stops at 0.718, so coverage 0.35 rendered EXACTLY zero cloud (sweep: 0 at <= 0.40, 0.0009 at 0.45) — and the re-derived response (cloudEffectiveCoverage, CloudDensityDomain.wgsl) now puts this fixture at roughly 40% of the tradewind anchor's sky cover with ~80% of its peak density. A sparse fair-weather deck sits below the denser fixtures' floors, hence 0.02 rather than their 0.03-0.05.",
    },
    climate: "midlatitude-continental",
    region: "north-american-great-plains",
    cloudType: CloudType.CUMULUS,
    formation: "humilis-scattered",
    rationale:
      "The fork's historical cloud anchor (-95/39). Fair-weather cumulus over " +
      "a dry continental boundary layer: sparse, high-contrast, and the one " +
      "scene every prior cloud probe shares, so its evidence is comparable to " +
      "the whole existing corpus.",
    anchor: { lon: -95.0, lat: 39.0 },
    localSolarHour: 12.0,
    volumetric: {
      cloudType: CloudType.CUMULUS,
      cloudCoverage: 0.35,
      cloudDensity: 0.7,
      cloudLayerBottom: 1500,
      cloudLayerTop: 3200,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "ground-lookup",
        regime: "ground",
        lon: -95.0,
        lat: 39.0,
        height: 800,
        heading: 0,
        pitch: 10,
      },
      {
        id: "in-deck",
        regime: "inside-deck",
        lon: -95.0,
        lat: 39.0,
        height: 2300,
        heading: 0,
        pitch: 0,
      },
      {
        id: "above-deck",
        regime: "above-deck",
        lon: -95.0,
        lat: 39.0,
        height: 9000,
        heading: 20,
        pitch: -25,
      },
      {
        id: "orbit",
        regime: "orbital",
        lon: -95.0,
        lat: 39.0,
        height: 18000000,
        heading: 0,
        pitch: -90,
      },
    ],
  },
  {
    id: "tradewind-cumulus-caribbean",
    gate: {
      minChangedFraction: 0.03,
      why: "Denser and lower than the plains field, so its floor is higher; a trade-wind deck that reads below 3% is not the formation this fixture names.",
    },
    climate: "tropical-maritime-tradewind",
    region: "caribbean-sea",
    cloudType: CloudType.CUMULUS,
    formation: "tradewind-mediocris",
    rationale:
      "SAME GENUS as the plains fixture, different formation: a moist maritime " +
      "trade-wind cumulus field sits lower, is more numerous and less eroded. " +
      "Two cumulus fixtures that differ only in their formation parameters are " +
      "the row's 'multiple same-type formations'.",
    anchor: { lon: -65.0, lat: 17.0 },
    localSolarHour: 10.0,
    volumetric: {
      cloudType: CloudType.CUMULUS,
      cloudCoverage: 0.55,
      cloudDensity: 0.85,
      cloudLayerBottom: 700,
      cloudLayerTop: 2400,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "ground-lookup",
        regime: "ground",
        lon: -65.0,
        lat: 17.0,
        height: 300,
        heading: 45,
        pitch: 12,
      },
      {
        id: "in-deck",
        regime: "inside-deck",
        lon: -65.0,
        lat: 17.0,
        height: 1500,
        heading: 45,
        pitch: 0,
      },
      {
        id: "above-deck",
        regime: "above-deck",
        lon: -65.0,
        lat: 17.0,
        height: 6000,
        heading: 45,
        pitch: -20,
      },
    ],
  },
  {
    id: "itcz-cumulonimbus-westpacific",
    gate: {
      minChangedFraction: 0.05,
      why: "A 13 km deep, 70%-coverage tower field fills a large fraction of every station view; anything under 5% means the deck interval collapsed.",
    },
    climate: "tropical-deep-convection",
    region: "west-pacific-warm-pool",
    cloudType: CloudType.CUMULONIMBUS,
    formation: "towering-anvil",
    rationale:
      "The deepest deck in the set (800-14000 m). Exercises the TOWER/anvil " +
      "genus profile and a shell thick enough that the ground, inside-deck and " +
      "above-deck regimes are far apart in march length, not just in altitude.",
    anchor: { lon: 150.0, lat: 5.0 },
    localSolarHour: 15.0,
    volumetric: {
      cloudType: CloudType.CUMULONIMBUS,
      cloudCoverage: 0.7,
      cloudDensity: 0.95,
      cloudLayerBottom: 800,
      cloudLayerTop: 14000,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "ground-lookup",
        regime: "ground",
        lon: 150.0,
        lat: 5.0,
        height: 400,
        heading: 0,
        pitch: 25,
      },
      {
        id: "in-deck",
        regime: "inside-deck",
        lon: 150.0,
        lat: 5.0,
        height: 6000,
        heading: 0,
        pitch: 0,
      },
      {
        id: "above-deck",
        regime: "above-deck",
        lon: 150.0,
        lat: 5.0,
        height: 18000,
        heading: 0,
        pitch: -20,
      },
      {
        id: "orbit",
        regime: "orbital",
        lon: 150.0,
        lat: 5.0,
        height: 12000000,
        heading: 0,
        pitch: -90,
      },
    ],
  },
  {
    id: "sepacific-stratocumulus-closed",
    gate: {
      minChangedFraction: 0.08,
      why: "A 90%-coverage closed-cell sheet is the highest-coverage low deck in the set; its floor is correspondingly the highest of the low-cloud fixtures.",
    },
    climate: "subtropical-marine-eastern-boundary",
    region: "southeast-pacific-off-peru",
    cloudType: CloudType.STRATOCUMULUS,
    formation: "closed-cell-sheet",
    rationale:
      "The planet's most persistent cloud deck: a shallow, near-solid " +
      "stratocumulus sheet capped by a subsidence inversion. A 600-1400 m deck " +
      "is thin enough that the inside-deck regime is a genuinely narrow band, " +
      "which is where deck-bound interval math fails first.",
    anchor: { lon: -80.0, lat: -20.0 },
    localSolarHour: 9.0,
    volumetric: {
      cloudType: CloudType.STRATOCUMULUS,
      cloudCoverage: 0.9,
      cloudDensity: 0.8,
      cloudLayerBottom: 600,
      cloudLayerTop: 1400,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "ground-lookup",
        regime: "ground",
        lon: -80.0,
        lat: -20.0,
        height: 200,
        heading: 270,
        pitch: 15,
      },
      {
        id: "in-deck",
        regime: "inside-deck",
        lon: -80.0,
        lat: -20.0,
        height: 1000,
        heading: 270,
        pitch: 0,
      },
      {
        id: "above-deck",
        regime: "above-deck",
        lon: -80.0,
        lat: -20.0,
        height: 5000,
        heading: 270,
        pitch: -25,
      },
    ],
  },
  {
    id: "southern-ocean-stratocumulus-open",
    gate: {
      minChangedFraction: 0.012,
      why: "Open cells are broken by construction (50% coverage, strong erosion), so the floor sits well below its closed-cell twin. Calibrated 2026-08-01: the above-deck vantage measured 0.017 on the first run (in-deck 0.251), so the floor moved from 0.03 to sit under the weakest legitimate regime with margin.",
    },
    climate: "cold-air-outbreak",
    region: "southern-ocean",
    cloudType: CloudType.STRATOCUMULUS,
    formation: "open-cell-broken",
    rationale:
      "SAME GENUS as the Peruvian sheet, opposite formation: a cold-air " +
      "outbreak breaks the deck into open cells — lower coverage, deeper, " +
      "stronger edge erosion. The pair proves the tour distinguishes formations " +
      "within a genus rather than re-rendering one canned stratocumulus.",
    anchor: { lon: -45.0, lat: -55.0 },
    localSolarHour: 12.0,
    volumetric: {
      cloudType: CloudType.STRATOCUMULUS,
      cloudCoverage: 0.5,
      cloudDensity: 0.6,
      cloudLayerBottom: 900,
      cloudLayerTop: 2600,
      cloudErosionStrength: 0.9,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "in-deck",
        regime: "inside-deck",
        lon: -45.0,
        lat: -55.0,
        height: 1800,
        heading: 180,
        pitch: 0,
      },
      {
        id: "above-deck",
        regime: "above-deck",
        lon: -45.0,
        lat: -55.0,
        height: 8000,
        heading: 180,
        pitch: -30,
      },
    ],
  },
  {
    id: "bengal-monsoon-nimbostratus",
    gate: {
      minChangedFraction: 0.1,
      why: "An overcast rain sheet at 95% coverage should dominate every station view; a low number here means saturation or early march termination, not thin cloud.",
    },
    climate: "monsoon",
    region: "bay-of-bengal",
    cloudType: CloudType.NIMBOSTRATUS,
    formation: "overcast-rain-sheet",
    rationale:
      "The densest genus profile (baseDensity 0.95 / extinction 0.9). An " +
      "overcast rain sheet is the saturated end of the density domain, where a " +
      "march that terminates early and a march that saturates look alike from " +
      "one screenshot and differ in the OFF/ON contribution metric.",
    anchor: { lon: 88.0, lat: 18.0 },
    localSolarHour: 11.0,
    volumetric: {
      cloudType: CloudType.NIMBOSTRATUS,
      cloudCoverage: 0.95,
      cloudDensity: 0.95,
      cloudLayerBottom: 700,
      cloudLayerTop: 6000,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "ground-lookup",
        regime: "ground",
        lon: 88.0,
        lat: 18.0,
        height: 300,
        heading: 90,
        pitch: 20,
      },
      {
        id: "in-deck",
        regime: "inside-deck",
        lon: 88.0,
        lat: 18.0,
        height: 3000,
        heading: 90,
        pitch: 0,
      },
      {
        id: "above-deck",
        regime: "above-deck",
        lon: 88.0,
        lat: 18.0,
        height: 11000,
        heading: 90,
        pitch: -25,
      },
    ],
  },
  {
    id: "arctic-stratus-svalbard",
    gate: {
      minChangedFraction: 0.02,
      why: "Polar DAY at the June solstice, so the deck is genuinely lit; Batch 735 turned this checkpoint from blank to green and the floor keeps it there.",
    },
    climate: "polar-marine",
    region: "arctic-ocean-north-of-svalbard",
    cloudType: CloudType.STRATUS,
    formation: "thin-polar-stratus",
    rationale:
      "NORTH-POLE approach, lit: at the June solstice the Arctic is in polar " +
      "day, so a thin stratus deck at 82N is genuinely illuminated and a blank " +
      "frame is a defect rather than night. Batch 735 replaced the pre-fix " +
      "north-pole blank with green WGS84 evidence; this fixture keeps that " +
      "checkpoint inside the tour.",
    anchor: { lon: 20.0, lat: 82.0 },
    localSolarHour: 12.0,
    volumetric: {
      cloudType: CloudType.STRATUS,
      cloudCoverage: 0.75,
      cloudDensity: 0.55,
      cloudLayerBottom: 300,
      cloudLayerTop: 1200,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "ground-lookup",
        regime: "ground",
        lon: 20.0,
        lat: 82.0,
        height: 150,
        heading: 0,
        pitch: 15,
      },
      {
        id: "above-deck",
        regime: "above-deck",
        lon: 20.0,
        lat: 82.0,
        height: 20000,
        heading: 0,
        pitch: -30,
      },
      {
        id: "pole-approach",
        regime: "above-deck",
        lon: 20.0,
        lat: 89.5,
        height: 20000,
        heading: 0,
        pitch: -30,
      },
    ],
  },
  {
    id: "antarctic-stratus-plateau",
    gate: {
      minChangedFraction: 0.02,
      why: "Polar DAY at the December solstice (see the rationale); matched to its Arctic twin so an asymmetry between the poles is visible as a gate result.",
    },
    climate: "polar-continental",
    region: "antarctic-plateau",
    cloudType: CloudType.STRATUS,
    formation: "shallow-ice-stratus",
    rationale:
      "SOUTH-POLE approach and the SAME GENUS as the Arctic fixture in the " +
      "opposite hemisphere. It is pinned to the DECEMBER solstice, not the " +
      "shared June one: at -78 latitude in June the sun never rises, so a " +
      "June-locked southern fixture would measure polar night and its blank " +
      "frame would be correct — useless as a pole-geometry oracle. December " +
      "puts the same geometry in polar DAY.",
    anchor: { lon: -45.0, lat: -78.0 },
    dateIso: "2026-12-21",
    localSolarHour: 12.0,
    volumetric: {
      cloudType: CloudType.STRATUS,
      cloudCoverage: 0.65,
      cloudDensity: 0.45,
      cloudLayerBottom: 400,
      cloudLayerTop: 1600,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "above-deck",
        regime: "above-deck",
        lon: -45.0,
        lat: -78.0,
        height: 20000,
        heading: 180,
        pitch: -30,
      },
      {
        id: "pole-approach",
        regime: "above-deck",
        lon: -45.0,
        lat: -89.5,
        height: 20000,
        heading: 180,
        pitch: -30,
      },
    ],
  },
  {
    id: "northatlantic-cirrus-fibratus",
    gate: {
      minChangedFraction: 0.002,
      why: "The thinnest genus in the set (extinction 0.1). A cirrus floor has to be an order of magnitude below the cumulus floors or it rejects a correct wispy render. HISTORY: pinned as a knownGapId ceiling 2026-08-01 when CIRRUS rendered ~nothing; the CLOUD-LOW-COVERAGE-CUTOFF fix restored visibility the same day (ground 0.0028, above-deck 0.0148) and the ceiling failed loudly as designed, flipping this back to the authored floor. Genus MORPHOLOGY (fibrous streaks vs generic puffs) remains C13-16.",
    },
    climate: "midlatitude-jetstream",
    region: "north-atlantic",
    cloudType: CloudType.CIRRUS,
    formation: "fibratus-filaments",
    rationale:
      "The thinnest genus profile (baseDensity 0.15 / extinction 0.1) at a HIGH " +
      "deck (8-11 km). Cirrus is the regime where a wispy correct render and a " +
      "missing render differ by a few counts of luminance, which is exactly why " +
      "the visibility oracle has to be an OFF/ON delta and not a bright-pixel " +
      "count.",
    anchor: { lon: -30.0, lat: 45.0 },
    localSolarHour: 14.0,
    volumetric: {
      cloudType: CloudType.CIRRUS,
      cloudCoverage: 0.45,
      cloudDensity: 0.35,
      cloudLayerBottom: 8000,
      cloudLayerTop: 11000,
      cloudSpecies: "fibratus",
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "ground-lookup",
        regime: "ground",
        lon: -30.0,
        lat: 45.0,
        height: 500,
        heading: 180,
        pitch: 35,
      },
      {
        id: "above-deck",
        regime: "above-deck",
        lon: -30.0,
        lat: 45.0,
        height: 16000,
        heading: 180,
        pitch: -20,
      },
    ],
  },
  {
    id: "sahara-clear-sky",
    gate: {
      maxChangedFraction: 0.02,
      why: "CEILING, not a floor. This climate is suppressed at 5% coverage; a large contribution here means the tour reports cloud where the configuration asks for almost none.",
    },
    climate: "subtropical-desert",
    region: "central-sahara",
    cloudType: CloudType.CUMULUS,
    formation: "suppressed-near-clear",
    rationale:
      "The NEGATIVE-SPACE control. A climate whose correct answer is 'almost " +
      "no cloud' is the only way to tell a working tour from one that always " +
      "reports cloud. Its gate is a CEILING, not a floor: a large contribution " +
      "here is the defect.",
    anchor: { lon: 12.0, lat: 24.0 },
    localSolarHour: 12.0,
    volumetric: {
      cloudType: CloudType.CUMULUS,
      cloudCoverage: 0.05,
      cloudDensity: 0.3,
      cloudLayerBottom: 2500,
      cloudLayerTop: 4200,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    negativeControl: true,
    stations: [
      {
        id: "ground-lookup",
        regime: "ground",
        lon: 12.0,
        lat: 24.0,
        height: 600,
        heading: 0,
        pitch: 20,
      },
      {
        id: "above-deck",
        regime: "above-deck",
        lon: 12.0,
        lat: 24.0,
        height: 12000,
        heading: 0,
        pitch: -30,
      },
    ],
  },
  {
    id: "dateline-east-convective",
    gate: {
      minChangedFraction: 0.03,
      why: "Broken oceanic convection at 60% coverage. Shared verbatim with the western twin so the pair is judged by one rule.",
    },
    climate: "tropical-maritime-tradewind",
    region: "west-pacific-east-of-antimeridian",
    cloudType: CloudType.CUMULUS,
    formation: "broken-oceanic",
    rationale:
      "EASTWARD dateline crossing (+179.6 looking east through +180). Paired " +
      "with its western twin so the crossing is exercised in BOTH directions " +
      "with an otherwise identical configuration — a wrap bug that is " +
      "sign-dependent shows up as an asymmetry between the pair, which a single " +
      "crossing cannot reveal.",
    anchor: { lon: 179.6, lat: 8.0 },
    localSolarHour: 12.0,
    dateline: "east",
    volumetric: {
      cloudType: CloudType.CUMULUS,
      cloudCoverage: 0.6,
      cloudDensity: 0.85,
      cloudLayerBottom: 1500,
      cloudLayerTop: 4000,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "horizon-east",
        regime: "above-deck",
        lon: 179.6,
        lat: 8.0,
        height: 9000,
        heading: 90,
        pitch: -5,
      },
      {
        id: "crossed-east",
        regime: "above-deck",
        lon: 180.4,
        lat: 8.0,
        height: 9000,
        heading: 90,
        pitch: -5,
      },
    ],
  },
  {
    id: "dateline-west-convective",
    gate: {
      minChangedFraction: 0.03,
      why: "Broken oceanic convection at 60% coverage. Shared verbatim with the eastern twin so the pair is judged by one rule.",
    },
    climate: "tropical-maritime-tradewind",
    region: "west-pacific-west-of-antimeridian",
    cloudType: CloudType.CUMULUS,
    formation: "broken-oceanic",
    rationale:
      "WESTWARD dateline crossing (-179.6 looking west through -180), the twin " +
      "of the eastward fixture. Same volumetric configuration and the same " +
      "pinned instant by construction; only the crossing direction differs, so " +
      "any east/west asymmetry in the result is the wrap and nothing else.",
    anchor: { lon: -179.6, lat: 8.0 },
    // Same INSTANT as the eastward twin: see `fixtureClockIso`.
    clockAnchorLon: 179.6,
    localSolarHour: 12.0,
    dateline: "west",
    twinOf: "dateline-east-convective",
    volumetric: {
      cloudType: CloudType.CUMULUS,
      cloudCoverage: 0.6,
      cloudDensity: 0.85,
      cloudLayerBottom: 1500,
      cloudLayerTop: 4000,
      cloudWindSpeed: 0,
      cloudWeatherMap: false,
      cloudVolumetricQuality: "high",
    },
    stations: [
      {
        id: "horizon-west",
        regime: "above-deck",
        lon: -179.6,
        lat: 8.0,
        height: 9000,
        heading: 270,
        pitch: -5,
      },
      {
        id: "crossed-west",
        regime: "above-deck",
        lon: -180.4,
        lat: 8.0,
        height: 9000,
        heading: 270,
        pitch: -5,
      },
    ],
  },
];

/** The fixture table, frozen. */
export const CLOUD_TOUR_FIXTURES = Object.freeze(
  FIXTURES.map((fixture) => Object.freeze(fixture)),
);

/** Fixture lookup by id. */
export function fixtureById(id) {
  return CLOUD_TOUR_FIXTURES.find((fixture) => fixture.id === id);
}

// ── Sequence table ─────────────────────────────────────────────────────────
//
// A sequence is an ORDERED phase list over ONE fixture. Every phase declares its
// frame count up front, so the total frame budget — and therefore the clock walk
// and the watchdog budget — is a constant derivable without running anything.
//
// `expectResetBits` names, per phase, which temporal history-reset reasons the
// phase is supposed to provoke (`WebGPUCloudTemporalHistory.ts`'s bit table).
// `forbidResetBits` names the ones it must NOT. This is what turns "camera
// teleport and history reset" from a screenshot into an assertion.

const TELEPORT_BIT = 1 << 3; // CLOUD_TEMPORAL_RESET_TELEPORT
const FRAME_GAP_BIT = 1 << 2; // CLOUD_TEMPORAL_RESET_FRAME_GAP
// Reserved for the open follow-up phase (temporal-tier toggle while clouds
// keep rendering) — the only cause that records temporalActive=false.
const _REACTIVATED_BIT = 1 << 7; // CLOUD_TEMPORAL_RESET_REACTIVATED
const DECK_BOUNDS_BIT = 1 << 8; // CLOUD_TEMPORAL_RESET_DECK_BOUNDS
const RESOURCE_BIT = 1 << 10; // CLOUD_TEMPORAL_RESET_RESOURCE

/**
 * Temporal tier. The reset/ghost sequences MUST run on a tier whose
 * `temporalEnabled` is true (T1 low / T2 medium) — on T3 the history does not
 * exist and every reset assertion would pass vacuously.
 */
const TEMPORAL_TIER = "medium";

/** Passes worth timing on a full-resolution straight-march lane. */
const FULLRES_PASSES = Object.freeze(["ProceduralClouds pass"]);

/** Passes worth timing on a temporal (half-res + reconstruct) lane. */
const TEMPORAL_PASSES = Object.freeze([
  "ProceduralClouds half-res pass",
  "CloudTemporalResolve pass",
  "CloudUpscale composite pass",
]);

const SEQUENCES = [
  // ── wind / time advancement: three lanes, one variable apart ────────────
  {
    id: "wind-time-pinned-control",
    kind: "wind-time",
    fixtureId: "plains-fairweather-cumulus",
    description: "clock PINNED, wind 0 — the determinism floor",
    rationale:
      "Neither time nor wind advances, so consecutive frames must be " +
      "essentially identical. This lane's frame-to-frame delta IS the noise " +
      "floor the other two lanes are measured against; without it a small " +
      "advection signal is indistinguishable from dither.",
    clock: { stepSeconds: 0, warmFrames: 24, measureFrames: 48 },
    volumetric: { cloudWindSpeed: 0, cloudVolumetricQuality: "high" },
    gpuPasses: FULLRES_PASSES,
    expect: { framewiseMotion: "static" },
    phases: [
      {
        id: "hold",
        action: "hold",
        stationId: "above-deck",
        frames: 48,
        capture: true,
        expectResetBits: 0,
        resetAssertFromFrame: 4,
      },
    ],
  },
  {
    id: "wind-time-clock-only",
    kind: "wind-time",
    fixtureId: "plains-fairweather-cumulus",
    description: "clock ADVANCES 60 s/frame, wind 0 — sun-only motion",
    rationale:
      "Isolates what time alone does. The cloud FIELD cannot advect (wind is " +
      "zero) so any frame-to-frame delta here is sun/lighting, and the wind " +
      "lane's excess over this lane is the advection signal.",
    clock: { stepSeconds: 60, warmFrames: 24, measureFrames: 48 },
    volumetric: { cloudWindSpeed: 0, cloudVolumetricQuality: "high" },
    gpuPasses: FULLRES_PASSES,
    expect: { framewiseMotion: "lighting-only" },
    phases: [
      {
        id: "hold",
        action: "hold",
        stationId: "above-deck",
        frames: 48,
        capture: true,
        expectResetBits: 0,
        resetAssertFromFrame: 4,
      },
    ],
  },
  {
    id: "wind-time-advection",
    kind: "wind-time",
    fixtureId: "plains-fairweather-cumulus",
    description: "clock ADVANCES 60 s/frame, wind 15 m/s — field advection",
    rationale:
      "Same clock walk as the control lane plus wind, so the difference " +
      "between the two lanes' frame-to-frame deltas is attributable to " +
      "advection. 15 m/s x 60 s = 900 m of displacement per frame, far above " +
      "any quantization grid in the publish path, so the motion is real rather " +
      "than a rounding artifact.",
    clock: { stepSeconds: 60, warmFrames: 24, measureFrames: 48 },
    volumetric: {
      cloudWindSpeed: 15,
      cloudWindDirection: { x: 1, y: 0 },
      cloudVolumetricQuality: "high",
    },
    gpuPasses: FULLRES_PASSES,
    expect: { framewiseMotion: "advecting" },
    phases: [
      {
        id: "hold",
        action: "hold",
        stationId: "above-deck",
        frames: 48,
        capture: true,
        expectResetBits: 0,
        resetAssertFromFrame: 4,
      },
    ],
  },

  // ── camera teleport ────────────────────────────────────────────────────
  {
    id: "teleport-hemisphere-jump",
    kind: "teleport",
    fixtureId: "plains-fairweather-cumulus",
    description:
      "converge, teleport to the antipode, converge, return — history must " +
      "reset on each discontinuity and only on those frames",
    rationale:
      "A teleport is the one camera motion reprojection cannot follow. The " +
      "assertion is two-sided: the TELEPORT reset bit must be set on the jump " +
      "frames and CLEAR on the settled frames either side, so a renderer that " +
      "resets every frame fails just as loudly as one that never resets.",
    clock: { stepSeconds: 0, warmFrames: 24, measureFrames: 0 },
    volumetric: { cloudVolumetricQuality: TEMPORAL_TIER, cloudWindSpeed: 0 },
    gpuPasses: TEMPORAL_PASSES,
    phases: [
      {
        id: "origin-converge",
        action: "hold",
        stationId: "above-deck",
        frames: 24,
        capture: true,
        expectResetBits: 0,
        forbidResetBits: TELEPORT_BIT,
        resetAssertFromFrame: 4,
      },
      {
        id: "teleport-antipode",
        action: "teleport",
        station: {
          id: "antipode",
          regime: "above-deck",
          lon: 85.0,
          lat: -39.0,
          height: 9000,
          heading: 20,
          pitch: -25,
        },
        frames: 1,
        capture: true,
        expectResetBits: TELEPORT_BIT,
      },
      {
        id: "antipode-converge",
        action: "hold",
        frames: 24,
        capture: true,
        expectResetBits: 0,
        forbidResetBits: TELEPORT_BIT,
        resetAssertFromFrame: 4,
      },
      {
        id: "teleport-back",
        action: "return",
        stationId: "above-deck",
        frames: 1,
        capture: true,
        expectResetBits: TELEPORT_BIT,
      },
      {
        id: "return-converge",
        action: "hold",
        frames: 24,
        capture: true,
        expectResetBits: 0,
        forbidResetBits: TELEPORT_BIT,
        resetAssertFromFrame: 4,
      },
    ],
  },

  // ── history reset taxonomy ─────────────────────────────────────────────
  {
    id: "history-reset-taxonomy",
    kind: "history-reset",
    fixtureId: "sepacific-stratocumulus-closed",
    description:
      "walk four independent reset causes — reactivation, deck-bounds change, " +
      "resource resize, teleport — and require each to name ITSELF",
    rationale:
      "The reset classifier reports a BITMASK, so a probe that only checks " +
      "'nonzero' cannot tell a deck-bounds reset from a resource reset. Each " +
      "phase provokes exactly one cause and requires that cause's bit, which " +
      "makes a future mis-classification a named failure instead of a silent " +
      "one. Runs at a temporal tier because T3 has no history to reset.",
    clock: { stepSeconds: 0, warmFrames: 24, measureFrames: 0 },
    volumetric: { cloudVolumetricQuality: TEMPORAL_TIER, cloudWindSpeed: 0 },
    gpuPasses: TEMPORAL_PASSES,
    phases: [
      {
        id: "converge",
        action: "hold",
        stationId: "above-deck",
        frames: 24,
        capture: true,
        expectResetBits: 0,
        resetAssertFromFrame: 4,
      },
      {
        id: "clouds-off",
        action: "disable-clouds",
        frames: 4,
        capture: false,
      },
      {
        id: "clouds-on",
        action: "enable-clouds",
        frames: 1,
        capture: true,
        // FRAME_GAP, not REACTIVATED (2026-08-01 calibration): a FULL
        // clouds-off toggle renders no cloud frames at all, so no frame can
        // record temporalActive=false — the classifier legitimately sees only
        // the frame-number gap on re-entry. REACTIVATED is reserved for a
        // temporal-tier toggle while clouds keep rendering (a phase this
        // sequence does not yet include; adding one is open follow-up).
        expectResetBits: FRAME_GAP_BIT,
      },
      {
        id: "settle-after-reactivate",
        action: "hold",
        frames: 16,
        capture: false,
        expectResetBits: 0,
        resetAssertFromFrame: 4,
      },
      {
        id: "deck-raised",
        action: "set-deck",
        deck: { bottom: 900, top: 2600 },
        frames: 1,
        capture: true,
        expectResetBits: DECK_BOUNDS_BIT,
      },
      {
        id: "settle-after-deck",
        action: "hold",
        frames: 16,
        capture: false,
        expectResetBits: 0,
        resetAssertFromFrame: 4,
      },
      {
        id: "resized",
        action: "resize",
        viewport: { width: 960, height: 640 },
        frames: 2,
        capture: true,
        expectResetBits: RESOURCE_BIT,
      },
      {
        id: "settle-after-resize",
        action: "hold",
        frames: 16,
        capture: false,
        expectResetBits: 0,
        resetAssertFromFrame: 4,
      },
      {
        id: "teleport",
        action: "teleport",
        station: {
          id: "far-jump",
          regime: "above-deck",
          lon: 100.0,
          lat: 20.0,
          height: 5000,
          heading: 90,
          pitch: -25,
        },
        frames: 1,
        capture: true,
        expectResetBits: TELEPORT_BIT,
      },
    ],
  },

  // ── temporal delta / ghosting ──────────────────────────────────────────
  {
    id: "temporal-ghost-pan-return",
    kind: "temporal-ghost",
    fixtureId: "tradewind-cumulus-caribbean",
    description:
      "converge at a pose, pan away, pan BACK to the identical pose, converge " +
      "again — the residual between the two converged frames is the ghost",
    rationale:
      "The prior temporal probe captured static/moving/settled screenshots and " +
      "left the judgement to a human eye, which is why the ledger records " +
      "'numeric ghost/flicker/history metrics are not yet implemented'. " +
      "Returning to the EXACT entry pose makes the oracle numeric and " +
      "self-referential: with a pinned clock and zero wind the reconverged " +
      "frame must match the pre-pan frame, and whatever it does not match by " +
      "is history contamination. No cross-run baseline is needed.",
    clock: { stepSeconds: 0, warmFrames: 24, measureFrames: 0 },
    volumetric: { cloudVolumetricQuality: TEMPORAL_TIER, cloudWindSpeed: 0 },
    gpuPasses: TEMPORAL_PASSES,
    phases: [
      {
        id: "converged-reference",
        action: "hold",
        stationId: "above-deck",
        frames: 40,
        capture: true,
        expectResetBits: 0,
        resetAssertFromFrame: 4,
      },
      {
        id: "pan-away",
        action: "pan",
        pan: { headingDeltaDegrees: 1.6, frames: 25 },
        frames: 25,
        capture: true,
      },
      {
        id: "pan-back",
        action: "pan",
        pan: { headingDeltaDegrees: -1.6, frames: 25 },
        frames: 25,
        capture: false,
      },
      {
        id: "reconverged",
        action: "return",
        stationId: "above-deck",
        frames: 40,
        capture: true,
      },
    ],
  },
];

/** The sequence table, frozen. */
export const CLOUD_TOUR_SEQUENCES = Object.freeze(
  SEQUENCES.map((sequence) => Object.freeze(sequence)),
);

/** Sequence lookup by id. */
export function sequenceById(id) {
  return CLOUD_TOUR_SEQUENCES.find((sequence) => sequence.id === id);
}

/** Total rendered frames a sequence will execute — a constant, so the caller
 * can size a watchdog without running anything. */
export function sequenceFrameBudget(sequence) {
  const warm = sequence.clock?.warmFrames ?? 0;
  const measure = sequence.clock?.measureFrames ?? 0;
  const phases = sequence.phases.reduce(
    (total, phase) => total + (phase.frames ?? 0),
    0,
  );
  return warm + measure + phases;
}

// ── Validation ─────────────────────────────────────────────────────────────

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Structural + physical validation of ONE fixture. Returns failure strings; an
 * empty array means the fixture is sound. Never throws, so a whole table can be
 * reported at once instead of one error per run.
 *
 * @param {object} fixture
 * @returns {string[]}
 */
export function validateFixture(fixture) {
  const failures = [];
  const id = fixture?.id ?? "(unnamed)";
  const need = (condition, message) => {
    if (!condition) {
      failures.push(`${id}: ${message}`);
    }
  };

  need(typeof fixture?.id === "string" && fixture.id.length > 3, "missing id");
  need(typeof fixture?.climate === "string", "missing climate");
  need(typeof fixture?.region === "string", "missing region");
  need(typeof fixture?.formation === "string", "missing formation");
  need(
    typeof fixture?.rationale === "string" && fixture.rationale.length > 40,
    "missing rationale (say what this fixture is evidence FOR)",
  );
  need(
    CloudType.validate?.(fixture?.cloudType) ??
      isFiniteNumber(fixture?.cloudType),
    `cloudType ${String(fixture?.cloudType)} is not a CloudType genus`,
  );
  need(
    isFiniteNumber(fixture?.anchor?.lon) &&
      isFiniteNumber(fixture?.anchor?.lat),
    "anchor must carry finite lon/lat",
  );
  need(
    fixture?.localSolarHour >= 0 && fixture?.localSolarHour < 24,
    "localSolarHour must be in [0, 24)",
  );

  const volumetric = fixture?.volumetric ?? {};
  need(
    volumetric.cloudType === fixture?.cloudType,
    "volumetric.cloudType must equal the fixture's declared genus — the " +
      "renderer reads the volumetric copy, so a mismatch renders a genus the " +
      "manifest does not name",
  );
  const bottom = volumetric.cloudLayerBottom;
  const top = volumetric.cloudLayerTop;
  need(
    isFiniteNumber(bottom) && bottom >= 0,
    "cloudLayerBottom must be finite",
  );
  need(isFiniteNumber(top) && top > bottom, "cloudLayerTop must exceed bottom");
  need(
    volumetric.cloudCoverage >= 0 && volumetric.cloudCoverage <= 1,
    "cloudCoverage must be in [0, 1]",
  );
  need(
    volumetric.cloudDensity >= 0 && volumetric.cloudDensity <= 1,
    "cloudDensity must be in [0, 1]",
  );
  need(
    volumetric.cloudWeatherMap === false,
    "cloudWeatherMap must be explicitly false — an implicit weather map makes " +
      "the fixture's field depend on data this table does not pin",
  );

  // Every fixture declares its own visibility gate and says WHY. A shared
  // default threshold is how a cirrus fixture ends up judged by a cumulus rule
  // and reported RED for rendering correctly.
  const gate = fixture?.gate ?? {};
  const hasFloor = isFiniteNumber(gate.minChangedFraction);
  const hasCeiling = isFiniteNumber(gate.maxChangedFraction);
  need(
    hasFloor !== hasCeiling,
    "gate must declare exactly one of minChangedFraction (a floor) or " +
      "maxChangedFraction (a ceiling, for a negative-space control)",
  );
  if (hasFloor) {
    need(
      gate.minChangedFraction > 0 && gate.minChangedFraction < 1,
      "gate.minChangedFraction must be a fraction in (0, 1)",
    );
  }
  if (hasCeiling) {
    need(
      gate.maxChangedFraction > 0 && gate.maxChangedFraction < 1,
      "gate.maxChangedFraction must be a fraction in (0, 1)",
    );
    need(
      fixture?.negativeControl === true ||
        (typeof fixture?.knownGapId === "string" &&
          fixture.knownGapId.length > 0 &&
          gate.why.includes(fixture.knownGapId)),
      "only a fixture declared negativeControl, or one pinning a tracked " +
        "knownGapId that its gate.why names, may use a ceiling gate",
    );
  }
  need(
    typeof gate.why === "string" && gate.why.length > 20,
    "gate.why must justify the threshold — an unexplained number is a number " +
      "nobody can revise safely",
  );

  const stations = Array.isArray(fixture?.stations) ? fixture.stations : [];
  need(stations.length > 0, "needs at least one camera station");
  const stationIds = new Set();
  for (const station of stations) {
    const label = `${id}/${station?.id ?? "(unnamed station)"}`;
    if (typeof station?.id !== "string") {
      failures.push(`${label}: missing station id`);
      continue;
    }
    if (stationIds.has(station.id)) {
      failures.push(`${label}: duplicate station id`);
    }
    stationIds.add(station.id);
    if (!STATION_REGIMES.includes(station.regime)) {
      failures.push(`${label}: unknown regime ${String(station.regime)}`);
    }
    for (const key of ["lon", "lat", "height", "heading", "pitch"]) {
      if (!isFiniteNumber(station[key])) {
        failures.push(`${label}: ${key} must be a finite number`);
      }
    }
    if (!(station.lat >= -90 && station.lat <= 90)) {
      failures.push(`${label}: latitude out of range`);
    }
    // Regime vs the fixture's OWN deck — the check that catches an
    // "inside-deck" station authored above the deck it claims to occupy.
    if (
      isFiniteNumber(station.height) &&
      isFiniteNumber(bottom) &&
      isFiniteNumber(top)
    ) {
      const h = station.height;
      if (station.regime === "ground" && !(h < bottom)) {
        failures.push(
          `${label}: regime ground but height ${h} is not below the deck base ${bottom}`,
        );
      }
      if (station.regime === "inside-deck" && !(h > bottom && h < top)) {
        failures.push(
          `${label}: regime inside-deck but height ${h} is outside [${bottom}, ${top}]`,
        );
      }
      if (station.regime === "above-deck" && !(h > top && h < 1e6)) {
        failures.push(
          `${label}: regime above-deck but height ${h} is not above the deck top ${top} and below 1e6 m`,
        );
      }
      if (station.regime === "orbital" && !(h >= 1e6)) {
        failures.push(
          `${label}: regime orbital but height ${h} is below 1e6 m`,
        );
      }
    }
  }
  return failures;
}

/**
 * Whole-table validation: per-fixture soundness, unique ids, and the coverage
 * the C13-01 row demands in its own words.
 *
 * @param {object[]} [fixtures]
 * @returns {string[]}
 */
export function validateFixtureSet(fixtures = CLOUD_TOUR_FIXTURES) {
  const failures = [];
  const ids = new Set();
  for (const fixture of fixtures) {
    failures.push(...validateFixture(fixture));
    if (ids.has(fixture.id)) {
      failures.push(`duplicate fixture id ${fixture.id}`);
    }
    ids.add(fixture.id);
  }

  const coverage = summarizeFixtureCoverage(fixtures);
  if (coverage.climates.length < 4) {
    failures.push(
      `only ${coverage.climates.length} distinct climates (row requires at least four)`,
    );
  }
  if (coverage.regions.length < 4) {
    failures.push(
      `only ${coverage.regions.length} distinct regions (row requires at least four)`,
    );
  }
  if (coverage.genera.length < 3) {
    failures.push(
      `only ${coverage.genera.length} distinct cloud genera (row requires at least three)`,
    );
  }
  if (coverage.sameTypeGroups.length < 1) {
    failures.push(
      "no genus carries multiple formations (row requires multiple same-type formations)",
    );
  }
  // Same-type VARIATION: within a genus, two fixtures may not share a
  // configuration — that would be the same formation rendered twice rather than
  // the row's "multiple same-type formations". A DECLARED TWIN is the deliberate
  // exception, and it earns that exemption by being validated the other way:
  // a twin MUST match its partner exactly, because the twin's whole purpose is
  // to vary one thing outside the configuration (here, the crossing direction).
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  for (const group of coverage.sameTypeGroups) {
    const seen = new Map();
    for (const fixtureId of group.fixtureIds) {
      const fixture = byId.get(fixtureId);
      const config = stableStringify(fixture?.volumetric ?? null);
      const previous = seen.get(config);
      if (previous === undefined) {
        seen.set(config, fixtureId);
        continue;
      }
      const declaredTwin =
        fixture?.twinOf === previous ||
        byId.get(previous)?.twinOf === fixtureId;
      if (!declaredTwin) {
        failures.push(
          `${group.genus}: ${previous} and ${fixtureId} share an identical volumetric ` +
            "configuration without declaring `twinOf` — that is the same formation " +
            "twice, not same-type variation",
        );
      }
    }
  }
  for (const fixture of fixtures) {
    if (typeof fixture.twinOf !== "string") {
      continue;
    }
    const partner = byId.get(fixture.twinOf);
    if (!partner) {
      failures.push(
        `${fixture.id}: twinOf names unknown fixture ${fixture.twinOf}`,
      );
      continue;
    }
    if (
      stableStringify(fixture.volumetric) !==
      stableStringify(partner.volumetric)
    ) {
      failures.push(
        `${fixture.id}: declares twinOf ${partner.id} but their volumetric ` +
          "configurations differ — a twin that differs in configuration cannot " +
          "isolate the variable it claims to isolate",
      );
    }
    if (fixtureClockIso(fixture) !== fixtureClockIso(partner)) {
      failures.push(
        `${fixture.id}: twin of ${partner.id} but pinned to a different instant — ` +
          "the pair would then differ in illumination as well as in the variable " +
          "under test",
      );
    }
    if (fixture.dateline === partner.dateline) {
      failures.push(
        `${fixture.id}: twin of ${partner.id} with the same dateline direction — ` +
          "the pair varies nothing",
      );
    }
  }
  for (const regime of STATION_REGIMES) {
    if (!coverage.regimes.includes(regime)) {
      failures.push(`no station covers the ${regime} regime`);
    }
  }
  for (const direction of ["east", "west"]) {
    if (!coverage.datelineDirections.includes(direction)) {
      failures.push(`no fixture crosses the dateline ${direction}ward`);
    }
  }
  if (!coverage.poles.includes("north")) {
    failures.push("no fixture approaches the north pole (|lat| >= 80 N)");
  }
  if (!coverage.poles.includes("south")) {
    failures.push("no fixture approaches the south pole (|lat| >= 80 S)");
  }
  if (!coverage.hasNegativeControl) {
    failures.push(
      "no negative-space control fixture — without a climate whose correct " +
        "answer is 'almost no cloud', a tour that always reports cloud passes",
    );
  }
  if (!coverage.hasAltitudeTransition) {
    failures.push(
      "no fixture provides an altitude transition (a station pair whose heights differ by 10x)",
    );
  }
  return failures;
}

/**
 * Coverage summary, in the row's vocabulary. Pure; the spec asserts against it
 * and the probe writes it into the manifest so a reader can see what the run
 * actually covered.
 *
 * @param {object[]} [fixtures]
 */
export function summarizeFixtureCoverage(fixtures = CLOUD_TOUR_FIXTURES) {
  const climates = new Set();
  const regions = new Set();
  const generaByValue = new Map();
  const regimes = new Set();
  const datelineDirections = new Set();
  const poles = new Set();
  let hasNegativeControl = false;
  let hasAltitudeTransition = false;

  for (const fixture of fixtures) {
    climates.add(fixture.climate);
    regions.add(fixture.region);
    const list = generaByValue.get(fixture.cloudType) ?? [];
    list.push(fixture.id);
    generaByValue.set(fixture.cloudType, list);
    if (fixture.dateline) {
      datelineDirections.add(fixture.dateline);
    }
    if (fixture.negativeControl === true) {
      hasNegativeControl = true;
    }
    const heights = [];
    for (const station of fixture.stations ?? []) {
      regimes.add(station.regime);
      heights.push(station.height);
      if (station.lat >= 80) {
        poles.add("north");
      }
      if (station.lat <= -80) {
        poles.add("south");
      }
    }
    if (heights.length > 1) {
      const min = Math.min(...heights);
      const max = Math.max(...heights);
      if (min > 0 && max / min >= 10) {
        hasAltitudeTransition = true;
      }
    }
  }

  const sameTypeGroups = [...generaByValue.entries()]
    .filter(([, fixtureIds]) => fixtureIds.length > 1)
    .map(([cloudType, fixtureIds]) => ({
      cloudType,
      genus: genusName(cloudType),
      fixtureIds,
    }));

  return {
    climates: [...climates].sort(),
    regions: [...regions].sort(),
    genera: [...generaByValue.keys()].sort((a, b) => a - b).map(genusName),
    sameTypeGroups,
    regimes: [...regimes].sort(),
    datelineDirections: [...datelineDirections].sort(),
    poles: [...poles].sort(),
    hasNegativeControl,
    hasAltitudeTransition,
  };
}

/**
 * Structural validation of ONE sequence against the fixture table.
 *
 * @param {object} sequence
 * @param {object[]} [fixtures]
 * @returns {string[]}
 */
export function validateSequence(sequence, fixtures = CLOUD_TOUR_FIXTURES) {
  const failures = [];
  const id = sequence?.id ?? "(unnamed)";
  const need = (condition, message) => {
    if (!condition) {
      failures.push(`${id}: ${message}`);
    }
  };

  need(typeof sequence?.id === "string", "missing id");
  need(
    SEQUENCE_KINDS.includes(sequence?.kind),
    `unknown kind ${String(sequence?.kind)}`,
  );
  need(
    typeof sequence?.rationale === "string" && sequence.rationale.length > 40,
    "missing rationale (say what this sequence is evidence FOR)",
  );

  const fixture = fixtures.find((entry) => entry.id === sequence?.fixtureId);
  need(!!fixture, `unknown fixtureId ${String(sequence?.fixtureId)}`);

  need(
    isFiniteNumber(sequence?.clock?.stepSeconds) &&
      sequence.clock.stepSeconds >= 0,
    "clock.stepSeconds must be a finite, non-negative constant — a sequence " +
      "that advances time by wall clock is not replayable",
  );
  need(
    Number.isInteger(sequence?.clock?.warmFrames) &&
      sequence.clock.warmFrames >= 0,
    "clock.warmFrames must be a non-negative integer",
  );
  need(
    Array.isArray(sequence?.gpuPasses) && sequence.gpuPasses.length > 0,
    "gpuPasses must name at least one GPU pass label to attribute timing to",
  );

  const phases = Array.isArray(sequence?.phases) ? sequence.phases : [];
  need(phases.length > 0, "needs at least one phase");
  const phaseIds = new Set();
  let capturedPhases = 0;
  let sawStation = false;
  for (const phase of phases) {
    const label = `${id}/${phase?.id ?? "(unnamed phase)"}`;
    if (typeof phase?.id !== "string") {
      failures.push(`${label}: missing phase id`);
      continue;
    }
    if (phaseIds.has(phase.id)) {
      failures.push(`${label}: duplicate phase id`);
    }
    phaseIds.add(phase.id);
    if (!PHASE_ACTIONS.includes(phase.action)) {
      failures.push(`${label}: unknown action ${String(phase.action)}`);
    }
    if (!Number.isInteger(phase.frames) || phase.frames < 1) {
      failures.push(
        `${label}: frames must be a positive integer — an unbounded phase has no deadline`,
      );
    }
    if (phase.capture === true) {
      capturedPhases++;
    }
    if (typeof phase.stationId === "string") {
      sawStation = true;
      const known = (fixture?.stations ?? []).some(
        (station) => station.id === phase.stationId,
      );
      if (!known) {
        failures.push(
          `${label}: stationId ${phase.stationId} is not a station of ${String(
            sequence?.fixtureId,
          )}`,
        );
      }
    }
    if (phase.station) {
      sawStation = true;
      for (const key of ["lon", "lat", "height", "heading", "pitch"]) {
        if (!isFiniteNumber(phase.station[key])) {
          failures.push(`${label}: inline station ${key} must be finite`);
        }
      }
    }
    if (phase.action === "set-deck") {
      const deck = phase.deck ?? {};
      if (!(
        isFiniteNumber(deck.bottom) &&
        isFiniteNumber(deck.top) &&
        deck.top > deck.bottom
      )) {
        failures.push(`${label}: set-deck requires deck.bottom < deck.top`);
      }
    }
    if (phase.action === "resize") {
      const viewport = phase.viewport ?? {};
      if (!(
        Number.isInteger(viewport.width) && Number.isInteger(viewport.height)
      )) {
        failures.push(
          `${label}: resize requires an integer viewport width/height`,
        );
      }
    }
    if (phase.action === "pan") {
      const pan = phase.pan ?? {};
      if (!(
        isFiniteNumber(pan.headingDeltaDegrees) && Number.isInteger(pan.frames)
      )) {
        failures.push(
          `${label}: pan requires a finite headingDeltaDegrees and an integer frame count`,
        );
      } else if (pan.frames !== phase.frames) {
        failures.push(
          `${label}: pan.frames ${pan.frames} disagrees with phase.frames ${phase.frames}`,
        );
      }
    }
    for (const key of ["expectResetBits", "forbidResetBits"]) {
      if (phase[key] !== undefined && !Number.isInteger(phase[key])) {
        failures.push(`${label}: ${key} must be an integer bitmask`);
      }
    }
    // GRACE WINDOW. A phase that follows a discontinuity legitimately carries
    // the tail of that discontinuity's reset on its first frame or two — the
    // history is being rebuilt. Asserting "no resets at all" from frame zero
    // would make a correct renderer fail. The grace is explicit and bounded so
    // it cannot quietly grow into "assert nothing".
    if (phase.resetAssertFromFrame !== undefined) {
      if (
        !Number.isInteger(phase.resetAssertFromFrame) ||
        phase.resetAssertFromFrame < 0
      ) {
        failures.push(
          `${label}: resetAssertFromFrame must be a non-negative integer`,
        );
      } else if (
        Number.isInteger(phase.frames) &&
        phase.resetAssertFromFrame >= phase.frames
      ) {
        failures.push(
          `${label}: resetAssertFromFrame ${phase.resetAssertFromFrame} covers the ` +
            `whole ${phase.frames}-frame phase — the assertion would be vacuous`,
        );
      } else if (
        Number.isInteger(phase.frames) &&
        phase.resetAssertFromFrame > phase.frames / 2
      ) {
        failures.push(
          `${label}: resetAssertFromFrame ${phase.resetAssertFromFrame} skips more than ` +
            `half of the phase's ${phase.frames} frames`,
        );
      }
    }
    if (
      phase.expectResetBits !== undefined &&
      phase.expectResetBits !== 0 &&
      (phase.resetAssertFromFrame ?? 0) !== 0
    ) {
      failures.push(
        `${label}: a phase that EXPECTS a reset must observe from frame 0 — the ` +
          "reset it is looking for is the edge at the start of the phase",
      );
    }
    if (
      Number.isInteger(phase.expectResetBits) &&
      Number.isInteger(phase.forbidResetBits) &&
      (phase.expectResetBits & phase.forbidResetBits) !== 0
    ) {
      failures.push(`${label}: expectResetBits and forbidResetBits overlap`);
    }
  }
  need(
    capturedPhases > 0,
    "no phase captures a frame — the sequence produces no pixels",
  );
  need(
    sawStation,
    "no phase names a camera station — the camera pose is unauthored",
  );

  // A sequence that asserts a history reset must run on a tier that HAS a
  // history. Asserting reset bits on T3 would pass vacuously.
  const assertsReset = phases.some(
    (phase) =>
      Number.isInteger(phase.expectResetBits) && phase.expectResetBits !== 0,
  );
  if (assertsReset) {
    const tier = sequence?.volumetric?.cloudVolumetricQuality;
    need(
      tier === "low" || tier === "medium",
      "asserts temporal history resets but does not pin a TEMPORAL tier " +
        "(low/medium) — on a non-temporal tier there is no history and every " +
        "reset assertion is vacuous",
    );
  }
  return failures;
}

/**
 * Whole sequence-table validation, including the kind coverage the row's
 * "wind/time advancement, camera teleport, and history reset" demands.
 *
 * @param {object[]} [sequences]
 * @param {object[]} [fixtures]
 * @returns {string[]}
 */
export function validateSequenceSet(
  sequences = CLOUD_TOUR_SEQUENCES,
  fixtures = CLOUD_TOUR_FIXTURES,
) {
  const failures = [];
  const ids = new Set();
  for (const sequence of sequences) {
    failures.push(...validateSequence(sequence, fixtures));
    if (ids.has(sequence.id)) {
      failures.push(`duplicate sequence id ${sequence.id}`);
    }
    ids.add(sequence.id);
  }

  const kinds = new Set(sequences.map((sequence) => sequence.kind));
  for (const kind of SEQUENCE_KINDS) {
    if (!kinds.has(kind)) {
      failures.push(`no sequence of kind ${kind}`);
    }
  }

  // The wind/time lanes are only evidence as a SET: three lanes over one
  // fixture differing by exactly one variable each.
  const windLanes = sequences.filter(
    (sequence) => sequence.kind === "wind-time",
  );
  if (windLanes.length < 3) {
    failures.push(
      `only ${windLanes.length} wind-time lanes — advection cannot be separated ` +
        "from sun motion without a pinned control and a clock-only control",
    );
  } else {
    const fixtureIds = new Set(windLanes.map((lane) => lane.fixtureId));
    if (fixtureIds.size !== 1) {
      failures.push(
        "wind-time lanes span multiple fixtures — the lanes must differ by the " +
          "clock/wind variable alone, not by scene",
      );
    }
    const pinned = windLanes.filter((lane) => lane.clock.stepSeconds === 0);
    const advancing = windLanes.filter((lane) => lane.clock.stepSeconds > 0);
    if (pinned.length < 1) {
      failures.push("wind-time set has no pinned-clock control lane");
    }
    if (advancing.length < 2) {
      failures.push(
        "wind-time set needs two advancing-clock lanes (wind on and wind off)",
      );
    }
    const advancingWind = advancing.map(
      (lane) => (lane.volumetric?.cloudWindSpeed ?? 0) > 0,
    );
    if (!advancingWind.includes(true) || !advancingWind.includes(false)) {
      failures.push(
        "the two advancing-clock lanes must differ in cloudWindSpeed — otherwise " +
          "advection and sun motion are confounded",
      );
    }
    const steps = new Set(advancing.map((lane) => lane.clock.stepSeconds));
    if (steps.size !== 1) {
      failures.push(
        "advancing wind-time lanes use different clock steps — they are then not " +
          "comparable to each other",
      );
    }
  }
  return failures;
}

export default {
  CLOUD_TOUR_SCHEMA_VERSION,
  TOUR_EPOCH_DATE,
  STATION_REGIMES,
  PHASE_ACTIONS,
  SEQUENCE_KINDS,
  CLOUD_TOUR_FIXTURES,
  CLOUD_TOUR_SEQUENCES,
  genusName,
  utcIsoForLocalSolarHour,
  stableStringify,
  replayKeyFor,
  fixtureReplaySubset,
  sequenceReplaySubset,
  fixtureClockIso,
  fixtureById,
  sequenceById,
  sequenceFrameBudget,
  validateFixture,
  validateFixtureSet,
  summarizeFixtureCoverage,
  validateSequence,
  validateSequenceSet,
};
