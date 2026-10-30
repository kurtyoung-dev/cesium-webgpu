// query-context.mjs — CLI for building and querying the Cesium WebGPU SQLite context, seam, ledger, and spatial validation spine.
// @purpose Command-line entrypoint to build and query the zero-dependency SQLite context spine (symbols, verified slices, Cesium seams, Charter-ranked rulings/ledgers, spatial R-tree rigs, contracts, and context capsules).
// @status ACTIVE

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContextSpine,
  buildImpactPack,
  formatImpactPackMarkdown,
  generateContextCapsule,
  getSpineStats,
  openOrBuildSpine,
  queryContracts,
  queryDeadExports,
  queryLedger,
  querySeams,
  querySpatialValidation,
  querySymbols,
} from "./context-spine/query-engine.mjs";
import { importGraphifyJson } from "./context-spine/graphify-bridge.mjs";
import {
  finalizeDatabaseForReadOnly,
  openContextDatabase,
  readVerifiedSlice,
  resolveDbPath,
} from "./context-spine/schema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

/** Printed at the head of every `contracts` answer: the rows scope work, they never accept it. */
const CONTRACTS_LEAD_NOTE =
  "Contracts and hazard output is a scoping lead, not a gate: it has no runner home and this command always exits 0. Re-read each cited line at HEAD; never cite this output as acceptance.";

