# 3D Tiles Patch & Invalidation Extension — Closing-Gate Re-Audit (2026-08-16)

**Target:** [3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md](3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md) as revised — 4,436 lines at Batches 1054/1055.
**Baseline:** [3D_TILES_PATCH_EXTENSION_AUDIT_2026-08-16.md](3D_TILES_PATCH_EXTENSION_AUDIT_2026-08-16.md) — the 61-finding audit of the 2,310-line original, whose findings the five section-owned revision lanes dispositioned under maintainer rulings D1-D9.
**Purpose:** independent check on a revision whose lanes all self-certified. Reviewers were instructed to judge the revised text on its merits and NOT to re-raise a prior finding unless the new text still exhibits it.

## Coverage — read this before the findings

This gate is **partial**. Of eight planned dimensions, **five ran** (protocol, security, codecs, optimizer, editorial) and **three did not** (prior-art, citations, fork-fit) — they failed on structured-output retries and returned nothing. Consequences:

- **Fork-fit is entirely unchecked.** The revision's engine claims — eight named components with proposed homes, the Phase 8 reconciliation verdict, the P0 harness plan, the GPU-residency couplings — have had no independent read. They remain worker self-report.
- **Citations are unchecked in this pass.** The prior audit verified 33/33 references with zero misattributions; the revision added ~10 more, re-fetched by the authoring lane but not re-verified here.
- **Prior art got a spot-check, not a survey.** The synthesizer ran three searches and one registry read against the document's own watchlist (result: the bounded novelty claim stands, unnarrowed). That does **not** discharge the document's own pre-D1 re-survey obligation.
- **All six CRITICAL findings are UNVERIFIED.** The protocol and optimizer lanes returned no verification pass, so their findings rest on one reader's close reading. Treat them as high-quality allegations pending confirmation, not settled defects. The codecs and editorial lanes did verify — against engine source and document text respectively — and their CONFIRMED findings are solid.

An earlier attempt at this same gate (2026-08-15) died at 0/9 agents on credit exhaustion and produced nothing; this run replaced it.

## What this gate was for, and what it found

Five lanes edited one document in parallel and each reported its own findings fixed; a sixth reconciled them and also self-reported. The risks were lane self-certification, seam regressions, and new defects in 2,126 added lines. **The gate found all three classes.** The heaviest findings are not survivals of the original 61 — they are contradictions introduced or exposed by the revision itself, concentrated where one lane's output became another lane's premise: the optimizer's `D_max` derivation against the protocol lane's closure law; a per-bin compaction cap used to bound a global manifest; a conformance matrix anchored to sections the document's own new conformance-language table declares non-normative.

That is the gate working as intended. Nothing here argues the design should not be built, and the central architecture is affirmed.

---
# Verified Audit — `migration_doc/3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md`

*Synthesis of five adversarial review dimensions (protocol, security, codecs, optimizer, editorial) against the 4,436-line design. 56 findings raised, 5 refuted and removed, **51 surviving**: 16 CONFIRMED, 7 PLAUSIBLE, 28 UNVERIFIED.*

---

## 1. Verdict

The design is architecturally sound and unusually rigorous for a document at this stage: the immutable content-addressed head, the state-manifest-as-sole-authority model with events demoted to hints, the atomic multi-resource activation with rollback, and the explicit patch-versus-rebuild cost contract are all coherent and mutually reinforcing. Nothing in this audit contradicts the central thesis, and no finding argues the design should not be built. What the audit found instead is a document whose **normative skeleton has not caught up with its analytical body**. The failures cluster in three places. First, several load-bearing laws contradict each other rather than being merely incomplete: the state-control-closure requirement (§4.2/§10) and the `1 + 2d` request model that yields normative `D_max = 16` (§9.3.3/§12) cannot both hold; the per-bin compaction cap is used to bound a global manifest in §9.7; and §14 row 4 states two mutually exclusive bounds. Second, the security profile boundary leaks: the freshness-profile selector is itself unauthenticated, the unsigned profile has no generation floor at all yet carries MVP-core conformance rows, and revocation is defeated by simply withholding the head — none of which the document's own threat table acknowledges. Third, and most systematically, the conformance suite is anchored to non-normative prose: 26 of 138 rows trace only to sections the document's own conformance-language table (lines 54–66) declares non-normative, and the normative §12 compaction trigger is decidable only from an `activeSummary` schema that nothing normatively requires a publisher to emit. These are fixable by editing, not redesign — but they are not cosmetic, because the terminal-patch argument, the `D_max` cap and the conformance suite are exactly the parts a spec reviewer will attack first.

Two honesty caveats bound this verdict. **All six CRITICAL findings are UNVERIFIED** — the protocol and optimizer lanes returned no verification pass, so their 23 findings (including four of the six CRITICALs) rest on a single reader's close reading of the document rather than an independent second look. They are internally consistent, quote line numbers accurately in every case I spot-checked, and the optimizer lane reproduced the document's own arithmetic exactly for every figure except `t_ttc` — which is itself a finding — but they should be treated as *high-quality allegations pending confirmation*, not as settled defects. By contrast the codecs and editorial lanes verified against engine source and the document text respectively, and their CONFIRMED findings are solid.

**Novelty claim: stands, unnarrowed, as bounded.** §2.4's claim is carefully scoped — a combination claim over *published standards and registered extensions only*, with an explicit disclaimer for private engines and proprietary tilers, and a standing re-survey obligation. My adversarial spot-check against the document's own watchlist found nothing that narrows it: the CesiumGS 3D Tiles extension registry still lists no patch, delta, incremental-update, time-dynamic, conditional-content or versioning extension (only `3DTILES_bounding_volume_S2`, `3DTILES_ellipsoid`, the six 1.0 extensions, and five vendor extensions); `3DTILES_content_conditional` remains a draft PR with reader/writer support in cesium-native but no registry entry; issue #102 and the June 2025 Cesium roadmap remain statements of intent with no published wire format; and OGC's changeset work (Testbed-15 19-070, the OGC API changeset conformance classes) is 2D-tile-and-feature scoped, which §2.4 already cites and correctly characterises. The claim's *framing* is its strongest asset — it names every individual piece of prior art and claims only the combination — and that framing survives contact. This check was three searches and one registry read, not a full R0 re-survey; the document's own pre-D1 re-survey obligation is not discharged by it.

---

## 2. Ranked findings

Severity first, then verdict strength (CONFIRMED > PLAUSIBLE > UNVERIFIED), then blast radius.

