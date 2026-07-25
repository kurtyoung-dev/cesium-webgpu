#!/usr/bin/env node
// build-eot20-constituent-grid.mjs — offline bake of the EOT20 ocean-tide
// constituent atlas into the "TCG1" grid read by
// `packages/engine/Source/Core/TideConstituentGrid.js`.
//
// Maintainer ruling T5 (migration_doc/TIDES_FEASIBILITY_2026-07-24.md §5a):
// "support BOTH EOT20 (bundled bake, CC BY 4.0) and NOAA CO-OPS (runtime,
// public domain, US stations); DEFAULT EOT20". This is the EOT20 half.
//
// THE ASSET IS NOT BAKED YET. Nothing under packages/engine/Source/Assets/Tides
// exists in the tree. This script + `Core/TideConstituentGrid.js` define the
// contract so the bake is a build step, not a redesign. Run it when you want
// the atlas; the engine falls back to the dataset-free equilibrium tide
// (`Core/TideModel.js`) until then, which is why the default path is not
// blocked on this.
//
// SOURCE + LICENCE
// ----------------
//   EOT20 — Empirical Ocean Tide model, DGFI-TUM.
//   DOI: 10.17882/79489   (SEANOE)  ->  https://doi.org/10.17882/79489
//   Paper: Hart-Davis, M. G., Piccioni, G., Dettmering, D., Schwatke, C.,
//          Passaro, M., and Seitz, F.: "EOT20: a global ocean tide model from
//          multi-mission satellite altimetry", Earth Syst. Sci. Data 13,
//          3869-3884, 2021.  https://doi.org/10.5194/essd-13-3869-2021
//
//   LICENCE: Creative Commons Attribution 4.0 (CC BY 4.0). CONFIRMED VERBATIM
//   in the ESSD paper's data-availability statement: "All ocean and load tide
//   data from the model can be freely accessed at https://doi.org/10.17882/79489
//   ... distributed under the Creative Commons Attribution 4.0 License."
//   (Recorded in TIDES_FEASIBILITY_2026-07-24.md §3, licence table row 1.)
//
//   ATTRIBUTION IS MANDATORY under CC BY. A bake committed to this repository
//   MUST add a LICENSE.md "Bundled Engine Assets" entry, following the Batch
//   730 pattern used for the EGM2008 geoid grid. The exact string this script
//   prints on success, and which must be copied verbatim:
//
//     Ocean tide constituents derived from EOT20 (Hart-Davis, M. G., Piccioni,
//     G., Dettmering, D., Schwatke, C., Passaro, M., and Seitz, F., 2021,
//     SEANOE, https://doi.org/10.17882/79489), licensed CC BY 4.0. Resampled
//     from the published 0.125-degree grid to a coarser grid and re-encoded;
//     this is a modified derivative and is not the original dataset.
//
//   CC BY also requires the modification to be flagged, which the second
//   sentence does. The multi-hundred-MB source is NEVER committed.
//
// DOWNLOAD — READ THIS BEFORE RUNNING
// -----------------------------------
// This script does NOT fetch. SEANOE serves EOT20 behind a versioned,
// session-scoped download path off the DOI landing page rather than a stable
// direct URL, so a URL hardcoded here would rot silently and a rotted URL that
// still returns 200 (an HTML error page) is worse than no URL at all. Resolve
// https://doi.org/10.17882/79489 in a browser, download the "ocean_tides"
// archive, unpack it, and point --input at the directory.
//
// UNVERIFIED, AND DELIBERATELY SO: the exact per-constituent file names, the
// NetCDF variable names, the DIMENSION ORDER and the complex sign convention
// inside that archive were NOT confirmed against a real download while this
// script was written (network fetch of the dataset was out of scope for the
// slice that produced it). Each of those four is handled explicitly, because
// they fail in two very different ways:
//
//   LOUD (a wrong guess crashes)      - file names, variable names. Discovered
//                                       by case-insensitive match; on a miss the
//                                       script lists what it actually found.
//   SILENT (a wrong guess bakes a plausible atlas with the tide in the wrong
//   place) - dimension order, complex sign. These get real handling:
//     * DIMENSION ORDER is read from the variable's own dimension NAMES,
//       cross-checked against the coordinate variables' element counts, and
//       transposed when it is (lon, lat). If names do not resolve and the grid
//       is square, the script REFUSES rather than flipping a coin.
//     * COMPLEX SIGN cannot be recovered from a (real, imag) pair at all. The
//       script therefore does not guess: it requires --imag-sign, and if the
//       archive also ships a phase variable it CONFIRMS the declared sign
//       against it and aborts on disagreement.
//
// CF PACKING is applied (`value = stored * scale_factor + add_offset`), with
// _FillValue tested on the RAW stored value before unpacking. Parsing those
// attributes and not applying them is a silent order-of-magnitude data error.
//
// SANITY GATE. Every bake is decoded back THROUGH the shipped
// `Core/TideConstituentGrid.js` and gated before anything is written: ocean
// coverage fraction, the leading constituent's median and maximum amplitude
// (which is what catches a units or scale_factor error), the circular spread of
// its phase (which catches a phase that failed to decode), and a node-by-node
// round trip sampled by LONGITUDE AND LATITUDE rather than by index (which
// catches a west/north swap, a step-units drift or a units-per-metre offset
// drift — none of which an index-space self-check can see).
//
// NETCDF FLAVOUR. A pure-JS NetCDF-3 ("classic" / "64-bit offset") reader is
// included — no dependencies. EOT20 may ship NetCDF-4, which is HDF5 and is NOT
// parseable here; the script detects the HDF5 magic and prints the one-line
// conversion command rather than failing obscurely.
//
// OUTPUT FORMAT ("TCG1")
// ----------------------
// Defined in full in the header of `Core/TideConstituentGrid.js`. Summary:
// 32-byte header, then a 4-byte ASCII id per constituent, then per constituent
// nx*ny int16 (real, imaginary) pairs in millimetres, row-major from the NORTH
// row south and each row west to east, with BOTH longitude seams present so the
// runtime sampler is a clamp with no wrap branch. Real/imaginary rather than
// amplitude/phase because phase wraps at 360 deg and interpolating across the
// wrap — unavoidable around every amphidromic point — injects a spurious tide
// reversal.
//
// SIZE / RESOLUTION TRADE (8 primary constituents, 4 bytes per node per
// constituent):
//
//   step      nodes         bytes        note
//   1.0 deg   361 x 181     2.00 MiB     coastal detail largely gone
//   0.5 deg   721 x 361     7.96 MiB     DEFAULT; matches the feasibility
//                                        report's "~2-8 MB" Tier-1 budget
//   0.25 deg  1441 x 721   31.75 MiB     too large to bundle
//
// EOT20's native grid is 0.125 deg. Decimating to 0.5 deg is lossy exactly
// where tides are most interesting (shelf seas and estuaries, where the real
// range is 1-16 m). That is a deliberate bundling trade, not an accuracy claim:
// the atlas exists to give the open ocean a real phase and amplitude instead of
// the equilibrium tide's ideal one, and a 3 km FFT ocean patch resolves nothing
// finer regardless. Raise --step for a regional bake if a coastal consumer
// lands.
//
// Usage:
//   node Tools/build-eot20-constituent-grid.mjs --input <dir>
//   node Tools/build-eot20-constituent-grid.mjs --input <dir> --step 1.0
//   node Tools/build-eot20-constituent-grid.mjs --input <dir> --all   # +Mf,Mm
//   node Tools/build-eot20-constituent-grid.mjs --input <dir> --out <file>
//   node Tools/build-eot20-constituent-grid.mjs --input <dir> --imag-sign negative
//   node Tools/build-eot20-constituent-grid.mjs --self-test           # no data
//
// --self-test bakes a synthetic analytic atlas, encodes it with the real
// encoder, and reads it back through the real `Core/TideConstituentGrid.js`
// under the same sanity gate a live bake runs. It proves the FORMAT — and the
// agreement between producer and consumer — without the dataset.
//
// `encode` and `sanityCheck` are exported so
// `Tools/visual-regression/tidal-harmonics.spec.mjs` drives them directly.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";

