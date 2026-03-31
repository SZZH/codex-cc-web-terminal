# Codex Web Terminal

在你的 Windows/macOS 机器上运行 `codex`，并通过浏览器（电脑/手机）访问多会话界面。

当前开源版本仅支持 **Codex**。

## 1. 你会得到什么

- 浏览器里管理 Codex 会话（列表、历史、恢复、发送、中断）
- 手机可访问（局域网或 Tailscale）
- 开发模式支持热更新（前端 HMR + 后端 watch）

## 2. 环境要求

- Node.js >= 22
- 本机已安装并可执行 `codex`
- （可选）需要手机外网访问时安装 Tailscale

检查命令：

```bash
node -v
codex --version
```

## 3. 最快启动（本地）

### 3.1 初始化

```bash
cd /Users/jiaojian/Desktop/self/codex-cc-web-terminal
cp .env.example .env
npm install
```

编辑 `.env`，至少改这两项：

```env
PORT=3210
ACCESS_TOKEN=改成你自己的强密码token
```

### 3.2 启动（开发模式，推荐）

```bash
npm run dev:up
```

启动后：

- API 服务：`http://127.0.0.1:3210`
- 前端 HMR：`http://127.0.0.1:5173/#/sessions`

查看日志：

```bash
tail -f /tmp/codex-server-dev.log /tmp/codex-web-dev.log
```

## 4. 手机访问（局域网）

1. 确保手机和电脑在同一 Wi-Fi。
2. 电脑上查看局域网 IP（例如 `192.168.1.23`）。
3. 手机访问：`http://<电脑IP>:3210`
4. 输入 `.env` 的 `ACCESS_TOKEN` 登录。

如果打不开：

- 检查防火墙是否放行 `3210`
- 确保 `.env` 里 `HOST=0.0.0.0`

## 5. 手机访问（Tailscale，推荐外网）

## 5.1 安装

- 电脑端：安装并登录 Tailscale（[官方下载](https://tailscale.com/download)）
- 手机端：安装 Tailscale App（iOS/Android）并登录同一账号

## 5.2 连接

电脑端确认在线：

```bash
tailscale status
tailscale ip -4
```

拿到电脑 Tailscale IP（如 `100.x.x.x`）后，手机访问：

`http://<tailscale-ip>:3210`

建议 `.env` 开启仅 Tailscale 访问：

```env
TAILSCALE_ONLY=true
```

## 6. 生产部署（PM2）

安装依赖后，直接用内置脚本：

```bash
npm run service:start
npm run service:status
```

常用命令：

```bash
npm run service:restart
npm run service:stop
npm run service:logs
npm run service:list
```

## 7. 自启动

### macOS（launchd）

```bash
npm run launchd:install
npm run launchd:list
```

卸载：

```bash
npm run launchd:uninstall
```

### Windows

可用任务计划程序在登录后执行 PM2 恢复。

## 8. 常用配置（.env）

最常用：

```env
HOST=0.0.0.0
PORT=3210
ACCESS_TOKEN=your-strong-token
TAILSCALE_ONLY=false
TRUSTED_CIDRS=
CODEX_BIN=codex
CODEX_MODEL=
CODEX_PROFILE=
CODEX_FULL_ACCESS=true
CODEX_NO_ALT_SCREEN=true
CODEX_EXTRA_ARGS=
DISPLAY_TIMEZONE=Asia/Shanghai
```

说明：

- `TAILSCALE_ONLY=true`：只允许本机 + Tailscale 网段访问
- `TRUSTED_CIDRS`：自定义白名单网段（逗号分隔）
- `CODEX_MODEL`：默认模型

## 9. 常见问题

### Q1: 登录提示 `Cross-origin request rejected`

使用 `npm run dev:up` 启动，前后端配套开发模式已处理本机跨端口校验。

### Q2: 5173 打不开

先重启开发服务：

```bash
npm run dev:up
```

再检查端口：

```bash
lsof -iTCP:5173 -sTCP:LISTEN -n -P
lsof -iTCP:3210 -sTCP:LISTEN -n -P
```

### Q3: 手机能打开但提示“电脑未连接”

- 确认电脑端服务在线（`service:status`）
- 确认手机和电脑在同一网络路径（同 Wi-Fi 或同 Tailnet）

## 10. 开源协作

- License: [MIT](./LICENSE)
- 贡献指南: [CONTRIBUTING.md](./CONTRIBUTING.md)
- 安全策略: [SECURITY.md](./SECURITY.md)
- 行为准则: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