| # | Sev | Verdict | Dim | Title | Doc lines |
|---|---|---|---|---|---|
| 1 | CRITICAL | UNVERIFIED | security | Freshness-profile selector is unauthenticated; entrypoint anti-downgrade check is circular | 1708, 1719, 1346-1351, 1681, 1314, 4292 |
| 2 | CRITICAL | UNVERIFIED | security | Revocation defeated by withholding the head, and by replaying a pre-revocation head to a cold client | 1336-1341, 4279-4281, 3429-3444, 4293 |
| 3 | CRITICAL | UNVERIFIED | protocol | `D_max` is derived from a request model that contradicts the state-control-closure law | 1523-1528, 1624-1634, 2911, 3473-3484 |
| 4 | CRITICAL | UNVERIFIED | protocol | Signed head expiry vs 304 revalidation: permanent staleness, or the head cost model collapses | 1301-1310, 1326-1364, 2020-2033 |
| 5 | CRITICAL | UNVERIFIED | optimizer | §9.7 bounds a global manifest with a per-bin cap; the quadratic remedy does not hold | 3174-3186, 3461-3465, 3711 |
| 6 | CRITICAL | UNVERIFIED | optimizer | The triad's winner is decided by per-target exposure counts §9.1 forbids as inputs | 2685-2690, 2738-2740, 3260-3274 |
| 7 | MAJOR | CONFIRMED | editorial | 26 conformance rows trace to sections the doc declares non-normative | 54-66, 4078-4082, 4204-4232 |
| 8 | MAJOR | CONFIRMED | editorial | Normative compaction trigger depends on a schema declared non-normative and never required | 3453-3466, 61, 2718-2731 |
| 9 | MAJOR | CONFIRMED | security | "No JavaScript or shader source" under-covers the MVP payload, which is a whole tileset | 3645-3646, 4239, 2083-2087, 3630, 247-251 |
| 10 | MAJOR | CONFIRMED | codecs | Interval rule admits lowering edits that escape the vertex-fitted header bounding sphere | 2498-2519, 4256 |
| 11 | MAJOR | CONFIRMED | codecs | Implicit-tiling cost claim conflates content-addressed storage with client/CDN cache reuse | 586, 658-668, 1875-1878, 3712 |
| 12 | MAJOR | CONFIRMED | codecs | No derived-data or seam-closure gate for glTF position overrides | 2240, 2319, 4245, 4260 |
| 13 | MAJOR | CONFIRMED | editorial | MVP-core rows impose multi-component and fallback duties §2.2 excludes; T-17 contradicts C-39 | 303-330, 4098, 4149-4150, 4262, 3863 |
| 14 | MAJOR | CONFIRMED | editorial | §17.5 declares two body MUST/MUST NOT requirements "not required" | 2143, 3515-3516, 4314, 4319 |
| 15 | MAJOR | CONFIRMED | editorial | §16 questions 1-3 are already answered normatively, and §5.3 contradicts itself | 3926, 3941-3942, 2063, 2116, 2137, 4164 |
| 16 | MAJOR | PLAUSIBLE | security | §13's limit table is incomplete against the codec registry, and nothing is quantified | 3654-3666, 784-785, 1535-1536, 4238, 4019 |
| 17 | MAJOR | PLAUSIBLE | codecs | T-13's cross-LOD edge-position agreement test is unsatisfiable | 2526-2537, 2622-2624, 4258 |
| 18 | MAJOR | UNVERIFIED | protocol | Unsigned MVP profile has no generation floor at all, yet C-63 is tagged MVP-core | 1341-1342, 1831-1832, 3327-3330, 4188 |
| 19 | MAJOR | UNVERIFIED | protocol | Retention arithmetic bounds cache revalidation, not origin freshness, so it does not bound readers | 1283-1284, 1942, 1950-1956, 4189, 4195 |
| 20 | MAJOR | UNVERIFIED | protocol | `closureDigest` is undefined, leaving the descriptor-to-replacement-root hop unauthenticated | 1215-1247, 1675-1692, 2070-2074 |
| 21 | MAJOR | UNVERIFIED | security | No origin or trust-domain confinement of closure URIs: digests prove integrity, not provenance | 1677-1690, 1246, 3629, 3642, 4238, 3906 |
| 22 | MAJOR | UNVERIFIED | security | Retention law obliges the publisher to keep serving revoked bytes for the whole retention window | 1649-1655, 1966-1975, 1736-1737 |
| 23 | MAJOR | UNVERIFIED | security | Hint rate limiting and dedup are keyed on attacker-chosen identifiers, so the bounds are not bounds | 1846-1851, 1830-1832, 4135-4136 |
| 24 | MAJOR | UNVERIFIED | protocol | Compaction trigger is undecidable: bin partition, `baseBytes(b)` and `loadCost(b)` are undefined | 2698-2720, 3456-3458, 3486-3493 |
| 25 | MAJOR | UNVERIFIED | protocol | Compaction trigger has no clearance guarantee: predicates (B) and (C) can stay fired forever | 3468-3471, 3503-3518, 3571-3572 |
| 26 | MAJOR | UNVERIFIED | protocol | Commit-frontier recomputation has no progress bound: unbounded deferral under a moving camera | 1119-1120, 3340-3342, 3716, 3866 |
| 27 | MAJOR | UNVERIFIED | protocol | Coupled imagery component's resource closure is unbounded, unpriced, and not revision-scoped | 670-673, 1514-1517, 2632-2634, 3140-3152 |
| 28 | MAJOR | UNVERIFIED | optimizer | §14's residual frame budget is incompatible with the overlay depth §9.5/§12/§9.8 permit | 3720, 3723, 3094-3096, 3300-3303 |
| 29 | MAJOR | UNVERIFIED | optimizer | Two incompatible amortization rules stated at the same λ/q, up to 4.3× apart | 2921-2936, 3284-3292 |
| 30 | MAJOR | UNVERIFIED | optimizer | `b_wire` and `n_req` are charged at two aggregation levels; the R level has no wire or request term | 2823-2845, 2895-2907, 3229-3232 |
| 31 | MAJOR | UNVERIFIED | optimizer | Stage 2 pushes `costHi` above the Stage-1 `costHi` and re-measures only the patch candidates | 3023-3043, 3106-3110, 3262-3283 |
| 32 | MAJOR | UNVERIFIED | optimizer | §14 rows 9 and 10 are falsified by the document's own second worked edit | 3716-3717, 3269-3272, 3280-3281 |
| 33 | MAJOR | UNVERIFIED | optimizer | Stage 2 has no wall-time budget and its own cost is charged to no candidate | 3103-3118, 3278-3283, 3713 |
| 34 | MINOR | CONFIRMED | codecs | Water mask treated as geometry-independent; T-12 forbids changing it at rung 2 | 699-701, 2610-2615, 4257 |
| 35 | MINOR | CONFIRMED | codecs | Rung 1 is the "fastest path" but its client apply is O(vertexCount), and nothing measures it | 87, 2604-2607, 3712-3733 |
| 36 | MINOR | CONFIRMED | editorial | Normative reporting obligations exist with no defined diagnostic surface | 3655-3657, 4238, 4099, 4226, 3901-3922 |
| 37 | MINOR | CONFIRMED | editorial | Signed and revocation profiles carry 18 conformance rows but no phase in the §15 plan | 341-342, 3752-3777, 3799-3813 |
| 38 | MINOR | CONFIRMED | editorial | Two Layer-B codecs are declared then never specified, tagged, gated, limited, or tested | 786-787, 340, 3660-3666, 4297-4322 |
| 39 | MINOR | CONFIRMED | editorial | No extension placement or nesting rules: an external tileset with its own head is unaddressed | 1694-1717, 1880-1886, 3906 |
| 40 | MINOR | CONFIRMED | editorial | §14 head-size target is unattainable under signed and revocation profiles | 3708-3709, 1352-1358 |
| 41 | MINOR | PLAUSIBLE | security | Selector registry contradicts its own base-scoping claim for `state`, `region`, and `subtree` | 1860, 1864, 1869-1870, 1893-1894 |
| 42 | MINOR | PLAUSIBLE | codecs | Morph section permits initial-weight patches T-19 forbids, and omits the animation gate | 623-627, 640-648, 4262 |
| 43 | MINOR | PLAUSIBLE | codecs | §9.8's Edit B contradicts the interval rule and T-10 | 2498-2500, 3250-3255, 4255 |
| 44 | MINOR | UNVERIFIED | optimizer | The `t_ttc` figures do not reconstruct from §9.8's stated cohort priors | 3222-3226, 2879-2883, 3243, 3269-3272 |
| 45 | MINOR | UNVERIFIED | optimizer | Gate and cap gaps: no mask-representability gate, β range conflict, wrong candidate count | 2751-2790, 2128-2137, 3094, 3713 |
| 46 | MINOR | UNVERIFIED | optimizer | §9.7's head-origin crossover contradicts the coalescing paragraph above it; row 27 codifies it | 3187-3197, 3734 |
| 47 | MINOR | UNVERIFIED | optimizer | §9.2's decidability claim is false for its own gates; `futureDebt` is a dangling symbol | 2747, 2716-2743, 2800, 3304 |
| 48 | MINOR | UNVERIFIED | protocol | No defined client behaviour on a profile-version or digest-suite change | 1258, 1665-1673, 1715-1723, 3910 |
| 49 | MINOR | UNVERIFIED | protocol | `invalidate` has no authoritative form, so the law's headline concurrency case is vacuous | 1570-1584, 1730, 1893-1894 |
| 50 | EDITORIAL | PLAUSIBLE | codecs | §7.3's exclusion argument covers Basis transcode ambiguity, not the supercompression scheme | 224-228, 2386-2405, 4253 |
| 51 | EDITORIAL | PLAUSIBLE | editorial | Two research conclusions assert unmeasured claims unmarked, and one floats free of the body | 4324-4327, 4334-4336, 4370-4375, 464 |

---

## 3. Per-finding detail

### CRITICAL

**#1 — Freshness-profile selector is unauthenticated; entrypoint anti-downgrade check is circular** (security, UNVERIFIED, 1708/1719/1346-1351/1681/1314/4292)
*Claim.* The client learns which freshness profile applies from `freshnessProfile` in the entrypoint, which is digest-bound only under the revocation profile. One rewritten string downgrades signed to unsigned and discards the `generationWatermark`, a signed-only obligation. The revocation defence is circular: `entrypointDigest` lives in the head, reachable only via the entrypoint, so R-05 is unimplementable.
*Evidence.* 1681 concedes "the unsigned and signed profiles do not bind the entrypoint, so a stripped or repointed entrypoint is a downgrade those profiles permit." 1348-1350 claims the pin prevents exactly that, but the digest is obtainable only from a head the stripped entrypoint never names. 1314 scopes the watermark to the signed profile. No rule requires a client to durably remember that an origin/dataset was previously signed or revocation-pinned.
*Suggested fix.* Durable `(origin, datasetId)` record pinning the highest profile ever observed; downgrade below it fails closed. State the bootstrap TOFU rule. Retarget R-05 at that pin rather than the head-borne digest.
*Verifier's note.* No verification pass recorded for this lane. Reported as the finder stated it.

**#2 — Revocation defeated by withholding the head, and by replaying a pre-revocation head to a cold client** (security, UNVERIFIED, 1336-1341/4279-4281/3429-3444/4293)
*Claim.* Expiry means "keep serving the last verified state" and MUST NOT blank content. No deadline ever forces withholding, so a passive attacker who blocks or stale-serves the head keeps revoked content rendering indefinitely; §11 scopes the guarantee to clients "reaching the current head," a condition the attacker controls. Cold start against an expired-but-signed head is unspecified.
*Evidence.* 1339-1341 ("MUST keep serving the last verified state, MUST mark it stale … MUST NOT blank content merely because a statement expired"). F-07 (4279) lets a client that cannot persist the watermark merely *report* it, so cleared storage plus a replayed pre-revocation signed head restores revoked content; R-06 (4293) does not apply because nothing was applied yet. The "persistent deny root" relied on at 3442 is defined nowhere.
*Suggested fix.* Define `maxRevocationStaleness` after which required/current publications withhold; make watermark persistence a hard admission requirement under the revocation profile; require a client with no prior state to reject an expired head; specify the deny root.
*Verifier's note.* Unverified. Note this is the highest-consequence finding in the set if it holds — it targets the one mechanism the design offers for the compromised-content case.

**#3 — `D_max` is derived from a request model that contradicts the state-control-closure law** (protocol, UNVERIFIED, 1523-1528/1624-1634/2911/3473-3484)
*Claim.* §4.2/§10 require the complete state-control closure — every patch descriptor — verified before activation. §9.3.3 charges `d` descriptor fetches per *target* cold load (`n_req(d) = 1 + 2d`), and §12 derives normative `D_max = 16` from it. Both cannot hold: if descriptors are pre-fetched with the state, `D_max` is misderived; if they are lazy, the selector index is incomplete at commit.
*Evidence.* 1624-1626 defines the closure as "every exact patch/tombstone descriptor/selector/write set"; 1632-1634 and 3335 require it complete before commit; 1523-1525 says the descriptor is fetched with it "so the client can build a complete loaded/future-loaded selector index." 2911 nonetheless models `1 + 2d` descriptors individually addressed; 3473-3482 turns that into `A_max = 33` and `D_max = 16`; 3184-3185 calls the derivation "what makes the Section 12 trigger load-bearing rather than advisory."
*Suggested fix.* Decide whether descriptors are state-scoped or target-scoped. If state-scoped, re-derive `A_max`/`D_max` from `1 + d` payload requests and add the descriptor-closure fetch to §9.7's scaling law and §14 rows 11-12.
*Verifier's note.* Unverified, but this is the same fault line as #5 and #24 and drives decision D1 below.

**#4 — Signed head expiry vs 304 revalidation** (protocol, UNVERIFIED, 1301-1310/1326-1364/2020-2033)
*Claim.* `issuedAt`/`expiresAt` sit in the head body, so re-issuing a statement changes the bytes and the strong ETag. Two unaddressed horns: sign only per head move, and any publication gap beyond `maxStaleness` expires every client's statement while the head is still current; or re-sign on a timer, and every revalidation across a re-sign returns 200 with a body, not 304.
*Evidence.* 1327-1328 fixes `expiresAt <= issuedAt + maxStaleness` and recommends `maxStaleness` SHOULD equal `maxHeadRevalidationInterval` — under which a client revalidating at the interval receives a statement expiring at that instant. 1359-1361 rests the CDN economics on "all but the ones that cross a publication return `304` with no body," and §14 row 27 rests on that. 1362-1363 warns only of a *shorter* window; the equal and no-publication cases are never considered.
*Suggested fix.* Move `issuedAt`/`expiresAt`/signature into response fields refreshable on a 304, or require re-issue every `maxStaleness/2` independent of head moves — then re-derive §4.1's sizing paragraph and §14 row 27 for full 200 responses.
*Verifier's note.* Unverified. Interacts with #40 (head size) — moving the signature to response fields resolves both.

