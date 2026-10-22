import test from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import { configureMarkdownImages } from "../web/src/lib/markdown-images.js";

const markdown = configureMarkdownImages(new MarkdownIt({ html: false }));

test("Markdown local images use the authenticated image route", () => {
  const html = markdown.render("![result](/tmp/result.png)");
  assert.match(html, /src="\/api\/local-file-image\?path=%2Ftmp%2Fresult.png"/);
  assert.match(html, /role="button"/);
  assert.match(html, /tabindex="0"/);
});

test("Markdown encoded paths preserve unicode and spaces without double encoding", () => {
  const html = markdown.render("![result](</tmp/测试 image.png>)");
  assert.match(html, /path=%2Ftmp%2F%E6%B5%8B%E8%AF%95\+image.png/);
  assert.doesNotMatch(html, /%25E6/);
});

test("Markdown file URLs are rewritten to authenticated HTTP image requests", () => {
  assert.match(markdown.render("![result](file:///tmp/result.png)"), /src="\/api\/local-file-image\?path=%2Ftmp%2Fresult.png"/);
});

test("Markdown HTTPS and attachment routes remain browser URLs", () => {
  assert.match(markdown.render("![result](https://example.com/a.png)"), /src="https:\/\/example.com\/a.png"/);
  assert.match(markdown.render("![result](/api/attachments/images/abc)"), /src="\/api\/attachments\/images\/abc"/);
});

test("Markdown unsupported and unsafe image schemes do not become image requests", () => {
  assert.doesNotMatch(markdown.render("![result](relative.png)"), /<img/);
  assert.doesNotMatch(markdown.render("![result](javascript:alert%281%29)"), /<img/);
});
