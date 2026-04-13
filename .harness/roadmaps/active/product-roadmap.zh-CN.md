# Codex Web Terminal 产品路线图

Created: 2026-04-13
Status: active
Owner: maintainers
Source: roadmap
Exit Condition: 当该路线图被完整执行、明确废弃，或被新路线图替代时，迁移到 `.harness/archive/completed/`、`.harness/archive/abandoned/` 或 `.harness/archive/superseded/`
Supersedes:
Superseded By:

基于两个竞品项目做出的当前版本路线判断：

- [`remodex`](/Users/jiaojian/Desktop/self/remodex) 更像“Codex 专用遥控器”
- [`hapi`](/Users/jiaojian/Desktop/self/hapi) 更像“多 Agent 远程协作平台”
- 本项目当前阶段更适合优先吸收 `remodex` 的产品骨架，再择机补 `hapi` 的平台能力

## 核心判断

- 先把产品做成“顺手、聚焦、像成品”，不要一上来做成“大而全的平台”
- 先做单一 Codex 工作流最常用的高频能力
- 先收敛运行时配置和控制权切换，再扩展语音、工作区隔离和更多 Agent 抽象

## P0：立刻做

这些能力优先级最高，应该作为下一阶段的主线：

1. 统一 composer runtime 配置层
   - 统一管理模型、推理强度、权限模式
   - 不要把这些状态分散在按钮和页面局部状态里

2. 权限模式切换
   - 第一版先做少数几档
   - 建议优先采用接近 `on-request / full-access` 的收敛模型

3. 模型切换
   - 做成高频显式入口
   - 与当前会话状态绑定

4. 推理强度切换
   - 与模型联动
   - 当模型变化时自动约束可选 effort

5. 图片附件
   - 第一版仅支持图片
   - 优先支持粘贴、选择图片、移动端上传

6. 本地 / 远程控制权切换
   - 参考 `hapi` 的 session handoff 思路
   - 保持会话不断、上下文不丢

## P1：下一阶段做

这些能力适合在 P0 稳定后推进：

1. Git 分支切换
   - 先做基础 branch switch
   - 暂不直接上完整 worktree handoff

2. 运行上下文展示
   - 当前 repo
   - 当前 branch
   - 当前模型
   - 当前权限模式

3. 语音输入
   - 先做“语音转文字发 prompt”
   - 优先参考 `remodex` 的轻量路径

4. 批权限交互优化
   - 手机端或网页端快速 approve / deny
   - 提供明确的结果反馈

## P2：后续演进

这些能力价值高，但复杂度明显更高，应延后：

1. Worktree 创建与 handoff
   - 适合在基础 Git 能力稳定后推进

2. 通用文件上传
   - 后续再扩展到 PDF、文本、代码文件等

3. 多 Agent / 多模型统一平台
   - 更接近 `hapi` 的平台方向
   - 不适合作为当前阶段主线

4. 独立语音助手
   - 类似 `hapi` 的 ElevenLabs 语音助手链路
   - 依赖更多、链路更长、维护成本更高

## 当前阶段不要做

- 不要一上来照搬 `hapi` 的 `CLI + Hub + Web` 全平台抽象
- 不要一上来做过多 permission mode
- 不要一上来把 branch、worktree、handoff、team state 全部做齐
- 不要一上来做独立语音助手
- 不要一上来做任意文件上传与复杂预览

## 推荐开发顺序

1. runtime 配置层
2. 模型切换
3. 推理强度切换
4. 权限模式切换
5. 图片附件
6. 本地 / 远程控制权切换
7. Git branch
8. 语音输入
9. worktree

## 竞品参考结论

### 更应该优先学 `remodex` 的部分

- 单一 Codex 产品下的 runtime 配置
- 权限切换
- 模型与推理强度联动
- 图片输入
- Git / worktree 的执行边界

### 更应该择机吸收 `hapi` 的部分

- local / remote 控制权切换
- session handoff
- 平台化同步思路
- 后续多 Agent 扩展的抽象方式

## 一句话结论

前 30 天优先目标不是“做成 `hapi` 那样大”，而是先把本项目做成“像 `remodex` 一样顺手、聚焦、像成品”。
