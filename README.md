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

| 字段          | 类型    | 必填 | 说明                                   |
| ------------- | ------- | ---- | -------------------------------------- |
| `size`        | integer | 是   | 资源总字节数，非负安全整数（≥ 0）       |
| `contentType` | string  | 否   | 资源媒体类型，默认 `application/octet-stream` |
| `etag`        | string  | 否   | 资源当前 ETag（RFC 9110 entity-tag，强或弱，如 `"v1"` / `W/"v1"`），与 `If-Range` 头配合 |
| `lastModified`| string  | 否   | 资源当前 Last-Modified（HTTP-date，如 `Wed, 21 Oct 2015 07:28:00 GMT`），与 `If-Range` 头配合 |

另有等价的 `GET /plan?size=...&contentType=...&etag=...&lastModified=...`，便于直接用浏览器/curl 探测。

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

# If-Range 与当前强 ETag 逐字一致 -> 执行范围规划（206, decision=partial）
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99' \
  -H 'If-Range: "v1-abc"' \
  -d '{"size":10000,"etag":"\"v1-abc\""}'

# If-Range 不匹配 -> 忽略 Range，返回完整传输规划（200, decision=full）
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99' \
  -H 'If-Range: "stale-etag"' \
  -d '{"size":10000,"etag":"\"v1-abc\""}'

# 等价 GET（日期校验器：If-Range 不早于 lastModified 才执行范围）
curl 'http://localhost:3000/plan?size=10000&lastModified=Wed%2C%2021%20Oct%202015%2007%3A28%3A00%20GMT' \
  -H 'Range: bytes=-500' -H 'If-Range: Wed, 21 Oct 2015 08:00:00 GMT'
