# Regression Plan

Last updated: 2026-10-19
Status: active
Owner: backend

这份矩阵用于约束后续后端拆分时的回归范围。目标不是只测 happy path，而是保证目录重组、公共逻辑抽离、provider 拆分后，现有功能行为保持不变。

## Codex V2 主链路

当前行为以 [V2 聊天契约](../refactoring/codex-chat-v2.md) 为准。下方旧 session/SSE/PTY 测试继续保护兼容层；Codex 主聊天需额外覆盖：

- `app-server-interactions`、`codex-interactions`、`codex-interaction-routes`：五类原RPC、原socket代次/typed id/多approvalId、早于ACK/null-turn/无observer、单次claim/同答幂等/多端冲突、resolved/断线/终态失效、身份/跨源/大小限制；available内嵌规则权威及伪造拒绝，权限子集与deny保持，secret不进事件/日志/磁盘，未知只核对不重放。
- `codex-interaction-state/runtime/ui`：WS门禁与旧快照、刷新/重连/前台、秘密答案内存清理、普通草稿/附件和发送屏障；自由输入/选项/跳过、所有原决定、高级操作可达、标准表单0/false/缺席/空枚举、URL与设备能力边界、resolved自动撤去。SFC生成答案须通过真实后端校验；复杂schema不得伪accept。
- `codex-manual-review`、`codex-interaction-thread-options`：四模式存储及旧三模式参数、supported策略+approval解码、unsupported限制保持、desktop无全局写、CC/json_exec拒绝；V2 create/resume普通模式问答config与原模型/reasoning/权限保持。原生问答/批准/取消后继续另有隔离实证，不能以fakeWS替代。
- `codex-read-cancellation`：初始化含metadata/turns/requests/interactions四条读取，全数取消并清期限；发送POST不随读取卸载中断、不重复，迟到结果/草稿/unknown归属保持。真实IAB另核对1280/390/320短屏、长表单内部滚动、动作与普通草稿可达、输入宿主恢复113px；原生设备proof与真实手机软键盘不由这些绿测试证明。

