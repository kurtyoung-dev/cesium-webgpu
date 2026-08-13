// Static contract for the Sandcastle2 Eclipse Explorer.
//
// Run: node --test Tools/visual-regression/eclipse-sandcastle.spec.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const demoDirectory = path.join(
  root,
  "packages/sandcastle/gallery/eclipse-explorer",
);
const mainPath = path.join(demoDirectory, "main.js");
const htmlPath = path.join(demoDirectory, "index.html");
const metadataPath = path.join(demoDirectory, "sandcastle.yaml");
const legacyDemoPath = path.join(
  root,
  "Apps/Sandcastle/gallery/Eclipse Explorer.html",
);
const legacyGalleryIndexPath = path.join(
  root,
  "Apps/Sandcastle/gallery/gallery-index.js",
);

const mainSource = fs.readFileSync(mainPath, "utf8");
const htmlSource = fs.readFileSync(htmlPath, "utf8");
const metadataSource = fs.readFileSync(metadataPath, "utf8");
const legacyGalleryIndexSource = fs.readFileSync(
  legacyGalleryIndexPath,
  "utf8",
);
const presetBlock = mainSource.match(
  /const ECLIPSE_PRESETS = Object\.freeze\(\s*(\[[\s\S]*?\])\.map\(Object\.freeze\),\s*\);/,
);

assert.ok(presetBlock, "Sandcastle2 must retain one inline preset authority");
const presets = vm.runInNewContext(`(${presetBlock[1]})`, Object.create(null));

const expectedEvents = [
  {
    id: "solar-luarca-c2-2026",
    kind: "solar",
    utc: "2026-08-12T18:26:50Z",
    longitude: -6.535,
    latitude: 43.544,
  },
  {
    id: "solar-reykjavik-max-2026",
    kind: "solar",
    utc: "2026-08-12T17:48:47.1Z",
    longitude: -21.9426,
    latitude: 64.1466,
  },
  {
    id: "solar-erie-max-2024",
    kind: "solar",
    utc: "2024-04-08T19:18:11Z",
    longitude: -80.0851,
    latitude: 42.1292,
  },
  {
    id: "solar-torreon-max-2024",
    kind: "solar",
    utc: "2024-04-08T18:19:41Z",
    longitude: -103.4068,
    latitude: 25.5428,
  },
  {
    id: "lunar-fairbanks-aurora-2025",
    kind: "lunar",
    utc: "2025-03-14T06:58:47Z",
    longitude: -147.7164,
    latitude: 64.8378,
  },
  {
    id: "lunar-nairobi-longest-2018",
    kind: "lunar",
    utc: "2018-07-27T20:21:45Z",
    longitude: 36.8219,
    latitude: -1.2921,
  },
  {
    id: "lunar-tokyo-uranus-2022",
    kind: "lunar",
    utc: "2022-11-08T10:59:13Z",
    longitude: 139.6917,
    latitude: 35.6895,
  },
];

test("historical presets retain exact UTC and observer coordinates", () => {
  assert.equal(presets.length, expectedEvents.length);
  assert.deepEqual(
    Array.from(presets, ({ id, kind, utc, longitude, latitude }) => ({
      id,
      kind,
      utc,
      longitude,
      latitude,
    })),
    expectedEvents,
  );
  assert.equal(new Set(presets.map(({ id }) => id)).size, presets.length);

  for (const preset of presets) {
    assert.equal(preset.timeScale, "UTC", `${preset.id} time scale`);
    assert.ok(Number.isFinite(Date.parse(preset.utc)), `${preset.id} UTC`);
    assert.ok(
      Number.isFinite(preset.longitude) &&
        preset.longitude >= -180.0 &&
        preset.longitude <= 180.0,
      `${preset.id} longitude`,
    );
    assert.ok(
      Number.isFinite(preset.latitude) &&
        preset.latitude >= -90.0 &&
        preset.latitude <= 90.0,
      `${preset.id} latitude`,
    );
    assert.ok(preset.authority.length > 20, `${preset.id} authority`);
    assert.equal(new URL(preset.authorityUrl).protocol, "https:");
  }
});

test("civil UTC values stay distinct from separately labelled time-scale references", () => {
  assert.deepEqual(
    Array.from(
      presets.filter(({ kind }) => kind === "lunar"),
      ({ id, utc, eventStage }) => ({ id, utc, eventStage }),
    ),
    [
      {
        id: "lunar-fairbanks-aurora-2025",
        utc: "2025-03-14T06:58:47Z",
        eventStage:
          "Greatest total lunar eclipse; NASA's catalog TD is 06:59:56",
      },
      {
        id: "lunar-nairobi-longest-2018",
        utc: "2018-07-27T20:21:45Z",
        eventStage:
          "Greatest eclipse; NASA's catalog TD is 20:22:54; total phase about 103 minutes",
      },
      {
        id: "lunar-tokyo-uranus-2022",
        utc: "2022-11-08T10:59:13Z",
        eventStage:
          "Greatest total lunar eclipse; NASA's catalog TD is 11:00:22 and published UT1 is 10:59:11.3",
      },
    ],
  );
});