```

## If-Range 条件处理（RFC 9110 §13.2.2）

`POST/GET /plan` 接受**可选**的 `If-Range` 请求头。请求体（POST）或查询参数
（GET）同时给出资源当前的 `etag` 与/或 `lastModified`。判定规则：

- **强 ETag 逐字匹配**：`If-Range` 是带双引号的强 entity-tag（如 `"v1"`），
  与当前 `etag` **逐字节相等**时执行范围规划；弱 ETag（`W/"…"`）在
  `If-Range` 中永不匹配。
- **HTTP-date 不早于 lastModified**：`If-Range` 是 HTTP-date（支持
  IMF-fixdate 与废弃的 RFC 850 / asctime 格式），且其时间戳 **≥**
  `lastModified` 时执行范围规划。
- **以下情况忽略 Range**，直接返回 `200` 的完整传输规划
  （`Content-Length: <size>`、`Content-Type`、`Accept-Ranges: bytes`，
  `decision: "full"`）：
  - 校验器与当前元数据不匹配（ETag 不同 / 日期更早）；
  - 请求未提供对应的当前资源元数据（缺 `etag` / `lastModified`，
    或当前 ETag 是弱验证器）；
  - `If-Range` 值既不是合法强 entity-tag 也不是合法 HTTP-date
    （含空值、弱验证器 `W/"…"`、不存在的日期等）——此时根本不解析
    `Range`，行为与源站完全一致。
- 每个响应都带 **`decision`**：`"partial"`（执行了范围规划，即 206/416/422）
  或 `"full"`（200 完整规划）。发送了 `If-Range` 时还带 `ifRange` 判定块：
  `{ matched, rangesAllowed, kind: "etag"|"date"|null, reason }`，
  `reason` 取值如 `ETAG_MATCH`、`ETAG_MISMATCH`、`MISSING_RESOURCE_ETAG`、
  `RESOURCE_ETAG_NOT_STRONG`、`WEAK_VALIDATOR_NOT_ALLOWED`、
  `DATE_NOT_EARLIER`、`DATE_EARLIER_THAN_LAST_MODIFIED`、
  `MISSING_RESOURCE_LAST_MODIFIED`、`INVALID_VALIDATOR`。
- **保留原有语义**：匹配成功时 206/416/422 的判定与响应结构不变；未发送
  `If-Range` 时行为与旧版完全一致（仅响应中多出 `decision: "partial"`）。
- **拒绝异常输入**：重复 `If-Range` 头、`If-Range`/`etag`/`lastModified`
  含 CR/LF、头值超过 4096 字节一律 `400`；GET 查询参数重复（`?etag=a&etag=b`）
  同样 `400`。

完整 200 响应示例（节选）：

```json
{
  "statusCode": 200,
  "decision": "full",
  "ifRange": {
    "rangesAllowed": false,
    "matched": false,
    "kind": "etag",
    "reason": "ETAG_MISMATCH"
  },
  "resource": { "size": 10000, "contentType": "application/octet-stream" },
  "bytes": { "selected": 10000, "framing": 0, "total": 10000, "resource": 10000, "ratio": 1 },
  "responseHeaders": {
    "Accept-Ranges": "bytes",
    "Content-Type": "application/octet-stream",
    "Content-Length": "10000"
  }
}
```

## 响应语义

| 情况 | 状态码 | 说明 |
| --- | --- | --- |
| 一个区间（合并后） | `206` | `decision: "partial"`；`responseHeaders` 给出 `Content-Range`、`Content-Length`、`Accept-Ranges: bytes` |
| 多个区间 | `206` | `decision: "partial"`；`responseHeaders` 给出 `Content-Type: multipart/byteranges; boundary=…` 与含封装开销的 `Content-Length`；`segments[].partHeaderBlock` 给出每段头部原文（CRLF） |
| 全部区间不可满足 | `416` | `decision: "partial"`，带 `Content-Range: bytes */<size>` |
| `If-Range` 未通过（不匹配/缺元数据/校验器无效） | `200` | `decision: "full"`；忽略 Range，完整传输规划：`Content-Length: <size>`、`Content-Type`、`Accept-Ranges: bytes` |
| `Range` 语法错误 / 非 byte 单位 / 缺失 | `400` | 头本身无效，区别于“语法合法但无法满足” |
| `etag`/`lastModified` 格式非法、含 CR/LF，或 `If-Range` 重复/含 CR/LF/超长 | `400` | 请求携带的元数据或条件头无效 |
| 合并后段数 > 16 | `422` | `code: TOO_MANY_SEGMENTS` |
| 计划传输字节 > 资源大小 × 2 | `422` | `code: TRANSFER_LIMIT_EXCEEDED`，封装字节（边界+段头+收尾）也计入 |

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
  planner.js   # 范围规划核心：解析、夹取、丢弃、合并、边界生成、422 守卫、If-Range 前置条件
  app.js       # Fastify 应用：POST/GET /plan、/healthz、输入校验（含重复/CR/LF 条件头）
  server.js    # 启动入口与环境变量读取
test/
  planner.test.js  # node:test 测试（57 个用例），npm test
```

## 本地开发与测试

```bash
npm ci
npm test          # 57 个用例：区间解析/合并/416/422/边界 + If-Range ETag/日期/弱验证器/异常输入
npm start
```

## 安全说明

- 只接受 `bytes` 范围单位，其他单位返回 `400 UNSUPPORTED_RANGE_UNIT`。
- `Range` 与 `If-Range` 头长度上限均为 4096 字节；拒绝重复 `Range` 与重复
  `If-Range` 头（`DUPLICATE_RANGE_HEADER` / `DUPLICATE_IF_RANGE_HEADER`）。
- `If-Range`、`etag`、`lastModified`、`contentType` 均不得包含 CR/LF，
  杜绝响应头注入；非法 entity-tag / HTTP-date 元数据返回
  `400 INVALID_ETAG` / `400 INVALID_LAST_MODIFIED`。
- `If-Range` 中的弱 ETag 与无法解析的校验器不会报错，而是按 RFC 忽略
  Range 返回完整 200——这与真实源站行为一致。
- 所有偏移量使用非负安全整数（`Number.MAX_SAFE_INTEGER` 以内）解析。
