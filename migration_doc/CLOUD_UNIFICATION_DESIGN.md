# Cloud Unification Design — Drive Volumetric Clouds THROUGH CloudCollection

**STATUS: SHIPPED (2026-07-05).** All 8 slices landed (Batches 617–625 + the U8 close-out). The WebGPU volumetric cloud deck is now driven THROUGH `CloudCollection` via the exclusive `renderMode` (`BILLBOARD` default / `VOLUMETRIC`) + the `.volumetric` {@link CloudVolumetrics} config + collection-level `.cloudType`. The legacy `globe.showProceduralClouds` / `globe.cloud*` / `globe.weatherProvider` surface was **removed** (not aliased) in slice 4B; `globe.defaultCloudCollection` is the single cloud authority. WebGPU-only expanded flags (genera, weather, exotic E1/E2/E3) default off, are byte-identical when off, and are documented no-ops on WebGL. Off-identity + WebGL-no-op are guarded by `Tools/visual-regression/probe-cloud-u8-offident.mjs` (both backends GREEN: WebGL billboard hash 455912924 / WebGPU 2372594303, before==after with the entire flag surface populated in BILLBOARD mode; VOLUMETRIC-on-WebGL neither throws nor errors). Sections below are the as-built design of record; §2.5 is corrected to reflect the REMOVE decision.

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

### 2.5 Removal (as built — supersedes the original "deprecate + alias" plan)

- `globe.showProceduralClouds`, the ~49 `globe.cloud*` field family, and `globe.weatherProvider` were **REMOVED** (user-decided REMOVE-not-alias, slice 4B, 2026-07-05) — not kept as deprecated aliases. `globe.defaultCloudCollection` (a managed, config-only `CloudCollection` created in the `Globe` ctor) is the single cloud authority; its exclusive `renderMode === VOLUMETRIC` is the only activation gate. Every former globe consumer (env-effects, post-frustum snapshot gate, god-ray gate, volumetric-fog cloud-shadow, atmospheric-effects genus/weather) was re-homed onto the collection. The `AtmosphericConditions.clouds.*` facade proxies onto `defaultCloudCollection.volumetric` / `.cloudType` / `.renderMode` (the `enableVolumetric` alias flips the exclusive `renderMode`), so user-facing scene code that went through the atmospherics facade is unaffected.

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
| 2 | **Config indirection in renderer** — `executeProceduralClouds` + `publishCloudIblCoverage` take a structurally-typed `CloudVolumetricsConfig` arg (new ambient interface in `cesium-js-types.d.ts`) instead of `CesiumGlobe`; legacy call still passes `globe` (identical field names). **LANDED (CLOUD-U2-CONFIG-INDIRECTION)** — probe `Tools/visual-regression/probe-cloud-u2-config.mjs` proves the WebGPU cloud render (ON + OFF paths) is byte-identical before vs after (onHash 1222644883 / offHash 949509334, HEAD == change); WebGL untouched. | **None** | Decouples renderer from globe with no behavior change |
| 3 | **Publish + consume wiring** — `CloudCollection.update()` publishes resolved config (`_resolveVolumetricConfig` → `showProceduralClouds:true` + the CloudVolumetrics dials) via `context.requestVolumetricClouds` when shown && `renderMode===VOLUMETRIC` && `volumetric.enabled`, and the CLOUD_COLLECTION FR suppresses that collection's own billboards (exclusive toggle); env-effects `consumeVolumetricCloudRequest`s and drives the single primary deck (collection wins over `globe.showProceduralClouds`, which still works). **LANDED (CLOUD-U3-PUBLISH-CONSUME-TOGGLE)** — probe `Tools/visual-regression/probe-cloud-u3-toggle.mjs` (standing guard) proves: WebGPU deck renders + publishes `enabled/showProceduralClouds=true` with billboards suppressed; WebGL billboards-only (no publish); BILLBOARD byte-identical to HEAD (webgl 1856340617 / webgpu 3595144265, before==after); and the CRITICAL `show=false` case cedes the deck (reqCount===0). | **Yes (opt-in)** — a volumetric CloudCollection now renders a deck | First user-facing capability; globe path still works |
| 4 | **Globe alias** — migrate `globe.showProceduralClouds` to synthesize a `CloudVolumetrics` and publish through the same path; deprecate; single authoritative gate (collection wins) | **None** for existing globe scenes | Removes dual-owner hazard; one dispatch site |
| 5 | **Genera** — `collection.cloudType` feeds `CloudTypeProfile` deck/profile | Yes (opt-in) | Reuses shared genus vocabulary |
| 6 | **Weather map / provider** flags on collection config | Yes (opt-in) | Self-contained weather texture path |
| 7 | **Exotic E1/E2** flags on collection config (mammatus/species + remaining E2 modes). **PREMISE-STALE (CLOUD-U7-EXOTIC-E1-E2)** — already exposed on `collection.volumetric` + wired to slots 128–139 by prior slices; probe `Tools/visual-regression/probe-cloud-exotic-flags.mjs` GREEN (see §5 note). | Yes (opt-in) | Uniform-driven density shaping; E3 excluded |
| 8 | **Docs + inventory + probes** — status/removal reconcile (this doc §2.5 + top banner), FEATURE_INVENTORY + FORK_OVERVIEW moved onto the `CloudCollection.renderMode` / `.volumetric` / `.cloudType` API, Sandcastle demos already migrated in 4B, and a dedicated off-identical close-out probe. **LANDED (CLOUD-U8-DOCS-DEMO-PROBES)** — probe `Tools/visual-regression/probe-cloud-u8-offident.mjs` (standing guard) proves on BOTH backends: (A) BILLBOARD-mode byte-identity with the ENTIRE expanded WebGPU-only flag surface populated (WebGL 455912924 / WebGPU 2372594303, base==flags), (B) WebGL no-op — `renderMode=VOLUMETRIC` + every flag neither throws nor emits a console error. | None | Keep docs load-bearing |

