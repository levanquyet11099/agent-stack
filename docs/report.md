# Báo cáo Bài 1 — REST → OpenAPI → GraphQL → MCP

Diagram viết bằng Mermaid. GitHub, GitLab và VS Code tự render được, hoặc dán vào mermaid.live để xem.

## C1 — System Context

```mermaid
flowchart LR
  user([Thành viên team]) -- chat --> element[Element]
  element -- Matrix Client API --> synapse[Synapse]
  synapse -- sự kiện phòng --> openclaw[OpenClaw bot]
  openclaw -- prompt / tool call --> llm[(LLM provider)]
  openclaw -- MCP tools --> taskSys[[Hệ thống Task: MCP + GraphQL + REST]]
```

## C2 — Container

```mermaid
flowchart TB
  subgraph Chat
    element[Element :8080] --> synapse[Synapse :8008]
  end
  synapse --> openclaw[OpenClaw]
  openclaw --> llm[(LLM)]
  subgraph Task System [Phần tự xây — Docker Compose]
    mcp[MCP server :8004<br/>Node, Streamable HTTP] -- POST /graphql --> gql[GraphQL :8003<br/>Node, graphql-http]
    gql -- HTTP + X-API-Key --> uapi[User API :8001<br/>Express] --> udb[(SQLite users)]
    gql -- HTTP + X-API-Key --> tapi[Task API :8002<br/>Express] --> tdb[(SQLite tasks)]
  end
  openclaw -- http://localhost:8004/mcp --> mcp
```

## C3 — Component (GraphQL gateway)

```mermaid
flowchart LR
  req[POST /graphql] --> handler[graphql-http handler]
  handler --> schema[Schema từ specs/schema.graphql]
  schema --> qres[Query resolvers<br/>users, user, tasks, task]
  schema --> fres[Field resolvers<br/>User.tasks, User.taskStats, Task.assignee]
  fres --> ul[DataLoader users<br/>GET /users?ids=]
  fres --> sl[DataLoader stats<br/>GET /tasks/stats?assignee_ids=]
  qres --> rest[restGet<br/>timeout 5s, map lỗi → UPSTREAM_*]
  ul --> rest
  sl --> rest
```

## Sequence 1 — "Task của Lan còn mấy việc chưa xong?" (thành công)

```mermaid
sequenceDiagram
  actor U as User
  participant E as Element/Synapse
  participant O as OpenClaw
  participant L as LLM
  participant M as MCP
  participant G as GraphQL
  participant UA as User API
  participant TA as Task API

  U->>E: "Task của Lan còn mấy việc chưa xong?"
  E->>O: m.room.message
  O->>L: prompt + danh sách tool
  L-->>O: tool_call find_person_tasks(name="Lan", status="open")
  O->>M: tools/call
  M->>G: query users(search:"Lan"){ taskStats, tasks(status:OPEN) }
  G->>UA: GET /users?q=Lan
  UA-->>G: [Lan id=10]
  par field resolvers
    G->>TA: GET /tasks?assignee_id=10&status=open
    TA-->>G: 3 task
  and DataLoader
    G->>TA: GET /tasks/stats?assignee_ids=10
    TA-->>G: open=3, overdue=1
  end
  G-->>M: data
  M-->>O: {ok:true, found:true, people:[...]}
  O->>L: kết quả tool
  L-->>O: "Lan còn 3 việc chưa xong, 1 việc quá hạn: ..."
  O->>E: gửi tin nhắn
  E-->>U: hiển thị câu trả lời
```

## Sequence 2 — Nhánh lỗi

