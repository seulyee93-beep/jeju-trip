// 일정 페이지를 보여주고, 준비물 체크 상태를 Turso에 저장하는 서버 (외부 패키지 없음)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TURSO_URL = (process.env.TURSO_URL || '').replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
const TURSO_TOKEN = process.env.TURSO_TOKEN || '';
const INDEX = path.join(__dirname, 'index.html');

// Turso 설정이 없으면 메모리에만 저장 (로컬 테스트용)
const memory = new Map();
const memoryItems = [];

async function turso(statements) {
  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        ...statements.map(([sql, args = []]) => ({
          type: 'execute',
          stmt: { sql, args: args.map(v => (typeof v === 'number' ? { type: 'integer', value: String(v) } : { type: 'text', value: String(v) })) },
        })),
        { type: 'close' },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
  const data = await res.json();
  const err = data.results.find(r => r.type === 'error');
  if (err) throw new Error(err.error.message);
  return data.results.map(r => r.response && r.response.result);
}

let ready = null;
function init() {
  if (!TURSO_URL) return Promise.resolve();
  ready = ready || turso([
    ['CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, done INTEGER NOT NULL, updated_at TEXT NOT NULL)'],
    ['CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL)'],
  ]);
  return ready;
}

async function getChecks() {
  if (!TURSO_URL) return Object.fromEntries(memory);
  await init();
  const [result] = await turso([['SELECT id, done FROM checks']]);
  return Object.fromEntries(result.rows.map(([id, done]) => [id.value, Number(done.value)]));
}

async function setCheck(id, done) {
  if (!TURSO_URL) return void memory.set(id, done);
  await init();
  await turso([[
    'INSERT INTO checks (id, done, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET done = excluded.done, updated_at = excluded.updated_at',
    [id, done, new Date().toISOString()],
  ]]);
}

// 직접 추가한 준비물
async function getItems() {
  if (!TURSO_URL) return memoryItems.slice();
  await init();
  const [result] = await turso([['SELECT id, label FROM items ORDER BY created_at']]);
  return result.rows.map(([id, label]) => ({ id: id.value, label: label.value }));
}

async function addItem(label) {
  const item = { id: 'u' + Math.random().toString(36).slice(2, 10), label };
  if (!TURSO_URL) { memoryItems.push(item); return item; }
  await init();
  await turso([['INSERT INTO items (id, label, created_at) VALUES (?, ?, ?)', [item.id, label, new Date().toISOString()]]]);
  return item;
}

async function deleteItem(id) {
  if (!TURSO_URL) {
    const i = memoryItems.findIndex(x => x.id === id);
    if (i >= 0) memoryItems.splice(i, 1);
    memory.delete(`ck_${id}`);
    return;
  }
  await init();
  await turso([['DELETE FROM items WHERE id = ?', [id]], ['DELETE FROM checks WHERE id = ?', [`ck_${id}`]]]);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/checks' && req.method === 'GET') return send(res, 200, await getChecks());
    if (url.pathname === '/api/checks' && req.method === 'POST') {
      const { id, done } = await readBody(req);
      if (typeof id !== 'string' || !/^ck_[a-z0-9]{1,20}$/.test(id)) return send(res, 400, { error: 'bad id' });
      await setCheck(id, done ? 1 : 0);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/items' && req.method === 'GET') return send(res, 200, await getItems());
    if (url.pathname === '/api/items' && req.method === 'POST') {
      const label = String((await readBody(req)).label || '').trim();
      if (!label || label.length > 40) return send(res, 400, { error: 'bad label' });
      return send(res, 200, await addItem(label));
    }
    if (url.pathname === '/api/items' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') || '';
      if (!/^u[a-z0-9]{1,12}$/.test(id)) return send(res, 400, { error: 'bad id' });
      await deleteItem(id);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html; charset=utf-8');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`listening on ${PORT}${TURSO_URL ? '' : ' (memory mode, TURSO_URL not set)'}`));
