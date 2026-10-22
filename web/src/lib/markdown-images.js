import { normalizeImageUrl } from "./image-url.js";

export function configureMarkdownImages(markdown) {
  const validateLink = markdown.validateLink.bind(markdown);
  markdown.validateLink = (url) => /^file:\/\//i.test(url) || validateLink(url);
  const renderImage = markdown.renderer.rules.image;
  markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const original = String(token.attrGet("src") || "");
    let decoded = original;
    try {
      decoded = decodeURI(original);
    } catch {
      // Keep malformed percent escapes literal rather than dropping the message.
    }
    const url = normalizeImageUrl(decoded);
    if (!url) {
      return markdown.utils.escapeHtml(token.content || "image");
    }
    token.attrSet("src", url);
    token.attrSet("class", "markdown-image");
    token.attrSet("role", "button");
    token.attrSet("tabindex", "0");
    token.attrSet("loading", "lazy");
    token.attrSet("decoding", "async");
    return renderImage(tokens, index, options, env, renderer);
  };
  return markdown;
}
