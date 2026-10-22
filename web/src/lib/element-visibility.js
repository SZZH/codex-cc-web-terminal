export function observeElementVisibility(element, onChange, { rootMargin = "240px", once = false } = {}) {
  const Observer = globalThis.IntersectionObserver;
  if (!element || typeof Observer !== "function") {
    onChange(true);
    return () => {};
  }
  let active = true;
  const observer = new Observer((entries) => {
    if (!active) return;
    const entry = entries.find((value) => value.target === element);
    if (!entry) return;
    onChange(entry.isIntersecting);
    if (entry.isIntersecting && once) { active = false; observer.disconnect(); }
  }, { rootMargin });
  observer.observe(element);
  return () => { active = false; observer.disconnect(); };
}
