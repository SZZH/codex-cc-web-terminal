<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, toRefs, watch } from "vue";
import { createSessionListViewState } from "../lib/app-state.js";
import { createSessionListPosition } from "../lib/session-list-position.js";
import { buildActivitySessions, createSessionSearch, isSessionRunning, sessionGroupKey } from "../lib/session-list.js";
import { deriveSessionListProgress, sessionListGroupCounts } from "../lib/session-list-progress.js";
import SessionListRow from "./SessionListRow.vue";
import SessionListToolbar from "./SessionListToolbar.vue";
import { observeElementVisibility } from "../lib/element-visibility.js";
import { normalizeCatalogQuery } from "../lib/paged-session-catalog.js";

const props = defineProps({
  groups: { type: Array, default: () => [] },
  activeSessionId: { type: String, default: "" },
  pendingSessionId: { type: String, default: "" },
  formatRelativeTime: { type: Function, required: true },
  searchQuery: { type: String, default: "" },
  viewState: { type: Object, default: createSessionListViewState },
  getPositionGeneration: { type: Function, default: () => null },
  loading: { type: Boolean, default: false },
  loaded: { type: Boolean, default: true },
  complete: { type: Boolean, default: true },
  counts: { type: Object, default: null },
  loadError: { type: String, default: "" },
  pagination: { type: Object, default: null }
});

const emit = defineEmits(["open", "create-group-session", "update:searchQuery", "retry", "catalog-view", "load-group", "load-more"]);
// A mounted instance keeps its own auth generation's object after navigation or expiry.
const ownedViewState = props.viewState;
const viewState = reactive(ownedViewState);
const { expandedGroups, localExpansion, expandedLists, activityLimit,
  searchCollapsed, searchLimits, searchActivityLimit, searchGroupLimit } = toRefs(viewState);
const viewMode = ref("groups");
const query = ref(props.searchQuery);
const searching = computed(() => Boolean(query.value.trim()));
const queryPending = computed(() => props.pagination && normalizeCatalogQuery(query.value) !== props.pagination.query);
const progress = computed(() => props.pagination ? { complete: props.loaded && !queryPending.value,
  searchPending: queryPending.value, runningTotal: props.pagination.page?.runningTotal, groupCounts: new Map() }
  : deriveSessionListProgress(props, query.value));
const search = computed(() => createSessionSearch(props.groups));
const visibleGroups = computed(() => progress.value.searchPending ? [] : props.pagination ? props.groups : search.value(query.value));
const renderedGroups = computed(() => searching.value ? visibleGroups.value.slice(0, searchGroupLimit.value) : visibleGroups.value);
watch(() => props.searchQuery, (value) => { query.value = value; });
function syncSearchPagination(value) {
  if (viewState.searchQuery === value) return;
  viewState.searchQuery = value;
  searchCollapsed.value = new Set();
  searchLimits.value = new Map();
  searchActivityLimit.value = 20;
  searchGroupLimit.value = 20;
}
syncSearchPagination(query.value);
let searchTimer;
watch(query, (value) => {
  syncSearchPagination(value);
  emit("update:searchQuery", value);
  if (props.pagination) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => emit("catalog-view", { view: viewMode.value, query: value }), 250);
  }
});
try { if (window.localStorage.getItem("codex-session-list-view") === "activity") viewMode.value = "activity"; } catch { /* Optional display preference. */ }
if (props.pagination) viewMode.value = props.pagination.view;
const activitySessions = computed(() => buildActivitySessions(visibleGroups.value));
const runningCount = computed(() => progress.value.runningTotal ?? activitySessions.value.filter(isSessionRunning).length);
const visibleActivityLimit = computed(() => props.pagination ? Infinity : searching.value ? searchActivityLimit.value : activityLimit.value);
const screenEl = ref(null);
const positionGeneration = props.getPositionGeneration();
const position = createSessionListPosition({ viewState, getRoot: () => screenEl.value,
  getContext: () => ({ mode: viewMode.value, query: query.value, loaded: props.loaded }),
  isCurrent: () => props.viewState === ownedViewState && props.getPositionGeneration() === positionGeneration
});
onMounted(() => {
  position.restore();
  if (props.pagination && queryPending.value) emit("catalog-view", { view: viewMode.value, query: query.value });
});
watch(() => [props.loaded, props.groups], position.restore, { flush: "post" });
watch(() => [query.value, viewMode.value, props.viewState, props.getPositionGeneration()], position.cancel, { flush: "sync" });
onBeforeUnmount(() => { clearTimeout(searchTimer); position.capture(); position.dispose(); });

