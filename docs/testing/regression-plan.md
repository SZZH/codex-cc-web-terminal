# Regression Plan

Last updated: 2026-04-14
Status: active
Owner: backend

这份矩阵用于约束后续后端拆分时的回归范围。目标不是只测 happy path，而是保证目录重组、公共逻辑抽离、provider 拆分后，现有功能行为保持不变。

## 已落地的可执行测试

- `tests/koa-app.test.js`
  - 登录成功/失败
  - 登录限流封禁与窗口恢复
  - 认证会话续期（TTL 刷新）
  - 未登录访问受保护接口
  - 跨域登录拦截
  - session CRUD 路由代理
  - 复用同 `provider + resumeSessionId` 的 live session
  - 健康检查公开访问
  - 重启保护（`shuttingDown`）对非健康接口返回 503
  - 文件浏览接口
  - 非法路径与非法 JSON 返回 400
  - 历史会话相关路由代理
  - history 资源风格路由（`/api/history-sessions/:provider/:resume/messages`）
- `tests/ws.test.js`
  - 未授权 ws 握手拒绝
  - 已授权 ws 握手成功
  - 未信任 Origin 拒绝
  - session 不存在时拒绝
  - input / resize 消息转发
  - 非法帧 payload 返回 `error` 消息
- `tests/session-manager.test.js`
  - provider 目录暴露
  - 非法 provider 创建失败
  - Codex live session 创建
  - `findRunningLiveSessionByResume` 选择最新运行会话
  - app-server 回包写入 buffer
  - 自动命名
  - 手动重命名持久化
  - 历史会话扫描 / 解析 / 归档 / 恢复 / 删除
  - 缺失历史会话时报错路径
  - `listAll` 对 live/history 同 resume 去重
  - provider 命令构建
  - Claude auto-named 场景不注入 `--name`

## 建议测试入口

- 全量后端回归（推荐）
  - `npm run test:backend:all`
- 路由 + ws 快速回归
  - `npm run test:backend:http`
- `SessionManager` 子域回归
  - `npm run test:backend:session`

## 重构完成后必须补跑的回归点

- 认证与安全
  - Cookie 续期
  - 登录限流窗口与封禁恢复
  - `trustedCidrs` / `tailscaleOnly` 行为
  - `Origin` 白名单
- 运行时 HTTP 能力
  - 请求体大小限制
  - 非法 JSON 处理
  - 静态资源查找顺序
  - 缺失前端构建时的首页兜底行为
- Live Session
  - `findRunningLiveSessionByResume`
  - `json_exec` 队列消费
  - app-server 通知流增量消息
  - shell / pty exit 后状态刷新
  - ws snapshot 内容完整性
- Historical Session
  - 图片消息恢复
  - 标题候选与摘要候选提取
  - Codex `session_index.jsonl` 缓存命中/失效
  - 临时目录与非 CLI 会话过滤规则
- Claude 特殊行为
  - 启动阶段自动确认
  - `--resume` 与 `--name` 参数分支

## 建议执行顺序

1. 每次拆出一个子模块后先跑对应专项：`npm run test:backend:session` 或 `npm run test:backend:http`。
2. `sessionManager` 大拆阶段，每次提交前都跑 `npm run test:backend:session`。
3. 路由或 runtime 变更后，必须跑 `npm run test:backend:http`。
4. 当天重构收口前，统一跑 `npm run test:backend:all`。
