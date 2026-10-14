import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { log as jlog, withSpanSync } from './otel.js';

const PORT = Number(process.env.PORT ?? 8000);
const API_KEY = process.env.API_KEY ?? 'dev-key';
const log = (...a) => jlog('INFO', a.join(' '));

// Bỏ dấu tiếng Việt, chữ thường — để tìm "duc" ra "Đức"
const fold = (s) => s.replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const db = new DatabaseSync(process.env.DB_PATH ?? 'users.db');

// Mỗi câu SQL là 1 span "db.query" trên Jaeger (node:sqlite không có auto-instrumentation)
const sql = (text) => {
  const statement = text.replace(/\s+/g, ' ').trim();
  const call = (method) => (...p) =>
    withSpanSync('db.query', { 'db.system': 'sqlite', 'db.name': 'users', 'db.statement': statement }, () => db.prepare(text)[method](...p));
  return { get: call('get'), all: call('all'), run: call('run') };
};
db.function('fold', fold);
db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, department TEXT)');
const seed = db.prepare('INSERT OR IGNORE INTO users VALUES (?,?,?,?)');
for (const u of [
  [10, 'Lan', 'lan@example.com', 'Backend'],
  [20, 'Nam', 'nam@example.com', 'Frontend'],
  [30, 'Hoa', 'hoa@example.com', 'QA'],
  [40, 'Minh', 'minh@example.com', 'Backend'],
  [50, 'Đức', 'duc@example.com', 'DevOps'],
]) seed.run(...u);

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

const app = express();

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((req, _res, next) => {
  if (req.get('X-API-Key') !== API_KEY) throw new ApiError(401, 'UNAUTHORIZED', 'Thiếu hoặc sai X-API-Key');
  next();
});

app.get('/users', (req, res) => {
  const { q, ids } = req.query;
  const page = intParam(req.query, 'page', 1, 1, 1e6);
  const pageSize = intParam(req.query, 'page_size', 20, 1, 100);
  if (q !== undefined && (typeof q !== 'string' || q.length > 100)) throw invalid([{ loc: ['query', 'q'], msg: 'tối đa 100 ký tự' }]);
  if (ids !== undefined && !/^\d+(,\d+){0,99}$/.test(ids)) throw invalid([{ loc: ['query', 'ids'], msg: 'dạng 10,20 (tối đa 100 id)' }]);

  const where = [], params = [];
  if (q) { where.push('fold(name) LIKE ?'); params.push(`%${fold(q)}%`); }
  if (ids) {
    const list = ids.split(',').map(Number);
    where.push(`id IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = sql(`SELECT COUNT(*) AS total FROM users ${clause}`).get(...params);
  const items = sql(`SELECT * FROM users ${clause} ORDER BY id LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  log(`GET /users q=${q ?? ''} ids=${ids ?? ''} -> ${total}`);
  res.json({ items, total, page, page_size: pageSize });
});

app.get('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw invalid([{ loc: ['path', 'id'], msg: 'phải là số nguyên' }]);
  const user = sql('SELECT * FROM users WHERE id = ?').get(id);
  log(`GET /users/${id} found=${!!user}`);
  if (!user) throw new ApiError(404, 'NOT_FOUND', `Không có user id=${id}`);
  res.json(user);
});

app.use((_req, _res) => { throw new ApiError(404, 'NOT_FOUND', 'Endpoint không tồn tại'); });

// Format lỗi thống nhất: { error: { code, message, details } }
app.use((err, _req, res, _next) => {
  const e = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL_ERROR', 'Lỗi hệ thống');
  if (e.status >= 500) jlog('ERROR', err.message, { stack: err.stack });
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details ?? null } });
});

app.listen(PORT, () => log(`listening on :${PORT}`));
