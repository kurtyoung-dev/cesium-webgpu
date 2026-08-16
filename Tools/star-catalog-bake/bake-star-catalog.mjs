#!/usr/bin/env node
/**
 * Star-catalogue depth bake (C12-09) — Yale BSC5 as served by NASA HEASARC.
 * @purpose Regenerates the BrightStarCatalog.js data table from the pinned HEASARC BSC5P archive, deepening the embedded sky to naked-eye magnitude.
 * @status ACTIVE
 *
 * Regenerates the `data` table inside
 * `packages/engine/Source/Scene/BrightStarCatalog.js` from the HEASARC
 * `heasarc_bsc5p` Browse table, deepening the embedded sky from the 263
 * hand-curated rows the fork shipped through C12-08 to the naked-eye sky.
 *
 * Read `Tools/star-catalog-bake/README.md` first — it carries the licence
 * verification, the provenance chain, and the reconcile findings. Nothing in
 * this script invents astronomical data: every emitted row that is not one of
 * the surviving hand-curated rows is a verbatim (rounded) copy of four
 * HEASARC columns.
 *
 * Usage:
 *   node Tools/star-catalog-bake/bake-star-catalog.mjs                 # ship default
 *   node Tools/star-catalog-bake/bake-star-catalog.mjs --limit 6.0     # deeper band
 *   node Tools/star-catalog-bake/bake-star-catalog.mjs --dry-run       # report only
 *   node Tools/star-catalog-bake/bake-star-catalog.mjs --out /tmp/x.js
 *
 * The source archive is NOT vendored. Fetch it into `work/` first:
 *   curl -L -o Tools/star-catalog-bake/work/heasarc_bsc5p.tdat.gz \
 *     https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_bsc5p.tdat.gz
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// ---------------------------------------------------------------------------
// Pinned source — a HEASARC re-issue must fail loudly, never silently change
// the shipped sky (the same discipline as Tools/moon-albedo-bake).
// ---------------------------------------------------------------------------
const SOURCE = Object.freeze({
  product: "Bright Star Catalog, 5th Revised Edition (Preliminary Version)",
  table: "heasarc_bsc5p",
  url: "https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_bsc5p.tdat.gz",
  page: "https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/bsc5p.html",
  sha256: "122628cde2d8bedf7e16ddf5f888167ac58c04b5592d6155408ce297f3073931",
  bytes: 913895,
  lastModified: "2022-02-04T03:57:37Z",
  retrieved: "2026-08-01",
  reference:
    "Hoffleit, D. & Warren, W.H. Jr. 1991, Bright Star Catalogue, 5th Revised Ed. (preliminary); HEASARC Browse table heasarc_bsc5p, 9110 rows.",
});

/** The four columns this bake is permitted to read out for vendoring (DR-02). */
const VENDORED_COLUMNS = Object.freeze(["ra", "dec", "vmag", "bv_color"]);

/**
 * Reconcile radius. A hand-curated row with a BSC5P star inside this radius is
 * corroborated and kept as-is. A row with nothing inside it is a transcription
 * error in the hand-curated block (see README §5) and MUST carry an entry in
 * `CORRECTIONS` below, or the bake fails.
 */
const POSITION_EPS_DEG = 0.05;

/**
 * Position corrections for the hand-curated block, C12-09.
 *
 * 24 of the 263 rows the fork shipped through C12-08 place a named star where
 * no BSC5 star of that brightness exists — almost all of them a right-ascension
 * transcription error, with the declination and the photometry copied
 * correctly. Each was identified by searching the whole 9,096-star source for
 * the row's (declination, V, B-V) fingerprint, which is unique in every case;
 * the displacements run from 0.07 deg (rho Per) to 29.5 deg (nu Hya).
 *
 * This mattered little while the star cubemap painted every star anyway. Under
 * DR-01 (the blurred t5 bake carries diffuse light only, so the catalogue is
 * the ONLY source of resolved stars) a wrong row is a star visibly in the wrong
 * constellation — and, once the source supplies the same star at its true
 * position in the appended block, the SAME star drawn twice.
 *
 * `from` is the erroneous position as it appears in the pre-C12-09 file and is
 * matched exactly; a row already at its corrected position simply does not
 * match, which is what makes re-running the bake idempotent. `to` is validated
 * against the pinned source before it is applied: a star must exist there with
 * this V and B-V, or the bake aborts.
 */
