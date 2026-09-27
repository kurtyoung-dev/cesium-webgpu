// radial-banding-family-mutants.spec.mjs — inertness mutants of the ring-family estimator. Pure Node: no browser, no GPU.
//
// @purpose Makes one construct of the ring-family estimator unreachable at a time (a data: copy of its module graph, never the file on disk) and asserts that the synthetic or banked case in radial-banding-family.spec.mjs that guards it comes back wrong.
// @status ACTIVE
//
// A mutant that leaves its case green means the construct is not what the
// case certifies. Each mutant names the case it guards in its failure text.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CENTRE_AT_SEARCH_BOUNDARY,
  ringFamily,
  ringFamilyFromProfile,
  ringFamilyProfile,
} from "./lib/metrics/radial-banding.mjs";
import {
  DENSE,
  FAMILY_DISC,
  FAMILY_WINDOW,
  M0,
  PLANTED_RMS,
  distance,
  familyResult,
  frame,
  measured,
  rigged,
  withRings,
  withinPercent,
} from "./lib/radial-banding-family-cases.mjs";
import RIG from "./rigs/orbital-fulldisc-6608km.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const METRICS = path.join(HERE, "lib", "metrics");

/**
 * The metric's module graph with one file mutated. Every module that imports
 * the mutated file (directly or through another) is loaded as a `data:` copy
 * whose sibling imports point at the mutated copies; every other sibling
 * resolves to its file on disk. The mutation is asserted to have applied.
 *
 * @param {string} file Module under `lib/metrics/` to mutate.
 * @param {string} from Source text that must occur exactly once.
 * @param {string} to Its replacement.
 * @returns {Promise<object>} `radial-banding.mjs` over the mutated graph.
 */
async function importMutated(file, from, to) {
  const sources = new Map();
  const read = (name) => {
    if (!sources.has(name)) {
      sources.set(
        name,
        readFileSync(path.join(METRICS, name), "utf8").replaceAll("\r\n", "\n"),
      );
    }
    return sources.get(name);
  };
  const siblingsOf = (name) =>
    [...read(name).matchAll(/from "\.\/([\w-]+\.mjs)";/g)].map(
      (match) => match[1],
    );
  const reaches = (name) => name === file || siblingsOf(name).some(reaches);
  const urls = new Map();
  const build = (name) => {
    if (!urls.has(name)) {
      let source = read(name);
      for (const sibling of siblingsOf(name)) {
        const target = reaches(sibling)
          ? build(sibling)
          : pathToFileURL(path.join(METRICS, sibling)).href;
        source = source.replace(
          `from "./${sibling}";`,
          `from ${JSON.stringify(target)};`,
        );
      }
      if (name === file) {
        assert.equal(source.split(from).length - 1, 1, `${file}: ${from}`);
        source = source.replace(from, to);
      }
      urls.set(
        name,
        `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`,
      );
    }
    return urls.get(name);
  };
  const mutant = await import(build("radial-banding.mjs"));
  assert.notEqual(
    mutant.ringFamily,
    ringFamily,
    "the mutant is the real module",
  );
  return mutant;
}

const SPECTRUM = "radial-banding-family-spectrum.mjs";
const MAIN = "radial-banding-family.mjs";
const CENTRE = "radial-banding-family-centre.mjs";

/** Run a mutant over one synthetic frame. */
function onField(mutant, key) {
  return mutant.ringFamily(frame(key), FAMILY_DISC, FAMILY_WINDOW);
}

test("M2. MUTATION control: an unreachable detrend turns the dense case's amplitude and its control RED", async () => {
  const mutant = await importMutated(
    SPECTRUM,
    "  if (half > 0) {",
    "  if (false && half > 0) {",
  );
  const real = familyResult("dense", "quadratic");
  assert.ok(Math.abs(real.bandPassRms / PLANTED_RMS - 1) < 0.1);
  const inert = onField(mutant, "dense:quadratic");
  assert.ok(
    inert.bandPassRms > 2 * PLANTED_RMS,
    `the inert detrend read ${inert.bandPassRms}, which F1's amplitude clause would have passed`,
  );
  assert.equal(familyResult("dense", null).verdict, "ABSENT");
  assert.notEqual(
    onField(mutant, "dense:null").verdict,
    "ABSENT",
    "the inert detrend's control still reads ABSENT, so F3 would not have caught it",
  );
});

