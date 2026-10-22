# 界面品牌与状态反馈

Last updated: 2026-10-22
Status: active
Owner: frontend

## 范围

网页展示名为 Codex Web。保留系统字体、暖白背景、灰褐边框和咖啡色操作按钮；像素角色用于品牌、等待和空状态，不改变聊天内容与执行结果的语义。

## 组件职责

- `web/src/components/PixelCompanion.js`：像素终端角色，提供静止、读取、工作、等待、搜索和失败表情；图形对辅助技术隐藏，由旁边文字表达状态。
- `web/src/components/InterfaceState.js`：共用加载、空状态、错误和重试入口，支持列表、消息骨架与紧凑模式。超过八秒仍在读取时补充等待说明，卸载时清理计时器。
- `web/src/styles/interface-state.css`：共用状态样式与逐帧动效。角色和骨架延迟约 180 毫秒出现，不阻挡结果展示；减少动态效果设置下停止动画。
- `web/src/components/SessionListHeader.vue`：产品标题和新建入口。打开项目选择器时独立读取未筛选项目目录，关闭或离开时取消请求；选中项目后复用既有创建会话动作。
- `web/src/lib/project-picker.js`：同名同目录的独立项目保留各自身份，用目录总会话数、创建日期和必要的项目标识区分，避免按目录错误合并。
- `web/src/components/ChatHeader.vue`：会话标题、项目名称、完整信息弹层和浏览器标签标题。弹层复用原生 dialog 与既有焦点管理。

异步页面和业务状态共用纯 JavaScript 组件，保留 Node 测试直接导入异步视图模块的能力。状态组件只呈现事实，不发送消息、不重发请求、不修改权限，也不模拟进度百分比。

## 运行中筛选

列表中的运行数量可以切换“最近活动”的运行中筛选。`GET /api/session-catalog?view=activity&running=1` 在完整搜索结果去重、排序后筛选，再进行分页。不能将已加载窗口中的运行项当作全部运行项。

`running` 仅支持缺省、`0` 或 `1`；`1` 仅适用于 activity 视图。筛选响应带 `runningOnly: true`，游标绑定该上下文。客户端切换筛选时取消旧请求，翻页与刷新保留筛选，切回按项目时清除筛选。搜索与运行中筛选取交集。

## 关键交互

运行时即使已经输入草稿或添加附件，停止入口仍保留；停止动作不提交或清空草稿。输入区域显示“立即引导”或“加入队列”的说明，原有提交与核对协议保持不变。输入设置展示当前权限描述，隐藏文件输入退出 Tab 顺序，附件操作在触屏下扩展点击区域。

## 验证

相关测试位于 `tests/async-view.test.js`、`tests/session-list-ui.test.js`、`tests/paged-session-catalog.test.js`、`tests/session-catalog-pages.test.js`、`tests/composer-popover.test.js` 与 `tests/codex-chat-runtime.test.js`。构建门禁为 `npm run check`。

视觉验收需额外检查桌面和窄屏、长标题、加载到结果切换、项目选择、输入设置、运行筛选、键盘焦点及减少动态效果。浏览器验收不应触发真实发送、停止、授权或创建会话；这些动作的契约使用隔离测试覆盖。