// prettier-ignore
const CORRECTIONS = Object.freeze([
  // name,          from ra,  from dec,   to ra,    to dec,   V,     B-V
  ["eps Crv",       182.089,  -22.620,   182.531,  -22.620,  3.00,   1.33],
  ["theta Peg",     326.764,    6.198,   332.550,    6.198,  3.53,   0.08],
  ["alpha Del",     309.249,   15.912,   309.910,   15.912,  3.77,  -0.06],
  ["kappa Her",     246.354,   17.046,   242.019,   17.047,  5.00,   0.95],
  ["phi Sgr",       284.432,  -26.990,   281.414,  -26.991,  3.17,  -0.11],
  ["mu Sgr",        281.198,  -21.059,   273.441,  -21.059,  3.86,   0.23],
  ["rho Boo",       211.674,   30.371,   217.958,   30.371,  3.58,   1.30],
  ["delta Boo",     222.198,   33.315,   228.876,   33.315,  3.47,   0.95],
  ["theta Boo",     218.097,   51.851,   216.299,   51.851,  4.05,   0.50],
  ["phi Vel",       152.092,  -54.567,   149.216,  -54.568,  3.54,  -0.08],
  ["beta Pav",      311.524,  -66.203,   311.240,  -66.203,  3.42,   0.16],
  ["omicron1 Eri",   58.533,   -7.652,    62.966,   -6.838,  4.04,   0.33],
  ["phi Eri",        31.123,  -51.512,    34.127,  -51.512,  3.56,  -0.12],
  ["tau Pup",       100.243,  -50.614,   102.484,  -50.615,  2.93,   1.20],
  ["gamma Hya",     207.404,  -23.172,   199.730,  -23.172,  3.00,   0.92],
  ["pi Hya",        220.762,  -26.682,   211.593,  -26.683,  3.27,   1.12],
  ["nu Hya",        131.689,  -16.194,   162.406,  -16.194,  3.11,   1.25],
  ["omicron Leo",   142.928,    9.892,   145.287,    9.892,  3.52,   0.49],
  ["omicron Per",    49.882,   32.288,    56.080,   32.288,  3.83,   0.05],
  ["rho Per",        46.199,   38.840,    46.294,   38.840,  3.39,   1.65],
  ["pi4 Ori",        70.560,    5.605,    72.802,    5.605,  3.69,  -0.17],
  ["lambda Oph",    243.587,    1.984,   247.728,    1.984,  3.82,   0.01],
  ["mu Ser",        237.704,   -3.430,   237.405,   -3.430,  3.53,  -0.04],
  ["beta Mus",      191.570,  -67.961,   191.570,  -68.108,  3.05,  -0.18],
]);

/**
 * B-V for source rows whose `bv_color` cell is empty. 0.00 is the *definition*
 * of the B-V zero point (A0 V / Vega), so an uncoloured star renders as the
 * photometric system's reference white rather than being assigned a fabricated
 * temperature. Emitted rows using it are counted in the manifest.
 */
const BV_DEFAULT = 0.0;

/**
 * Angular floor below which two rows of the SAME magnitude cannot be two
 * stars. ~1/3 of a pixel at 1920x1080 with Cesium's default 60-degree
 * horizontal FOV. `star-catalog-depth.spec.mjs` asserts the shipped table
 * against the same value.
 */
const PIXEL_FLOOR_DEG = 0.01;

const RA_DP = 3;
const DEC_DP = 3;
const MAG_DP = 2;
const BV_DP = 2;