test("M3. MUTATION control: an unreachable centre refinement loses the offset family", async () => {
  const mutant = await importMutated(
    MAIN,
    "  if (settings.refineCentre) {",
    "  if (false && settings.refineCentre) {",
  );
  const real = familyResult("dense", "quadratic");
  assert.ok(distance(real.centre) < 1);
  const inert = onField(mutant, "dense:quadratic");
  assert.ok(
    distance(inert.centre) > 30,
    `the inert refinement measured about a point ${distance(inert.centre).toFixed(2)} px from the family`,
  );
  assert.equal(
    inert.detected,
    false,
    "the inert refinement still found the family",
  );
});

/** G9's frame reduced about its found centre with the octant frame only. */
function sectorOctantsOnly() {
  const { centre } = measured("sector");
  const reduction = ringFamilyProfile(
    frame("sector"),
    { x: centre.x, y: centre.y },
    FAMILY_DISC,
    FAMILY_WINDOW,
  );
  for (const key of [
    "sectorSums",
    "sectorCounts",
    "fineSectorSums",
    "fineSectorCounts",
  ]) {
    delete reduction[key];
  }
  return reduction;
}

test("M4. MUTATION control: an unreachable octant concentricity test calls one-sided rings a family where only octants were kept", async () => {
  const mutant = await importMutated(
    MAIN,
    "(ring === null || ring.concentric)",
    "(true || ring === null || ring.concentric)",
  );
  const reduction = sectorOctantsOnly();
  assert.equal(
    ringFamilyFromProfile(reduction, FAMILY_DISC, FAMILY_WINDOW).detected,
    false,
  );
  assert.equal(
    mutant.ringFamilyFromProfile(reduction, FAMILY_DISC, FAMILY_WINDOW)
      .detected,
    true,
    "G9 would not have caught it",
  );
});

test("M17. MUTATION control: an unreachable sixteen-sector test calls a plaid a family and refuses a checkerboard", async () => {
  const mutant = await importMutated(
    MAIN,
    "(sixteenths === null || sixteenths.concentric)",
    "(true || sixteenths === null || sixteenths.concentric)",
  );
  assert.equal(measured("plaid 24 0.2").familyCount, 0);
  assert.equal(measured("checkerboard 0.3").refusal, null);
  const plaid = onField(mutant, "plaid 24 0.2");
  assert.ok(plaid.familyCount > 0, "G17 would not have caught the plaid");
  assert.equal(plaid.verdict, "PRESENT");
  assert.notEqual(
    onField(mutant, "checkerboard 0.3").refusal,
    null,
    "G17 would not have caught the checkerboard",
  );
});

test("M18. MUTATION control: an unreachable anti-phase veto calls a hexagonal lattice a family", async () => {
  const mutant = await importMutated(
    SPECTRUM,
    "    concentric: inPhase >= required && opposed <= allowed,",
    "    concentric: inPhase >= required && (true || opposed <= allowed),",
  );
  assert.equal(measured("hexagonal").familyCount, 0);
  assert.ok(
    onField(mutant, "hexagonal").familyCount > 0,
    "G17 would not have caught it",
  );
});

test("M19. MUTATION control: an unreachable boundary on the further search reports a family pinned at its edge", async () => {
  const mutant = await importMutated(
    MAIN,
    "  const families = at.boundary === null ? found : [];",
    "  const families = true || at.boundary === null ? found : [];",
  );
  assert.equal(measured("past-second").familyCount, 1);
  assert.equal(
    onField(mutant, "past-second").familyCount,
    2,
    "G18 would not have caught it",
  );
});

test("M5. MUTATION control: an unreachable amplitude floor calls a faint ripple a family", async () => {
  const mutant = await importMutated(
    MAIN,
    "      line.lineRms >= RING_AMPLITUDE_CLASSES.absent;",
    "      (true || line.lineRms >= RING_AMPLITUDE_CLASSES.absent);",
  );
  assert.equal(measured("faint").detected, false);
  assert.equal(
    onField(mutant, "faint").detected,
    true,
    "G8 would not have caught it",
  );
});

test("M6. MUTATION control: letting a refusal outrank the visible family turns G5's verdict", async () => {
  const mutant = await importMutated(
    MAIN,
    "  if (familyCount > 0) {",
    "  if (false && familyCount > 0) {",
  );
  assert.equal(measured("beside-2").verdict, "PRESENT");
  assert.equal(
    onField(mutant, "beside-2").verdict,
    "REFUSED",
    "G5 would not have caught it",
  );
});

test("M7. MUTATION control: leaving a low-duty family's harmonics in its floor loses it", async () => {
  const mutant = await importMutated(
    SPECTRUM,
    "      overtonesOf(joint[index]),",
    "      ...(false ? [overtonesOf(joint[index])] : []),",
  );
  assert.equal(measured("duty-36").detected, true);
  assert.equal(
    onField(mutant, "duty-36").detected,
    false,
    "G6 would not have caught it",
  );
});

