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

**The use case this survey is measured against.** The primary target is a *constantly changing* 3D
Tiles data provider—a simulation or live capture pipeline that keeps producing new data for a world
that has already been published. The patches are **dynamic overlays**: data generated after the fact,
against tiles that are already published and already resident in client caches, carrying information
that did not exist when those tiles were created. They are not prebaked alternate states of an
authored asset, and they do not walk a timeline the producer knew in advance. Every comparison below
is made against that case: a live producer, an immutable already-published base, and clients that must
converge on the producer's current state quickly, atomically, and without a visual hole.

**Primary-source survey result as of 2026-08-11, re-surveyed 2026-08-16:** no published or registered
3D Tiles/glTF extension, OGC 3D Tiles standard, or OGC API — Tiles conformance class defines a
client-applied, base-relative patch protocol with the combined semantics proposed here:

1. originate updates from a live producer as post-hoc overlays of data absent when the base was
   published;
2. bind an update to an exact immutable base revision;
3. transfer only a semantic subset of changed tile content;
4. validate and compose that subset across tile and HLOD boundaries;
5. activate an atomic multi-resource state with rollback;
6. retain and later compact ephemeral patch generations;
7. notify clients that an exact prior state is superseded, without making event delivery authoritative;
8. retire and garbage-collect old closures under explicit safety rules; and
9. standardize a patch-versus-rebuild decision contract.

This is a bounded novelty claim about the current published standards and registered extensions—not
a claim that no private engine, I3S/scene service, coverage service, database, CDN, or proprietary
tiler has ever implemented incremental updates.

