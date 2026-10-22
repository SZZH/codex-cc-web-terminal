import { defineComponent, h, onBeforeUnmount, ref, watch } from "vue";
import PixelCompanion from "./PixelCompanion.js";

export default defineComponent({
  name: "InterfaceState",
  props: {
    title: { type: String, default: "正在加载…" }, detail: { type: String, default: "" },
    kind: { type: String, default: "loading" }, layout: { type: String, default: "center" },
    mood: { type: String, default: "" }, actionLabel: { type: String, default: "" }, disabled: Boolean
  },
  emits: ["action"],
  setup(props, { emit, slots }) {
    const slow = ref(false);
    let timer;
    watch(() => [props.kind, props.title], () => {
      clearTimeout(timer); slow.value = false;
      if (props.kind === "loading") {
        timer = setTimeout(() => { slow.value = true; }, 8000);
        timer.unref?.();
      }
    }, { immediate: true });
    onBeforeUnmount(() => clearTimeout(timer));
    return () => h("div", { class: ["interface-state", `state-${props.kind}`, `state-${props.layout}`],
      role: props.kind === "error" ? "alert" : "status", "aria-live": "polite", "aria-busy": props.kind === "loading" || undefined }, [
      h("div", { class: "state-intro" }, [
        h(PixelCompanion, { mood: props.mood || (props.kind === "loading" ? props.layout === "messages" ? "reading" : "loading" : props.kind === "error" ? "error" : "idle"), size: props.layout === "inline" ? 28 : 64 }),
        h("div", { class: "state-copy" }, [h("p", { class: "state-title" }, props.title),
          props.detail || slow.value ? h("p", { class: "state-detail" }, props.detail || "读取时间比平时稍长，仍在等待响应。") : null])
      ]),
      props.kind === "loading" && ["list", "messages"].includes(props.layout)
        ? h("div", { class: "state-skeletons", "aria-hidden": "true" }, Array.from({ length: props.layout === "list" ? 4 : 3 }, (_, index) =>
          h("div", { class: "state-skeleton", key: index }, [h("span"), h("span")]))) : null,
      props.actionLabel ? h("button", { class: "state-action", type: "button", disabled: props.disabled, onClick: () => emit("action") }, props.actionLabel) : null,
      slots.default?.()
    ]);
  }
});
