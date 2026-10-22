import test from "node:test";
import assert from "node:assert/strict";
import { FONT_VERSION, fontDirectory, verifyFontArchive } from "./install-fonts.mjs";

test("fonts remain private to the preview LibreOffice application", () => {
  assert.equal(FONT_VERSION, "2.004");
  assert.equal(fontDirectory("/private/preview/runtime.json", "/private/preview/LibreOffice.app/Contents"),
    "/private/preview/LibreOffice.app/Contents/Resources/fonts/truetype");
  for (const officeHome of ["/Applications/LibreOffice.app/Contents", "/private/preview/../../Library/Fonts", "/private/preview-other/LibreOffice.app/Contents"]) {
    assert.throws(() => fontDirectory("/private/preview/runtime.json", officeHome), /isolated preview runtime/);
  }
});

test("fonts are pinned to the verified release, and an invalid archive cannot be installed", () => {
  assert.throws(() => verifyFontArchive(Buffer.from("latest font archive")), /2.004 archive checksum mismatch/);
  assert.throws(() => verifyFontArchive(Buffer.alloc(0)), /checksum mismatch/);
});