| Existing mechanism | What it provides | What it does **not** provide | Relation to this proposal |
| --- | --- | --- | --- |
| 3D Tiles `asset.tilesetVersion` and revisioned URIs | Application-specific version/cache invalidation | Partial-content delta, base precondition, atomic patch state, or composition semantics | The coarse whole-dataset ancestor of the head pointer; replaced here by an exact digest-bound head and state manifest |
| 3D Tiles external tilesets and multiple contents | More independently referenced renderable content | Spatial subtraction/masking, replacement precedence, or patch lifecycle | The composition substrate `replaceRegion` builds on; supplies containers, not precedence or lifecycle |
| 3D Tiles `ADD` / `REPLACE` refinement | Parent/child HLOD rendering behavior | Replacement of a polygonal subset across arbitrary active LODs | Governs selection inside one revision; §5.2 correctness must hold across it |
| 3D Tiles implicit tiling | Stable implicit coordinates and compact availability | Modification of part of an existing content payload | Supplies the stable selectors typed codecs address; hierarchy/availability changes still publish a new base revision |
| 3D Tiles tile expiration (`expire.duration`, `expire.date`) | Per-tile polled staleness: after a duration or date the tile's whole content is re-requested, with the old content kept visible until the replacement is ready | Deltas, base preconditions, an authoritative dataset state, atomic multi-resource activation, push, retention, or GC | The closest existing streaming-refresh primitive in 3D Tiles, and the origin of the zero-flicker handoff this design reuses; it composes as the degraded path—a deployment may keep expiration on the base for clients that ignore the extension while aware clients reconcile the head |
| Draft `3DTILES_content_conditional` | Selection among content variants by conditions such as revision/time | Base-relative deltas, masks, content-addressed patch state, or atomic partial mutation; it remains a draft | The nearest active 3D Tiles work: it may eventually select among fully materialized per-tile variants, but selecting an active patch-state manifest would require an integration extension or a change to the draft |
| Time-dynamic 3D Tiles direction (issue #102; June 2025 Cesium roadmap) | The spec steward's stated intent that a single tileset be updated incrementally while preserving a history of changes, with each new capture updating only affected tiles; #102's original per-tile time-series model | A published extension, schema, or wire format; immutable head/state, atomic multi-resource activation, retention/GC, or a patch-versus-rebuild contract | Complementary and the principal convergence risk: it selects among captures authored ahead of delivery, this design publishes overlays a live producer generates afterwards. See the convergence note below |
| `3DTILES_temporal` (published 2020; not registered, not adopted) | A 3D Tiles extension carrying authored `versions`, `versionTransitions`, and feature-level `transactions` with date ranges, plus 4D bounding volumes and per-feature validity intervals; client-side selection by date | Base-relative deltas, immutable head/state, content addressing, atomic activation, retention/GC, publication or notification, or any live-producer path | The closest existing 3D Tiles extension to this design's supersession layer. It versions the *modelled world*; this design versions the *published dataset*. Its transition vocabulary is a direct adoption candidate for §4.4 |
| glTF sparse accessors | Sparse values differing from an accessor's initialization state inside one complete asset | Cross-version base identity, update discovery/distribution, atomic live patching, or tile/HLOD semantics | The typed sparse-data building block a future `sparseAttributeOverride` codec should reuse |
| Core glTF: sparse accessor over a shared external buffer | A conformant construction today: a small new asset may point `buffer.uri` at the base's content-addressed `.bin`, lay a `bufferView` over it, and attach a `sparse` object displacing selected elements—wire cost roughly the sparse indices and values | Cross-asset base identity or digest binding, discovery, ordering, atomic activation, rollback, retention, HLOD composition; and no equivalent for GLB-embedded buffers, whose binary chunk is not addressable from another asset | A zero-new-codec transport option under `replaceContent`/`replaceRegion` for bin-based content, and the reason the "core glTF cannot express this" framing is narrowed to GLB-embedded payloads and to the cross-asset identity/lifecycle gap |
| glTF morph targets, animations, and material variants | Authored alternate states within one asset | An external patch protocol or mutation of an already published asset | Prebaked alternates, the opposite origin from a post-hoc producer overlay; useful only as provenance rules (§2.5) |
| glTF `MPEG_scene_dynamic` and companion media extensions | Registered vendor mechanism for timed scene-description update samples carried by media tracks; per ISO/IEC 23090-14 each update sample is an RFC 6902 JSON Patch document (`add`, `remove`, `replace`, `move`, `copy`, `test`) applied as one timed transaction | A 3D Tiles/HLOD spatial patch contract, exact immutable base/state head, client invalidation, atomic multi-resource publication, retention/compaction, or patch optimizer | The nearest registered *update-document* prior art; its JSON Patch model is direct input to the control plane and the §7 envelope, but its authority model is inverted—the stream is authoritative there, the state snapshot here |
| Other current glTF extensions | Extensibility for geometry, compression, materials, animation, and other asset features | No registered general immutable-base patch/invalidation lifecycle with the combined semantics here | Confirms the negative: the registry has no lifecycle layer |
| KTX Fragment URI | Standard addressing/retrieval of mip, layer, face, time, and spatial texture subresources | Mutation, predecessor/base identity, atomic multi-resource state, or 3D Tiles composition | Prior art for naming a texture subresource, reusable by `textureBlockReplace` selectors |
| Quantized-mesh extensions | Append optional normals, water mask, metadata, and related tile data | Replacement of existing vertices/topology, version chains, or atomic multi-tile patches | Shows the terrain format is extensible by appending, not by replacing; §8 needs a sibling profile |
| OGC API — Tiles Part 1 | Discovery and retrieval of complete tiled representations | Partial/delta update of a tile representation | The retrieval layer this design sits above; unchanged by it |
| OGC Testbed-15 Images and ChangeSet API Engineering Report (19-070) | Experimental checkpoint, changed/deleted-resource lists, and packages of affected 2D tiles | An adopted standard, 3D Tiles subregion patches, immutable active-state composition, or atomic GPU/client activation | Prior art for checkpoint-based recovery of a changed set; 2D-tile scoped |
| OGC Testbed-15 Delta Updates Engineering Report (19-012r1) | Experimental architecture delivering *prioritized* feature deltas to clients in DDIL (denied, degraded, intermittent, limited-bandwidth) environments; an AUDIT/CHECKPOINT changeset algorithm between two checkpoints, realized over transactional OGC API — Features and over a WPS façade, with HTTP conditional requests and a GeoPackage-backed client | An adopted standard, any tiled or 3D content model, HLOD composition, immutable content-addressed state, atomic multi-resource activation, or retention/GC—the report never addresses tiles | The closest prior art for the priority-hinted, degraded-bandwidth half of the control plane; its checkpoint-pair changeset is the feature-domain analogue of `supersedesStateDigest` |
| HTTP caching and HTTP Cache Groups | URI revalidation plus optional same-origin grouping/invalidation inside one cache | Authoritative dataset state, multi-cache synchronization, 3D tile selectors, atomic successor readiness, or object-retention/GC law | The transport-validation layer the head relies on; never the state authority |
| OGC CDB 2.0 versioning | File/table replacement and capture of transitory or ephemeral CDB asset state | A 3D Tiles patch/invalidation protocol, spatial content delta, or client atomic-state compositor | Prior art for ephemeral-state capture in a repository model, not a delivery contract |
| OGC CityGML 3.0 Versioning | Predecessor/successor city-model versions (`Version`, `VersionTransition`) and transactions describing feature creation, termination, and modification | A 3D Tiles/HLOD delivery patch, immutable tile-state head, client invalidation/activation, or patch-compaction protocol | The conceptual parent of `3DTILES_temporal`'s vocabulary, and therefore the upstream source of the transition terms this design may adopt |
| OGC APIs that use HTTP `PATCH` | Server-side CRUD/update of API resources in their own domains | A client-consumable 3D Tiles/glTF content-delta format or HLOD compositor | Confirms the write-side analogue exists and is not the read-side contract needed here |
| OGC WCS Transaction (`WCS-T`) | Insert, delete, or update parts of a server's coverage offering | A patch wire format for 3D Tiles/glTF clients, HLOD composition, or immutable patch-state delivery | Same write-side/read-side split, in the coverage domain |
| OGC I3S 1.3 (17-014r9) and platform scene-layer workflows | An indexed, paged delivery format and the SLPK persistence model for arbitrarily large scene layers | Any client-visible post-publication update, invalidation, or versioning contract: the standard's text defines no delta, incremental-update, or invalidation mechanism. Platform implementations act service-side instead—ArcGIS lets an owner rebuild all or part of a hosted 3D layer cache after edits, or replace a layer's contents with another layer, as administrative operations with no standardized client-facing change signal | Prior art for streaming 3D scene delivery, and operational confirmation that partial cache rebuilds pay for themselves; the update path is unstandardized service-side behavior, so it is not a competing wire contract |
| HTTP delta encoding / VCDIFF | Transfer a byte delta and reconstruct a complete target representation | Semantic vertex/texture operations, GPU-direct application, HLOD correctness, or patch state | A transport codec this design may carry, never a replacement for semantic patch/HLOD rules |

The closest typed sparse-data building block is glTF's sparse accessor, and it is useful input to a
future `sparseAttributeOverride` codec. It is not itself a patch protocol: the sparse data is authored
as part of the glTF asset, and the glTF specification defines neither an external predecessor/base
contract nor update publication, ordering, atomicity, rollback, cache lifetime, or compaction.

One consequence deserves stating plainly, because it narrows an easy overclaim. A small new glTF
asset may set `buffer.uri` to the base revision's content-addressed `.bin`, define a `bufferView`
over it, and attach a `sparse` object that displaces selected elements—all conformant glTF 2.0, with
a wire cost of roughly the sparse indices and values. Core glTF can therefore already express a
*payload* shaped like a delta whenever the base's binary data lives in an external buffer. What it
cannot express is the surrounding contract: which base revision the overlay is bound to, how a client
discovers it, how it is ordered against other overlays, how it activates atomically or rolls back,
how long either object is retained, and how the result composes across tile and HLOD boundaries. The
construction is worth adopting as a zero-new-codec transport option; the novelty claim narrows to
GLB-embedded content, where the binary chunk is not addressable from another asset, and to the
cross-asset identity and lifecycle gap that remains in both cases.

`MPEG_scene_dynamic` is important update-stream prior art rather than a duplicate of this proposal.
It binds timed scene-description updates to media tracks and circular-buffer access, and—per
ISO/IEC 23090-14, though not the extension's own README—each update sample is an RFC 6902 JSON Patch
document, with `add`, `remove`, `replace`, `move`, `copy`, and `test` operations applied as a single
timed transaction. Two things follow. Its timing/stream model is worth studying for the control
plane, and its JSON Patch document model belongs in the study list for both the control plane and the
§7 codec envelope as an already-standardized way to express a bounded edit to a structured document.
Neither closes the gap: this design still needs independent 3D Tiles selectors, HLOD masking,
immutable head/state reconciliation, invalidation, offline recovery, retirement, and compaction, and
it inverts MPEG's authority model—there the stream is authoritative, here the state snapshot is.

The closest active 3D Tiles effort is the draft `3DTILES_content_conditional`, whose proposal
explicitly generalizes earlier time-dynamic 3D Tiles work and cites issue #102 as its origin. It may
eventually help select a revision or time state, but it does not spatially mask stale base content or
deliver a relative update. Conditional content could select among fully materialized per-tile
variants. Selecting an active patch-state manifest would require an integration extension or a change
to the current draft.

#### `3DTILES_temporal`

`3DTILES_temporal` (Jaillot, Servigne, Gesquière and Boix; JSON schemas published 2020-01-02 under
CC BY 4.0, described in *Delivering time-evolving 3D city models for web visualization*, IJGIS
34(10):2030–2052) is the closest existing 3D Tiles extension to this design's supersession layer, so
it is worth characterizing exactly.

It is 3D-Tiles-native, attaching at three extension points. On the **tileset** it adds `startDate`
and `endDate` plus three arrays: `versions`, `versionTransitions`, and `transactions`. A `version`
is a named, dated, tagged set of feature IDs—an enumerated membership list, not a delta. A
`versionTransition` carries `from` and `to` version IDs, a date range, a description of the reason
for the evolution, a `type` from {`planned`, `realized`, `historical succession`, `fork`, `merge`},
and the IDs of the transactions composing it. A `transaction` carries a date range plus `source` and
`destination` arrays of feature IDs; a `primaryTransaction` adds a `type` from {`creation`,
`demolition`, `modification`, `union`, `division`}, and a `transactionAggregate` nests transactions
into composites. On the **bounding volume** it adds `startDate`/`endDate`, yielding 4D bounding
volumes. On the **batch table** it adds `startDates`, `endDates`, and `featuresIds` arrays indexed by
batch ID. Time selection is entirely client-side: the client filters already-delivered features by
date against those intervals. The extension is 1.0-era—keyed to the batch table rather than to
structural metadata—is published as a vendor extension whose own record states that it "has currently
not been integrated in the 3D Tiles standard", and it does not appear in the CesiumGS extension
registry.

What it does not provide: base-relative deltas—every state is materialized in the delivered content,
and the transactions describe semantic relationships between feature IDs rather than content
differences; an immutable content-addressed head or state; atomic multi-resource activation;
retention or garbage collection; and any publication, notification, or live-producer path. It is an
authoring-time model of how a city evolved, delivered whole and filtered locally. It is therefore
prior art for *versioning vocabulary inside a tileset*, not for *delivering a change to a published
tileset*.

**What this design could adopt from it.** Its transition vocabulary is more developed than this
document's and is orthogonal to it, so borrowing costs nothing. §4.4 defines a *lifecycle and
authority* vocabulary—`supersede`, `invalidate`, `revalidate`, `suppress`, `revoke`, `retire`,
`garbageCollect`—which says what the system does to a generation. `3DTILES_temporal` supplies a
*semantic-change* vocabulary, which says what happened in the world. The state manifest and the
transition hint already carry a free-form `reason`; {`creation`, `demolition`, `modification`,
`union`, `division`} is a defensible enumeration for it, and `source`/`destination` feature-ID pairs
are the shape `updateLineage` would take if lineage were ever tracked at feature rather than update
granularity. `fork` and `merge` name branching cases the epoch model does not yet address, and the
`planned` versus `realized` distinction is close to this design's publish-then-activate split.
Adopting the terms also aligns with CityGML 3.0's `Version`/`VersionTransition` model, from which
they derive.

#### Convergence with time-dynamic 3D Tiles

The specification's steward has its own on-point direction, and this survey must engage it rather
than route around it. Issue #102, "Time-dynamic 3D Tiles," has been open since 2016 and proposed
per-tile time series prefetched like streaming video. The draft `3DTILES_content_conditional`
describes itself as a generalization of that work and names #102 as its origin. The June 2025 Cesium
roadmap states that "a single tileset can be updated incrementally, preserving a history of changes,"
with "each new capture updating only affected tiles," and that "no longer will an entirely new
tileset need to be created for each update."

That direction is prebaked and authored ahead of delivery: the captures exist before they are
published, and the client moves along a timeline the producer already knows. This design's patches
have the opposite origin—a live producer emits data that did not exist when the base was published,
onto tiles already resident in client caches. The two are complementary rather than competing.
Similar logic and overlapping flows should be expected; a patch can be a delta *within* a linear time
flow; and this design should aim to **extend** a future `3DTILES_time_dynamic` rather than duplicate
it. A time-dynamic extension would say which state is current for a given time; this design says how
a state is produced, verified, made atomic, superseded, and collected. Nothing published today
occupies the second role.

The convergence risk is nevertheless real and unresolved, and it is the reason for the re-survey
obligation below.

#### Bounded novelty statement

Surveyed 2026-08-11; re-surveyed 2026-08-16. No adopted 3D Tiles, glTF, or OGC API — Tiles
standard—and no registered 3D Tiles or glTF extension—defines the following combination:

1. **live-producer streaming of dynamic post-hoc overlays**: changes generated onto an
   already-published base, carrying data that did not exist when that base was created;
2. **base-relative deltas** bound to an exact immutable base revision and its layout;
3. an **immutable, content-addressed head and active-state manifest** as the single state authority,
   with event delivery reduced to a hint;
4. **atomic multi-resource activation** with rollback across tiles, LODs, and coupled components;
5. **retention, logical retirement, and reachability-based garbage collection** under explicit safety
   rules; and
6. a **patch-versus-rebuild decision contract** the producer can evaluate before encoding.

Every element has prior art individually, and this section names it: sparse encodings in glTF, patch
documents in MPEG-I scene description, subresource addressing in KTX Fragment URI, checkpoint
recovery and prioritized deltas in the Testbed-15 reports, versioning in CityGML 3.0 and
`3DTILES_temporal`, polled refresh in 3D Tiles tile expiration, transactional writes in WCS-T and the
OGC APIs, revalidation in HTTP, and byte deltas in VCDIFF. The claim is only about the combination,
and only about published standards and registered extensions. It is not a claim that no private
engine, scene service, coverage service, database, CDN, or proprietary tiler has implemented
incremental updates. This design occupies a missing layer between immutable tiled assets and
application-specific update systems, and deliberately reuses that prior art rather than restating it.

#### Re-survey obligation

This survey is dated, and the most on-point work is the steward's own and in motion. Before the D1
terminology/scope freeze, re-run R0 and record the result in this section, with the date. The
standing watchlist is:

- `3d-tiles` issue #102 and any `3DTILES_time_dynamic` work that emerges from it;
- the Cesium roadmap's incremental-update deliverable and whatever form it ships in;
- the draft `3DTILES_content_conditional` (PR #834), including whether it grows manifest selection;
- the CesiumGS 3D Tiles extension registry and the Khronos glTF extension registry; and
- MPEG-I Scene Description (ISO/IEC 23090-14) scene-update work.

A finding that any of these has shipped an overlapping contract narrows or retires the novelty claim.
It does not invalidate the design, which can then be re-scoped as a profile of, or an extension to,
that work—the preferred outcome for the time-dynamic case in particular.

### 2.5 Compatibility with adjacent formats and mechanisms

The extension is designed to compose with these mechanisms, but “cleanly” has different meanings for
semantic replacement, typed direct application, and transport-only deltas.

| Mechanism | Compatibility | Required rule |
| --- | --- | --- |
| glTF sparse accessors | **Yes** | A replacement tileset may contain ordinary sparse accessors: strictly increasing indices and absolute values overriding an accessor's initialization state inside one complete asset. `sparseAttributeOverride` reuses that index/value representation and adds external base identity, because a glTF sparse accessor by itself cannot refer to an accessor in a different published asset. A replacement glTF may instead reference the base's content-addressed external buffer by URI and lay a sparse accessor over the same buffer view; that construction needs no new codec but requires a non-GLB base. |
| glTF morph targets | **Yes, with provenance** | `replaceRegion` is transparent. Directly changing base or morph-target attributes requires exact primitive/accessor identity, consistent normals/tangents and bounds, and one atomic resource generation. Weights are per-node runtime state shared by every primitive of the mesh, so bounds evidence must hold over every instantiating node's reachable weight range, not one authored vector. Changing target count or order is content replacement, not a patch. Morph targets remain authored deformation, not patch history. |
| 3D Tiles implicit tiling | **Yes for overlays** | `replaceRegion` composes above the base tree and does not modify subtree availability. Per-content typed patches use exact implicit `(level,x,y[,z])` plus base/content identity. Subtree and content URIs are template-derived from coordinates rather than content-addressed, so hierarchy or availability changes publish a new base revision, and clients must scope coordinate-keyed subtree caches to a base revision. |
| Draft `3DTILES_content_conditional` | **Independent, potentially complementary** | Do not require this draft for the MVP. It may select complete materialized variants. Selecting patch-state manifests or nesting external replacement tilesets would require explicit future integration and whatever the final conditional-content standard permits. |
| HTTP delta encoding / VCDIFF | **Yes as a transport codec** | Bind exact source and target digests, reconstruct the whole immutable target off-thread, verify it, then use the normal loader. This does not replace semantic patch/HLOD rules, and deployment must not assume every CDN/browser implements HTTP delta negotiation. Immutable delta objects fetched with ordinary `GET` are the portable baseline. |
| Quantized-mesh extensions | **Yes through a sibling terrain profile, not the 3D Tiles extension itself** | Preserve and validate every appended extension record. Oct-encoded normals are geometry-dependent and must be re-supplied by the producer, including at tile boundaries; water masks and metadata are preserved byte-identically or separately replaced. Unknown geometry-dependent extensions force whole-tile replacement unless their invariants are declared. Height payloads carry `uint16` decoded-quantized codes only, per Section 8. |

#### glTF sparse accessors

Sparse accessors are a natural payload building block: `sparse.indices` are strictly increasing,
`sparse.values` are absolute, and together they override elements of the accessor's initialization
state — its buffer view, or zeros when the accessor has none. The substitution resolves once at load
time inside one asset and yields an ordinary complete accessor. It is not an ordered delta log, and
it cannot reference another asset.

Three integration modes are valid:

1. Put a complete standards-conformant sparse accessor in replacement glTF content.
2. Reference the base's immutable content-addressed buffer by URI from a small replacement glTF and
   lay a sparse accessor over the same buffer view. This is conformant core glTF and needs no new
   codec: wire cost is the replacement JSON plus the sparse indices and values. It requires a
   non-GLB base whose buffer is separately addressable and fetchable by the client, and the
   replacement binds that buffer's digest so a repack cannot silently redirect it.
3. Reuse the sparse index/value representation in `sparseAttributeOverride`, with additional external
   base identity, layout, atomicity, derived-data, and HLOD requirements defined by this extension.

Mode 3 is not itself an ordinary glTF sparse accessor because core glTF does not let one asset's
accessor inherit data from an accessor in another immutable asset. Mode 2 sets the bar the typed
codec must clear: it already works on paper, so `sparseAttributeOverride` earns its place by avoiding
a second asset parse, by applying to decoded or GPU-resident data, and by carrying the derived-data
and bounds obligations a plain accessor cannot express.

Fork prerequisite: this repository's glTF loader implements no sparse-accessor path — no accessor
`sparse` handling exists anywhere under `packages/engine/Source` — so modes 1 and 2 do not load here
today. Sparse-accessor support in the loader is a prerequisite of the typed-geometry milestone, not
an assumption of it.

#### glTF morph targets

Morph targets continue to operate normally inside base or replacement content. A direct patch may:

- change the base attribute while retaining existing morph deltas;
- change sparse/dense morph-target deltas;
- change initial morph weights or animation data.

The deformed attribute is the base value plus the weighted sum of the target deltas
(`packages/engine/Source/Scene/Model/MorphTargetsPipelineStage.js` emits
`morphed<Attribute> += u_morphWeights[i] * a_target<Attribute>_<i>`), and the weights are per-node
runtime state supplied by the node or its mesh (`packages/engine/Source/Scene/ModelComponents.js`,
`Scene/Model/ModelRuntimeNode.js`) and writable by animation
(`Scene/Model/ModelAnimationChannel.js`). Therefore:

- one mesh may be instantiated by several nodes carrying different weights, so a patch to a base
  attribute or to any target changes every instance. Bounds and geometric-error evidence must be
  proven over the union of every instantiating node's reachable weight range, including
  animation-driven ranges, rather than over the authored weight vector;
- target count and target order are structural. Adding, removing, or reordering targets changes the
  weight-vector arity and every animation sampler that drives it, so it is content replacement, not
  a `sparseAttributeOverride`;
- normal and tangent targets must be patched consistently with position targets, and the producer
  must model the resulting deformed bounds and update every dependent stream.

A patch may not use morph targets as an implicit update log. Weights are runtime state driven by
animation and application code, so an update encoded as a weight change is not a deterministic
function of the published state.

#### Implicit tiling

The overlay design is intentionally tree-agnostic. It masks the rendered base surface in a common
world frame and traverses an independent replacement tileset, so explicit and implicit base tiles can
share the same compositor. Typed patches target implicit contents by stable coordinates plus exact
resource identity; they do not rewrite subtree availability in place.

Availability interacts with content addressing in one specific way. Implicit subtree and content URIs
are produced by substituting coordinates into templates
(`packages/engine/Source/Scene/ImplicitTileset.js` holds `subtreeUriTemplate` and
`contentUriTemplates`), so those URIs are coordinate-derived, not content-addressed: two generations
of one subtree collide at a single URI. The consequent rules:

- an overlay may replace or suppress content at an already-available coordinate. It may never make an
  unavailable coordinate available, or the reverse;
- any availability, subdivision, or hierarchy change publishes a new base revision under a new
  immutable prefix. Its closure reuses every unchanged content object by digest, so the cost is the
  changed subtree files plus the new root, not the dataset;
- a patch targeting implicit content binds the subtree digest and the expected content digest, so an
  overlay can never be applied against a different availability;
- clients must scope subtree caches to a base revision. This engine's `ImplicitSubtreeCache` finds
  cached subtrees by implicit coordinates alone, with no revision component
  (`packages/engine/Source/Scene/ImplicitSubtreeCache.js`), so carrying an entry across a
  base-revision boundary is a correctness failure rather than a cache optimization.

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

- encoded normals are geometry-dependent per-vertex data sized `vertexCount * 2` bytes, and this
  engine never recomputes them, so a patch re-supplies them with cross-tile support (Section 8.1);
- water masks may remain unchanged or be replaced as a separate typed stream;
- metadata may remain unchanged only when its declared semantics remain true;
- unknown extensions are preserved only when declared geometry-independent;
- length/offset changes are handled by reconstructing a complete verified terrain resource rather
  than mutating unknown trailing bytes in place. Every appended record is reached by walking byte
  offsets past the vertex, index, and edge streams, so a vertex or triangle count change invalidates
  all of them at once.

This is clean at the shared patch-envelope/state level, but it requires a quantized-mesh-specific
codec and conformance suite.

---

## 3. Proposed architecture

The driving deployment is a **continuously changing provider**: a simulation advances a world model
and emits an unbounded stream of localized changes while clients fly over the result. Patches are
dynamic overlays of data that did not exist when the base was built, and the architecture is sized
for that stream — arrival rate, not edit count, is the independent variable.

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
- `quantizedMeshHeightOverride` — **sibling terrain profile, not part of the 3D Tiles extension**
  (§2.3). It is listed here to keep the codec ladder in one place; its boundary and engine owner are
  stated in §3.3.5;
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

This section records what this fork already has, what it does not have, and which existing subsystems
a committed patch state touches. It is a fork-implementation boundary, not a wire contract.

#### 3.3.1 Existing prior art

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

#### 3.3.2 Capabilities the engine does not have

Three central laws of this design have **no owner in this repository today**: activate the mask and
replacement in the same frame (§5.2), never partially apply a multi-tile, multi-LOD, or
terrain-plus-imagery update (§10), and activate coupled terrain and imagery revisions together
(§8.4).

What exists instead is a per-tile path. The engine feed swaps one tile at a time by reusing the
expired-content handoff — it assigns the live content to `_expiredContent`, flips the content state,
and skips multi-content tiles entirely — so there is no transaction spanning tiles, no grouping
across providers, and no rollback. Imagery is attached per `GlobeSurfaceTile` with no revision
pinning, and no scene-level object holds one committed generation across a tileset, the globe, and
the imagery layers.

The prototype therefore introduces new engine components. Proposed names and file homes:

| Capability | Proposed component | Proposed file home | Backend obligation |
| --- | --- | --- | --- |
| Frame-atomic multi-tile swap | `Cesium3DTileGenerationTransaction` | `packages/engine/Source/Scene/Cesium3DTileGenerationTransaction.js` | Backend-agnostic. Commits at a frame boundary that precedes pass execution on both backends; retirement rides `Renderer/ResourceOwnership/SubmissionSerialAuthority.ts` on WebGPU and context resource destruction on WebGL. |
| Scene-level coupled-component coordinator | `SceneRevisionCoordinator` | `packages/engine/Source/Scene/SceneRevisionCoordinator.js` | Backend-agnostic. Holds one committed generation per frame across tilesets, globe terrain, and imagery, and separates the rate-limited wake from the committed-state bump against `Scene._snapshotVersion`. |
| Patched content inside the base traversal | `Cesium3DTilePatchCompositor` | `packages/engine/Source/Scene/Cesium3DTilePatchCompositor.js`, with hooks in `Scene/Cesium3DTilesetTraversal.js`, `Scene/Cesium3DTilesetBaseTraversal.js`, `Scene/Cesium3DTilesetSkipTraversal.js`, and `Scene/Cesium3DTilesetMostDetailedTraversal.js` | Backend-agnostic selection; backend-specific only where draw commands are emitted. All four traversal entry points are integration sites — a compositor wired into one of them is wired into none of the others. |
| Region mask realization | `ReplacementRegionMask` | `packages/engine/Source/Scene/ReplacementRegionMask.js` | Dual-backend by construction: WebGL through `Scene/ClippingPolygonCollection.js` and `Scene/Model/ModelClippingPolygonsPipelineStage.js`, WebGPU through `Renderer/WebGPU/WebGPUClippingPolygonCollection.ts`. Both, or the operation does not ship. |
| Coupled terrain + imagery swap | `GlobeSurfaceRevisionSwap` | `packages/engine/Source/Scene/GlobeSurfaceRevisionSwap.js`, driven from `Scene/GlobeSurfaceTileProvider.js` and `Scene/QuadtreePrimitive.js` | Backend-agnostic staging; WebGPU pins realizations through `Renderer/WebGPU/WebGPUSharedImageryRealizations.ts`, WebGL through its own texture path. |
| Revision-pinned imagery attachment | extension of `ImagerySourceIdentity` | `packages/engine/Source/Renderer/ImagerySourceIdentity.ts`, `Scene/ImageryLayer.js`, `Scene/GlobeSurfaceTile.js` | The identity module is already backend-neutral and carries object identity plus a monotonic revision; WebGL must adopt the contract the WebGPU realization table already uses. |
| Residency accounting and pinning | extension of the tileset cache | `packages/engine/Source/Scene/Cesium3DTilesetCache.js`, `Scene/Cesium3DTilesetStatistics.js` | Backend-agnostic. Reports pinned, baked, and double-resident bytes; see §3.3.3. |
| Digest-keyed derived-composite cache | `PatchBakeCache` | `packages/engine/Source/Scene/PatchBakeCache.js`, over `Renderer/ResourceOwnership/RealizationShadowCache.ts` | Backend-agnostic. Holds the §3.4.2 local bake as an evictable entry keyed by exact state/base/patch identity. |

Two of these lean on infrastructure the fork already has and does not yet use.
`Renderer/ResourceOwnership/` supplies content fingerprints with revisions, realization leases, and a
submission-serial authority that runs a retirement only after the submission referencing the resource
has completed. It has no engine consumer today; only `Tools/far200-shadow-self-test.ts` exercises it.
Adopting it is cheaper and safer than inventing a second retirement mechanism, because it already
implements the §10 rule that resources retire only when submitted work can no longer reference them.

Repository principle 5 governs all of it: a capability that composes patched content exists on both
backends, or the work item that schedules it declares it single-backend explicitly. Nothing here is
architecturally WebGL-hostile — the mask is the only piece with genuinely backend-specific halves, and
both halves already exist. Every row is a prerequisite for the prototype phases of §15 and belongs in
[DEFERRED_WORK.md](DEFERRED_WORK.md) before P1 starts.

#### 3.3.3 One tileset, one cache, one budget

**Prototype vehicle:** replacement and rebuilt content ride **inside the base tileset's traversal** as
a compositor subtree, not as sibling `Cesium3DTileset` instances.

The alternative was one tileset per patch. It is rejected for the prototype because each
`Cesium3DTileset` owns a private `Cesium3DTilesetCache` with its own `cacheBytes` and
`maximumCacheOverflowBytes`, its own traversal, its own statistics, and its own stream of requests
against the process-global caps in `Core/RequestScheduler.js` (50 concurrent, 18 per server by
default). N patches would mean N+1 uncoordinated budgets and N+1 candidate swap owners for an
operation whose defining property is that it is atomic across all of them. The compositor keeps one
cache, one byte budget, one request budget, one statistics record, and one swap owner.

The vehicle must add eviction rules the cache does not have today — its unload walk currently drops
any non-selected tile once total memory exceeds `cacheBytes`, with no concept of a pinned entry:

1. Mask coverage and replacement root coverage belonging to the committed generation are **pinned**.
   Evicting them re-exposes base geometry inside the mask and resurrects retired content, breaking
   §5.2 and §10.
2. Content below replacement root coverage evicts normally.
3. Baked composites (§3.4.2) evict first; they are reconstructible from base plus patch.
4. Pinned bytes shrink the usable budget, so activation needs a client-side admission gate: if the
   committed pinned coverage would exceed a configured fraction of `cacheBytes`, refuse activation and
   report degraded absence rather than thrash. This gate is a client rule and is distinct from the
   producer optimizer of §9.
5. Bounded zero-flicker double residency is expressed in `maximumCacheOverflowBytes` headroom. A swap
   whose predecessor plus successor coverage does not fit within `cacheBytes` plus
   `maximumCacheOverflowBytes` defers instead of committing.

Content held by other residency systems is out of MVP scope: voxel content is resident in its own
budget (`Scene/Megatexture.js`, `Scene/VoxelTraversal.js`), so a state spanning it crosses two
independent budgets with no shared trim policy.

#### 3.3.4 GPU residency

The fork's GPU-resident tile direction is recorded in
[Phase 8 — GPU-Resident Tiles Design](PHASE_8_GPU_RESIDENT_TILES_DESIGN.md). Its foundation shipped;
the resident stack it describes — a GPU-side tile store with per-tile columnar arrays, mesh
mega-buffers, a resident drawer, and GPU-side style evaluation — is unbuilt. The two designs
reconcile as follows.

- **No contradiction in kind.** That design reserves load and evict as the only write points into
  resident storage and forbids mid-frame mutation. A committed patch is a load followed by an evict,
  so it uses the channel already reserved for it.
- **One premise yields, and it is Phase 8's.** Its case for data-oriented storage rests on tile
  content mutating rarely. A continuously changing provider makes that false as stated. The amendment:
  per-frame CPU cost becomes O(camera-delta + committed-change-delta), and the second term is bounded
  by the same admission and throttle rules that bound the producer in §3.4.3. The resident layout does
  not change; the cost claim does.
- **One rule binds this design.** A commit allocates a new slot, commits, then frees the predecessor
  slot; it never mutates a live slot in place. This is the resident-storage form of the immutable-base
  law, and it is what keeps a swap atomic once the store is GPU-side.
- **One swap owner, not two.** If the resident stack lands after this prototype, its slot-table write
  becomes the transaction's commit rather than a second owner inside the store. The transaction of
  §3.3.2 is therefore written so that committing is a table write, not a mutation of tile objects.
- **The facade requirement extends to patched content.** That design keeps `Cesium3DTileset`,
  `Cesium3DTile`, and `scene.pick` as the public surface; the compositor subtree is reachable through
  the same surface, never through a parallel API.

The additive residency techniques queued for voxels and point clouds
([technique audit](VOXEL_POINTCLOUD_GSPLAT_AUDIT_2026-08-09.md)) each add one coupling:

- **Continuous point-cloud LOD.** The GPU LOD layer keeps a point from a hash of its identifier
  against a distance function (`Shaders/WebGPU/Compute/PointCloudLOD.wgsl`,
  `Renderer/WebGPU/WebGPUPointCloudLODProcessor.ts`). A patch that renumbers point identifiers inside a
  mask changes the kept set and pops. Identifier stability is therefore a codec precondition for point
  content, or the transition retires LOD state for the affected extent.
- **Voxel empty-space skipping.** Per-slot occupancy metadata is derived from content, so a patched
  brick invalidates its occupancy entry. Derived data is regenerated inside the same atomic
  transition — the same obligation the terrain profile carries for client-derived descendants
  (§3.3.5).
- **Ray-guided residency feedback.** GPU miss-flags return through a readback ring. Feedback records
  carry the generation that produced them and records from a retired generation are dropped, or the
  streamer loads content for a state that no longer exists.
- **Two-pass compute point rasterization.** A commit must not fall between the two passes. Committing
  at a frame boundary satisfies this by construction, which is one reason the boundary is normative
  rather than convenient.

Local baking (§3.4.2) **composes** with GPU residency under two rules: the bake is a slot write like
any other load, and the slot table records the bake's exact digest key and generation so refill is
reproducible and a stale slot is detectable. It conflicts only with in-place slot mutation, which both
designs forbid.

#### 3.3.5 The terrain boundary and its crossings

§2.3 keeps quantized-mesh terrain and independent imagery outside the 3D Tiles extension. Three
crossings exist anyway; each has an owner:

| Crossing | Where it appears | Owner |
| --- | --- | --- |
| Quantized-mesh height override among the Layer B codecs | §3.1 | Terrain sibling profile. Engine owner is `Scene/GlobeSurfaceTileProvider.js` and the terrain data classes, never `Cesium3DTileset`. |
| Client-derived descendants: `Scene/GlobeSurfaceTile.js` upsamples child terrain from a parent and caches the result per tile rather than per parent generation, so a parent height patch leaves stale children | §8.1 | Terrain sibling profile plus `GlobeSurfaceRevisionSwap`, which invalidates every derived descendant in the same transition. |
| Coupled imagery revision | §8.4 | Imagery profile plus revision-pinned attachment through `Renderer/ImagerySourceIdentity.ts`. |

A deployment with terrain and imagery only has no `tileset.json` on which to hang the extension, so
its discovery bootstrap belongs to the sibling profiles rather than to this one (§16).

#### 3.3.6 Subsystem couplings a committed generation touches

Cross-referenced against [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md). `Scene/Cesium3DTilePass.js`
defines eight passes; render, pick, shadow, and the most-detailed passes each run their own traversal
and their own tile requests, so a generation is observed more than once per frame.

- **Picking.** Two obligations. The commit boundary lies between frames, so every pass within a frame
  observes one generation — pick never sees a generation the color pass did not. And the most-detailed
  passes materialize content outside the render frontier, so masks and tombstones bind at traversal
  time for future-loaded content rather than by walking the current cache (§10 states the law; the
  traversal is where it binds). Engine sites: `Scene/Picking.js`,
  `Renderer/WebGPU/WebGPUPickFramebuffer.ts`.
- **Height and ray queries.** `pickFromRay`, `sampleHeight`, and `clampToHeight` drive most-detailed
  traversals over the same content, so "rendering-only" (§16, decision 1) is not free in this engine:
  those queries observe the base unless the mask applies to their pass too. Whichever way that decision
  settles, it is stated as a capability of the profile rather than left to fall out of the
  implementation.
- **Shadows.** The shadow pass builds its cast list from its own traversal. Masked base content stops
  casting in the same commit frame, or a flattened hill keeps its shadow. Engine sites:
  `Scene/ShadowMap.js`, `Renderer/WebGPU/WebGPUCSMCastPass.ts`,
  `Renderer/WebGPU/WebGPUPrimitiveShadowCast.ts`.
- **Classification and draping.** Classifiers resolve against the classified surface's depth, so the
  classification depth target is re-derived against the replacement in the commit frame. A classifier
  that targets terrain does not see a replacement delivered as 3D Tiles content, so a coupled state
  declares which surface its classifiers target. Engine sites: `Scene/ClassificationPrimitive.js`,
  `Scene/Vector3DTilePrimitive.js`, `Scene/InvertClassification.js`,
  `Renderer/WebGPU/WebGPUTranslucentTileClassification.ts`.
- **Temporal reprojection.** A generation swap is a disocclusion with no motion vector: geometry
  appears and disappears between two frames whose cameras agree. Temporal history is rejected for the
  affected extent in the commit frame, or the swap ghosts. The fork's shared history is
  `Scene/ViewTemporalHistory.js`; the WebGPU consumer already carries a motion-vector validity switch
  (`Renderer/WebGPU/WebGPUTAAEffect.ts`).

### 3.4 Source-driven rapid iteration loop

This is the canonical end-to-end flow for a producer whose source is a running simulation. The
low-latency patch path and the durable rebuild path are two stages of one pipeline, not competing
long-term storage models:

```text
simulation step + updateId/sourceRevision
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

Because the source is a stream rather than an occasional edit, the loop is a steady state rather than
an event: at any instant a client may be applying generation `g` while the producer publishes `g+1`
and rebuilds a prefix ending at `g-k`. Every rule below is written for that condition.

#### 3.4.1 Producer decision and patch-first path

1. **Record and localize the source change.** Assign `updateId`/`sourceRevision`, compute a bounded
   affected feature/region/tile/LOD summary, and perform no full-tile scan in the fast estimator. A
   simulation step may emit zero, one, or many changes; each is localized independently, and the step
   boundary is not itself a publication boundary.
2. **Run the patch-versus-materialization heuristics.** Correctness gates run first. The cost model
   then decides whether a typed patch/`replaceRegion` is materially cheaper than rebuilding the
   affected content, tile set, or subtree. `NO_OP`, bounded coalescing, and semantic suppression are
   explicit outcomes; “patch” is never chosen solely because its wire payload is small. Under a
   sustained stream, coalescing several steps into one publication window is the normal case rather
   than the exception, and the decision is evaluated against that window rather than against one
   change.
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

Receiving a newer verified state is immediate; expensive realization may be demand-driven. The camera
is normally in motion while the stream arrives, so visibility is re-evaluated every frame and each
rule below is written against a moving frontier:

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
  GPU sparse-updated, or compositor-backed according to the codec and cost model. Under GPU residency
  the bake is a slot write whose key and generation the slot table records (§3.3.4), and it is the
  first thing evicted under budget pressure (§3.3.3).
- If a newer rebuilt tile becomes authoritative before an off-screen patch is realized, skip the
  obsolete bake and prepare the newest generation directly. Under a sustained stream this is routine,
  so skipped-obsolete-bake and wasted-pre-bake counts are first-class benchmark outputs (§15.2) rather
  than anomaly reports.

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

**Dependency on the optimizer's terminal-patch semantics.** Under decision 14 (§1.2) every economical
patch is followed by a durable rebuild, so with a never-idle stream the rebuild queue is never empty
and the parameters above are what bound patch debt. If §9 instead admits **terminal** patches —
patches whose mandated rebuild is uneconomical and is therefore never scheduled — then `maxWait` stops
being a completion timer and becomes a debt ceiling, and these thresholds become the inputs that decide
terminality. §9 owns that decision; this section states the dependency and is re-read against whichever
way it settles. The client rules of §3.3.3 and §3.4.2 are unaffected either way, because a terminal
patch is still an ordinary committed generation to a client.

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

Because the simulation does not pause for the rebuild, publication of the rebuilt successor races the
next steps of the stream. The surviving-tail rebase rule is therefore load-bearing under the primary
deployment rather than an edge case: a rebuild that cannot rebase its tail defers (§3.4.3) instead of
publishing a base that silently drops changes.

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
| `trustDomainId` | Identifier for the authenticated publisher scope entitled to speak for a dataset: the entrypoint origin in the unsigned profile, and the origin plus the accepted publisher key set in the signed and revocation profiles. Every durable client record is scoped by `(trustDomainId, datasetId)`. |
| `generationWatermark` | Durable client-side monotonic floor: the highest `generation` the client has verified and activated for one `(trustDomainId, datasetId)` pair. It is client state and is never published. |

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

This object is mutable. It is served with a strong ETag under the revalidation policy of
Section 4.5, and it is the only mutable object in the model.

The head answers one question: which state is current. Integrity of everything it names follows from
digests; freshness of the head itself does not follow from anything unless it is made to. Three
layered freshness profiles are defined, and a publication MUST declare exactly one.

**Unsigned profile — integrity only.** The head carries no publisher authentication beyond the
transport. A client can prove that the state it fetched is the state the head named and that every
payload matches its digest, but it cannot prove the head is current. An origin or intermediary that
keeps serving an old head pins a client to an old generation for as long as it likes, and a cold or
restarted client cannot detect it. This profile therefore provides integrity and internal consistency
only: **it offers no rollback resistance, and a stale-serving cache or CDN is an undetected
exposure.** A publication using it MUST NOT claim authoritative currentness, and MUST NOT be used for
the revocation profile.

**Signed profile — freshness.** The head is a short-expiry signed head statement:

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
  },
  "issuedAt": "2026-08-11T18:22:41Z",
  "expiresAt": "2026-08-11T18:23:11Z"
}
```

The signature is **detached** and covers the exact served head bytes, so the signed input is the same
byte string the client hashed and parsed (Section 4.3) and every member of the head is bound,
`datasetId`, `generation`, `stateDigest`, `updates.updateEpochId`, `issuedAt`, and `expiresAt`
included. It is delivered in the same response that carries the head, so one conditional `GET` returns
both. Under a signed or revocation profile a head served without a verifiable signature is not a head:
the client rejects it and keeps its last verified state. A statement whose signature verifies but
whose `datasetId` or trust domain is not the one the client bootstrapped MUST also be rejected.

A client of this profile MUST maintain a durable `generationWatermark` per
`(trustDomainId, datasetId)`:

- a verified head naming a `generation` below the watermark MUST be rejected and MUST NOT be
  activated, however well formed and well signed it is;
- a verified head naming the watermark generation with a `stateDigest` other than the one recorded for
  that generation is a verified split-brain and fails closed (Section 4.4);
- the watermark advances only after a state is fetched, verified against the head, and activated;
- the watermark MUST survive reload, cache eviction, and process restart for as long as the client
  retains any content from that dataset. A client that cannot persist it MUST report that it has no
  rollback resistance rather than silently offering the unsigned guarantee under a signed name.

A publication declaring this profile MUST also declare `maxStaleness`, the maximum age of a head
statement a client may treat as current, and `expiresAt` MUST NOT exceed `issuedAt + maxStaleness`.
`maxStaleness` MUST NOT exceed the deployment's `maxHeadRevalidationInterval` and SHOULD equal it
(Section 4.5): a shorter window leaves conforming clients stale between revalidations, and a longer one
would let a client claim currentness while out of contact for longer than the retention arithmetic
assumes. Every required/current claim in this document — authoritative currentness, the
no-old-geometry guarantee, and revocation — holds only while the client holds an unexpired,
watermark-passing head statement.

Expiry behavior is specified, not left to implementations:

- while the statement is unexpired, the state it names is current;
- once it expires and revalidation has not yet produced a newer one, the client MUST keep serving the
  last verified state, MUST mark it stale in its diagnostics, and MUST stop making required/current
  claims for it. It MUST NOT blank content merely because a statement expired;
- the client MUST NOT adopt a lower generation at any point, expired or not. Recovery is always
  forward: revalidate until a statement at or above the watermark verifies;
- a hard revocation already applied is not undone by expiry (Section 13).

**Revocation profile — freshness plus entrypoint identity.** The signed profile, plus a pinned
entrypoint: the head statement additionally binds `entrypointDigest`, the digest of the canonical
bootstrap fragment (Section 4.4) the client is expected to have loaded. A client MUST compare the
entrypoint it actually loaded against that digest, so an entrypoint served with the extension stripped
or repointed at another head cannot silently downgrade the client to an unsigned stale base. A
mismatch fails closed under this profile.

**Sizing for a live producer.** The head is the only object that moves, so a producer that publishes
continuously moves it continuously; the identity model is sized for that, not for occasional
publishes. The head stays inside the roughly 1 KB discovery budget of Section 14 with the signed
members added: the body grows by two timestamps, plus one digest under the revocation profile, and the
detached signature and key identifier ride in the response fields at roughly 100-200 bytes for a
compact modern suite. The head never grows with dataset size, patch count, or history, because it
carries none of them. Cost scales with audience and cadence only: `C` connected clients revalidating
every `T` seconds cost `C/T` conditional `GET`s per second, and all but the ones that cross a
publication return `304` with no body, which is what makes a high head-move rate affordable behind a
CDN. A deployment SHOULD set publication cadence, minimum client revalidation interval, and the
signature validity window together — a validity window shorter than the revalidation interval leaves
every client permanently stale — and SHOULD sign one statement per head move rather than per request,
since the statement is identical for every client. `generation` is uint64, so a producer moving the
head a thousand times a second cannot exhaust it.

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
A client missing one does not activate the primary representation. It selects a compatible
`materializedFallbacks` entry already bound inside this same authoritative state manifest when the
state binds one and it is ready, and otherwise keeps whatever it was already showing and reports
itself non-current. That is a currentness statement, not a fail-closed suppression: an incapable
client is never made to blank content it already had (Section 11). A fallback names an exact
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
client that does not implement that required profile rejects the state, keeps what it already had,
and makes no absence claim about the revoked target. The hard-absence guarantee is scoped to clients
that implement the profile (Sections 11 and 13). Neither list is a general audit log, and both must be
compacted or sharded under explicit limits.

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
- byte-identical duplicate tombstones normalize to one stable `tombstoneId`/target identity **before**
  the state is serialized. That normalization is a producer authoring step; a served manifest still
  containing two byte-identical tombstone records, or two records sharing a `tombstoneRevisionId`, is
  noncanonical and is rejected rather than repaired (Section 4.3);
- every reconstructed resource has an exact expected output digest;
- a future dependency profile may permit same-target overlap only inside a bounded acyclic
  `dependsOnPatchRevisionIds` graph with exact input/output digests at every edge. That graph—not
  manifest order—defines deterministic execution; unrelated overlap still rejects; and
- state membership defines readiness/commit coupling, not patch precedence;
- when the future authenticated revocation profile is enabled, a verified revocation has fixed
  fail-closed dominance over any patch or tombstone targeting the revoked digest. This is profile
  semantics, not list order.

The law must also yield exactly one result when a supersession and an invalidation reach a client for
the same target at the same time. Precedence is fixed:

1. **Generation.** Head compare-and-swap totally orders states, so the higher verified `generation`
   wins outright and an operation present only in a lower generation has no effect. A hint never
   competes with a state at all: it carries no operations, so a control-plane invalidation naming a
   target that the newly verified state omits resolves to omission, which is already retirement.
2. **Absence beats presence within one state.** An operation absent from the active set is retired for
   that generation regardless of any earlier hint, cached descriptor, or in-flight preparation naming
   it.
3. **Operation kind within one state.** For one semantic element, a verified revocation dominates a
   tombstone and a tombstone dominates a patch. Under the MVP disjointness rule no two of these can be
   active on the same element, because the overlapping pair rejects at validation, so this ordering is
   the safety net for the future dependency and revocation profiles rather than a routine path.

These rules make a cold load deterministic, make a concurrent supersede and invalidate converge on one
answer, and prevent the same active snapshot from producing different bytes after list reordering. The
first `replaceRegion` profile requires disjoint **closed**
masks, including boundaries and transition collars; typed codec schemas must expose equally precise
write-set conflict tests.

Canonical state serialization sorts every semantically unordered component, patch, tombstone,
revocation, capability, fallback, and `updateLineage` array by its specified identity key before
hashing.
RFC 8785 canonicalizes JSON syntax but does not sort arrays, so this extension/profile must define
those keys.

Canonical form is what is served, not merely what is hashed. A publisher MUST serve exactly the
canonical bytes at `stateUri`, and `stateDigest` — with any signature over the state — is computed
over those served bytes (Section 4.3). A client MUST reject, never repair, a manifest that is not
already canonical: noncanonical array order, a duplicate JSON object key, a duplicate identity key
within an array, or any other RFC 8785 violation. There is no normalizing client and no implementer's
choice here. This removes the parser-differential surface in which two distinct byte streams both
claim one digest, and it reduces verification to hashing the bytes that arrived.

| Array | Canonical ascending key/comparator |
| --- | --- |
| `components` | UTF-8 byte order of unique `componentId`. |
| `sourceDomains` | UTF-8 byte order of unique `sourceDomainId`; at most one entry is `default`. |
| `patches` | RFC 9562 network-byte order of unique `patchRevisionId`. |
| `tombstones` | RFC 9562 network-byte order of unique `tombstoneRevisionId`. |
| `revocations` | RFC 9562 network-byte order of unique `revocationId`. |
| `requiredCapabilities` | UTF-8 byte order of the unique complete exact capability string; duplicates are invalid. |
| `materializedFallbacks` | UTF-8 byte order of unique `fallbackId`. |
| `updateLineage` | RFC 9562 network-byte order of unique `updateId`; ties are invalid. |

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
- Old bases and patches remain available for at least the retention window that Section 4.5 computes
  from the deployment's declared constants.
- Logical invalidation changes authority and reachability; it does not rewrite or purge a
  content-addressed object.

#### Digest strings and algorithm agility

A digest is `algorithm ":" lowercase-hex`, where `algorithm` is a registered token and the hex string
is the full-length output of that algorithm. The address names the algorithm, so no digest can be
reinterpreted under a different one and no verifier has to guess.

- The registry for this profile is `sha256`, and nothing else. Every digest a conforming MVP publisher
  emits MUST use it.
- An unknown or unregistered algorithm token MUST be rejected. A client MUST NOT fall back to a weaker
  algorithm, accept a truncated output, or accept an unprefixed digest.
- One suite per closure: every digest reachable from one state — state manifest, base descriptor,
  resource manifest and its entries, patch descriptors, payloads, replacement closures, retirement
  manifests — MUST use the same algorithm. A closure that mixes algorithms is rejected, so no
  verification path can be steered toward its weakest link.
- Adding an algorithm is a profile version change and migrating to one is a republication: the
  publisher emits a new base revision and a new state whose closure is uniformly addressed under the
  new suite. There is no in-place upgrade and no negotiated downgrade.

#### The digest chain has no unauthenticated hop

Every authority hop is covered:

| Hop | Covered by | Notes |
| --- | --- | --- |
| entrypoint to head | `headUri` in the bootstrap fragment; additionally `entrypointDigest` under the revocation profile | The unsigned and signed profiles do not bind the entrypoint, so a stripped or repointed entrypoint is a downgrade those profiles permit and the revocation profile does not (Section 4.1). |
| head to state | `stateDigest` over the served canonical state bytes | The head is the freshness authority; Section 4.1 states exactly what each profile proves about it. |
| state to patch descriptor | `descriptorDigest` | Fetched and verified with the state-control closure. |
| descriptor to payload | `payloadDigest` plus closure digests | The heavy payload may be lazy; it is never activated unverified. |
| state to base | `baseDigest` | Binds the canonical base descriptor including root identity and resource-manifest identity. |
| base to resources | `resourceManifestDigest`, then per-resource digests or Merkle proofs | Touched resources verify without hashing the whole base. |
| replacement tileset to its closure | the same resource-manifest mechanism | Replacement content is not a trust exception. |

Two links are deliberately not digest-covered, and neither can authorize content. The transition hint
(Section 4.4) carries no authority at all. Outside the revocation profile, the entrypoint that names
`headUri` is unbound, and the head itself is authenticated only in the signed and revocation profiles;
that exposure is stated in Section 4.1 rather than left implicit.

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
      "freshnessProfile": "signed",
      "fallback": "staleBase"
    }
  }
}
```

The final vendor name is intentionally unfrozen. If current/revoked-state behavior is required for
correct rendering, the extension must also appear in `extensionsRequired`; an optional-to-ignore
extension can promise only a valid but potentially stale base.

`freshnessProfile` is one of `unsigned`, `signed`, or `revocation` and selects the guarantees of
Section 4.1. A client that does not implement the declared profile does not participate in it: it is
an unaware client for this dataset and behaves exactly as Section 11 describes. The revocation profile
additionally publishes the trust-domain descriptor and key material its clients pin; key distribution
and rotation remain open (Section 16).

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
| `fail closed` | Refuse to treat a disputed input as authoritative and stop making the guarantee it would have supported, without inventing a new visible state: keep the current verified generation, do not activate the disputed input, report the condition, and reconcile against the authoritative head. It never means blanking content that no rule requires to be absent, and it is never reachable from unauthenticated input. The only operation that intentionally produces absence is `revoke`. |

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
ordering authority.

`affected` is a conservative optimization hint. It MAY be omitted, and an omitted `affected` is
simply no coverage claim. When present it MUST cover every changed target conservatively; a present
array with false-negative coverage is a publisher defect. An empty array MUST NOT be sent, because
"this transition changed no target" is not a claim a transition can make. In no case does `affected`
replace state verification or suppress content.

Idempotency and ordering are different questions and one projection cannot answer both, so the hint
carries two independent keys:

- the **semantic identity projection**, bound by `invalidationId`, contains only `datasetId`,
  `generation`, `supersedesStateDigest`, and `successor.stateDigest`. Canonicalize and hash that
  projection. It answers "is this the same logical transition?" and is stable across transports,
  epochs, re-serialization, and `formatVersion` revisions, because none of those changes which
  predecessor state became which successor state;
- the **transport ordering key** `(trustDomainId, datasetId, updateEpochId, sequence)` answers "have I
  seen this delivery, and did I miss one?" It orders and deduplicates deliveries within an epoch and
  carries no semantic authority whatsoever.

`successor.stateUri`, `mode`, `reason`, and `affected` are non-authoritative routing, priority, or
diagnostic hints and may vary or be omitted across transports; they never change state semantics or
authorize content. The subsequently verified head supplies the usable state URI and complete identity.

Durable deduplication state — seen `invalidationId` values, epoch and sequence positions, and the
`generationWatermark` — is scoped by `(trustDomainId, datasetId)`. Nothing learned in one trust domain
is applied in another, so a hint from an origin that does not speak for a dataset cannot pollute that
dataset's dedup record.

An epoch reset is an ordinary, expected event for a live producer. It mints a new `updateEpochId` and
restarts `sequence`, and it changes transport identity only. A transition re-served after a reset
keeps its `invalidationId` and its semantic identity projection, because the transition itself did not
change. A client MUST NOT treat a re-served transition under a new epoch as a conflict.

Client laws:

1. `invalidationId` is the idempotency key for the semantic identity projection, and
   `(trustDomainId, datasetId, updateEpochId, sequence)` is the delivery key. Replaying either with
   the same value of the projection it binds is idempotent. Reusing `invalidationId` for a divergent
   semantic projection is a publisher defect: the client ignores the hint and reconciles against the
   head (law 9). Reusing `updateEpochId` across different sequence values is the normal definition of
   an epoch, and a new epoch with restarted sequence numbers is a reset, not a conflict.
2. A hint naming a lower generation than the client's verified generation is stale and ignored. A hint
   naming an equal generation with a different state digest is an anomaly, not a verdict: the client
   ignores it and reconciles (law 9). Split-brain is declared only from verified data — when the
   client's own verified head names a generation it has already verified for this
   `(trustDomainId, datasetId)` with a different `stateDigest`, or names a generation below the
   durable `generationWatermark`. That verified disagreement fails closed (Section 4.1).
3. A sequence gap, epoch change, unknown predecessor, reconnect, or cold start fetches the latest
   head and complete state snapshot; event-chain replay is never required and no hint history is
   retained beyond the dedup window.
4. The client keeps the old valid state active while the successor is fetched, verified, and
   prepared. Ordinary invalidation and replacement commit in the same frame transition.
5. Publisher rollback is a **new higher generation** referring to prior known-good immutable content;
   generations never decrease.
6. A notification cannot inject an arbitrary URI or patch. The verified head/state and their digest
   closures remain authoritative.
7. The fetched state's `datasetId`, `generation`, and `stateRevisionId` must exactly equal the head,
   and its canonical digest must equal `stateDigest`. That comparison is between two verified objects,
   so a mismatch is a retry or a fail-closed split-brain. A hint's successor generation/digest must
   match the subsequently verified head before it can accelerate work, but a disagreement there is
   hint evidence only: discard the hint and reconcile ordinarily (law 9), never activate from the
   hint, and never fail closed on hint evidence alone.
8. For direct-transition optimization, the hint's `invalidationId` and `supersedesStateDigest` must
   equal the state transition's `invalidationId` and `parentStateDigest`. A mismatch discards the
   incremental hint path and performs ordinary complete head/state reconciliation; it cannot reject an
   otherwise valid cold-load snapshot solely because non-authoritative hint metadata was wrong.
9. Every hint-plane anomaly resolves the same way — replay with a divergent projection, reordering, a
   sequence gap, an epoch reset, an unknown epoch, an unparseable or oversized hint, a hint for an
   unknown dataset: ignore the hint and schedule a rate-limited head reconciliation, exactly as law 8
   already does for a mismatched direct transition. The rate limit is per
   `(trustDomainId, datasetId)`, jittered, and coalesces an anomaly burst into one revalidation. No
   anomaly on this plane produces a fail-closed state, blanks content, or advances any durable record
   other than the dedup window.
10. Hints are unauthenticated by construction, so the most they may ever cause is something the client
    was already entitled to do: revalidate the head sooner. Hint content MUST NOT suppress content,
    reject a state, trip a fail-closed condition, or persist anything that would change the outcome of
    a later verified reconciliation. Hint rate is bounded, and an over-rate transport is throttled or
    dropped rather than obeyed.

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
      "baseDigest": "sha256:...",
      "retainUntil": "2026-09-04T00:00:00Z"
    },
    {
      "kind": "patchClosure",
      "compactedThroughSourceRevision": "source:918274",
      "closureDigest": "sha256:retired-closure-root",
      "retainUntil": "2026-09-04T00:00:00Z"
    }
  ],
  "purgeEligibleAfter": "2026-09-11T00:00:00Z"
}
```

