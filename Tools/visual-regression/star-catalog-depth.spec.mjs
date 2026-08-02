// star-catalog-depth.spec.mjs — C12-09 acceptance spec.
//
// Pure-Node (`node --test Tools/visual-regression/star-catalog-depth.spec.mjs`).
// Proves the deepened `BrightStarCatalog` is the table the bake says it is,
// without a browser, a GPU, or the (unvendored) HEASARC source archive:
//
//   (a) star count sits in the maintainer-approved band and the emitted
//       magnitude limit is inside the approved magnitude window;
//   (b) every vendored magnitude is at or brighter than that limit, and the
//       renderer's MAG_CUTOFF equals the faintest vendored star — a deepening
//       that forgets the constant renders the new rows at zero flux;
//   (c) RA / Dec / B-V ranges are physically valid and the table is a whole
//       number of STRIDE-sized records;
//   (d) no two rows are the same star — no exact duplicates, and no two rows
//       closer than the render-resolution floor with the same photometry;
//   (e) the pre-C12-09 catalogue's high-signal stars all survive, at
//       positions the source corroborates (the 24 known transcription errors
//       are asserted as CORRECTED, not merely as present);
//   (f) the provenance manifest is bound to the shipped numbers by sha256,
//       and records the licence position and the HEASARC sourcing DR-02
//       requires.
//
// (e) is the anti-regression clause: the deepening must not lose or move a
// star that C12-05..08 calibrated against.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import BrightStarCatalog from "../../packages/engine/Source/Scene/BrightStarCatalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const catalogPath = path.join(
  root,
  "packages/engine/Source/Scene/BrightStarCatalog.js",
);
const mathPath = path.join(
  root,
  "packages/engine/Source/Scene/StarFieldMath.ts",
);
const manifestPath = path.join(
  root,
  "Tools/star-catalog-bake/star-catalog-manifest.json",
);
const licensePath = path.join(root, "LICENSE.md");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const catalogSrc = fs.readFileSync(catalogPath, "utf8");
const mathSrc = fs.readFileSync(mathPath, "utf8");

// ---------------------------------------------------------------------------
// Approved envelope (queue row C12-09 + the LD-3 ruling of 2026-08-01).
// ---------------------------------------------------------------------------
const APPROVED = {
  // "magnitude ~5.5-6" — the window the ruling approved.
  MIN_LIMIT: 5.5,
  MAX_LIMIT: 6.0,
  // "~5,000 stars" with a ~200 KB bundle budget. The lower bound guards
  // against a bake that silently under-delivers; the upper against one that
  // blows the budget (the queue's own tighten trigger sits at ~5,200).
  MIN_STARS: 2500,
  MAX_STARS: 5300,
  // The pre-C12-09 table, for the no-regression clause.
  LEGACY_STARS: 263,
};

const { data, STRIDE, count } = BrightStarCatalog;
const stars = [];
for (let i = 0; i < count; i++) {
  const b = i * STRIDE;
  stars.push({
    ra: data[b],
    dec: data[b + 1],
    vmag: data[b + 2],
    bv: data[b + 3],
  });
}

// The decimals the bake emits — the precision the renderer actually sees.
const {
  ra: RA_DP,
  dec: DEC_DP,
  vmag: MAG_DP,
  bv: BV_DP,
} = manifest.bake.decimals;
const fixed = (v, dp) => {
  const s = v.toFixed(dp);
  return Number(s) === 0 ? (0).toFixed(dp) : s;
};
const emitKey = (s) =>
  `${fixed(s.ra, RA_DP)},${fixed(s.dec, DEC_DP)},${fixed(s.vmag, MAG_DP)},${fixed(s.bv, BV_DP)}`;

const D2R = Math.PI / 180;
const toUnit = (ra, dec) => {
  const c = Math.cos(dec * D2R);
  return [c * Math.cos(ra * D2R), c * Math.sin(ra * D2R), Math.sin(dec * D2R)];
};
const sepDeg = (a, b) =>
  Math.acos(
    Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])),
  ) / D2R;

