<script setup>
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const props = defineProps({
  item: { type: Object, required: true },
  assistantName: { type: String, default: "Codex" }
});

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true
});

const shouldRenderMarkdown = computed(() => props.item?.category === "primary");

const renderedBody = computed(() => {
  const body = String(props.item?.body || "").trim();
  if (!body) {
    return "";
  }
  if (!shouldRenderMarkdown.value) {
    return "";
  }
  return DOMPurify.sanitize(md.render(body), {
    ALLOWED_TAGS: [
      "p",
      "br",
      "pre",
      "code",
      "blockquote",
      "ul",
      "ol",
      "li",
      "a",
      "strong",
      "em",
      "del",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "img",
      "span"
    ],
    ALLOWED_ATTR: ["href", "target", "rel", "class", "src", "alt", "title"]
  }).trim();
});

const itemClasses = computed(() => [
  "thread-item-card",
  `thread-item-${props.item?.category || "process"}`,
  `thread-item-kind-${props.item?.kind || "unknown"}`,
  {
    "is-live-overlay": Boolean(props.item?.isLiveOverlay),
    "is-unknown-item": Boolean(props.item?.isUnknown)
  }
]);

</script>

<template>
  <article :class="itemClasses">
    <div
      v-if="renderedBody"
      class="thread-item-body markdown-body"
      v-html="renderedBody"
    ></div>
    <pre
      v-else-if="item.body"
      class="thread-item-body plain-body"
    >{{ item.body }}</pre>
  </article>
</template>
