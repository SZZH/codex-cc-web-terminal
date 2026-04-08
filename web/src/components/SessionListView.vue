<script setup>
import { onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({
  groups: { type: Array, default: () => [] },
  activeSessionId: { type: String, default: "" },
  pendingSessionId: { type: String, default: "" },
  formatRelativeTime: { type: Function, required: true }
});

const emit = defineEmits(["open", "create-group-session"]);
const expandedGroups = ref(new Set());
const openMenuGroupName = ref("");
const openMenuPoint = ref({ x: 0, y: 0 });
const longPressTimer = ref(null);
const longPressGroupName = ref("");
const suppressToggleUntil = ref(0);

function buildInitialExpandedSet(groups, activeSessionId) {
  const next = new Set();
  const activeGroup = groups.find((group) => group.sessions.some((session) => session.id === activeSessionId));
  if (activeGroup?.name) {
    next.add(activeGroup.name);
  }
  for (const group of groups.slice(0, activeGroup ? 2 : 3)) {
    next.add(group.name);
  }
  return next;
}

watch(
  () => [props.groups, props.activeSessionId],
  ([groups, activeSessionId]) => {
    const next = buildInitialExpandedSet(groups, activeSessionId);
    for (const group of groups) {
      if (expandedGroups.value.has(group.name)) {
        next.add(group.name);
      }
    }
    expandedGroups.value = next;
  },
  { immediate: true }
);

function isExpanded(name) {
  return expandedGroups.value.has(name);
}

function toggleGroup(name) {
  if (Date.now() < suppressToggleUntil.value) {
    return;
  }
  const next = new Set(expandedGroups.value);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  expandedGroups.value = next;
}

function groupSubtitle(group) {
  const count = group.sessions.length;
  const latest = group.sessions[0]?.updatedAt;
  const latestText = latest ? props.formatRelativeTime(latest) : "";
  return latestText ? `最近 ${latestText}` : count ? `${count} 个会话` : "暂无更新时间";
}

function closeMenu() {
  openMenuGroupName.value = "";
}

function clearLongPressTimer() {
  if (longPressTimer.value) {
    window.clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
}

function onGroupPointerDown(group, event) {
  const clientX = Number(event?.clientX || 0);
  const clientY = Number(event?.clientY || 0);
  openMenuPoint.value = { x: clientX, y: clientY };
  clearLongPressTimer();
  longPressGroupName.value = group.name;
  longPressTimer.value = window.setTimeout(() => {
    openMenuGroupName.value = group.name;
    suppressToggleUntil.value = Date.now() + 260;
    longPressTimer.value = null;
  }, 500);
}

function onGroupPointerUp() {
  clearLongPressTimer();
}

function onGlobalPointerDown(event) {
  if (!openMenuGroupName.value) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    closeMenu();
    return;
  }
  if (target.closest(".group-action-popover")) {
    return;
  }
  closeMenu();
}

function createGroupSession(group) {
  if (!group) {
    closeMenu();
    return;
  }
  closeMenu();
  emit("create-group-session", group);
}

function menuStyle() {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 390;
  const x = Number(openMenuPoint.value?.x || 0);
  const y = Number(openMenuPoint.value?.y || 0);
  const clampedX = Math.max(12, Math.min(x, viewportWidth - 12));
  return {
    left: `${clampedX}px`,
    top: `${Math.max(8, y - 10)}px`
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", onGlobalPointerDown, true);
}

onBeforeUnmount(() => {
  clearLongPressTimer();
  if (typeof window !== "undefined") {
    window.removeEventListener("pointerdown", onGlobalPointerDown, true);
  }
});
</script>

<template>
  <main class="session-screen">
    <section v-if="groups.length" class="session-groups">
      <section v-for="group in groups" :key="group.name" class="session-group">
        <button
          class="session-group-head"
          type="button"
          @click="toggleGroup(group.name)"
          @pointerdown="onGroupPointerDown(group, $event)"
          @pointerup="onGroupPointerUp"
          @pointercancel="onGroupPointerUp"
          @pointerleave="onGroupPointerUp"
        >
          <div class="session-group-head-main">
            <span class="folder-icon" aria-hidden="true"></span>
            <div class="session-group-copy">
              <div class="session-group-title-row">
                <h2>{{ group.name }}</h2>
                <span class="session-group-count">{{ group.sessions.length }}</span>
              </div>
              <p class="session-group-subtitle">{{ groupSubtitle(group) }}</p>
            </div>
          </div>
          <span class="session-group-toggle" :class="{ expanded: isExpanded(group.name) }" aria-hidden="true">⌄</span>
        </button>
        <div v-show="isExpanded(group.name)" class="session-group-body">
          <button
            v-for="session in group.sessions"
            :key="session.id"
            class="session-row"
            :class="{ active: session.id === activeSessionId, pending: session.id === pendingSessionId }"
            :aria-current="session.id === activeSessionId ? 'true' : undefined"
            @click="emit('open', session)"
          >
            <div class="session-row-body">
              <p class="session-row-title">{{ session.displayTitle }}</p>
              <time class="session-row-time">{{ formatRelativeTime(session.updatedAt) }}</time>
            </div>
          </button>
        </div>
      </section>
    </section>
    <div
      v-if="openMenuGroupName"
      class="group-action-popover floating"
      :style="menuStyle()"
    >
      <button
        type="button"
        class="group-action-btn"
        @click.stop="createGroupSession(groups.find((item) => item.name === openMenuGroupName))"
      >
        新增会话
      </button>
    </div>

    <div v-else class="empty-state">还没有可展示的会话。</div>
  </main>
</template>

<style scoped>
.session-screen {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 12px 12px 18px;
}

.session-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.session-group {
  position: relative;
  overflow: visible;
  border: 1px solid rgba(201, 189, 177, 0.55);
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(255, 251, 247, 0.98), rgba(247, 242, 237, 0.94));
  box-shadow: 0 12px 30px rgba(120, 101, 84, 0.05);
}

.group-action-popover {
  position: absolute;
  left: 14px;
  top: 8px;
  transform: translateY(-100%);
  z-index: 5;
  border: 1px solid rgba(206, 193, 179, 0.78);
  border-radius: 12px;
  background: rgba(255, 252, 248, 0.98);
  box-shadow: 0 14px 26px rgba(84, 72, 58, 0.16);
  padding: 6px;
}

.group-action-popover.floating {
  position: fixed;
  z-index: 2200;
  transform: translate(-50%, -100%);
}

.group-action-btn {
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: rgba(70, 58, 47, 0.95);
  font-size: 13px;
  line-height: 1.2;
  font-weight: 600;
  padding: 8px 10px;
  cursor: pointer;
  white-space: nowrap;
}

.group-action-btn:active {
  background: rgba(171, 149, 126, 0.16);
}

.session-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 14px 14px 13px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition:
    background-color 0.16s ease,
    transform 0.16s ease;
}

