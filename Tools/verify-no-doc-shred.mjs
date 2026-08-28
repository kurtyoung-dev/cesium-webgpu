// verify-no-doc-shred.mjs
//
// @purpose Fails when any migration_doc markdown file contains a long run of single-character lines - the signature of a splice-spread-over-string edit defect that has landed shredded ledger sections three times.
// @status ACTIVE
//
// The defect shape: a seat-side update script builds a section as an array,
// joins it into one string, and then spreads that string into a line-array
// splice. JavaScript spreads a string into characters, so the section lands
// one character per line. The content survives (it spells the intended text)
// but the document is destroyed, and nothing in the landing gates noticed -
// prettier ignores migration_doc, the mirror comparator does not parse these
// files, and the section's own anchor text still greps. This check is the
// missing gate: a run of RUN_LIMIT consecutive lines each one character or
// shorter cannot occur in honest prose or tables, so it fails loudly with the
// file and line span. Exit 0 clean, 1 on any shred, 2 on scan failure.
import fs from "node:fs";
import path from "node:path";

const RUN_LIMIT = 20;
const root = path.resolve(process.argv[2] ?? "migration_doc");

let files;
try {
  files = fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(root, f));
} catch (error) {
  console.error(`verify-no-doc-shred: cannot scan ${root}: ${error.message}`);
  process.exit(2);
}

let shreds = 0;
for (const file of files) {
  const lines = fs.readFileSync(file, "latin1").toString().split(/\r?\n/);
  let run = 0;
  let max = 0;
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    run = lines[i].length <= 1 ? run + 1 : 0;
    if (run > max) {
      max = run;
      end = i;
    }
  }
  if (max >= RUN_LIMIT) {
    shreds += 1;
    console.error(
      `SHRED: ${path.relative(process.cwd(), file)} - ${max} consecutive single-character lines ending at line ${end + 1}`,
    );
  }
}

if (shreds > 0) {
  console.error(
    `verify-no-doc-shred: ${shreds} file(s) shredded of ${files.length} scanned`,
  );
  process.exit(1);
}
console.log(`verify-no-doc-shred: ${files.length} files clean`);
