(() => {
  const initialize = () => {
    const markdown = document.getElementById("markdown");
    if (!markdown) return;
    let source;
    try {
      const encoded = new URL(location.href).searchParams.get("url");
      source = new URL(atob(encoded));
      source.protocol = location.protocol; source.host = location.host;
    } catch { return; }
    const filename = decodeURIComponent(source.pathname.split("/").at(-1)).replace(/^[a-zA-Z0-9_-]{32}--/, "");
    document.title = filename;
    const heading = document.querySelector(".panel-title a");
    if (heading) heading.textContent = filename;
    const style = document.createElement("style");
    style.textContent = `
      .panel-title{overflow-wrap:anywhere}
      #markdown{font:16px/1.7 system-ui;overflow-wrap:anywhere;letter-spacing:0}
      #markdown h1{font-size:26px}#markdown h2{font-size:22px}#markdown h3{font-size:18px}
      #markdown table{display:block;max-width:100%;overflow:auto}
      @media(max-width:959px){#directory{display:none!important}.main-container{height:100dvh!important;padding:0!important}.content-container{width:100%;min-width:0}.panel-body{padding:16px!important}}
    `;
    document.head.append(style);
    const update = () => {
      for (const image of markdown.querySelectorAll("img[src]")) {
        const original = image.getAttribute("src");
        if (!original || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(original)) continue;
        image.setAttribute("src", new URL(original, source).href);
      }
    };
    new MutationObserver(update).observe(markdown, { childList: true, subtree: true });
    update();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
