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
  return TOKENS.access_token;
}

/* ===== Real BP data ===== */
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

/* ===== Demo BP data fallback ===== */
function generateDemoBP(days = 30) {
  const out = [];
  const now = Math.floor(Date.now() / 1000);
  for (let d = days - 1; d >= 0; d--) {
    const ts1 = now - d * 24 * 3600 + 8 * 3600 + Math.floor(Math.random() * 1800);  // ~08:00
    const ts2 = now - d * 24 * 3600 + 20 * 3600 + Math.floor(Math.random() * 1800); // ~20:00
    const baselineSBP = 124 + Math.round((Math.random() - 0.5) * 12); // 118–130
    const baselineDBP = 78 + Math.round((Math.random() - 0.5) * 8);   // 74–82
    const spike = Math.random() < 0.12 ? 10 + Math.round(Math.random() * 8) : 0; // some days spike
    const hr1 = 68 + Math.round((Math.random() - 0.5) * 10);
    const hr2 = 72 + Math.round((Math.random() - 0.5) * 10);
    out.push({ ts: ts1, sbp: baselineSBP, dbp: baselineDBP, hr: hr1 });
    out.push({ ts: ts2, sbp: baselineSBP + spike, dbp: baselineDBP + Math.round(spike/2), hr: hr2 });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

app.get('/api/bp-demo', (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days || '30', 10)));
  res.json(generateDemoBP(days));
});

