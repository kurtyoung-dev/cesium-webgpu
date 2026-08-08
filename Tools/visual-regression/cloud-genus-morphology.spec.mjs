// C13-16 — per-genus cloud morphology (the cirrus row).
//
// PREMISE THIS FILE PINS. `Scene/CloudTypeProfile.js` has always carried five
// axes per WMO genus, and two of them reached no renderer at all: the
// FIBROUS/PUFFY `erosion` style and the Henyey-Greenstein `phaseG`. A genus
// therefore differed only in deck, height-gradient shape, density scale, and
// extinction — so CIRRUS rendered as a faint, scaled-down CUMULUS instead of as
// ice. The C13-01 tour recorded exactly that: `northatlantic-cirrus-fibratus`
// carries the note "Genus MORPHOLOGY (fibrous streaks vs generic puffs) remains
// C13-16" even after CLOUD-LOW-COVERAGE-CUTOFF restored its VISIBILITY.
//
// WHAT IS ASSERTED, AND WHY IN THIS FORM.
//
//  1. Add-only layout. The new uniform row sits at 168-171 and every earlier
//     offset is unchanged, matching the fork's frozen-offset rule.
//  2. Default byte-neutrality, with `assert.equal` and no tolerances anywhere.
//     The default genus is CUMULUS: its fibre row is exactly the identity, its
//     phase delta is exactly 0, the fibre factor is exactly 1, and the erosion
//     height weight is exactly the historical `1 - h`.
//  3. STRUCTURAL morphology, never band means. The metric is the ratio of the
//     fibre field's correlation length along the wind to its correlation length
//     across it, plus the along-wind lag between the deck top and the deck
//     base. Both are properties of the coordinate transform rather than of the
//     noise permutation, so they survive the CPU twin's f32/f64 hash difference
//     — and both are blind to overall brightness, which is the trap this
//     campaign keeps rediscovering: a faint wide-band cloud change is invisible
//     to a band mean.
//  4. MUTATION coverage. The acceptance predicate is run against deliberately
//     broken rows — anisotropy flattened to 1, shear removed, strength removed
//     — and each must be REJECTED. A predicate that passes a flattened row is
//     not measuring anisotropy.
//
// Exact rendered luminance is not this file's job; the Edge acceptance owns it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultVariant } from "./lib/wgsl-variant.mjs";

import CloudType from "../../packages/engine/Source/Scene/CloudType.js";
import CloudTypeProfile from "../../packages/engine/Source/Scene/CloudTypeProfile.js";
import {
  fallstreakLag,
  fibreElongation,
  fibreHeightBands,
  genusErosionHeightWeight,
  genusFibreFactor,
  genusForwardG,
  genusPhaseDeltaFor,
  GENUS_PHASE_G_LIMIT,
} from "./lib/cloud-genus-morphology-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const cloudShaderSource = read(
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
);
const domainSource = read(
  "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
);
const rendererSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const profileSource = read("packages/engine/Source/Scene/CloudTypeProfile.js");

function functionSource(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  assert.fail(`unterminated function ${name}`);
}

const FIBROUS = CloudTypeProfile.CloudErosionStyle.FIBROUS;
const PUFFY = CloudTypeProfile.CloudErosionStyle.PUFFY;
const ALL_GENERA = Array.from({ length: CloudType.COUNT }, (_, i) => i);
const rowFor = (genus) => CloudTypeProfile.getFibreMorphology(genus);
const CIRRUS_ROW = rowFor(CloudType.CIRRUS);
const CUMULUS_ROW = rowFor(CloudType.CUMULUS);
/** The default `phaseG1` the renderer packs when no dial overrides it. */
const DEFAULT_PHASE_G1 = 0.85;

// ── 1. Add-only uniform layout ────────────────────────────────────────────