```mermaid
sequenceDiagram
  actor U as User
  participant O as OpenClaw
  participant L as LLM
  participant M as MCP
  participant G as GraphQL
  participant UA as User API
  participant TA as Task API

  U->>O: "Task của Tuấn?"
  O->>L: prompt + tools
  L-->>O: find_person_tasks(name="Tuấn")
  O->>M: tools/call
  M->>G: query users(search:"Tuấn")
  G->>UA: GET /users?q=Tuấn
  UA-->>G: items=[], total=0
  G-->>M: users.total = 0
  M-->>O: {ok:true, found:false, message:"Không có người dùng ..."}
  O->>L: kết quả tool
  L-->>O: "Không có dữ liệu về Tuấn trong hệ thống."

  Note over U,TA: Task API sập hoặc timeout
  U->>O: "Những việc nào đang mở?"
  O->>L: prompt + tools
  L-->>O: list_tasks(status="open")
  O->>M: tools/call
  M->>G: query tasks(status:OPEN)
  G-xTA: GET /tasks (ECONNREFUSED / quá 5s)
  G-->>M: errors[0].extensions = {code: UPSTREAM_UNAVAILABLE | UPSTREAM_TIMEOUT, service: task-api}
  M-->>O: {ok:false, error:"Dịch vụ dữ liệu báo lỗi."}, isError=true
  O->>L: kết quả tool (lỗi)
  L-->>O: "Hệ thống dữ liệu task đang lỗi, bạn thử lại sau nhé."
```

## Kịch bản demo trong Element (chụp ảnh nộp bài)

| # | Câu hỏi | Kỳ vọng |
|---|---|---|
| 1 | Task của Lan còn mấy việc chưa xong? | 3 việc, 1 quá hạn (số lấy từ `taskStats`) |
| 2 | Những việc nào đang mở, ai làm? | Danh sách 6 task kèm tên người. Câu này cần gom cả 2 API |
| 3 | Task của Tuấn? | Không có dữ liệu, không bịa |
| 4 | Task số 999? | Không có task này |
| 5 | (`docker compose stop task-api`) Những việc nào đang mở? | Bot báo hệ thống lỗi |

---

# Bài 2 — Bot tạo dữ liệu qua chat

Luồng ghi: `User → OpenClaw → MCP create_task → GraphQL mutation createTask → REST POST /tasks → SQLite`

## Các lớp bảo vệ

| Rủi ro | Chặn ở đâu | Cách chặn |
|---|---|---|
| Bot ghi khi user chưa đồng ý | Persona + MCP | SOUL.md bắt tóm tắt và hỏi xác nhận. Tham số `confirmed` của tool chỉ nhận `true` (zod `literal(true)`) |
| Bot tự điền thông tin thiếu | Persona + MCP + REST | Persona bắt hỏi lại. Tool bắt buộc đủ 3 trường. REST trả 422 nếu thiếu hoặc sai |
| Giao nhầm người | MCP + REST | MCP tra tên: 0 người → `ASSIGNEE_NOT_FOUND`, nhiều người → `AMBIGUOUS_ASSIGNEE`. REST kiểm tra lại id qua User API |
| Tạo trùng khi agent retry | REST (`Idempotency-Key`) | MCP sinh key từ nội dung + khung 10 phút. Gửi lại cùng key thì REST trả kết quả cũ (`Idempotent-Replay: true`) |
| Tạo trùng do user nhập lại | REST | Task đang mở cùng người, trùng tiêu đề (không phân biệt hoa thường, khoảng trắng) → `409 DUPLICATE_TASK` |
| Dữ liệu sai định dạng | REST | Tiêu đề 3–200 ký tự, ngày phải có thật và không ở quá khứ → `422 VALIDATION_ERROR`, `details` chỉ rõ trường lỗi |

## Sequence — tạo thành công có xác nhận

```mermaid
sequenceDiagram
  actor U as User
  participant O as OpenClaw
  participant L as LLM
  participant M as MCP
  participant G as GraphQL
  participant TA as Task API
  participant UA as User API

  U->>O: "Giao cho Nam viết tài liệu API, hạn 30/10"
  O->>L: prompt + tools
  L-->>O: (không gọi tool) "Tạo task: Viết tài liệu API — Nam — 2026-10-30. Xác nhận?"
  O-->>U: tóm tắt + hỏi xác nhận
  U->>O: "ok"
  O->>L: lịch sử + "ok"
  L-->>O: create_task(title, assigneeName="Nam", dueDate, confirmed=true)
  O->>M: tools/call
  M->>G: query users(search:"Nam")
  G->>UA: GET /users?q=Nam
  UA-->>G: [Nam id=20]
  G-->>M: 1 người
  M->>G: mutation createTask(input, idempotencyKey)
  G->>TA: POST /tasks + Idempotency-Key
  TA->>UA: GET /users/20 (người được giao có tồn tại?)
  UA-->>TA: 200
  TA->>TA: validate, kiểm tra trùng, INSERT
  TA-->>G: 201 task id=10
  G-->>M: createTask
  M-->>O: {ok:true, created:true, task}
  O->>L: kết quả tool
  L-->>O: "Đã tạo task #10 ..."
  O-->>U: xác nhận đã tạo
```

