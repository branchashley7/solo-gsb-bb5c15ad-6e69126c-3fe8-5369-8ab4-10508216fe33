# range-plan-api — HTTP 字节范围响应规划服务

基于 **Node.js + Fastify + range-parser** 构建的字节范围（byte-range）响应规划
API，遵循 [RFC 9110 §14](https://www.rfc-editor.org/rfc/rfc9110.html#section-14)。

服务**不传输真实文件内容**：客户端提交资源总字节数与 `Range` 请求头，服务返回
一份“响应规划”——应当使用的 HTTP 状态码、响应头、每段的偏移/长度、每段头部，
以及多段时确定性的 `multipart/byteranges` 边界和实际线上传输字节核算。

## 单条启动命令

```bash
docker compose up --build -d
```

启动后服务监听：

```
http://localhost:3000
```

健康检查：

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

> 不想用 Docker 时：`npm ci && npm start`（需要 Node.js ≥ 20），
> 同样监听 `http://localhost:3000`。

## 接口

### `POST /plan`（主接口）

`Range` 以真实请求头携带，与源站收到的请求完全一致；资源信息放在 JSON 体里。

请求体：

| 字段             | 类型    | 必填 | 说明                                   |
| ---------------- | ------- | ---- | -------------------------------------- |
| `size`           | integer | 是   | 资源总字节数，非负安全整数（≥ 0）       |
| `contentType`    | string  | 否   | 资源媒体类型，默认 `application/octet-stream` |
| `etag`           | string  | 否   | 资源当前的实体标签（entity-tag），如 `"v1-abc"` 或 `W/"v1-abc"` |
| `lastModified`   | string  | 否   | 资源当前的 `Last-Modified`，必须是合法 IMF-fixdate，如 `Wed, 21 Oct 2015 07:28:00 GMT` |

可另带可选的 `If-Range` 请求头（单个**强 ETag** 或单个 **HTTP-date**），按
[RFC 9110 §13.1.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.3)
评估后再决定是否执行 Range 规划：

- `If-Range` 与当前 `etag` **逐字节相同且都是强验证器**（`"…"`，`W/` 前缀一律不匹配），或
- `If-Range` 是不早于 `lastModified` 的 HTTP-date（相等也算通过），

才返回 `206` 分片规划；否则（验证器不匹配、缺失对应资源元数据、验证器格式
无效、弱验证器、日期早于 Last-Modified）**忽略 Range**，返回 `200` 的完整
传输规划（`decision: "full"`，`Content-Length=size`）。注意此时 Range 头
根本不会被解析，因此 Range 本身语法错误也仍然得到 200。

另有等价的 `GET /plan?size=...&contentType=...&etag=...&lastModified=...`，
便于直接用浏览器/curl 探测。

快速验证：

```bash
# 单区间（206 + 单段头部规划）
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99' \
  -d '{"size":10000,"contentType":"video/mp4"}'

# 多区间（206 + multipart/byteranges 规划）
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99, 500-599' \
  -d '{"size":10000}'

# If-Range 命中当前 ETag -> 206 分片
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99' \
  -H 'If-Range: "v1-abc"' \
  -d '{"size":10000,"etag":"\"v1-abc\""}'

# If-Range 过期（ETag 不匹配）-> 200 完整规划
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99' \
  -H 'If-Range: "stale"' \
  -d '{"size":10000,"etag":"\"v1-abc\""}'

# 等价 GET
curl 'http://localhost:3000/plan?size=10000' -H 'Range: bytes=-500'
```

## 响应语义

每个规划结果带 `decision` 字段：

- `"partial"` —— 执行 Range 规划：`206`（含 `416`/`422` 这类仍针对分片
  请求的结果）。
- `"full"` —— 忽略 Range、返回完整表示规划：仅 `200`。

| 情况 | 状态码 | `decision` | 说明 |
| --- | --- | --- | --- |
| 一个区间（合并后） | `206` | `partial` | `responseHeaders` 给出 `Content-Range`、`Content-Length`、`Accept-Ranges: bytes` |
| 多个区间 | `206` | `partial` | `responseHeaders` 给出 `Content-Type: multipart/byteranges; boundary=…` 与含封装开销的 `Content-Length`；`segments[].partHeaderBlock` 给出每段头部原文（CRLF） |
| 全部区间不可满足 | `416` | `partial` | 带 `Content-Range: bytes */<size>` |
| `If-Range` 未通过（或验证器无法识别） | `200` | `full` | 完整传输规划：`Content-Length: <size>`、`Content-Type`、`Accept-Ranges: bytes`；`segments`/`segmentsCount` 为 `null`，Range 不解析 |
| `Range` 语法错误 / 非 byte 单位 / 缺失 | `400` | — | 头本身无效，区别于“语法合法但无法满足” |
| 合并后段数 > 16 | `422` | `partial` | `code: TOO_MANY_SEGMENTS` |
| 计划传输字节 > 资源大小 × 2 | `422` | `partial` | `code: TRANSFER_LIMIT_EXCEEDED`，封装字节（边界+段头+收尾）也计入 |

请求带 `If-Range` 时，结果中还有 `condition` 块说明判定依据：

```json
{ "header": "If-Range", "validatorKind": "etag", "outcome": "passed", "reason": "etag-match" }
```

`reason` 取值：通过时为 `etag-match` / `date-not-earlier`；失败时为
`etag-mismatch`、`date-earlier`、`weak-validator`、`resource-metadata-missing`
或 `invalid-validator`。提供了 `etag`/`lastModified` 时，200/206/416/422
的 `resource` 与 `responseHeaders` 会原样回显它们（`ETag`、`Last-Modified`）。

### RFC 9110 处理规则

- **闭区间** `bytes=0-499`：原样接受。
- **开放尾端** `bytes=500-`：结束位置自动延伸至最后一个字节。
- **后缀范围** `bytes=-200`：取最后 200 字节；后缀长度 **≥ 资源大小**时按 RFC
  覆盖整个资源（如 50 字节资源上的 `bytes=-200` → `bytes 0-49/50`），而不是
  丢弃。这是对 `range-parser` 原生行为的 RFC 兼容修正（预处理阶段完成）。
- **夹取越界端点**：末位超过 `size-1` 时夹到 `size-1`。
- **丢弃不可满足项**：`start ≥ size`、逆序闭区间、非空资源上的 `-0` 等单项被
  丢弃；其余项继续规划。所有项都被丢弃时才返回 `416`。
- **合并**：重叠或相邻（间隔为 0，如 `0-9,10-19`）的区间合并为一段；段顺序
  保持各区间**首次出现**的顺序（来自 `range-parser` 的 `combine` 语义）。
- **确定性边界**：对 `{size, contentType, 排序后的区间集合}` 取 SHA-256，得到
  `brp-` + 48 个十六进制字符。同样的覆盖字节集合（与列出顺序无关）必然产生
  同一边界；不同规划必然不同。
- **If-Range（§13.1.3）**：头值以 `"` 开头时按实体标签处理——必须是强标签
  且与当前 `etag` **逐字相等**（不做空白折叠/大小写归一；`W/…` 永不通过）；
  否则按 HTTP-date 解析（仅接受 IMF-fixdate，并校验星期与真实日历一致），
  日期 **不早于** `lastModified` 才通过。任何不通过的情形都降级为
  `200 decision:"full"`；未提供 `If-Range` 时行为与原先完全一致。

单区间 206 响应示例（节选）：

```json
{
  "statusCode": 206,
  "decision": "partial",
  "segmentsCount": 1,
  "segments": [{ "index": 1, "start": 0, "end": 99, "bytes": 100,
    "headers": { "Content-Type": "video/mp4", "Content-Range": "bytes 0-99/10000" },
    "partHeaderBlock": "Content-Type: video/mp4\r\nContent-Range: bytes 0-99/10000\r\n\r\n" }],
  "bytes": { "selected": 100, "framing": 0, "total": 100, "resource": 10000, "ratio": 0.01 },
  "multipart": null,
  "responseHeaders": {
    "Accept-Ranges": "bytes",
    "Content-Type": "video/mp4",
    "Content-Range": "bytes 0-99/10000",
    "Content-Length": "100"
  }
}
```

`If-Range` 失败时的 200 完整规划示例：

```json
{
  "statusCode": 200,
  "decision": "full",
  "segmentsCount": null,
  "segments": null,
  "bytes": { "selected": 10000, "framing": 0, "total": 10000, "resource": 10000, "ratio": 1 },
  "multipart": null,
  "responseHeaders": {
    "Accept-Ranges": "bytes",
    "Content-Type": "video/mp4",
    "Content-Length": "10000",
    "ETag": "\"v1-abc\""
  },
  "condition": { "header": "If-Range", "validatorKind": "etag", "outcome": "failed", "reason": "etag-mismatch" }
}
```

多区间时 `multipart` 字段给出 `boundary`、`boundaryDelimiter`
（`--<boundary>`）、`closingBoundary`（`--<boundary>--`）和行终止符 `CRLF`，
可直接据此拼接真实的 multipart 报文。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `MAX_SEGMENTS` | `16` | 允许的最大段数，超过返回 422 |
| `TRANSFER_SIZE_RATIO` | `2` | 计划传输字节相对资源大小的上限倍数 |
| `LOG_LEVEL` | （空=关闭日志） | 设为 `info`/`debug` 等启用 Fastify 日志 |

修改端口/阈值后重新 `docker compose up -d` 即可。例如本地端口改为 8080：

```bash
PORT=8080 docker compose up --build -d   # 或编辑 compose 中的 ports 映射
```

## 项目结构

```
src/
  conditional.js # If-Range 评估：强 ETag 逐字比较、严格 IMF-fixdate 解析
  planner.js     # 范围规划核心：解析、夹取、丢弃、合并、边界生成、422 守卫、条件降级
  app.js         # Fastify 应用：POST/GET /plan、/healthz、输入校验
  server.js      # 启动入口与环境变量读取
test/
  planner.test.js  # 原有 node:test 用例（26 个）
  if-range.test.js # If-Range ETag/日期/降级/元数据校验用例（25 个）
  headers.test.js  # 真实 socket 上的重复头与 CR/LF 拒绝用例（4 个）
```

## 本地开发与测试

```bash
npm ci
npm test          # 55 个用例：区间解析/合并/416/422/边界 + If-Range ETag/日期/降级 + 重复头/CRLF
npm start
```

## 安全说明

- 只接受 `bytes` 范围单位，其他单位返回 `400 UNSUPPORTED_RANGE_UNIT`。
- `Range` 头长度上限 4096 字节；拒绝重复 `Range` 头。
- `If-Range` 同样拒绝重复头（`400 DUPLICATE_IF_RANGE_HEADER`）；含 CR/LF
  的值在 HTTP 解析层即被拒绝（应用层另有一道 CR/LF 检查兜底）。
- 资源元数据 `etag` 必须是合法 entity-tag、`lastModified` 必须是合法
  IMF-fixdate 且不含 CR/LF，否则 `400 INVALID_ETAG` /
  `400 INVALID_LAST_MODIFIED`；GET 的重复同名参数也会被拒绝。
- `If-Range` 中的非法验证器**不**算请求错误：按 RFC 忽略 Range 并返回
  200 完整规划（`condition.reason: "invalid-validator"`）。
- `contentType` 需为合法媒体类型且不含 CR/LF，杜绝响应头注入。
- 所有偏移量使用非负安全整数（`Number.MAX_SAFE_INTEGER` 以内）解析。
