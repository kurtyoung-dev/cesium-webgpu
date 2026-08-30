# Maglor - research queue encoding normalization

- Status: **COMPLETE / POST-WRITE INDEPENDENT GO**
- Owner: root orchestrator
- Research lead: Maglor
- Byte forensics: Mablung
- Tooling review: Beechbone
- Target: migration_doc/QUEUE_2026-08-29_RESEARCH_DISPATCH.md

## Bounded purpose

Normalize one systematically corrupted Markdown queue so strict UTF-8 tools and the patch engine can
read it. This lane changes encoding bytes only. It must not alter queue meaning, status, ownership,
ordering, whitespace, line endings, or any unrelated file.

The target preimage is 204,717 bytes with SHA-256
542870963444838af545add9e5c116db9d4976f98eae65c9318843ae3ad0a3da. It has no BOM and contains
1,072 CRLF sequences, no bare LF, and no bare CR.

## Registered replacement map

Exactly 71 original byte offsets may change:

- 23 standalone B7 bytes become UTF-8 U+00B7: 165229, 165233, 166369, 166373, 167232, 167236,
  168324, 168332, 169077, 169082, 169941, 169950, 170795, 170799, 171676, 171680, 172304,
  172313, 172855, 172866, 173378, 173982, 173986.
- 6 standalone A7 bytes become UTF-8 U+00A7: 165783, 166849, 167715, 168631, 169505, 173307.
- 12 standalone 92 bytes become UTF-8 U+2192: 168451, 174708, 174718, 174728, 174738, 174748,
  174768, 174778, 174788, 174798, 174808, 174818.
- 26 ASCII control 14 bytes become UTF-8 U+2014: 19238, 22337, 22573, 23344, 23507, 23511,
  23535, 162333, 164229, 164640, 165816, 166754, 167335, 167653, 167747, 168658, 169323,
  169843, 170269, 170940, 171351, 171866, 172433, 172990, 173467, 174254.
- 4 ASCII control 13 bytes become UTF-8 U+2013: 23220, 162807, 169486, 172858.

The mappings are the exact low-byte truncations of the intended Unicode scalars. Context independently
classifies them as list separators, section references, arrows, em dashes, and en dashes.

## Mechanical exception

The ordinary patch engine rejects the invalid preimage before applying a hunk. A one-purpose
root-owned binary reconstruction is therefore authorized only after an independent pre-write review
matches this record and the frozen preimage. It must read the original as bytes, require every
registered offset to contain its expected byte, copy every unregistered original byte unchanged,
write a sibling temporary file, validate the complete candidate, and atomically replace only the
named target. Whole-file character decoding/re-encoding, editor save-as, Get-Content/Set-Content,
Prettier, and CP1252 or Latin-1 transcoding are prohibited.

## Acceptance

The reconstructed candidate must satisfy all of the following:

- exactly 71 replacement sites and 204,646 original bytes copied unchanged;
- 204,830 total bytes;
- SHA-256 47f51f3947c833109913ba92581ac0d4a13a793f67537cfe1116780f18873a29;
- strict UTF-8 decoding succeeds;
- zero U+FFFD scalars and zero unexpected ASCII controls;
- no BOM, 1,072 CRLF sequences, no bare LF, and no bare CR;
- every untouched span is byte-identical to the frozen preimage;
- no repository path other than the target and this record changes in the lane.

After replacement, a fresh independent reviewer must rederive the invalid-byte/control census, verify
the registered contexts and candidate identity, and confirm ordinary patch tooling can read the file.
This repair does not itself change or approve any queue item.

## Execution and independent review

Root revalidated the exact 204,717-byte preimage and 71 registered source bytes, reconstructed the
candidate in memory, and wrote it through a sibling temporary file before same-directory replacement.
The temporary file was absent after replacement. The terminal target was 204,830 bytes / SHA-256
47f51f3947c833109913ba92581ac0d4a13a793f67537cfe1116780f18873a29, with 204,646 original
bytes copied unchanged, strict UTF-8, zero U+FFFD or unexpected controls, no BOM, 1,072 CRLF, and no
bare LF or CR.

Pengolodh independently returned unconditional pre-write GO after rederiving the complete offset map,
candidate identity, 72 untouched spans, reverse collapse, and EOL/control predicates. After the write,
fresh reviewer Rúmil independently returned unconditional GO. Rúmil rederived all 71 characters and
contexts, reproduced the exact frozen preimage by reverse collapse, found zero untouched-span
mismatches, and confirmed patch-engine readability through a non-writing impossible-context probe.

The normalized queue identity above is the terminal artifact of this encoding-only lane. Subsequent
ordinary queue edits use the patch engine and produce their own new hashes; they do not retroactively
alter the reviewed normalization evidence. No queue status, ownership, ordering, or meaning changed in
this lane.