## Sequence — nhánh lỗi

```mermaid
sequenceDiagram
  actor U as User
  participant O as OpenClaw/LLM
  participant M as MCP
  participant TA as Task API (qua GraphQL)

  U->>O: "Tạo task Tối ưu trang chủ cho Nam" (thiếu hạn)
  O-->>U: "Hạn chót là ngày nào?" (không gọi tool)

  U->>O: "Tạo task X cho Nam hạn 1/11" → "Xác nhận?" → "không"
  O-->>U: "Đã huỷ, không tạo task." (không gọi tool)

  U->>O: ... xác nhận "ok"
  O->>M: create_task(...)
  M->>TA: POST /tasks
  TA-->>M: 409 DUPLICATE_TASK (existing_task id=4)
  M-->>O: {ok:false, code:DUPLICATE_TASK, details}
  O-->>U: "Nam đã có task đang mở 'Tối ưu trang chủ' (#4, hạn 2026-10-20), không tạo thêm."

  Note over M,TA: Agent retry do timeout
  O->>M: create_task(...) lần 2, cùng nội dung
  M->>TA: POST /tasks, cùng Idempotency-Key
  TA-->>M: 201 + Idempotent-Replay: true (task cũ, không INSERT)
```

## Kịch bản demo (chụp ảnh nộp bài)

| # | Tình huống | Câu nhắn mẫu | Kết quả đúng |
|---|---|---|---|
| 1 | Tạo thành công có xác nhận | "Giao cho Nam viết tài liệu API, hạn 2026-10-30" → "ok" | Bot tóm tắt, hỏi xác nhận, rồi báo đã tạo kèm id |
| 2 | User từ chối | "Tạo task Viết test e2e cho Hoa hạn 2026-11-05" → "không" | "Đã huỷ", log MCP **không** có `create_task` |
| 3 | Thiếu thông tin | "Tạo task Review code cho Minh" | Bot hỏi hạn chót, không tự điền |
| 4a | Trùng | "Giao cho Nam việc tối ưu trang chủ hạn 2026-10-30" → "ok" | Bot báo trùng task #4 |
| 4b | Dữ liệu sai | "Tạo task Họp cho Lan hạn 2026-01-01" → "ok" | Bot báo hạn chót ở quá khứ, hỏi lại ngày |

---


# Bài 4 — Tracing với OpenTelemetry + Jaeger

Một lời gọi tool MCP ra đúng **một** trace trên Jaeger, đi qua `mcp → graphql → user-api / task-api → db.query`. Jaeger UI: http://localhost:16686.

## Cách làm (Node thay cho Python trong tài liệu)

| Tài liệu (Python) | Dự án (Node) |
|---|---|
| `pip install opentelemetry-distro opentelemetry-exporter-otlp` + `opentelemetry-bootstrap -a install` | `npm i @opentelemetry/api @opentelemetry/auto-instrumentations-node` |
| `opentelemetry-instrument uvicorn main:app` | `node --import @opentelemetry/auto-instrumentations-node/register index.js` (REST, MCP) · `node --require ./tracing.cjs index.js` (GraphQL, để cấu hình `ignoreTrivialResolveSpans`) |
| `OTEL_*` trong `environment` của Compose | Như tài liệu, khai một lần bằng YAML anchor `x-otel`, mỗi service tự đặt `OTEL_SERVICE_NAME` |
| Auto-instrument FastAPI + HTTPX | Auto-instrument `http` (server), `undici` (`fetch` — tự gắn `traceparent`), `express`, `graphql` |
| `OTEL_PYTHON_LOG_CORRELATION` + `python-json-logger` | `otel.js`: hàm `log()` in JSON, lấy `otelTraceID`/`otelSpanID` từ span đang chạy |
| `tracer.start_as_current_span(...)` | `withSpan()` / `withSpanSync()` trong `otel.js` (lỗi → `setStatus(ERROR)`, span đỏ) |
| Auto-instrument psycopg | `node:sqlite` chưa có instrumentation → bọc mỗi câu SQL trong span `db.query` (`db.system=sqlite`, `db.statement`) |

