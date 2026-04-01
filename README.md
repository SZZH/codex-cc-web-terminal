# Codex Web Terminal

只做一件事：把你电脑上的 `codex` 会话放到浏览器（含手机）里用。

当前仅支持 **Codex**。

## 1 分钟本地跑起来

```bash
cd /Users/jiaojian/Desktop/self/codex-cc-web-terminal
npm run setup
```

`npm run setup` 会交互式引导你完成：`.env` 配置、可选 Tailscale、安装依赖、启动服务。

或手动执行：

```bash
cd /Users/jiaojian/Desktop/self/codex-cc-web-terminal
cp .env.example .env
# 把 .env 里的 ACCESS_TOKEN 改成你自己的
npm install
npm run dev:up
```

打开：

- 前端（推荐）：`http://127.0.0.1:5173/#/sessions`
- 后端直连：`http://127.0.0.1:3210`

## 手机访问（两种）

### A. 同一 Wi-Fi

1. `.env` 确认：`HOST=0.0.0.0`
2. 手机打开：`http://你的电脑局域网IP:3210`
3. 用 `ACCESS_TOKEN` 登录

### B. Tailscale（外网推荐）

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
npm run dev:up         # 开发模式（前端热更新）
npm run dev:down       # 停止开发服务
npm run check          # 快速自检
```

## 三个高频问题

1. `Cross-origin request rejected`
- 用 `npm run dev:up` 启动，不要手动拆开前后端起。

2. `5173` 打不开
- 先执行 `npm run dev:up`，再看端口：
```bash
lsof -iTCP:5173 -sTCP:LISTEN -n -P
```

3. 手机提示“电脑未连接”
- 先确认电脑服务在线：`npm run service:status`
- 再确认网络路径正确：同 Wi-Fi 或同 Tailnet

## 开源说明

- [LICENSE](./LICENSE)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
