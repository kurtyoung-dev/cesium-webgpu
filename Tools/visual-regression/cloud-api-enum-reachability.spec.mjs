/**
 * C13-N34 — the public cloud API says what the renderer actually does.
 *
 * Five API/JSDoc defects shared one shape: a documented value, type or wire
 * format that no consumer ever honoured. A caller sets it, nothing happens, and
 * nothing fails. This spec pins the agreement between the public declaration
 * and the consuming code so that class of drift fails a test instead of a user.
 *
 * The contracts asserted here are properties of the SOURCE, extracted, not
 * properties of any particular edit:
 *
 *   1. For every string-valued dial on `CloudVolumetrics`, the set of values its
 *      JSDoc names and the set of literals its consumers actually test are the
 *      SAME set. A documented-but-untested value is a lie to the caller; a
 *      tested-but-undocumented value is a hidden feature. The one exemption is
 *      a value the JSDoc explicitly declares RESERVED and hands to a named
 *      owning row — and that exemption is closed at both ends: a reserved value
 *      with no row id fails, and a reserved value that HAS become reachable
 *      fails too, so the marker cannot be left behind once the row lands.
 *   2. The dial's documented `@type` agrees with every structural declaration of
 *      the same field under `Renderer/WebGPU`.
 *   3. The dial list is derived from the source, not hard-coded here, so a new
 *      string dial added tomorrow is covered tomorrow.
 *   4. Every field of the exotic species / feature / special families that the
 *      cloud uniform packer reads has a public declaration on `CloudVolumetrics`.
 *   5. `scene.godRayCloudAware` resolves against a declaration rather than an
 *      `as unknown as {…}` expando, and the read still exists.
 *   6. `MetarWeatherSource`'s module docstring describes the wire format
 *      `_loadStations` actually parses.
 *
 * Why source text and not imports: these modules are engine ES modules that
 * reach `GraphicsContext`, WGSL string modules and a `GPUDevice`; none of them
 * load under plain `node --test` without a build, and the behaviour at stake
 * (what a shipped JSDoc claims) is a property of the text either way.
 *
 * Mutant hook: set `CLOUD_API_SOURCE_ROOT` to a copy of the tree to run these
 * contracts against mutated sources. That is how each fix is shown to be
 * load-bearing — revert one fix in the copy and the matching test goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CLOUD_API_SOURCE_ROOT
  ? path.resolve(process.env.CLOUD_API_SOURCE_ROOT)
  : path.resolve(HERE, "..", "..");

const API_FILE = path.join(
  ROOT,
  "packages/engine/Source/Scene/CloudVolumetrics.js",
);
const WEBGPU_DIR = path.join(ROOT, "packages/engine/Source/Renderer/WebGPU");
const TYPES_FILE = path.join(WEBGPU_DIR, "cesium-js-types.d.ts");
const CHAIN_FILE = path.join(
  WEBGPU_DIR,
  "WebGPUSceneRendererPostFrustumChain.ts",
);
const METAR_FILE = path.join(
  ROOT,
  "packages/engine/Source/Scene/Weather/MetarWeatherSource.ts",
);

/**
 * The ledger is deliberately NOT redirected by `CLOUD_API_SOURCE_ROOT`: mutants
 * mutate engine source, never the campaign record, and a reserved value's
 * owning row has to be checkable against the real ledger for the marker to mean
 * anything.
 */
const LEDGER_DIR = path.resolve(HERE, "..", "..", "migration_doc");

/**
 * A campaign row id: two or more all-caps/digit segments joined by hyphens
 * (`C13-N12`, `DP-H41`, `NEW-WEBGPU-…`). Deliberately strict about case so
 * ordinary hyphenated prose ("WebGPU-only", "sky-lut") cannot pass as one.
 */
const ROW_ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g;

/**
 * A derived carrier (`const n = specialName.toLowerCase()`) stays valid for this
 * many lines. The packer reuses the name `n` for the species, feature and
 * special blocks in turn, ~35 lines apart, so an unbounded carrier would pool
 * all three value sets together.
 */
