import { shallowRef } from "vue";

export function createCodeHighlighter(loadModule = () => import("highlight.js/lib/common")) {
  const implementation = shallowRef(null);
  let pending;
  return {
    get: () => implementation.value,
    load() {
      // A failed optional chunk leaves readable code and does not retry on every streamed token.
      pending ||= Promise.resolve().then(loadModule).then((module) => {
        implementation.value = module.default || module;
        return implementation.value;
      }).catch(() => null);
      return pending;
    }
  };
}

export const codeHighlighter = createCodeHighlighter();

export function preserveCodeScroll(element, afterRender) {
  const positions = [...(element?.querySelectorAll?.(".code-scroll") || [])]
    .map((node) => ({ left: node.scrollLeft, top: node.scrollTop, text: node.textContent }));
  if (!positions.some(({ left, top }) => left || top)) return;
  afterRender(() => {
    if (element?.isConnected === false) return;
    const nodes = element?.querySelectorAll?.(".code-scroll") || [];
    positions.forEach(({ left, top, text }, index) => {
      const node = nodes[index];
      if (node && node.textContent === text) { node.scrollLeft = left; node.scrollTop = top; }
    });
  });
}
