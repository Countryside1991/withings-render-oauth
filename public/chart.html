<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BP Trend</title>
  <style>
    body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin:24px}
    .card{max-width:920px;margin:auto;border:1px solid #e5e7eb;border-radius:16px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,.05)}
    h1{font-size:20px;margin:0 0 12px}
    .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    input,button,select{padding:8px 12px;border:1px solid #d1d5db;border-radius:10px}
    button{cursor:pointer}
    .muted{color:#6b7280}
    .badge{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid #d1d5db;margin-left:8px}
  </style>
</head>
<body>
  <div class="card">
    <h1>ความดันโลหิต (BP) — แนวโน้ม <span id="mode" class="badge" style="display:none"></span></h1>
    <p class="muted">ถ้ายังไม่ authorize ให้กลับไปหน้าแรกแล้วกดปุ่ม Authorize ก่อน</p>
    <div class="row">
      <label>ช่วงวัน:
        <select id="days">
          <option value="7">7 วัน</option>
          <option value="14">14 วัน</option>
          <option value="30" selected>30 วัน</option>
          <option value="90">90 วัน</option>
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="useDemo" checked />
        ใช้ข้อมูลตัวอย่างอัตโนมัติเมื่อไม่มีข้อมูลจริง
      </label>
      <button id="reload">โหลดข้อมูล</button>
      <button id="sendWeekly">ส่งสรุป 7 วัน (LINE)</button>
      <a href="/" style="margin-left:auto">หน้าแรก</a>
    </div>
    <canvas id="bpChart" height="120"></canvas>
    <pre id="meta" class="muted"></pre>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script>
    const ctx = document.getElementById('bpChart');
    let chart;

    async function fetchJSON(url){
      const res = await fetch(url);
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    }

    async function loadChart(days=30){
      let mode = 'real';
      let data = [];
      try {
        data = await fetchJSON(`/api/bp?days=${days}`);
      } catch (e) {
        console.warn('Fetch real BP failed:', e.message);
        data = [];
      }

      const allowDemo = document.getElementById('useDemo').checked;
      if ((!data || data.length === 0) && allowDemo) {
        try {
          data = await fetchJSON(`/api/bp-demo?days=${days}`);
          mode = 'demo';
        } catch (e) {
          console.warn('Fetch demo BP failed:', e.message);
        }
      }

      const modeBadge = document.getElementById('mode');
      if (mode === 'demo') {
        modeBadge.textContent = 'แสดงข้อมูลตัวอย่าง';
        modeBadge.style.display = 'inline-block';
      } else {
        modeBadge.style.display = data.length ? 'none' : 'inline-block';
        if (!data.length) { modeBadge.textContent = 'ไม่มีข้อมูล'; }
      }

      if (!data || !data.length) {
        if(chart){ chart.destroy(); }
        document.getElementById('meta').textContent = 'ไม่พบข้อมูลในช่วงวันที่เลือก';
        return;
      }

      const labels = data.map(d=>new Date(d.ts*1000).toLocaleString());
      const sbp = data.map(d=>d.sbp);
      const dbp = data.map(d=>d.dbp);
      const hr  = data.map(d=>d.hr);

      const meta = document.getElementById('meta');
      const n = data.length;
      const avg = arr => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length) : 0;
      const hrAvg = avg(hr.filter(x=>x!=null));
      meta.textContent = `โหมด: ${mode==='demo'?'ตัวอย่าง':'ข้อมูลจริง'} | จุดข้อมูล: ${n} | ค่าเฉลี่ย SBP=${avg(sbp).toFixed(1)} DBP=${avg(dbp).toFixed(1)} HR=${isFinite(hrAvg)?hrAvg.toFixed(1):'-'}`;

      const cfg = {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'SBP', data: sbp, pointRadius: 2 },
            { label: 'DBP', data: dbp, pointRadius: 2 },
            { label: 'HR',  data: hr,  pointRadius: 3, yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          scales: {
            y: { title: { display: true, text: 'mmHg' } },
            y1: { position: 'right', title: { display: true, text: 'bpm' }, grid: { drawOnChartArea: false } }
          }
        }
      };

      if(chart){ chart.destroy(); }
      chart = new Chart(ctx, cfg);
    }

    document.getElementById('reload').onclick = ()=>{
      const days = document.getElementById('days').value;
      loadChart(days);
    };

    document.getElementById('sendWeekly').onclick = async ()=>{
      try{
        const r = await fetch('/line/send-weekly');
        const t = await r.text();
        alert(t || 'ส่งแล้ว');
      }catch(e){
        alert('ส่งไม่สำเร็จ: ' + e.message);
      }
    };

    loadChart(30);
  </script>
</body>
</html>
