# 本地文件与网页预览运维

Last updated: 2026-10-27
Status: active
Owner: infra

## 用途

聊天中的本地文件链接、文件变更面板中的文件名，以及明确启动的 loopback 网页服务，可在网页端直接预览。桌面使用侧边面板，手机使用全屏预览；关闭后保留聊天和草稿。文件转换使用 kkFileView 5.0.3，网页请求由独立源网关转发。

本文记录当前 macOS 原生运行方式，以及现有 frp、Caddy 外部访问链路的配置。Office 文档、图片、PDF 和 Markdown 是核心预览场景；Office 使用 LibreOffice 服务端转换，Word/演示文稿使用 PDF，Excel 使用轻量 HTML 表格，减少手机首次加载大型表格编辑器资源。实际格式效果仍取决于文件、字体、打印版式和转换运行时。

## 音视频播放

聊天回复中的 `![视频](output/clip.mp4)`、`![音频](output/voice.mp3)` 显示原生播放器；本地音视频文件链接点击后在现有预览面板中播放。相对路径以会话工作目录解析，支持本地绝对路径和 `file://` 地址。远程 HTTP(S) 嵌入直接由浏览器读取，仍受浏览器混合内容和目标站点限制。

媒体等用户点击播放后才创建来源并请求文件，历史消息不会预加载整段媒体。播放、暂停、进度与视频全屏使用浏览器原生控件，手机使用 `playsinline`；部分手机需要在来源准备完成后再点一次原生播放键。切换来源、关闭面板或移除消息时停止并释放播放资源，文本继续输出不会重建已有播放器。

本地媒体通过已有预览授权生成同源的 `GET/HEAD /api/previews/:id/media`，沿用聊天登录和跨源校验，不需要另一个端口的登录 cookie。创建授权仍要求预览网关就绪；媒体不经过 kkFileView 或 LibreOffice 转码。新窗口入口仍使用隔离预览网关，因此公网访问该入口仍需相应端口可用。

识别视频容器 `mp4`、`m4v`、`mov`、`webm`、`ogv` 和音频容器 `mp3`、`m4a`、`aac`、`wav`、`ogg`、`oga`、`opus`、`flac`。容器扩展名不能保证内部编码可播放，兼容性由浏览器决定；失败时可重试或在新窗口打开、下载播放。服务器流式读取并支持单范围 `Range`、`If-Range`、`HEAD`，不会为播放将整段文件读入内存。

## 前提条件

- 运行 Codex Web Terminal 的电脑保持在线、唤醒，聊天服务、预览网关及所需本地网页服务可用。文件保留在这台电脑上，预览链接不等于上传到独立的永久托管服务。
- 文件预览运行时为 kkFileView 5.0.3、Java 21 和适配本机架构的 LibreOffice。外部访问还需要现有 frp、Caddy 链路和有效 HTTPS 配置。
- 聊天服务用 `npm run service:start`、`service:restart`、`service:status` 和 `service:logs` 管理。kkFileView 用 `node scripts/preview-service.mjs run --runtime …` 前台启动，或把 `render` 生成的 launchd 配置交给你自己的进程管理器。不要另起一套未登记的后台进程。
- 预览配置、授权记录、转换缓存和日志保存在本机私有运行目录。仓库只保存配置样例，不提交实际路径、令牌、证书或预览授权 URL。

## 配置与端口

应用配置见 [`.env.example`](../../.env.example)；实际读取入口是 [`src/config.js`](../../src/config.js)。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `PREVIEW_ENABLED` | `true` | 启用文件与网页预览网关及入口 |
| `PREVIEW_HOST` | `127.0.0.1` | 网关监听地址，默认仅本机 |
| `PREVIEW_PORT` | `3211` | 文件预览网关端口 |
| `PREVIEW_SERVICE_PORTS` | `3212,3213,3214,3215` | 四个独立网页预览槽位 |
| `PREVIEW_PUBLIC_ORIGIN` | 空 | 外部文件预览入口的 origin，包含协议、主机和端口，不带路径 |
| `KKFILEVIEW_URL` | `http://127.0.0.1:8012` | kkFileView 内部上游地址，保留为 loopback |

