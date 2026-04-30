<script setup>
const emit = defineEmits(["capture-photo", "upload-images", "upload-files", "paste-clipboard"]);
</script>

<template>
  <div>
    <header class="popover-header">添加内容</header>
    <button class="option" type="button" @click="emit('capture-photo')">
      <span><b>拍照</b><small>调用相机拍摄图片</small></span>
    </button>
    <button class="option" type="button" @click="emit('upload-images')">
      <span><b>上传图片</b><small>截图、设计稿、报错图片</small></span>
    </button>
    <button class="option" type="button" @click="emit('upload-files')">
      <span><b>上传文件</b><small>代码、文档、配置或日志</small></span>
    </button>
    <button class="option" type="button" @click="emit('paste-clipboard')">
      <span><b>粘贴剪贴板图片</b><small>从系统剪贴板读取截图</small></span>
    </button>
  </div>
</template>

<style scoped>
.popover-header {
  padding: 13px 14px 9px;
  font-size: 13px;
  font-weight: 650;
  color: #4a4038;
}

.option {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 11px 14px;
  border: 0;
  border-top: 1px solid rgba(238, 230, 223, 0.82);
  background: transparent;
  text-align: left;
  color: #372f29;
  cursor: pointer;
}

.option:hover {
  background: rgba(246, 241, 236, 0.92);
}

.option b {
  display: block;
  font-size: 14px;
  margin-bottom: 3px;
}

.option small {
  color: #8b7b6e;
  font-size: 12px;
  line-height: 1.35;
}
</style>