// The SHIPPED reader, imported so the producer is validated against the actual
// consumer. An earlier revision re-implemented the decode inline here, which
// meant the two could disagree about header SEMANTICS — units-per-metre offset,
// step units, a west/north swap — while the self test kept passing. Those are
// exactly the mutations that produce a silently wrong atlas rather than a
// crash, so the check has to go through this object and no other.
import TideConstituentGrid from "../packages/engine/Source/Core/TideConstituentGrid.js";

const MAGIC = 0x31474354; // "TCG1"
const HEADER_BYTES = 32;
const UNITS_PER_METRE = 1000; // int16 millimetres -> +-32.767 m
const NO_DATA = -32768;
const PRIMARY = ["M2", "S2", "N2", "K2", "K1", "O1", "P1", "Q1"];
const LONG_PERIOD = ["Mf", "Mm"];
const DEFAULT_OUT = path.join(
  "packages",
  "engine",
  "Source",
  "Assets",
  "Tides",
  "eot20-0p5deg.tcg",
);
const ATTRIBUTION = [
  "Ocean tide constituents derived from EOT20 (Hart-Davis, M. G., Piccioni, G.,",
  "Dettmering, D., Schwatke, C., Passaro, M., and Seitz, F., 2021, SEANOE,",
  "https://doi.org/10.17882/79489), licensed CC BY 4.0. Resampled from the",
  "published 0.125-degree grid to a coarser grid and re-encoded; this is a",
  "modified derivative and is not the original dataset.",
].join("\n  ");

function parseArgs(argv) {
  const args = {
    input: null,
    out: null,
    stepDeg: 0.5,
    constituents: PRIMARY.slice(),
    selfTest: false,
    imagSign: null,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input") {
      args.input = argv[++i];
    } else if (argv[i] === "--out") {
      args.out = argv[++i];
    } else if (argv[i] === "--step") {
      args.stepDeg = Number(argv[++i]);
    } else if (argv[i] === "--all") {
      args.constituents = PRIMARY.concat(LONG_PERIOD);
    } else if (argv[i] === "--self-test") {
      args.selfTest = true;
    } else if (argv[i] === "--imag-sign") {
      args.imagSign = argv[++i];
      if (args.imagSign !== "positive" && args.imagSign !== "negative") {
        throw new Error("--imag-sign must be 'positive' or 'negative'");
      }
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (
    !(args.stepDeg > 0) ||
    360 / args.stepDeg !== Math.round(360 / args.stepDeg)
  ) {
    throw new Error("--step must divide 360 exactly (e.g. 1.0, 0.5, 0.25)");
  }
  if (args.out === null) {
    args.out = DEFAULT_OUT.replace(
      "0p5deg",
      `${String(args.stepDeg).replace(".", "p")}deg`,
    );
  }
  if (!args.selfTest && args.input === null) {
    throw new Error(
      "--input <dir> is required (see the DOWNLOAD note at the top of this file), or use --self-test",
    );
  }
  return args;
}

// ── Minimal NetCDF-3 (classic / 64-bit offset) reader ─────────────────────
// XDR: everything big-endian, every field padded to a 4-byte boundary. Scoped
// to what a tide atlas needs — numeric variables with at most two dimensions,
// no record variables. NetCDF-4 is HDF5 and is rejected up front.
const NC_BYTE = 1;
const NC_CHAR = 2;
const NC_SHORT = 3;
const NC_INT = 4;
const NC_FLOAT = 5;
const NC_DOUBLE = 6;
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };

