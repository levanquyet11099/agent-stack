// MCP server (Streamable HTTP, stateless) bọc GraphQL thành tool cho OpenClaw.
// Endpoint: http://localhost:8004/mcp  (không có dấu / cuối)
import { createHash } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 8000);
const GRAPHQL_URL = process.env.GRAPHQL_URL ?? 'http://localhost:8003/graphql';
const log = (...a) => console.log(new Date().toISOString(), 'mcp', ...a);

async function gql(query, variables) {
  log('-> GraphQL', JSON.stringify(variables));
  let body;
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(25_000), // > timeout GraphQL → REST (15s)
    });
    body = await res.json();
  } catch (e) {
    log('GraphQL unreachable:', e.message);
    return { ok: false, error: 'Dịch vụ dữ liệu đang không phản hồi, vui lòng thử lại sau.' };
  }
  if (body.errors?.length) {
    const details = body.errors.map((e) => ({ message: e.message, ...e.extensions }));
    log('GraphQL errors:', JSON.stringify(details));
    return { ok: false, error: 'Dịch vụ dữ liệu báo lỗi.', details };
  }
  return { ok: true, data: body.data };
}

const result = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], isError: obj.ok === false });
const statusArg = z.enum(['open', 'done']).optional().describe('"open" = chưa xong, "done" = đã xong, bỏ trống = tất cả');
const toEnum = (s) => (s ? s.toUpperCase() : null);

