# 3D Tiles patch extension P0b core — R8 adjudicator-cap correction preregistration (2026-08-27)

**Status:** RULING REQUEST ANSWERED on 2026-08-27; implementation remains locked pending a corrected
post-ruling authority design and fresh independent review.

## 0. Authority and scope

R8 inherits the exact approved R7 observation-harness design at
`21,915 bytes / 298 LF / 249de33775c4b4209be713ad84da03ff0604745222703d7c5bee4a36d9e7bfb2`.
R7 remains frozen. Its 820-line cap is a measured red and cannot be changed by an agent-authored
design: charter §1.1 requires a maintainer ruling. R8 therefore proposes, but does not authorize, a
cap correction. Every non-cap R7 clause remains binding.

> **RULING REQUEST.** The valid R7 run measured a readable 1,258-line sole adjudicator against the
> preregistered 820-line cap and therefore failed 0/2 before semantics. The gate may be at fault
> because 820 was projected before R7 added mandatory oracle, failed-import, concurrency, coercion,
> 64-URL, per-image namespace, and exact-accounting teeth; independent implementation and review
> found no path to 820 without hiding or removing load-bearing adjudication. Proposed change: preserve
> the R7 FAIL, set the provenance cap to 1,280 and the explicitly non-binding fixture+harness+spec
> ceiling to 1,800, add a pinned R8 authority reference, and require the complete existing semantic,
> replay, and independent-review gates before any certification claim.

> **RULING OUTCOME — 2026-08-27; instrument: AskUserQuestion.** Verbatim option label:
> **"Raise per-spec, keep aggregate (Recommended)"**.
>
> - **GRANTED:** per-spec provenance cap rises **820 -> 1,400**. Rationale: the parser scope
>   outgrew a cap set before it existed.
> - **DENIED:** the aggregate demotion. The **1,340 combined ceiling STAYS BINDING**, because the
>   independent review proved it genuinely couples the budget (the proposed 1,940 equals the sum of
>   individual maxima and would constrain nothing).

This ruling answers R8's RULING REQUEST through the instrument R8 supplied for charter §1.1. R8's
own citation of charter §1.1 was substantively correct: the measured red could be rescored only by
maintainer ruling. The ruling changes no historical observation or frozen tuple. It grants only the
per-spec `820 -> 1,400` change and denies making the 1,340 aggregate non-binding; the proposal above
and later conditional projection text remain the historical request, not implementation authority.

The first R8 candidate at
`7,555 / 129 / 6c3b8d631f3e348633a2047df5796d38bf866c2660723a6304bc04b5cadb4d9b`
is preserved as `FAIL / NO-GO`: it left a stale topology pin, omitted in-band R8 authority, created a
potential authority/postimage hash cycle, and lacked a maintainer ruling.

Before the ruling, this document is the sole authorized R8 authoring path. If the correction is
ruled, the orchestrator records the ruling in the add-only maintainer series, propagates its exact ID
here, removes this request status, freezes the authority tuple, and obtains two fresh design reviews.
A design GO closes no implementation finding. `P0B-F02` through `P0B-F06` remain OPEN / NOT RETESTED.

## 1. Frozen evidence and honest R7 red

| Artifact | Exact tuple: bytes / LF lines / SHA-256 |
| --- | --- |
| R7 design | `21,915 / 298 / 249de33775c4b4209be713ad84da03ff0604745222703d7c5bee4a36d9e7bfb2` |
| frozen fixture | `8,925 / 299 / d30319cc6cd4482a755fb701572e05ea67bcc8aecdb211fd7c77734c7ea6c3f0` |
| R7 provenance harness | `6,533 / 219 / 0b2ec80306b9696b94dbff2cecee3f1d11555c5adb4dd6587315291fe35bceb4` |
| R7 topology spec | `74,687 / 1,674 / b3c718d24df645f4d5168aa653cbf296da768300ddb79b7c5d5e41257cc51e80` |
| R7 provenance spec cap red | `45,157 / 1,258 / bf4b1e3938262e044358f86e36b70306a06b27bcebaa1699aab4c98bd8eafbe9` |
| current result | `43,398 / 602 / 250d3bba7bdcd7750cb7b2580349884b0c59cdb1d17f48fe7eb50f41a062b3d8` |

The provenance preimage has exactly two top-level tests, zero `prettier-ignore`, zero `JSON.parse`,
and only the four R7-authorized imports. Syntax, default Prettier, and ESLint pass. Its focused run is
an honest `FAIL 0/2`, exit 1: both tests stop at the preregistered `own <= 820` gate before semantic
adjudication. Topology is conditionally 35/36 with all 32 mutants passing; its sole red is that same
provenance cap. No semantic PASS is inferred and no R7 implementation certification is claimed.

Independent read-only review partitioned all 1,258 readable lines into source/oracle literals,
shape and source adjudication, named mutations, graph and R7 inverse controls, hostile-boundary
observations, seven R3/R5 discriminators, eight R6 discriminators, and the two test/accounting tails.
Reaching 820 would require removing or hiding load-bearing adjudication rather than moving generic
mechanism. The exact harness already owns the reusable mechanism authorized by R7.

## 2. Proposed decision and unchanged architecture

If and only if the maintainer rules it, the provenance-spec cap becomes **1,280**. The fixture +
harness + spec combined reporting ceiling becomes **1,800** and remains explicitly non-binding: the
individual maxima total `299 + 220 + 1,280 = 1,799`. The measured readable preimage has 22 lines of
individual headroom.