function readNetcdf3(buffer) {
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x48 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    throw new Error(
      "this file is HDF5 (NetCDF-4), which this reader cannot parse.\n" +
        "  Convert it once with either of:\n" +
        "    nccopy -k classic in.nc out.nc\n" +
        "    ncks -3 in.nc out.nc\n" +
        "  then re-run with --input pointing at the converted directory.",
    );
  }
  if (buffer[0] !== 0x43 || buffer[1] !== 0x44 || buffer[2] !== 0x46) {
    throw new Error("not a NetCDF file (bad magic)");
  }
  const version = buffer[3];
  if (version !== 1 && version !== 2) {
    throw new Error(`unsupported NetCDF classic version ${version}`);
  }
  let p = 4;
  const i32 = () => {
    const v = buffer.readInt32BE(p);
    p += 4;
    return v;
  };
  const i64 = () => {
    const v = Number(buffer.readBigInt64BE(p));
    p += 8;
    return v;
  };
  const name = () => {
    const n = i32();
    const s = buffer.toString("latin1", p, p + n);
    p += n + ((4 - (n % 4)) % 4);
    return s;
  };
  const skipValues = (type, n) => {
    const bytes = TYPE_SIZE[type] * n;
    p += bytes + ((4 - (bytes % 4)) % 4);
  };
  const attributes = () => {
    const tag = i32();
    const n = tag === 0 ? (i32(), 0) : i32();
    for (let i = 0; i < n; i++) {
      name();
      const type = i32();
      skipValues(type, i32());
    }
  };

  i32(); // numrecs

  const dims = [];
  {
    const tag = i32();
    const n = tag === 0 ? (i32(), 0) : i32();
    for (let i = 0; i < n; i++) {
      dims.push({ name: name(), length: i32() });
    }
  }
  attributes(); // global

  const variables = new Map();
  {
    const tag = i32();
    const n = tag === 0 ? (i32(), 0) : i32();
    for (let i = 0; i < n; i++) {
      const varName = name();
      const rank = i32();
      const shape = [];
      // Dimension NAMES are kept, not just lengths: they are the only reliable
      // way to tell a (lat, lon) grid from a (lon, lat) one, and a transposed
      // grid is the failure mode that produces a plausible-looking atlas with
      // the tide in the wrong place.
      const dimensionNames = [];
      for (let d = 0; d < rank; d++) {
        const dimension = dims[i32()];
        shape.push(dimension.length);
        dimensionNames.push(dimension.name);
      }
      // Per-variable attributes: we need _FillValue / missing_value, so parse
      // rather than skip.
      const attrs = new Map();
      const tagA = i32();
      const nA = tagA === 0 ? (i32(), 0) : i32();
      for (let a = 0; a < nA; a++) {
        const attrName = name();
        const attrType = i32();
        const attrCount = i32();
        const start = p;
        let value;
        if (attrType === NC_CHAR) {
          value = buffer.toString("latin1", start, start + attrCount);
        } else if (attrCount >= 1) {
          value = readScalar(buffer, start, attrType);
        }
        const bytes = TYPE_SIZE[attrType] * attrCount;
        p = start + bytes + ((4 - (bytes % 4)) % 4);
        attrs.set(attrName, value);
      }
      const type = i32();
      i32(); // vsize
      const begin = version === 1 ? i32() : i64();
      variables.set(varName, {
        name: varName,
        shape,
        dimensionNames,
        type,
        begin,
        attrs,
      });
    }
  }
  return { variables, dims };
}

function readScalar(buffer, offset, type) {
  switch (type) {
    case NC_BYTE:
      return buffer.readInt8(offset);
    case NC_SHORT:
      return buffer.readInt16BE(offset);
    case NC_INT:
      return buffer.readInt32BE(offset);
    case NC_FLOAT:
      return buffer.readFloatBE(offset);
    case NC_DOUBLE:
      return buffer.readDoubleBE(offset);
    default:
      return undefined;
  }
}

function readVariable(buffer, variable) {
  const count = variable.shape.reduce((a, b) => a * b, 1);
  const size = TYPE_SIZE[variable.type];
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = readScalar(buffer, variable.begin + i * size, variable.type);
  }
  // _FillValue FIRST, on the RAW stored values — CF packs the sentinel in the
  // stored type, so testing it after unpacking would compare a scaled fill
  // against an unscaled constant and miss every land node.
  const fill =
    variable.attrs.get("_FillValue") ?? variable.attrs.get("missing_value");
  if (typeof fill === "number") {
    for (let i = 0; i < count; i++) {
      if (out[i] === fill) {
        out[i] = NaN;
      }
    }
  }
  // CF packing: `value = stored * scale_factor + add_offset`. This is COMMON in
  // NetCDF — an int16-packed amplitude with scale_factor 0.1 is an ordinary way
  // to ship a tide grid — and ignoring it is a silent order-of-magnitude data
  // error, not a crash. Parsing the attributes and then not applying them is
  // the worst of both worlds, so they are applied here.
  const scale = variable.attrs.get("scale_factor");
  const offset = variable.attrs.get("add_offset");
  const hasScale = typeof scale === "number" && scale !== 1.0;
  const hasOffset = typeof offset === "number" && offset !== 0.0;
  if (hasScale || hasOffset) {
    const s = hasScale ? scale : 1.0;
    const o = hasOffset ? offset : 0.0;
    for (let i = 0; i < count; i++) {
      out[i] = out[i] * s + o;
    }
    console.log(
      `    ${variable.name}: CF packing applied (scale_factor ${s}, add_offset ${o})`,
    );
  }
  return out;
}

