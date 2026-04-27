<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { requestWorkspaceChanges, revertWorkspaceChanges } from "../../lib/api.js";

const props = defineProps({
  cwd: { type: String, default: "" }
});

const emit = defineEmits(["status"]);

const loading = ref(false);
const reverting = ref(false);
const error = ref("");
const changes = ref({ files: [] });
const expanded = ref(new Set());

const files = computed(() => Array.isArray(changes.value?.files) ? changes.value.files : []);
const hasChanges = computed(() => files.value.length > 0);
const totalLabel = computed(() => `${files.value.length} 个文件已更改`);

function fileKey(file) {
  return String(file?.path || "");
}

function isExpanded(file) {
  return expanded.value.has(fileKey(file));
}

function toggleFile(file) {
  const key = fileKey(file);
  if (!key) {
    return;
  }
  const next = new Set(expanded.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expanded.value = next;
}

function statusLabel(status) {
  const text = String(status || "").trim();
  if (text === "??") return "新增";
  if (text.includes("D")) return "删除";
  if (text.includes("R")) return "重命名";
  if (text.includes("A")) return "新增";
  return "修改";
}

function formatDiffLines(diff) {
  return String(diff || "").split(/\r?\n/).map((text, index) => {
    const type = text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "del" : text.startsWith("@@") ? "meta" : "ctx";
    return { id: `${index}:${text}`, text, type };
  });
}

async function loadChanges({ silent = false } = {}) {
  const cwd = String(props.cwd || "").trim();
  if (!cwd) {
    changes.value = { files: [] };
    return;
  }
  if (!silent) {
    loading.value = true;
  }
  error.value = "";
  try {
    changes.value = await requestWorkspaceChanges(cwd);
  } catch (err) {
    error.value = err?.message || String(err);
  } finally {
    loading.value = false;
  }
}

async function revertFiles(paths) {
  const cwd = String(props.cwd || "").trim();
  const selected = (Array.isArray(paths) ? paths : []).map((item) => String(item || "").trim()).filter(Boolean);
  if (!cwd || reverting.value || !selected.length) {
    return;
  }
  reverting.value = true;
  error.value = "";
  try {
    changes.value = await revertWorkspaceChanges(cwd, selected);
    expanded.value = new Set([...expanded.value].filter((key) => files.value.some((file) => file.path === key)));
    emit("status", selected.length === 1 ? `已撤销 ${selected[0]}` : `已撤销 ${selected.length} 个文件`);
  } catch (err) {
    error.value = err?.message || String(err);
  } finally {
    reverting.value = false;
  }
}

function revertAll() {
  revertFiles(files.value.map((file) => file.path));
}

watch(
  () => props.cwd,
  () => {
    expanded.value = new Set();
    loadChanges();
  }
);

onMounted(() => loadChanges());
</script>

<template>
  <section v-if="hasChanges || loading || error" class="workspace-changes">
    <header class="workspace-changes-head">
      <strong>{{ loading ? "正在检查文件变更…" : totalLabel }}</strong>
      <button
        v-if="hasChanges"
        class="workspace-changes-action"
        type="button"
        :disabled="reverting"
        @click="revertAll"
      >
        撤销
      </button>
    </header>

    <p v-if="error" class="workspace-changes-error">{{ error }}</p>

    <div v-for="file in files" :key="file.path" class="workspace-change-file">
      <div class="workspace-change-row">
        <button class="workspace-change-main" type="button" @click="toggleFile(file)">
          <span class="workspace-change-name">{{ file.path }}</span>
          <span class="workspace-change-status">{{ statusLabel(file.status) }}</span>
          <span class="workspace-change-stat add">+{{ file.additions || 0 }}</span>
          <span class="workspace-change-stat del">-{{ file.deletions || 0 }}</span>
        </button>
        <span class="workspace-change-spacer"></span>
        <button
          class="workspace-change-icon"
          type="button"
          title="撤销这个文件"
          :disabled="reverting"
          @click.stop="revertFiles([file.path])"
        >
          ↶
        </button>
        <span class="workspace-change-icon" aria-hidden="true">{{ isExpanded(file) ? "⌃" : "⌄" }}</span>
      </div>

      <div v-if="isExpanded(file)" class="workspace-change-diff">
        <pre v-if="file.diff" class="workspace-change-code"><code>
<span
  v-for="line in formatDiffLines(file.diff)"
  :key="line.id"
  class="workspace-change-line"
  :class="line.type"
>{{ line.text || " " }}</span></code></pre>
        <p v-else class="workspace-change-empty">没有可展示的文本 diff。</p>
      </div>
    </div>
  </section>
</template>