- `tests/codex-v2-history.test.js`、`tests/codex-v2-presentation.test.js`：只读分页、cursor/after、长轮主项、旧 canonical output diff、宿主截图包装、同文不同 ID、图片媒体与预览上限。
- `tests/codex-v2-requests.test.js`、`tests/codex-v2-service.test.js`、`tests/codex-queued-writer.test.js`：回执持久化与同 ID 幂等、unknown 恢复、按线程排队、steer 目标与竞态、显式 interrupt、writer 冲突转桌面队列及 clientId 对账、终态和迟到事件。
- `tests/codex-v2-routes.test.js`：V2 HTTP/WS 认证与 Origin、稳定 threadId 订阅、断点与缺口恢复、历史/媒体端点、after 透传。
- 桌面队列回归包含模型/权限覆盖值拒绝、按官方队列 ID 撤回及已领取时冲突、后发消息保持顺序、重启后按 clientId 分页核对。
- `tests/codex-chat-store.test.js`、`tests/codex-chat-runtime.test.js`：单状态与读取竞态、草稿/未确认请求恢复、可见历史自动补读及并发上限、最新轮增量尾读、旧轮终态复用、自动核对、跨线程/旧 socket 隔离与实际组件挂载交互。
- `tests/codex-read-refresh.test.js`、`tests/codex-runtime-errors.test.js`：metadata/turns/回执错误独立、有效响应与迟到代次、稳定回执下的历史自动恢复；固定动作归属、目标 ID、成功清理和旧成功不清新失败；真实连接构造失败的 2 秒重连与 HTTP 退避分别验证，卸载清零。
- `tests/codex-item-hydration.test.js`、`tests/message-stream-scroll.test.js`：双槽按页让出、显式展开优先及所有优先级的 FIFO 有界进展；展开增长的阅读位置、旧强制回调、真实回底和 1000ms 连续惯性、同手势反向、静止/布局负例及上下文/卸载。
- `tests/app-viewport.test.js`、`tests/session-list-position.test.js`、`tests/session-list-ui.test.js`、`tests/preview-ui.test.js`：共享可视高度与顶底偏移、小数/零值、样式 priority 恢复与卸载后旧回调；列表元素自身的坐标/范围/根相对锚点、两模式与搜索分页往返、认证对象及即时代次隔离，预览受控滚动主体与原服务/焦点契约。CSS 是否可达另由真实浏览器核对。
- `tests/app-server-request.test.js`、`tests/codex-v2-read-cancellation.test.js`：真实桥接单ID取消、序列化/send/回复/错误/超时/reset竞态首次结算；HTTP读独立signal、共享ready waiter、五类历史GET及正常req.close/finish/keepalive、缓存/两段detail/legacy/图片、迟到transport、对账与JSON边界。未绑定写/后台/其他客户端独立，pending/deadline/listener无残留；本地退出不代表远端中断。
- `tests/api-auth.test.js`、`tests/thread-item-refactor-contract.test.js`：登录拒绝不递归恢复或误发过期事件，受保护请求仅恢复一次；身份检查/自动登录的迟到结果不能恢复旧身份，瞬时错误保留 token；普通、历史及流式旧请求的 401 或旧凭据恢复不能踢出新登录。
- `tests/api-read-deadline.test.js`、`tests/codex-chat-runtime.test.js`：认证、配置和线程设置 GET 保留 15 秒总期限；目录 GET 独立验证 30 秒连续无进展和 120 秒总上限，覆盖 headers 超过 15 秒、持续 JSON/NDJSON 字节进展、停滞、零字节与持续进展触达总上限。headers/成功与失败 JSON/一次认证恢复和重读共用原始预算；preabort、中途取消、迟到 resolve/reject 不重开总期限、不发失效事件、不重试旧请求。成功/失败移除 timer/listener并结束未消费的所属传输；外部 signal、非目标 GET 和业务写入不被新期限接管。认证超时挂载登录与错误、保留凭据且不立即自动登录；真实 HTTP 另核对未结束 401/login 正文的连接释放。
- `tests/codex-submission-feedback.test.js`、`tests/codex-chat-runtime.test.js`：真实反馈组件及挂载提交进度、当前本地失败归属、阻塞 unknown 优先、多条原 ID 核对、重开/其他客户端/旧错误负例；store 权威更新消除旧错误，切 context 后迟到结果不污染。恢复原文/原图/设置不覆盖新稿，输入区和 footer 共享 busy、重复点击不重放；manual dismiss 保留 unknown 和重复风险。实际浏览器另核对上翻后状态与动作可见、长错/长稿局部滚动、阅读位置和 document 范围，不能用 renderer 几何替代页面验证。
- `tests/session-runtime.test.js`、`tests/codex-chat-runtime.test.js`：目录未完成时列表/正文仍可读取，线程设置及回执读取未完成或首次读取失败时禁止发送；坏回执结构不当作空列表，成功重试可解锁；共享配置的 60 秒新鲜度、强制刷新、失败重试和跨登录隔离；目录迟到不覆盖设置或附件，旧 CC 继续等待配置。分组新增线程在目录缺失/陈旧时仍由服务端实时默认决定，客户端不发送占位覆盖；旧会话升级保留已有的明确设置。

真实隔离会话验收需检查首发、多轮记忆、刷新重进、断线和重启、运行中排队/引导/停止、同轮多个 user item、失败消息恢复、文件 diff 和图文/纯图。待发送消息应在时间线内显示为普通用户消息，官方 user item 到达后按身份接替，不产生重复卡片；网页本地未派发请求可转引导，桌面官方队列不可由网页引导。同轮多次用户输入、摘要回填与迟到回执不能颠倒问答。空思考不产生空卡片，展开过程自动补读详情，完整详情清除旧截断状态。桌面 owner 的已持久化说明消息和工具项应在 turn 完成前逐项出现，单条消息无 token delta 时不得制造假流式；空增量页不能导致反复从头下载。桌面 owner 冲突需验证同 threadId 入队、执行、历史对账及断线不重发；未加载和无完成时间的伪中断不能把排队视作完成。这里只记录验收范围，不代替实际运行结果。

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
- `tests/cc-provider-spawn.test.js`
  - 通过真实 `SessionManager.create` 和 PTY 替身检查自动/显式命名、新建/恢复的实际 argv
  - 名称及重命名仍保存在元数据和自定义名称存储中；模型、resume、权限和显式 `CC_EXTRA_ARGS` 保持