Slices 1-2 change nothing visually (pure plumbing). Slice 3 is the first opt-in capability. Slice 4 closes the dual-ownership gap. 5-7 layer WebGPU-only expansion. 8 documents.

**Slice 4A LANDED (CLOUD-U4A-SCENE-DEFAULT-COLLECTION, Option A, user-decided 2026-07-05).** Adds a Scene/Globe-owned MANAGED default volumetric-capable `CloudCollection` (`scene.globe.defaultCloudCollection`, created in the `Globe` ctor, config-only — never added to the scene primitives) and RE-HOMES the four config producers onto its `.volumetric` `CloudVolumetrics` + collection-level `cloudType`:

1. `scene.globe.atmosphericConditions.clouds.*` (the user cloud facade in `AtmosphericConditions.buildClouds` + the `weather.cloudCover`/wind proxies in `buildWeather`) now proxy onto `defaultCloudCollection.volumetric` / `.cloudType` / `.renderMode` (the `enableProcedural`/`enableVolumetric` aliases flip the exclusive `renderMode` BILLBOARD⇄VOLUMETRIC + set `volumetric.enabled`). Two new proxies (`clouds.weatherMap`, `clouds.weatherProvider`) attach the weather ingest to the collection.
2. `AtmosphericEffects.applyAtmosphericConditions` genus bias writes `defaultCloudCollection.cloudType` (was `globe.cloudType`).
3. The weather-ingest present-weather read (`applyWeatherIngestToScene`) prefers `defaultCloudCollection.volumetric.weatherProvider`, falling back to `globe.weatherProvider`.
4. The `scene.godRayCloudAware` gate (`WebGPUPostProcessStageCollection`) reads `defaultCloudCollection.renderMode === VOLUMETRIC` (OR the legacy `globe.showProceduralClouds`).