function setViewMode(mode) {
  viewMode.value = mode;
  if (props.pagination) { clearTimeout(searchTimer); emit("catalog-view", { view: mode, query: query.value }); }
  try { window.localStorage.setItem("codex-session-list-view", mode); } catch { /* The view still works without storage. */ }
}
function searchLimit(group) { return searchLimits.value.get(sessionGroupKey(group)) || 5; }
function showAll(group) { return searching.value ? searchLimit(group) >= group.sessions.length : expandedLists.value.has(sessionGroupKey(group)); }
function visibleSessions(group) {
  if (props.pagination) return group.sessions;
  if (searching.value) return group.sessions.slice(0, searchLimit(group));
  return showAll(group) ? group.sessions : group.sessions.slice(0, 5);
}
function toggleList(group) {
  if (props.pagination) { emit("load-group", { key: sessionGroupKey(group), more: true }); return; }
  if (!progress.value.complete) return;
  if (searching.value) {
    const next = new Map(searchLimits.value);
    next.set(sessionGroupKey(group), showAll(group) ? 5 : searchLimit(group) + 20);
    searchLimits.value = next;
    return;
  }
  const next = new Set(expandedLists.value), key = sessionGroupKey(group);
  if (next.has(key)) next.delete(key); else next.add(key);
  expandedLists.value = next;
}
function groupCount(group) { return props.pagination ? group.catalogPage?.total || 0 : sessionListGroupCounts(group, progress.value).total; }
function groupRunningCount(group) { return props.pagination ? group.catalogPage?.running || 0 : sessionListGroupCounts(group, progress.value).running; }
function groupBusy(group) { return props.pagination?.loadingGroups.has(sessionGroupKey(group)); }
function groupError(group) { return props.pagination?.groupErrors.get(sessionGroupKey(group)); }
function groupHasMore(group) { return props.pagination ? Boolean(group.catalogPage?.nextCursor) : group.sessions.length > 5; }
function moreActivity() { if (props.pagination) emit("load-more"); else if (progress.value.complete) searching.value ? searchActivityLimit.value += 20 : activityLimit.value += 20; }

