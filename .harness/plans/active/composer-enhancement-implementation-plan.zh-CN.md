---
Created: 2026-04-27
Status: active
Owner: Codex
Source: `.harness/inbox/composer-prototype.html` 与输入区增强需求文档
Exit Condition: 输入区增强按原型完整实现、验证通过并由用户确认
Supersedes: none
Superseded By: none
---

# 输入框区域增强实现方案

## 1. 实现原则

本实现必须严格遵循原型文件：

`.harness/inbox/composer-prototype.html`

除非用户再次确认变更，否则不得自行调整布局结构、控件位置、交互入口或视觉风格。

## 2. UI 锁定规格

### 2.1 Composer 总体结构

在 `ChatView.vue` 中将现有 composer 从：

```text
textarea + 发送按钮
```

改为以下固定结构：

```text
composer-wrap
  composer
    textarea.draft / composer-input
    attachments
      chip...
    composer-actions
      + icon button
      context-button
      send button
```

必须保持该顺序：

1. 输入框
2. 附件 chips
3. 底部动作条

不得把模型、思考强度、Git 分支、权限按钮常驻放在输入框上方或下方。

### 2.2 常驻底部动作条

底部动作条固定展示三个控件：

```text
[ + ] [ GPT-5.5 · 中等 · feature/xxx ] [ 发送/中断 ]
```

#### `+` 按钮

- 位置：左侧。
- 形态：36px icon button。
- 图标：SVG 加号。
- 点击：打开 `添加内容` 弹窗。

#### `context-button`

- 位置：中间。
- 形态：柔和胶囊状态条。
- 文案格式固定为：

```text
{modelLabel} · {reasoningLabel} · {gitBranch}
```

示例：

```text
GPT-5.5 · 中等 · feature/conversation-sync-fix
```

宽度不足时必须省略中间文本，不得换行，不得撑开布局。

#### 发送/中断按钮

- 位置：右侧。
- 形态：胶囊主按钮。
- 空输入且无附件时禁用。
- 可发送时显示 `发送`。
- turn 运行中显示 `中断`。

### 2.3 输入框

现有 `textarea` 保留，但纳入 composer 面板。

要求：

- 默认最小高度约 78px。
- 最大高度沿用现有输入框限制。
- 超过最大高度后内部滚动。
- 不显示边框。
- 背景透明，使用 composer 面板背景。

### 2.4 附件 chips

附件 chips 放在输入框下方，动作条上方。

未选择附件时：

- `attachments` 容器不渲染或高度为 0。

有附件时：

- 每个附件渲染为圆胶囊 chip。
- chip 内容：
  - 类型图标或文件类型标识。
  - 文件名。
  - 删除按钮。
- chip 横向滚动。
- 文件名超长省略。

### 2.5 弹窗位置

所有 composer 弹窗都必须从 composer 上方弹出。

要求：

- 弹窗不得遮住输入框。
- 弹窗不得遮住底部动作条。
- 移动端窄屏宽度为 `calc(100vw - 28px)` 上限。
- 矮屏下弹窗内部滚动。

## 3. 弹窗规格

### 3.1 添加内容弹窗

触发入口：`+` 按钮。

标题：

```text
添加内容
```

菜单项顺序固定为：

1. 拍照
2. 上传图片
3. 上传文件
4. 粘贴剪贴板图片

每项结构：

```text
标题
说明
```

文案固定如下：

| 标题 | 说明 |
| --- | --- |
| 拍照 | 调用相机拍摄图片 |
| 上传图片 | 截图、设计稿、报错图片 |
| 上传文件 | 代码、文档、配置或日志 |
| 粘贴剪贴板图片 | 从系统剪贴板读取截图 |

### 3.2 输入设置弹窗

触发入口：`context-button`。

标题：

```text
输入设置
```

内容顺序固定为：

1. 模型
2. 思考强度
3. Codex 权限
4. Git 分支入口

### 3.3 模型分组

显示为横向 chip 选择器。

第一版使用后端 provider catalog 返回的 Codex 模型列表。

如果后端没有模型列表，展示 fallback：

```text
GPT-5.5
GPT-5.4
Mini
```

当前选中项使用 active 样式。

### 3.4 思考强度分组

显示为横向 chip 选择器。

选项固定：

| UI 文案 | 值 |
| --- | --- |
| 低 | low |
| 中等 | medium |
| 高 | high |
| 极高 | xhigh |

