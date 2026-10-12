import { strict as assert } from "node:assert";
import { test } from "node:test";
import { OutputReader, ProgressUpdate, parseProgress } from "../../progress";

// What code2pdf 3.12 wrote to stderr for `code2pdf -a scripts -o a.pdf --exclude nothing_here`
const RUN = `Warning: --exclude 'nothing_here' matched nothing
code2pdf: 11 files, 2,918 lines (~62 pages)
  [1/3] Preparing layout…  0:00 elapsed
  [2/3] Laying out page 7 of ~62 (10%), 0:02 elapsed
  [2/3] Laying out page 31 of ~62 (50%), 0:03 elapsed
  [2/3] Laying out page 56 of ~62 (90%), 0:04 elapsed
  [3/3] Writing PDF…  0:05 elapsed, ~0:02 left
Done: 61 pages in 0:07 → /tmp/a.pdf
`;

function read(text: string, chunk = text.length) {
  const updates: ProgressUpdate[] = [];
  const reader = new OutputReader((u) => updates.push(u));
  for (let i = 0; i < text.length; i += chunk) {
    reader.feed(text.slice(i, i + chunk));
  }
  reader.end();
  return { reader, updates };
}

test("a whole run: progress goes up to 1, with the page count and the warning", () => {
  const { reader, updates } = read(RUN);
  assert.equal(reader.pages, 61);
  assert.deepEqual(reader.warnings, ["--exclude 'nothing_here' matched nothing"]);
  assert.equal(updates[0].message, "11 files, ~62 pages");
  const fractions = updates.map((u) => u.fraction).filter((f) => f !== undefined) as number[];
  assert.deepEqual([...fractions].sort((a, b) => a - b), fractions, "never goes backwards");
  assert.equal(fractions[fractions.length - 1], 1);
  assert.deepEqual(updates.map((u) => u.message).filter(Boolean).slice(1),
    ["Preparing layout", "Laying out page 7 of ~62", "Laying out page 31 of ~62", "Laying out page 56 of ~62", "Writing PDF"]);
});

test("lines split across chunks read the same", () => {
  const whole = read(RUN);
  for (const size of [1, 7, 64]) {
    const split = read(RUN, size);
    assert.deepEqual(split.updates, whole.updates);
    assert.equal(split.reader.pages, 61);
  }
});

test("parts mode", () => {
  assert.deepEqual(parseProgress("  in 4 parts of ~200 pages, 3 at a time"), { message: "In 4 parts" });
  const rendering = parseProgress("  [2/3] Rendering page 80 of ~800 (10%), 0:05 elapsed  (parts done: 0/4)");
  assert.equal(rendering?.message, "Rendering page 80 of ~800");
  assert.ok(Math.abs((rendering?.fraction ?? 0) - 0.135) < 1e-9);
  assert.equal(parseProgress("  [3/3] Joining 4 parts…  0:30 elapsed")?.message, "Joining 4 parts");
});

test("-s reports on stdout", () => {
  const reader = new OutputReader();
  reader.feed("Converting to a PDF file for src/app.py:10-20\nPDF created at /tmp/app.pdf\n", "stdout");
  reader.end();
  assert.equal(parseProgress("Converting to a PDF file for src/app.py:10-20")?.message, "src/app.py:10-20");
  assert.equal(parseProgress("PDF created at /tmp/app.pdf")?.fraction, 1);
  assert.equal(reader.errorMessage(), undefined);
});

test("stdout and stderr keep their own partial lines", () => {
  const reader = new OutputReader();
  reader.feed("Warning: one", "stderr");
  reader.feed("Converting to a PDF", "stdout");
  reader.feed(" two\n", "stderr");
  reader.end();
  assert.deepEqual(reader.warnings, ["one two"]);
});

test("errors, notes, and warnings repeated after Done: are listed once", () => {
  const { reader } = read([
    "Warning: app.py:10-12 stops inside a block that goes on to line 20; to print it whole, use app.py:10-20",
    "Note: --changed HEAD: 1 untracked file(s) not included (git add them, or list them with --files-from): new.py",
    "Done: 2 pages in 0:01 → /tmp/x.pdf",
    "Warning: app.py:10-12 stops inside a block that goes on to line 20; to print it whole, use app.py:10-20",
  ].join("\n"));
  assert.equal(reader.warnings.length, 1);
  assert.equal(reader.notes.length, 1);
  assert.equal(reader.pages, 2);

  const failed = read("Error: unknown theme 'nosuch'; run `code2pdf --list-themes` to see the names\n").reader;
  assert.equal(failed.errorMessage(), "unknown theme 'nosuch'; run `code2pdf --list-themes` to see the names");
  assert.equal(read("File not found.\n").reader.errorMessage(), "File not found.");
  assert.equal(read("code2pdf: stopped (SIGINT); nothing was written\n").reader.errorMessage(),
    "code2pdf: stopped (SIGINT); nothing was written");
});

test("big numbers have commas", () => {
  const { reader, updates } = read("code2pdf: 1,204 files, 310,532 lines (~7,702 pages)\nDone: 7,689 pages in 6:01 → /tmp/big.pdf\n");
  assert.equal(updates[0].message, "1,204 files, ~7,702 pages");
  assert.equal(reader.pages, 7689);
  assert.equal(parseProgress("code2pdf: 1 file, 11 lines (~2 pages)")?.message, "1 file, ~2 pages");
});
