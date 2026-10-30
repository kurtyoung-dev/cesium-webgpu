// mcp-server.mjs — Zero-dependency JSON-RPC 2.0 Model Context Protocol (MCP) stdio server for the Cesium WebGPU context spine.
// @purpose Zero-dependency stdio MCP server exposing token-compact impact packs, SHA-256 verified symbol slices, Charter-ranked rulings/ledgers, spatial R-tree rig covers, and coordinate contract checks.
// @status ACTIVE

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildImpactPack,
  formatImpactPackMarkdown,
  generateContextCapsule,
  openOrBuildSpine,
  queryContracts,
  queryDeadExports,
  queryLedger,
  querySeams,
  querySpatialValidation,
  querySymbols,
} from "./query-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..", "..");

const MCP_TOOLS = [
  {
    name: "cesium_impact_pack",
    description:
      "Return a ~1.5K-2.5K token Impact Pack for any CesiumJS/WebGPU file, symbol, FeatureRendererKey, or ShaderDefine: line-anchored symbol outline, cross-boundary seams, RTE/depth/CameraUniforms contracts, Charter §0.4 active rulings/queues, minimal Probe Kit spatial rigs, and matching npm test scripts.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "File basename, repo-relative path, class/function/WGSL symbol, FeatureRendererKey, or ShaderDefine flag.",
        },
        includeSlice: {
          type: "boolean",
          description:
            "Include live SHA-256 verified snippet for top matching symbols.",
        },
        includeSlices: {
          type: "boolean",
          description: "Alias for includeSlice.",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "cesium_query_symbol",
    description:
      "Search JS, TS, WGSL, and GLSL symbols and return exact line spans with optional live disk SHA-256 freshness verification and automatic symbol relocation.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol name, file path, or keyword.",
        },
        kind: {
          type: "string",
          description:
            "Optional symbol kind filter (class, function, method, wgsl-fn, wgsl-struct, wgsl-ifdef, etc.).",
        },
        includeSlice: {
          type: "boolean",
          description: "Read live SHA-256 verified source slice from disk.",
        },
        limit: { type: "number", description: "Maximum results (default 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "cesium_query_ledger",
    description:
      "Query Maintainer Rulings, Campaign Queues, CAMPAIGN_STATE, Consolidated Remediation Blueprint epics/hotspots, and DEFERRED_WORK in strict Charter §0.4 authority order (omitting superseded/closed chatter unless includeHistorical is true).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Ruling ID (R-YYYY-MM-DD-N), queue row (C13-41), file name, or topic.",
        },
        docKind: {
          type: "string",
          description:
            "Optional filter: ruling, queue-row, campaign-state, blueprint-hotspot, blueprint-epic, deferred-work.",
        },
        includeHistorical: {
          type: "boolean",
          description: "Include CLOSED, AMENDED, and VACATED entries.",
        },
        limit: { type: "number", description: "Maximum results (default 12)." },
      },
      required: ["query"],
    },
  },
  {
    name: "cesium_spatial_rigs",
    description:
      "Query the SQLite R-tree spatial validation graph over Probe Kit visual-regression rigs and GIS datum assets; computes a greedy minimal rig set-cover and reports untested planetary singularity regimes.",
    inputSchema: {
      type: "object",
      properties: {
        forTarget: {
          type: "string",
          description:
            "File or subsystem name to infer required spatial regimes and GIS datum assets.",
        },
        bbox: {
          type: "array",
          items: { type: "number" },
          minItems: 4,
          maxItems: 4,
          description: "[minLon, minLat, maxLon, maxLat] in WGS84 degrees.",
        },
        regimes: {
          type: "array",
          items: { type: "string" },
          description:
            "Explicit spatial regimes (e.g. north_pole, grazing_terminator, coastal_or_water, sub_ellipsoid_or_underground).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Explicit RIG_TAGS filters (e.g. wave-end, cloud, globe, voxel, ssr).",
        },
        renderer: { type: "string", enum: ["webgl", "webgpu"] },
      },
    },
  },
  {
    name: "cesium_check_contracts",
    description:
      "Audit 64-bit RTE precision, logarithmic depth (_logDepthEncodeNearFar vs currentFrustum), CameraUniforms.previousViewProjection tail placement, and WGSL @group/@binding contracts.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Optional file path or substring filter.",
        },
        category: {
          type: "string",
          description:
            "Optional category: precision_rte, depth_encoding, camera_uniform_tail, bind_group_layout.",
        },
        severity: {
          type: "string",
          enum: ["hazard", "review", "positive"],
        },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "cesium_context_capsule",
    description:
      "Generate a role-sliced (worker, reviewer, orchestrator) HEAD-SHA-stamped Markdown context capsule for one or more targets.",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          description: "Target files, symbols, or subsystems.",
        },
        role: {
          type: "string",
          enum: ["worker", "reviewer", "orchestrator"],
        },
      },
      required: ["targets"],
    },
  },
  {
    name: "cesium_query_seams",
    description:
      "Traverse cross-boundary Cesium seams (FeatureRendererKey registrations/consumers, 3-word ShaderDefine/ShaderDefineHi/ShaderDefineExt & WGSL //>>ifdef guards, ShaderSourceId cache entries, GLSL<->WGSL stem pairs, and structural imports/calls).",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "File path, FeatureRendererKey, ShaderDefine flag, ShaderSourceId, or symbol name.",
        },
        limit: {
          type: "number",
          description: "Maximum edges per seam category (default 25).",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "cesium_dead_exports",
    description:
      "List exported runtime symbols (classes, functions, constants) under a directory prefix that have 0 engine/widget consumers (excluding @experimental symbols and index barrels), flagging test-only dead twins.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description:
            "Repo-relative path prefix (default: packages/engine/Source).",
        },
        includePublicJsDefaults: {
          type: "boolean",
          description:
            "Also inspect default exports of .js modules (off by default since public API re-exports them).",
        },
        limit: {
          type: "number",
          description: "Maximum items to return (default 50).",
        },
      },
    },
  },
];

