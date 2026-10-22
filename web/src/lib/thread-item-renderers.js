import { isRenderableImageUrl, normalizeImageUrl } from "./image-url.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value, maxLength = 160) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function preserveBlockText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return "";
}

function normalizeKind(value) {
  return String(value || "")
    .trim()
    .replace(/[_\s-]+/g, "")
    .toLowerCase();
}

const USER_KINDS = new Set(["usermessage"]);
const PRIMARY_KINDS = new Set(["agentmessage", "plan", "imageview"]);
const PROCESS_KINDS = new Set([
  "hookprompt",
  "reasoning",
  "commandexecution",
  "filechange",
  "mcptoolcall",
  "dynamictoolcall",
  "collabagenttoolcall",
  "websearch",
  "imagegeneration",
  "enteredreviewmode",
  "exitedreviewmode",
  "contextcompaction"
]);

const DISPLAY_LABELS = {
  usermessage: "用户消息",
  hookprompt: "Hook 提示",
  agentmessage: "回复正文",
  plan: "计划",
  reasoning: "思考过程",
  commandexecution: "命令执行",
  filechange: "文件变更",
  mcptoolcall: "MCP 工具",
  dynamictoolcall: "动态工具",
  collabagenttoolcall: "子代理协作",
  subagentactivity: "子智能体",
  websearch: "网页搜索",
  imageview: "图像查看",
  imagegeneration: "图像生成",
  enteredreviewmode: "进入 Review",
  exitedreviewmode: "退出 Review",
  contextcompaction: "上下文压缩",
  unknown: "执行项"
};

const STATUS_LABELS = {
  inprogress: "执行中",
  running: "执行中",
  completed: "完成",
  success: "完成",
  succeeded: "完成",
  failed: "失败",
  aborted: "已中断",
  cancelled: "已取消",
  canceled: "已取消",
  pending: "等待中"
};

const DIAGNOSTIC_DUMP_PATTERNS = [
  /history:codex:/i,
  /threadSnapshot/i,
  /conversation\.turns/i,
  /rollout-\d{4}-\d{2}-\d{2}T/i,
  /"\s*kind\s*":\s*"UserMessage"/i,
  /"\s*kind\s*":\s*"AgentMessage"/i,
  /"\s*role\s*":\s*"assistant"/i,
  /"\s*role\s*":\s*"user"/i,
  /\/Users\/[^/\n]+\/\.codex\/sessions\//,
  /Codex 会话权限同步并改为只读展示/,
  /fatal: Unable to create '.git\/index\.lock'/i
];

const EMPTY_COMMAND_OUTPUT_PATTERNS = [
  /^bash\s+Chunk ID:\s*\S+/i,
  /^Chunk ID:\s*\S+/i,
  /^Wall time:\s*[\d.]+\s*seconds$/i,
  /^Process exited with code 0$/i,
  /^Original token count:\s*\d+$/i,
  /^Output:\s*$/i,
  /^Command:\s*.+$/i
];

export function inferThreadItemKind(item = {}) {
  if (item.type === "subAgentActivity") return "subagentactivity";
  const directKind = normalizeKind(firstDefined(item.kind, item.itemKind, item.item_type, item.type));
  if (directKind) {
    return directKind;
  }

  const variantKeys = Object.keys(item || {});
  if (variantKeys.length === 2 && variantKeys.includes("id")) {
    const variantKey = variantKeys.find((key) => key !== "id");
    return normalizeKind(variantKey);
  }

  if (variantKeys.length === 1) {
    return normalizeKind(variantKeys[0]);
  }

  return "unknown";
}

function extractVariantPayload(item = {}, kind = inferThreadItemKind(item)) {
  if (item && typeof item === "object") {
    if (item.payload && typeof item.payload === "object") {
      return item.payload;
    }
    for (const [key, value] of Object.entries(item)) {
      if (normalizeKind(key) === kind && value && typeof value === "object") {
        return value;
      }
    }
  }
  return item;
}

function getRootText(item = {}) {
  return preserveBlockText(firstDefined(item.text, item.summary, item.message, item.body, ""));
}

function normalizeStatus(value) {
  const key = normalizeKind(value);
  return key || "";
}

