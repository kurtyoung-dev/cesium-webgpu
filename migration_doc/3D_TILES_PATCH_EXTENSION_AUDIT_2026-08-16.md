# 3D Tiles Patch & Invalidation Extension — Heavy Design Audit (2026-08-16)

**Target:** [3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md](3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md) (2,310 lines, landed Batch 1024; co-authored by the maintainer and the Codex Sol 5.6 lane).
**Method:** maintainer-directed heavy review; 17-agent workflow (wf_2008aec5-533): eight independent dimension reviewers (prior-art + citation-integrity with live web verification; protocol correctness; security threat model; format/codec correctness; fork implementability + cross-doc consistency; optimizer + performance-target soundness; spec-editorial + internal consistency), one adversarial verifier per dimension instructed to REFUTE against the doc text and primary sources, then a synthesis. 64 findings raised, 3 refuted, 61 surviving. The workflow was interrupted by a session limit on 2026-08-15 with 13/17 agents complete and resumed from its journal cache on 2026-08-16 (reviewer findings and five verifier verdicts replayed byte-identical; the remaining three verifiers and the synthesis ran live).
**Status:** findings are PROPOSALS for the design doc's authors; nothing in the target doc has been edited by this audit. Decisions in §5 below await maintainer rulings.

---
# Verified Audit — `migration_doc/3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md`

Audit date 2026-08-15/16. Eight dimensions (prior-art, citations, protocol, security, codecs, fork-fit, optimizer, editorial). 64 findings raised, 3 refuted by the verifier and removed, **61 surviving**: 3 CRITICAL, 19 MAJOR, 31 MINOR, 8 EDITORIAL; 45 CONFIRMED, 16 PLAUSIBLE, 0 UNVERIFIED. Five findings were raised independently by two dimensions and are cross-tagged below.

## 1. Verdict

