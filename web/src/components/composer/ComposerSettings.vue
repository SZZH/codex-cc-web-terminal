<script setup>
import {
  PERMISSION_MODE_OPTIONS,
  REASONING_EFFORT_OPTIONS
} from "../../lib/composer.js";

defineProps({
  models: { type: Array, default: () => [] },
  composerOptions: { type: Object, required: true },
  gitState: { type: Object, required: true },
  disabled: Boolean,
  showPermissionMode: Boolean
});

defineEmits([
  "select-model",
  "select-reasoning",
  "select-permission",
  "open-git"
]);
</script>

<template>
  <div class="settings-body">
    <section class="settings-group">
      <header class="settings-heading">模型</header>
      <div class="chip-row">
        <button
          v-for="model in models"
          :key="model.value"
          class="option-chip"
          :class="{ active: composerOptions.model === model.value }"
          type="button"
          :disabled="disabled"
          @click="$emit('select-model', model.value)"
        >
          {{ model.label }}
        </button>
        <span v-if="!models.length" class="empty-hint">当前未读取到模型列表</span>
      </div>
    </section>

    <section class="settings-group">
      <header class="settings-heading">思考强度</header>
      <div class="chip-row">
        <button
          v-for="option in REASONING_EFFORT_OPTIONS"
          :key="option.value"
          class="option-chip"
          :class="{ active: composerOptions.reasoningEffort === option.value }"
          type="button"
          :disabled="disabled"
          @click="$emit('select-reasoning', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </section>

    <section v-if="showPermissionMode" class="settings-group">
      <header class="settings-heading">Codex 权限</header>
      <div class="permission-list">
        <button
          v-for="option in PERMISSION_MODE_OPTIONS"
          :key="option.value"
          class="permission-card"
          :class="{ active: composerOptions.permissionMode === option.value }"
          type="button"
          :disabled="disabled"
          @click="$emit('select-permission', option.value)"
        >
          <span class="permission-copy">
            <span class="permission-title">{{ option.label }}</span>
            <span class="permission-desc">{{ option.description }}</span>
          </span>
          <span class="permission-check" aria-hidden="true">
            {{ composerOptions.permissionMode === option.value ? "✓" : "" }}
          </span>
        </button>
      </div>
    </section>

    <section class="settings-group git-entry-wrap">
      <button
        class="git-entry"
        type="button"
        :disabled="disabled || !gitState.available || !gitState.isGitRepo"
        @click="$emit('open-git')"
      >
        <span class="git-copy">
          <span class="settings-heading">Git 分支</span>
          <span class="git-desc">
            {{
              !gitState.available
                ? "Git 状态暂不可用"
                : gitState.isGitRepo
                  ? (gitState.currentBranch || composerOptions.gitBranch || "未选择分支")
                  : "当前目录不是 Git 仓库"
            }}
          </span>
        </span>
      </button>
    </section>
  </div>
</template>

<style scoped>
.settings-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 16px 16px;
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.settings-heading {
  font-size: 13px;
  line-height: 1.35;
  color: #7f7165;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.empty-hint {
  font-size: 12px;
  line-height: 1.4;
  color: #8a7b6f;
}

.option-chip {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid rgba(221, 211, 201, 0.95);
  border-radius: 999px;
  background: rgba(246, 240, 234, 0.88);
  color: #60534a;
  font-size: 13px;
}

.option-chip.active {
  border-color: rgba(173, 155, 140, 0.96);
  background: rgba(232, 221, 211, 0.95);
  color: #3d342d;
}

.permission-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.permission-card,
.git-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  text-align: left;
  border: 1px solid rgba(221, 211, 201, 0.95);
  border-radius: 14px;
  background: rgba(250, 245, 239, 0.88);
}

.permission-card.active {
  border-color: rgba(173, 155, 140, 0.96);
  background: rgba(239, 230, 221, 0.95);
}

.permission-copy,
.git-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.permission-title,
.git-desc {
  font-size: 14px;
  line-height: 1.35;
  color: #3f342d;
}

.permission-desc {
  font-size: 12px;
  line-height: 1.45;
  color: #8a7b6f;
}

.permission-check {
  flex: 0 0 auto;
  font-size: 12px;
  color: #8e7b6b;
}

.git-entry:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