Each retired closure carries `retainUntil`, the publisher's guaranteed-availability deadline for that
closure. `purgeEligibleAfter` is the earliest time an implementation may even consider collection and
MUST be greater than or equal to every applicable `retainUntil`; neither field is permission to
delete.

Retention is computed from declared deployment constants rather than from prose. A publication MUST
declare at least:

| Constant | Meaning |
| --- | --- |
| `maxHeadRevalidationInterval` | The longest an aware online client may go without revalidating the head. It is also the head's staleness bound for currentness claims and the ceiling on the signed profile's `maxStaleness` (Section 4.1). |
| `maxLazyFetchHorizon` | The longest a client may defer fetching a lazy-closure resource of a state it has already activated before it must either complete the fetch or drop its claim on that state. |
| `propagationWindow` | The declared CDN and intermediary propagation plus retry/backoff allowance. |
| `offlineWindow` | The declared offline, rollback, and pinned-package lease window; zero when the deployment offers none. |

Aware online clients MUST honor the first two: revalidate at least once per
`maxHeadRevalidationInterval` while active, and complete or abandon a lazy fetch within
`maxLazyFetchHorizon`. A client that does not meet them is an offline client by definition and makes
no currentness claim.

Retention for a retired closure is then at least
`maxHeadRevalidationInterval + maxLazyFetchHorizon + propagationWindow + offlineWindow` plus an
operator grace margin, and `retainUntil` MUST NOT be set earlier than that. There is no reader lease
and no server-side session registry: an anonymous HTTP reader is bounded by the constants it is
required to honor, which is what keeps the model workable for a CDN-fronted, unauthenticated audience.
A client that exceeds those constants has not broken the protocol; it has become an offline client,
and it recovers by fetching the current head and complete state.