The design is sound in its architecture and unusually careful in its identity model, canonicalization discipline, and content-addressing story; the verifier confirmed no misattributed citation across all 33 references and confirmed the survey's central negative — no registered 3D Tiles or glTF extension provides base-relative patching with immutable head/state, atomic multi-resource activation, retention/GC, and an optimizer. **The bounded novelty claim survives adversarial search.** It does so with a weaker survey record than the claim deserves: the spec steward's own on-point work (3d-tiles issue #102 and the June-2025 Cesium roadmap promising incremental single-tileset updates with change history), the published-but-unregistered `3DTiles_temporal` versioning extension, 3D Tiles tile expiration, MPEG-SD's RFC 6902 JSON-Patch update mechanism, the OGC Testbed-15 Delta Updates ER (19-012r1), and a zero-new-codec core-glTF construction (sparse accessor over a shared external `.bin`) are all absent. None of these overturns the claim; together they narrow it and identify a real convergence risk with a future `3DTILES_time_dynamic`.

Where the document is weak is not in what it proposes but in what it leaves un-nailed at the boundaries: (i) **freshness/anti-rollback** — the head is unsigned, no staleness bound or persisted client watermark is mandated, so the "current"/revocation guarantees are not achievable against a stale-serving CDN; (ii) **the hint plane's fail-closed laws** — the event-identity projection binds epoch+sequence, so a legitimate epoch reset can be indistinguishable from a publisher conflict, and unauthenticated hints can drive undefined "fail closed" states; (iii) **the optimizer's economics** — as written, `futureDebt` charges every patch the full mandated rebuild with no amortization and no explicit time-to-current term, so it is unclear a patch can ever win against decision 14; (iv) **fork fit** — the atomic multi-tile / terrain-plus-imagery swap, a scene-level state coordinator, revision-pinned imagery, a shared patch-budget governor, and a producer/head-server harness are all prerequisites the repo lacks and §3.3/§15 never name; and (v) **MVP scope** — 2.2 declares one operation, but 5.5 `replaceContent`, multi-component states, in-state fallbacks, and the producer scheduler are required by 12.1, 17.1, and the scenarios with no phase assignment. Every one of these is fixable within the current architecture; none requires abandoning the design.

## 2. Ranked Findings

| # | Sev | Verdict | Dim | Title | Lines |
|---|---|---|---|---|---|
| 1 | CRITICAL | CONFIRMED | security | No freshness/anti-rollback root of trust: stale-pinning CDN defeats currentness and revocation | 615-633, 972-979, 1969, 1975-1987 |
| 2 | CRITICAL | PLAUSIBLE | protocol | Epoch reset makes legitimate hint replay a mandated fail-closed publisher conflict | 75-77, 599, 651, 924, 959-971, 986-988 |
| 3 | CRITICAL | PLAUSIBLE | optimizer | Cost model structurally cannot prefer patch-first: `futureDebt` dominates, latency benefit has no term | 1583, 1604-1624, 78-81, 2220-2221 |
| 4 | MAJOR | CONFIRMED | security | Revocation-incapable clients fail OPEN: rejecting the state retains and displays revoked content | 766-768, 789-790, 1855-1858, 2224-2225 |
| 5 | MAJOR | CONFIRMED | protocol | Retention anchored to undefined quantities; no reader lease or client revalidation cadence | 606, 856-866, 879, 1059-1066, 2114-2115 |
| 6 | MAJOR | CONFIRMED | protocol | Stale-base fallback entrypoint has no GC root, freshness rule, or mutable-pointer law | 133, 1062-1064, 1070-1074, 1843-1848 |
| 7 | MAJOR | CONFIRMED | fork-fit | Atomic activation has no engine owner: no multi-tile or terrain+imagery swap exists in this fork | 749-756, 1448-1454, 1793-1803, 405-434 |
| 8 | MAJOR | CONFIRMED | fork-fit | §15 plan not executable as written: producer/server harness is never a deliverable | 2019-2040, 2042-2061, 2063-2085 |
| 9 | MAJOR | CONFIRMED | optimizer | 9.3 cost vector is dimensionally and aggregation-level incoherent | 1565-1632 |
| 10 | MAJOR | CONFIRMED | optimizer | 9.4 defects: upper/lower-bound mismatch, undefined `patchAdmissionRatio`, wrong maintenance terminal | 1669-1710, 1729-1739, 1546, 1880-1884 |
| 11 | MAJOR | CONFIRMED | codecs | 8.1 extremum rule is over-broad, self-contradictory, and disqualifies the north-star edit | 1408-1418, 16-17, 2044 |
| 12 | MAJOR | CONFIRMED | editorial | `replaceContent` is load-bearing but excluded from the MVP scope it serves | 125, 1209-1255, 1933, 2055, 2159 |
| 13 | MAJOR | CONFIRMED | editorial | Conformance matrix and body impose an MVP far larger than 2.2 enumerates | 118-136, 662-731, 2163-2167, 2200-2217 |
| 14 | MAJOR | CONFIRMED | editorial | §16 lists as open four decisions the body already answers normatively | 2091-2101, 807-824, 1194, 2172 |
| 15 | MAJOR | CONFIRMED | prior-art | Survey misses CesiumGS's own incremental-update direction (issue #102, 2025 roadmap) | 152-217, 204-208, 2283-2284 |
| 16 | MAJOR | CONFIRMED | prior-art | Survey omits `3DTiles_temporal`, an existing published 3D Tiles versioning extension | 154-169, 188, 210-217 |
| 17 | MAJOR | PLAUSIBLE | protocol | Client laws derive fail-closed split-brain decisions from unauthenticated hint content (dup: #18) | 396-398, 962-973, 1975-1980, 2136-2138 |
| 18 | MAJOR | PLAUSIBLE | security | Event identity keys are bare UUIDs with no trust-domain binding; hints can force fail-closed states (dup: #17) | 966-989, 991-1004, 1972 |
| 19 | MAJOR | PLAUSIBLE | fork-fit | §3.3 compatibility boundary omits every GPU-residency coupling (Phase 8, C18) | 405-434, 519-525, 856-867 |
| 20 | MAJOR | PLAUSIBLE | fork-fit | Replacement mini-tilesets have no unified memory budget or eviction story in the engine | 1170-1174, 1199-1206, 1828-1831, 866-867 |
| 21 | MAJOR | PLAUSIBLE | optimizer | 9.2 gates: economic gate misfiled, producer-unevaluable frontier gate, missing overlap gate | 1526-1559, 855-858, 807-819 |
| 22 | MAJOR | PLAUSIBLE | optimizer | 9.6 two-stage refinement never integrates with 9.4 and can flip a decision after the caller acts | 1638-1642, 1706-1710, 1743-1756 |
| 23 | MINOR | CONFIRMED | protocol | `stateDigest` over canonical form plus "rejected or normalized" weakens content addressing (dup: #30) | 587, 811, 826-831, 2169-2173 |
| 24 | MINOR | CONFIRMED | protocol | Signature profile signs the state but not the head, giving no freshness or rollback value | 973, 1969, 1975-1987 |
| 25 | MINOR | CONFIRMED | security | No digest-algorithm agility policy: downgrade to a weak hash unaddressed anywhere in the chain | 583-607, 1954-1973, 2097-2098 |
| 26 | MINOR | CONFIRMED | codecs | `sparseAttributeOverride` is undefined over Draco/meshopt-compressed base primitives | 1325-1347, 1272, 226 |
| 27 | MINOR | CONFIRMED | codecs | Dual value domains in the quantized-mesh payload break exact-output-digest determinism | 1420-1424, 812, 829-831 |
| 28 | MINOR | CONFIRMED | codecs | Cross-tile normal recomputation gap: edge-vertex normals need neighbor data | 1411, 1433-1435, 287-288 |
| 29 | MINOR | CONFIRMED | codecs | 8.3 operation ladder omits the height-stream/header-replacement rung that 8.1/8.2 select | 1437-1446, 1417, 1430-1431 |
| 30 | MINOR | PLAUSIBLE | security | "Rejected or normalized" canonicalization ambiguity creates digest/signature malleability (dup: #23) | 826-831, 1976-1977 |
| 31 | MINOR | CONFIRMED | codecs | Missed core-glTF construction: sparse accessor over a shared external buffer | 178, 194-197, 226, 241-244 |
| 32 | MINOR | CONFIRMED | fork-fit | Dual-backend parity obligation absent; existing dual-backend clipping infra unmentioned | 1795, 1199-1206, 405-434 |
| 33 | MINOR | CONFIRMED | fork-fit | Compatibility boundary omits classification and shadow-pass correctness for masked content | 1121-1125, 1596-1597, 2150-2156, 133 |
| 34 | MINOR | CONFIRMED | fork-fit | Layer B codec list crosses the 2.3 terrain boundary; no bootstrap for non-3D-Tiles deployments | 362-371, 135-136, 144-151, 890-901 |
| 35 | MINOR | CONFIRMED | fork-fit | Quantized-mesh height patch ignores client-side upsampled descendant meshes | 1404-1419, 1437-1446 |
| 36 | MINOR | CONFIRMED | editorial | Conformance matrix orphans in both directions | 952-957, 743-745, 836, 2174, 2220 |
| 37 | MINOR | CONFIRMED | editorial | `retire` used in three senses beyond its 4.4 definition (invalidationId half refuted) | 916, 71, 943-946, 1033, 1985, 932 |
| 38 | MINOR | CONFIRMED | editorial | No conformance-language declaration; 5.3 "should" items harden into matrix rejections | 1181-1197, 1160, 2152, 2172-2173 |
| 39 | MINOR | CONFIRMED | editorial | Missing spec apparatus: digest syntax, URI bases, media types, version fields | 584, 617, 638, 894, 1157, 773-775 |
| 40 | MINOR | CONFIRMED | editorial | Research conclusions 1 and 5 assert results ahead of the doc's own pending evidence | 2250, 2258-2260, 2014-2016, 2036-2037 |
| 41 | MINOR | CONFIRMED | prior-art | Survey table omits 3D Tiles tile expiration (`expireDuration`/`expireDate`) | 171-193, 410-411 |
| 42 | MINOR | CONFIRMED | prior-art | `MPEG_scene_dynamic` under-characterized: updates are RFC 6902 JSON Patch documents (dup: #56) | 179-180, 199-202 |
| 43 | MINOR | CONFIRMED | prior-art | Testbed-15 engagement covers the ChangeSet API ER but not the Delta Updates ER (19-012r1) | 185, 2292 |
| 44 | MINOR | CONFIRMED | prior-art | I3S row is tautological where an affirmative, verifiable statement is available | 191, 167-169 |
| 45 | MINOR | CONFIRMED | citations | Citation integrity summary: 33/33 resolve; zero misattributions (residual anchor/usage defects) | 2277-2310, 152-217 |
| 46 | MINOR | CONFIRMED | citations | I3S row's update-workflow claim is not supported by the cited source | 191, 2296 |
| 47 | MINOR | CONFIRMED | citations | CityGML reference anchor `#versioning` does not exist in the target document | 2294, 188 |
| 48 | MINOR | CONFIRMED | citations | Repo-relative snapshot-spike anchor slug will not resolve under GitHub slugging | 2307, 405-412 |
| 49 | MINOR | PLAUSIBLE | security | §13 limits are an unquantified checklist with codec gaps; limit-attack conformance item untestable | 1954-1973, 361-374, 2222-2223 |
| 50 | MINOR | PLAUSIBLE | codecs | `textureBlockReplace` ignores device-dependent Basis/KTX2 transcode targets | 1353-1365, 1297-1299 |
| 51 | MINOR | PLAUSIBLE | optimizer | Optimizer inputs require client-side telemetry the architecture never provides | 1498-1501, 1574, 1596-1600, 1766 |
| 52 | MINOR | PLAUSIBLE | optimizer | 9.7 contains no scaling law; "small new root" unquantified for a sharded index | 1758-1769 |
| 53 | MINOR | PLAUSIBLE | optimizer | §14: targets unfalsifiable; alleged contradictions only partly hold | 1991-2016, 1508-1524 |
| 54 | EDITORIAL | CONFIRMED | prior-art | Canonical ordering table cites obsoleted RFC 4122 while references cite RFC 9562 (dup: #55) | 837-844, 2305 |
| 55 | EDITORIAL | CONFIRMED | citations | Normative canonical-ordering text cites RFC 4122, absent from the reference list (dup: #54) | 837-844, 2305 |
| 56 | EDITORIAL | CONFIRMED | citations | `MPEG_scene_dynamic` row omits JSON Patch per ISO/IEC 23090-14 (dup: #42) | 180, 199-202, 2287 |
| 57 | EDITORIAL | CONFIRMED | citations | Three listed RFCs (9530, 8594, 5829) are never used or engaged in the body | 2301-2303 |
| 58 | EDITORIAL | CONFIRMED | codecs | "New subtree revision" names an identity that does not exist in the identity model | 1008-1010, 1254, 2162, 228, 774 |
| 59 | EDITORIAL | CONFIRMED | fork-fit | Imagery component example uses `layer.json`, conflating imagery with the terrain descriptor | 705 |
| 60 | EDITORIAL | PLAUSIBLE | protocol | `affected` may be omitted yet "must never contain false-negative coverage" (dup: #61) | 955-957, 1816-1817 |
| 61 | EDITORIAL | PLAUSIBLE | editorial | `affected` hint rule is self-contradictory as worded (dup: #60) | 956-957 |

## 3. Per-Finding Detail

**#1 No freshness/anti-rollback root of trust** (security, CRITICAL, CONFIRMED)
- Claim: nothing bounds how stale a validly-formed head may be; a misbehaving CDN can serve an old head, an old validly-signed state, or an extension-stripped entry `tileset.json` forever; cold/restarted clients accept it, so the required/current promise and §17.3 revocation guarantees are unachievable.
- Evidence: head (615-633) unsigned; the optional signature covers only the state manifest (1976-1977); laws 2/5 (972-979) compare against a watermark the client is never required to persist; §13 lists rollback (1969) and the profile "must define anti-rollback epochs" (1984) with no mechanism.
- Fix: TUF-style freshness role — short-expiry signed head binding generation/stateDigest/epoch; mandatory durable client generation watermark; normative max-staleness bound for required/current profiles; signed or pinned entrypoint identity for the revocation profile.
- Verifier: confirmed; "maximum head staleness" appears only as a GC input (1065); mechanism is deferred to open decisions 14/19 (2107, 2116) — acknowledged gap, still a gap. See Decision 1.

**#2 Epoch reset vs. event-identity projection** (protocol, CRITICAL, PLAUSIBLE)
- Claim: projection includes `updateEpochId`+`sequence` and is bound by `invalidationId`; after an intentional epoch reset, a re-served hint for the current transition reuses the manifest-fixed `invalidationId` under a new epoch/sequence — a divergent projection law 1 requires to fail closed, contradicting decision 13 ("replayed events are harmless").
- Evidence: 959-961 (projection), 968-971 + 2136-2138 (fail-closed mandate), 599 (resets intentional), 651 (one ID per transition), 924 (poll serves hints).
- Fix: split the projection — `invalidationId` binds only {datasetId, generation, supersedesStateDigest, successor.stateDigest}; (epochId, sequence) binds transport ordering; hint conflict = ignore + head reconciliation; add a post-reset replay case to §17.
- Verifier: coupling is real, but the doc never says a server re-labels a transition after reset; `head.updates` (620-626) records epoch/seq at CAS, so re-served hints may carry fixed values. Needs a rule either way. See Decision 2.

**#3 Cost model cannot prefer patch-first** (optimizer, CRITICAL, PLAUSIBLE)
- Claim: `futureDebt` (1583) charges each patch the full mandated rebuild (decision 14, 78-81), plus patch and compositor cost; the only latency credit is buried in `notificationCost`; zeroing `Wdebt` is non-conformant (2220-2221); K debounced patches → K-fold rebuild overcount. So the argmin picks direct rebuild.
- Evidence: 1583, 1604-1624, 78-81, 1580-1581, 3.4.3 debounce.
- Fix: explicit time-to-current cost on every candidate (rebuilds pay production latency vs SLA); define `futureDebt` as marginal amortized rebuild cost under debounce; show on flatten-a-hill that a patch can win.
- Verifier: overcount and missing amortization are real; "structurally cannot" overreaches — time-to-current is a per-candidate term (1580) and hard cap (1550). Settle with a worked example. See Decision 5.

**#4 Revocation-incapable clients fail open** (security, MAJOR, CONFIRMED)
- Claim: a core client encountering nonempty `revocations` rejects the state and "retains the predecessor" — the pre-revocation content — indefinitely if no compatible in-state fallback is available; fail-open display for the one fail-closed operation.
- Evidence: 761-767, 789-790, 1855-1858, 2224-2225; fail-closed absence (1984-85, 2241-42) only for profile clients.
- Fix: on a revocation-bearing state with no compatible fallback a core client must withhold affected coupled target groups; require revocation-bearing publications to ship a core-consumable fallback; add conformance test.
- Verifier: text matches verbatim. See Decision 3.

**#5 Retention anchored to undefined quantities** (protocol, MAJOR, CONFIRMED)
- Claim: GC preconditions cite "maximum head staleness", "active-session", "declared offline windows", "maximum cache/offline retention window" — none defined; anonymous readers have no lease; no revalidation cadence; lazy closure fetches deferrable indefinitely.
- Evidence: 879 (sole occurrence), 1064-1066, 606/1059 (`retainUntil` in no schema; only `purgeEligibleAfter` 1055), 856-866/1791-1794.
- Fix: deployment constants (max head-revalidation interval, max lazy-fetch horizon); obligate aware online clients; retention ≥ those + propagation/grace; give `retainUntil` a schema carrier.
- Verifier: confirmed; open decision 18 (2114) covers the general stale lease, so acknowledged, not closed. See Decision 8.

**#6 Stale-base entrypoint has no GC root or pointer law** (protocol, MAJOR, CONFIRMED)
- Claim: mark-epoch root set omits published entrypoints ("active publication" undefined), so an entrypoint's base can be GC'd while served `tileset.json` references it; the "stable base URL" is a second mutable pointer with no CAS/ETag/cache rule.
- Evidence: 133, 300, 1073-1075, 1064, 1844-1847, 1097-1110, 1985.
- Fix: entrypoints become durable named roots with repoint/retention procedure; stable base URL gets head-style validator/CAS/cache-control or is a redirect to the current base revision.
- Verifier: confirmed.

**#7 Atomic activation has no engine owner** (fork-fit, MAJOR, CONFIRMED)
- Claim: "never partially apply a multi-tile, multi-LOD, or terrain-plus-imagery update" (1803) and 8.4 coupled activation have no home in this fork; §3.3 never names it missing (CLAUDE.md principle 9).
- Evidence: all §3.3 prior art is `Cesium3DTileset`-scoped; `Cesium3DTilesInvalidationFeed.invalidateTile()` reuses per-tile `_expiredContent` (Feed.js:279-293); imagery draped per `GlobeSurfaceTile` with no revision pinning; no shared state coordinator; 509-514 unenforceable.
- Fix: add to §3.3 a missing-capability list — frame-atomic multi-tile swap, scene-level multi-component coordinator, revision-pinned imagery attachment; track in DEFERRED_WORK as P2/V2 prerequisites.
- Verifier: confirmed; 3.3 (424-431) lists only feed gaps; 2270-71 "not yet multi-layer" is the closest.

**#8 §15 producer/server harness never a deliverable** (fork-fit, MAJOR, CONFIRMED)
- Claim: P3/V3 and half of 15.2 need a stateful producer/publication service (CAS head writes, SSE/WS, durable outbox, origin op counting, GC sweeps); no phase names it; repo has nothing that can host it.
- Evidence: phase table 2021-2040 (only S1 "conformance assets"); 15.2 2076-2081; `server.js` is `express.static` (line 544); no cross-tile hill `replaceRegion` fixture in Specs/Data.
- Fix: add P0 delivering a Node reference producer + mutable-head server + scenario dataset generator; annotate each 15.2 output with its instrument; mark cohort-p95 outputs out of scope for the in-repo prototype.
- Verifier: confirmed. See Decision 7.

**#9 9.3 cost vector incoherent** (optimizer, MAJOR, CONFIRMED)
- Claim: `riskPenalty` unweighted/unitless (1623); several terms are multi-unit bundles; per-client vs fleet aggregation stated for 3 of 18 terms; uncertainty counted three ways.
- Evidence: 1578-1582, 1589-1595 vs 1631-1632, 1695-1697, 1658-1660.
- Fix: scalar components in declared units; state aggregation level per term; weight `riskPenalty` or fold into bounds; one uncertainty mechanism with `confidencePass` as a width test.
- Verifier: confirmed verbatim.

**#10 9.4 defects** (optimizer, MAJOR, CONFIRMED)
- Claim: (a) `bestMaterialized` chosen by min upperCost, admission tests its lowerCost; (b) `patchAdmissionRatio` undefined, three inconsistent thresholds (1546, 1729, 1735); (c) failed maintenance-only compaction returns `NO_SAFE_CANDIDATE_DEFER_TO_OFFLINE_BUILD` where §12 makes deferral routine.
- Fix: admit against min lowerCost over materialized (or the final-selection candidate); define the ratio and a precedence rule; route failed maintenance-only compaction to `DEFER_COMPACTION`.
- Verifier: confirmed; (c) is the weakest.

**#11 8.1 extremum rule over-broad** (codecs, MAJOR, CONFIRMED)
- Claim: 1416-1418 forces height-stream/header or whole-tile replacement whenever an edit "removes or creates an extremum", contradicting 1410 (interval only) and 1412 (stale-conservative bounds permitted); flattening the hill holding the tile max is kicked off the fast path.
- Fix: replace with "requires a height outside the declared min/max interval"; permit extrema-tightening on the fast path when 1412's evidence holds; note raising-toward-old-max needs horizon-occlusion re-proof.
- Verifier: confirmed; scenario 1 (2044) is disqualified only when the hill holds the tile max.

**#12 `replaceContent` outside MVP** (editorial, MAJOR, CONFIRMED)
- Claim: 2.2 limits MVP to `replaceRegion` + one tombstone op, yet 5.5 `replaceContent` is used by 12.1 step 1, 484-486, scenarios 7/10, matrix row 2159 with no phase marker.
- Fix: add it to 2.2, or mark 5.5/12.1-step-1/scenario 10 post-MVP and give 12.1 an MVP-only path.
- Verifier: confirmed; 12.1 step 1 is optimizer-optional (1950), so "required by compaction" overstates; phase gap holds. See Decision 6.

**#13 Matrix/body MVP larger than 2.2** (editorial, MAJOR, CONFIRMED)
- Claim: 17.1 "initial acceptance" tests multi-component states, in-state fallbacks, degraded profile, off-screen deferral/baking, and producer debounce/maxWait/outbox recovery — none in 2.2, no phase tags.
- Fix: extend 2.2 or tag matrix rows by phase.
- Verifier: confirmed; terrain+imagery atomicity is in scope by intent (2.3, 4.2), so that item is weaker. See Decision 6.

**#14 §16 lists already-answered decisions** (editorial, MAJOR, CONFIRMED)
- Claim: Q1, Q2, Q5, Q9 (and largely Q17) are stated as requirements in body/matrix (807-810, 822-824, 124, 2172; 132, 55, 897; 132-133, 1122-1124; 1194; 993-1029).
- Fix: delete and record in 1.2, or annotate body statements as provisional.
- Verifier: confirmed; Q9 weakest (1194 sits inside a "should be narrow" list). See Decision 9.

**#15 Survey misses #102 / 2025 roadmap** (prior-art, MAJOR, CONFIRMED)
- Claim: 3d-tiles issue #102 (open since 2016) and the June-2025 Cesium roadmap ("a single tileset can be updated incrementally, preserving a history of changes"; "each new capture updating only affected tiles") are absent; only #834/#822 engaged.
- Fix: add both to §2.4/§19; state collision/convergence risk with a future `3DTILES_time_dynamic`; pin the survey date; add a re-survey obligation before D1 freeze.
- Verifier: confirmed; slightly softened by #834 naming #102/#817.

**#16 `3DTiles_temporal` omitted** (prior-art, MAJOR, CONFIRMED)
- Claim: Oslandia/LIRIS 3D Tiles vendor extension (Zenodo 10.5281/zenodo.3596881; IJGIS 34(10) 2020) provides versions/version transitions through 3D Tiles; closest existing extension to the supersession layer.
- Fix: add a row — provides authored multi-version/time selection; does not provide base-relative deltas, immutable head/state, atomic activation, retention/GC, optimizer.
- Verifier: confirmed; zero hits for "temporal".

**#17 / #18 Hint-content fail-closed, no trust-domain binding** (protocol MAJOR PLAUSIBLE / security MAJOR PLAUSIBLE)
- Claim: laws 1-2 (968-973, 2136-2138) prescribe fail-closed from unauthenticated hint content while 962-964/396-398/1977-1978 say hints never change semantics; keys are bare UUIDs unbound to origin; a forged/relay-corrupted hint on shared transport can DoS updates and pollute dedup state; "fail closed" undefined for the hint plane; law 8 (986-989) pulls the other way.
- Fix: scope event/head state by (trust domain, datasetId); hint anomalies → ignore + rate-limited head reconciliation (mirror law 8); reserve fail-closed for the verified head-vs-state path; define "fail closed" wherever mandated.
- Verifier: laws quoted accurately; law 4/6, 1817, 2144 support a benign "never activate from hint" reading; no shared transports posited; law 3 + 2145 revalidation may bound the DoS. One demotion sentence settles it. See Decision 2.

**#19 GPU-residency couplings absent** (fork-fit, MAJOR, PLAUSIBLE)
- Claim: no reconciliation with PHASE_8_GPU_RESIDENT_TILES_DESIGN.md or C18; zero hits for "Phase 8"/"C18"/"WebGPU"; resident allocations, impostor bakes, residency feedback must key on generation.
- Fix: §3.3 GPU-residency subsection; cross-link both ways.
- Verifier: zero hits confirmed, but the doc keys GPU state on generation generically (519-522, 1108, 1795-1801); Phase 8b MegaBuffer is FUTURE; C18-A6 is voxel residency. Settle by checking Phase 8 cache keying.

**#20 No unified budget for replacement tilesets** (fork-fit, MAJOR, PLAUSIBLE)
- Claim: every `Cesium3DTileset` owns a private LRU/byte budget (Cesium3DTileset.js:82-83, 252-266); N patches → N+1 uncoordinated caches, N traversals, N request queues; 5.4 never costs this.
- Fix: engine-integration note — shared patch-budget governor (aggregate `cacheBytes`, coordinated trim, shared traversal scheduling) as a new capability to scope.
- Verifier: repo claim holds; the doc bounds N at protocol level (535, 1734, 1871) and never mandates one `Cesium3DTileset` per patch. See Decision 7.

**#21 9.2 gate list** (optimizer, MAJOR, PLAUSIBLE)
- Claim: 1546 economic comparison sits among correctness gates (vs 477-481); 1538 frontier gate is client/camera-dependent (855-858); no gate rejects overlapping write sets against active patches/tombstones.
- Fix: move economic comparison to 9.4; restate frontier gate as producer-checkable closure completeness; add a disjoint-or-supersede write-set gate.
- Verifier: misfiling holds but does not strain O(1) (1502 lookup); frontier gate ambiguous rather than unevaluable; overlap rejection is mandated at 807-819/824/2232 — only the 9.2 list omits it.

**#22 9.6 Stage 2 never integrates with 9.4** (optimizer, MAJOR, PLAUSIBLE)
- Claim: `NEEDS_BOUNDED_STAGE_2` returns only from the input-bounds guard (1638-1642); no close-decision branch; 9.6 has no re-entry; Stage-2 exhaustion returns a candidate admitted under distrusted estimates.
- Fix: closeness test (overlapping bounds of top two) returning `NEEDS_BOUNDED_STAGE_2` from 9.4; Stage 2 re-invokes the full gate+admission pipeline; no side effect before the final stage returns.
- Verifier: gap real; "flip after side effects" unsupported (3.4.1 step 3 publishes only after decision).

**#23 / #30 "Rejected or normalized" canonicalization** (protocol MINOR CONFIRMED / security MINOR PLAUSIBLE)
- Claim: `stateDigest` hashes the canonical manifest, not served bytes; noncanonical input "is rejected or normalized" (830-831) at implementer's choice → parser-differential surface, distinct byte streams under one digest, interop divergence; duplicate handling inconsistent (811/2173 normalize vs 2170-2171 reject).
- Fix: publishers serve exactly canonical bytes; digest/signature over served bytes; noncanonical/duplicate manifests uniformly rejected.
- Verifier: divergence real; "breaking exact-byte reasoning" overstates since semantic identity is by design and HTTP caching keys on URI/ETag. See Decision 4.

**#24 Signature covers state, not head** (protocol, MINOR, CONFIRMED)
- Claim: outside the revocation profile the only signature is over the state manifest; unsigned head is the sole currentness authority; rollback to older signed states undetectable for cold clients.
- Fix: sign a head statement (datasetId, generation, stateDigest, issued-at) with a persisted client floor, or state that the base profile provides integrity only.
- Verifier: confirmed; subsumed by #1 / Decision 1.

**#25 No digest-algorithm agility** (security, MINOR, CONFIRMED)
- Claim: `sha256:` used illustratively ~25-30 times; no allowed set, no weak/unknown rejection, no one-suite-per-closure; a weak sub-digest lets payload substitution bypass the manifest signature.
- Fix: normative registry (sha256-only initially), rejection rule, single-suite rule, migration story; add to §13 and matrix.
- Verifier: confirmed; only hooks are 774 and Q6.

**#26 `sparseAttributeOverride` over compressed primitives** (codecs, MINOR, CONFIRMED)
- Claim: 7.1 never says whether Draco/meshopt bases are legal targets, which space indices live in, or what the layout digest covers.
- Fix: forbid compressed base accessors in the MVP codec, or define indices in decoded space with a deterministic-decode requirement and decoded-layout digest; fallback `replaceRegion`.
- Verifier: confirmed.

**#27 Dual value domains in quantized-mesh payload** (codecs, MINOR, CONFIRMED)
- Claim: 1420-1424 allow decoded quantized heights OR real-world heights with client re-encoding; 812 requires exact output digests; no rounding rule exists.
- Fix: uint16 decoded domain sole normative payload, or normatively pin the rounding mode.
- Verifier: confirmed; grep finds no rounding/IEEE rule. See Decision 10.

**#28 Cross-tile normal recompute** (codecs, MINOR, CONFIRMED)
- Claim: "normals are supplied or recomputed" (1411) — single-tile recompute of boundary vertex normals changes averaging support vs neighbor → lighting seams even with matching positions.
- Fix: require supplied normals for boundary-adjacent vertices or define a neighbor-collar recompute; add a lighting-seam conformance row.
- Verifier: confirmed; 1409 does not close it.

**#29 8.3 ladder missing height-stream rung** (codecs, MINOR, CONFIRMED)
- Claim: 8.1 (1417) and 8.2 name "complete height-stream/header replacement" but 8.3 rungs are sparse-override / subregion / whole-tile / multi-tile; 3.1 lists no codec for it.
- Fix: add `heightStreamReplace` between rungs 1 and 3, or amend 8.1/8.2 to select whole-tile and delete the phantom.
- Verifier: confirmed. See Decision 10.

**#31 Sparse accessor over shared external buffer** (codecs, MINOR, CONFIRMED)
- Claim: a tiny new glTF may reference the base's content-addressed `.bin` by URI and lay a sparse accessor over the same bufferView — conformant today, wire cost ≈ sparse indices/values; weakens the "core glTF cannot express this" framing for bin-based content (GLB stays a real limit).
- Fix: acknowledge as a zero-new-codec transport option under `replaceContent`/`replaceRegion`; narrow the novelty claim to GLB-embedded and cross-asset-identity gaps.
- Verifier: confirmed; no mention of shared/external buffer URIs anywhere.

**#32 Dual-backend obligation absent** (fork-fit, MINOR, CONFIRMED)
- Claim: only graphics-API term is "bind groups" (1795); no principle-5 note; `ModelClippingPolygonsPipelineStage` (WebGL) + `WebGPUClippingPolygonCollection` (SDF-atlas, SHIPPED) unmentioned as mask vehicle.
- Fix: fork-implementation note; evaluate the clipping-polygon collections as the `replaceRegion` mask vehicle and fold SDF-resolution limits into 5.3.
- Verifier: confirmed.

**#33 Classification and shadow passes** (fork-fit, MINOR, CONFIRMED)
- Claim: 5.1/17.1 define correctness for render+pick only; no criterion that a masked base stops casting shadows; classification/draping inside a mask undefined.
- Fix: acceptance rows for shadow-cast exclusion in the same atomic transition and for classification/draping resolution against the replacement surface (or explicit deferral).
- Verifier: confirmed; "classif" zero hits, "shadow" only at 1597.

**#34 Layer B crosses terrain boundary; no non-3D-Tiles bootstrap** (fork-fit, MINOR, CONFIRMED)
- Claim: 369 lists `quantizedMeshHeightOverride` under the 3D Tiles extension's Layer B without a sibling marker; discovery only via `tileset.json` extension (886-901); pure terrain+imagery deployments have no bootstrap.
- Fix: annotate as sibling profile; add discovery for `layer.json`/service-level roots.
- Verifier: confirmed; Q16 mentions discovery links but defines nothing.

**#35 Upsampled descendants** (fork-fit, MINOR, CONFIRMED)
- Claim: `GlobeSurfaceTile` upsamples child terrain from parent (GlobeSurfaceTile.js:209, 259, 443-465) cached by tile not parent generation; a parent height patch leaves stale derived children.
- Fix: 8.1 rule — invalidate/regenerate every client-derived descendant in the same atomic transition; sibling-profile acceptance row.
- Verifier: confirmed.

**#36 Matrix orphans** (editorial, MINOR, CONFIRMED)
- Claim: no rows for generation-encoding rejection (952-955), cross-domain comparison ban (743-745), one-default-per-sourceDomains (836), `affected` completeness (956-957); rows 2174 (context loss) and 2220 (mutants) have no body definition.
- Fix: add four rows; add a §10 context-loss subsection; state mutation testing in 9.6/15.2 or drop the row.
- Verifier: confirmed.

**#37 `retire` polysemy** (editorial, MINOR, CONFIRMED)
- Claim: 916 defines client-side release; also used for publisher closure retirement (71, 943-946), logical retirement-by-omission (1033), revocation retention (1985).
- Fix: distinct terms in the 4.4 table.
- Verifier: polysemy confirmed; the `invalidationId`-naming half is refuted (604 defines it as "one logical invalidation/supersession transition").

**#38 No conformance-language declaration** (editorial, MINOR, CONFIRMED)
- Claim: zero RFC 2119/8174 or capitalized key words; parts labeled "normative" (775, 907, 993, 1160) in an "exploratory" doc (3); 5.3 "should" conflicts with 4.2/5.1 "requires".
- Fix: conformance-language section; mark normative vs rationale sections; MUST for binding items.
- Verifier: confirmed with the correction that disjointness/self-intersection are already hard at 822-823, 1159-1160.

**#39 Missing spec apparatus** (editorial, MINOR, CONFIRMED)
- Claim: no digest-string grammar; relative-URI resolution only for replacement URIs (1156); no media types; version fields inconsistent (`"v": 1` vs `formatVersion "1.0"` vs `version "1.0"`).
- Fix: before D1 — one digest grammar with agility, one URI-resolution rule per object class, provisional media types, one version convention.
- Verifier: confirmed.

**#40 Conclusions 1 and 5 ahead of evidence** (editorial, MINOR, CONFIRMED)
- Claim: "fills a real update-latency gap" and "quantized mesh can be patched efficiently" stated as findings; P6/B1 pending; §14 says performance "is not established by a small payload alone".
- Fix: reword 1 as a standards-gap claim, 5 as conditional pending P6/B1.
- Verifier: confirmed; conclusion 5 already partly conditional.

**#41 Tile expiration omitted** (prior-art, MINOR, CONFIRMED)
- Claim: no §2.4 row for 3D Tiles tile expiration (issue #99; `Cesium3DTile.expireDuration/expireDate`) though 410-411 shows awareness.
- Fix: add a row — polled per-tile whole-content refresh; no deltas, base preconditions, atomic multi-resource state, retention, push.
- Verifier: confirmed; corrections: API is `expireDuration`/`expireDate` (no `expireUri`); ref-doc carries no explicit "draft" disclaimer.

**#42 / #56 MPEG_scene_dynamic = JSON Patch** (prior-art MINOR / citations EDITORIAL, both CONFIRMED)
- Claim: ISO/IEC 23090-14 update samples are RFC 6902 JSON Patch documents; the doc names only the timing/circular-buffer model.
- Fix: name the JSON Patch mechanism (and `MPEG_buffer_circular` carrier) and add its patch-document model to the study list for the control plane and §7 codec envelope.
- Verifier: confirmed; the cited Khronos README itself omits it — not a misattribution; distance claims remain correct.

**#43 Testbed-15 Delta Updates ER** (prior-art, MINOR, CONFIRMED)
- Claim: only 19-070 engaged; the Delta Updates ER (prioritized deltas via transactional OGC API-Features + WPS, DDIL) is closer prior art for the priority-hinted control plane.
- Fix: add as row/reference; mine for priority/degraded-bandwidth aspects.
- Verifier: confirmed with correction — the ER is OGC 19-012r1 (not 19-018); the 19-070 fetch showed no cross-reference to it.

**#44 I3S row tautological** (prior-art, MINOR, CONFIRMED)
- Claim: the negative cell is true of any non-3D-Tiles technology; 17-014r9 affirmatively defines no client-visible post-publication update/invalidation/versioning contract.
- Fix: rewrite the row to state what I3S standardizes and that update workflows are unstandardized service-side behavior, citing 17-014r9.
- Verifier: confirmed; editorial-strength.

**#45 Citation integrity summary** (citations, MINOR, CONFIRMED)
- Claim: 31 web + 2 repo references resolve; every checked attribution supported (RFC 9875 safe-method text at L1106; glTF sparse text at L178; quantized-mesh details in §8; PR #834 Draft `content_conditional`; no "expire" in 3d-tiles spec source or registry).
- Fix: none for content; optionally note 22-025r4 HTML is ~53 MB and cite the GitHub source as primary.
- Verifier: spot re-checks hold.

**#46 I3S row half unsourced** (citations, MINOR, CONFIRMED)
- Claim: "republishing/updating service-side scene layers" is not supported by the cited OGC landing page; true in reality (ArcGIS), uncited.
- Fix: cite Esri i3s-spec / ArcGIS scene-layer update docs, or soften.
- Verifier: confirmed.

**#47 CityGML anchor** (citations, MINOR, CONFIRMED)
- Claim: `#versioning` absent from 20-010.html; ids present include `_versioning`, `rc_versioning`.
- Fix: `#_versioning` or `#rc_versioning`.
- Verifier: confirmed by Node fetch (12,662,652 bytes).

**#48 Snapshot-spike anchor slug** (citations, MINOR, CONFIRMED)
- Claim: heading is `### 3.2 Reconciliation contract with \`Scene._snapshotVersion\`` → slug keeps the underscore; L2307 drops it.
- Fix: `#32-reconciliation-contract-with-scene_snapshotversion`.
- Verifier: confirmed; sibling SESSION_2026-04-08 anchor is correct.

**#49 §13 limits unquantified** (security, MINOR, PLAUSIBLE)
- Claim: no limit quantified or declared; instance counts, metadata bytes, array cardinalities, concurrent bakes absent; 17.1's "resource-limit attacks fail closed" untestable.
- Fix: quantify or require per-profile declaration of every limit; extend with per-codec axes.
- Verifier: codec-axis gap holds; "no declaration mechanism" overstates (§3.4.3 530-538, §10 1828-30).

**#50 `textureBlockReplace` transcode targets** (codecs, MINOR, PLAUSIBLE)
- Claim: for KTX2/Basis, GPU block format is per-client; "format and block dimensions are exact" cannot hold for all clients with one payload.
- Fix: restrict to concretely-formatted base textures or per-transcode-target cohorts; basis-universal falls back to whole-texture.
- Verifier: 7.3 never states the format domain; if stored/encoded, the base has one format and the last bullet already routes ETC1S to whole mips; a format-domain sentence settles it.

**#51 Client telemetry unspecified** (optimizer, MINOR, PLAUSIBLE)
- Claim: cohort decode throughput, p95 hitch, affected-screen probability, cache-hit probability are demand-side; no client→producer channel; no cold-start defaults; base profile embeds engine pass usage.
- Fix: telemetry/calibration component in §3, conservative cold-start vectors, move pass-usage to deployment profile.
- Verifier: no channel drawn, but B1/15.2 are the intended offline calibration path; gap is provenance, not absence.

**#52 9.7 no scaling law** (optimizer, MINOR, PLAUSIBLE)
- Claim: no formula relating manifest bytes/requests/origin ops to P, clients, cadence; flat shard index root is O(P/s) not small.
- Fix: state asymptotics (flat O(P); one-level O(√P); Merkle O(log P) with per-generation republication) and the head-polling origin-load formula.
- Verifier: no formula confirmed; "false as stated" overreaches — 1762 says Merkle/spatially sharded, for which a small root is achievable; unquantified O(log P) republication cost is the real omission.

**#53 §14 targets** (optimizer, MINOR, PLAUSIBLE)
- Claim: only head/hint byte targets are checkable; rest qualitative; 2004 vs 2005 contradictory; 2000 conflicts with 9.1 activeSummary.
- Fix: restate per-frame bullets as O(visible + log P); require incremental activeSummary derivation; attach budgets or "calibrated in B1" markers.
- Verifier: unbudgeted targets confirmed; the "contradiction" is refuted by 17.1 (2210); the activeSummary clash is speculative.

**#54 / #55 RFC 4122 vs 9562** (prior-art / citations, EDITORIAL, CONFIRMED)
- Claim: comparator table (837-844) cites RFC 4122 four times; §19 lists only RFC 9562, which obsoletes it.
- Fix: swap to RFC 9562 (byte semantics unchanged).
- Verifier: confirmed.

**#57 Unused RFCs 9530/8594/5829** (citations, EDITORIAL, CONFIRMED)
- Claim: listed but never bound despite pervasive digest verification, retention windows, and head/predecessor navigation.
- Fix: wire them (Repr-Digest, Sunset, version-navigation link relations) or annotate as background.
- Verifier: confirmed by grep.

**#58 "Subtree revision" identity** (codecs, EDITORIAL, CONFIRMED)
- Claim: no subtree-level revision exists in §4; 774/228/12.1 treat availability changes as a new base revision.
- Fix: reword to "new base revision (closure may reuse unchanged resources) or a future availability-overlay profile".
- Verifier: confirmed; the term appears at 1009, 1254, 2162 (and "subtree/base metadata" at 1949) — fix all sites.

**#59 Imagery example uses `layer.json`** (fork-fit, EDITORIAL, CONFIRMED)
- Claim: 705 gives the imagery component `baseUri: imagery/.../layer.json`; `layer.json` is the quantized-mesh descriptor (doc's own line 141).
- Fix: neutral descriptor name; note each component profile defines its own root format.
- Verifier: confirmed.

**#60 / #61 `affected` wording** (protocol / editorial, EDITORIAL, PLAUSIBLE)
- Claim: "may be omitted; must never contain false-negative coverage" — omission vs empty array undistinguished.
- Fix: "If present, `affected` conservatively covers every changed target; absent = no coverage claim; empty array forbidden or an explicit no-target claim." Add a matrix row for present-but-incomplete.
- Verifier: not strictly contradictory (natural reading: "contain" applies to a present array); impact bounded to fetch ordering by 962-964/1817; only the empty-array case is truly undefined.

## 4. Citation-Integrity Summary

| Category | Count | Result |
|---|---|---|
| Web references in §19 | 31 | 31/31 resolve (HTTP 200; 22-025r4 is a 52.9 MB HTML, verified via GitHub spec source) |
| Repo-relative references in §19 | 2 | 2/2 files exist; both engine files cited in §3.3 exist |
| Attributions checked (all fetchable §2.4 rows, §2.5 rules, §8 quantized-mesh details, in-body RFC 8785/9875 claims) | all | 0 misattributions |
| Broken anchors | 2 | CityGML `#versioning` (#47); snapshot-spike slug (#48) |
| Claims resting on an uncited source | 1 | I3S "republishing/updating" half (#46) |
| Listed-but-unused references | 3 | RFC 9530, 8594, 5829 (#57) |
| Cited-but-unlisted references | 1 | RFC 4122 in the ordering table (#54/#55) |
| Under-characterized rows (source faithful, doc omits salient fact) | 1 | MPEG_scene_dynamic JSON Patch (#42/#56) |
| Novelty-claim negative check | — | no "expire"/patch extension in 3d-tiles spec source or registry; claim survives |
| Refuted findings (whole audit) | 3 | protocol 1, security 2 |

## 5. Decisions for the Maintainer

**D1. Freshness / anti-rollback root of trust** (#1, #24; open decisions 14/19)
- Options: (a) status quo — unsigned head, no staleness bound, integrity-only signature; (b) short-expiry signed head statement (datasetId, generation, stateDigest, epoch, issued-at) + mandatory durable client generation watermark + normative max-staleness for required/current profiles; (c) (b) plus signed/pinned entrypoint identity for the revocation profile.
- Pros/cons: (a) simplest, but §17.3 revocation and "current" promises are unachievable against a stale CDN and the doc should say so; (b) small wire cost, needs key distribution and a client persistence obligation; (c) closes the stripped-entrypoint hole but adds a bootstrap trust anchor.
- Recommendation: (c) for the revocation profile, (b) as the base signed profile, and an explicit "integrity-only, no rollback resistance" statement for the unsigned profile.

**D2. Event-identity projection scope and hint-plane conflict semantics** (#2, #17, #18)
- Options: (a) keep epoch+sequence in the projection and add an explicit post-reset re-labeling rule so a reset mints new transport identity while `invalidationId` stays fixed; (b) split the projection — `invalidationId` binds semantic fields only, (epochId, sequence) bind ordering only — and demote every hint-plane anomaly to ignore + rate-limited head reconciliation (mirror law 8), reserving fail-closed split-brain for verified head-vs-state.
- Pros/cons: (a) minimal text change but keeps unauthenticated content able to trigger "fail closed" and leaves the term undefined; (b) removes the DoS surface and the decision-13 contradiction at the cost of re-stating laws 1-2 and conformance 2136-2140.
- Recommendation: (b), plus scoping durable dedup state by (trust domain, datasetId).

**D3. Revocation-incapable client behavior** (#4)
- Options: (a) keep "retain predecessor until fallback ready"; (b) withhold affected coupled target groups (degraded absence) when no core-consumable fallback exists, and require revocation-bearing publications to ship one; (c) make revocation support mandatory for all extension-aware clients.
- Pros/cons: (a) preserves availability but displays revoked content — fail-open for the one fail-closed operation; (b) honest fail-closed, may blank regions on old clients; (c) simplest semantics, raises the core-client bar.
- Recommendation: (b), with the conformance test the finder proposes.

**D4. Canonical bytes: reject-only vs normalize; digest domain** (#23, #30, #25)
- Options: (a) keep "rejected or normalized"; (b) reject-only — served bytes at `stateUri` must be canonical, digest and signature over served bytes, duplicates uniformly rejected; (c) reject-only but digest still over canonical form.
- Pros/cons: (a) implementer freedom, interop divergence and parser-differential surface; (b) simplest verification (hash bytes, done), forces publishers to emit canonical form — which they must anyway to compute the digest; (c) middle ground, still needs client canonicalization.
- Recommendation: (b), paired with a normative digest registry (sha256-only initially) and one-suite-per-closure rule.

**D5. Optimizer economics: how a patch can ever win** (#3, #9, #10, #21, #22)
- Options: (a) keep decision 14 (patch always followed by rebuild) and repair the model — amortized marginal `futureDebt` under debounce, explicit per-candidate time-to-current cost, dimensionally coherent 9.3, consistent 9.4 thresholds; (b) relax decision 14 so patches may be terminal when the rebuild is uneconomical; (c) keep as is and accept that the argmin will mostly select rebuild.
- Pros/cons: (a) preserves the "patches are latency bridges" doctrine and makes 17.1's undercount test meaningful; (b) simpler cost model but re-opens long-lived patch accumulation the doc's compaction story was written to avoid; (c) contradicts decision 14 in practice.
- Recommendation: (a), with a worked flatten-a-hill example in §9 showing patch winning under stated weights.

**D6. MVP scope vs. matrix and body** (#12, #13, #14)
- Options: (a) widen 2.2 to name `replaceContent`, multi-component atomic states, in-state fallbacks, degraded profile, producer scheduler as MVP; (b) keep 2.2 tight, tag every 17.1 row and 5.5/12.1/scenario 10 by phase (MVP core / producer profile / typed profiles) and give 12.1 an MVP-only path.
- Pros/cons: (a) honest about what 17.1 already demands but makes the "minimum" large; (b) keeps a shippable core but requires disciplined tagging.
- Recommendation: (b), and in the same pass resolve or annotate Q1/Q2/Q5/Q9/Q17 (record in 1.2 or mark body statements provisional).

**D7. Prototype vehicle and harness** (#7, #8, #20, #19)
- Options: (a) one `Cesium3DTileset` per replacement patch, plus a new shared patch-budget governor; (b) a compositor sub-tree inside the base tileset's traversal with a single cache/budget; either paired with (c) a new P0 phase delivering a Node reference producer + mutable-head server + scenario dataset generator.
- Pros/cons: (a) reuses existing loader/traversal, N-fold traversal and cache cost, needs the governor; (b) one budget and one traversal, larger engine change and a new atomic-swap owner either way; (c) is required regardless — §15 P3/V3 and half of 15.2 cannot run without it.
- Recommendation: (c) unconditionally; between (a)/(b) pick (b) for the prototype only if the frame-atomic multi-tile swap is being built anyway (it must be — no engine owner exists), otherwise (a) with the governor scoped as a DEFERRED_WORK prerequisite; add the Phase 8 / C18 cross-links either way.

**D8. Retention windows and reader leases** (#5, #6; open decision 18)
- Options: (a) deployment constants (max head-revalidation interval, max lazy-fetch horizon) that aware online clients must honor, retention ≥ those + propagation + grace, `retainUntil` carried in a schema; (b) explicit reader lease/session protocol; (c) leave to open decision 18.
- Pros/cons: (a) stateless, works for anonymous HTTP readers, bounds GC without server state; (b) tighter but adds server state and fails anonymous readers; (c) leaves the GC-vs-reader race unbounded in the MVP.
- Recommendation: (a), plus making published entrypoints durable named GC roots with a repoint procedure and giving the stable base URL head-style validator/cache rules.

**D9. Quantized-mesh sibling profile: payload domain and ladder** (#27, #29, #11, #35, #28)
- Options: (a) uint16 decoded-quantized heights as sole normative payload domain and add a `heightStreamReplace` rung; (b) allow real-world heights with a normatively pinned rounding mode; (c) delete the height-stream/header operation and route interval changes to whole-tile.
- Pros/cons: (a) bit-exact by construction, one new rung; (b) producer convenience, cross-implementation byte risk unless rounding is nailed; (c) simplest ladder but forfeits the header-only case 8.1/8.2 explicitly select.
- Recommendation: (a), fixing the 8.1 extremum rule to interval-only, adding the upsampled-descendant invalidation rule and the boundary-normal rule in the same pass.

## 6. What the Audit Did Not Cover

- No execution: no builds, no Playwright, no probes; every repo claim (Feed.js, Cesium3DTileset.js, GlobeSurfaceTile.js, server.js, FEATURE_INVENTORY, Phase 8 design) was verified by reading, not by running.
- No end-to-end formal analysis of the state machine (laws 1-8 + GC + CAS) — findings are local consistency checks, not a model check; interactions among the three CRITICALs were not explored jointly.
- The 3 refuted findings and their reasoning are not reproduced here (removed by the verifier per brief).
- Prior-art search was adversarial but bounded (web-searchable English sources; OGC/Khronos/CesiumGS/MPEG/Esri/academic); no patent search, no non-English literature, no private vendor formats beyond I3S.
- Citation checks were fetch-and-match at 2026-08-15; the 53 MB 22-025r4 HTML was verified through its GitHub source rather than the rendered page; RFC 9530/8594/5829 were confirmed to exist and be unused, not evaluated for fitness.
- Optimizer findings are analytical (structure of the cost model), not numerical — no weights were instantiated and no worked example was computed; D5 asks for that.
- Codec analysis covered the codecs the doc defines; it did not audit encoder feasibility (Draco/meshopt/KTX2 tooling) or measure any patch size ratio.
- The verifier graded verdicts CONFIRMED/PLAUSIBLE only; no finding was left UNVERIFIED, but PLAUSIBLE items (16) still carry the verifier's stated uncertainty and should be read as "settle with one sentence or one experiment," not as established defects.
- Scope was the design document alone; the sibling `DEFERRED_WORK.md`/`FEATURE_INVENTORY.md` entries the fixes imply were not authored.