/**
 * Minimal deterministic CLI flag parser.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return {
    command: positionals[0] ?? "help",
    args: positionals.slice(1),
    flags,
  };
}

function printHelp() {
  const text = `Usage: node Tools/query-context.mjs <command> [args] [flags]

Commands:
  build [--incremental] [--with-graphify] [--bootstrap-graphify --graphify-version <x.y.z>] [--db <path>]
      Build or refresh .cache/context-spine/cesium-context.sqlite
      (--bootstrap-graphify downloads graphifyy==<x.y.z> from the default Python
      package index into .cache/context-spine/py-venv; it refuses without the pin)
  stats [--json]
      Report indexed symbol, seam, contract, ledger, and spatial R-tree counts
  impact <target> [--slice] [--json]
      One-shot ~1.5K-2.5K token Impact Pack (outline + seams + contracts + rulings + rigs + tests)
  symbol <query> [--slice] [--kind <kind>] [--limit <n>] [--json]
      Lookup JS/TS/WGSL/GLSL symbols with optional live SHA-256 verified snippet
  slice <relPath> <startLine> <endLine> [--symbol <name>] [--json]
      Read an exact line window verified against indexed SHA-256
  seam <target> [--json]
      Traverse FeatureRendererKey, ShaderDefine/ifdef, ShaderSourceId, and GLSL<->WGSL seams
  ruling <query> [--all] [--limit <n>] [--json]
      Query Maintainer Rulings in Charter §0.4 order (marks AMENDED / VACATED)
  ledger <query> [--all] [--kind <docKind>] [--limit <n>] [--json]
      Query rulings, campaign queues, CAMPAIGN_STATE, Blueprint hotspots, and DEFERRED_WORK
  spatial-rigs [--for <target>] [--bbox minLon,minLat,maxLon,maxLat] [--regime <r1,r2>] [--tag <t1,t2>] [--json]
      Query SQLite R-tree spatial rigs, minimal set-cover, GIS datum assets, and coverage gaps
  contracts [--file <path>] [--category <cat>] [--severity <hazard|review|positive>] [--json]
      Query 64-bit RTE, log-depth, CameraUniforms tail, and @group/@binding contracts
      (a scoping lead, not a gate: no runner home, always exits 0)
  dead-exports [--prefix <path>] [--include-js-defaults] [--limit <n>] [--json]
      Find exported runtime symbols with 0 engine/widget consumers (excluding @experimental)
  capsule <target1[,target2...]> [--role <worker|reviewer|orchestrator>] [--out <path>] [--json]
      Emit a HEAD-SHA-stamped context capsule for worker/reviewer clones
  import-graphify <graphJsonPath> [--prefix <scanPrefix>]
      Merge a Graphify --code-only graph.json (call graph + Leiden communities) into SQLite
`;
  process.stdout.write(text);
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, args, flags } = parseArgs(argv);
  const repoRoot = flags.repo
    ? path.resolve(String(flags.repo))
    : DEFAULT_REPO_ROOT;
  const dbPath = typeof flags.db === "string" ? flags.db : undefined;
  const asJson = Boolean(flags.json);
  const limit = flags.limit ? Number(flags.limit) : undefined;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "build") {
    const result = await buildContextSpine({
      repoRoot,
      dbPath,
      incremental: Boolean(flags.incremental),
      withGraphify: Boolean(flags["with-graphify"]),
      bootstrapGraphify: Boolean(flags["bootstrap-graphify"]),
      graphifyVersion:
        typeof flags["graphify-version"] === "string"
          ? flags["graphify-version"]
          : undefined,
      graphifyJsonPath:
        typeof flags["graphify-json"] === "string"
          ? flags["graphify-json"]
          : undefined,
    });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Built ${result.dbPath} in ${result.durationMs}ms @ HEAD ${result.headSha.slice(0, 10)}\n` +
          `  Code & Shaders : ${result.code.fileCount} files, ${result.code.symbolCount} symbols, ${result.code.edgeCount} edges, ${result.code.contractCount} contracts\n` +
          `  Governance/Docs: ${result.ledger.entryCount} entries (${result.ledger.activeCount} active, ${result.ledger.rulingCount} rulings)\n` +
          `  Spatial & GIS  : ${result.spatial.rigCount} rigs (${result.spatial.geoIndexedCount} R-tree geo-indexed), ${result.spatial.gisAssetCount} GIS assets\n` +
          (result.spatial.coverageGaps.length > 0
            ? `  Regime Gaps    : ${result.spatial.coverageGaps.join(", ")}\n`
            : "  Regime Gaps    : none\n") +
          (result.graphify
            ? `  Graphify Bridge: ${JSON.stringify(result.graphify)}\n`
            : ""),
      );
    }
    return 0;
  }

  if (command === "import-graphify") {
    const graphJsonPath = args[0];
    if (!graphJsonPath) {
      throw new Error("Usage: import-graphify <path/to/graph.json>");
    }
    await openOrBuildSpine(repoRoot, { dbPath }).then((db) => db.close());
    const writableDb = openContextDatabase(resolveDbPath(repoRoot, dbPath), {
      readOnly: false,
      reset: false,
    });
    try {
      const imported = importGraphifyJson(
        writableDb,
        path.resolve(repoRoot, graphJsonPath),
        repoRoot,
        {
          scanPrefix:
            typeof flags.prefix === "string"
              ? flags.prefix
              : "packages/engine/Source",
        },
      );
      finalizeDatabaseForReadOnly(writableDb);
      process.stdout.write(`${JSON.stringify(imported, null, 2)}\n`);
    } finally {
      writableDb.close();
    }
    return 0;
  }

  const db = await openOrBuildSpine(repoRoot, { dbPath });
  try {
    if (command === "stats") {
      const stats = getSpineStats(db);
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      return 0;
    }

    if (command === "impact") {
      const target = args.join(" ").trim();
      if (!target) throw new Error("Usage: impact <file|symbol|define>");
      const pack = buildImpactPack(db, repoRoot, target, {
        includeSlice: Boolean(flags.slice),
      });
      if (asJson) {
        process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatImpactPackMarkdown(pack)}\n`);
      }
      return 0;
    }

    if (command === "symbol") {
      const query = args.join(" ").trim();
      if (!query) throw new Error("Usage: symbol <query>");
      const hits = querySymbols(db, repoRoot, query, {
        limit,
        kind: typeof flags.kind === "string" ? flags.kind : undefined,
        includeSlice: Boolean(flags.slice),
      });
      if (asJson) {
        process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
      } else {
        for (const h of hits) {
          process.stdout.write(
            `${h.filePath}:L${h.startLine}-L${h.endLine} [${h.kind}] ${h.name}${h.signature ? ` — ${h.signature}` : ""}\n`,
          );
          if (h.slice) {
            process.stdout.write(
              `  fresh=${h.slice.fresh} relocated=${h.slice.relocated}\n${h.slice.snippet
                .split("\n")
                .map((l) => `    ${l}`)
                .join("\n")}\n`,
            );
          }
        }
      }
      return 0;
    }

    if (command === "slice") {
      const [relPath, startStr, endStr] = args;
      if (!relPath || !startStr || !endStr) {
        throw new Error("Usage: slice <relPath> <startLine> <endLine>");
      }
      const normalized = relPath.replace(/\\/g, "/");
      const fileRow = db
        .prepare("SELECT sha256 FROM files WHERE path = ?")
        .get(normalized);
      const res = readVerifiedSlice(
        repoRoot,
        normalized,
        Number(startStr),
        Number(endStr),
        fileRow?.sha256 ?? null,
        typeof flags.symbol === "string" ? flags.symbol : undefined,
      );
      if (asJson) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else {
        process.stdout.write(
          `# ${normalized}:L${res.startLine}-L${res.endLine} (fresh=${res.fresh}, relocated=${res.relocated})\n${res.snippet}\n`,
        );
      }
      return 0;
    }

    if (command === "seam") {
      const target = args.join(" ").trim();
      if (!target) throw new Error("Usage: seam <target>");
      const res = querySeams(db, target, { limit });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return 0;
    }

    if (command === "ruling" || command === "ledger") {
      const query = args.join(" ").trim();
      if (!query) throw new Error(`Usage: ${command} <query>`);
      const res = queryLedger(db, query, {
        activeOnly: !flags.all,
        docKind:
          command === "ruling"
            ? "ruling"
            : typeof flags.kind === "string"
              ? flags.kind
              : undefined,
        limit,
      });
      if (asJson) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else {
        for (const r of res) {
          process.stdout.write(
            `[Rank ${r.authorityRank} | ${r.status}] ${r.id} (${r.sourceFile}:L${r.startLine}-L${r.endLine})\n  ${r.title}\n  ${r.summary}\n`,
          );
        }
      }
      return 0;
    }

    if (command === "spatial-rigs") {
      const bbox =
        typeof flags.bbox === "string"
          ? flags.bbox.split(",").map(Number)
          : undefined;
      const regimes =
        typeof flags.regime === "string"
          ? flags.regime.split(",").filter(Boolean)
          : undefined;
      const tags =
        typeof flags.tag === "string"
          ? flags.tag.split(",").filter(Boolean)
          : undefined;
      const res = querySpatialValidation(db, {
        bbox:
          bbox && bbox.length === 4
            ? /** @type {[number,number,number,number]} */ (bbox)
            : undefined,
        regimes,
        tags,
        renderer:
          typeof flags.renderer === "string" ? flags.renderer : undefined,
        forTarget:
          typeof flags.for === "string"
            ? flags.for
            : args.length > 0
              ? args.join(" ")
              : undefined,
        limit,
      });
      if (asJson) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else {
        process.stdout.write(
          `Matching Rigs: ${res.totalMatchingRigs} | Fleet Regime Gaps: ${res.fleetCoverageGaps.join(", ") || "none"}\n`,
        );
        if (res.minimalCover) {
          process.stdout.write(
            `Minimal Set-Cover (${res.minimalCover.selectedRigs.length} rigs for [${res.minimalCover.coveredTargets.join(", ")}]):\n`,
          );
          for (const sr of res.minimalCover.selectedRigs) {
            process.stdout.write(
              `  - ${sr.id} (${sr.filePath}) [${sr.renderers.join("+")}] -> covers ${sr.newlyCovered.join(", ")}\n`,
            );
          }
        } else {
          for (const r of res.rigs) {
            process.stdout.write(
              `  - ${r.id} (${r.filePath}) regimes=[${r.regimes.join(",")}]\n`,
            );
          }
        }
        if (res.gisAssets.length > 0) {
          process.stdout.write(
            `Overlapping GIS Datum Assets (${res.gisAssets.length}):\n`,
          );
          for (const g of res.gisAssets) {
            process.stdout.write(
              `  - ${g.id}: ${g.crsFrom} -> ${g.crsTo} (${g.seamRule})\n`,
            );
          }
        }
      }
      return 0;
    }

    if (command === "contracts") {
      const res = queryContracts(db, {
        filePath:
          typeof flags.file === "string" ? flags.file : (args[0] ?? undefined),
        category:
          typeof flags.category === "string" ? flags.category : undefined,
        severity:
          typeof flags.severity === "string" ? flags.severity : undefined,
        limit,
      });
      if (asJson) {
        process.stdout.write(
          `${JSON.stringify({ note: CONTRACTS_LEAD_NOTE, ...res }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`${CONTRACTS_LEAD_NOTE}\n`);
        for (const s of res.summary) {
          process.stdout.write(
            `[${s.severity.toUpperCase()}] ${s.category}/${s.contract_type}: ${s.count}\n`,
          );
        }
        for (const i of res.items) {
          process.stdout.write(
            `  ${i.file_path}:L${i.line} [${i.severity}] ${i.contract_type} — ${i.detail}\n`,
          );
        }
      }
      return 0;
    }

    if (command === "dead-exports") {
      const res = queryDeadExports(db, {
        prefix:
          typeof flags.prefix === "string"
            ? flags.prefix
            : typeof flags.scope === "string"
              ? flags.scope
              : (args[0] ?? "packages/engine/Source"),
        includePublicJsDefaults: Boolean(flags["include-js-defaults"]),
        includeToolConsumers: Boolean(flags["include-tools"]),
        limit,
      });
      if (asJson) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else {
        process.stdout.write(
          `Dead Runtime Exports under '${res.prefix}': ${res.totalDeadExports}\n`,
        );
        for (const item of res.items) {
          const note =
            item.toolOnlyConsumers > 0
              ? ` [test/tool-only consumers: ${item.toolOnlyConsumers}]`
              : "";
          process.stdout.write(
            `  ${item.filePath}:L${item.startLine}-L${item.endLine} [${item.kind}] ${item.name}${note}\n`,
          );
        }
      }
      return 0;
    }

    if (command === "capsule") {
      const rawTargets = args.join(",");
      const targets = rawTargets
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (targets.length === 0) {
        throw new Error(
          "Usage: capsule <target1[,target2...]> [--role worker] [--out path]",
        );
      }
      const role =
        flags.role === "reviewer" || flags.role === "orchestrator"
          ? flags.role
          : "worker";
      const outPath = typeof flags.out === "string" ? flags.out : undefined;
      const cap = generateContextCapsule(db, repoRoot, {
        targets,
        role,
        outPath,
      });
      if (asJson) {
        process.stdout.write(`${JSON.stringify(cap, null, 2)}\n`);
      } else if (outPath) {
        process.stdout.write(
          `Wrote ${outPath} (~${cap.approxTokens} tokens, HEAD ${cap.headSha.slice(0, 10)})\n`,
        );
      } else {
        process.stdout.write(`${cap.markdown}\n`);
      }
      return 0;
    }

    throw new Error(`Unknown command '${command}'. Run with --help for usage.`);
  } finally {
    db.close();
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`[query-context] ERROR: ${err?.message ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