A server object remains available while reachable from any retained state root, shared resource
closure, rollback point, deployment pin, offline package or lease, or **published entrypoint**.
Garbage collection requires a reachability proof plus expiry of all four declared windows.

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

#### Published entrypoints are durable named roots

An entrypoint is a URL the deployment has handed out: the optional/stale-compatible base URL, the
required/current URL, and either member of a dual-entrypoint pair (Section 11). Each one is a
**durable named root** in the collector's root set and holds the exact base revision or state it
currently names, together with that object's transitive closure. "Active publication" is therefore not
a judgment call: a root exists for as long as the deployment publishes the name.

Repointing is the only way to release one:

1. publish, verify, and pin the new target closure exactly as for an ordinary publication;
2. atomically repoint the named entrypoint at the new target;
3. keep the previous target rooted for the full retention window computed above, so a client that
   already resolved the old name still resolves its closure;
4. drop the old root only after that window expires; and
5. retiring a name outright, with no successor, still holds its last target for the retention window
   before the root is dropped.

The stale-compatible base entrypoint is a mutable pointer and MUST be served as one: strong ETag,
`Cache-Control: no-cache` — or a short freshness budget with `must-revalidate` in a bounded-lag
deployment — and conditional `GET` revalidation, on the same terms as the head. Serving it instead as
a redirect to the current immutable base-revision URL is permitted and preferred where the deployment
can express it, because it keeps mutability in one place. What is not permitted is an entrypoint served
with immutable caching semantics: that produces an unbounded population of clients pinned to a base
revision nobody is retaining.

HTTP policy follows the identity model:

- content-addressed immutable objects use a long freshness lifetime plus `immutable`;
- the head is mutable and MUST NOT be served with a freshness lifetime exceeding the declared
  `maxHeadRevalidationInterval`. The immediate-notification profile serves it with
  `Cache-Control: no-cache, must-revalidate` and a strong ETag, and a hint-triggered request requires
  end-to-end revalidation; a bounded-lag polling profile may instead declare a short freshness budget
  plus `must-revalidate` and accept that delay as its stated maximum lag. Under the signed profile the
  detached head-statement signature is served with the head, so one response satisfies both;
- for a continuously publishing producer the steady-state cost is conditional `GET`s rather than head
  downloads: a client revalidates on each accepted hint, rate-limited per law 9 of Section 4.4, and
  otherwise at its polling interval, and an unchanged head answers `304` with no body. A deployment
  SHOULD choose publication cadence, minimum client revalidation interval, and signed-statement
  validity window together — a validity window shorter than the revalidation interval leaves every
  client permanently stale, while a revalidation interval longer than the publication cadence merely
  means clients skip intermediate generations, which is safe because every state is a complete
  snapshot;
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

Payload rules:

- `expectedContentDigest` binds the predecessor's bytes exactly as published — the stored encoding,
  not a decoded form — so a recompressed or repacked base is a different target and rejects.
- The replacement's container encoding is independent of the predecessor's. Whole-slot replacement is
  the required fallback whenever a Layer-B codec gate rejects a base encoding (Section 7), so a
  Draco-compressed slot may be replaced by uncompressed content, or the reverse, provided the slot's
  declared invariants still hold.
- The replacement carries its own complete resource closure. It may reuse the predecessor's
  content-addressed resources by digest; it may not depend on a resource reachable only through the
  predecessor's content.
- Bounds evidence travels with the payload. Content that would exceed the bound tile's bounding
  volume or geometric error rejects rather than silently widening either.
- For a producer that rebuilds whole tiles — the ordinary case for a live simulation republishing a
  changed region — this is the operation to emit. `replaceRegion` is for edits whose stale geometry
  also lives in ancestors or descendants.

If the edit must mask stale geometry in ancestors/descendants, use `replaceRegion` or publish the
complete cross-LOD group. If bounds, hierarchy, availability, or refinement changes, publish a new
base revision whose closure reuses every unchanged content-addressed resource. `replaceContent` is a
semantic materialized replacement candidate, not an in-place mutation of the immutable base URI.

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

Every codec here is a Layer-B payload codec: it binds an exact immutable base, declares hard
compatibility conditions, and falls back to `replaceContent`, `replaceRegion`, or rebuild when any
condition fails. Two rules govern all of them.

**Digest domain.** Every identity a typed codec binds is taken over the resource's decoded canonical
form — the decoded elements in element order with container padding and stride removed, preceded by a
canonical descriptor of the layout — never over container bytes. A base republished with different
compression settings but identical decoded content therefore keeps its typed-patch identity, and a
client can verify what it is about to modify without re-encoding it. Container-byte identity remains
the domain of `replaceContent` and `binaryResourceDelta`.

**Decoder-defined order is not an addressable domain.** A codec in which the decoder, rather than the
asset, fixes element order or decoded layout cannot host element-indexed patches. In practice this
admits uncompressed and `EXT_meshopt_compression` bases and excludes `KHR_draco_mesh_compression` and
comparable bitstreams; Section 7.1 states the gate and the reason.

### 7.1 `sparseAttributeOverride`

Use when topology and layout are unchanged.

Provisional payload contents:

- content and decoded-layout digests;
- primitive/stable stream ID;
- accessor semantic and set index;
- exact component/count/quantization contract;
- declared base container encoding;
- sorted element indices or compact ranges;
- absolute replacement values for the MVP;
- optional associated normal/tangent data;
- new conservative min/max and bounds evidence;
- expected decoded digest of the base attribute and declared decoded digest of the result.

Indices are element indices into the bound accessor: strictly increasing, no duplicates. A duplicate
or out-of-order index rejects rather than resolving last-wins, which matches glTF sparse-accessor
index semantics and keeps one payload bound to one output digest.

Base encoding gate:

- uncompressed bases are admissible. Element `i` addresses accessor element `i`, and the layout
  digest covers the accessor descriptor plus the buffer view's stride and offset;
- `EXT_meshopt_compression` bases are admissible. The extension is a buffer-view filter: decoding
  produces exactly `count * byteStride` bytes in the glTF-declared layout
  (`packages/engine/Source/Scene/GltfBufferViewLoader.js` allocates `count * byteStride` and calls
  `MeshoptDecoder.decodeGltfBuffer`), so element indices and the declared layout survive decoding
  unchanged. The client decodes, verifies the expected decoded digest, applies the override to the
  decoded elements, and publishes a new resource generation. It never splices the compressed
  bitstream;
- `KHR_draco_mesh_compression` bases are rejected in the MVP. The decoder, not the asset, determines
  vertex order and decoded layout: this repository's loader discards the declared geometry offsets
  after decode — "The accessor's byteOffset and byteStride should be ignored for draco. Each
  attribute is tightly packed in its own buffer after decode"
  (`packages/engine/Source/Scene/GltfLoader.js`) — and takes quantization from the decoder. Neither a
  wire-stable element index nor a wire-stable layout exists to bind. The same gate covers every other
  decoder-ordered geometry bitstream routed through that vertex-buffer path, including the splat
  compression this fork loads alongside Draco;
- a producer needing sparse updates over such content republishes the primitive through
  `replaceContent`, or authors the base uncompressed or meshopt-compressed with stable IDs.

Order-dependent/additive deltas are deferred to the bounded dependency profile and require exact
input/output digests plus an explicit acyclic dependency edge; they cannot rely on manifest order.

The client may decode into CPU memory or upload sparse ranges directly into a replacement GPU buffer.
It must publish the new resource generation atomically; it must not edit a buffer still referenced by
submitted work.

### 7.2 `submeshReplace`

Use when topology changes inside a bounded region but replacing the full content is still wasteful.
The payload contains a small self-contained mesh plus an exact cut boundary/collar. This is more
robust than attempting to splice arbitrary index sequences into a compressed base.

Its provenance requirements are those of `sparseAttributeOverride` minus the value binding: the cut
boundary names base vertices, so it binds the decoded topology digest and rejects the same
decoder-ordered bases. Collar positions must agree on both sides within the profile's declared
tolerance, verified by the producer before publication because the client sees only one side at a
time.

### 7.3 `textureBlockReplace`

"Format" here means the base texture's stored format — the format of the published,
content-addressed bytes — not the format a particular client uploads. The codec is defined only where
those two agree up to a client-independent block grid.

Use only when:

- the base texture's stored format is uncompressed or a concrete block-compressed format;
- texture identity, dimensions, and format are unchanged;
- replacement rectangles are block-aligned in the stored format's block grid;
- every required mip rectangle is supplied;
- atlas/gutter ownership is explicit;
- compression permits independent block replacement, or the payload supplies whole replacement
  mip levels.

Supercompressed KTX2 is out of domain. A Basis ETC1S or UASTC payload has no single decoded block
format: the transcode target is chosen per device at load time from the client's supported formats
(`packages/engine/Source/Workers/transcodeKTX2.js` selects among ETC, ETC1, S3TC, PVRTC, ASTC, and
BC7), and transcoding is not block-local. Such bases select whole-level replacement, whole-texture
replacement, or a `binaryResourceDelta` over the complete encoded KTX2, after which the client
transcodes normally.

The universal fallback is a replacement texture object referenced by replacement content.

### 7.4 `binaryResourceDelta`

Use a standard binary-delta algorithm such as VCDIFF when exact-byte reconstruction is cheaper than
shipping a complete changed GLB, buffer, image, KTX, subtree, or other immutable resource. It is also
the transport-level fallback for every typed codec whose gate rejects — notably supercompressed
textures and decoder-ordered geometry — because it needs no semantic access to the resource's
interior.

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

- a header holding the tile center, `minimumHeight`/`maximumHeight`, a bounding sphere, and a horizon
  occlusion point;
- quantized `u`, `v`, and height arrays of `vertexCount` `uint16` codes each;
- zig-zag delta coding applied independently along each of those three arrays;
- high-water-mark encoded triangle indices whose width depends on `vertexCount`;
- west/south/east/north edge-vertex lists used for skirts and crack hiding;
- optional appended extension records: oct-encoded normals, water mask, and metadata.

In this repository that layout is parsed by `packages/engine/Source/Core/CesiumTerrainProvider.js`,
decoded by `AttributeCompression.zigZagDeltaDecode`, held by
`packages/engine/Source/Core/QuantizedMeshTerrainData.js`, and turned into a render mesh by
`packages/engine/Source/Workers/createVerticesFromQuantizedTerrainMesh.js`. The rules below are
stated against that pipeline. The fork also carries an experimental glTF-in-3D-Tiles terrain path
(`Core/Cesium3DTilesTerrainData.js`); its payload rules are the Section 7 glTF codecs, but the
terrain-side rules in this section — boundary agreement, skirts, derived descendants — apply to it
unchanged because it feeds the same `TerrainData` and `GlobeSurfaceTile` machinery.

### 8.1 Fast height-only patch

**Payload domain (normative).** Heights are transported as `uint16` decoded-quantized height codes:
the values that exist after zig-zag delta decoding, in `[0, 32767]`, interpreted against the bound
tile header's interval as

```text
height(i) = minimumHeight + (maximumHeight - minimumHeight) * code(i) / 32767
```

which is exactly the dequantization `createVerticesFromQuantizedTerrainMesh.js` performs and exactly
the domain `QuantizedMeshTerrainData.interpolateHeight` samples. This is the sole normative payload
domain. Real-world meter heights are producer-side inputs, never wire values: the producer quantizes
once, before publication, and the client writes codes into the decoded height array with no rounding,
re-quantization, or floating-point conversion. The patched tile is therefore bit-exact by
construction, and its declared output digest is reproducible on every client and every platform.

**Output identity.** The profile's exact output identity is the digest of the decoded tile state: the
canonical concatenation of the header fields, the decoded `u`, `v`, and height code arrays, the
decoded index array, the four edge lists, and the appended extension records in ascending extension
ID. Clients apply patches to decoded state and never re-encode merely to verify. A producer that also
publishes a materialized encoded tile binds its container digest separately; the two are related by
the profile's canonical encoder, which is deterministic given the vertex order.

Flattening a hill can be a very good sparse patch when all of these hold:

- existing vertex density adequately represents the flattened surface;
- vertex count, vertex order, and topology are unchanged, and the `u`/`v` codes are unchanged;
- every replacement height lies within the bound tile's declared minimum/maximum interval (interval
  rule below);
- affected samples are not on a tile boundary, or every neighbor and LOD representation sharing an
  affected edge vertex is patched in the same atomic set (boundary rule below);
- replacement oct-encoded normals are supplied whenever the bound tile carries them (normal rule
  below);
- header culling evidence remains conservative or is re-supplied;
- every client-derived descendant of the patched tile is invalidated in the same transition
  (derived-descendant rule below);
- parent and child LOD representations are patched together or a cross-LOD overlay owns the region.

**Interval rule (normative).** Admissibility depends only on the interval, never on which sample
attains an extremum.

- An edit whose every height lies inside the declared `[minimumHeight, maximumHeight]` interval never
  forces re-quantization, including when it removes or creates a local or tile-wide extremum. The
  interval defines the code domain; it is not a claim that either endpoint is attained. Leaving an
  endpoint unattained only makes the declared interval conservative, and a conservative interval
  changes no already-published code, because the quantization step `(maximumHeight - minimumHeight) /
  32767` is unchanged.
- An edit requiring a height outside that interval changes the interval, and the interval multiplies
  the whole stream: changing it changes the decoded value of every code in the tile. Such an edit
  selects `quantizedMeshHeightStreamReplace` (ladder rung 2) or higher. It is never a sparse override.
- A producer may also choose rung 2 to re-tighten a slack interval for precision. Tightening is an
  optimization, never an admissibility condition, and it costs one height stream rather than one tile.
- The rendering-side bounding region derives its heights from the declared interval
  (`packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js` takes the region's minimum and
  maximum from the mesh/terrain-data extrema), so a slack interval stays conservative for culling and
  distance estimation.
- Header culling evidence is a separate obligation from the interval. The bounding sphere and horizon
  occlusion point are consumed verbatim from the header, and the occlusion point is recomputed
  client-side only when `minimumHeight < 0`
  (`Core/QuantizedMeshTerrainData.js`, `Workers/createVerticesFromQuantizedTerrainMesh.js`). Lowering
  the surface leaves both conservative. Any edit that raises a height must re-prove them or re-supply
  them, because a sphere or occlusion point fitted to the old surface can cull a tile that is now
  visible; re-supplying header fields is rung 2.

Flattening an interior hill is therefore rung 1 even when that hill holds the tile maximum: every new
height sits at or above `minimumHeight` and below the old maximum, the codes stay in domain, the
culling evidence stays conservative, and the declared maximum simply becomes unattained. The
north-star edit is on the fast path.

**Boundary, skirt, and seam rule (normative).** Edge vertices are shared geometry, not shared codes.
Neighboring tiles carry their own intervals, so two tiles agreeing on a decoded ECEF edge position
generally disagree on the raw code. Boundary edits are computed in decoded space and re-quantized per
tile against that tile's own interval.

- A patch that changes any height listed in the bound tile's west, south, east, or north edge index
  list must include, in the same atomic set, every tile that owns a coincident edge vertex — the
  same-level edge neighbor and every coarser or finer representation covering that edge — or it
  rejects. That is ladder rung 5.
- Decoded edge positions across the atomic set must agree within the profile's declared tolerance
  after per-tile re-quantization. The producer verifies this before publication; a client that sees
  one tile at a time cannot.
- Skirts carry no payload. The client regenerates skirt vertices from the edge index lists and the
  patched heights, and the skirt depth is a level-derived constant
  (`skirtHeight = getLevelMaximumGeometricError(level) * 5.0` in `Core/CesiumTerrainProvider.js`,
  consumed by `addSkirt` in `Workers/createVerticesFromQuantizedTerrainMesh.js`). A patch that tries
  to transport skirt geometry rejects.

**Normal rule (normative).** Oct-encoded normals are per-vertex geometry-dependent data appended as
extension record `1` and sized `vertexCount * 2` bytes, and this engine never recomputes them: the
parsed `encodedNormals` array is passed through to the render mesh and to the skirt vertices.
Therefore:

- if the bound tile carries the normals extension, the patch supplies replacement normals for every
  vertex whose one-ring support changed, which always includes every affected edge vertex;
- edge-vertex normals are computed by the producer over the union of the patched tile's triangles and
  the incident triangles of its neighbors. A client has no neighbor data at patch time, so a
  single-tile recompute is forbidden: it changes the averaging support and produces a lighting seam
  even where positions match exactly;
- a height patch for a normals-bearing tile that omits the corresponding normals rejects, and the
  producer falls back to a higher rung;
- a deployment that publishes terrain without the normals extension declares that in its profile, and
  this obligation is then vacuous.

**Derived-descendant rule (normative).** A client may hold meshes it derived rather than fetched. In
this engine a `GlobeSurfaceTile` whose own terrain is unavailable or failed is upsampled from its
parent (`Scene/GlobeSurfaceTile.js`, `Core/QuantizedMeshTerrainData.js#upsample`), and the result is
cached on the descendant tile with no generation key. Activating a height patch therefore must, in
the same atomic transition:

- drop every client-derived descendant of the patched tile and re-derive it from the patched parent;
  and
- treat the visible derived descendants as part of the patch's readiness frontier, so the transition
  does not activate while a finer LOD would still display the pre-edit surface.