/**
 * The (lat, lon) element order of a 2-D data variable, with the singleton
 * dimensions (a degenerate time axis, say) squeezed out.
 *
 * Returns `{ rowsAreLatitude, rows, columns }`. Throws with the discovered
 * dimension names when the variable cannot be reconciled with the coordinate
 * variables — which is the whole point: the archive layout was never confirmed
 * against a real download, and unlike a wrong variable NAME (which fails
 * loudly at `pick`), a wrong dimension ORDER fails silently and bakes a
 * plausible atlas with the tide in the wrong place.
 */
function resolveGridOrder(variable, lonName, latName, slon, slat, file) {
  const axes = [];
  for (let i = 0; i < variable.shape.length; i++) {
    if (variable.shape[i] > 1) {
      axes.push({
        length: variable.shape[i],
        name: variable.dimensionNames[i],
      });
    }
  }
  const describe = `${variable.name}${JSON.stringify(variable.shape)} dims [${variable.dimensionNames.join(", ")}]`;
  const elements = variable.shape.reduce((a, b) => a * b, 1);
  if (elements !== slon * slat) {
    throw new Error(
      `${file}: ${describe} has ${elements} elements but the coordinate ` +
        `variables describe a ${slon} x ${slat} grid (${slon * slat} nodes).`,
    );
  }
  if (axes.length !== 2) {
    throw new Error(
      `${file}: ${describe} does not reduce to two non-singleton axes.`,
    );
  }
  const isLat = (n) => n === latName || /^(lat|latitude|y|nlat|j)$/i.test(n);
  const isLon = (n) => n === lonName || /^(lon|longitude|x|nlon|i)$/i.test(n);
  if (isLat(axes[0].name) && isLon(axes[1].name)) {
    return { rowsAreLatitude: true, rows: slat, columns: slon };
  }
  if (isLon(axes[0].name) && isLat(axes[1].name)) {
    console.warn(
      `    NOTE: ${describe} is (lon, lat); transposing to (lat, lon).`,
    );
    return { rowsAreLatitude: false, rows: slon, columns: slat };
  }
  // Names did not resolve. Shape can still settle it on a non-square grid;
  // on a square one there is genuinely no evidence, so refuse rather than
  // guess — a 50/50 coin flip on the tide's geography is not a default.
  if (slon !== slat) {
    if (axes[0].length === slat && axes[1].length === slon) {
      console.warn(
        `    NOTE: ${describe} dimension names unrecognised; inferred (lat, lon) from shape.`,
      );
      return { rowsAreLatitude: true, rows: slat, columns: slon };
    }
    if (axes[0].length === slon && axes[1].length === slat) {
      console.warn(
        `    NOTE: ${describe} dimension names unrecognised; inferred (lon, lat) from shape and transposing.`,
      );
      return { rowsAreLatitude: false, rows: slon, columns: slat };
    }
  }
  throw new Error(
    `${file}: cannot determine the dimension order of ${describe} ` +
      `against coordinate variables "${latName}" (${slat}) and "${lonName}" (${slon}). ` +
      `Rename the dimensions or extend the recognised names in resolveGridOrder().`,
  );
}

/** Reindex a (lon, lat) buffer into the (lat, lon) order `resample` expects. */
function transposeToLatMajor(values, slon, slat) {
  const out = new Float64Array(values.length);
  for (let j = 0; j < slat; j++) {
    for (let i = 0; i < slon; i++) {
      out[j * slon + i] = values[i * slat + j];
    }
  }
  return out;
}

// ── Source discovery ──────────────────────────────────────────────────────
const AMPLITUDE_NAMES = ["amplitude", "amp", "Amplitude", "ha"];
const PHASE_NAMES = ["phase", "pha", "Phase", "hp", "phase_lag"];
const REAL_NAMES = ["real", "hRe", "re", "Re"];
const IMAG_NAMES = ["imag", "hIm", "im", "Im", "imaginary"];
const LON_NAMES = ["lon", "longitude", "x"];
const LAT_NAMES = ["lat", "latitude", "y"];

function pick(variables, candidates) {
  for (const c of candidates) {
    if (variables.has(c)) {
      return variables.get(c);
    }
  }
  const lower = new Map([...variables.keys()].map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const hit = lower.get(c.toLowerCase());
    if (hit !== undefined) {
      return variables.get(hit);
    }
  }
  return undefined;
}

function findFile(directory, constituentId) {
  const wanted = constituentId.toLowerCase();
  const entries = fs.readdirSync(directory).filter((f) => /\.nc$/i.test(f));
  // "M2" must not match "MM2" or "2N2": require a non-alphanumeric boundary.
  const pattern = new RegExp(`(^|[^a-z0-9])${wanted}([^a-z0-9]|$)`, "i");
  const hits = entries.filter((f) => pattern.test(f));
  if (hits.length === 0) {
    throw new Error(
      `no NetCDF file for constituent ${constituentId} in ${directory}\n` +
        `  files present: ${entries.join(", ") || "(none)"}`,
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `ambiguous files for constituent ${constituentId}: ${hits.join(", ")}`,
    );
  }
  return path.join(directory, hits[0]);
}

