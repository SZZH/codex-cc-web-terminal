<script setup>
const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: "" }
});

const emit = defineEmits(["close"]);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="popover-backdrop" @click="emit('close')"></div>
    <section v-if="open" class="popover-drawer" @click.stop>
      <div class="popover-grabber" aria-hidden="true"></div>
      <header v-if="title" class="popover-title">{{ title }}</header>
      <slot />
    </section>
  </Teleport>
</template>

<style scoped>
.popover-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  background: rgba(62, 49, 37, 0.12);
  backdrop-filter: blur(2px);
}

.popover-drawer {
  position: fixed;
  left: 0;
  right: 0;
  max-height: min(70vh, calc(100vh - 92px - env(safe-area-inset-bottom)));
  bottom: calc(env(safe-area-inset-bottom));
  width: min(420px, calc(100vw - 20px));
  margin: 0 auto;
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

.popover-title {
  padding: 0 18px 10px;
  font-size: 13px;
  line-height: 1.35;
  color: #7f7165;
}

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
