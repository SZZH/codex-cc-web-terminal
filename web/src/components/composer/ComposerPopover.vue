<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

const props = defineProps({
  id: { type: String, default: "" },
  open: { type: Boolean, default: false },
  title: { type: String, default: "" },
  fallbackFocus: { type: Function, default: null }
});

const emit = defineEmits(["close"]);
const dialog = ref(null);
const nativeSupported = ref(true);
const titleId = `composer-popover-title-${useId()}`;
const dialogId = computed(() => props.id || `${titleId}-dialog`);
let revision = 0;
let disposed = false;
let origin = null;
let pointerStartedOutside = false;

function restoreFallback(closedDialog = dialog.value, returnOrigin = origin) {
  const document = globalThis.document;
  if (document?.querySelector?.("dialog[open]")) return;
  const active = document?.activeElement;
  const unavailable = returnOrigin?.isConnected === false || returnOrigin?.disabled || returnOrigin?.matches?.(":disabled");
  if (unavailable && (!active || active === document?.body || active === closedDialog || active === returnOrigin || active.isConnected === false)) {
    props.fallbackFocus?.();
  }
}

function closeDialog({ restore = true } = {}) {
  pointerStartedOutside = false;
  const element = dialog.value;
  if (!element) return;
  if (element.open) element.close();
  if (!restore) return;
  const version = revision;
  const returnOrigin = origin;
  restoreFallback(element, returnOrigin);
  // The origin can disappear later in the same parent DOM update.
  void nextTick().then(() => {
    if (disposed || version !== revision || props.open) return;
    restoreFallback(element, returnOrigin);
  });
}

// Close before v-if removes the dialog and its native focus context.
watch(() => props.open, async (open) => {
  const version = ++revision;
  if (!open) { closeDialog(); return; }
  nativeSupported.value = true;
  await nextTick();
  if (disposed || version !== revision || !props.open) return;
  const element = dialog.value;
  if (typeof element?.showModal !== "function" || typeof element?.close !== "function") {
    nativeSupported.value = false;
    emit("close");
    throw new Error("当前浏览器不支持原生对话框，请更新浏览器后重试。");
  }
  origin = globalThis.document?.activeElement || null;
  element.showModal();
}, { immediate: true, flush: "sync" });

function requestClose(event) {
  event?.preventDefault?.();
  if (props.open && !disposed) emit("close");
}

function handleCancel(event) {
  event.preventDefault();
  if (event.target === dialog.value && dialog.value?.open) requestClose();
}

function handleNativeClose(event) {
  if (event.target !== dialog.value || dialog.value?.open || disposed) return;
  restoreFallback();
  if (props.open) emit("close");
}

function outsidePanel(event) {
  if (event.target !== dialog.value) return false;
  const rect = dialog.value.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
}

function handleBackdropClick(event) {
  const close = pointerStartedOutside && outsidePanel(event);
  pointerStartedOutside = false;
  if (close) requestClose();
}

onBeforeUnmount(() => {
  disposed = true;
  revision += 1;
  closeDialog({ restore: false });
});
</script>

<template>
  <Teleport to="body">
    <dialog v-if="open && nativeSupported" :id="dialogId" ref="dialog" class="popover-drawer" role="dialog" aria-modal="true" :aria-labelledby="titleId"
      @cancel="handleCancel" @close="handleNativeClose" @pointerdown="pointerStartedOutside = outsidePanel($event)"
      @pointercancel="pointerStartedOutside = false" @click="handleBackdropClick">
      <div class="popover-grabber" aria-hidden="true"></div>
      <header class="popover-heading">
        <h2 :id="titleId" class="popover-title">{{ title || '操作选项' }}</h2>
        <button class="popover-close" type="button" :aria-label="`关闭${title || '弹层'}`" :title="`关闭${title || '弹层'}`" @click="requestClose">&times;</button>
      </header>
      <slot />
    </dialog>
  </Teleport>
</template>

<style scoped>
.popover-drawer::backdrop {
  background: rgba(62, 49, 37, 0.12);
  backdrop-filter: blur(2px);
}

.popover-drawer {
  position: fixed;
  left: 0;
  right: 0;
  top: auto;
  max-height: min(calc(var(--app-viewport-height, 100dvh) * .7), max(0px, calc(var(--app-viewport-height, 100dvh) - 20px - env(safe-area-inset-bottom))));
  bottom: calc(var(--app-viewport-bottom, 0px) + env(safe-area-inset-bottom));
  width: min(420px, calc(100vw - 20px));
  max-width: calc(100vw - 20px);
  margin: 0 auto;
  padding: 0;
  color: inherit;
  border: 1px solid rgba(220, 209, 199, 0.9);
  border-radius: 22px;
  background: rgba(255, 252, 248, 0.98);
  box-shadow:
    0 22px 54px rgba(99, 78, 60, 0.2),
    0 1px 0 rgba(255, 255, 255, 0.92) inset;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
  z-index: 21;
  animation: drawer-in 180ms ease-out;
}

.popover-grabber {
  width: 42px;
  height: 5px;
  margin: 10px auto 6px;
  border-radius: 999px;
  background: rgba(184, 169, 156, 0.82);
}

.popover-heading { display: flex; align-items: center; gap: 8px; padding: 0 8px 0 18px; }
.popover-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.35;
  color: #7f7165;
}
.popover-close { flex: 0 0 44px; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: #7f7165; font: inherit; font-size: 24px; cursor: pointer; }
.popover-close:focus-visible { outline: 2px solid #806249; outline-offset: -3px; }

@keyframes drawer-in {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
