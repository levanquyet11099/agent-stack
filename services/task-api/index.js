import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { log as jlog, withSpanSync } from './otel.js';

import { createHash } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8000);
const API_KEY = process.env.API_KEY ?? 'dev-key';
const USER_API = process.env.USER_API_URL ?? 'http://localhost:8001';
const log = (...a) => jlog('INFO', a.join(' '));
const today = () => new Date().toISOString().slice(0, 10);

const db = new DatabaseSync(process.env.DB_PATH ?? 'tasks.db');

// Mỗi câu SQL là 1 span "db.query" trên Jaeger (node:sqlite không có auto-instrumentation)
const sql = (text) => {
  const statement = text.replace(/\s+/g, ' ').trim();
  const call = (method) => (...p) =>
    withSpanSync('db.query', { 'db.system': 'sqlite', 'db.name': 'tasks', 'db.statement': statement }, () => db.prepare(text)[method](...p));
  return { get: call('get'), all: call('all'), run: call('run') };
};
db.exec('CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT, assignee_id INTEGER, due_date TEXT)');
const seed = db.prepare('INSERT OR IGNORE INTO tasks VALUES (?,?,?,?,?)');
for (const t of [
  [1, 'Sửa lỗi đăng nhập', 'open', 10, '2026-10-05'],
  [2, 'Viết OpenAPI spec cho Order API', 'open', 10, '2026-10-30'],
  [3, 'Review PR thanh toán', 'done', 10, '2026-10-01'],
  [4, 'Tối ưu trang chủ', 'open', 20, '2026-10-20'],
  [5, 'Dựng CI cho frontend', 'done', 20, '2026-09-25'],
  [6, 'Viết test hồi quy giỏ hàng', 'open', 30, '2026-10-10'],
  [7, 'Migrate database lên Postgres 17', 'open', 40, '2026-11-15'],
  [8, 'Thêm index cho bảng orders', 'open', 10, '2026-11-01'],
  [9, 'Cấu hình backup', 'done', 50, '2026-10-02'],
]) seed.run(...t);
// Lưu kết quả theo Idempotency-Key: gửi lại cùng key → trả lại đúng kết quả cũ, không tạo thêm
db.exec('CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, request_hash TEXT, status INTEGER, body TEXT, created_at TEXT)');

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
const invalid = (details) => new ApiError(422, 'VALIDATION_ERROR', 'Tham số không hợp lệ', details);

function intParam(q, name, def, min, max) {
  if (q[name] === undefined) return def;
  const n = Number(q[name]);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid([{ loc: ['query', name], msg: `phải là số nguyên ${min}..${max}` }]);
  return n;
}

// Nghiệp vụ "quá hạn" tính ở REST, không để GraphQL hay bot tự suy ra
const toTask = (t) => ({ ...t, overdue: t.status === 'open' && t.due_date < today() });

const app = express();

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((req, _res, next) => {
  if (req.get('X-API-Key') !== API_KEY) throw new ApiError(401, 'UNAUTHORIZED', 'Thiếu hoặc sai X-API-Key');
  next();
});
app.use(express.json());

// So trùng tiêu đề: không phân biệt hoa thường, gộp khoảng trắng
const normTitle = (s) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

// "2026-02-30", "2026-13-01" khớp regex nhưng không phải ngày thật
const isRealDate = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

function validateCreate(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};
  const title = typeof b.title === 'string' ? b.title.trim().replace(/\s+/g, ' ') : undefined;
  if (title === undefined || title === '') errors.push({ loc: ['body', 'title'], msg: 'bắt buộc' });
  else if (title.length < 3 || title.length > 200) errors.push({ loc: ['body', 'title'], msg: 'dài 3–200 ký tự' });

  if (b.assignee_id === undefined) errors.push({ loc: ['body', 'assignee_id'], msg: 'bắt buộc' });
  else if (!Number.isInteger(b.assignee_id) || b.assignee_id < 1) errors.push({ loc: ['body', 'assignee_id'], msg: 'phải là số nguyên dương' });

  if (b.due_date === undefined) errors.push({ loc: ['body', 'due_date'], msg: 'bắt buộc' });
  else if (typeof b.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.due_date) || !isRealDate(b.due_date)) {
    errors.push({ loc: ['body', 'due_date'], msg: 'ngày không hợp lệ, định dạng YYYY-MM-DD' });
  } else if (b.due_date < today()) errors.push({ loc: ['body', 'due_date'], msg: `không được ở quá khứ (hôm nay ${today()})` });

  if (errors.length) throw invalid(errors);
  return { title, assignee_id: b.assignee_id, due_date: b.due_date };
}

