<script setup>
import { computed } from "vue";
import PixelCompanion from "./PixelCompanion.js";

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
      <div class="login-brand"><PixelCompanion :size="56" :mood="loading ? 'loading' : 'idle'" /><span>Codex Web</span></div>
      <h1>回到你的工作台</h1>
      <p class="login-description">连接桌面，在这里继续你的会话。</p>
      <form @submit.prevent="emit('submit')">
      <label class="field">
        <span>访问令牌</span>
        <input
          v-model="accessTokenModel"
          type="password"
          placeholder="输入访问令牌"
          autocomplete="current-password"
          :disabled="loading"
          required
        />
      </label>
      <label class="remember-field">
        <input
          v-model="rememberTokenModel"
          type="checkbox"
        />
        <span>在当前设备记住令牌</span>
      </label>
      <button class="primary-button" type="submit" :disabled="loading">
        {{ loading ? "正在连接…" : "进入工作台" }}
      </button>
      <p v-if="statusText" class="status-copy" role="alert">{{ statusText }}</p>
      </form>
    </div>
  </section>
</template>

<style scoped>
.login-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; color: #65564a; font-size: 14px; font-weight: 600; }
h1 { font-size: 24px; letter-spacing: -.03em; color: #3c342d; }
.login-description { margin: 10px 0 24px; color: #8b7f73; font-size: 13px; line-height: 1.6; }
.primary-button { background: #514338; box-shadow: none; }
.primary-button:disabled { opacity: .6; }
input:focus-visible, button:focus-visible { outline: 2px solid #8b7f73; outline-offset: 3px; }
</style>
