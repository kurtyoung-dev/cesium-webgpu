import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const registryPath =
  "packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts";
const layoutPath =
  "Tools/visual-regression/fixtures/shader-registry-layout.json";
const namespace = {
  lo: "ShaderDefine",
  hi: "ShaderDefineHi",
  ext: "ShaderDefineExt",
};

// These independent pins are the add-only boundary. Consumer status deliberately
// remains outside it, so a consumer and its ledger flip can land together.
const landedNames = {
  lo: `GEODETIC_NORMAL DISABLE_DEPTH_DISTANCE SPLIT_ENABLED COMPRESSED_VERTICES
    DISTANCE_DISPLAY_CONDITION EYE_DISTANCE_TRANSLUCENCY EYE_DISTANCE_PIXEL_OFFSET
    EYE_DISTANCE_SCALING VS_THREE_POINT_DEPTH_CHECK MODEL_HAS_KHR_TEXTURES
    STOCHASTIC_DITHER_ALPHA STENCIL_PICK_WINNER MODEL_HAS_TEXCOORD_1
    MODEL_HAS_FEATURE_ID_0 MATERIAL_APPLY LOG_DEPTH GLOBE_IMAGERY_REDUCED
    CAPTURE_MODE MODEL_HAS_METADATA MODEL_HAS_PROPERTY_TEXTURES
    MODEL_HAS_PROPERTY_TABLES METADATA_PICKING_ENABLED POINT_CLOUD_EDL_DEPTH
    MODEL_HAS_WGSL_CUSTOM_SHADER MODEL_HAS_WGSL_CUSTOM_VERTEX
    VOXEL_CUSTOM_SHADER_COLOR MODEL_SPLIT_ENABLED MODEL_HAS_COLOR MODEL_SILHOUETTE
    VOXEL_USER_CUSTOM_SHADER MODEL_METADATA_MAT_TRANSPORT`.split(/\s+/),
  hi: `HI_WORD_PROBE ENHANCED_OCEAN SPLAT_PACKED_WASM SPLAT_SPHERICAL_HARMONICS
    CLOUD_MARCH_EMIT_RECONSTRUCTION CLOUD_RECONSTRUCTION_CONSUME
    UNDERWATER_OPTICS WATER_PROVIDER_PARITY
    CLOUD_NOISE_BAKED_ONLY CLOUD_MORPHOLOGY_BASE_ONLY CLOUD_DENSITY_MOMENTS
    CLOUD_PRIMARY_REUSE CLOUD_SPATIAL_OCCUPANCY CLOUD_DENSITY_SAMPLE_CACHE
    CLOUD_PRIMARY_DENSITY_CACHE CLOUD_LIGHTING_PREVIEW CLOUD_DIRECTIONAL_LIGHTING
    CLOUD_DEEP_SHADOW_CACHE CLOUD_LIGHTING_RESPONSE CLOUD_CONTRIBUTION_LIGHTING
    CLOUD_WEATHER_VOLUME_BOUNDS CLOUD_WEATHER_TRANSITION CLOUD_WEATHER_VERTICAL
    CLOUD_WEATHER_POPULATIONS CLOUD_GEOGRAPHIC_WIND CLOUD_SINGLE_LEVEL_WIND
    CLOUD_VELOCITY_ONLY_WIND CLOUD_PADDED_MATERIAL_FLOW CLOUD_MATERIAL_REPROJECTION
    CLOUD_SPATIAL_PROXY CLOUD_JOINT_SPATIAL_PROXY`.split(/\s+/),
  ext: `CLOUD_WEATHER_MATERIAL CLOUD_GEOGRAPHIC_FIBRES CLOUD_WEATHER_FORMATIONS
    CLOUD_OPTICAL_JOINT_COLUMNS CLOUD_SPATIAL_PROFILES CLOUD_JOINT_HEIGHT_PROFILES
    CLOUD_PROFILE_LATERAL_LIGHTING CLOUD_SPATIAL_PROXY_REGION CLOUD_SPARSE_PROFILES
    CLOUD_PROFILE_BAND_SUPPORT CLOUD_REGIONAL_PROXY_LEVELS
    CLOUD_REGIONAL_HEIGHT_SUPPORT CLOUD_FILTERED_HEIGHT_PROFILES
    CLOUD_SPATIAL_PROXY_PAGES`.split(/\s+/),
};