**#5 — §9.7 bounds a global manifest with a per-bin cap** (optimizer, UNVERIFIED, 3174-3186/3461-3465/3711)
*Claim.* "Bounding the chain at `D_max = 16` caps `M` at 9,054 B and restores linear growth" is false. `D_max` is a per-*bin* depth cap; `P` in `M(P) = 1134 + 495P` counts every active patch record in the manifest. Under the document's own moving-front deployment each newly touched bin adds records and an untouched bin's patches never retire, so `P(t) = P₀ + g·t` globally and the 51.3 GB/hour result survives the §12 trigger.
*Evidence.* `1134 + 495·16 = 9,054 B` is `P = 16` records TOTAL, not depth 16 in one bin. §12's trigger is per-bin and clears only for that bin (3542-3544). §14 row 4 asserts both "≤ 9,054 B at the per-bin cap `D_max = 16`" and "shard above `P = 256` (125 KiB)" — unreachable if the first holds. The finder re-derived `g·c₀·T + c_rec·g·(P₀·T + g·T²/2) = 16.3 MB + 51.32 GB` at `g = 4/s, T = 3600 s`, matching the document; enforcing `D_max` per bin changes neither term.
*Suggested fix.* Add a normative global cap on active patch records (or bins × depth) to §12, or restate 9.7's bound as Θ(bins × depth) and re-derive the 130.4 MB / 6.5 MB figures. Reconcile §14 row 4's two mutually exclusive clauses.
*Verifier's note.* Unverified, but the arithmetic is self-checking and the §14 row-4 internal contradiction is independently readable.

**#6 — The triad's winner is decided by per-target exposure counts §9.1 forbids as inputs** (optimizer, UNVERIFIED, 2685-2690/2738-2740/3260-3274)
*Claim.* §9.3.5's "none dominates" claim rests on `E`, `E_live`, `F`. §9.1 puts `E`/`E_live` in I3 — one immutable-per-epoch deployment document — and bans live measurement and client properties except as cohort priors. §9.8 then varies them per *target*: 360 because "the tile is remote," 7,500 because "the tile is busy" — aggregated per-tile client traffic, not a per-population prior.
*Evidence.* 2685-2690 bans camera/visible set/cache/session/live measurement (decision 8); 2738-2740 lists `E_live`, `E`, `H` in I3. 3260-3262 varies `E = 360/7,500/22,000` and `E_live = 3/90/140` per edit; 3266-3273 attributes it to tile popularity. Recomputation: row 1 patch-terminal `= 5,618 + 3·1,142.86 + 360·16.70 = 15,058` exactly; substituting row 2's `E = 7,500` flips row 1 to patch-then-rebuild. If `E` is one deployment constant, rows 1 and 2 cannot both exist.
*Suggested fix.* Add a fifth input class — a dated per-bin exposure prior with its own staleness/confidence rules, derived from the base profile's spatial bins — or drop per-target `E` and show the triad separating on producer-side inputs alone.
*Verifier's note.* Unverified. The exact reproduction of row 1 is strong circumstantial support that the finder read the model correctly.

### MAJOR — CONFIRMED

**#7 — 26 conformance rows trace to non-normative sections** (editorial, CONFIRMED, 54-66/4078-4082/4204-4232)
*Claim.* §17 is normative and claims every row traces to a requirement above, but 26 of 138 rows cite only sections the conformance-language table calls non-normative: C-49/50/51 → 3.3.6, C-81–C-85 → 3.4.x, C-86–C-96 → 3.3.x/3.4.x, C-73–C-80 → 9.3.x/9.4/9.6, C-07 → 2.4.
*Evidence.* Line 60 lists "1, 2.1-2.4, 3, 6, 14, 15 other than 15.0, 16, 18, 19" as non-normative; line 61 makes "9 other than 9.2" non-normative; line 58 says every §17 row "traces to a requirement above." The line-66 bridge fails: the compositor-vehicle, pinning and admission-gate obligations of C-86/C-88/C-90/C-91 exist only in 3.3.3 and are restated nowhere in 9, 10 or 12. C-30 (4135) also cites "4.4 laws 9-10, 13"; §4.4 has exactly ten client laws.
*Suggested fix.* Promote the obligation text of 3.3.2-3.4.4 and 9.3-9.6 into normative sections and update the 54-64 table, or restate each row's requirement in §10/§12 and repoint the Body column. Fix the C-30 "law 13" citation.
*Verifier's note.* **Confirmed by row scan: 138 rows, exactly 26 citing only non-normative sections.** The 63-64 bridge fails twice — it points at §9, itself non-normative but for 9.2, and `cacheBytes`/admission-gate/pinning appear only in 3.3.3 and decision 34. Caveats: the finder's groupings over-enumerate slightly (C-84 also cites 9.4), and "law 13" may be a §13 reference.

**#8 — Normative compaction trigger depends on a non-normative, never-required schema** (editorial, CONFIRMED, 3453-3466/61/2718-2731)
*Claim.* §12's normative trigger — the sole structural bound the terminal-patch argument rests on — is decidable only from `depth(b)`/`deltaBytes(b)`/`applyCost(b)`, which exist only in `activeSummary`, defined in §9.1 and declared non-normative producer policy. Nothing normatively requires a publisher to emit those fields.
*Evidence.* 3455: "All three quantities are already carried per bin by `activeSummary` (Section 9.1), so the rule adds no schema." Line 61 simultaneously says the extension "standardizes … the metadata of 9.1" and marks 9-other-than-9.2 non-normative. §9.1's own obligation is lowercase (2730) and so imposes nothing per lines 50-52. §17.5 does not list the `activeSummary` field set among untested requirements.
*Suggested fix.* Move the `activeSummary` per-bin field set and its atomic-publication rule into a normative subsection, mark it in the 54-64 table, and add a conformance row plus a 17.5 entry for the fields C-69/C-72 already assume.
*Verifier's note.* **Confirmed**: `activeSummary` defined only at 2714 in non-normative 9.1, all obligations lowercase, used normatively at 3457/3572, tested by C-69/C-72, absent from 17.5; line 61 self-contradicts. Weaker half: the producer holds the quantities internally regardless, so what breaks is testability, not the MUST itself.

**#9 — "No JavaScript or shader source" under-covers the MVP payload** (security, CONFIRMED, 3645-3646/4239/2083-2087/3630/247-251)
*Claim.* The one content-level guard rejects only executable JavaScript and shader source, but the MVP replacement is always a valid 3D Tiles tileset carrying styling expressions, metadata schemas and arbitrary glTF/tileset extensions, none of which trip C-98. Nothing forbids a replacement tileset carrying the live-update extension itself with its own `headUri`.
*Evidence.* 2083: "The MVP replacement is always a valid 3D Tiles tileset." 3645 names only JavaScript and shader source. A nested control plane inside replacement content defeats decision 33's "one cache, one byte budget, one request budget, one statistics record, and one swap owner" (247-251) and escapes the 3.3.3 admission gate. The 3630 "cross-resource references and cycles" bullet is about resource graphs and does not reach it.
*Suggested fix.* State that the live-update extension MUST NOT appear inside replacement or patch content and that `extensionsRequired` there rejects; add an allowlist or exclusion for styles, metadata schemas and glTF extensions, with §13 limits.
*Verifier's note.* **Confirmed.** 3645 is the sole content-level guard; nothing across 4,436 lines bounds what a replacement tileset may contain — no mention of styling expressions, metadata schemas or glTF extensions anywhere, and `extensionsRequired` occurs only at 1699 and 3406, both about the host entrypoint. The nested control plane is genuinely unaddressed. Pairs with #39.

**#10 — Interval rule admits lowering edits that escape the header bounding sphere** (codecs, CONFIRMED, 2498-2519/4256)
*Claim.* §8.1 asserts lowering leaves the bounding sphere and occlusion point conservative, and T-11 requires re-proof only for edits that RAISE a height. The header sphere bounds the original vertex set; containment is not preserved under radial contraction, so a lowering edit inside the interval can put a patched vertex outside the culling volume while passing every gate.
*Evidence.* L2513-19 states the claim. Engine-verified: `QuantizedMeshTerrainData.js:273` passes the header sphere straight into `TerrainMesh`, never refitted; only the occlusion point is recomputed, and only when `minimumHeight < 0` (`createVerticesFromQuantizedTerrainMesh.js:178-188`). Counterexample: a high-LOD cliff tile with relief ≈ its half-width `r`, sphere centred near the max-height corners, radius ≈ `r`; lowering a corner to `minimumHeight` puts it ≈ 1.41`r` out.
*Suggested fix.* Require the producer to verify every changed decoded position still lies inside the declared bounding sphere and OBB in both directions, selecting rung 2 otherwise. Delete the "lowering is conservative" claim; widen T-11.
*Verifier's note.* **Confirmed against engine source** (header sphere parsed `CesiumTerrainProvider.js:881`, passed verbatim at `QuantizedMeshTerrainData.js:273`; only the OBB is interval-derived at :1063). Caveat: 3D culling uses the OBB (`GlobeSurfaceTileProvider.js:963`), so "a hole" overstates the symptom — the real exposure is `boundingSphere3D` as command volume.

**#11 — Implicit-tiling cost claim conflates content-addressed storage with cache reuse** (codecs, CONFIRMED, 586/658-668/1875-1878/3712)
*Claim.* The document correctly notes implicit subtree/content URIs are coordinate-templated, not content-addressed, then says a base-revision bump costs only the changed subtree files. Digest reuse is an origin-*storage* property: under a new prefix every templated content URI is new, so every browser and CDN entry for the implicit tree misses and the visible working set is refetched.
*Evidence.* L658-61 vs L665-67 ("Its closure reuses every unchanged content object by digest, so the cost is the changed subtree files plus the new root, not the dataset"). `ImplicitSubtreeCache.js:81-93` keys on coordinates alone. For a producer changing the world several times a second, any subdivision change is a full cache flush.
*Suggested fix.* State the transfer cost of a base-revision bump for implicit datasets; then either keep the template prefix stable and version only subtree files, or record a bound on base-revision frequency as a known limitation.
*Verifier's note.* **Confirmed — the document refutes itself** at L658-61 vs L665-67/L3613-16. One sub-claim does *not* hold: §14 row 5 covers a patch, not a base bump, so it is not falsified.

**#12 — No derived-data or seam-closure gate for glTF position overrides** (codecs, CONFIRMED, 2240/2319/4245/4260)
*Claim.* The terrain profile is rigorous about geometry-dependent derived data; the glTF codec is not. §7.1 lists normal/tangent data as *optional* and its only row tests layout, count, quantization and index order. An override listing indices for one primitive silently cracks the surface at every seam-split duplicate and every other primitive sharing those positions.
*Evidence.* L2319 ("- optional associated normal/tangent data;") vs T-15 (L4260) for terrain, where omitted normals rejects and single-tile normal recompute is forbidden. Cesium does not recompute NORMAL when present, so the failure mode is identical. §6.1 names both hazards (L2240) but §7 never converts either into a gate; T-01 covers only mismatch and index ordering, while `submeshReplace` does get a collar rule (L2376-81).
*Suggested fix.* Add to §7.1 a normative rule mirroring §8.1's normal rule (a POSITION override omitting NORMAL/TANGENT on a bearing primitive rejects) plus a write-set-closure rule covering every co-located duplicate across primitives; add rows.
*Verifier's note.* **Confirmed.** The only glTF normals language is rhetorical ("it binds the derived-data obligations," L2357), never normative. Grep confirms no seam or write-set-closure rule anywhere in §7.

