function encodeFilePath(pathname) {
  const params = new URLSearchParams();
  params.set("path", pathname);
  return `/api/local-file-image?${params.toString()}`;
}

export function normalizeImageUrl(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }

  if (
    /^data:image\//i.test(value) ||
    /^https?:\/\//i.test(value) ||
    /^blob:/i.test(value) ||
    value.startsWith("/uploads/") ||
    value.startsWith("/api/")
  ) {
    return value;
  }

  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return encodeFilePath(decodeURIComponent(url.pathname || ""));
    } catch {
      return "";
    }
  }

  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) {
    return encodeFilePath(value);
  }

  return "";
}

export function isRenderableImageUrl(input) {
  return Boolean(normalizeImageUrl(input));
}