const landedSourceNames =
  `GLOBE_TERRAIN BILLBOARD_COLLECTION BILLBOARD_COLLECTION_PICK
  BILLBOARD_COLLECTION_SDF POINT_PRIMITIVE_COLOR POINT_PRIMITIVE_PICK
  POLYLINE_COLLECTION POLYLINE_COLLECTION_PICK POLYLINE_ARROW POLYLINE_DASH
  POLYLINE_GLOW POLYLINE_OUTLINE CLOUD_COLLECTION VOXEL_PRIMITIVE
  WEATHER_PARTICLE_RENDER WEATHER_PARTICLES_COMPUTE ENVIRONMENT_SUN ENVIRONMENT_MOON
  VOLUMETRIC_FOG_COMPUTE VOLUMETRIC_FOG_COMPOSITE POINT_CLOUD POINT_CLOUD_LOD
  MODEL_PBR_COMPLETE VECTOR_3DTILE_PRIMITIVE VECTOR_3DTILE_POLYLINES
  VECTOR_3DTILE_CLAMPED_POLYLINES BUFFER_POINT_MATERIAL BUFFER_POLYLINE_MATERIAL
  BUFFER_POLYGON_MATERIAL GROUND_PRIMITIVE GROUND_POLYLINE SKY_ATMOSPHERE
  ELLIPSOID_PRIMITIVE COMPUTE_INSTANCE_SCAFFOLD COMPUTE_INSTANCE_RENDER GAUSSIAN_SPLAT
  STAR_FIELD_CATALOG POINT_CLOUD_EDL_DEPTH POINT_CLOUD_EDL_BLEND FLOW_FIELD_RENDER
  OCEAN_SURFACE EDGE_EMITTER PROCEDURAL_CLOUDS CLOUD_PRIMARY_COMPOSITE`.split(
    /\s+/,
  );

const range = (word, start, end, name, owner = name) => ({
  word,
  start,
  end,
  name,
  owner,
});
const landedRanges = [
  range("lo", 0, 30, "historical"),
  range("hi", 0, 0, "infrastructure-probe", "infrastructure"),
  range("hi", 1, 1, "water-ocean-styling", "water-ocean"),
  range("hi", 2, 3, "gaussian-splats"),
  range("hi", 4, 5, "cloud-reconstruction"),
  range("hi", 6, 7, "water-ocean-optics", "water-ocean"),
  range("hi", 8, 14, "cloud-march"),
  range("hi", 15, 19, "cloud-lighting"),
  range("hi", 20, 23, "cloud-weather"),
  range("hi", 24, 28, "cloud-transport"),
  range("hi", 29, 30, "cloud-spatial"),
  range("ext", 0, 0, "weather-material", "cloud-weather"),
  range("ext", 1, 1, "geographic-transport", "cloud-transport"),
  range("ext", 2, 2, "weather-formations", "cloud-weather"),
  range("ext", 3, 5, "spatial-columns", "cloud-spatial"),
  range("ext", 6, 6, "profile-lighting", "cloud-lighting"),
  range("ext", 7, 10, "spatial-profiles", "cloud-spatial"),
  range("ext", 11, 12, "banked-cloud-profiles", "cloud-profiles-held-banked"),
  range("ext", 13, 13, "spatial-pages", "cloud-spatial"),
  range("ext", 14, 20, "cloud-expansion"),
  range("ext", 21, 23, "water-ocean"),
  range("ext", 24, 25, "globe-atmosphere"),
  range("ext", 26, 29, "scene-model"),
  range("ext", 30, 30, "infrastructure"),
];
const landedSourceRanges = [
  [1, 42, "historical"],
  [43, 63, "cloud"],
  [64, 95, "water-ocean"],
  [96, 127, "globe-atmosphere"],
  [128, 159, "scene-model"],
  [160, 191, "infrastructure"],
  [192, 255, "reserved"],
].map(([start, end, name]) => ({ start, end, name, owner: name }));