// ---------------------------------------------------------------------------
// (a) Depth is inside the approved band
// ---------------------------------------------------------------------------
test("(a) star count and magnitude limit sit inside the approved envelope", (t) => {
  const limit = manifest.bake.magnitudeLimit;
  t.diagnostic(
    `${count} stars at vmag <= ${limit} (was ${APPROVED.LEGACY_STARS} at 5.0); ` +
      `${manifest.output.curated} curated + ${manifest.output.appended} appended`,
  );
  assert.ok(
    limit >= APPROVED.MIN_LIMIT && limit <= APPROVED.MAX_LIMIT,
    `magnitude limit ${limit} outside the approved window [${APPROVED.MIN_LIMIT}, ${APPROVED.MAX_LIMIT}]`,
  );
  assert.ok(
    count >= APPROVED.MIN_STARS && count <= APPROVED.MAX_STARS,
    `star count ${count} outside the approved band [${APPROVED.MIN_STARS}, ${APPROVED.MAX_STARS}]`,
  );
  assert.ok(
    count > APPROVED.LEGACY_STARS * 5,
    `deepening delivered only ${count} stars — barely more than the ${APPROVED.LEGACY_STARS}-star baseline`,
  );
  assert.equal(count, manifest.output.stars, "manifest star count disagrees");
});

// ---------------------------------------------------------------------------
// (b) Magnitude bound, and the MAG_CUTOFF coupling
// ---------------------------------------------------------------------------
test("(b) every star is within the limit and MAG_CUTOFF matches the faintest", (t) => {
  const limit = manifest.bake.magnitudeLimit;
  const faintest = stars.reduce((m, s) => Math.max(m, s.vmag), -Infinity);
  const brightest = stars.reduce((m, s) => Math.min(m, s.vmag), Infinity);
  for (const s of stars) {
    assert.ok(
      s.vmag <= limit + 1e-9,
      `star at (${s.ra}, ${s.dec}) has vmag ${s.vmag} > limit ${limit}`,
    );
  }
  assert.equal(
    faintest,
    limit,
    "faintest star does not reach the stated limit",
  );
  assert.equal(brightest, -1.46, "Sirius is no longer the brightest row");

  // The coupled constant. Left behind, every row past the old bound emits
  // exactly zero flux and the deepening is inert.
  const m = mathSrc.match(/const MAG_CUTOFF = ([0-9]*\.?[0-9]+);/);
  assert.ok(m, "MAG_CUTOFF not found in StarFieldMath.ts");
  assert.equal(
    Number(m[1]),
    faintest,
    `MAG_CUTOFF ${m[1]} != faintest vendored star ${faintest} — the deepened rows would render at zero flux`,
  );
  t.diagnostic(
    `vmag ${brightest} .. ${faintest}; MAG_CUTOFF ${m[1]}; ` +
      `flux ratio brightest:faintest = ${Math.pow(10, 0.4 * (faintest - brightest)).toFixed(0)}:1`,
  );
});

// ---------------------------------------------------------------------------
// (c) Structural + physical validity
// ---------------------------------------------------------------------------
test("(c) STRIDE intact and every field physically valid", () => {
  assert.equal(STRIDE, 4, "STRIDE changed");
  assert.equal(
    data.length % STRIDE,
    0,
    "data length is not a whole number of records",
  );
  assert.equal(
    count,
    data.length / STRIDE,
    "count disagrees with data.length / STRIDE",
  );
  assert.equal(manifest.output.stride, STRIDE, "manifest stride disagrees");
  assert.ok(Object.isFrozen(data), "catalog data is no longer frozen");

  for (const s of stars) {
    assert.ok(
      Number.isFinite(s.ra) && s.ra >= 0 && s.ra < 360,
      `RA out of [0, 360): ${s.ra}`,
    );
    assert.ok(
      Number.isFinite(s.dec) && s.dec >= -90 && s.dec <= 90,
      `Dec out of [-90, 90]: ${s.dec}`,
    );
    assert.ok(Number.isFinite(s.vmag), `non-finite vmag: ${s.vmag}`);
    // Real stellar B-V spans roughly -0.4 (O-type) to +3 (extreme carbon
    // stars). Anything outside that is a parse error, not a star.
    assert.ok(
      Number.isFinite(s.bv) && s.bv >= -0.5 && s.bv <= 3.5,
      `B-V outside the stellar range at (${s.ra}, ${s.dec}): ${s.bv}`,
    );
  }
});