test("the per-genus morphology row is appended at 168-171, offsets frozen", () => {
  // Every pre-existing tail field keeps its documented slot.
  assert.match(
    cloudShaderSource,
    /densityMorphologyOriginHigh: vec3<f32>, \/\/ 160-162/,
  );
  assert.match(
    cloudShaderSource,
    /densityMorphologyOriginLow: vec3<f32>,\s*\/\/ 164-166/,
  );

  // The new row is the LAST thing in the struct, in slot order.
  const struct = cloudShaderSource.slice(
    cloudShaderSource.indexOf("struct CloudUniforms {"),
  );
  const structBody = struct.slice(0, struct.indexOf("\n};"));
  const newFields = [
    ["genusFibreStrength", 168],
    ["genusFibreAnisotropy", 169],
    ["genusFibreShear", 170],
    ["genusPhaseDelta", 171],
  ];
  let previousIndex = structBody.indexOf("densityMorphologyOriginLow");
  assert.ok(previousIndex > 0);
  for (const [field, slot] of newFields) {
    const index = structBody.indexOf(`${field}: f32,`);
    assert.ok(index > previousIndex, `${field} must follow the C13-37 tail`);
    assert.match(
      structBody.slice(index, index + 120),
      new RegExp(`\\/\\/ ${slot} `),
      `${field} must be documented at slot ${slot}`,
    );
    previousIndex = index;
  }

  // The renderer's float count grows by exactly one 16-byte row, expressed as an
  // addition rather than a rewritten literal so the growth stays auditable.
  assert.match(rendererSource, /const CLOUD_GENUS_MORPHOLOGY_FLOATS = 4;/);
  assert.match(
    rendererSource,
    /const CLOUD_UNIFORM_FLOATS =\s*148 \+ CLOUD_DENSITY_PRIMARY_ORIGIN_FLOATS \+ CLOUD_GENUS_MORPHOLOGY_FLOATS;/,
  );
  // 148 + 20 + 4 = 172 floats = 688 bytes = 43 whole 16-byte rows.
  assert.equal((148 + 20 + 4) % 4, 0);

  // The four writes are consecutive and in slot order.
  const writes = rendererSource.slice(
    rendererSource.indexOf("// 168 genusFibreStrength"),
  );
  const order = [
    "168 genusFibreStrength",
    "169 genusFibreAnisotropy",
    "170 genusFibreShear",
    "171 genusPhaseDelta",
  ];
  let cursor = -1;
  for (const marker of order) {
    const index = writes.indexOf(marker);
    assert.ok(index > cursor, `slot write out of order: ${marker}`);
    cursor = index;
  }
});

test("the renderer derives the row from the profile table, not from new dials", () => {
  assert.match(
    rendererSource,
    /CloudTypeProfile\.getFibreMorphology\(\s*config\.cloudType \?\? CloudType\.CUMULUS,?\s*\)/,
  );
  assert.match(
    rendererSource,
    /data\[offset\+\+\] = profile\.phaseG - cumulusProfile\.phaseG;/,
  );
  // `cloudType` stays the single public selector: this row introduces no new
  // `config.cloudGenus*` escape hatch that could drift from the table.
  assert.doesNotMatch(rendererSource, /cloudGenusFibre/);
});

// ── 2. Default byte-neutrality — exact equality, no tolerances ────────────

test("the default genus packs an exact identity row", () => {
  assert.equal(CUMULUS_ROW.strength, 0);
  assert.equal(CUMULUS_ROW.anisotropy, 1);
  assert.equal(CUMULUS_ROW.shear, 0);
  assert.equal(genusPhaseDeltaFor(CloudType.CUMULUS), 0);
});

test("the fibre factor is exactly 1 at the default genus", () => {
  for (const h of [0, 0.13, 0.5, 0.87, 1]) {
    for (const x of [-11.7, 0, 3.25, 91.5]) {
      for (const z of [-4.5, 0, 7.75]) {
        assert.equal(
          genusFibreFactor([x, 3.0, z], h, CUMULUS_ROW),
          1,
          `factor must be exactly 1 at (${x}, ${z}, h=${h})`,
        );
      }
    }
  }
});

test("the erosion height weight is exactly the historical 1 - h at the default", () => {
  for (const h of [0, 0.15, 0.37, 0.5, 0.7, 0.92, 1]) {
    assert.equal(
      genusErosionHeightWeight(h, CUMULUS_ROW.strength),
      Math.fround(1 - h),
      `erosion height weight must be exactly 1 - h at h=${h}`,
    );
  }
});

test("the forward phase lobe is exactly phaseG1 at the default genus", () => {
  assert.equal(
    genusForwardG(DEFAULT_PHASE_G1, genusPhaseDeltaFor(CloudType.CUMULUS)),
    DEFAULT_PHASE_G1,
  );
  for (const g of [0.0, 0.42, 0.85, 0.99, -0.3]) {
    assert.equal(genusForwardG(g, 0), g);
  }
});