默认值：

```text
medium
```

### 3.5 Codex 权限分组

显示为竖向选择卡片。

选项固定：

| UI 文案 | 值 | 说明 |
| --- | --- | --- |
| 默认权限 | default | 沿用当前项目配置 |
| 自动审查 | auto-review | 写入工作区，必要时请求确认 |
| 完全访问权限 | full-access | 跳过审批和沙箱，仅 Codex 生效 |

当前选中项显示 active 样式和 `✓`。

第一版默认值应与当前项目配置一致：

- 如果 `codexFullAccess === true`，默认选中 `full-access`。
- 如果 `codexFullAccess !== true`，默认选中 `default`。

### 3.6 Git 分支入口

在输入设置弹窗底部展示为一条 `option`：

标题：

```text
Git 分支
```

说明为当前分支名。

点击后打开 Git 分支弹窗。

### 3.7 Git 分支弹窗

标题：

```text
切换 Git 分支
```

列表展示：

- 当前分支。
- 本地分支。
- 远程跟踪分支。

当前分支右侧显示 `✓`。

底部按钮：

```text
从当前状态新建 Git 分支
```

如果当前 workspace 不是 Git 仓库：

- Git 分支入口置灰。
- 说明文案显示 `当前目录不是 Git 仓库`。
- 点击不打开分支弹窗。

## 4. 前端状态模型

新增 composer options 状态。

必须在 `App.vue` 管理，因为提交、创建会话、历史继续提问都在 `App.vue` 串联。

状态结构固定为：

```js
const composerOptions = reactive({
  model: "",
  reasoningEffort: "medium",
  permissionMode: "default",
  gitBranch: "",
  attachments: []
});
```

### 4.1 字段定义

#### `model`

- 类型：string
- 来源：provider catalog / 当前 session model / 用户选择
- 提交时传给后端。

#### `reasoningEffort`

- 类型：string
- 值：`low | medium | high | xhigh`
- 默认：`medium`

#### `permissionMode`

- 类型：string
- 值：`default | auto-review | full-access`
- 仅 Codex 生效。

#### `gitBranch`

- 类型：string
- 当前 workspace Git 分支。

#### `attachments`

数组，每项结构：

```js
{
  id: string,
  kind: "image" | "file",
  name: string,
  file: File,
  status: "pending" | "uploading" | "uploaded" | "failed",
  url: string,
  error: string
}
```

## 5. 组件拆分

为避免 `ChatView.vue` 继续膨胀，必须拆组件。

实现时不得把 composer 的新 UI 直接堆在 `ChatView.vue` 里。`ChatView.vue` 只允许保留消息流、滚动、lightbox、状态透传和 composer 事件转发。

### 5.1 新增组件

必须新增以下组件，不得合并为一个大组件：

```text
web/src/components/composer/ChatComposer.vue
web/src/components/composer/ComposerPopover.vue
web/src/components/composer/AttachmentChips.vue
web/src/components/composer/ComposerSettings.vue
web/src/components/composer/AddContentMenu.vue
web/src/components/composer/GitBranchMenu.vue
```

### 5.2 职责

#### `ChatComposer.vue`

负责整体结构：

- textarea。
- 附件 chips。
- 底部动作条。
- 弹窗开关。
- emit submit / interrupt / options change。

#### `ComposerPopover.vue`

通用弹窗外壳：

- 固定 composer 上方弹出。
- 处理关闭。
- 处理矮屏滚动。

#### `AttachmentChips.vue`

负责：

- 附件列表展示。
- 删除附件。
- 上传状态展示。

#### `ComposerSettings.vue`

负责：

- 模型选择。
- 思考强度选择。
- Codex 权限选择。
- Git 分支入口。

#### `AddContentMenu.vue`

负责：

- 拍照。
- 上传图片。
- 上传文件。
- 粘贴剪贴板图片入口。

#### `GitBranchMenu.vue`

负责：

- 分支列表展示。
- 切换分支。
- 新建分支入口。

## 6. ChatView 改造

`ChatView.vue` 保留职责：

- 消息列表。
- 滚动。
- lightbox。
- 把 composer props 和事件透传给 `ChatComposer`。

`ChatView.vue` 不再直接维护 composer 复杂 UI。

### 6.1 Props

新增传入：