const BEGIN_MARK =
  "// ---- BEGIN GENERATED (Tools/star-catalog-bake/bake-star-catalog.mjs) ----";
const END_MARK = "// ---- END GENERATED ----";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    limit: 5.5,
    dryRun: false,
    out: path.join(
      repoRoot,
      "packages/engine/Source/Scene/BrightStarCatalog.js",
    ),
    manifest: path.join(here, "star-catalog-manifest.json"),
    source: path.join(here, "work", "heasarc_bsc5p.tdat.gz"),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--limit") {
      out.limit = Number(argv[++i]);
    } else if (a === "--out") {
      out.out = path.resolve(argv[++i]);
    } else if (a === "--manifest") {
      out.manifest = path.resolve(argv[++i]);
    } else if (a === "--source") {
      out.source = path.resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!Number.isFinite(out.limit) || out.limit < 3.0 || out.limit > 6.5) {
    throw new Error(`--limit ${out.limit} outside the sane band [3.0, 6.5]`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 1 — verify the pinned source
// ---------------------------------------------------------------------------
function readVerifiedSource(file) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `source archive missing: ${file}\n` +
        `Fetch it first:\n  curl -L -o "${file}" ${SOURCE.url}`,
    );
  }
  const gz = fs.readFileSync(file);
  const sha = crypto.createHash("sha256").update(gz).digest("hex");
  if (gz.length !== SOURCE.bytes || sha !== SOURCE.sha256) {
    throw new Error(
      `source hash/size mismatch — HEASARC may have re-issued the table.\n` +
        `  expected ${SOURCE.bytes} bytes sha256 ${SOURCE.sha256}\n` +
        `  actual   ${gz.length} bytes sha256 ${sha}\n` +
        `Re-verify provenance and terms before re-pinning.`,
    );
  }
  return zlib.gunzipSync(gz).toString("latin1");
}

// ---------------------------------------------------------------------------
// Stage 2 — parse the TDAT table, taking ONLY the four vendored columns
// ---------------------------------------------------------------------------
function parseTdat(text) {
  const lines = text.split(/\r?\n/);
  const specLine = lines.find((l) => l.startsWith("line[1] ="));
  if (!specLine) {
    throw new Error("TDAT: no `line[1] =` data-format specification");
  }
  // Column positions are read from the file, never hardcoded — a HEASARC
  // column reorder must be picked up, not silently mis-indexed.
  const columns = specLine
    .slice(specLine.indexOf("=") + 1)
    .trim()
    .split(/\s+/);
  const index = {};
  for (const name of VENDORED_COLUMNS) {
    const i = columns.indexOf(name);
    if (i < 0) {
      throw new Error(`TDAT: vendored column "${name}" not present`);
    }
    index[name] = i;
  }
  const declaredRows = Number(
    (text.match(/#\s*TOTAL ROWS:\s*(\d+)/) ?? [])[1] ?? NaN,
  );

  const dataAt = lines.indexOf("<DATA>");
  if (dataAt < 0) {
    throw new Error("TDAT: no <DATA> section");
  }
  const stars = [];
  let seen = 0;
  let droppedNoPosition = 0;
  let droppedNoMagnitude = 0;
  for (let i = dataAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "<END>") {
      break;
    }
    if (line.trim() === "") {
      continue;
    }
    seen++;
    const cell = line.split("|");
    if (cell.length < columns.length) {
      throw new Error(`TDAT: short row ${seen} (${cell.length} cells)`);
    }
    const ra = cell[index.ra].trim();
    const dec = cell[index.dec].trim();
    const vmag = cell[index.vmag].trim();
    const bv = cell[index.bv_color].trim();
    if (ra === "" || dec === "") {
      droppedNoPosition++;
      continue;
    }
    // The 14 BSC5 entries with no V magnitude are novae and deleted rows;
    // a starfield sprite has nothing to render for them.
    if (vmag === "") {
      droppedNoMagnitude++;
      continue;
    }
    stars.push({
      ra: Number(ra),
      dec: Number(dec),
      vmag: Number(vmag),
      bv: bv === "" ? null : Number(bv),
    });
  }
  for (const s of stars) {
    if (
      !Number.isFinite(s.ra) ||
      !Number.isFinite(s.dec) ||
      !Number.isFinite(s.vmag) ||
      (s.bv !== null && !Number.isFinite(s.bv))
    ) {
      throw new Error(`TDAT: non-numeric cell in ${JSON.stringify(s)}`);
    }
    if (s.ra < 0 || s.ra >= 360 || s.dec < -90 || s.dec > 90) {
      throw new Error(`TDAT: out-of-range position ${JSON.stringify(s)}`);
    }
  }
  return { stars, seen, declaredRows, droppedNoPosition, droppedNoMagnitude };
}

// ---------------------------------------------------------------------------
// Stage 3 — parse the existing curated core out of BrightStarCatalog.js
// ---------------------------------------------------------------------------
function readCatalogFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const open = text.indexOf("const data = [");
  if (open < 0) {
    throw new Error(`${file}: no \`const data = [\``);
  }
  const bodyStart = open + "const data = [".length;
  const close = text.indexOf("\n];", bodyStart);
  if (close < 0) {
    throw new Error(`${file}: unterminated data array`);
  }
  return {
    text,
    prefix: text.slice(0, bodyStart),
    body: text.slice(bodyStart, close),
    suffix: text.slice(close),
  };
}

