/**
 * read-receipt-tracker — Vercel + Turso 版
 * 功能与原版完全对齐，数据库换成 Turso (libsql)
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');

// ==================== 数据库 ====================
let db = null;

async function getDb() {
  if (db) return db;

  const { createClient } = require('@libsql/client');

  const url = process.env.TURSO_DB_URL;
  const authToken = process.env.TURSO_DB_AUTH_TOKEN;

  if (!url) {
    throw new Error('TURSO_DB_URL 环境变量未设置');
  }

  db = createClient({ url, authToken });

  // 初始化表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      wx_id           TEXT NOT NULL,
      content         TEXT DEFAULT '',
      create_time     INTEGER NOT NULL,
      registered_at   INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS reads (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id          TEXT NOT NULL,
      wx_id           TEXT NOT NULL,
      ip_address      TEXT,
      user_agent      TEXT,
      country         TEXT DEFAULT '',
      region          TEXT DEFAULT '',
      city            TEXT DEFAULT '',
      isp             TEXT DEFAULT '',
      loc             TEXT DEFAULT '',
      reader_wx_id    TEXT DEFAULT '',
      read_at         INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      UNIQUE(msg_id, ip_address)
    )
  `);

  // 索引
  try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_reads_msg ON reads(msg_id)`); } catch(e) {}
  try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_reads_wx ON reads(wx_id)`); } catch(e) {}
  try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_msgs_wx ON messages(wx_id)`); } catch(e) {}

  return db;
}

// ==================== 配置 ====================
const API_KEY = process.env.API_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ENABLE_GEO = !['0', 'off', 'false', 'no'].includes((process.env.ENABLE_GEO || '1').toLowerCase());

// 1x1 透明 GIF
const TRANSPARENT_GIF = Buffer.from([
  0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,
  0x80,0x00,0x00,0x00,0x00,0x00,0xFF,0xFF,0xFF,0x21,
  0xF9,0x04,0x01,0x00,0x00,0x00,0x00,0x2C,0x00,0x00,
  0x00,0x00,0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,
  0x01,0x00,0x3B,
]);

// ==================== 工具函数 ====================
function generateMessageId(wxId, content, createTimeMs) {
  return crypto.createHash('sha256')
    .update(wxId + '\0' + content + '\0' + String(createTimeMs))
    .digest('hex');
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  const xri = req.headers['x-real-ip'];
  if (xri) return xri.trim();
  return req.ip || '0.0.0.0';
}

const ISP_CN = {
  'china mobile': '中国移动', 'china mobile communications': '中国移动',
  'china unicom': '中国联通', 'china unicom communications': '中国联通',
  'china telecom': '中国电信', 'china telecom backbone': '中国电信',
  'chinatelecom': '中国电信', 'china broadband': '中国广电',
  'china education': '教育网', 'dr peng telecom': '鹏博士',
  'great wall broadband': '长城宽带',
};

function cnIsp(isp) {
  if (!isp) return '';
  return ISP_CN[isp.trim().toLowerCase()] || isp;
}

async function fetchJson(url, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'rrt/2.1' },
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function lookupIpLocation(ip) {
  if (!ENABLE_GEO) return null;
  if (!ip || ip === '0.0.0.0' || ip === '127.0.0.1' || ip === '::1') return null;

  // 接口 1: ip-api.com
  try {
    const d = await fetchJson(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,country,regionName,city,isp,lat,lon`);
    if (d.status === 'success') {
      return {
        country: d.country || '', region: d.regionName || '', city: d.city || '',
        isp: cnIsp(d.isp), loc: d.lat != null ? `${d.lat},${d.lon}` : '',
      };
    }
  } catch(e) {}

  // 接口 2: ipwho.is
  try {
    const d = await fetchJson(`https://ipwho.is/${ip}?lang=zh-CN`);
    if (d.success) {
      return {
        country: d.country || '', region: d.region || '', city: d.city || '',
        isp: cnIsp((d.connection || {}).isp || ''),
        loc: d.latitude != null ? `${d.latitude},${d.longitude}` : '',
      };
    }
  } catch(e) {}

  // 接口 3: ipinfo.io
  try {
    const d = await fetchJson(`https://ipinfo.io/${ip}/json`);
    if (d.country) {
      return {
        country: d.country || '', region: d.region || '', city: d.city || '',
        isp: cnIsp((d.org || '').split(' ').slice(1).join(' ')),
        loc: d.loc || '',
      };
    }
  } catch(e) {}

  return null;
}

function ts2date(ts) {
  try { return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }); } catch(e) { return String(ts); }
}

function fmtLoc(loc) {
  if (!loc || !loc.includes(',')) return loc;
  try {
    const [latS, lonS] = loc.split(',', 2);
    const lat = parseFloat(latS), lon = parseFloat(lonS);
    const latDir = lat >= 0 ? '北纬' : '南纬';
    const lonDir = lon >= 0 ? '东经' : '西经';
    return `${latDir}${Math.abs(lat).toFixed(4)}°, ${lonDir}${Math.abs(lon).toFixed(4)}°`;
  } catch(e) { return loc; }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ==================== 鉴权 ====================
function getAdminPwd() { return ADMIN_PASSWORD || API_KEY; }

function requireAdmin(req, res, next) {
  if (req.cookies?.authed === '1') return next();
  const ak = API_KEY;
  if (ak) {
    const rk = req.headers['x-api-key'] || req.query.api_key || '';
    if (rk && rk === ak) return next();
  } else {
    return next();
  }
  if (req.path.startsWith('/api/') || req.path === '/batch-status' || req.query.json === '1') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect(`/login?next=${encodeURIComponent(req.path)}`);
}

// ==================== HTML 模板 ====================
function loginTemplate(error) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 - 已读追踪</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;display:flex;justify-content:center;align-items:center;min-height:100vh}.login-box{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);width:320px}h2{text-align:center;margin-bottom:1.5rem;color:#333}input[type=password]{width:100%;padding:.75rem;border:1px solid #ddd;border-radius:8px;font-size:1rem;margin-bottom:1rem}button{width:100%;padding:.75rem;background:#4f46e5;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}button:hover{background:#4338ca}.err{color:#ef4444;text-align:center;margin-bottom:1rem;font-size:.9rem}</style></head><body>
<div class="login-box"><h2>📬 已读追踪</h2>${error?`<p class="err">${error}</p>`:''}<form method="POST"><input type="password" name="password" placeholder="输入密码" autofocus><button type="submit">登录</button></form></div></body></html>`;
}

function indexTemplate(stats, messages) {
  const tm = stats?.tm || 0, tr = stats?.tr || 0, ar = stats?.ar || 0, gr = stats?.gr || 0;
  const msgRows = messages.map(m => `<tr><td><a href="/message/${m.id}">${escHtml((m.content||'').slice(0,60)||'(无内容)')}</a></td><td>${escHtml(m.wx_id)}</td><td>${m.cnt||0}</td><td>${ts2date(m.registered_at)}</td><td><button onclick="deleteMsg('${m.id}')">删除</button></td></tr>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已读追踪 - 管理面板</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;color:#333}.container{max-width:960px;margin:0 auto;padding:1rem}h1{margin-bottom:1rem;font-size:1.5rem}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;margin-bottom:1.5rem}.stat{background:#fff;padding:1rem;border-radius:12px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.08)}.stat .num{font-size:1.8rem;font-weight:700;color:#4f46e5}.stat .label{font-size:.85rem;color:#666;margin-top:.25rem}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}th,td{padding:.6rem .8rem;text-align:left;border-bottom:1px solid #eee;font-size:.9rem}th{background:#f9fafb;font-weight:600}a{color:#4f46e5;text-decoration:none}a:hover{text-decoration:underline}button{padding:.3rem .6rem;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.8rem}.top-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem}.top-bar form button{background:#6b7280}</style></head><body>
<div class="container"><div class="top-bar"><h1>📬 已读追踪管理</h1><form method="POST" action="/logout"><button type="submit">退出登录</button></form></div>
<div class="stats"><div class="stat"><div class="num">${tm}</div><div class="label">总消息</div></div><div class="stat"><div class="num">${tr}</div><div class="label">总已读</div></div><div class="stat"><div class="num">${ar}</div><div class="label">平均已读</div></div><div class="stat"><div class="num">${gr}</div><div class="label">有定位</div></div></div>
<table><thead><tr><th>内容</th><th>微信号</th><th>已读数</th><th>注册时间</th><th>操作</th></tr></thead><tbody>${msgRows||'<tr><td colspan="5" style="text-align:center;padding:2rem;color:#999">暂无消息</td></tr>'}</tbody></table></div>
<script>function deleteMsg(mid){if(!confirm('确定删除？'))return;fetch('/api/delete/'+mid,{method:'POST'}).then(()=>location.reload())}</script></body></html>`;
}

function detailTemplate(message, reads) {
  const readRows = reads.map(r => {
    const loc = [r.country,r.region,r.city].filter(Boolean).join(' ')||'-';
    return `<tr><td>${escHtml(r.ip_address||'-')}</td><td>${escHtml(r.reader_wx_id||'-')}</td><td>${escHtml(loc)}</td><td>${escHtml(r.isp||'-')}</td><td>${escHtml(fmtLoc(r.loc)||'-')}</td><td>${escHtml(r.user_agent||'-')}</td><td>${ts2date(r.read_at)}</td></tr>`;
  }).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>消息详情</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;color:#333}.container{max-width:960px;margin:0 auto;padding:1rem}h1{margin-bottom:1rem;font-size:1.3rem}.msg-box{background:#fff;padding:1rem;border-radius:12px;margin-bottom:1rem;box-shadow:0 1px 4px rgba(0,0,0,.08)}.msg-box p{margin:.3rem 0}.msg-box .label{color:#666;font-size:.85rem}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}th,td{padding:.5rem .6rem;text-align:left;border-bottom:1px solid #eee;font-size:.85rem}th{background:#f9fafb;font-weight:600}a{color:#4f46e5;text-decoration:none}.back{display:inline-block;margin-bottom:1rem;color:#4f46e5}</style></head><body>
<div class="container"><a class="back" href="/">← 返回列表</a><h1>消息详情</h1>
<div class="msg-box"><p><span class="label">消息ID：</span>${escHtml(message.id)}</p><p><span class="label">微信号：</span>${escHtml(message.wx_id)}</p><p><span class="label">内容：</span>${escHtml(message.content||'(无内容)')}</p><p><span class="label">已读数：</span>${message.read_cnt||0}</p><p><span class="label">注册时间：</span>${ts2date(message.registered_at)}</p></div>
<h2 style="margin-bottom:.5rem;font-size:1.1rem">已读记录</h2>
<table><thead><tr><th>IP</th><th>访客</th><th>位置</th><th>运营商</th><th>坐标</th><th>UA</th><th>时间</th></tr></thead><tbody>${readRows||'<tr><td colspan="7" style="text-align:center;padding:2rem;color:#999">暂无已读记录</td></tr>'}</tbody></table></div></body></html>`;
}

// ==================== Express 应用 ====================
const app = express();
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true }));

// Cookie 解析
app.use((req, res, next) => {
  req.cookies = {};
  const ch = req.headers.cookie;
  if (ch) ch.split(';').forEach(c => { const [k,...v]=c.trim().split('='); req.cookies[k]=v.join('='); });
  next();
});

// ==================== 路由 ====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'read-receipt-tracker', platform: 'vercel+turso' });
});

app.get('/login', (req, res) => {
  const pwd = getAdminPwd();
  if (!pwd) return res.redirect('/');
  if (req.cookies?.authed === '1') return res.redirect('/');
  res.send(loginTemplate(null));
});

app.post('/login', (req, res) => {
  const pwd = getAdminPwd();
  if (!pwd) return res.redirect('/');
  if ((req.body.password||'') === pwd) {
    res.setHeader('Set-Cookie', 'authed=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800');
    const nxt = req.query.next || '/';
    return res.redirect(nxt.startsWith('/')&&!nxt.startsWith('//')?nxt:'/');
  }
  res.send(loginTemplate('密码错误，请重试'));
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'authed=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/login');
});

app.post('/register', async (req, res) => {
  try {
    const db = await getDb();
    const data = req.body;
    const wx = (data.wxId||'').trim();
    const content = data.content||'';
    const ct = data.createTime || Date.now();
    if (!wx) return res.status(400).json({ error: 'wxId required' });
    if (content.length > 50000) return res.status(400).json({ error: 'content too long' });

    const mid = generateMessageId(wx, content, ct);
    await db.execute({
      sql: 'INSERT OR IGNORE INTO messages(id,wx_id,content,create_time) VALUES(?,?,?,?)',
      args: [mid, wx, content, ct],
    });

    const hostUrl = `${req.protocol}://${req.get('host')}/`;
    res.json({ success: true, id: mid, wxId: wx, pixel_url: `${hostUrl}pixel?wxId=${wx}&id=${mid}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/pixel', async (req, res) => {
  const wx = req.query.wxId||'', mid = req.query.id||'';
  if (!wx||!mid) { res.setHeader('Content-Type','image/gif'); return res.send(TRANSPARENT_GIF); }

  const ip = getClientIp(req), ua = (req.headers['user-agent']||'').slice(0,500);

  // 异步写入，不阻塞响应
  lookupIpLocation(ip).then(async geo => {
    try {
      const db = await getDb();
      const c=geo?.country||'',r=geo?.region||'',ci=geo?.city||'',isp=geo?.isp||'',loc=geo?.loc||'';
      await db.execute({
        sql: 'INSERT OR IGNORE INTO reads(msg_id,wx_id,ip_address,user_agent,country,region,city,isp,loc,reader_wx_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
        args: [mid,wx,ip,ua,c,r,ci,isp,loc,'未知访客'],
      });
    } catch(e) {}
  }).catch(()=>{});

  res.setHeader('Content-Type','image/gif');
  res.setHeader('Cache-Control','no-store,no-cache,must-revalidate');
  res.send(TRANSPARENT_GIF);
});

app.get('/pixel.gif', async (req, res) => {
  const ip = getClientIp(req);
  lookupIpLocation(ip).then(async geo => {
    try {
      const db = await getDb();
      const c=geo?.country||'',r=geo?.region||'',ci=geo?.city||'',isp=geo?.isp||'',loc=geo?.loc||'';
      await db.execute({
        sql: 'INSERT OR IGNORE INTO reads(msg_id,wx_id,ip_address,user_agent,country,region,city,isp,loc,reader_wx_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
        args: ['pixel.gif','未知访客',ip,'wechat-image',c,r,ci,isp,loc,'未知访客'],
      });
    } catch(e) {}
  }).catch(()=>{});

  res.setHeader('Content-Type','image/gif');
  res.setHeader('Cache-Control','no-store,no-cache,must-revalidate');
  res.send(TRANSPARENT_GIF);
});

app.get('/count', async (req, res) => {
  const wx=req.query.wxId||'', mid=req.query.id||'';
  if (!wx||!mid) return res.json({ count:0, error:'wxId and id required' });

  const db = await getDb();
  const r = await db.execute({
    sql: 'SELECT COUNT(DISTINCT ip_address) as cnt FROM reads WHERE msg_id=? AND wx_id=?',
    args: [mid, wx],
  });
  const rows = await db.execute({
    sql: 'SELECT * FROM reads WHERE msg_id=? AND wx_id=? ORDER BY read_at DESC, id DESC',
    args: [mid, wx],
  });

  res.json({
    count: r.rows[0]?.cnt || 0, msg_id: mid,
    reads: rows.rows.map(x => ({
      ip_address: x.ip_address, reader_wx_id: x.reader_wx_id||'',
      location: [x.country,x.region,x.city].filter(Boolean).join(' ')||'-',
      province: x.region, city: x.city, country: x.country, isp: x.isp,
      loc: fmtLoc(x.loc)||'-', user_agent: x.user_agent, read_at: ts2date(x.read_at),
    })),
  });
});

app.get('/', requireAdmin, async (req, res) => {
  const db = await getDb();
  const s = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM messages) as tm,
      (SELECT COUNT(DISTINCT ip_address) FROM reads) as tr,
      CASE WHEN (SELECT COUNT(*) FROM messages)=0 THEN 0.0
           ELSE ROUND(CAST((SELECT COUNT(*) FROM reads) AS REAL)/(SELECT COUNT(*) FROM messages),1)
      END as ar,
      (SELECT COUNT(DISTINCT ip_address) FROM reads WHERE country != '' OR city != '') as gr
  `);
  const ms = await db.execute(`
    SELECT m.*,
      (SELECT COUNT(DISTINCT ip_address) FROM reads r WHERE r.msg_id=m.id) as cnt,
      (SELECT COUNT(DISTINCT ip_address) FROM reads r WHERE r.msg_id=m.id AND (r.country!='' OR r.city!='')) as geo_cnt
    FROM messages m ORDER BY registered_at DESC LIMIT 100
  `);

  const stats = s.rows[0] || { tm:0, tr:0, ar:0, gr:0 };
  res.send(indexTemplate(stats, ms.rows));
});

app.get('/message/:mid', requireAdmin, async (req, res) => {
  const mid = req.params.mid;
  const db = await getDb();

  const m = await db.execute({
    sql: 'SELECT m.*,(SELECT COUNT(DISTINCT ip_address) FROM reads r WHERE r.msg_id=m.id) as read_cnt FROM messages m WHERE m.id=?',
    args: [mid],
  });
  if (!m.rows.length) return res.status(404).send('404');

  const rs = await db.execute({
    sql: 'SELECT wx_id,reader_wx_id,ip_address,user_agent,read_at,country,region,city,isp,loc FROM reads WHERE msg_id=? ORDER BY read_at DESC, id DESC',
    args: [mid],
  });

  if (req.query.json==='1') {
    const msg = m.rows[0];
    return res.json({
      message: { id:msg.id, wxId:msg.wx_id, content:msg.content },
      reads: rs.rows.map(r => ({
        ip_address:r.ip_address, location:[r.country,r.region,r.city].filter(Boolean).join(' ')||'-',
        country:r.country,region:r.region,city:r.city,isp:r.isp,loc:fmtLoc(r.loc)||'-',
        user_agent:r.user_agent, read_at:ts2date(r.read_at),
      })),
    });
  }
  res.send(detailTemplate(m.rows[0], rs.rows));
});

app.get('/api/reads/:mid', async (req, res) => {
  const mid = req.params.mid;
  const db = await getDb();
  const m = await db.execute({ sql: 'SELECT * FROM messages WHERE id=?', args: [mid] });
  if (!m.rows.length) return res.status(404).json({ error:'not found' });

  const rs = await db.execute({
    sql: 'SELECT * FROM reads WHERE msg_id=? ORDER BY read_at DESC, id DESC',
    args: [mid],
  });

  res.json({
    msg_id:mid, wxId:m.rows[0].wx_id, content:m.rows[0].content, read_count:rs.rows.length,
    reads: rs.rows.map(r => ({
      ip_address:r.ip_address, location:[r.country,r.region,r.city].filter(Boolean).join(' ')||'-',
      country:r.country,region:r.region,city:r.city,isp:r.isp,loc:fmtLoc(r.loc)||'-',
      user_agent:r.user_agent, read_at:ts2date(r.read_at),
    })),
  });
});

app.get('/api/messages', async (req, res) => {
  const db = await getDb();
  const rows = await db.execute(`
    SELECT m.*,(SELECT COUNT(DISTINCT ip_address) FROM reads r WHERE r.msg_id=m.id) as cnt
    FROM messages m ORDER BY registered_at DESC LIMIT 100
  `);
  res.json({ messages: rows.rows.map(r => ({
    id:r.id, wxId:r.wx_id, content:r.content, read_count:r.cnt, registered_at:ts2date(r.registered_at),
  })) });
});

app.post('/api/delete/:mid', requireAdmin, async (req, res) => {
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM reads WHERE msg_id=?', args: [req.params.mid] });
  await db.execute({ sql: 'DELETE FROM messages WHERE id=?', args: [req.params.mid] });
  res.json({ success:true });
});

app.post('/api/delete-all', requireAdmin, async (req, res) => {
  const db = await getDb();
  await db.execute('DELETE FROM reads');
  await db.execute('DELETE FROM messages');
  res.json({ success:true });
});

app.get('/batch-status', requireAdmin, async (req, res) => {
  const idsStr = req.query.ids||'';
  if (!idsStr) return res.status(400).json({ error:'ids required' });
  const ids = idsStr.split(',').map(s=>s.trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error:'no valid ids' });

  const db = await getDb();
  const ph = ids.map(()=>'?').join(',');
  const rows = await db.execute({
    sql: `SELECT msg_id, COUNT(DISTINCT ip_address) as cnt FROM reads WHERE msg_id IN (${ph}) GROUP BY msg_id`,
    args: ids,
  });

  const rv = {};
  rows.rows.forEach(r => rv[r.msg_id] = r.cnt);
  ids.forEach(mid => { if(!(mid in rv)) rv[mid] = 0; });
  res.json({ statuses:rv });
});

// ==================== 导出 ====================
module.exports = app;

// 本地开发
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`📬 read-receipt-tracker 已启动: http://localhost:${PORT}`);
  });
}