Biến dùng chung (`docker-compose.yml`):

```yaml
x-otel: &otel
  OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4317
  OTEL_EXPORTER_OTLP_PROTOCOL: grpc
  OTEL_TRACES_EXPORTER: otlp
  OTEL_METRICS_EXPORTER: none
  OTEL_LOGS_EXPORTER: none
  OTEL_NODE_ENABLED_INSTRUMENTATIONS: http,express,graphql,undici
  OTEL_NODE_RESOURCE_DETECTORS: env,host,os,process   # bỏ dò cloud gây cảnh báo khi chạy local
```

## Span thủ công

| Service | Span | Thuộc tính |
|---|---|---|
| MCP | `mcp.tool <tên tool>` cho cả 5 tool | `mcp.tool.name`; tool trả `ok=false` → span ERROR |
| GraphQL | `graphql.resolve <field>` (auto, đã bỏ field tầm thường) | path của field |
| Task API | `validate_task`, `kiem_tra_trung`, `tinh_thong_ke`, `xep_hang` | `task.assignee_id`, `task.duplicate`, `stats.assignee_count`, `ranking.by` |
| User API, Task API | `db.query` mỗi câu SQL | `db.system`, `db.name`, `db.statement` |

Không gắn dữ liệu nhạy cảm (API key, tên người dùng nhập, nội dung task) vào attribute.

## Trace thành công — `find_person_tasks(name="Lan", status="open")`

```
mcp | POST /mcp
  mcp | mcp.tool find_person_tasks
    mcp | POST (fetch → GraphQL, tự gắn traceparent)
      graphql | POST /graphql
        graphql | graphql.parse · graphql.validate
        graphql | query
          graphql | graphql.resolve users
            graphql | GET → user-api | GET /users → db.query × 2
          graphql | graphql.resolve users.items.*.taskStats      ← DataLoader, 1 lời gọi
            graphql | GET → task-api | GET /tasks/stats → tinh_thong_ke → db.query
          graphql | graphql.resolve users.items.*.tasks
            graphql | GET → task-api | GET /tasks → db.query × 2
```

24 span, 4 service, 1 trace id. Trước khi bật `ignoreTrivialResolveSpans` + `mergeItems` trace có 53 span (mỗi field `id`, `title`… một span).

## Trace lỗi — tắt `task-api` rồi gọi lại

```
mcp | mcp.tool find_person_tasks                       ❌ ERROR (tool trả ok=false)
  graphql | graphql.resolve users                       ✓ user-api trả bình thường
  graphql | graphql.resolve users.items.*.taskStats     ❌ ERROR
    graphql | GET → task-api                            ❌ ERROR  (không có span task-api nào)
  graphql | graphql.resolve users.items.*.tasks         ❌ ERROR
    graphql | GET → task-api                            ❌ ERROR
```

Đọc trace: lỗi phát sinh ở lời gọi **GraphQL → Task API**, Task API không nhận được request (không có span phía server). Log GraphQL ghi `ERROR REST GET /tasks thất bại`, MCP trả `UPSTREAM_UNAVAILABLE, service: task-api`. Mất ~8 s mới báo lỗi vì Docker DNS chờ phân giải tên container đã dừng.

## Grep log theo trace id

Trace lỗi ở trên (task-api tắt), trace id `dd03f90e1b3d562ab5fd2ce7956f8677`:

```bash
docker compose logs --no-log-prefix | grep dd03f90e1b3d562ab5fd2ce7956f8677
```

```
mcp       INFO   POST /mcp method=tools/call tool=find_person_tasks
mcp       INFO   -> GraphQL {"s":"Lan","st":null}
mcp       ERROR  GraphQL errors
graphql   INFO   -> REST GET /users?q=Lan&page=1&page_size=5
graphql   INFO   -> REST GET /tasks?assignee_id=10&page=1&page_size=50
graphql   INFO   -> REST GET /tasks/stats?assignee_ids=10
graphql   ERROR  REST GET /tasks/stats thất bại: fetch failed
graphql   ERROR  REST GET /tasks thất bại: fetch failed
user-api  INFO   GET /users q=Lan ids= -> 1
```