function parseSource(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
}

function consumerFile(file) {
  return (
    file.startsWith("packages/engine/Source/") &&
    file !== registryPath &&
    /\.(?:ts|js|wgsl)$/.test(file) &&
    !/(?:^|\/)(?:Specs?|fixtures)(?:\/|$)/i.test(file) &&
    !/(?:Spec|\.spec|\.test)\.(?:ts|js)$/.test(file) &&
    !(
      file.startsWith("packages/engine/Source/Shaders/") && file.endsWith(".js")
    )
  );
}

function scanConsumers(files, data) {
  const consumers = new Map();
  const flagNames = new Map(
    data.entries.map((entry) => [
      entry.name,
      `${namespace[entry.word]}.${entry.name}`,
    ]),
  );
  const record = (key, file) => {
    const paths = consumers.get(key) ?? new Set();
    paths.add(file);
    consumers.set(key, paths);
  };
  const directives = (source, file) => {
    for (const match of source.matchAll(
      /^\s*\/\/>>\s*ifdef\s+([A-Z_][A-Z0-9_]*)\s*$/gm,
    )) {
      const key = flagNames.get(match[1]);
      if (key) {
        record(key, file);
      }
    }
  };
  for (const [file, source] of files) {
    if (!consumerFile(file)) {
      continue;
    }
    if (file.endsWith(".wgsl")) {
      directives(source, file);
      continue;
    }
    if (!/Shader(?:Define|SourceId)|resolveDefineBit|\/\/>>/.test(source)) {
      continue;
    }
    const tree = parseSource(file, source);
    const bindings = new Map();
    const moduleAliases = new Set();
    for (const statement of tree.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !/WebGPUShaderDefines\.[jt]s$/.test(statement.moduleSpecifier.text) ||
        statement.importClause?.isTypeOnly
      ) {
        continue;
      }
      const names = statement.importClause?.namedBindings;
      if (names && ts.isNamedImports(names)) {
        for (const binding of names.elements) {
          if (!binding.isTypeOnly) {
            bindings.set(
              binding.name.text,
              (binding.propertyName ?? binding.name).text,
            );
          }
        }
      } else if (names && ts.isNamespaceImport(names)) {
        moduleAliases.add(names.name.text);
      }
    }
    const importedName = (node) => {
      if (ts.isIdentifier(node)) {
        return bindings.get(node.text);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        moduleAliases.has(node.expression.text)
      ) {
        return node.name.text;
      }
      return undefined;
    };
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const table = importedName(node.expression);
        if (["ShaderSourceId", ...Object.values(namespace)].includes(table)) {
          record(`${table}.${node.name.text}`, file);
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = importedName(node.expression) ?? "";
        const first = node.arguments[0];
        if (
          /^resolveDefineBit\w*$/.test(callee) &&
          first &&
          ts.isStringLiteral(first)
        ) {
          const key = flagNames.get(first.text);
          if (key) {
            record(key, file);
          }
        }
      }
      if (
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        directives(node.text, file);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return consumers;
}

async function readEngineSources(directory) {
  const entries = await readdir(path.join(root, directory), {
    withFileTypes: true,
  });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return readEngineSources(file);
      }
      return consumerFile(file)
        ? [[file, await readFile(path.join(root, file), "utf8")]]
        : [];
    }),
  );
  return groups.flat();
}

let layout;
let registrySource;
let registry;
let engineSources;
before(async () => {
  const [json, source, files] = await Promise.all([
    readFile(path.join(root, layoutPath), "utf8"),
    readFile(path.join(root, registryPath), "utf8"),
    readEngineSources("packages/engine/Source"),
  ]);
  layout = JSON.parse(json);
  registrySource = source;
  engineSources = new Map(files);
  registry = await bundle({
    path: path.join(root, registryPath),
    source,
    real: [],
  });
});

function allocation(ranges, word, position) {
  const matches = ranges.filter(
    (item) =>
      (word === undefined || item.word === word) &&
      item.start <= position &&
      position <= item.end,
  );
  assert.equal(
    matches.length,
    1,
    `allocation coverage ${word ?? "source"}:${position}`,
  );
  return matches[0];
}

