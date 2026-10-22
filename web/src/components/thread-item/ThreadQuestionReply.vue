<script setup>
defineProps({ replies: { type: Array, required: true } });
</script>

<template>
  <div class="thread-question-replies">
    <div v-for="(reply, index) in replies" :key="`${reply.questionItemId}-${index}`" class="thread-question-reply">
      <blockquote>{{ reply.question }}</blockquote>
      <p>{{ reply.answer || '已跳过' }}</p>
    </div>
  </div>
</template>

<style scoped>
.thread-question-replies { display: grid; gap: 14px; min-width: 0; font-size: 14px; }
.thread-question-reply { min-width: 0; }
blockquote { margin: 0 0 5px; color: #6f655c; font-size: .92em; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
p { margin: 0; color: inherit; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