**#13 — MVP-core rows impose multi-component and fallback duties §2.2 excludes** (editorial, CONFIRMED, 303-330/4098/4149-4150/4262/3863)
*Claim.* §2.2's MVP core lists "one immutable base revision" and never mentions multi-component states, `materializedFallbacks`, or coupled terrain/imagery — yet C-04/C-05/C-40 make in-state fallbacks MVP-core and C-39 makes multi-layer terrain/imagery atomicity MVP-core, while T-17 tags the same terrain+imagery requirement typed-profile.
*Evidence.* Line 307 vs 4149 (C-39 "multi-layer terrain/imagery/object frontier … MVP-core") and 4262 (T-17 "… typed-profile | 8.4"). Scenario 10 (3863) tags its multi-layer leg MVP-core. The 2.2.1 phase table defines no tag for multi-component composition at all.
*Suggested fix.* Decide the phase once: add multi-component states, `materializedFallbacks` and coupled imagery to the §2.2 MVP-core list and retag T-17 MVP-core, or demote C-39/C-40/C-04/C-05 and the scenario-10 multi-layer leg to a declared profile tag.
*Verifier's note.* **Confirmed** on the C-04/C-05/C-40 and scenario-10 legs. Weak leg: 2196 already calls coupled activation MVP-core and T-17 cites §8.4 (the quantized-mesh sibling), so the T-17/C-39 conflict may be a tag-scope artifact rather than a contradiction.

**#14 — §17.5 declares two body MUST/MUST NOT requirements "not required"** (editorial, CONFIRMED, 2143/3515-3516/4314/4319)
*Claim.* §17.5 exists to justify normative requirements carrying no conformance row. Two entries instead deny the requirement is normative, contradicting the normative body text they cite.
*Evidence.* Normative §5.4 line 2143: "lookup MUST NOT scan the whole patch catalog," answered at 4314 with "Measured rather than asserted … A pass/fail row would freeze a performance number." Normative §12 line 3515: "A deployment that cannot satisfy the inequality MUST shard the bin, reduce `g`, or accept a larger `D_max`," answered at 4319 with "Measured, not required."
*Suggested fix.* Add conformance rows for both — a structural row asserting sublinear mask lookup independent of the microsecond target, and a producer-profile row asserting the sharding/rate/`D_max` response — or downgrade both to SHOULD and say so in 17.5.
*Verifier's note.* **Confirmed**, with an extra defect: 4314 restates the MUST NOT in lower case, which lines 50-52 say imposes nothing. The neighbouring sharding MUST is handled honestly elsewhere, so this reads as an oversight rather than a policy.

**#15 — §16 questions 1-3 are already answered normatively, and §5.3 contradicts itself** (editorial, CONFIRMED, 3926/3941-3942/2063/2116/2137/4164)
*Claim.* §16's own rule is that a question the body now answers normatively is deleted with a pointer. Q2 (mask target) and Q3 (WGS84 prism) are both answered by normative §5.3; Q1's "which passes the first profile declares" is answered for three passes by MVP-core rows C-49/50/51. §5.3 also contradicts itself on content groups.
*Evidence.* Line 3926 states the rule. Line 2116 (normative) requires a "WGS84 geodetic surface polygon applied only to a declared continuous 2.5D surface content group"; line 2137 defers "named content groups" to after the surface profile is proven; 2063 shows `"targetContentGroup": "surface-elevation"`. Lines 4164-4166 make shadow, classification and temporal passes MVP-core while Q1 (3941) still reads "Open."
*Suggested fix.* Delete Q2 and Q3 with pointers to §5.3 or state what remains open past it; reconcile 2116 against 2137; narrow Q1 to the query passes only.
*Verifier's note.* **Confirmed.** Q2 and Q3 are bare questions with no answer text while normative §5.3 states the answer — either way 3926's rule breaks. Softening: §5.3 is a SHOULD, and Q1's genuine residue is the query passes.

### MAJOR — PLAUSIBLE

**#16 — §13's limit table is incomplete against the codec registry** (security, PLAUSIBLE, 3654-3666/784-785/1535-1536/4238/4019)
*Claim.* 3654 states that a limit which is not declared cannot be enforced or tested and that every bound MUST carry a concrete value. The table covers four codec classes and omits `featureMetadataOverride`, `instanceTransformOverride`, the MVP-core `replaceRegion`, the tombstone operation, and `replaceContent`. No concrete value appears anywhere.
*Suggested fix.* Extend the table to every operation the document defines, and add the per-profile-class default table question 20 already owes, so C-97 has something to exercise.
*Verifier's note.* **Plausible.** Real: `replaceContent` is a specified typed codec (§5.5, 340, T-07/T-18) absent from the 3660-3666 table, and the tombstone/revocation "explicit limits" (1535-1536) are never given. Weaker: `replaceRegion` axes sit in the 3626 bullets and §5.3; the two omitted codec names have no profile yet and are caught by the general codec MUST; and values are deployment-declared *by design* (3654), so "nothing is quantified" is partly a category error.

**#17 — T-13's cross-LOD edge-position agreement test is unsatisfiable** (codecs, PLAUSIBLE, 2526-2537/2622-2624/4258)
*Claim.* The boundary rule demands the atomic set hold every tile owning a coincident edge vertex — same-level neighbour *and* every coarser or finer representation — then requires decoded edge positions across that set to agree. Vertex coincidence is real only between same-level neighbours.
*Evidence.* L2531-37 states both halves; T-13 freezes them as one row. The document itself cites why LOD edges do not match — skirts, L2538-42, `skirtHeight = getLevelMaximumGeometricError(level) * 5.0` (verified `CesiumTerrainProvider.js:1055`). The genuine cross-LOD hazard (a coarser tile still showing the un-flattened hill) is a surface-coverage obligation already carried at L2489 and rung 5.
*Suggested fix.* Split into (a) same-level edge-vertex coincidence with a positional-agreement test and (b) cross-LOD surface coverage with no vertex-level predicate. Split T-13 to match.
*Verifier's note.* **Plausible.** Real tension: membership is "owns a coincident edge vertex" then glossed to "every coarser or finer representation covering that edge" — two predicates in one row. But unsatisfiability is unproven: tile *corners* are coincident across levels, and the agreement bullet plausibly scopes to coincident vertices only. Settled by the document saying which it means.

### MAJOR — UNVERIFIED

**#18 — Unsigned MVP profile has no generation floor at all, yet C-63 is tagged MVP-core** (protocol, 1341-1342/1831-1832/3327-3330/4188)
*Claim.* The only rule binding a client's acceptance of a lower-generation head sits inside the signed profile and is enforced by the durable watermark. No session-scoped floor is stated anywhere, so under the MVP profile a stale-serving intermediary can walk a live client back from generation 42 to 41, re-activating operations a verified transition already retired.
*Evidence.* 1341-1342 sits under "**Signed profile**" and is scoped by the watermark bullets at 1314-1324. 3383-3385 concedes "under the unsigned profile the client has no floor and reports that it has none." 3327-3330 requires the head to pass "its declared profile's checks … including the durable `generationWatermark`" — an empty obligation under `unsigned`. C-63 is MVP-core and cites law 5, but law 5 (1831-1832) is a *publisher* rule about how rollback is published.
*Suggested fix.* Add a profile-independent client law: never activate a head whose `generation` is below the highest verified in the current session. Scope the watermark bullets to durability across restart rather than to monotonicity itself.
*Verifier's note.* Unverified. Cheapest high-value fix in the set if it holds — one sentence.

**#19 — Retention arithmetic bounds cache revalidation, not origin freshness** (protocol, 1283-1284/1942/1950-1956/4189/4195)
*Claim.* The four-constant retention floor is justified because "an anonymous HTTP reader is bounded by the constants it is required to honor." A client honoring `maxHeadRevalidationInterval` against an intermediary serving an old head revalidates on schedule and still never learns of the new head, staying pinned to a retired state past `retainUntil`.
*Evidence.* 1283-1284 states the hazard; 1950-1954 states the floor then "There is no reader lease and no server-side session registry." 1942 defines `propagationWindow` as a declared allowance, not a ceiling on undetected stale serving. C-64 and C-101 are both MVP-core.
*Suggested fix.* Make the signed profile a precondition for the retention derivation, or add a declared constant bounding maximum intermediary staleness; state plainly that under `unsigned` a pinned reader may lose its closure mid-session.
*Verifier's note.* Unverified. Same root as #1/#2/#18 — the unsigned profile's threat model.

**#20 — `closureDigest` is undefined, leaving the descriptor-to-replacement-root hop unauthenticated** (protocol, 1215-1247/1675-1692/2070-2074)
*Claim.* §4.3 asserts "The digest chain has no unauthenticated hop," but the MVP's only operation binds its replacement through a field the document never defines: `replaceRegion`'s `replacement` block carries `tilesetUri`, `resourceManifestUri` and `closureDigest` — no digest over the replacement tileset JSON, and no `resourceManifestDigest`.
*Evidence.* The §4 identity table (1215-1247) defines `stateDigest`, `baseDigest`, `resourceManifestDigest`, `descriptorDigest`, `payloadDigest`; `closureDigest` is absent from it yet used at 1768, 1922, 2073 and 2180. The base block at 1403-1409 carries `resourceManifestDigest` and `baseDigest`; the replacement block does not. 1687 claims the hop is covered by "the same resource-manifest mechanism," which that payload does not instantiate.
*Suggested fix.* Define `closureDigest` in the §4 table (what it hashes, canonical record form, whether it covers the root descriptor) and add `resourceManifestDigest` plus a root-descriptor digest to the `replaceRegion` replacement block.
*Verifier's note.* Unverified, but this is a checkable, bounded editorial fact — worth confirming first among the protocol set.

**#21 — No origin or trust-domain confinement of closure URIs** (security, 1677-1690/1246/3629/3642/4238/3906)
*Claim.* The table headed "Every authority hop is covered" covers byte integrity only. `trustDomainId` is defined as the entrypoint origin but constrains no URI: state, base, resource-manifest, descriptor, payload and replacement URIs are unconstrained, and digests verify over whatever arrives from wherever. A verified state can steer a client fleet at third-party origins; credentialing is unstated.
*Evidence.* 1690 names only the hint and the entrypoint as uncovered hops. §13 asserts the bound as bare bullets (3629, 3642) without stating any rule, and 15.3 defers URI resolution to S1 — so C-97 tests "cross-dataset targets fail closed" with no definition of the term.
*Suggested fix.* State normatively that a state's closure resolves within the declared trust domain by default, with cross-origin objects listed in a machine-readable allowlist in the deployment declaration; state the credentialing rule; give C-97 a testable definition.
*Verifier's note.* Unverified. Note the integrity-vs-provenance distinction is correct in principle regardless of how the document reads.