This is a correction of the falsified R7 geometry projection, not behavior room. A second spec would
change consumer topology and split sole adjudication; another helper would move oracles out of the
spec. R8 therefore preserves all of the following exactly:

- three harness exports/arities and its import allowlist;
- fixture as inherited package-oracle data home and spec as sole adjudicator;
- the affected and inherited graph edges and both sole-consumer rules;
- four source images, 18 scored source files, and 25 syntax/ESLint JavaScript files;
- exactly two provenance tests, 73 total tests, and 67 controls;
- all pins, paths, traces, descriptors, brands, hooks, sentinels, tags, URLs, namespaces, mutations,
  discriminators, assertions, killed-ID accounting, failure ordering, and forbidden surfaces;
- harness 220, topology 1,680, result 850, R7 design 320, this R8 authority 180, the R8
  implementation manifest 200, and every inherited cap; and
- topology's 24 inherited readable formatter markers, with zero added.

## 3. Two-stage authority and projection — locked until ruling + design GO

Embedding final code hashes in the authority that code must itself pin creates a mutual hash cycle.
R8 separates authority from evidence instead:

1. **Freeze authority first.** After the ruling ID is recorded here, this document freezes and two
   fresh reviewers approve its exact tuple. It contains no successor-code hash.
2. **Project topology first.** From frozen topology preimage
   `74,687 / 1,674 / b3c718d24df645f4d5168aa653cbf296da768300ddb79b7c5d5e41257cc51e80`,
   add one `r8Design` cap row pointing to this authority at cap 180, change the provenance cap
   `820 -> 1280`, and change the combined ceiling `1340 -> 1800`. Freeze that topology postimage.
3. **Project provenance second.** From frozen provenance preimage
   `45,157 / 1,258 / bf4b1e3938262e044358f86e36b70306a06b27bcebaa1699aab4c98bd8eafbe9`,
   add this authority path after R7 in `REFERENCE_PATHS`; add `r8Design` after `r7Design` in the exact
   reference-name vector; add a `PINS.r8Design` entry containing the frozen authority tuple; replace
   `PINS.topology` with the topology postimage tuple; change `own` cap `820 -> 1280`; and change the
   combined ceiling `1340 -> 1800`. No other source byte may change.
4. **Bank evidence outside the authority.** Before any test, create
   `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_R8_IMPLEMENTATION_MANIFEST_2026-08-27.md` with the
   ruling ID, authority tuple, both exact preimages/postimages, unique-anchor counts, line arithmetic,
   and a byte-diff statement. The manifest is evidence, not a source image or authority, and is never
   imported or pinned by product/test code.

After ruling and both design GOs, implementation may edit exactly the topology spec, provenance
spec, new implementation manifest, and current result. It does not authorize formatter cleanup,
semantic repair, renamed helpers, a new assertion, a removed assertion, or any other artifact. If
projection or testing reveals a non-cap red, preserve it and stop for a new preregistered successor.
The result changes only after the complete evidence run and remains within 850 lines.

## 4. R8 acceptance

1. **R8A-01 — authority and prerequisite lock:** an operative maintainer ruling explicitly approves
   the 1,280/1,800 correction; this authority tuple, R5/R6/R7 designs, policies, current result,
   fixture, harness, topology/spec preimages, and every immutable R7 prerequisite rehash exactly.
   Chronology-only reds are cross-checked without invented identities.
2. **R8A-02 — exact staged correction:** topology freezes before provenance; provenance pins both
   this R8 authority and the topology postimage; all registered insertion/replacement anchors occur
   uniquely; no other code byte changes; the <=200-line implementation manifest banks both final
   tuples before execution.
3. **R8A-03 — focused gates:** syntax, default Prettier, and ESLint pass; provenance is 2/2; topology
   is 36/36 with all 32 independent mutants; no test stops at a cap before semantic adjudication.
4. **R8A-04 — inherited behavior:** exact package records/digests, five-factory/ten-resolution/
   five-measurement ordering, filesystem/TOCTOU/symlink controls, exact errors/freezes/brands,
   16 tags, 64 globally unique URLs, per-image URL and namespace set sizes 16, seven R3/R5 and eight
   R6 discriminator rows, and exact 67-control accounting all execute and pass.
5. **R8A-05 — full local evidence:** Gate D PRE and FORWARD are each 151/151; protocol is 15/15,
   hostile boundary is 20/20, topology is 36/36, provenance is 2/2, for 73 total tests; the exact
   18/25 inventories, caps, graph, and forbidden-surface scans pass.
6. **R8A-06 — replay and review:** the complete frozen tuple replays in the clean landing clone, then
   two fresh independent terminal reviewers return unconditional GO. Author review cannot substitute
   for either terminal verdict.
7. **R8A-07 — result and checkpoint:** the result records the R7 cap red, R8 correction, commands,
   counts, tuples, negative evidence, clean-clone replay, and reviewer verdicts without closing
   `P0B-F02..F06` absent their required evidence. Only the orchestrator may create a local checkpoint;
   no push or publication is authorized.

## 5. Nonclaims and stop conditions

Absent the explicit ruling, R8 remains locked and no reviewer can substitute its own preference.
R8 does not certify Cesium, WebGL, WebGPU, browser, GPU, network, production performance, or extension
specification conformance. It changes no product source. A missing ruling, tuple mismatch, extra edit,
semantic red, inventory drift, cap overflow, missing control, or conditional reviewer verdict is
`FAIL / NO-GO` and stops the wave. Measured reds are preserved and never de-scored.
