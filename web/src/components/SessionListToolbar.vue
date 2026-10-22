<script setup>
import { computed, ref } from "vue";

const props = defineProps({
  search: { type: String, default: "" },
  mode: { type: String, default: "groups" },
  runningCount: { type: Number, default: 0 },
  resultCount: { type: Number, default: null }
});
const emit = defineEmits(["update:search", "update:mode"]);
const input = ref(null);
const query = computed({ get: () => props.search, set: (value) => emit("update:search", value) });
function clearSearch() {
  query.value = "";
  input.value?.focus?.();
}
function handleKeydown(event) {
  if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || event.target?.composing) return;
  event.preventDefault();
  clearSearch();
}
</script>

<template>
  <div class="session-list-toolbar">
    <div class="session-search" role="search">
      <input ref="input" v-model="query" class="session-search-input" type="search" maxlength="200"
        aria-label="搜索会话" placeholder="搜索会话或项目" autocomplete="off" :spellcheck="false"
        @keydown="handleKeydown" />
      <button v-if="query" type="button" class="session-search-clear" aria-label="清空搜索" title="清空搜索" @click="clearSearch">&times;</button>
    </div>
    <div class="session-list-controls">
      <div class="session-view-switch" role="group" aria-label="会话视图">
        <button type="button" :aria-pressed="mode === 'groups'" @click="emit('update:mode', 'groups')">分组</button>
        <button type="button" :aria-pressed="mode === 'activity'" @click="emit('update:mode', 'activity')">最近活动</button>
      </div>
      <span v-if="query.trim() && resultCount !== null" class="session-search-count" role="status">{{ resultCount }} 个匹配会话</span>
      <span v-else-if="runningCount" class="session-running-count">{{ runningCount }} 个运行中</span>
    </div>
  </div>
</template>

<style scoped>
.session-list-toolbar { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.session-search { position: relative; min-width: 0; }
.session-search-input { display: block; width: 100%; min-width: 0; height: 44px; padding: 10px 48px 10px 12px; border: 1px solid #d9cec3; border-radius: 8px; background: #fffcf8; color: #594a3d; font: inherit; font-size: 16px; }
.session-search-input::placeholder { color: #8b7969; }
.session-search-input::-webkit-search-cancel-button { appearance: none; }
.session-search-input:focus-visible { outline: 2px solid #b6a08b; outline-offset: 1px; }
.session-search-clear { position: absolute; inset: 0 0 0 auto; width: 44px; border: 0; border-radius: 6px; background: transparent; color: #796757; font: inherit; font-size: 22px; cursor: pointer; }
.session-search-clear:hover { background: #efe8e1; }
.session-list-controls { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.session-view-switch { display: inline-flex; flex: 0 0 auto; padding: 3px; gap: 2px; border: 1px solid #e2d7cd; border-radius: 12px; background: #efe8e1; }
.session-view-switch button { padding: 7px 13px; border: 0; border-radius: 9px; background: transparent; color: #8b7969; font: inherit; font-size: 13px; cursor: pointer; }
.session-view-switch button[aria-pressed="true"] { background: #fffcf8; color: #594a3d; box-shadow: 0 1px 4px #6d554715; }
.session-view-switch button:focus-visible, .session-search-clear:focus-visible { outline: 2px solid #b6a08b; outline-offset: 2px; }
.session-running-count, .session-search-count { min-width: 0; color: #846b54; font-size: 11px; overflow-wrap: anywhere; text-align: right; }
</style>