**#22 — Retention law obliges the publisher to keep serving revoked bytes** (security, 1649-1655/1966-1975/1736-1737)
*Claim.* `revoke` is the security/corruption action, yet §4.3 forbids deleting a referenced immutable object and says invalidation never purges one, while §4.5's retention floor keeps the pre-revocation state and its closure reachable at stable content-addressed URLs. No rule permits early purge, so revocation edits authority and never removes the compromised bytes.
*Evidence.* 1650, 1654-1655; the §4.5 arithmetic is a MUST-NOT-earlier bound on `retainUntil` with no revocation carve-out; `withdraw` (1736) governs removal of the *record*, never the bytes.
*Suggested fix.* Add a normative revocation-purge rule overriding the retention floor for the revoked closure alone, specifying how still-reachable states referencing it are retired and their entrypoint roots repointed first.
*Verifier's note.* Unverified. Decision-shaped — see D7.

**#23 — Hint rate limiting and dedup are keyed on attacker-chosen identifiers** (security, 1846-1851/1830-1832/4135-4136)
*Claim.* Law 9 resolves every anomaly, including an unknown epoch or unknown dataset, as one reconciliation rate-limited per `(trustDomainId, datasetId)`, tested by C-30 as "Flood is bounded." Both identifiers arrive in the unauthenticated hint, so an attacker mints unbounded keys, each with its own bucket and dedup/epoch record; the dedup window has no declared size.
*Evidence.* 1847-1850. For an unknown dataset the client holds no `headUri`, so the mandated action names an operation it cannot perform. Law 10's "an over-rate transport is throttled or dropped" is the only global control and is stated as an aside.
*Suggested fix.* Require a global per-transport budget above the per-key limit; drop hints whose `datasetId` was never bootstrapped before any scheduling or record creation; declare a maximum dedup-table and epoch count with an eviction rule.
*Verifier's note.* Unverified. The "unknown dataset ⇒ reconcile a head you have no URI for" observation is independently checkable and, if right, is a plain drafting bug.

**#24 — Compaction trigger is undecidable: bin partition, `baseBytes(b)` and `loadCost(b)` undefined** (protocol, 2698-2720/3456-3458/3486-3493)
*Claim.* §12 claims the trigger "adds no schema" because `activeSummary` carries the three left-hand quantities. Predicates (B) and (C) compare them against `baseBytes(b)` and `loadCost(b)`, which appear in no declared document, and the spatial-bin partition is never defined, so conforming producers get different answers to a MUST.
*Evidence.* 3456-3458 vs 3487 and 3492-3493. `activeSummary` (2717-2720) lists only `depth(b)`, `deltaBytes(b)`, `applyCost(b)`; `baseProfile` (2698-2707) carries spatial bins and whole-content byte totals — no per-bin base bytes or load cost.
*Suggested fix.* Add per-bin `baseBytes` and `loadCost` to `baseProfile` bound to `baseDigest`, and make the bin partition a declared, digest-bound property of the base revision so the predicate is reproducible and C-69/C-70 are testable.
*Verifier's note.* Unverified, and directly compounds #8 (confirmed): the trigger is both non-normatively sourced and, per this finding, underspecified on its right-hand side.

**#25 — Compaction trigger has no clearance guarantee** (protocol, 3468-3471/3503-3518/3571-3572)
*Claim.* The trigger is a level predicate with a mandatory action, and only the depth predicate gets a liveness envelope. Nothing bounds the surviving rebased tail against the new base, so a hot bin can emerge from compaction still violating (B) or (C): the predicate stays fired, `patch-terminal` is permanently inadmissible, and compaction is permanently rescheduled.
*Evidence.* 3468-3471, 3571-3572, 3503-3504 ("a deferred trigger is still a fired trigger"). The hot-stream envelope at 3507-3518 is derived for (D) only.
*Suggested fix.* Require compaction to reduce every fired predicate below threshold or escalate (writer fence, bin shard); give (B) and (C) an arrival-rate envelope analogous to `ρ = C_wall·g/D_max`; add a conformance row for a bin that cannot clear.
*Verifier's note.* Unverified.

**#26 — Commit-frontier recomputation has no progress bound** (protocol, 1119-1120/3340-3342/3716/3866)
*Claim.* §10 requires recomputing the activation frontier at the commit frame and deferring if it expanded past prepared coverage. No hysteresis, deferral cap, prediction margin or escalation is stated, and the primary deployment is continuous camera motion plus several publications per second — so a conforming client can defer indefinitely.
*Evidence.* 3340-3342 and 1119-1120. §14 row 9 targets p95 time-to-current ≤ 3.0 s; scenario 13 states convergence only "after the stream stops," which unbounded deferral satisfies while failing in motion.
*Suggested fix.* Cap consecutive frontier-expansion deferrals, require a prediction/hysteresis margin on prepared coverage, and on cap exhaustion either commit under a declared partial-coverage policy or report a bounded degraded state.
*Verifier's note.* Unverified. This is the one finding whose failure mode is most directly observable in a prototype — a good early P0/P1 experiment.

**#27 — Coupled imagery component's resource closure is unbounded, unpriced, not revision-scoped** (protocol, 670-673/1514-1517/2632-2634/3140-3152)
*Claim.* §4.2 requires each component's resource manifest to bind its complete transitive immutable closure, and §8.4 makes the imagery component mandatory for coupled activation. For an imagery pyramid that is a per-revision enumeration; nothing bounds or prices it. Imagery URLs are also coordinate-derived, with no revision-scoping rule.
*Evidence.* 1514-1517, 2632-2634. §9.7 measures only the state manifest `M(P) = 1134 + 495P`, and §14 row 4 likewise. 670-673 states revision-scoping for `ImplicitSubtreeCache` alone.
*Suggested fix.* Give the terrain/imagery component profiles an explicit closure model (bounded manifest, or a revision root plus a declared derivation rule rather than enumeration), price it in §9.7, and state revision-scoping for all coordinate-derived component caches.
*Verifier's note.* Unverified, but note it is the same coordinate-derived-URI hazard the codecs lane **confirmed** for implicit tiling (#11), which raises prior confidence.

**#28 — §14's residual frame budget is incompatible with the permitted overlay depth** (optimizer, 3720/3723/3094-3096/3300-3303)
*Claim.* Row 13 caps residual cost at 97 µs/frame/bin at `d = 1` and 250 µs/frame total across all bins — at most ~2.6 bin-overlays in view. But `D_max` is permitted in [8, 32], recommended 16, and §9.8 row 4 requires `D_max ≥ 26` for the hot producer. One bin at `d = 16` costs 1,552 µs/frame: 6.2× the total budget, 9.3% of a 16.7 ms frame.
*Evidence.* 3720 vs 3723 and 3094-3096; 3229-3232 gives 97 µs/frame/overlay "linear in `d`". §12 predicate (C) bounds cold-load apply cost against `loadCost(b)`, not per-frame residual; §9.2's "persistent CPU/GPU frame budget" cap is named but given no value.
*Suggested fix.* Derive `D_max` from the frame budget as well as from request amplification — row 13 implies `D_max ≈ 2` — or raise row 13 and drop the 1.5%-of-frame claim. Make the per-frame residual budget a normative §12 predicate.
*Verifier's note.* Unverified. Decision-shaped — see D3.

**#29 — Two incompatible amortization rules at the same λ/q** (optimizer, 2921-2936/3284-3292)
*Claim.* §9.3.4 mandates `α = 1/k` with `k = 7.39` at `λ = 4/s, q = 0.5 s`, giving ≈111 cu of debt per overlay on an 824 cu compaction. §9.8 row 4 restates `k = 7.39`, then prices at `C_compact/D_max`: 103.0/51.5/25.8 cu at `D_max = 8/16/32` — 4.31× apart at `D_max = 32`. And if the debounce governs, a rebuild fires every 1.85 s, so `ρ = 1.73` at every `D_max` in the table, destroying row 4's "at 32 it is 40% occupied."
*Suggested fix.* State that a cap-forced compaction amortizes over `D_max` while `α = 1/k` applies only to debounce-scheduled rebuilds, give the rule for which fires first at a given `(λ, q, D_max)`, and re-derive row 4's `ρ` under the binding one.
*Verifier's note.* Unverified. Back-solving (103.0·8 = 51.5·16 = 25.8·32 ≈ 824 cu) is arithmetically self-checking.

**#30 — `b_wire` and `n_req` are charged at two aggregation levels** (optimizer, 2823-2845/2895-2907/3229-3232)
*Claim.* §9.3.1 says "No term appears at more than one level. A term multiplied twice is a defect," and lists `b_wire` and `n_req` at level T only. §9.8's 16.70 cu per exposure per overlay — an R-level quantity multiplied by `E` — contains 3.624 cu of wire and 1.0 cu of requests, 27.7% of it. `n_req` is also overloaded: critical-path requests at T, cold-load amplification `n_req(d) = 1 + 2d` at R.
*Evidence.* The finder reproduced the residual exactly: `16.70 = 0.05·(232.8 + 4.53) + 0.5·2 + 2e-5·181,200 + 1e-7·2.1e6`. The only R-level symbols declared are `t_resid` (ms) and `m_run` (bytes); neither has units of transferred bytes or requests.
*Suggested fix.* Split the symbols: keep `b_wire`/`n_req` at T, add distinct R-level cold-load wire/request terms, and name §9.3.3's amplification separately so C-80's "undercount wire bytes" mutant has a defined target.
*Verifier's note.* Unverified. The exact reproduction is strong support.

**#31 — Stage 2 pushes `costHi` above the Stage-1 `costHi`** (optimizer, 3023-3043/3106-3110/3262-3283)
*Claim.* In row 3 → 3′ Stage 2 adds +37,777 cu to both patch candidates and leaves rebuild-now unchanged. If row 3's figures are `costHi` — as §9.4's sort and margin test require — measurement landed 14% above the declared upper bound, voiding `confidencePass`. If they are not `costHi`, Stage 1 compared the patch at its low endpoints against the rebuild's estimate: the asymmetry C-75 forbids.
*Evidence.* 3040-3043 ("Every comparison is between `costHi` values"); 3262-3264; 3278-3280 gives post-measurement intervals implying Stage 1 used the low endpoints; 3106-3110 says Stage 2 "tightens only the terms whose interval width causes the overlap" — a tightening cannot raise `costHi`.
*Suggested fix.* State that Stage 1 evaluates `costHi` at the pessimistic endpoint; require Stage 2 to re-measure every candidate in the overlapping pair; require the post-Stage-2 point to lie inside the Stage-1 interval or record an estimator-calibration failure.
*Verifier's note.* Unverified.

