---
name: upstream-sync
description: Procedure and conflict rules for merging upstream CesiumGS main into the fork, two-parent recovery and post-sync tasks. Read before any upstream sync.
---

# Upstream Sync Procedure

Part of the fork's rules: moved here from `CLAUDE.md` (see its "On-demand Skills" section) so it loads only when needed, and it binds exactly as `CLAUDE.md` does.

This fork tracks `https://github.com/CesiumGS/cesium` as `upstream`.

1. Create safety branch: `git branch pre-upstream-merge main`
2. Fetch upstream: `git fetch upstream main`
3. Check divergence: `git rev-list --count main..upstream/main`
4. Merge: `git merge upstream/main --no-edit`
5. Resolve conflicts — for ES6-class fork files (e.g. `ClippingPolygon.js`, `Scene.js`, `ShaderBuilder.js`, `CreditDisplay.js`), never `git checkout --theirs`: it reverts the fork's ES6 class conversion, and "re-add WebGPU code" does not repair that damage. Start from the fork's `ours` (ES6 class) and port upstream's semantic changes into it; verify with `npm run verify-es6-shape` (`Tools/upstream-shape-guard.mjs`). See `UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md` §3 for the measured conflict census (36 of the sync's 79 conflict hunks, 46%, are this exact mechanism).
6. Verify two-parent merge commit: `git cat-file -p HEAD` must show TWO parents. If `MERGE_HEAD` was lost during conflict resolution, rebuild it — `git commit-tree $(git rev-parse "HEAD^{tree}") -p <our-commit> -p <upstream-commit> -m "<message>"`, then `git reset --hard` onto the result
7. Push: `git push origin main --force-with-lease`

Prerequisites: `upstream` points at `https://github.com/CesiumGS/cesium.git` and `origin` at this fork.

After the merge: review `CHANGES.md` for upstream features needing WebGPU equivalents; diff `packages/engine/Source/Scene/` and the GLSL shaders against the merge base for new rendering features that need a WGSL twin; run `npm install` for new dependencies; and record the new features and their WebGPU status in `migration_doc/WEBGPU_MIGRATION_STATUS.md`.

Conflicts concentrate in the upstream files the fork modifies — Scene files carrying WebGPU routing (`Scene.js`, `Primitive.js`, `PointPrimitiveCollection.js`, `SkyBox.js`, `View.js`), the build system (`scripts/build.js`, `gulpfile.js`), `package.json`, and the widget entry points. Files that exist only in this fork (`Renderer/WebGPU/`, `Shaders/WebGPU/`, `Apps/WebGPUTest/`) never conflict.
