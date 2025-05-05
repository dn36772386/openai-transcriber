/* ======================================================
   OpenAI Transcriber 主要ロジック
   ====================================================== */
/* ---------- 設定値 ---------- */
const DEBUG = true;
const MAX_HIST = 10;
const TOTAL_MS = 7200000; // 2h

/* ---------- ショートハンド ---------- */
const $ = q => document.querySelector(q);
const $$ = q => document.querySelectorAll(q);
const pad = n => String(n).padStart(2, '0');
const dbg = (...a) => DEBUG && console.log('[DBG]', ...a);

/* ---------- 状態 ---------- */
let apiKey = localStorage.getItem('oa-key') || '';
let vadE = null;
let rec = false;
let timer, tick, remainMs;
let segs = [];
let queue = [];
let busy = false;
let currentBlob = null;
let mediaRec = null;
let mrChunks = [];
let db;

// --- 追加: 多重実行／多重保存を防ぐフラグ ---
let stopping = false;      // stopRec の二重呼び出し防止
let savedOnce = false;     // onstop の二重発火防止

/* ======================================================
   IndexedDB（履歴）
   ====================================================== */
async function openDB() {
  return new Promise((ok, ng) => {
    const rq = indexedDB.open('whisperDB', 1);
    rq.onupgradeneeded = e => {
      const store = e.target.result.createObjectStore('hist', { keyPath: 'time' });
      store.createIndex('timeIdx', 'time');
    };
    rq.onsuccess = e => { db = e.target.result; ok(); };
    rq.onerror = e => ng(e.target.error);
  });
}
async function getAllHist() {
  await openDB();
  return new Promise(r => {
    const idx = db.transaction('hist', 'readonly').objectStore('hist').index('timeIdx');
    idx.getAll().onsuccess = e => r(e.target.result.reverse());
  });
}
async function putHist(obj) {
  await openDB();
  const store = db.transaction('hist', 'readwrite').objectStore('hist');
  store.put(obj);
  store.index('timeIdx').openCursor(null, 'next').onsuccess = e => {
    const c = e.target.result;
    if (!c) return;
    store.count().onsuccess = ev => {
      if (ev.target.result > MAX_HIST) c.delete();
    };
  };
}

/* ======================================================
   録音制御／Whisper 送信
   ====================================================== */
async function startRec() {
  if (!apiKey) { openModal(); return; }
  if (!vadE) {
    vadE = await vad.MicVAD.new({
      noise_threshold: 0.15,
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.3,
      onSpeechEnd: arr => handleChunk(arr)
    });
  }
  queue.length = 0; busy = false; $('#player').src = '';
  rec = true; segs.length = 0; $('#result').innerHTML = '';
  $('#counter').textContent = '';
  const stream = vadE.stream ?? await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  mrChunks = [];
  mediaRec.ondataavailable = e => mrChunks.push(e.data);
  mediaRec.start();

  await vadE.start();
  remainMs = TOTAL_MS;
  timer = setTimeout(stopRec, remainMs);
  tick = setInterval(() => { remainMs -= 1000; $('#counter').textContent = `残り ${Math.floor(remainMs/60000)}:${pad((remainMs/1000)%60)}`; }, 1000);
  updateRecUI();
}
function stopRec() {
  if (stopping) return;   // 多重呼び出しガード
  stopping = true;
  savedOnce = false;

  vadE?.pause();
  vadE?.stream?.getTracks().forEach(t => t.stop());
  clearTimeout(timer); clearInterval(tick);
  rec = false; $('#counter').textContent = ''; updateRecUI();

  mediaRec.onstop = async () => {
    if (savedOnce) return; // onstop 二重発火ガード
    savedOnce = true;
    currentBlob = new Blob(mrChunks, { type: 'audio/webm' });
    await saveHist();
    stopping = false;     // 完了後フラグ解除
  };
  mediaRec.stop();

  // VAD のリセット: 次回録音時に新しいインスタンスを生成
  vadE = null;
}