function validateLayout(data, api, files) {
  assert.equal(data.version, 1);
  assert.equal(data.reservedDefineBit, 31);
  assert.equal(data.reservedSourceId, 0);
  assert.equal(data.cloudExtMaxBit, 20);
  assert.deepEqual(data.ranges, landedRanges, "landed ranges and owners");
  assert.deepEqual(
    data.sourceRanges,
    landedSourceRanges,
    "landed source ranges and owners",
  );
  for (const word of Object.keys(namespace)) {
    for (let bit = 0; bit < 31; bit++) {
      allocation(data.ranges, word, bit);
    }
  }
  for (let id = 1; id <= 255; id++) {
    allocation(data.sourceRanges, undefined, id);
  }

  const usedNames = new Set();
  for (const [word, tableName] of Object.entries(namespace)) {
    const table = api[tableName];
    const names = Object.keys(table);
    assert.deepEqual(
      names.slice(0, landedNames[word].length),
      landedNames[word],
      `${word} add-only declaration order`,
    );
    const entries = data.entries.filter((entry) => entry.word === word);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      names,
      `${word} ledger declaration order`,
    );
    const usedBits = new Set();
    for (const entry of entries) {
      const key = `${tableName}.${entry.name}`;
      assert(!usedNames.has(entry.name), `${key} unique namespace`);
      usedNames.add(entry.name);
      assert(
        Number.isInteger(entry.bit) && entry.bit >= 0 && entry.bit < 31,
        `${key} bit bounds`,
      );
      if (word === "ext" && entry.owner.startsWith("cloud-")) {
        assert(
          entry.bit <= data.cloudExtMaxBit,
          `${key} exact cloud cache packing`,
        );
      }
      assert(!usedBits.has(entry.bit), `${key} unique bit`);
      usedBits.add(entry.bit);
      assert.equal(table[entry.name], 2 ** entry.bit, `${key} ledger bit`);
      assert.equal(
        entry.owner,
        allocation(data.ranges, word, entry.bit).owner,
        `${key} allocation owner`,
      );
    }
    for (const [bit, name] of landedNames[word].entries()) {
      assert.equal(table[name], 2 ** bit, `${word}.${name} landed bit`);
    }
  }
  assert.equal(
    data.entries.length,
    usedNames.size,
    "no unknown words or duplicate ledger names",
  );

  const sourceNames = Object.keys(api.ShaderSourceId);
  assert.deepEqual(
    sourceNames.slice(0, landedSourceNames.length),
    landedSourceNames,
    "source add-only declaration order",
  );
  for (const [index, name] of landedSourceNames.entries()) {
    assert.equal(
      api.ShaderSourceId[name],
      index + 1,
      `${name} landed source ID`,
    );
  }
  assert.deepEqual(
    data.sources.map((entry) => entry.name),
    sourceNames,
    "source ledger declaration order",
  );
  const sourceIds = new Set();
  for (const entry of data.sources) {
    assert(
      Number.isInteger(entry.id) && entry.id > 0 && entry.id < 256,
      `${entry.name} source ID bounds`,
    );
    assert(!sourceIds.has(entry.id), `${entry.name} unique source ID`);
    sourceIds.add(entry.id);
    assert.equal(
      api.ShaderSourceId[entry.name],
      entry.id,
      `${entry.name} ledger source ID`,
    );
    assert.equal(
      entry.owner,
      allocation(data.sourceRanges, undefined, entry.id).owner,
      `${entry.name} source owner`,
    );
  }

  const consumers = scanConsumers(files, data);
  for (const entry of [...data.entries, ...data.sources]) {
    const key = entry.word
      ? `${namespace[entry.word]}.${entry.name}`
      : `ShaderSourceId.${entry.name}`;
    const paths = [...(consumers.get(key) ?? [])].sort();
    assert.equal(
      entry.status,
      paths.length ? "consumed" : "reserved",
      `${key} consumer status: ${paths.join(", ")}`,
    );
    if (entry.consumers !== undefined) {
      assert.deepEqual(entry.consumers, paths, `${key} consumer paths`);
    }
  }
}