```js
composerOptions: Object,
models: Array,
gitState: Object
```

### 6.2 Emits

新增：

```js
"update:composer-options"
"add-attachments"
"remove-attachment"
"switch-git-branch"
"create-git-branch"
```

原有保留：

```js
"update:draft"
"submit"
"interrupt"
```

## 7. API 设计

### 7.1 Provider catalog

现有 provider catalog 已能返回模型列表。

前端模型列表应优先使用现有数据。

不得在组件内写死最终模型列表，只能作为 fallback。

### 7.2 Git 状态接口

新增接口：

```http
GET /api/workspace-git?cwd=/path/to/workspace
```

返回：

```json
{
  "ok": true,
  "isGitRepo": true,
  "currentBranch": "feature/conversation-sync-fix",
  "dirty": true,
  "branches": [
    {
      "name": "feature/conversation-sync-fix",
      "current": true,
      "remote": false
    },
    {
      "name": "main",
      "current": false,
      "remote": false
    },
    {
      "name": "origin/main",
      "current": false,
      "remote": true
    }
  ]
}
```

非 Git 仓库返回：

```json
{
  "ok": true,
  "isGitRepo": false,
  "currentBranch": "",
  "dirty": false,
  "branches": []
}
```

### 7.3 切换 Git 分支接口

新增接口：

```http
POST /api/workspace-git/checkout
```

请求：

```json
{
  "cwd": "/path/to/workspace",
  "branch": "main"
}
```

行为：

- 后端执行 `git checkout <branch>` 或等价安全命令。
- 如果工作区 dirty，返回 409，不自动切。

409 返回：

```json
{
  "error": "Workspace has uncommitted changes",
  "dirty": true
}
```

### 7.4 新建 Git 分支接口

新增接口：

```http
POST /api/workspace-git/branches
```

请求：

```json
{
  "cwd": "/path/to/workspace",
  "branch": "feature/new-branch",
  "checkout": true
}
```

行为：

- 校验分支名。
- 执行 `git checkout -b <branch>`。
- 返回最新 Git 状态。

## 8. 提交消息协议

### 8.1 输入流请求

现有请求：

```json
{
  "type": "input",
  "data": "用户输入\n"
}
```

需要扩展为：

```json
{
  "type": "input",
  "data": "用户输入\n",
  "model": "gpt-5.5",
  "reasoningEffort": "medium",
  "permissionMode": "full-access",
  "attachments": []
}
```

`normalizeSessionInputEvents` 必须保留旧格式兼容。

### 8.2 session 创建请求

创建 session 时同样携带：

```json
{
  "provider": "codex",
  "cwd": "/path/to/workspace",
  "model": "gpt-5.5",
  "reasoningEffort": "medium",
  "permissionMode": "full-access"
}
```

## 9. Codex 参数映射

在 `codexRunner.js` 中实现统一映射函数。

必须实现以下语义等价函数：

```js
function buildCodexPermissionArgs(permissionMode, config) {
  if (permissionMode === "full-access") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  if (permissionMode === "auto-review") {
    return ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"];
  }
  if (config.codexFullAccess) {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  return [];
}
```

`default` 必须沿用当前项目配置。

### 9.1 禁止重复参数

如果 session 选择了 `permissionMode !== "default"`，不得再额外叠加 `config.codexFullAccess`。

### 9.2 reasoning 参数

第一版必须先做 Codex CLI 配置确认，再写映射代码。

确认方式固定为：

```bash
codex debug config 2>/dev/null || codex --help
```

如果能确认真实配置键，则用 `--config <key>=<value>` 映射。

如果不能确认真实配置键，则第一版只在前端保存和展示 `reasoningEffort`，不得把猜测字段传给 Codex CLI。

禁止使用未确认字段名，例如不得直接猜测 `reasoning_effort`、`model_reasoning_effort`、`reasoning.effort` 中任意一个。

## 10. 附件实现

### 10.1 第一版发送策略

第一版附件发送范围固定为：

- 图片附件：发送给 Codex。
- 非图片文件：只完成选择、chip 展示和删除，不随消息发送。

图片发送规则：

- 图片文件保留为本地临时文件路径。
- `codex exec` 使用 `--image <FILE>` 传入。
- 每个图片附件对应一个 `--image` 参数。