**#32 — §14 rows 9 and 10 are falsified by the document's own second worked edit** (optimizer, 3716-3717/3269-3272/3280-3281)
*Claim.* Row 9 sets a blanket p95 time-to-current ≤ 3.0 s and row 10 a blanket ≥ 10× reduction, both derived from Edit A alone. Edit B — presented in the same section as a realistic structural cross-LOD edit — gives patch `t_ttc` = 3,475 ms (3,985 ms after Stage 2) and a ratio of 1.16× (1.01× post-Stage-2). No workload mix is stated over which the p95 holds.
*Suggested fix.* Scope rows 9 and 10 to the Edit-A class (reference scenarios 1-3), add a separate weaker target for structural cross-LOD edits, and state the workload mix the p95 is taken over.
*Verifier's note.* Unverified. Directly readable from the document's own tables; likely to hold.

**#33 — Stage 2 has no wall-time budget and its own cost is charged to no candidate** (optimizer, 3103-3118/3278-3283/3713)
*Claim.* §14 row 6 budgets Stage 1 at p95 ≤ 200 µs, but §14 has no Stage-2 row and §9.6 bounds Stage 2 only by undeclared "strict maximum bytes, blocks, and wall-time." In §9.8 row 3, Stage 2 encodes the mask and reports 2,600-3,100 ms — the whole patch production it was estimating, ≈12× the 250 ms inter-arrival budget at `g = 4/s`. Row 3′ then picks rebuild-now, so that work is discarded and priced nowhere.
*Evidence.* With `margin = 0.20` (3082) and ~14 candidates constructed, the closeness test fires whenever the top two sit within 20%, so Stage 2 is a common path.
*Suggested fix.* Add a §14 row for Stage-2 wall-time tied to `1/g`, and either add a P-level optimizer-work term or charge Stage-2 encode time to the selected candidate's `t_prod`.
*Verifier's note.* Unverified.

### MINOR

**#34 — Water mask treated as geometry-independent; T-12 forbids changing it at rung 2** (codecs, CONFIRMED, 699-701/2610-2615/4257)
A height edit crossing sea level makes a preserved water mask wrong. L700-01 gives metadata a truth condition and the water mask an unconditional MAY; T-12 then makes rung 2 reject any payload altering it. *Fix:* give the water mask metadata's truth condition and state that an edit invalidating it forces rung 4 — or define the promised water-mask stream and place it on the ladder and in §3.1. *Verifier:* **Confirmed** — the promised escape hatch exists nowhere: no water-mask codec in the Layer-B list (L787-798), and rung 4 triggers on "unknown geometry-dependent extension records" (L2617) while the mask is a *known* record.

**#35 — Rung 1 is the "fastest path" but its client apply is O(vertexCount)** (codecs, CONFIRMED, 87/2604-2607/3712-3733)
The rung-1 wire payload is genuinely sparse, but applying it in this engine forces skirt regeneration, `hMin` re-derivation and a `TerrainEncoding` refit that re-encodes every vertex. *Fix:* state the O(vertexCount) apply cost in §8.3, add a terrain apply-cost row to §14, and scope §1.1's sparse-GPU-upload claim to the glTF codecs. *Verifier:* **Confirmed against source** — skirts regenerated and `hMin` re-derived over all four edge lists (`createVerticesFromQuantizedTerrainMesh.js:178-190`); `TerrainEncoding` takes quantization from the AABB and height range (`TerrainEncoding.js:53-77`) and every vertex is re-encoded (:249, :274). §14 has no terrain row at all. Caveat: L87 is a hedged goals bullet, not a promise.

**#36 — Normative reporting obligations with no defined diagnostic surface** (editorial, CONFIRMED, 3655-3657/4238/4099/4226/3901-3922)
At least eight normative requirements oblige a client to report something, and C-97 makes "the client reports which limit fired" a testable MVP-core criterion, but nothing defines a report format or code set and §15.3's apparatus list has no entry for one. *Fix:* add a diagnostic and limit-report vocabulary row to §15.3 (enumerated condition codes plus the object each report names), and either bind the reporting rows to it or soften them to SHOULD until it exists. *Verifier:* **Confirmed** — all cited obligations verified; §15.3's table has six rows and no condition-code or report-shape entry.

**#37 — Signed and revocation profiles carry 18 conformance rows but no §15 phase** (editorial, CONFIRMED, 341-342/3752-3777/3799-3813)
§17.3/17.4 define ten F- and eight R- rows while 2.2.1 admits §15 schedules no phase for signed-profile, yet normative 15.0 loads the full signed and revocation fixture burden onto P0. *Fix:* add explicit P7 (signed freshness) and P8 (authenticated revocation) rows, point 2.2.1's "Where it lands" column at them, and scope 15.0's fixture obligations to those phases. *Verifier:* **Confirmed** — F = 10, R = 8; the phase table holds R0-R2, D1-D2, P0-P6, V1-V3, B1, I1, S1-S2 with no signed or revocation deliverable.

**#38 — Two Layer-B codecs declared then never specified, tagged, gated, limited, or tested** (editorial, CONFIRMED, 786-787/340/3660-3666/4297-4322)
`featureMetadataOverride` and `instanceTransformOverride` appear only at 786-787: no §7 definition, no 2.2.1 phase tag, no §9.2 gate, no §13 limit axis, no conformance row, no 17.5 entry — while §2.1 explicitly promises "feature metadata" and "instances and transforms" coverage. *Fix:* give both a §7 subsection with gates, limit axes, typed-profile row and 2.2.1 tag, or delete them from §3.1 and record them as deferred envelope coverage under §2.1 with a 17.5 entry. *Verifier:* **Confirmed** on all six counts. Imprecise clause: §17's orphan check covers normative requirements and §3.1 is non-normative, so it is not strictly a check failure.

**#39 — No extension placement or nesting rules** (editorial, CONFIRMED, 1694-1717/1880-1886/3906)
The extension object is shown exactly once, on a bootstrap entrypoint; nothing states where in a 3D Tiles document it may legally appear, nor what a client does when an external tileset inside a base closure declares its own `VENDOR_3d_tiles_live_update` with a different `datasetId` or `headUri`. *Fix:* normative placement rule (entrypoint tileset object only, with a stated outcome for a nested declaration), a conformance row for the nested case, and a 15.3 apparatus entry for placement and `extensionsRequired` propagation. *Verifier:* **Confirmed** — `extensionsUsed`/`extensionsRequired` occur only at 1698-1699, 1716 and 3406, all at the entrypoint, while §4.4's canonical locator chains the external-content index, putting nested tilesets squarely in scope. **This is the same hole as #9 from the other side.**

**#40 — §14 head-size target unattainable under signed and revocation profiles** (editorial, CONFIRMED, 3708-3709/1352-1358)
Row 1 sets an unscoped ≤ 512 B target (measured 403 B, unsigned shape); §4.1 papers over the signed overrun by citing "the roughly 1 KB discovery budget of Section 14," which §14 states for the *hint*, not the head. *Fix:* split row 1 into per-profile targets with a measured value for each, and correct §4.1's citation. *Verifier:* **Confirmed on the citation defect.** Correction to the finder's arithmetic: 1355 puts the signature in response fields, not the body; measured 403 B unsigned, 472 B signed (**passes** 512 B), 565 B revocation (**fails**) — so the gap is narrower than "640-740 B" but real for the revocation profile.

**#41 — Selector registry contradicts its own base-scoping claim** (security, PLAUSIBLE, 1860/1864/1869-1870/1893-1894)
Line 1860 introduces the table as "Normative selectors are typed and base-scoped," but `region` (1870) requires no component or base digest at all — the only render selector without one. *Fix:* add `componentId` and `baseDigest` to the `region` row. *Verifier:* **Plausible — the `region` half only.** The other halves fail: 1884-1888 define explicit and implicit root locators as digest-bearing so `subtree` *is* bound, and a state digest is already a content address so the trust-domain qualifier on `state` is belt-and-braces.

**#42 — Morph section permits initial-weight patches T-19 forbids** (codecs, PLAUSIBLE, 623-627/640-648/4262)
L627 permits "change initial morph weights or animation data" while L646-48 forbids weight-encoded updates and T-19 makes that a hard reject; the actual gating mechanism (`ModelAnimationChannel` writes node morph weights every frame while a channel targeting them runs, silently overwriting a patch to authored weights) is never named as a precondition. *Fix:* restrict the permitted case to authored default weights on nodes no animation channel drives, and make T-19 test that precondition rather than producer intent. *Verifier:* **Plausible** — the MAY/reject conflict is real and T-19 does test intent, but the document does draw the distinction (L585, L646) and does name the mechanism (L640-42).

**#43 — §9.8's Edit B contradicts the interval rule and T-10** (codecs, PLAUSIBLE, 2498-2500/3250-3255/4255)
Edit B is introduced on the premise that removing a height extremum matters, which the revision's own interval rule deleted (T-10). *Fix:* drop the extremum clause from Edit B and justify the candidate from LOD span and collar cost alone. *Verifier:* **Plausible** — the clause is vestigial and worth cutting, but "contradicts" is unproven: Edit B is a `replaceRegion`/3D-Tiles case making no rung-admissibility claim, and every number follows from "crosses three LODs," not the extremum.

**#44 — `t_ttc` figures do not reconstruct from §9.8's stated cohort priors** (optimizer, UNVERIFIED, 3222-3226/2879-2883/3243/3269-3272)
Evaluating the stated formula over the stated priors gives 2,043 / 45,730 / 3,263 / 3,884 ms against the document's 2,243 / 46,630 / 3,475 / 4,024. Residuals of 200/900/212/140 ms are neither constant nor byte-proportional; back-solving, Edit A's patch row implies ≈0.70 MB/s effective bandwidth while its rebuild row implies ≈2.39 MB/s. Everything else in §9.8 reproduces exactly. *Fix:* publish the per-candidate `t_ttc` worksheet with every addend named, or correct the four figures — the 20.8× headline and §14 rows 9-10 all rest on them. *Verifier:* Unverified, but the "everything else reproduces exactly" control makes this the most credible of the optimizer arithmetic findings.

**#45 — Gate and cap gaps** (optimizer, UNVERIFIED, 2751-2790/2128-2137/3094/3713)
(a) §9.2's correctness gates omit mask representability, so §9.4 can return a `replaceRegion` candidate whose mask §5.3 requires publication to reject. (b) §9.5 caps `β ∈ [0.25, 0.5]` while §12 blesses `β = 1.0` as defensible. (c) §14 row 6 derives its 200 µs budget from "≤ 3 candidate vectors"; §9.4 constructs about 14. *Fix:* add a mask-representability correctness gate to §9.2; align §9.5's `β` range with §12; recount row 6's candidate vectors or bound `fixedCodecsFor` explicitly. *Verifier:* Unverified. Three independent small defects bundled; (b) and (c) are trivially checkable.

