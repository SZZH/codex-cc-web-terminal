const MEDIA_TYPES = {
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], mov: ["video", "video/quicktime"],
  webm: ["video", "video/webm"], ogv: ["video", "video/ogg"],
  mp3: ["audio", "audio/mpeg"], m4a: ["audio", "audio/mp4"], aac: ["audio", "audio/aac"],
  wav: ["audio", "audio/wav"], ogg: ["audio", "audio/ogg"], oga: ["audio", "audio/ogg"],
  opus: ["audio", "audio/ogg"], flac: ["audio", "audio/flac"]
};

/** Container identification only; browser support also depends on the codecs inside. */
export function mediaType(filename) {
  let source = String(filename || "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    try { source = decodeURIComponent(new URL(source).pathname); } catch { return null; }
  }
  const extension = /\.([a-z0-9]+)$/i.exec(source)?.[1].toLowerCase();
  const type = Object.hasOwn(MEDIA_TYPES, extension) ? MEDIA_TYPES[extension] : null;
  return type ? { kind: type[0], contentType: type[1] } : null;
}
