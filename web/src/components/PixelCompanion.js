import { defineComponent, h } from "vue";

// Integer geometry keeps the same little terminal legible at favicon and loading sizes.
export default defineComponent({
  name: "PixelCompanion",
  props: { mood: { type: String, default: "idle" }, size: { type: Number, default: 48 } },
  setup(props) {
    const rect = (x, y, width, height, fill, extra = {}) => h("rect", { x, y, width, height, fill, ...extra });
    return () => h("svg", { class: ["pixel-companion", `pixel-${props.mood}`], viewBox: "0 0 32 32",
      width: props.size, height: props.size, "aria-hidden": "true", focusable: "false", "shape-rendering": "crispEdges" }, [
      rect(7, 28, 18, 2, "var(--pixel-shadow, #e7e1db)", { class: "pixel-shadow" }),
      h("g", { class: "pixel-body" }, [
        h("path", { d: "M8 5h16v2h3v17h-3v2H8v-2H5V7h3z", fill: "var(--pixel-ink, #514338)" }),
        h("path", { d: "M9 7h14v2h2v13h-2v2H9v-2H7V9h2z", fill: "var(--pixel-shell, #c9b7a5)" }),
        rect(9, 9, 14, 11, "var(--pixel-screen, #fffcf8)"),
        h("g", { class: "pixel-eyes" }, [rect(11, props.mood === "error" ? 14 : 12, 2, props.mood === "waiting" ? 2 : 3, "#514338"),
          rect(19, 12, 2, 3, "#514338")]),
        rect(10, 16, 3, 1, "#d9c4b2"), rect(19, 16, 3, 1, "#d9c4b2"),
        h("path", { d: props.mood === "error" ? "M14 18h4v1h-4z" : "M14 17h1v1h2v-1h1v2h-4z", fill: "#8b7f73" }),
        rect(10, 22, 3, 1, "#8b7f73"), rect(20, 22, 2, 1, "#fffcf8"),
        rect(9, 26, 4, 2, "#514338", { class: "pixel-foot-left" }),
        rect(19, 26, 4, 2, "#514338", { class: "pixel-foot-right" })
      ]),
      props.mood === "reading" ? h("g", { class: "pixel-paper" }, [rect(23, 18, 7, 10, "#8b7f73"), rect(24, 19, 5, 8, "#fffcf8"), rect(25, 21, 3, 1, "#c9b7a5"), rect(25, 24, 2, 1, "#c9b7a5")]) : null,
      props.mood === "search" ? h("path", { d: "M24 18h5v1h1v5h-1v1h-1v2h2v2h-2v-2h-2v-2h-2v-1h-1v-5h1zm1 2v3h3v-3z", fill: "#8b7f73" }) : null
    ]);
  }
});
