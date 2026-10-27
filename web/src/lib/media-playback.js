import { reactive } from "vue";
import { request } from "./api.js";

// Only the authenticated media route may be supplied by a local preview grant.
export function previewMedia(result) {
  const media = result?.media;
  if (!media || result.kind !== "file" || !["video", "audio"].includes(media.kind) ||
    !/^[A-Za-z0-9_-]{32}$/.test(result.id || "") || media.url !== `/api/previews/${result.id}/media`) return null;
  return { kind: media.kind, url: media.url, contentType: media.contentType };
}

export function createMediaPlayback({ request: send = request, timeoutMs = 20000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const state = reactive({ src: "", status: "idle", error: "", revision: 0 });
  let revision = 0, pending = null;
  function reset() {
    revision += 1;
    pending?.abort(); pending = null;
    Object.assign(state, { src: "", status: "idle", error: "", revision });
  }
  async function open(source) {
    reset();
    const generation = revision, controller = pending = new AbortController();
    let timer;
    state.status = "loading";
    try {
      let url = source.url;
      if (source.target) {
        const result = await Promise.race([
          send("/api/previews", { method: "POST", body: JSON.stringify({ target: source.target, cwd: source.cwd || "" }), signal: controller.signal }),
          new Promise((_, reject) => { timer = setTimer(() => { controller.abort(); reject(new Error("媒体加载超时，请重试。")); }, timeoutMs); })
        ]);
        const media = previewMedia(result);
        if (!media || media.kind !== source.kind) throw new Error("该文件无法作为音视频打开。");
        url = media.url;
      } else if (!/^\/api\/previews\/[A-Za-z0-9_-]{32}\/media$/.test(url || "")) {
        const remote = new URL(url);
        if (!["https:", "http:"].includes(remote.protocol) || remote.username || remote.password) throw new Error("媒体地址不可用。");
        url = remote.href;
      }
      if (generation !== revision) return false;
      Object.assign(state, { src: url, status: "ready", error: "" });
      return true;
    } catch (error) {
      if (generation === revision) Object.assign(state, { status: "error", error: error?.message || "无法加载媒体，请重试。" });
      return false;
    } finally { clearTimer(timer); }
  }
  function failed(code) {
    state.status = "error";
    state.error = [3, 4].includes(code) ? "当前浏览器无法播放此编码，可在新窗口打开或下载后播放。" : "播放中断或链接已过期，请重试。";
  }
  return { state, open, reset, failed };
}
