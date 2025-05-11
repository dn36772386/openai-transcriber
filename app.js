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

/* ======================================================
   スライドプロンプト関数（直前300文字）
   ====================================================== */
function buildPrompt(maxLen = 300) {
  const buf = [];
  let total = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    const txt = segs[i]?.text || '';
    if (!txt) continue;
    if (total + txt.length > maxLen) {
      buf.unshift(txt.slice(txt.length - (maxLen - total)));
      break;
    }
    buf.unshift(txt);
    total += txt.length;
    if (total === maxLen) break;
  }
  return buf.join('');
}

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
let cancelRec = false;     // キャンセル時は保存しない
let isManual  = false;     // モード状態（true=manual）

/* ======================================================
   モードトグル表示 (auto / manual)
   ====================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const modeTgl   = $('#modeToggle');
  const modeLabel = $('#modeLabel');
  if (!modeTgl || !modeLabel) return;
  const upd = () => {
    isManual = modeTgl.checked;
    modeLabel.textContent = isManual ? 'manual' : 'auto';
  };
  upd();
  modeTgl.addEventListener('change', upd);

  /* 一行コピー機能 */
  const result = $('#result');
  if (result) {
    // click や touchstart 両方をハンドリング
    const copyLine = async e => {
      // どちらを押しても .msg 全体に遡る
      const msg = e.target.closest('.msg');
      if (!msg) return;
      // タイムスタンプを除き .txt 要素だけコピー
      const txt = msg.querySelector('.txt')?.innerText || '';
      await copyToClipboard(txt);                // iOS 対応版
      msg.classList.add('copied');             // 背景色を変える
      setTimeout(() => msg.classList.remove('copied'), 800);
    };
    result.addEventListener('click', copyLine, { capture: true });
    result.addEventListener('touchstart', copyLine, { passive: true });
  }
});

/* ---------- クリップボード共通関数 ---------- */
async function copyToClipboard(text){
  try{
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(text);
      return true;
    }
  }catch(e){/* fallthrough */ }
  /* フォールバック（iOS Safari 等）*/
  const ta=document.createElement('textarea');
  ta.value=text;
  ta.style.position='fixed';
  ta.style.opacity='0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try{ document.execCommand('copy'); }catch{}
  document.body.removeChild(ta);
  return true;
}

/* 待機ヘルパ：キューが空になるまで待つ */
const waitQueue = async () => {
  while (busy || queue.length) await sleep(200);
};

/* ======================================================
   ヘッダの録音制御ボタン表示を更新（マイク⇔✅❌）
   ====================================================== */
function updateHeaderButtons(){
  const recBtn  = $('#recordBtn');
  const finBtn  = $('#finishBtn');
  const canBtn  = $('#cancelBtn');
  if (!recBtn || !finBtn || !canBtn) return;
  recBtn.hidden   = rec;
  finBtn.hidden   = canBtn.hidden = !rec;
  recBtn.disabled = rec;
}

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
  if (!isManual && !vadE) {               // manual では無音検知しない
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
  const stream = vadE?.stream ?? await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  mrChunks = [];
  mediaRec.ondataavailable = e => mrChunks.push(e.data);
  mediaRec.start();

  if (!isManual) await vadE.start();      // manual では起動しない
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

    /* ── ここで残りの音声全文を文字起こしへ送信 ── */
    if (!cancelRec) {
      const url = URL.createObjectURL(currentBlob);
      const idx = appendSeg('…文字起こし中…', url, true);
      enqueue(currentBlob, url, idx);        // 最後の塊を Whisper へ
      await waitQueue();                     // キュー処理が終わるまで待機
      await saveHist();                      // 文字起こし反映後に履歴保存
    } else {
      // キャンセル時は結果・履歴とも破棄
      segs.length = 0;
      $('#result').innerHTML = '';
      cancelRec = false;
    }
    stopping = false;                 // 完了後フラグ解除
    updateHeaderButtons();            // 停止後にヘッダ復帰
  };
  mediaRec.stop();

  // VAD のリセット: 次回録音時に新しいインスタンスを生成
  vadE = null;
}

async function handleChunk(arr) {
  if (isManual) return;           // manual モードではスキップ
  const blob = new Blob([vad.utils.encodeWAV(arr)], { type: 'audio/wav' });
  const dataUrl = await blobToDataURL(blob);
  const idx = appendSeg('…文字起こし中…', dataUrl, true);
  enqueue(blob, dataUrl, idx);
}