- `tests/thread-composer-state.test.js`、`tests/koa-app.test.js`
  - CC 与 claude 别名使用自身 provider 默认模型，空模型不继承 Codex 默认值
  - CC 不读取 Codex 桌面/线程配置；live、显式覆盖、cwd 和 `git=0` 合同保持
- `tests/composer-runtime.test.js`、`tests/session-runtime.test.js`、`tests/codex-chat-runtime.test.js`
  - CC 新 live、历史重开与冷恢复的实际序列化 input/resume 保留空模型或自身默认模型
  - 明确空模型清除旧回退；晚到配置不能污染 CC，Codex 默认行为及原用户选择/附件保护保持
- `tests/sidebar-payload.test.js`、`tests/koa-app.test.js`
  - br/gzip/identity完整解码字节、跨编码弱ETag及304空体，legacy/compact与runtime隔离，内容及活动变化失效
  - 常见浏览器编码顺序、质量优先、大小写Q、通配、显式拒绝、无头；全部禁止带有效ETag仍406/no-store，无成功ETag/编码头，认证失败仍优先401
  - 原请求/接受器不变；同正文的编码并发共用，失败保留原错误并可重试，旧失败不驱逐新对象，304不产生压缩；升级Koa/accepts需复核局部接受器适配
- `tests/sidebar-progressive.test.js`、`tests/session-sidebar-stream.test.js`、`tests/session-list-sync.test.js`，以及既有 runtime/List/App 用例
  - 精确 opt-in、JSON fallback、同快照冻结、组成员/顺序/别名/完整预览及真实计数；br/gzip/identity首行独立解码、完整尾帧等价、安全头/认证/406/304、双槽溢出/替换、真实慢接收反压、头前/头后故障与取消清理
  - 分块UTF-8、协议/引用/计数/顺序、尾帧加正常EOF才成功；截断/多帧/错版本拒绝并释放reader；鉴权恢复及两帧共享120秒总上限，非空字节刷新30秒停滞计时，晚回调不发布
  - partial/full显式状态、首批失败保留、完整重试、degraded空/非空尾帧、原暖JSON；实际App/List首批可打开、真实计数、更多/写禁用、查询不报局部或假空、完整后末条preview搜索；可见错误为单句中文且cause/code/status/同飞错误身份保留
  - 隐藏周期零读取、恢复可见立即单飞、SSR/停止/新owner/旧回调；默认stop保留在途，内部离开仅取消冷未完整GET，重进/认证失效与旧finally隔离
  - 实际浏览器另核对首批与失败/恢复、桌面/390内部滚动和正式代理首帧/全量分别计时；不能以字节比例代替页面速度

## 建议测试入口

- CI 与提交前检查：`npm run check` 和 `npm test`，分别验证语法/前端构建与全部回归用例。
- `npm ci` 使用已提交锁文件安装依赖；`package.json` 必须保持与锁文件中的 Vue/Koa 项目依赖一致。
- 时间窗口测试使用固定时钟，不依赖执行当天日期；配置样本遵循实际桌面端 JSON 层级。
- 增量协议用例断言版本、线程与 turn 身份和消息内容，不要求已移除的全历史快照字段。
- 桥接权限覆盖新建/续聊策略、未获处理审批的拒绝，以及显式中断；控制用例覆盖取消竞态和失败反馈。
- 输入设置覆盖模型能力联动、无推理模型、首次打开新会话、跨线程迟到请求、连续选择、失败回滚与发送保存屏障。
- 线程设置用临时 SQLite 验证独立权限、重新打开和省略字段续聊，断言桌面全局设置未改变；执行验证检查真实 bridge 参数和 CLI 参数。
- 历史缓存用合成 JSONL 统计读取次数，覆盖首次解析、重复访问、单文件追加、新增、删除、同大小替换、索引标题变化及扫描中写入；不变文件不得重复解析。
- 工作区故障替身在 fixture 准备阶段完成纯就绪握手，再开始业务故障预算；握手不执行 Git 或写工作区。真实读取/写入 deadline 用例保留，写入不确定性在实际写标记后触发中断，避免把尚未开始的写误当 unknown。文件路径覆盖 literal magic、首尾空格、rename 和子目录；文本补丁覆盖多 hunk 实际匹配漂移、零上下文插入、正文末行空格和正反恢复。

