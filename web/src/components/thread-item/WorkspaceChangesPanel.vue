<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { applyPatchWorkspaceChanges, requestWorkspaceChanges, reversePatchWorkspaceChanges } from "../../lib/api.js";
import { observeElementVisibility } from "../../lib/element-visibility.js";
import { createWorkspaceChangesRefresh } from "../../lib/workspace-changes-refresh.js";
import { openLocalPreview } from "../../lib/preview.js";

const props = defineProps({
  cwd: { type: String, default: "" },
  files: { type: Array, default: () => [] },
  interactive: { type: Boolean, default: false },
  readOnly: { type: Boolean, default: false }
});

const emit = defineEmits(["status"]);

const loading = ref(false);
const reverting = ref(false);
const error = ref("");
const writeOutcome = ref("");
const changes = ref({ files: [] });
const expanded = ref(new Set());
const toggledPaths = ref(new Set());
const showAllFiles = ref(false);
const previewFileCount = 3;
const visibilityElement = ref(null);
let workspaceVersion = 0;
let nearViewport = false;
let disposed = false;
let stopVisibility = () => {};
const fileDetails = ref({});
const detailReads = new Map();
let detailRevision = 0;

const sourceFiles = computed(() => {
  if (Array.isArray(props.files) && props.files.length > 0) {
    return props.files;
  }
  return Array.isArray(changes.value?.files) ? changes.value.files.map((file) => ({ ...file, ...fileDetails.value[file.path] })) : [];
});
const hasHistoricalFiles = computed(() => Array.isArray(props.files) && props.files.length > 0);
const fileCwd = computed(() => hasHistoricalFiles.value ? props.cwd : changes.value.cwd || props.cwd);
const files = computed(() =>
  hasHistoricalFiles.value
    ? sourceFiles.value
    : sourceFiles.value.filter((file) => !toggledPaths.value.has(fileKey(file)))
);
const hasChanges = computed(() => files.value.length > 0);
const totalLabel = computed(() => hasHistoricalFiles.value ? `已编辑 ${files.value.length} 个文件` : `工作区变更 · ${files.value.length} 个文件`);
const visibleFiles = computed(() => showAllFiles.value ? files.value : files.value.slice(0, previewFileCount));
const hiddenFileCount = computed(() => Math.max(0, files.value.length - previewFileCount));
const totalStats = computed(() => files.value.reduce((total, file) => ({
  additions: total.additions + (Number(file.additions) || 0),
  deletions: total.deletions + (Number(file.deletions) || 0)
}), { additions: 0, deletions: 0 }));
const statsKnown = (file) => file.statsKnown !== false && Number.isFinite(file.additions) && Number.isFinite(file.deletions);
const totalStatsKnown = computed(() => files.value.every(statsKnown));
const allVisibleFilesToggled = computed(() =>
  hasHistoricalFiles.value && files.value.length > 0 && files.value.every((file) => hasToggledFile(file))
);
const actionLabel = computed(() => allVisibleFilesToggled.value ? "恢复" : "撤销");
const canApplyAll = computed(() => !props.readOnly && props.interactive && Boolean(props.cwd.trim()) && !loading.value &&
  !writeOutcome.value && changes.value.capabilities?.applyPatch === true && files.value.length > 0 && files.value.every(canPatchFile));

function canPatchFile(file) {
  const filePath = String(file?.path || "").replaceAll("\\", "/");
  if (!filePath || /^(?:\/|[A-Za-z]:)/.test(filePath) || /[\0\r\n]/.test(filePath) || filePath.split("/").includes("..") || file.previousPath || file.truncated) return false;
  const diff = String(file.diff || "");
  if (diff.includes("\0")) return false;
  if (!diff.split(/\r?\n/).filter((line) => /^(---|\+\+\+) /.test(line))
    .every((line) => ["/dev/null", `a/${filePath}`, `b/${filePath}`].includes(line.slice(4).split("\t")[0]))) return false;
  let hunk = null;
  let count = 0;
  const complete = () => !hunk || hunk.old === 0 && hunk.next === 0;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    const header = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (header) {
      if (!complete()) return false;
      hunk = { old: Number(header[1] ?? 1), next: Number(header[2] ?? 1) }; count += 1;
    } else if (hunk && !complete()) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith(" ") || line.startsWith("-")) hunk.old -= 1;
      if (line.startsWith(" ") || line.startsWith("+")) hunk.next -= 1;
      if (![" ", "-", "+"].includes(line[0]) || hunk.old < 0 || hunk.next < 0) return false;
    } else if (line.startsWith("@@") || hunk && line && !line.startsWith("\\")) return false;
  }
  return count > 0 && complete();
}

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
  if (next.has(key)) void loadFileDetail(file);
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