**#46 — §9.7's head-origin crossover contradicts the coalescing paragraph above it** (optimizer, UNVERIFIED, 3187-3197/3734)
§9.7 establishes that reconciliation rate `r ≪ g` sets client cost, then computes hint-driven head load as `N_clients · g` — the un-coalesced rate — giving 40,000 req/s and the crossover `g < 1/T_poll`; row 27 codifies that form. *Fix:* restate the crossover in terms of `r`, fix §14 row 27, and present `r = g` separately as the explicit no-coalescing worst case. *Verifier:* Unverified. Each arithmetic is right in isolation; the two paragraphs assume opposite client behaviour.

**#47 — §9.2's decidability claim is false for its own gates; `futureDebt` dangling** (optimizer, UNVERIFIED, 2747/2716-2743/2800/3304)
"Every gate below is decidable from I1, I2, and I4 alone" omits I3, yet the same subsection gates on storage policy, client capability profile, and the whole Structural-caps block (`D_max`, `β`, `γ`, per-bin frame budget, hitch/TTC/memory/request caps) — all placed in I3 by §9.1. Separately `futureDebt` survives at 2800 and 3304 though this revision uses `c_debt`. *Fix:* change to "decidable from I1-I4 with no client state," and replace both `futureDebt` occurrences. *Verifier:* Unverified. The dangling-symbol half is a five-second check.

**#48 — No defined client behaviour on a profile-version or digest-suite change** (protocol, UNVERIFIED, 1258/1665-1673/1715-1723/3910)
§4.3 forbids in-place suite upgrade and negotiated downgrade, making migration a republication; a running client re-reads only the head, so after a suite migration it sees an unregistered algorithm token, MUST reject, and keeps its last verified state with no path forward. `"v": 1` appears in the head with no consuming rule. *Fix:* add a client law — an unparseable or unregistered-suite head triggers one entrypoint re-bootstrap before falling back to last-verified-state — and state what a bump of each version field obliges. *Verifier:* Unverified.

**#49 — `invalidate` has no authoritative form** (protocol, UNVERIFIED, 1570-1584/1730/1893-1894)
The deterministic active-operation law adds three precedence rules to guarantee one result when a supersession and an invalidation reach a client together, but no published artifact carries an authoritative invalidation, and rule 1 concedes hints carry no operations — so the headline concurrency case is vacuous while the real races (publishers racing the head CAS) get no rule. *Fix:* state that `invalidate` is hint-plane-only and retitle the rules as intra-state operation precedence, or define the authoritative invalidation artifact the selector registry presumes; add a precedence rule for the head CAS race. *Verifier:* Unverified.

### EDITORIAL

**#50 — §7.3's exclusion argument covers Basis transcode ambiguity, not the supercompression scheme** (codecs, PLAUSIBLE, 224-228/2386-2405/4253)
Decision 30 and T-05 reject supercompressed KTX2 as a class, but §7.3's argument is entirely about Basis ETC1S/UASTC having no single decoded block format — which does not reach a KTX2 with `supercompressionScheme` Zstd or ZLIB over a concrete block format such as BC7. *Fix:* add `supercompressionScheme != None` to the 7.3 gate list as an independent rejection condition, stated separately from the Basis argument. *Verifier:* **Plausible** — the justification is Basis-only, but §7.3 states the exclusion categorically one sentence earlier (L2396) and T-05 freezes it, so only the *reasoning* is under-inclusive. The finder's "still unpatchable" is wrong: the last gate bullet admits whole replacement mip levels, which KTX2 Zstd per-level streams satisfy.

**#51 — Two research conclusions assert unmeasured claims unmarked** (editorial, PLAUSIBLE, 4324-4327/4334-4336/4370-4375/464)
§18 promises that a claim depending on unmade measurement is marked pending; conclusions 1 and 5 honor it, conclusions 3 and 4 do not, and conclusion 12 recommends reusing RFC 6902 which the body only places on a study list. *Fix:* mark conclusions 3 and 4 pending on P1/P2 and P4/P5; either add a §16 question or §15 phase for RFC 6902 adoption, or reword conclusion 12 to "remains a study candidate." *Verifier:* **Plausible — conclusion 4 only.** "Essential" and "fragility is solved" rest on row 24's ≥4× target owed at P4/P5 with T-01..T-08 unrun. Conclusion 3's leg misreads: §9.8 row 3′ is the optimizer picking rebuild for one edit, exactly as designed, while 776 calls `replaceRegion` the universal safe fallback. Conclusion 12 already hedges to "a candidate envelope," matching 456's study list.

---

## 4. Citation integrity

**No citation-integrity dimension was supplied in this audit's input.** The brief asks for that dimension's counts table; there is none to report, and I will not synthesize one. What follows is the survival ledger actually delivered, plus the citation-shaped defects other lanes surfaced incidentally.

### Findings ledger by dimension

| Dimension | Raised | Refuted | Surviving | CONFIRMED | PLAUSIBLE | UNVERIFIED |
|---|---|---|---|---|---|---|
| protocol | 11 | 0 | 11 | 0 | 0 | 11 |
| security | 10 | 2 | 8 | 1 | 2 | 5 |
| codecs | 11 | 2 | 9 | 5 | 4 | 0 |
| optimizer | 12 | 0 | 12 | 0 | 0 | 12 |
| editorial | 12 | 1 | 11 | 10 | 1 | 0 |
| **citations** | **—** | **—** | **not run / not supplied** | — | — | — |
| **Total** | **56** | **5** | **51** | **16** | **7** | **28** |

| Severity | Count | CONFIRMED | PLAUSIBLE | UNVERIFIED |
|---|---|---|---|---|
| CRITICAL | 6 | 0 | 0 | 6 |
| MAJOR | 27 | 9 | 2 | 16 |
| MINOR | 16 | 7 | 3 | 6 |
| EDITORIAL | 2 | 0 | 2 | 0 |

### Citation-shaped defects found by other lanes

| Site | Defect | Finding |
|---|---|---|
| C-30 (4135) | Cites "4.4 laws 9-10, 13"; §4.4 has exactly ten client laws | #7 |
| §4.1 (1354) | Cites "the roughly 1 KB discovery budget of Section 14"; §14 assigns that ceiling to the hint (3709), not the head | #40 |
| §9.2 (2747) | "Decidable from I1, I2, and I4 alone" while gating on I3 quantities | #47 |
| §9.2 (2800), §9.5 (3304) | `futureDebt` — symbol not defined in this revision (§9.3.4 uses `c_debt`) | #47 |
| §12 (3455) | "already carried per bin by `activeSummary` (Section 9.1)" — cites a non-normative, never-required schema | #8 |
| §12 (3487, 3492-3493) | `baseBytes(b)`, `loadCost(b)` — sourced to no declared document | #24 |
| §4 identity table (1215-1247) | `closureDigest` used at 1768/1922/2073/2180 but absent from the table that defines the digest vocabulary | #20 |
| §14 rows 9-10 (3716-3717) | Both cite "Section 9.8 Edit A" as sole derivation for blanket targets | #32 |
| §14 row 4 (3711) | Two mutually exclusive bounds cited in one row | #5 |
| 26 §17 rows | Body column points at sections lines 54-66 declare non-normative | #7 |

Citation *accuracy* — whether quoted line numbers say what the finders claim — was spot-checked by the codecs and editorial verifiers against both the document and engine source and held in every case examined. It was **not** systematically checked for the protocol, security and optimizer lanes.

---

## 5. Decisions for the maintainer

Only genuine design forks appear here — places where the document must choose, not places where it must simply be edited. Every other finding is a fix, not a decision.

### D1 — Descriptor scoping: state-scoped closure, or target-scoped lazy fetch
*Raised by #3, compounds #5, #24, #30.*
- **Option A — state-scoped.** Every patch descriptor arrives with the state manifest. **Pro:** the state-control closure of §4.2/§10 is true as written; the selector index is complete at commit; `n_req` per target drops to `1 + d` payload requests. **Con:** the closure fetch scales with active patch count, and `D_max = 16`, `A_max = 33` and §14 rows 11-12 must all be re-derived; the manifest-growth problem of #5 gets worse, not better.
- **Option B — target-scoped lazy.** Descriptors are fetched per target on cold load, as §9.3.3 already models. **Pro:** `D_max = 16` stands as derived; per-target cost is bounded. **Con:** §4.2/§10's closure law must be weakened to "closure over the *prepared* frontier," and the atomicity argument has to be restated in terms of prepared coverage rather than global completeness — which then collides with #26.
- **Option C — hybrid.** State carries a digest-bound descriptor *index* (selectors + digests only, no write sets); write sets fetch lazily per target. **Pro:** selector index is complete at commit as §4.2 requires; per-target request count stays low. **Con:** a third artifact class to specify, digest-bind, size and limit.
- **Recommendation: C.** It is the only option that keeps both the closure law and the `D_max` derivation approximately intact, and the index is exactly the object §4.2 already describes when it says "so the client can build a complete loaded/future-loaded selector index." Re-derive `A_max`/`D_max` over index-fetch + `1 + d` payloads and price the index in §9.7.

### D2 — Manifest growth: what bounds `P` globally
*Raised by #5.*
- **Option A — normative global cap on active patch records.** **Pro:** makes §9.7's linear-growth claim true; one number, testable. **Con:** a global cap forces compaction of *cold* bins the per-bin trigger would never fire on, and the eviction policy across bins is new design.
- **Option B — mandatory sharding above a record count.** §14 row 4 already gestures at "shard above `P = 256`." **Pro:** matches the existing row; keeps per-bin locality. **Con:** the shard-selection rule, cross-shard atomicity and client fan-out are all unspecified — and fan-out reopens #3.
- **Option C — restate honestly as Θ(bins × depth) and accept it.** **Pro:** truthful; no new mechanism; the moving-front deployment is a declared limitation with a stated envelope. **Con:** the 51.3 GB/hour figure stays in the document as a real cost, weakening the terminal-patch argument the design leans on.
- **Recommendation: B, with C as the interim.** State Θ(bins × depth) now and reconcile §14 row 4's two clauses, then specify sharding as the P2/P3 deliverable. A global cap (A) fights the design's own locality model.