## 关键功能验收

| 范围 | 自动回归 | 真实验收要求 |
| --- | --- | --- |
| 桌面侧栏 | `codex-sidebar`、`sidebar-read-runtime`、`session-list-ui` | 按项目 ID 核对名称、顺序、成员、置顶与最近；同名项目不按路径合并。SQLite 锁等待不阻塞无关 HTTP/WS；稳定版本不重复 SQL/JSON，WAL-only、global 更新、checkpoint、删除/替换均失效；迟到发布、失败回退/恢复和关闭取消保持身份 |
| 会话搜索与反馈 | `session-list-ui`、`session-list-position`、`session-runtime`、`codex-chat-runtime` | 标题/路径/项目及多词匹配、中文 IME、Escape 清空和焦点、隐藏旧会话、分组/最近活动分页；返回保留查询及手动展开/分页，并在内容提交后一次恢复稳定行偏移；缺项/缩短列表钳制，查询/模式/即时认证路由、用户操作及卸载取消旧恢复，轮询不反复滚动。身份变化清空，旧实例不污染新对象。首次 pending 或冷空降级不报空，暖降级保留目录身份，首个非空 fallback 带提示，重试/正常恢复清错；旧认证失败不覆盖新状态 |
| 列表传输 | `sidebar-payload`、`sidebar-progressive`、`session-sidebar-stream`、`session-runtime`、HTTP 侧栏缓存 | 默认与 compact 解码后语义相同；opt-in首批/尾帧同快照、真实counts与完整搜索，只有尾帧和EOF确认完整；坏引用/截断保留可用目录并重试。原JSON/ETag/鉴权与编码保持，真实前缀解码、反压、双槽和取消故障恢复；公网分别记录首批/完整时间，不裁字段 |
| 按需目录 | `session-catalog-pages`、`paged-session-catalog`、`session-list-ui` | 初始20条brief无完整preview、全量预览NFKC AND搜索、别组同cwd/alias成员与活动去重；HMAC上下文、快照冻结/过期和409恢复、loaded安全整数按实际快照钳制。超过1000条单组/2000条累计仍可刷新续页；空活动列表发现新记录；250ms搜索窗口往返对齐查询、旧timer零重复。真实App分页/返回位置/身份隔离，真实Observer屏外与折叠零读取、进入才取 |
| 按需正文 | `codex-item-hydration`、`codex-history-items`、`codex-chat-runtime`、`codex-read-cancellation` | 摘要不自动使整页可见；最新/活动、真实可视与展开才补详情；离屏停续页、排队读取与自动重试，重新进入恢复断点。显式10轮可见时仍验证5000 items完整、170页、并发上限2与取消压力；真实组件事件经线程身份隔离。浏览器另记录初始/滚动后的items请求，不以屏幕外DOM存在冒充已下载详情 |
| 自动分页 | `message-stream-scroll`、`codex-chat-runtime`、`session-list-ui` | 历史真实上行触顶，80/30/6px不提前读、到0才读；列表末尾真实下行意图。初次定位不触发、单飞、无新意图不连续取页、失败只手动重试。前插偏移与context/intent保护、同次触摸/滚动条反向回底、忙期间触底恢复及错误清waiting、相同错误文案按真实owner隔离；键盘输入区不触发列表分页 |
| 按需附属数据 | `workspace-changes-panel`、`thread-item-markdown`、`model-catalog` | 屏外工作区面板零自动Git读取、历史摘要/稳定观察锚点/卸载清理、cwd与写入竞态；parser首次renderMarkdown才创建且原代码高亮/链接/图片/表格输出保持。完整模型缓存SWR不阻塞热读、单飞刷新、失败保留与冷读真实能力 |
| 静态传输 | `frontend-assets` | gzip/br 解码一致、协商与 406、304/HEAD；旧构建或过期侧文件安全使用原文；仅内容指纹文件长期缓存，HTML/私有图片不缓存；缺失 API/资产为 404 |
| 视口与布局 | `app-viewport`、真实 App/Chat/List/Preview | document 横纵范围为0，列表/消息/登录/提示区域内部能到达末尾；小数、visualViewport 缩小/偏移/零值与卸载恢复分别验证。实际320×240、320×480、390×844、959/960×540、1280×720覆盖短屏登录、长列表、长消息/35行草稿、弹层与宽窄预览；输入宿主不被压缩、工具可聚焦，长错误Tab到重试并恢复，不能靠裁剪假装无溢出。Node几何不等于物理键盘或CSS像素 |
| 路由资源加载 | `async-view`、`critical-composer` | 预取/挂载共享成功、pending与失败；代码待载立即显示status，API先完成也不空白，成功或失败替换状态，切路由及卸载后迟到结果不插回。当前路由在auth期间只拉静态代码，初始未解析不猜测。使用真实安装Vite与Vue验证共用CSS pending/失败跨视图、Codex-first与Chat-first、独立模块并发和实际App dependsOn接线；真正消费前不读业务API。旧路由/身份与未flush卸载窗口不reload新页面；JS/CSS受限恢复、永久失败可见alert与手动重新加载、无关列表/登录隔离。实际浏览器另验证样式尺寸、HTTP故障和受控冷开时间线，不能以Node探针代替布局或LCP/INP |
| 历史传输 | `codex-read-json-transfer`、`codex-v2-routes` | 只压缩鉴权后的三个成功历史 GET，保留 no-store/安全头；UTF-8 8 KiB 边界、surrogate 跨块及大于 4 MiB 正文逐字节解压；q=0/wildcard/identity 禁止、406/忙时 503 与完整原文降级；每 runtime 两槽、反压、头前/头后取消和故障后容量恢复。慢接收端 socket EPIPE 日志与数据/资源结果分别记录 |
| 首发与续聊 | `session-runtime`、`critical-composer`、`codex-read-cancellation`、`codex-chat-store` | 独立 A/B 会话，多轮记忆、切换与迟到隔离；旧上传成功/失败及迟到 POST 结算不覆盖新稿、图片或其他新请求，后续打字不回退迟到回执，存储失败不伪装持久化成功。离开取消 GET 和队列/计时器，保留唯一 mutation 及回执 |
| 增量与历史 | `streamed-text`、`history-merge`、`paginated-history` | 正文逐字一致；刷新后不漏尾、不重复；不同官方 turn 不按相同提示词合并 |
| Markdown 流式渲染 | `thread-item-markdown`、`thread-item-renderers`、`markdown-images`、`markdown-links`、`codex-v2-presentation` | 同文对象更新不重复 Markdown 或 process 高亮/清洗；独立语言 primitive 稳定，源码/语言变化、权威重写和 cwd 变化及时失效。fence 缓存最多 8 项/256 KiB 保留字符串，长内容不裁剪，失败不缓存，实例与 item 身份隔离及卸载清理。比较实际 Vue/typed 链次数和完整原始输出；实际浏览器另核对真实 DOMPurify、图片、链接、安全属性、流式输入草稿和窄屏，不能用 identity sanitizer CPU 基准替代清洗/布局或 INP |
| 预览返回归属 | `preview-ui`、`session-list-ui` | 同页关闭恢复原窗口、显式data-app-scroll元素及焦点；跨route/auth或App卸载只失效书签/旧恢复，不改面板、pending、ACK或服务释放。快速开关、逃逸RAF/微任务不覆盖新页；新文档重新捕获owner，同页切目标/重试保留opener。实际深列表进入聊天、开预览、返回列表再关闭，元素偏移保持；原生Escape/Tab与locator自动聚焦滚动分开核对 |
| 长历史分页 | `codex-history-items`、`codex-item-hydration`、`codex-chat-runtime`、`codex-v2-history`、`codex-read-cancellation` | 首读/cursor/after 显式 limit=30，cursor 优先且锚点独占；真实 HTTP 10×500 typed items 恰170页、双槽逐页释放，逐项核对身份/顺序/正文/clientId/diff。持续显式 boost 时实际 FIFO 队首最多被绕过两次，最新/普通/多个展开方均进展；503、坏 cursor 保留部分页且可恢复，刷新合并/WS/最终详情及 dispose 清理保持。浏览器核对展开首读时间线、完整顺序、草稿和窄屏，不把合成延迟等同手机性能 |
| 读取与动作恢复 | `codex-read-refresh`、`codex-runtime-errors`、`codex-chat-runtime` | 稳定回执不能掩盖首次历史503；metadata/turns独立失败与坏200、当前成功恢复、手动/自动重试及精确退避。唯一读取重试在可见输入状态旁，历史只保留分页；busy/防重复、目录不阻塞设置、旧目录成功不清新失败和跨context隔离保持。普通动作错误不单独给连接操作；成功只清自身错误，无mutation重放。完整App在390×844/320×480核对新稿阻止覆盖、完整原文/原图片恢复、unknown独立再次核对及原received ID引导，自动轮询额外404单独记录，不把绝对次数当合同 |
| 服务端读取消 | `app-server-request`、`codex-v2-read-cancellation`、`codex-v2-routes` | 异常response close/已destroyed退出，正常GET req.close/finish与keepalive不误取消；preabort/共享ready/冷metadata/缓存/详情两阶段/媒体/兼容分支边界，晚结果不入cache、不追加RPC/对账/JSON。真实bridge+fakeWS并存正常客户端、后台和fake写仍完成；只清自身ID/pending/timer/listener，未知晚reply隔离。保持rpcError/uncertain和开放响应真实错误，不用turn interrupt或重启WS；不把合成计数当真实远端取消/生产容量 |
| 滚动与长会话 | `message-stream-scroll`、`codex-chat-runtime`、`codex-v2-presentation`、`codex-chat-store` | 初读/图片增长跟随；上翻或显式展开后，分页/流式/输入尺寸及旧强制回调不夺位。真实回底及连续1000ms惯性恢复，同手势反向暂停；4/5px/水平过滤、静止750ms、无位移/布局负例、context/reset/dispose保持。实际浏览器核对61项补齐前后标题偏移、完整HTML、正常贴底与390px；Node几何不代表物理手机触摸。草稿不重跑历史投影，内容/排序/详情继续失效 |
| 图片 | `image-attachments`、`markdown-images`、HTTP 图片代理 | 图文、纯图、模型回复本地图片、预览及刷新；GIF MIME、认证、非法文件和大小限制 |
| 图片预览生命周期 | `image-lightbox`、`codex-chat-runtime`、真实 ImageLightbox | Markdown/缩略图入口、原生 modal/inert、Tab/Shift+Tab/Escape/背景/按钮单次关闭；多触点2→1/1→2/cancel和1..4缩放，放大后关闭按钮不被图片或手势覆盖。显式opener与native origin不同、opener移除/禁用、新modal/有效焦点及卸载迟到分别核对，preventScroll保持阅读位置。真实浏览器检查320×240、390px、桌面与非零可视偏移；受控visualViewport不冒充手机键盘 |
| 元信息进行中共享 | `codex-metadata-reads`、`codex-v2-read-cancellation`、真实reader/bridge/HTTP | 重叠fresh/缓存/后台共享，显式GET仍刷新、2秒/64值缓存不变；各waiter独立取消、最后waiter同步清pending、共享ready存活、failure/timeout/disconnect重试；remember/eviction/新旧entry保护发布。逐项核对raw/presentation、身份、顺序和完整分页，终态inflight/pending/timer/listener为0；RPC计数不当作生产速度 |
| 设置 | `model-catalog`、`managed-permissions`、`thread-composer-state`、`composer-runtime`、`codex-chat-runtime` | 当前模型实际运行；模型/思考/权限重开与重启保存；自定义窄权限禁止自动扩大。首次失败重试建立有效服务器基线，期间用户权限/effort 修改仍为显式 override；旧成功不清新读取或 PATCH 失败，当前恢复才能解锁；旧布尔契约兼容 |
| 输入弹层 | `composer-popover`、`critical-composer`、`codex-chat-runtime` | 真实浏览器打开聚焦、背景 inert、原生 Escape/图标/backdrop 关闭与入口恢复；设置切 Git 仅一个弹层，运行结束关闭后草稿保留且输入框获焦。自动测试覆盖延迟旧事件、入口随后移除/禁用、新弹层和卸载保护；390px 无横向溢出，浏览器 chrome 的 Tab 导航不算背景穿透 |
| 预览键盘归属 | `preview-keyboard`、`preview-ui`、真实PreviewHost/ChatComposer | 背景预览旁打开原生设置，首个Escape只关闭设置，preview open/url/status/revision、草稿及服务grant保持，后续Escape关闭预览且只释放一次；已有defaultPrevented事件不重复消费，顶层Tab/ShiftTab不被窄屏preview拦截。桌面设置打开后缩窄并关闭，焦点回可见预览，外部/body/null Tab、focusin及断点回调不留隐藏背景控件；iframe身份、桌面输入、新native modal和hasFocus=false保持。覆盖compact排队后回桌面/close/unmount的负例与capture监听清理；Node原生替身与实际浏览器默认cancel分别验证 |
| 停止和恢复 | `session-control`、`session-runtime` | 收到增量后停止，再发下一轮；后端重启旧 live ID 重绑定且不重发提示词 |
| 发送结果核对 | `codex-read-cancellation`、`codex-chat-store`、`codex-chat-runtime` | 上游先接收而浏览器收到408/5xx时核对原ID，无回执保持unknown不重发；明确其他4xx仍可恢复。客户端快/慢时钟、重开本地unknown及迟到ACK以服务器事实收敛；相同服务器来源保留终态和时间戳保护。已确认执行的GET404/503不降级或产生解锁入口，原unknown仍须再次404才能显式解锁 |
| Git | `process-command`、`workspace-command`、`workspace-jobs`、`workspace-async`、`critical-composer`、HTTP workspace API | 共享执行核心与 workspace 错误类/代码/消息兼容；隔离仓库的分支创建/切换、dirty/config 错误拒绝、unborn/detached、子目录差异与重命名选中还原；同根/重叠写互斥、批次上限、超时/后代清理及三态；慢 Git 同进程 HTTP/WS 响应与设置 git=0；失败只读刷新不重发写 |
| 编辑文件列表 | `workspace-changes-panel` | 默认三条、展开剩余并收起；汇总包含隐藏文件，实时追加保留展开状态，折叠不影响单文件 diff 或全量撤销；写期间追加文件及迟到读取不丢结果或卡按钮，已处理文件不重复撤销，applied/unknown 只读确认且官方历史保留 |
| 文件操作完整页面 | 完整App/真实Panel、workspace route/service、专属临时文件 | 多文件组全量撤销/恢复及单文件组单目标操作，默认3→4行、展开与完整历史保持；实际磁盘字节、Git HEAD及写次数独立核对。真实git apply成功后使下一次只读刷新失败，service生成applied/502，只读确认不能重写；受控unknown明确底层是否写，刷新仍禁写。长路径不撑宽、3996px diff在局部容器横滚；文件预览若grant/viewer合成则明确边界，不能冒称真实预览后端验证 |
| 公网 | HTTP/WS 认证与侧栏缓存用例 | 保持 TLS 验证，双层认证、图片上传和下载、WSS 增量回复；br/gzip 协商、406与鉴权后的 ETag/304；动态200需核对实际ETag/正文变化，分开记录连接/TLS/首字节/正文耗时，不将字节减少等同页面提速 |