test("the WGSL identity guards are explicit early returns, not arithmetic luck", () => {
  const fibre = functionSource(cloudShaderSource, "genusFibreFactor");
  assert.match(fibre, /if \(strength <= 0\.0\) \{\s*return 1\.0;\s*\}/);

  const weight = functionSource(cloudShaderSource, "genusErosionHeightWeight");
  assert.match(weight, /if \(fibre <= 0\.0\) \{\s*return 1\.0 - h;\s*\}/);

  const forward = functionSource(cloudShaderSource, "genusForwardG");
  assert.match(
    forward,
    /if \(cloud\.genusPhaseDelta == 0\.0\) \{\s*return cloud\.phaseG1;\s*\}/,
  );

  // MUTATION: strip each early return and the guard check above must fail. A
  // contract that still passes without its guard is not checking the guard.
  const stripped = [
    [fibre, /if \(strength <= 0\.0\) \{\s*return 1\.0;\s*\}/],
    [weight, /if \(fibre <= 0\.0\) \{\s*return 1\.0 - h;\s*\}/],
    [
      forward,
      /if \(cloud\.genusPhaseDelta == 0\.0\) \{\s*return cloud\.phaseG1;\s*\}/,
    ],
  ];
  for (const [source, pattern] of stripped) {
    const mutant = source.replace(pattern, "");
    assert.doesNotMatch(mutant, pattern);
  }
});

// ── 3. Structural morphology — the row's actual deliverable ───────────────

/**
 * The acceptance predicate. Deliberately expressed once and reused, so the
 * mutation group below runs the SAME predicate the passing case runs.
 *
 * `expected` supplies the thresholds and defaults to the row itself. The
 * mutation group holds `expected` at the AUTHORED cirrus row while feeding a
 * broken `row`, so a mutation cannot pass by moving the goalposts with it.
 */
function assertCirriformMorphology(row, label, expected = row) {
  const { elongation } = fibreElongation(row);
  assert.ok(
    elongation >= 4,
    `${label}: filaments must run at least 4x longer along the wind than ` +
      `across it (measured ${elongation.toFixed(2)})`,
  );
  const lag = fallstreakLag(row);
  assert.ok(
    lag > 0.5 * expected.shear,
    `${label}: the deck base must lag the generating head downwind ` +
      `(measured ${lag.toFixed(3)} against shear ${expected.shear})`,
  );
  // A carve that removes nothing is not a morphology.
  const bands = fibreHeightBands(row);
  assert.ok(
    Math.max(...bands) < 0.9,
    `${label}: the fibre field must actually carve (max band ${Math.max(
      ...bands,
    ).toFixed(3)})`,
  );
}

test("CIRRUS renders as wind-aligned, fallstreak-sheared filaments", () => {
  assertCirriformMorphology(CIRRUS_ROW, "cirrus");

  // The measured elongation tracks the authored aspect ratio rather than being
  // an arbitrary "it is different" threshold.
  const { alongLength, acrossLength, elongation } = fibreElongation(CIRRUS_ROW);
  assert.ok(
    elongation > 0.6 * CIRRUS_ROW.anisotropy &&
      elongation < 1.4 * CIRRUS_ROW.anisotropy,
    `elongation ${elongation.toFixed(2)} should track anisotropy ` +
      `${CIRRUS_ROW.anisotropy} (along ${alongLength.toFixed(3)}, ` +
      `across ${acrossLength.toFixed(3)})`,
  );

  // The fallstreak lag recovers the authored shear, sign included.
  const lag = fallstreakLag(CIRRUS_ROW);
  assert.ok(
    Math.abs(lag - CIRRUS_ROW.shear) < 0.15,
    `fallstreak lag ${lag.toFixed(3)} should recover shear ${CIRRUS_ROW.shear}`,
  );
});

test("the fibre carve is columnar, not a base or top band", () => {
  // This is what separates the GENUS grain from the supplementary features next
  // to it: mammatus / asperitas / arcus / virga all carve a BASE band and
  // fluctus carves a TOP band, so each shows a strong height ramp. An ice
  // filament is a curtain hanging through the whole layer.
  const bands = fibreHeightBands(CIRRUS_ROW);
  const spread = Math.max(...bands) - Math.min(...bands);
  assert.ok(
    spread < 0.02,
    `fibre bands should be near-uniform through the deck (spread ${spread.toFixed(
      4,
    )}): ${bands.map((b) => b.toFixed(4)).join(", ")}`,
  );

  // The default genus leaves every band exactly untouched.
  for (const band of fibreHeightBands(CUMULUS_ROW)) {
    assert.equal(band, 1);
  }
});