`WebGPUSceneRendererEnvironmentalEffects` consumes the managed collection as the volumetric-deck source of truth: when no USER collection published a request, it falls back to `defaultCloudCollection._resolveVolumetricConfig()` iff its `renderMode===VOLUMETRIC && volumetric.enabled`, else the legacy `globe.showProceduralClouds` path (cloudConfig===globe) stands byte-identically. `_resolveVolumetricConfig()` now folds in the collection-level `cloudType` (default `CUMULUS`, which the renderer's `?? CUMULUS` resolves identically to the historical `undefined`). The managed collection's `.volumetric` defaults are byte-equal to the historical `globe.cloud*` defaults, so a default scene (renderMode BILLBOARD) publishes nothing and is byte-identical on BOTH backends (verified: U3 deterministic `empty`/`billboard` hashes reproduce the slice-3 HEAD values exactly; probe `Tools/visual-regression/probe-cloud-u4a-managed.mjs` is the STANDING guard). `globe.cloud*`/`globe.showProceduralClouds`/`globe.weatherProvider` are NOT removed yet — that is slice 4B, which must also re-home the two remaining direct globe consumers still reading `globe.showProceduralClouds`: `WebGPUVolumetricFogRenderer` (cloud-shadow interaction, ~L950) and the `WebGPUProceduralCloudRenderer` module docstring.

**Slice 4B LANDED (CLOUD-U4B-REMOVE-GLOBE-SURFACE, user-decided REMOVE-not-alias, 2026-07-05).** The `Globe` cloud surface is GONE: `globe.showProceduralClouds` + the ~49 `globe.cloud*` field family + `globe.weatherProvider` were deleted from `Globe.js` (ctor block + the dead `tileProvider.cloud*` passthrough) and from the `CesiumGlobe` interface in `cesium-js-types.d.ts`. The managed `globe.defaultCloudCollection` is now the SINGLE cloud authority; its exclusive `renderMode` (VOLUMETRIC === 1) is the only activation gate. Every remaining direct globe consumer was re-homed onto the collection: `WebGPUSceneRendererEnvironmentalEffects` (no-deck ⇒ `cloudConfig === undefined`, no legacy `globe.showProceduralClouds` branch), `WebGPUSceneRendererPostFrustumChain` (snapshot-copy gate), `WebGPUPostProcessStageCollection` (god-ray gate), `WebGPUVolumetricFogRenderer` (cloud-shadow config reads `defaultCloudCollection.volumetric` + `renderMode`), and `AtmosphericEffects` (genus bias + present-weather read drop their `globe.*` fallbacks). `AtmosphericEffects` now always writes the collection genus (the `else globe.cloudType` dead branch is gone). A new `CloudCollection.enableVolumetric` get/set (design §2.2) is the clean master-gate migration target. All ~55 cloud/weather probes + 10 Sandcastle demos were migrated off `globe.cloud*`/`showProceduralClouds` onto `defaultCloudCollection.enableVolumetric` / `.volumetric.cloud*` / `.cloudType` (genus → collection-level). Verified: `probe-cloud-u3-toggle` reproduces the exact HEAD hashes (WebGL billboard 1856340617 / WebGPU 3595144265 / empty 2798422854 — byte-identical off-gate, WebGL unaffected) and `probe-cloud-u4a-managed` PASSES (facade-driven deck renders, `mismatchPct 0.000`, zero errors). Grep-clean: no `globe.cloud*`/`showProceduralClouds`/`globe.weatherProvider` code symbols remain.

**Slice 5 PREMISE-STALE / already satisfied (CLOUD-U5-GENERA, verified 2026-07-05).** The genera wiring (`collection.cloudType` → `CloudTypeProfile` deck/profile into the published config) was already complete by slice 4B: `CloudCollection.cloudType` get/set (slice 1, validated, default `CUMULUS`) + `_resolveVolumetricConfig` folding `cloudType: this.volumetric.cloudType ?? this._cloudType` (slice 4A) + the renderer's `CloudTypeProfile.get(config.cloudType ?? CUMULUS)` profile packing (shape@101 / densityScale@102 / extinction@103 / anvilBias@104, Batch 408). No new code needed. Standing regression probe `Tools/visual-regression/probe-cloud-genus.mjs` drives `defaultCloudCollection.cloudType` and PASSES GREEN: CUMULUS==default byte-identical (whole-frame diff 0), CIRRUS deck 5.66% vs CUMULUS 15.23% (thinner), CUMULONIMBUS/STRATUS distinct, 0 device errors.

**Slice 6 PREMISE-STALE / already satisfied (CLOUD-U6-WEATHER-FLAGS, verified 2026-07-05).** The three weather dials (`cloudWeatherMap`, `weatherProvider`, `cloudWeatherChannelStrength`) were already fully exposed through the collection config by slice 4B: they live on `CloudVolumetrics` (`collection.volumetric`, committed), reach the raymarcher purely through `_resolveVolumetricConfig()`'s `...this.volumetric` spread (published via `context.requestVolumetricClouds`, consumed by `WebGPUSceneRendererEnvironmentalEffects` → `WebGPUProceduralCloudRenderer`, which reads `config.cloudWeatherMap` / `config.weatherProvider` / `config.cloudWeatherChannelStrength`), and are typed on `CloudVolumetricsConfig` in `cesium-js-types.d.ts`. The `AtmosphericConditions.clouds.weatherMap` / `.weatherProvider` facade proxies already route onto `defaultCloudCollection.volumetric`. No new code needed. Existing standing probes `probe-weather-map.mjs` (drives `volumetric.cloudWeatherMap`) and `probe-weather-channels.mjs` (drives `volumetric.weatherProvider` + `.cloudWeatherChannelStrength`) already exercise the collection path. New dedicated regression probe `Tools/visual-regression/probe-cloud-weather-flags.mjs` PASSES GREEN: BILLBOARD-mode weather flag inert (off vs weatherOn diff 0 — byte-identical off-gate), VOLUMETRIC weather-off deterministic (diff 0), `volumetric.cloudWeatherMap=true` through the collection carves the deck (diff 22.9), 0 device errors. The weather map is a self-contained 256×128 producer always bound (its own pre-existing infrastructure); `weatherMapEnabled=0` reproduces today's pixels when the flag is off. WebGL: the flags are inert stores (no volumetric FR) — documented no-op.

**Slice 7 PREMISE-STALE / already satisfied (CLOUD-U7-EXOTIC-E1-E2, verified 2026-07-05).** The exotic E1/E2 density-shaping dials were already fully exposed through the collection config by slice 4B + the E1/E2/E3 exotic batches (610–612): they live on `CloudVolumetrics` (`collection.volumetric`, committed slice 1) as `cloudMammatus{Strength,Scale,Depth}` (E2, UBO slots 128–131), `cloudSpecies`/`cloudSpecies{Mode,Strength,Scale,Param}` (E1, slots 132–135), and `cloudFeature`/`cloudFeature{Mode,Strength,Scale,Param}` (E2 remaining asperitas/fluctus/arcus/virga, slots 136–139). They reach the raymarcher purely through `_resolveVolumetricConfig()`'s `...this.volumetric` spread (published via `context.requestVolumetricClouds`, consumed by `WebGPUSceneRendererEnvironmentalEffects` → `WebGPUProceduralCloudRenderer`, which packs `config.cloudMammatus*` / `config.cloudSpecies*` / `config.cloudFeature*` into slots 128–139), and the WGSL `ProceduralClouds.wgsl` `mammatusFactor()` / `speciesFactor()` / `featureFactor()` consume them, each early-returning 1.0 when its mode/strength is 0 (default) → byte-identical off. The name→mode maps live in the packer (`lenticularis`→1, `fibratus`/`uncinus`→2; `asperitas`→1, `fluctus`→2, `arcus`→3, `virga`→4). No new code needed. New dedicated regression probe `Tools/visual-regression/probe-cloud-exotic-flags.mjs` PASSES GREEN: BILLBOARD-mode exotic flags inert (off vs exoticOn diff 0 — byte-identical off-gate), VOLUMETRIC exotics-off deterministic (diff 0), and all three groups drive the deck through the collection — `volumetric.cloudMammatusStrength` (diff 0.79, underside-only so subtlest), `volumetric.cloudSpecies="lenticularis"` (diff 7.19, dramatic lens reshaping), `volumetric.cloudFeature="asperitas"` (diff 1.51) — 0 device errors. The UBO layout is add-only and unchanged (slots 140–143 hold the excluded E3 special-shade fields, batch 612). WebGL: the flags are inert stores (no volumetric FR) — documented no-op. E3 new-decks (noctilucent/nacreous/contrails/pyrocumulus) remain out of scope (needs new deck infra; tracked CLOUD-EXOTIC-E3-SPECIAL).

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
