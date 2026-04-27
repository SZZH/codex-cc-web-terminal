# Codex Web Terminal

[English](./README.md) | 简体中文

只做一件事：把你电脑上的 `codex` 会话放到浏览器（含手机）里用。

当前仅支持 **Codex**。

## 示例截图

<p align="center">
  <img src="./docs/images/codex-web-terminal.jpg" alt="Codex Web Terminal 手机界面截图 1" width="280" />
  <img src="./docs/images/codex-web-terminal2.jpg" alt="Codex Web Terminal 手机界面截图 2" width="280" />
</p>

## 前置依赖

- Node.js 22+
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
# 把 .env 里的 ACCESS_TOKEN 改成你自己的
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