const observedGroups = new WeakMap();
const autoPages = new Map();
const requestedCursors = new Map();
let pagingIntent = false;
let touchY = null;
function tryAutoPage(record) {
  if (!props.pagination || !record.visible || !pagingIntent || queryPending.value) return;
  if (props.loadError) { record.waiting = false; return; }
  const key = record.key;
  const group = props.groups.find((entry) => sessionGroupKey(entry) === key);
  if (key !== "activity" && (!group || !isExpanded(group))) return;
  const cursor = key === "activity" ? props.pagination.page?.nextCursor : group?.catalogPage?.nextCursor;
  if (props.pagination.groupErrors.has(key)) { record.waiting = false; return; }
  if (!cursor || requestedCursors.get(key) === cursor) return;
  if (props.pagination.loading || props.pagination.loadingGroups.has(key)) { record.waiting = true; return; }
  record.waiting = false;
  requestedCursors.set(key, cursor);
  if (key === "activity") moreActivity();
  else if (group && isExpanded(group)) emit("load-group", { key, more: true });
}
function markPagingIntent(event) {
  if (event.type === "keydown" && event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
  if (event.type === "wheel") pagingIntent = event.deltaY > 0;
  else if (event.type === "keydown") pagingIntent = ["ArrowDown", "PageDown", "End", " "].includes(event.key);
  else {
    const next = event.touches?.[0]?.clientY;
    if (event.type === "touchmove" && touchY != null && next != null) pagingIntent = next < touchY;
    touchY = next ?? null;
  }
  if (pagingIntent) for (const record of autoPages.values()) tryAutoPage(record);
}
const vAutoPage = {
  mounted(element, binding) {
    const record = { key: binding.value, visible: false };
    autoPages.set(element, record);
    record.stop = observeElementVisibility(element, (visible) => { record.visible = visible; if (visible) tryAutoPage(record); }, { rootMargin: "0px" });
  },
  updated(element, binding) {
    const record = autoPages.get(element);
    if (record) { record.key = binding.value; if (record.waiting) tryAutoPage(record); }
  },
  beforeUnmount(element) { autoPages.get(element)?.stop(); autoPages.delete(element); }
};
watch(() => [query.value, viewMode.value], () => {
  pagingIntent = false; requestedCursors.clear();
  for (const record of autoPages.values()) record.waiting = false;
}, { flush: "sync" });
function loadVisibleGroup(key) {
  const group = props.groups.find((entry) => sessionGroupKey(entry) === key);
  if (props.pagination && !props.pagination.loading && !queryPending.value && group && isExpanded(group)
    && !group.sessions.length && groupHasMore(group) && !groupBusy(group) && !groupError(group)) emit("load-group", { key });
}
const vVisibleGroup = {
  mounted(element, binding) {
    const record = { visible: false, key: binding.value };
    observedGroups.set(element, record);
    record.stop = observeElementVisibility(element, (visible) => { record.visible = visible; if (visible) loadVisibleGroup(record.key); });
  },
  updated(element, binding) { const record = observedGroups.get(element); if (record) { record.key = binding.value; if (record.visible) loadVisibleGroup(record.key); } },
  beforeUnmount(element) { observedGroups.get(element)?.stop(); observedGroups.delete(element); }
};

function buildInitialExpandedSet(groups, activeSessionId) {
  const next = new Set();
  const activeGroup = groups.find((group) => group.sessions.some((session) => session.id === activeSessionId));
  for (const group of groups) {
    const key = sessionGroupKey(group);
    const expanded = localExpansion.value.has(key) ? localExpansion.value.get(key) : group.collapsed !== true;
    if (expanded || group === activeGroup && !localExpansion.value.has(key)) next.add(key);
  }
  return next;
}

watch(
  () => [props.groups, props.activeSessionId],
  ([groups, activeSessionId]) => {
    const next = buildInitialExpandedSet(groups, activeSessionId);
    expandedGroups.value = next;
  },
  { immediate: true }
);

function isExpanded(group) {
  return searching.value ? !searchCollapsed.value.has(sessionGroupKey(group)) : expandedGroups.value.has(sessionGroupKey(group));
}

function toggleGroup(group) {
  const name = sessionGroupKey(group);
  if (searching.value) {
    const next = new Set(searchCollapsed.value);
    if (next.has(name)) next.delete(name); else next.add(name);
    searchCollapsed.value = next;
    return;
  }
  const next = new Set(expandedGroups.value);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  localExpansion.value.set(name, next.has(name));
  expandedGroups.value = next;
}

function groupSubtitle(group) {
  const count = groupCount(group);
  const latest = group.sessions[0]?.updatedAt;
  const latestText = latest ? props.formatRelativeTime(latest) : "";
  return latestText ? `最近 ${latestText}` : count ? `${count} 个会话` : "";
}

function isCreatingGroup(group) {
  const cwd = String(group?.cwd || "").trim();
  return Boolean(cwd && props.pendingSessionId === `__creating__:${cwd}`);
}

function createGroupSession(group) {
  if (!progress.value.complete || !group || isCreatingGroup(group)) {
    return;
  }
  emit("create-group-session", group);
}
</script>

<template>
  <main ref="screenEl" class="session-screen" data-app-scroll tabindex="0" aria-label="会话列表" :aria-busy="loading && !progress.complete"
    @wheel.passive="markPagingIntent" @touchstart.passive="markPagingIntent" @touchmove.passive="markPagingIntent" @keydown="markPagingIntent">
    <SessionListToolbar v-model:search="query" :mode="viewMode" :running-count="runningCount"
      :result-count="progress.complete ? pagination?.page?.activitiesTotal ?? activitySessions.length : null" @update:mode="setViewMode" />
    <div v-if="loadError" class="session-list-error" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" :disabled="loading" aria-label="重新加载会话" title="重新加载会话" @click="emit('retry')">&#x21bb;</button>
    </div>
    <div v-else-if="(loading || queryPending) && !progress.complete" class="session-list-loading" role="status">{{ searching ? '正在搜索…' : '正在加载会话…' }}</div>
    <section v-if="visibleGroups.length && viewMode === 'groups'" class="session-groups">
      <section v-for="group in renderedGroups" :key="sessionGroupKey(group)" v-visible-group="sessionGroupKey(group)" class="session-group" :data-group-id="sessionGroupKey(group)">
        <div class="session-group-head">
          <button
            class="session-group-toggle-area"
            type="button"
            :aria-expanded="isExpanded(group)"
            @click="toggleGroup(group)"
          >
            <div class="session-group-head-main">
              <span class="folder-icon" aria-hidden="true"></span>
              <div class="session-group-copy">
                <div class="session-group-title-row">
                  <h2>{{ group.name }}</h2>
                  <span class="session-group-count">{{ groupCount(group) }}</span>
                  <span v-if="groupRunningCount(group)" class="session-running-count">{{ groupRunningCount(group) }} 个运行中</span>
                </div>
                <p class="session-group-subtitle">{{ groupSubtitle(group) }}</p>
              </div>
            </div>
          </button>
          <button
            v-if="group.cwd && (!group.groupKind || group.groupKind === 'project')"
            class="session-group-add"
            :class="{ loading: isCreatingGroup(group) }"
            type="button"
            :aria-label="`在 ${group.name} 新增会话`"
            title="新增会话"
            :disabled="!progress.complete || isCreatingGroup(group)"
            :aria-busy="isCreatingGroup(group) ? 'true' : undefined"
            @click.stop="createGroupSession(group)"
          >
            <span class="session-group-add-label" aria-hidden="true">+</span>
          </button>
        </div>
        <div v-if="isExpanded(group)" class="session-group-body">
          <p v-if="pagination && groupError(group)" class="session-list-error" role="alert">{{ groupError(group) }}<button type="button" :disabled="groupBusy(group)" aria-label="重试加载此分组" title="重试" @click="toggleList(group)">&#x21bb;</button></p>
          <p v-else-if="pagination && !group.sessions.length && groupCount(group)" class="session-row-placeholder" :role="groupBusy(group) ? 'status' : undefined">{{ groupBusy(group) ? '正在加载会话…' : '' }}</p>
          <p v-else-if="progress.complete && !group.sessions.length && !loadError" class="session-row-placeholder">暂无对话</p>
          <SessionListRow v-for="session in visibleSessions(group)" :key="session.id" :session="session"
            :active="session.id === activeSessionId" :pending="session.id === pendingSessionId"
            :format-relative-time="formatRelativeTime" @open="emit('open', $event)" />
          <button v-if="groupHasMore(group) && (!pagination || group.sessions.length)" v-auto-page="sessionGroupKey(group)" class="session-show-more" type="button" :disabled="!progress.complete || groupBusy(group) || pagination?.loading" :aria-expanded="pagination ? undefined : showAll(group)" @click="toggleList(group)">
            {{ pagination ? groupBusy(group) ? '正在加载…' : `再显示 ${Math.min(20, groupCount(group) - group.sessions.length)} 个会话` : showAll(group) ? '收起，只显示 5 个' : `再显示 ${searching ? Math.min(20, group.sessions.length - searchLimit(group)) : group.sessions.length - 5} 个会话` }}
            <span aria-hidden="true">{{ showAll(group) ? '⌃' : '⌄' }}</span>
          </button>
        </div>
      </section>
      <button v-if="searching && searchGroupLimit < visibleGroups.length" type="button" class="session-show-more session-more-projects" @click="searchGroupLimit += 20">显示更多匹配分组</button>
    </section>
    <section v-else-if="viewMode === 'activity' && activitySessions.length" class="session-activity" aria-label="按最近使用排序的会话">
      <SessionListRow v-for="session in activitySessions.slice(0, visibleActivityLimit)" :key="session.id" :session="session" show-project
        :active="session.id === activeSessionId" :pending="session.id === pendingSessionId"
        :format-relative-time="formatRelativeTime" @open="emit('open', $event)" />
      <p v-if="pagination?.groupErrors.get('activity')" class="session-list-error" role="alert">{{ pagination.groupErrors.get('activity') }}</p>
      <button v-if="pagination ? pagination.page?.nextCursor : visibleActivityLimit < activitySessions.length" v-auto-page="'activity'" type="button" class="session-show-more" :disabled="!progress.complete || pagination?.loading || pagination?.loadingGroups.has('activity')" @click="moreActivity">{{ pagination?.loadingGroups.has('activity') ? '正在加载…' : '显示更早的会话' }} <span aria-hidden="true">⌄</span></button>
    </section>
    <div v-if="progress.complete && !loadError && (viewMode === 'activity' ? !activitySessions.length : !visibleGroups.length)" class="empty-state">{{ searching ? '没有匹配的会话或项目。' : '还没有可展示的会话。' }}</div>
  </main>
</template>

<style src="../styles/session-list.css"></style>
