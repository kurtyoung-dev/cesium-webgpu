# Campaign 16 — Comment Remediation & Attribution (Plan, 2026-08-10)

**Launch authority:** maintainer directive, 2026-08-10 ("audit all of our fork
changes and fix ALL of our comments … break it into batches as a new
campaign 16"). **Numbering note:** the celestial-light-transport epic, which
had been informally pencilled as C16 in working notes, was never ratified and
renumbers to **proposed C17**. Nothing in any ratified queue changes.

## 1. The problem, measured

A 13-agent audit (rubric + 12 file shards + synthesis, run 2026-08-10 against
merge-base `77fd16a758`) censused every fork-changed file under
`packages/engine/Source` + `packages/widgets/Source` — 1,366 files (801
fork-added, 565 fork-modified; for modified files only fork-added comment
lines counted).

**Result: 6,450 violation blocks across 556 files**, by category:

| Cat | Definition | Blocks |
| --- | --- | --- |
| A | Dev-history markers (Batch/C1x-/DP-H/FAR/TAKRAM/UP1xx/CLOUD-U IDs) in code comments | **5,527** |
| B | Narrative/journal comments (what *changed*, prior bugs, refuted designs — not what the code does) | 158 |
| C | Placement (mid-function banners, trailing essays, comments not above their declaration) | 525 |
| D | JSDoc violations on exported API (missing/malformed tags; pollutes `npm run build-docs`) | 88 |
| E | Style mismatch (ALL-CAPS emphasis, ★/⚠ glyphs, first-person, notes-to-future-developers) | 103 |
| F | Missing attribution for derived/reference-based code | 39 |
| G | Dead weight (commented-out code, TODO/FIXME) | 10 |

**Attribution census: 76 files** implement techniques derived from papers,
books, engines, or datasets. 43 need a citation added, **20 need a license
review** before any comment fix touches them (see §4), 13 are already cited
per convention (e.g. `ProceduralClouds.wgsl` → Schneider/Nubis,
`ProjectRadianceToSH.wgsl` → Sloan, `BrightStarCatalog.js` → Yale BSC5).

## 2. Standards (the targets every batch is gated on)

- `Documentation/Contributors/CodingGuide/README.md` — descriptive comments
  for non-obvious code; no commented-out code; no TODO at merge; JSDoc rules.
- `Documentation/Contributors/DocumentationGuide/README.md` — the doc
  generator is **JSDoc-based** (`npm run build-docs`), not Doxygen. Every
  exported symbol's block must generate clean documentation.
- **Seamlessness test:** a reviewer diffing a fork file against upstream must
  not be able to identify fork comments by voice. No campaign/batch/wave/row
  IDs anywhere in `packages/*/Source`. Comments sit above the declaration
  they describe. Rationale comments state the constraint the code cannot show
  ("rg32float because a half-float metre at 100 km quantizes to ~50 m"), not
  the history of how we learned it.
- **Knowledge is preserved, not deleted:** every A/B-category comment that
  carries live engineering knowledge moves verbatim (with file/symbol anchor)
  into `migration_doc/DEV_NOTES_<subsystem>.md` before the code comment is
  rewritten. The campaign queues, DEBUGGING_LOG, and DEFERRED_WORK remain the
  historical record; `migration_doc/**` is explicitly exempt from these rules.

## 3. Enforcement (built first, so the debt cannot regrow)

1. **Lint guard** — an ast-grep/regex rule (mirroring upstream's ast-grep
   usage) failing any comment in `packages/*/Source` matching the marker
   grammar (`Batch \d`, `C\d{1,2}-\d`, `DP-H\d`, `FAR-\d`, `TAKRAM`,
   `UP\d{3}-`, `CLOUD-U\d`, ★/⚠ glyphs). Wired into lint-staged and CI.
2. **Comment-only-diff verifier** — a tool that strips comments and asserts
   the stripped source is byte-identical before/after a rewrite batch. Every
   rewrite batch MUST pass it: C16 changes comments, never code.
3. **`npm run build-docs` green** is a binding gate for every batch touching
   exported API.
4. **Worker standard** — the orchestrator's worker-prompt boilerplate gains
   the comment standard; every post-C16 batch writes seamless comments from
   day one. Tracker IDs live in commit messages and ledgers only.

## 4. License-review items (scheduled FIRST — legally load-bearing)

The 20 `needs-license-review` flags include: **mulberry32 PRNG copied
verbatim** in `FlowFieldWindLayer.js` (Tommy Ettinger — needs a LICENSE.md
Third-Party entry or replacement); **naga-wasm** ThirdParty coverage
(`LICENSE.md` section + `ThirdParty.extra.json` verification for the MIT/
Apache-2.0 dual license); **SSGI** (MIT reference cited only in an internal
research doc — the notice belongs in LICENSE.md); **Khronos glTF
sample-viewer lineage** in the PBR WGSL (copied-vs-re-derived determination);
star-map/moon/lakes **asset provenance notices** (Tycho-2/NASA SVS
derivatives, NASA LROC mosaic, Natural Earth — public-domain but
attribution-customary). The 43 `needs-citation` files get `Reference:` blocks
per Cesium's existing conventions (Karis 2013, Hillaire 2020, Bruneton 2008,
Wronski 2014, Moffat 1969, van der Zijp 2008, Kerbl et al. 2023, etc.).

## 5. Batch structure

See `QUEUE_2026-08-10_CAMPAIGN16.md` (the live queue and sole status
authority). Shape: **C16-00** standards doc + lint guard + comment-only-diff
verifier + DEV_NOTES format → **C16-01** attribution & license batch (the
risk batch, independent of rewrites) → **C16-02** upstream v1.144 sync (57
commits; sequenced BEFORE rewrites so they happen once against the final
base; audit re-run is cached) → **C16-03..C16-12** subsystem rewrite shards
(~550–700 blocks each, extraction-then-rewrite, sized from per-file audit
counts) → **C16-20** final gate: audit workflow re-run expecting **zero**
violation blocks + `build-docs` clean + parity re-score refresh.

## 6. References

Audit run: workflow `wf_c6df8ba5-f04` (13 agents, 1,366/1,366 files, 12/12
shards returned; per-shard results in the workflow journal). Upstream
divergence at audit time: 57 behind / 1,251 ahead of `upstream/main`.