test("the allocation ledger pins identities, owners, ranges, order and live consumer status", () => {
  validateLayout(layout, registry, engineSources);
});

test("new declarations carry JSDoc naming a consumer unit or a reserved subsystem", () => {
  const declarations = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer && ts.isCallExpression(initializer)) {
        let object = initializer.arguments[0];
        if (object && ts.isAsExpression(object)) {
          object = object.expression;
        }
        if (object && ts.isObjectLiteralExpression(object)) {
          declarations.set(node.name.text, object.properties);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(registryPath, registrySource));
  for (const [tableName, first] of [
    ["ShaderDefineHi", 6],
    ["ShaderDefineExt", 0],
    ["ShaderSourceId", 42],
  ]) {
    const properties = declarations.get(tableName);
    assert(properties, tableName);
    for (const property of properties.slice(first)) {
      const docs = property.jsDoc?.map((doc) => doc.getText()).join("\n") ?? "";
      assert.match(
        docs,
        /^\/\*\*/,
        `${tableName}.${property.name.getText()} JSDoc`,
      );
      assert.match(
        docs,
        /\.(?:wgsl|[jt]s)\b|reserved for [a-z]/i,
        `${tableName}.${property.name.getText()} consumer or reservation`,
      );
    }
  }
});

test("consumer discovery excludes comments, prose, fixtures and unrelated property names", () => {
  const file = "packages/engine/Source/Renderer/WebGPU/ConsumerExample.ts";
  const name = "CLOUD_NOISE_BAKED_ONLY";
  const prefix =
    'import { ShaderDefineHi as H, resolveDefineBitHi as resolve } from "./WebGPUShaderDefines.js";\n';
  const key = `ShaderDefineHi.${name}`;
  const noise = `// ShaderDefineHi.${name}\nconst prose = "ShaderDefineHi.${name}";\nconst H = { ${name}: 1 };\nH.${name};`;
  assert(!scanConsumers(new Map([[file, noise]]), layout).has(key));
  for (const source of [
    `${prefix}H.${name};`,
    `${prefix}resolve("${name}");`,
    `import * as R from "./WebGPUShaderDefines.js"; R.ShaderDefineHi.${name};`,
    `const shader = \`//>>ifdef ${name}\nbody\n//>>endif\`;`,
  ]) {
    assert.deepEqual(
      [...scanConsumers(new Map([[file, source]]), layout).get(key)],
      [file],
    );
  }
  for (const ignored of [
    registryPath,
    file.replace("/Source/", "/Specs/"),
    file.replace(".ts", ".spec.ts"),
    "packages/engine/Source/Shaders/WebGPU/Generated.js",
  ]) {
    assert(
      !scanConsumers(new Map([[ignored, `${prefix}H.${name};`]]), layout).has(
        key,
      ),
    );
  }
});

test("a reserved-to-consumed ledger update needs no registry source change", () => {
  const data = structuredClone(layout);
  const entry = data.entries.find(
    (item) => item.name === "CLOUD_NOISE_BAKED_ONLY",
  );
  assert.equal(entry.status, "reserved");
  const files = new Map(engineSources);
  const file = "packages/engine/Source/Renderer/WebGPU/AllocationConsumer.ts";
  files.set(
    file,
    'import { ShaderDefineHi } from "./WebGPUShaderDefines.js";\nconst mask = ShaderDefineHi.CLOUD_NOISE_BAKED_ONLY;',
  );
  assert.throws(() => validateLayout(data, registry, files), /consumer status/);
  entry.status = "consumed";
  if (entry.consumers !== undefined) {
    entry.consumers = [file];
  }
  validateLayout(data, registry, files);
});

test("R-2 rejects swapping two landed bit assignments even with a matching ledger", () => {
  const data = structuredClone(layout);
  const api = { ...registry, ShaderDefineExt: { ...registry.ShaderDefineExt } };
  const [a, b] = ["CLOUD_OPTICAL_JOINT_COLUMNS", "CLOUD_SPATIAL_PROFILES"];
  [api.ShaderDefineExt[a], api.ShaderDefineExt[b]] = [
    api.ShaderDefineExt[b],
    api.ShaderDefineExt[a],
  ];
  for (const entry of data.entries.filter(
    (item) => item.word === "ext" && [a, b].includes(item.name),
  )) {
    entry.bit = entry.name === a ? 4 : 3;
  }
  assert.throws(() => validateLayout(data, api, engineSources), /landed bit/);
});

