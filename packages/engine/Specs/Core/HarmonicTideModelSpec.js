import {
  HarmonicTideModel,
  JulianDate,
  TidalConstituents,
} from "../../index.js";

describe("Core/HarmonicTideModel", function () {
  const time = JulianDate.fromIso8601("2026-07-03T05:00:00Z");

  function stationFor(constituents) {
    const station = HarmonicTideModel.createStation(constituents);
    station.valid = true;
    return station;
  }

  it("rejects missing and truncated constituent arrays", function () {
    const station = stationFor([TidalConstituents.M2]);

    station.amplitudeM = new Float64Array(0);
    expect(HarmonicTideModel.predict(time, station).valid).toBe(false);

    station.amplitudeM = new Float64Array([0.5]);
    station.phaseLagRadians = new Float64Array(0);
    expect(HarmonicTideModel.predict(time, station).valid).toBe(false);

    station.phaseLagRadians = new Float64Array([0.0]);
    station.constituents = [];
    expect(HarmonicTideModel.predict(time, station).valid).toBe(false);
  });

  it("never reports an all-NaN atlas station as valid", function () {
    const station = stationFor([TidalConstituents.M2]);
    station.amplitudeM[0] = Number.NaN;
    station.phaseLagRadians[0] = 0.0;

    const amplitudeResult = HarmonicTideModel.predict(time, station);
    expect(amplitudeResult.valid).toBe(false);
    expect(amplitudeResult.heightM).toBe(0.0);
    expect(Number.isFinite(amplitudeResult.heightM)).toBe(true);

    station.amplitudeM[0] = 0.5;
    station.phaseLagRadians[0] = Number.NaN;
    const lagResult = HarmonicTideModel.predict(time, station);
    expect(lagResult.valid).toBe(false);
    expect(lagResult.heightM).toBe(0.0);
    expect(Number.isFinite(lagResult.heightM)).toBe(true);
  });

  it("uses finite rows from a partially missing atlas station", function () {
    const station = stationFor([TidalConstituents.M2, TidalConstituents.S2]);
    station.amplitudeM[0] = 0.5;
    station.phaseLagRadians[0] = 0.25;
    station.amplitudeM[1] = Number.NaN;
    station.phaseLagRadians[1] = 0.0;

    const m2Only = stationFor([TidalConstituents.M2]);
    m2Only.amplitudeM[0] = 0.5;
    m2Only.phaseLagRadians[0] = 0.25;

    const result = HarmonicTideModel.predict(time, station);
    expect(result.valid).toBe(true);
    expect(Number.isFinite(result.heightM)).toBe(true);
    expect(result.heightM).toBe(
      HarmonicTideModel.predict(time, m2Only).heightM,
    );
  });

  it("keeps a finite zero-amplitude station valid", function () {
    const station = stationFor([TidalConstituents.M2]);
    station.amplitudeM[0] = 0.0;
    station.phaseLagRadians[0] = 0.0;

    const result = HarmonicTideModel.predict(time, station);
    expect(result.valid).toBe(true);
    expect(result.heightM).toBe(0.0);
  });
});