// Returns { lon: Float64Array, lat: Float64Array, re, im } in METRES, with NaN
// wherever the source has no data.
function loadConstituent(directory, constituentId, imagSign) {
  const file = findFile(directory, constituentId);
  const buffer = fs.readFileSync(file);
  const { variables } = readNetcdf3(buffer);

  const lonVar = pick(variables, LON_NAMES);
  const latVar = pick(variables, LAT_NAMES);
  if (!lonVar || !latVar) {
    throw new Error(
      `${file}: no longitude/latitude variable.\n  variables present: ${[...variables.keys()].join(", ")}`,
    );
  }
  const lon = readVariable(buffer, lonVar);
  const lat = readVariable(buffer, latVar);
  if (lon.length < 2 || lat.length < 2) {
    throw new Error(
      `${file}: coordinate variables are degenerate (${lon.length} lon x ${lat.length} lat)`,
    );
  }
  // Every data variable is validated against these and transposed if needed, so
  // `resample` can index k = j * slon + i without assuming anything.
  const orient = (variable, values) => {
    const order = resolveGridOrder(
      variable,
      lonVar.name,
      latVar.name,
      lon.length,
      lat.length,
      file,
    );
    return order.rowsAreLatitude
      ? values
      : transposeToLatMajor(values, lon.length, lat.length);
  };

  const ampVar = pick(variables, AMPLITUDE_NAMES);
  const phaVar = pick(variables, PHASE_NAMES);
  const reVar = pick(variables, REAL_NAMES);
  const imVar = pick(variables, IMAG_NAMES);

  let re;
  let im;
  let mode;
  if (ampVar && phaVar) {
    mode = `amplitude(${ampVar.name}) + phase(${phaVar.name})`;
    const amplitude = orient(ampVar, readVariable(buffer, ampVar));
    const phase = orient(phaVar, readVariable(buffer, phaVar));
    // EOT20 publishes amplitude in CENTIMETRES and phase as the Greenwich
    // phase LAG in degrees. The units attribute is checked rather than assumed
    // because a wrong factor of 100 is a silently plausible tide.
    const units = String(ampVar.attrs.get("units") ?? "").toLowerCase();
    const toMetres = units.includes("m") && !units.includes("cm") ? 1.0 : 0.01;
    console.log(
      `    amplitude units "${ampVar.attrs.get("units") ?? "(none)"}" -> x${toMetres} to metres`,
    );
    re = new Float64Array(amplitude.length);
    im = new Float64Array(amplitude.length);
    for (let i = 0; i < amplitude.length; i++) {
      const a = amplitude[i] * toMetres;
      const g = (phase[i] * Math.PI) / 180.0;
      re[i] = a * Math.cos(g);
      im[i] = a * Math.sin(g);
    }
  } else if (reVar && imVar) {
    // THE CONJUGATION PROBLEM. TideConstituentGrid reads g = atan2(im, re),
    // i.e. it wants hc = A*exp(+i*g). Tide archives are split on whether their
    // stored complex is that or its conjugate A*exp(-i*g). Getting it backwards
    // TIME-REVERSES every tide — high water where low water belongs — and
    // produces an atlas that is entirely plausible on inspection. Nothing in a
    // real/imaginary pair alone resolves it, so this branch does NOT guess:
    // it requires the convention to be declared.
    if (imagSign !== "positive" && imagSign !== "negative") {
      throw new Error(
        `${file}: this archive supplies only a (real, imag) pair, whose sign\n` +
          `  convention cannot be determined from the data. Getting it wrong\n` +
          `  time-reverses every tide and looks correct.\n` +
          `  Re-run with --imag-sign positive   (stored hc = A*exp(+i*g)) or\n` +
          `             --imag-sign negative   (stored hc = A*exp(-i*g), the\n` +
          `                                     common oceanographic convention).\n` +
          `  To decide: pick one open-ocean point, bake both ways, and compare\n` +
          `  the predicted M2 high-water time against any published co-tidal\n` +
          `  chart or a NOAA CO-OPS station prediction. The two differ by half\n` +
          `  an M2 period (6.21 h) at most points, so one look settles it.`,
      );
    }
    const conjugate = imagSign === "negative" ? -1.0 : 1.0;
    mode = `real(${reVar.name}) + imag(${imVar.name}), --imag-sign ${imagSign}`;
    const units = String(reVar.attrs.get("units") ?? "").toLowerCase();
    const toMetres = units.includes("m") && !units.includes("cm") ? 1.0 : 0.01;
    const rawRe = orient(reVar, readVariable(buffer, reVar));
    const rawIm = orient(imVar, readVariable(buffer, imVar));
    re = new Float64Array(rawRe.length);
    im = new Float64Array(rawIm.length);
    for (let i = 0; i < rawRe.length; i++) {
      re[i] = rawRe[i] * toMetres;
      im[i] = conjugate * rawIm[i] * toMetres;
    }
    // If the archive ALSO ships an amplitude or a phase, the declared sign is
    // checkable rather than merely declared — so check it.
    if (phaVar) {
      const phase = orient(phaVar, readVariable(buffer, phaVar));
      let agree = 0;
      let disagree = 0;
      for (let i = 0; i < re.length; i += 101) {
        if (!Number.isFinite(re[i]) || !Number.isFinite(phase[i])) {
          continue;
        }
        const stored = Math.atan2(im[i], re[i]);
        const published = (phase[i] * Math.PI) / 180.0;
        const delta = Math.abs(
          Math.atan2(
            Math.sin(stored - published),
            Math.cos(stored - published),
          ),
        );
        if (delta < 0.1) {
          agree++;
        } else {
          disagree++;
        }
      }
      if (agree + disagree > 20 && disagree > agree) {
        throw new Error(
          `${file}: --imag-sign ${imagSign} disagrees with the file's own ` +
            `"${phaVar.name}" variable at ${disagree} of ${agree + disagree} sampled ` +
            `nodes. Use --imag-sign ${imagSign === "negative" ? "positive" : "negative"}.`,
        );
      }
      console.log(
        `    --imag-sign ${imagSign} CONFIRMED against "${phaVar.name}" (${agree}/${agree + disagree} nodes)`,
      );
    }
  } else {
    throw new Error(
      `${file}: found neither an (amplitude, phase) nor a (real, imag) pair.\n` +
        `  variables present: ${[...variables.keys()].join(", ")}`,
    );
  }
  console.log(`  ${constituentId}: ${path.basename(file)} [${mode}]`);
  return { lon, lat, re, im };
}