const DERIVED_CARRIER_LINES = 20;

/**
 * Carriers that cross a module boundary, where the value reaches its comparison
 * through a parameter rather than a field access. Each entry is the identifier
 * the receiving module compares, with the hop that justifies it.
 */
const EXTRA_CARRIERS = {
  // WebGPUProceduralCloudRenderer packs the dial into `{ preset: … }`
  // (CloudQualityInputs); resolveTier / resolveCloudQuality compare `preset`.
  cloudVolumetricQuality: ["preset"],
};

const read = (file) => fs.readFileSync(file, "utf8");

function wordRe(name) {
  return new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`);
}

/**
 * Blank out comments while preserving line numbering, so a value named only in
 * prose never counts as a value the code tests. Tracks string state so a `//`
 * inside a literal is not read as a comment.
 */
function codeLines(text) {
  const out = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = "";
    let i = 0;
    let quote = null;
    while (i < raw.length) {
      const c = raw[i];
      const n = raw[i + 1];
      if (inBlock) {
        if (c === "*" && n === "/") {
          inBlock = false;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (quote !== null) {
        line += c;
        if (c === "\\") {
          line += n ?? "";
          i += 2;
          continue;
        }
        if (c === quote) {
          quote = null;
        }
        i += 1;
        continue;
      }
      if (c === "/" && n === "*") {
        inBlock = true;
        i += 2;
        continue;
      }
      if (c === "/" && n === "/") {
        break;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        line += c;
        i += 1;
        continue;
      }
      line += c;
      i += 1;
    }
    out.push(line);
  }
  return out;
}

/**
 * String literals on one code line, minus `typeof x === "string"` guards — a
 * typeof comparison names a JS type tag, never an API value.
 */
function literalsOn(line) {
  const cleaned = line.replace(
    /typeof\s+[\w$.?[\]]+\s*[!=]==\s*(?:"[^"]*"|'[^']*')/g,
    " ",
  );
  const out = [];
  for (const m of cleaned.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'/g)) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

function consumerFiles() {
  const files = [API_FILE];
  for (const entry of fs.readdirSync(WEBGPU_DIR).sort()) {
    if (/\.(ts|js)$/.test(entry)) {
      files.push(path.join(WEBGPU_DIR, entry));
    }
  }
  return files;
}

/**
 * Every string literal the code compares against (or defaults) a dial, found by
 * following the dial's carriers: the property name itself, anything assigned
 * from a carrier, and the declared cross-module carriers. Returns value → first
 * `file:line` that supplies it, so a failure names its own evidence.
 */
function consumedValues(prop) {
  const found = new Map();
  const propRe = wordRe(prop);
  for (const file of consumerFiles()) {
    const text = read(file);
    if (!propRe.test(text)) {
      continue;
    }
    const lines = codeLines(text);
    const carriers = new Map([[prop, Infinity]]);
    for (const extra of EXTRA_CARRIERS[prop] ?? []) {
      carriers.set(extra, Infinity);
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") {
        continue;
      }
      let carried = false;
      for (const [name, until] of carriers) {
        if (i <= until && wordRe(name).test(line)) {
          carried = true;
          break;
        }
      }
      if (!carried) {
        continue;
      }
      for (const literal of literalsOn(line)) {
        if (!found.has(literal)) {
          found.set(literal, `${path.basename(file)}:${i + 1}`);
        }
      }
      const assigned =
        line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/) ??
        line.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
      if (assigned) {
        const prev = carriers.get(assigned[1]) ?? -1;
        carriers.set(assigned[1], Math.max(prev, i + DERIVED_CARRIER_LINES));
      }
    }
  }
  return found;
}

/** The JSDoc block immediately above `this.<prop> = …` in CloudVolumetrics.js. */
function docBlockFor(apiLines, prop) {
  const assignRe = new RegExp(`^\\s*this\\.${prop}\\s*=`);
  const at = apiLines.findIndex((l) => assignRe.test(l));
  if (at < 0) {
    return null;
  }
  let end = at - 1;
  while (end >= 0 && !apiLines[end].includes("*/")) {
    end -= 1;
  }
  if (end < 0) {
    return null;
  }
  let start = end;
  while (start >= 0 && !apiLines[start].includes("/**")) {
    start -= 1;
  }
  if (start < 0) {
    return null;
  }
  return { line: at + 1, text: apiLines.slice(start, end + 1).join("\n") };
}

/**
 * The public dials: every `this.x = options.x` on CloudVolumetrics whose JSDoc
 * declares a string type AND names at least one `<code>"value"</code>. Derived
 * from the source so a dial added later is covered without editing this list.
 */
function stringDials() {
  const apiLines = read(API_FILE).split(/\r?\n/);
  const dials = [];
  for (const line of apiLines) {
    const m = line.match(/^\s*this\.([A-Za-z_$][\w$]*)\s*=\s*options\./);
    if (!m) {
      continue;
    }
    const block = docBlockFor(apiLines, m[1]);
    if (!block) {
      continue;
    }
    const type = (block.text.match(/@type\s*\{([^}]*)\}/) ?? [])[1] ?? "";
    const documented = [...block.text.matchAll(/<code>"([^"]*)"<\/code>/g)].map(
      (v) => v[1],
    );
    if (documented.length === 0) {
      continue;
    }
    dials.push({
      prop: m[1],
      type,
      documented,
      line: block.line,
      doc: block.text,
    });
  }
  return dials;
}

