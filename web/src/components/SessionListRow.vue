<script setup>
import { isSessionRunning } from "../lib/session-list.js";

defineProps({
  session: { type: Object, required: true },
  active: Boolean,
  pending: Boolean,
  showProject: Boolean,
  formatRelativeTime: { type: Function, required: true }
});
const emit = defineEmits(["open"]);
</script>

<template>
  <button class="session-row" type="button" :class="{ active, pending }" :data-session-id="session.id"
    :aria-current="active ? 'true' : undefined" @click="emit('open', session)">
    <div class="session-row-copy">
      <p class="session-row-title" :title="session.displayTitle || '暂无对话'">{{ session.displayTitle || '暂无对话' }}</p>
      <p v-if="showProject && session.projectName" class="session-row-project">{{ session.projectName }}</p>
    </div>
    <div class="session-row-meta">
      <span v-if="isSessionRunning(session)" class="session-row-running"><span class="session-running-icon" aria-hidden="true"></span>运行中</span>
      <time class="session-row-time">{{ formatRelativeTime(session.lastActivityAt || session.updatedAt) }}</time>
    </div>
  </button>
</template>

<style scoped>
.session-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 10px 12px; border: 1px solid transparent; border-radius: 14px; background: transparent; color: inherit; text-align: left; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; transition: background-color .16s ease, border-color .16s ease; }
.session-row:hover { background: rgba(255,250,246,.94); }
.session-row:focus-visible { outline: 2px solid #b6a08b; outline-offset: 2px; }
.session-row.active { border-color: rgba(188,170,152,.42); background: linear-gradient(180deg,rgba(250,244,237,.98),rgba(255,252,248,.92)); box-shadow: inset 0 1px 0 rgba(255,255,255,.88),0 8px 20px rgba(146,126,108,.08); }
.session-row.pending { border-color: rgba(196,178,160,.4); background: rgba(251,247,242,.95); }
.session-row-copy { flex: 1; min-width: 0; }
.session-row-title { margin: 0; overflow: hidden; color: rgba(58,50,42,.94); font-size: 14px; font-weight: 600; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.session-row.active .session-row-title { color: rgb(97,81,66); }
.session-row-project { margin: 4px 0 0; overflow: hidden; color: #988777; font-size: 11px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.session-row-meta { display: flex; flex: 0 0 auto; align-items: flex-end; flex-direction: column; gap: 5px; }
.session-row-time { color: #8e7e71; font-size: 11px; line-height: 1.2; white-space: nowrap; }
.session-row-running { display: inline-flex; align-items: center; gap: 5px; color: #74604c; font-size: 11px; white-space: nowrap; }
.session-running-icon { display: inline-block; width: 11px; height: 11px; border: 1.5px solid #d6c9bb; border-top-color: #886e55; border-radius: 2px; animation: session-running 1.4s steps(4, end) infinite; }
@keyframes session-running { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .session-running-icon { animation: none; } }
</style>
