// MCP server (Streamable HTTP, stateless) bọc GraphQL thành tool cho OpenClaw.
// Endpoint: http://localhost:8004/mcp  (không có dấu / cuối)
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
      signal: AbortSignal.timeout(10_000),
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