// ── Resampling onto the output graticule ──────────────────────────────────
// Bilinear over whichever source corners carry data, so a coastal output node
// keeps whatever ocean is adjacent instead of being poisoned by a land NaN.
function resample(source, nx, ny, westDeg, northDeg, stepDeg) {
  const { lon, lat, re, im } = source;
  const slon = lon.length;
  const slat = lat.length;
  const lon0 = lon[0];
  const dlon = lon[1] - lon[0];
  const lat0 = lat[0];
  const dlat = lat[1] - lat[0];
  const outRe = new Float64Array(nx * ny);
  const outIm = new Float64Array(nx * ny);

  for (let j = 0; j < ny; j++) {
    const latitude = northDeg - j * stepDeg;
    const fy = (latitude - lat0) / dlat;
    let j0 = Math.floor(fy);
    if (j0 < 0) {
      j0 = 0;
    } else if (j0 > slat - 2) {
      j0 = slat - 2;
    }
    const ty = Math.min(1, Math.max(0, fy - j0));
    for (let i = 0; i < nx; i++) {
      let longitude = westDeg + i * stepDeg;
      // Source longitudes may run 0..360; bring the query into their range.
      while (longitude < lon0) {
        longitude += 360;
      }
      while (longitude >= lon0 + 360) {
        longitude -= 360;
      }
      const fx = (longitude - lon0) / dlon;
      const i0 = Math.min(slon - 1, Math.max(0, Math.floor(fx)));
      const i1 = (i0 + 1) % slon; // the source wraps in longitude
      const tx = Math.min(1, Math.max(0, fx - i0));
      let sumRe = 0;
      let sumIm = 0;
      let weight = 0;
      const corners = [
        [i0, j0, (1 - tx) * (1 - ty)],
        [i1, j0, tx * (1 - ty)],
        [i0, j0 + 1, (1 - tx) * ty],
        [i1, j0 + 1, tx * ty],
      ];
      for (const [ci, cj, w] of corners) {
        const k = cj * slon + ci;
        if (w > 0 && Number.isFinite(re[k]) && Number.isFinite(im[k])) {
          sumRe += w * re[k];
          sumIm += w * im[k];
          weight += w;
        }
      }
      const index = j * nx + i;
      if (weight > 0) {
        outRe[index] = sumRe / weight;
        outIm[index] = sumIm / weight;
      } else {
        outRe[index] = NaN;
        outIm[index] = NaN;
      }
    }
  }
  return { re: outRe, im: outIm };
}

// ── Encoder ───────────────────────────────────────────────────────────────
// Exported so `Tools/visual-regression/tidal-harmonics.spec.mjs` drives the
// REAL encoder and the REAL sanity gate rather than a third hand-written copy
// of the layout — the same reason the gate itself decodes through the shipped
// TideConstituentGrid.
export function encode(ids, grids, nx, ny, westDeg, northDeg, stepDeg) {
  const count = ids.length;
  const payloadOffset = HEADER_BYTES + count * 4;
  const buffer = Buffer.alloc(payloadOffset + nx * ny * 2 * 2 * count);
  buffer.writeUInt32LE(MAGIC, 0);
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt16LE(UNITS_PER_METRE, 6);
  buffer.writeUInt32LE(nx, 8);
  buffer.writeUInt32LE(ny, 12);
  buffer.writeInt32LE(Math.round(westDeg * 1e6), 16);
  buffer.writeInt32LE(Math.round(northDeg * 1e6), 20);
  buffer.writeUInt32LE(Math.round(stepDeg * 1e6), 24);
  buffer.writeUInt16LE(count, 28);
  buffer.writeUInt16LE(0, 30);
  // Ids sit between the fixed header and the payload, 4 ASCII bytes each,
  // NUL-padded by Buffer.alloc.
  ids.forEach((id, i) => buffer.write(id, HEADER_BYTES + i * 4, 4, "latin1"));

  let clamped = 0;
  let noData = 0;
  const limit = 32767;
  for (let c = 0; c < ids.length; c++) {
    const { re, im } = grids[c];
    let p = payloadOffset + c * nx * ny * 4;
    for (let k = 0; k < nx * ny; k++) {
      if (!Number.isFinite(re[k]) || !Number.isFinite(im[k])) {
        buffer.writeInt16LE(NO_DATA, p);
        buffer.writeInt16LE(0, p + 2);
        noData++;
      } else {
        let r = Math.round(re[k] * UNITS_PER_METRE);
        let i2 = Math.round(im[k] * UNITS_PER_METRE);
        // The NO_DATA sentinel must stay unreachable as data: clamp the real
        // channel to -32767, one above it.
        if (r > limit) {
          r = limit;
          clamped++;
        } else if (r < -limit) {
          r = -limit;
          clamped++;
        }
        if (i2 > limit) {
          i2 = limit;
          clamped++;
        } else if (i2 < -limit) {
          i2 = -limit;
          clamped++;
        }
        buffer.writeInt16LE(r, p);
        buffer.writeInt16LE(i2, p + 2);
      }
      p += 4;
    }
  }
  return { buffer, clamped, noData };
}

