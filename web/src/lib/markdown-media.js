import { mediaType } from "../../../src/preview/media.js";
import { localPreviewTarget, previewOpenHref } from "./markdown-links.js";

export function mediaSource(value, cwd = "", title = "") {
  let source = String(value || "").trim();
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(source)) {
    try { source = decodeURIComponent(source); } catch { return null; }
  }
  const type = mediaType(source);
  if (!type) return null;
  const local = localPreviewTarget(source, cwd);
  // Local web services have their own isolated preview; they are not file grants.
  if (local && !/^https?:/i.test(local.target)) {
    return { ...type, ...local, title: title || source.split(/[\\/]/).at(-1), href: previewOpenHref(local), key: JSON.stringify([local.target, local.cwd || ""]) };
  }
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || local) return null;
    return { ...type, url: url.href, title: title || decodeURIComponent(url.pathname.split('/').at(-1)), href: url.href, key: url.href };
  } catch { return null; }
}

export function configureMarkdownMedia(markdown, { getCwd = () => "" } = {}) {
  const renderImage = markdown.renderer.rules.image;
  markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const source = mediaSource(token.attrGet("src"), getCwd(), token.content);
    if (!source) return renderImage(tokens, index, options, env, renderer);
    if (Array.isArray(env.media)) {
      if (!env.media.some((entry) => entry.key === source.key)) env.media.push(source);
      return "";
    }
    return `<a href="${markdown.utils.escapeHtml(source.href)}">${markdown.utils.escapeHtml(source.title || '播放媒体')}</a>`;
  };
}