/* ===== Withings notifications ===== */
app.get('/withings/subscribe', async (req, res) => {
  const appli = parseInt(req.query.appli || '4', 10); // 4 = blood pressure
  try {
    const access = await ensureAccessToken();
    const callbackurl = `${baseUrlFrom(req)}/withings/notify`;
    const payload = { action: 'subscribe', callbackurl, appli, comment: 'demo subscribe' };
    const { data } = await axios.post('https://wbsapi.withings.net/notify', qs.stringify(payload), {
      headers: { 'Authorization': `Bearer ${access}`, 'Content-Type': 'application/x-www-form-urlencoded' }
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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${access}` }
    });
    console.log('Fetched new measures count:', resp.data?.body?.measuregrps?.length || 0);
  } catch (err) {
    console.error('Post-notify fetch failed:', err.message);
  }
});

/* ===================== LINE summary with ADVICE ===================== */
// Weekly summary (Thai) + advice rules (enhanced)
async function buildWeeklySummaryTH(days = 7) {
  const access = await ensureAccessToken();
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 24 * 60 * 60;

  const params = {
    action: 'getmeas',
    meastypes: '9,10,11',   // DBP(9), SBP(10), HR(11)
    category: 1,
    startdate: start,
    enddate: end
  };
  const { data } = await axios.post('https://wbsapi.withings.net/measure', qs.stringify(params), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${access}` }
  });

  const grps = data.body?.measuregrps || [];
  const rows = [];
  for (const g of grps) {
    let sbp, dbp, hr;
    for (const m of g.measures) {
      if (m.type === 10) sbp = m.value * Math.pow(10, m.unit);
      if (m.type === 9)  dbp = m.value * Math.pow(10, m.unit);
      if (m.type === 11) hr  = m.value * Math.pow(10, m.unit);
    }
    if (sbp != null && dbp != null) rows.push({ ts: g.date, sbp, dbp, hr: hr ?? null });
  }
  if (!rows.length) return "สรุป BP รายสัปดาห์: ไม่พบข้อมูลในช่วงที่ผ่านมา";

  const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
  const sbps = rows.map(r=>r.sbp);
  const dbps = rows.map(r=>r.dbp);
  const hrs  = rows.filter(r=>r.hr!=null).map(r=>r.hr);

  const avgSBP = avg(sbps);
  const avgDBP = avg(dbps);
  const hiSBP = Math.max(...sbps), loSBP = Math.min(...sbps);
  const hiDBP = Math.max(...dbps), loDBP = Math.min(...dbps);
  const avgHR  = hrs.length ? avg(hrs) : null;

  // Count high readings
  const highCnt = rows.filter(r=> (r.sbp>=140 || r.dbp>=90)).length;
  const highPct = Math.round((highCnt/rows.length)*100);

  // Days measured
  const daySet = new Set(rows.map(r => Math.floor(r.ts / 86400)));
  const daysMeasured = daySet.size;

  // Advice rules
  let adviceHeader = "";
  const advice = [];
  if (avgSBP >= 160 || avgDBP >= 100) {
    adviceHeader = "สรุป: ความดันสูงมาก ควบคุมยังไม่ดี";
    advice.push(
      "• ความดันยังคุมได้ไม่ดี ต้องรับประทานยาสม่ำเสมอตามแพทย์สั่ง",
      "• ลดอาหารเค็ม (เลี่ยงน้ำปลา/ซีอิ๊ว/ซุปเข้มข้น) จำกัดแอลกอฮอล์",
      "• ออกกำลังกายระดับปานกลาง ~150 นาที/สัปดาห์ และควบคุมน้ำหนัก",
      "• นัดติดตามแพทย์ตามกำหนด / ปรึกษาแพทย์เรื่องการปรับยา"
    );
  } else if (avgSBP >= 140 || avgDBP >= 90) {
    adviceHeader = "สรุป: ความดันยังคุมได้ไม่ดี";
    advice.push(
      "• ความดันยังคุมได้ไม่ดี ต้องรับประทานยาสม่ำเสมอ",
      "• ลดอาหารเค็ม เพิ่มผักผลไม้แบบ DASH diet",
      "• ออกกำลังกาย ~150 นาที/สัปดาห์ จำกัดแอลกอฮอล์ และพักผ่อนเพียงพอ",
      "• วัดและบันทึกความดันอย่างสม่ำเสมอ"
    );
  } else if ((avgSBP >= 130 && avgSBP <= 139) || (avgDBP >= 80 && avgDBP <= 89)) {
    adviceHeader = "สรุป: ความดันเริ่มสูง ต้องปรับพฤติกรรมต่อเนื่อง";
    advice.push(
      "• ลดเค็ม เพิ่มผักผลไม้ ควบคุมน้ำหนัก",
      "• เดิน/ออกกำลัง ≥30 นาทีต่อวัน เกือบทุกวัน",
      "• วัดและบันทึกความดันอย่างสม่ำเสมอ"
    );
  } else {
    adviceHeader = "สรุป: คุมได้ดี 👍";
    advice.push(
      "• รักษาพฤติกรรมดี ๆ ต่อเนื่อง",
      "• รับประทานยาตามแพทย์สั่ง (ถ้ามี) และวัดความดันต่อเนื่อง"
    );
  }
  if (hiSBP >= 180 || hiDBP >= 120) {
    advice.push("⚠️ พบค่าความดันสูงมากบางครั้ง (≥180/≥120) หากมีอาการปวดศีรษะมาก เวียนศีรษะ เจ็บหน้าอก เหนื่อย หรือตาพร่า ให้ไปโรงพยาบาลทันที");
  }
  if (daysMeasured < 5) {
    advice.push(`• วัดให้ได้อย่างน้อย ~5 วัน/สัปดาห์ (สัปดาห์นี้วัด ${daysMeasured} วัน) เพื่อประเมินแนวโน้มให้แม่นยำขึ้น`);
  }

  const lines = [
    "สรุป BP รายสัปดาห์",
    `จำนวนครั้งวัด: ${rows.length} (${daysMeasured} วัน)`,
    `ค่าเฉลี่ย: ${avgSBP.toFixed(1)}/${avgDBP.toFixed(1)} mmHg${avgHR!=null ? ` • HR ${avgHR.toFixed(1)} bpm` : ""}`,
    `ช่วง (SBP): ต่ำสุด ${loSBP} สูงสุด ${hiSBP} mmHg`,
    `ช่วง (DBP): ต่ำสุด ${loDBP} สูงสุด ${hiDBP} mmHg`,
    `มีค่าเกิน 140/90: ${highCnt} ครั้ง (${isFinite(highPct)?highPct:0}%)`,
    "",
    adviceHeader,
    ...advice
  ];
  return lines.join("\n");
}

// manual trigger button
app.get('/line/send-weekly', async (req, res) => {
  try {
    if (!lineClient) return res.status(400).send('LINE not configured');
    const to = process.env.LINE_USER_ID;
    if (!to) return res.status(400).send('Missing LINE_USER_ID env');
    const text = await buildWeeklySummaryTH(7);
    await lineClient.pushMessage(to, { type: 'text', text });
    res.send('LINE weekly summary sent.');
  } catch (e) {
    res.status(500).send('LINE send failed: ' + e.message);
  }
});

// quick test push
app.get('/line/test-push', async (req, res) => {
  try {
    if (!lineClient) return res.status(400).send('LINE not configured');
    const to = process.env.LINE_USER_ID;
    if (!to) return res.status(400).send('Missing LINE_USER_ID env');
    await lineClient.pushMessage(to, { type: 'text', text: 'ทดสอบส่งจากระบบ Withings ✅' });
    res.send('Sent test push.');
  } catch (e) {
    res.status(500).send('LINE push failed: ' + e.message);
  }
});

// weekly cron Mon 09:00 Asia/Bangkok
if (lineClient) {
  cron.schedule('0 9 * * MON', async () => {
    try {
      const to = process.env.LINE_USER_ID;
      if (!to || !TOKENS) return;
      const text = await buildWeeklySummaryTH(7);
      await lineClient.pushMessage(to, { type: 'text', text });
      console.log('[cron] Sent weekly summary to LINE_USER_ID');
    } catch (e) {
      console.error('[cron] Failed weekly summary:', e.message);
    }
  }, { timezone: 'Asia/Bangkok' });
}

/* ===================== UI ===================== */
app.get('/chart', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chart.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));
