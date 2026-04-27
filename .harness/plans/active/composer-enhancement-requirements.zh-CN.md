---
Created: 2026-04-27
Status: active
Owner: Codex
Source: 用户在输入区原型评审中的确认意见
Exit Condition: 输入框区域完成实现、验证并由用户确认可用
Supersedes: none
Superseded By: none
---

# 输入框区域增强需求文档

## 1. 背景

当前会话页输入区只包含文本输入和发送/中断能力，无法直接完成模型切换、思考强度切换、Git 分支切换、图片/文件添加、权限模式选择等操作。

用户希望输入区升级为更完整的 composer，但移动端宽度较窄，不能把所有功能按钮常驻展示，否则会显得拥挤、难看、像桌面工具栏硬塞进手机。

本需求基于原型文件：

`.harness/inbox/composer-prototype.html`

## 2. 设计目标

- 保持当前产品的暖灰、克制、工具型视觉风格。
- 移动端优先，输入体验优先，不让功能按钮挤占输入空间。
- 常驻区域只展示最高频操作：添加内容、上下文设置入口、发送/中断。
- 模型、思考强度、Git 分支、权限模式收进设置弹窗。
- 上传能力收进 `+` 菜单，拍照排在第一位。
- 功能真实可接后端，不做纯装饰型 UI。

## 3. 非目标

- 本阶段不重做整个聊天页面。
- 不改会话消息流、历史展示、文件变更面板的整体结构。
- 不优先支持 Claude 权限细分；权限切换先只做 Codex。
- 不在正在执行的 turn 中途切换权限、模型或思考强度。
- 不把所有选项常驻展示在输入区。

## 4. 输入区信息架构

输入区应升级为一个 composer 面板，结构如下：

```text
┌────────────────────────────┐
│ 文本输入 textarea           │
│ 附件 chips                  │
│ +   当前上下文设置   发送/中断 │
└────────────────────────────┘
```

常驻区域只保留：

- `+`：添加内容菜单入口。
- `当前上下文设置`：显示模型、思考强度、Git 分支的压缩摘要。
- `发送/中断`：主操作按钮。

## 5. 常驻控件

### 5.1 添加内容按钮

位置：composer 底部动作条左侧。

表现：

- 使用 SVG 加号图标。
- 36px 左右的 icon button。
- 不展示文字，避免拥挤。

点击后打开添加内容菜单。

### 5.2 上下文设置入口

位置：composer 底部动作条中间。

表现：

- 单个轻量状态条，不拆成多个 pill。
- 文案示例：`GPT-5.5 · 中等 · feature/conversation-sync-fix`
- 超长 Git 分支名需省略，不撑破布局。
- 点击打开输入设置弹窗。

### 5.3 发送/中断按钮

位置：composer 底部动作条右侧。

状态：

- 空输入且无附件时禁用发送。
- 可发送时显示 `发送`。
- turn 运行中显示 `中断`。

视觉：

- 胶囊按钮。
- 保持当前产品暖灰主按钮风格。

## 6. 文本输入

### 6.1 基础行为

- 支持多行输入。
- 输入框自动增高，但不超过最大高度。
- 超过最大高度后输入框内部滚动。
- 移动端 placeholder 使用 `给 Codex 发消息…`。
- 桌面端可继续提示 `Enter 发送，Shift + Enter 换行`。

### 6.2 键盘行为

桌面端：

- `Enter` 发送。
- `Shift + Enter` 换行。
- IME 组合输入时不得误触发送。

移动端：

- 默认使用系统输入行为。
- 不依赖快捷键。

## 7. 附件区域

附件 chips 展示在输入框下方、动作条上方。

### 7.1 支持类型

- 图片。
- 文件。
- 拍照得到的图片。
- 剪贴板图片。

### 7.2 chip 展示

每个附件 chip 包含：

- 类型图标或缩略标识。
- 文件名。
- 删除按钮。

约束：

- chip 使用横向滚动容器。
- 文件名过长时省略。
- 不撑高输入区太多。

### 7.3 附件状态

需要支持：

