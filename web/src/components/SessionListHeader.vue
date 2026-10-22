<script setup>
import { computed, onBeforeUnmount, ref, useId } from "vue";
import PixelCompanion from "./PixelCompanion.js";
import InterfaceState from "./InterfaceState.js";
import ComposerPopover from "./composer/ComposerPopover.vue";
import { request } from "../lib/api.js";
import { buildProjectChoices } from "../lib/project-picker.js";

const props = defineProps({ pending: Boolean });
const emit = defineEmits(["create"]);
const open = ref(false), loading = ref(false), error = ref(""), groups = ref([]), query = ref("");
const trigger = ref(null);
const dialogId = `project-picker-${useId()}`;
let controller;
const choices = computed(() => buildProjectChoices(groups.value).filter(({ group }) =>
  `${group.name} ${group.cwd}`.toLowerCase().includes(query.value.trim().toLowerCase())));
function close() { open.value = false; controller?.abort(); loading.value = false; }
async function loadProjects() {
  controller?.abort();
  const owner = new AbortController(); controller = owner;
  loading.value = true; error.value = "";
  try {
    const data = await request("/api/session-catalog?view=groups&limit=1", { signal: owner.signal });
    if (owner.signal.aborted) return;
    if (!Array.isArray(data.projectGroups)) throw new Error("项目列表暂时无法读取。");
    groups.value = data.projectGroups.filter((group) => group.cwd && (!group.groupKind || group.groupKind === "project"));
    if (data.sidebarStatus?.degraded) error.value = "部分项目暂时无法更新，可重试读取。";
  } catch (failure) { if (!owner.signal.aborted) error.value = failure.message || "项目列表暂时无法读取。"; }
  finally { if (controller === owner) loading.value = false; }
}
function show() { query.value = ""; groups.value = []; open.value = true; void loadProjects(); }
function choose(group) { if (!props.pending) { close(); emit("create", group); } }
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <header class="session-brand-header">
    <div class="session-brand">
      <PixelCompanion :size="44" />
      <div><p class="session-brand-name">Codex Web</p><h1>会话</h1></div>
    </div>
    <button ref="trigger" class="session-create" type="button" :disabled="pending" aria-haspopup="dialog"
      :aria-expanded="open" :aria-controls="dialogId" @click="show"><span aria-hidden="true">＋</span>{{ pending ? '创建中…' : '新建会话' }}</button>
    <ComposerPopover v-if="open" :id="dialogId" :open="open" title="选择项目" :fallback-focus="() => trigger?.focus()" @close="close">
      <div class="project-picker">
        <p class="project-picker-note">新会话将在所选项目中开始。</p>
        <input v-model="query" class="project-picker-search" type="search" placeholder="搜索项目" aria-label="搜索项目" autocomplete="off">
        <InterfaceState v-if="loading" title="正在读取项目…" layout="inline" />
        <InterfaceState v-if="error" kind="error" :title="error" layout="inline" action-label="重新读取" @action="loadProjects" />
        <div v-if="choices.length" class="project-picker-list">
          <button v-for="{ group, detail } in choices" :key="group.id || group.cwd" type="button" :disabled="pending" @click="choose(group)">
            <span>{{ group.name }}</span><small>{{ group.cwd }}</small><span class="project-picker-arrow" aria-hidden="true">↗</span>
            <small v-if="detail">{{ detail }}</small>
          </button>
        </div>
        <InterfaceState v-else-if="!loading && !error" kind="empty" mood="search" :title="query ? '没有找到匹配项目' : '还没有可用项目'"
          :detail="query ? '试试其他名称。' : '先在桌面端打开一个项目，再回来新建会话。'" />
      </div>
    </ComposerPopover>
  </header>
</template>

<style scoped>
.session-brand-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: calc(8px + env(safe-area-inset-top)) 2px 12px; }
.session-brand { display: flex; align-items: center; gap: 10px; }
.session-brand-name { margin: 0 0 3px; color: #8b7f73; font-size: 11px; font-weight: 500; letter-spacing: .04em; }
h1 { margin: 0; font-size: 22px; line-height: 1.2; letter-spacing: -.04em; font-weight: 650; color: #3c342d; }
.session-create { display: flex; align-items: center; gap: 6px; min-height: 42px; padding: 8px 13px; border: 1px solid #d9d0c7; border-radius: 12px; background: #fffcf8; color: #514338; font-size: 13px; font-weight: 500; }
.session-create > span { font-size: 20px; font-weight: 400; }
.session-create:hover { background: #eee6de; }
.session-create:disabled { opacity: .55; cursor: wait; }
.session-create:focus-visible, .project-picker button:focus-visible, .project-picker-search:focus-visible { outline: 2px solid #8b7f73; outline-offset: 2px; }
.project-picker { padding: 0 16px 16px; }
.project-picker-note { margin: 4px 0 14px; color: #8b7f73; font-size: 13px; }
.project-picker-search { width: 100%; min-height: 44px; padding: 8px 12px; border: 1px solid #d9d0c7; border-radius: 10px; background: #fffcf8; font-size: 16px; color: #514338; }
.project-picker-list { display: grid; gap: 4px; margin-top: 12px; }
.project-picker-list button { position: relative; display: grid; gap: 4px; min-height: 60px; width: 100%; padding: 10px 30px 10px 10px; border-radius: 10px; text-align: left; color: #514338; }
.project-picker-list button:hover { background: #f0e8e0; }
.project-picker-list small { color: #8b7f73; font-size: 11px; overflow-wrap: anywhere; }
.project-picker-arrow { position: absolute; right: 10px; top: 16px; color: #8b7f73; }
</style>