test("solar observers are path-verified while lunar events use visibility", () => {
  const solar = presets.filter(({ kind }) => kind === "solar");
  const lunar = presets.filter(({ kind }) => kind === "lunar");
  assert.equal(solar.length, 4);
  assert.ok(solar.every(({ totalityPathVerified }) => totalityPathVerified));
  assert.ok(lunar.every(({ totalPhaseVisible }) => totalPhaseVisible));
  assert.ok(
    lunar.every((preset) => !Object.hasOwn(preset, "totalityPathVerified")),
  );
  assert.match(solar[0].location, /Asturias/);
  assert.doesNotMatch(solar[0].location, /Galicia/);
  assert.match(
    solar.find(({ id }) => id === "solar-erie-max-2024").localTime,
    /EDT/,
  );
  assert.match(
    solar.find(({ id }) => id === "solar-reykjavik-max-2026").localTime,
    /47\.1 GMT/,
  );
});

test("the lunar list includes independently interesting real conjunctions", () => {
  const lunar = presets.filter(({ kind }) => kind === "lunar");
  assert.equal(lunar.length, 3);
  const fairbanks = lunar.find(
    ({ id }) => id === "lunar-fairbanks-aurora-2025",
  );
  assert.equal(
    fairbanks.spaceWeatherContext,
    "photographed-aurora-conjunction",
  );
  assert.match(fairbanks.context, /not eclipse causation/i);
  assert.equal(fairbanks.authorityUrl, "https://svs.gsfc.nasa.gov/5472/");
  assert.match(fairbanks.contextAuthority, /Dan Zafra/);
  assert.equal(
    new URL(fairbanks.contextAuthorityUrl).hostname,
    "www.youtube.com",
  );
  assert.match(
    lunar.find(({ id }) => id === "lunar-nairobi-longest-2018").context,
    /longest/i,
  );
  assert.match(
    lunar.find(({ id }) => id === "lunar-tokyo-uranus-2022").context,
    /Uranus/,
  );
  const tokyo = lunar.find(({ id }) => id === "lunar-tokyo-uranus-2022");
  assert.match(tokyo.contextAuthority, /NAOJ/);
  assert.equal(
    tokyo.contextAuthorityUrl,
    "https://www.nao.ac.jp/astro/sky/2022/11-topics02.html",
  );
});

test("eclipse visuals remain physics-driven and expose quality tiers", () => {
  assert.equal(
    mainSource.match(/scene\.sun\.glowFactor\s*=\s*1\.0/g)?.length,
    1,
  );
  assert.doesNotMatch(mainSource, /\bsetInterval\s*\(/);
  assert.doesNotMatch(mainSource, /Math\.(?:sin|cos)\s*\(/);

  for (const flag of [
    "enableEclipse",
    "enableEclipseGlobeShadow",
    "enableSolarLimbDarkening",
    "enableSolarGlareFalloff",
    "enableTrueSolarDiscSize",
    "enableScreenSpaceSunHalo",
    "enableAngularSolarGlare",
    "enableEclipseHorizonTwilight",
    "enableLunarBRDF",
    "enableLunarNormalMap",
    "enableEarthshine",
  ]) {
    assert.match(mainSource, new RegExp(`${flag}: true`), flag);
  }

  for (const mode of ["balanced", "cinematic", "performance"]) {
    assert.match(mainSource, new RegExp(`applyPerformanceMode\\("${mode}"\\)`));
  }
  assert.match(mainSource, /requestRenderMode: true/);
  assert.doesNotMatch(mainSource, /Terrain\.fromWorldTerrain/);
  assert.match(mainSource, /cloudCover = checked \? 0\.35 : 0\.0/);
});

test("unsupported contact, lunar-shadow, and aurora visuals are disclosed", () => {
  assert.match(mainSource, /Analytic corona/);
  assert.match(mainSource, /Baily's beads\/diamond ring/);
  assert.match(mainSource, /located prominences/);
  assert.match(mainSource, /lunar Earth-shadow renderer currently unavailable/);
  assert.match(mainSource, /aurora renderer currently unavailable/);
  assert.match(mainSource, /does not override the event time/);
  assert.match(mainSource, /scene\._frameState\?\.eclipseState/);
});

test("the Explorer is Sandcastle2-only and has complete gallery metadata", () => {
  assert.match(metadataSource, /^title: Eclipse Explorer$/m);
  assert.match(metadataSource, /^description: /m);
  assert.match(metadataSource, / {2}- Showcases/);
  assert.match(htmlSource, /id="cesiumContainer"/);
  assert.match(htmlSource, /id="eventPanel"/);
  assert.equal(fs.existsSync(legacyDemoPath), false);
  assert.doesNotMatch(legacyGalleryIndexSource, /name: "Eclipse Explorer"/);
  assert.doesNotMatch(mainSource, /from\s+["']\.\//);
});

test("the Sandcastle2 program parses as JavaScript", () => {
  const syntax = spawnSync(process.execPath, ["--check", mainPath], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});
