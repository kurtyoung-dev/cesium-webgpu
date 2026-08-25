---
name: audit-cesium-certification
description: Independently audit Cesium WebGPU certification claims, probes, gates, evidence artifacts, frozen review packets, and campaign ledgers. Use for read-only verification reviews, GO or NO-GO decisions, prior-finding carry-forward, scoring-topology audits, provenance checks, and adversarial mutant design. Do not use to implement the repair in the same review pass.
---

# Audit Cesium Certification

Perform an evidence-first, read-only review. Do not edit the candidate, run unauthorized browser or
evidence work, or let the expected verdict substitute for independent recomputation.

## 1. Freeze the audit subject

1. Read `AGENTS.md`, the current state, charter, rulings, owning queue, prior audits, and handoff.
2. Record the exact commit/tree and dirty-state boundary, candidate paths, byte counts, SHA-256
   values, claimed checks, and evidence namespaces.
3. Stop if the candidate drifts. Do not review a moving tuple.
4. Carry every prior finding forward as OPEN, FIXED, SUPERSEDED, ACCEPTED-RISK, or NOT-RETESTED.
   Absence from a later audit is not closure.

## 2. Inventory the claims and executable boundary

- Map each headline claim to the exact predicate, retained primitive, source path, and artifact that
  proves it.
- Traverse the probe's static and dynamic imports through gate libraries and helpers. Include every
  load-bearing policy, schema, shader, asset, adapter, and generated/served dependency.
- Classify prerequisites as source-only, build, browser, assets, server, or external evidence.
- Distinguish historical facts from current claims and facts from inferences. Attribute work only
  to the extent identities and records support it.

## 3. Recompute evidence independently

1. Validate canonical schema, exact keys/cardinalities, immutable bindings, hashes, run identity,
   chronology, status, and exit code.
2. Recompute metrics and the final fold from retained primitives or persisted bytes; do not trust
   reported summaries.
3. Verify current source, build, served runtime, browser/adapter, content, and transitive dependency
   identities for every claim that needs them.
4. Confirm that the measured subject is present and that capture, scoring, and draw/readiness
   witnesses belong to the same task or rendered frame.
5. Report the exact audited fraction. Never generalize "none found" beyond the recomputed sample.

## 4. Audit scoring topology

Look beyond numeric thresholds. Treat these as integrity findings unless an explicit ruling permits
them:

- deleting or weakening a guard after it turns red;
- demoting a predicate to reported-only;
- adding a subject-absent or skip condition that makes the red unreachable;
- moving failures into a quarantinable lane;
- calibrating a threshold from the same samples it judges;
- allowing a proxy metric to carry a stronger headline claim; or
- changing a predecessor schema or fold while claiming byte-preserving compatibility.

A trustworthy criterion miss is FAIL. ERROR is harness/runtime failure. STRUCTURAL means the
required subject, prerequisite, provenance, or contract could not be established.

## 5. Challenge coordinated failure modes

Design mutants and reproductions that attack relationships, not only individual fields:

- mutate both backends consistently;
- alter primitives together with their summaries while leaving persisted bytes unchanged;
- permute positional mappings on every copy;
- forge stale but well-formed hashes or provenance across all consumers;
- introduce initial-claim, replacement, cleanup, and foreign-owner races;
- delay browser, response, device-loss, or cleanup events across settlement boundaries; and
- remove the subject while preserving green-looking metadata.

Require inverse controls: malformed evidence stays STRUCTURAL, while valid evidence with a real
product miss remains FAIL.

## 6. Review lifecycle and recoverability

Audit UUID archives, canonical RUNNING/latest, write-once first-red, locks, receipts, retries,
foreign-successor preservation, cleanup bounds, and crash recovery. A successful artifact is not
certifying if publication can lose a predecessor, expose stale PASS during RUNNING, unlock with
unsettled work, or accept noncanonical/mutable evidence.

## 7. Issue the verdict

Use GO only when the exact frozen tuple satisfies every required predicate and all blockers have
closure evidence. Otherwise issue NO-GO and list findings by severity, reproduction, consequence,
and smallest safe repair boundary. Separate confirmed facts, likely inferences, coverage gaps, and
unverified claims.

Do not repair the candidate during the independent review. If asked to implement afterward, end the
review role, create a new bounded writer wave, freeze a new tuple, and obtain a fresh independent
reviewer.