默认端口关系如下。公网端口是现有部署方式的示例，需与 frp/Caddy 实际映射一致。

| 服务 | 本机端口 | 公网入口示例 |
| --- | --- | --- |
| 文件预览网关 | `3211` | `8444` |
| 网页槽位 1–4 | `3212`–`3215` | `8445`–`8448` |
| kkFileView 内部服务 | `8012` | 仅 loopback，不直接发布 |

例如将 `PREVIEW_PUBLIC_ORIGIN` 设置为 `https://chat.example.com:8444`，网关会按本机端口相对 `PREVIEW_PORT` 的偏移生成其余预览地址，因此默认网页槽位对应 `8445`–`8448`。修改端口时必须同步调整外部映射；只映射文件端口不能使网页槽位可用。`example.com` 为示例域名，替换为自己的入口。

从 localhost 打开聊天时，预览继续使用本机端口；从外部地址打开时，配置的公共 origin 用于生成手机可访问的地址。聊天配置 `HOST` 与预览配置 `PREVIEW_HOST` 独立：手机能打开聊天，不代表它能直连默认仅监听 loopback 的预览端口。通过现有 frp/Caddy 转发这些网关端口即可保留默认监听范围。

## 配置原生运行时

1. 以 [`scripts/preview/runtime.example.json`](../../scripts/preview/runtime.example.json) 为样例，在仓库外创建 `runtime.json`。填写 Java、LibreOffice、kkFileView JAR、同版本默认配置、缓存与日志目录的绝对路径。保留 `kkVersion: "5.0.3"` 和 `bridgeOrigin: "http://127.0.0.1:3211"`；当前原生启动脚本固定使用该文件桥接端口。
2. 使用 [`scripts/preview-service.mjs`](../../scripts/preview-service.mjs) 检查版本并生成配置。以下路径是占位符，执行前替换：

   ```bash
   node scripts/preview-service.mjs doctor --runtime /absolute/preview-runtime/runtime.json
   node scripts/preview-service.mjs render --runtime /absolute/preview-runtime/runtime.json
   ```

3. 将 `render` 输出的 `registration` 登记到你的进程管理器：服务名 `codex-kkfileview`、launchd 配置及健康检查地址。`render` 只生成文件；`run` 是前台启动入口，不负责安装或启动其他服务。未传 `--runtime` 时，脚本默认读取 `~/.local/share/codex-cc-web-terminal/preview-runtime/runtime.json`。已经放在其他目录的 `runtime.json` 要继续通过 `--runtime` 或 `PREVIEW_RUNTIME_CONFIG` 指定。脚本不会自动读取项目 `.env`。
4. 启动预览运行时与聊天服务。更新应用 `.env` 后执行 `npm run service:restart`。若使用 frp/Caddy，确认五个预览入口转到对应网关。保留 kkFileView 的 `/viewer` 路径及 HTTP/WebSocket 转发能力。

生成配置将 kkFileView 限定在 `127.0.0.1:8012`，关闭上传、删除及编辑相关入口。启动脚本发现已有 `soffice.bin` 时会拒绝继续启动；先确认该进程归属并处理冲突，不强行终止正在使用的 Office 进程。

## 文件授权与关联资源

登录后的预览入口按用户点击的具体文件或本地服务创建随机授权标识（capability）。授权有效期为 12 小时，过期后从原会话重新打开。文件预览链接本身具有读取能力，应按临时访问凭据对待；关闭文件面板不代表该链接立刻失效。

文件入口只接受普通文件，拒绝目录、常见凭据目录或文件以及应用内部数据。kkFileView 读取的是被选中文件的授权地址，不应把 kkFileView 内部端口或整个用户目录直接发布到公网。

