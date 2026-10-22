const OPEN_PATH = "/api/previews/open";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

function decodePath(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function localPreviewTarget(value, cwd = "") {
  const source = String(value || "").trim();
  if (!source || /[\u0000-\u001f\u007f]/.test(source) || /^[#?]/.test(source)) return null;
  if (/^file:/i.test(source)) {
    try {
      const file = new URL(source);
      if (file.protocol !== "file:" || (file.hostname && file.hostname !== "localhost")) return null;
      const pathname = decodePath(file.pathname);
      return { target: /^\/[a-z]:[\\/]/i.test(pathname) ? pathname.slice(1) : pathname, ...(cwd ? { cwd } : {}) };
    } catch { return null; }
  }
  let service = source.replace(/^(https?:\/\/)\%5B([^/]+)\%5D(?=[:/]|$)/i, "$1[$2]");
  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+(?:[/?#]|$)/i.test(service)) service = `http://${service}`;
  if (/^(?:https?:)?\/\//i.test(service)) {
    try {
      const url = new URL(service.startsWith("//") ? `http:${service}` : service);
      if (!LOCAL_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) return null;
      return { target: service.startsWith("//") ? `http:${service}` : service, ...(cwd ? { cwd } : {}) };
    } catch { return null; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) return null;
  if (source.startsWith(OPEN_PATH)) return null;
  return { target: source, ...(cwd ? { cwd } : {}) };
}

export function previewOpenHref({ target, cwd = "" }) {
  return `${OPEN_PATH}?${new URLSearchParams({ target, ...(cwd ? { cwd } : {}) })}`;
}

export function previewTargetFromHref(href) {
  if (!String(href || "").startsWith(`${OPEN_PATH}?`)) return null;
  const params = new URL(href, "https://preview.invalid").searchParams;
  return localPreviewTarget(params.get("target"), params.get("cwd") || "");
}

// Markdown permits angle-bracket destinations with spaces. Accept unwrapped
// local paths too, without changing quoted link titles or code blocks.
function configureLocalDestinations(markdown) {
  const parseDestination = markdown.helpers.parseLinkDestination;
  markdown.helpers = { ...markdown.helpers, parseLinkDestination(source, start, max) {
    const original = parseDestination(source, start, max);
    if (source[start] === "<") return original;
    let depth = 0, end = start;
    for (; end < max; end += 1) {
      const char = source[end];
      if (char === "\n" || char === "\r") return original;
      if (char === "\\") { end += 1; continue; }
      if (char === "(") depth += 1;
      if (char === ")") { if (!depth) break; depth -= 1; }
    }
    const candidate = source.slice(start, end).trim();
    if (end >= max || !/\s/.test(candidate) || /["']/.test(candidate) || !localPreviewTarget(candidate)) return original;
    return { ok: true, pos: end, lines: 0, str: candidate.replace(/\\([()])/g, "$1") };
  } };
}

export function configureMarkdownLinks(markdown, { getCwd = () => "" } = {}) {
  configureLocalDestinations(markdown);
  const validateLink = markdown.validateLink.bind(markdown);
  markdown.validateLink = (url) => /^file:/i.test(url) ? Boolean(localPreviewTarget(url)) : validateLink(url);
  const renderLink = markdown.renderer.rules.link_open || ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options));
  markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const href = token.attrGet("href");
    const preview = localPreviewTarget(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href || "") ? href : decodePath(href || ""), getCwd());
    if (preview) {
      token.attrSet("href", previewOpenHref(preview));
      token.attrJoin("class", "local-preview-link");
    }
    return renderLink(tokens, index, options, env, renderer);
  };
  return markdown;
}

export function handleLocalPreviewLink(event, openPreview) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
    (event.type === "click" && event.button != null && event.button !== 0) ||
    (event.type === "keydown" && event.key !== "Enter")) return false;
  const anchor = event.target?.closest?.("a[href]");
  if (!anchor || !event.currentTarget?.contains(anchor)) return false;
  const target = previewTargetFromHref(anchor.getAttribute("href"));
  if (!target) return false;
  event.preventDefault(); event.stopPropagation();
  void openPreview(target);
  return true;
}
