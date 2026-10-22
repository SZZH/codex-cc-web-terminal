import test from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import { configureMarkdownImages } from "../web/src/lib/markdown-images.js";
import { configureMarkdownLinks, handleLocalPreviewLink, localPreviewTarget, previewTargetFromHref } from "../web/src/lib/markdown-links.js";

function renderLinks(source, cwd = "/work/项目") {
  const md = configureMarkdownLinks(configureMarkdownImages(new MarkdownIt({ html: false, linkify: true })), { getCwd: () => cwd });
  const tokens = md.parse(source, {});
  const html = md.renderer.render(tokens, md.options, {});
  const children = tokens.flatMap((token) => token.children || []);
  return { html, links: children.filter((token) => token.type === "link_open"), images: children.filter((token) => token.type === "image") };
}

test("Markdown absolute, relative and file URLs preserve Chinese paths and spaces in preview requests", () => {
  for (const [source, target] of [
    ["[文档](</work/项目/测试 report.pdf>)", "/work/项目/测试 report.pdf"],
    ["[文档](/work/项目/测试 report.pdf)", "/work/项目/测试 report.pdf"],
    ["[文档](docs/季度%20报告.docx)", "docs/季度 报告.docx"],
    ["[文档](file:///work/%E9%A1%B9%E7%9B%AE/test%20report.xlsx)", "/work/项目/test report.xlsx"],
    ["[图表](../reports/chart.svg)", "../reports/chart.svg"],
    ["[记录](./100%2520real.txt)", "./100%20real.txt"]
  ]) {
    const { links } = renderLinks(source);
    assert.equal(links.length, 1, source);
    assert.deepEqual(previewTargetFromHref(links[0].attrGet("href")), { target, cwd: "/work/项目" });
  }
});

test("local service hosts use preview gateway links without changing the service path or query", () => {
  for (const target of ["http://localhost:3000/demo?q=中文", "http://127.0.0.1:5173", "http://0.0.0.0:8080/app", "http://[::1]:3000/"]) {
    const { links } = renderLinks(`[服务](${target})`);
    const request = previewTargetFromHref(links[0].attrGet("href"));
    assert.equal(new URL(request.target).hostname, new URL(target).hostname);
    assert.equal(new URL(request.target).pathname, new URL(target).pathname);
    assert.equal(new URL(request.target).searchParams.get("q"), new URL(target).searchParams.get("q"));
  }
  assert.equal(localPreviewTarget("localhost:3000/demo").target, "http://localhost:3000/demo");
});

test("external links, anchors and mailto remain ordinary browser links; code and dangerous schemes stay inert", () => {
  for (const target of ["https://example.com/doc", "https://localhost.example.com", "#section", "mailto:team@example.com"]) {
    const { links } = renderLinks(`[link](${target})`);
    assert.equal(links[0].attrGet("href"), target);
    assert.equal(previewTargetFromHref(target), null);
  }
  for (const source of ["[bad](javascript:alert%281%29)", "[bad](vbscript:bad)", "[bad](data:text/html;base64,abc)", "`[file](/tmp/a.pdf)`"]) {
    assert.equal(renderLinks(source).links.length, 0);
  }
  assert.equal(localPreviewTarget("https://user:password@localhost:3000"), null);
});

test("preview link handling preserves authenticated Markdown image behavior and quoted link titles", () => {
  const { images, links } = renderLinks('![图片](</tmp/测试 image.png>) [PDF](/tmp/report.pdf "报告标题")');
  assert.equal(images.length, 1);
  assert.equal(new URL(images[0].attrGet("src"), "https://app.example").searchParams.get("path"), "/tmp/测试 image.png");
  assert.equal(links[0].attrGet("title"), "报告标题");
  assert.equal(previewTargetFromHref(links[0].attrGet("href")).target, "/tmp/report.pdf");
});

test("normal clicks and Enter open preview; modified clicks, unrelated anchors and unsafe hrefs keep default behavior", () => {
  const href = renderLinks("[doc](docs/a.pdf)").links[0].attrGet("href");
  const opened = [];
  function event(patch = {}, link = href) {
    const anchor = { getAttribute: () => link };
    return { type: "click", button: 0, target: { closest: () => anchor }, currentTarget: { contains: (element) => element === anchor },
      preventDefault() { this.prevented = true; }, stopPropagation() {}, ...patch };
  }
  const click = event();
  assert.equal(handleLocalPreviewLink(click, (target) => opened.push(target)), true);
  assert.equal(click.prevented, true);
  assert.deepEqual(opened[0], { target: "docs/a.pdf", cwd: "/work/项目" });
  assert.equal(handleLocalPreviewLink(event({ type: "keydown", key: "Enter" }), (target) => opened.push(target)), true);
  for (const pending of [event({ ctrlKey: true }), event({ metaKey: true }), event({ button: 1 }), event({ type: "keydown", key: " " }), event({}, "https://example.com"), event({}, "/api/previews/open?target=javascript%3Aalert(1)")]) {
    assert.equal(handleLocalPreviewLink(pending, (target) => opened.push(target)), false);
    assert.equal(pending.prevented, undefined);
  }
  assert.equal(opened.length, 2);
});