async function handleChunk(arr) {
  const blob = new Blob([vad.utils.encodeWAV(arr)], { type: 'audio/wav' });
  const dataUrl = await blobToDataURL(blob);
  const idx = appendSeg('…文字起こし中…', dataUrl, true);
  enqueue(blob, dataUrl, idx);
}

function enqueue(file, url, segIdx) { queue.push({ file, url, segIdx }); if (!busy) processQueue(); }
async function processQueue() {
  if (busy) return; busy = true;
  const WAIT = 10, COOL = 300;
  while (queue.length) {
    const job = queue.shift();
    try {
      const fd = new FormData();
      fd.append('file', job.file);
      fd.append('model', 'whisper-1');
      fd.append('language', 'ja');
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: fd
      });
      if (res.status === 429) {
        const w = +(res.headers.get('Retry-After') || WAIT);
        job.backoff = Math.min((job.backoff||w)*2, 60);
        queue.unshift(job);
        await sleep(w*1000);
        continue;
      }
      if (!res.ok) throw new Error(res.status);
      const js = await res.json();
      replaceSeg(job.segIdx, js.text||'(無音)');
    } catch(e) {
      console.error(e);
      replaceSeg(job.segIdx, '【エラー】');
    }
    await sleep(COOL);
  }
  busy = false;
}

/* ======================================================
   UI ヘルパ
   ====================================================== */
function appendSeg(text, audio, loading=false) {
  const d = new Date(), ts=`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const idx = segs.push({ ts, text, audio }) - 1;
  const div = document.createElement('div'); div.className = 'msg'; div.dataset.idx = idx;
  div.innerHTML = `<span class="ts">${ts}</span><div class="txt">${text}</div>`;
  div.onclick = () => playAudio(idx);
  $('#result').append(div);
  if (!loading) $('#result').scrollTop = $('#result').scrollHeight;
  return idx;
}
function replaceSeg(i, text) {
  if (i<0||i>=segs.length) return;
  segs[i].text = text;
  $(`#result .msg[data-idx="${i}"] .txt`).textContent = text;
}
function playAudio(idx) { const a = segs[idx]?.audio; if (!a) return; const pl = $('#player'); pl.dataset.idx = idx; pl.src = a; pl.play(); }
function updateRecUI() {
  const item = $('[data-act="record"]');
  item.querySelector('span').textContent = rec ? '停止' : '文字起こし';
  $('#toggle').classList.toggle('rec-on', rec);
  item.classList.toggle('rec-on', rec);
}

async function summarize() {
  if (!apiKey) { openModal(); return; }
  const txt = $('#result').innerText.trim();
  if (!txt) { alert('文字起こし結果がありません'); return; }
  const btn = $('[data-act="summarize"]'); btn.classList.add('active');
  try {
    const body = { model: 'gpt-4o-mini', temperature: 0.7,
      messages: [{ role: 'system', content: 'タイトル + 箇条書きで日本語要約' },{ role: 'user', content: txt }]
    };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type':'application/json', Authorization:`Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    const summary = (await res.json()).choices?.[0]?.message?.content || '';
    const old = $('.msg.summary'); if(old) old.remove();
    const div = document.createElement('div'); div.className='msg summary';
    div.innerHTML = `<span class="ts">要約</span><div class="txt">${summary}</div>`;
    $('#result').prepend(div);
  } catch(e) { alert('要約失敗'); console.error(e); }
  finally { btn.classList.remove('active'); }
}

