# Cloud Unification Design — Drive Volumetric Clouds THROUGH CloudCollection

**Date:** 2026-07-05
**Directive (user, 2026-07-05):** The fork's WebGPU volumetric cloud system (`WebGPUProceduralCloudRenderer`, key `PROCEDURAL_CLOUDS=32`, + `WebGPUWeatherRenderer`, `CloudNoiseBake`, WMO genera, E1/E2/E3 exotics) must be **driven through the upstream `CloudCollection` API and built OFF it**, instead of being a separate globe-attached system (`globe.showProceduralClouds`). Requirements: (1) `CloudCollection` is the entry point for volumetric too; (2) enable FLAGS turn volumetric on; (3) WebGPU-only FLAGS expose expanded functionality + cloud TYPES (weather, genera, exotics) with no WebGL counterpart; (4) existing billboard `CloudCollection`/`CumulusCloud` usage stays backward-compatible + WebGL keeps working (feature-detect + graceful fallback; opt-in default-off; byte-identical when off).

**Premises verified at HEAD** (reads, not memory):
- `CloudCollection.add()` (CloudCollection.js:250-271) reads `options.cloudType`, calls `CloudType.validate()`, then constructs `new CumulusCloud(options, this)` — but `CumulusCloud` ctor (CumulusCloud.js:37-66) never stores it. Genus is validated and dropped. ✔ cleanest per-cloud seam.
- `CloudCollection.update()` (CloudCollection.js:429-439) already forks on `getFeatureRenderer(CLOUD_COLLECTION)`; WebGPU FR takes the whole path, WebGL billboard path is the fallthrough. ✔ backward-compatible dispatch shape already exists.
- Volumetric raymarch is dispatched in the **env-effects phase** (WebGPUSceneRendererEnvironmentalEffects.ts:159), gated `if (globe?.showProceduralClouds)`, `execute(context, frameState, colorView, depthView, outputView, globe)` — config read off `globe.*`. Runs LATE (post-globe, post-process) because it samples scene color + depth and composites over `outputView`. ✔ cannot be a primitive-phase DrawCommand.
- `publishCloudIblCoverage(context, globe)` (env-effects:114) runs every frame regardless of cull, reading `globe.*` via a loose cast. ✔ must keep an unconditional publish.
- `_consumeDirtyState` (CloudCollection.js:359-377) zeroes `_propertiesChanged[0..NUMBER_OF_PROPERTIES)` in a generic loop; the dirty-index system is add-only. ✔ adding index 7 is mechanical.
- `CloudType` (CloudType.js) = frozen 11-genus enum, `COUNT=11`, `CUMULUS=0` first for back-compat, `validate()` integer-in-[0,10].

---

## 1. Architecture

### 1.1 The central constraint that shapes everything

The volumetric raymarch **must** run in the env-effects phase (after globe + post-process) because it samples display-space scene color + depth and composites full-screen over the output view. `CloudCollection.update(frameState)` runs during **primitive update** and can only emit `DrawCommand`s — it has no access to the late composite hookup. Therefore the redesign splits the two concerns:

- **CONFIG SOURCE + ACTIVATION GATE** → move from `globe.*` onto the `CloudCollection` instance. (This is what the directive asks for.)
- **THE FULL-SCREEN COMPOSITE PASS** → stays exactly where it is, in the env-effects phase. What changes is *what object it reads config from* and *how it is gated*.

This is the "config moves, pass stays late" split. It is mandatory; any attempt to render the march from `CloudCollection.update()` breaks pass ordering.

### 1.2 The unifying data type: `CloudVolumetrics` (structural config carrier)

Introduce a plain backend-neutral config object, **`CloudVolumetrics`** (`packages/engine/Source/Scene/CloudVolumetrics.js`), whose fields are **exactly the field names the volumetric renderer already reads off the globe** (`cloudCoverage`, `cloudLayerBottom/Top`, `cloudDensity`, `cloudWindSpeed`, `cloudWindDirection`, `cloudQuality`, `cloudVolumetricQuality`, `cloudType`, `cloudMultiDeck`, `cloudCastShadows`, `cloudContributesIBL`, `cloudWeatherMap`, `weatherProvider`, `cloudMammatus*`, `cloudSpecies*`, `cloudHighPrecision`, … the ~40 `cloud*` dials + genera + exotic knobs). It also carries `enabled: boolean`.

