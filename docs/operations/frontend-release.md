# 公网前端静态发布

Last updated: 2026-10-21
Status: active
Owner: maintainers

## 部署边界

公网入口可以直接提供已经构建的 HTML、JS、CSS 和许可证文件，API、WebSocket、附件和预览仍沿原有受认证反向代理访问本机。静态资源不再占用本机隧道；动态请求的延迟仍取决于该链路。

仅使用项目专属目录和代理实例。不要修改共享 Caddy、其他站点、全局防火墙或网络参数。主机、账户、认证信息和真实部署路径保存在运维者的私有配置中，不写入仓库。应用启停沿现有服务管理入口完成。

## 产物与工具

`scripts/frontend-release/cli.mjs` 使用现有 Node 运行时，不构建、不联网、不启停服务。`remote.py` 使用 Python 3 标准库，供没有 Node 的远端安装产物；它与 Node 工具共用 `contract.json`。

```text
PROJECT_STATIC_ROOT/
  releases/RELEASE_ID/manifest.json
  releases/RELEASE_ID/files/...
  shared/files/assets/...
  current -> releases/RELEASE_ID
```

清单记录每个文件的长度、SHA-256、MIME、压缩类型和缓存分类。Node 验证文件依赖及 br/gzip 解压内容，远端验证上传后的字节与清单完全一致，不需要安装 Brotli。所有版本的 hash 资源保留在共享目录；同一 URL 不同内容拒绝发布。产物目录不能含私有接口路径、未列明文件或符号链接，清单位于公开 `files/` 之外。

## 发布顺序

1. 完成相关回归及构建检查。涉及新接口时，先通过现有管理入口发布兼容后端，确认新能力可用。该管理入口若已经构建前端，后续直接使用它产出的 `web/dist`，不要在上传阶段重新构建。
2. 对最终产物生成清单并暂存。下面的大写参数均由运维者替换为本机实际值，不是固定路径。

```sh
node scripts/frontend-release/cli.mjs manifest --source BUILD_DIR --release RELEASE_ID --output MANIFEST_FILE
node scripts/frontend-release/cli.mjs verify --source BUILD_DIR --manifest MANIFEST_FILE
node scripts/frontend-release/cli.mjs stage --source BUILD_DIR --manifest MANIFEST_FILE --root LOCAL_STAGE
```

3. 将 `LOCAL_STAGE/releases/RELEASE_ID` 完整传到项目专属上传目录。另将 `remote.py`、`remote_manifest.py`、`contract.json` 放在同一工具目录，不能混入 release 包。通过受认证通道传输；清单是完整性校验，不是签名或身份认证。
4. 在远端先验证并暂存，尚不切换页面。

```sh
python3 TOOL_DIR/remote.py verify --bundle UPLOADED_RELEASE
python3 TOOL_DIR/remote.py stage --bundle UPLOADED_RELEASE --root PROJECT_STATIC_ROOT
```

5. 从保存的原始 Caddy JSON 生成候选配置。必须明确指定 server 名和唯一 upstream。`--retained` 文件包含全部保留版本的清单数组，首次部署也应纳入当前旧版本，以便旧页面继续加载 chunk 和执行回退。

```sh
node scripts/frontend-release/cli.mjs caddy --config ORIGINAL_CONFIG --server PROJECT_SERVER --upstream PROJECT_UPSTREAM --root PROJECT_STATIC_ROOT --manifest MANIFEST_FILE --retained RETAINED_MANIFESTS --output CANDIDATE_CONFIG
```

6. 使用项目专属 Caddy 二进制验证候选配置。确认当前配置摘要仍与备份一致，除指定反代内新增静态路由外，其余配置深度相等。入口认证和 TLS、其他 server 必须保留；静态响应也保留防 iframe、nosniff 和 Referrer-Policy 头。
7. 所有验证通过后，原子切换当前版本，并按项目管理方式应用专属 Caddy 配置。若 admin API 被禁用，使用专属服务的管理入口，不要向默认 `localhost:2019` 发送 reload，它可能属于另一个实例。

```sh
python3 TOOL_DIR/remote.py activate --root PROJECT_STATIC_ROOT --release RELEASE_ID
```

8. 从正式入口核验 HTML 和全部资源的 SHA、br/gzip/identity、MIME、缓存、安全头、未认证请求、缺失资源 404、API、WebSocket、预览。对照其他服务的配置摘要、进程和健康状态。只有正式入口验证完成才算发布完成。

发布锁发现遗留时会报错，必须先确认没有进行中的发布；工具不抢锁。上传或校验失败不会切换 `current`。新接口的能力标记允许旧前端继续运行，前后端应始终使用兼容发布顺序。

## 回退与保留

```sh
python3 TOOL_DIR/remote.py rollback --root PROJECT_STATIC_ROOT --release PREVIOUS_RELEASE_ID
```

回退会重新校验旧产物和共享资源后原子切指针。候选 Caddy 必须已包含旧清单；如果回退整个静态托管功能，恢复保存的原始配置，只重启项目专属代理。旧前端产物和后端发布备份分别保留，静态回退不等于自动回退后端。

工具不自动删除旧版本。维护时至少保留最近 30 天和最近 3 个版本的并集；删除前按清单求出仍被引用的 hash，不可直接清空 `shared/files`。原始配置备份含认证资料，使用严格文件权限保管。

## 验证与限制

`node --test tests/frontend-release.test.js` 覆盖真实临时目录、跨语言清单、路径和符号链接拒绝、残缺上传、冲突、原子切换、旧资源保留、失败保留当前版本及 Caddy 配置隔离。运行 Python 互验需要 `python3`。

静态路径按发布清单精确匹配，`/assets/*` 和 `/licenses/*` 未命中真实返回 404，不回退成 HTML。带 hash 资源使用长期缓存，入口和可变公开文件 `no-store`。压缩侧文件仅用于内容协商。静态下载提速不能代表动态接口或真实手机网络已经达标，需分别测量。
