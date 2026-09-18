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

另有等价的 `GET /plan?size=...&contentType=...`，便于直接用浏览器/curl 探测。

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

# 等价 GET
curl 'http://localhost:3000/plan?size=10000' -H 'Range: bytes=-500'
```

## 响应语义

| 情况 | 状态码 | 说明 |
| --- | --- | --- |
| 一个区间（合并后） | `206` | `responseHeaders` 给出 `Content-Range`、`Content-Length`、`Accept-Ranges: bytes` |
| 多个区间 | `206` | `responseHeaders` 给出 `Content-Type: multipart/byteranges; boundary=…` 与含封装开销的 `Content-Length`；`segments[].partHeaderBlock` 给出每段头部原文（CRLF） |
| 全部区间不可满足 | `416` | 带 `Content-Range: bytes */<size>` |
| `Range` 语法错误 / 非 byte 单位 / 缺失 | `400` | 头本身无效，区别于“语法合法但无法满足” |
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
  planner.js   # 范围规划核心：解析、夹取、丢弃、合并、边界生成、422 守卫
  app.js       # Fastify 应用：POST/GET /plan、/healthz、输入校验
  server.js    # 启动入口与环境变量读取
test/
  planner.test.js  # node:test 测试（26 个用例），npm test
```

## 本地开发与测试

```bash
npm ci
npm test          # 26 个用例：闭区间/开放尾端/后缀/夹取/丢弃/合并/416/422/确定性边界
npm start
```

## 安全说明

- 只接受 `bytes` 范围单位，其他单位返回 `400 UNSUPPORTED_RANGE_UNIT`。
- `Range` 头长度上限 4096 字节；拒绝重复 `Range` 头。
- `contentType` 需为合法媒体类型且不含 CR/LF，杜绝响应头注入。
- 所有偏移量使用非负安全整数（`Number.MAX_SAFE_INTEGER` 以内）解析。
