<script setup>
import { computed, ref, useId, watch } from "vue";
import ComposerPopover from "./ComposerPopover.vue";

const props = defineProps({ runningTask: Boolean, hasInput: Boolean, canInterrupt: Boolean, followUpMode: { type: String, default: "steer" },
  disabled: Boolean, canSteer: Boolean, interrupting: Boolean, fallbackFocus: { type: Function, default: null } });
const emit = defineEmits(["submit", "interrupt"]);
const menuOpen = ref(false);
const dialogId = `composer-send-${useId()}`;
const defaultMode = computed(() => props.runningTask && props.followUpMode !== "queue" ? "steer" : "queue");
const actionLabel = computed(() => !props.runningTask ? "发送消息" : defaultMode.value === "queue" ? "加入队列" : "立即引导");
const showStop = computed(() => props.runningTask);
const stopTitle = computed(() => !props.canInterrupt ? "请在桌面端停止当前任务" : props.interrupting ? "正在停止…" : "停止生成");
watch(() => [props.runningTask, props.hasInput, props.disabled, props.followUpMode], () => { menuOpen.value = false; });
function closeMenu() { menuOpen.value = false; }
function toggleMenu() {
  if (menuOpen.value) { closeMenu(); return; }
  if (props.disabled || !props.runningTask || !props.hasInput) return;
  menuOpen.value = true;
}
function send(mode) {
  if (!props.hasInput || props.disabled || mode === "steer" && !props.canSteer) return;
  menuOpen.value = false;
  emit("submit", { mode: mode || defaultMode.value });
}
function stop() {
  if (showStop.value && props.canInterrupt && !props.interrupting) emit("interrupt");
}
</script>

<template>
  <div class="send-actions">
    <button v-if="showStop" class="stop-button" type="button" aria-label="停止生成" :title="stopTitle" :aria-description="stopTitle"
      :disabled="!canInterrupt || interrupting" :aria-busy="interrupting" @click="stop"><span aria-hidden="true"></span></button>
    <div v-if="!runningTask || hasInput" class="send-button-group">
      <button v-if="runningTask && hasInput" class="send-menu-toggle" type="button" aria-label="选择发送方式" title="选择发送方式"
        aria-haspopup="dialog" :aria-expanded="menuOpen" :aria-controls="dialogId" :disabled="disabled" @click="toggleMenu">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      <button class="send-button" type="button" :aria-label="actionLabel"
        :title="`${actionLabel}（Enter）`" :disabled="disabled || !hasInput" @click="send()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
      </button>
    </div>
    <ComposerPopover :id="dialogId" :open="menuOpen" title="发送方式" :fallback-focus="fallbackFocus" @close="closeMenu">
      <div class="send-menu">
        <button autofocus type="button" :disabled="disabled" @click="send('queue')">
          <span>加入队列<small>当前回复完成后发送</small></span><kbd v-if="defaultMode === 'queue'">Enter</kbd>
        </button>
        <button type="button" :disabled="disabled || !canSteer" @click="send('steer')">
          <span>立即引导<small>立即补充给当前回复</small></span><kbd>Ctrl/⌘ ↵</kbd>
        </button>
      </div>
    </ComposerPopover>
  </div>
</template>

<style scoped>
.send-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
button { cursor: pointer; font: inherit; touch-action: manipulation; }
button:disabled { opacity: .45; cursor: default; }
.stop-button, .send-button { display: grid; place-items: center; width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%; background: #3c342d; color: #fffdfb; }
.stop-button { background: #eee6de; color: #65564a; border: 1px solid #d9d0c7; }
.stop-button span { width: 11px; height: 11px; background: currentColor; border-radius: 2px; }
.send-button svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.send-button-group { display: flex; align-items: center; gap: 2px; }
.send-menu-toggle { display: grid; place-items: center; width: 28px; height: 40px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: #807164; }
.send-menu-toggle svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
button:focus-visible { outline: 2px solid #806249; outline-offset: -3px; }
.send-menu { padding: 0 8px 10px; }
.send-menu button { display: flex; justify-content: space-between; align-items: center; gap: 16px; width: 100%; padding: 12px; border: 0; border-radius: 12px; background: transparent; color: #51463e; text-align: left; }
.send-menu button:hover { background: #f2ebe4; }
.send-menu small { display: block; margin-top: 4px; color: #9b8b7d; font-size: 12px; }
.send-menu kbd { color: #9b8b7d; font-family: inherit; font-size: 11px; white-space: nowrap; }
@media (pointer: coarse) { .stop-button, .send-button, .send-menu-toggle { min-width: 44px; min-height: 44px; } }
</style>