test("cirrus is discriminated from cumulus by DIRECTION, not by dimming", () => {
  // The cumuliform field is pointwise identity, so any nonzero elongation
  // difference is entirely the ice path's doing.
  const cirrus = fibreElongation(CIRRUS_ROW).elongation;
  const isotropicSameStrength = fibreElongation({
    ...CIRRUS_ROW,
    anisotropy: 1,
  }).elongation;
  assert.ok(
    isotropicSameStrength < 1.5,
    `an isotropic carve of the same depth must not read as directional ` +
      `(measured ${isotropicSameStrength.toFixed(2)})`,
  );
  assert.ok(
    cirrus > 4 * isotropicSameStrength,
    `cirrus elongation ${cirrus.toFixed(2)} must dominate the same-depth ` +
      `isotropic carve ${isotropicSameStrength.toFixed(2)}`,
  );

  // ...and the two carve comparably much, so the discriminator is not brightness.
  const cirrusBand = fibreHeightBands(CIRRUS_ROW)[2];
  const isotropicBand = fibreHeightBands({ ...CIRRUS_ROW, anisotropy: 1 })[2];
  assert.ok(
    Math.abs(cirrusBand - isotropicBand) < 0.15,
    `the anisotropic and isotropic carves should remove a comparable amount ` +
      `(${cirrusBand.toFixed(3)} vs ${isotropicBand.toFixed(3)}) — otherwise ` +
      `the elongation test could be passing on density alone`,
  );
});

// ── 4. Mutation coverage — the predicate must reject broken rows ──────────

test("MUTATION: flattening the anisotropy is rejected", () => {
  assert.throws(
    () =>
      assertCirriformMorphology(
        { ...CIRRUS_ROW, anisotropy: 1 },
        "flattened-anisotropy",
      ),
    /longer along the wind/,
  );
  // Also rejected just below the authored value's neighbourhood, so the
  // threshold is not tuned to only catch a total collapse.
  assert.throws(
    () =>
      assertCirriformMorphology(
        { ...CIRRUS_ROW, anisotropy: 2.5 },
        "weak-anisotropy",
      ),
    /longer along the wind/,
  );
});

test("MUTATION: removing the fallstreak shear is rejected", () => {
  // The threshold stays pinned to the AUTHORED shear while the field carries
  // none, so this measures the rendered tilt rather than the authored number.
  assert.throws(
    () =>
      assertCirriformMorphology(
        { ...CIRRUS_ROW, shear: 0 },
        "no-shear",
        CIRRUS_ROW,
      ),
    /lag the generating head downwind/,
  );
});

test("MUTATION: removing the carve strength is rejected", () => {
  assert.throws(
    () =>
      assertCirriformMorphology(
        { ...CIRRUS_ROW, strength: 0 },
        "no-strength",
        CIRRUS_ROW,
      ),
    /must actually carve|longer along the wind/,
  );
});