test("(c2) the sky is covered, not clustered in one hemisphere", (t) => {
  // A parse or sign error would show up as an empty half-sky far sooner than
  // as an out-of-range value.
  const north = stars.filter((s) => s.dec > 0).length;
  const quadrants = [0, 0, 0, 0];
  for (const s of stars) {
    quadrants[Math.min(3, Math.floor(s.ra / 90))]++;
  }
  t.diagnostic(
    `north ${north} / south ${count - north}; RA quadrants ${quadrants.join(", ")}`,
  );
  assert.ok(
    north > count * 0.3 && north < count * 0.7,
    "declination badly skewed",
  );
  for (const q of quadrants) {
    assert.ok(q > count * 0.15, `an RA quadrant holds only ${q} stars`);
  }
});

// ---------------------------------------------------------------------------
// (d) No star is drawn twice
// ---------------------------------------------------------------------------
test("(d) no duplicate rows, and no unresolvable same-photometry pair", (t) => {
  const seen = new Map();
  for (let i = 0; i < stars.length; i++) {
    const k = emitKey(stars[i]);
    assert.ok(
      !seen.has(k),
      `rows ${seen.get(k)} and ${i} are byte-identical (${k}) — the same star drawn twice`,
    );
    seen.set(k, i);
  }

  // Beyond exact equality: two rows closer than a rendered pixel AND carrying
  // the same magnitude are one star recorded twice, not a resolvable double.
  // (Genuine double-star components with distinct photometry are kept — that
  // is what the naked eye sees.) 0.01 deg is ~1/3 px at 1920x1080 / 60 deg.
  const PIXEL_FLOOR_DEG = 0.01;
  const byRa = stars
    .map((s, i) => ({ ...s, i, u: toUnit(s.ra, s.dec) }))
    .sort((a, b) => a.ra - b.ra);
  let nearPairs = 0;
  for (let i = 0; i < byRa.length; i++) {
    for (let j = i + 1; j < byRa.length; j++) {
      // RA is a lower bound on separation only away from the poles, so widen
      // the scan window by the cos(dec) factor of the more polar row.
      const cosDec = Math.max(
        1e-6,
        Math.cos(Math.max(Math.abs(byRa[i].dec), Math.abs(byRa[j].dec)) * D2R),
      );
      if ((byRa[j].ra - byRa[i].ra) * cosDec > PIXEL_FLOOR_DEG) {
        break;
      }
      const d = sepDeg(byRa[i].u, byRa[j].u);
      if (d > PIXEL_FLOOR_DEG) {
        continue;
      }
      nearPairs++;
      assert.ok(
        Math.abs(byRa[i].vmag - byRa[j].vmag) > 1e-9,
        `rows ${byRa[i].i} and ${byRa[j].i} are ${d.toFixed(5)} deg apart with identical ` +
          `vmag ${byRa[i].vmag} — one star recorded twice`,
      );
    }
  }
  t.diagnostic(
    `${nearPairs} sub-${PIXEL_FLOOR_DEG}-deg pairs, all with distinct magnitudes ` +
      `(resolved double-star components)`,
  );
});

// ---------------------------------------------------------------------------
// (e) No regression of the high-signal stars
// ---------------------------------------------------------------------------