function cancelDetails() {
  detailRevision += 1;
  for (const read of detailReads.values()) read.abort();
  detailReads.clear();
  fileDetails.value = Object.fromEntries(Object.entries(fileDetails.value).map(([path, detail]) =>
    [path, { ...detail, detailLoading: false }]));
}
async function loadFileDetail(file) {
  if (disposed || !props.interactive || hasHistoricalFiles.value || file.detailsLoaded !== false || !nearViewport || globalThis.document?.hidden || detailReads.has(file.path)) return;
  const revision = detailRevision;
  const controller = new AbortController();
  detailReads.set(file.path, controller);
  fileDetails.value = { ...fileDetails.value, [file.path]: { detailLoading: true } };
  try {
    const result = await requestWorkspaceChanges(fileCwd.value, { paths: [file.path], signal: controller.signal });
    if (disposed || revision !== detailRevision) return;
    const detail = result.files?.find((entry) => entry.path === file.path);
    fileDetails.value = { ...fileDetails.value, [file.path]: detail
      ? { ...detail, statsKnown: detail.statsKnown ?? (Number.isFinite(detail.additions) && Number.isFinite(detail.deletions)),
        detailsLoaded: true, detailLoading: false }
      : { detailsLoaded: true, detailLoading: false, diff: "" } };
  } catch (err) {
    if (!disposed && revision === detailRevision) fileDetails.value = { ...fileDetails.value,
      [file.path]: { detailLoading: false, detailError: err?.message || String(err) } };
  } finally { if (detailReads.get(file.path) === controller) detailReads.delete(file.path); }
}
const workspaceReads = createWorkspaceChangesRefresh({
  read: requestWorkspaceChanges,
  onLoading: (value) => { loading.value = value; }, onSuspend: cancelDetails,
  onResume: () => { for (const file of files.value) if (expanded.value.has(file.path)) void loadFileDetail(file); },
  onError: (err) => { error.value = err?.message || String(err); },
  onResult: (result) => {
    cancelDetails(); fileDetails.value = {}; changes.value = result; error.value = "";
    if (writeOutcome.value !== "unknown") writeOutcome.value = "";
    else error.value = "已刷新工作区，请核对文件内容后重新打开会话。";
    for (const file of result.files || []) if (expanded.value.has(file.path)) void loadFileDetail(file);
  }
});
const loadChanges = (options) => workspaceReads.refresh(options);

function hasToggledFile(file) {
  return toggledPaths.value.has(fileKey(file));
}

async function revertFiles(paths) {
  const workspaceCwd = String(props.cwd || "").trim();
  const cwd = String(fileCwd.value || "").trim();
  const historical = hasHistoricalFiles.value;
  const selected = (Array.isArray(paths) ? paths : []).map((item) => String(item || "")).filter(Boolean);
  const version = workspaceVersion;
  const isCurrent = () => !disposed && workspaceCwd === String(props.cwd || "").trim() && version === workspaceVersion;
  if (!cwd || reverting.value || !selected.length || !canApplyAll.value) {
    return;
  }
  reverting.value = true;
  error.value = "";
  const selectedFiles = files.value.filter((file) => selected.includes(fileKey(file)));
  const direction = hasHistoricalFiles.value && selectedFiles.every((file) => hasToggledFile(file)) ? "forward" : "reverse";
  const markApplied = () => {
    if (historical !== hasHistoricalFiles.value || cwd !== String(fileCwd.value || "").trim()) return;
    toggledPaths.value = direction === "forward"
      ? new Set([...toggledPaths.value].filter((key) => !selected.includes(key)))
      : new Set([...toggledPaths.value, ...selected]);
  };
  try {
    const result = direction === "forward"
      ? await applyPatchWorkspaceChanges(cwd, selectedFiles, direction)
      : await reversePatchWorkspaceChanges(cwd, selectedFiles);
    if (!isCurrent()) return;
    workspaceReads.invalidate();
    loading.value = false;
    changes.value = result;
    markApplied();
    expanded.value = new Set([...expanded.value].filter((key) => files.value.some((file) => file.path === key)));
    emit("status", direction === "forward"
      ? (selected.length === 1 ? `已恢复 ${selected[0]}` : `已恢复 ${selected.length} 个文件`)
      : (selected.length === 1 ? `已撤销 ${selected[0]}` : `已撤销 ${selected.length} 个文件`));
  } catch (err) {
    if (!isCurrent()) return;
    workspaceReads.invalidate();
    loading.value = false;
    if (err?.executionState === "applied") {
      markApplied();
      writeOutcome.value = "applied";
      error.value = "操作已完成，状态刷新失败，请刷新确认：" + (err?.message || String(err));
    } else if (err?.executionState === "unknown") {
      writeOutcome.value = "unknown";
      error.value = "执行状态待确认，请刷新工作区后检查文件：" + (err?.message || String(err));
    } else error.value = err?.message || String(err);
  } finally {
    if (isCurrent()) reverting.value = false;
  }
}

function revertAll() {
  const targets = hasHistoricalFiles.value && !allVisibleFilesToggled.value ? files.value.filter((file) => !hasToggledFile(file)) : files.value;
  revertFiles(targets.map((file) => file.path));
}