### D3 — What binds `D_max`: request amplification, or the per-frame residual budget
*Raised by #28, interacts with #3 and #29.*
- **Option A — frame budget binds.** §14 row 13's 250 µs total implies `D_max ≈ 2`. **Pro:** the client-side promise (1.5% of frame) is kept. **Con:** guts the terminal-patch story — at `d = 2` almost every hot bin compacts constantly, and §9.8 row 4's hot producer becomes infeasible.
- **Option B — request amplification binds; raise row 13.** **Pro:** keeps `D_max = 16` and the hot-producer scenario. **Con:** requires admitting up to ~9.3% of a 16.7 ms frame for a single deep bin, and the "1.5% of frame" claim must go.
- **Option C — two caps, both normative; `D_max` is the min of them, evaluated per deployment.** **Pro:** honest, and makes the tension explicit rather than resolving it by fiat. **Con:** `D_max` becomes deployment-computed rather than a constant, so every derivation citing `D_max = 16` needs a stated reference deployment.
- **Recommendation: C.** Add the per-frame residual as a normative §12 predicate alongside (B)/(C)/(D), state `D_max = min(request-bound, frame-bound)`, and label 16 as the reference-deployment value. The document already prices both sides; it just never intersects them.

### D4 — Optimizer inputs: does a per-target exposure prior exist
*Raised by #6.*
- **Option A — add a fifth input class (dated per-bin exposure prior).** **Pro:** legitimizes the §9.8 worked examples, which are the document's most persuasive material; per-bin priors derive naturally from the base profile's spatial bins. **Con:** breaks decision 8's clean "no client-derived state" line, and needs its own staleness/confidence/poisoning rules — a live per-bin popularity feed is an attacker-influenceable input.
- **Option B — drop per-target `E`; one deployment constant.** **Pro:** decision 8 holds unqualified. **Con:** the triad collapses toward a single winner and §9.8's three-row demonstration has to be rebuilt on producer-side inputs alone; "none dominates" may not survive.
- **Recommendation: A**, with the prior explicitly *producer-measured and published in the deployment document* (not client-reported), which keeps decision 8's actual intent — no client state in the optimizer — while making the worked examples legal.

### D5 — The unsigned profile: is it a supported deployment or an illustrative baseline
*Raised by #1, #2, #18, #19; the single largest cluster in the audit.*
- **Option A — signed profile becomes the MVP baseline; unsigned is non-conforming.** **Pro:** every finding in this cluster evaporates; the retention derivation, the generation floor and the anti-downgrade pin all have a foundation. **Con:** raises the deployment bar substantially (key management, rotation, signing infrastructure) and may deter the very live-producer pipelines the design targets.
- **Option B — keep unsigned, add profile-independent client laws** (session generation floor, durable highest-profile-ever-seen pin, bootstrap TOFU rule) **and state its residual weaknesses plainly.** **Pro:** preserves the low-friction on-ramp; the added laws are cheap. **Con:** the residual "stale-serving intermediary pins a reader indefinitely" hole stays open by design, and must be documented as such in §11 and §13.
- **Option C — three-tier honesty: unsigned is explicitly a development/trusted-network profile, not a public-internet one.** **Pro:** matches reality; lets §13's threat model scope cleanly. **Con:** needs the MVP-core conformance tags (C-63, C-64, C-101) retagged, touching the phase plan.
- **Recommendation: B + C together.** Add the profile-independent laws (which are one-line fixes with real value), and scope the unsigned profile normatively to trusted-network deployment. Option A is the right long-term answer but should not gate MVP.

### D6 — Trust-domain confinement: default-deny or unconstrained
*Raised by #21.*
- **Option A — closure resolves within the declared trust domain by default; cross-origin objects require a machine-readable allowlist in the deployment declaration.** **Pro:** turns `trustDomainId` from a label into a control; makes C-97 testable. **Con:** breaks legitimate CDN/multi-origin topologies unless the allowlist is easy, and adds a declaration format.
- **Option B — leave unconstrained; rely on digests for integrity and say so plainly.** **Pro:** no new mechanism; digests genuinely do prevent content substitution. **Con:** §4.3's "Every authority hop is covered" table must be retitled, because a verified state can still steer a fleet's requests to arbitrary origins — a real amplification and privacy exposure even when bytes are sound.
- **Recommendation: A.** The allowlist is small (origins, not URIs), and the alternative requires weakening a headline claim.

### D7 — Revocation vs retention: does revoking purge
*Raised by #22.*
- **Option A — revocation carve-out overriding the retention floor for the revoked closure alone.** **Pro:** `revoke` actually removes compromised bytes, which is what the word means. **Con:** breaks the "a referenced immutable object cannot be deleted" invariant that the GC safety argument rests on; needs a retirement-then-repoint ordering rule for still-reachable referencing states.
- **Option B — revocation is authority-only; publishers purge out of band.** **Pro:** the immutability invariant survives intact; simpler spec. **Con:** the document must say outright that revocation does not remove content and that clients which cannot enforce it keep working URLs — a statement worth making explicitly rather than by omission.
- **Recommendation: A** for the security-motivated revocation reason, **B** for the correctness-motivated one. Split `revoke` by reason code; only the security reason carries the purge obligation and its ordering rule.

### D8 — Implicit-tiling base-bump economics
*Raised by #11 (CONFIRMED).*
- **Option A — stable template prefix, version only subtree files.** **Pro:** preserves client and CDN cache reuse across base bumps, which is the whole point. **Con:** the coordinate-derived URI then aliases across revisions — precisely the collision §3.1 identifies — so revision-scoping must move into the cache key (`ImplicitSubtreeCache` keys on coordinates alone today, so this is a fork-side engine change too).
- **Option B — accept the flush; bound base-revision frequency.** **Pro:** no aliasing risk; simplest. **Con:** for a producer changing the world several times a second, any subdivision change is a full working-set refetch, which contradicts the design's core promise for implicit datasets.
- **Recommendation: A**, paired with a revision-scoped cache key. State the transfer cost of a base bump for implicit datasets either way — the current text claims a cost it does not have.

### D9 — Normativity boundary: promote, restate, or demote
*Raised by #7 and #8 (both CONFIRMED).*
- **Option A — promote 3.3.2-3.4.4 and 9.1/9.3-9.6 to normative.** **Pro:** 26 conformance rows and the §12 trigger get real foundations in one move. **Con:** a large amount of analytical and rationale prose becomes binding, including material that reads as exposition and would need rewriting to survive as requirements.
- **Option B — restate each obligation in §10/§12 and repoint the Body column.** **Pro:** keeps the analytical sections readable and non-binding; normative surface stays small. **Con:** substantial duplication, and every future edit must keep two copies in sync.
- **Option C — extract a new normative subsection per cluster** (compositor obligations, `activeSummary` schema, optimizer contract) and leave the surrounding prose non-normative.
- **Recommendation: C.** It is B's precision without B's duplication, and the three clusters are already well-delimited. Do `activeSummary` first — it unblocks the §12 trigger, which several other findings depend on.

### D10 — MVP scope: single-component or multi-component
*Raised by #13 (CONFIRMED).*
- **Option A — widen §2.2's MVP core** to include multi-component states, `materializedFallbacks` and coupled terrain/imagery; retag T-17 MVP-core. **Pro:** matches what C-04/C-05/C-39/C-40 and scenario 10 already demand, and coupled terrain+imagery is the actual target deployment. **Con:** the MVP grows materially, and #27's unbounded imagery closure becomes an MVP blocker rather than a profile problem.
- **Option B — demote those rows to a declared profile tag** and keep MVP single-component. **Pro:** smallest MVP; #27 defers with it. **Con:** an MVP that cannot atomically pair terrain with imagery is not demonstrable on the primary use case.
- **Recommendation: A**, and treat #27 (imagery closure model) as an MVP-blocking design item rather than deferring it. The document already calls coupled activation MVP-core at 2196; the phase table should simply agree with itself.

---

## 6. What this audit did not cover

**Verification coverage is uneven and two lanes are unverified.** The codecs and editorial lanes ran verification passes — codecs against CesiumJS engine source (`QuantizedMeshTerrainData.js`, `createVerticesFromQuantizedTerrainMesh.js`, `TerrainEncoding.js`, `CesiumTerrainProvider.js`, `ImplicitSubtreeCache.js`), editorial against the document text with row-by-row counts. The **protocol and optimizer lanes returned no verification verdicts at all**, and the security lane verified only 3 of 8 surviving findings. That means 28 of 51 findings — including **all six CRITICALs** — rest on one reader's close reading. They quote line numbers that spot-checks found accurate and the optimizer lane reproduced the document's own arithmetic exactly for every figure it tested but one, so they are credible; they are not confirmed. Before acting on D1-D5 the CRITICAL findings should get a verification pass.

**No citation-integrity lane data was supplied**, so §4's counts table is the delivered survival ledger rather than the citation audit the brief anticipated. Citation accuracy across the protocol, security and optimizer findings was not systematically checked.

**Nothing was executed, built, or prototyped.** This is a document audit under a read-only constraint: no schema validation, no JSON parsing of the illustrative payloads, no test of any conformance row, no prototype of the head/hint protocol, no measurement of any §14 target, and no browser or Playwright work. The optimizer arithmetic was re-derived on paper by the finder, not run.

**Coverage within the document is not uniform.** The five lanes targeted §4 (protocol/identity), §11-13 (security), §5-8 (codecs), §9/§12/§14 (optimizer) and §2/§15-18 (editorial). Sections **1, 6 (upstream analysis), 19, and the §3.2/3.3 repository-compatibility material** received only incidental attention. §2.5 (provenance rules), §5.4's spatial index design, and §10's full activation state machine beyond the frontier question were not systematically reviewed.

**Not assessed at all:** whether the design should be built (effort, schedule, staffing, opportunity cost against the live C11-C18 campaigns); IPR, patent or licensing exposure of the derived mechanisms; how the extension would fare in the actual CesiumGS/Khronos registration process or with the spec steward; interoperability with the existing fork's WebGPU renderer and its `ImplicitSubtreeCache`/`Cesium3DTileset` internals beyond the five files the codecs lane touched; and any measurement of whether the claimed performance targets are achievable on this engine.

**Novelty:** my re-check was three web searches plus one registry read against the document's own watchlist — enough to say nothing has *obviously* shipped that narrows the claim, not enough to discharge the pre-D1 R0 re-survey the document itself requires. The `3DTILES_content_conditional` PR and the time-dynamic work behind issue #102 remain the live convergence risks and should be re-checked at D1 regardless of this audit.

**Line numbers** are against the working-tree copy of the file at 4,436 lines. The file is uncommitted live work; if other lanes edit it, the citations drift.

*Sources for the novelty re-check: [CesiumGS/3d-tiles extensions registry](https://github.com/CesiumGS/3d-tiles/tree/main/extensions), [Time-dynamic 3D Tiles issue #102](https://github.com/AnalyticalGraphicsInc/3d-tiles/issues/102), [Cesium 2025 roadmap](https://cesium.com/blog/2025/06/23/cesium-roadmap-for-bridging-the-built-and-natural-environment/), [cesium-native CHANGES.md](https://github.com/CesiumGS/cesium-native/blob/main/CHANGES.md), [OGC Testbed-15 Images and ChangeSet API ER 19-070](https://docs.ogc.org/per/19-070.html), [OGC API — Tiles Part 1: Core](https://docs.ogc.org/is/20-057/20-057.html).*