/**
 * Split the array body into curated entries, keeping each row's comment block
 * attached so the hand-authored star names survive a re-bake. Anything at or
 * after the generated marker is discarded — that region is this script's own
 * previous output, so re-running is idempotent.
 */
function parseCuratedCore(body) {
  const beginAt = body.indexOf(BEGIN_MARK);
  const core = beginAt >= 0 ? body.slice(0, beginAt) : body;
  const entries = [];
  let pending = [];
  for (const raw of core.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("//")) {
      pending.push(line);
      continue;
    }
    const nums = line
      .replace(/\/\/.*$/, "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(Number(n)))) {
      throw new Error(`curated core: cannot parse row \`${line}\``);
    }
    entries.push({
      comments: pending,
      ra: Number(nums[0]),
      dec: Number(nums[1]),
      vmag: Number(nums[2]),
      bv: Number(nums[3]),
    });
    pending = [];
  }
  return { entries, trailingComments: pending };
}

// ---------------------------------------------------------------------------
// Spherical helpers
// ---------------------------------------------------------------------------
const D2R = Math.PI / 180;
function toUnit(raDeg, decDeg) {
  const ra = raDeg * D2R;
  const dec = decDeg * D2R;
  const c = Math.cos(dec);
  return [c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec)];
}
function sepDeg(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, dot))) / D2R;
}