A client that cannot enumerate its derived descendants drops the whole subtree below the patched
tile. Derived descendants are client state, not dataset state: they are never separately published,
and a producer never emits a patch for one.

### 8.2 Why not patch encoded bytes directly?

- The header interval is a multiplier on the whole stream. Heights are codes into
  `[minimumHeight, maximumHeight]`, so changing that range changes the meaning of every quantized
  height in the tile; a header-only byte edit is never a local edit.
- Vertex values use a running delta accumulator. Each of `u`, `v`, and height decodes as
  `value(i) = value(i - 1) + zigZagDecode(code(i))` (`Core/AttributeCompression.js`), so writing
  decoded sample `i` requires re-encoding the words at `i` and `i + 1`, and transport gzip then makes
  the compressed byte delta nonlocal even when the raw edit was two words.
- Indices are high-water-mark coded: the decoder reconstructs `index(i) = highest - code(i)` and
  increments `highest` on each zero code (`Core/CesiumTerrainProvider.js`), so any topology change
  rewrites the remainder of the index stream. Index width also switches from 16-bit to 32-bit above 65,536
  vertices, which re-aligns every following section.
- Edge lists and extension records are reached by walking offsets. Each edge list is length-prefixed
  and aligned to the index width, and extension records are parsed by stepping `extensionId` plus
  `extensionLength` from the end of the north list to the end of the buffer. Adding or removing a
  vertex invalidates every following offset, and the normals record is sized from `vertexCount`.
- Boundary agreement lives in decoded space. Neighbor tiles use different intervals, so their raw
  quantized height codes need not — and generally do not — match even where the decoded ECEF edge
  positions agree exactly.

The sibling profile therefore patches decoded values and reassembles a complete verified terrain
resource; it never mutates encoded bytes in place. Where transport bytes still matter,
`binaryResourceDelta` (Section 7.4) carries the difference between two complete encoded tiles under
exact source and target digests — a transport codec, not a semantic one.

### 8.3 Quantized-mesh operation ladder

1. **`quantizedMeshHeightOverride`** — sparse absolute height codes. Vertex count, order, topology,
   and `u`/`v` codes unchanged; every height inside the declared interval; culling evidence
   conservative or re-supplied; normals supplied where the tile carries them. Fastest path; payload
   is one index plus one `uint16` per changed sample.
2. **`quantizedMeshHeightStreamReplace`** — the height-stream replacement rung. Replaces the complete
   height code array together with the header fields that define or bound it: `minimumHeight`,
   `maximumHeight`, bounding sphere, and horizon occlusion point. Vertex count, order, `u`/`v` codes,
   indices, and edge lists are unchanged and reused verbatim from the bound base; oct-encoded normals
   are re-supplied when present; water-mask and metadata records are preserved byte-identically. This
   is the rung selected whenever an edit leaves the declared interval, whenever the producer
   re-tightens the interval, and whenever new culling evidence is required. Payload is
   `2 * vertexCount` bytes plus a small header — far below a whole tile — and the result is bit-exact
   because the client applies codes to decoded state rather than re-deriving them.
3. **`quantizedMeshSubregionReplace`** — bounded replacement mesh with an exact shared collar; used
   when vertex density or local topology must change but replacing the tile is still wasteful.
4. **Whole terrain-tile replacement** — topology, vertex count, unknown geometry-dependent extension
   records, or patch economics fail every rung above.
5. **Multi-LOD/multi-tile atomic set** — required whenever the edit touches a shared edge vertex or
   spans more than one published LOD representation of the same surface. Any rung above may appear
   inside the set, once per participating tile. Client-derived descendants are handled by the
   derived-descendant rule, not by adding tiles to the published set.

Rung selection is producer policy under the Section 9 gates, but rungs 1 and 2 are the working path
for a live simulation: both preserve the base tile's `u`/`v` codes, topology, and edge lists, so a
producer that only moves elevation never re-tiles, never re-indexes, and never disturbs a neighbor
unless it moved an edge vertex.

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

A published patch is a durable state, not a bridge. The producer must decide, before expensive
work, among:

1. emit `NO_OP` when the localized source result is semantically identical;
2. coalesce/defer a soft update within its explicit freshness SLA;
3. emit a semantic tombstone/suppression for a deletion;
4. **patch-terminal** — publish a patch or `replaceRegion` and schedule no rebuild;
5. **patch-then-rebuild** — publish the same patch now and schedule a bounded later rebuild;
6. **rebuild-now** — publish the smallest complete materialized result and no patch;
7. compact/rebuild the base revision; or
8. defer compaction/offline materialization when a hot update tail cannot make bounded progress.

Candidates 4, 5, and 6 are the economic triad. None dominates the others, and a rebuild is never an
obligation a patch incurs: what bounds an accumulating chain is the compaction trigger of Section
12, which is normative and structural. The cost model below decides only which candidate is cheapest
inside those bounds.

The interoperability extension standardizes the hard gates of Section 9.2 and the optional
patchability metadata of Section 9.1. Candidate scoring, deployment weights, thresholds, and
representation choice are non-normative producer policy. "Optimal" means the lowest conservatively
estimated cost among supported candidates for a declared deployment profile, not a globally provable
optimum.

### 9.1 Producer-computable inputs

**Producer-computability rule.** Every optimizer input is a total function of exactly four
documents:

| Class | Document | Bound to | Mutability |
| --- | --- | --- | --- |
| I1 | `baseProfile` | `baseDigest` | immutable |
| I2 | `activeSummary` | `stateDigest` | immutable |
| I3 | `deploymentProfile` | profile digest plus calibration epoch | immutable per epoch |
| I4 | `changeSummary` | `updateId` / `sourceRevision` | one bounded record |

No optimizer input may name a client's camera, visible set, cache contents, session identity, or
live measurement. A quantity that is physically a client property enters only as a **cohort prior**
in I3, carrying its calibration timestamp, sample count, and confidence interval. An expired prior
widens its interval; it never blocks a decision. This is what makes the estimator runnable inside a
simulation step: it reads three immutable documents and one bounded change record, and it evaluates
identically offline, in a test, and in production.

At base-build time, emit a small private or optional public **base profile** containing:

- a schema/estimator version and immutable profile digest bound to `baseDigest`;
- compressed and expanded bytes by geometry, texture mip, metadata, and auxiliary stream;
- vertex/triangle/feature/instance counts;
- codec, quantization, layout, compression random-access unit, GPU allocation/copy granularity, and
  texture block sizes;
- spatial bins mapping source features/regions to affected streams and LODs;
- stable feature, primitive, stream, and other patch-target IDs plus provenance hashes;
- bounds and geometric-error slack;
- resource alias/refcount and dependency-closure summaries;
- normal/tangent/mipmap/acceleration-data dependencies and their byte/work estimates;
- approximate whole-content replacement, affected-tile rebuild, and base-compaction costs.

This turns the first decision into table lookups and integer arithmetic rather than a trial encode.
The estimator must receive an already localized, bounded `changeSummary`; discovering changed
elements by scanning the base is production work, not part of the microsecond decision.

Active patch state is mutable and must not be mixed into the base-bound profile. Each published
state therefore has a separate immutable `activeSummary` containing:

- summary schema/version and digest;
- exact `stateDigest` and generation;
- per tile/spatial bin, the three quantities the Section 12 trigger reads — **overlay depth**
  `depth(b)`, **cumulative delta bytes** `deltaBytes(b)`, and **apply cost** `applyCost(b)` — plus
  object count and dependency closure;
- active tombstone/selector count and lazy lookup cost per tile/spatial bin;
- current update epoch/sequence, compaction watermark, and rebased-tail count;
- bounded update-arrival/burst rates, tail bytes/work, rebase throughput, CAS conflict/backoff
  history, maximum writer-fence latency, observation-window endpoint, confidence bounds, and maximum
  age;
- global manifest, notification, storage, retirement, and retention totals.

The summary is computed and made available atomically with the state it describes. Rate/contention
fields are immutable observations over a declared window, not counters mutated after publication. An
estimator must reject an expired, stale, or mismatched `activeSummary`; every decision record binds
its digest/version, `stateDigest`, generation, observation window, and confidence bounds.

The **deployment profile** carries everything that is neither base nor state:

- the cost weights and their units (Section 9.3), the safety margin, and the confidence width `rho`;
- the structural caps `D_max`, `beta`, `gamma` and the per-bin frame budget;
- `quietPeriod`, `maxWait`, and the arrival-rate model used to amortize a scheduled rebuild;
- the exposure model — expected concurrent exposures `E_live`, total exposures `E`, and the
  deployment horizon `H`;
- cohort priors for bandwidth, RTT, decode and upload throughput, activation hitch, and warm-cache
  fraction, each with its calibration epoch and interval;
- the applicable pass-view count per component profile — color, depth, shadow, pick, stereo — which
  is a property of the deployment's engine, not of the base.

### 9.2 Hard rejection gates

Every gate below is decidable from I1, I2, and I4 alone. Reject each candidate immediately when its
relevant condition fails. Specialized patches use the codec gates; materialized and maintenance
candidates use the same fail-closed discipline.

**Correctness gates.**

- base or layout identity mismatch;
- unsupported codec or missing stable IDs;
- hierarchy, transform, refinement, or implicit availability change;
- bounds/geometric-error safety cannot be proven;
- topology change requested by a topology-stable codec;
- texture change is not block/mip/gutter safe;
- **write-set overlap** — the candidate's canonical write set intersects the write set of any patch
  or tombstone active in the predecessor state, and the candidate's own publication neither omits
  nor supersedes the conflicting operation. Section 4.2 requires the active set to be disjoint; this
  is the gate that enforces it at admission, so a producer cannot publish a state that its own
  deterministic-operation law would reject;
- **frontier admissibility** — for every target in the candidate's write set, the publication binds
  (i) the complete state-control closure and (ii) at least one patch or replacement root whose
  declared coverage is total over that target at every base LOD that can select it. Client
  visibility is never an input. The producer proves the stronger statement — that whatever
  activation frontier a client computes at its commit frame is a subset of what the publication
  makes resolvable — so the gate is decidable from the candidate closure alone. The client-side
  frontier test of Section 4.2 remains a client obligation; it is not a producer gate and cannot be
  one, because the producer does not know any client's camera;
- invalidation target identity is ambiguous or not scoped to the exact dataset/base/state;
- for a base-compaction candidate, the live tail cannot be safely rebound to the candidate base;
- for a base-compaction candidate, rebase throughput cannot outrun the bounded arrival rate, or
  CAS/fence progress cannot be proven inside its deployment cap;
- required retention/offline guarantees exceed storage policy;
- client capability profile cannot apply the codec.

**Structural caps.** A candidate crossing a declared cap is rejected in its current shape and may
re-enter only as a smaller or differently shaped candidate:

- p95 activation hitch and time-to-current;
- peak CPU and GPU bytes, including atomic double-buffer/copy-on-write generations;
- request, object, dependency, and origin counts;
- overlay depth, cumulative delta bytes, and apply cost per affected tile or spatial bin — the same
  three quantities Section 12 uses as its compaction trigger;
- persistent CPU/GPU frame budget across every applicable pass/view;
- retirement latency and retained-resource budget.

**Terminal admissibility.** A `patch-terminal` candidate is admissible only when publishing it
leaves every Section 12 trigger predicate false for every bin it touches. A candidate that would
cross one is not rejected: it survives as `patch-then-rebuild`, with the compaction it forces
already priced into `futureDebt`. This is the only bound on a terminal patch, and it is structural
rather than a matter of policy.

**Not a gate.** "Full replacement is already smaller or cheaper" was previously listed here. It is a
comparison between candidate costs, not a compatibility condition: it has no fail-closed meaning, it
cannot be evaluated before both candidates are estimated, and placing it among correctness gates let
a cost comparison eliminate a *correct* candidate before the cost model ran. It belongs to the
selection rule of Section 9.4.

Hard-gate evaluation is O(1) or O(a strictly capped number of touched spatial bins), never O(full
tile size) or O(all active patches). If a localized change or active-state summary exceeds the
Stage-1 budget, the result is conservatively `NEEDS_BOUNDED_STAGE_2` or a materialized replacement.

### 9.3 Candidate cost vector

#### 9.3.1 Currency, dimensions, and aggregation

All costs are expressed in one scalar currency, the **cost unit** `cu`. Each weight `W_x` has
dimension `cu` divided by the unit of its term, so every product is `cu` and dimensional coherence
is mechanically checkable. A term without a declared unit is not a term.

Every term carries exactly one **aggregation level**:

- **P — per publication.** Counted once, whatever the client population.
- **T — per concurrent exposure.** Paid by each client that must perform the transition; multiplied
  by `E_live`.
- **R — per exposure over the horizon.** Paid by each client-load of an affected target while the
  patch remains active; multiplied by `E`.

No term appears at more than one level. A term multiplied twice is a defect, not conservatism.

The exposure horizon is `H = min(declared deployment/session horizon, expected time to compaction)`.
For a terminal patch the second is unbounded, so `H` is the declared horizon — which is precisely
what makes a terminal patch costable.

| Symbol | Term | Unit | Level |
| --- | --- | --- | --- |
| `t_prod` | locate, encode, validate, publish | ms | P |
| `n_origin` | `PUT`/`HEAD`/`DELETE`/`LIST`, reference-index, outbox, recovery-scan operations | ops | P |
| `s_store` | retained base/patch/fallback bytes through the grace window | byte-day | P |
| `t_contend` | tail rebase work, CAS retries/backoff, bounded writer-fence latency | ms | P |
| `b_notify` | head and hint bytes emitted for the transition, including fanout | bytes | P |
| `t_fresh` | coalesce/defer latency charged against the update's declared freshness SLA | ms | P |
| `c_debt` | amortized scheduled rebuild (Section 9.3.4) | cu | P |
| `b_wire` | transfer bytes on the applying client's critical path | bytes | T |
| `n_req` | requests/ranges/revalidation round trips on that critical path | requests | T |
| `t_cpu` | validate, decode, apply, rebuild query structures | ms | T |
| `t_gpu` | upload/copy, mask, pipeline warmup, synchronization | ms | T |
| `m_cpu` | peak preparation bytes including decompression and temporaries | bytes | T |
| `m_gpu` | peak atomic-generation bytes including copy-on-write resources | bytes | T |
| `t_hitch` | p95 activation hitch | ms | T |
| `t_ttc` | **time-to-current**: source change accepted to first correct pixel | ms | T |
| `t_retire` | old-generation residency after activation | ms | T |
| `t_resid` | residual client complexity per exposure (Section 9.3.3) | ms | R |
| `m_run` | retained patch resources, pipelines, descriptors, compositor state | bytes | R |

The aggregate is

```text
Cost = SUM over P-terms  W_x * x
     + E_live * SUM over T-terms  W_x * x
     + E      * SUM over R-terms  W_x * x
     + c_debt
```

`riskPenalty` is deleted. Uncertainty has exactly one representation: every term is an interval
`[x-, x+]` produced by its estimator, weights are exact, and `Cost` is the interval obtained by
evaluating the sum at both endpoints. `confidencePass` is the width test
`(Cost+ - Cost-) <= rho * Cost+` for a declared `rho`. Counting uncertainty a second time inside the
sum, or a third time in an asymmetric comparison, charges the same ignorance twice.

Cohorts are evaluated separately, never blended: cold-base, warm-base, codec-capable, and
codec-incapable populations each get their own `E_live`, `E`, and priors, and a heterogeneous
deployment may select `typed patch + materialized fallback` as one publication candidate.

#### 9.3.2 Time-to-current

This is the term the model previously lacked, and the only term that structurally favours a patch.

```text
t_ttc     = t_publish + t_propagate + t_notify + t_fetch + t_prepare
t_fetch   = b_wire / bandwidth + rttGroups * RTT
t_prepare = t_cpu + t_gpu
```

`t_publish` is producer wall-clock from accepting the source change to a successful head CAS. For
`rebuild-now` it contains the entire materialization; for a patch it contains only the localized
encode. Every other addend is common to all candidates, so the difference between candidates is
almost exactly the difference in production latency.

A scheduled rebuild published *after* a correct patch carries **no** `t_ttc`. Its clients are
already current; the later swap pays transfer, hitch, and preparation only. Charging it staleness
would count the same staleness twice — once against the patch that removed it, once against the
rebuild that did not.

#### 9.3.3 Residual client complexity

A live patch leaves durable work in every client that loads the affected target:

```text
t_resid(d) = (u_cpu + u_gpu * V) * F                    residual frame work per exposure
           + t_desc * d + SUM over i<=d of t_apply,i    overlay application per cold load
```

where `d` is the chain depth on the affected bin, `V` is the applicable pass-view count, `F` is the
expected visible frames per exposure, `u_cpu` covers traversal, spatial lookup, picking/query/BVH,
and draw preparation, and `u_gpu` covers mask/overdraw/early-Z loss and replacement work.

The cold-load **request amplification** of a target at depth `d` is

```text
n_req(d) = 1 + 2d                 descriptors individually addressed (conservative default)
n_req(d) = 1 + d + ceil(d / S)    descriptors index-sharded, S per shard
```

At `d = 8` the conservative form is 17 requests where 1 sufficed. This is the quantity that gives
the per-bin depth cap a derivation rather than a guess (Section 12).

`t_resid` is what a terminal patch pays and a rebuild does not. It is the honest price of a terminal
patch.

#### 9.3.4 Amortized future debt

```text
c_debt = 0                  for patch-terminal and rebuild-now
c_debt = alpha * C_rebuild  for patch-then-rebuild
alpha  = 1 / k(lambda)
k(lambda) = min( exp(lambda * q), 1 + lambda * maxWait )
```

Derivation. Under trailing-edge debounce with quiet period `q`, one rebuild absorbs every arrival
until the first inter-arrival gap of at least `q`. For Poisson arrivals at rate `lambda`, each gap
exceeds `q` with probability `exp(-lambda*q)`, so the number of absorbed arrivals is geometric with
mean `exp(lambda*q)`. The `maxWait` cap truncates that busy period at about `1 + lambda*maxWait`
arrivals. One rebuild therefore discharges `k` patches, and one patch is charged `1/k` of it.

Charging a full rebuild to every patch — the previous model — overcounts by exactly `k`. At the
stream rates Section 12 must handle (`lambda = 4/s`, `q = 0.5 s`) that factor is 7.39. A terminal
patch is charged nothing, because nothing is scheduled.

#### 9.3.5 The triad identity

```text
rebuild-now         maximizes t_ttc,     zeroes t_resid,       zeroes c_debt
patch-terminal      minimizes t_ttc,     pays t_resid over H,  zeroes c_debt
patch-then-rebuild  minimizes t_ttc,     truncates t_resid,    pays alpha * C_rebuild
```

Exactly three quantities separate the three candidates, and each candidate is worst at one of them.
Which wins is an empirical question about `E_live`, `E`, `W_prod`, and `d` — not a doctrine.
Section 9.8 exhibits all three winning, plus a fourth case where the structural trigger decides
before economics can.

Recurring cost is projected over the horizon rather than treated as a one-time scalar:

```text
residualCost = E * ( W_frame * t_resid(d) + W_mem * m_run )
```

`V` includes every path that uses the patch: color, depth, shadows, picking, stereo/multiview, and
other engine-specific passes. It is a deployment property, declared in I3.

### 9.4 Fast decision algorithm