真实验收不得用模型 mock 或构建成功替代。测试会话和图片使用独立工作区；不读写用户原会话内容。手机尺寸浏览器验证与真实手机网络验证分别记录。

当前网页没有归档、恢复或永久删除入口。旧历史管理 API 仍基于文件和应用自有归档标记，不能作为新版 Codex 线程管理接口使用；无 rollout 的线程和桌面归档同步尚未兼容，不纳入已通过项。永久删除不得作为日常回归操作。

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
  - `--resume`、网页命名元数据与用户显式额外参数；不自动生成 `--name`
  - 真实兼容 CLI 使用本轮唯一 cwd 和新 session 验证启动；有认证后再核对 assistant JSONL、历史 GET、关闭 live 后不传 model 的冷恢复与第二轮记忆
  - 终端 echo、横幅或会话 running 不代表模型回复；认证/额度/网络错误需分别记录，不能用显式替代模型掩盖默认值路径

## 建议执行顺序

1. 每次拆出一个子模块后先跑对应专项：`npm run test:backend:session` 或 `npm run test:backend:http`。
2. `sessionManager` 大拆阶段，每次提交前都跑 `npm run test:backend:session`。
3. 路由或 runtime 变更后，必须跑 `npm run test:backend:http`。
4. 当天重构收口前，统一跑 `npm run test:backend:all`。