- 待上传。
- 上传中。
- 上传成功。
- 上传失败。
- 删除。

上传失败时应允许重试或删除。

## 8. 添加内容菜单

点击 `+` 打开菜单。

菜单顺序必须为：

1. 拍照
2. 上传图片
3. 上传文件
4. 粘贴剪贴板图片

### 8.1 拍照

移动端优先能力。

实现建议：

- 使用 `<input type="file" accept="image/*" capture="environment">`。
- 桌面端如不支持 capture，则退化为图片选择。

### 8.2 上传图片

实现建议：

- 使用 `<input type="file" accept="image/*" multiple>`。

### 8.3 上传文件

实现建议：

- 使用 `<input type="file" multiple>`。
- 文件大小和类型限制需要后端配合确认。

### 8.4 粘贴剪贴板图片

实现建议：

- 支持 paste 事件读取图片。
- 如浏览器权限不允许读取剪贴板，给出轻提示。

## 9. 输入设置弹窗

点击上下文设置入口打开。

弹窗不能遮住 composer 输入区和按钮区，应从 composer 上方弹出。

弹窗内容包括：

- 模型。
- 思考强度。
- Codex 权限。
- Git 分支入口。

## 10. 模型切换

### 10.1 展示

在输入设置弹窗中展示模型选项。

示例：

- `GPT-5.5`
- `GPT-5.4`
- `Mini`

实际选项应来自后端 provider catalog，而不是前端写死。

### 10.2 生效时机

- 新会话：创建时生效。
- 历史会话继续提问：下一轮提交时生效。
- turn 运行中：禁止切换或提示下一轮生效。

## 11. 思考强度切换

### 11.1 展示

选项：

- 低
- 中等
- 高
- 极高

### 11.2 生效时机

- 新会话：创建时生效。
- 历史会话继续提问：下一轮提交时生效。
- turn 运行中：禁止切换或提示下一轮生效。

### 11.3 后端映射

需要在后端明确映射到真实运行参数。

建议字段：

```json
{
  "reasoningEffort": "medium"
}
```

候选值：

- `low`
- `medium`
- `high`
- `xhigh`

## 12. Git 分支切换

### 12.1 展示

设置弹窗里只展示当前 Git 分支摘要，并提供入口进入 Git 分支选择弹窗。

分支弹窗展示：

- 当前分支。
- 本地分支。
- 远程跟踪分支。
- 是否存在未提交改动。
- 新建分支入口。

### 12.2 数据来源

分支列表必须来自当前 workspace 的真实 Git 状态。

需要后端接口提供：

- 当前分支。
- 本地分支列表。
- 远程分支列表。
- 工作区是否 dirty。

### 12.3 切换限制

- 如果当前 turn 正在运行，禁止切换。
- 如果工作区有未提交改动，切换前需要提示风险。
- 切换分支操作应通过服务后端执行，不能只改前端状态。

### 12.4 新建分支

入口文案：

`从当前状态新建 Git 分支`

行为：

- 输入新分支名。
- 校验合法性。
- 调用后端创建并切换。

## 13. Codex 权限切换

只针对 Codex 生效，暂不处理 Claude。

### 13.1 选项

- 默认权限
- 自动审查
- 完全访问权限

### 13.2 Codex CLI 映射

已确认本地 Codex CLI 支持：

- `--sandbox read-only`
- `--sandbox workspace-write`
- `--sandbox danger-full-access`
- `--ask-for-approval untrusted`
- `--ask-for-approval on-request`
- `--ask-for-approval never`
- `--full-auto`
- `--dangerously-bypass-approvals-and-sandbox`

建议映射：

| UI 选项 | Codex 参数 |
| --- | --- |
| 默认权限 | 不额外传权限参数，沿用项目配置 |
| 自动审查 | `--sandbox workspace-write --ask-for-approval on-request` |
| 完全访问权限 | `--dangerously-bypass-approvals-and-sandbox` |

如果后续希望更保守，`自动审查` 可改为：

`--sandbox workspace-write --ask-for-approval untrusted`

### 13.3 生效时机

