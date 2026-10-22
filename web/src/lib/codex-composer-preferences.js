import { normalizeComposerSettingsPatch } from "./composer.js";

const FIELDS = ["model", "reasoningEffort", "permissionMode"];
const select = (value) => Object.fromEntries(FIELDS.filter((key) => typeof value?.[key] === "string")
  .map((key) => [key, value[key]]));

// Composer choices are drafts. Reading or changing them must never mutate the
// desktop thread or an already submitted message, including queued messages.
export function createCodexComposerPreferences({ threadId, storage, getOptions, getModels, apply }) {
  const key = `codex-composer-preferences:${threadId}`;
  let overrides = {};
  try { overrides = select(JSON.parse(storage?.getItem(key) || "null")); } catch { /* Keep server defaults if the saved draft is unreadable. */ }
  return {
    restore() { apply({ ...overrides }); },
    change(patch) {
      const next = select(normalizeComposerSettingsPatch(select(patch), getOptions(), getModels()));
      const saved = { ...overrides, ...next };
      // Save before showing the choice; a storage failure must not look applied.
      if (!storage) throw new Error("浏览器无法保存输入设置，请检查存储权限后重试。");
      storage.setItem(key, JSON.stringify(saved));
      overrides = saved;
      apply(next);
    },
    snapshot() { return { ...overrides }; }
  };
}