Task API không có dòng nào vì đang tắt — đúng với trace. Mỗi dòng log là một object JSON, ví dụ dòng của user-api:

```json
{"asctime":"2026-10-14T05:26:47.362Z","levelname":"INFO","name":"user-api","message":"GET /users q=Lan ids= -> 1","otelTraceID":"dd03f90e1b3d562ab5fd2ce7956f8677","otelSpanID":"09e1f106ecd28700"}
```

## Thời gian trung bình từng tầng

`find_person_tasks(Lan, open)` gọi thẳng MCP 6 lần, bỏ lần đầu (làm nóng), số liệu lấy từ Jaeger:

| Tầng | TB (ms) | Min | Max |
|---|---|---|---|
| MCP (cả tool) | 1012 | 433 | 2917 |
| GraphQL (server) | 911 | 368 | 2708 |
| User API (server) | 117 | 88 | 195 |
| Task API (server, lượt dài nhất) | 119 | 66 | 185 |
| DB (tổng `db.query`) | 232 | 167 | 351 |

**Tầng chậm nhất: GraphQL** (gần như toàn bộ thời gian của MCP nằm trong GraphQL):

1. **Hai lượt gọi REST nối tiếp**: phải có kết quả `users` mới biết id để gọi `tasks` và `taskStats` (hai lượt sau chạy song song). Thời gian ≈ lượt 1 + lượt 2, không phải tổng các lời gọi.
2. **Chi phí mỗi lời gọi HTTP** (mở kết nối, tuần tự hoá JSON) lớn hơn chính thời gian REST xử lý (~120 ms, trong đó SQL ~40–90 ms).
3. **`graphql.validate`** tốn 60–260 ms mỗi lần vì query được gửi dạng chuỗi, mỗi lần đều parse + validate lại.
4. Máy chạy local (laptop 4 nhân, CPU thường xuyên cao) nên dao động lớn: Max gấp ~7 lần Min.

Hướng cải thiện nếu cần: cache kết quả parse/validate theo chuỗi query, thêm endpoint REST trả user + stats + tasks trong một lần cho đúng câu hỏi hay gặp, giữ kết nối HTTP (keep-alive) giữa GraphQL và REST.

Toàn bộ lượt trả lời bot (~15–20 s) phần lớn nằm ở OpenClaw (dựng ngữ cảnh ~10–13 s, 2 lượt gọi LLM ~3 s) — xem log `agent turn milestone` của OpenClaw. Phần MCP → GraphQL → REST chỉ chiếm ~0,5–1 s.

## OpenClaw có gửi `traceparent` không

**Không.** Kiểm tra bằng đoạn log tạm ở MCP (bước 3 của tài liệu), hỏi bot 2 câu trong Element:

| Thời điểm | Tool bot gọi | `traceparent` nhận được | Trace id (do MCP tự tạo) |
|---|---|---|---|
| 06:46:43 | `list_tasks` | `None` | `68678155…` |
| 06:48:19 | `find_person_tasks` | `None` | `b49d0f8d6baf1bf329f2c5ed7b809673` |

→ OpenClaw 2026.9.6 (cấu hình hiện tại) không gắn `traceparent` khi gọi MCP, nên **trace bắt đầu từ MCP**. Theo tài liệu như vậy vẫn đủ cho bài này. Thời gian bên trong OpenClaw (dựng ngữ cảnh, gọi LLM) xem ở log `agent turn milestone` của OpenClaw, không có trên Jaeger.

Trace của câu hỏi thật từ bot (`b49d0f8d…`): 24 span, đủ mcp → graphql → user-api, task-api → db.query, tổng 1,66 s phía MCP.

Đoạn log tạm đã xoá khỏi `services/mcp/index.js` sau khi ghi kết quả.

## Đối chiếu tiêu chí (mục 11.8)

