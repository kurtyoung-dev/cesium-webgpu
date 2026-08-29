// @purpose EAN-04: prove the earth-at-night toolbar's collapsed-by-default
// state is a structural fact the browser DOM reads (the `<details>` element's
// `open` attribute), not merely a claim in a comment. Static text analysis of
// the shipped index.html -- no browser, no layout measurement (the
// DOM-bounding-box-vs-sky-region acceptance clause is measured later, in the
// tranche-A browser run).
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "..", "..");
const INDEX_HTML_PATH = path.join(
  REPOSITORY_ROOT,
  "packages",
  "sandcastle",
  "gallery",
  "earth-at-night",
  "index.html",
);

const SOURCE = fs.readFileSync(INDEX_HTML_PATH, "utf8").replace(/\r\n/g, "\n");

/**
 * Extracts the opening `<details ...>` tag and its full element body (up to
 * the matching `</details>`), assuming (as here) there is exactly one
 * `<details>` element in the document -- verified below rather than assumed.
 */
function extractDetailsElement(html) {
  const openTagMatch = html.match(/<details\b[^>]*>/);
  assert.ok(openTagMatch, "expected a <details> element in index.html");
  const openTag = openTagMatch[0];
  const bodyStart = openTagMatch.index + openTag.length;
  const closeIndex = html.indexOf("</details>", bodyStart);
  assert.ok(closeIndex !== -1, "expected a matching </details> close tag");
  const body = html.slice(bodyStart, closeIndex);
  return { openTag, body };
}

test("EAN-04: exactly one <details> element wraps the toolbar", () => {
  const count = (SOURCE.match(/<details\b/g) ?? []).length;
  assert.equal(
    count,
    1,
    `expected exactly one <details> element, found ${count}`,
  );
});

test("EAN-04: the <details> element has no `open` attribute -- collapsed is the initial DOM state", () => {
  const { openTag } = extractDetailsElement(SOURCE);

  // The `open` boolean attribute is what the browser's DOM actually reads to
  // decide whether a <details> element starts expanded (HTML Standard
  // section 4.11.1). Absence of the attribute -- not any comment or class
  // name -- is what makes the element collapsed on first paint.
  assert.doesNotMatch(
    openTag,
    /\bopen\b/i,
    `<details> tag must not carry the "open" attribute: ${openTag}`,
  );
});

test("EAN-04: the collapsed element is the one containing all five controls", () => {
  const { body } = extractDetailsElement(SOURCE);
  const requiredBindings = [
    "value: nightImagery",
    "value: nightDarkness",
    "checked: dynamicLighting",
    "checked: enableNightLights",
    "value: nightIntensity",
  ];
  for (const binding of requiredBindings) {
    assert.ok(
      body.includes(binding),
      `<details> body must contain the "${binding}" control binding`,
    );
  }
});

test("EAN-04 mutant: adding the open attribute must flip the collapsed-state check to red", () => {
  const { openTag } = extractDetailsElement(SOURCE);
  const mutatedTag = openTag.replace("<details", "<details open");
  assert.notEqual(mutatedTag, openTag, "mutation must actually change the tag");

  let sawFailure = false;
  try {
    assert.doesNotMatch(mutatedTag, /\bopen\b/i);
  } catch {
    sawFailure = true;
  }
  assert.equal(
    sawFailure,
    true,
    "the collapsed-state assertion must fail against a mutant carrying the open attribute",
  );
});
