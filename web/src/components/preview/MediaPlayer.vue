<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { createMediaPlayback } from "../../lib/media-playback.js";

const props = defineProps({ source: { type: Object, required: true } });
const playback = createMediaPlayback();
const state = playback.state;
const player = ref(null);
let playSequence = 0;
function stop() {
  playSequence += 1;
  const element = player.value;
  element?.pause?.();
  element?.removeAttribute?.("src");
  element?.load?.();
  playback.reset();
}
async function play() {
  if (state.status === "loading") return;
  stop();
  const sequence = playSequence;
  if (!await playback.open(props.source)) return;
  await nextTick();
  if (sequence !== playSequence) return;
  // Some mobile browsers require another tap after the asynchronous grant.
  // Keep their native controls available if autoplay permission was lost.
  try { await player.value?.play?.(); } catch { /* native controls remain usable */ }
}
watch([() => props.source.target, () => props.source.cwd, () => props.source.url, () => props.source.kind], stop);
onBeforeUnmount(stop);
</script>

<template>
  <section class="media-player" :class="`media-player-${source.kind}`" :aria-label="source.title || (source.kind === 'video' ? '视频' : '音频')">
    <div class="media-player-heading">
      <span>{{ source.title || (source.kind === 'video' ? '视频' : '音频') }}</span>
      <a v-if="source.href" :href="source.href" target="_blank" rel="noopener noreferrer">新窗口打开 ↗</a>
    </div>
    <component :is="source.kind === 'video' ? 'video' : 'audio'" v-if="state.src" :key="state.revision" ref="player" :src="state.src"
      controls playsinline preload="none" :aria-label="source.title || '媒体播放器'" @error="playback.failed($event.currentTarget.error?.code)" />
    <button v-else class="media-player-start" type="button" :disabled="state.status === 'loading'" @click="play">
      <span class="media-play-symbol" aria-hidden="true">▶</span>
      {{ state.status === 'loading' ? '正在准备…' : source.kind === 'video' ? '播放视频' : '播放音频' }}
    </button>
    <div v-if="state.error" class="media-player-error" role="alert"><span>{{ state.error }}</span><button type="button" @click="play">重试</button></div>
  </section>
</template>

<style scoped>
.media-player { min-width: 0; width: 100%; margin: 10px 0; border: 1px solid var(--line, #ded4ca); border-radius: 14px; overflow: hidden; background: #f7f2ec; color: var(--text, #352f29); }
.media-player-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; padding: 10px 12px; font-size: 12px; line-height: 1.5; }
.media-player-heading > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.media-player-heading a { flex: 0 0 auto; color: #79634f; text-decoration: none; font-size: 11px; }
.media-player video { display: block; width: 100%; max-height: min(65dvh, 640px); background: #211f1c; }
.media-player audio { display: block; width: calc(100% - 16px); max-width: 100%; margin: 0 8px 8px; height: 48px; }
.media-player-start { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 56px; padding: 12px; border: 0; color: #665448; background: #eee6dd; cursor: pointer; }
.media-player-video .media-player-start { min-height: 130px; }
.media-play-symbol { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid #c9b9a9; border-radius: 8px; font-size: 14px; }
.media-player-start:disabled { cursor: wait; opacity: .7; }
.media-player-error { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 12px; color: #965449; font-size: 12px; line-height: 1.6; }
.media-player-error span { flex: 1; min-width: 160px; }
.media-player-error button { flex: 0 0 auto; padding: 8px 14px; border: 1px solid #d9d0c7; border-radius: 8px; background: #fdfbf8; color: #665448; }
.media-player :is(button, a, audio, video):focus-visible { outline: 2px solid #92765c; outline-offset: -3px; }
</style>
