// server.js — Withings OAuth + Notifications + LINE + Demo BP + Weekly Button + Advice (final-one-file)
require('dotenv').config();
const path = require('path');
const express = require('express');
const axios = require('axios');
const qs = require('qs');
const cron = require('node-cron');
const line = require('@line/bot-sdk');

const app = express();

/* ===================== LINE (REGISTER BEFORE BODY PARSERS) ===================== */
// LINE config
const lineConfig = (() => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  const secret = process.env.LINE_CHANNEL_SECRET || '';
  if (token && secret) return { channelAccessToken: token, channelSecret: secret };
  return null;
})();
const lineClient = lineConfig ? new line.Client(lineConfig) : null;
let LAST_LINE_USER_ID = null;

// Webhook route: return 200 even if not configured so LINE "Verify" succeeds
app.post(
  '/line/webhook',
  (req, res, next) => {
    if (!lineClient || !lineConfig) {
      console.warn('[LINE] Not configured yet, returning 200 for Verify');
      return res.status(200).end();
    }
    return next();
  },
  // IMPORTANT: no body parser before this middleware
  line.middleware(lineConfig || { channelAccessToken: 'dummy', channelSecret: 'dummy' }),
  async (req, res) => {
    try {
      const events = req.body.events || [];
      for (const ev of events) {
        if (ev.source?.userId) LAST_LINE_USER_ID = ev.source.userId;
        if (ev.type === 'message' && ev.replyToken && lineClient) {
          await lineClient.replyMessage(ev.replyToken, {
            type: 'text',
            text: `รับข้อมูลแล้ว ✅ userId: ${ev.source.userId}`
          });
        }
      }
      res.status(200).end();
    } catch (e) {
      console.error('LINE webhook error:', e.message);
      res.status(200).end(); // still 200 to avoid Verify failure
    }
  }
);

// Helper route always available
app.get('/line/last-user', (req, res) => {
  if (!lineClient) {
    return res
      .type('text')
      .send('LINE not configured — ใส่ LINE_CHANNEL_ACCESS_TOKEN และ LINE_CHANNEL_SECRET ใน Render แล้ว Restart');
  }
  res
    .type('text')
    .send(LAST_LINE_USER_ID
      ? `LAST_LINE_USER_ID = ${LAST_LINE_USER_ID}`
      : 'ยังไม่มี userId — กรุณาเพิ่มบอทเป็นเพื่อนและทักข้อความใส่มาที่บอทก่อน');
});

/* ===================== BODY PARSERS & STATIC (AFTER LINE WEBHOOK) ===================== */
app.use(express.urlencoded({ extended: true })); // for Withings notify (x-www-form-urlencoded)
app.use(express.json());
app.use('/public', express.static('public'));

/* ===================== WITHINGS OAUTH / API ===================== */
const CLIENT_ID = process.env.WITHINGS_CLIENT_ID;
const CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET;
const SCOPE = process.env.WITHINGS_SCOPE || 'user.metrics';
const USE_DEMO = String(process.env.WITHINGS_USE_DEMO || 'true') === 'true';

// Token store (demo only — replace with DB in production)
let TOKENS = null; // { access_token, refresh_token, expires_at, userid }

function baseUrlFrom(req){
  return process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || (`https://${req.headers.host}`);
}

app.get('/', (req, res) => {
  const base = baseUrlFrom(req);
  const u = new URL('https://account.withings.com/oauth2_user/authorize2');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', CLIENT_ID || '');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('redirect_uri', `${base}/oauth/callback`);
  u.searchParams.set('state', Math.random().toString(36).slice(2));
  if (USE_DEMO) u.searchParams.set('mode', 'demo');

  res.type('html').send(`
    <h1>Withings OAuth Quickstart + LINE</h1>
    <p>Base URL: <code>${base}</code></p>
    <p>Redirect URI: <code>${base}/oauth/callback</code></p>
    <p>Callback URI (Withings webhook): <code>${base}/withings/notify</code></p>
    <p>LINE Webhook URL: <code>${base}/line/webhook</code></p>
    <p><a href="${u.toString()}"><button>Authorize Withings ${USE_DEMO ? '(DEMO)' : ''}</button></a></p>
    <p>
      <a href="/chart">ดูกราฟ BP</a> •
      <a href="/withings/subscribe?appli=4">Subscribe Notifications (BP)</a> •
      <a href="/line/send-weekly">ส่งสรุป 7 วัน (LINE)</a> •
      <a href="/line/test-push">ทดสอบส่ง LINE</a> •
      <a href="/line/last-user">ดู userId ล่าสุด</a>
    </p>
    <pre>Tokens: ${TOKENS ? 'READY for userid ' + TOKENS.userid : 'None'}</pre>
  `);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  const redirect_uri = `${baseUrlFrom(req)}/oauth/callback`;
  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code) return res.status(400).send('Missing ?code');
  try {
    const payload = {
      action: 'requesttoken',
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri
    };
    const { data } = await axios.post('https://wbsapi.withings.net/v2/oauth2', qs.stringify(payload), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (data.status !== 0) throw new Error(JSON.stringify(data));
    const body = data.body;
    const expires_at = Math.floor(Date.now() / 1000) + (body.expires_in || 3 * 60 * 60);
    TOKENS = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at,
      userid: String(body.userid)
    };
    res.type('html').send(`
      <h2>Authorized ✅</h2>
      <p>UserID: ${TOKENS.userid}</p>
      <p>ต่อไป: <a href="/withings/subscribe?appli=4">สมัคร Notifications (BP)</a> หรือ <a href="/chart">ดูกราฟ</a></p>
    `);
  } catch (e) {
    res.status(500).send('Token exchange failed: ' + e.message);
  }
});

async function ensureAccessToken() {
  if (!TOKENS) throw new Error('Not authorized yet.');
  const now = Math.floor(Date.now() / 1000);
  if (now < (TOKENS.expires_at - 60)) return TOKENS.access_token;

  const payload = {
    action: 'requesttoken',
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: TOKENS.refresh_token
  };
  const { data } = await axios.post('https://wbsapi.withings.net/v2/oauth2', qs.stringify(payload), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (data.status !== 0) throw new Error('Refresh failed: ' + JSON.stringify(data));
  const body = data.body;
  TOKENS.access_token = body.access_token;
  TOKENS.refresh_token = body.refresh_token || TOKENS.refresh_token;
  TOKENS.expires_at = Math.floor(Date.now() / 1000) + (body.expires_in || 3 * 60 * 60);
  return TOKENS.access