```text
function chooseUpdate(changeSummary, baseProfile, activeSummary, deploymentProfile,
                      stage2Allowed, stage2AlreadyRun):

    # PURE. Encodes nothing durably, uploads nothing, pins nothing, publishes nothing,
    # writes no head. The caller acts only on a terminal return value.

    if !stage1InputsAreBoundedAndProvenanceMatches(
        changeSummary, baseProfile, activeSummary):
        return stage2Allowed && !stage2AlreadyRun
            ? NEEDS_BOUNDED_STAGE_2
            : deferralTerminal(changeSummary)

    if sourceUpdateWork(changeSummary) && exactSemanticNoOp(changeSummary):
        return NO_OP

    compactionMustDefer = compactionRequested(...)
        && !boundedCompactionProgressIsProven(...)

    if maintenanceOnlyCompaction(changeSummary) && compactionMustDefer:
        return DEFER_COMPACTION

    candidates = []

    if coalesceOrDeferHardGatesPass(...):
        candidates.push(estimateCoalesceOrDefer(...))

    if semanticSuppressionHardGatesPass(...):
        candidates.push(estimateSemanticSuppression(...))

    for codec in fixedCodecsFor(changeSummary.kind):
        if codec.operationHardGatesPass(changeSummary, baseProfile, activeSummary):
            p = codec.constantTimeEstimate(...)
            if terminalAdmissible(p, activeSummary, deploymentProfile):
                candidates.push(asTerminal(p))
            candidates.push(asPatchThenRebuild(p))

    if regionReplacementHardGatesPass(...):
        r = estimateRegionReplacement(...)
        if terminalAdmissible(r, activeSummary, deploymentProfile):
            candidates.push(asTerminal(r))
        candidates.push(asPatchThenRebuild(r))

    if patchWithFallbackHardGatesPass(...):
        candidates.push(estimatePatchWithMaterializedFallback(...))

    candidates.push(estimateWholeContentReplacement(...))
    candidates.push(estimateAffectedTileRebuild(...))
    candidates.push(estimateAffectedSubtreeRebuild(...))

    if !compactionMustDefer:
        candidates.push(estimateBaseCompaction(...))

    admissible = candidates.filter(c =>
        c.hardCompatibilityPass && c.hardCapsPass && c.confidencePass)

    if admissible.isEmpty:
        return deferralTerminal(changeSummary)

    ranked = admissible.sortAscendingBy(c => c.costHi)
    best   = ranked[0]

    if ranked.length > 1 && best.costHi > (1 - margin) * ranked[1].costHi:
        if stage2Allowed && !stage2AlreadyRun:
            return NEEDS_BOUNDED_STAGE_2(best, ranked[1])
        best = conservativeTieBreak(best, ranked[1])

    best.maintenanceDisposition = compactionMustDefer ? DEFER_COMPACTION : NONE
    return best

function deferralTerminal(changeSummary):
    return maintenanceOnlyCompaction(changeSummary)
        ? DEFER_COMPACTION
        : NO_SAFE_CANDIDATE_DEFER_TO_OFFLINE_BUILD
```

**One statistic.** Every comparison is between `costHi` values. The previous rule compared a patch's
upper bound against a materialized candidate's lower bound, which charges the same uncertainty
twice — once inside each interval and again in the asymmetry — by an amount no deployment can
measure or calibrate. `margin` is the single calibratable conservatism knob and is a deployment
constant (Section 9.5), not a per-candidate ratio.

**`patchAdmissionRatio` is deleted.** It was never defined. The three thresholds that stood in for
it — the cost-comparison entry in the old gate list, the safety margin, and the upper-versus-lower
comparison — reduce to `margin` alone.

**Materialized candidates are ranked, not privileged.** The previous algorithm pre-selected a
`bestMaterialized` and admitted patches against it, so a patch could be eliminated by a materialized
candidate that then lost to a different materialized candidate. One ranking over one admissible set
removes that case, and it is what lets the triad of Section 9.3.5 compete on equal terms.

**Deferral terminals match the request kind.** A maintenance-only request that finds no admissible
candidate returns `DEFER_COMPACTION`, consistent with Section 12, where deferral is routine and
non-blocking. `NO_SAFE_CANDIDATE_DEFER_TO_OFFLINE_BUILD` is reserved for a source update with no
safe representation.

**Purity.** `chooseUpdate` is a pure function of its four documents. Every side effect belongs to
Section 3.4.1 step 3, which runs only on a terminal return. `NEEDS_BOUNDED_STAGE_2` is therefore not
a decision a caller can have acted on.

`NO_OP` applies only to source-update work after exact semantic equality is proven; it does not
suppress a requested maintenance compaction, and it creates no new state generation, head write, or
notification. Coalescing/defer is illegal for hard revocation or when it would exceed the source
update's freshness SLA. A coalesced patch retains the canonical `updateLineage` union and the
oldest/least remaining freshness deadline; a newer update cannot reset that deadline. Exceeding the
lineage cap selects a materialized candidate rather than dropping provenance. Semantic suppression
is a durable tombstone state operation, not omission from a notification. A deferred compaction
leaves the current verified state authoritative and schedules bounded later work; it does not delay
an already-admitted currentness update.

### 9.5 Initial non-normative weights and seeds

**Subordination law.** A heuristic may order, seed, or prune candidates. It may never admit a
candidate the gates reject, nor reject a candidate the gates admit. If a heuristic and the cost
model disagree on the winner, the cost model wins and the heuristic is recalibrated; a heuristic
that has to override the model is a mis-weighted term.

The only threshold inside the algorithm is the safety margin, initially `margin = 0.20`, with
`rho = 0.35` for the confidence-width test.

These are recorded crossover observations from which weights are fitted. They are calibration seeds,
not tests, and none of them may reject a candidate:

- patch wire bytes at the observed crossover: 50-60% of replacement bytes;
- patch producer time at the crossover: about 50% of rebuild time;
- patch client apply time at the crossover: 25-40% of replacement decode/upload time.

These are caps, they live in Section 9.2 and Section 12, and they do reject:

- overlay depth per affected tile or spatial bin, `D_max` in `[8, 32]`;
- cumulative delta bytes per bin, `beta` in `[0.25, 0.5]` of that bin's base bytes;
- apply cost per bin, `gamma = 0.25` of that bin's base load cost.

A correctness-gate failure removes a candidate; it does not select a rebuild. The rebuild is
selected, if at all, by ranking the candidates that survive. The prototype must calibrate every
weight and cap from real workloads.

### 9.6 Two-stage refinement

1. **Stage 1 — metadata estimate.** Microseconds, and only when codec count, touched bins, and all
   input summaries are explicitly bounded and pre-aggregated. Rejects obviously poor choices.
2. **Stage 2 — bounded exact encode/sample.** Entered only from a `NEEDS_BOUNDED_STAGE_2` return. It
   encodes affected blocks or a small representative sample under strict maximum bytes, blocks, and
   wall-time.

**Integration.** Two returns reach Stage 2: the input-bounds guard, and the closeness test in
Section 9.4 — the top two ranked candidates are not separated by `margin`. Stage 2 tightens only the
terms whose interval width causes the overlap, then re-invokes `chooseUpdate` once with
`stage2AlreadyRun = true`. Re-entry depth is exactly one. A second closeness result is resolved by
`conservativeTieBreak`, which selects the smaller `costHi` and, on a tie, the candidate with the
smaller `t_resid` — the one that leaves the client simplest. Stage-2 exhaustion returns the best
admissible candidate under the untightened intervals, marked with its confidence width; it never
returns a candidate admitted on estimates the guard already distrusted.

No decision can flip after the caller has acted, because the caller cannot act before a terminal
return. Stage 2's own encodes are bounded, discardable, and published only if the terminal return
selects them.

The producer emits a decision record containing the base/profile/estimator hashes and versions,
exact state generation/digest and active-summary digest/version, calibration cohort, every candidate
vector with its interval, hard-gate outcome, which stage decided, the margin applied, the chosen
representation, and the reason. This makes optimizer behaviour auditable and trainable without
putting the cost model itself into the interoperability specification.

### 9.7 Manifest and CDN scaling law

The MVP active-state manifest is a full active snapshot, so its wire and parse cost is O(active
patches). Measured over the canonical JSON of Section 4.2 with full 64-hex digests:

```text
M(P) = c0 + c_rec * P bytes,   c0 = 1134 B,   c_rec = 495 B
```

`c0` is a one-component envelope with source domains, capabilities, transition provenance, and one
base block; `c_rec` is one patch record with a one-element `updateLineage`. A four-element lineage
costs 750 B. These constants are what the benchmark phase must re-measure; the asymptotics do not
depend on them.

**Flat index — Theta(P).** `M(256) = 125 KiB`, `M(1024) = 496 KiB`, `M(10000) = 4.72 MiB`. Every
generation republishes the whole document and every reconciling client refetches it.

**One-level shard index — Theta(sqrt(P)).** Partition into `S` shards; a localized change touches
one. A flat root listing `S` shard digests costs about `c_root = 90 B` per entry, so a generation
costs `c_rec*P/S + c_root*S`, minimized at

```text
S* = sqrt(c_rec * P / c_root)        fetch(S*) = 2 * sqrt(c_rec * c_root * P)
```

`P = 1024`: `S* = 75` shards, 13.2 KiB per generation, 37.6x below flat. `P = 10000`: `S* = 235`
shards, 41.2 KiB, 117x below flat.

**Merkle index — Theta(log P) fetch and Theta(log P) republication.** With branching factor 16 and
16 records per leaf, `P = 10000` gives 625 leaves and depth 3. A generation fetches one leaf
(7,920 B) plus the root and interior path (3 x 16 x 90 = 4,320 B), 12.0 KiB in total — 3.4x below
the one-level optimum. The omitted cost is the write side: the same generation must republish one
leaf and three interior nodes, 12.2 KiB across four origin `PUT`s, against two for the one-level
scheme. "A small new root" is small only in the Merkle scheme, and only when the per-generation
interior republication is counted.

**Unbounded chains are quadratic.** Without compaction at generation rate `g`, `P(t) = P0 + g*t`, so
cumulative manifest transfer for a client reconciling every generation over a window `T` is

```text
INT[0,T] g * M(P0 + g*t) dt = g*c0*T + c_rec*g*(P0*T + g*T^2/2)
```

which is `Theta(c_rec * g^2 * T^2 / 2)`. At `g = 4/s` and `P0 = 0`, one hour costs **51.3 GB per
reconciling client**. Bounding the chain at `D_max = 16` caps `M` at 9,054 B and restores linear
growth: the same hour costs 130.4 MB at full per-generation reconciliation, and 6.5 MB with a
five-second client coalescing window. This is the derivation that makes the Section 12 trigger
load-bearing rather than advisory.

**Reconciliation rate, not publication rate, sets client cost.** Manifest transfer is `r * T * M(P)`
where `r <= g` is the client's coalesced reconciliation rate. A hot stream requires `r << g`; the
burst-coalescing law of Section 10 is what supplies it.

**Head origin load.** Polling at interval `T_poll` costs `N_clients / T_poll` conditional `GET`s per
second, nearly all `304`. Hint-driven revalidation costs one conditional `GET` per client per
published generation, `N_clients * g`. Hint-driven is cheaper exactly when `g < 1 / T_poll`. At
10,000 clients and `T_poll = 5 s`, polling costs 2,000 requests per second while hint-driven
revalidation at `g = 4/s` costs 40,000. Above the crossover the hint plane must carry a coalescing
window, or the head must be edge-cacheable with a short freshness budget and the deployment must
accept the declared lag.

**Terminal chains multiply cold-load requests.** A target at depth `d` costs `1 + 2d` requests to
load cold (Section 9.3.3). This is the dominant scaling cost of a terminal patch and the reason the
depth cap is normative.

Cost estimates also include cache-hit probability, 200-versus-304 behaviour, cold base/fallback
downloads, HTTP header and minimum-object overhead, object/origin fanout, manifest parsing, CDN
byte-days during the required grace period, and origin `PUT`/`HEAD`/`DELETE`/`LIST` plus
reference-index transaction counts. A large population of tiny immutable objects can be expensive
even when its byte total is small.

### 9.8 Worked example: flatten a hill

Every number below is arithmetic over the model of Section 9.3 with the weights stated. It exists to
show that the three economic candidates each win under realistic inputs, and that the fourth case is
decided structurally before economics can act.

**Deployment weights** (`cu` per unit; `W_prod` is the input that varies):

| Weight | Value | Weight | Value |
| --- | --- | --- | --- |
| `W_wire` | 2.0e-5 cu/B | `W_hitch` | 5.0 cu/ms |
| `W_req` | 0.5 cu/request | `W_ttc` | 0.5 cu/ms |
| `W_origin` | 2.0 cu/op | `W_frame` | 0.05 cu/ms |
| `W_cpu` | 0.05 cu/ms | `W_mem` | 1.0e-7 cu/B |
| `W_gpu` | 0.05 cu/ms | `W_store` | 1.0e-8 cu/(B-day) |

**Cohort priors:** 25 Mbit/s (3.125 MB/s), 60 ms RTT, 3 serial round-trip groups, 40 MB/s decode,
900 MB/s upload, 250 ms CDN propagation, 150 ms hint delivery. `margin = 0.20`, `H = 30 days`,
`quietPeriod = 300 s`.

**Residual per exposure per overlay.** `u_cpu = 34 us/frame`, `u_gpu = 21 us/pass-view`, `V = 3`,
`F = 2400` frames, so residual frame work is `(34 + 63) * 2400 = 232.8 ms`. Adding the cold-load
amplification of one overlay (2 extra requests, 181.2 KB, 4.53 ms apply) and 2.1 MB of retained
runtime state gives **16.70 cu per exposure per overlay**, linear in `d`. Activation hitch is
`3.1 * d` ms.

**Edit A — the hill** (reference scenarios 1-3 of Section 15.1). Seven affected contents totalling
9.1 MB.

| | patch | rebuild |
| --- | --- | --- |
| producer build | 1,400 ms | 42,000 ms |
| wire bytes | 181.2 KB | 9.10 MB |
| requests / origin ops | 4 / 9 | 10 / 22 |
| `t_ttc` | **2,243 ms** | **46,630 ms** |
| transition cost per exposure | 1,142.7 cu | 23,643.7 cu |
| same rebuild as scheduled maintenance (no `t_ttc`) | — | 328.9 cu |

The patch reaches current 20.8x sooner. That difference, 44.4 s, is the entire case for patching,
and the previous cost vector had no term for it.

**Edit B — structural edit on a small tile.** The edit removes the tile's declared height extremum
and crosses three LODs, so `replaceRegion` needs a seven-LOD mask and a three-LOD replacement
(240 KB, 2,600 ms to localize and solve the collar), while the rebuild is one 300 KB content in
3,200 ms. Patch `t_ttc = 3,475 ms`, rebuild `t_ttc = 4,024 ms`: the latency advantage nearly
vanishes.

**Verdicts.**

| # | Inputs | patch-terminal | patch-then-rebuild | rebuild-now | Winner |
| --- | --- | --- | --- | --- | --- |
| 1 | Edit A; `E_live=3`, `E=360`, `W_prod=4.0`, `d=1` | **15,058** | 178,130 | 238,978 | patch-terminal, 11.8x |
| 2 | Edit A; `E_live=90`, `E=7,500`, `W_prod=0.25`, `d=1` | 228,466 | **144,878** | 2,138,478 | patch-then-rebuild, 1.58x |
| 3 | Edit B; `E_live=140`, `E=22,000`, `W_prod=0.25`, `d=4` | 1,723,243 | 267,852 | 286,397 | 1.069x apart: unresolved |
| 3' | row 3 after Stage 2 measurement | 1,761,020 | 305,629 | **286,397** | rebuild-now, 1.07x |

Reading them:

- **Row 1 — patch-terminal.** The producer is a simulation at 92% of its per-step budget, so
  `W_prod = 4.0` and a 42 s rebuild costs 168,048 cu by itself. The tile is remote: 360 exposures
  over 30 days pay 6,012 cu of residual, which never approaches the rebuild. A terminal patch is not
  a compromise here, it is the correct end state. Under a mandatory-rebuild premise this outcome was
  unreachable, because the rebuild was charged in full to the patch.
- **Row 2 — patch-then-rebuild.** The producer is idle (`W_prod = 0.25`, one rebuild = 10,548 cu)
  and the tile is busy: 7,500 exposures times 16.70 cu is 125,250 cu of durable client tax that a
  10,548 cu rebuild erases. The patch still buys 44.4 s of currentness for the 90 clients present at
  the transition. Both halves of the candidate earn their place.
- **Row 3 — the close case, and how it resolves.** The raw argmin prefers patch-then-rebuild by
  6.9%, inside the 20% margin, so Section 9.4 returns `NEEDS_BOUNDED_STAGE_2` rather than a
  decision. Stage 2 encodes the mask and measures what Stage 1 estimated: producer time 2,600 to
  3,100 ms, wire 240 to 268 KB, hitch 12.4 to 15.1 ms. The patch's `t_ttc` rises to 3,985 ms, within
  39 ms of the rebuild's; the latency advantage disappears and rebuild-now wins outright at
  286,397 cu. This is the "deliberately uneconomic patch selects full replacement" case, decided by
  measurement rather than by doctrine.

**Row 4 — hot simulation tile, `g = 4` overlays/s on one bin.** With `q = 0.5 s` and
`maxWait = 60 s`, `k = min(e^2.0, 241) = 7.39`, so `alpha = 0.135`: one compaction discharges 7.4
overlays.

| `D_max` | depth cap reached | compaction period | producer duty `rho` | amortized cost per overlay |
| --- | --- | --- | --- | --- |
| 8 | 2.0 s | 2.0 s | 1.60 | 103.0 cu |
| 16 | 4.0 s | 4.0 s | 0.80 | 51.5 cu |
| 32 | 8.0 s | 8.0 s | 0.40 | 25.8 cu |

`rho = C_wall * g / D_max` is the fraction of producer wall-clock consumed by compaction. At
`D_max = 8` the producer cannot keep up at all; at 16 it is 80% occupied and has no headroom for
currentness publication; at 32 it is 40% occupied and pays double residual. The deployment envelope
is `D_max >= C_wall * g / rho_max`, which for `rho_max = 0.5` and this producer means `D_max >= 26`.

The economic comparison never gets to run. The marginal overlay pays for its own compaction after
`alpha * C_compact / 16.70 = 6.7` remaining exposures, which at this tile's load rate is 13.1
minutes — while the depth cap at `D_max = 16` is reached in 4.0 seconds, **197x earlier**. In the
hot-stream case the structural trigger decides and the cost model only chooses how. That is why the
Section 12 trigger is normative, and why the terminal-admissibility gate of Section 9.2 is the bound
on a terminal patch rather than any weighting of `futureDebt`.

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
- Validate freshness before preparing anything. The head must pass its declared profile's checks
  (Section 4.1), including the durable `generationWatermark`, before a state fetched under it is
  prepared. A state that fails the watermark is not prepared, not retained as a candidate, and never
  counted as a desired generation.
- Activation is idempotent and keyed by `stateDigest`. Re-delivery, reconnect, replay, snapshot wake,
  and a repeated verified head naming the already-active state produce no state change, no resource
  churn, and no committed-generation bump. Preparing a generation twice reuses the digest-identical
  prepared resources instead of duplicating them.
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
- Commit is all-or-nothing over the prepared activation frontier. If any prepared resource is lost or
  fails between `READY` and the commit boundary, such as device loss, eviction, or a failed final
  upload, the commit does not begin: the predecessor stays active, the generation returns to
  preparation, and the failure is reported. A commit that has begun completes; there is no
  half-swapped frame.
- A lazy-closure failure after commit does not revert the committed generation, because reverting
  would reintroduce the stale content the transition removed. The client keeps the committed
  generation, withholds the affected coupled target group under a required/current profile or shows
  the complete declared predecessor group under a stale-compatible profile, retries within
  `maxLazyFetchHorizon`, and reports that target as unresolved rather than current.
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

The extension is **strictly additive**. A client that does not implement it, or does not implement one
of its profiles, behaves exactly as it does today: it loads the immutable base its entrypoint names and
keeps rendering what it pulled at load. It never receives patches, states, or invalidations for a
profile it does not implement, because it never asks for them. Nothing here changes what an unaware
client sees, and no publication may depend on an unaware client changing its behavior.

What varies is not client behavior but what the publication can claim:

- **Optional/stale-compatible entrypoint:** unaware clients render a valid base and may be arbitrarily
  stale. The publication makes no currentness claim to them.
- **Required/current entrypoint:** lists the extension in `extensionsRequired`, so an unaware client
  rejects the tileset at load rather than rendering a stale base. This is how a publication declines to
  be read stalely; it is a load-time rejection, not a runtime suppression.
- **Dual entrypoints:** one stable base URL and one authoritative patched-state URL. Both are durable
  named roots under Section 4.5, and the stable base URL is served with the mutable-pointer rules
  stated there.
- **Materialized fallback:** an aware client that lacks a particular codec or component profile fetches
  a fully materialized current representation bound inside the same state manifest.

The claim boundary follows directly: no client may ignore a required capability and claim current data,
and no publication may claim currentness on clients that never agreed to the contract.

An extension-aware client also validates the state's versioned `requiredCapabilities`. Missing a
component, operation, codec, or authenticated-revocation capability, it does not activate the primary
representation. It activates a compatible in-state materialized fallback when the state binds one and
that fallback's exact closure/output identity, source revision, and capability set verify; when there
is none it keeps whatever it was already showing and reports itself non-current until a state it can
interpret arrives. It is not required to blank content, and this is not a fail-closed condition: it is
the honest statement that the client cannot advance. Fallback discovery contains the exact alternate
component/closure descriptor and digest, semantic/output identity, source revision, and required
capability set. It remains part of the one head-bound state manifest; it is not an alternate state
digest or an unbound prose promise.