/**
 * Detect whether `cwd` (or one of its ancestors) is a Cesium repository/worker clone
 * so a single global Codex MCP registration (`~/.codex/config.toml`) automatically binds
 * to whichever worker clone Sol, Astra, or Opus is currently standing in.
 *
 * @param {string} [startDir]
 * @returns {string}
 */
export function detectActiveCesiumRoot(startDir = process.cwd()) {
  let curr = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(path.join(curr, "packages", "engine", "Source")) &&
      fs.existsSync(path.join(curr, "package.json"))
    ) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return DEFAULT_REPO_ROOT;
}

function parseServerFlags(argv) {
  let repoRoot = detectActiveCesiumRoot();
  let dbPath;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo" && argv[i + 1]) {
      repoRoot = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--db" && argv[i + 1]) {
      dbPath = argv[i + 1];
      i += 1;
    }
  }
  return { repoRoot, dbPath };
}

/**
 * Start the stdio JSON-RPC 2.0 MCP server.
 */
export function startMcpServer(argv = process.argv.slice(2)) {
  const { repoRoot, dbPath } = parseServerFlags(argv);
  let dbPromise = null;

  function getDb() {
    if (!dbPromise) {
      dbPromise = openOrBuildSpine(repoRoot, { dbPath });
    }
    return dbPromise;
  }

  let framingMode = "ndjson"; // Dynamically switches to "content-length" if client sends Content-Length header

  function sendMessage(payload) {
    const json = JSON.stringify(payload);
    if (framingMode === "content-length") {
      const byteLen = Buffer.byteLength(json, "utf8");
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  }

  async function handleToolCall(name, args = {}) {
    const db = await getDb();
    switch (name) {
      case "cesium_impact_pack": {
        const pack = buildImpactPack(db, repoRoot, String(args.target ?? ""), {
          includeSlice: Boolean(args.includeSlice ?? args.includeSlices),
        });
        return formatImpactPackMarkdown(pack);
      }
      case "cesium_query_symbol": {
        const hits = querySymbols(db, repoRoot, String(args.query ?? ""), {
          kind: typeof args.kind === "string" ? args.kind : undefined,
          includeSlice: args.includeSlice !== false,
          limit: typeof args.limit === "number" ? args.limit : 10,
        });
        return JSON.stringify(hits, null, 2);
      }
      case "cesium_query_ledger": {
        const rows = queryLedger(db, String(args.query ?? ""), {
          docKind: typeof args.docKind === "string" ? args.docKind : undefined,
          activeOnly: !args.includeHistorical,
          limit: typeof args.limit === "number" ? args.limit : 12,
        });
        return JSON.stringify(rows, null, 2);
      }
      case "cesium_spatial_rigs": {
        const res = querySpatialValidation(db, {
          forTarget:
            typeof args.forTarget === "string" ? args.forTarget : undefined,
          bbox: Array.isArray(args.bbox) ? args.bbox : undefined,
          regimes: Array.isArray(args.regimes) ? args.regimes : undefined,
          tags: Array.isArray(args.tags) ? args.tags : undefined,
          renderer:
            typeof args.renderer === "string" ? args.renderer : undefined,
        });
        return JSON.stringify(res, null, 2);
      }
      case "cesium_check_contracts": {
        const res = queryContracts(db, {
          filePath:
            typeof args.filePath === "string" ? args.filePath : undefined,
          category:
            typeof args.category === "string" ? args.category : undefined,
          severity:
            typeof args.severity === "string" ? args.severity : undefined,
          limit: typeof args.limit === "number" ? args.limit : 30,
        });
        return JSON.stringify(res, null, 2);
      }
      case "cesium_context_capsule": {
        const targets = Array.isArray(args.targets)
          ? args.targets.map(String)
          : [];
        const cap = generateContextCapsule(db, repoRoot, {
          targets,
          role:
            args.role === "reviewer" || args.role === "orchestrator"
              ? args.role
              : "worker",
        });
        return cap.markdown;
      }
      case "cesium_query_seams": {
        const res = querySeams(db, String(args.target ?? ""), {
          limit: typeof args.limit === "number" ? args.limit : 25,
        });
        return JSON.stringify(res, null, 2);
      }
      case "cesium_dead_exports": {
        const res = queryDeadExports(db, {
          prefix:
            typeof args.prefix === "string"
              ? args.prefix
              : "packages/engine/Source",
          includePublicJsDefaults: Boolean(args.includePublicJsDefaults),
          limit: typeof args.limit === "number" ? args.limit : 50,
        });
        return JSON.stringify(res, null, 2);
      }
      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }

  async function dispatchRpc(msg) {
    if (!msg || typeof msg !== "object") return;
    const { id, method, params } = msg;

    // Notifications have no `id` and expect no response.
    if (id === undefined || id === null) {
      return;
    }

    try {
      if (method === "initialize") {
        sendMessage({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "cesium-context-spine",
              version: "1.0.0",
            },
          },
        });
        return;
      }

      if (method === "ping") {
        sendMessage({ jsonrpc: "2.0", id, result: {} });
        return;
      }

      if (method === "tools/list") {
        sendMessage({
          jsonrpc: "2.0",
          id,
          result: { tools: MCP_TOOLS },
        });
        return;
      }

      if (method === "tools/call") {
        const toolName = params?.name;
        const text = await handleToolCall(toolName, params?.arguments ?? {});
        sendMessage({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text }],
            isError: false,
          },
        });
        return;
      }

      sendMessage({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${String(method)}`,
        },
      });
    } catch (err) {
      if (method === "tools/call") {
        sendMessage({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: `Error executing ${params?.name}: ${err?.message ?? err}`,
              },
            ],
            isError: true,
          },
        });
      } else {
        sendMessage({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: String(err?.message ?? err),
          },
        });
      }
    }
  }

  let buffer = Buffer.alloc(0);

  function pumpBuffer() {
    while (buffer.length > 0) {
      // Check for Content-Length LSP framing
      const headerProbe = buffer
        .subarray(0, Math.min(buffer.length, 64))
        .toString("ascii");
      if (/^Content-Length:/i.test(headerProbe)) {
        framingMode = "content-length";
        const sepIdx = buffer.indexOf("\r\n\r\n");
        if (sepIdx === -1) return;
        const headerText = buffer.subarray(0, sepIdx).toString("ascii");
        const m = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!m) {
          buffer = buffer.subarray(sepIdx + 4);
          continue;
        }
        const bodyLen = Number(m[1]);
        const totalNeeded = sepIdx + 4 + bodyLen;
        if (buffer.length < totalNeeded) return;
        const bodyStr = buffer
          .subarray(sepIdx + 4, totalNeeded)
          .toString("utf8");
        buffer = buffer.subarray(totalNeeded);
        try {
          void dispatchRpc(JSON.parse(bodyStr));
        } catch (err) {
          process.stderr.write(`[mcp-server] Parse error: ${err?.message}\n`);
        }
        continue;
      }

      // Otherwise treat as newline-delimited JSON-RPC
      const nlIdx = buffer.indexOf(0x0a); // '\n'
      if (nlIdx === -1) return;
      const lineStr = buffer.subarray(0, nlIdx).toString("utf8").trim();
      buffer = buffer.subarray(nlIdx + 1);
      if (!lineStr) continue;
      framingMode = "ndjson";
      try {
        void dispatchRpc(JSON.parse(lineStr));
      } catch (err) {
        process.stderr.write(
          `[mcp-server] Line parse error: ${err?.message}\n`,
        );
      }
    }
  }

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pumpBuffer();
  });

  process.stdin.on("end", () => {
    if (dbPromise) {
      dbPromise.then((db) => db.close()).catch(() => {});
    }
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startMcpServer();
}
