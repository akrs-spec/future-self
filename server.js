import express from 'express';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const app = express();
app.use(express.json({ limit: '2mb' }));
const db = new Database(process.env.DB_PATH || './future-self.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY, first_name TEXT, access TEXT NOT NULL DEFAULT 'FREE',
  access_expires_at INTEGER, subscription_expires_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  telegram_charge_id TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, amount INTEGER NOT NULL,
  currency TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_invites (
  token TEXT PRIMARY KEY, duration_days INTEGER NOT NULL, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, used_by TEXT
);
`);
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || '7738464404');
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET;

function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData) throw new Error('Telegram authorization is not configured');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Missing Telegram signature');
  params.delete('hash');
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > 86400) throw new Error('Telegram session expired; reopen the app');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const a = Buffer.from(expected, 'hex'); const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Invalid Telegram signature');
  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw new Error('Telegram user is missing');
  return user;
}
function auth(req, res, next) {
  try {
    const user = verifyInitData(req.get('X-Telegram-Init-Data'));
    req.telegramUser = user;
    db.prepare(`INSERT INTO users(telegram_id, first_name, created_at) VALUES(?,?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name`)
      .run(String(user.id), user.first_name || 'Пользователь', Date.now());
    next();
  } catch (e) { res.status(401).json({ error: e.message }); }
}
function isAdmin(req) { return String(req.telegramUser.id) === ADMIN_ID; }
function getRole(id) {
  if (String(id) === ADMIN_ID) return 'ADMIN';
  const row = db.prepare('SELECT access, access_expires_at, subscription_expires_at FROM users WHERE telegram_id=?').get(String(id));
  if (!row) return 'FREE';
  const now = Date.now();
  if (row.access === 'FRIENDS' && (!row.access_expires_at || row.access_expires_at > now)) return 'FRIENDS';
  if (row.subscription_expires_at && row.subscription_expires_at > now) return 'PRO';
  return 'FREE';
}
async function telegram(method, payload) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is not configured');
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}
app.get('/api/me', auth, (req, res) => {
  const role = getRole(req.telegramUser.id);
  const row = db.prepare('SELECT subscription_expires_at, access_expires_at FROM users WHERE telegram_id=?').get(String(req.telegramUser.id));
  res.json({ access: role, isAdmin: role === 'ADMIN', subscriptionExpiresAt: row?.subscription_expires_at || null, friendsExpiresAt: row?.access_expires_at || null });
});
app.post('/api/ai/chat', auth, async (req, res) => {
  try {
    if (!['PRO','FRIENDS','ADMIN'].includes(getRole(req.telegramUser.id))) return res.status(403).json({error:'AI доступен в PRO'});
    if (!GEMINI_API_KEY) return res.status(503).json({error:'GEMINI_API_KEY is not configured on the server'});
    const message = String(req.body?.message || '').trim().slice(0, 6000);
    if (!message) return res.status(400).json({error:'Message is empty'});
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : [];
    const contents = history
      .filter(x => x && ['user','assistant'].includes(x.role) && String(x.content || '').trim())
      .map(x => ({role:x.role === 'assistant' ? 'model' : 'user', parts:[{text:String(x.content).slice(0,4000)}]}));
    contents.push({role:'user', parts:[{text:message}]});
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method:'POST',
      headers:{'content-type':'application/json','x-goog-api-key':GEMINI_API_KEY},
      body:JSON.stringify({
        systemInstruction:{parts:[{text:'Ты — бережный, практичный AI-наставник FUTURE SELF. Помогай формулировать цели, превращать их в конкретные шаги, вести рефлексию. Не обещай магических результатов и не подменяй врача, психолога, юриста или финансового специалиста.'}]},
        contents,
        generationConfig:{maxOutputTokens:1200,temperature:0.8}
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Gemini API error (${response.status})`);
    const reply = (data.candidates || []).flatMap(candidate => candidate.content?.parts || []).map(part => part.text || '').join('\n').trim();
    if (!reply) throw new Error(data.promptFeedback?.blockReason ? `Gemini blocked the prompt: ${data.promptFeedback.blockReason}` : 'Gemini returned an empty response');
    res.json({reply});
  } catch(e) { console.error('Gemini chat error:',e); res.status(502).json({error:e.message}); }
});
app.post('/api/payments/create-invoice', auth, async (req, res) => {
  try {
    if (['PRO','FRIENDS','ADMIN'].includes(getRole(req.telegramUser.id))) return res.status(409).json({error:'У вас уже есть полный доступ'});
    const payload = `pro_monthly:${req.telegramUser.id}:${crypto.randomUUID()}`;
    const invoiceLink = await telegram('createInvoiceLink', {
      title:'FUTURE SELF PRO', description:'Месяц доступа к функциям FUTURE SELF PRO', payload,
      provider_token:'', currency:'XTR', prices:[{label:'FUTURE SELF PRO — 1 месяц',amount:390}],
      subscription_period:2592000
    });
    res.json({invoiceLink});
  } catch(e) { res.status(502).json({error:e.message}); }
});
app.post('/telegram/webhook', async (req, res) => {
  if (WEBHOOK_SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) return res.sendStatus(403);
  try {
    const update = req.body;
    if (update.pre_checkout_query) await telegram('answerPreCheckoutQuery', {pre_checkout_query_id:update.pre_checkout_query.id, ok:true});
    const payment = update.message?.successful_payment;
    if (payment) {
      const payload = String(payment.invoice_payload || '');
      const match = payload.match(/^pro_monthly:(\d+):/);
      if (match && payment.currency === 'XTR') {
        const id = match[1];
        const expiry = Number(payment.subscription_expiration_date || Math.floor(Date.now()/1000)+2592000)*1000;
        db.prepare(`INSERT OR REPLACE INTO payments(telegram_charge_id,telegram_id,amount,currency,expires_at,created_at) VALUES(?,?,?,?,?,?)`)
          .run(payment.telegram_payment_charge_id,id,payment.total_amount,payment.currency,expiry,Date.now());
        db.prepare('UPDATE users SET subscription_expires_at=? WHERE telegram_id=?').run(expiry,id);
      }
    }
    res.sendStatus(200);
  } catch(e) { console.error('Telegram webhook error:',e); res.sendStatus(500); }
});
app.use('/api/admin', auth, (req,res,next)=>{ if(!isAdmin(req)) return res.status(403).json({error:'Admin only'}); next(); });
app.get('/api/admin/users', (req,res) => {
  const users = db.prepare('SELECT telegram_id AS telegramId, first_name AS name, access, access_expires_at AS expiresAt, subscription_expires_at AS subscriptionExpiresAt FROM users ORDER BY created_at DESC LIMIT 500').all()
    .map(u=>({...u, access:getRole(u.telegramId), expiresAt:u.expiresAt ? new Date(u.expiresAt).toISOString() : null}));
  res.json({users});
});
app.post('/api/admin/grant', (req,res) => {
  const id=String(req.body?.telegramId||''); const days=Number(req.body?.durationDays);
  if(!/^\d{5,15}$/.test(id) || ![0,7,30,90,365].includes(days)) return res.status(400).json({error:'Invalid Telegram ID or duration'});
  const expires=days===0?null:Date.now()+days*86400000;
  db.prepare(`INSERT INTO users(telegram_id,first_name,access,access_expires_at,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(telegram_id) DO UPDATE SET access='FRIENDS',access_expires_at=excluded.access_expires_at`).run(id,'FRIENDS','FRIENDS',expires,Date.now());
  res.json({ok:true});
});
app.post('/api/invites/redeem', auth, (req,res) => {
  const token=String(req.body?.token||'');
  if(!/^[a-f0-9]{48}$/.test(token)) return res.status(400).json({error:'Некорректная ссылка-приглашение'});
  const now=Date.now();
  const claim=db.transaction(() => {
    const invite=db.prepare('SELECT duration_days,expires_at,used_at FROM access_invites WHERE token=?').get(token);
    if(!invite || invite.used_at || invite.expires_at<=now) return null;
    const expires=invite.duration_days===0?null:now+invite.duration_days*86400000;
    db.prepare('UPDATE access_invites SET used_at=?,used_by=? WHERE token=? AND used_at IS NULL').run(now,String(req.telegramUser.id),token);
    db.prepare(`INSERT INTO users(telegram_id,first_name,access,access_expires_at,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET access='FRIENDS',access_expires_at=excluded.access_expires_at`)
      .run(String(req.telegramUser.id),req.telegramUser.first_name||'Пользователь','FRIENDS',expires,now);
    return {expiresAt:expires};
  });
  const result=claim();
  if(!result) return res.status(410).json({error:'Ссылка уже использована или срок её действия истёк'});
  res.json({ok:true,expiresAt:result.expiresAt});
});
app.post('/api/admin/invites', (req,res) => {
  const days=Number(req.body?.durationDays);
  if(![0,7,30,90,365].includes(days)) return res.status(400).json({error:'Invalid invite duration'});
  const token=crypto.randomBytes(24).toString('hex');
  const now=Date.now();
  db.prepare('INSERT INTO access_invites(token,duration_days,created_by,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(token,days,String(req.telegramUser.id),now,now+7*86400000);
  res.json({ok:true,token,inviteUrl:'https://t.me/VAMOPAV_bot?startapp='+token,expiresAt:now+7*86400000,durationDays:days});
});
app.post('/api/admin/revoke', (req,res) => {
  const id=String(req.body?.telegramId||'');
  if(!/^\d{5,15}$/.test(id)) return res.status(400).json({error:'Invalid Telegram ID'});
  db.prepare("UPDATE users SET access='FREE',access_expires_at=NULL WHERE telegram_id=? AND telegram_id<>?").run(id,ADMIN_ID);
  res.json({ok:true});
});
app.get('/health', (_req,res)=>res.json({ok:true}));
app.use(express.static(process.cwd()));
const port=Number(process.env.PORT||3000);
app.listen(port,()=>console.log(`FUTURE SELF API listening on ${port}`));
