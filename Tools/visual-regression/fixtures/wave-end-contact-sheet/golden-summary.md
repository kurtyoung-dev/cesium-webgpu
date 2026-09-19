# Wave-end gate: kit-wave-b-fixture

- Verdict: **PASS**
- Started: 2026-09-19T00:00:00.000Z
- Finished: 2026-09-19T00:00:02.000Z
- Source commit: `ffffffffffffffffffffffffffffffffffffffff`
- Source dirty: false
- Source identity: `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`
- Baseline update requested: no
- Baseline reason: n/a

## Served subject

- Base: `http://localhost:8094`
- Sandcastle base: `http://localhost:8095`

| Artifact | Origin | Bytes | MD5 |
| --- | --- | ---: | --- |
| Build/CesiumUnminified/Cesium.js | http://localhost:8094 | 42 | 11111111111111111111111111111111 |

## Plan

| Step | Command | Bindable now | Phase | Bound by | Declared exit map | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| fixture-step | `node fixture-step.mjs --fixture` | yes | post-spawn | child | none | fixture step always binds |

## Steps

| Step | Spawned | Raw exit | Signal | Error | Timeout | Cleanup closed | Descendant quiescence | Verdict bound by | Normalized |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| fixture-step | yes | 0 |  |  | no | yes | unproven (Direct-child close does not prove descendant process-tree quiescence.) | child | PASS (typed) |
