import { reactive } from "vue";
import { request } from "./api.js";
import { localPreviewTarget, previewOpenHref } from "./markdown-links.js";

const newRequestId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("");

export function createPreviewController({ request: send = request, document: doc = globalThis.document,
  window: view = globalThis.window, timeoutMs = 20000, setTimer = setTimeout, clearTimer = clearTimeout,
  requestId: createRequestId = newRequestId } = {}) {
  const state = reactive({ open: false, target: "", cwd: "", title: "预览", kind: "", url: "", id: "",
    expiresAt: null, status: "idle", error: "", revision: 0 });
  let abort = null;
  let returnContext = null;
  let releasePending = null;
  let positionGeneration = 0;
  let restoreFrame = null;

  function cancelPositionRestore() {
    if (restoreFrame != null) view?.cancelAnimationFrame?.(restoreFrame);
    restoreFrame = null;
  }
  function invalidatePosition() {
    positionGeneration += 1;
    returnContext = null;
    cancelPositionRestore();
  }

  function rememberPosition() {
    return { focus: doc?.activeElement, x: view?.scrollX || 0, y: view?.scrollY || 0,
      scrollers: [...(doc?.querySelectorAll?.("[data-app-scroll]") || [])].map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft })) };
  }
  async function open({ target, cwd = "" } = {}) {
    const revision = ++state.revision;
    cancelPositionRestore();
    abort?.abort(); abort = new AbortController();
    const controller = abort;
    if (!state.open || !returnContext) returnContext = rememberPosition();
    const releasing = releaseService();
    Object.assign(state, { open: true, target: String(target || ""), cwd: String(cwd || ""), title: String(target || "预览").split(/[\\/]/).at(-1) || "预览",
      status: "loading", error: "", url: "", id: "", kind: "", expiresAt: null });
    let timer;
    try {
      if (releasing) {
        await Promise.race([releasing, new Promise((_, reject) => {
          timer = setTimer(() => reject(new Error("上一个网页预览尚未关闭，请稍后重试。")), timeoutMs);
        })]);
        clearTimer(timer);
      }
      if (revision !== state.revision || !state.open) return null;
      const payload = localPreviewTarget(target, cwd);
      if (!payload) throw new Error("请选择本地文件或本地服务地址。");
      if (/^https?:\/\//i.test(payload.target)) {
        payload.requestId = createRequestId();
        Object.assign(state, { id: payload.requestId, kind: "service" });
      }
      const result = await Promise.race([
        send("/api/previews", { method: "POST", body: JSON.stringify(payload), signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimer(() => { controller.abort(); reject(new Error("预览创建超时，请重试。")); }, timeoutMs); })
      ]);
      if (revision !== state.revision || !state.open) return null;
      const url = new URL(result.url);
      if (!["http:", "https:"].includes(url.protocol) || (view?.location?.origin && url.origin === view.location.origin)) {
        throw new Error("预览服务返回的地址不可用。");
      }
      Object.assign(state, { id: result.id, title: result.title || state.title, kind: result.kind,
        url: result.url, expiresAt: result.expiresAt, status: "frame-loading" });
      return result;
    } catch (error) {
      if (revision === state.revision && state.open) {
        releaseService();
        Object.assign(state, { status: "error", error: error?.message || "无法打开预览。" });
      }
      return null;
    } finally { clearTimer(timer); }
  }
  function close() {
    if (!state.open) return;
    const revision = ++state.revision;
    abort?.abort(); abort = null;
    releaseService();
    Object.assign(state, { open: false, status: "idle", url: "", error: "" });
    const context = returnContext; returnContext = null;
    const generation = positionGeneration;
    cancelPositionRestore();
    if (!context) return;
    let frame = null;
    const restore = () => {
      if (restoreFrame === frame) restoreFrame = null;
      if (state.open || generation !== positionGeneration || revision !== state.revision) return;
      for (const { element, top, left } of context.scrollers) if (element.isConnected !== false) { element.scrollTop = top; element.scrollLeft = left; }
      view?.scrollTo?.(context.x, context.y);
      if (context.focus?.isConnected !== false) context.focus?.focus?.({ preventScroll: true });
    };
    if (view?.requestAnimationFrame) restoreFrame = frame = view.requestAnimationFrame(restore); else queueMicrotask(restore);
  }
  function releaseService() {
    if (state.kind === "service" && state.id) {
      const id = state.id; state.id = "";
      const task = (releasePending || Promise.resolve()).then(() => send(`/api/previews/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true })).catch(() => {})
        .finally(() => { if (releasePending === task) releasePending = null; });
      releasePending = task;
    }
    return releasePending;
  }
  function frameLoaded(revision) { if (state.open && state.revision === revision) { state.status = "ready"; state.error = ""; } }
  function frameFailed(revision, message = "预览未能加载，请重试或在新窗口打开。") {
    if (state.open && state.revision === revision) Object.assign(state, { status: "error", error: message });
  }
  return { state, open, close, invalidatePosition, retry: () => open({ target: state.target, cwd: state.cwd }), frameLoaded, frameFailed,
    externalHref: () => previewOpenHref({ target: state.target, cwd: state.cwd }) };
}

export const localPreview = createPreviewController();
export const previewState = localPreview.state;
export const openLocalPreview = (target) => localPreview.open(target);
export const closeLocalPreview = () => localPreview.close();
export const invalidateLocalPreviewPosition = () => localPreview.invalidatePosition();
