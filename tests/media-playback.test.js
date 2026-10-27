import test from "node:test";
import assert from "node:assert/strict";
import { createMediaPlayback, previewMedia } from "../web/src/lib/media-playback.js";

const id = "Aa_9-bZ0".repeat(4);
const grant = (kind = "video", token = id) => ({ id: token, kind: "file", title: "clip.mp4",
  media: { kind, url: `/api/previews/${token}/media`, contentType: kind === "video" ? "video/mp4" : "audio/mpeg" } });
const visibleState = ({ src, status, error }) => ({ src, status, error });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function clock() {
  const timers = new Map(); let sequence = 0;
  return { timers, setTimer(callback) { timers.set(++sequence, callback); return sequence; }, clearTimer(key) { timers.delete(key); } };
}

test("media grants accept base64url IDs and only their exact authenticated same-origin route", () => {
  assert.deepEqual(previewMedia(grant()), grant().media);
  for (const result of [
    { ...grant(), kind: "service" }, { ...grant(), id: "../other" },
    { ...grant(), media: { ...grant().media, kind: "image" } },
    ...["https://attacker.example/clip.mp4", `//attacker.example/api/previews/${id}/media`,
      `/api/previews/${id}/media?redirect=evil`, `/api/previews/${id}/media/../other`,
      `/api/previews/${"b".repeat(32)}/media`, "javascript:alert(1)"].map((url) => ({ ...grant(), media: { ...grant().media, url } }))
  ]) assert.equal(previewMedia(result), null);
});

test("media stays idle until explicitly opened and requests only the selected local artifact", async () => {
  const calls = [], playback = createMediaPlayback({ request: async (url, options) => { calls.push({ url, ...options }); return grant(); } });
  await Promise.resolve();
  assert.equal(calls.length, 0);
  assert.deepEqual(visibleState(playback.state), { src: "", status: "idle", error: "" });
  assert.equal(await playback.open({ kind: "video", target: "视频/测试 片段.mp4", cwd: "/work/项目" }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/previews");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), { target: "视频/测试 片段.mp4", cwd: "/work/项目" });
  assert.equal(playback.state.src, grant().media.url);
  assert.equal(playback.state.status, "ready");
  playback.reset();
  assert.deepEqual(visibleState(playback.state), { src: "", status: "idle", error: "" });
});

test("an older grant or failure cannot replace a newer selected source", async () => {
  for (const settle of ["resolve", "reject"]) {
    const first = deferred(), second = deferred(), signals = []; let requests = 0;
    const playback = createMediaPlayback({ request: (_url, options) => { signals.push(options.signal); return ++requests === 1 ? first.promise : second.promise; } });
    const openingFirst = playback.open({ kind: "video", target: "/tmp/first.mp4" });
    const openingSecond = playback.open({ kind: "audio", target: "/tmp/second.mp3" });
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    const secondGrant = grant("audio", "Bc_8-Ya1".repeat(4));
    assert.equal(secondGrant.id.length, 32);
    second.resolve(secondGrant); assert.equal(await openingSecond, true);
    first[settle](settle === "resolve" ? grant() : new Error("old request failed"));
    assert.equal(await openingFirst, false);
    assert.equal(playback.state.src, secondGrant.media.url);
    assert.equal(playback.state.status, "ready");
    assert.equal(playback.state.error, "");
    playback.reset();
  }
});

test("closing during grant creation aborts the request and late responses never reopen playback", async () => {
  const pending = deferred(); let signal;
  const playback = createMediaPlayback({ request: (_url, options) => { signal = options.signal; return pending.promise; } });
  const opening = playback.open({ kind: "video", target: "/tmp/clip.mp4" });
  playback.reset();
  assert.equal(signal.aborted, true);
  pending.resolve(grant());
  assert.equal(await opening, false);
  assert.deepEqual(visibleState(playback.state), { src: "", status: "idle", error: "" });
});

test("grant timeout is bounded, aborts its own request and permits a fresh retry", async () => {
  const timers = clock(), first = deferred(), signals = []; let requests = 0;
  const playback = createMediaPlayback({ ...timers, request: (_url, options) => { signals.push(options.signal); return ++requests === 1 ? first.promise : Promise.resolve(grant()); } });
  const opening = playback.open({ kind: "video", target: "/tmp/clip.mp4" });
  [...timers.timers.values()][0]();
  assert.equal(await opening, false);
  assert.equal(signals[0].aborted, true);
  assert.equal(playback.state.src, "");
  assert.match(playback.state.error, /超时/);
  assert.equal(await playback.open({ kind: "video", target: "/tmp/clip.mp4" }), true);
  first.resolve(grant("audio")); await Promise.resolve();
  assert.equal(playback.state.src, grant().media.url);
  assert.equal(playback.state.error, "");
  assert.equal(timers.timers.size, 0);
  playback.reset();
});

test("an escaped old timeout cannot abort the current media request", async () => {
  const timers = clock(), tasks = [], signals = [];
  const playback = createMediaPlayback({ ...timers, request: (_url, options) => { const task = deferred(); tasks.push(task); signals.push(options.signal); return task.promise; } });
  const first = playback.open({ kind: "video", target: "/tmp/first.mp4" });
  const oldTimeout = [...timers.timers.values()][0];
  const second = playback.open({ kind: "video", target: "/tmp/second.mp4" });
  oldTimeout(); assert.equal(await first, false);
  assert.equal(signals[1].aborted, false);
  assert.equal(playback.state.status, "loading");
  tasks[1].resolve(grant()); assert.equal(await second, true);
  playback.reset();
});

test("failed or mismatched local grants are visible errors and retry does not retain a stale URL", async () => {
  let attempts = 0;
  const playback = createMediaPlayback({ request: async () => {
    if (++attempts === 1) throw new Error("文件已移动");
    if (attempts === 2) return grant("audio");
    return grant();
  } });
  const source = { kind: "video", target: "/tmp/clip.mp4" };
  assert.equal(await playback.open(source), false);
  assert.equal(playback.state.error, "文件已移动");
  assert.equal(await playback.open(source), false);
  assert.equal(playback.state.src, "");
  assert.match(playback.state.error, /无法作为音视频/);
  assert.equal(await playback.open(source), true);
  assert.equal(playback.state.error, "");
  playback.failed(4);
  assert.match(playback.state.error, /编码/);
  playback.failed(2);
  assert.match(playback.state.error, /中断|过期/);
  assert.equal(await playback.open(source), true);
  assert.equal(playback.state.error, "");
  playback.reset();
});

test("remote URLs and existing media routes play without proxy requests, while unsafe URLs are rejected", async () => {
  let requests = 0;
  const playback = createMediaPlayback({ request: async () => { requests += 1; throw new Error("unexpected proxy request"); } });
  for (const url of ["https://media.example/clip.mp4?signature=abc#t=2", grant().media.url]) {
    assert.equal(await playback.open({ kind: "video", url }), true);
    assert.equal(playback.state.src, url);
  }
  for (const url of ["javascript:alert(1)", "data:video/mp4;base64,AAAA", "file:///tmp/clip.mp4", "//media.example/clip.mp4", "https://user:secret@media.example/clip.mp4"]) {
    assert.equal(await playback.open({ kind: "video", url }), false, url);
    assert.equal(playback.state.src, "");
    assert.equal(playback.state.status, "error");
  }
  assert.equal(requests, 0);
  playback.reset();
});
