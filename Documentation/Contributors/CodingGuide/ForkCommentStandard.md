# Fork Comment Standard

An addendum to the [Coding Guide](README.md) and the
[Documentation Guide](../DocumentationGuide/README.md), covering comments in
this fork's WebGPU work. Everything in those two guides still applies; this
document adds the rules that only arise because we carry a large body of
changes on top of upstream CesiumJS.

**Scope: `packages/engine/Source` and `packages/widgets/Source`** — code,
WGSL, GLSL, and shipped assets. Nothing else. Test specs, tooling under
`Tools/`, build scripts, commit messages, and the campaign queues, ledgers and
audits under `migration_doc/` are where development history is _supposed_ to
live, and none of the rules below touch them.

## 1. The rule

> A comment describes what the code does and the constraints it obeys. It
> never describes the work that produced it.

Everything else here follows from that sentence.

The test a reviewer applies is the **seamlessness test**: someone diffing a
fork file against upstream must not be able to tell which comments are ours by
their voice. Upstream Cesium comments explain the code in front of you. Ours
must read the same way. A comment that only makes sense to someone who has read
a queue document is not a comment about the code.

This is not a style preference. A comment that says _when_ something changed
answers a question the reader did not ask and cannot act on, and it goes stale
the moment the surrounding code moves. A comment that says _why the code cannot
be written the obvious way_ answers the question that actually stops people, and
stays true as long as the constraint does.

## 2. What to write instead

Rewrite history into constraint. The information that made the historical note
worth writing is almost always a constraint the code cannot show:

| Instead of                                     | Write                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| "Changed to `rg32float` after the depth bug"   | "`rg32float`: a half-float metre at 100 km quantizes to ~50 m, which banded the sky" |
| "This used to be per-vertex"                   | "Evaluated per fragment; per-vertex re-introduces a mesh pattern at orbit altitude"  |
| "Do not remove — needed by the pipeline cache" | "The pipeline cache keys on shader-module identity, so this must stay distinct"      |
| "Fixed the NaN here"                           | "Inverted so a NaN length is treated as degenerate rather than passing the test"     |

If the historical note carries knowledge that genuinely has no home in the code
— a measurement, a refuted design, a cross-backend divergence with no local
consequence — it moves verbatim into `migration_doc/DEV_NOTES_<subsystem>.md`
before the comment is rewritten. See
[DEV_NOTES_FORMAT.md](../../../migration_doc/DEV_NOTES_FORMAT.md). Knowledge is
relocated, never deleted.

## 3. Vocabulary that is mechanically banned

The following never appear in a comment under `packages/*/Source`. Each row is
enforced by `node Tools/c16/comment-marker-guard.mjs`; the identifier in the
first column is the rule id it reports.

The guard reads source, not documentation, so this page — which has to name
the vocabulary it bans — is outside its scope in the same way `migration_doc/`
is. What is checked is the substantive part: every fenced example below is
required to be marker-free, and the worked example in §7 shows its tracker ids
anonymized for that reason.

| Rule id                | Matches                                                 | Why it is banned                                          |
| ---------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `batch-id`             | `Batch \d`, `Batches \d`                                | Names a commit, not a constraint                          |
| `campaign-row-id`      | `C\d{1,2}-\d+`, alphabetic `C\d{1,2}-` labels           | A queue row id; the queue is the authority                |
| `parity-report-row-id` | `Q\d{1,2}-` parity-report labels                        | A parity-report row id; the report is the authority       |
| `campaign-name`        | `Campaign \d`                                           | Dates the comment to a work programme                     |
| `review-id`            | `C-R\d`                                                 | Audit-round identifier                                    |
| `dp-h-id`              | `DP-H\d`                                                | Design-point identifier                                   |
| `far-id`               | `FAR-\d{3}`                                             | Containment-flag tracker identifier                       |
| `fork-id`              | `FORK-\d+`                                              | Fork-defect tracker identifier                            |
| `takram`               | `TAKRAM`                                                | A reference-implementation codename used as a tag         |
| `upstream-sync-id`     | `UP\d{3}-`                                              | Upstream-sync work-item identifier                        |
| `cloud-unification-id` | `CLOUD-U\d`                                             | Work-item identifier                                      |
| `deferred-work-id`     | `NEW-`, `BUG-`, `EPIC-`, `FIX-` prefixed ledger ids     | Points at a backlog row, not at the code                  |
| `all-caps-fix-label`   | Three or more hyphenated ALL-CAPS/alphanumeric segments | A bare development-history label, not a code constraint   |
| `numbered-bug-id`      | `BUG-\d`                                                | Debugging-log entry number                                |
| `session-id`           | `Session \d`                                            | Dates the comment to a working session                    |
| `tracker-document`     | Names of the campaign ledgers and queue files           | The code must stand on its own                            |
| `decorative-glyph`     | U+2605, U+26A0, U+2705, U+274C and similar              | No glyph of this kind appears anywhere in upstream Cesium |