test("owner drift in an entry or in a range is rejected", () => {
  const data = structuredClone(layout);
  data.entries.find((entry) => entry.name === "CLOUD_NOISE_BAKED_ONLY").owner =
    "water-ocean";
  assert.throws(
    () => validateLayout(data, registry, engineSources),
    /allocation owner/,
  );
  const changedRange = structuredClone(layout);
  changedRange.ranges.find((entry) => entry.name === "cloud-march").owner =
    "water-ocean";
  assert.throws(
    () => validateLayout(changedRange, registry, engineSources),
    /landed ranges and owners/,
  );
});

test("stale consumer state in both directions is rejected", () => {
  const api = registry;
  const sources = engineSources;
  for (const status of ["consumed", "reserved"]) {
    const data = structuredClone(layout);
    const entry = data.entries.find((item) => item.status === status);
    assert(entry);
    entry.status = status === "consumed" ? "reserved" : "consumed";
    assert.throws(() => validateLayout(data, api, sources), /consumer status/);
  }
});

test("M-L1 rejects an entry moved outside its allocation range", () => {
  const data = structuredClone(layout);
  const name = "CLOUD_NOISE_BAKED_ONLY";
  const api = {
    ...registry,
    ShaderDefineHi: { ...registry.ShaderDefineHi, [name]: 2 ** 15 },
  };
  data.entries.find((entry) => entry.name === name).bit = 15;
  assert.throws(
    () => validateLayout(data, api, engineSources),
    /allocation owner/,
  );
});

test("M-L2 rejects an invalid Ext power or reserved bit 31", () => {
  const name = "CLOUD_WEATHER_MATERIAL";
  const invalidPower = {
    ...registry,
    ShaderDefineExt: { ...registry.ShaderDefineExt, [name]: 3 },
  };
  assert.throws(
    () => validateLayout(layout, invalidPower, engineSources),
    /ledger bit/,
  );
  const data = structuredClone(layout);
  const reservedBit = {
    ...registry,
    ShaderDefineExt: { ...registry.ShaderDefineExt, [name]: 2 ** 31 },
  };
  data.entries.find((entry) => entry.name === name).bit = 31;
  assert.throws(
    () => validateLayout(data, reservedBit, engineSources),
    /bit bounds/,
  );
});

test("M-L3 rejects source 43 consumed without a qualified consumer", () => {
  const data = structuredClone(layout);
  const entry = data.sources.find((item) => item.id === 43);
  assert.equal(entry.name, "PROCEDURAL_CLOUDS");
  assert.equal(entry.status, "reserved");
  entry.status = "consumed";
  assert.throws(
    () => validateLayout(data, registry, engineSources),
    /ShaderSourceId\.PROCEDURAL_CLOUDS consumer status/,
  );
});

test("M-L4 rejects an existing cloud Ext entry moved to bit 21", () => {
  const data = structuredClone(layout);
  const name = "CLOUD_WEATHER_MATERIAL";
  const api = {
    ...registry,
    ShaderDefineExt: { ...registry.ShaderDefineExt, [name]: 2 ** 21 },
  };
  data.entries.find((entry) => entry.name === name).bit = 21;
  assert.throws(
    () => validateLayout(data, api, engineSources),
    /exact cloud cache packing/,
  );
});

test("M-L5 rejects reordered Ext declarations with their values kept", () => {
  const data = structuredClone(layout);
  const entries = Object.entries(registry.ShaderDefineExt);
  [entries[0], entries[1]] = [entries[1], entries[0]];
  const api = { ...registry, ShaderDefineExt: Object.fromEntries(entries) };
  const first = data.entries.findIndex((entry) => entry.word === "ext");
  [data.entries[first], data.entries[first + 1]] = [
    data.entries[first + 1],
    data.entries[first],
  ];
  assert.throws(
    () => validateLayout(data, api, engineSources),
    /add-only declaration order/,
  );
});
