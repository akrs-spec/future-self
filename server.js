import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';

const { Pool, types } = pg;
types.setTypeParser(20, value => Number(value)); // BIGINT timestamps are safe as JS numbers.

const app = express();
app.use(express.json({ limit: '12mb' }));

// Allow the GitHub Pages Mini App to call this Render API.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === 'https://akrs-spec.github.io') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || '7738464404');
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'ymDCYd8puC7gYjxIamPt'; // Marina — soft, clear Russian female voice.
const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const SQLITE_PATH = process.env.DB_PATH || './future-self.sqlite';

let sqlite = null;
let pool = null;
let databaseMode = 'sqlite';

function pgSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => '$' + (++index));
}

async function query(sql, params = [], client = null) {
  if (pool) {
    const result = await (client || pool).query(pgSql(sql), params);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  const statement = sqlite.prepare(sql);
  if (/^\s*SELECT\b/i.test(sql)) return { rows: statement.all(...params), rowCount: 0 };
  const result = statement.run(...params);
  return { rows: [], rowCount: result.changes };
}

async function transaction(callback) {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = await callback(null);
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

async function initializeDatabase() {
  if (DATABASE_URL) {
    databaseMode = 'postgres';
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    });
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY, first_name TEXT,
        access TEXT NOT NULL DEFAULT 'FREE',
        access_expires_at BIGINT, subscription_expires_at BIGINT,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payments (
        telegram_charge_id TEXT PRIMARY KEY, telegram_id TEXT NOT NULL,
        amount INTEGER NOT NULL, currency TEXT NOT NULL,
        expires_at BIGINT, created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_invites (
        token TEXT PRIMARY KEY, duration_days INTEGER NOT NULL,
        created_by TEXT NOT NULL, created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL, used_at BIGINT, used_by TEXT
      );
      CREATE TABLE IF NOT EXISTS migration_log (
        migration_key TEXT PRIMARY KEY, completed_at BIGINT NOT NULL,
        imported_users INTEGER NOT NULL DEFAULT 0,
        imported_payments INTEGER NOT NULL DEFAULT 0,
        imported_invites INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS app_states (
        telegram_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at BIGINT NOT NULL
      );
    `);

    // Import the existing SQLite data once. The source database is never modified or deleted.
    const migration = await pool.query('SELECT migration_key FROM migration_log WHERE migration_key=$1', ['sqlite_initial_import']);
    if (migration.rowCount === 0) {
      if (!fs.existsSync(SQLITE_PATH)) {
        if (process.env.ALLOW_EMPTY_POSTGRES !== 'true') {
          throw new Error(`DATABASE_URL is set, but the old SQLite database was not found at "${SQLITE_PATH}". Refusing to start with an empty database. Restore/backup the old database first, or explicitly set ALLOW_EMPTY_POSTGRES=true only if an empty migration is intended.`);
        }
        await pool.query(
          'INSERT INTO migration_log(migration_key,completed_at) VALUES($1,$2) ON CONFLICT(migration_key) DO NOTHING',
          ['sqlite_initial_import', Date.now()]
        );
        console.warn('Starting PostgreSQL with an explicitly approved empty database.');
      } else {
        const legacy = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
        try {
          const users = legacy.prepare('SELECT telegram_id, first_name, access, access_expires_at, subscription_expires_at, created_at FROM users').all();
          const payments = legacy.prepare('SELECT telegram_charge_id, telegram_id, amount, currency, expires_at, created_at FROM payments').all();
          const invites = legacy.prepare('SELECT token, duration_days, created_by, created_at, expires_at, used_at, used_by FROM access_invites').all();
          await transaction(async client => {
            for (const user of users) {
              await query(
                'INSERT INTO users(telegram_id,first_name,access,access_expires_at,subscription_expires_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_id) DO NOTHING',
                [user.telegram_id, user.first_name, user.access, user.access_expires_at, user.subscription_expires_at, user.created_at], client
              );
            }
            for (const payment of payments) {
              await query(
                'INSERT INTO payments(telegram_charge_id,telegram_id,amount,currency,expires_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_charge_id) DO NOTHING',
                [payment.telegram_charge_id, payment.telegram_id, payment.amount, payment.currency, payment.expires_at, payment.created_at], client
              );
            }
            for (const invite of invites) {
              await query(
                'INSERT INTO access_invites(token,duration_days,created_by,created_at,expires_at,used_at,used_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(token) DO NOTHING',
                [invite.token, invite.duration_days, invite.created_by, invite.created_at, invite.expires_at, invite.used_at, invite.used_by], client
              );
            }
            await query(
              'INSERT INTO migration_log(migration_key,completed_at,imported_users,imported_payments,imported_invites) VALUES(?,?,?,?,?) ON CONFLICT(migration_key) DO NOTHING',
              ['sqlite_initial_import', Date.now(), users.length, payments.length, invites.length], client
            );
          });
          console.log(`SQLite import completed: ${users.length} users, ${payments.length} payments, ${invites.length} invites. Original SQLite file retained.`);
        } finally {
          legacy.close();
        }
      }
    }
    return;
  }

  // Backward-compatible mode: until DATABASE_URL is configured, keep using the existing SQLite database.
  sqlite = new Database(SQLITE_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
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
    CREATE TABLE IF NOT EXISTS app_states (
      telegram_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}

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

async function auth(req, res, next) {
  try {
    const user = verifyInitData(req.get('X-Telegram-Init-Data'));
    req.telegramUser = user;
    await query(
      'INSERT INTO users(telegram_id,first_name,created_at) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name',
      [String(user.id), user.first_name || 'Пользователь', Date.now()]
    );
    next();
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
}

function isAdmin(req) { return String(req.telegramUser.id) === ADMIN_ID; }

async function getRole(id) {
  if (String(id) === ADMIN_ID) return 'ADMIN';
  const result = await query('SELECT access,access_expires_at,subscription_expires_at FROM users WHERE telegram_id=?', [String(id)]);
  const row = result.rows[0];
  if (!row) return 'FREE';
  const now = Date.now();
  if (row.access === 'FRIENDS' && (!row.access_expires_at || Number(row.access_expires_at) > now)) return 'FRIENDS';
  if (row.subscription_expires_at && Number(row.subscription_expires_at) > now) return 'PRO';
  return 'FREE';
}

async function telegram(method, payload) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is not configured');
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

app.get('/api/state', auth, async (req, res) => {
  try {
    const result = await query('SELECT state_json,updated_at FROM app_states WHERE telegram_id=?', [String(req.telegramUser.id)]);
    const row = result.rows[0];
    res.json({ state: row ? JSON.parse(row.state_json) : null, updatedAt: row ? Number(row.updated_at) : null });
  } catch (e) {
    console.error('Load app state error:', e);
    res.status(500).json({ error: 'Не удалось загрузить сохранённые данные' });
  }
});

app.post('/api/state', auth, async (req, res) => {
  try {
    const state = req.body?.state;
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return res.status(400).json({ error: 'Некорректные данные приложения' });
    }
    const stateJson = JSON.stringify(state);
    if (Buffer.byteLength(stateJson, 'utf8') > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'Слишком большой объём данных для сохранения' });
    }
    const updatedAt = Date.now();
    await query(
      'INSERT INTO app_states(telegram_id,state_json,updated_at) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at',
      [String(req.telegramUser.id), stateJson, updatedAt]
    );
    res.json({ ok: true, updatedAt });
  } catch (e) {
    console.error('Save app state error:', e);
    res.status(500).json({ error: 'Не удалось сохранить данные на сервере' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const role = await getRole(req.telegramUser.id);
    const result = await query('SELECT subscription_expires_at,access_expires_at FROM users WHERE telegram_id=?', [String(req.telegramUser.id)]);
    const row = result.rows[0];
    res.json({
      access: role, isAdmin: role === 'ADMIN',
      subscriptionExpiresAt: row?.subscription_expires_at || null,
      friendsExpiresAt: row?.access_expires_at || null
    });
  } catch (e) { console.error('Get profile error:', e); res.status(500).json({error:'Database error'}); }
});

app.post('/api/ai/chat', auth, async (req, res) => {
  try {
    if (!['PRO','FRIENDS','ADMIN'].includes(await getRole(req.telegramUser.id))) return res.status(403).json({error:'AI доступен в PRO'});
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

const MEDITATION_PARTS = [
  [
    'Сделай спокойный вдох… и медленный выдох. Устройся так, чтобы телу было удобно. Тебе не нужно ничего доказывать и никуда спешить. Если захочется, просто прикрой глаза.',
    'Представь, что прошло пять лет. Ты просыпаешься в своей жизни. Не пытайся сделать картинку идеальной. Заметь первое, что появляется: свет за окном, пространство вокруг, звуки, ощущение в теле.',
    'Посмотри на себя в этой будущей жизни. Как ты держишься? Как разговариваешь с собой? Что стало для тебя привычной заботой, а что больше не занимает столько места в мыслях?',
    'Представь, что будущая ты садится рядом. В ней нет осуждения. Она знает, через что тебе пришлось пройти, и не требует от тебя мгновенных перемен.',
    'Спроси её: какой один небольшой шаг действительно приблизит меня к этой жизни? Не ищи грандиозный ответ. Позволь появиться простой мысли, слову или ощущению.',
    'Поблагодари себя будущую за эту встречу. Сделай вдох, почувствуй опору под телом и возвращай внимание в комнату. Когда будешь готова, мягко открой глаза. Запомни один шаг, который хочешь сделать.'
  ],
  [
    'Найди удобное положение. Почувствуй, как поверхность поддерживает твоё тело. Медленно вдохни… и спокойно выдохни. Сейчас не нужно решать все вопросы сразу.',
    'Вспомни место, реальное или воображаемое, где тебе спокойно. Рассмотри его в деталях: какой там свет, какие цвета, какая температура воздуха. Позволь этому образу стать немного яснее.',
    'Переведи внимание на то, что уже есть в твоей жизни. Навыки, опыт, люди, идеи, способность учиться и начинать снова. Не обесценивай небольшое. Ресурс не всегда выглядит как что-то большое.',
    'Представь, что перед тобой открывается несколько дорог. Не обязательно выбирать все. Какая из них вызывает тихий интерес? Какое действие может сделать эту возможность чуть реальнее?',
    'Скажи себе: я могу замечать возможности и проверять их маленькими шагами. Мне не нужно контролировать всё будущее, чтобы двигаться вперёд.',
    'Сделай ещё один спокойный вдох и выдох. Почувствуй опору под собой. Возвращайся в настоящий момент и возьми с собой одну мысль, которая поддерживает тебя.'
  ]
];
const meditationAudioCache = new Map();
const meditationAudioUsage = new Map();

app.post('/api/meditation/audio', auth, async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) return res.status(503).json({error:'Озвучка пока не настроена на сервере'});
    const trackIndex = Number(req.body?.trackIndex);
    const partIndex = Number(req.body?.partIndex);
    const text = MEDITATION_PARTS[trackIndex]?.[partIndex];
    if (!text) return res.status(400).json({error:'Неизвестная часть практики'});
    const cacheKey = ELEVENLABS_VOICE_ID + ':' + trackIndex + ':' + partIndex;
    const cached = meditationAudioCache.get(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control','private, max-age=86400');
      res.type('audio/mpeg').send(cached);
      return;
    }
    const userId = String(req.telegramUser.id);
    const now = Date.now();
    const usage = meditationAudioUsage.get(userId);
    if (usage && now - usage.startedAt < 60 * 60 * 1000 && usage.count >= 12) {
      return res.status(429).json({error:'Лимит генерации аудио на час достигнут. Попробуй позже.'});
    }
    if (!usage || now - usage.startedAt >= 60 * 60 * 1000) meditationAudioUsage.set(userId,{startedAt:now,count:1});
    else usage.count++;
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(ELEVENLABS_VOICE_ID) + '?output_format=mp3_44100_128', {
      method:'POST',
      headers:{'xi-api-key':ELEVENLABS_API_KEY,'Content-Type':'application/json','Accept':'audio/mpeg'},
      body:JSON.stringify({
        text,
        model_id:'eleven_multilingual_v2',
        voice_settings:{stability:0.58,similarity_boost:0.82,style:0.18,use_speaker_boost:true,speed:0.88}
      })
    });
    if (!response.ok) {
      const details = await response.text();
      console.error('ElevenLabs TTS error:',response.status,details.slice(0,1000));
      return res.status(502).json({error:'Не удалось создать озвучку. Проверь баланс и доступность голоса в ElevenLabs.'});
    }
    const audio = Buffer.from(await response.arrayBuffer());
    meditationAudioCache.set(cacheKey,audio);
    res.setHeader('Cache-Control','private, max-age=86400');
    res.type('audio/mpeg').send(audio);
  } catch(error) {
    console.error('Meditation audio error:',error);
    res.status(502).json({error:'Ошибка при создании голосовой практики'});
  }
});

app.post('/api/payments/create-invoice', auth, async (req, res) => {
  try {
    if (['PRO','FRIENDS','ADMIN'].includes(await getRole(req.telegramUser.id))) return res.status(409).json({error:'У вас уже есть полный доступ'});
    const payload = `pro_monthly:${req.telegramUser.id}:${crypto.randomUUID()}`;
    const invoiceLink = await telegram('createInvoiceLink', {
      title:'FUTURE SELF PRO', description:'Месяц доступа к функциям FUTURE SELF', payload,
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
        await query(
          'INSERT INTO payments(telegram_charge_id,telegram_id,amount,currency,expires_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_charge_id) DO UPDATE SET telegram_id=excluded.telegram_id,amount=excluded.amount,currency=excluded.currency,expires_at=excluded.expires_at,created_at=excluded.created_at',
          [payment.telegram_payment_charge_id,id,payment.total_amount,payment.currency,expiry,Date.now()]
        );
        await query('UPDATE users SET subscription_expires_at=? WHERE telegram_id=?', [expiry,id]);
      }
    }
    res.sendStatus(200);
  } catch(e) { console.error('Telegram webhook error:',e); res.sendStatus(500); }
});

app.use('/api/admin', auth, (req,res,next)=>{ if(!isAdmin(req)) return res.status(403).json({error:'Admin only'}); next(); });

app.get('/api/admin/users', async (req,res) => {
  try {
    const result = await query('SELECT telegram_id AS "telegramId",first_name AS name,access,access_expires_at AS "expiresAt",subscription_expires_at AS "subscriptionExpiresAt" FROM users ORDER BY created_at DESC LIMIT 500');
    const users = await Promise.all(result.rows.map(async u=>({
      ...u,
      access: await getRole(u.telegramId),
      expiresAt: u.expiresAt ? new Date(Number(u.expiresAt)).toISOString() : null,
      subscriptionExpiresAt: u.subscriptionExpiresAt ? Number(u.subscriptionExpiresAt) : null
    })));
    res.json({users});
  } catch(e) { console.error('Admin users error:',e); res.status(500).json({error:'Database error'}); }
});

app.post('/api/admin/grant', async (req,res) => {
  try {
    const id=String(req.body?.telegramId||''); const days=Number(req.body?.durationDays);
    if(!/^\d{5,15}$/.test(id) || ![0,7,30,90,365].includes(days)) return res.status(400).json({error:'Invalid Telegram ID or duration'});
    const expires=days===0?null:Date.now()+days*86400000;
    await query(
      "INSERT INTO users(telegram_id,first_name,access,access_expires_at,created_at) VALUES(?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET access='FRIENDS',access_expires_at=excluded.access_expires_at",
      [id,'FRIENDS','FRIENDS',expires,Date.now()]
    );
    res.json({ok:true});
  } catch(e) { console.error('Grant access error:',e); res.status(500).json({error:'Database error'}); }
});

app.post('/api/invites/redeem', auth, async (req,res) => {
  try {
    const token=String(req.body?.token||'');
    if(!/^[a-f0-9]{48}$/.test(token)) return res.status(400).json({error:'Некорректная ссылка-приглашение'});
    const now=Date.now();
    const result = await transaction(async client => {
      const found = await query('SELECT duration_days,expires_at,used_at,used_by FROM access_invites WHERE token=?', [token], client);
      const invite = found.rows[0];
      if(!invite || Number(invite.expires_at)<=now) return null;
      if(invite.used_at) return invite.used_by===String(req.telegramUser.id)?{alreadyActivated:true}:null;
      const expires=Number(invite.duration_days)===0?null:now+Number(invite.duration_days)*86400000;
      const claimed = await query('UPDATE access_invites SET used_at=?,used_by=? WHERE token=? AND used_at IS NULL', [now,String(req.telegramUser.id),token], client);
      if (claimed.rowCount !== 1) return null;
      await query(
        "INSERT INTO users(telegram_id,first_name,access,access_expires_at,created_at) VALUES(?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET access='FRIENDS',access_expires_at=excluded.access_expires_at",
        [String(req.telegramUser.id),req.telegramUser.first_name||'Пользователь','FRIENDS',expires,now], client
      );
      return {expiresAt:expires,alreadyActivated:false};
    });
    if(!result) return res.status(410).json({error:'Ссылка уже использована или срок её действия истёк'});
    res.json({ok:true,expiresAt:result.expiresAt});
  } catch(e) { console.error('Redeem invite error:',e); res.status(500).json({error:'Database error'}); }
});

app.post('/api/admin/invites', async (req,res) => {
  try {
    const days=Number(req.body?.durationDays);
    if(![0,7,30,90,365].includes(days)) return res.status(400).json({error:'Invalid invite duration'});
    const token=crypto.randomBytes(24).toString('hex');
    const now=Date.now();
    await query('INSERT INTO access_invites(token,duration_days,created_by,created_at,expires_at) VALUES(?,?,?,?,?)',
      [token,days,String(req.telegramUser.id),now,now+7*86400000]);
    res.json({ok:true,token,inviteUrl:'https://t.me/VAMOPAV_bot?startapp='+token,expiresAt:now+7*86400000,durationDays:days});
  } catch(e) { console.error('Create invite error:',e); res.status(500).json({error:'Database error'}); }
});

app.post('/api/admin/revoke', async (req,res) => {
  try {
    const id=String(req.body?.telegramId||'');
    if(!/^\d{5,15}$/.test(id)) return res.status(400).json({error:'Invalid Telegram ID'});
    await query("UPDATE users SET access='FREE',access_expires_at=NULL WHERE telegram_id=? AND telegram_id<>?", [id,ADMIN_ID]);
    res.json({ok:true});
  } catch(e) { console.error('Revoke access error:',e); res.status(500).json({error:'Database error'}); }
});

app.get('/health', async (_req,res)=>{
  try {
    if (pool) await pool.query('SELECT 1');
    else sqlite.prepare('SELECT 1').get();
    res.json({ok:true,database:databaseMode});
  } catch(e) { res.status(503).json({ok:false,database:databaseMode}); }
});
app.use(express.static(process.cwd()));

const port=Number(process.env.PORT||3000);
initializeDatabase().then(()=>{
  app.listen(port,()=>console.log(`FUTURE SELF API listening on ${port} using ${databaseMode}`));
}).catch(error=>{
  console.error('Database initialization failed; server was not started:',error);
  process.exit(1);
});
