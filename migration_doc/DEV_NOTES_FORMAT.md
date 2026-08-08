# DEV_NOTES format

The Campaign 16 comment standard removes development history from
`packages/engine/Source` and `packages/widgets/Source`. Some of what it removes
is load-bearing: a measured number, a design that was tried and refuted, a
cross-backend divergence with no local consequence. That knowledge is
**relocated, never deleted**. This document defines where it goes and what an
entry looks like.

Standard:
[Documentation/Contributors/CodingGuide/ForkCommentStandard.md](../Documentation/Contributors/CodingGuide/ForkCommentStandard.md).
Queue: [QUEUE_2026-08-10_CAMPAIGN16.md](QUEUE_2026-08-10_CAMPAIGN16.md).

## Where the notes live

One file per subsystem, in this directory:

```text
migration_doc/DEV_NOTES_<SUBSYSTEM>.md
```

`<SUBSYSTEM>` matches the rewrite shard that produced it, in
`SCREAMING_SNAKE_CASE` — `CLOUDS`, `CELESTIAL`, `GLOBE_IMAGERY`,
`RENDERER_INFRA`, `POST_PROCESS`, `MODEL_PBR`, `COLLECTIONS`, `SPLATS_COMPUTE`,
`SCENE_ARCHITECTURE`. A shard that finds itself needing a tenth file names it
after the subsystem, not after the batch.

`migration_doc/**` is exempt from the comment standard. These files are the
historical record and are expected to contain batch numbers, row ids, glyphs
and first-person prose — that is the point of moving the text here rather than
rewriting it.

## When an entry is required

Move a comment here when **all three** hold:

1. It is being removed or rewritten by a Campaign 16 shard, and
2. it states something a future maintainer could act on — a measurement, a
   refuted approach, a constraint that lives outside the file, a reason a
   plausible change would be wrong — and
3. that something has no natural home in the rewritten comment, because it is
   about the work rather than about the code.

If the fact belongs in the code, it stays in the code, restated as a
constraint. Most category A comments need no entry at all: a batch number
attached to an otherwise correct explanation is deleted, not archived.

Do not archive: pure "changed in batch N" annotations, comments duplicating a
queue row, notes already recorded in the debugging log or the deferred-work
ledger. Cite the existing record instead.

## Entry format

Four required parts, in this order.

```markdown
### `packages/engine/Source/Renderer/UniformState.js` — `UniformState#updateSun`

_Moved 2026-08-11._

> C12-29 S2 — eclipse dimming of the SUN-driven scene light. ⚠ IT IS NOT
> UNIVERSAL ON WEBGPU. `ModelPBRComplete.wgsl` reads NONE of the
> `csm_lightColor*` automatic uniforms — its direct term is
> `light.sunColor * light.sunIntensity * NdotL`, packed raw from
> `frameState.light` by `WebGPUModelRenderer.packLightUniforms`.

Kept because the second half is the only written record that the WebGPU model
path carries a duplicate of this multiply. The rewritten comment states the
constraint; this preserves the wording that identified it.
```

- **Heading** — the repo-relative file path in backticks, an em dash, and the
  **symbol anchor**: the class, method, function, constant or shader entry
  point the comment sat above. `file — symbol` is the whole address; a line
  number is not, because it stops being true at the next edit. Use
  `Class#member` for instance members and `Class.member` for static ones, as
  the Documentation Guide does. For a file-level docblock, write `(module
  docblock)`.
- **Date moved** — `_Moved YYYY-MM-DD._` on its own line. This is the date the
  rewrite landed, not the date the original comment was written.
- **The comment, verbatim** — as a blockquote, exactly as it stood, including
  its markers, glyphs and capitalisation. Verbatim is the point: a paraphrase
  is a second rewrite, and the reason to keep the text at all is that nobody is
  confident which part of it will matter. Strip only the leading `//` or ` * `
  delimiters. Fenced blocks are acceptable instead of a blockquote when the
  comment contains markdown-significant characters.
- **Why it was kept** — one or two sentences, in the present tense, saying what
  the entry is for. An archive nobody can triage is a second copy of the
  problem.

Entries are appended in the order the shard processed them. Do not re-sort;
the file is an archive, not an index.

## File header

Each `DEV_NOTES_<SUBSYSTEM>.md` opens with:

```markdown
# DEV notes — <subsystem>

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.
```

That last sentence is not boilerplate. These entries are frozen at the moment
they were moved, and the code they describe keeps moving.

## Landing rule

**The notes land in the same commit as the rewrite they came from.** A batch
that rewrites comments and defers the extraction has deleted the knowledge, and
the only remaining copy is in a diff nobody will read again. The queue lists
this as a binding gate for every rewrite shard.
