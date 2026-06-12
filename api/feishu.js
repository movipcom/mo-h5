// ───────────────────────────────────────────────────────────────
//  飞书多维表格代理  ·  Vercel Serverless Function
//  H5 只跟这个文件说话；App Secret 永远不进前端。
//  路由：/api/feishu
//    GET  ?action=list                          → 读取整张表（自动翻页）
//    POST {action:'create', fields}             → 新增一条明细
//    POST {action:'update', recordId, fields}   → 改一条明细
// ───────────────────────────────────────────────────────────────

const HOST = process.env.FEISHU_HOST || 'https://open.feishu.cn'; // Lark国际版: open.larksuite.com
const APP_ID     = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const APP_TOKEN  = process.env.FEISHU_APP_TOKEN || 'Aem3bSTYEaDJiSsmfUBcp8d8n1d'; // 你这个 base
const TABLE_ID   = process.env.FEISHU_TABLE_ID  || 'tblkz5PWTZ8YEP0T';            // 购物车明细表
const PROXY_KEY  = process.env.PROXY_KEY || '';

let cache = { token: null, exp: 0 };
async function getToken() {
  const now = Date.now();
  if (cache.token && now < cache.exp) return cache.token;
  const r = await fetch(`${HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`取 token 失败：${j.code} ${j.msg}`);
  cache = { token: j.tenant_access_token, exp: now + (j.expire - 120) * 1000 };
  return cache.token;
}

// ── 飞书免登：用预授权 code 换取当前用户身份 ──
async function getAppToken() {
  const r = await fetch(`${HOST}/open-apis/auth/v3/app_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`取 app_token 失败：${j.code} ${j.msg}`);
  return j.app_access_token;
}
async function loginByCode(code) {
  const appToken = await getAppToken();
  const r = await fetch(`${HOST}/open-apis/authen/v1/access_token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`免登失败：${j.code} ${j.msg}`);
  const d = j.data || {};
  return { name: d.name || '', open_id: d.open_id || '', avatar: d.avatar_url || '' };
}

async function listAll(token, appToken, tableId) {
  const items = []; let pageToken = '';
  do {
    const url = new URL(`${HOST}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`);
    url.searchParams.set('page_size', '500');
    url.searchParams.set('automatic_fields', 'true');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (j.code !== 0) throw new Error(`读取记录失败：${j.code} ${j.msg}`);
    for (const it of j.data.items || []) items.push({ recordId: it.record_id, fields: it.fields, createdTime: it.created_time, modifiedTime: it.last_modified_time });
    pageToken = j.data.has_more ? j.data.page_token : '';
  } while (pageToken);
  return items;
}

let fieldCache = {}; // tableId -> { names:Set, exp }
async function getFieldNames(token, appToken, tableId) {
  const now = Date.now(); const c = fieldCache[tableId];
  if (c && now < c.exp) return c.names;
  try {
    const r = await fetch(`${HOST}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    if (j.code !== 0) return null;
    const names = new Set((j.data.items || []).map((f) => f.field_name));
    fieldCache[tableId] = { names, exp: now + 60000 };
    return names;
  } catch (e) { return null; }
}
function pruneFields(fields, names) {
  const out = {}; for (const k in fields) { if (names.has(k)) out[k] = fields[k]; } return out;
}

async function rawCreate(token, appToken, tableId, fields) {
  const r = await fetch(`${HOST}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return r.json();
}
async function createRecord(token, appToken, tableId, fields) {
  let j = await rawCreate(token, appToken, tableId, fields);
  if (j.code === 1254045) { // FieldNameNotFound：剔除表里不存在的字段后重试
    const names = await getFieldNames(token, appToken, tableId);
    if (names) j = await rawCreate(token, appToken, tableId, pruneFields(fields, names));
  }
  if (j.code !== 0) throw new Error(`新增失败：${j.code} ${j.msg}`);
  return j.data.record;
}

async function rawUpdate(token, appToken, tableId, recordId, fields) {
  const r = await fetch(`${HOST}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return r.json();
}
async function updateRecord(token, appToken, tableId, recordId, fields) {
  let j = await rawUpdate(token, appToken, tableId, recordId, fields);
  if (j.code === 1254045) {
    const names = await getFieldNames(token, appToken, tableId);
    if (names) j = await rawUpdate(token, appToken, tableId, recordId, pruneFields(fields, names));
  }
  if (j.code !== 0) throw new Error(`更新失败：${j.code} ${j.msg}`);
  return j.data.record;
}

async function deleteRecord(token, appToken, tableId, recordId) {
  const r = await fetch(`${HOST}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`删除失败：${j.code} ${j.msg}`);
  return j.data;
}

async function fetchMedia(token, fileToken) {
  const r = await fetch(`${HOST}/open-apis/drive/v1/medias/${fileToken}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error('media ' + r.status);
  const ct = r.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await r.arrayBuffer());
  return { ct, buf };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (PROXY_KEY && req.headers['x-proxy-key'] !== PROXY_KEY)
    return res.status(401).json({ ok: false, error: '无权访问' });
  if (!APP_ID || !APP_SECRET)
    return res.status(500).json({ ok: false, error: '未配置 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量' });

  const appToken = (req.query && req.query.app_token) || APP_TOKEN;
  const tableId  = (req.query && req.query.table_id)  || TABLE_ID;

  try {
    const token = await getToken();
    if (req.method === 'GET') {
      if (req.query && req.query.action === 'login' && req.query.code) {
        try { return res.status(200).json({ ok: true, ...(await loginByCode(req.query.code)) }); }
        catch (e) { return res.status(200).json({ ok: false, error: String(e.message || e) }); }
      }
      if (req.query && req.query.action === 'login') {
        return res.status(200).json({ ok: false, error: 'login_endpoint_alive_no_code' });
      }
      if (req.query && req.query.action === 'media' && req.query.file_token) {
        try {
          const { ct, buf } = await fetchMedia(token, req.query.file_token);
          res.setHeader('Content-Type', ct);
          res.setHeader('Cache-Control', 'public, max-age=600');
          return res.status(200).send(buf);
        } catch (e) {
          return res.status(404).json({ ok: false, error: String(e.message || e) });
        }
      }
      const items = await listAll(token, appToken, tableId);
      return res.status(200).json({ ok: true, count: items.length, items });
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (body.action === 'create') {
        const rec = await createRecord(token, appToken, tableId, body.fields || {});
        return res.status(200).json({ ok: true, record: rec });
      }
      if (body.action === 'update') {
        const rec = await updateRecord(token, appToken, tableId, body.recordId, body.fields || {});
        return res.status(200).json({ ok: true, record: rec });
      }
      if (body.action === 'delete') {
        const r = await deleteRecord(token, appToken, tableId, body.recordId);
        return res.status(200).json({ ok: true, deleted: r });
      }
      return res.status(400).json({ ok: false, error: '未知的 action' });
    }
    return res.status(405).json({ ok: false, error: '方法不支持' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