function enqueue(file, url, segIdx) {
  queue.push({ file, url, segIdx }); // enqueue with explicit fname below
  if (!busy) processQueue();
}
async function processQueue() {
  if (busy) return; busy = true;
  const WAIT = 10, COOL = 300;
  while (queue.length) {
    const job = queue.shift();
    try {
      const fd = new FormData();
      const fname = job.file.type.includes('wav') ? 'audio.wav' : 'audio.webm';
      fd.append('file', job.file, fname);           // ファイル名を明示 ★
      fd.append('model', 'whisper-1');
      fd.append('language', 'ja');
      /* ← ここで直近300文字の文脈を添付 */
      fd.append('prompt', buildPrompt());
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
   新規セッション（文字起こしメニューで呼び出し）
   ====================================================== */
function newSession(){
  if (rec) stopRec();          // 録音中なら停止
  segs.length = 0;
  queue.length = 0;
  $('#result').innerHTML = '';
  $('#player').src = '';
  currentBlob = null;
  cancelRec = false;
  updateRecUI();
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
  updateHeaderButtons();                        // アイコン同期
}

async function proofread() {
  if (!apiKey) { openModal(); return; }

  // segs 配列を [ts] text 形式にまとめる
  const lines = segs.map(s => `[${s.ts}] ${s.text}`).join('\n');
  if (!lines.trim()) { alert('文字起こし結果がありません'); return; }

  const btn = $('[data-act="proofread"]');
  btn.classList.add('active');

  try {
    const body = {
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            `あなたは日本語の文字起こし校正アシスタントです。
前後の文脈を考慮し、誤認識された単語を正しい語に置き換えます。
タイムスタンプ([HH:MM:SS])は変更せず、次の JSON 配列だけを返してください。
例:
[
  {"ts":"00:00:01","text":"修正後の文"},
  ...
]`
        },
        { role: 'user', content: lines }
      ]
    };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });

    const reply = (await res.json()).choices?.[0]?.message?.content || '[]';
    let arr;
    try {
      arr = JSON.parse(reply);          // GPT が純粋な JSON を返した場合
    } catch {
      // 万一 ```json … ``` で返ってきた場合でも括弧内を抜き出す
      const m = reply.match(/\[([\s\S]*)\]/);
      arr = m ? JSON.parse(`[
${m[1]}
]`) : [];
    }

    // segs と DOM を更新
    arr.forEach(({ ts, text }) => {
      const i = segs.findIndex(s => s.ts === ts);
      if (i !== -1 && text) replaceSeg(i, text.trim());
    });

  } catch (e) {
    console.error(e);
    alert('校正失敗');
  } finally {
    btn.classList.remove('active');
  }
}

function dispatch(act) {
  $$('.menu-item').forEach(m => m.classList.remove('active'));
  $(`[data-act="${act}"]`).classList.add('active');
  switch(act) {
    case 'record':
      if (rec) stopRec(); else newSession();
      break;
    case 'proofread': proofread(); break;
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

// ------- DOMContentLoaded で UI 要素を安全に取得 -------
document.addEventListener('DOMContentLoaded', () => {
  /* ==== ページリロード時に完全初期化 ==== */
  newSession();                               // 画面／配列／Queue をクリア
  $('#result').scrollTop = 0;
  updateHeaderButtons();                      // ヘッダ状態を初期化

  const recordBtn = document.getElementById('recordBtn');
  const finishBtn = document.getElementById('finishBtn');
  const cancelBtn = document.getElementById('cancelBtn');

  /* ── サイドバー「文字起こし」 ── */
  document.querySelector('[data-act="record"]')
    ?.addEventListener('click', () => newSession());

  /* ── ヘッダ録音制御 ── */
  recordBtn?.addEventListener('click', () => { rec ? stopRec() : startRec(); updateHeaderButtons(); });
  finishBtn?.addEventListener('click', () => { if (rec) stopRec(); updateHeaderButtons(); });
  cancelBtn?.addEventListener('click', () => { if (rec) { cancelRec=true; stopRec(); } updateHeaderButtons(); });

  updateHeaderButtons();   // 初期描画

  // PWA Service Worker 更新監視
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('[SW] registered', reg.scope))
      .catch(err => console.error('[SW] register failed', err));

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // 新しい SW が制御権を握ったら 1 回だけリロード
      if (window._swRld) return;
      window._swRld = true;
      location.reload();
    });

    // sw.js が activate で postMessage('sw-updated') を送ってくる
    navigator.serviceWorker.addEventListener('message', evt => {
      if (evt.data === 'sw-updated') {
        console.log('[SW] updated – reloading');
        navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage('skipWaiting');
      }
    });
  }
});

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
  copyToClipboard(txt);
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
