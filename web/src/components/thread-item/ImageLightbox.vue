<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({
  image: { type: Object, required: true },
  origin: { type: Object, default: null }
});
const emit = defineEmits(["close"]);
const dialog = ref(null);
const closeButton = ref(null);
const scale = ref(1);
const translateX = ref(0);
const translateY = ref(0);
const imageStyle = computed(() => ({
  transform: `translate3d(${translateX.value}px, ${translateY.value}px, 0) scale(${scale.value})`
}));
let revision = 0;
let disposed = false;
let closing = false;
let origin = null;
let nativeOrigin = null;
let gesture = null;

function resetGesture() {
  scale.value = 1;
  translateX.value = 0;
  translateY.value = 0;
  gesture = null;
}

function restoreFocus(element) {
  const document = globalThis.document;
  const active = document?.activeElement;
  if (active && active !== document.body && active !== origin && active !== nativeOrigin && active !== element && !element?.contains(active)) return;
  if (!origin?.isConnected || origin.disabled || origin.matches?.(":disabled")) return;
  origin.focus?.({ preventScroll: true });
}

function closeImage(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  if (disposed || closing) return;
  closing = true;
  revision += 1;
  const element = dialog.value;
  const active = globalThis.document?.activeElement;
  const ownsFocus = !active || active === globalThis.document?.body || active === origin || element?.contains(active)
    || (!element?.open && active === nativeOrigin);
  if (element?.open) element.close();
  if (ownsFocus) restoreFocus(element);
  gesture = null;
  emit("close");
}

watch(() => props.image, async () => {
  const version = ++revision;
  closing = false;
  resetGesture();
  origin = props.origin || globalThis.document?.activeElement || null;
  await nextTick();
  const element = dialog.value;
  if (disposed || version !== revision || !element?.isConnected) return;
  if (typeof element.showModal !== "function" || typeof element.close !== "function") {
    closing = true;
    emit("close");
    throw new Error("当前浏览器不支持原生对话框，请更新浏览器后重试。");
  }
  if (!element.open) {
    nativeOrigin = globalThis.document?.activeElement || null;
    element.showModal();
  }
  await nextTick();
  if (disposed || version !== revision || !element.open || !element.isConnected || !closeButton.value?.isConnected) return;
  const active = globalThis.document?.activeElement;
  if (active && active !== globalThis.document?.body && !element.contains(active)) return;
  closeButton.value.focus({ preventScroll: true });
}, { immediate: true, flush: "sync" });

function handleKeydown(event) {
  if (event.key !== "Tab" && event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") closeImage();
  else closeButton.value?.focus({ preventScroll: true });
}

function handleCancel(event) {
  event.preventDefault();
  event.stopPropagation();
  if (event.target === dialog.value && dialog.value?.open) closeImage();
}

function handleNativeClose(event) {
  if (event.target === dialog.value && !dialog.value?.open) closeImage();
}

function beginGesture(event) {
  const touches = event.touches;
  gesture = null;
  if (touches.length >= 2) {
    const [a, b] = touches;
    gesture = { mode: "pinch", scale: scale.value, distance: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, translateX: translateX.value, translateY: translateY.value };
  } else if (touches.length === 1 && scale.value > 1) {
    gesture = { mode: "pan", x: touches[0].clientX, y: touches[0].clientY, translateX: translateX.value, translateY: translateY.value };
  }
  if (gesture) event.preventDefault();
}

function moveGesture(event) {
  if (!gesture) return;
  const touches = event.touches;
  if ((touches.length >= 2 && gesture.mode !== "pinch") || (touches.length === 1 && gesture.mode !== "pan")) {
    beginGesture(event);
    return;
  }
  if (touches.length >= 2) {
    const [a, b] = touches;
    const distance = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    scale.value = Math.min(4, Math.max(1, gesture.scale * (gesture.distance > 0 ? distance / gesture.distance : 1)));
    translateX.value = gesture.translateX + (a.clientX + b.clientX) / 2 - gesture.x;
    translateY.value = gesture.translateY + (a.clientY + b.clientY) / 2 - gesture.y;
  } else if (touches.length === 1 && scale.value > 1) {
    translateX.value = gesture.translateX + touches[0].clientX - gesture.x;
    translateY.value = gesture.translateY + touches[0].clientY - gesture.y;
  }
  event.preventDefault();
}

function endGesture(event) {
  if (scale.value <= 1) resetGesture();
  beginGesture(event);
}

function cancelGesture() {
  if (scale.value <= 1) resetGesture();
  gesture = null;
}

onBeforeUnmount(() => {
  disposed = true;
  revision += 1;
  gesture = null;
  if (dialog.value?.open) dialog.value.close();
});
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="image-lightbox" role="dialog" aria-label="图片预览" aria-modal="true"
      @keydown="handleKeydown" @cancel="handleCancel" @close="handleNativeClose"
      @click="($event.target === $event.currentTarget) && closeImage($event)"
      @touchstart="beginGesture" @touchmove="moveGesture" @touchend="endGesture" @touchcancel="cancelGesture">
      <button ref="closeButton" class="image-lightbox-close" type="button" aria-label="关闭预览" @click.stop="closeImage"
        @touchstart.stop @touchmove.stop @touchend.stop @touchcancel.stop>&times;</button>
      <img class="image-lightbox-media" :src="image.url" :alt="image.alt" :style="imageStyle" loading="eager" decoding="async" @click.stop>
    </dialog>
  </Teleport>
</template>

<style scoped>
.image-lightbox {
  position: fixed;
  top: var(--app-viewport-top, 0px);
  right: 0;
  bottom: auto;
  left: 0;
  width: 100%;
  max-width: none;
  height: var(--app-viewport-height, 100dvh);
  max-height: none;
  margin: 0;
  border: 0;
  padding: 20px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: rgba(24, 19, 15, 0.76);
  backdrop-filter: blur(8px);
  touch-action: none;
  overscroll-behavior: contain;
}
.image-lightbox[open] { display: flex; }
.image-lightbox::backdrop { background: transparent; }
.image-lightbox-media {
  max-width: min(100vw - 32px, 960px);
  max-height: min(calc(var(--app-viewport-height, 100dvh) - 48px), calc(var(--app-viewport-height, 100dvh) * .88));
  border-radius: 16px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  background: rgba(255, 255, 255, 0.96);
  transform-origin: center center;
  user-select: none;
  -webkit-user-drag: none;
  touch-action: none;
  will-change: transform;
}
.image-lightbox-close {
  position: absolute;
  z-index: 1;
  top: calc(env(safe-area-inset-top) + 12px);
  right: 14px;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.9);
  color: #3b3028;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}
</style>
