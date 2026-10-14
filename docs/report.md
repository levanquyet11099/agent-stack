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
