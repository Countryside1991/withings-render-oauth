// server.js — Withings OAuth + Notifications + LINE weekly summary + LINE webhook (Full)
require('dotenv').config();
const path = require('path');
const express = require('express');
const axios = require('axios');
const qs = require('qs');
const cron = require('node-cron');
const line = require('@line/bot-sdk');

const app = express();
app.use(express.urlencoded({ extended: true })); // parse x-www-form-urlencoded (Withings notify)
app.use(express.json());
app.use('/public', express.static('public'));

// ===== Withings OAuth basic setup =====
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
    <p>Redirect URI (Withings Developer): <code>${base}/oauth/callback</code></p>
    <p>Callback URI for Notifications (add in Withings Developer "Callback URI" list):<br/>
      <code>${base}/withings/notify</code>
    </p>
    <p>LINE Webhook URL (optional, for capturing userId):<br/>
      <code>${base}/line/webhook</code>
    </p>
    <p><a href="${u.toString()}"><button>Authorize Withings ${USE_DEMO ? '(DEMO)' : ''}</button></a></p>
    <p><a href="/chart">ดูกราฟ BP</a> (หลัง authorize)</p>
    <p><a href="/withings/subscribe?appli=4">Subscribe Notifications (BP)</a> — ต้อง authorize แล้วก่อน</p>
    <p><a href="/line/test-push">ทดสอบส่ง LINE</a> — ตั้งค่า LINE_* แล้ว และมี LINE_USER_ID</p>
    <p><a href="/line/last-user">ดู userId ล่าสุดที่ webhook จับได้</a> (หลังจากทักแชตบอท)</p>
    <pre>Tokens: ${TOKENS ? 'READY for userid ' + TOKENS.userid : 'None'}</pre>
  `);
});

// OAuth callback
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
      <p>Access token พร้อมใช้งาน</p>
      <p>ต่อไป: 
        <a href="/withings/subscribe?appli=4">กดสมัคร Notifications (BP)</a> 
        แล้วเปิด <a href="/chart">กราฟ BP</a>
      </p>
    `);
  } catch (e) {
    res.status(500).send('Token exchange failed: ' + e.message);
  }
});

// Token refresh helper
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

// ===== Withings Data Fetch (BP) =====
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

// ===== Withings Notifications =====
app.get('/withings/subscribe', async (req, res) => {
  const appli = parseInt(req.query.appli || '4', 10); // default pressure
  try {
    const access = await ensureAccessToken();
    const callbackurl = `${baseUrlFrom(req)}/withings/notify`;
    const payload = {
      action: 'subscribe',
      callbackurl,
      appli,
      comment: 'demo subscribe'
    };
    const { data } = await axios.post('https://wbsapi.withings.net/notify', qs.stringify(payload), {
      headers: {
        'Authorization': `Bearer ${access}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    res.type('json').send({ subscribe_payload: payload, response: data });
  } catch (e) {
    res.status(500).send('Subscribe failed: ' + e.message);
  }
});

app.post('/withings/notify', async (req, res) => {
  console.log('Withings notify payload:', req.body);
  res.status(200).send('OK');
  try {
    const { startdate, enddate } = req.body || {};
    const access = await ensureAccessToken();
    const params = {
      action: 'getmeas',
      meastypes: '9,10,11',
      category: 1,
      startdate: startdate || Math.floor(Date.now()/1000) - 7*24*60*60,
      enddate: enddate || Math.floor(Date.now()/1000)
    };
    const resp = await axios.post('https://wbsapi.withings.net/measure', qs.stringify(params), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${access}`
      }
    });
    console.log('Fetched new measures count:', resp.data?.body?.measuregrps?.length || 0);
  } catch (err) {
    console.error('Post-notify fetch failed:', err.message);
  }
});

// ===== LINE Messaging API =====
const lineConfig = (() => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  const secret = process.env.LINE_CHANNEL_SECRET || '';
  if (token && secret) return { channelAccessToken: token, channelSecret: secret };
  return null;
})();
const lineClient = lineConfig ? new line.Client(lineConfig) : null;

// Capture userId via webhook
let LAST_LINE_USER_ID = null;

