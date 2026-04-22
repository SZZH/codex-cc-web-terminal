function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
const PRIMARY_KINDS = new Set(["agentmessage", "plan"]);
const PROCESS_KINDS = new Set([
  "hookprompt",
  "reasoning",
  "commandexecution",
  "filechange",
  "mcptoolcall",
  "dynamictoolcall",
  "collabagenttoolcall",
  "websearch",
  "imageview",
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

export function inferThreadItemKind(item = {}) {
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

function buildBody(kind, item = {}, payload = {}) {
  if (kind === "agentmessage" || kind === "usermessage" || kind === "plan") {
    return extractMessageText(item, payload);
  }
  if (kind === "reasoning") {
    return joinTextParts([
      item.text,
      item.summary,
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
    item.summary !== item.text ? item.summary : "",
    payload.output,
    payload.result,
    payload.text,
    payload.message,
    payload.details
  ]);
}

export function getThreadItemCategory(item = {}) {
  const kind = inferThreadItemKind(item);
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

  return {
    id: String(firstDefined(item.id, payload?.id, `${kind}-${Math.random().toString(36).slice(2, 10)}`)),
    raw: item,
    kind,
    category,
    label: DISPLAY_LABELS[kind] || DISPLAY_LABELS.unknown,
    status,
    statusLabel: humanizeStatus(status),
    summary,
    body,
    details: [],
    timestamp: firstDefined(item.timestamp, item.ts, payload?.timestamp, payload?.ts, ""),
    isUnknown: kind === "unknown",
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
    other: 0
  };

  for (const item of items) {
    counts.total += 1;
    const kind = inferThreadItemKind(item);
    if (kind === "reasoning") {
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
  if (counts.other) parts.push(`其他 ${counts.other}`);

  return {
    ...counts,
    label: parts.length ? `执行过程 ${counts.total} 项 · ${parts.join(" · ")}` : `执行过程 ${counts.total} 项`
  };
}