Three more rules are part of the standard but are **not** machine-checked,
because every regex for them produces false positives at a rate that teaches
reviewers to ignore the tool:

- **No ALL-CAPS emphasis.** Upstream uses sentence case. The narrow
  `all-caps-fix-label` rule catches bare labels with three or more segments of
  at least two alphanumeric characters. It excludes the required `CC-BY-SA`
  license identifier and the `YYYY-MM-DD` date placeholder; ordinary emphasis
  remains a review judgement. If a point needs emphasis, the sentence is not
  yet doing its job.
- **No first person.** Not "we", "I", "our", and not "note to whoever picks
  this up". The reader is a maintainer, not an audience.
- **No narrative.** No "this previously", "the first attempt", "turned out
  that". State the current arrangement.

Also from the Coding Guide, restated because they matter here: no commented-out
code, and no `TODO` at merge.

## 4. Placement

Comments sit **immediately above the declaration they describe**, at the same
indentation. That means:

- A file-level docblock at the top explains the module.
- A JSDoc block sits above the class, function, property or constant.
- A rationale comment sits above the statement it justifies.
- A trailing comment on the same line is fine when it is short.

What is not fine: banner comments in the middle of a function body, essays
appended below the code they discuss, and multi-paragraph blocks explaining a
subsystem parked above an unrelated local variable. If a block is long enough to
need a banner, it belongs in a file docblock or in the DEV notes.

Box-drawing rules and section banners inside a function body are a symptom, not
a formatting choice: they mark a function that wants to be several functions.

## 5. JSDoc on exported API

The documentation generator (`npm run build-docs`) is JSDoc-based. Every
exported symbol's block must generate clean output, per the
[Documentation Guide](../DocumentationGuide/README.md). In practice:

- Every `@param` has a type, a name and a sentence. Every non-void function has
  `@returns`.
- ES6 class members do not carry `@memberof`; properties defined through
  `Object.defineProperties` do. Both are enforced by the ast-grep rules in
  `Tools/ast-grep/rules`.
- `@private` means "not in the published API". TypeScript reads it as
  class-scoped visibility, so a method called across modules uses `@internal`
  instead, or is declared public in a co-located `.d.ts`.
- Use `@see` sparingly, and `{@link URL|title}` for external links.
- Do not add JSDoc that did not exist to a file you are only otherwise
  modernizing, and never delete JSDoc while modernizing.

## 6. Attribution

Two mechanisms, and they answer different questions.

### 6.1 `Reference:` blocks — for techniques

Use a reference block when the code **implements a published technique** but the
code itself is ours. Papers, book chapters, blog posts, conference talks, and
other engines whose approach we re-derived all belong here. This carries no
licensing weight; it is scholarly credit and, more usefully, it tells the next
reader where the equations come from.

Place it in the file or symbol docblock, after the description:

```javascript
/**
 * Projects a radiance cube map onto the first nine spherical-harmonic
 * coefficients, which the model lighting stage reads as the diffuse ambient
 * term.
 *
 * References:
 *   - Peter-Pike Sloan, "Stupid Spherical Harmonics (SH) Tricks" (GDC 2008)
 *     — the projection and the windowing used to suppress ringing.
 *   - Ravi Ramamoorthi & Pat Hanrahan, "An Efficient Representation for
 *     Irradiance Environment Maps" (SIGGRAPH 2001) — the nine-coefficient
 *     irradiance result this relies on.
 */
```