HTML 和 Markdown 的配图等资源可从所选文件所在目录及其子目录读取允许的静态资源类型；目录越界、符号链接绕出目录和受保护文件会被拒绝。这个关联资源范围仍可能包含同目录下的其他静态文件，因此应把可预览产物与必需资源放在独立产物目录，避免混入私密配置或业务数据。frp/Caddy 只转发预览网关，不为私密文件目录配置公开静态目录映射。

Markdown 相对图片使用 [`scripts/preview/markdown-assets.js`](../../scripts/preview/markdown-assets.js) 解析到原文档的授权资源位置。运行时 `render` 需要能找到与 `defaultsPath` 配套的 `resources/web/markdown.ftl`，以生成带该辅助脚本的模板。建议使用 `images/chart.png` 等同目录或子目录引用；越出文档目录的 `../` 引用会受到授权边界限制。

## 本地网页兼容范围

网页入口接受明确启动的 localhost、loopback IPv4/IPv6 或 `0.0.0.0` 服务地址；聊天、预览、管理等保留端口不可作为任意转发目标。四个网页槽位提供不同 origin，每个面板或独立窗口使用独立槽位，同一创建请求重试不会重复占用。关闭网页面板会请求释放槽位；快速取消创建的请求也不会留下迟到授权。

“新窗口打开”签发独立授权，关闭原面板不会影响新窗口。浏览器直接关闭独立窗口不会通知聊天控制器，该授权会保留到 12 小时到期；同时打开的网页预览最多四个。网页面板适合日常快速切换，独立窗口用于需要保留的预览。

预览网关不会把聊天登录 Cookie 或 Authorization 转发给被预览应用。上游返回的 Cookie 会被隔离命名并强制设为 `HttpOnly`，Service Worker 注册也被禁用。因此：

- 通过服务器 Cookie 会话处理请求的网页可按其具体实现验证；依赖 `document.cookie` 读取或改写会话值的应用可能不能正常登录或保持状态。
- 依赖 Service Worker、离线缓存或 PWA 后台能力的流程不属于当前兼容承诺。
- 页面内硬编码的本机地址不会自动变成手机地址；建议本地项目使用同源相对路径访问 API、静态资源与 WebSocket，并从手机实际验证。

## PDF.js 缺失资源修复

已知上游包可能包含 PDF.js viewer，却缺少配套 `build` 资源，表现为 PDF 或 Office 转换后的 PDF 预览空白、模块 404。使用 [`scripts/preview/restore-pdfjs.mjs`](../../scripts/preview/restore-pdfjs.mjs) 补齐：

1. 先停止 kkFileView。
2. 运行固定版本修复脚本：

   ```bash
   node scripts/preview/restore-pdfjs.mjs --runtime /absolute/preview-runtime/runtime.json
   ```

3. 重新启动 kkFileView，再验证 PDF 与 Office 文件。

脚本确认当前 viewer 为 `5.4.530`，从官方 `pdfjs-dist` 同版本包补入 API、worker 与 sandbox 的兼容构建，校验归档和文件摘要，保存原 JAR 备份与修复记录。不得使用 `latest` 或混配其他版本的 worker；升级 kkFileView 后应先核对 viewer 版本，再更新修复脚本及校验值。

## 中文字体

部分 macOS headless LibreOffice 转换无法正确回退到系统中文字体。可使用 [`scripts/preview/install-fonts.mjs`](../../scripts/preview/install-fonts.mjs) 将固定版本的开源 Noto Sans SC 字体安装到私有 LibreOffice 应用目录，保留许可证，不修改系统字体。

```bash
node scripts/preview/install-fonts.mjs --runtime /absolute/preview-runtime/runtime.json
```

安装后重启 kkFileView，使 Office 进程重新加载字体。已生成的缺字 PDF 缓存需要清除后重新转换；先核对缓存归属，不能删除源文档。

