<script setup>
import { computed } from "vue";

const props = defineProps({
  loading: Boolean,
  statusText: { type: String, default: "" },
  modelValue: { type: String, default: "" },
  rememberToken: { type: Boolean, default: true }
});

const emit = defineEmits(["update:modelValue", "update:rememberToken", "submit"]);

const accessTokenModel = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value)
});

const rememberTokenModel = computed({
  get: () => props.rememberToken,
  set: (value) => emit("update:rememberToken", value)
});
</script>

<template>
  <section class="login-view">
    <div class="login-card">
      <p class="login-kicker">Codex</p>
      <h1>登录</h1>
      <form @submit.prevent="emit('submit')">
      <label class="field">
        <span>Access Token</span>
        <input
          v-model="accessTokenModel"
          type="password"
          placeholder="输入 token"
        />
      </label>
      <label class="remember-field">
        <input
          v-model="rememberTokenModel"
          type="checkbox"
        />
        <span>在当前设备记住 token</span>
      </label>
      <button class="primary-button" type="submit" :disabled="loading">
        {{ loading ? "进入中..." : "进入" }}
      </button>
      <p v-if="statusText" class="status-copy">{{ statusText }}</p>
      </form>
    </div>
  </section>
</template>