| Tiêu chí | Kết quả |
|---|---|
| Một câu hỏi ra đúng một trace chứa span của cả 3 tầng | Có: mcp, graphql, user-api, task-api chung 1 trace id |
| Trace lỗi chỉ ra được tầng gây lỗi | Có: span ERROR tại `graphql → task-api`, không có span task-api |
| Log JSON, mỗi dòng có `otelTraceID` | Có, cả 4 service |
| Span thủ công cho nghiệp vụ chính | `mcp.tool *`, `validate_task`, `kiem_tra_trung`, `tinh_thong_ke`, `xep_hang`, `db.query` |
=======
# Bài 3 — Đăng nhập SSO cho Element bằng Keycloak

Keycloak chỉ dùng để đăng nhập Element. MCP, GraphQL, REST không thay đổi gì. Bot `@taskbot` và `@admin` vẫn đăng nhập bằng mật khẩu.

## C1 — System Context (cập nhật)

```mermaid
flowchart LR
  user([Thành viên team]) -- chat --> element[Element]
  user -- đăng nhập SSO --> kc[Keycloak]
  element -- Matrix Client API --> synapse[Synapse]
  synapse -- OIDC: đổi code lấy token, đọc userinfo --> kc
  synapse -- sự kiện phòng --> openclaw[OpenClaw bot]
  openclaw -- prompt / tool call --> llm[(LLM provider)]
  openclaw -- MCP tools --> taskSys[[Hệ thống Task: MCP + GraphQL + REST]]
```

## C2 — Container (cập nhật)

```mermaid
flowchart TB
  browser([Trình duyệt])
  subgraph Compose [docker-compose — agent-stack]
    element[Element :8080]
    synapse[Synapse :8008]
    kc[Keycloak :8180<br/>realm geo, client synapse]
    openclaw[OpenClaw gateway<br/>bot @taskbot]
    mcp[MCP :8004] --> gql[GraphQL :8003]
    gql --> uapi[User API :8001] --> udb[(users.db)]
    gql --> tapi[Task API :8002] --> tdb[(tasks.db)]
    tapi -. xác minh người được giao .-> uapi
  end
  browser --> element
  browser -- trang đăng nhập<br/>localhost:8180 --> kc
  element --> synapse
  synapse -- token / userinfo / jwks<br/>keycloak:8080 (mạng Docker) --> kc
  synapse --> openclaw
  openclaw -- mcp:8000/mcp --> mcp
  openclaw --> llm[(OpenAI)]
```

## Sequence — đăng nhập SSO (lần đầu)

```mermaid
sequenceDiagram
  actor U as User (trình duyệt)
  participant E as Element :8080
  participant S as Synapse :8008
  participant K as Keycloak :8180

  U->>E: mở trang đăng nhập
  E->>S: GET /_matrix/client/v3/login
  S-->>E: flows: m.login.sso [Keycloak], m.login.password
  U->>E: bấm "Keycloak"
  E->>S: GET /login/sso/redirect/oidc-keycloak?redirectUrl=localhost:8080
  S-->>U: 302 → localhost:8180/realms/geo/.../auth (client_id=synapse, state, nonce)
  U->>K: trang đăng nhập Keycloak
  U->>K: username lan + mật khẩu
  K-->>U: 302 → localhost:8008/_synapse/client/oidc/callback?code=…
  U->>S: GET /oidc/callback?code=…
  S->>K: POST keycloak:8080/.../token (code + client_secret)
  K-->>S: id_token (iss=http://localhost:8180/realms/geo) + access_token
  S->>K: GET keycloak:8080/.../certs (kiểm chữ ký id_token)
  S->>K: GET keycloak:8080/.../userinfo
  K-->>S: preferred_username=lan, name=Lan Nguyen, email
  S->>S: localpart_template → @lan:localhost<br/>chưa có → tạo tài khoản, display name, email
  S-->>U: 302 → localhost:8080 kèm loginToken
  U->>E: Element đổi loginToken lấy access token (m.login.token)
  E-->>U: đã đăng nhập @lan:localhost (Lan Nguyen)
```

Nhánh lỗi thường gặp:

| Bước hỏng | Triệu chứng | Nguyên nhân |
|---|---|---|
| Redirect sang Keycloak | `Invalid parameter: redirect_uri` | Valid redirect URI của client khác `public_baseurl` + `_synapse/client/oidc/callback` |
| Synapse đổi code lấy token | Quay về Synapse báo lỗi | Synapse không gọi được Keycloak, hoặc sai `client_secret` |
| Kiểm `id_token` | Sai issuer | `KC_HOSTNAME` của Keycloak khác `issuer` trong `homeserver.yaml` |
| Tạo tài khoản | Tài khoản đã tồn tại | Username Keycloak trùng tài khoản Synapse có sẵn (`admin`, `taskbot`) |