function buildServer() {
  const server = new McpServer(
    { name: 'task-assistant', version: '1.0.0' },
    {
      instructions:
        'Tra cứu người dùng và task của team. Chỉ trả lời bằng dữ liệu tool trả về. ' +
        'Nếu found=false, nói rõ là không có dữ liệu, không được bịa. ' +
        'Số liệu (total/open/done/overdue) dùng nguyên giá trị tool trả, không tự cộng trừ.',
    },
  );

  server.registerTool(
    'find_person_tasks',
    {
      description:
        'Tìm người theo tên (không cần dấu) và trả task của họ kèm thống kê. ' +
        'Dùng cho câu hỏi kiểu "task của Lan còn mấy việc chưa xong?". ' +
        'taskStats.open/done/overdue là số do hệ thống tính — trả lời bằng đúng số này. ' +
        'found=false nghĩa là không có người này: nói không có dữ liệu.',
      inputSchema: { name: z.string().min(1).describe('Tên người, ví dụ "Lan"'), status: statusArg },
    },
    async ({ name, status }) => {
      const res = await gql(
        `query($s: String!, $st: TaskStatus) {
          users(search: $s, pageSize: 5) {
            total
            items {
              id name department
              taskStats { total open done overdue }
              tasks(status: $st, pageSize: 50) { total items { id title status dueDate overdue } }
            }
          }
        }`,
        { s: name, st: toEnum(status) },
      );
      if (!res.ok) return result(res);
      const users = res.data.users;
      if (users.total === 0) return result({ ok: true, found: false, message: `Không có người dùng nào tên '${name}' trong hệ thống.` });
      return result({ ok: true, found: true, people: users.items });
    },
  );

  server.registerTool(
    'list_tasks',
    {
      description:
        'Liệt kê task của CẢ TEAM kèm tên người được giao (gom Task API + User API). ' +
        'Dùng khi câu hỏi KHÔNG nêu tên người, ví dụ "việc nào quá hạn?", "những việc nào đang mở, ai làm?". ' +
        'overdue=true để lấy việc quá hạn. total là tổng số task khớp điều kiện, do hệ thống tính. Mỗi trang 20 task.',
      inputSchema: {
        status: statusArg,
        overdue: z.boolean().optional().describe('true = chỉ việc quá hạn (chưa xong và đã qua hạn)'),
        search: z.string().max(100).optional().describe('Từ khóa trong tiêu đề task'),
        page: z.number().int().min(1).default(1),
      },
    },
    async ({ status, overdue, search, page }) => {
      const res = await gql(
        `query($st: TaskStatus, $od: Boolean, $q: String, $p: Int) {
          tasks(status: $st, overdue: $od, search: $q, page: $p, pageSize: 20) {
            total page pageSize
            items { id title status dueDate overdue assignee { name department } }
          }
        }`,
        { st: toEnum(status), od: overdue ?? null, q: search ?? null, p: page },
      );
      if (!res.ok) return result(res);
      const tasks = res.data.tasks;
      if (tasks.total === 0) return result({ ok: true, found: false, message: 'Không có task nào khớp điều kiện.' });
      return result({ ok: true, found: true, ...tasks });
    },
  );

  server.registerTool(
    'rank_people',
    {
      description:
        'Xếp hạng thành viên theo số task, do hệ thống tính sẵn. ' +
        'Dùng cho câu hỏi so sánh giữa người với người: "ai hoàn thành nhiều việc nhất?" (by=done), ' +
        '"ai còn nhiều việc nhất?" (by=open), "ai trễ hạn nhiều nhất?" (by=overdue), "ai được giao nhiều nhất?" (by=total). ' +
        'rank do hệ thống tính: cùng rank nghĩa là bằng nhau. Không tự đếm hay so sánh lại.',
      inputSchema: { by: z.enum(['total', 'open', 'done', 'overdue']).default('total') },
    },
    async ({ by }) => {
      const res = await gql(
        `query($by: RankBy) { taskRanking(by: $by) { rank total open done overdue assignee { name department } } }`,
        { by: by.toUpperCase() },
      );
      if (!res.ok) return result(res);
      const items = res.data.taskRanking;
      if (items.length === 0) return result({ ok: true, found: false, message: 'Chưa có task nào trong hệ thống.' });
      return result({ ok: true, found: true, by, items });
    },
  );

  server.registerTool(
    'get_task',
    {
      description: 'Xem chi tiết một task theo id, kèm người được giao. found=false nếu không tồn tại.',
      inputSchema: { taskId: z.number().int().describe('Id của task') },
    },
    async ({ taskId }) => {
      const res = await gql(
        `query($id: ID!) { task(id: $id) { id title status dueDate overdue assignee { id name email department } } }`,
        { id: String(taskId) },
      );
      if (!res.ok) return result(res);
      if (!res.data.task) return result({ ok: true, found: false, message: `Không có task id=${taskId}.` });
      return result({ ok: true, found: true, task: res.data.task });
    },
  );

  server.registerTool(
    'create_task',
    {
      description:
        'Tạo task mới cho một thành viên. GHI DỮ LIỆU THẬT — làm đúng thứ tự: ' +
        '(1) Cần đủ 3 thông tin từ user: tiêu đề, tên người được giao, hạn chót. Thiếu cái nào thì HỎI LẠI user, ' +
        'không tự đặt tiêu đề, không tự chọn người, không tự chọn ngày. ' +
        '(2) Tóm tắt lại cho user (tiêu đề, người được giao, hạn chót dạng YYYY-MM-DD) và hỏi "Xác nhận tạo không?". ' +
        '(3) CHỈ gọi tool này sau khi user trả lời đồng ý rõ ràng (có/ok/đồng ý), với confirmed=true. ' +
        'User từ chối hoặc muốn sửa thì KHÔNG gọi. ' +
        'Kết quả: created=true là đã tạo. ok=false kèm code: VALIDATION_ERROR (dữ liệu sai, xem details), ' +
        'ASSIGNEE_NOT_FOUND / AMBIGUOUS_ASSIGNEE (không tìm thấy / nhiều người trùng tên → hỏi lại user), ' +
        'DUPLICATE_TASK (người đó đã có task đang mở trùng tiêu đề, xem details.existing_task). ' +
        'Báo đúng lý do cho user, không tự sửa dữ liệu rồi gọi lại.',
      inputSchema: {
        title: z.string().describe('Tiêu đề task, đúng như user nói'),
        assigneeName: z.string().describe('Tên người được giao, ví dụ "Nam"'),
        dueDate: z.string().describe('Hạn chót dạng YYYY-MM-DD. User nói ngày tương đối ("thứ 6 tuần sau") thì quy đổi và đưa vào bước xác nhận'),
        confirmed: z.literal(true).describe('Chỉ đặt true sau khi user đã đồng ý bản tóm tắt'),
      },
    },
    async ({ title, assigneeName, dueDate }) => {
      // 1. Tìm người được giao theo tên (tra cứu, không phải nghiệp vụ)
      const found = await gql(`query($s: String!) { users(search: $s, pageSize: 5) { total items { id name department } } }`, { s: assigneeName });
      if (!found.ok) return result(found);
      const { total, items } = found.data.users;
      if (total === 0) {
        return result({ ok: false, code: 'ASSIGNEE_NOT_FOUND', error: `Không có thành viên nào tên '${assigneeName}'. Hỏi lại user tên người được giao.` });
      }
      if (total > 1) {
        return result({ ok: false, code: 'AMBIGUOUS_ASSIGNEE', error: `Có ${total} người khớp tên '${assigneeName}'. Hỏi user chọn đúng người.`, candidates: items });
      }
      const assignee = items[0];

      // 2. Idempotency-Key theo nội dung + khung 10 phút: agent retry khi timeout sẽ không tạo bản ghi thứ hai
      const window = Math.floor(Date.now() / 600_000);
      const idempotencyKey = 'mcp-' + createHash('sha256').update(`${title}|${assignee.id}|${dueDate}|${window}`).digest('hex').slice(0, 40);

      // 3. Gọi mutation — validation, chống trùng do Task API làm
      const res = await gql(
        `mutation($in: CreateTaskInput!, $key: String) {
          createTask(input: $in, idempotencyKey: $key) { id title status dueDate overdue assignee { name department } }
        }`,
        { in: { title, assigneeId: String(assignee.id), dueDate }, key: idempotencyKey },
      );
      if (!res.ok) {
        const err = res.details?.[0];
        const userErrors = ['VALIDATION_ERROR', 'ASSIGNEE_NOT_FOUND', 'DUPLICATE_TASK', 'IDEMPOTENCY_CONFLICT', 'BAD_REQUEST'];
        if (err && userErrors.includes(err.code)) {
          return result({ ok: false, code: err.code, error: err.message, details: err.details ?? null });
        }
        return result(res); // lỗi hệ thống
      }
      return result({ ok: true, created: true, task: res.data.createTask });
    },
  );

  return server;
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Stateless: mỗi request một server + transport
app.post('/mcp', async (req, res) => {
  log(`POST /mcp method=${req.body?.method ?? '?'}${req.body?.params?.name ? ` tool=${req.body.params.name}` : ''}`);
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});

// Stateless nên không hỗ trợ GET (stream) / DELETE (session)
const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

app.listen(PORT, () => log(`listening on :${PORT}/mcp`));