// ── Sanity gate ───────────────────────────────────────────────────────────
// Runs on EVERY bake and on --self-test, and decodes THROUGH the shipped
// TideConstituentGrid. Before this existed, a 100%-no-data atlas or one with a
// units error wrote successfully and exited 0.
//
// Bounds and why each is where it is:
export const SANITY = Object.freeze({
  // Node-count coverage over a global lat/lon graticule. A lat/lon grid
  // over-weights polar rows, so this is NOT the 71% ocean AREA fraction and the
  // band is deliberately wide — it exists to catch a lost land mask (-> 1.0)
  // and a decode that produced nothing (-> 0.0), not to grade a coastline.
  MIN_COVERAGE: 0.3,
  MAX_COVERAGE: 0.98,
  // M2 ocean amplitude. Real open-ocean M2 is a few cm to ~1 m, with resonant
  // shelf maxima to ~5 m (a 0.5 deg grid smooths the 16 m Fundy extreme away).
  // An unapplied scale_factor of 0.1, or a cm/m mix-up, moves the MEDIAN by an
  // order of magnitude and lands outside this band.
  M2_MEDIAN_MIN_M: 0.005,
  M2_MEDIAN_MAX_M: 1.0,
  M2_MAX_MIN_M: 0.4,
  M2_MAX_MAX_M: 20.0,
  // Circular resultant length of the M2 phase over the ocean. A real global M2
  // field sweeps the whole circle around its amphidromes, so R is small; a
  // phase that failed to decode is constant and gives R ~ 1.
  MAX_PHASE_RESULTANT: 0.75,
  // Round-trip through the reader: int16 millimetres, so half a millimetre plus
  // the reader's own bilinear arithmetic at an exact node.
  MAX_NODE_ERROR_M: 0.0011,
});

/**
 * Decode `buffer` with the shipped reader and check it against the arrays that
 * were encoded. Throws on any hard failure; returns a stats object.
 */
export function sanityCheck(
  buffer,
  ids,
  grids,
  nx,
  ny,
  westDeg,
  northDeg,
  stepDeg,
) {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  const grid = new TideConstituentGrid(arrayBuffer);

  if (grid.constituentIds.join(",") !== ids.join(",")) {
    throw new Error(
      `sanity: the reader sees [${grid.constituentIds.join(", ")}], the bake wrote [${ids.join(", ")}]`,
    );
  }
  if (grid.longitudeCount !== nx || grid.latitudeCount !== ny) {
    throw new Error(
      `sanity: the reader sees ${grid.longitudeCount}x${grid.latitudeCount}, the bake wrote ${nx}x${ny}`,
    );
  }
  if (Math.abs(grid.stepDegrees - stepDeg) > 1e-9) {
    throw new Error(
      `sanity: the reader sees step ${grid.stepDegrees} deg, the bake wrote ${stepDeg}`,
    );
  }

  // Node round trip THROUGH THE READER. Sampling by (longitude, latitude)
  // rather than by index is what makes a west/north swap or a step-units drift
  // fail here — an index-space comparison would agree with itself regardless.
  const station = grid.createStation();
  let worstNodeError = 0;
  let worstAt = "";
  let checked = 0;
  let sentinels = 0;
  const stride = Math.max(1, Math.floor((nx * ny) / 4096));
  for (let k = 0; k < nx * ny; k += stride) {
    const j = Math.floor(k / nx);
    const i = k - j * nx;
    const longitude = westDeg + i * stepDeg;
    const latitude = northDeg - j * stepDeg;
    if (longitude > 180 || latitude < -90) {
      continue;
    }
    grid.sampleInto(longitude, latitude, station);
    for (let c = 0; c < ids.length; c++) {
      const re = grids[c].re[k];
      const im = grids[c].im[k];
      if (!Number.isFinite(re) || !Number.isFinite(im)) {
        // The reader renormalises over the neighbours of a land node, so it may
        // legitimately return a value here; what must hold is the sentinel
        // round trip, which the coverage statistic below covers.
        sentinels++;
        continue;
      }
      const error = Math.abs(
        station.amplitudeM[c] - Math.sqrt(re * re + im * im),
      );
      if (error > worstNodeError) {
        worstNodeError = error;
        worstAt = `${ids[c]} at ${longitude},${latitude}`;
      }
      checked++;
    }
  }
  if (worstNodeError > SANITY.MAX_NODE_ERROR_M) {
    throw new Error(
      `sanity: the reader disagrees with the encoder by ${(worstNodeError * 1000).toFixed(3)} mm ` +
        `(worst: ${worstAt}). Producer and consumer have drifted apart — check the header semantics ` +
        `(units per metre, step units, west/north edges).`,
    );
  }

  // Population statistics on the first constituent (M2 by construction of
  // PRIMARY), read out of the encoded payload rather than the source arrays.
  const values = new Int16Array(
    arrayBuffer,
    HEADER_BYTES + ids.length * 4,
    nx * ny * 2 * ids.length,
  );
  const amplitudes = [];
  let ocean = 0;
  let sumSin = 0;
  let sumCos = 0;
  for (let k = 0; k < nx * ny; k++) {
    const p = k * 2;
    if (values[p] === NO_DATA) {
      continue;
    }
    ocean++;
    const re = values[p] / UNITS_PER_METRE;
    const im = values[p + 1] / UNITS_PER_METRE;
    const amplitude = Math.sqrt(re * re + im * im);
    amplitudes.push(amplitude);
    if (amplitude > 0) {
      const g = Math.atan2(im, re);
      sumCos += Math.cos(g);
      sumSin += Math.sin(g);
    }
  }
  const coverage = ocean / (nx * ny);
  amplitudes.sort((a, b) => a - b);
  const median = amplitudes.length ? amplitudes[amplitudes.length >> 1] : NaN;
  const maximum = amplitudes.length ? amplitudes[amplitudes.length - 1] : NaN;
  const resultant = ocean
    ? Math.sqrt(sumCos * sumCos + sumSin * sumSin) / ocean
    : 1;

  const fail = (message) => {
    throw new Error(`sanity: ${message}`);
  };
  if (coverage < SANITY.MIN_COVERAGE) {
    fail(
      `only ${(100 * coverage).toFixed(2)}% of nodes carry data — an atlas that is almost entirely no-data is not a bake`,
    );
  }
  if (coverage > SANITY.MAX_COVERAGE) {
    fail(
      `${(100 * coverage).toFixed(2)}% of nodes carry data — the land mask was lost, so continents will be given a tide`,
    );
  }
  if (!(median >= SANITY.M2_MEDIAN_MIN_M && median <= SANITY.M2_MEDIAN_MAX_M)) {
    fail(
      `${ids[0]} median amplitude ${median.toFixed(4)} m is outside [${SANITY.M2_MEDIAN_MIN_M}, ${SANITY.M2_MEDIAN_MAX_M}] — check the units (scale_factor, cm vs m)`,
    );
  }
  if (!(maximum >= SANITY.M2_MAX_MIN_M && maximum <= SANITY.M2_MAX_MAX_M)) {
    fail(
      `${ids[0]} maximum amplitude ${maximum.toFixed(4)} m is outside [${SANITY.M2_MAX_MIN_M}, ${SANITY.M2_MAX_MAX_M}] — check the units`,
    );
  }
  if (resultant > SANITY.MAX_PHASE_RESULTANT) {
    fail(
      `${ids[0]} phase is clustered (circular resultant ${resultant.toFixed(3)}) — a global tide sweeps the full circle around its amphidromes, so this looks like a phase that failed to decode`,
    );
  }

  return {
    coverage,
    median,
    maximum,
    resultant,
    worstNodeError,
    checked,
    sentinels,
  };
}

