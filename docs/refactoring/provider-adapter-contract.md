# Provider Adapter Contract

Last updated: 2026-04-22
Status: draft
Owner: backend

## Goal

定义各智能体接入系统时必须遵守的统一适配契约，保证：

- 上游 provider 差异被隔离在 adapter 层
- 核心 projector / snapshot / transport 不依赖特定 provider
- 新增 provider 时改动范围可控

## Scope

本文件覆盖：

- adapter 接口
- capability matrix
- provider registry
- 原始事件到 canonical event 的职责边界

## Non-goals

本文件不覆盖：

- 某 provider 的 prompt 设计
- 某 provider 的计费策略
- provider 具体 API 细节

## Core Principle

provider 是来源，不是系统状态模型。

UI、projector、history、snapshot 均不得直接理解 provider 原始协议。

## Adapter Interface

```ts
interface ProviderAdapter {
  providerId: string;
  capabilities: ProviderCapabilities;
  startTurn(input: StartTurnInput): Promise<ProviderTurnHandle>;
  interruptTurn(handle: ProviderTurnHandle): Promise<void>;
  normalizeEvent(raw: unknown, context: NormalizeContext): CanonicalEvent[];
}
```

## ProviderCapabilities

```ts
type ProviderCapabilities = {
  reasoning: boolean;
  tools: boolean;
  artifacts: boolean;
  interrupt: boolean;
  multiAgent: boolean;
};
```

## StartTurnInput

```ts
type StartTurnInput = {
  threadId: string;
  text: string;
  clientRequestId?: string;
  metadata?: Record<string, unknown>;
};
```

## ProviderTurnHandle

```ts
type ProviderTurnHandle = {
  providerId: string;
  providerThreadId?: string;
  providerTurnId?: string;
};
```

## NormalizeContext

```ts
type NormalizeContext = {
  threadId: string;
  turnId: string;
  providerThreadId?: string;
  providerTurnId?: string;
  nextSeq: () => number;
};
```

## Adapter Responsibilities

- 启动 turn
- 中断 turn
- 读取 provider 原始事件
- 映射为 canonical events
- 维护 provider raw id 与系统稳定 id 的映射

## Adapter Non-Responsibilities

- 直接修改 snapshot
- 直接写历史
- 直接返回 UI 组件数据
- 直接决定页面渲染逻辑

## Provider Registry

建议维护统一 registry：

```ts
type ProviderRegistryEntry = {
  providerId: string;
  displayName: string;
  protocolVersion: string;
  capabilities: ProviderCapabilities;
  adapter: ProviderAdapter;
};
```

## Mapping Rules

- provider 的原始 delta 只能映射成 canonical events
- 不允许新增只属于某一家 provider 的 transport 事件
- provider 若无某能力，必须通过 capability matrix 明确声明

## Error Rules

- provider 原始事件无法识别时，adapter 必须记录调试日志
- 无法识别事件不得直接污染主状态
- adapter 可以选择：
  - 丢弃并记录
  - 降级映射为通用 `tool.progress`
  - 降级映射为 `artifact.updated`

## Interrupt Rules

- 若 provider 支持 interrupt，adapter 必须实现 `interruptTurn`
- 若 provider 不支持，必须在 capabilities 中显式为 `false`
- 上层不得假设所有 provider 都能被中断

## Multi-Provider Thread Rules

- 同一 `threadId` 未来允许跨 provider 继续
- 但每个事件都必须保留 `provider` 元信息
- projector 不得因为 provider 改变而切换状态模型

## Verification

至少需要以下测试：

- codex adapter mapping tests
- provider capability declaration tests
- duplicate raw event mapping idempotency tests
- unsupported capability fallback tests
- interrupt behavior tests

## Risks / Maintenance Notes

- 如果有人绕过 adapter，直接把 provider 原始事件送入 projector，架构会立即失效
- provider 能力差异如果不显式声明，后面会变成隐式 bug