test("M8. MUTATION control: taking one line per band finds one of two families about a centre", async () => {
  const mutant = await importMutated(
    SPECTRUM,
    "  for (let n = 0; n < MAX_LINES; n++) {",
    "  for (let n = 0; n < (false ? MAX_LINES : 1); n++) {",
  );
  assert.equal(measured("same-centre").familyCount, 2);
  assert.ok(
    onField(mutant, "same-centre").familyCount < 2,
    "G3 would not have caught it",
  );
});

test("M9. MUTATION control: no further centre finds one of two families about two centres", async () => {
  const mutant = await importMutated(
    MAIN,
    "  if (first.detected) {",
    "  if (false && first.detected) {",
  );
  assert.equal(measured("two-centres").familyCount, 2);
  assert.equal(
    onField(mutant, "two-centres").familyCount,
    1,
    "G4 would not have caught it",
  );
});

test("M10. MUTATION control: an unreachable alias test reports the fold of a finer family as visible", async () => {
  const mutant = await importMutated(
    MAIN,
    "      fineSeries !== null &&\n      line.owner",
    "      false &&\n      fineSeries !== null &&\n      line.owner",
  );
  assert.equal(measured("alias").familyCount, 0);
  assert.ok(
    onField(mutant, "alias").familyCount > 0,
    "G11 would not have caught it",
  );
  assert.ok(
    onField(mutant, "past-fastest").familyCount > 0,
    "G12 would not have caught it",
  );
});

test("M11. MUTATION control: an unnamed search edge lets a family outside the search go unflagged", async () => {
  const mutant = await importMutated(
    CENTRE,
    "  const atEdge =\n",
    "  const atEdge = false &&\n",
  );
  assert.equal(measured("outside").centre.boundary, CENTRE_AT_SEARCH_BOUNDARY);
  assert.equal(
    onField(mutant, "outside").centre.boundary,
    null,
    "G10 would not have caught it",
  );
});

test("M12. MUTATION control: an unreachable interior test refuses at the edge of a search", async () => {
  const mutant = await importMutated(
    MAIN,
    "      line.interior &&\n",
    "      (true || line.interior) &&\n",
  );
  assert.equal(rigged("past-reach-150").refusal, null);
  assert.notEqual(
    rigged("past-reach-150", mutant).refusal,
    null,
    "G14 would not have caught it",
  );
});

test("M13. MUTATION control: an unreachable overtone guard refuses a low-duty family through its harmonics", async () => {
  const mutant = await importMutated(
    MAIN,
    "        !other.isFamily &&\n",
    "        false &&\n        !other.isFamily &&\n",
  );
  assert.equal(rigged("pulse-130").refusal, null);
  assert.notEqual(
    rigged("pulse-130", mutant).refusal,
    null,
    "G15 would not have caught it",
  );
});

test("M14. MUTATION control: not removing the visible family from a neighbour's series hides M0's neighbour", async () => {
  const mutant = await importMutated(
    MAIN,
    "        : sideAbout(profile, settings, key, here, visible));",
    "        : sideAbout(profile, settings, key, here, false ? visible : []));",
  );
  const planted = withRings(M0.profile, 70, 0.03);
  assert.notEqual(
    ringFamilyFromProfile(planted, RIG.disc, DENSE.options).refusal,
    null,
  );
  assert.equal(
    mutant.ringFamilyFromProfile(planted, RIG.disc, DENSE.options).refusal,
    null,
    "G13 would not have caught it",
  );
});

test("M15. MUTATION control: a law fitted across radii the detrend flattened misreads the chirp", async () => {
  const mutant = await importMutated(
    SPECTRUM,
    "  if (!(to > from)) {\n    return { ...band };\n  }",
    "  if (true || !(to > from)) {\n    return { ...band };\n  }",
  );
  const inert = rigged("chirp-6800", mutant).family;
  assert.ok(
    !withinPercent(inert.periodPx.atRhoMin, 6800 / DENSE.options.rhoMinPx, 2),
    `the law fitted across the flattened radii still reads ${inert.periodPx.atRhoMin}`,
  );
});

test("M16. MUTATION control: judging a law by the amplitude it fits, not the variance it explains, misreads a slow family", async () => {
  const mutant = await importMutated(
    SPECTRUM,
    "  return fit.explained;",
    "  return fit.lineRms;",
  );
  const period = rigged("slow-90", mutant).refusal?.periodAtMidPx ?? null;
  assert.ok(
    period === null || !withinPercent(period, 90, 2),
    `the amplitude objective still refused at ${period}`,
  );
});