Because the field names are identical, `WebGPUProceduralCloudRenderer.executeProceduralClouds` and `publishCloudIblCoverage` do **not** change their ~50 read sites — they just take a `config` argument that structurally matches what `globe` gave them today. The globe *is* a valid `CloudVolumetrics`-shaped object (it already has those fields); a `CloudCollection` will own a `CloudVolumetrics` with the same shape. This makes the migration a near-mechanical arg swap, not a rewrite of the byte-locked 136-float packer.

`CloudVolumetrics` is the place to **formalize the currently-undeclared fields** (`cloudMultiDeck`, `cloudHighPrecision`, `cloudSpecies*`) that today live only behind `globe as unknown as {…}` casts — giving them real typed, documented public homes on the collection.

### 1.3 Ownership + dispatch (the new control flow)

```
CloudCollection (Scene primitive, backend-agnostic)
  ├── .volumetric : CloudVolumetrics   (opt-in config; .enabled=false default)
  ├── .cloudType  : CloudType          (collection-level genus, WebGPU-only)
  └── update(frameState):
        removeClouds()
        fr = context.getFeatureRenderer(CLOUD_COLLECTION)   // WebGPU only
        if (fr):
            fr.update(this, frameState)          // existing billboard/cumulus FR
            if (this.volumetric.enabled):
                context.requestVolumetricClouds(this._resolveVolumetricConfig())  // NEW publish
            return
        // WebGL: billboard path unchanged; volumetric flags are silent no-ops
        ...legacy billboard render...
```

- **Publish, don't render.** When volumetric is enabled and the WebGPU CLOUD_COLLECTION FR is present, `update()` publishes a resolved `CloudVolumetrics` snapshot to a per-context registry via a new backend-neutral context method `requestVolumetricClouds(config)` (a thin setter on `GraphicsContext`; WebGL's impl is a no-op, so scene code never branches on backend). This respects Principle 2 — scene code never imports `Renderer/WebGPU/` nor checks `isWebGPU`.
- **Env-effects consumes the request.** `executeEnvironmentalEffects` reads the published request(s) from the context instead of `globe.showProceduralClouds`. It resolves a **single primary volumetric deck** for the first cut (see §7 open question on multi-deck) and drives the existing `PROCEDURAL_CLOUDS` FR `execute(...)` with that config as the last arg. `publishCloudIblCoverage` reads the same resolved config every frame (unconditional, resets to 0 when no deck is active — preserving the byte-identical IBL invariant).
- **`globe.showProceduralClouds` becomes a deprecated alias.** When set, the globe (or scene) synthesizes a `CloudVolumetrics` from its existing `globe.cloud*` fields and publishes it through the *same* `requestVolumetricClouds` path — but only if no `CloudCollection` has claimed the primary deck this frame (collection wins; single authoritative gate; no double-dispatch).

### 1.4 Reuse — build OFF, don't fork