if (lineConfig) {
  app.post('/line/webhook', line.middleware(lineConfig), async (req, res) => {
    try {
      const events = req.body.events || [];
      for (const ev of events) {
        if (ev.source?.userId) LAST_LINE_USER_ID = ev.source.userId;
        if (ev.type === 'message' && ev.replyToken) {
          await lineClient.replyMessage(ev.replyToken, { type: 'text', text: `รับข้อมูลแล้ว ✅ userId: ${ev.source.userId}` });
        }
      }
      res.status(200).end();
    } catch (e) {
      console.error('LINE webhook error:', e.message);
      res.status(500).end();
    }
  });

  // Helper to show the last captured userId
  app.get('/line/last-user', (req, res) => {
    res.type('text').send(LAST_LINE_USER_ID ? `LAST_LINE_USER_ID = ${LAST_LINE_USER_ID}` : 'ยังไม่มี userId — กรุณาเพิ่มบอทเป็นเพื่อนและทักข้อความใส่มาที่บอทก่อน');
  });
}

// Weekly summary (Thai)
async function buildWeeklySummaryTH(days=7){
  const access = await ensureAccessToken();
  const end = Math.floor(Date.now()/1000);
  const start = end - days*24*60*60;
  const params = {
    action: 'getmeas',
    meastypes: '9,10,11',
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
  const grps = data.body?.measuregrps || [];
  const rows = [];
  for(const g of grps){
    const ts = g.date;
    let sbp, dbp, hr;
    for(const m of g.measures){
      if(m.type===10) sbp = m.value * Math.pow(10, m.unit);
      if(m.type===9)  dbp = m.value * Math.pow(10, m.unit);
      if(m.type===11) hr  = m.value * Math.pow(10, m.unit);
    }
    if(sbp!=null && dbp!=null) rows.push({ts, sbp, dbp, hr: hr??null});
  }
  if(!rows.length) return "สรุป BP รายสัปดาห์: ไม่พบข้อมูลในช่วงที่ผ่านมา";

  const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
  const sbps = rows.map(r=>r.sbp);
  const dbps = rows.map(r=>r.dbp);
  const hrs  = rows.filter(r=>r.hr!=null).map(r=>r.hr);
  const hiSBP = Math.max(...sbps), loSBP = Math.min(...sbps);
  const hiDBP = Math.max(...dbps), loDBP = Math.min(...dbps);
  const msg = [
    "สรุป BP รายสัปดาห์",
    `จำนวนครั้งวัด: ${rows.length}`,
    `SBP เฉลี่ย: ${avg(sbps).toFixed(1)} (สูงสุด ${hiSBP}, ต่ำสุด ${loSBP})`,
    `DBP เฉลี่ย: ${avg(dbps).toFixed(1)} (สูงสุด ${hiDBP}, ต่ำสุด ${loDBP})`,
    hrs.length? `HR เฉลี่ย: ${avg(hrs).toFixed(1)} bpm` : null
  ].filter(Boolean).join("
");
  return msg;
}

// Manual trigger to send weekly summary to LINE_USER_ID
app.get('/line/send-weekly', async (req, res) => {
  try{
    if(!lineClient) return res.status(400).send('LINE not configured');
    const to = process.env.LINE_USER_ID;
    if(!to) return res.status(400).send('Missing LINE_USER_ID env');
    const text = await buildWeeklySummaryTH(7);
    await lineClient.pushMessage(to, { type: 'text', text });
    res.send('LINE weekly summary sent.');
  }catch(e){
    res.status(500).send('LINE send failed: '+e.message);
  }
});

// Simple test push
app.get('/line/test-push', async (req, res) => {
  try{
    if(!lineClient) return res.status(400).send('LINE not configured');
    const to = process.env.LINE_USER_ID;
    if(!to) return res.status(400).send('Missing LINE_USER_ID env');
    await lineClient.pushMessage(to, { type: 'text', text: 'ทดสอบส่งจากระบบ Withings ✅' });
    res.send('Sent test push.');
  }catch(e){
    res.status(500).send('LINE push failed: '+e.message);
  }
});

// Weekly cron (Mon 09:00 Asia/Bangkok)
if (lineClient) {
  cron.schedule('0 9 * * MON', async () => {
    try{
      const to = process.env.LINE_USER_ID;
      if(!to || !TOKENS) return; // needs target and tokens
      const text = await buildWeeklySummaryTH(7);
      await lineClient.pushMessage(to, { type: 'text', text });
      console.log('[cron] Sent weekly summary to LINE_USER_ID');
    }catch(e){
      console.error('[cron] Failed weekly summary:', e.message);
    }
  }, { timezone: 'Asia/Bangkok' });
}

// Serve chart via route + static
app.get('/chart', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chart.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));
