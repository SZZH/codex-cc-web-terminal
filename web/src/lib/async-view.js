import { defineAsyncComponent, defineComponent, h, onBeforeUnmount } from "vue";
import InterfaceState from "../components/InterfaceState.js";

const viewLoaders = new WeakMap();

const ViewLoading = defineComponent({
  setup() {
    return () => h("section", { class: "mobile-shell centered-shell" }, h(InterfaceState, { title: "正在加载页面…" }));
  }
});

const ViewLoadError = defineComponent({
  props: ["error"],
  setup() {
    return () => h("section", { class: "mobile-shell centered-shell" }, [
      h(InterfaceState, { kind: "error", title: "页面加载失败", detail: "请重新加载后再试。", actionLabel: "重新加载", onAction: () => window.location.reload() })
    ]);
  }
});

export function recoverViewChunk(error, environment = globalThis) {
  if (!/Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk .* failed|Unable to preload CSS for /i.test(String(error?.message || error))) {
    return false;
  }
  const browser = environment.window;
  if (!browser?.location?.reload) return false;
  try {
    const key = "codex-web-terminal.chunk-reload-at";
    const previous = Number(browser.sessionStorage.getItem(key) || 0);
    const now = Date.now();
    if (previous && now - previous < 30_000) return false;
    browser.sessionStorage.setItem(key, String(now));
    browser.location.reload();
    return true;
  } catch {
    return false;
  }
}

export function defineAppView(loader, { getGeneration = () => null, dependsOn = [] } = {}) {
  const dependencies = dependsOn.map((view) => {
    const load = viewLoaders.get(view);
    if (!load) throw new TypeError("App view dependencies must be created with defineAppView");
    return load;
  });
  let sharedLoad;
  // Retain failures: Vite may otherwise skip a CSS dependency that failed to preload.
  const load = () => {
    if (!sharedLoad) {
      // Register shared resources first, then start the independent import without waiting.
      const required = dependencies.map((loadDependency) => loadDependency());
      const imported = Promise.resolve().then(loader);
      sharedLoad = Promise.all([...required, imported]).then((modules) => modules[modules.length - 1]);
    }
    return sharedLoad;
  };
  const View = defineComponent({
    name: "AppView",
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      const generation = getGeneration();
      let active = true;
      onBeforeUnmount(() => { active = false; });
      const component = defineAsyncComponent({
        loader: load,
        loadingComponent: ViewLoading,
        delay: 0,
        errorComponent: ViewLoadError,
        onError(error, _retry, fail) {
          if (!active || generation !== getGeneration() || !recoverViewChunk(error)) fail(error);
        }
      });
      return () => h(component, attrs, slots);
    }
  });
  viewLoaders.set(View, load);
  View.preload = () => load().then(() => true, () => false);
  return View;
}
