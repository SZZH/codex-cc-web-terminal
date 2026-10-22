<script setup>
import { computed, ref, useId, watch } from "vue";
import ComposerPopover from "./composer/ComposerPopover.vue";
import PixelCompanion from "./PixelCompanion.js";

const props = defineProps({ title: String, cwd: String });
defineEmits(["back"]);
const open = ref(false), trigger = ref(null);
const dialogId = `chat-info-${useId()}`;
const project = computed(() => props.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || "Codex Web");
watch(() => props.title, (title) => { if (typeof document !== "undefined") document.title = `${title || '会话'} · Codex Web`; }, { immediate: true });
</script>

<template>
  <header class="chat-header">
    <button class="chat-back" type="button" aria-label="返回会话列表" @click="$emit('back')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button>
    <div class="chat-heading">
      <h1><button ref="trigger" type="button" :title="title" aria-haspopup="dialog" :aria-expanded="open" :aria-controls="dialogId" @click="open = true">{{ title }}<span aria-hidden="true">⌄</span></button></h1>
      <p :title="cwd">{{ project }}</p>
    </div>
    <PixelCompanion :size="28" />
    <ComposerPopover v-if="open" :id="dialogId" :open="open" title="会话信息" :fallback-focus="() => trigger?.focus()" @close="open = false">
      <div class="chat-info"><p class="chat-info-label">会话标题</p><p class="chat-info-title">{{ title }}</p><p class="chat-info-label">所属项目</p><p>{{ project }}</p><p v-if="cwd" class="chat-info-path">{{ cwd }}</p></div>
    </ComposerPopover>
  </header>
</template>

<style scoped>
.chat-header { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; min-height: 68px; padding: calc(8px + env(safe-area-inset-top)) 16px 8px 8px; background: #f8f5f1; border-bottom: 1px solid #e7e1db; }
.chat-back { display: grid; place-items: center; width: 44px; height: 44px; flex: 0 0 auto; color: #65564a; border-radius: 12px; }
.chat-back:hover { background: #eee6de; }
.chat-back svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.chat-heading { flex: 1; min-width: 0; }
.chat-heading h1 { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
.chat-heading h1 button { display: block; position: relative; max-width: 100%; padding: 3px 20px 3px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; color: #3c342d; }
.chat-heading h1 span { position: absolute; right: 2px; color: #9b8b7d; font-size: 13px; }
.chat-heading > p { margin: 1px 0 0; color: #8b7f73; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button:focus-visible { outline: 2px solid #8b7f73; outline-offset: 2px; border-radius: 5px; }
.chat-info { padding: 0 20px 20px; color: #514338; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.chat-info-label { color: #8b7f73; font-size: 12px; margin-bottom: 4px; }
.chat-info-title { margin-top: 0; font-weight: 600; }
.chat-info-path { color: #8b7f73; font-size: 12px; }
</style>