/** JSDoc block text as flat sentences, comment furniture removed. */
function docSentences(blockText) {
  const flat = blockText
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\/\*\*|\*\/|\*)/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ");
  return flat.split(/(?<=\.)\s+/);
}

/**
 * Values the JSDoc declares RESERVED — documented, accepted, not yet honoured —
 * mapped to the row ids named in the same sentence. An empty row list is kept
 * (not dropped) so the caller can fail it as an unowned reservation rather than
 * as a plain unreachable value.
 */
function reservedValues(blockText) {
  const out = new Map();
  for (const sentence of docSentences(blockText)) {
    if (!/\breserved\b/i.test(sentence)) {
      continue;
    }
    const rows = [...sentence.matchAll(ROW_ID)].map((m) => m[0]);
    for (const m of sentence.matchAll(/<code>"([^"]*)"<\/code>/g)) {
      out.set(m[1], rows);
    }
  }
  return out;
}

let ledgerCache = null;
/** Whether a row id appears in the campaign record at all. */
function ledgerMentions(rowId) {
  if (ledgerCache === null) {
    ledgerCache = "";
    if (fs.existsSync(LEDGER_DIR)) {
      for (const entry of fs.readdirSync(LEDGER_DIR)) {
        if (entry.endsWith(".md")) {
          ledgerCache += read(path.join(LEDGER_DIR, entry));
        }
      }
    }
  }
  return ledgerCache.includes(rowId);
}

const show = (set) => JSON.stringify([...set].sort());

