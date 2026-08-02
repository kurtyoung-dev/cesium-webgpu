// C13-08 — CoverageJSON cyclic-longitude parser contract.
//
// A CRS84 axis may stay inside [-180, 180] while walking eastward through the
// antimeridian: 170, 175, 180, -175, -170. The parser must unwrap that axis
// before it decides either field bounds or column orientation. These tests are
// browser-free and exercise the parser-derived field through WeatherFieldGrid
// and WeatherTexPacker, so an equivalent-but-incompatible bounds encoding cannot
// hide at the parser boundary.
//
// RUNNER REQUIREMENT: Node >= 22.18 (built-in TypeScript stripping).
//   node --test Tools/visual-regression/coveragejson-antimeridian.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();
const { parseCoverageJson } =
  await import("../../packages/engine/Source/Scene/Weather/CoverageJsonParser.ts");
const { weatherFieldLonSpan } =
  await import("../../packages/engine/Source/Scene/Weather/WeatherFieldGrid.ts");
const { packWeatherField } =
  await import("../../packages/engine/Source/Scene/Weather/WeatherTexPacker.ts");
const { GLOBAL_WEATHER_BOUNDS } =
  await import("../../packages/engine/Source/Scene/Weather/WeatherTypes.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const parserSource = fs
  .readFileSync(
    path.join(
      root,
      "packages/engine/Source/Scene/Weather/CoverageJsonParser.ts",
    ),
    "utf8",
  )
  .replace(/\r\n/g, "\n");

const DEG = Math.PI / 180.0;
const FALLBACK = {
  west: -Math.PI,
  south: -Math.PI / 2.0,
  east: Math.PI,
  north: Math.PI / 2.0,
};

function parse(xs, values, ys = [20, 10]) {
  return parseCoverageJson(
    {
      domain: { axes: { x: { values: xs }, y: { values: ys } } },
      ranges: { TCDC: { values } },
    },
    {
      parameterName: "TCDC",
      units: "percent",
      bounds: FALLBACK,
    },
  );
}

function coverageValues(values) {
  return new Float32Array(
    values.map((value) => (value === null ? NaN : value / 100.0)),
  );
}

const forwardXs = [170, 175, 180, -175, -170];
const forwardValues = [0, null, 25, 50, 100, 100, 75, 50, 25, 0];

test("a wrapped eastward axis derives the minimal 170..190-degree window", () => {
  const field = parse(forwardXs, forwardValues);

  assert.equal(field.bounds.west, 170 * DEG);
  assert.equal(field.bounds.east, 190 * DEG);
  assert.ok(Math.abs(weatherFieldLonSpan(field.bounds) - 20 * DEG) < 1e-14);
  assert.deepEqual(field.coverage, coverageValues(forwardValues));
  assert.ok(Number.isNaN(field.coverage[1]), "null must remain no-data");
});

test("the reverse wrapped axis normalizes to the same field and packed bytes", () => {
  const forward = parse(forwardXs, forwardValues);
  const reversedValues = [
    ...forwardValues.slice(0, 5).reverse(),
    ...forwardValues.slice(5, 10).reverse(),
  ];
  const reverse = parse([...forwardXs].reverse(), reversedValues);

  assert.deepEqual(reverse.bounds, forward.bounds);
  assert.deepEqual(reverse.coverage, forward.coverage);
  assert.deepEqual(
    packWeatherField(reverse, 72, 36),
    packWeatherField(forward, 72, 36),
  );
  assert.ok(Number.isNaN(reverse.coverage[1]), "reversal must move no-data");
});

test("ordinary regional axes retain their historical bounds and bytes", () => {
  const values = [10, null, 30, 40, 50, 60];
  const field = parse([-120, -110, -100], values, [40, 30]);

  assert.deepEqual(field.bounds, {
    west: -120 * DEG,
    south: 30 * DEG,
    east: -100 * DEG,
    north: 40 * DEG,
  });
  assert.deepEqual(field.coverage, coverageValues(values));
});

test("ordinary global and exact full-circle axes are not collapsed", () => {
  const values = [0, 20, 40, 60, 80, 100, 100, 80, 60, 40, 20, 0];
  const field = parse([-180, -108, -36, 36, 108, 180], values, [90, -90]);
  assert.deepEqual(field.bounds, GLOBAL_WEATHER_BOUNDS);

  const expected = {
    gridWidth: 6,
    gridHeight: 2,
    coverage: coverageValues(values),
    bounds: GLOBAL_WEATHER_BOUNDS,
    registration: "node",
  };
  assert.deepEqual(
    packWeatherField(field, 72, 36),
    packWeatherField(expected, 72, 36),
    "the established global pack must stay byte-identical",
  );

  const twoNode = parse([-180, 180], [0, 100, 100, 0], [90, -90]);
  assert.deepEqual(twoNode.bounds, GLOBAL_WEATHER_BOUNDS);
  assert.equal(weatherFieldLonSpan(twoNode.bounds), 2.0 * Math.PI);

  const coarse = parse([0, 270, 360], [0, 50, 100, 100, 50, 0], [90, -90]);
  assert.deepEqual(coarse.bounds, {
    west: 0,
    south: -Math.PI / 2.0,
    east: 2.0 * Math.PI,
    north: Math.PI / 2.0,
  });
  assert.equal(weatherFieldLonSpan(coarse.bounds), 2.0 * Math.PI);
});

function hasSharedUnwrappedAxisContract(source) {
  return (
    source.includes("const longitudeAxis = unwrapLongitudeAxis(xs);") &&
    /const xAscending =\s*longitudeAxis !== null\s*\? longitudeAxis\.values\[0\] <\s*longitudeAxis\.values\[longitudeAxis\.values\.length - 1\]\s*: xs\[0\] < xs\[xs\.length - 1\];/.test(
      source,
    ) &&
    source.includes("boundsFromAxes(longitudeAxis, ys)")
  );
}

test("bounds and column orientation consume the same unwrapped axis", () => {
  assert.equal(hasSharedUnwrappedAxisContract(parserSource), true);
});

test("MUTATION — restoring raw endpoint orientation is rejected", () => {
  const mutated = parserSource.replace(
    /const xAscending =\s*longitudeAxis !== null\s*\? longitudeAxis\.values\[0\] <\s*longitudeAxis\.values\[longitudeAxis\.values\.length - 1\]\s*: xs\[0\] < xs\[xs\.length - 1\];/,
    "const xAscending = xs[0] < xs[xs.length - 1];",
  );
  assert.notEqual(
    mutated,
    parserSource,
    "mutation must edit the live decision",
  );
  assert.equal(hasSharedUnwrappedAxisContract(mutated), false);
  assert.equal(forwardXs[0] < forwardXs[forwardXs.length - 1], false);
});

test("MUTATION — restoring raw min/max bounds is rejected", () => {
  const mutated = parserSource.replace(
    "boundsFromAxes(longitudeAxis, ys)",
    "boundsFromAxes({ values: xs, crossedSeam: false }, ys)",
  );
  assert.notEqual(mutated, parserSource, "mutation must edit the live bounds");
  assert.equal(hasSharedUnwrappedAxisContract(mutated), false);

  const rawSpan = Math.max(...forwardXs) - Math.min(...forwardXs);
  assert.equal(rawSpan, 355);
  assert.notEqual(rawSpan, 20, "the defect oracle must remain discriminating");
});