## Cấu hình đã dùng

**Keycloak** (service `keycloak` trong `docker-compose.yml`, cấu hình bằng `keycloak/setup-keycloak.sh` — tương đương thao tác tay ở mục 10.4):

| Mục | Giá trị |
|---|---|
| Image | `quay.io/keycloak/keycloak:26.7.1`, `start-dev` |
| `KC_HOSTNAME` | `http://localhost:8180` (cố định issuer) |
| `KC_HOSTNAME_BACKCHANNEL_DYNAMIC` | `true` (cho Synapse gọi qua `keycloak:8080` trong mạng Docker) |
| Realm | `geo` |
| Client | `synapse`, Client authentication bật, Standard flow bật |
| Valid redirect URIs | `http://localhost:8008/_synapse/client/oidc/callback` |
| User test | `lan` (Lan Nguyen, lan@example.com), mật khẩu không Temporary |

**Synapse** (`synapse-data/homeserver.yaml`, không commit — file chứa secret):

```yaml
public_baseurl: "http://localhost:8008/"

oidc_providers:
  - idp_id: keycloak
    idp_name: "Keycloak"
    issuer: "http://localhost:8180/realms/geo"
    client_id: "synapse"
    client_secret: "<ĐÃ CHE>"
    scopes: ["openid", "profile", "email"]
    discover: false
    authorization_endpoint: "http://localhost:8180/realms/geo/protocol/openid-connect/auth"   # trình duyệt
    token_endpoint: "http://keycloak:8080/realms/geo/protocol/openid-connect/token"           # Synapse, mạng Docker
    userinfo_endpoint: "http://keycloak:8080/realms/geo/protocol/openid-connect/userinfo"
    jwks_uri: "http://keycloak:8080/realms/geo/protocol/openid-connect/certs"
    skip_verification: true   # local http, chỉ dùng cho local
    user_mapping_provider:
      config:
        localpart_template: "{{ user.preferred_username }}"
        display_name_template: "{{ user.name }}"
        email_template: "{{ user.email }}"

sso:
  client_whitelist:
    - "http://localhost:8080/"   # quay về Element không hiện trang hỏi xác nhận
```

**Khác tài liệu và lý do:**

| Tài liệu | Ở đây | Lý do |
|---|---|---|
| `docker run keycloak` riêng + Synapse `--add-host` | Keycloak và Synapse cùng `docker-compose` | 3 endpoint phía server dùng `keycloak:8080` thay vì `host.docker.internal:8180` |
| Không có | `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` | Keycloak 26 chấp nhận gọi back-channel qua hostname nội bộ, issuer vẫn là `localhost:8180` |
| Không có | `sso.client_whitelist` | Bỏ trang trung gian "Continue to localhost:8080?" của Synapse |
| Bot chỉ cho `@admin` | Thêm `@lan:localhost` vào `groupAllowFrom` / `dm.allowFrom` | Để user SSO hỏi được bot (mục 10.7 bước 5) |

## Kết quả kiểm tra

| Tiêu chí (mục 10.9) | Kết quả |
|---|---|
| Màn hình đăng nhập Element có nút Keycloak | `GET /login` trả `m.login.sso [Keycloak]` |
| Đăng nhập user Keycloak, tài khoản Matrix tự tạo lần đầu | `@lan:localhost`, `external_ids: oidc-keycloak` |
| Tên hiển thị lấy từ Keycloak | `Lan Nguyen` |
| Bot và admin vẫn đăng nhập bằng mật khẩu | `m.login.password` vẫn bật |
| Không có secret trong repo | `homeserver.yaml`, `.env.local`, `openclaw.json` trong `.gitignore` |

Ảnh nộp bài: màn hình đăng nhập có nút Keycloak · trang đăng nhập Keycloak · Element sau khi đăng nhập là Lan Nguyen · Lan hỏi bot trong phòng, bot trả lời.