watch(() => [props.cwd, props.interactive], () => {
  workspaceVersion += 1;
  showAllFiles.value = false;
  writeOutcome.value = "";
  reverting.value = false;
  expanded.value = new Set();
  toggledPaths.value = new Set();
});
watch(hiddenFileCount, (count) => { if (!count) showAllFiles.value = false; });

watch(
  () => `${props.cwd}:${props.interactive ? "1" : "0"}:${props.files.map((file) => fileKey(file)).join("\n")}`,
  () => {
    const paths = new Set(props.files.map(fileKey));
    expanded.value = new Set([...expanded.value].filter((key) => paths.has(key)));
    toggledPaths.value = new Set([...toggledPaths.value].filter((key) => paths.has(key)));
    loading.value = false;
    changes.value = { files: [] };
    fileDetails.value = {};
    error.value = "";
    workspaceReads.configure({ cwd: props.cwd, interactive: props.interactive });
  }, { immediate: true }
);

onMounted(() => {
  stopVisibility = observeElementVisibility(visibilityElement.value, (visible) => {
    nearViewport = visible;
    workspaceReads.setVisible(visible);
  });
});
onBeforeUnmount(() => {
  disposed = true;
  workspaceVersion += 1;
  workspaceReads.dispose();
  stopVisibility();
});
</script>

<template>
  <div ref="visibilityElement" class="workspace-changes-anchor">
  <section v-if="hasChanges || loading || error" class="workspace-changes">
    <header class="workspace-changes-head">
      <div class="workspace-changes-summary">
        <strong>{{ loading && !hasChanges ? "正在检查文件变更…" : totalLabel }}</strong>
        <div v-if="hasChanges" class="workspace-changes-stats">
          <span v-if="totalStatsKnown" class="workspace-change-stat add">+{{ totalStats.additions }}</span>
          <span v-if="totalStatsKnown" class="workspace-change-stat del">-{{ totalStats.deletions }}</span>
        </div>
      </div>
      <button
        v-if="canApplyAll"
        class="workspace-changes-action"
        type="button"
        :disabled="reverting"
        @click="revertAll"
      >
        {{ actionLabel }}
      </button>
    </header>

    <p v-if="error" class="workspace-changes-error">{{ error }}</p>
    <button v-if="writeOutcome" class="workspace-changes-refresh" type="button" title="刷新工作区状态" aria-label="刷新工作区状态" :disabled="loading || reverting" @click="loadChanges()">↻</button>

    <div v-for="file in visibleFiles" :key="file.path" class="workspace-change-file">
      <div class="workspace-change-row">
        <button class="workspace-change-main" type="button" :aria-label="`预览文件：${file.path}`"
          @click="openLocalPreview({ target: file.path, cwd: fileCwd })">
          <span class="workspace-change-name">{{ file.path }}</span>
          <span class="workspace-change-status">{{ statusLabel(file.status) }}</span>
          <span v-if="statsKnown(file)" class="workspace-change-stat add">+{{ file.additions }}</span>
          <span v-if="statsKnown(file)" class="workspace-change-stat del">-{{ file.deletions }}</span>
        </button>
        <span class="workspace-change-spacer"></span>
        <button
          class="workspace-change-icon"
          :class="{ expanded: isExpanded(file) }"
          type="button"
          :aria-label="isExpanded(file) ? '折叠文件变更' : '展开文件变更'"
          @click="toggleFile(file)"
        >
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>

      <div v-if="isExpanded(file)" class="workspace-change-diff">
        <p v-if="file.detailLoading" class="workspace-change-empty">正在读取变更…</p>
        <p v-else-if="file.detailError" class="workspace-changes-error">{{ file.detailError }}</p>
        <pre v-else-if="file.diff" class="workspace-change-code"><code>
<span
  v-for="line in formatDiffLines(file.diff)"
  :key="line.id"
  class="workspace-change-line"
  :class="line.type"
>{{ line.text || " " }}</span></code></pre>
        <p v-else class="workspace-change-empty">没有可展示的文本 diff。</p>
      </div>
    </div>

    <button
      v-if="hiddenFileCount"
      class="workspace-changes-toggle"
      type="button"
      :aria-expanded="showAllFiles"
      @click="showAllFiles = !showAllFiles"
    >
      <span>{{ showAllFiles ? "收起文件列表" : `再显示 ${hiddenFileCount} 个文件` }}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true" :class="{ expanded: showAllFiles }">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  </section>
  </div>
</template>

<style scoped>
.workspace-changes-anchor {
  min-height: 1px;
}

.workspace-changes-refresh {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin: 0 14px 8px;
  padding: 0;
  border: 1px solid #d4d8dc;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 18px;
  cursor: pointer;
}
.workspace-changes-refresh:disabled { opacity: 0.45; cursor: wait; }
</style>