// The 30 brightest rows of the pre-C12-09 catalogue, verbatim, as the
// anti-regression witness. These are the stars C12-05..08 calibrated the PSF,
// the exposure anchor and the G2 gate against; losing or moving one silently
// would invalidate that calibration.
// prettier-ignore
const LEGACY_BRIGHTEST_30 = [
  ["Sirius",      101.287, -16.716, -1.46],
  ["Canopus",      95.988, -52.696, -0.74],
  ["Rigil Kent",  219.902, -60.834, -0.27],
  ["Arcturus",    213.915,  19.182, -0.05],
  ["Vega",        279.234,  38.784,  0.03],
  ["Capella",      79.172,  45.998,  0.08],
  ["Rigel",        78.634,  -8.202,  0.13],
  ["Procyon",     114.825,   5.225,  0.34],
  ["Achernar",     24.429, -57.237,  0.46],
  ["Betelgeuse",   88.793,   7.407,  0.50],
  ["Hadar",       210.956, -60.373,  0.61],
  ["Altair",      297.696,   8.868,  0.77],
  ["Acrux",       186.650, -63.099,  0.77],
  ["Aldebaran",    68.980,  16.509,  0.85],
  ["Spica",       201.298, -11.161,  1.04],
  ["Antares",     247.352, -26.432,  1.09],
  ["Pollux",      116.329,  28.026,  1.14],
  ["Fomalhaut",   344.413, -29.622,  1.16],
  ["Deneb",       310.358,  45.280,  1.25],
  ["Mimosa",      191.930, -59.689,  1.25],
  ["Regulus",     152.093,  11.967,  1.35],
  ["Adhara",      104.656, -28.972,  1.50],
  ["Castor",      113.650,  31.888,  1.58],
  ["Shaula",      263.402, -37.104,  1.62],
  ["Gacrux",      187.791, -57.113,  1.63],
  ["Bellatrix",    81.283,   6.350,  1.64],
  ["Elnath",       81.573,  28.608,  1.65],
  ["Miaplacidus", 138.300, -69.717,  1.67],
  ["Alnilam",      84.053,  -1.202,  1.69],
  ["Alnair",      332.058, -46.961,  1.74],
];

test("(e) every pre-C12-09 high-signal star survives, unmoved", (t) => {
  for (const [name, ra, dec, vmag] of LEGACY_BRIGHTEST_30) {
    const u = toUnit(ra, dec);
    const hit = stars.find(
      (s) =>
        Math.abs(s.vmag - vmag) < 1e-9 && sepDeg(u, toUnit(s.ra, s.dec)) < 1e-3,
    );
    assert.ok(hit, `${name} (v${vmag}) lost or moved by the C12-09 deepening`);
  }
  t.diagnostic(
    `${LEGACY_BRIGHTEST_30.length}/${LEGACY_BRIGHTEST_30.length} present at their calibrated positions`,
  );
});

test("(e2) the 24 known transcription errors are corrected, not merely present", (t) => {
  const table = manifest.reconcile.correctionsTable;
  assert.ok(
    Array.isArray(table) && table.length === 24,
    `expected 24 pinned corrections, manifest has ${table?.length}`,
  );
  for (const c of table) {
    // The corrected star must be in the table at its source position...
    const to = toUnit(c.to.ra, c.to.dec);
    const fixedRow = stars.find(
      (s) =>
        Math.abs(s.vmag - c.to.vmag) < 1e-9 &&
        sepDeg(to, toUnit(s.ra, s.dec)) < 1e-3,
    );
    assert.ok(fixedRow, `${c.name}: corrected position missing from the table`);

    // ...and nothing may remain at the erroneous position, or the star is
    // drawn twice, which is exactly what the correction exists to prevent.
    const from = toUnit(c.from.ra, c.from.dec);
    const ghost = stars.find(
      (s) =>
        sepDeg(from, toUnit(s.ra, s.dec)) < 1e-3 &&
        Math.abs(s.vmag - c.to.vmag) < 0.05,
    );
    assert.ok(
      !ghost,
      `${c.name}: a row of the same brightness survives at the erroneous position ` +
        `(${c.from.ra}, ${c.from.dec}) — the star would render twice, ${c.offsetDeg} deg apart`,
    );
  }
  const worst = table.reduce((m, c) => Math.max(m, c.offsetDeg), 0);
  t.diagnostic(`24 corrections applied, worst displacement ${worst} deg`);
});

