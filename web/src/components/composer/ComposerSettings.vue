<script setup>
import { computed } from "vue";
import {
  PERMISSION_MODE_OPTIONS,
  getModelReasoningEffortOptions
} from "../../lib/composer.js";

const props = defineProps({
  models: { type: Array, default: () => [] },
  permissionModeOptions: { type: Array, default: () => PERMISSION_MODE_OPTIONS },
  composerOptions: { type: Object, required: true },
  gitState: { type: Object, required: true },
  disabled: Boolean,
  showPermissionMode: Boolean
});

const reasoningOptions = computed(() =>
  getModelReasoningEffortOptions(props.models, props.composerOptions.model)
);

defineEmits([
  "select-model",
  "select-reasoning",
  "select-permission",
  "refresh-git"
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
          :aria-pressed="composerOptions.model === model.value"
          type="button"
          :disabled="disabled"
          @click="$emit('select-model', model.value)"
        >
          {{ model.label }}
        </button>
        <span v-if="!models.length" class="empty-hint">当前未读取到模型列表</span>
      </div>
    </section>

    <section v-if="reasoningOptions.length" class="settings-group">
      <header class="settings-heading">思考强度</header>
      <div class="chip-row">
        <button
          v-for="option in reasoningOptions"
          :key="option.value"
          class="option-chip"
          :class="{ active: composerOptions.reasoningEffort === option.value }"
          :aria-pressed="composerOptions.reasoningEffort === option.value"
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
      <div class="chip-row">
        <button
          v-for="option in permissionModeOptions"
          :key="option.value"
          class="option-chip permission-option"
          :class="{ active: composerOptions.permissionMode === option.value }"
          :aria-pressed="composerOptions.permissionMode === option.value"
          :title="option.description"
          type="button"
          :disabled="disabled"
          @click="$emit('select-permission', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <p class="permission-description">{{ permissionModeOptions.find(option => option.value === composerOptions.permissionMode)?.description }}</p>
    </section>

    <section class="settings-group git-entry-wrap">
      <div class="git-entry-row">
      <div class="git-entry">
        <span class="git-copy">
          <span class="settings-heading">Git 分支</span>
          <span class="git-desc">
            {{
              !gitState.available
                ? "Git 状态暂不可用"
                : gitState.isGitRepo
                  ? (gitState.currentBranch || "分离 HEAD")
                  : "当前目录不是 Git 仓库"
            }}
          </span>
        </span>
      </div>
      <button
        class="git-refresh"
        type="button"
        title="刷新 Git 状态"
        aria-label="刷新 Git 状态"
        :disabled="disabled || gitState.loading"
        @click="$emit('refresh-git')"
      >&#x21bb;</button>
      </div>
      <p v-if="gitState.error" class="git-error" role="status">{{ gitState.error }}</p>
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
.permission-description { margin: 0; color: #7f7165; font-size: 12px; line-height: 1.6; }
.option-chip:focus-visible { outline: 2px solid #8b7f73; outline-offset: 2px; }
@media (pointer: coarse) { .option-chip { min-height: 44px; } }

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

.git-entry-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.git-refresh {
  flex: 0 0 44px;
  min-height: 44px;
  padding: 0;
  border: 1px solid rgba(221, 211, 201, 0.95);
  border-radius: 8px;
  background: rgba(250, 245, 239, 0.88);
  color: #60534a;
  font-size: 24px;
  cursor: pointer;
}

.git-error {
  margin: 0;
  max-height: 96px;
  overflow: auto;
  overflow-wrap: anywhere;
  color: #9b4537;
  font-size: 12px;
  line-height: 1.4;
}

.git-entry {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
  padding: 12px 14px;
  text-align: left;
  border: 1px solid rgba(221, 211, 201, 0.95);
  border-radius: 14px;
  background: rgba(250, 245, 239, 0.88);
}

.git-entry {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.git-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.git-desc {
  font-size: 14px;
  line-height: 1.35;
  color: #3f342d;
  overflow-wrap: anywhere;
}

.git-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