In GLSL and WGSL, upstream's existing single-line form is preferred for short
citations, matching files such as `octDecode.glsl`:

```glsl
// Cigolle et al 2014: http://jcgt.org/published/0003/02/01/
```

Say explicitly when a technique was **reimplemented from a paper rather than
copied** — that sentence is what distinguishes a citation from an unresolved
licensing question.

### 6.2 `LICENSE.md` Third-Party section — for code

Use a third-party license entry when **code, data or assets were copied**, in
whole or in part, or when a dependency's license requires a notice. A reference
block is not a substitute: a `Reference:` line credits an author, it does not
grant or reproduce a license.

Add an entry to the `# Third-Party Code` section of the root `LICENSE.md`
(mirrored into `packages/engine/LICENSE.md` where the code ships from that
package), in the established shape: an `###` heading naming the author or
project, the source URL on its own line, then the license text as a blockquote.
Register the dependency in `ThirdParty.json` / `ThirdParty.extra.json` when it
is a package rather than a snippet.

Which one applies:

| Situation                                                     | Reference block | LICENSE.md entry           |
| ------------------------------------------------------------- | --------------- | -------------------------- |
| Equations from a paper, implemented from scratch              | yes             | no                         |
| A function transcribed from another project, even a short one | yes             | **yes**                    |
| A shader chunk adapted from a reference renderer              | yes             | **yes**                    |
| A vendored package under `ThirdParty/`                        | no              | **yes**                    |
| A dataset or texture derived from a public-domain source      | yes             | **yes**, provenance notice |
| A technique described to us in an issue thread                | yes             | no                         |

When in doubt the answer is both. An unnecessary license entry costs a
paragraph; a missing one is a defect that ships.

## 7. Worked example

Taken from `Renderer/UniformState.js`, where the scene light is dimmed during
an eclipse. The original is reproduced faithfully except that its tracker ids
are shown as `C1x-NN` rather than the live ones, and the warning-sign glyph
(U+26A0) that opened its second paragraph has been removed. Both blocks below
are checked by the guard's grammar, so an example of what not to write cannot
be written literally.

Before:

```javascript
// C1x-NN S2 — eclipse dimming of the SUN-driven scene light. One multiply
// here reaches, in GLSL, `czm_lightColor` / `czm_lightColorHdr` — GlobeFS'
// diffuse term, phong, translucentPhong and the model PBR lighting stage
// (`Model/LightingStageFS.glsl`) — and, on WebGPU, `csm_lightColor` /
// `csm_lightColorHdr` plus `WebGPUGlobeSurfaceCameraUB`'s `lightColor`
// slot. That is why the dimming lives at the JS uniform source rather
// than in eight shaders.
//
// IT IS NOT UNIVERSAL ON WEBGPU. `ModelPBRComplete.wgsl` reads NONE of
// the `csm_lightColor*` automatic uniforms — its direct term is
// `light.sunColor * light.sunIntensity * NdotL`, packed raw from
// `frameState.light` by `WebGPUModelRenderer.packLightUniforms`, which
// carries its own copy of this multiply (S2 injection site 5) under the
// SAME `instanceof SunLight` gate. Any future change to the gating or the
// quantity here must be mirrored there, or WebGPU models desynchronise
// from the WebGPU globe during an eclipse.
//
// AFTER the LDR clamp, not before. `_lightColor` is `_lightColorHdr`
// renormalised so its brightest channel is <= 1; a pre-clamp multiply
// would be entirely swallowed by that renormalisation until the factor
// dropped below 1/intensity (0.5 at the default SunLight intensity of
// 2.0), giving a light that does not dim at all through the first half of
// the eclipse and then dims at double rate.
```

After:

```javascript
// Eclipse dimming of the sun-driven scene light. Applying it here, at the
// uniform source, reaches every consumer of `czm_lightColor` /
// `czm_lightColorHdr` on WebGL and of `csm_lightColor*` on WebGPU — the
// globe's diffuse term, phong, translucent phong, and the model PBR
// lighting stage — so the factor does not have to be threaded through
// eight shaders.
//
// `ModelPBRComplete.wgsl` is the exception: it reads none of the
// `csm_lightColor*` automatic uniforms and lights from
// `light.sunColor * light.sunIntensity * NdotL`, packed by
// `WebGPUModelRenderer.packLightUniforms`, which carries its own copy of
// this multiply under the same `instanceof SunLight` gate. The two must
// change together or WebGPU models stay lit while the WebGPU globe dims.
// `eclipse-scene-dimming.spec.mjs` pins both halves.
//
// Applied after the LDR clamp, not before. `_lightColor` is
// `_lightColorHdr` renormalised so its brightest channel is at most 1, so a
// pre-clamp multiply is swallowed by the renormalisation until the factor
// drops below 1 / intensity — 0.5 at the default sun intensity of 2.0 —
// which would hold the light steady through the first half of an eclipse
// and then dim it at double rate.
```

What changed, and what did not:

- The row id, the ALL-CAPS emphasis and the glyph are gone.
- "That is why", "Any future change", "future" — the narrative framing — is
  gone; the constraints are stated directly.
- Every load-bearing fact survives: the list of consumers, the WebGPU model
  exception and the reason the two sites must move together, the clamp
  ordering and the exact failure it prevents, and the spec that pins it.
- It got shorter, because history was the padding.

Nothing here was moved to the DEV notes: none of the deleted text carried
knowledge that the rewrite dropped.

## 8. Enforcement

Four instruments, all under `Tools/c16/`:

1. **`comment-marker-guard.mjs`** — the vocabulary rules in §3, over comments
   only. Wired into `lint-staged`, so it runs on staged engine and widgets
   source at commit time, and runnable repository-wide for a census
   (`node Tools/c16/comment-marker-guard.mjs`). Findings are warnings by
   default and errors under `--strict` or under a path listed in
   `comment-marker-cleanlist.txt`, except for an exact pair recorded in the
   grammar-widening grandfather file.
2. **`comment-marker-cleanlist.txt`** — the ratchet. A remediation batch
   appends the paths it certified, in the same commit as the rewrite, and those
   paths are enforced strictly from then on. `--verify-cleanlist` asserts every
   entry still resolves to a real file and has no ungrandfathered findings, so
   neither a rename nor a regression can quietly retire an entry.
3. **`comment-marker-grandfather.txt`** — exact cleanlisted file/rule pairs
   exposed by the 2026-08-21 grammar widening. Only the named rule is a warning;
   every other rule in the same file stays an error. A row becomes an error
   once its pair has zero current findings, so the exception set shrinks as
   files self-clean.
4. **`comment-only-diff.mjs`** — the gate for remediation batches. It strips
   comments from both sides of a ref pair and requires the remainder to be
   identical, which is the only way "I only changed comments" can be checked
   rather than believed. Build pragmas, lint directives and license banners
   count as code: deleting one fails the gate.

`npm run build-docs` must stay clean for any change touching exported API.

## Appendix A — worker-prompt boilerplate

Paste this into the prompt of any agent or contributor writing code in
`packages/*/Source`. It is deliberately short; the full rules are above.

> **Comment standard (binding).** Comments in `packages/engine/Source` and
> `packages/widgets/Source` describe what the code does and the constraints it
> obeys — never the work that produced them. No batch numbers, campaign or
> queue row ids, design-point or audit ids, ledger entry ids, session numbers,
> or references to tracker documents. No decorative glyphs, no ALL-CAPS
> emphasis, no first person, no narrative about what changed or what was tried.
> Comments sit immediately above the declaration they describe. Exported API
> carries JSDoc that generates clean documentation. Techniques taken from
> published work get a `Reference:` block; copied code, data or assets also get
> a `LICENSE.md` Third-Party entry. If a fact you are removing is load-bearing
> and has no home in the code, move it verbatim, with a file and symbol anchor,
> into `migration_doc/DEV_NOTES_<subsystem>.md` in the same change — knowledge
> is relocated, never deleted. Tracker ids belong in commit messages and
> ledgers, and nowhere else. Verify with
> `node Tools/c16/comment-marker-guard.mjs --strict <files>`; a batch that
> claims to change only comments must also pass
> `node Tools/c16/comment-only-diff.mjs --base <ref>`.