test("MUTATION: the shader wiring cannot be silently unhooked", () => {
  // Every density evaluation must carry the factor; dropping it from ANY of the
  // three breaks the base-vs-full skip invariant or the shadow/visible match.
  const chainSites = [
    "legacyCloudDensity",
    "legacyCloudBaseDensity",
    "cloudMacroSampleAt",
  ];
  for (const name of chainSites) {
    const body = functionSource(cloudShaderSource, name);
    assert.match(
      body,
      /genusFibreFactor\((samplePos|morphologyCoordinate), heightFraction\)/,
      `${name} must apply the genus fibre factor`,
    );
    // MUTATION: strip the call and the same check must fail.
    assert.doesNotMatch(
      body.replace(/genusFibreFactor\([^)]*\) \*\n?\s*/g, ""),
      /genusFibreFactor\((samplePos|morphologyCoordinate), heightFraction\)/,
    );
  }

  // The anisotropic division IS the streak signature. Strip it and the contract
  // must fail rather than quietly rendering isotropic cells.
  const fibre = functionSource(cloudShaderSource, "genusFibreFactor");
  assert.match(fibre, /vec3<f32>\(along \/ aspect,/);
  assert.doesNotMatch(
    fibre.replace(/along \/ aspect/, "along"),
    /vec3<f32>\(along \/ aspect,/,
  );

  // Both erosion sites route the height weight through the genus helper.
  for (const name of ["legacyCloudDensity", "cloudDensityFromMacro"]) {
    const body = functionSource(cloudShaderSource, name);
    assert.match(body, /genusErosionHeightWeight\(heightFraction\)/, name);
  }
  // The historical literal must be GONE from those erosion expressions, or the
  // helper would be dead code sitting beside the old behaviour.
  assert.doesNotMatch(
    functionSource(cloudShaderSource, "cloudDensityFromMacro"),
    /cloud\.erosionStrength \* \(1\.0 - heightFraction\)/,
  );

  // The phase lobe reads the genus eccentricity.
  assert.match(
    functionSource(cloudShaderSource, "cloudPhase"),
    /hgPhase\(cosTheta, genusForwardG\(\)\)/,
  );
});

// ── 5. The table is internally consistent with its own erosion axis ───────

test("FIBROUS genera carry a fibre row and PUFFY genera carry the identity", () => {
  for (const genus of ALL_GENERA) {
    const profile = CloudTypeProfile.get(genus);
    const row = rowFor(genus);
    if (profile.erosion === FIBROUS) {
      assert.ok(row.strength > 0, `genus ${genus} is FIBROUS but carves 0`);
      assert.ok(row.strength <= 1, `genus ${genus} strength out of range`);
      assert.ok(
        row.anisotropy > 1,
        `genus ${genus} is FIBROUS but its domain is isotropic`,
      );
      assert.ok(row.shear >= 0, `genus ${genus} shear must be downwind`);
    } else {
      assert.equal(profile.erosion, PUFFY);
      assert.equal(row.strength, 0, `genus ${genus} is PUFFY but carves`);
      assert.equal(row.anisotropy, 1, `genus ${genus} is PUFFY but stretches`);
      assert.equal(row.shear, 0, `genus ${genus} is PUFFY but shears`);
    }
  }

  // The three ice genera are ordered the way the meteorology is: cirrus is the
  // detached, most strongly sheared mare's tail; cirrostratus is a continuous
  // fibrous VEIL (it has to stay a sheet — it is the halo genus); cirrocumulus
  // is a granular mackerel field, barely elongated at all.
  const cirrus = rowFor(CloudType.CIRRUS);
  const cirrostratus = rowFor(CloudType.CIRROSTRATUS);
  const cirrocumulus = rowFor(CloudType.CIRROCUMULUS);
  assert.ok(cirrus.anisotropy > cirrostratus.anisotropy);
  assert.ok(cirrostratus.anisotropy > cirrocumulus.anisotropy);
  assert.ok(cirrus.shear > cirrostratus.shear);
  assert.ok(cirrostratus.shear > cirrocumulus.shear);
  assert.ok(cirrostratus.strength < cirrus.strength, "a veil carves less");

  // The table is frozen alongside PROFILES so it cannot be mutated at runtime.
  assert.ok(Object.isFrozen(CloudTypeProfile.FIBRE_MORPHOLOGY));
  assert.match(
    profileSource,
    /Object\.freeze\(CloudTypeProfile\.FIBRE_MORPHOLOGY\);/,
  );
});

test("the carve never guts an already-thin ice deck", () => {
  // The regression this guards is the one the C13-01 tour actually found:
  // "CIRRUS renders ~nothing". The cirrus family is already thin twice over
  // (baseDensity 0.15 against cumulus 0.7, extinction 0.1 against 0.6), so a
  // deep fibre carve on top of that walks straight back into it. The streak
  // read comes entirely from `anisotropy` — the measured elongation below is
  // identical at every carve depth — so depth buys morphology nothing and costs
  // visibility directly. Every ice row must therefore retain more than half the
  // deck's mean mass.
  for (const genus of ALL_GENERA) {
    const row = rowFor(genus);
    if (row.strength === 0) {
      continue;
    }
    const bands = fibreHeightBands(row);
    const mean = bands.reduce((a, b) => a + b, 0) / bands.length;
    assert.ok(
      mean > 0.5,
      `genus ${genus} retains only ${mean.toFixed(3)} of its mean mass`,
    );
    // ...and no sample is driven to zero, so the carve thins filaments rather
    // than punching holes the march's `density > 0.001` floor then swallows.
    assert.ok(row.strength < 1, `genus ${genus} carve reaches zero density`);
  }

  // The claim that depth is free: elongation is invariant under carve depth.
  const shallow = fibreElongation({ ...CIRRUS_ROW, strength: 0.3 }).elongation;
  const deep = fibreElongation({ ...CIRRUS_ROW, strength: 0.9 }).elongation;
  assert.ok(
    Math.abs(shallow - deep) < 0.01,
    `elongation must not depend on carve depth (${shallow} vs ${deep})`,
  );
});

test("each FIBROUS genus renders a measurably different grain", () => {
  const measured = [
    CloudType.CIRRUS,
    CloudType.CIRROSTRATUS,
    CloudType.CIRROCUMULUS,
  ].map((genus) => fibreElongation(rowFor(genus)).elongation);
  for (let i = 1; i < measured.length; i++) {
    assert.ok(
      measured[i - 1] > measured[i] * 1.25,
      `ice genera must be separable by grain, got ${measured
        .map((m) => m.toFixed(2))
        .join(" > ")}`,
    );
  }
  // Cirrocumulus is ice but BILLOWY: near-round cells, not streaks.
  assert.ok(measured[2] < 3, `cirrocumulus elongation ${measured[2]}`);
});

// ── 6. Per-genus phase — ice scatters more forward than water ─────────────

test("the phase delta is exactly the profile difference for every genus", () => {
  const cumulusG = CloudTypeProfile.get(CloudType.CUMULUS).phaseG;
  for (const genus of ALL_GENERA) {
    assert.equal(
      genusPhaseDeltaFor(genus),
      CloudTypeProfile.get(genus).phaseG - cumulusG,
    );
  }
});

test("ice genera get a more forward-peaked lobe than water genera, bounded", () => {
  const forwardFor = (genus) =>
    genusForwardG(DEFAULT_PHASE_G1, genusPhaseDeltaFor(genus));
  const iceGenera = ALL_GENERA.filter(
    (genus) => CloudTypeProfile.get(genus).erosion === FIBROUS,
  );
  const waterGenera = ALL_GENERA.filter(
    (genus) => CloudTypeProfile.get(genus).erosion === PUFFY,
  );
  const minIce = Math.min(...iceGenera.map(forwardFor));
  const maxWater = Math.max(...waterGenera.map(forwardFor));
  assert.ok(
    minIce > maxWater,
    `every ice genus must out-forward every water genus ` +
      `(ice min ${minIce}, water max ${maxWater})`,
  );

  // The clamp keeps the HG denominator away from its singularity at g = 1.
  for (const genus of ALL_GENERA) {
    const g = forwardFor(genus);
    assert.ok(g <= GENUS_PHASE_G_LIMIT, `genus ${genus} forward g ${g}`);
    assert.ok(g > -1 && g < 1);
  }
  assert.equal(genusForwardG(DEFAULT_PHASE_G1, 5.0), GENUS_PHASE_G_LIMIT);
  assert.equal(genusForwardG(DEFAULT_PHASE_G1, -5.0), -GENUS_PHASE_G_LIMIT);
});

test("the erosion height weight blends toward uniform with the fibre strength", () => {
  // Cumuliform erosion is base-weighted because a convective water cloud has a
  // ragged bottom and a crisp top; ice has no such buoyant asymmetry.
  for (const h of [0.1, 0.4, 0.75]) {
    const cumuliform = genusErosionHeightWeight(h, 0);
    const fullyFibrous = genusErosionHeightWeight(h, 1);
    const partial = genusErosionHeightWeight(h, 0.55);
    assert.equal(cumuliform, Math.fround(1 - h));
    assert.equal(fullyFibrous, 1);
    assert.ok(partial > cumuliform && partial < fullyFibrous);
  }
  // At the deck base the two agree exactly — the difference is purely aloft.
  assert.equal(genusErosionHeightWeight(0, 0), genusErosionHeightWeight(0, 1));
});

// ── 7. The shader still compiles ──────────────────────────────────────────

test("naga validates the cloud shader with the per-genus morphology", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() =>
    naga.validate_wgsl(`${domainSource}\n${defaultVariant(cloudShaderSource)}`),
  );
});