test("every documented cloud-dial value is one a consumer tests, and every tested value is documented", () => {
  const dials = stringDials();
  assert.ok(
    dials.length >= 7,
    `expected the cloud dials to still be documented with <code>"…"</code> values; found ${dials.length}`,
  );
  const problems = [];
  for (const dial of dials) {
    const consumed = consumedValues(dial.prop);
    const documented = new Set(dial.documented);
    const tested = new Set(consumed.keys());
    const reserved = reservedValues(dial.doc);
    for (const value of tested) {
      if (!documented.has(value)) {
        problems.push(
          `${dial.prop}: "${value}" is honoured at ${consumed.get(value)} but is not documented at CloudVolumetrics.js:${dial.line}`,
        );
      }
    }
    for (const value of documented) {
      if (tested.has(value)) {
        if (reserved.has(value)) {
          problems.push(
            `${dial.prop}: "${value}" is still marked reserved at CloudVolumetrics.js:${dial.line}, but a consumer now tests it at ${consumed.get(value)} — the owning row landed; drop the reservation`,
          );
        }
        continue;
      }
      const rows = reserved.get(value);
      if (rows === undefined) {
        problems.push(
          `${dial.prop}: "${value}" is documented at CloudVolumetrics.js:${dial.line} but no consumer ever tests or defaults it — setting it does nothing. Correct the doc, or declare it reserved in the same JSDoc and name the row that owns honouring it.`,
        );
        continue;
      }
      if (rows.length === 0) {
        problems.push(
          `${dial.prop}: "${value}" is marked reserved at CloudVolumetrics.js:${dial.line} but names no owning row id — a reservation with no owner is just an unreachable value`,
        );
        continue;
      }
      for (const row of rows) {
        if (!ledgerMentions(row)) {
          problems.push(
            `${dial.prop}: "${value}" is reserved for ${row}, which appears nowhere in migration_doc/*.md`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    problems,
    [],
    `cloud API values disagree with the code:\n  ${problems.join("\n  ")}`,
  );
});

test("the reserved-value exemption is live, and today it has exactly one member", () => {
  // Tight membership, deliberately. The exemption above is the only way a
  // documented value may be unreachable, so it must not quietly grow: every
  // reservation in the tree is listed here, with the row that owns honouring it.
  //
  // When C13-N12 lands the S4 rung, "ultra" becomes reachable and this test
  // fails — as does the stale-reservation arm of the sweep. That is the signal
  // to delete the reservation from the JSDoc, not to relax this assertion.
  const found = [];
  for (const dial of stringDials()) {
    for (const [value, rows] of reservedValues(dial.doc)) {
      found.push(`${dial.prop}:"${value}" -> ${rows.join(",")}`);
      for (const row of rows) {
        assert.ok(
          ledgerMentions(row),
          `${dial.prop}:"${value}" reserves against ${row}, which is in no migration_doc/*.md`,
        );
      }
    }
  }
  assert.deepEqual(found, [
    'cloudVolumetricQuality:"ultra" -> C13-N12,C13-N41',
  ]);
});

test("each cloud dial's documented @type agrees with every structural declaration of the field", () => {
  const dials = stringDials();
  const problems = [];
  for (const dial of dials) {
    if (!/\bstring\b/.test(dial.type)) {
      problems.push(
        `${dial.prop}: @type is {${dial.type}} at CloudVolumetrics.js:${dial.line}, but its documented values are string literals`,
      );
    }
    const declRe = new RegExp(`^\\s*${dial.prop}\\?\\s*:\\s*([^;]+);`, "m");
    for (const file of consumerFiles()) {
      if (file === API_FILE) {
        continue;
      }
      const m = read(file).match(declRe);
      if (m && !/\bstring\b/.test(m[1])) {
        problems.push(
          `${dial.prop}: declared as ${m[1].trim()} in ${path.basename(file)} but documented as {${dial.type}}`,
        );
      }
    }
  }
  assert.deepEqual(
    problems,
    [],
    `cloud API types disagree:\n  ${problems.join("\n  ")}`,
  );
});

test("cloudNoiseMorphology is a string dial in all three of its declarations", () => {
  // The one dial whose @type disagreed with every consumer. Named explicitly as
  // a regression anchor for C13-N34 D3; the sweep above is what generalizes it.
  const dial = stringDials().find((d) => d.prop === "cloudNoiseMorphology");
  assert.ok(dial, "cloudNoiseMorphology is no longer a documented string dial");
  assert.match(dial.type, /\bstring\b/);
  assert.match(read(TYPES_FILE), /cloudNoiseMorphology\?\s*:\s*string/);
  assert.deepEqual(
    [...consumedValues("cloudNoiseMorphology").keys()],
    ["perlin-worley"],
  );
});

test("every exotic species / feature / special field the cloud packer reads is declared on the public config", () => {
  // The packer reaches these through `config as unknown as {…}` casts, which is
  // deliberate (the config carrier stays decoupled). What is NOT deliberate is a
  // field the packer reads having no public home at all: that is a dial nobody
  // outside the renderer can discover. cloudSpecialShadeMode was one.
  const renderer = read(
    path.join(WEBGPU_DIR, "WebGPUProceduralCloudRenderer.ts"),
  );
  const api = read(API_FILE);
  const wanted = new Set();
  for (const m of renderer.matchAll(
    /^\s*(cloud(?:Species|Feature|Special)[\w$]*)\?\s*:/gm,
  )) {
    wanted.add(m[1]);
  }
  assert.ok(
    wanted.size >= 15,
    `expected the exotic cast blocks to still be present; found ${wanted.size} fields`,
  );
  const undeclared = [...wanted].filter(
    (name) => !new RegExp(`^\\s*this\\.${name}\\s*=`, "m").test(api),
  );
  assert.deepEqual(
    undeclared,
    [],
    `read by the cloud uniform packer but undeclared on CloudVolumetrics: ${show(undeclared)}`,
  );
});

test("scene.godRayCloudAware is read through a declaration, not an untyped expando", () => {
  // Why no runtime assertion: the read lives in the WebGPU post-frustum chain,
  // which needs a GPUDevice, a frame and a post-process pipeline to reach. What
  // IS checkable without a browser is the property the defect was about — that
  // the flag has a declared home, so the read type-checks instead of being
  // asserted into existence at the call site. Behaviour is unchanged either way:
  // unset, the expression is false.
  //
  // The name is load-bearing: FEATURE_INVENTORY §B advertises
  // `scene.godRayCloudAware` to users as a SHIPPED opt-in, so the read and the
  // declaration must both spell it that way.
  const chain = read(CHAIN_FILE);
  assert.match(
    chain,
    /config\.scene\.godRayCloudAware === true/,
    "the god-ray cloud-aware read was removed; it is a SHIPPED, inventoried opt-in whose producer is the application",
  );
  assert.doesNotMatch(
    chain,
    /as unknown as \{[^}]*godRayCloudAware/,
    "godRayCloudAware is being cast into existence again instead of declared",
  );
  const types = read(TYPES_FILE);
  const sceneStart = types.indexOf("interface CesiumScene {");
  assert.ok(sceneStart >= 0, "interface CesiumScene not found");
  const sceneEnd = types.indexOf("\n}", sceneStart);
  const body = types.slice(sceneStart, sceneEnd);
  assert.match(
    body,
    /godRayCloudAware\?\s*:\s*boolean/,
    "godRayCloudAware is not declared on CesiumScene, so the chain's read resolves against nothing",
  );
});

test("MetarWeatherSource documents the wire format _loadStations actually parses", () => {
  const text = read(METAR_FILE);
  const docEnd = text.indexOf("@module Scene/Weather/MetarWeatherSource");
  assert.ok(docEnd > 0, "module docstring not found");
  const docstring = text.slice(0, docEnd);

  const loader = text.slice(
    text.indexOf("_loadStations"),
    text.indexOf("_rasterize"),
  );
  const parsesJson = /res\.json\(\)/.test(loader);
  const readsStations = /data\.stations/.test(loader);
  assert.ok(
    parsesJson && readsStations,
    "the loader no longer parses JSON `{stations:[…]}`; re-derive this contract against what it does parse",
  );

  assert.match(
    docstring,
    /stations/,
    "the loader reads `data.stations` but the docstring never names that shape",
  );
  assert.match(
    docstring,
    /JSON/,
    "the loader calls res.json() but the docstring does not say the URL serves JSON",
  );
  // The raw-text feed is a real, named follow-up (text feeds carry an ICAO id,
  // not lon/lat). It may be described — but never as a path that works today.
  const rawClaim = docstring.match(/[^.]*raw METAR text[^.]*\./g) ?? [];
  for (const sentence of rawClaim) {
    assert.match(
      sentence.replace(/\s+/g, " "),
      /deferred|follow-up|not a supported/i,
      `the docstring offers a raw-METAR-text URL as a working path, which _loadStations does not parse: "${sentence.trim()}"`,
    );
  }
});
