# Codex Web Terminal

[English](./README.md) | 简体中文

只做一件事：把你电脑上的 `codex` 会话放到浏览器（含手机）里用。

主聊天界面面向 **Codex**，保留旧 Claude Code（CC）终端通道的兼容能力。

## 示例截图

<p align="center">
  <img src="./docs/images/codex-web-terminal.jpg" alt="Codex Web Terminal 手机界面截图 1" width="280" />
  <img src="./docs/images/codex-web-terminal2.jpg" alt="Codex Web Terminal 手机界面截图 2" width="280" />
</p>

## 前置依赖

- Node.js 22.15+
- 已安装 `codex` 命令并可在终端直接运行
- 如果要外网访问：电脑和手机都要安装 Tailscale，并登录同一账号

## 1 分钟本地跑起来

```bash
git clone https://github.com/SZZH/codex-cc-web-terminal.git
cd codex-cc-web-terminal
npm run setup
```

`npm run setup` 会交互式引导你完成：`.env` 配置、可选 Tailscale、安装依赖、启动服务。

或手动执行（macOS / Linux）：

```bash
cd codex-cc-web-terminal
cp .env.example .env
# 把 .env 里的 ACCESS_TOKEN 改成你自己的；默认的 change-me 会被拒绝
npm install
npm run dev:up
```

Windows（PowerShell / CMD）请改用：

```bash
npm install
npm run dev
```

打开：

- 前端（推荐）：`http://127.0.0.1:5173/#/sessions`
- 后端直连：`http://127.0.0.1:3210`（如果你改了 `PORT`，这里用对应端口）

## 手机访问（两种）

### A. 同一 Wi-Fi

1. `.env` 确认：`HOST=0.0.0.0`
2. 手机打开：`http://你的电脑局域网IP:3210`
3. 用 `ACCESS_TOKEN` 登录

### B. Tailscale（外网推荐）

这条路径的前提：电脑和手机都安装 Tailscale，并登录同一账号。