// ---------------------------------------------------------------------------
// Stage 4a — apply + validate the pinned position corrections
// ---------------------------------------------------------------------------
function applyCorrections(core, allStars) {
  const applied = [];
  for (const [name, fromRa, fromDec, toRa, toDec, v, bv] of CORRECTIONS) {
    // The correction target must still exist in the pinned source with the
    // photometry it was identified by; otherwise this table is stale and the
    // bake must not quietly move a star.
    const witness = allStars.find(
      (s) =>
        Math.abs(s.ra - toRa) <= 0.002 &&
        Math.abs(s.dec - toDec) <= 0.002 &&
        Math.abs(s.vmag - v) <= 0.02 &&
        (s.bv === null ? bv === BV_DEFAULT : Math.abs(s.bv - bv) <= 0.02),
    );
    if (!witness) {
      throw new Error(
        `correction "${name}" -> (${toRa}, ${toDec}, V ${v}, B-V ${bv}) has no ` +
          `witness in the pinned source; re-derive the table before baking.`,
      );
    }
    const entry = core.find(
      (e) => e.ra === fromRa && e.dec === fromDec && e.vmag !== undefined,
    );
    if (!entry) {
      // Already corrected (idempotent re-bake) — nothing to do.
      continue;
    }
    applied.push({
      name,
      from: { ra: entry.ra, dec: entry.dec, vmag: entry.vmag, bv: entry.bv },
      to: { ra: toRa, dec: toDec, vmag: v, bv },
      offsetDeg: Number(
        sepDeg(toUnit(entry.ra, entry.dec), toUnit(toRa, toDec)).toFixed(4),
      ),
    });
    entry.ra = toRa;
    entry.dec = toDec;
    entry.vmag = v;
    entry.bv = bv;
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Stage 4b — reconcile the curated core against the source
// ---------------------------------------------------------------------------
function reconcile(core, stars) {
  const starUnits = stars.map((s) => toUnit(s.ra, s.dec));
  const kept = [];
  const uncorroborated = [];
  const excluded = new Set();
  let maxSep = 0;
  for (const entry of core) {
    const u = toUnit(entry.ra, entry.dec);
    const hits = [];
    let nearest = { sep: Infinity, star: null };
    for (let i = 0; i < stars.length; i++) {
      const d = sepDeg(u, starUnits[i]);
      if (d < nearest.sep) {
        nearest = { sep: d, star: stars[i] };
      }
      if (d <= POSITION_EPS_DEG) {
        hits.push(i);
      }
    }
    if (hits.length > 0) {
      // Every source row under the curated star is suppressed, not just the
      // closest — otherwise the components of a naked-eye double would be
      // drawn on top of the curated combined-magnitude entry.
      for (const i of hits) {
        excluded.add(i);
      }
      maxSep = Math.max(maxSep, nearest.sep);
      kept.push({ entry, matched: hits.length, sep: nearest.sep });
    } else {
      uncorroborated.push({
        ra: entry.ra,
        dec: entry.dec,
        vmag: entry.vmag,
        bv: entry.bv,
        name: (entry.comments[entry.comments.length - 1] ?? "")
          .replace(/^\/\/\s*/, "")
          .slice(0, 80),
        nearestSourceSepDeg: Number(nearest.sep.toFixed(4)),
        nearestSourceVmag: nearest.star ? nearest.star.vmag : null,
      });
    }
  }
  return { kept, uncorroborated, excluded, maxSep };
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
function fixed(value, dp) {
  const s = value.toFixed(dp);
  // Avoid emitting "-0.000" for a coordinate that rounds to zero.
  return Number(s) === 0 ? (0).toFixed(dp) : s;
}
function rowText(ra, dec, vmag, bv) {
  return `  ${fixed(ra, RA_DP)}, ${fixed(dec, DEC_DP)}, ${fixed(vmag, MAG_DP)}, ${fixed(bv, BV_DP)},`;
}
function buildBody(kept, appended, trailingComments, limit) {
  const out = [];
  for (const k of kept) {
    for (const c of k.entry.comments) {
      out.push(`  ${c}`);
    }
    out.push(rowText(k.entry.ra, k.entry.dec, k.entry.vmag, k.entry.bv));
  }
  for (const c of trailingComments) {
    out.push(`  ${c}`);
  }
  out.push("");
  out.push(`  ${BEGIN_MARK}`);
  out.push(
    `  // ${appended.length} rows from the HEASARC BSC5P table, vmag <= ${limit.toFixed(2)},`,
  );
  out.push(
    `  // brightest first. Dedupe radius ${POSITION_EPS_DEG} deg against the curated rows`,
  );
  out.push(
    `  // above. Do not hand-edit: re-run bake-star-catalog.mjs instead.`,
  );
  for (const s of appended) {
    out.push(rowText(s.ra, s.dec, s.vmag, s.bv ?? BV_DEFAULT));
  }
  out.push(`  ${END_MARK}`);
  return `\n${out.join("\n")}\n`;
}

/**
 * Canonical hash of the emitted numeric table — the manifest is bound to the
 * NUMBERS, not to the file's comments or formatting, so a doc edit does not
 * invalidate the provenance record while a data edit does.
 */
function hashTable(rows) {
  const canonical = rows
    .map(
      (r) =>
        `${fixed(r.ra, RA_DP)},${fixed(r.dec, DEC_DP)},${fixed(r.vmag, MAG_DP)},${fixed(r.bv, BV_DP)}`,
    )
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv);
  const log = (...m) => console.log(...m);

  log(`[1/6] verifying pinned source ${path.relative(repoRoot, args.source)}`);
  const text = readVerifiedSource(args.source);

  log(`[2/6] parsing TDAT (columns ${VENDORED_COLUMNS.join(", ")} only)`);
  const parsed = parseTdat(text);
  if (
    Number.isFinite(parsed.declaredRows) &&
    parsed.seen !== parsed.declaredRows
  ) {
    throw new Error(
      `TDAT: header declares ${parsed.declaredRows} rows, read ${parsed.seen}`,
    );
  }
  log(
    `      ${parsed.seen} rows; ${parsed.stars.length} usable ` +
      `(-${parsed.droppedNoPosition} no position, -${parsed.droppedNoMagnitude} no V magnitude)`,
  );

  const band = parsed.stars.filter((s) => s.vmag <= args.limit);
  log(`[3/6] magnitude filter vmag <= ${args.limit}: ${band.length} stars`);
  for (const probe of [5.0, 5.4, 5.5, 6.0]) {
    log(
      `      (reference: vmag <= ${probe.toFixed(1)} would be ${parsed.stars.filter((s) => s.vmag <= probe).length})`,
    );
  }

  log(`[4/6] reading curated core from ${path.relative(repoRoot, args.out)}`);
  const file = readCatalogFile(args.out);
  const { entries: core, trailingComments } = parseCuratedCore(file.body);
  log(`      ${core.length} curated rows`);

  const corrections = applyCorrections(core, parsed.stars);
  log(
    `[5/6] corrections: ${corrections.length} curated rows repositioned ` +
      `(each validated against the pinned source)`,
  );
  for (const c of corrections) {
    log(
      `      fix   ${c.name.padEnd(13)} (${c.from.ra}, ${c.from.dec}) -> ` +
        `(${c.to.ra}, ${c.to.dec})  ${c.offsetDeg} deg`,
    );
  }

  const { kept, uncorroborated, excluded, maxSep } = reconcile(core, band);
  if (uncorroborated.length > 0) {
    for (const u of uncorroborated) {
      log(
        `      UNCORROBORATED ${u.ra}, ${u.dec}, v${u.vmag} (${u.name || "unnamed"}) ` +
          `nearest source star ${u.nearestSourceSepDeg} deg away`,
      );
    }
    throw new Error(
      `${uncorroborated.length} curated rows have no BSC5P star within ` +
        `${POSITION_EPS_DEG} deg and no entry in CORRECTIONS. Identify them ` +
        `against the source and extend the table — do not ship an uncorroborated star.`,
    );
  }
  log(
    `      reconcile @ ${POSITION_EPS_DEG} deg: ${kept.length}/${core.length} corroborated ` +
      `(worst residual ${maxSep.toFixed(4)} deg), ${excluded.size} source rows suppressed as duplicates`,
  );

  // Collapse rows that are the SAME star recorded twice. BSC5 gives close
  // binaries a separate HR number per component while writing the SYSTEM
  // magnitude on both rows, at positions that differ by a few arcseconds or
  // not at all:
  //
  //   alpha Com   HR 4968/4969  0.2 arcsec  both V 5.22
  //   epsilon Ari HR  887/ 888  1.5 arcsec  both V 4.63
  //   delta Ser   HR 5788/5789  3.9 arcsec  both V 3.80
  //
  // Emitting both draws one star twice and over-brightens it by 0.75 mag — at
  // these separations no camera in the engine can resolve them (a pixel is
  // ~0.03 deg at 1920x1080 / 60 deg FOV, so 3.9 arcsec is 1/28 px). The test
  // is deliberately "same brightness AND unresolvable", not "same position":
  // genuine components with DISTINCT magnitudes stay, because a combined
  // naked-eye pair is exactly what the sky shows. `star-catalog-depth.spec.mjs`
  // asserts the same rule against the shipped table.
  const sortedBand = band
    .filter((_, i) => !excluded.has(i))
    .sort((a, b) => a.vmag - b.vmag || a.ra - b.ra || a.dec - b.dec);
  const collapsed = [];
  const appended = [];
  // The sort puts equal magnitudes adjacent, so the same-brightness scan only
  // has to walk back over the current magnitude group.
  const groupStart = new Map();
  for (const s of sortedBand) {
    const magKey = fixed(s.vmag, MAG_DP);
    let start = groupStart.get(magKey);
    if (start === undefined) {
      start = appended.length;
      groupStart.set(magKey, start);
    }
    const u = toUnit(s.ra, s.dec);
    let mergedInto = -1;
    for (let j = start; j < appended.length; j++) {
      if (
        sepDeg(u, toUnit(appended[j].ra, appended[j].dec)) <= PIXEL_FLOOR_DEG
      ) {
        mergedInto = j;
        break;
      }
    }
    if (mergedInto >= 0) {
      collapsed.push({
        ra: Number(fixed(s.ra, RA_DP)),
        dec: Number(fixed(s.dec, DEC_DP)),
        vmag: s.vmag,
      });
      // Prefer the component that actually carries a measured colour.
      if (appended[mergedInto].bv === null && s.bv !== null) {
        appended[mergedInto] = s;
      }
      continue;
    }
    appended.push(s);
  }
  if (collapsed.length > 0) {
    log(
      `      collapsed ${collapsed.length} source rows onto an already-emitted star ` +
        `(same magnitude, within ${PIXEL_FLOOR_DEG} deg)`,
    );
  }
  const missingBv = appended.filter((s) => s.bv === null).length;

  const emittedRows = [
    ...kept.map((k) => ({
      ra: k.entry.ra,
      dec: k.entry.dec,
      vmag: k.entry.vmag,
      bv: k.entry.bv,
    })),
    ...appended.map((s) => ({
      ra: s.ra,
      dec: s.dec,
      vmag: s.vmag,
      bv: s.bv ?? BV_DEFAULT,
    })),
  ];
  const faintest = emittedRows.reduce((m, r) => Math.max(m, r.vmag), -Infinity);
  const brightest = emittedRows.reduce((m, r) => Math.min(m, r.vmag), Infinity);

  const body = buildBody(kept, appended, trailingComments, args.limit);
  // Match the checkout's line endings. `core.autocrlf=true` gives Windows a
  // CRLF working tree while `.prettierrc` sets `endOfLine: "auto"`, so writing
  // LF here would leave a mixed file that `prettier --check` rejects
  // immediately after every bake. Git normalises to LF on commit either way.
  const eol = /\r\n/.test(file.text) ? "\r\n" : "\n";
  const next = (file.prefix + body + file.suffix)
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, eol);

  const beforeBytes = Buffer.byteLength(file.text, "utf8");
  const afterBytes = Buffer.byteLength(next, "utf8");

  log(
    `[6/6] ${emittedRows.length} stars (${kept.length} curated + ${appended.length} appended); ` +
      `vmag ${brightest} .. ${faintest}; ${missingBv} appended rows used the B-V default`,
  );
  log(
    `      ${path.basename(args.out)} ${beforeBytes} -> ${afterBytes} bytes ` +
      `(+${afterBytes - beforeBytes}, +${((100 * (afterBytes - beforeBytes)) / beforeBytes).toFixed(1)}%)`,
  );

  const manifest = {
    $comment:
      "Generated by Tools/star-catalog-bake/bake-star-catalog.mjs. Checked in as the provenance + reconcile evidence for the embedded bright-star catalogue. Tools/visual-regression/star-catalog-depth.spec.mjs re-derives tableSha256 from the shipped BrightStarCatalog.js and rejects this manifest if they disagree.",
    source: SOURCE,
    vendoredColumns: VENDORED_COLUMNS,
    licence: {
      position:
        "See LICENSE.md -> Bundled Engine Assets -> Bright-star catalogue, and Tools/star-catalog-bake/README.md §2.",
      heasarcDataPolicy:
        "https://heasarc.gsfc.nasa.gov/docs/heasarc/data_policy.html",
      heasarcQuote: "HEASARC materials are all available freely for your use.",
      tableSecurity: "public (heasarc_bsc5p TDAT header)",
      verified: "2026-08-01",
    },
    bake: {
      magnitudeLimit: args.limit,
      positionEpsilonDeg: POSITION_EPS_DEG,
      bvDefault: BV_DEFAULT,
      decimals: { ra: RA_DP, dec: DEC_DP, vmag: MAG_DP, bv: BV_DP },
      ordering:
        "curated rows in their historical order, then appended rows sorted by vmag ascending (brightest first), ties broken by ra then dec. No renderer depends on order: both starfield renderers draw the instances with additive premultiplied blending and depth writes disabled, so the composite is order-independent.",
    },
    sourceRows: {
      declared: parsed.declaredRows,
      read: parsed.seen,
      usable: parsed.stars.length,
      droppedNoPosition: parsed.droppedNoPosition,
      droppedNoMagnitude: parsed.droppedNoMagnitude,
      inMagnitudeBand: band.length,
    },
    reconcile: {
      curatedRowsRead: core.length,
      curatedRowsCorroborated: kept.length,
      worstResidualDeg: Number(maxSep.toFixed(4)),
      sourceRowsSuppressedAsDuplicates: excluded.size,
      sourceRowsCollapsedAsSameStar: collapsed.length,
      collapsedSameStar: collapsed,
      pixelFloorDeg: PIXEL_FLOOR_DEG,
      correctionsAppliedThisRun: corrections.length,
      // Recorded unconditionally: on an idempotent re-bake the rows are
      // already at their corrected positions, so nothing is applied, but the
      // decision record must survive.
      correctionsTable: CORRECTIONS.map(
        ([name, fromRa, fromDec, toRa, toDec, vmag, bv]) => ({
          name,
          from: { ra: fromRa, dec: fromDec },
          to: { ra: toRa, dec: toDec, vmag, bv },
          offsetDeg: Number(
            sepDeg(toUnit(fromRa, fromDec), toUnit(toRa, toDec)).toFixed(4),
          ),
        }),
      ),
    },
    output: {
      file: path.relative(repoRoot, args.out).split(path.sep).join("/"),
      stars: emittedRows.length,
      curated: kept.length,
      appended: appended.length,
      appendedUsingBvDefault: missingBv,
      brightestVmag: brightest,
      faintestVmag: faintest,
      stride: 4,
      tableSha256: hashTable(emittedRows),
      fileBytesBefore: beforeBytes,
      fileBytesAfter: afterBytes,
    },
  };

  if (args.dryRun) {
    log("\n--dry-run: nothing written");
    log(JSON.stringify(manifest.output, null, 2));
    return;
  }
  fs.writeFileSync(args.out, next);
  fs.writeFileSync(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`\nwrote ${path.relative(repoRoot, args.out)}`);
  log(`wrote ${path.relative(repoRoot, args.manifest)}`);
  log(
    `\nMAG_CUTOFF in packages/engine/Source/Scene/StarFieldMath.ts must equal ${faintest} ` +
      `(the faintest vendored star) or the deepened rows render at zero flux.`,
  );
}

main();
