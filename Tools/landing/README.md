# Tools/landing

Landing-time helpers for the probe-kit harvest. Two tools.

## rebase-shared.mjs

Every probe family edits the same shared files: the rig census in `Tools/visual-regression/rig-registry.spec.mjs`,
`RIG_TAGS` in `Tools/visual-regression/lib/rig-registry.mjs`, and the shrink-only
`Tools/visual-regression/lib/*-allowlist.mjs` row lists. Two families landing in sequence therefore conflict
textually although their edits compose. The tool takes a frozen lane patch and writes a patch whose hunks on those
files are regenerated against the current tip as the semantic union (every tag once, census total = tip + the lane's
delta, only the lane's own removed rows gone). A section that already applies is kept byte-for-byte. A lane edit the
model does not own is refused by name, never guessed.

It does not own the end-of-file appends (`migration_doc/WEBGPU_DEBUGGING_LOG.md`, `DEFERRED_WORK.md`,
`FEATURE_INVENTORY.md`, the `package.json` tail) or `Tools/visual-regression/archive/README.md`; the landing script's
union resolver handles those. The manifest the tool prints names each of those five files the lane touches on its
"not owned" line; that line is stdout only and never changes the bytes of the output patch.

### Seat invocation

```
node Tools/landing/rebase-shared.mjs --repo <seat> --lane <lane>/_lane-out/<name>.patch \
  --lane-md5 <line 1 of FREEZE_<NAME>.md5> --out <name>.rebased.patch
```

Optional: `--base <rev>` (default `HEAD`), `--lane-repo <clone>` (repeatable; only when the lane's pre-image blob is
missing from the seat's object store), `--tmp-root <dir>`. Then land `<name>.rebased.patch` with its `.md5`.

- Exit 0: written; stdout is a manifest (what was kept, what was regenerated, what is not owned, the whole-patch result).
- Exit 2: refused; one `REFUSED:` line on stderr, nothing written. Any `<out>` and `<out>.md5` from an earlier run are
  deleted first, so a refused run never leaves a stale patch beside it, unless that path IS the lane patch: the check
  is file identity (`dev` + `ino`), not path spelling, so a second spelling of the lane path on a case-insensitive
  filesystem is recognised and the lane is never deleted. Stop on exit 2.
- Exit 1: usage error.

Refusals: lane md5 mismatch; a removed row the tip no longer has (family landed twice, or the row moved); a byTag key
the tip already has; an edit outside `RIG_TAGS`, `total` / `byTag` or the allowlist rows; an edit to a drifted row; a
section that is not a plain modification.

### `git apply --3way --check` is not an oracle

`git apply --cached --3way --check` exits 0 and prints success for patches that leave conflicts when applied for real,
raw lane patches included. The tool therefore never trusts it. Its whole-patch line runs the real
`git apply --cached --3way` into a throwaway index (`GIT_INDEX_FILE` in a temp directory) with
`GIT_OBJECT_DIRECTORY` pointing at a quarantine directory and the repo's store only as a read-only alternate, and
fails on the `with conflicts` text. Do the same when you check an output by hand; the repo is never touched.

### Spec and mutants

```
node --test Tools/landing/rebase-shared.spec.mjs     # or: npm run test-landing-tools
node Tools/landing/rebase-shared-mutants.mjs [parallel=4]
```

The spec builds synthetic git repos under `os.tmpdir()/cesium-lane/landing` and removes them. The mutant runner
makes one transform unreachable in a copy of the tool, runs the spec against it (`REBASE_SHARED_TOOL`) and requires
RED; it never edits the tool and prints its md5 before and after.

## post-landing-spine.mjs

No landing step used to refresh the context spine (`.cache/context-spine/cesium-context.sqlite`), so the seat's DB went
30 batches stale. The seat's landing runbook runs this tool after each push and reads its exit code. It resolves
`--commit` (default `HEAD`), lists the paths that commit touched, and always runs the incremental refresh
(`Tools/query-context.mjs build --incremental --repo <repo> --json`, about 4 s unchanged and 14 s with changes). It then
runs the graphify import (`build --incremental --with-graphify ...`, about 2 min 12 s; it works while the
`cesium-context-spine` MCP server holds the DB) when graphify is due:

- due automatically when a touched path starts with `packages/engine/Source/` or `Tools/context-spine/` (exact prefixes,
  POSIX separators; `packages/engine/Specs/` and `Tools/context-spineX/` do not count);
- `--graphify` forces it, `--no-graphify` skips it; both together is a usage error.

A landing is a squash commit with one parent, whose paths come from `git diff-tree --root`. A merge commit is judged by its
first-parent diff (`git diff <sha>^1 <sha>`). The graphify step is not attempted when the refresh failed, and it fails
unless the build JSON reports `graphify.executed === true` (without a graphify binary it reports `executed: false` and a
reason, which the tool prints).

### Seat invocation

```
node Tools/landing/post-landing-spine.mjs [--repo <root>] [--commit <rev>] [--graphify | --no-graphify] [--timeout-ms <n>]
```

`--repo` defaults to the repo containing the tool; `--timeout-ms` bounds each build step (default 600000). Output is a
`before:` line, an `after:` line (each with `head_sha` shortened to 10 characters, `built_at`, `graphify_imported_at`, or
`none`; the `after:` line also carries the seconds of each step) and a final `verdict:` line.

| Exit | Meaning                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Refreshed, and graphify imported when due.                                                                                                                                                                  |
| 1    | A step failed: spawn error, non-zero exit, timeout, unparsable JSON, graphify not executed, or the DB `head_sha` after the refresh differs from the repo `HEAD` (the build indexes `HEAD`, not `--commit`). |
| 2    | Usage error, or the commit does not resolve.                                                                                                                                                                |

### Spec

```
node --test Tools/landing/post-landing-spine.spec.mjs
```

The spec commits into throwaway git repos under the lane temp root and drives the tool through its runner and meta seams
with a fake build, asserting the calls made, the exit codes and the printed lines. `POST_LANDING_SPINE_TOOL=<path>` aims it
at a mutant copy of the tool.
