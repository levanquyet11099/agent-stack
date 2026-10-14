# Agent Stack — Bước 1, 2 và Bài 1

Element + Synapse + REST (User, Task) → GraphQL → MCP, chạy bằng Docker Compose. Tất cả service viết bằng Node.js 22.

## Cổng

| Thành phần | Cổng | Ghi chú |
|---|---|---|
| Element | 8080 | Image `vectorim/element-web`, cấu hình ở `element/config.json` |
| Synapse | 8008 | Dữ liệu ở `synapse-data/` (không commit) |
| User API | 8001 | REST, spec `specs/user-api.openapi.yaml` |
| Task API | 8002 | REST, spec `specs/task-api.openapi.yaml` |
| GraphQL | 8003 | `POST /graphql`. Mở `GET /graphql` trên trình duyệt để dùng GraphiQL. Schema ở `specs/schema.graphql` |
| MCP | 8004 | `http://localhost:8004/mcp` (Streamable HTTP, **không** có `/` cuối) |

## Chạy

Cần mở Docker Desktop trước.

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Script sẽ:
1. Sinh `homeserver.yaml` (chỉ ở lần đầu).
2. Chạy `docker compose up -d --build`.
3. Tạo 2 tài khoản `@admin:localhost` (admin) và `@taskbot:localhost` (bot). Mật khẩu ngẫu nhiên, lưu trong `.env.local` (không commit).

Dữ liệu REST nằm trong `data/users.db` và `data/tasks.db` (SQLite, không commit). Nếu muốn quay về dữ liệu mẫu ban đầu, xóa 2 file này rồi chạy `docker compose restart user-api task-api`.

Các lần sau chỉ cần chạy `docker compose up -d`. Sửa `element/config.json` xong thì chạy `docker compose restart element`.

> Tài liệu gốc chạy Element bằng `pnpm start` từ repo Element. Ở đây dùng image Docker cho gọn và kết quả tương đương. Nếu cần sửa code Element thì chạy theo cách `pnpm` trong tài liệu, với cùng nội dung `config.json`.

## Kiểm tra nhanh

```bash
curl http://localhost:8008/_matrix/client/versions
curl -H "X-API-Key: dev-key" "http://localhost:8001/users?q=lan"
curl -H "X-API-Key: dev-key" "http://localhost:8002/tasks/stats?assignee_ids=10,20"
curl -X POST http://localhost:8003/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ tasks(status: OPEN) { total items { title overdue assignee { name } } } }"}'
npx @redocly/cli lint specs/user-api.openapi.yaml specs/task-api.openapi.yaml
npx @stoplight/prism-cli mock specs/task-api.openapi.yaml   # mock server khi chưa có code
```

Xem luồng gọi: `docker compose logs -f mcp graphql user-api task-api`. GraphQL log từng lượt gọi REST (`-> REST GET ...`) để soi N+1.

## Bước 2 — OpenClaw

Phần cài đặt OpenClaw: hỏi người phụ trách theo hạ tầng hiện tại. Thông tin cần khai:

| Mục | Giá trị |
|---|---|
| Homeserver | `http://localhost:8008` |
| Tài khoản bot | `@taskbot:localhost` / mật khẩu trong `.env.local` |
| MCP server | `http://localhost:8004/mcp` (nếu OpenClaw chạy trong container thì dùng `http://host.docker.internal:8004/mcp`) |
| Persona | Copy các file trong `openclaw/` (IDENTITY, SOUL, AGENTS, USER) vào workspace OpenClaw |

Sau đó vào Element: đăng nhập `admin`, tạo phòng, mời `@taskbot:localhost`.

## Thiết kế Bài 1 — tóm tắt

- **Hai REST API có quan hệ:** `Task.assignee_id` tham chiếu tới `User.id`.
- **Nghiệp vụ nằm ở REST:**
  - Tìm theo tên không phân biệt dấu (`/users?q=`).
  - Lọc task theo người, trạng thái, từ khóa.
  - Tính `overdue`.
  - Thống kê `/tasks/stats` (total, open, done, overdue).
- **Endpoint lấy theo nhiều id cho DataLoader:** `/users?ids=` và `/tasks/stats?assignee_ids=`.
- **Các quy ước chung:**
  - Lỗi trả theo format thống nhất `{ error: { code, message, details } }`.
  - List có phân trang `page` / `page_size`.
  - Xác thực bằng header `X-API-Key`.
- **GraphQL làm theo schema-first:** dựng schema bằng `buildSchema` từ file SDL đã duyệt. Resolver chỉ gọi REST rồi đổi tên field.
- **Xử lý lỗi upstream ở GraphQL:** REST báo 404 thì GraphQL trả `null`. REST lỗi 5xx, timeout hoặc không kết nối được thì GraphQL trả `errors[].extensions.code` = `UPSTREAM_*`, kèm tên service gây lỗi.
- **MCP:** server stateless và trả JSON. Kết quả mỗi tool có `ok` và `found` để bot phân biệt 3 trường hợp: có dữ liệu, không có dữ liệu, hệ thống lỗi.

Câu query lấy dữ liệu từ cả 2 REST API:

```graphql
{ users(search: "lan") { items { name taskStats { open overdue } tasks(status: OPEN) { items { title dueDate } } } } }
```

Diagram C1/C2/C3 và sequence nằm trong [docs/report.md](docs/report.md).
