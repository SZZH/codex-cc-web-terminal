import MarkdownIt from "markdown-it";
import { codeHighlighter } from "./code-highlighting.js";
import { configureMarkdownImages } from "./markdown-images.js";
import { configureMarkdownLinks } from "./markdown-links.js";
import { configureMarkdownMedia } from "./markdown-media.js";

const MAX_FENCE_ENTRIES = 8;
const MAX_FENCE_STRING_BYTES = 256 * 1024;

function normalizeLanguageTag(lang) {
  const key = String(lang || "").trim().toLowerCase();
  if (!key) return "";
  if (["sh", "shell", "zsh", "console", "env"].includes(key)) return "bash";
  if (["plain", "text"].includes(key)) return "plaintext";
  return key;
}

function classifyLanguageFamily(language) {
  const key = String(language || "").toLowerCase();
  if (!key) return "plain";
  if (["sql", "postgresql", "mysql", "plsql"].includes(key)) return "sql";
  if (["bash", "shell", "zsh", "powershell", "pwsh", "fish", "sh"].includes(key)) return "shell";
  if (["javascript", "typescript", "tsx", "jsx", "json", "yaml", "toml", "ini", "xml", "html", "css", "scss", "less", "dockerfile", "nginx", "markdown"].includes(key)) return "config";
  return "code";
}

function renderUncachedCodeFence(sourceText, languageTag = "", hljs) {
  const normalizedLanguage = normalizeLanguageTag(languageTag);
  let highlighted = "";
  let resolvedLanguage = "";
  if (!hljs) {
    resolvedLanguage = /^[a-z0-9][a-z0-9_+-]{0,63}$/.test(normalizedLanguage) ? normalizedLanguage : "plaintext";
    highlighted = sourceText.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]);
  } else if (normalizedLanguage && hljs.getLanguage(normalizedLanguage)) {
    highlighted = hljs.highlight(sourceText, {
      language: normalizedLanguage,
      ignoreIllegals: true
    }).value;
    resolvedLanguage = normalizedLanguage;
  } else {
    const auto = hljs.highlightAuto(sourceText);
    highlighted = auto.value;
    resolvedLanguage = String(auto.language || "plaintext").toLowerCase();
  }
  const family = classifyLanguageFamily(resolvedLanguage);
  const languageLabel = resolvedLanguage === "plaintext" ? "text" : resolvedLanguage;
  return [
    `<pre class="code-block language-${resolvedLanguage} family-${family}">`,
    `<span class="code-lang">${languageLabel}</span>`,
    `<span class="code-scroll"><code class="hljs language-${resolvedLanguage}">${highlighted}</code></span>`,
    "</pre>"
  ].join("");
}

export function createThreadItemMarkdown({ getCwd = () => "", highlighter = codeHighlighter, onHighlightReady = () => {} } = {}) {
  const fences = [];
  let retainedStringBytes = 0;
  let cachedHighlighter = null, pendingFences = false;
  function clearFenceCache() {
    fences.length = 0;
    retainedStringBytes = 0;
  }
  function renderCodeFence(sourceText, languageTag = "") {
    // Read before the cache lookup so only computed renderers containing code track readiness.
    const hljs = highlighter.get();
    if (hljs !== cachedHighlighter) {
      clearFenceCache();
      cachedHighlighter = hljs;
      if (pendingFences) { pendingFences = false; onHighlightReady(); }
    }
    if (!hljs) { pendingFences = true; void highlighter.load(); }
    const cached = fences.find((entry) => entry.source === sourceText && entry.language === languageTag);
    if (cached) return cached.html;
    const html = renderUncachedCodeFence(sourceText, languageTag, hljs);
    // Bound retained UTF-16 source/language/HTML strings; at most eight small entry objects remain outside this budget.
    const bytes = 2 * (sourceText.length + String(languageTag || "").length + html.length);
    if (bytes <= MAX_FENCE_STRING_BYTES) {
      while (fences.length >= MAX_FENCE_ENTRIES || retainedStringBytes + bytes > MAX_FENCE_STRING_BYTES) {
        retainedStringBytes -= fences.shift().bytes;
      }
      fences.push({ source: sourceText, language: languageTag, html, bytes });
      retainedStringBytes += bytes;
    }
    return html;
  }
  let md;
  function renderMarkdown(body, env = {}) {
    if (!md) {
      md = new MarkdownIt({
        html: false,
        breaks: true,
        linkify: true,
        typographer: true,
        highlight(code, language) {
          return renderCodeFence(String(code || ""), language);
        }
      });
      md.renderer.rules.table_open = (tokens, index, options, _env, renderer) =>
        `<div class="markdown-table-scroll" role="region" aria-label="表格" tabindex="0">\n${renderer.renderToken(tokens, index, options)}`;
      md.renderer.rules.table_close = (tokens, index, options, _env, renderer) =>
        `${renderer.renderToken(tokens, index, options)}</div>\n`;
      configureMarkdownImages(md);
      configureMarkdownLinks(md, { getCwd });
      configureMarkdownMedia(md, { getCwd });
    }
    const html = md.render(body, env);
    return env.media?.length ? html.replace(/<p>\s*<\/p>/g, "") : html;
  }
  return { renderMarkdown, renderCodeFence, clearFenceCache };
}
