// server.js — พร้อมใช้บน Render หรือรันท้องถิ่น (CommonJS)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
app.use('/public', express.static('public'));

const CLIENT_ID = process.env.WITHINGS_CLIENT_ID;
theCLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET;
const SCOPE = process.env.WITHINGS_SCOPE || 'user.metrics';
const USE_DEMO = String(process.env.WITHINGS_USE_DEMO || 'true') === 'true';

// เก็บ token ไว้ในหน่วยความจำ (เดโม่) — โปรดเก็บใน DB จริงเมื่อทำโปรดักชัน
let TOKENS = null; // { access_token, refresh_token, expires_at, userid }

function baseUrlFrom(req){
  // บน Render มีตัวแปร RENDER_EXTERNAL_URL (https://your-app.onrender.com)
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
    <h1>Withings OAuth Quickstart</h1>
    <p>Base URL: <code>${base}</code></p>
    <p>Redirect URI ที่ต้องไปตั้งใน Withings Developer:<br/>
       <code>${base}/oauth/callback</code></p>
    <p><a href="${u.toString()}"><button>Authorize Withings ${USE_DEMO ? '(DEMO)' : ''}</button></a></p>
    <p><a href="/public/chart.html">View BP Chart</a> (หลัง authorize)</p>
    <pre>Tokens: ${TOKENS ? 'READY' : 'None'}</pre>
  `);
});

// จุดรับ callback หลังผู้ใช้กด Accept
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
    const body = data.body; // { access_token, refresh_token, expires_in, scope, userid }
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
      <p>Access token พร้อมใช้งาน (ตัวอย่างนี้เก็บชั่วคราวในหน่วยความจำ)</p>
      <p>ต่อไป: เปิด <a href="/public/chart.html">BP Chart</a></p>
    `);
  } catch (e) {
    res.status(500).send('Token exchange failed: ' + e.message);
  }
});

// refresh token เมื่อหมดอายุ (ตัวอย่างอย่างง่าย)
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
  return TOKENS.access_token;
}

// API ให้หน้า chart เรียกดึง BP (SBP/DBP/HR)
app.get('/api/bp', async (req, res) => {
  try {
    const access = await ensureAccessToken();
    const days = Math.max(1, Math.min(365, parseInt(req.query.days || '30', 10)));
    const end = Math.floor(Date.now() / 1000);
    const start = end - days * 24 * 60 * 60;

    const params = {
      action: 'getmeas',
      meastypes: '9,10,11', // DBP, SBP, HR
      category: 1,
      startdate: start,
      enddate: end
    };
    const { data } = await axios.post('https://wbsapi.withings.net/measure', qs.stringify(params), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${access}`
      }
    });
    if (data.status !== 0) return res.status(500).json({ error: data });

    const grps = data.body?.measuregrps || [];
    const out = [];
    for (const g of grps) {
      const ts = g.date;
      let sbp, dbp, hr;
      for (const m of g.measures) {
        if (m.type === 10) sbp = m.value * Math.pow(10, m.unit);
        if (m.type === 9)  dbp = m.value * Math.pow(10, m.unit);
        if (m.type === 11) hr  = m.value * Math.pow(10, m.unit);
      }
      if (sbp != null && dbp != null) out.push({ ts, sbp, dbp, hr: hr ?? null });
    }
    out.sort((a, b) => a.ts - b.ts);
    res.json(out);
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));