Revocation is where additive design meets a hard guarantee, so the boundary is stated exactly. A
verified hard revocation produces absence on clients that implement the authenticated revocation
profile and are reaching the current head. It does nothing at all on an unaware client, on an aware
client without that profile, or on any client that stopped fetching: none of them can be reached by a
mechanism they do not implement, and the extension does not pretend otherwise. Therefore:

- a publication whose correctness depends on revoked content being absent MUST serve only
  required/current entrypoints pinned under the revocation profile (Section 4.1) for that dataset, and
  MUST NOT also publish a stale-compatible entrypoint for it, because that entrypoint is precisely a
  supported way to keep rendering the revoked bytes;
- the profile's absence guarantee is scoped in Section 17.3 to the clients that implement it. Content
  already delivered to a client outside the profile is outside the guarantee, in the same way that no
  HTTP mechanism can recall bytes a client has already cached (Section 4.5); and
- a client that implements the profile and cannot reach a current head applies the profile's persistent
  deny root and fails closed on the revoked target (Section 13). That is the one place in this design
  where absence is produced on purpose.

---

## 12. Compaction policy

Compaction is what bounds a patch chain. Because a patch may be terminal, no per-patch rebuild
pledge bounds anything, so the trigger below is normative and structural: economics choose *when* to
compact inside those bounds, never *whether* the bounds apply.

### Normative compaction trigger

Let `b` range over the spatial bins of the affected component. All three quantities are already
carried per bin by `activeSummary` (Section 9.1), so the rule adds no schema and is decidable in
O(touched bins) at admission time:

```text
COMPACT(b) is REQUIRED when any of

  (D)  depth(b)       >  D_max
  (B)  deltaBytes(b)  >  beta  * baseBytes(b)
  (C)  applyCost(b)   >  gamma * loadCost(b)
```

Crossing any one predicate has two consequences. The producer **must** schedule compaction for `b`,
and it **must not** admit a further `patch-terminal` candidate touching `b` until the predicate
clears. A patch on a triggered bin remains legal only as `patch-then-rebuild`; otherwise the change
must be coalesced, expressed as a suppression, or published as a materialized replacement.

**(D) — chain depth.** A target at depth `d` costs `1 + 2d` requests to load cold (Section 9.3.3).
Fix a deployment ceiling `A_max` on that request amplification; then

```text
D_max = floor( (A_max - 1) / 2 )
```

`A_max = 33` sits at the point where one tile's cold load consumes roughly a third of the 100-128
concurrent streams an HTTP/2 connection typically allows, giving `D_max = 16`. The recommended
window `D_max` in `[8, 32]` is exactly `A_max` in `[17, 65]`. When the descriptor index is sharded
`S` per shard, the amplification is `1 + d + ceil(d/S)` and `D_max` rises accordingly; a profile
must declare its sharding before claiming the larger bound.

**(B) — cumulative delta bytes.** A cold load of a patched target transfers
`baseBytes(b) + deltaBytes(b)`. Constraining `deltaBytes(b) <= beta * baseBytes(b)` is therefore a
direct cap of `(1 + beta)` on cold-load transfer inflation. `beta = 0.5` — a 1.5x worst-case cold
load — is the recommended terminal-deployment value; `beta = 1.0` is defensible only when compaction
is already scheduled and the inflation is short-lived.

**(C) — apply cost.** `applyCost(b) = t_desc * d + SUM of t_apply,i` is the work of composing the
chain on top of a freshly loaded base, and `loadCost(b)` is that base's own decode and upload.
Constraining the ratio to `gamma` bounds the cold-load latency regression at `gamma`. At
`gamma = 0.25` the chain stays inside the noise of the base load; above it, applying overlays
becomes the dominant cost of loading a tile that is nominally already cached, which is the failure
the whole design exists to avoid.

**Deferral does not suspend the trigger.** When the update-arrival upper bound meets or exceeds
conservative rebase throughput, or CAS/fence progress cannot be bounded, `DEFER_COMPACTION` remains
the safe candidate: the producer continues publishing ordinary currentness updates, coalesces only
within their freshness SLAs, and retries after the hot tail subsides or capacity increases. But a
deferred trigger is still a fired trigger — `patch-terminal` stays inadmissible on that bin for the
whole deferral, and sustained deferral raises the operator debt/age alert of Section 3.4.3 rather
than silently accumulating depth.

**Hot-stream envelope.** At publication rate `g` on one bin, the depth cap forces a compaction every
`T_compact = D_max / g`. If one compaction takes `C_wall` seconds of producer wall-clock, its duty
cycle is

```text
rho = C_wall * g / D_max        and the deployment requires   D_max >= C_wall * g / rho_max
```

`rho_max = 0.5` is recommended: the producer must retain half its budget for currentness
publication. A deployment that cannot satisfy the inequality must shard the bin, reduce `g`, or
accept a larger `D_max` and its proportionally larger residual cost. Section 9.8 row 4 works the
arithmetic for `g = 4/s`.

### Advisory triggers

These remain inputs to the cost model, not obligations. They may bring compaction forward; they can
never postpone a required one:

- active patch bytes exceed a percentage of base bytes below `beta`;
- recurring mask/application cost approaches the frame-time budget;
- multiple patches touch the same region or resource;
- patch preparation becomes slower than replacement loading;
- offline snapshot closure becomes too large;
- a scheduled publication window permits a full rebuild; and
- measured tail arrival, rebase throughput, CAS contention, and writer-fence latency prove the
  compaction can finish inside bounded deployment limits.

### Compaction procedure

1. Fence a durable source revision `N` and snapshot the exact active state/base used by the build.
2. Materialize and validate a candidate immutable base `B1` locally containing source changes
   through `N`; do not expose its objects to collection/publication yet.
3. Continue accepting source changes `N+1...` as a live tail, or take only a short bounded writer
   fence; do not silently drop updates while `B1` builds.
4. Capture a bounded tail and partition each patch and tombstone's `updateLineage` at `N`. Because
   `B1` was built once from the canonical source snapshot through `N`, validate that the
   incorporated prefix is reflected in `B1` and mark it absorbed — never apply those patch payloads
   a second time. Re-encode/rebind only the surviving tail against `B1`; omit an empty tail record.
   Each surviving patch or tombstone keeps its complete tail lineage but receives a new
   exact-base-scoped revision UUID and digest.
5. Derive the exact candidate state and transitive closure containing `B1` plus only the rebased
   tail. Before any candidate object becomes visible, create a durable publication pin over every
   new and reused digest in that exact closure.
6. Publish and verify the entire pinned immutable closure and candidate state. The pin participates
   in the GC root set throughout verification and publication; successful verification atomically
   seals the compact token/root/count/bytes verification certificate used by head CAS.
7. Compare-and-swap the mutable head against the exact state digest/generation observed when the
   tail was captured. The same atomic transaction O(1)-validates the still-live publication-pin
   fencing token plus sealed verification certificate and promotes its exact closure root to the
   durable head root; an expired/reaped publisher cannot win.
8. If CAS fails because another update arrived, capture and rebase the additional tail, derive the
   new exact closure, and atomically extend or replace the publication pin **before** making any
   added object visible. Keep prior-attempt pins through retry/abort grace. Retry only within the
   declared retry, tail-byte/work, and elapsed-time caps. A final writer fence is allowed only
   within its declared maximum latency. On cap exhaustion, abort/defer compaction, keep the old
   authoritative state, and release all attempt pins only after their abort grace periods; never
   spin or starve currentness updates indefinitely.
9. Emit one idempotent head-change/invalidation hint after the head commit.
10. Clients atomically activate the successor, then retire old CPU/GPU generations after safe
    fences.
11. Make the committed state/head the durable root before releasing the candidate publication pin.
    Retain the old base/patch closure for the grace/offline/rollback window and garbage-collect only
    after a consistent mark epoch plus final root/pin recheck proves it unused.

Compaction reduces `depth(b)` to the depth of the surviving rebased tail, not necessarily to zero. A
trigger clears only when every predicate is false against the newly published `activeSummary`.

`compactedThroughSourceRevision=N` is safe only when the declared source domain makes `N` a true
ordered prefix. A source without that guarantee uses selective compaction naming exact logical
update IDs plus patch revision IDs/digests in a strictly bounded canonical set; a larger set is
stored as a content-addressed Merkle/index root with bounded proofs. Both forms must rebase or
retain every dependent later patch/tombstone. Publishing a new base while carrying old-base-relative
tail operations is a correctness failure even if their logical source IDs match.

### 12.1 Local rebuilt-tile example

Rebuilding one tile does not require regenerating every tile payload or changing the tiling scheme.
Steps 1 and 2 are separate decisions under separate triggers; step 2 is not implied by step 1.

1. **Publish the change.** If the logical tile, bounds, geometric error, refinement, and implicit
   availability remain valid, publish the rebuilt content as a `replaceContent` one-tile replacement
   state operation. The old content and any patches incorporated into the rebuilt bytes stop
   contributing in the same atomic state transition.
   - *MVP-only path.* `replaceContent` is a typed operation outside the Section 2.2 MVP. An MVP
     deployment expresses the same change as `replaceRegion` with a mask covering exactly the tile's
     surface footprint and a one-tile replacement tileset wrapping the rebuilt content. The wire
     cost is one mask polygon plus one generated tileset descriptor above the typed form; the
     semantics, atomicity, and identity binding are the same. Everything below applies unchanged.
2. **Compact only when required or chosen.** Publishing a new base revision is a separate decision.
   It is mandatory when any Section 12 trigger predicate is true for a touched bin, and otherwise it
   is one candidate the optimizer weighs against leaving the replacement in place terminally
   (Section 9.4). When compaction runs, the new base revision's resource closure reuses every
   unchanged base object and references only the new tile/content and any changed subtree or root
   shard. Base immutability requires a new revision identity; it does **not** require recomputing or
   retransmitting unchanged content-addressed resources.
3. Omit incorporated patches from the successor active set. Retain or rebase unrelated/dependent
   tail patches against the new base digest.
4. CAS the head, then emit an exact-content/subtree hint. A client loads and verifies the new
   content, switches mask/selection and content atomically, and retires the old GPU/CPU generation
   after its fences settle.
5. The old tile and incorporated patch closure become GC candidates only after retention and
   reachability rules pass.

If the rebuild changes hierarchy, availability, bounding-volume containment, or refinement
semantics, a new base revision must be published for the affected component; its closure may reuse
every unchanged content-addressed resource, so "republish the subtree" means a new base revision
identity, not a retransmission. There is no subtree-level revision identity in Section 4.

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
- downgrade and rollback to an older generation, including a stale-serving intermediary that replays
  an older head, bounded by the declared freshness profile, the durable `generationWatermark`, and
  `maxStaleness` (Section 4.1);
- digest-algorithm downgrade, unregistered or truncated digests, and mixed-suite closures
  (Section 4.3);
- invalidation selectors, subtree depth/ranges, and notification rate;
- event UUID/epoch/sequence replay, gaps, and same-generation digest conflicts;
- unauthorized cross-dataset, cross-base, cross-origin, or shared-cache targets;
- retention/GC attempts against still-reachable or shared resources.

Patch data must never contain executable JavaScript or arbitrary shader source. HTTPS provides
transport protection and digests provide integrity, but freshness and publisher authenticity come
only from the signed head statement of Section 4.1, whose detached signature covers the exact served
head bytes. A signature over a state manifest alone proves who built that state, not that it is the
current one, so it is never sufficient for a currentness or revocation claim. Hard revocations must
be authenticated, anti-rollback protected, persisted in the current authoritative state, and bounded
so a replay or flood cannot create an unbounded tombstone index.

A limit that is not declared cannot be enforced or tested, so every bound above MUST be declared with
a concrete value in the deployment/profile declaration a client obtains with the entrypoint, and that
declaration MUST be machine-readable. A client rejects any input exceeding the declared limit or its
own local limit, whichever is smaller, and reports which one fired. A profile that introduces a codec
MUST extend the declaration with that codec's own axes, at least instance and primitive counts,
attribute and index counts, mip and block counts, decompressed output bytes and expansion ratio, and
concurrent bake/upload work, so that resource-limit conformance is a testable claim rather than a
posture.

A notification channel is not trusted to inject resources, authorize deletion, or trip a protective
state. Hints are unauthenticated by construction: the most one may cause is a rate-limited head
revalidation (Section 4.4, laws 9 and 10). No hint content, whether a replayed identifier, a
divergent projection, a conflicting generation, an unknown epoch, or a flood, may produce a
fail-closed condition, because that would hand denial of service to anyone who can reach the
transport. Fail-closed conditions arise only from a verified head/state disagreement, a failed digest
or signature, a watermark violation, or a verified revocation.

Hard revocation is a separate required security profile, not an MVP core promise. The profile must
define publisher keys/rotation, signed state and optional signed deny-only notices, anti-rollback
epochs, exact digest-scoped targets, the pinned `entrypointDigest` of Section 4.1 so a client cannot
be moved to an entrypoint with the extension stripped, and fail-closed behavior while a successor is
unavailable. A revocation record cannot retire until no supported retained entrypoint/state/offline
lease can select the target, or until an equally authoritative persistent deny root continues to
cover it. A core client without the profile rejects a state containing nonempty `revocations`, keeps
what it already had, and makes no absence claim. The profile's guarantee is therefore scoped to the
clients that implement it and are reaching the current head; Section 11 states that boundary and
Section 17.3 tests it.

---

## 14. Performance targets for the prototype

Every target below carries a number and an instrument. A target without both is a slogan. Values are
derived from the cost model of Section 9.3, the scaling law of Section 9.7, and the caps of Section
12; where a value was measured, it was measured over the canonical JSON of this document with full
64-hex digests.

Two instrument classes are used, and browser-free is preferred wherever the quantity does not
require a rendering surface:

- **N — browser-free Node.** A pure model or gate library under `Tools/visual-regression/lib/`
  driven by `node --test Tools/visual-regression/<name>.spec.mjs`, plus fixture generators run as
  `node Tools/<name>.mjs`. The reference producer and mutable-head server run in the same lane. No
  browser, no GPU, deterministic, runnable in CI.
- **P — Playwright probe.** `Tools/visual-regression/probe-*.mjs` against Edge/Chromium with WebGPU
  enabled, reading frame counters through `scene.getDebugSnapshot()` and capturing canvas-element
  screenshots; `Tools/visual-regression/capture-and-diff.mjs` for the pixel-correctness legs.

| # | Target | Value | Derivation | Instrument |
| --- | --- | --- | --- | --- |
| 1 | Discovery head bytes | <= 512 B (measured 403 B) | Section 4.1 shape with full digests | N — byte count over generated fixtures |
| 2 | Head-change hint bytes | <= 1 KB; 564 B bare, 803 B with one `affected` entry | measured; a second entry crosses 1 KB, so at most one entry is carried and larger detail defers to a head refresh | N |
| 3 | Event-identity projection bytes | <= 512 B | eight canonical fields of Section 4.4 | N |
| 4 | Active-state manifest bytes | `M(P) = 1134 + 495P`; <= 9,054 B at the per-bin cap `D_max = 16`; shard above `P = 256` (125 KiB) | Section 9.7 | N |
| 5 | No full base download for a cache-resident compatible patch | 0 base bytes fetched | content-addressed immutability | N — reference-server request log |
| 6 | Optimizer Stage-1 decision time | p95 <= 200 us | table lookups plus <= 3 candidate vectors of ~18 terms over <= 64 touched bins | N — 10^5 runs over the pure model |
| 7 | Producer patch build vs full rebuild | <= 5% for the reference edit (1,400 ms vs 42,000 ms = 3.3%) | Section 9.8 Edit A | N — producer timing |
| 8 | Patch build scaling | linear in changed elements/blocks, independent of total tile size; slope fitted, `R^2 >= 0.9` | Section 9.1 localization contract | N — sweep over change sizes |
| 9 | **Time-to-current, patch** | p95 <= 3.0 s | `t_publish + t_propagate + t_notify + t_fetch + t_prepare` = 2,243 ms modelled | N for `t_publish`; P for hint-to-first-correct-pixel |
| 10 | **Time-to-current, patch vs rebuild** | >= 10x reduction (46,630 / 2,243 = 20.8x modelled) | Section 9.8 Edit A | N + P, same run |
| 11 | State-fetch round trips | <= 3 serial round-trip groups cold, <= 1 warm (head `304` plus state) | Section 9.3.2 `t_fetch` | N — reference-server trace |
| 12 | Cold-load request amplification | <= `1 + 2 * D_max` = 33 at `D_max = 16` | Section 9.3.3 | N — request log at synthetic depth |
| 13 | Residual per-frame cost | <= 97 us/frame/bin at `d = 1`; <= 250 us/frame total across all bins, 1.5% of a 16.7 ms frame | `u_cpu + u_gpu * V` with `V = 3` | P — frame-time trace with patches active vs absent |
| 14 | No per-frame work for patches outside the view | 0 us, 0 draw calls, 0 mask evaluations | Section 5.4 coarse rejection | P — counters with the camera off the patched region |
| 15 | Spatial lookup | `O(log P)`; <= 12 us at `P = 4096` | Section 5.4 spatial index | N — pure index library |
| 16 | Bounded patch-state memory | `m_run <= 2.1 MB` per active overlay; total <= `D_max * 2.1 MB` per bin | Section 9.8 residual model | P — GPU/CPU allocation counters |
| 17 | p95 activation hitch | `3.1 * d` ms modelled; hard cap 8 ms at `d = 1` | Section 9.8 hitch model | P — frame-time histogram across the swap |
| 18 | Atomic activation | 0 frames showing a partial swap, a hole, or a mixed coupled generation | Section 10 commit rule | P — `capture-and-diff.mjs` over the transition frames |
| 19 | Bounded double residency | peak <= 1.35x steady GPU bytes | Section 10 bounded rollout | P — allocation counters |
| 20 | Old-generation retirement latency | <= 3 frames after the submission fence | Section 10 retire rule | P — resource-lifetime counters |
| 21 | Zero new GPU resources on stable repeated frames | 0 creations over 300 consecutive frames | Section 10 | P — creation counters |
| 22 | Duplicate/out-of-order notifications | 0 fetches, 0 patch work, 0 generation changes | Section 4.4 client laws 1-3 | N — state machine; P — frame counters |
| 23 | Bounded event/tombstone history | manifest carries no history; recovery needs no event chain | Section 4.2 snapshot law | N — cold-load from head only |
| 24 | Typed sparse update vs replacement | >= 4x faster decode-plus-upload | Section 7.1 direct-apply target | P — timed apply against the same edit as `replaceRegion` |
| 25 | Automatic rebuild choice when patch economics lose | selected in 100% of the Section 9.8 row 3' inputs | Section 9.4 ranking plus margin | N — decision-record assertions |
| 26 | Compaction duty cycle | `rho = C_wall * g / D_max <= 0.5` | Section 12 hot-stream envelope | N — producer scheduler simulation |
| 27 | Head origin load | `<= N_clients / T_poll`; hint-driven revalidation only while `g < 1 / T_poll` | Section 9.7 crossover | N — reference-server request counters |

Rows 1-12, 15, 22-23, and 25-27 are fully browser-free and belong in the deterministic lane. Rows
13-14, 16-21, and 24 require a real rendering surface and use the probe lane; each names the counter
or capture it reads so that a green result is a measurement rather than an assertion that the code
ran.

"Hyper performant" is not established by a small payload alone, and it is not established by
time-to-current alone either. The gate is the whole cost vector: producer time, wire bytes, request
and origin counts, client preparation, activation hitch, recurring frame cost, retained memory,
residual chain complexity, and eventual compaction. A candidate that wins one row and loses four is
not fast; it has moved the cost somewhere the benchmark was not looking.

---

## 15. Prototype and standardization plan

| Phase | Deliverable | Status |
| --- | --- | --- |
| R0 | Primary-source standards survey and architecture review | Complete |
| R1 | This working design/decision tracker | Complete |
| R2 | Reconcile prior repository invalidation research/prototype with the immutable state model | Complete |
| D1 | Freeze terminology, scope, fallback, identity, mask, selector, and invalidation semantics | Pending |
| D2 | Define patch profile and patch-vs-rebuild estimator schema | Pending |
| P0 | Reference producer (simulation-shaped change stream), mutable-head publication server, and scenario dataset generator | Pending |
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

