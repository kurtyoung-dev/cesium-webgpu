# 3D Tiles Patch and Invalidation Extension — Working Design and Research Tracker

**Status:** exploratory design; no extension name, schema, or compatibility contract is frozen.

**Started:** 2026-08-11

**Working family name:** `3D Tiles Patch + Invalidation`
**Initial standards vehicle:** optional vendor extension, with promotion considered only after two
interoperable implementations and benchmark evidence.

This document tracks the design of a lightweight, high-performance update system for frequently
changing 3D Tiles datasets. It records maintainer decisions, proposed wire/runtime architecture,
patch-versus-rebuild economics, invalidation and compaction semantics, unresolved questions, and
implementation milestones.

The north-star use case is a small change—such as flattening a hill and updating its imagery—that
can be produced, transferred, validated, and displayed without rebuilding the entire surrounding
tile hierarchy. Patches are temporary published state: they remain reachable and immutable while
referenced, then are compacted into a new immutable base revision. A compact invalidation control
plane makes the successor state visible quickly, retires superseded tiles and patches without a
visual hole, and eventually makes unreachable objects eligible for safe garbage collection.

---

## 1. Maintainer requirements and current decisions

### 1.1 Required qualities

The system must be:

- **Lightweight:** tiny discovery and manifest overhead; payload size proportional to the useful
  change wherever possible.
- **Powerful:** able to represent changes to geometry, topology, textures, materials, metadata,
  features, and surface regions through an extensible operation/codec registry.
- **Fast to produce:** avoid global retiling and recompression when a bounded change has a safe
  local representation.
- **Fast to transfer:** immutable, content-addressed payloads; CDN-friendly caching; no need to
  redownload an unchanged base.
- **Fast to apply:** spatially reject irrelevant patches, prepare resources off-screen, then make
  one atomic state transition. Specialized patches should support direct sparse GPU uploads where
  safe.
- **Self-optimizing:** quickly decide whether a patch is cheaper than rebuilding/replacing the
  affected tile or base revision.
- **Fast to invalidate:** notify connected clients of a successor generation with a tiny, idempotent
  event while retaining a complete-snapshot recovery path for cold, offline, or disconnected clients.
- **Correct across LOD:** old geometry must not reappear in authoritative/current output as
  screen-space error selects ancestors or descendants.
- **Safe under compaction:** publish and verify the rebuilt successor before superseding the old base
  and its ephemeral patches; never create a transient content hole.
- **Fail-closed:** a missing, corrupt, incompatible, or partially downloaded patch must never
  create a half-patched state.

### 1.2 Agreed decisions

1. Start as an **optional 3D Tiles vendor extension**.
2. Keep published base tiles and revisions **immutable**.
3. Publish **content-addressed, atomic patch state**, while keeping discovery and manifests small.
4. Start with a semantic **`replaceRegion`** operation using a spatial mask plus a replacement
   3D Tiles tileset. A GLB is wrapped as the content of a generated one-tile tileset.
5. Compact accumulated patches into a new base revision later.
6. Give datasets, base revisions, patch states, and patches explicit versions and UUIDs.
7. Do **not** ban vertex and texture patches. Treat them as highly optimized, typed codecs with
   strict preconditions rather than unstructured byte edits.
8. Include a constant-time/metadata-only first-stage estimator that chooses patch, replacement, or
   rebuild before expensive encoding begins.
9. Put patching and invalidation in **one live-update state model**, while keeping composition data,
   patch codecs, and transition notifications separate and independently bounded.
10. Make the immutable active-state snapshot authoritative. Push, Server-Sent Events (SSE), WebSocket,
    or polling events are low-latency **head-change hints**, never a second source of truth.
11. For ordinary supersession, publish the complete successor closure, verify it, atomically advance
    the head, and only then retire the old tile/base/patch closure. Physical deletion happens later
    after reachability and retention checks.
12. Keep `supersede`, `invalidate`, HTTP `revalidate`, client `retire`, security `revoke`, and server
    `garbageCollect` as distinct operations. “Invalidated” never implicitly means “bytes deleted.”
13. Give invalidation transitions their own UUID, stream epoch, monotonic sequence, target digest
    precondition, and successor state identity so duplicate, missing, replayed, and out-of-order
    events are harmless.
14. When a patch is economical, publish it first for low latency, then enqueue a configurable
    debounced/throttled durable rebuild; when it is not economical, rebuild directly without emitting
    a transient patch.
15. Let clients defer expensive patch realization for off-screen tiles and pre-bake from bounded
    camera/screen-space-error prediction. Local baking creates only a digest-keyed derived cache entry
    and never
    mutates the immutable base.
16. Keep HTTP/2/HTTP/3, WebSocket, gRPC, Server-Sent Events/polling, and producer/listener delivery behind
    transport-independent state/digest semantics.

### 1.3 Important naming caveat

The first interoperable operation is more accurately a **surface replacement overlay** than a raw
binary patch to one tile. “3D Tiles Patch + Invalidation” remains a useful working umbrella name
because later codecs can patch individual attributes, texture blocks, features, and quantized-mesh
samples while the same state model supersedes and retires obsolete generations.

---

## 2. Scope

### 2.1 Intended eventual coverage

The patch envelope should eventually be capable of updating:

- vertex attributes such as position, normal, tangent, color, and feature ID;
- indices and local topology;
- textures and selected mip/block regions;
- material values and texture bindings;
- feature metadata and feature visibility/deletion state;
- instances and transforms;
- bounded spatial regions through replacement content;
- regular or irregular terrain height samples;
- multiple affected tiles and LOD representations as one atomic change.

This does not mean one generic operation should manipulate all of these. The envelope is general;
each operation codec has narrow, testable invariants.

### 2.2 MVP scope

The first MVP is deliberately smaller:

- one immutable base revision;
- one small mutable head pointer;
- one immutable active-state manifest;
- one compact optional invalidation/head-change event shape;
- disjoint surface masks;
- one `replaceRegion` operation;
- one bounded semantic-suppression/tombstone operation for deliberate deletion without replacement;
- replacement content expressed as a valid one-tile or multi-tile 3D Tiles tileset;
- exact base-revision and payload identity;
- atomic activation/rollback;
- exact state/base/patch invalidation targets with duplicate and gap recovery;
- ordinary base-compaction supersession and safe client resource retirement;
- stale-base fallback for clients that ignore the optional extension;
- rendering and picking correctness first.

The MVP does not promise arbitrary solid-volume editing, collision/physics updates, analytics, or
Cesium quantized-mesh terrain support through the 3D Tiles extension itself.

### 2.3 Explicit distinction: 3D Tiles surface content versus Cesium terrain

Terrain delivered as glTF inside 3D Tiles can use the proposed 3D Tiles extension. Cesium's common
globe terrain path uses the separate quantized-mesh terrain format and a `layer.json` pyramid.
Independent imagery layers are separate again.

Therefore:

- `3D Tiles Patch + Invalidation` can directly patch terrain-like glTF content in a 3D Tiles dataset
  and supersede its prior state.
- Quantized-mesh needs a sibling patch codec/protocol or a future shared geospatial patch envelope.
- Independent imagery should normally be updated through the imagery service, with its revision
  activated atomically with the terrain/3D Tiles patch state.

### 2.4 Standards landscape and novelty confirmation

**Primary-source survey result as of 2026-08-11:** no published or registered 3D Tiles/glTF
extension, OGC 3D Tiles standard, or OGC API — Tiles conformance class defines a client-applied,
base-relative patch protocol with the combined semantics proposed here:

1. bind an update to an exact immutable base revision;
2. transfer only a semantic subset of changed tile content;
3. validate and compose that subset across tile and HLOD boundaries;
4. activate an atomic multi-resource state with rollback;
5. retain and later compact ephemeral patch generations;
6. notify clients that an exact prior state is superseded, without making event delivery authoritative;
7. retire and garbage-collect old closures under explicit safety rules; and
8. standardize a patch-versus-rebuild decision contract.

This is a bounded novelty claim about the current published standards and registered extensions—not
a claim that no private engine, I3S/scene service, coverage service, database, CDN, or proprietary
tiler has ever implemented incremental updates.

| Existing mechanism | What it provides | What it does **not** provide |
| --- | --- | --- |
| 3D Tiles `asset.tilesetVersion` and revisioned URIs | Application-specific version/cache invalidation | Partial-content delta, base precondition, atomic patch state, or composition semantics |
| 3D Tiles external tilesets and multiple contents | More independently referenced renderable content | Spatial subtraction/masking, replacement precedence, or patch lifecycle |
| 3D Tiles `ADD` / `REPLACE` refinement | Parent/child HLOD rendering behavior | Replacement of a polygonal subset across arbitrary active LODs |
| 3D Tiles implicit tiling | Stable implicit coordinates and compact availability | Modification of part of an existing content payload |
| Draft `3DTILES_content_conditional` | Selection among content variants by conditions such as revision/time | Base-relative deltas, masks, content-addressed patch state, or atomic partial mutation; it remains a draft |
| glTF sparse accessors | Sparse values differing from an accessor's initialization state inside one complete asset | Cross-version base identity, update discovery/distribution, atomic live patching, or tile/HLOD semantics |
| glTF morph targets, animations, and material variants | Authored alternate states within one asset | An external patch protocol or mutation of an already published asset |
| glTF `MPEG_scene_dynamic` and companion media extensions | Registered vendor mechanism for timed/circular-buffer scene-description update samples carried by media tracks | A 3D Tiles/HLOD spatial patch contract, exact immutable base/state head, client invalidation, atomic multi-resource publication, retention/compaction, or patch optimizer |
| Other current glTF extensions | Extensibility for geometry, compression, materials, animation, and other asset features | No registered general immutable-base patch/invalidation lifecycle with the combined semantics here |
| KTX Fragment URI | Standard addressing/retrieval of mip, layer, face, time, and spatial texture subresources | Mutation, predecessor/base identity, atomic multi-resource state, or 3D Tiles composition |
| Quantized-mesh extensions | Append optional normals, water mask, metadata, and related tile data | Replacement of existing vertices/topology, version chains, or atomic multi-tile patches |
| OGC API — Tiles Part 1 | Discovery and retrieval of complete tiled representations | Partial/delta update of a tile representation |
| OGC Testbed-15 Changesets Engineering Report | Experimental checkpoint, changed/deleted-resource lists, and packages of affected 2D tiles | An adopted standard, 3D Tiles subregion patches, immutable active-state composition, or atomic GPU/client activation |
| HTTP caching and HTTP Cache Groups | URI revalidation plus optional same-origin grouping/invalidation inside one cache | Authoritative dataset state, multi-cache synchronization, 3D tile selectors, atomic successor readiness, or object-retention/GC law |
| OGC CDB 2.0 versioning | File/table replacement and capture of transitory or ephemeral CDB asset state | A 3D Tiles patch/invalidation protocol, spatial content delta, or client atomic-state compositor |
| OGC CityGML 3.0 Versioning | Predecessor/successor city-model versions and transactions describing feature creation, termination, and modification | A 3D Tiles/HLOD delivery patch, immutable tile-state head, client invalidation/activation, or patch-compaction protocol |
| OGC APIs that use HTTP `PATCH` | Server-side CRUD/update of API resources in their own domains | A client-consumable 3D Tiles/glTF content-delta format or HLOD compositor |
| OGC WCS Transaction (`WCS-T`) | Insert, delete, or update parts of a server's coverage offering | A patch wire format for 3D Tiles/glTF clients, HLOD composition, or immutable patch-state delivery |
| OGC I3S and scene-service update workflows | Prior art for streaming 3D scene data and republishing/updating service-side scene layers | A registered 3D Tiles/glTF base-relative patch extension with the semantics defined here |
| HTTP delta encoding / VCDIFF | Transfer a byte delta and reconstruct a complete target representation | Semantic vertex/texture operations, GPU-direct application, HLOD correctness, or patch state |

The closest typed sparse-data building block is glTF's sparse accessor, and it is useful input to a
future `sparseAttributeOverride` codec. It is not itself a patch protocol: the sparse data is authored
as part of the glTF asset, and the glTF specification defines neither an external predecessor/base
contract nor update publication, ordering, atomicity, rollback, cache lifetime, or compaction.

`MPEG_scene_dynamic` is important update-stream prior art rather than a duplicate of this proposal.
It binds timed scene-description updates to media tracks and circular-buffer access. This design
should study its timing/stream model, but still needs independent 3D Tiles selectors, HLOD masking,
immutable head/state reconciliation, invalidation, offline recovery, retirement, and compaction.

The closest active 3D Tiles effort is the draft `3DTILES_content_conditional`, whose proposal
explicitly generalizes earlier time-dynamic 3D Tiles work. It may eventually help select a revision or
time state, but it does not spatially mask stale base content or deliver a relative update.
Conditional content could select among fully materialized per-tile variants. Selecting an active
patch-state manifest would require an integration extension or a change to the current draft.

Accordingly, the survey found no existing standardized feature that duplicates this proposal's full
contract. Specifically, as of 2026-08-11, no adopted 3D Tiles, glTF, or OGC API — Tiles standard—and
no registered 3D Tiles or glTF extension—defines the proposed combination of spatial sub-tile
replacement, immutable versioned state, client-visible supersession/invalidation, atomic activation,
compaction, and retention-safe garbage collection. It occupies a missing layer between immutable
tiled assets and application-specific update systems while deliberately reusing prior art for sparse
data, subresource retrieval, checkpoint recovery, HTTP validation, server-side transactions,
conditional selection, and byte-delta transport.

### 2.5 Compatibility with adjacent formats and mechanisms

The extension is designed to compose with these mechanisms, but “cleanly” has different meanings for
semantic replacement, typed direct application, and transport-only deltas.