// ---------------------------------------------------------------------------
// (f) Provenance manifest is bound to the shipped numbers
// ---------------------------------------------------------------------------
test("(f) manifest sha256 re-derives from the shipped table", (t) => {
  const canonical = stars
    .map(emitKey)
    .map((k) => k.split(",").join(","))
    .join("\n");
  const sha = crypto.createHash("sha256").update(canonical).digest("hex");
  assert.equal(
    sha,
    manifest.output.tableSha256,
    "the shipped catalogue numbers do not match the manifest — re-run the bake",
  );
  t.diagnostic(`tableSha256 ${sha.slice(0, 16)}...`);
});

test("(f2) provenance records HEASARC sourcing and the licence position", () => {
  // DR-02 condition 1: sourced from NASA HEASARC, not VizieR/CDS.
  assert.match(
    manifest.source.url,
    /^https:\/\/heasarc\.gsfc\.nasa\.gov\//,
    "source URL is not a HEASARC URL — DR-02 requires HEASARC sourcing",
  );
  assert.ok(
    !/vizier|cds\.u-strasbg|cdsarc/i.test(JSON.stringify(manifest.source)),
    "provenance references VizieR/CDS — DR-02 excludes them as the source",
  );
  // DR-02 condition 2: only the four factual columns are vendored.
  assert.deepEqual(
    manifest.vendoredColumns,
    ["ra", "dec", "vmag", "bv_color"],
    "vendored column set drifted from RA/Dec/Vmag/B-V",
  );
  // The pinned source must be identified well enough to re-fetch and re-verify.
  assert.match(
    manifest.source.sha256,
    /^[0-9a-f]{64}$/,
    "source sha256 missing",
  );
  assert.ok(manifest.source.bytes > 0, "source byte count missing");
  assert.ok(manifest.source.retrieved, "source retrieval date missing");
  assert.ok(manifest.licence.verified, "licence verification date missing");

  // LICENSE.md must carry the bundled-asset entry; the terms travel with the
  // redistribution, so a silent removal is a licensing regression.
  const license = fs.readFileSync(licensePath, "utf8");
  assert.match(
    license,
    /# Bundled Engine Assets/,
    "Bundled Engine Assets section missing",
  );
  assert.match(
    license,
    /### Bright-star catalogue/,
    "LICENSE.md has no bright-star catalogue entry",
  );
  assert.ok(
    license.includes(manifest.licence.heasarcQuote),
    "LICENSE.md no longer quotes the HEASARC terms the ingest relies on",
  );
  assert.ok(
    license.includes(manifest.source.sha256),
    "LICENSE.md does not pin the source hash recorded in the manifest",
  );
});

test("(f3) the generated region is machine-owned and marked", () => {
  assert.match(
    catalogSrc,
    /BEGIN GENERATED \(Tools\/star-catalog-bake\/bake-star-catalog\.mjs\)/,
    "generated-region marker missing — re-bakes would clobber curated rows",
  );
  assert.match(
    catalogSrc,
    /END GENERATED/,
    "generated-region end marker missing",
  );
  assert.match(
    catalogSrc,
    /Do not hand-edit: re-run bake-star-catalog\.mjs instead\./,
    "generated region lost its do-not-edit notice",
  );
  // The appended block must actually be sorted brightest-first. Anchor on the
  // marker LINE, not the bare phrase — the docblock names it too.
  const gen = catalogSrc.slice(
    catalogSrc.indexOf("// ---- BEGIN GENERATED ("),
    catalogSrc.indexOf("// ---- END GENERATED ----"),
  );
  const mags = gen
    .split("\n")
    .filter((l) => /^\s+-?[0-9]/.test(l))
    .map((l) => Number(l.trim().split(",")[2]));
  assert.equal(
    mags.length,
    manifest.output.appended,
    "appended row count disagrees",
  );
  for (let i = 1; i < mags.length; i++) {
    assert.ok(
      mags[i] >= mags[i - 1],
      `appended rows are not brightest-first at index ${i} (${mags[i - 1]} then ${mags[i]})`,
    );
  }
});