P0 is a prerequisite, not an option: P1-P3, V1-V3, B1, and roughly half of §15.2 assume a publication
service and a scenario corpus that this repository does not have. The engine prototype rides the
compositor-subtree vehicle of §3.3.3 — replacement content inside the base tileset's traversal, one
cache, one budget, one swap owner — so P1 and P2 also depend on the transaction and mask components
named in §3.3.2.

### 15.0 P0 — reference producer, head server, and dataset generator

The repository's development server (`server.js`) is a static file server with a build watcher: it has
no mutable resource, no conditional write, no event channel, and no operation accounting. No fixture
expresses a base revision, a patch closure, or a head. P0 delivers three Node artifacts and their
contracts.

1. **Reference producer — simulation-shaped.** A change-stream generator rather than an edit script:
   it advances a small world model (a moving excavation front over a synthetic surface plus a handful
   of surface objects), and emits localized changes at a configured rate for a configured duration,
   each carrying `updateId`/`sourceRevision`, a bounded affected-target summary, and the decision the
   §9 estimator produced. A fixed seed produces a byte-identical stream so a run is reproducible, and
   the rate is a parameter so arrival-versus-rebase-capacity behavior (§3.4.3) can be driven from
   below capacity to sustained overload.
2. **Mutable-head publication server.** An immutable content-addressed object route with immutable
   cache headers; one mutable head route with an entity tag and compare-and-swap on conditional write;
   one hint channel (Server-Sent Events) that is explicitly non-authoritative; retention and
   garbage-collection controls; injectable delay, corruption, and stale-serving fault profiles; and
   counters for every origin operation. It runs on its own port and does not modify `server.js`, which
   keeps serving the client build.
3. **Scenario dataset generator.** Writes the base revision, patch closures, tombstones, and rebuilt
   successors for §15.1 into a scratch directory, deriving from repository fixtures where one fits and
   synthesizing where none does. Generated corpora stay out of version control; only the small
   canonical vectors a conformance suite needs are checked in, and that is S1's deliverable, not P0's.

Acceptance is browser-free wherever the claim is not visual, following the fork's existing split
between contract specs and probes ([Tools/visual-regression/README.md](../Tools/visual-regression/README.md)):

- **Contract specs** run under Node's test runner (`node --test`) with no dev server, browser, or GPU,
  and assert: canonical bytes hash to their advertised digests; a conditional head write with a stale
  precondition is rejected and the rejection is observable; replaying an identical publication is
  idempotent and advances nothing; a generated scenario closure is complete, every referenced object
  resolves, and every digest verifies; a retention window is honored before an object becomes
  collectable; and the seeded stream reproduces byte-for-byte across runs. Precedent for browser-free
  engine-adjacent self-tests: [`Tools/run-far200-shadow-self-test.mjs`](../Tools/run-far200-shadow-self-test.mjs).
- **Probes** cover only claims that require a rendered frame. They resolve their verdict through the
  frozen fleet table in
  [`Tools/visual-regression/lib/verdict-exit-gate.mjs`](../Tools/visual-regression/lib/verdict-exit-gate.mjs)
  — `0` PASS, `1` FAIL, `2` ERROR, `3` STRUCTURAL — with
  [`probe-fleet-contract.spec.mjs`](../Tools/visual-regression/probe-fleet-contract.spec.mjs) enforcing
  verdict-versus-exit-code agreement. A probe that cannot reach its subject exits `3`; it never reports
  a pass. Captures are canvas-element screenshots taken in the same task as the render, because a read
  taken across a yield is invalid on both backends
  ([`lib/same-task-capture.mjs`](../Tools/visual-regression/lib/same-task-capture.mjs) holds the
  canonical primitives and the drift check).
- **Existing instruments are reused rather than reinvented:** content-request and byte accounting
  through
  [`lib/representative-tileset-request-ledger.mjs`](../Tools/visual-regression/lib/representative-tileset-request-ledger.mjs),
  and cross-backend pixel comparison through
  [`capture-and-diff.mjs`](../Tools/visual-regression/capture-and-diff.mjs).
- **Both backends.** Every rendered acceptance claim runs on WebGL and WebGPU (repository principle 5).
  A claim that can only be shown on one backend is recorded as such rather than generalized.

Proposed homes: the three artifacts under `Tools/patch-prototype/`, their contract specs as
`Tools/visual-regression/*.spec.mjs`, and their probes as `Tools/visual-regression/probe-patch-*.mjs`.
P0 requires no engine change; P1 onward requires the components of §3.3.2.

### 15.1 Required reference scenarios

Each scenario names the dataset it runs against. "Generated" means the P0 generator produces it;
repository paths are existing fixtures.

| # | Scenario | Dataset |
| --- | --- | --- |
| 1 | Flatten an interior hill and update baked imagery. | Generated `hill-base`: a three-level surface tileset with baked imagery. No repository fixture carries a cross-LOD hill. |
| 2 | Flatten a hill crossing a tile boundary. | Generated `hill-base`, with the edit straddling a shared edge. |
| 3 | Preserve the flattened result through coarse, medium, and fine HLOD transitions. | Generated `hill-base`; refinement behavior cross-checked against `Specs/Data/Cesium3DTiles/Tilesets/TilesetReplacement1`. |
| 4 | Apply sparse vertex/normal changes to a layout-stable glTF. | Generated from `Specs/Data/Cesium3DTiles/GltfContent`, with the generator recording exact layout provenance. |
| 5 | Apply block-aligned texture changes with complete mips/gutters. | Generated KTX2 fixture; shared-resource behavior cross-checked against `Specs/Data/Cesium3DTiles/Tilesets/TilesetWithSharedTextures`. |
| 6 | Apply a topology-stable quantized-mesh height override. | `Specs/Data/CesiumTerrainTileJson/QuantizedMesh` for the single-tile decode contract; generated for the edge/LOD group and its upsampled descendants. |
| 7 | Force every optimizer fallback: patch, region replacement, whole tile, and base compaction. | Generated stream with edits sized to cross each threshold in turn. |
| 8 | Compact an ordered source-update prefix through `sourceRevision N` while later source changes arrive; rebase the entire `N+1...N+k` tail without losing an `updateId`. | Generated seeded stream (P0 producer plus head server). |
| 9 | Deliver duplicate, reordered, and gapped invalidation events; converge directly on the latest state snapshot. | Generated, through the P0 hint channel's fault profile. |
| 10 | Replace one exact tile/content slot, one implicit subtree, and one multi-layer atomic state while leaving siblings untouched. | `Specs/Data/Cesium3DTiles/MultipleContents` and `Specs/Data/Cesium3DTiles/Implicit/ImplicitTileset`, plus a generated terrain/imagery pairing for the multi-layer leg. |
| 11 | Keep old content visible through a delayed successor, then release old CPU/GPU resources only after safe submission fences. | Generated, through the P0 server's injectable delay and failure profiles. |
| 12 | Exercise semantic suppression, stale-compatible offline state, reconnect, and retention-safe shared-resource garbage collection; exercise hard revocation only under the required authenticated revocation profile. | Generated, using the P0 server's retention/GC controls and a shared-resource closure spanning two states. |
| 13 | **Continuous simulation stream under a moving camera** — the primary deployment. The producer emits changes at a configured rate for a configured duration while the camera flies a fixed path across the affected extent. No frame shows a mixed generation, double residency stays inside its budget, patch debt and oldest-job age stay bounded, and the client converges to the newest generation after the stream stops. | Generated `hill-base` plus the seeded P0 stream at several rates, including one above sustained rebase capacity. |

Scenario 13 is the deployment the design exists for; scenarios 1-12 are the correctness ladder it
depends on, and each must hold under 13's arrival rates as well as in isolation.

### 15.2 Benchmark outputs

Each output names the instrument that produces it. Producer- and server-side outputs are asserted by
Node contract specs; client-side outputs are read by probes; rendered claims are compared with the
capture harness.

| Output | Instrument |
| --- | --- |
| Source-change localization time; optimizer decision time | P0 producer run record; bounds asserted by contract spec |
| Patch/replacement/rebuild production time | P0 producer run record |
| Manifest and payload bytes | P0 generator and server accounting |
| Request count and time-to-current | `Tools/visual-regression/lib/representative-tileset-request-ledger.mjs` plus P0 server origin counters |
| Client validation/decode/upload time | In-page performance marks read by the probe |
| Visible/imminent/off-screen preparation latency, prediction hit rate, wasted pre-bakes, skipped obsolete bakes | Compositor and bake-cache counters (§3.3.2) surfaced through `scene.getDebugSnapshot()` and read by the probe |
| Peak CPU/GPU memory; pinned, baked, and double-resident bytes | `Cesium3DTilesetStatistics` and `Cesium3DTileset.totalMemoryUsageInBytes`, plus `Renderer/WebGPU/WebGPUFrameStatistics.ts` on the WebGPU leg |
| Frame-time and hitching impact | Probe-side frame timing; GPU timing legs interleaved within one run, never compared across builds |
| Cache hit/offline replay behavior | P0 server counters with its offline/fault profile |
| Invalidation event bytes, fanout, coalescing, gap recovery, and time-to-current | P0 hint channel counters plus client reconciliation counters |
| Origin `PUT`/`HEAD`/`DELETE`/`LIST`, reference-index, durable-outbox, and recovery-scan operation counts | P0 server operation counters |
| In-flight swap count, double-residency peak, and retirement latency | Transaction and cache statistics (§3.3.2, §3.3.3) |
| Update arrival/burst rate, compaction rebase throughput, CAS retry/backoff, writer-fence latency, deferral rate, retained-closure byte-days | P0 producer and server telemetry; asserted by contract spec |
| Debounce quiet/max-wait latency, rebuild jobs avoided/coalesced, throttle queue depth, direct-rebuild versus patch-first completion time | P0 producer scheduler telemetry |
| Compaction time and storage amplification | P0 generator and server |
| Exact visual, picking, and query correctness | Probes with same-task element capture; cross-backend pixel comparison through `Tools/visual-regression/capture-and-diff.mjs` |

Out of scope for the in-repository prototype, because no instrument here can produce them honestly:
client-cohort percentiles, real CDN edge and multi-region propagation behavior, and any figure that
requires a fleet rather than one machine. These are deployment measurements; the prototype reports
single-client, single-origin numbers and says so.

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

These rows test the authenticated revocation profile. The rows naming the head statement, the
generation watermark, and the digest suite apply equally to the signed freshness profile of
Section 4.1, which the revocation profile includes.

- An unsigned, wrong-key, replayed, cross-dataset, or rollback revocation fails closed.
- A verified revocation dominates patches and tombstones targeting the revoked digest, including
  content not yet loaded, independent of manifest order.
- Hard-revoked content remains absent during successor failure and cannot return through a stale or
  offline entrypoint covered by the profile's persistent deny root.
- A revocation record cannot retire while any supported retained state/offline lease can select the
  target unless an equally authoritative persistent deny root remains.
- A head statement that is unsigned, signed by the wrong key, expired beyond the declared
  `maxStaleness`, bound to another dataset or trust domain, or naming a generation below the durable
  `generationWatermark` is rejected; the client keeps its last verified state, marks it stale, and
  never adopts the older generation.
- The watermark survives reload, cache eviction, and process restart: a client replayed an older but
  validly signed head after a restart rejects it.
- An entrypoint that is stripped of the extension, repointed at another head, or does not match the
  signed `entrypointDigest` fails closed instead of silently downgrading the client to an unsigned
  stale base.
- The detached head-statement signature verifies against the exact served head bytes; a re-serialized
  or renormalized head fails verification.
- A closure that mixes digest algorithms, or names an unregistered or truncated one, is rejected with
  no fallback to a weaker algorithm.
- The profile's absence guarantee is claimed only for clients that implement it and are reaching the
  current head. Conformance asserts absence on profile clients, and asserts that an unaware or
  non-profile client is unaffected by the profile rather than blanked by it.
- An expired head statement does not undo a revocation the client already applied.

---

## 18. Research conclusions

Each conclusion below is a reading of evidence recorded elsewhere in this document. Where a claim
depends on measurement that has not been taken, it is marked as pending rather than asserted.

1. The concept addresses a gap in the **published standards**, not a gap in capability. §2.4's survey
   finds no adopted standard and no registered extension that binds an update to an exact immutable
   base revision, activates it atomically across coupled resources, and retires the predecessor under
   explicit safety rules. Whether that shape actually reduces update latency against whole-tile
   replacement is a measurement owed by P1, P6, and B1, and is not established by this document.
2. The best first standards shape is one live-update extension family discovering an immutable
   active-state manifest, plus an optional low-latency invalidation/head-change control plane—not
   HTTP `PATCH`, not blind GLB byte mutation, and not an authoritative imperative event log.
3. `replaceRegion` plus a replacement tileset is the correct universal MVP because it handles
   independent HLOD and avoids coupling to one exporter layout.
4. Typed vertex and texture patches remain essential optimization paths. Their fragility is solved
   through exact provenance, narrow codec invariants, derived-data rules, and automatic fallback.
5. Quantized mesh **appears** patchable for topology-stable height changes under the preconditions
   §8.1 states, but the claim is conditional on P6 and B1 and is not established here. Independently
   of that result it is a separate terrain format and needs its own profile, and wide,
   topology-changing, or bounds-changing edits should replace the terrain tile or spatial region.
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
10. The distinguishing property of this work is the **origin** of a change, not its encoding. §2.4
   shows a standards landscape well supplied with prebaked, authored-ahead temporal and versioning
   models—`3DTILES_temporal`, CityGML 3.0 versioning, glTF morph targets and material variants, and
   the time-dynamic direction in issue #102 and the June 2025 Cesium roadmap—and essentially
   unsupplied for a live producer pushing data onto tiles that are already published and already
   cached. Design decisions should be tested against that case first. The one existing 3D Tiles
   primitive aimed at a changing dataset is tile expiration, which is whole-tile, polled, and
   base-unaware; it remains the right degraded path for clients that ignore the extension.
11. Time-dynamic 3D Tiles is a **convergence obligation, not a competitor**. Its updates are captures
   authored ahead of delivery; these patches are post-hoc overlays from a live producer, and a patch
   can be a delta within a linear time flow. The design should be shaped so it can extend a future
   `3DTILES_time_dynamic` rather than duplicate it, and §2.4's survey must be re-run before the D1
   freeze.
12. Two already-standardized mechanisms should be reused rather than reinvented: RFC 6902 JSON Patch,
   which MPEG-I scene description already uses as its update-sample model, as a candidate envelope
   for bounded edits to structured documents; and the core-glTF construction of a sparse accessor
   laid over a shared external buffer, as a zero-new-codec payload for bin-based content. Both
   narrow what this design must specify itself, and the second narrows the novelty claim in §2.4.
13. Standardization should follow implementation evidence: vendor extension, conformance corpus, two
   runtimes, benchmarks, then possible `3DTILES_*` or future core promotion.

---

## 19. Primary references

Every URL below was fetched and confirmed to resolve on 2026-08-16. Entries added after the original
2026-08-11 survey are marked *(added 2026-08-16)*.

- [OGC 3D Tiles 1.1](https://docs.ogc.org/cs/22-025r4/22-025r4.html) — the rendered HTML is roughly
  53 MB; the specification source below is the practical primary citation.
- [3D Tiles specification source and extension mechanics](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc)
- [3D Tiles extension registry](https://github.com/CesiumGS/3d-tiles/tree/main/extensions)
- [3D Tiles implicit tiling](https://github.com/CesiumGS/3d-tiles/blob/main/specification/ImplicitTiling/README.adoc)
- [3D Tiles next-version scope](https://github.com/CesiumGS/3d-tiles/issues/822)
- [Time-dynamic 3D Tiles (3d-tiles issue #102)](https://github.com/CesiumGS/3d-tiles/issues/102) *(added 2026-08-16)*
- [Tile expiration (3d-tiles issue #99)](https://github.com/CesiumGS/3d-tiles/issues/99) *(added 2026-08-16)*
- [Cesium roadmap for bridging the built and natural environment, 2025-06-23](https://cesium.com/blog/2025/06/23/cesium-roadmap-for-bridging-the-built-and-natural-environment/) *(added 2026-08-16)*
- [Draft `3DTILES_content_conditional`](https://github.com/CesiumGS/3d-tiles/pull/834)
- [`3DTILES_temporal` JSON schemas, Jaillot, Servigne, Gesquière and Boix, 2020](https://doi.org/10.5281/zenodo.3596881) *(added 2026-08-16)*
- [Jaillot, Servigne and Gesquière, "Delivering time-evolving 3D city models for web visualization", *International Journal of Geographical Information Science* 34(10):2030–2052, 2020](https://doi.org/10.1080/13658816.2020.1749637) *(added 2026-08-16)*
- [glTF 2.0 specification, including sparse accessors and external buffer URIs](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
- [glTF extension registry](https://github.com/KhronosGroup/glTF/blob/main/extensions/README.md)
- [glTF vendor `MPEG_scene_dynamic` extension](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/MPEG_scene_dynamic/README.md)
- [MPEG-I Scene Description dynamic scenes and JSON Patch update model (ISO/IEC 23090-14)](https://mpeg-sd.org/dynamic-content) *(added 2026-08-16)*
- [KTX 2.0 specification](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html)
- [KTX Fragment URI 1.0](https://registry.khronos.org/KTX/specs/2.0/ktx-frag.html)
- [Quantized-mesh terrain format](https://github.com/CesiumGS/quantized-mesh)
- [OGC API — Tiles Part 1](https://docs.ogc.org/is/20-057/20-057.html)
- [OGC Testbed-15 Images and ChangesSet API Engineering Report (19-070)](https://docs.ogc.org/per/19-070.html)
- [OGC Testbed-15 Delta Updates Engineering Report (19-012r1)](https://docs.ogc.org/per/19-012r1.html) *(added 2026-08-16)*
- [OGC CDB 2.0 Part 1](https://docs.ogc.org/is/23-034/23-034.html)
- [OGC CityGML 3.0 Conceptual Model — Versioning](https://docs.ogc.org/is/20-010/20-010.html#_versioning)
- [OGC WCS Transaction Extension](https://docs.ogc.org/is/13-057r1/13-057r1.html)
- [OGC Indexed 3D Scene Layer (I3S) 1.3 Community Standard (17-014r9)](https://docs.ogc.org/cs/17-014r9/17-014r9.html) *(added 2026-08-16; replaces the OGC I3S landing page, which does not carry the format's update semantics)*
- [ArcGIS Enterprise — Manage 3D layers, including partial and full scene-layer cache rebuilds](https://doc.esri.com/en/arcgis-enterprise/latest/share/manage-3d-layers.html) *(added 2026-08-16)*
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html)
- [RFC 8246: HTTP Immutable Responses](https://www.rfc-editor.org/rfc/rfc8246.html)
- [RFC 9875: HTTP Cache Groups](https://www.rfc-editor.org/rfc/rfc9875.html)
- [RFC 6902: JavaScript Object Notation (JSON) Patch](https://www.rfc-editor.org/rfc/rfc6902.html) *(added 2026-08-16)*
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [RFC 9562: Universally Unique IDentifiers, including UUIDv7](https://www.rfc-editor.org/rfc/rfc9562.html)
- [RFC 4122: A Universally Unique IDentifier (UUID) URN Namespace](https://www.rfc-editor.org/rfc/rfc4122.html) — obsoleted by RFC 9562; cited by the canonical-ordering table in §4.2, which should be
  restated against RFC 9562 (the byte semantics are unchanged) *(added 2026-08-16)*
- [Repository live-invalidation research](archive/SESSION_2026-04-08_RESEARCH_REPORT.md#6-live-3d-tiles-invalidation--final-design)
- [Repository snapshot/invalidation reconciliation spike](archive/SNAPSHOT_MODE_SPIKE_2026-04-09.md#32-reconciliation-contract-with-scene_snapshotversion)
- [RFC 5789: HTTP PATCH](https://www.rfc-editor.org/rfc/rfc5789)
- [RFC 3229: Delta Encoding in HTTP](https://www.rfc-editor.org/rfc/rfc3229)
- [RFC 3284: VCDIFF](https://www.rfc-editor.org/rfc/rfc3284)

RFC 9530 (Digest Fields), RFC 8594 (the Sunset header) and RFC 5829 (link relations for simple
version navigation) were listed in the 2026-08-11 draft but are not bound by any statement in this
document. They are removed here rather than left as decorative citations. If a later revision binds
representation digests to HTTP `Repr-Digest`/`Content-Digest`, advertises retention deadlines with
`Sunset`, or standardizes predecessor/successor navigation links, restore the corresponding
reference at the same time.