function dispatch(act) {
  $$('.menu-item').forEach(m => m.classList.remove('active'));
  $(`[data-act="${act}"]`).classList.add('active');
  switch(act) {
    case 'record': rec ? stopRec() : startRec(); break;
    case 'summarize': summarize(); break;
    case 'download': copyText(); break;
    case 'audio': downloadAudio(); break;
    case 'settings': openModal(); break;
  }
}
function bindUI() {
  $$('.menu-item').forEach(el=> el.onclick = ()=>{dispatch(el.dataset.act); closeSidebar();});
  $('#toggle').onclick = toggleSidebar;
  $('#backdrop').onclick = toggleSidebar;
  $('#saveKey').onclick = ()=>{ apiKey=$('#apiKey').value.trim(); localStorage.setItem('oa-key',apiKey); closeModal(); };
  $('#clearAll').onclick = ()=>{ if(confirm('全履歴を削除しますか？')) clearHist(); };
  $('#player').addEventListener('ended',()=>{
    const cur = +($('#player').dataset.idx||-1), next = cur+1;
    if (next<segs.length) playAudio(next);
  });
}

async function init() {
  await openDB();
  await drawHist();
  const first = $('#histList .hist'); first?.click();
  if (!apiKey) openModal();
  bindUI();
}
init();

// 小さなユーティリティ
const sleep = ms => new Promise(r => setTimeout(r, ms));
const blobToDataURL = blob => new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsDataURL(blob); });

// 履歴表示
async function drawHist() {
  const list = $('#histList');
  list.innerHTML = '';
  const all = await getAllHist();
  all.forEach(h => {
    const li = document.createElement('li');
    li.className = 'hist';
    li.dataset.time = h.time;
    const span = document.createElement('span');
    span.textContent = new Date(h.time).toLocaleString();
    const btn = document.createElement('button');
    btn.className = 'btnDel';
    btn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    btn.onclick = e => { e.stopPropagation(); deleteHist(h.time); };
    li.append(span, btn);
    li.onclick = () => loadHist(h);
    list.append(li);
  });
}

// 保存
async function saveHist() {
  const h = { time: Date.now(), segs, audio: URL.createObjectURL(currentBlob) };
  await putHist(h);
  await drawHist();
}

// 全履歴削除
async function clearHist() {
  await openDB();
  const tx = db.transaction('hist', 'readwrite');
  tx.objectStore('hist').clear();
  await tx.complete;
  await drawHist();
}

// 個別削除
async function deleteHist(time) {
  await openDB();
  const tx = db.transaction('hist', 'readwrite');
  tx.objectStore('hist').delete(time);
  await tx.complete;
  await drawHist();
}

// 履歴読み込み
function loadHist(h) {
  // 表示領域を完全にクリアしてから選択履歴をそのまま描画
  $('#result').innerHTML = '';
  segs = h.segs;                         // 配列は参照だけ差し替え、push しない
  h.segs.forEach((s, i) => {            // 既存データを DOM に描画
    const div = document.createElement('div');
    div.className = 'msg';
    div.dataset.idx = i;
    div.innerHTML = `<span class="ts">${s.ts}</span><div class="txt">${s.text}</div>`;
    div.onclick = () => playAudio(i);
    $('#result').append(div);
  });
  // サイドバーの選択状態を更新
  $$('.hist').forEach(el =>
    el.classList.toggle('selected', +el.dataset.time === h.time)
  );
}

// コピー
function copyText() {
  const txt = $('#result').innerText;
  navigator.clipboard.writeText(txt);
}

// 音声DL
function downloadAudio() {
  if (!currentBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(currentBlob);
  a.download = 'recording.webm';
  a.click();
}

// モーダル
function openModal() { $('#modal').classList.add('open'); }
function closeModal(){ $('#modal').classList.remove('open'); }

// サイドバー
function toggleSidebar() {
  const sb = $('#sidebar');
  if (window.innerWidth <= 768) {
    sb.classList.toggle('open');
    $('#backdrop').classList.toggle('show');
  } else {
    sb.classList.toggle('collapsed');
  }
}
function closeSidebar() {
  if (window.innerWidth <= 768) {
    $('#sidebar').classList.remove('open');
    $('#backdrop').classList.remove('show');
  }
}
