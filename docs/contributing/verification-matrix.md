# Verification Matrix

Last updated: 2026-04-14
Status: active
Owner: maintainers

## Goal

明确不同类型改动的最低验证要求。

## Baseline Checks

- `npm run check`
- `npm run test:backend:http`
- `npm run test:backend:session`
- `npm run test:backend:all`

## Matrix

### 文档改动

最低要求：

- 检查入口链接是否同步
- 检查引用路径是否有效

### 后端逻辑小改

最低要求：

- `npm run test:backend:session`

### 路由 / runtime / ws 改动

最低要求：

- `npm run test:backend:http`

### 后端结构重构

最低要求：

- `npm run test:backend:all`
- `npm run check`

### 前端改动

最低要求：

- `npm run check`

### 配置 / 脚本 / 服务管理改动

最低要求：

- `npm run check`

## If A Required Check Cannot Run

必须记录：

- 哪个检查没跑
- 为什么没跑
- 风险是什么

## Default Rule

如果不确定该跑哪组验证，默认执行：

- `npm run test:backend:all`
- `npm run check`