| Mechanism | Compatibility | Required rule |
| --- | --- | --- |
| glTF sparse accessors | **Yes** | A replacement tileset may contain ordinary sparse accessors. A direct `sparseAttributeOverride` binds the exact base/layout digest and may reuse the sparse index/value model, but a glTF sparse accessor by itself cannot refer to an accessor in a different published asset. |
| glTF morph targets | **Yes, with provenance** | `replaceRegion` is transparent. Directly changing base or morph-target attributes requires exact primitive/accessor identity, consistent normals/tangents and bounds, and one atomic resource generation. Morph targets remain authored deformation, not patch history. |
| 3D Tiles implicit tiling | **Yes for overlays** | `replaceRegion` composes above the base tree and does not modify subtree availability. Per-content typed patches use exact implicit `(level,x,y[,z])` plus base/content identity. Hierarchy or availability changes publish a new base revision. |
| Draft `3DTILES_content_conditional` | **Independent, potentially complementary** | Do not require this draft for the MVP. It may select complete materialized variants. Selecting patch-state manifests or nesting external replacement tilesets would require explicit future integration and whatever the final conditional-content standard permits. |
| HTTP delta encoding / VCDIFF | **Yes as a transport codec** | Bind exact source and target digests, reconstruct the whole immutable target off-thread, verify it, then use the normal loader. This does not replace semantic patch/HLOD rules, and deployment must not assume every CDN/browser implements HTTP delta negotiation. Immutable delta objects fetched with ordinary `GET` are the portable baseline. |
| Quantized-mesh extensions | **Yes through a sibling terrain profile, not the 3D Tiles extension itself** | Preserve and validate all appended extensions. Geometry-dependent normals must be patched or recomputed; water/metadata are preserved or separately replaced. Unknown geometry-dependent extensions force whole-tile replacement unless their invariants are declared. |

#### glTF sparse accessors

Sparse accessors are a natural payload building block because they provide sorted indices and values
that differ from an initialized accessor. Two integration modes are valid:

1. Put a complete standards-conformant sparse accessor in replacement glTF content.
2. Reuse the sparse index/value representation in `sparseAttributeOverride`, with additional external
   base identity, layout, atomicity, derived-data, and HLOD requirements defined by this extension.

The second mode is not itself an ordinary glTF sparse accessor because core glTF does not let one
asset's accessor inherit data from an accessor in another immutable asset.

#### glTF morph targets

Morph targets continue to operate normally inside base or replacement content. A direct patch may:

- change the base attribute while retaining existing morph deltas;
- change sparse/dense morph-target deltas;
- change initial morph weights or animation data.

The producer must model the resulting deformed bounds and update every dependent stream. A patch may
not use morph targets as an implicit update log unless the complete intended runtime deformation is
actually part of the published asset semantics.

#### Implicit tiling

The overlay design is intentionally tree-agnostic. It masks the rendered base surface in a common
world frame and traverses an independent replacement tileset, so explicit and implicit base tiles can
share the same compositor. Typed patches target implicit contents by stable coordinates plus exact
resource identity; they do not rewrite subtree availability in place.

#### Conditional content

Conditional content and patching solve different problems:

- conditional content chooses among complete authored contents;
- patching derives and atomically composes a new state relative to an immutable base.

They can be complementary, but the MVP must not depend on an unsettled draft. Any later integration
needs explicit rules for URI resolution, required-extension behavior, selection precedence,
replacement readiness, and nested/external content support.

#### HTTP deltas

HTTP/VCDIFF-style byte deltas can make transfer exceptionally small when a client has the exact base
resource. They are safely nested under `binaryResourceDelta`; the semantic manifest still determines
which dataset state the reconstructed resource belongs to. If the source digest is unavailable or
wrong, the client downloads the complete immutable target or another materialized fallback.

#### Quantized-mesh extensions

Quantized-mesh permits appended extension records such as encoded normals, water masks, and metadata.
A terrain height patch cannot ignore them:

- encoded normals are geometry-dependent and must be supplied again or recomputed;
- water masks may remain unchanged or be replaced as a separate typed stream;
- metadata may remain unchanged only when its declared semantics remain true;
- unknown extensions are preserved only when declared geometry-independent;
- length/offset changes are handled by reconstructing a complete verified terrain resource rather
  than mutating unknown trailing bytes in place.

This is clean at the shared patch-envelope/state level, but it requires a quantized-mesh-specific
codec and conformance suite.

---

## 3. Proposed architecture

```text
ordinary immutable tileset.json
          |
          +-- optional VENDOR_* extension
                    |
                    v
             tiny mutable head  -- ETag/revalidate
                    |
                    v
       immutable active-state manifest
          |         |          |
          |         |          +-- replacement tilesets (including one-tile GLB wrappers)
          |         +------------- typed patch payloads
          +----------------------- exact immutable base revision

 source changes --> patch/rebuild producer --> upload + verify immutable closure
                                                   |
                                                   v
                                      compare-and-swap tiny head
                                                   |
                    +------------------------------+---------------------------+
                    |                                                          |
                    v                                                          v
       optional invalidation/head-change hint                       cold/gap recovery GET
                    |                                                          |
                    +----------------------> revalidate head <------------------+
                                                   |
                                                   v
                                  prepare + atomic client activation
                                                   |
                                                   v
                                    retire old CPU/GPU generation

                       later compaction
                              |
                              v
                    new immutable base revision
                              |
                              v
                 delayed reachability-based garbage collection
```

### 3.1 Two data layers plus one control plane

The design separates **composition semantics** from **payload codecs**, then adds a tiny notification
plane that accelerates reconciliation without becoming authoritative.

#### Layer A — semantic composition

Defines what the resulting dataset means:

- which immutable base revision is required;
- which bounded region or logical target is replaced;
- which patch state is active;
- ordering, supersession, readiness, and rollback;
- how base and replacement content compose across all LODs.

`replaceRegion` belongs here. It is the universal safe fallback.

#### Layer B — specialized payload codecs

Defines efficient representations when the base was built with stable update provenance:

- `sparseAttributeOverride`;
- `textureBlockReplace`;
- `binaryResourceDelta`;
- `featureMetadataOverride`;
- `instanceTransformOverride`;
- `quantizedMeshHeightOverride`;
- `submeshReplace`.

Each codec declares hard compatibility conditions. If any condition fails, the producer falls back
to `replaceRegion`, whole-content replacement, or rebuild.

#### Control plane — invalidation and revision transitions

Defines how a connected client learns that its exact state may no longer be current:

- the predecessor state digest and successor generation/digest;
- an idempotent invalidation UUID plus stream epoch/sequence;
- optional exact tile, subtree, region, patch, or resource hints;
- ordinary supersession versus hard revocation;
- gap recovery through the tiny head and complete state snapshot;
- bounded rollout, readiness, retirement, and diagnostics.

The control plane does not mutate immutable objects, authorize a partially downloaded state, or
require delivery of every event. Its only ordinary action is to trigger reconciliation against the
authoritative head. A cold client never needs the event history.

### 3.2 Why this split matters

It satisfies both goals:

- The extension can eventually update nearly any useful part of a tile.
- An unsafe low-level delta can never be mistaken for a valid patch merely because its byte offsets
  happen to fit.
- Lost, duplicated, delayed, or reordered notification events cannot change the meaning of the
  dataset because the complete immutable state snapshot remains authoritative.

### 3.3 Repository prior art and compatibility boundary

This repository already contains useful invalidation research and a Phase-1 experimental engine
path:

