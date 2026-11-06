---
name: probe-kit
description: Probe kit and the rendering-fix workflow — kit-first order, guide sync. Read before fixing a rendering bug, writing or running probes, or claiming a fix.
---

# Probe Kit and Rendering-Fix Verification

Part of the fork's rules: moved here from `CLAUDE.md` (Principle 8 and "Probe Kit - Kit First") so it loads only when needed, and it binds exactly as `CLAUDE.md` does. The full guide and the generated inventory of every piece: [`PROBE_KIT_GUIDE.md`](../../../migration_doc/PROBE_KIT_GUIDE.md). For the kit-first search read its "3. Building a new probe from pieces (kit first)" and the "4. Inventory" table for the piece kind you need ("Kit pieces", "Metrics", "Rigs by tag"), not the whole file. Verdicts are `PASS` 0 / `FAIL` 1 / `ERROR` 2 / `STRUCTURAL` 3 (Charter §1); the frozen table is `Tools/visual-regression/lib/verdict-exit-gate.mjs`.

## Verify Rendering Fixes via Playwright (Principle 8)

If a fix is visually verifiable (renders a globe, sky, tiles, post-process effects, picking, etc.), the verification must be done via an automated Playwright probe BEFORE the fix is claimed to work — not by asking the user to reload and inspect.

**Required workflow for any WebGPU rendering fix:**

1. **Reproduce the symptom in a probe first**, built from probe-kit pieces (see "Probe Kit"), that loads the exact URL/camera/mode that triggers the bug. The probe MUST match the user's reproduction (saved-view query params, terrain/imagery picker selections, scene mode) — default-camera probes miss LOD-specific and view-specific artifacts.
2. **Capture WebGL vs WebGPU + compute a pixel diff.** Record the baseline mismatch percentage.
3. **Apply the fix → rebuild → re-run the probe.** Compare the new mismatch percentage against baseline. A "fix" that doesn't move the diff is not a fix.
4. **Read the output PNGs yourself.** Don't claim a fix works just because the diff dropped — visually confirm against the WebGL screenshot that the artifact is gone and no new artifact appeared.
5. **Only then ping the user.** Surface the probe name, the mismatch delta, and the screenshots so the user can spot-check rather than diagnose.

**Anti-patterns to avoid:**

- "Try reloading and let me know if the ring is gone" — the user's job is not to re-verify what you can verify automatically.
- "The build has the fix, so it should work" — bytes in the build output do not prove the runtime path is reached or the bug is gone.
- Default-camera probes when the user reported the bug at a specific saved view — match their reproduction exactly. Probe-first applies even when "I'm just going to be quick".

## Probe Kit - Kit First

When we need probe functionality, we first see if it already exists; if it does not, we create a new modular piece
(the maintainer's directive is quoted in the guide). The probe kit under `Tools/visual-regression/` is the shared
runtime (`lib/probe-runtime.mjs`), the rig registry (`lib/rig-registry.mjs`, `rigs/*.mjs`: scenes as data), the stage
and step pieces in `lib/`, the metrics in `lib/metrics/`, the capture seam and the contact sheet. How it works, and the
inventory of every piece: [`migration_doc/PROBE_KIT_GUIDE.md`](../../../migration_doc/PROBE_KIT_GUIDE.md).

**Before writing any probe code, in this order:**

1. **Rig.** Is the scene already a rig? If not, declare one as data in `rigs/<id>.mjs`.
2. **Stage.** Is there a stage or step piece for the scene kind? Reuse it, or add the missing dial to it.
3. **Metric.** Is there a metric? Reuse it, and measure in Node from the captured PNG.
4. **Probe.** Does a probe on the runtime already capture the scene? Extend its scene table.
5. **Only then** write ONE new modular piece in `lib/` (one responsibility, an `@purpose`/`@status` header, a Node
   spec with an inertness mutant). **Never** a bespoke probe or driver that launches its own browser.

**Keep the guide in sync**, as for `DEBUGGING_GUIDE.md`: a change that adds or removes a kit piece, metric, rig or
runtime probe regenerates the guide's inventory in the same change
(`node Tools/visual-regression/probe-kit-inventory.mjs --write migration_doc/PROBE_KIT_GUIDE.md`; `--check` fails on
drift). A new probe also falls under the `DEBUGGING_GUIDE.md` sync duty: read `/debug-console` when you add one.

The seat's landing step for the kit's shared files (`Tools/landing/rebase-shared.mjs`) is in `/seat-duties`.