- 新会话：创建时生效。
- 历史会话继续提问：下一轮 `codex exec resume ...` 生效。
- turn 运行中：禁止切换或提示下一轮生效。

### 13.4 当前代码现状

目前权限只支持全局配置：

- `src/config.js` 中的 `codexFullAccess`
- `src/sessions/runners/codexRunner.js` 中按全局配置拼 `--dangerously-bypass-approvals-and-sandbox`
- `src/sessions/providers/buildProviders.js` 中按全局配置拼启动参数

需要新增会话级或下一轮级的 `permissionMode`。

## 14. 前后端数据结构建议

前端 composer 状态建议：

```json
{
  "model": "gpt-5.5",
  "reasoningEffort": "medium",
  "permissionMode": "full-access",
  "gitBranch": "feature/conversation-sync-fix",
  "attachments": []
}
```

权限模式候选值：

```text
default
auto-review
full-access
```

提交消息时建议携带：

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

也可以放在请求顶层：

```json
{
  "events": [
    {
      "type": "input",
      "data": "用户输入\n"
    }
  ],
  "model": "gpt-5.5",
  "reasoningEffort": "medium",
  "permissionMode": "full-access",
  "attachments": []
}
```

具体采用哪种，需和现有 `normalizeSessionInputEvents` 兼容。

## 15. 后端改造点

需要检查并改造：

- `src/routes/sessions.js`
  - 创建 session 时接收 composer options。
  - thread input-stream 时接收 composer options。

- `src/sessionManager.js`
  - session 上保存 `model`、`reasoningEffort`、`permissionMode`。
  - 历史 thread 继续提问时把 options 传入 live session。

- `src/sessions/runners/codexRunner.js`
  - `buildCodexJsonExecArgs` 根据 session options 拼真实 Codex 参数。

- `src/sessions/providers/buildProviders.js`
  - 新会话启动参数也需要支持同一套映射。

- `web/src/App.vue`
  - 管理 composer options。
  - 提交消息时带上 options。

- `web/src/components/ChatView.vue`
  - 展示 composer UI。
  - 处理设置弹窗和上传入口。

## 16. 视觉要求

### 16.1 保留风格

- 暖灰/米色背景。
- 克制边框。
- 低饱和按钮。
- 轻阴影。
- 20px 左右 composer 圆角。

### 16.2 避免

- 常驻展示三个以上大按钮。
- 桌面工具栏式拥挤布局。
- 强烈彩色渐变。
- 大面积卡片堆叠。
- 弹窗遮挡输入框和发送按钮。

### 16.3 移动端要求

- 360px 宽度下不溢出。
- Git 分支长名称必须省略。
- 附件 chips 横向滚动。
- 弹窗高度受限，内部可滚动。

## 17. 交互状态

需要覆盖：

- 默认空输入。
- 有文本。
- 有附件。
- 上传中。
- 上传失败。
- 正在执行。
- 执行中禁用模型/思考/权限/Git 分支切换。
- 历史会话继续提问。
- 新会话。
- 当前 workspace 非 Git 仓库。
- Git dirty 状态。

## 18. 验收标准

- 移动端输入区不拥挤。
- 常驻区只展示 `+`、上下文入口、发送/中断。
- `+` 菜单顺序为：拍照、上传图片、上传文件、粘贴剪贴板图片。
- 设置弹窗包含模型、思考强度、Codex 权限、Git 分支入口。
- 权限切换仅 Codex 生效，Claude 不展示或禁用该功能。
- 弹窗不遮挡 composer 输入和按钮区域。
- 360px 宽度下文本不溢出。
- Git 分支名过长时省略。
- Codex 权限模式能真实映射到底层 CLI 参数。
- 运行中的 turn 不允许中途切换影响执行的选项。

## 19. 建议实施顺序

1. 先实现 composer 视觉结构，不接后端。
2. 接模型和思考强度状态管理。
3. 接 Codex 权限模式参数映射。
4. 接真实 Git 分支读取与切换。
5. 接附件选择、拍照和剪贴板图片。
6. 接上传后端和发送 payload。
7. 做移动端 UI 验证和实际会话提交验证。

