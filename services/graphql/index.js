// GraphQL gateway — schema-first. Resolver chỉ gọi REST và ghép dữ liệu, không xử lý nghiệp vụ.
import { readFileSync } from 'node:fs';
import DataLoader from 'dataloader';
import express from 'express';
import { GraphQLError, buildSchema } from 'graphql';
import { createHandler } from 'graphql-http/lib/use/express';

const PORT = Number(process.env.PORT ?? 8000);
const USER_API = process.env.USER_API_URL ?? 'http://localhost:8001';
const TASK_API = process.env.TASK_API_URL ?? 'http://localhost:8002';
const API_KEY = process.env.API_KEY ?? 'dev-key';
// Timeout tầng trên > tầng dưới: Task API → User API 5s, GraphQL → REST 15s, MCP → GraphQL 25s
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15000);
const log = (...a) => console.log(new Date().toISOString(), 'graphql', ...a);

/**
 * Gọi REST. GET 404 → null. Lỗi/timeout → GraphQLError có code rõ ràng,
 * giữ nguyên code + details của REST (lỗi validation, task trùng...) để MCP báo lại cho user.
 */
async function restCall(method, base, path, { params = {}, body, headers = {} } = {}) {
  const service = base === USER_API ? 'user-api' : 'task-api';
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  log(`-> REST ${method} ${url.pathname}${url.search}`); // log từng lượt gọi để soi N+1

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'X-API-Key': API_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e.name === 'TimeoutError';
    throw new GraphQLError(timeout ? `${service} timeout` : `${service} không kết nối được`, {
      extensions: { code: timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', service },
    });
  }
  if (res.status === 404 && method === 'GET') return null;
  const data = await res.json().catch(() => null);
  if (res.status >= 500) {
    throw new GraphQLError(data?.error?.message ?? `${service} lỗi ${res.status}`, {
      extensions: { code: data?.error?.code ?? 'UPSTREAM_ERROR', service },
    });
  }
  if (res.status >= 400) {
    throw new GraphQLError(data?.error?.message ?? 'Bad request', {
      extensions: { code: data?.error?.code ?? 'BAD_REQUEST', service, details: data?.error?.details ?? null },
    });
  }
  return data;
}
const restGet = (base, path, params) => restCall('GET', base, path, { params });

// REST trả snake_case + page_size → đổi sang shape của schema
const toPage = (p) => ({ items: p.items, total: p.total, page: p.page, pageSize: p.page_size });
const STATUS_OUT = { open: 'OPEN', done: 'DONE' };
const STATUS_IN = { OPEN: 'open', DONE: 'done' };

// DataLoader: gom id trong cùng một lượt, bỏ trùng, gọi REST 1 lần
const createLoaders = () => ({
  users: new DataLoader(async (ids) => {
    const data = await restGet(USER_API, '/users', { ids: ids.join(','), page_size: ids.length });
    const byId = new Map(data.items.map((u) => [u.id, u]));
    return ids.map((id) => byId.get(id) ?? null);
  }),
  stats: new DataLoader(async (ids) => {
    const data = await restGet(TASK_API, '/tasks/stats', { assignee_ids: ids.join(',') });
    const byId = new Map(data.items.map((s) => [s.assignee_id, s]));
    return ids.map((id) => byId.get(id) ?? null);
  }),
});

const resolvers = {
  Query: {
    users: async (_, { search, page, pageSize }) => toPage(await restGet(USER_API, '/users', { q: search, page, page_size: pageSize })),
    user: (_, { id }, ctx) => ctx.loaders.users.load(Number(id)),
    tasks: async (_, { status, assigneeId, overdue, search, page, pageSize }) =>
      toPage(await restGet(TASK_API, '/tasks', { status: STATUS_IN[status], assignee_id: assigneeId, overdue, q: search, page, page_size: pageSize })),
    taskRanking: async (_, { by }) => (await restGet(TASK_API, '/tasks/ranking', { by: by.toLowerCase() })).items,
    task: (_, { id }) => restGet(TASK_API, `/tasks/${Number(id)}`),
  },
  Mutation: {
    // Chỉ đổi tên field và chuyển tiếp — validation, kiểm tra người tồn tại, chống trùng đều ở Task API
    createTask: (_, { input, idempotencyKey }) =>
      restCall('POST', TASK_API, '/tasks', {
        body: { title: input.title, assignee_id: Number(input.assigneeId), due_date: input.dueDate },
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      }),
  },
  User: {
    tasks: async (user, { status, page, pageSize }) =>
      toPage(await restGet(TASK_API, '/tasks', { assignee_id: user.id, status: STATUS_IN[status], page, page_size: pageSize })),
    taskStats: (user, _, ctx) => ctx.loaders.stats.load(user.id),
  },
  RankingEntry: {
    assignee: (r, _, ctx) => ctx.loaders.users.load(r.assignee_id),
  },
  Task: {
    status: (t) => STATUS_OUT[t.status],
    dueDate: (t) => t.due_date,
    assignee: (t, _, ctx) => ctx.loaders.users.load(t.assignee_id),
  },
};

// Schema-first: dựng schema từ file SDL đã duyệt, rồi gắn resolver vào từng field
const schema = buildSchema(readFileSync(process.env.SCHEMA_PATH ?? 'schema.graphql', 'utf8'));
for (const [typeName, fields] of Object.entries(resolvers)) {
  const type = schema.getType(typeName);
  for (const [fieldName, resolve] of Object.entries(fields)) {
    const field = type?.getFields()[fieldName];
    if (!field) throw new Error(`Resolver ${typeName}.${fieldName} không có trong schema`);
    field.resolve = resolve;
  }
}

const app = express();
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
// GET /graphql trên trình duyệt → GraphiQL để gõ thử query
app.get('/graphql', (_req, res) => res.type('html').send(GRAPHIQL_HTML));
app.post(
  '/graphql',
  createHandler({ schema, context: () => ({ loaders: createLoaders() }) }), // loader mới cho từng request
);
app.listen(PORT, () => log(`listening on :${PORT}/graphql`));

const GRAPHIQL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>GraphiQL</title>
<link rel="stylesheet" href="https://unpkg.com/graphiql@3.8.3/graphiql.min.css"></head>
<body style="margin:0;height:100vh"><div id="g" style="height:100vh"></div>
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/graphiql@3.8.3/graphiql.min.js"></script>
<script>ReactDOM.createRoot(document.getElementById('g')).render(
  React.createElement(GraphiQL, { fetcher: GraphiQL.createFetcher({ url: '/graphql' }) }));</script>
</body></html>`;
