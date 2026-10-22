<script setup>
// Unmodified paths from Lucide 0.543.0: https://github.com/lucide-icons/lucide/tree/0.543.0/icons
// ISC / MIT notices are distributed at /licenses/lucide.txt.
defineProps({ name: { type: String, required: true } });
const paths = {
  "list-end": ["M16 5H3", "M16 12H3", "M9 19H3", "m16 16-3 3 3 3", "M21 5v12a2 2 0 0 1-2 2h-6"],
  "trash-2": ["M10 11v6", "M14 11v6", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  "corner-up-right": ["m15 14 5-5-5-5", "M4 20v-7a4 4 0 0 1 4-4h12"]
};
</script>

<template>
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">
    <path v-for="d in paths[name]" :key="d" :d="d" />
  </svg>
</template>