如果验证发现 `codex exec resume ... --image <FILE>` 不支持图片参数，则第一版必须禁用图片随历史会话发送，并在 UI 中提示“当前继续会话暂不支持图片附件”。

不得把非图片文件内容自动拼进 prompt；后续是否读取文件内容需要单独设计。

### 10.2 附件限制

必须限制：

- 单次附件数量。
- 单文件大小。
- 总大小。

第一版限制固定为：

- 图片最多 6 张。
- 文件最多 6 个。
- 单文件最大 20MB。

超出时前端提示，不发送。

## 11. 运行中禁用规则

当 `canInterrupt === true` 或 `loading === true`：

- 禁用模型选择。
- 禁用思考强度选择。
- 禁用 Codex 权限切换。
- 禁用 Git 分支切换。
- 禁用附件添加。
- 允许点击中断按钮。

禁用态样式：

- opacity 降低。
- cursor 默认。
- 不打开弹窗。

## 12. 错误处理

### 12.1 Git 切换失败

显示 status：

```text
当前工作区有未提交改动，无法直接切换分支。
```

### 12.2 非 Git 仓库

设置弹窗中 Git 分支显示：

```text
当前目录不是 Git 仓库
```

入口禁用。

### 12.3 权限不支持

如果 provider 不是 Codex：

- 隐藏 Codex 权限分组，或显示禁用态。
- 第一版推荐隐藏，避免误导。

### 12.4 上传失败

附件 chip 标记失败态，保留删除按钮。

## 13. 样式实现要求

### 13.1 必须复用原型视觉

从原型迁移以下样式方向：

- composer 圆角约 20px。
- composer 背景为接近 `rgba(255,253,250,0.98)` 的暖白渐变。
- 边框为低对比暖灰。
- 阴影轻，不超过原型厚度。
- 附件 chip 为圆胶囊。
- context-button 为柔和状态条。
- send button 为暖灰胶囊主按钮。

### 13.2 不允许

- 不允许紫色/蓝紫渐变。
- 不允许大面积高饱和按钮。
- 不允许三个以上常驻配置按钮。
- 不允许弹窗遮住 composer。
- 不允许 Git 分支长文本撑破布局。

### 13.3 CSS 位置

composer 新样式必须放在新增 composer 组件的 scoped style 内。

不要新增全局 CSS，除非需要共享变量。

## 14. 测试计划

### 14.1 单元测试

新增/更新测试：

- 权限模式到 Codex 参数映射。
- 默认权限沿用 config。
- 非 default 权限不叠加全局 full access。
- input-stream 旧格式兼容。
- input-stream 新格式包含 composer options。

### 14.2 后端接口测试

新增测试：

- Git 状态接口在 Git 仓库返回当前分支。
- 非 Git 目录返回 `isGitRepo: false`。
- dirty 工作区 checkout 返回 409。
- 新建分支成功返回最新状态。

### 14.3 前端构建

必须运行：

```bash
npm run web:build
```

### 14.4 服务验证

必须通过进程管理重启：

```bash
npm run service:restart
```

健康检查：

```bash
curl -sS http://localhost:3210/api/health
```

### 14.5 浏览器验证

移动端宽度至少验证：

- 360px
- 390px
- 430px

场景：

- 空输入。
- 长 Git 分支名。
- 多附件。
- 打开添加内容菜单。
- 打开输入设置菜单。
- 打开 Git 分支菜单。
- 运行中禁用态。

## 15. 实施顺序

必须按以下顺序实施：

1. 提取 `ChatComposer.vue`，只迁移现有输入框和发送行为。
2. 按原型完成 composer 布局和样式。
3. 加入附件 chips 静态渲染和删除事件。
4. 加入 `+` 菜单 UI。
5. 加入输入设置 UI。
6. 接入模型状态。
7. 接入 Codex 权限状态和后端参数映射。
8. 接入 Git 状态接口和分支菜单。
9. 接入附件选择。
10. 接入附件发送。
11. 完成禁用态和错误态。
12. 跑测试、构建、服务重启和浏览器验证。

每一步都应保持页面可运行，不允许一次性大爆炸式改完后再修。

## 16. 交付标准

交付时必须说明：

- 修改了哪些文件。
- 哪些功能已真实接后端。
- 哪些功能仍为前端状态或待后端。
- Codex 权限三档的真实参数映射。
- Git 分支切换的安全限制。
- 附件发送支持范围。
- 已执行的验证命令。