// ── Self test: analytic atlas -> encode -> READ BACK WITH THE SHIPPED READER ──
function selfTest(stepDeg) {
  const nx = Math.round(360 / stepDeg) + 1;
  const ny = Math.round(180 / stepDeg) + 1;
  const ids = PRIMARY.slice();
  const grids = [];
  for (let c = 0; c < ids.length; c++) {
    const re = new Float64Array(nx * ny);
    const im = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const latitude = 90 - j * stepDeg;
      for (let i = 0; i < nx; i++) {
        const longitude = -180 + i * stepDeg;
        const k = j * nx + i;
        if (Math.abs(latitude) > 80) {
          re[k] = NaN; // stand-in for the polar ice / land mask
          im[k] = NaN;
          continue;
        }
        // Amplitude and phase both vary with position so that a transposed or
        // edge-swapped decode cannot coincidentally agree.
        const amplitude =
          0.35 + 0.2 * Math.cos((longitude * Math.PI) / 180) + 0.02 * c;
        const g = ((longitude * 2 + latitude * 3 + 37 * c) * Math.PI) / 180;
        re[k] = amplitude * Math.cos(g);
        im[k] = amplitude * Math.sin(g);
      }
    }
    grids.push({ re, im });
  }
  const { buffer } = encode(ids, grids, nx, ny, -180, 90, stepDeg);
  const stats = sanityCheck(buffer, ids, grids, nx, ny, -180, 90, stepDeg);
  console.log(
    `self test: ${ids.length} constituents, ${nx}x${ny}, ${buffer.length} bytes\n` +
      `  read back through Core/TideConstituentGrid.js at ${stats.checked} node samples\n` +
      `  worst amplitude disagreement ${(stats.worstNodeError * 1000).toFixed(3)} mm ` +
      `(budget ${(SANITY.MAX_NODE_ERROR_M * 1000).toFixed(1)} mm)\n` +
      `  coverage ${(100 * stats.coverage).toFixed(2)}%, ${ids[0]} median ${stats.median.toFixed(4)} m, ` +
      `max ${stats.maximum.toFixed(4)} m, phase resultant ${stats.resultant.toFixed(3)}`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.selfTest) {
    selfTest(args.stepDeg);
    return;
  }

  const nx = Math.round(360 / args.stepDeg) + 1; // both seams
  const ny = Math.round(180 / args.stepDeg) + 1; // both poles
  console.log(
    `baking ${args.constituents.length} constituents at ${args.stepDeg} deg (${nx} x ${ny}) from ${args.input}`,
  );

  const grids = args.constituents.map((id) => {
    const source = loadConstituent(args.input, id, args.imagSign);
    return resample(source, nx, ny, -180, 90, args.stepDeg);
  });

  const { buffer, clamped, noData } = encode(
    args.constituents,
    grids,
    nx,
    ny,
    -180,
    90,
    args.stepDeg,
  );

  // Gate BEFORE writing: a rejected bake must not leave a plausible-looking
  // file on disk for someone to commit later.
  const stats = sanityCheck(
    buffer,
    args.constituents,
    grids,
    nx,
    ny,
    -180,
    90,
    args.stepDeg,
  );
  console.log(
    `\nsanity: coverage ${(100 * stats.coverage).toFixed(2)}%, ` +
      `${args.constituents[0]} median ${stats.median.toFixed(4)} m / max ${stats.maximum.toFixed(4)} m, ` +
      `phase resultant ${stats.resultant.toFixed(3)}, ` +
      `reader round trip ${(stats.worstNodeError * 1000).toFixed(3)} mm over ${stats.checked} samples`,
  );

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, buffer);
  const sha = crypto.createHash("sha256").update(buffer).digest("hex");
  console.log(`\nwrote ${args.out}`);
  console.log(
    `  ${buffer.length} bytes (${(buffer.length / 1048576).toFixed(2)} MiB)`,
  );
  console.log(`  sha256 ${sha}`);
  console.log(`  ${noData} no-data nodes, ${clamped} clamped samples`);
  if (clamped > 0) {
    console.warn(
      `  WARNING: ${clamped} samples exceeded +-32.767 m and were clamped. ` +
        `That should not happen for a real ocean tide — check the amplitude units.`,
    );
  }
  console.log(
    `\nAdd to LICENSE.md under "Bundled Engine Assets":\n\n  ${ATTRIBUTION}\n`,
  );
}

// Only run when invoked as a script. The spec imports `encode`/`sanityCheck`
// from this file, and an unconditional main() would fire (and fail on the
// missing --input) at import time.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`build-eot20-constituent-grid: ${error.message}`);
    process.exitCode = 1;
  });
}