1. 电脑安装并登录 [Tailscale](https://tailscale.com/download)
2. 安卓/iOS 安装 Tailscale App，并登录同一账号
3. 电脑执行：

```bash
tailscale status
tailscale ip -4
```

4. 手机打开：`http://电脑的100.x.x.x:3210`

建议 `.env` 打开：

```env
TAILSCALE_ONLY=true
```

## 部署（PM2）

```bash
npm run service:start
npm run service:status
npm run service:logs
```

Codex app-server 会显式接收线程的模型、推理强度和权限设置。
网页当前会拒绝需要审批的命令、文件修改和权限提升请求，不会自动批准。
输入设置支持只读、自动审核和完全访问。自动审核由 Codex 审核者处理，网页不代替用户批准未支持的人工审批请求。
模型、思考强度和权限按当前线程保存，不修改桌面端全局权限。
思考档位跟随所选模型能力，发送会等待设置保存完成；Codex V2 主聊天通过官方 app-server 发送。

侧栏按本地 Codex 的项目身份、成员关系、置顶和排序展示，直接读取桌面元数据，避免每次遍历所有对话文件。模型选项来自当前 app-server 的实际模型目录。

会话列表提供“分组 / 最近活动”切换。每组默认显示 5 条，可展开全部；最近活动跨项目按实际使用时间排序。列表和分组标题会标出已确认运行中的会话。桌面独占线程若没有可靠的运行状态证据，保持未知，不把未加载或中断记录误报为运行或结束。
无法安全换算为三档权限的自定义策略，需要先明确选择权限再续聊。

## Codex 聊天（V2）

聊天使用官方 Thread / Turn / Item 身份、有界历史分页和按稳定线程 ID 订阅的 WebSocket。可见历史页的中间消息、文件和过程条目自动补齐，最多两轮并发；完整终态旧轮复用，最新轮从最后已读条目读取新增内容，执行过程默认折叠。断线恢复只补齐历史与订阅，不重发提示词。旧文件历史在读取入口适配，CC 终端通道独立保留。

每次提交都有持久请求回执。默认排队发送，等待网页持有的当前轮完成；“立即引导”向该活动轮补充输入，“停止”显式中断该轮。待发送消息显示在输入框上方，可逐条转为引导；过程展开后自动补读详情，空思考条目不占用卡片。失败消息保留原文和附件，发送结果暂不确定时自动核对，不盲目重发。

一次消息保留多行文本，可附带最多六张 PNG、JPEG、WebP 或 GIF 图片，每张上限 20 MiB。本地及内嵌回复图片通过认证媒体地址读取；工具输出和文件 diff 按需展开，超大内容明确标记截断。网页不会抢占桌面运行时持有的线程：遇到 writer 冲突会把消息存入官方桌面队列，保留原 threadId、原文和附件，并按官方历史确认执行。桌面会话未加载或中断时可能暂不消费，页面应保持“待执行”，不能当作已发送完成。只读查看不获取执行权，网页也不能停止或引导桌面持有的活动轮。

详细契约见 [Codex V2](./docs/refactoring/codex-chat-v2.md) 和 [桌面兼容边界](./docs/architecture/codex-desktop-compatibility.md)。

## 本地文件与网页预览

本地文件链接和已启动的 loopback 网页可在电脑侧边面板、手机全屏中打开，保留聊天位置和草稿。文件预览采用 kkFileView 5.0.3，核心场景为 Office 文档、图片、PDF 和 Markdown。电脑及相关服务需要保持在线；预览使用独立端口与有时限、限定范围的访问授权，私密目录不能作为公开静态内容暴露。

frp/Caddy 配置、原生运行时、进程管理操作和兼容边界见[本地预览运维说明](./docs/operations/local-preview.md)。

## 最常用命令

```bash
npm run dev            # 跨平台开发模式（前后端前台运行）
npm run dev:up         # 仅 macOS/Linux：后台启动开发服务
npm run dev:down       # 仅 macOS/Linux：停止后台开发进程
npm run check          # 快速自检
```

## 三个高频问题

1. `Cross-origin request rejected`
- 优先用 `npm run dev`（macOS/Linux 也可用 `npm run dev:up`）启动，不要手动拆开前后端起。

2. `5173` 打不开
- 先执行 `npm run dev`，再看端口：
```bash
# macOS/Linux
lsof -iTCP:5173 -sTCP:LISTEN -n -P

# Windows
netstat -ano | findstr :5173
```

3. 手机提示“电脑未连接”
- 先确认电脑服务在线：`npm run service:status`
- 再确认网络路径正确：同 Wi-Fi 或同 Tailnet
- 如果你改过 `PORT`，手机访问地址也要用同一个端口。

## 更新日志

### `v0.2.0`

相较 `v0.1.0` 的核心更新：

- 重构了会话 / thread 主链路，统一到 thread snapshot、canonical event 和 SSE 输入流这套模型，让实时会话、历史会话和续聊状态同步更一致。
- 完善了 Codex 历史会话能力，补齐历史列表、历史消息渲染、历史图片恢复、thread continuation 和消息展示一致性。
- 新增文件变更面板，支持展示 diff、按轮次挂靠历史修改记录，以及撤销当前工作区文件变更。
- 优化会话列表分组逻辑，支持按最近使用时间排序，并让分组顺序随组内最新会话时间变化。
- 对齐 Codex 项目会话列表筛选口径，按项目、当前分支和正常 `vscode` 会话展示。
- 优化 thread 展示层和过程区样式，统一执行过程与文件变更区折叠图标，改进代码块与过程区可读性。
- 补齐进程管理 npm 脚本，统一服务启动、重启、状态检查和日志管理入口。
- 修复多项聊天体验问题，包括初始不贴底、内容变化后追滚不稳定、历史消息归类错误、历史图片展示异常，以及历史接口中 Codex directive 泄漏到正文气泡的问题。

### `v0.1.0`

核心更新：

- 初始化仓库规则、协作说明和版本标签约定。

## 开源说明

- [LICENSE](./LICENSE)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