## 公网静态资源

为避免每次打开都跨隧道传输预览器脚本，公网 Caddy 可直接提供与本机 kkFileView 精确匹配的公开静态资源；文档内容和转换结果继续经过授权网关读取。

使用 `node scripts/preview/package-static.mjs --runtime /absolute/preview-runtime/runtime.json` 从固定版本源码复制 `js`、`css`、`bootstrap`、`pdfjs`，并补入同版 PDF.js build；脚本先验证来源摘要，再生成逐文件 SHA-256 清单。PDF viewer 的脚本与样式引用附带固定版本参数，避免继续使用部署前失败加载的缓存。部署到专用只读目录后，仅在文件预览入口加入以下规则，保留现有认证和其他服务配置：

```caddyfile
@viewer_static path /viewer/js/* /viewer/css/* /viewer/bootstrap/* /viewer/pdfjs/*
handle @viewer_static {
    uri strip_prefix /viewer
    root * /absolute/public-preview-static
    header Cache-Control "public, max-age=86400"
    file_server
}
handle {
    reverse_proxy 127.0.0.1:13211
}
```

目录内只能包含公开的预览器资源，不能复制文档、转换缓存、运行时配置或授权记录。升级时同步本机和服务器版本，并处理浏览器旧资源缓存，避免 PDF.js API 与 worker 混配。frp 预览代理开启传输压缩，本机网关也为预览器静态资源设置一天缓存；文档转换缓存按文件版本隔离。

## 验证

- 确认聊天服务和 kkFileView 在线。若使用 frp/Caddy，同时确认对应转发在线。网关健康路径为 `/__preview_health`，kkFileView 健康路径为 `http://127.0.0.1:8012/viewer/actuator/health`；前者通过不代表转换器也已就绪。
- 使用不含私密信息的样例检查 PDF、Word/Excel/PowerPoint、图片、Markdown 及相对配图。验证文字、中文字体和多页内容，不能只以 HTTP 200 判定转换成功。
- 在手机打开同一文件和一个本地网页，确认使用外部预览 origin、页面/API/资源加载正常，并验证关闭、重试、新窗口打开及聊天草稿保留。
- 核对无授权或过期地址、目录越界、受保护文件被拒绝；网页场景确认聊天凭据不转发、Service Worker 被拒绝。
- 维护代码时可运行现有预览测试：

  ```bash
  node --test tests/previews.test.js tests/preview-ui.test.js tests/markdown-links.test.js tests/markdown-media.test.js tests/media-playback.test.js tests/thread-item-markdown.test.js
  node --test scripts/preview/preview-service.test.mjs scripts/preview/restore-pdfjs.test.mjs
  ```

## 故障处理与维护

| 表现 | 优先核对 |
| --- | --- |
| 电脑能看、手机打不开 | 电脑在线状态、公共 origin、Caddy/frp 五端口映射及 HTTPS；不要把手机引向其自身 localhost |
| Office/PDF 空白 | kkFileView/LibreOffice 健康与日志、字体、PDF.js build 资源和版本匹配 |
| Markdown 图片缺失 | 模板辅助脚本是否生成、图片真实位置、相对路径及目录授权范围 |
| 文件 403/404/410 | 文件是否仍存在且可读、是否受保护、授权是否过期；过期后从会话重新打开 |
| 网页能加载但登录或离线能力异常 | `document.cookie`、HttpOnly 与 Service Worker 兼容边界，应用是否写死地址 |
| 网页预览槽位已满 | 关闭不再使用的网页面板，确认槽位释放；异常残留由管理员检查授权记录 |

Apple Silicon 上部分压缩包处理和视频转码依赖额外的原生组件，不作为本版本支持承诺。核心场景验收通过不能推断所有 kkFileView 上游格式都可用。转换缓存和日志需要按本机维护策略清理；保留运行时版本、配置与修复记录，避免把实际文件内容或授权链接提交到仓库。