- **Billboard path** (WebGL `update()` + WebGPU `CLOUD_COLLECTION` FR / `WebGPUCloudRenderer`) is untouched and remains the always-on base. Volumetric is *additive* on top of the same collection.
- **Noise bake** (`buildCloudNoiseResources`, device-level 128³+32³) stays **shared/device-level** — no per-collection duplication.
- **Genera** (`CloudType` + `CloudTypeProfile`) is already the shared vocabulary; the collection's `cloudType` feeds the same profile lookup the globe path used.
- **Exotics** (E1 species, E2 mammatus/asperitas/fluctus/arcus/virga) are all uniform-driven density-shaping modes → map cleanly to WebGPU-only `CloudVolumetrics` flags. **E3** (noctilucent/nacreous new decks, contrails, pyrocumulus) needs new deck infra regardless — out of scope for unification, tracked separately (CLOUD-EXOTIC-E3-SPECIAL, NEXT_QUEUE_CAMPAIGN5 #23).
- **Weather map / provider** already self-contained inside the renderer (256×128 texture producer) → sourced from collection config.
- **Cache** (`context._cloudCache`) stays a **per-context singleton primary deck** for the first cut. Per-collection caches (multi-deck) are deferred (§7).

### 1.5 Per-cloud vs per-collection genus

The volumetric march is a **single planet-origin shell** driven by scalars; there is **no per-instance march path**. So the volumetric authority is **per-collection** (`collection.cloudType` / `collection.volumetric`), not per-`CumulusCloud`. Per-cloud `CumulusCloud.cloudType` storage is still worth adding (it is the cleanest per-cloud seam and formalizes the dropped `add({cloudType})` value), but it is **decoupled** from volumetric driving in this design: it is stored + dirty-tracked for future per-cloud billboard-shape / per-instance work, not wired into the raymarch. This avoids the instance-stride coupling risk while honoring the "stop dropping the genus" intent.

---

## 2. API Design (exact new / changed public surface)

### 2.1 `CloudVolumetrics` (new class, `Scene/CloudVolumetrics.js`)

Plain data holder; all fields public, all default to the parity/off values. `enabled` defaults `false`. Field names mirror the existing `globe.cloud*` set verbatim (so the renderer reads are unchanged). Formalizes the three currently-cast-only fields (`cloudMultiDeck`, `cloudHighPrecision`, `cloudSpecies*`). Constructed lazily by `CloudCollection` and exposed as `collection.volumetric`.

### 2.2 `CloudCollection` additions

```
new CloudCollection({
  // ...existing: show, noiseDetail, noiseOffset, debugBillboards, debugEllipsoids...
  enableVolumetric: false,        // NEW — WebGPU-only master opt-in (default false)
  cloudType: CloudType.CUMULUS,   // NEW — collection-level genus (WebGPU volumetric only)
  volumetric: { /* CloudVolumetrics overrides */ },  // NEW — optional config bag
})
```

New public members (each JSDoc'd with the Scene.js no-op template — see §3):
- `collection.enableVolumetric : boolean` — master gate. Getter/setter; plain store. **WebGPU only; no effect on WebGL.** `@default false`.
- `collection.volumetric : CloudVolumetrics` — lazily-created config object carrying every WebGPU-only dial (coverage/density/layers/wind/quality/shadows/IBL/weather-map/exotics). Mutating it when volumetric is off is a no-op on output.
- `collection.cloudType : CloudType` — collection-level genus selecting the altitude deck + `CloudTypeProfile`. **WebGPU volumetric only.** `@default CloudType.CUMULUS`.

`add()` is unchanged in signature; it continues to accept `options.cloudType` (still validated). See §2.3 for where that now lands.

### 2.3 `CumulusCloud` additions (per-cloud genus storage)

- New private `_cloudType` (default `CloudType.CUMULUS`), stored from `options.cloudType` in the ctor (stop dropping it).
- New public getter/setter `cloudType` — dirty-guarded via `makeDirty(this, CLOUD_TYPE_INDEX)`.
- New static dirty index `CLOUD_TYPE_INDEX = 7`; bump `NUMBER_OF_PROPERTIES` from 7 to 8. (`_consumeDirtyState`'s generic loop already covers the new slot.)
- **Not** wired into the WebGPU 68-byte instance buffer nor the WebGL vertex writers in this design (billboard render ignores genus, as today). Stored for future per-cloud work; keeps instance stride untouched (avoids the stride-coupling risk).

### 2.4 `GraphicsContext` addition (backend-neutral publish seam)

- `context.requestVolumetricClouds(config)` — records the frame's volumetric request. **WebGL Context.js: no-op** (default impl on the abstract base returns immediately). WebGPUContext override stores it for the env-effects consumer. Scene code calls it unconditionally → no `isWebGPU` branch (Principle 2 compliant). Optionally paired with `context.consumeVolumetricCloudRequest()` used internally by env-effects.

### 2.5 Deprecations

- `globe.showProceduralClouds` and the `globe.cloud*` family: **kept working**, marked `@deprecated — use CloudCollection.enableVolumetric / .volumetric`. They forward into the same `requestVolumetricClouds` path (globe synthesizes a `CloudVolumetrics`). No removal.

---

## 3. Flag Design (opt-in, default-off, WebGL-graceful-no-op)

Follows the established fork convention (Scene.js `enableSSR`/`enableNPROutlines`/`enableContactShadows`; Globe.js `showProceduralClouds` + cloud family; FORK_OVERVIEW principle 10).

**Master enable:** `CloudCollection.enableVolumetric = false`. Plain get/set that only stores; **never throws, never checks backend.** WebGL simply never reads it → silent documented no-op. JSDoc template verbatim:
> `When true and using the WebGPU renderer, the collection additionally renders a volumetric ray-marched cloud deck. Has no effect on the WebGL path. @default false @example // (WebGPU only)`

**WebGPU-only expanded flags** (all on `collection.volumetric` / `collection.cloudType`, all default to parity/off, all no-op on WebGL):
- **Shell/coverage/wind:** `cloudCoverage`, `cloudLayerBottom`, `cloudLayerTop`, `cloudDensity`, `cloudWindSpeed`, `cloudWindDirection`.
- **Quality:** `cloudQuality`, `cloudVolumetricQuality` ("auto" preset resolve).
- **Genera (WMO):** `collection.cloudType` (0..10) → `CloudTypeProfile` deck + density/lighting.
- **Weather:** `cloudWeatherMap`, `weatherProvider`, `cloudWeatherChannelStrength`.
- **Shadows/IBL:** `cloudCastShadows`, `cloudContributesIBL` — GPU-resource flags: when off, consumers read the existing 1×1-white placeholder → byte-identical.
- **Exotic types (E1/E2):** `cloudMammatus{Strength,Scale,Depth}` (E2, already shipped uniform slots 128-131), `cloudSpecies`/`cloudSpeciesMode`/`cloudSpecies{Strength,Scale,Param}` (E1, slots 132-135), plus the remaining E2 modes (asperitas, fluctus, arcus, virga) as they land. Each a WebGPU-only density-shaping mode, default neutral.
- **Precision/decks:** `cloudHighPrecision` (RTE camera split, slots 120-127), `cloudMultiDeck`.

**Enforcement mechanics (unchanged from charter):**
- UBO growth **add-only**; no new floats emitted when an enable bit is 0. The 136-float `CloudUniforms` layout is preserved verbatim — config *source* changes, layout does not.
- `ShaderDefine` / `qualityFlags` bits are add-only, contiguous, never renumbered; new exotic bits appended.
- WGSL gating via `//>>ifdef` with the default-0 branch emitting historical byte-identical code.
- Off-parity probes under `Tools/visual-regression` must be unchanged with all flags off.

**WebGL setting a WebGPU-only flag:** stores the value, renders nothing extra, no console error. Verified by the webgl-only variant smoke test (`Tools/variant-smoke-test.mjs`, zero console.error) and the off==identical probes.

---

## 4. Backward Compatibility

1. **Existing billboard usage unchanged.** `new CloudCollection()` + `add({position, scale, maximumSize, slice, color, brightness})` renders the exact same cumulus puffs on both backends. No new required options; all additions are optional and default to off/parity. `add({cloudType})` behavior is *strictly better* (now stored, still validated) but visually identical on the billboard path (genus still ignored there).
2. **Byte-identical when off.** `enableVolumetric=false` (default) means `update()` never calls `requestVolumetricClouds`, env-effects finds no collection request, and — unless `globe.showProceduralClouds` is set — publishes coverage 0 (unchanged IBL). No new UBO floats, no new bind entries exercised. Existing `probe-volcloud-toggle.mjs` / `probe-cloud-*-flagon.mjs` / `probe-scene-capture-off.mjs` must stay green.
3. **WebGL unaffected.** WebGL registers no `CLOUD_COLLECTION`/`PROCEDURAL_CLOUDS` FR; `getFeatureRenderer` returns undefined; the legacy billboard path runs; `requestVolumetricClouds` is a base-class no-op. WebGPU-only flags are inert stores. The webgl-only build variant stubs the WebGPU modules and is never reached behind the `if (fr)` guard.
4. **`globe.showProceduralClouds` keeps working** as a deprecated alias routed through the same publish path — existing globe-driven volumetric scenes render identically until users migrate.
5. **Add-only dirty index + UBO.** `NUMBER_OF_PROPERTIES` 7→8 and any new `CloudUniforms` fields are append-only; existing packers/strides untouched (per-cloud `_cloudType` deliberately not added to the 68-byte instance record).

---

## 5. Increment Split (cheapest-first, nothing visual until late)

| # | Slice | Visual change? | Rationale |
|---|-------|----------------|-----------|
| 1 | **API scaffold** — `CloudVolumetrics` class + `CloudRenderMode` enum + `CloudCollection.renderMode` / `.volumetric` / `.cloudType` (stores only; `enableVolumetric` convenience alias flips `renderMode`) + `CumulusCloud.cloudType` (index 7, `NUMBER_OF_PROPERTIES` 7→8) + `context.requestVolumetricClouds` no-op base + WebGPU store / `consumeVolumetricCloudRequest`. **LANDED (CLOUD-U1-API-SCAFFOLD)** — probe `Tools/visual-regression/probe-cloud-u1-scaffold.mjs` proves BILLBOARD-mode + flags-off byte-identical on both backends. | **None** — pure additive stores | Zero-risk surface; unblocks everything |
| 2 | **Config indirection in renderer** — `executeProceduralClouds` + `publishCloudIblCoverage` take a structurally-typed `config` arg; legacy call still passes `globe` (identical field names) | **None** | Decouples renderer from globe with no behavior change |
| 3 | **Publish + consume wiring** — `CloudCollection.update()` publishes resolved config when `enableVolumetric` && FR present; env-effects consumes the request (single primary deck) instead of only reading globe | **Yes (opt-in)** — a volumetric CloudCollection now renders a deck | First user-facing capability; globe path still works |
| 4 | **Globe alias** — migrate `globe.showProceduralClouds` to synthesize a `CloudVolumetrics` and publish through the same path; deprecate; single authoritative gate (collection wins) | **None** for existing globe scenes | Removes dual-owner hazard; one dispatch site |
| 5 | **Genera** — `collection.cloudType` feeds `CloudTypeProfile` deck/profile | Yes (opt-in) | Reuses shared genus vocabulary |
| 6 | **Weather map / provider** flags on collection config | Yes (opt-in) | Self-contained weather texture path |
| 7 | **Exotic E1/E2** flags on collection config (mammatus/species + remaining E2 modes) | Yes (opt-in) | Uniform-driven density shaping; E3 excluded |
| 8 | **Docs + inventory + probes** — deprecation notes, FEATURE_INVENTORY moves, Sandcastle demo, off-identical probe additions | None | Keep docs load-bearing |

Slices 1-2 change nothing visually (pure plumbing). Slice 3 is the first opt-in capability. Slice 4 closes the dual-ownership gap. 5-7 layer WebGPU-only expansion. 8 documents.

---

## 6. Tasks

See `tasks` array in the structured output.

---

## 7. Open Questions (need user decision)

1. **Per-collection vs single primary volumetric deck.** The march + `context._cloudCache` is a per-context singleton (one planet-origin shell). Multiple simultaneous volumetric `CloudCollection`s would each need their own cache/pipelines/half-res/temporal/shadow targets (real VRAM + encoder cost) and real bounding volumes (the shell cull assumes one planet-wide deck). **Proposal:** first cut supports one primary volumetric deck (first enabled collection wins; others' volumetric flags are inert). Multi-deck is a follow-up. OK?
2. **Deprecate `globe.showProceduralClouds` or keep it co-equal?** Design keeps it working as a forwarding alias. Do you want an explicit `@deprecated` tag + console warn-once, or silent forwarding with only a doc note?
3. **Per-cloud genus march.** There is no per-`CumulusCloud` volumetric path today (much larger lift). This design stores `CumulusCloud.cloudType` but drives volumetric per-collection. Confirm per-collection is the intended granularity (vs. a future per-cloud march).
4. **Where does the collection sit spatially?** Volumetric is a planet-wide shell today. Should a `CloudCollection`'s volumetric deck be planet-wide (globe-like) or eventually localized to the collection's clouds' bounds? (Ties to Q1.)
5. **`CloudVolumetrics` as class vs. flattening onto `CloudCollection`.** Proposed a nested `.volumetric` config object (formalizes the ~40 dials + 3 undeclared fields cleanly). Alternative is ~40 flat `collection.cloud*` properties mirroring globe. Nested is cleaner; flat mirrors globe 1:1. Preference?