- the archived [Live 3D Tiles Invalidation design](archive/SESSION_2026-04-08_RESEARCH_REPORT.md#6-live-3d-tiles-invalidation--final-design);
- [`Cesium3DTilesInvalidationFeed`](../packages/engine/Source/Scene/Cesium3DTilesInvalidationFeed.js)
  and its pluggable producer adapters;
- [`TilePathResolver`](../packages/engine/Source/Scene/TilePathResolver.js) with child-index, quadkey,
  Morton, and level/XY addressing;
- Cesium's existing expired-content handoff, which can keep old content visible until replacement is
  ready; and
- the `Scene._snapshotVersion` hook that wakes frozen/snapshot rendering after an update.

The following ideas should be retained:

- transport-independent adapters;
- exact-tile versus subtree distinction;
- layer routing and unknown-layer no-op behavior;
- bounded, visible-first zero-flicker replacement;
- multi-content support;
- monotonic IDs, duplicate suppression, and gap recovery; and
- snapshot/render-cache invalidation after one committed logical transition.

The current engine feed is not the standards contract. It presently applies to in-memory tiles,
does not use parsed message IDs for durable deduplication or gap recovery, does not carry producer
extents through the normalized set, skips multi-content tiles, only logs `tileset.json` refresh, and
does not implement the proposed bounded rollout. Its legacy mutable-URI cache-bust path is also not
the immutable publication model proposed here. Treat it as an implementation adapter/prototype to be
hardened, not as proof that the extension lifecycle is complete.

The clean migration is to translate legacy path messages into base-scoped typed hints that trigger
head reconciliation. A `refreshMutableUri` compatibility profile may preserve existing producer
deployments, but URL globs and cache-busting tokens should not become normative update identities.

### 3.4 Source-driven rapid iteration loop

This is the canonical end-to-end flow. The low-latency patch path and durable rebuild path are two
stages of one source-driven pipeline, not competing long-term storage models:

```text
source change + updateId/sourceRevision
                |
                v
bounded localization + constant-time heuristics
                |
       +--------+--------------------+
       | patch is economical         | patch is not economical/safe
       v                              v
build/publish patch state       rebuild affected content/tile/subtree
       |             \                |
       |              +--> notify/distribute --> non-blocking client apply (ends)
       v                              |
durably enqueue debounced rebuild     |
       +---------------+--------------+
                       v
        publish immutable rebuilt content + successor state
                       |
                       v
     notify -> prepare -> atomic client switch -> retire patches/old tile
```

Every source change gets a stable logical `updateId`. An immutable patch or tombstone revision binds
a canonical, nonempty `updateLineage` array of `{updateId, sourceRevision}` records; the common case
has one member, while bounded coalescing retains every incorporated logical change and its source
checkpoint. Re-encoding those changes against a compacted base produces a new patch/tombstone
revision and digest without losing source lineage. The fast path is proportional to the localized
change; the safe fallback may rebuild one content/subtree while reusing every unchanged
content-addressed resource. Only topology, availability, bounding-volume, or economic boundaries
force a broader base publication.

#### 3.4.1 Producer decision and patch-first path

1. **Record and localize the source change.** Assign `updateId`/`sourceRevision`, compute a bounded
   affected feature/region/tile/LOD summary, and perform no full-tile scan in the fast estimator.
2. **Run the patch-versus-materialization heuristics.** Correctness gates run first. The cost model
   then decides whether a typed patch/`replaceRegion` is materially cheaper than rebuilding the
   affected content, tile set, or subtree. `NO_OP`, bounded coalescing, and semantic suppression are
   explicit outcomes; “patch” is never chosen solely because its wire payload is small.
3. **If patching wins, publish it first.** Build and verify the immutable patch closure, publish the
   complete active state, CAS the tiny head, then emit the low-latency update. Only after that head
   commit is the durable rebuild/compaction job eligible to start. The producer never waits for every
   client to acknowledge or apply the patch—an unbounded global acknowledgement barrier would stall
   the source pipeline.
4. **If patching loses, rebuild directly.** Produce the smallest complete materialized result that
   preserves correctness: one content, affected tiles, an affected subtree, or a new base revision.
   This direct result is already the durable rebuild; do not also create a transient patch.

HTTP/2 immutable object fetches, WebSocket messages, gRPC streams, and in-process/producer listeners
are transport profiles for the same identities. A transport may push a tiny hint, state manifest, or
bounded payload bytes, but it never becomes a second authority: the client verifies the head/state,
base precondition, closure digests, generation, and limits before activation. Browser deployments will
normally use HTTP/2 or HTTP/3 for content-addressed bulk objects and SSE/WebSocket/polling for hints;
gRPC and listeners are natural for native, edge, or producer-to-distributor deployments.

Rebuild scheduling is durable and idempotent. Before or alongside the patch-head advance, persist an
intent keyed by `(datasetId, committedStateDigest, affectedTargetSetDigest)`; only a successful head
CAS makes it eligible. If the publication backend cannot transact the outbox and head together, a
recovery scan of active uncompacted patch states recreates missing intents after a crash. Duplicate
delivery/enqueue is harmless, and completion records bind the exact absorbed lineage/base result.

#### 3.4.2 Visibility-aware client preparation and local baking

Receiving a newer verified state is immediate; expensive realization may be demand-driven:

- If the affected tile contributes to the current frame, prepare and atomically apply the patch as
  soon as its state-control closure and visible activation frontier are ready.
- If it is off-screen, fetch and verify the small mandatory patch descriptor/selector index, but defer
  heavy payload fetch, decode, GPU upload, and compositor work until demand is plausible. An off-screen
  stale tile may remain cached. If it becomes visible before the heavy payload is ready, a
  **stale-compatible/degraded profile** may explicitly render the complete coupled predecessor
  component group but forfeits authoritative currentness, cross-generation atomicity, and the
  no-old-geometry guarantee. It cannot mix old terrain with new imagery/object companions. A
  required/current profile instead suppresses/withholds the entire coupled target group until the
  patch or compatible materialized successor is ready; it never presents the predecessor as current.
- A bounded pre-bake predictor may start work before visibility using camera position/direction/
  velocity, distance, predicted screen-space error, traversal/refinement likelihood, measured network
  and decode latency, and CPU/GPU memory headroom. Hysteresis and per-frame budgets prevent camera
  jitter from thrashing work.
- “Bake into the local tile” means create an evictable derived composite/cache entry keyed by exact
  `(stateDigest, baseDigest, patchRevisionIds, codec/profile versions)`. It never mutates the immutable
  downloaded base, changes server identity, or becomes authoritative. The entry may be CPU materialized,
  GPU sparse-updated, or compositor-backed according to the codec and cost model.
- If a newer rebuilt tile becomes authoritative before an off-screen patch is realized, skip the
  obsolete bake and prepare the newest generation directly.

#### 3.4.3 Configurable rebuild debounce, throttle, and maximum wait

A successful patch schedules eventual materialization, but rapid edits should not rebuild the same
tile after every patch. The producer maintains a bounded per-content/tile/subtree rebuild accumulator
and a global work scheduler. A deployment profile configures at least:

- `quietPeriod`: trailing-edge debounce after the latest incorporated source change;
- `maxWait`: maximum age before a rebuild attempt, so continuous edits cannot postpone compaction
  forever;
- maximum active patch count, bytes/base-byte ratio, overlap/compositor depth, and persistent
  CPU/GPU frame cost per affected tile/bin;
- maximum lineage/tail work, patch age, and offline closure size;
- maximum concurrent rebuilds plus producer CPU/memory/IO budgets; and
- rebase-throughput, CAS-retry, and writer-fence caps for a hot source stream.

Each new patch resets only the quiet-period timer, never `maxWait` or the oldest freshness deadline.
Crossing any correctness, memory, runtime, chain-depth, or maximum-age threshold promotes rebuild
immediately subject to the global throttle. When measured update arrival exceeds bounded rebase
throughput, the scheduler defers compaction rather than starving live updates, then retries after a
quiet window or capacity increase. Policies and defaults are configurable and telemetry-backed;
correctness gates and retention laws are not configurable away.

`maxWait` guarantees an aged job a scheduled **attempt**, not successful completion when sustained
arrival exceeds safe rebase capacity. The global scheduler uses age/fair-share priority so one hot
tile cannot starve unrelated targets, reports repeated deferrals and oldest-job age, and raises an
operator/capacity alert when the deployment's maximum deferral or patch-debt budget is exceeded. It
still never violates a writer-fence, memory, or correctness cap merely to meet a timer.

#### 3.4.4 Rebuilt-tile publication and patch invalidation

After the direct or patch-delayed rebuild completes, the producer:

1. derives the exact replacement/base closure and surviving post-fence patch/tombstone tail;
2. pins, uploads, and verifies the immutable closure;
3. publishes a complete successor state that references the rebuilt content and omits incorporated
   patches;
4. CAS-advances the head and sends the same transport-independent invalidation/head-change hint; and
5. leaves old tile and patch objects available through retention/lease/grace windows.

The client does not discard the patched visual result when it hears the hint. It prepares the rebuilt
tile immediately when visible or predicted, or lazily when off-screen; then atomically switches from
the patched generation to the rebuilt generation. Only after submitted work is safe does it retire
the old base/patch-derived CPU/GPU state. Server garbage collection is a later reachability decision.

---

## 4. Lightweight identity and version model

UUIDs identify logical objects; digests identify exact bytes. Both are needed.

| Field | Purpose |
| --- | --- |
| `datasetId` | Stable UUID for the logical dataset across every compaction. |
| `componentId` | Stable identifier for one state component/profile, such as a 3D Tiles surface, imagery layer, collision layer, or metadata/query companion. |
| `baseRevisionId` | UUID for one immutable base publication. Prefer time-sortable UUIDv7. |
| `baseUri` | URI of the immutable component-profile root descriptor; the 3D Tiles profile points to `tileset.json`. |
| `resourceManifestUri` | URI of the immutable transitive-resource/Merkle manifest for the base. |
| `resourceManifestDigest` | Digest binding the manifest that identifies base JSON, external tilesets, subtrees, GLBs, buffers, images, and other transitive resources. |
| `baseDigest` | Digest of the canonical base-revision descriptor, which includes `componentId`, `baseRevisionId`, root identity, and resource-manifest identity. This one digest therefore binds both logical revision and exact bytes. |
| `generation` | Monotonically increasing uint64 state generation, encoded in the JSON profile as its canonical unsigned decimal string. |
| `stateRevisionId` | UUIDv7 for one published logical state revision; the complete state is the atomic activation unit across its components. |
| `stateDigest` | Digest of the canonical active-state manifest; carried by the head/URI and never serialized inside the hashed manifest. |
| `sourceDomainId` | Stable identifier for the source revision/order domain and its comparison profile. |
| `sourceRevision` | Producer/source checkpoint against which a base or logical update was materialized. Its domain and ordering are declared separately from state `generation`. |
| `updateId` | Stable UUID for one logical source change across patch encodings, rebases, and later compaction. |
| `updateLineage` | Canonically sorted, duplicate-free, bounded array mapping every incorporated logical `updateId` to its source-domain `sourceRevision`. A one-element array is ordinary. |
| `patchRevisionId` | UUIDv7 for one immutable encoding of an update set against one exact base/layout. Rebasing creates a new value. |
| `descriptorDigest` | Cryptographic identity of the mandatory small patch descriptor/selector record. |
| `payloadDigest` | Cryptographic identity of the heavy patch payload bound by that descriptor. |
| `tombstoneId` | Stable UUID for one logical semantic suppression across rebases. |
| `tombstoneRevisionId` | UUIDv7 for one immutable, exact-base-scoped encoding of a tombstone. Rebasing creates a new value. |
| `revocationId` | UUIDv7 for one authenticated hard-revocation record in the optional required security profile. |
| `fallbackId` | Stable identifier for one in-state materialized fallback representation. |
| `updateEpochId` | UUID identifying one ordered transition-stream epoch; changes when sequence continuity is intentionally reset. |
| `invalidationId` | UUIDv7 identifying one logical invalidation/supersession transition and serving as its idempotency key. |
| `sequence` | Monotonic unsigned invalidation sequence within `updateEpochId`, used only for deduplication and gap detection. |
| `supersedesStateDigest` | Exact predecessor-state precondition for a transition; never inferred from timestamps or bare URIs. |
| `parentStateDigest` | Optional transition/audit metadata naming the predecessor; not required to load a cold latest-state snapshot. |
| `createdAt` / `expiresAt` | Lifecycle metadata; expiry never permits deletion while referenced. |
| `compactedThroughSourceRevision` | Source checkpoint incorporated into a newer base. It is never interpreted as a state generation; if the source has no total order, compaction binds a bounded exact update-ID set or its content-addressed Merkle root instead. |
| `retainUntil` | Guaranteed-availability deadline for a retained state or closure. It is a lower bound on retention, never proof that reachability or client leases have ended. |

UUIDs alone do not prove content integrity. Digests alone are poor human/operational identifiers.

### 4.1 Tiny mutable head

The frequently revalidated object should remain on the order of hundreds of bytes, not contain the
full patch history:

```json
{
  "v": 1,
  "datasetId": "0198a9b2-9d25-7d91-a92e-687596290c61",
  "generation": "42",
  "stateRevisionId": "0198a9b3-a81f-76e4-a607-ad83ce85772f",
  "stateDigest": "sha256:...",
  "stateUri": "states/sha256-...json",
  "updates": {
    "updateEpochId": "0198a9b4-77b4-729c-8b17-e95b338cfa27",
    "sequence": "1842"
  }
}
```

This object is mutable and served with a strong ETag and revalidation policy.

### 4.2 Immutable active-state manifest

The state manifest describes only active patches, not every historical operation:

```json
{
  "formatVersion": "1.0",
  "datasetId": "0198a9b2-9d25-7d91-a92e-687596290c61",
  "generation": "42",
  "stateRevisionId": "0198a9b3-a81f-76e4-a607-ad83ce85772f",
  "requiredCapabilities": [
    "component:3d-tiles@1.0",
    "component:imagery-revision@1.0",
    "operation:replaceRegion@1.0"
  ],
  "materializedFallbacks": [],
  "transition": {
    "parentStateDigest": "sha256:...",
    "invalidationId": "0198a9b3-abe7-78dd-98c0-62eecb15951f",
    "reason": "patchPublication"
  },
  "sourceDomains": [
    {
      "sourceDomainId": "authoring-main",
      "ordering": "total",
      "revisionProfile": "opaque-decimal-v1",
      "default": true
    }
  ],
  "components": [
    {
      "componentId": "surface-elevation",
      "profile": {
        "id": "3d-tiles",
        "version": "1.0"
      },
      "base": {
        "baseRevisionId": "0198a98b-cf0e-73b4-b7a1-397f70073946",
        "sourceRevision": "source:918273",
        "baseUri": "bases/0198a98b/tileset.json",
        "resourceManifestUri": "bases/0198a98b/resources.merkle.json",
        "resourceManifestDigest": "sha256:...",
        "baseDigest": "sha256:terrain-base"
      },
      "patches": [
        {
          "updateLineage": [
            {
              "updateId": "0198a9b1-aabc-716c-8f91-433af33c4c7e",
              "sourceRevision": "source:918274"
            }
          ],
          "patchRevisionId": "0198a9b2-685a-7d31-9888-c65dd67fc2de",
          "baseDigest": "sha256:terrain-base",
          "descriptorUri": "objects/sha256/terrain-patch-descriptor.json",
          "descriptorDigest": "sha256:terrain-patch-descriptor",
          "bounds": {
            "region": [-1.31, 0.69, -1.30, 0.70, 120, 190]
          }
        }
      ],
      "tombstones": [],
      "revocations": []
    },
    {
      "componentId": "surface-imagery",
      "profile": {
        "id": "imagery-revision",
        "version": "1.0"
      },
      "base": {
        "baseRevisionId": "0198a98c-7d4f-78b1-8169-c815d33ce5f1",
        "sourceRevision": "source:918273",
        "baseUri": "imagery/0198a98c/layer.json",
        "resourceManifestUri": "imagery/0198a98c/resources.merkle.json",
        "resourceManifestDigest": "sha256:...",
        "baseDigest": "sha256:imagery-base"
      },
      "patches": [
        {
          "updateLineage": [
            {
              "updateId": "0198a9b1-aabc-716c-8f91-433af33c4c7e",
              "sourceRevision": "source:918274"
            }
          ],
          "patchRevisionId": "0198a9b2-dd72-7456-85b8-9cae1d5c476a",
          "baseDigest": "sha256:imagery-base",
          "descriptorUri": "objects/sha256/imagery-patch-descriptor.json",
          "descriptorDigest": "sha256:imagery-patch-descriptor",
          "bounds": {
            "region": [-1.31, 0.69, -1.30, 0.70, 120, 190]
          }
        }
      ],
      "tombstones": [],
      "revocations": []
    }
  ]
}
```

The `transition` object is optional provenance for an incremental handoff. A cold client may fetch
the latest head, verify the referenced state manifest directly, and materialize it without walking
any predecessor chain. The head's `stateDigest` and content-addressed `stateUri` bind the manifest;
including that digest inside the hashed document would be circular.

Every `sourceRevision` is interpreted only through its bound `sourceDomainId`. The state's
duplicate-free `sourceDomains` registry defines canonical revision encoding/comparison and whether
the order is total, partial, or exact-set-only. A one-domain state may declare one default inherited
by component/base/update-lineage records; a multi-domain state names the domain explicitly on each
record. Watermarks, prefix compaction, and tail partitioning are per domain, and revisions from
different domains are never compared. Partial/exact-set domains use bounded ID sets or Merkle roots
rather than inventing an order.

Each `componentId` is unique in the state. A component profile is identified by an exact, versioned
`{id, version}` pair; an unknown version is an unknown profile, not an assumed compatible revision.
The complete `stateRevisionId` is one atomic semantic unit: every changed component must verify and
meet the bounded activation frontier before any of them commits. Independent changes that should not
wait for each other are published as separate state generations; coupled terrain/imagery/object
changes share one state. A one-component tileset is simply a one-element `components` array.
Component profiles may be standardized separately, allowing 3D Tiles, imagery, quantized mesh,
collision, and query data to share state identity without pretending their payload formats are
identical.

`requiredCapabilities` is the duplicate-free exact union needed to interpret the state's primary
representation.
A capability suffix such as `@1.0` is an exact profile version in the MVP, not an implicit semver
range; a later negotiation profile may define compatible ranges explicitly.
A client missing one retains the predecessor or selects a compatible `materializedFallbacks` entry
that is already bound inside this same authoritative state manifest. A fallback names an exact
alternate component/closure descriptor, its digest, semantic/output identity, and its smaller
capability set; it is not an alternate state manifest and therefore cannot conflict with the head's
single `stateDigest`. A profile may be marked ignorable only when it cannot affect any claimed
rendering/query/currentness result and is not needed by another component. Unsupported required
members are never partially ignored, and an unknown required component/profile rejects the whole
atomic state unless such an in-state fallback is compatible and ready.

Each component resource manifest binds its transitive immutable base closure. It may be a flat digest
list for small datasets or a Merkle tree for large ones, allowing a client to verify touched resources
without downloading or hashing the entire base. Changing any bound resource publishes a new base
revision for that component. Replacement tilesets bind their complete transitive closure through the
same mechanism. The digest domain, canonical resource record, media type, byte length, content
encoding, and negotiated representation rules must be normative.

Every active patch separates a small mandatory descriptor from its potentially heavy payload. The
descriptor contains the exact operation type, component/base target, selector/mask, canonical write
set, payload and closure digests/URIs, capability requirements, and conservative bounds. It is fetched
and verified with the state-control closure so the client can build a complete loaded/future-loaded
selector index without downloading off-screen geometry or texture bytes. For small states it may be
inlined; for larger bounded states it is a content-addressed descriptor/index shard. Heavy patch,
replacement, and codec resources remain demand-loadable. A coarse `bounds` field alone is only an
acceleration hint and never sufficient to suppress stale content.

Ordinary superseded states and patches are omitted from a newer active-state snapshot; the manifest
does not accumulate update history. Per-component `tombstones` contains bounded active semantic
suppressions. `revocations` is reserved for a future authenticated hard-revocation profile; a core
client that does not implement that required profile rejects a nonempty list. Neither is a general
audit log, and both must be compacted or sharded under explicit limits.

Every tombstone record carries `tombstoneId`, `tombstoneRevisionId`, exact component `baseDigest`,
canonical `updateLineage`, target/write set, and the semantic absence it asserts. A base compaction
partitions incorporated versus tail lineage exactly as it does for patches: incorporated suppression
is materialized into the new base, an empty tail record is omitted, and a surviving tail receives a
new base-scoped tombstone revision. Deletions therefore cannot disappear or remain accidentally bound
to the predecessor base.

#### Deterministic active-operation law

The active operation set is not an imperative log and JSON array order has no semantic effect:

- every patch and tombstone binds one exact component base digest and declares a canonical
  target/write set;
- typed MVP overrides contain absolute result values/blocks/resources, not order-dependent additive
  mutations;
- independent MVP patch and tombstone write sets must be disjoint. Two independent patches,
  patch-versus-tombstone, or two nonidentical tombstones that overlap the same semantic element,
  texture block, content slot, or mask interior conflict unless the successor state omits/supersedes
  one;
- byte-identical duplicate tombstones normalize to one stable `tombstoneId`/target identity;
- every reconstructed resource has an exact expected output digest;
- a future dependency profile may permit same-target overlap only inside a bounded acyclic
  `dependsOnPatchRevisionIds` graph with exact input/output digests at every edge. That graph—not
  manifest order—defines deterministic execution; unrelated overlap still rejects; and
- state membership defines readiness/commit coupling, not patch precedence;
- when the future authenticated revocation profile is enabled, a verified revocation has fixed
  fail-closed dominance over any patch or tombstone targeting the revoked digest. This is profile
  semantics, not list order.

These rules make a cold load deterministic and prevent the same active snapshot from producing
different bytes after list reordering. The first `replaceRegion` profile requires disjoint **closed**
masks, including boundaries and transition collars; typed codec schemas must expose equally precise
write-set conflict tests.

Canonical state serialization sorts every semantically unordered component, patch, tombstone,
revocation, capability, fallback, and `updateLineage` array by its specified identity key before
hashing.
RFC 8785 canonicalizes JSON syntax but does not sort arrays, so this extension/profile must define
those keys. A noncanonical reordering may reconstruct the same output but is rejected or normalized
before computing `stateDigest`; it cannot create a second digest for the same logical state.

| Array | Canonical ascending key/comparator |
| --- | --- |
| `components` | UTF-8 byte order of unique `componentId`. |
| `sourceDomains` | UTF-8 byte order of unique `sourceDomainId`; at most one entry is `default`. |
| `patches` | RFC 4122 network-byte order of unique `patchRevisionId`. |
| `tombstones` | RFC 4122 network-byte order of unique `tombstoneRevisionId`. |
| `revocations` | RFC 4122 network-byte order of unique `revocationId`. |
| `requiredCapabilities` | UTF-8 byte order of the unique complete exact capability string; duplicates are invalid. |
| `materializedFallbacks` | UTF-8 byte order of unique `fallbackId`. |
| `updateLineage` | RFC 4122 network-byte order of unique `updateId`; ties are invalid. |

UUID strings are lowercase canonical text on the wire and compare by their decoded 16 network-order
bytes. Component profiles define canonical ordering for any additional semantically unordered arrays.

#### Logical atomicity and bounded readiness frontier

Atomic activation does not require downloading an entire replacement tileset or every off-screen
member descendant. The producer/state profile distinguishes:

- **state-control closure:** state/component metadata plus every exact patch/tombstone
  descriptor/selector/write set, payload/closure identity, and capability rule needed to prevent any
  stale loaded or future-loaded target from contributing;
- **activation frontier:** the heavy patch/replacement roots and current visible/contributing coverage
  needed to commit the globally atomic state without a hole or mixed component result; and
- **lazy closure:** verified content-addressed heavy payloads, descendants, and off-screen resources
  loaded later under the already-committed generation.

The complete state-control closure and all heavy resources in the current bounded activation frontier
must be ready together. After commit, an unloaded/off-screen member can resolve only from the new
generation; stale loaded content may remain cached but cannot re-enter **as** the new generation. An
explicitly stale-compatible/degraded profile may render a separately identified predecessor, but that
output uses the complete coupled predecessor component group and is outside the required/current
atomic-state guarantee. A required/current profile withholds the complete coupled target group until
its new frontier is ready. This preserves authoritative semantic atomicity without fetching every
off-screen payload or creating unbounded double residency.

For very large active patch sets, the same logical schema may be encoded as a compact binary index
or spatially partitioned manifest. JSON is preferred for the MVP because its operational simplicity
and debuggability outweigh small encoding savings at low patch counts.

### 4.3 Content-addressed storage law

- Immutable base, state, and patch URLs may be cached for a long period with `immutable` semantics.
- Only the tiny head is mutable.
- A patch is ephemeral only in **reachability**. A referenced immutable object cannot be deleted.
- Compaction publishes a new base before advancing the head.
- Old bases and patches remain available for at least the maximum cache/offline retention window.
- Logical invalidation changes authority and reachability; it does not rewrite or purge a
  content-addressed object.

### 4.4 Invalidation, supersession, and revision transitions

The extension family has one state authority and may expose many notification transports. An enabled
tileset discovers the authoritative head through a small bootstrap object. The following is the
relevant fragment; a complete 3D Tiles entrypoint also lists the vendor name in `extensionsUsed` and,
when current-state behavior is mandatory, in `extensionsRequired`:

```json
{
  "extensions": {
    "VENDOR_3d_tiles_live_update": {
      "version": "1.0",
      "datasetId": "0198a9b2-9d25-7d91-a92e-687596290c61",
      "headUri": "updates/head.json",
      "fallback": "staleBase"
    }
  }
}
```

The final vendor name is intentionally unfrozen. If current/revoked-state behavior is required for
correct rendering, the extension must also appear in `extensionsRequired`; an optional-to-ignore
extension can promise only a valid but potentially stale base.

#### Normative terminology

| Term | Meaning |
| --- | --- |
| `supersede` | Publish a verified successor state and stop treating the predecessor as current when the successor atomically activates. |
| `invalidate` | Signal that an exact logical state or target must not be assumed current and that the authoritative head must be reconciled. It is not deletion. |
| `revalidate` | Perform HTTP validation of the mutable head, normally with a strong ETag and conditional `GET`. |
| `suppress` | Intentionally make selected content absent without replacement; persist this semantic result as an active tombstone/mask in the state snapshot. |
| `revoke` | Fail-closed security/corruption action in the future authenticated revocation profile. A current signed state must retain enough data for cold clients; ordinary event history is insufficient. |
| `retire` | Stop traversing/rendering a predecessor generation and release its CPU/GPU resources after all submitted work is safe. |
| `garbageCollect` | Physically delete an unreachable immutable server object after every retention, lease, rollback, and shared-reference condition passes. |

The ordinary compaction path is `supersede -> retire -> garbageCollect`, never
`invalidate -> delete -> try to load replacement`.

#### Lightweight transition hint

A push/SSE/WebSocket/poll response may carry this compact shape:

```json
{
  "formatVersion": "1.0",
  "datasetId": "0198a9b2-9d25-7d91-a92e-687596290c61",
  "updateEpochId": "0198a9b4-77b4-729c-8b17-e95b338cfa27",
  "sequence": "1843",
  "invalidationId": "0198a9b5-059d-79b6-99ed-b30d44a18fb7",
  "generation": "43",
  "mode": "superseded",
  "reason": "baseCompaction",
  "supersedesStateDigest": "sha256:old-state",
  "successor": {
    "stateDigest": "sha256:new-state",
    "stateUri": "states/sha256-new-state.json"
  },
  "affected": [
    {
      "kind": "retiredPatchClosure",
      "baseRevisionId": "0198a98b-cf0e-73b4-b7a1-397f70073946",
      "compactedThroughSourceRevision": "source:918274",
      "closureDigest": "sha256:retired-closure-root"
    }
  ]
}
```

Generation and sequence are uint64 values encoded in this JSON profile only as canonical unsigned
decimal strings. Compare their numeric values, never their JSON strings lexicographically; reject
overflow, numbers, and noncanonical leading-zero encodings. A future binary profile maps its uint64
to this same canonical decimal form before event-identity hashing. Timestamps are diagnostics, never
ordering authority. `affected` is a conservative optimization hint and may be omitted; it must never
contain false-negative coverage or replace state verification.

For idempotency/conflict detection, the canonical event-identity projection contains only
`formatVersion`, `datasetId`, `updateEpochId`, `sequence`, `invalidationId`, `generation`,
`supersedesStateDigest`, and `successor.stateDigest`. Canonicalize and hash that projection.
`successor.stateUri`, `mode`, `reason`, and `affected` are non-authoritative routing, priority, or
diagnostic hints and may vary or be omitted across transports; they never change state semantics or
authorize content. The subsequently verified head supplies the usable state URI and complete identity.

Client laws:

1. The event key `(datasetId, updateEpochId, sequence)` and the independent `invalidationId` each bind
   one canonical event-identity projection. Replaying either key with the same projection is
   idempotent; reusing either key for a divergent projection is a fail-closed publisher conflict.
   Reusing `updateEpochId` across different sequence values is the normal definition of an epoch.
2. A lower generation is stale and ignored. An equal generation with a different state digest is a
   split-brain error and fails closed.
3. A sequence gap, epoch change, unknown predecessor, reconnect, or cold start fetches the latest
   head and complete state snapshot; event-chain replay is never required.
4. The client keeps the old valid state active while the successor is fetched, verified, and
   prepared. Ordinary invalidation and replacement commit in the same frame transition.
5. Publisher rollback is a **new higher generation** referring to prior known-good immutable content;
   generations never decrease.
6. A notification cannot inject an arbitrary URI or patch. The verified head/state and their digest
   closures remain authoritative.
7. The fetched state's `datasetId`, `generation`, and `stateRevisionId` must exactly equal the head,
   and its canonical digest must equal `stateDigest`. A hint's successor generation/digest must match
   the subsequently verified head before it can accelerate work; mismatches trigger retry or
   fail-closed split-brain handling, never activation from the hint.
8. For direct-transition optimization, the hint's `invalidationId` and `supersedesStateDigest` must
   equal the state transition's `invalidationId` and `parentStateDigest`. A mismatch discards the
   incremental hint path and performs ordinary complete head/state reconciliation; it cannot reject an
   otherwise valid cold-load snapshot solely because non-authoritative hint metadata was wrong.

#### Target selector registry

Normative selectors are typed and base-scoped; producer-specific wildcard paths remain adapter input:

| Selector | Required identity |
| --- | --- |
| `state` | Dataset ID plus exact state digest. |
| `baseRevision` | Base revision UUID plus base digest. |
| `patch` | Patch revision UUID, exact base digest, descriptor digest, payload/closure digest, and canonical `updateLineage`. One lineage member alone never aliases the whole coalesced revision. |
| `explicitContent` | Component/base digest, canonical explicit tile locator, content index/group, tile-descriptor digest, and expected content digest/Merkle proof. |
| `implicitContent` | Component/base digest, canonical implicit-root locator, subdivision scheme, `(level,x,y[,z])`, content index/group, subtree digest, and expected content digest/Merkle proof. |
| `subtree` | Base-scoped explicit/implicit root plus a bounded depth or coordinate range; never an unbounded theoretical-tree enumeration. |
| `region` | Declared world/ellipsoid coordinate model, stable content group, conservative bounds, and the same mask rules as `replaceRegion`. |
| `resourceClosure` | Exact resource/Merkle root digest for retirement and GC; not normally a render selector because resources may be shared. |

Unloaded content must consult the active selector/tombstone index when it is later materialized.
Invalidating only tile objects that happen to be in memory is incorrect. For implicit tiling, an
overlay may replace or suppress content at an already-available coordinate, but changing tile/content
availability or packed subtree topology requires a new subtree/base revision or a future dedicated
availability-overlay profile.

Canonical locator rules:

- an explicit tile locator is a chain of segments. Each segment contains the exact tileset-JSON
  digest, a canonical unsigned root-to-tile child-index path within that JSON, and the zero-based
  external-content index used to enter the next tileset, if any. The final segment carries the
  zero-based content index plus tile-subobject/content descriptor digests;
- an implicit root locator is the bound implicit-root descriptor digest. Coordinates include the
  declared subdivision scheme and zero-based content index, and bind the subtree/resource proof;
- a producer may expose a shorter stable tile/group ID only when the bound resource manifest maps it
  one-to-one to the canonical locator;
- a `contentGroupId` is declared by the component profile and maps to a closed set of content slots or
  conditional variants; and
- authoritative operations require the expected target digest/proof. Non-authoritative event hints
  may omit it because they can only prioritize reconciliation, never mutate behavior.

Runtime-expanded child topology and a bare URI are not canonical locators. External tilesets,
multiple contents, and repacks therefore resolve identically only through the digest-bound segment
chain above.

### 4.5 Retention, retirement manifests, and garbage collection

Omission from the new active-state snapshot is the authoritative logical retirement rule. An optional
immutable retirement manifest can summarize closure-level operational advice without bloating the hot
head or active state:

```json
{
  "formatVersion": "1.0",
  "datasetId": "0198a9b2-9d25-7d91-a92e-687596290c61",
  "retiredByGeneration": "43",
  "reason": "compacted",
  "closures": [
    {
      "kind": "base",
      "baseRevisionId": "0198a98b-cf0e-73b4-b7a1-397f70073946",
      "baseDigest": "sha256:..."
    },
    {
      "kind": "patchClosure",
      "compactedThroughSourceRevision": "source:918274",
      "closureDigest": "sha256:retired-closure-root"
    }
  ],
  "purgeEligibleAfter": "2026-09-11T00:00:00Z"
}
```

`retainUntil` is the publisher's guaranteed-availability deadline for a retained state or closure.
`purgeEligibleAfter` is the earliest time an implementation may even consider collection and must be
greater than or equal to every applicable `retainUntil`; neither field is permission to delete. A
server object remains available
while reachable from any retained state root, shared resource closure, rollback point, deployment
pin, offline package/lease, or active publication. Garbage collection requires a reachability proof
plus expiry of the maximum head staleness, retry/backoff, CDN propagation, active-session, rollback,
and declared offline windows.

Publication and collection share a durable root-set protocol:

1. Before verification, the publisher creates a durable staging/publication pin naming the exact
   candidate closure, including digest-identical resources reused from older publications.
2. The pin is in the collector's root set before any candidate object can be observed by a sweeper and
   remains rooted through state publication, head CAS, and the abort grace period.
3. A collector marks from a consistent root epoch containing current heads, retained states,
   rollback/offline leases, active publication pins, and shared-resource references.
4. Before deleting an unmarked object, the collector rechecks that no newer root epoch or publication
   pin acquired it. Objects staged concurrently with a mark cannot be swept from an older view.
5. On successful CAS, the immutable state/head becomes the durable root before its staging pin is
   released. On abort, the pin is released only after the declared retry/grace window.

Each publication pin records its owner, exact closure digest, phase, creation time, renewable lease
expiry, and a monotonically fenced ownership token issued by the root manager. Full closure
verification atomically seals a compact `VERIFIED` pin certificate bound to the fencing token,
closure/Merkle root, object count, total bytes, and verification epoch. Head CAS performs only an
O(1) atomic check that the lease/token is current and the matching sealed certificate exists, then
promotes that closure root to a durable head root in the same transaction; it never enumerates or
`HEAD`s the closure in the CAS critical path. A publisher whose lease expired or whose pin was reaped
cannot CAS even when its expected predecessor head still matches. After a crash, an orphan reaper may
release an expired pin only after its abort grace period and a fresh
head/retained-root/shared-reference check; a pin whose candidate won CAS is redundant with the new
head root, never an orphan. This bounds leaked staging storage without reopening the sweep race.

This pin/mark-epoch barrier prevents a concurrent collector from deleting a candidate between upload
and head publication, and protects shared objects reused by the candidate without relying on a racy
reference-count update.

HTTP policy follows the identity model:

- content-addressed immutable objects use a long freshness lifetime plus `immutable`;
- the immediate-notification profile serves the tiny head with response `Cache-Control: no-cache`,
  and a hint-triggered request explicitly requires end-to-end revalidation; a bounded-lag polling
  profile may instead declare a short freshness budget plus `must-revalidate` and accept that delay;
- both profiles use a strong ETag, jitter, and coalesced revalidation;
- compare-and-swap publication uses an exact predecessor/strong validator;
- HTTP/CDN purge and HTTP Cache Groups are optional delivery optimizations only;
- RFC 9875 cache-group invalidation is optional and ignored on safe-method responses such as `GET`;
  it cannot be carried by an ordinary head/hint fetch as authoritative behavior;
- already decoded application/GPU state is retired by the runtime lifecycle, not by HTTP cache rules;
- a `404`, `410`, cache purge, or expiry timestamp can never recall bytes already cached by a client.

An offline snapshot is internally consistent at generation `G`, but it cannot claim currentness. On
reconnect it may jump directly to the latest complete state without replaying missed invalidations.

---

## 5. `replaceRegion`: the universal MVP operation

### 5.1 Semantics

The operation means:

> Outside the mask, render and pick the base. Inside the mask, render and pick the replacement. Other
> query systems observe replacements only when the selected profile explicitly declares that
> capability. Activate the complementary mask and replacement atomically only after valid root
> coverage is ready.

Illustrative payload:

```json
{
  "op": "replaceRegion",
  "targetContentGroup": "surface-elevation",
  "selector": {
    "type": "geodeticSurfacePolygon",
    "ellipsoid": "WGS84",
    "positionsRadians": [[-1.31, 0.69], [-1.30, 0.69], [-1.30, 0.70]],
    "boundaryOwner": "replacement"
  },
  "replacement": {
    "tilesetUri": "objects/sha256/replacement-tileset.json",
    "resourceManifestUri": "objects/sha256/replacement-resources.merkle.json",
    "closureDigest": "sha256:..."
  },
  "transition": {
    "collarMeters": 0.5
  }
}
```

Field names are provisional.

The MVP replacement is always a valid 3D Tiles tileset. A bare GLB is supported through a generated
one-tile wrapper that supplies transform, bounding volume, geometric error, and refinement semantics.
Direct bare-GLB replacement is deferred.

Replacement URIs resolve relative to the patch manifest. Base masks and replacement bounds are
evaluated in a common world/ECEF frame after every tile and glTF transform. WGS84 longitudes and
latitudes are radians and heights, wherever used by a later volume profile, are ellipsoidal meters.
Ring closure, winding, self-intersection, antimeridian normalization, pole behavior, and boundary
ownership are normative.

### 5.2 HLOD correctness

A hill may exist in coarse ancestors, the edited tile, and fine descendants. Masking only one GLB
allows the old hill to reappear during zoom transitions.

The mask therefore applies to every selected base LOD, while the replacement mini-tileset traverses
its own bounding volumes and geometric error. The client must:

1. Traverse the base normally.
2. Traverse the replacement independently.
3. Keep the old complete state until replacement root coverage is renderable and validated.
4. Activate the mask and replacement in the same frame.
5. Preserve replacement parent coverage during ordinary `REPLACE` refinement.
6. Before activation, any candidate failure keeps the predecessor active.
7. After activation, never lower the authoritative generation merely because a resource becomes
   unavailable. Retry/materialize the current generation or use only a stale fallback that the
   publication explicitly permits; otherwise report degraded absence. Hard-revoked content must
   never reappear.

### 5.3 MVP mask restrictions

To remain interoperable and fast, the first mask profile should be narrow:

- WGS84 geodetic surface polygon applied only to a declared continuous 2.5D surface content group;
- no self-intersections;
- initially no holes;
- explicit antimeridian and boundary rules;
- disjoint active closed masks, including boundaries and transition collars;
- replacement owns the boundary;
- one continuous 2.5D base surface target, avoiding accidental clipping of buildings, bridges, or
  underground content sharing the same geodetic column;
- replacement root covers the whole mask;
- replacement remains inside the base root bounding volume.

Arbitrary 3D volumes, buildings mixed with terrain, overlapping patches, and named content groups can
follow after the surface profile is proven.

### 5.4 Performance rules

- Coarse CPU bounding-volume rejection prevents mask evaluation on unaffected tiles.
- Active masks are held in a small spatial index; lookup must not scan the whole patch catalog.
- Base and replacement use the same mask representation to avoid gaps or double ownership.
- Shader clipping is an implementation choice, not a required wire representation.
- When an active-state snapshot changes, prepare new pipelines/resources before an atomic state swap.
- Patch chains are never evaluated linearly per fragment. The active state is materialized into a
  bounded compositor representation.

### 5.5 `replaceContent`: exact rebuilt-tile operation

`replaceContent` is the materialized fast path used when one existing logical tile/content slot has
been rebuilt without changing its tile metadata or hierarchy:

```json
{
  "op": "replaceContent",
  "componentId": "surface-elevation",
  "target": {
    "type": "explicitContent",
    "baseDigest": "sha256:terrain-base",
    "tilesetChain": [
      {
        "tilesetJsonDigest": "sha256:root-tileset-json",
        "childIndexPath": [2, 1, 3, 0]
      }
    ],
    "contentIndex": 0,
    "tileDescriptorDigest": "sha256:tile-descriptor",
    "expectedContentDigest": "sha256:old-content"
  },
  "replacement": {
    "contentUri": "objects/sha256/new-content.glb",
    "contentDigest": "sha256:new-content",
    "resourceManifestUri": "objects/sha256/new-content-resources.json",
    "closureDigest": "sha256:new-content-closure"
  }
}
```

An implicit target substitutes the canonical implicit locator from Section 4.4. The operation:

- replaces exactly one declared content slot while leaving sibling contents untouched;
- preserves the existing tile transform, tile bounding volume, geometric error, refinement, and
  availability. New content must fit all bound invariants;
- activates the old-content suppression and new content atomically after its state-control closure
  and current activation frontier are ready;
- binds the old and new content/resource digests, so a cache or repack cannot redirect the target;
  and
- is published in the same state revision when terrain, imagery, metadata, or companion components
  must move together.

If the edit must mask stale geometry in ancestors/descendants, use `replaceRegion` or publish the
complete cross-LOD group. If bounds, hierarchy, availability, or refinement changes, publish a new
subtree/base revision. `replaceContent` is a semantic materialized replacement candidate, not an
in-place mutation of the immutable base URI.

---

## 6. Why raw vertex and texture deltas can be fragile

They are fragile **as semantic edits without stable provenance**, not inherently bad. A binary delta
against one exact immutable source is mechanically safe when the client reconstructs the complete
target bytes and verifies an exact target digest. What it lacks is semantic portability, direct
application to decoded/GPU resources, derived-data knowledge, and HLOD composition.

### 6.1 Vertex/index fragility

A raw offset or vertex index can stop identifying the same logical data when a producer:

- reorders vertices or primitives;
- changes mesh simplification;
- changes Draco/meshopt/other compression output;
- repacks or aligns buffer views;
- changes quantization bounds;
- deduplicates or splits vertices at material/normal/UV seams;
- regenerates an atlas or LOD;
- changes topology, triangle count, meshlets, or acceleration structures.

Even a valid position update can require related updates to:

- normals and tangents;
- accessor min/max;
- tile/content bounding volumes;
- geometric error;
- skirts and neighbor edges;
- picking/collision structures;
- parent and child LOD representations.

### 6.2 Texture fragility

A texture rectangle is not always an independently replaceable byte rectangle:

- GPU-compressed formats update in complete blocks.
- Atlas repacking changes the logical location of imagery.
- Every affected mip level must remain coherent.
- Tile/atlas gutters must be regenerated to prevent seams.
- KTX Fragment URIs can address logical spatial/mip subresources, but KTX2 supercompression operates
  on encoded level data; a logical rectangle is not necessarily an independently replaceable slice
  of the existing compressed bytes.
- A material may reference the same texture region from multiple primitives.

### 6.3 Safe typed fast paths

Vertex and texture patches become safe when they bind all required provenance:

- exact base revision and content digest;
- exact layout/schema digest;
- codec and codec version;
- stable logical stream/primitive/feature identifier;
- expected count, component type, stride, offset, and quantization parameters;
- derived-data obligations;
- declared bounds and error impact;
- a rollback-safe atomic resource generation.

The correct conclusion is:

> Blind in-place byte mutation is too weak for the semantic MVP. Verified whole-resource binary
> deltas are a useful transport codec, while typed vertex and texture codecs are the direct-apply
> performance target after `replaceRegion` proves the state/distribution envelope.

---

## 7. Proposed typed geometry and texture codecs

### 7.1 `sparseAttributeOverride`

Use when topology and layout are unchanged.

Provisional payload contents:

- content and layout digests;
- primitive/stable stream ID;
- accessor semantic and set index;
- exact component/count/quantization contract;
- sorted element indices or compact ranges;
- absolute replacement values for the MVP;
- optional associated normal/tangent data;
- new conservative min/max and bounds evidence.

Order-dependent/additive deltas are deferred to the bounded dependency profile and require exact
input/output digests plus an explicit acyclic dependency edge; they cannot rely on manifest order.

The client may decode into CPU memory or upload sparse ranges directly into a replacement GPU buffer.
It must publish the new resource generation atomically; it must not edit a buffer still referenced by
submitted work.

### 7.2 `submeshReplace`

Use when topology changes inside a bounded region but replacing the full content is still wasteful.
The payload contains a small self-contained mesh plus an exact cut boundary/collar. This is more
robust than attempting to splice arbitrary index sequences into a compressed base.

### 7.3 `textureBlockReplace`

Use only when:

- texture identity and dimensions are unchanged;
- format and block dimensions are exact;
- replacement rectangles are block-aligned;
- every required mip rectangle is supplied;
- atlas/gutter ownership is explicit;
- compression permits independent block replacement, or the payload supplies whole replacement
  mip levels.

The universal fallback is a replacement texture object referenced by replacement content.

### 7.4 `binaryResourceDelta`

Use a standard binary-delta algorithm such as VCDIFF when exact-byte reconstruction is cheaper than
shipping a complete changed GLB, buffer, image, KTX, subtree, or other immutable resource.

Required envelope fields include:

- exact source URI/digest and length;
- delta codec and codec version;
- immutable delta URI/digest and length;
- exact reconstructed target digest and length;
- resource media type/content-encoding rules;
- allocation and expansion limits.

The client applies the delta to cached source bytes, verifies the complete target digest, and then
loads the reconstructed resource normally. It never patches an arbitrary live byte range without
verification. This can be extremely small and robust for transfer, but it may still require full
target reconstruction, decode, CPU memory, and GPU upload. It also does not by itself solve
cross-resource derived data or cross-LOD consistency, so it remains a payload codec under the same
atomic patch-state envelope.

---

## 8. Can quantized mesh be patched correctly?

**Yes—but not transparently through a 3D Tiles extension, and not every edit is equally cheap.**

Quantized-mesh terrain is a separate quadtree format. A tile contains:

- minimum/maximum height and culling/bounding data in its header;
- quantized `u`, `v`, and height arrays;
- delta/zig-zag encoded vertex values;
- high-water-mark encoded triangle indices;
- edge-vertex lists used for skirts/crack hiding;
- optional encoded normals, water masks, and metadata.

### 8.1 Fast height-only patch

Flattening a hill can be a very good sparse patch when all of these hold:

- existing vertex density adequately represents the flattened surface;
- vertex order and topology remain unchanged;
- affected samples are not on a tile boundary, or every neighbor/LOD edge is patched atomically;
- replacement heights remain within the existing minimum/maximum quantization interval;
- normals are supplied or recomputed;
- existing bounds remain conservative and horizon-culling data remains safe, or new header evidence
  is supplied;
- parent and child LOD representations are patched together or a cross-LOD overlay owns the region.

The edit must not invalidate the header's declared terrain extrema. If it removes or creates an
extremum, select complete height-stream/header replacement or whole-tile replacement, including
updated bounds and culling data.

A typed payload should identify the exact `(level, x, y)` tile, base digest, vertex-layout digest, and
sorted vertex IDs, then provide **absolute decoded quantized heights** or real-world heights. The
encoder/client—not the publisher's raw byte offsets—regenerates the local delta encoding.

### 8.2 Why not patch encoded bytes directly?

- Height values are relative to header min/max; changing that range changes the meaning of every
  quantized height and therefore selects complete height-stream or whole-tile replacement.
- Vertex values use sequential delta coding. Changing decoded sample `i` normally requires
  regenerating encoded deltas at `i` and `i + 1`; transport gzip can still make the compressed byte
  delta nonlocal.
- Topology changes interact with high-water-mark index coding and shift later sections.
- Added/removed vertices can change index width, edge lists, skirts, normals, and byte offsets.
- A terrain edit at a boundary must preserve matching decoded world/ECEF edge positions within a
  specified tolerance. Neighbor tiles may use different min/max intervals, so their raw quantized
  height codes need not match.

### 8.3 Quantized-mesh operation ladder

1. **`quantizedMeshHeightOverride`** — same vertex count/order/topology and existing min/max interval;
   sparse absolute heights; fastest path.
2. **`quantizedMeshSubregionReplace`** — bounded replacement mesh with an exact shared collar; more
   flexible but more complex.
3. **Whole terrain-tile replacement** — topology, bounds, quantization, or patch economics fail.
4. **Multi-LOD/multi-tile atomic set** — required whenever the edit crosses edges or must remain
   correct across zoom levels.

### 8.4 Imagery coupled to terrain

If imagery is an independent imagery layer, patch the affected imagery tiles through that service.
The active state must atomically pair terrain revision `T` with imagery revision `I`; otherwise the
new shape may briefly display old imagery or vice versa.

If imagery is baked into glTF/KTX content, use `replaceRegion` first and later the typed texture codec.

### 8.5 Recommended standards relationship

Define a reusable patch envelope and state model, then bind it through separate profiles:

- 3D Tiles surface/content patch extension;
- quantized-mesh terrain patch profile;
- imagery patch/revision profile.

They may share UUIDs, digests, atomic state, CDN, compaction, and cost-model semantics without
pretending the underlying content formats are identical.

---

## 9. Patch-versus-rebuild optimizer

The producer must decide before expensive work whether to:

1. emit `NO_OP` when the localized source result is semantically identical;
2. coalesce/defer a soft update within its explicit freshness SLA;
3. emit a semantic tombstone/suppression for a deletion;
4. emit a specialized patch;
5. emit `replaceRegion` or whole-content replacement;
6. rebuild the affected tile(s) or affected subtree;
7. compact/rebuild the base revision; or
8. defer compaction/offline materialization when a hot update tail cannot make bounded progress.

The interoperability extension standardizes hard compatibility gates and optional patchability
metadata. Candidate scoring, deployment weights, thresholds, and representation choice are
non-normative producer policy. “Optimal” means the lowest conservatively estimated cost among
supported candidates for a declared deployment profile, not a globally provable optimum.

### 9.1 Precomputed patch profile

At base-build time, emit a small private or optional public profile containing:

- a schema/estimator version and immutable profile digest bound to `baseDigest`;
- compressed and expanded bytes by geometry, texture mip, metadata, and auxiliary stream;
- vertex/triangle/feature/instance counts;
- codec, quantization, layout, compression random-access unit, GPU allocation/copy granularity, and
  texture block sizes;
- spatial bins mapping source features/regions to affected streams and LODs;
- stable feature, primitive, stream, and other patch-target IDs plus provenance hashes;
- bounds and geometric-error slack;
- resource alias/refcount, shader/pass usage, and dependency-closure summaries;
- normal/tangent/mipmap/acceleration-data dependencies and their byte/work estimates;
- historical encode/decode throughput with units, calibration timestamp, device/client cohort, sample
  count, and error distribution;
- approximate whole-content replacement, affected-tile rebuild, and base-compaction costs.

This turns the first decision into table lookups and integer arithmetic rather than a trial encode.
The estimator must receive an already localized, bounded `changeSummary`; discovering changed
elements by scanning the base is production work, not part of the microsecond decision.

Active patch state is mutable and must not be mixed into the base-bound profile. Each published state
therefore has a separate immutable `activeSummary` containing:

- summary schema/version and digest;
- exact `stateDigest` and generation;
- active bytes, local overlay/depth, compositor/frame cost, object count, and dependency closure per
  tile/spatial bin;
- active tombstone/selector count and lazy lookup cost per tile/spatial bin;
- current update epoch/sequence, compaction watermark, and rebased-tail count;
- bounded update-arrival/burst rates, tail bytes/work, rebase throughput, CAS conflict/backoff history,
  maximum writer-fence latency, observation-window endpoint, confidence bounds, and maximum age;
- global manifest, notification, storage, retirement, and retention totals.

The summary is computed and made available atomically with the state it describes. Rate/contention
fields are immutable observations over a declared window, not counters mutated after publication. An
estimator must reject an expired, stale, or mismatched `activeSummary`; every decision record binds
its digest/version, `stateDigest`, generation, observation window, and confidence bounds.

### 9.2 Hard rejection gates

Reject each candidate immediately when its relevant compatibility/correctness condition fails.
Specialized patches use the codec gates below; materialized and maintenance candidates use the same
fail-closed discipline:

- base or layout identity mismatch;
- unsupported codec or missing stable IDs;
- hierarchy, transform, refinement, or implicit availability change;
- bounds/geometric-error safety cannot be proven;
- topology change requested by a topology-stable codec;
- texture change is not block/mip/gutter safe;
- cross-edge, cross-LOD, or multi-component state-control closure/activation frontier is incomplete;
- invalidation target identity is ambiguous or not scoped to the exact dataset/base/state;
- for a base-compaction candidate, the live tail cannot be safely rebound to the candidate base;
- for a base-compaction candidate, rebase throughput cannot outrun the bounded arrival rate, or
  CAS/fence progress cannot be proven inside its deployment cap;
- required retention/offline guarantees exceed storage policy;
- active patch depth/bytes/runtime overhead already exceed limits;
- client capability profile cannot apply the codec;
- full replacement is already smaller or cheaper.

Every candidate must also satisfy non-negotiable deployment caps before scalar ranking:

- p95 activation hitch and time-to-current;
- peak CPU and GPU bytes, including atomic double-buffer/copy-on-write generations;
- request, object, dependency, and origin counts;
- local overlays/overlap depth per affected tile or spatial bin;
- persistent CPU/GPU frame budget across every applicable pass/view;
- retirement latency and retained-resource budget.

Hard-gate evaluation is O(1) or O(a strictly capped number of touched spatial bins), never O(full tile
size) or O(all active patches). If a localized change or active-state summary exceeds the Stage-1
budget, the result is conservatively `NEEDS_BOUNDED_STAGE_2` or a materialized replacement.

### 9.3 Candidate cost vector

For each valid candidate, estimate:

```text
producerMs       time to locate, encode, validate, and publish
wireBytes        actual head + full/sharded manifest + payload + dependencies + HTTP overhead
requestCost      requests/ranges, origins, revalidation RTTs, polling, and minimum-object overhead
originOps        PUT/HEAD/DELETE/LIST/reference-index/outbox operations and recovery-scan overhead
clientCpuMs      validation, decode, rebuild, and query-structure cost
clientGpuMs      upload/copy, mask, pipeline warmup, synchronization, and activation cost
peakCpuBytes     peak preparation memory including decompression and temporary copies
peakGpuBytes     peak atomic-generation memory including copy-on-write resources
activationHitchMs p95 activation hitch on the target cohort
persistentCpuUs  traversal, spatial lookup, picking/query/BVH, and draw preparation per visible frame
persistentGpuUs  mask/overdraw/early-Z loss and replacement work per applicable pass/view
runtimeBytes     retained patch resources, pipelines, descriptors, and compositor state
retireLatency    frames/time old generations remain resident after activation
storageByteDays  base/patch/fallback CDN retention through the grace period
notificationCost head/feed bytes, fanout, coalescing, and time-to-current
freshnessDebt    coalesce/defer latency against the source update's declared freshness SLA
contentionCost   tail rebase work, CAS retries/backoff, and bounded writer-fence latency
futureDebt       mandatory queued rebuild/compaction, tail rebase, invalidation, and offline-closure cost
riskPenalty      confidence interval and uncertainty penalty for estimated quantities
```

Recurring cost is not a one-time scalar. Project it over the expected exposure horizon:

```text
persistentCost =
    (persistentCpuUs * expectedVisibleFrames * expectedClientSessions)
  + (persistentGpuUs * expectedApplicablePassViews
                     * expectedVisibleFrames
                     * expectedClientSessions)
```

`expectedApplicablePassViews` includes every path that uses the patch: color, depth, shadows,
picking, stereo/multiview, and other engine-specific passes. The deployment model also accounts for
affected-screen probability and client fanout. The exposure horizon is bounded by the lesser of the
expected patch lifetime, expected time-to-compaction, and declared deployment/session horizon.

Compare normalized cohort cost rather than bytes alone:

```text
patchCost =
    Wproducer * producerMs
  + Wwire     * wireBytes
  + Wrequest  * requestCost
  + Worigin   * originOps
  + Wcpu      * clientCpuMs
  + Wgpu      * clientGpuMs
  + WpeakCpu  * peakCpuBytes
  + WpeakGpu  * peakGpuBytes
  + Whitch    * activationHitchMs
  + Wframe    * persistentCost
  + Wmemory   * runtimeBytes
  + Wretire   * retireLatency
  + Wstorage  * storageByteDays
  + Wnotify   * notificationCost
  + Wfresh    * freshnessDebt
  + Wcontend  * contentionCost
  + Wdebt     * futureDebt
  + riskPenalty
```

The deployment profile supplies weights. A high-latency mobile client and a low-latency datacenter
viewer should not necessarily choose the same representation. Evaluate cold-base, warm-base,
codec-capable, and codec-incapable cohorts separately; a heterogeneous deployment may choose
`typed patch + materialized fallback` as one publication candidate.

Candidate `wireBytes`, `clientCpuMs`, and `clientGpuMs` are measured per applying client/cohort member;
the deployment aggregator multiplies them by expected applicable clients and cache/capability cohorts.

### 9.4 Fast decision algorithm

```text
function chooseUpdate(changeSummary, baseProfile, activeSummary, deploymentProfiles):
    if !stage1InputsAreBoundedAndProvenanceMatches(
        changeSummary, baseProfile, activeSummary):
        return boundedStage2IsAllowed
            ? NEEDS_BOUNDED_STAGE_2
            : NO_SAFE_CANDIDATE_DEFER_TO_OFFLINE_BUILD

    if sourceUpdateWork(changeSummary) && exactSemanticNoOp(changeSummary):
        return NO_OP

    compactionMustDefer = compactionRequested(...)
        && !boundedCompactionProgressIsProven(...)

    if maintenanceOnlyCompaction(changeSummary) && compactionMustDefer:
        return DEFER_COMPACTION

    materialized = [
        estimateWholeContentReplacement(...),
        estimateAffectedTileRebuild(...),
        estimateAffectedSubtreeRebuild(...)
    ].filter(candidate =>
        candidate.hardCompatibilityPass
        && candidate.hardCapsPass
        && candidate.confidencePass)

    if !compactionMustDefer:
        baseCompaction = estimateBaseCompaction(...)
        if baseCompaction.hardCompatibilityPass
            && baseCompaction.hardCapsPass
            && baseCompaction.confidencePass:
            materialized.push(baseCompaction)

    bestMaterialized = materialized.isEmpty
        ? null
        : minimumUpperBoundCost(materialized)

    patchCandidates = []

    if coalesceOrDeferHardGatesPass(...):
        patchCandidates.push(estimateCoalesceOrDefer(...))

    if semanticSuppressionHardGatesPass(...):
        patchCandidates.push(estimateSemanticSuppression(...))

    for codec in fixedCodecsFor(changeSummary.kind):
        if codec.operationHardGatesPass(changeSummary, baseProfile, activeSummary):
            patchCandidates.push(codec.constantTimeEstimate(...))

    if regionReplacementHardGatesPass(...):
        patchCandidates.push(estimateRegionReplacement(...))

    if patchWithFallbackHardGatesPass(...):
        patchCandidates.push(estimatePatchWithMaterializedFallback(...))

    admissiblePatches = patchCandidates.filter(candidate =>
        candidate.hardCompatibilityPass
        && candidate.hardCapsPass
        && candidate.confidencePass
        && (bestMaterialized is null
            || candidate.upperCost
                 <= bestMaterialized.lowerCost * patchAdmissionRatio))

    admissible = admissiblePatches
    if bestMaterialized is not null:
        admissible.push(bestMaterialized)

    if admissible.isEmpty:
        return NO_SAFE_CANDIDATE_DEFER_TO_OFFLINE_BUILD

    chosen = minimumUpperBoundCost(admissible)
    chosen.maintenanceDisposition = compactionMustDefer
        ? DEFER_COMPACTION
        : NONE
    return chosen
```

This avoids a subtle but expensive failure mode: if a specialized patch initially wins but fails
confidence/admission, the fallback is the cheapest admissible materialized candidate—not always a
base rebuild. `NO_OP` applies only to source-update work after exact semantic equality is proven; it
does not suppress a requested maintenance compaction. It creates no new state generation, head write,
or notification. Coalescing/defer is
illegal for hard revocation or when it would exceed the source update's freshness SLA. A coalesced
patch retains the canonical `updateLineage` union and the oldest/least remaining freshness deadline; a
newer update cannot reset that deadline. Exceeding the lineage cap selects a materialized candidate
rather than dropping provenance. Semantic suppression is a durable tombstone state operation, not
omission from a notification. A deferred compaction leaves the current verified state authoritative
and schedules bounded later work; it does not delay an already-admitted currentness update.

### 9.5 Initial non-normative admission heuristics

These are starting experiment values, not proposed specification constants:

- patch wire bytes `< 50–60%` of replacement bytes;
- patch producer time `< 50%` of rebuild time;
- patch client apply time `< 25–40%` of replacement decode/upload time;
- cumulative local patch bytes `< 25–50%` of the affected base resource closure, plus separate global
  manifest/storage limits;
- bounded active overlay count/depth **per affected tile/spatial bin**, initially around `8–32`
  depending on measured recurring cost;
- require a safety margin, such as `20%`, before choosing a patch from estimates;
- compare the patch's conservative upper-cost bound to the best materialized candidate's lower-cost
  bound;
- rebuild immediately when correctness gates fail, regardless of predicted savings.

The prototype must calibrate these thresholds from real workloads.

### 9.6 Two-stage refinement

1. **Stage 1: metadata estimate** — microseconds only when codec count, touched bins, and all input
   summaries are explicitly bounded and pre-aggregated; rejects obviously poor patch choices.
2. **Stage 2: bounded exact encode/sample** — only for close decisions; encodes affected blocks or a
   small representative sample and updates the estimate. It has strict maximum bytes, blocks, and
   wall-time; exhaustion returns the best admissible materialized candidate or
   `NO_SAFE_CANDIDATE_DEFER_TO_OFFLINE_BUILD`.

The producer should emit a decision record containing the base/profile/estimator hashes and versions,
exact state generation/digest and active-summary digest/version, calibration cohort, every candidate
vector, hard-gate outcome, confidence interval, chosen representation, and reason. This makes
optimizer behavior auditable and trainable without putting the cost model itself into the
interoperability specification.

### 9.7 Manifest and CDN scaling law

The MVP active-state manifest is a full active snapshot. Its wire/parse cost is therefore
O(active patches), not a free “state delta.” Bound the active-list size and compact before it becomes
material. A later scale profile may use a content-addressed Merkle/spatially sharded index so one new
generation fetches only the changed shard plus a small new root.

Cost estimates include cache-hit probability, 200-versus-304 behavior, head polling cadence, cold
base/fallback downloads, HTTP header and minimum-object overhead, object/origin fanout, manifest
parsing, CDN byte-days during the required grace period, and origin `PUT`/`HEAD`/`DELETE`/`LIST` plus
reference-index transaction counts. A large population of tiny immutable objects can be expensive
even when its byte total is small.

---

## 10. Atomic activation and failure model

Client state machine:

```text
ACTIVE(g) -> HEAD_HINT/REVALIDATE -> FETCH_STATE -> VERIFY -> PREPARE -> READY
   ^                                         |          |          |       |
   |                                         +----------+----------+-------+
   |                                                                  failure
   +---------------------- KEEP_PREVIOUS_STATE <-------------------------+

READY -> ATOMIC_ACTIVATE -> DRAIN_OLD_GPU_WORK -> RETIRED -> LOCALLY_EVICTABLE
```

Rules:

- Validate base revision, manifest, resource closures, payload digests, bounds, codec, and limits
  first. Validate the predecessor only when performing a direct incremental transition from an
  already-current state.
- Fetch the complete small state-control closure and every heavy resource in the current bounded
  activation frontier before activation; descendants/off-screen heavy resources in the lazy closure
  remain deferred and can resolve only under the new generation.
- Prepare replacement buffers, textures, bind groups, and traversal state off to the side.
- Do not expose a mask until replacement root coverage is renderable.
- Recompute the dynamic visible/contributing activation frontier at the commit frame against the
  current camera, traversal/query requirements, capability/device generation, and memory caps. If the
  frontier expanded beyond prepared coverage, defer commit and keep the predecessor active.
- Swap state at a frame boundary.
- Retire old resources only after submitted GPU work can no longer reference them.
- On any failure, retain the prior complete state.
- Never partially apply a multi-tile, multi-LOD, or terrain-plus-imagery update.
- An accepted unseen newer hint rate-limitedly wakes/thaws snapshot rendering and schedules head
  reconciliation before preparation. This wake does not apply the hint's selectors or change visible
  state.
- Coalesce event bursts into one monotonic desired generation, bound concurrent head/state work,
  preempt or demote obsolete non-READY preparation, and reuse digest-identical completed work. Fetch
  only through the verified head.
- If `READY(g)` becomes obsolete before its commit boundary because a newer verified desired
  generation exists, skip `g`, retain the current active predecessor, and reuse digest-identical
  prepared resources for the newer generation. Once an atomic commit has begun it completes; the
  successor is then prepared normally. The authenticated revocation profile may apply its deny rule
  immediately, independently of ordinary readiness.
- Apply only selectors/tombstones/revocations from the verified active state to loaded and
  future-loaded content; a tree walk of current cache entries is only an optimization. Event
  `affected` selectors may prioritize fetch/preparation but can never suppress or replace content.
- For ordinary supersession, keep rendering the predecessor until successor coverage is ready. When
  the required authenticated-revocation profile is enabled, a verified signed hard revocation is the
  explicit exception and may intentionally produce absence.
- If a tileset-root or subtree manifest changes, reconcile selectors against the new complete tree;
  never apply a delayed manifest change to targets resolved only against the old tree.
- After verified activation, advance the committed scene-state/render-cache generation exactly once
  per logical transition, not once per duplicate feed message or affected tile. This committed-state
  bump is distinct from the earlier rate-limited wake.

Bounded rollout is required because a zero-flicker swap may temporarily hold both generations. The
runtime should cap in-flight preparations, prioritize visible tiles, unload rather than double-buffer
safe off-screen content, reserve measured memory headroom, and expose degraded/stale diagnostics when
replacement repeatedly fails.

---

## 11. Optional-extension fallback semantics

An optional extension allows an unaware client to render the immutable base, which is useful but
stale. It cannot simultaneously promise authoritative current state.

The publication model must choose explicitly:

- **Optional/stale-compatible entrypoint:** unaware clients show a valid base and may be stale.
- **Required/current entrypoint:** lists the extension in `extensionsRequired`; unaware clients reject
  it.
- **Dual entrypoints:** one stable base URL and one authoritative patched-state URL.
- **Materialized fallback:** a patch-aware client that lacks a particular codec may fetch a fully
  materialized current tileset.

No client may silently ignore a required patch and claim current data.

The same rule applies to invalidation. A stale-compatible optional client may continue showing its
declared immutable fallback, but it cannot honor hard revocations or advertise authoritative
currentness. A publication requiring security revocation, suppression, or successor-only correctness
must use a required/current entrypoint or a fully materialized current fallback.

An extension-aware client also validates the state's versioned `requiredCapabilities`. Missing a
component, operation, codec, or authenticated-revocation capability rejects the primary
representation and retains the predecessor until a compatible in-state materialized fallback is
ready. Fallback discovery contains the exact alternate component/closure descriptor and digest,
semantic/output identity, source revision, and required capability set. It remains part of the one
head-bound state manifest; it is not an alternate state digest or an unbound prose promise.

---

## 12. Compaction policy

Compaction is triggered by economics, not merely age.

Possible triggers:

- active patch bytes exceed a percentage of base bytes;
- active overlay/codec count exceeds a traversal or memory budget;
- recurring mask/application cost exceeds a frame-time budget;
- multiple patches touch the same region or resource;
- patch preparation becomes slower than replacement loading;
- offline snapshot closure becomes too large;
- a scheduled publication window permits full rebuild; and
- measured tail arrival, rebase throughput, CAS contention, and writer-fence latency prove the
  compaction can finish inside bounded deployment limits.

A trigger does not force compaction. When the update-arrival upper bound meets or exceeds conservative
rebase throughput, or CAS/fence progress cannot be bounded, `DEFER_COMPACTION` is the safe candidate.
The producer continues publishing ordinary currentness updates, coalesces only within their freshness
SLAs, and retries compaction after the hot tail subsides or more capacity is available.

Compaction procedure:

1. Fence a durable source revision `N` and snapshot the exact active state/base used by the build.
2. Materialize and validate a candidate immutable base `B1` locally containing source changes through
   `N`; do not expose its objects to collection/publication yet.
3. Continue accepting source changes `N+1...` as a live tail, or take only a short bounded writer
   fence; do not silently drop updates while `B1` builds.
4. Capture a bounded tail and partition each patch and tombstone's `updateLineage` at `N`. Because
   `B1` was built once from the canonical source snapshot through `N`, validate that the incorporated
   prefix is reflected in `B1` and mark it absorbed—never apply those patch payloads a second time.
   Re-encode/rebind only the surviving tail against `B1`; omit an empty tail record. Each surviving
   patch or tombstone keeps its complete tail lineage but receives a new exact-base-scoped revision
   UUID and digest.
5. Derive the exact candidate state and transitive closure containing `B1` plus only the rebased tail.
   Before any candidate object becomes visible, create a durable publication pin over every new and
   reused digest in that exact closure.
6. Publish and verify the entire pinned immutable closure and candidate state. The pin participates in
   the GC root set throughout verification and publication; successful verification atomically seals
   the compact token/root/count/bytes verification certificate used by head CAS.
7. Compare-and-swap the mutable head against the exact state digest/generation observed when the tail
   was captured. The same atomic transaction O(1)-validates the still-live publication-pin fencing
   token plus sealed verification certificate and promotes its exact closure root to the durable head
   root; an expired/reaped publisher cannot win.
8. If CAS fails because another update arrived, capture and rebase the additional tail, derive the
   new exact closure, and atomically extend or replace the publication pin **before** making any added
   object visible. Keep prior-attempt pins through retry/abort grace. Retry only within the declared
   retry, tail-byte/work, and elapsed-time caps. A final writer fence is allowed only within its
   declared maximum latency. On cap exhaustion, abort/defer compaction, keep the old authoritative
   state, and release all attempt pins only after their abort grace periods; never spin or starve
   currentness updates indefinitely.
9. Emit one idempotent head-change/invalidation hint after the head commit.
10. Clients atomically activate the successor, then retire old CPU/GPU generations after safe fences.
11. Make the committed state/head the durable root before releasing the candidate publication pin.
    Retain the old base/patch closure for the grace/offline/rollback window and garbage-collect only
    after a consistent mark epoch plus final root/pin recheck proves it unused.

`compactedThroughSourceRevision=N` is safe only when the declared source domain makes `N` a true
ordered prefix. A source without that guarantee uses selective compaction naming exact logical
update IDs plus patch revision IDs/digests in a strictly bounded canonical set; a larger set is stored
as a content-addressed Merkle/index root with bounded proofs. Both forms must rebase or retain every
dependent later patch/tombstone. Publishing a new base while carrying old-base-relative tail
operations is a correctness failure even if their logical source IDs match.

### 12.1 Local rebuilt-tile example

Rebuilding one tile does not require regenerating every tile payload or changing the tiling scheme:

1. If the logical tile, bounds, geometric error, refinement, and implicit availability remain valid,
   publish the rebuilt content as a `replaceContent`/one-tile replacement state operation. The old
   content and any patches incorporated into the rebuilt bytes stop contributing in the same atomic
   state transition.
2. For durable compaction, publish a new base revision whose resource closure reuses every unchanged
   base object and references only the new tile/content (and any changed subtree/root shard). Base
   immutability requires a new revision identity; it does **not** require recomputing or retransmitting
   unchanged content-addressed resources.
3. Omit incorporated patches from the successor active set. Retain or rebase unrelated/dependent tail
   patches against the new base digest.
4. CAS the head, then emit an exact-content/subtree hint. A client loads and verifies the new content,
   switches mask/selection and content atomically, and retires the old GPU/CPU generation after its
   fences settle.
5. The old tile and incorporated patch closure become GC candidates only after retention and
   reachability rules pass.

If the rebuild changes hierarchy, availability, bounding-volume containment, or refinement
semantics, the affected subtree/base metadata must also be republished. The optimizer chooses between
the quick materialized replacement and immediate subtree/base compaction from the same cost vector.

---

## 13. Security and validation limits

The extension/profile must bound:

- manifest and payload bytes;
- patch count and dependency depth;
- polygon vertices and spatial-index size;
- decompressed output and compression ratio;
- vertex, index, texture, and mip counts;
- URI schemes, origins, redirects, and path traversal;
- cross-resource references and cycles;
- CPU/GPU allocation and workgroup sizes;
- coordinate finiteness and transform validity;
- bounds/geometric-error changes;
- base-digest mismatches and direct-transition predecessor mismatches;
- downgrade/rollback to older signed generations.
- invalidation selectors, subtree depth/ranges, and notification rate;
- event UUID/epoch/sequence replay, gaps, and same-generation digest conflicts;
- unauthorized cross-dataset, cross-base, cross-origin, or shared-cache targets;
- retention/GC attempts against still-reachable or shared resources.

Patch data must never contain executable JavaScript or arbitrary shader source. HTTPS provides
transport protection; digests provide integrity; publisher authenticity may additionally use a
signature over the canonical state manifest. A notification channel is not trusted to inject
resources or authorize deletion. Hard revocations must be authenticated, anti-rollback protected,
persisted in the current authoritative state, and bounded so a replay or flood cannot create an
unbounded tombstone index.

Hard revocation is a separate required security profile, not an MVP core promise. The profile must
define publisher keys/rotation, signed state and optional signed deny-only notices, anti-rollback
epochs, exact digest-scoped targets, and fail-closed behavior while a successor is unavailable. A
revocation record cannot retire until no supported retained entrypoint/state/offline lease can select
the target, or until an equally authoritative persistent deny root continues to cover it. A core
client without the profile rejects a state containing nonempty `revocations`.

---

## 14. Performance targets for the prototype

Targets must be measured against whole-content/tile replacement and full rebuild:

- discovery head under roughly 1 KB for the common case;
- common head-change/invalidation hint on the order of hundreds of bytes, with bounded selectors and
  a refresh-head fallback when detail would be large;
- no full base download for a cache-resident compatible patch;
- producer decision in microseconds from the precomputed profile;
- producer patch build proportional to changed elements/blocks, not total tile size;
- constant number of state-fetch round trips where possible;
- atomic activation of every ready/current frontier with no partial-swap hole or mixed coupled
  generation; withheld lazy targets and explicitly stale-compatible output are reported separately;
- no per-frame work for patches outside the view;
- spatial lookup sublinear in active patch count;
- bounded patch-state memory;
- bounded event/tombstone history, coalesced revalidation, and no event-chain requirement;
- bounded zero-flicker double residency and old-generation retirement latency;
- duplicate/out-of-order notifications performing no patch work;
- zero new GPU resource creation on stable repeated frames;
- typed sparse updates demonstrably faster than replacement decode/upload;
- automatic rebuild choice whenever patch economics lose.

“Hyper performant” is not established by a small payload alone. The gate must include producer time,
wire bytes, client preparation, recurring frame cost, memory, and eventual compaction.

---

## 15. Prototype and standardization plan

| Phase | Deliverable | Status |
| --- | --- | --- |
| R0 | Primary-source standards survey and architecture review | Complete |
| R1 | This working design/decision tracker | Complete |
| R2 | Reconcile prior repository invalidation research/prototype with the immutable state model | Complete |
| D1 | Freeze terminology, scope, fallback, identity, mask, selector, and invalidation semantics | Pending |
| D2 | Define patch profile and patch-vs-rebuild estimator schema | Pending |
| P1 | Three-LOD hill with cross-tile `replaceRegion` replacement | Pending |
| P2 | Atomic delayed/failing replacement load; never show a hole | Pending |
| P3 | Immutable head/state/cache/offline/rollback plus idempotent invalidation/gap-recovery prototype | Pending |
| V1 | Typed exact/subtree/implicit/region selector adapter with loaded and future-loaded tile coverage | Pending |
| V2 | Bounded visible-first zero-flicker rollout, multi-content, and snapshot/cache wake-up | Pending |
| V3 | Online compaction with live-tail rebase, CAS conflict retry, retirement manifest, and safe GC | Pending |
| P4 | Sparse glTF position/normal fast path with exact layout provenance | Pending |
| P5 | Texture block/mip patch experiment | Pending |
| P6 | Quantized-mesh height-only sibling profile | Pending |
| B1 | Patch-versus-rebuild benchmark and calibrated thresholds | Pending |
| I1 | Second independent runtime implementation | Pending |
| S1 | Vendor extension draft, JSON schemas, and conformance assets | Pending |
| S2 | Proposal for `3DTILES_*` promotion or future core inclusion | Pending |

### 15.1 Required reference scenarios

1. Flatten an interior hill and update baked imagery.
2. Flatten a hill crossing a tile boundary.
3. Preserve the flattened result through coarse, medium, and fine HLOD transitions.
4. Apply sparse vertex/normal changes to a layout-stable glTF.
5. Apply block-aligned texture changes with complete mips/gutters.
6. Apply a topology-stable quantized-mesh height override.
7. Force every optimizer fallback: patch, region replacement, whole tile, and base compaction.
8. Compact an ordered source-update prefix through `sourceRevision N` while later source changes
   arrive; rebase the entire `N+1...N+k` tail without losing an `updateId`.
9. Deliver duplicate, reordered, and gapped invalidation events; converge directly on the latest
   state snapshot.
10. Replace one exact tile/content slot, one implicit subtree, and one multi-layer atomic state while
    leaving siblings untouched.
11. Keep old content visible through a delayed successor, then release old CPU/GPU resources only
    after safe submission fences.
12. Exercise semantic suppression, stale-compatible offline state, reconnect, and retention-safe
    shared-resource garbage collection; exercise hard revocation only under the required authenticated
    revocation profile.

### 15.2 Benchmark outputs

- source-change localization time;
- optimizer decision time;
- patch/replacement/rebuild production time;
- manifest and payload bytes;
- request count and time-to-current;
- client validation/decode/upload time;
- visible/imminent/off-screen preparation latency, prediction hit rate, wasted pre-bakes, and skipped
  obsolete bakes;
- peak CPU/GPU memory;
- frame-time and hitching impact;
- cache hit/offline replay behavior;
- invalidation event bytes, fanout, coalescing, gap recovery, and time-to-current;
- origin `PUT`/`HEAD`/`DELETE`/`LIST`, reference-index, durable-outbox, and recovery-scan operation
  counts;
- in-flight swap count, double-residency peak, and retirement latency;
- update arrival/burst rate, compaction rebase throughput, CAS retry/backoff, writer-fence latency,
  deferral rate, and retained-closure byte-days;
- debounce quiet/max-wait latency, rebuild jobs avoided/coalesced, throttle queue depth, and direct
  rebuild versus patch-first completion time;
- compaction time and storage amplification;
- exact visual, picking, and query correctness.

---

## 16. Open decisions

1. Is the first extension rendering-only, or must height sampling, ray queries, collision, and analytics
   observe replacements?
2. Is stale-base fallback acceptable, or is a separate required/current entrypoint needed?
3. Does the first mask target the entire base surface or a stable logical content group?
4. Is WGS84 polygon-prism sufficient for the first profile?
5. Are active masks required to be disjoint? Current recommendation: yes for MVP.
6. What exact canonical/Merkle resource-record encoding, representation variants, and content-
   encoding domain does `baseDigest` bind?
7. Is JSON sufficient for the first active-state manifest, with binary spatial indexes deferred?
8. Which stable IDs/provenance can tilers emit to unlock typed vertex and texture codecs?
9. Must replacement geometry remain inside the old root bounds? Current recommendation: yes for MVP.
10. What are the default optimizer weights for cloud, desktop, and mobile deployment profiles?
11. What patch byte/count/runtime thresholds trigger compaction?
12. Should quantized-mesh share the envelope while remaining a separate profile/repository?
13. Which versioned terrain and independent-imagery component profiles should be standardized first
    under the globally atomic state envelope?
14. How are signatures, rollback protection, and publisher key rotation handled?
15. Is `3D Tiles Patch + Invalidation`, `3D Tiles Live Update`, or another term the clearest umbrella
    extension name?
16. Which notification transports and discovery links are standardized versus left to deployment
    profiles?
17. What is the normative typed-selector encoding for explicit IDs, implicit coordinates, content
    slots/groups, subtrees, and regions?
18. What stale/offline/rollback lease does a publisher promise, and how can managed offline packages
    pin a state closure?
19. What keys, rotation, anti-rollback epoch, deny-root retention, and offline policy should the future
    authenticated hard-revocation profile require?
20. When update traffic prevents compaction CAS progress, what maximum bounded writer-fence duration
    is acceptable?
21. Should HTTP Cache Groups be emitted as an optional same-origin cache optimization? They cannot be
    a conformance dependency.
22. How are shared resource closures reference-counted across bases, replacement tilesets, and
    rebased patches before GC?

---

## 17. Initial acceptance and conformance matrix

### 17.1 Core state, invalidation, replacement, and lifecycle

- Unknown optional extension renders the declared stale-compatible base.
- Required extension is rejected by an unaware client.
- An unknown required component/profile/version rejects the whole atomic state. A compatible in-state
  materialized fallback activates only when its exact closure/output identity and capability set pass.
- A patch whose `baseDigest` does not bind the exact component/base revision descriptor rejects.
- Replaying the same `(datasetId, updateEpochId, sequence)` tuple or `invalidationId` with the same
  canonical identity projection is idempotent; reusing either event key with a divergent projection
  fails closed. Non-authoritative URI/mode/reason/affected hints may vary without changing identity.
- Successive sequence values under the same `updateEpochId` are distinct valid events.
- Lower generation is ignored; equal generation with a different state digest fails closed.
- Missing any number of events still converges by fetching the latest head and complete snapshot.
- A notification with an arbitrary successor URI cannot bypass verified head/state identity.
- Head `datasetId`/`generation`/`stateRevisionId` and computed `stateDigest` must exactly match the
  fetched state; a hint successor that disagrees with the verified head cannot activate.
- Immediate hint handling forces head revalidation even if an intermediary holds a fresh prior head;
  a bounded-freshness profile instead proves and reports its declared maximum lag.
- A direct-successor transition with a divergent `parentStateDigest` is not applied incrementally;
  the client validates and materializes the advertised complete snapshot instead.
- Failure of one state-control or current activation-frontier resource applies none of the state.
- Old hill never reappears during parent/child HLOD transitions.
- Cross-edge replacement is crack-free and boundary ownership is deterministic.
- Invalid/self-intersecting/out-of-range masks reject.
- Replacement is not activated before root coverage is ready.
- Ordinary invalidation and replacement activate in the same frame; a delayed or corrupt successor
  keeps the predecessor visible.
- Post-activation loss does not silently restore a superseded generation; an explicitly permitted
  stale fallback may be used.
- An active semantic suppression applies to unloaded content when it is later materialized.
- Exact-content invalidation leaves sibling contents untouched; subtree invalidation does not hit
  siblings or enumerate an unbounded theoretical tree.
- Implicit content replacement preserves availability; an availability/topology mutation rejects or
  selects a new subtree/base revision.
- A ready/current multi-layer terrain/imagery/object frontier never exposes a mixed generation;
  withheld lazy targets are not claimed current, and stale-compatible fallback uses the complete
  coupled predecessor group.
- A paired base/content multi-component rebuild activates as one state, including when one component
  uses an in-state materialized fallback.
- Reordering independent patch/tombstone arrays leaves output identity unchanged.
- Every semantically unordered state array normalizes to its specified canonical order before hashing;
  shuffled input yields one digest, while duplicate component/domain/revision/capability/fallback IDs
  reject.
- Independent patch-versus-patch, patch-versus-tombstone, nonidentical tombstone overlap, and touching
  `replaceRegion` closed masks reject. Identical tombstones normalize deterministically.
- Context loss and reload recover one complete state.
- Cache/offline replay resolves an exact immutable resource closure.
- Offline state reports internally consistent but stale, then jumps directly to current on reconnect.
- Compaction preserves the same semantic surface and state identity lineage.
- Compaction with concurrent tail changes loses none; every surviving tail patch binds the new base
  digest and receives a new patch revision identity when re-encoded.
- Source-built compaction absorbs each patch and tombstone prefix exactly once, omits an empty tail,
  and re-encodes each surviving tail lineage against the new base without double-applying it.
- A head CAS conflict retries against the additional tail instead of overwriting it.
- Compaction that exceeds arrival/rebase/CAS/fence caps defers without blocking currentness updates or
  publishing a partial base.
- Rollback publishes a higher generation; a lower-generation rollback is rejected.
- Old closures remain retrievable through their promised retention window.
- Shared resources are not collected when any retained state, patch, base, or offline pin references
  them; an expiry timestamp alone never authorizes deletion.
- A collector racing candidate upload cannot delete staged or reused resources protected by a durable
  publication pin; successful CAS establishes the new root before pin release, and deletion performs
  a final mark-epoch/root/pin recheck.
- A crashed publisher's expired pin is reaped only after lease, abort-grace, and fresh root/reference
  checks; a committed candidate remains protected by the head root.
- Client CPU/GPU resources remain live through submitted work and retire exactly once afterward.
- Notification floods coalesce to bounded work and the newest verified generation.
- Coalescing retains every incorporated `updateLineage` record, respects freshness SLA, and selects a
  materialized candidate rather than exceeding the bounded lineage set.
- When patching wins, its verified state/head commit precedes rebuild scheduling; when patching loses,
  the producer publishes the direct materialized result without a transient patch.
- Repeated edits reset `quietPeriod` but not `maxWait` or the oldest freshness deadline. Threshold and
  global-throttle tests prove bounded rebuild count and fair attempts when arrival/rebase/CAS capacity
  is feasible; sustained infeasible load produces explicit debt/age alerts rather than a false
  completion guarantee.
- A crash after patch-head CAS but before ordinary queue delivery is recovered from the durable
  rebuild intent or active-state scan; duplicate scheduling materializes the lineage exactly once.
- `maxWait` produces a fair scheduled attempt and overload telemetry/alerts, but never claims
  completion while safe rebase throughput is below sustained arrival.
- HTTP object fetch plus SSE/WebSocket, gRPC, polling, and in-process listener profiles converge on
  the same verified state and produce identical output; transport bytes alone never authorize state.
- An off-screen affected tile performs no decode/upload/compositor work until visibility or bounded
  camera/screen-space-error prediction demands it. On re-entry it either keeps an explicitly reported
  predecessor fallback until atomic readiness or presents only the patched/materialized generation;
  stale bytes are never mislabeled current.
- A local baked composite is keyed by exact state/base/patch/profile identity, is evictable, and is
  skipped when a newer rebuilt generation supersedes it before realization.
- Rebuilt-content activation keeps the patched result visible until ready, then atomically switches
  and retires the incorporated patch generation only after safe resource fences.
- Exact semantic no-change selects `NO_OP`; a delete selects an active suppression; a deliberately
  uneconomic patch selects full replacement/rebuild.
- Optimizer mutants that undercount bytes, origin operations, client/recurring cost, chain debt,
  mandatory queued rebuild debt, contention, or required derived data fail.
- Corrupt payloads, excessive expansion, cycles, resource-limit attacks, oversized selectors,
  unbounded subtrees/globs, and cross-dataset targets fail closed.
- A core client rejects any nonempty `revocations` list because that list requires the authenticated
  revocation profile.

### 17.2 Optional typed/content profiles

- Sparse attribute patch rejects any layout/count/quantization mismatch.
- Texture patch rejects unaligned blocks or missing mip/gutter data.
- Quantized height patch rejects incomplete edge/LOD groups and unsafe header changes.
- An independent overlapping typed patch rejects; a future dependency-profile overlap is accepted
  only through its bounded acyclic graph and exact edge input/output digests, independent of array
  order.

### 17.3 Authenticated revocation profile

- An unsigned, wrong-key, replayed, cross-dataset, or rollback revocation fails closed.
- A verified revocation dominates patches and tombstones targeting the revoked digest, including
  content not yet loaded, independent of manifest order.
- Hard-revoked content remains absent during successor failure and cannot return through a stale or
  offline entrypoint covered by the profile's persistent deny root.
- A revocation record cannot retire while any supported retained state/offline lease can select the
  target unless an equally authoritative persistent deny root remains.

---

## 18. Research conclusions

1. The concept is technically credible and fills a real update-latency gap.
2. The best first standards shape is one live-update extension family discovering an immutable
   active-state manifest, plus an optional low-latency invalidation/head-change control plane—not
   HTTP `PATCH`, not blind GLB byte mutation, and not an authoritative imperative event log.
3. `replaceRegion` plus a replacement tileset is the correct universal MVP because it handles
   independent HLOD and avoids coupling to one exporter layout.
4. Typed vertex and texture patches remain essential optimization paths. Their fragility is solved
   through exact provenance, narrow codec invariants, derived-data rules, and automatic fallback.
5. Quantized mesh can be patched efficiently for topology-stable height changes, but it is a separate
   terrain format and needs its own profile. Wide/topology/bounds-changing edits should replace the
   terrain tile or spatial region.
6. The patch-versus-rebuild optimizer is a first-class part of the producer architecture. Its cost
   weights are deployment policy, while the wire specification only needs enough profile metadata
   to make decisions reliable and auditable.
7. Ordinary compaction is an atomic successor publication followed by logical retirement and delayed
   reachability-based garbage collection. It must rebase every concurrent tail patch and CAS the
   head; invalidating or deleting first is never safe.
8. Invalidation is a currentness/reconciliation signal, not a claim that browser, CDN, application,
   or GPU caches have erased bytes. Full snapshots, exact digests, retention, and runtime fences
   provide correctness.
9. The repository's existing invalidation feed is valuable adapter and zero-flicker prior art, but it
   is not yet the durable ordering, full-state, multi-layer, offline, and GC contract proposed here.
10. Standardization should follow implementation evidence: vendor extension, conformance corpus, two
   runtimes, benchmarks, then possible `3DTILES_*` or future core promotion.

---

## 19. Primary references

- [OGC 3D Tiles 1.1](https://docs.ogc.org/cs/22-025r4/22-025r4.html)
- [3D Tiles specification source and extension mechanics](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc)
- [3D Tiles extension registry](https://github.com/CesiumGS/3d-tiles/tree/main/extensions)
- [3D Tiles implicit tiling](https://github.com/CesiumGS/3d-tiles/blob/main/specification/ImplicitTiling/README.adoc)
- [3D Tiles next-version scope](https://github.com/CesiumGS/3d-tiles/issues/822)
- [Draft `3DTILES_content_conditional`](https://github.com/CesiumGS/3d-tiles/pull/834)
- [glTF 2.0 specification, including sparse accessors](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
- [glTF extension registry](https://github.com/KhronosGroup/glTF/blob/main/extensions/README.md)
- [glTF vendor `MPEG_scene_dynamic` extension](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/MPEG_scene_dynamic/README.md)
- [KTX 2.0 specification](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html)
- [KTX Fragment URI 1.0](https://registry.khronos.org/KTX/specs/2.0/ktx-frag.html)
- [Quantized-mesh terrain format](https://github.com/CesiumGS/quantized-mesh)
- [OGC API — Tiles Part 1](https://docs.ogc.org/is/20-057/20-057.html)
- [OGC Testbed-15 Images and ChangesSet API Engineering Report](https://docs.ogc.org/per/19-070.html)
- [OGC CDB 2.0 Part 1](https://docs.ogc.org/is/23-034/23-034.html)
- [OGC CityGML 3.0 Conceptual Model — Versioning](https://docs.ogc.org/is/20-010/20-010.html#versioning)
- [OGC WCS Transaction Extension](https://docs.ogc.org/is/13-057r1/13-057r1.html)
- [OGC I3S standard](https://www.ogc.org/standards/i3s/)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html)
- [RFC 8246: HTTP Immutable Responses](https://www.rfc-editor.org/rfc/rfc8246.html)
- [RFC 9875: HTTP Cache Groups](https://www.rfc-editor.org/rfc/rfc9875.html)
- [RFC 9530: Digest Fields](https://www.rfc-editor.org/rfc/rfc9530.html)
- [RFC 8594: The Sunset HTTP Header Field](https://www.rfc-editor.org/rfc/rfc8594.html)
- [RFC 5829: Link Relation Types for Simple Version Navigation](https://www.rfc-editor.org/rfc/rfc5829.html)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [RFC 9562: Universally Unique IDentifiers, including UUIDv7](https://www.rfc-editor.org/rfc/rfc9562.html)
- [Repository live-invalidation research](archive/SESSION_2026-04-08_RESEARCH_REPORT.md#6-live-3d-tiles-invalidation--final-design)
- [Repository snapshot/invalidation reconciliation spike](archive/SNAPSHOT_MODE_SPIKE_2026-04-09.md#32-reconciliation-contract-with-scenesnapshotversion)
- [RFC 5789: HTTP PATCH](https://www.rfc-editor.org/rfc/rfc5789)
- [RFC 3229: Delta Encoding in HTTP](https://www.rfc-editor.org/rfc/rfc3229)
- [RFC 3284: VCDIFF](https://www.rfc-editor.org/rfc/rfc3284)