function humanizeStatus(value) {
  const key = normalizeStatus(value);
  return STATUS_LABELS[key] || String(value || "").trim();
}

function joinTextParts(parts = []) {
  const seen = new Set();
  return asArray(parts)
    .map((part) => {
      if (typeof part === "string") {
        return preserveBlockText(part);
      }
      if (part && typeof part === "object") {
        return preserveBlockText(
          firstDefined(part.text, part.content, part.summary, part.title, part.message, part.value)
        );
      }
      return "";
    })
    .filter(Boolean)
    .filter((part) => {
      const key = compactText(part);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .join("\n\n");
}

function extractMessageText(item = {}, payload = {}) {
  const content = asArray(payload.content);
  const contentText = content
    .map((part) => {
      const partType = normalizeKind(part?.type);
      if (partType === "outputtext" || partType === "inputtext" || !partType) {
        return firstDefined(part.text, part.value, part.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  return preserveBlockText(
    firstDefined(
      item.text,
      item.summary,
      item.message,
      item.body,
      payload.text,
      payload.message,
      payload.contentText,
      payload.body,
      payload.summary,
      contentText
    )
  );
}

function extractSummary(kind, item = {}, payload = {}) {
  if (kind === "agentmessage" || kind === "usermessage" || kind === "plan") {
    return "";
  }
  const direct = compactText(
    firstDefined(
      item.summary,
      payload.summary,
      payload.title,
      payload.label,
      payload.message,
      payload.command,
      payload.query,
      payload.url,
      payload.alt
    )
  );
  if (direct) {
    return direct;
  }
  return DISPLAY_LABELS[kind] || DISPLAY_LABELS.unknown;
}

function extractImageUrl(item = {}, payload = {}) {
  return String(
    firstDefined(
      payload.url,
      payload.image_url,
      payload.path,
      item.url,
      item.image_url,
      item.path
    )
  ).trim();
}

function collectNestedImageParts(content, bucket) {
  for (const part of asArray(content)) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const kind = normalizeKind(part.type);
    const url = String(firstDefined(part.url, part.image_url, part.path)).trim();
    if ((kind === "inputimage" || kind === "image" || kind === "outputimage" || kind === "localimage") && isRenderableImageUrl(url)) {
      bucket.push({
        url,
        alt: String(firstDefined(part.alt, part.name, "image")).trim() || "image"
      });
    }
    if (Array.isArray(part.content)) {
      collectNestedImageParts(part.content, bucket);
    }
  }
}

function extractImageItems(item = {}, payload = {}) {
  const images = [];
  const pushImage = (url, alt = "image") => {
    const resolved = normalizeImageUrl(url);
    if (!isRenderableImageUrl(resolved)) {
      return;
    }
    images.push({
      url: resolved,
      alt: String(alt || "image").trim() || "image"
    });
  };

  const directUrl = extractImageUrl(item, payload);
  if (directUrl) {
    pushImage(directUrl, extractImageAlt(item, payload));
  }

  for (const image of asArray(payload.images)) {
    if (typeof image === "string") {
      pushImage(image);
    } else if (image && typeof image === "object") {
      pushImage(image.url || image.image_url || image.path, image.alt || image.name);
    }
  }

  for (const image of asArray(payload.local_images)) {
    if (typeof image === "string") {
      pushImage(image);
    } else if (image && typeof image === "object") {
      pushImage(image.path || image.url || image.image_url, image.alt || image.name);
    }
  }

  collectNestedImageParts(payload.content, images);
  if (payload.message?.role === "user") {
    collectNestedImageParts(payload.message?.content, images);
  }

  const seen = new Set();
  return images.filter((image) => {
    if (!image.url || seen.has(image.url)) {
      return false;
    }
    seen.add(image.url);
    return true;
  });
}

function extractImageAlt(item = {}, payload = {}) {
  return String(
    firstDefined(
      payload.alt,
      payload.name,
      item.alt,
      item.name,
      DISPLAY_LABELS[inferThreadItemKind(item)] || "image"
    )
  ).trim();
}

function buildBody(kind, item = {}, payload = {}) {
  if (kind === "imageview" || kind === "imagegeneration") {
    return "";
  }
  if (kind === "agentmessage" || kind === "usermessage" || kind === "plan") {
    return extractMessageText(item, payload);
  }
  if (kind === "reasoning") {
    return joinTextParts([
      item.text,
      payload.content,
      payload.text,
      payload.details,
      asArray(payload.summary).join("\n"),
      asArray(payload.content).join("\n")
    ]);
  }
  if (kind === "contextcompaction") {
    return preserveBlockText(firstDefined(item.text, item.summary, payload.summary, payload.message, payload.note));
  }
  return joinTextParts([
    item.text,
    payload.output,
    payload.result,
    payload.text,
    payload.message,
    payload.details
  ]);
}

function detectDiagnosticDump(kind, body = "", summary = "") {
  if (kind !== "commandexecution" && kind !== "dynamictoolcall" && kind !== "mcptoolcall") {
    return false;
  }
  const text = `${String(summary || "").trim()}\n${String(body || "").trim()}`.trim();
  if (!text) {
    return false;
  }
  const lineCount = text.split(/\r?\n/).length;
  return lineCount >= 8 && DIAGNOSTIC_DUMP_PATTERNS.some((pattern) => pattern.test(text));
}

function buildDiagnosticSummary(body = "", summary = "") {
  const compactBody = compactText(body);
  if (/git commit/i.test(body) && /\.git\/index\.lock/i.test(body)) {
    return "Git 提交失败调试输出";
  }
  if (/history:codex:/i.test(body) || /threadSnapshot/i.test(body) || /conversation\.turns/i.test(body)) {
    return "会话历史调试输出";
  }
  return truncateText(summary || compactBody || "调试输出", 48);
}

function isSuccessfulStatus(status = "") {
  const key = normalizeStatus(status);
  return !key || ["completed", "success", "succeeded"].includes(key);
}

function isZeroExitCode(value) {
  return value === undefined || value === null || value === "" || Number(value) === 0;
}

function hasOnlyEmptyCommandMetadata(body = "") {
  const lines = String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return true;
  }
  return lines.every((line) => EMPTY_COMMAND_OUTPUT_PATTERNS.some((pattern) => pattern.test(line)));
}

function detectNoisyProcessItem(kind, status, body = "", payload = {}) {
  if (kind !== "commandexecution") {
    return false;
  }
  if (!isSuccessfulStatus(status) || !isZeroExitCode(payload?.exitCode ?? payload?.exit_code)) {
    return false;
  }
  return hasOnlyEmptyCommandMetadata(body);
}

export function getThreadItemCategory(item = {}) {
  const kind = inferThreadItemKind(item);
  if (kind === "subagentactivity" || kind === "collabagenttoolcall" && (item.activity || item.payload?.activity)) return "activity";
  if (USER_KINDS.has(kind)) {
    return "user";
  }
  if (PRIMARY_KINDS.has(kind)) {
    return "primary";
  }
  if (PROCESS_KINDS.has(kind)) {
    return "process";
  }
  return "process";
}

export function normalizeThreadItem(item = {}, options = {}) {
  const kind = inferThreadItemKind(item);
  const payload = extractVariantPayload(item, kind);
  const status = normalizeStatus(firstDefined(item.status, payload?.status));
  const category = getThreadItemCategory(item);
  const body = buildBody(kind, item, payload);
  const summary = extractSummary(kind, item, payload);
  const isDiagnosticDump = detectDiagnosticDump(kind, body, summary);
  const isNoisyProcess = detectNoisyProcessItem(kind, status, body, payload);
  const imageItems = extractImageItems(item, payload);
  const imageUrl = imageItems[0]?.url || "";
  const imageAlt = imageItems[0]?.alt || extractImageAlt(item, payload);
  const questionSource = item.question || payload.question;
  const question = kind === "agentmessage" && questionSource?.source === "desktop" &&
    Array.isArray(questionSource.questions) && questionSource.questions.length ? questionSource : null;

  return {
    id: String(firstDefined(item.id, payload?.id, `${kind}-${Math.random().toString(36).slice(2, 10)}`)),
    raw: item,
    kind,
    category,
    label: DISPLAY_LABELS[kind] || DISPLAY_LABELS.unknown,
    status,
    statusLabel: humanizeStatus(status),
    title: DISPLAY_LABELS[kind] || DISPLAY_LABELS.unknown,
    summary: isDiagnosticDump
      ? buildDiagnosticSummary(body, summary)
      : compactText(summary) === compactText(body)
        ? ""
        : summary,
    body: question ? "" : body,
    imageUrl,
    imageAlt,
    imageItems,
    activity: item.activity || payload.activity || item.presentation?.activity || null,
    question,
    questionReplies: category === "user" && Array.isArray(item.questionReplies) ? item.questionReplies : null,
    details: [],
    timestamp: firstDefined(item.timestamp, item.ts, payload?.timestamp, payload?.ts, ""),
    isUnknown: kind === "unknown",
    isDiagnosticDump,
    isNoisyProcess,
    isLiveOverlay: Boolean(options.isLiveOverlay || item.isLiveOverlay),
    speakerName:
      category === "user"
        ? ""
        : firstDefined(payload?.speakerName, payload?.role === "assistant" ? options.assistantName : "", "")
  };
}

export function summarizeProcessItems(items = []) {
  const counts = {
    total: 0,
    reasoning: 0,
    command: 0,
    fileChange: 0,
    tool: 0,
    collab: 0,
    other: 0,
    diagnosticDump: 0,
    noisyCommand: 0
  };

  for (const item of items) {
    counts.total += 1;
    const kind = inferThreadItemKind(item);
    if (item?.isNoisyProcess && kind === "commandexecution") {
      counts.noisyCommand += 1;
    } else if (item?.isDiagnosticDump) {
      counts.diagnosticDump += 1;
    } else if (kind === "reasoning") {
      counts.reasoning += 1;
    } else if (kind === "commandexecution") {
      counts.command += 1;
    } else if (kind === "filechange") {
      counts.fileChange += 1;
    } else if (kind === "mcptoolcall" || kind === "dynamictoolcall" || kind === "websearch") {
      counts.tool += 1;
    } else if (kind === "collabagenttoolcall") {
      counts.collab += 1;
    } else {
      counts.other += 1;
    }
  }

  const parts = [];
  if (counts.reasoning) parts.push(`思考 ${counts.reasoning}`);
  if (counts.command) parts.push(`命令 ${counts.command}`);
  if (counts.fileChange) parts.push(`文件 ${counts.fileChange}`);
  if (counts.tool) parts.push(`工具 ${counts.tool}`);
  if (counts.collab) parts.push(`子代理 ${counts.collab}`);
  if (counts.diagnosticDump) parts.push(`调试输出 ${counts.diagnosticDump}`);
  if (counts.noisyCommand) parts.push(`已略过空命令 ${counts.noisyCommand}`);
  if (counts.other) parts.push(`其他 ${counts.other}`);

  const reads = new Set();
  const changedFiles = new Set();
  let commands = 0;
  for (const item of items) {
    if (inferThreadItemKind(item) === "filechange") {
      const changes = item.raw?.payload?.changes || item.raw?.changes || {};
      for (const name of Array.isArray(changes) ? changes.map((change) => change.path).filter(Boolean) : Object.keys(changes)) changedFiles.add(name);
    }
    if (inferThreadItemKind(item) !== "commandexecution") continue;
    const actions = asArray(item.raw?.payload?.commandActions || item.raw?.commandActions);
    const readActions = actions.filter((action) => action.type === "read");
    for (const action of readActions) reads.add(action.path || action.filename || action.command || item.id);
    if (!actions.length || actions.some((action) => action.type !== "read")) commands += 1;
  }
  const compact = [];
  if (reads.size) compact.push(`读取了 ${reads.size} 个文件`);
  if (commands) compact.push(`运行了 ${commands} 条命令`);
  if (counts.tool) compact.push(`调用了 ${counts.tool} 个工具`);
  if (counts.fileChange) compact.push(changedFiles.size ? `修改了 ${changedFiles.size} 个文件` : "更新了文件");
  if (counts.collab) compact.push(`协作了 ${counts.collab} 次`);
  if (!compact.length) compact.push(counts.reasoning ? "思考过程" : "执行记录");
  return {
    ...counts,
    compactLabel: compact.join(" · "),
    running: items.some((item) => ["inprogress", "running", "pending"].includes(item.status)),
    label: parts.length ? `执行过程 ${counts.total} 项 · ${parts.join(" · ")}` : `执行过程 ${counts.total} 项`
  };
}