.session-group-head:active {
  background: rgba(161, 145, 129, 0.06);
  transform: translateY(1px);
}

.session-group-head:focus-visible {
  outline: 2px solid rgba(182, 160, 139, 0.34);
  outline-offset: -2px;
}

.session-group-head-main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  flex: 1;
}

.folder-icon {
  position: relative;
  flex: 0 0 30px;
  width: 30px;
  height: 30px;
  margin-top: 1px;
  border: 1px solid rgba(205, 193, 181, 0.66);
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(240, 232, 224, 0.98), rgba(248, 242, 236, 0.9));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
}

.folder-icon::before {
  content: "";
  position: absolute;
  left: 4px;
  top: 6px;
  width: 12px;
  height: 5px;
  border-radius: 4px 4px 0 0;
  background: rgba(146, 126, 108, 0.16);
}

.folder-icon::after {
  content: "";
  position: absolute;
  inset: 9px 4px 4px;
  border-radius: 5px;
  background: rgba(146, 126, 108, 0.1);
}

.session-group-copy {
  min-width: 0;
  flex: 1;
}

.session-group-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.session-group-title-row h2 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: rgba(58, 50, 42, 0.94);
  font-size: 15px;
  font-weight: 650;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-group-count {
  flex: 0 0 auto;
  padding: 4px 8px;
  border: 1px solid rgba(208, 197, 187, 0.6);
  border-radius: 999px;
  background: rgba(245, 239, 233, 0.92);
  color: rgba(127, 112, 98, 0.92);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}

.session-group-subtitle {
  margin: 5px 0 0;
  color: rgba(140, 124, 110, 0.95);
  font-size: 12px;
  line-height: 1.35;
}

.session-group-toggle {
  flex: 0 0 auto;
  align-self: center;
  color: rgba(143, 127, 113, 0.82);
  font-size: 15px;
  line-height: 1;
  transition: transform 0.2s ease, color 0.16s ease;
}

.session-group-toggle.expanded {
  transform: rotate(180deg);
  color: rgba(155, 133, 112, 0.92);
}

.session-group-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 10px 10px 42px;
}

.session-group-body::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 10px;
  left: 26px;
  width: 1px;
  background: linear-gradient(
    180deg,
    rgba(201, 189, 177, 0.42),
    rgba(201, 189, 177, 0.1)
  );
}

.session-row {
  display: block;
  width: 100%;
  padding: 10px 12px 10px 12px;
  border: 1px solid transparent;
  border-radius: 14px;
  background: rgba(255, 252, 249, 0.74);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.72),
    0 0 0 rgba(120, 101, 84, 0);
  color: inherit;
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition:
    transform 0.16s ease,
    background-color 0.16s ease,
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.session-row:hover {
  background: rgba(255, 250, 246, 0.94);
}

.session-row:active {
  transform: translateY(1px) scale(0.998);
}

.session-row:focus-visible {
  outline: 2px solid rgba(182, 160, 139, 0.32);
  outline-offset: 2px;
}

.session-row.active {
  border-color: rgba(188, 170, 152, 0.42);
  background: linear-gradient(180deg, rgba(250, 244, 237, 0.98), rgba(255, 252, 248, 0.92));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.88),
    0 8px 20px rgba(146, 126, 108, 0.08);
}

.session-row.pending {
  border-color: rgba(196, 178, 160, 0.4);
  background: linear-gradient(180deg, rgba(251, 247, 242, 0.95), rgba(255, 252, 248, 0.92));
}

.session-row-body {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.session-row-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: rgba(58, 50, 42, 0.94);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-row-time {
  flex: 0 0 auto;
  color: rgba(142, 126, 113, 0.94);
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}

.session-row.active .session-row-title {
  color: rgb(97, 81, 66);
}

.empty-state {
  padding: 24px 18px;
  border: 1px dashed rgba(205, 193, 181, 0.7);
  border-radius: 18px;
  background: rgba(250, 246, 242, 0.78);
  color: rgba(142, 126, 113, 0.92);
  font-size: 13px;
  text-align: center;
}

@media (min-width: 700px) {
  .session-screen {
    padding: 14px 16px 20px;
  }
}
</style>
