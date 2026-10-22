import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicPath, PUBLIC_DIRECTORIES, versionViewerReferences, VIEWER_CACHE_VERSION } from "./package-static.mjs";
import { PDFJS_VERSION, PDFJS_BUILD_FILES } from "./restore-pdfjs.mjs";

test("only explicitly selected public static directories may enter the package", () => {
  assert.deepEqual(PUBLIC_DIRECTORIES, ["js", "css", "bootstrap", "pdfjs", "fonts"]);
  assert.equal(assertPublicPath("pdfjs/build/pdf.worker.mjs"), "pdfjs/build/pdf.worker.mjs");
  for (const name of ["data/files/private.pdf", "config/application.properties", "runtime.json", "../secret", "/js/a.js", "js/../../secret", "js\\secret"]) {
    assert.throws(() => assertPublicPath(name), /allowed public asset/);
  }
});

test("viewer resource references use the pinned cache version without rewriting already versioned URLs", () => {
  const source = '<link href="viewer.css"><script src="../build/pdf.mjs"></script><script src="keep.mjs?v=old"></script>';
  const output = versionViewerReferences(source);
  assert.equal(VIEWER_CACHE_VERSION, "5.4.530-1");
  assert.match(output, /viewer\.css\?v=5\.4\.530-1/);
  assert.match(output, /\.\.\/build\/pdf\.mjs\?v=5\.4\.530-1/);
  assert.match(output, /keep\.mjs\?v=old/);
  assert.equal(versionViewerReferences(output), output);
});

test("PDF.js packaging reuses the exact repaired viewer version and three verified build files", () => {
  assert.equal(PDFJS_VERSION, "5.4.530");
  assert.deepEqual(Object.keys(PDFJS_BUILD_FILES), ["pdf.mjs", "pdf.worker.mjs", "pdf.sandbox.mjs"]);
  assert.ok(Object.values(PDFJS_BUILD_FILES).every((hash) => /^[a-f0-9]{64}$/.test(hash)));
});
