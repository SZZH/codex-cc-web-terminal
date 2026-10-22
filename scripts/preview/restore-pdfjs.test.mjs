import test from "node:test";
import assert from "node:assert/strict";
import { PDFJS_VERSION, assertViewerVersion, verifyArchive } from "./restore-pdfjs.mjs";

test("only the exact bundled PDF.js version is accepted, never latest or a different worker API", () => {
  assert.equal(assertViewerVersion('const viewerVersion = "5.4.530";'), PDFJS_VERSION);
  for (const source of ['const viewerVersion = "latest";', 'const viewerVersion = "5.4.624";', "no version", 'const viewerVersion = "5.4.530"; const viewerVersion = "6.0.0";']) {
    assert.throws(() => assertViewerVersion(source), /pinned package/);
  }
});

test("a substituted or truncated archive is rejected before any jar mutation", () => {
  assert.throws(() => verifyArchive(Buffer.from("not the official package")), /integrity mismatch/);
  assert.throws(() => verifyArchive(Buffer.alloc(0)), /integrity mismatch/);
});
