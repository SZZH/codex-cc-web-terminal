<script setup>
const props = defineProps({
  gitState: { type: Object, default: () => ({ isGitRepo: false, currentBranch: "", branches: [], dirty: false }) },
  disabled: Boolean,
  busy: Boolean
});

const emit = defineEmits(["select-branch", "create-branch", "refresh"]);
</script>

<template>
  <div class="branch-sheet">
    <section class="branch-group">
      <header class="branch-heading branch-header">
        <span>当前分支</span>
        <button class="branch-refresh" type="button" title="刷新 Git 状态" aria-label="刷新 Git 状态"
          :disabled="disabled || busy || gitState.loading" @click="emit('refresh')">&#x21bb;</button>
      </header>
      <div class="branch-current-card">
        <strong>{{ gitState.available === false ? "Git 状态暂不可用" : gitState.currentBranch || "未选择分支" }}</strong>
        <small>
          {{
            gitState.dirty
              ? "工作区有未提交改动"
              : "当前仓库分支"
          }}
        </small>
      </div>
      <p v-if="gitState.error" class="branch-error" role="status">{{ gitState.error }}</p>
    </section>

    <section class="branch-group">
      <header class="branch-heading">切换分支</header>
      <div class="branch-chip-row">
        <button
          v-for="branch in gitState.branches || []"
          :key="branch.name"
          class="branch-chip"
          :class="{ active: branch.current }"
          type="button"
          :disabled="disabled || busy || gitState.loading || gitState.available === false || !gitState.isGitRepo || gitState.dirty || branch.current"
          @click="emit('select-branch', branch.name)"
        >
          {{ branch.name }}
        </button>
      </div>
      <p class="branch-meta">
        {{
          gitState.dirty
            ? "当前有未提交改动，先处理改动后再切换分支"
            : gitState.branches?.find((branch) => !branch.current && branch.remote)
              ? "包含本地与远程跟踪分支"
            : "显示当前仓库的可切换分支"
        }}
      </p>
    </section>

    <section class="branch-group">
      <header class="branch-heading">新建分支</header>
      <button class="branch-create" type="button" :disabled="disabled || busy || gitState.loading || gitState.available === false || !gitState.isGitRepo" @click="emit('create-branch')">
        从当前状态新建 Git 分支
      </button>
    </section>
  </div>
</template>

<style scoped>
.branch-sheet {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 16px 16px;
}

.branch-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.branch-heading {
  font-size: 13px;
  line-height: 1.35;
  color: #7f7165;
}

.branch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.branch-refresh {
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid rgba(221, 211, 201, 0.95);
  border-radius: 8px;
  background: rgba(250, 245, 239, 0.88);
  color: #60534a;
  font-size: 24px;
  cursor: pointer;
}

.branch-error {
  margin: 0;
  max-height: 96px;
  overflow: auto;
  overflow-wrap: anywhere;
  color: #9b4537;
  font-size: 12px;
  line-height: 1.4;
}

.branch-current-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  border: 1px solid rgba(221, 211, 201, 0.95);
  border-radius: 16px;
  background: rgba(248, 243, 238, 0.92);
  overflow-wrap: anywhere;
}

.branch-current-card strong,
.branch-option strong {
  font-size: 14px;
  line-height: 1.35;
  color: #3f342d;
}

.branch-current-card small,
.branch-meta {
  font-size: 12px;
  line-height: 1.35;
  color: #8b7b6f;
}

.branch-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.branch-chip {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid rgba(221, 211, 201, 0.95);
  border-radius: 999px;
  background: rgba(246, 240, 234, 0.88);
  color: #60534a;
  font-size: 13px;
  cursor: pointer;
}

.branch-chip.active {
  border-color: rgba(173, 155, 140, 0.96);
  background: rgba(232, 221, 211, 0.95);
  color: #3d342d;
}

.branch-meta {
  margin: 0;
}

.branch-create {
  width: 100%;
  min-height: 42px;
  border: 1px dashed rgba(190, 174, 160, 0.9);
  border-radius: 14px;
  background: rgba(250, 247, 244, 0.84);
  color: #65584e;
  cursor: pointer;
}

.branch-chip:disabled,
.branch-create:disabled,
.branch-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
