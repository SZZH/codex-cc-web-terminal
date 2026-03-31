<script setup>
defineProps({
  groupedSessions: { type: Array, default: () => [] },
  activeSessionId: { type: String, default: '' },
  pendingSessionId: { type: String, default: '' },
  statusText: { type: String, default: '' },
  formatRelativeTime: { type: Function, required: true },
  defaultPreview: { type: Function, required: true },
});
const emit = defineEmits(['open']);
</script>

<template>
  <main class="session-screen">
    <section v-if="groupedSessions.length" class="session-groups">
      <section v-for="group in groupedSessions" :key="group.name" class="session-group">
        <header class="session-group-head">
          <span class="folder-icon">⌂</span>
          <h2>{{ group.name }}</h2>
        </header>

        <button
          v-for="session in group.sessions"
          :key="session.id"
          class="session-row"
          :class="{ active: session.id === activeSessionId, pending: session.id === pendingSessionId }"
          @click="emit('open', session)"
        >
          <div class="session-row-body">
            <p class="session-row-title">{{ session.displayTitle }}</p>
            <div class="session-row-meta">
              <p class="session-row-preview">{{ session.displayPreview || defaultPreview(session) }}</p>
              <time class="session-row-time">{{ formatRelativeTime(session.updatedAt) }}</time>
            </div>
          </div>
        </button>
      </section>
    </section>

    <div v-else class="empty-state">还没有可展示的会话。</div>
    <div v-if="statusText" class="notice-strip">{{ statusText }}</div>
  </main>
</template>