async function assigneeExists(id) {
  let r;
  try {
    r = await fetch(`${USER_API}/users/${id}`, { headers: { 'X-API-Key': API_KEY }, signal: AbortSignal.timeout(5000) });
  } catch {
    throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'Không kiểm tra được người được giao (User API không phản hồi)');
  }
  if (r.status === 404) return false;
  if (!r.ok) throw new ApiError(503, 'UPSTREAM_ERROR', `User API lỗi ${r.status}`);
  return true;
}

app.post('/tasks', async (req, res) => {
  const key = req.get('Idempotency-Key');
  if (key !== undefined && !/^[\w-]{8,100}$/.test(key)) throw invalid([{ loc: ['header', 'Idempotency-Key'], msg: '8–100 ký tự chữ, số, - hoặc _' }]);
  const requestHash = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

  if (key) {
    const saved = sql('SELECT * FROM idempotency WHERE key = ?').get(key);
    if (saved) {
      if (saved.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key đã dùng cho một yêu cầu khác');
      log(`POST /tasks replay key=${key}`);
      return res.status(saved.status).set('Idempotent-Replay', 'true').json(JSON.parse(saved.body));
    }
  }

  const input = withSpanSync('validate_task', {}, () => validateCreate(req.body));
  if (!(await assigneeExists(input.assignee_id))) {
    throw new ApiError(422, 'ASSIGNEE_NOT_FOUND', `Không có user id=${input.assignee_id}`, [{ loc: ['body', 'assignee_id'], msg: 'không tồn tại' }]);
  }

  // Kiểm tra trùng + ghi trong cùng một đoạn đồng bộ (Node đơn luồng) nên không bị chen ngang
  const dup = withSpanSync('kiem_tra_trung', { 'task.assignee_id': input.assignee_id }, (span) => {
    const found = sql("SELECT * FROM tasks WHERE assignee_id = ? AND status = 'open'").all(input.assignee_id)
      .find((t) => normTitle(t.title) === normTitle(input.title));
    span.setAttribute('task.duplicate', !!found);
    return found;
  });
  if (dup) {
    throw new ApiError(409, 'DUPLICATE_TASK', `Người này đã có task đang mở trùng tiêu đề (id=${dup.id})`, { existing_task: toTask(dup) });
  }
  const { lastInsertRowid } = sql("INSERT INTO tasks (title, status, assignee_id, due_date) VALUES (?, 'open', ?, ?)")
    .run(input.title, input.assignee_id, input.due_date);
  const created = toTask(sql('SELECT * FROM tasks WHERE id = ?').get(Number(lastInsertRowid)));
  if (key) {
    sql('INSERT INTO idempotency VALUES (?, ?, ?, ?, ?)').run(key, requestHash, 201, JSON.stringify(created), new Date().toISOString());
  }
  log(`POST /tasks created id=${created.id} assignee=${created.assignee_id} key=${key ?? ''}`);
  res.status(201).set('Location', `/tasks/${created.id}`).json(created);
});

app.get('/tasks', (req, res) => {
  const { status, q, overdue } = req.query;
  const assigneeId = intParam(req.query, 'assignee_id', undefined, 0, Number.MAX_SAFE_INTEGER);
  const page = intParam(req.query, 'page', 1, 1, 1e6);
  const pageSize = intParam(req.query, 'page_size', 20, 1, 100);
  if (status !== undefined && !['open', 'done'].includes(status)) throw invalid([{ loc: ['query', 'status'], msg: 'open | done' }]);
  if (q !== undefined && (typeof q !== 'string' || q.length > 100)) throw invalid([{ loc: ['query', 'q'], msg: 'tối đa 100 ký tự' }]);
  if (overdue !== undefined && !['true', 'false'].includes(overdue)) throw invalid([{ loc: ['query', 'overdue'], msg: 'true | false' }]);

  const where = [], params = [];
  if (assigneeId !== undefined) { where.push('assignee_id = ?'); params.push(assigneeId); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (q) { where.push('LOWER(title) LIKE ?'); params.push(`%${q.toLowerCase()}%`); }
  if (overdue !== undefined) {
    where.push(overdue === 'true' ? "(status = 'open' AND due_date < ?)" : "NOT (status = 'open' AND due_date < ?)");
    params.push(today());
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = sql(`SELECT COUNT(*) AS total FROM tasks ${clause}`).get(...params);
  const items = sql(`SELECT * FROM tasks ${clause} ORDER BY due_date LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  log(`GET /tasks assignee=${assigneeId ?? ''} status=${status ?? ''} overdue=${overdue ?? ''} q=${q ?? ''} -> ${total}`);
  res.json({ items: items.map(toTask), total, page, page_size: pageSize });
});

// Đặt trước /tasks/:id
app.get('/tasks/stats', (req, res) => {
  const raw = req.query.assignee_ids;
  if (typeof raw !== 'string' || !/^\d+(,\d+){0,99}$/.test(raw)) throw invalid([{ loc: ['query', 'assignee_ids'], msg: 'bắt buộc, dạng 10,20' }]);
  const ids = [...new Set(raw.split(',').map(Number))];
  const items = withSpanSync('tinh_thong_ke', { 'stats.assignee_count': ids.length }, () => {
    const rows = sql(
      `SELECT assignee_id,
              COUNT(*) AS total,
              SUM(status = 'open') AS open,
              SUM(status = 'done') AS done,
              SUM(status = 'open' AND due_date < ?) AS overdue
       FROM tasks WHERE assignee_id IN (${ids.map(() => '?').join(',')})
       GROUP BY assignee_id`,
    ).all(today(), ...ids);
    const byId = new Map(rows.map((r) => [r.assignee_id, r]));
    return ids.map((id) => byId.get(id) ?? { assignee_id: id, total: 0, open: 0, done: 0, overdue: 0 });
  });
  log(`GET /tasks/stats ids=${ids}`);
  res.json({ items });
});

// Xếp hạng người theo số task — nghiệp vụ ở REST, bot không tự đếm/so sánh
const RANK_BY = ['total', 'open', 'done', 'overdue'];
app.get('/tasks/ranking', (req, res) => {
  const by = req.query.by ?? 'total';
  if (!RANK_BY.includes(by)) throw invalid([{ loc: ['query', 'by'], msg: RANK_BY.join(' | ') }]);
  const items = withSpanSync('xep_hang', { 'ranking.by': by }, () => {
    const rows = sql(
      `SELECT assignee_id,
              COUNT(*) AS total,
              SUM(status = 'open') AS open,
              SUM(status = 'done') AS done,
              SUM(status = 'open' AND due_date < ?) AS overdue
       FROM tasks GROUP BY assignee_id`,
    ).all(today());
    rows.sort((a, b) => b[by] - a[by] || a.assignee_id - b.assignee_id);
    // Dense rank: bằng điểm thì cùng hạng
    let rank = 0, prev;
    return rows.map((r) => {
      if (r[by] !== prev) { rank += 1; prev = r[by]; }
      return { rank, ...r };
    });
  });
  log(`GET /tasks/ranking by=${by} -> ${items.length}`);
  res.json({ by, items });
});

app.get('/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw invalid([{ loc: ['path', 'id'], msg: 'phải là số nguyên' }]);
  const task = sql('SELECT * FROM tasks WHERE id = ?').get(id);
  log(`GET /tasks/${id} found=${!!task}`);
  if (!task) throw new ApiError(404, 'NOT_FOUND', `Không có task id=${id}`);
  res.json(toTask(task));
});

app.use((_req, _res) => { throw new ApiError(404, 'NOT_FOUND', 'Endpoint không tồn tại'); });

app.use((err, _req, res, _next) => {
  const e = err instanceof ApiError ? err
    : err.type === 'entity.parse.failed' ? new ApiError(400, 'INVALID_JSON', 'Body không phải JSON hợp lệ')
    : new ApiError(500, 'INTERNAL_ERROR', 'Lỗi hệ thống');
  if (e.status >= 500) jlog('ERROR', err.message, { stack: err.stack });
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details ?? null } });
});

app.listen(PORT, () => log(`listening on :${PORT}`));
