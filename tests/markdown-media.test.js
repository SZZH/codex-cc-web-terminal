import test from "node:test";
import assert from "node:assert/strict";
import { createThreadItemMarkdown } from "../web/src/lib/thread-item-markdown.js";
import { mediaSource } from "../web/src/lib/markdown-media.js";

function render(body, cwd = "/work/项目") {
  const env = { media: [] };
  const html = createThreadItemMarkdown({ getCwd: () => cwd }).renderMarkdown(body, env);
  return { html, media: env.media };
}

test("Markdown media embeds preserve absolute, relative and file URL paths with spaces and Unicode", () => {
  const cases = [
    ["![演示](</tmp/测试 视频.mp4>)", "/tmp/测试 视频.mp4", "video"],
    ["![录音](音频/会议 录音.mp3)", "音频/会议 录音.mp3", "audio"],
    ["![演示](file:///tmp/%E6%B5%8B%E8%AF%95%20%E8%A7%86%E9%A2%91.webm)", "/tmp/测试 视频.webm", "video"],
    ["![录音](./音频/录音.WAV)", "./音频/录音.WAV", "audio"]
  ];
  for (const [body, target, kind] of cases) {
    const result = render(body);
    assert.equal(result.media.length, 1, body);
    assert.equal(result.media[0].target, target);
    assert.equal(result.media[0].cwd, "/work/项目");
    assert.equal(result.media[0].kind, kind);
    const href = new URL(result.media[0].href, "https://chat.example");
    assert.equal(href.pathname, "/api/previews/open");
    assert.equal(href.searchParams.get("target"), target);
    assert.equal(href.searchParams.get("cwd"), "/work/项目");
    assert.doesNotMatch(result.html, /<img|<audio|<video/);
    assert.equal(result.html.trim(), "", "media-only paragraphs should not leave empty text blocks");
  }
});

test("remote media retains query strings and fragments without becoming a local file grant", () => {
  const url = "https://media.example/clip%20one.MP4?download=1&signature=abc#t=2";
  const { html, media } = render(`![Preview](${url})`);
  assert.equal(media.length, 1);
  assert.equal(media[0].url, url);
  assert.equal(media[0].href, url);
  assert.equal(media[0].target, undefined);
  assert.equal(media[0].kind, "video");
  assert.equal(html.trim(), "");
});

test("invalid media protocols, credentials, control characters and local service URLs are not playable sources", () => {
  for (const source of [
    "javascript:alert(1).mp4", "data:video/mp4;base64,AAAA.mp4", "blob:https://media.example/clip.mp4",
    "ftp://media.example/a.mp3", "https://user:secret@media.example/a.mp3", "file://another-host/tmp/a.mp4",
    "http://localhost:5173/clip.mp4", "http://127.0.0.1:5173/clip.mp4", "//media.example/clip.mp4",
    "/tmp/a\n.mp4", "/tmp/%00bad.mp3", "/tmp/%not-a-valid-escape.mp3"
  ]) assert.equal(mediaSource(source, "/work"), null, source);
  assert.equal(render("![unsafe](javascript:alert%281%29.mp4)").media.length, 0);
});

test("code examples and ordinary links do not silently create inline players", () => {
  const { html, media } = render("`![example](/tmp/clip.mp4)`\n\n```md\n![example](/tmp/clip.mp4)\n```\n\n[Play recording](/tmp/recording.mp3)");
  assert.equal(media.length, 0);
  assert.match(html, /<code>/);
  assert.match(html, /local-preview-link/);
  assert.match(html, /target=%2Ftmp%2Frecording.mp3/);
  assert.match(html, /Play recording/);
});

test("media extraction preserves surrounding Markdown and deduplicates repeated embeds with stable keys", () => {
  const first = render("Before **video**.\n\n![First](/tmp/clip.mp4)\n\n![Duplicate](/tmp/clip.mp4)\n\nAfter.");
  const streamed = render("Before **video**.\n\n![Updated title](/tmp/clip.mp4)\n\nAfter. More output.");
  assert.equal(first.media.length, 1);
  assert.match(first.html, /Before <strong>video<\/strong>/);
  assert.match(first.html, /After/);
  assert.equal(streamed.media[0].key, first.media[0].key);
  assert.equal(streamed.media[0].title, "Updated title");
  assert.notEqual(render("![Video](/tmp/another.mp4)").media[0].key, first.media[0].key);
});

test("ordinary images keep their existing authenticated image and remote URL behavior beside media", () => {
  const { html, media } = render("![Picture](</tmp/测试 图片.png>)\n\n![Remote](https://media.example/picture.jpg)\n\n![Audio](/tmp/audio.m4a)");
  assert.equal(media.length, 1);
  assert.equal(media[0].kind, "audio");
  assert.match(html, /src="\/api\/local-file-image\?path=%2Ftmp%2F%E6%B5%8B%E8%AF%95\+%E5%9B%BE%E7%89%87.png"/);
  assert.match(html, /src="https:\/\/media.example\/picture.jpg"/);
  assert.match(html, /class="markdown-image"/);
  assert.match(html, /loading="lazy"/);
});

test("renderers without a media collection keep an escaped usable media link", () => {
  const html = createThreadItemMarkdown().renderMarkdown('![Play <unsafe>](/tmp/clip.mp4)');
  assert.match(html, /<a href="\/api\/previews\/open\?target=%2Ftmp%2Fclip.mp4">/);
  assert.match(html, /Play &lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<unsafe>|<img/);
});
