<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { localPreview } from "../../lib/preview.js";
import MediaPlayer from "./MediaPlayer.vue";

const props = defineProps({ controller: { type: Object, default: () => localPreview } });
const state = props.controller.state;
const panel = ref(null);
const closeButton = ref(null);
const compact = ref(false);
let media = null;
let frameTimer = null;
const syncSize = () => { compact.value = Boolean(media?.matches); };
const frameRevision = (event) => Number(event.currentTarget?.dataset?.previewRevision);
const nativeDialogOpen = () => Boolean(globalThis.document?.querySelector?.("dialog[open]"));
const ownsFocus = () => state.open && compact.value && !nativeDialogOpen() && globalThis.document?.hasFocus?.() !== false;
function containFocus() {
  if (!ownsFocus() || !panel.value || panel.value.contains(globalThis.document?.activeElement)) return;
  closeButton.value?.focus?.({ preventScroll: true });
}
function keydown(event) {
  if (!state.open || event.defaultPrevented || nativeDialogOpen()) return;
  if (event.key === "Escape") { event.preventDefault(); props.controller.close(); return; }
  if (event.key !== "Tab" || !ownsFocus()) return;
  const targets = [...(panel.value?.querySelectorAll("button:not([disabled]),a[href],iframe,video[controls],audio[controls]") || [])];
  const first = targets[0], last = targets.at(-1);
  const active = globalThis.document?.activeElement;
  // Native controls use shadow focus: let Tab traverse them before focusin
  // returns focus to the panel when it actually leaves the dialog.
  if (active?.matches?.("video[controls],audio[controls]")) return;
  if (!panel.value?.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus?.({ preventScroll: true }); }
  else if (event.shiftKey && active === first) { event.preventDefault(); last?.focus?.({ preventScroll: true }); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus?.({ preventScroll: true }); }
}
watch(() => state.open, async (open) => { if (open) { await nextTick(); closeButton.value?.focus?.({ preventScroll: true }); } }, { immediate: true });
watch(compact, async (isCompact) => { if (isCompact) { await nextTick(); containFocus(); } });
watch(() => [state.revision, state.status], ([revision, status]) => {
  clearTimeout(frameTimer);
  if (status === "frame-loading") frameTimer = setTimeout(() => props.controller.frameFailed(revision, "预览加载较慢，可重试或在新窗口打开。"), 25000);
});
onMounted(() => {
  media = window.matchMedia?.("(max-width: 959px)"); syncSize();
  media?.addEventListener?.("change", syncSize);
  window.addEventListener("keydown", keydown);
  window.addEventListener("focusin", containFocus, true);
});
onBeforeUnmount(() => {
  clearTimeout(frameTimer); media?.removeEventListener?.("change", syncSize);
  window.removeEventListener("keydown", keydown);
  window.removeEventListener("focusin", containFocus, true); props.controller.close();
});
</script>

<template>
  <aside v-if="state.open" ref="panel" class="preview-host" data-preview-host role="dialog" :aria-modal="compact || undefined" aria-labelledby="local-preview-title">
    <header class="preview-header">
      <button ref="closeButton" class="preview-close" type="button" aria-label="关闭预览" title="关闭预览（Esc）" @click="controller.close()">‹</button>
      <div class="preview-heading"><h2 id="local-preview-title">{{ state.title }}</h2><p>{{ state.media ? (state.media.kind === 'video' ? '视频预览' : '音频预览') : state.kind === 'service' ? '网页预览' : '文件预览' }}</p></div>
      <a class="preview-external" :href="controller.externalHref()" target="_blank" rel="noopener noreferrer">新窗口打开 <span aria-hidden="true">↗</span></a>
    </header>
    <div class="preview-content">
      <div v-if="state.media" class="preview-media"><MediaPlayer :key="state.revision" :source="{ ...state.media, target: state.target, cwd: state.cwd, title: state.title }" /></div>
      <iframe v-else-if="state.url" :key="state.revision" class="preview-frame" :src="state.url" :title="state.title" referrerpolicy="no-referrer"
        :data-preview-revision="state.revision"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        @load="controller.frameLoaded(frameRevision($event))" @error="controller.frameFailed(frameRevision($event))" />
      <div v-if="state.status === 'loading' || state.status === 'frame-loading'" class="preview-message" role="status" aria-live="polite"><p>正在打开预览…</p></div>
      <div v-else-if="state.status === 'error'" class="preview-message preview-error" role="alert">
        <p>{{ state.error }}</p><button class="preview-retry" type="button" @click="controller.retry()">重试</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.preview-host { position: fixed; inset: var(--app-viewport-top, 0px) 0 auto; z-index: 90; display: flex; flex-direction: column; min-width: 0; min-height: 0; height: var(--app-viewport-height, 100dvh); overflow: hidden; background: #fdfbf8; color: var(--text, #2f2c28); }
.preview-header { display: flex; flex: 0 0 auto; align-items: center; gap: 12px; min-height: 64px; padding: calc(10px + env(safe-area-inset-top)) 16px 10px; border-bottom: 1px solid var(--line, #e7e1db); }
.preview-close { flex: 0 0 36px; height: 36px; border-radius: 50%; background: #eee6de; color: #66564a; font-size: 26px; line-height: 1; }
.preview-heading { flex: 1; min-width: 0; }
.preview-heading h2 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600; }
.preview-heading p { margin: 4px 0 0; color: #938579; font-size: 11px; }
.preview-external { flex: 0 0 auto; color: #79634f; font-size: 12px; text-decoration: none; }
.preview-content { position: relative; flex: 1; min-height: 0; }
.preview-media { display: flex; align-items: center; height: 100%; min-height: 0; overflow: auto; padding: 16px; box-sizing: border-box; }
.preview-frame { display: block; width: 100%; height: 100%; border: 0; background: white; }
.preview-message { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: safe center; gap: 12px; min-height: 0; min-width: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 28px; background: #fdfbf8; color: #88796b; text-align: center; font-size: 14px; }
.preview-message > * { flex: 0 0 auto; }
.preview-message p { max-width: 460px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.preview-error { color: #965449; }
.preview-retry { padding: 9px 20px; border: 1px solid #d9d0c7; border-radius: 10px; color: #665448; background: #f4eee7; }
@media (min-width: 960px) { .preview-host { position: sticky; top: 0; height: 100%; border-left: 1px solid var(--line, #e7e1db); } }
</style>
