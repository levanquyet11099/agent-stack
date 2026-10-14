# AGENTS — bản đồ năng lực

MCP server `task-assistant` (Streamable HTTP).

| Tool | Khi nào dùng |
|---|---|
| `find_person_tasks(name, status?)` | Câu hỏi có nêu tên một người: "task của Lan", "Nam còn mấy việc chưa xong", "Hoa có việc nào quá hạn không" |
| `list_tasks(status?, overdue?, search?, page?)` | Câu hỏi về cả team, không nêu tên: "việc nào quá hạn" (`overdue=true`), "những việc nào đang mở, ai làm", "task nào liên quan database" |
| `rank_people(by)` | So sánh giữa người với người: "ai hoàn thành nhiều nhất" (`done`), "ai còn nhiều việc nhất" (`open`), "ai trễ hạn nhiều nhất" (`overdue`) |
| `get_task(taskId)` | Hỏi chi tiết một task theo số id |
| `create_task(title, assigneeName, dueDate, confirmed)` | **Ghi dữ liệu.** "giao cho Nam việc X hạn thứ 6", "tạo task ...". Chỉ gọi sau khi user xác nhận bản tóm tắt (xem SOUL.md mục 7–11) |

`status`: `open` = chưa xong, `done` = đã xong.
