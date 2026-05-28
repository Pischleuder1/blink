![Logo](admin/blink.png)
# ioBroker.blink

[![NPM version](https://img.shields.io/npm/v/iobroker.blink.svg)](https://www.npmjs.com/package/iobroker.blink)
[![Downloads](https://img.shields.io/npm/dm/iobroker.blink.svg)](https://www.npmjs.com/package/iobroker.blink)
![Number of Installations](https://iobroker.live/badges/blink-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/blink-stable.svg)



## blink adapter for ioBroker

ioBroker adapter for Blink cameras.

## Getting started

Install via the ioBroker Admin interface
-----------------------------------------------------------------------------------------
Fill out your credentials:
<img width="2356" height="880" alt="image" src="https://github.com/user-attachments/assets/cdc22784-309f-4514-bfe4-abb93625958c" />
-----------------------------------------------------------------------------------------
<img width="2364" height="1044" alt="image" src="https://github.com/user-attachments/assets/fc9e9a79-f512-4675-b0f0-e6a998a91894" />
-----------------------------------------------------------------------------------------
<img width="2520" height="1206" alt="image" src="https://github.com/user-attachments/assets/c55dfce4-7aa4-4e16-ac2f-c41a7e360726" />


## Developer manual

## Features

- Connects to the Blink Cloud
- Polls camera and sync module status
- Supports manual snapshots
- Stores live snapshots
- Downloads the latest available cloud video
- Allows enabling or disabling motion detection
- Supports battery warning states and notifications
- Supports optional MJPEG streaming (stream is out of a range of pictures, no live stream)
- Supports Smart Detection states for classified motion events (works only on paid cloud services)
- Supports cloud stored videos and local stored videos on sd-card (SyncModule 2 and XR) via local server on port 8085 - JavaScript needed, see below !
- The script requires ffmpeg installed and a lot resources and is only partially suitable for Raspberry Pis (min. 4GB — more is better)

<details>
<summary>press here to see the Script</summary>

```javascript
// ============================================================
// Blink Multi-Camera Server + Widget
//   http://<host>:8085/                  → Single + 10-Slot History darunter
//   http://<host>:8085/?camera=548730    → Single für eine fixe Kamera
//   http://<host>:8085/grid              → Alle Kameras im Grid (mit History-Blättern)
//   http://<host>:8085/history?camera=ID → Reine History-Ansicht, 10 Slots in Reihe
//   http://<host>:8085/blink/<file>      → Video-Datei
//   http://<host>:8085/cameras           → JSON mit allen Kameras (inkl. History-Datenpunkten)
// ============================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ============= KONFIGURATION =============
const PORT          = 8085;
const ROOT_DIR      = '/opt/iobroker/iobroker-data/blink';
const VIDEO_BASE    = '/blink/';
const CAMERA_PREFIX = 'blink.0.cameras.';
const VIDEO_STATE   = '.video.file';
const NAME_STATE    = '.info.name';
const TS_STATE      = '.video.timestamp';
const READY_STATE   = '.video.ready';
const ERROR_STATE   = '.video.lastError';
const HISTORY_SIZE  = 10;
const IOBROKER_PORT = 8082;
// =========================================

if (typeof globalThis.__blinkServer !== 'undefined') {
    try { globalThis.__blinkServer.close(); log('Vorherigen Blink-Server gestoppt'); }
    catch (e) { /* ignore */ }
}

// ---------- Kameras automatisch entdecken ----------
function discoverCameras() {
    return new Promise((resolve) => {
        const cams = [];
        const seen = new Set();
        $(`state[id=${CAMERA_PREFIX}*${NAME_STATE}]`).each((id) => {
            const rest = id.slice(CAMERA_PREFIX.length);
            const camId = rest.split('.')[0];
            if (!seen.has(camId)) {
                seen.add(camId);
                const history = [];
                for (let i = 0; i < HISTORY_SIZE; i++) {
                    history.push({
                        slot: i,
                        file_datapoint:      `${CAMERA_PREFIX}${camId}.video.history.${i}.file`,
                        timestamp_datapoint: `${CAMERA_PREFIX}${camId}.video.history.${i}.timestamp`,
                        id_datapoint:        `${CAMERA_PREFIX}${camId}.video.history.${i}.id`,
                        source_datapoint:    `${CAMERA_PREFIX}${camId}.video.history.${i}.source`
                    });
                }
                cams.push({
                    id: camId,
                    datapoint:       CAMERA_PREFIX + camId + VIDEO_STATE,
                    ts_datapoint:    CAMERA_PREFIX + camId + TS_STATE,
                    ready_datapoint: CAMERA_PREFIX + camId + READY_STATE,
                    error_datapoint: CAMERA_PREFIX + camId + ERROR_STATE,
                    history: history,
                    name: null
                });
            }
        });
        const promises = cams.map(c => new Promise((res) => {
            const nameDp = CAMERA_PREFIX + c.id + NAME_STATE;
            getState(nameDp, (err, st) => {
                if (!err && st && st.val) c.name = String(st.val).trim();
                res();
            });
        }));
        Promise.all(promises).then(() => resolve(cams.sort((a, b) =>
            (a.name || a.id).localeCompare(b.name || b.id)
        )));
    });
}

// ============================================================
// Gemeinsamer JS-Helper-Code
// ============================================================
const COMMON_JS = `
const VIDEO_PREFIX = location.protocol + '//' + location.hostname + ':__VIDEO_PORT__' + '__VIDEO_BASE__';
const IOBROKER_URL = location.protocol + '//' + location.hostname + ':__IOBROKER_PORT__';
const HISTORY_SIZE = __HISTORY_SIZE__;

function buildUrl(v, ts) {
  if (!v) return null;
  if (/^https?:\\/\\//.test(v)) return v;
  const fn = encodeURIComponent(String(v).split('/').pop());
  return VIDEO_PREFIX + fn + '?t=' + (ts || Date.now());
}
function tsFromName(n) {
  const m = n && n.match(/(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})/);
  return m ? \`\${m[1]} \${m[2]}:\${m[3]}:\${m[4]}\` : null;
}
function formatTs(isoOrMs) {
  if (!isoOrMs) return '';
  const d = new Date(isoOrMs);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
function relativeTime(ms) {
  if (!ms) return '';
  const diff = Math.max(0, Date.now() - (typeof ms === 'string' ? new Date(ms).getTime() : ms));
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'gerade eben';
  const min = Math.floor(sec / 60);
  if (min < 60) return 'vor ' + min + ' Min';
  const h = Math.floor(min / 60);
  if (h < 24) return 'vor ' + h + ' Std';
  const d = Math.floor(h / 24);
  if (d < 30) return 'vor ' + d + ' Tag' + (d===1?'':'en');
  return new Date(ms).toLocaleDateString('de-DE');
}

function isVideoValid(value, ready, lastError) {
  if (!value) return false;
  if (lastError && String(lastError).trim() !== '' && String(lastError).toLowerCase() !== 'null') return false;
  if (ready === false) return false;
  return true;
}
`;

// ============================================================
// Widget 1: Single + History-Streifen darunter
// ============================================================
const WIDGET_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blink Video Player</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/2.3.0/socket.io.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background:#1a1a1a; color:#eee; font-family:-apple-system,system-ui,sans-serif;
       min-height:100vh; display:flex; flex-direction:column; align-items:center; padding:16px; }
.container { width:100%; max-width:900px; background:#2a2a2a; border-radius:12px;
             overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.4); }
.header { padding:12px 16px; background:#333; display:flex; justify-content:space-between;
          align-items:center; gap:12px; border-bottom:1px solid #444; flex-wrap:wrap; }
.title { font-size:14px; font-weight:600; flex:1; min-width:0;
         overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.status { font-size:11px; padding:3px 8px; border-radius:10px; background:#555; flex-shrink:0; }
.status.ok { background:#2d6a3e; }
.status.err { background:#8b2d2d; }
select { background:#444; color:#eee; border:1px solid #555; padding:5px 8px;
         border-radius:6px; font-size:12px; max-width:200px; }
video { width:100%; display:block; background:#000; max-height:600px; }
.info { padding:12px 16px; font-size:12px; color:#999; word-break:break-all;
        border-top:1px solid #444; }
.info .ts { color:#ccc; font-weight:500; margin-bottom:4px; }
.info .err { color:#e88; font-weight:500; }
.info .source { display:inline-block; padding:2px 6px; border-radius:4px;
                font-size:10px; background:#444; margin-left:6px; vertical-align:middle; }
.info .source.cloud { background:#2d4a6a; }
.info .source.local_storage { background:#4a3a2d; }
.empty { padding:60px 20px; text-align:center; color:#777; }
.empty .err-msg { color:#e88; font-size:13px; margin-top:8px; }
.controls { padding:8px 16px; border-top:1px solid #444; display:flex; gap:8px;
            justify-content:space-between; align-items:center; }
.relative-ts { font-size:12px; color:#aaa; }
button { background:#444; color:#eee; border:none; padding:6px 12px; border-radius:6px;
         font-size:12px; cursor:pointer; }
button:hover { background:#555; }

/* History-Streifen */
.history-section { border-top:1px solid #444; padding:12px 16px; background:#252525; }
.history-section h3 { font-size:12px; color:#999; margin-bottom:8px; font-weight:500; }
.history-strip { display:flex; gap:6px; overflow-x:auto; padding-bottom:4px; }
.history-strip::-webkit-scrollbar { height:6px; }
.history-strip::-webkit-scrollbar-thumb { background:#555; border-radius:3px; }
.hslot { flex:0 0 130px; background:#1a1a1a; border-radius:6px; cursor:pointer;
         border:2px solid transparent; transition:border-color 0.15s, transform 0.15s; }
.hslot:hover { border-color:#666; transform:translateY(-2px); }
.hslot.active { border-color:#4a8; }
.hslot.empty { opacity:0.3; cursor:not-allowed; }
.hslot-thumb { position:relative; aspect-ratio:16/9; background:#000; border-radius:4px 4px 0 0;
               overflow:hidden; }
.hslot-thumb video { width:100%; height:100%; object-fit:cover; pointer-events:none; }
.hslot-thumb .badge { position:absolute; top:4px; left:4px; background:rgba(0,0,0,0.7);
                     color:white; padding:1px 5px; border-radius:3px; font-size:10px; }
.hslot-info { padding:4px 6px; font-size:10px; color:#aaa; line-height:1.3; }
.hslot-info .time { color:#ddd; font-weight:500; }
.hslot-info .src { font-size:9px; color:#888; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <span class="title" id="title">📹 Blink</span>
    <select id="picker" style="display:none"></select>
    <span class="status" id="status">Verbinde…</span>
  </div>
  <div id="player"><div class="empty">Lade Kameras…</div></div>
  <div class="info" id="info"></div>
  <div class="controls">
    <span class="relative-ts" id="reltime"></span>
    <button id="reload">🔄 Neu laden</button>
  </div>

  <div class="history-section" id="history-section" style="display:none">
    <h3>📚 Verlauf (10 neueste)</h3>
    <div class="history-strip" id="history-strip"></div>
  </div>
</div>
<script>
__COMMON_JS__

const params  = new URLSearchParams(location.search);
const fixedCamera = params.get('camera');
const $title  = document.getElementById('title');
const $status = document.getElementById('status');
const $player = document.getElementById('player');
const $info   = document.getElementById('info');
const $reload = document.getElementById('reload');
const $picker = document.getElementById('picker');
const $reltime = document.getElementById('reltime');
const $histSection = document.getElementById('history-section');
const $histStrip = document.getElementById('history-strip');

let socket, currentCam = null, cameras = [];
let curValue = null, curTs = null, curReady = null, curError = null;
// History-State pro Kamera-Wechsel neu aufgebaut
let histSlots = []; // [{file, timestamp, id, source}, ...]
let manualPick = null; // null = aktuellen Live-Clip zeigen, sonst Slot-Index

function setStatus(t, c) { $status.textContent = t; $status.className = 'status' + (c?' '+c:''); }
function updateRelativeTime() { $reltime.textContent = curTs ? relativeTime(curTs) : ''; }

function renderEmpty(msg, errMsg) {
  let html = '<div class="empty">' + msg;
  if (errMsg) html += '<div class="err-msg">⚠ ' + errMsg + '</div>';
  html += '</div>';
  $player.innerHTML = html;
  $info.textContent = '';
}

function renderCurrent() {
  updateRelativeTime();

  // Wenn manuell ein History-Slot gewählt, den dort gezeigten Clip verwenden
  let showFile, showTs, showSource, showInfo;
  if (manualPick !== null && histSlots[manualPick] && histSlots[manualPick].file) {
    const s = histSlots[manualPick];
    showFile = s.file;
    showTs = s.timestamp;
    showSource = s.source;
    showInfo = 'Slot ' + manualPick;
  } else if (isVideoValid(curValue, curReady, curError)) {
    showFile = curValue;
    showTs = curTs;
    showSource = null;
    showInfo = 'Live';
  } else {
    const errText = curError && String(curError).trim() && String(curError).toLowerCase() !== 'null'
      ? String(curError) : null;
    renderEmpty('Kein aktuelles Video', errText);
    refreshHistoryStrip();
    return;
  }

  const url = buildUrl(showFile, showTs);
  if (!url) { renderEmpty('Kein Video verfügbar'); return; }

  const fn = String(showFile).split('/').pop();

  $player.innerHTML = '';
  const video = document.createElement('video');
  video.controls = true;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  const source = document.createElement('source');
  source.setAttribute('src', url);
  source.setAttribute('type', 'video/mp4');
  video.appendChild(source);
  $player.appendChild(video);
  video.load();

  const ts = formatTs(showTs);
  let infoHtml = '<div class="ts">🕒 ' + (ts || '—') + ' · ' + showInfo;
  if (showSource) {
    infoHtml += '<span class="source ' + showSource + '">' + showSource + '</span>';
  }
  infoHtml += '</div><div>' + fn + '</div>';
  $info.innerHTML = infoHtml;

  refreshHistoryStrip();
}

function refreshHistoryStrip() {
  $histSection.style.display = '';
  $histStrip.innerHTML = '';
  for (let i = 0; i < HISTORY_SIZE; i++) {
    const s = histSlots[i] || {};
    const slot = document.createElement('div');
    slot.className = 'hslot' + (s.file ? '' : ' empty') + (manualPick === i ? ' active' : '');
    slot.dataset.slot = i;

    const thumb = document.createElement('div');
    thumb.className = 'hslot-thumb';
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = '#' + i;
    thumb.appendChild(badge);

    if (s.file) {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      const sourceEl = document.createElement('source');
      sourceEl.setAttribute('src', buildUrl(s.file, s.timestamp));
      sourceEl.setAttribute('type', 'video/mp4');
      v.appendChild(sourceEl);
      thumb.appendChild(v);
    }

    const inf = document.createElement('div');
    inf.className = 'hslot-info';
    const t = document.createElement('div');
    t.className = 'time';
    t.textContent = s.timestamp ? formatTs(s.timestamp).replace(/, \\d{4}/, '') : '—';
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = s.source || (s.file ? '' : 'leer');
    inf.appendChild(t);
    inf.appendChild(src);

    slot.appendChild(thumb);
    slot.appendChild(inf);

    if (s.file) {
      slot.addEventListener('click', () => {
        manualPick = (manualPick === i) ? null : i;
        renderCurrent();
      });
    }
    $histStrip.appendChild(slot);
  }
}

$reload.addEventListener('click', () => { manualPick = null; renderCurrent(); });
setInterval(updateRelativeTime, 30000);

function unsubscribeCurrent() {
  if (!currentCam || !socket) return;
  socket.emit('unsubscribe', currentCam.datapoint);
  socket.emit('unsubscribe', currentCam.ts_datapoint);
  socket.emit('unsubscribe', currentCam.ready_datapoint);
  socket.emit('unsubscribe', currentCam.error_datapoint);
  currentCam.history.forEach(h => {
    socket.emit('unsubscribe', h.file_datapoint);
    socket.emit('unsubscribe', h.timestamp_datapoint);
    socket.emit('unsubscribe', h.id_datapoint);
    socket.emit('unsubscribe', h.source_datapoint);
  });
}

function switchCamera(cam) {
  unsubscribeCurrent();
  currentCam = cam;
  manualPick = null;
  histSlots = new Array(HISTORY_SIZE).fill(null).map(() => ({}));
  $title.textContent = '📹 ' + (cam.name || 'Kamera ' + cam.id);
  $player.innerHTML = '<div class="empty">Lade Video…</div>';
  $info.textContent = '';
  curValue = null; curTs = null; curReady = null; curError = null;
  updateRelativeTime();

  // Live-States: 4 parallel
  let pending = 4 + 4 * HISTORY_SIZE;
  const done = () => { if (--pending === 0) renderCurrent(); };

  socket.emit('getState', cam.ts_datapoint, (e, st) => {
    if (st && st.val) curTs = st.val;
    done();
  });
  socket.emit('getState', cam.ready_datapoint, (e, st) => {
    if (st) curReady = st.val;
    done();
  });
  socket.emit('getState', cam.error_datapoint, (e, st) => {
    if (st) curError = st.val;
    done();
  });
  socket.emit('getState', cam.datapoint, (e, st) => {
    if (st) curValue = st.val;
    done();
  });

  socket.emit('subscribe', cam.datapoint);
  socket.emit('subscribe', cam.ts_datapoint);
  socket.emit('subscribe', cam.ready_datapoint);
  socket.emit('subscribe', cam.error_datapoint);

  // History-States: 10 Slots × 4 Felder
  cam.history.forEach((h, idx) => {
    socket.emit('getState', h.file_datapoint, (e, st) => {
      histSlots[idx].file = st ? st.val : null; done();
    });
    socket.emit('getState', h.timestamp_datapoint, (e, st) => {
      histSlots[idx].timestamp = st ? st.val : null; done();
    });
    socket.emit('getState', h.id_datapoint, (e, st) => {
      histSlots[idx].id = st ? st.val : null; done();
    });
    socket.emit('getState', h.source_datapoint, (e, st) => {
      histSlots[idx].source = st ? st.val : null; done();
    });
    socket.emit('subscribe', h.file_datapoint);
    socket.emit('subscribe', h.timestamp_datapoint);
    socket.emit('subscribe', h.id_datapoint);
    socket.emit('subscribe', h.source_datapoint);
  });
}

fetch('/cameras').then(r => r.json()).then(list => {
  cameras = list;
  if (!cameras.length) {
    setStatus('Keine Kameras', 'err');
    $player.innerHTML = '<div class="empty">Keine Kameras gefunden</div>';
    return;
  }
  if (fixedCamera) {
    const cam = cameras.find(c => c.id === fixedCamera);
    if (!cam) {
      setStatus('Unbekannt', 'err');
      $player.innerHTML = '<div class="empty">Kamera ' + fixedCamera + ' nicht gefunden</div>';
      return;
    }
    connectAndStart(cam);
  } else {
    $picker.style.display = '';
    cameras.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name || ('Kamera ' + c.id);
      $picker.appendChild(o);
    });
    $picker.addEventListener('change', () => {
      const cam = cameras.find(c => c.id === $picker.value);
      if (cam) switchCamera(cam);
    });
    connectAndStart(cameras[0]);
  }
}).catch(e => { setStatus('Server-Fehler', 'err'); console.error(e); });

function findHistorySlot(id) {
  if (!currentCam) return -1;
  return currentCam.history.findIndex(h =>
    id === h.file_datapoint || id === h.timestamp_datapoint ||
    id === h.id_datapoint || id === h.source_datapoint);
}

function connectAndStart(cam) {
  if (typeof io === 'undefined') { setStatus('Socket.IO Lib fehlt', 'err'); return; }
  socket = io(IOBROKER_URL, { transports: ['websocket', 'polling'] });
  socket.on('connect', () => { setStatus('Verbunden', 'ok'); switchCamera(cam); });
  socket.on('disconnect',    () => setStatus('Getrennt', 'err'));
  socket.on('connect_error', (e) => { setStatus('Verbindungsfehler', 'err'); console.error(e); });
  socket.on('stateChange', (id, state) => {
    if (!state || !currentCam) return;
    if (id === currentCam.datapoint)        { curValue = state.val; renderCurrent(); return; }
    if (id === currentCam.ts_datapoint)     { if (state.val) curTs = state.val; renderCurrent(); return; }
    if (id === currentCam.ready_datapoint)  { curReady = state.val; renderCurrent(); return; }
    if (id === currentCam.error_datapoint)  { curError = state.val; renderCurrent(); return; }

    const slot = findHistorySlot(id);
    if (slot >= 0) {
      const h = currentCam.history[slot];
      if (id === h.file_datapoint)      histSlots[slot].file = state.val;
      else if (id === h.timestamp_datapoint) histSlots[slot].timestamp = state.val;
      else if (id === h.id_datapoint)        histSlots[slot].id = state.val;
      else if (id === h.source_datapoint)    histSlots[slot].source = state.val;
      refreshHistoryStrip();
    }
  });
}
</script>
</body>
</html>`;

// ============================================================
// Widget 2: Grid (alle Kameras, History per Klick durchblättern)
// ============================================================
const GRID_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blink Cameras</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/2.3.0/socket.io.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background:#1a1a1a; color:#eee; font-family:-apple-system,system-ui,sans-serif;
       min-height:100vh; padding:12px; }
.topbar { display:flex; justify-content:space-between; align-items:center;
          padding:0 4px 12px; gap:12px; }
.topbar .title { font-size:14px; font-weight:600; }
.status { font-size:11px; padding:3px 8px; border-radius:10px; background:#555; }
.status.ok { background:#2d6a3e; }
.status.err { background:#8b2d2d; }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr));
        gap:12px; }
.cam { background:#2a2a2a; border-radius:10px; overflow:hidden;
       box-shadow:0 2px 6px rgba(0,0,0,0.3); display:flex; flex-direction:column; }
.cam-head { padding:8px 12px; background:#333; display:flex;
            justify-content:space-between; align-items:center; gap:8px; }
.cam-name { font-size:13px; font-weight:600; flex:1; min-width:0;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cam-time { font-size:11px; color:#aaa; flex-shrink:0; }
.cam-content { display:block; position:relative; }
.cam-video-wrap { position:relative; background:#000; aspect-ratio:16/9; cursor:pointer; }
.cam-video-wrap video { width:100%; height:100%; display:block; object-fit:cover; }
.cam-video-wrap .overlay { position:absolute; inset:0; display:flex;
                          align-items:center; justify-content:center; pointer-events:none;
                          background:rgba(0,0,0,0.25); transition:opacity 0.2s; }
.cam-video-wrap.playing .overlay { opacity:0; }
.cam-video-wrap .play-btn {
  width:56px; height:56px; border-radius:50%;
  background:rgba(0,0,0,0.6); border:2px solid rgba(255,255,255,0.8);
  display:flex; align-items:center; justify-content:center;
}
.cam-video-wrap .play-btn::after {
  content:''; width:0; height:0; margin-left:4px;
  border-top:10px solid transparent; border-bottom:10px solid transparent;
  border-left:16px solid white;
}
.cam-video-wrap .slot-badge {
  position:absolute; top:6px; left:6px;
  background:rgba(0,0,0,0.7); color:white;
  padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500;
  pointer-events:none;
}
.cam-empty { aspect-ratio:16/9; display:flex; flex-direction:column;
             align-items:center; justify-content:center; gap:6px;
             color:#888; font-size:13px; background:#1a1a1a; padding:8px; text-align:center; }
.cam-empty .err-msg { color:#e88; font-size:11px; }

/* History-Navigation */
.cam-nav { display:flex; align-items:center; justify-content:space-between;
           padding:6px 8px; background:#222; gap:6px; }
.cam-nav button { background:#444; color:#eee; border:none;
                  padding:4px 10px; border-radius:4px; font-size:11px; cursor:pointer; }
.cam-nav button:hover { background:#555; }
.cam-nav button:disabled { opacity:0.4; cursor:not-allowed; }
.cam-nav .label { font-size:11px; color:#bbb; flex:1; text-align:center;
                  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cam-nav .label .source { font-size:9px; padding:1px 4px; border-radius:3px;
                          background:#444; margin-left:4px; vertical-align:middle; }
.cam-nav .label .source.cloud { background:#2d4a6a; }
.cam-nav .label .source.local_storage { background:#4a3a2d; }
</style>
</head>
<body>
<div class="topbar">
  <span class="title">📹 Blink Kameras</span>
  <span class="status" id="status">Verbinde…</span>
</div>
<div class="grid" id="grid"></div>
<script>
__COMMON_JS__

const $status = document.getElementById('status');
const $grid   = document.getElementById('grid');

let socket;
const cards = {};   // camId → {value, ts, ready, error, hist[], pickIdx, root, contentHost, ...}

function setStatus(t, c) { $status.textContent = t; $status.className = 'status' + (c?' '+c:''); }

function buildCard(cam) {
  const card = document.createElement('div');
  card.className = 'cam';
  card.dataset.cam = cam.id;

  const head = document.createElement('div');
  head.className = 'cam-head';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'cam-name';
  nameSpan.textContent = cam.name || ('Kamera ' + cam.id);
  const timeSpan = document.createElement('span');
  timeSpan.className = 'cam-time';
  head.appendChild(nameSpan);
  head.appendChild(timeSpan);

  const contentHost = document.createElement('div');
  contentHost.className = 'cam-content';

  const empty = document.createElement('div');
  empty.className = 'cam-empty';
  empty.textContent = 'Lade…';
  contentHost.appendChild(empty);

  // History-Navigation
  const nav = document.createElement('div');
  nav.className = 'cam-nav';
  const prevBtn = document.createElement('button');
  prevBtn.textContent = '◀';
  prevBtn.title = 'Älterer Clip';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'Live';
  const nextBtn = document.createElement('button');
  nextBtn.textContent = '▶';
  nextBtn.title = 'Neuerer Clip';
  const liveBtn = document.createElement('button');
  liveBtn.textContent = '⏺ Live';
  liveBtn.title = 'Live-Ansicht';
  nav.appendChild(prevBtn);
  nav.appendChild(label);
  nav.appendChild(liveBtn);
  nav.appendChild(nextBtn);

  card.appendChild(head);
  card.appendChild(contentHost);
  card.appendChild(nav);
  $grid.appendChild(card);

  cards[cam.id] = {
    value: null, ts: null, ready: null, error: null,
    hist: new Array(HISTORY_SIZE).fill(null).map(() => ({})),
    pickIdx: null,  // null = Live, 0..9 = History-Slot
    root: card, contentHost: contentHost, timeEl: timeSpan,
    prevBtn, nextBtn, liveBtn, label,
    datapoint:       cam.datapoint,
    ts_datapoint:    cam.ts_datapoint,
    ready_datapoint: cam.ready_datapoint,
    error_datapoint: cam.error_datapoint,
    history:         cam.history,
    name: cam.name || ('Kamera ' + cam.id)
  };

  prevBtn.addEventListener('click', () => navigate(cam.id, +1));
  nextBtn.addEventListener('click', () => navigate(cam.id, -1));
  liveBtn.addEventListener('click', () => { cards[cam.id].pickIdx = null; renderCard(cam.id); });
}

function navigate(camId, delta) {
  const c = cards[camId];
  if (!c) return;
  let next = c.pickIdx == null ? 0 : c.pickIdx + delta;
  if (next < 0) { c.pickIdx = null; renderCard(camId); return; }
  if (next >= HISTORY_SIZE) next = HISTORY_SIZE - 1;
  // Suche nächsten Slot mit Datei
  while (next >= 0 && next < HISTORY_SIZE && !c.hist[next].file) next += delta;
  if (next >= 0 && next < HISTORY_SIZE) {
    c.pickIdx = next;
  } else {
    c.pickIdx = null;
  }
  renderCard(camId);
}

function setEmpty(c, text, errMsg) {
  while (c.contentHost.firstChild) c.contentHost.removeChild(c.contentHost.firstChild);
  const empty = document.createElement('div');
  empty.className = 'cam-empty';
  const main = document.createElement('div');
  main.textContent = text;
  empty.appendChild(main);
  if (errMsg) {
    const sub = document.createElement('div');
    sub.className = 'err-msg';
    sub.textContent = '⚠ ' + errMsg;
    empty.appendChild(sub);
  }
  c.contentHost.appendChild(empty);
}

function renderCard(camId) {
  const c = cards[camId];
  if (!c) return;

  if (c.timeEl) c.timeEl.textContent = c.ts ? relativeTime(c.ts) : '';

  let showFile, showTs, showSource, slotLabel;
  if (c.pickIdx !== null && c.hist[c.pickIdx] && c.hist[c.pickIdx].file) {
    const h = c.hist[c.pickIdx];
    showFile = h.file;
    showTs = h.timestamp;
    showSource = h.source;
    slotLabel = '#' + c.pickIdx;
  } else if (isVideoValid(c.value, c.ready, c.error)) {
    showFile = c.value;
    showTs = c.ts;
    showSource = null;
    slotLabel = null; // Live
    c.pickIdx = null;
  } else {
    const errText = c.error && String(c.error).trim() && String(c.error).toLowerCase() !== 'null'
      ? String(c.error) : null;
    setEmpty(c, 'Kein aktuelles Video', errText);
    updateNav(c);
    return;
  }

  const url = buildUrl(showFile, showTs);
  if (!url) { setEmpty(c, 'Kein Video'); updateNav(c); return; }

  const wrap = document.createElement('div');
  wrap.className = 'cam-video-wrap';
  wrap.dataset.cam = camId;

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.dataset.cam = camId;

  const source = document.createElement('source');
  source.setAttribute('src', url);
  source.setAttribute('type', 'video/mp4');
  video.appendChild(source);

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const playBtn = document.createElement('div');
  playBtn.className = 'play-btn';
  overlay.appendChild(playBtn);

  wrap.appendChild(video);
  wrap.appendChild(overlay);

  if (slotLabel) {
    const badge = document.createElement('div');
    badge.className = 'slot-badge';
    badge.textContent = slotLabel;
    wrap.appendChild(badge);
  }

  wrap.addEventListener('click', () => {
    if (video.paused) {
      video.controls = true;
      wrap.classList.add('playing');
      video.muted = false;
      video.play().catch(() => { video.muted = true; video.play(); });
    }
  });
  video.addEventListener('ended', () => { wrap.classList.remove('playing'); video.controls = false; });
  video.addEventListener('pause', () => { if (video.ended) wrap.classList.remove('playing'); });

  while (c.contentHost.firstChild) c.contentHost.removeChild(c.contentHost.firstChild);
  c.contentHost.appendChild(wrap);
  video.load();

  // Label + Quelle anzeigen
  let lbl = (slotLabel ? (slotLabel + ' · ') : 'Live · ') + (formatTs(showTs).replace(/, \\d{4}/, '') || '—');
  if (showSource) lbl += '<span class="source ' + showSource + '">' + showSource + '</span>';
  c.label.innerHTML = lbl;

  updateNav(c);
}

function updateNav(c) {
  // ◀ wäre älter (höhere Index-Zahl), ▶ wäre neuer
  const nextIdx = c.pickIdx == null ? 0 : c.pickIdx + 1;
  const prevIdx = c.pickIdx == null ? null : c.pickIdx - 1;
  c.prevBtn.disabled = !c.hist.slice(nextIdx).some(h => h && h.file);
  c.nextBtn.disabled = c.pickIdx === null;
}

function updateAllTimes() {
  Object.keys(cards).forEach(id => {
    const c = cards[id];
    if (c.timeEl) c.timeEl.textContent = c.ts ? relativeTime(c.ts) : '';
  });
}
setInterval(updateAllTimes, 30000);

fetch('/cameras').then(r => r.json()).then(list => {
  if (!list.length) {
    setStatus('Keine Kameras', 'err');
    $grid.innerHTML = '<div style="padding:40px;text-align:center;color:#777">Keine Kameras gefunden</div>';
    return;
  }
  list.forEach(buildCard);

  if (typeof io === 'undefined') { setStatus('Socket.IO Lib fehlt', 'err'); return; }
  socket = io(IOBROKER_URL, { transports: ['websocket', 'polling'] });
  socket.on('connect', () => {
    setStatus('Verbunden', 'ok');
    list.forEach(cam => {
      let pending = 4 + 4 * HISTORY_SIZE;
      const done = () => { if (--pending === 0) renderCard(cam.id); };

      socket.emit('getState', cam.ts_datapoint, (e, st) => {
        if (st && st.val) cards[cam.id].ts = st.val;
        done();
      });
      socket.emit('getState', cam.ready_datapoint, (e, st) => {
        if (st) cards[cam.id].ready = st.val;
        done();
      });
      socket.emit('getState', cam.error_datapoint, (e, st) => {
        if (st) cards[cam.id].error = st.val;
        done();
      });
      socket.emit('getState', cam.datapoint, (e, st) => {
        if (st) cards[cam.id].value = st.val;
        done();
      });

      socket.emit('subscribe', cam.datapoint);
      socket.emit('subscribe', cam.ts_datapoint);
      socket.emit('subscribe', cam.ready_datapoint);
      socket.emit('subscribe', cam.error_datapoint);

      cam.history.forEach((h, idx) => {
        socket.emit('getState', h.file_datapoint, (e, st) => {
          cards[cam.id].hist[idx].file = st ? st.val : null; done();
        });
        socket.emit('getState', h.timestamp_datapoint, (e, st) => {
          cards[cam.id].hist[idx].timestamp = st ? st.val : null; done();
        });
        socket.emit('getState', h.id_datapoint, (e, st) => {
          cards[cam.id].hist[idx].id = st ? st.val : null; done();
        });
        socket.emit('getState', h.source_datapoint, (e, st) => {
          cards[cam.id].hist[idx].source = st ? st.val : null; done();
        });
        socket.emit('subscribe', h.file_datapoint);
        socket.emit('subscribe', h.timestamp_datapoint);
        socket.emit('subscribe', h.id_datapoint);
        socket.emit('subscribe', h.source_datapoint);
      });
    });
  });
  socket.on('disconnect',    () => setStatus('Getrennt', 'err'));
  socket.on('connect_error', (e) => { setStatus('Verbindungsfehler', 'err'); console.error(e); });
  socket.on('stateChange', (id, state) => {
    if (!state) return;
    for (const cam of list) {
      if (id === cam.datapoint)        { cards[cam.id].value = state.val; cards[cam.id].ts = state.ts || cards[cam.id].ts; renderCard(cam.id); return; }
      if (id === cam.ts_datapoint)     { if (state.val) cards[cam.id].ts = state.val; renderCard(cam.id); return; }
      if (id === cam.ready_datapoint)  { cards[cam.id].ready = state.val; renderCard(cam.id); return; }
      if (id === cam.error_datapoint)  { cards[cam.id].error = state.val; renderCard(cam.id); return; }
      // History-States?
      for (let idx = 0; idx < HISTORY_SIZE; idx++) {
        const h = cam.history[idx];
        if (id === h.file_datapoint)      { cards[cam.id].hist[idx].file = state.val; renderCard(cam.id); return; }
        if (id === h.timestamp_datapoint) { cards[cam.id].hist[idx].timestamp = state.val; renderCard(cam.id); return; }
        if (id === h.id_datapoint)        { cards[cam.id].hist[idx].id = state.val; renderCard(cam.id); return; }
        if (id === h.source_datapoint)    { cards[cam.id].hist[idx].source = state.val; renderCard(cam.id); return; }
      }
    }
  });
}).catch(e => { setStatus('Server-Fehler', 'err'); console.error(e); });
</script>
</body>
</html>`;

// ============================================================
// Widget 3: History (10 Slots einer Kamera in einer Reihe)
// ============================================================
const HISTORY_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blink History</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/2.3.0/socket.io.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background:#1a1a1a; color:#eee; font-family:-apple-system,system-ui,sans-serif;
       min-height:100vh; padding:12px; }
.topbar { display:flex; justify-content:space-between; align-items:center;
          padding:0 4px 12px; gap:12px; flex-wrap:wrap; }
.topbar .title { font-size:14px; font-weight:600; }
.status { font-size:11px; padding:3px 8px; border-radius:10px; background:#555; }
.status.ok { background:#2d6a3e; }
.status.err { background:#8b2d2d; }
select { background:#444; color:#eee; border:1px solid #555; padding:5px 8px;
         border-radius:6px; font-size:12px; }
.player { background:#2a2a2a; border-radius:10px; overflow:hidden; margin-bottom:12px;
          box-shadow:0 4px 12px rgba(0,0,0,0.4); }
.player video { width:100%; display:block; background:#000; max-height:540px; }
.player .info { padding:10px 14px; font-size:12px; color:#bbb;
                border-top:1px solid #444; display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
.player .info .src { padding:2px 6px; border-radius:4px; font-size:10px; background:#444; }
.player .info .src.cloud { background:#2d4a6a; }
.player .info .src.local_storage { background:#4a3a2d; }
.player .empty { padding:80px 20px; text-align:center; color:#777; }

.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));
        gap:10px; }
.slot { background:#2a2a2a; border-radius:8px; overflow:hidden;
        cursor:pointer; border:2px solid transparent; transition:all 0.15s; }
.slot:hover { border-color:#666; transform:translateY(-2px); }
.slot.active { border-color:#4a8; }
.slot.empty { opacity:0.3; cursor:not-allowed; }
.slot-thumb { position:relative; aspect-ratio:16/9; background:#000; }
.slot-thumb video { width:100%; height:100%; object-fit:cover; pointer-events:none; }
.slot-thumb .badge { position:absolute; top:4px; left:4px;
                     background:rgba(0,0,0,0.7); color:white;
                     padding:2px 6px; border-radius:3px; font-size:10px; font-weight:500; }
.slot-thumb .src-badge { position:absolute; top:4px; right:4px;
                         background:#444; color:white;
                         padding:2px 6px; border-radius:3px; font-size:9px; }
.slot-thumb .src-badge.cloud { background:#2d4a6a; }
.slot-thumb .src-badge.local_storage { background:#4a3a2d; }
.slot-info { padding:6px 8px; font-size:11px; }
.slot-info .time { color:#ddd; font-weight:500; }
.slot-info .rel { color:#888; font-size:10px; }
</style>
</head>
<body>
<div class="topbar">
  <span class="title">📚 Verlauf</span>
  <select id="picker"></select>
  <span class="status" id="status">Verbinde…</span>
</div>

<div class="player" id="player">
  <div class="empty">Wähle einen Clip aus dem Verlauf</div>
</div>

<div class="grid" id="grid"></div>

<script>
__COMMON_JS__

const params  = new URLSearchParams(location.search);
const fixedCamera = params.get('camera');
const $status = document.getElementById('status');
const $picker = document.getElementById('picker');
const $player = document.getElementById('player');
const $grid   = document.getElementById('grid');

let socket, currentCam = null, cameras = [];
let histSlots = [];
let pickIdx = null;

function setStatus(t, c) { $status.textContent = t; $status.className = 'status' + (c?' '+c:''); }

function renderPlayer() {
  if (pickIdx === null || !histSlots[pickIdx] || !histSlots[pickIdx].file) {
    $player.innerHTML = '<div class="empty">Wähle einen Clip aus dem Verlauf</div>';
    return;
  }
  const s = histSlots[pickIdx];
  const url = buildUrl(s.file, s.timestamp);
  if (!url) {
    $player.innerHTML = '<div class="empty">Datei nicht verfügbar</div>';
    return;
  }
  $player.innerHTML = '';
  const video = document.createElement('video');
  video.controls = true;
  video.autoplay = true;
  video.muted = false;
  video.playsInline = true;
  const source = document.createElement('source');
  source.setAttribute('src', url);
  source.setAttribute('type', 'video/mp4');
  video.appendChild(source);
  $player.appendChild(video);
  video.load();
  video.play().catch(() => { video.muted = true; video.play(); });

  const info = document.createElement('div');
  info.className = 'info';
  const slot = document.createElement('span');
  slot.innerHTML = '<strong>Slot #' + pickIdx + '</strong>';
  const time = document.createElement('span');
  time.textContent = '🕒 ' + (formatTs(s.timestamp) || '—');
  const rel = document.createElement('span');
  rel.textContent = relativeTime(s.timestamp);
  info.appendChild(slot);
  info.appendChild(time);
  info.appendChild(rel);
  if (s.source) {
    const src = document.createElement('span');
    src.className = 'src ' + s.source;
    src.textContent = s.source;
    info.appendChild(src);
  }
  $player.appendChild(info);
}

function renderGrid() {
  $grid.innerHTML = '';
  for (let i = 0; i < HISTORY_SIZE; i++) {
    const s = histSlots[i] || {};
    const slot = document.createElement('div');
    slot.className = 'slot' + (s.file ? '' : ' empty') + (pickIdx === i ? ' active' : '');

    const thumb = document.createElement('div');
    thumb.className = 'slot-thumb';
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = '#' + i;
    thumb.appendChild(badge);

    if (s.source) {
      const srcBadge = document.createElement('div');
      srcBadge.className = 'src-badge ' + s.source;
      srcBadge.textContent = s.source === 'cloud' ? '☁' : '📥';
      thumb.appendChild(srcBadge);
    }

    if (s.file) {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      const sourceEl = document.createElement('source');
      sourceEl.setAttribute('src', buildUrl(s.file, s.timestamp));
      sourceEl.setAttribute('type', 'video/mp4');
      v.appendChild(sourceEl);
      thumb.appendChild(v);
    }

    const inf = document.createElement('div');
    inf.className = 'slot-info';
    const t = document.createElement('div');
    t.className = 'time';
    t.textContent = s.timestamp ? formatTs(s.timestamp).replace(/, \\d{4}/, '') : '—';
    const r = document.createElement('div');
    r.className = 'rel';
    r.textContent = relativeTime(s.timestamp) || (s.file ? '' : 'leer');
    inf.appendChild(t);
    inf.appendChild(r);

    slot.appendChild(thumb);
    slot.appendChild(inf);

    if (s.file) {
      slot.addEventListener('click', () => {
        pickIdx = (pickIdx === i) ? null : i;
        renderPlayer();
        renderGrid();
      });
    }
    $grid.appendChild(slot);
  }
}

function unsubscribeCurrent() {
  if (!currentCam || !socket) return;
  currentCam.history.forEach(h => {
    socket.emit('unsubscribe', h.file_datapoint);
    socket.emit('unsubscribe', h.timestamp_datapoint);
    socket.emit('unsubscribe', h.id_datapoint);
    socket.emit('unsubscribe', h.source_datapoint);
  });
}

function switchCamera(cam) {
  unsubscribeCurrent();
  currentCam = cam;
  pickIdx = null;
  histSlots = new Array(HISTORY_SIZE).fill(null).map(() => ({}));
  $player.innerHTML = '<div class="empty">Lade Verlauf…</div>';
  $grid.innerHTML = '';

  let pending = 4 * HISTORY_SIZE;
  const done = () => { if (--pending === 0) { renderGrid(); renderPlayer(); } };

  cam.history.forEach((h, idx) => {
    socket.emit('getState', h.file_datapoint, (e, st) => {
      histSlots[idx].file = st ? st.val : null; done();
    });
    socket.emit('getState', h.timestamp_datapoint, (e, st) => {
      histSlots[idx].timestamp = st ? st.val : null; done();
    });
    socket.emit('getState', h.id_datapoint, (e, st) => {
      histSlots[idx].id = st ? st.val : null; done();
    });
    socket.emit('getState', h.source_datapoint, (e, st) => {
      histSlots[idx].source = st ? st.val : null; done();
    });
    socket.emit('subscribe', h.file_datapoint);
    socket.emit('subscribe', h.timestamp_datapoint);
    socket.emit('subscribe', h.id_datapoint);
    socket.emit('subscribe', h.source_datapoint);
  });
}

fetch('/cameras').then(r => r.json()).then(list => {
  cameras = list;
  if (!cameras.length) {
    setStatus('Keine Kameras', 'err');
    return;
  }
  cameras.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name || ('Kamera ' + c.id);
    $picker.appendChild(o);
  });
  $picker.addEventListener('change', () => {
    const cam = cameras.find(c => c.id === $picker.value);
    if (cam) switchCamera(cam);
  });

  const startCam = fixedCamera
    ? cameras.find(c => c.id === fixedCamera) || cameras[0]
    : cameras[0];
  $picker.value = startCam.id;

  if (typeof io === 'undefined') { setStatus('Socket.IO Lib fehlt', 'err'); return; }
  socket = io(IOBROKER_URL, { transports: ['websocket', 'polling'] });
  socket.on('connect', () => { setStatus('Verbunden', 'ok'); switchCamera(startCam); });
  socket.on('disconnect', () => setStatus('Getrennt', 'err'));
  socket.on('connect_error', (e) => { setStatus('Verbindungsfehler', 'err'); console.error(e); });
  socket.on('stateChange', (id, state) => {
    if (!state || !currentCam) return;
    for (let idx = 0; idx < HISTORY_SIZE; idx++) {
      const h = currentCam.history[idx];
      if (id === h.file_datapoint)      { histSlots[idx].file = state.val; renderGrid(); return; }
      if (id === h.timestamp_datapoint) { histSlots[idx].timestamp = state.val; renderGrid(); return; }
      if (id === h.id_datapoint)        { histSlots[idx].id = state.val; renderGrid(); return; }
      if (id === h.source_datapoint)    { histSlots[idx].source = state.val; renderGrid(); return; }
    }
  });
}).catch(e => { setStatus('Server-Fehler', 'err'); console.error(e); });
</script>
</body>
</html>`;

function buildHTML(template) {
    return template
        .replace('__COMMON_JS__',     COMMON_JS)
        .replace(/__VIDEO_BASE__/g,    VIDEO_BASE)
        .replace(/__VIDEO_PORT__/g,    PORT)
        .replace(/__IOBROKER_PORT__/g, IOBROKER_PORT)
        .replace(/__HISTORY_SIZE__/g,  HISTORY_SIZE);
}
const SINGLE_PAGE  = buildHTML(WIDGET_HTML);
const GRID_PAGE    = buildHTML(GRID_HTML);
const HISTORY_PAGE = buildHTML(HISTORY_HTML);

const MIME = {
    '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime',
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
    '.html':'text/html; charset=utf-8','.json':'application/json'
};

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const urlPath = req.url.split('?')[0];

    if (urlPath === '/cameras') {
        try {
            const cams = await discoverCameras();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(JSON.stringify(cams));
        } catch (e) {
            log('Kamera-Discovery Fehler: ' + e.message, 'error');
            res.writeHead(500); res.end('Error');
        }
        return;
    }

    if (urlPath === '/grid' || urlPath === '/grid.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(GRID_PAGE);
        return;
    }

    if (urlPath === '/history' || urlPath === '/history.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HISTORY_PAGE);
        return;
    }

    if (urlPath === '/' || urlPath === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SINGLE_PAGE);
        return;
    }

    if (!urlPath.startsWith(VIDEO_BASE)) { res.writeHead(404); res.end('Not Found'); return; }

    const filename = decodeURIComponent(urlPath.slice(VIDEO_BASE.length));
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    const fullPath = path.join(ROOT_DIR, filename);
    if (!fullPath.startsWith(ROOT_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

    fs.stat(fullPath, (err, stat) => {
        if (err || !stat.isFile()) { res.writeHead(404); res.end('File Not Found'); return; }

        const ext = path.extname(filename).toLowerCase();
        const mimeType = MIME[ext] || 'application/octet-stream';
        const range = req.headers.range;

        const noCacheHeaders = mimeType.startsWith('video/')
            ? {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma':        'no-cache',
                'Expires':       '0'
              }
            : {};

        if (range && mimeType.startsWith('video/')) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end   = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            res.writeHead(206, {
                ...noCacheHeaders,
                'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges':  'bytes',
                'Content-Length': end - start + 1,
                'Content-Type':   mimeType
            });
            fs.createReadStream(fullPath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                ...noCacheHeaders,
                'Content-Length': stat.size,
                'Content-Type':   mimeType,
                'Accept-Ranges':  'bytes'
            });
            fs.createReadStream(fullPath).pipe(res);
        }
    });
});

server.listen(PORT, () => {
    log(`Blink-Server läuft: http://<host>:${PORT}/  (Single + History-Streifen)  ·  /grid (Multi mit Blättern)  ·  /history (Verlauf-Galerie)`);
});
server.on('error', (err) => log(`Blink-Server Fehler: ${err.message}`, 'error'));

globalThis.__blinkServer = server;

onStop(() => {
    if (server) { server.close(); log('Blink-Server gestoppt'); }
}, 2000);
```
</details>

## Blink Adapter: Datapoints

Overview of all datapoints provided by the customized ioBroker adapter `blink.0`.
Status: after refactoring for cloud history + local-storage fallback.

## Conventions

- `<CamID>` — numeric camera ID (e.g. `1754227`). Also used in the MP4 filename.
- `<NetID>` — Network ID of the sync module / home network (e.g. `174553`).
- `<N>` — slot index of the video history, **0 = newest** clip, **9 = oldest**.

All MP4 and snapshot files are stored in the configured snapshot directory (default: `/opt/iobroker/iobroker-data/blink/`).

---

## Adapter globals

| Datapoint | Type | Description |
|---|---|---|
| `blink.0.info.connection` | boolean | `true` if the adapter has a valid session to the Blink cloud. |

---

## Camera datapoints

Each camera gets its own channel `blink.0.cameras.<CamID>` with the following sub-structures.

### `info` – Master data

| Datapoint | Type | Description |
|---|---|---|
| `info.name` | string | Display name from the Blink app (e.g. "Driveway", "Patio"). |
| `info.network_id` | number | Network ID the camera belongs to. |
| `info.serial` | string | Camera serial number. |

### `status` – Current sensor state

| Datapoint | Type | Description |
|---|---|---|
| `status.armed` | boolean | Camera armed (follows the network mode). |
| `status.battery` | string | Battery status as text from the Blink app (e.g. `ok`, `low`). |
| `status.battery_raw` | number | Raw sensor value before conversion. |
| `status.battery_text` | string | Human-readable status text. |
| `status.battery_volt` | number | Battery voltage in volts. |
| `status.temperature` | number | Temperature at the camera sensor in °C. |
| `status.temperature_f` | number | Temperature in °F. |
| `status.temperature_text` | string | Temperature as formatted text. |
| `status.wifi_strength` | number | Wi-Fi signal strength (scale depends on model, higher = better). |
| `status.motion_detect_enabled` | boolean | Motion detection on the camera enabled/disabled. |
| `status.last_update` | string | Timestamp of the last status refresh (ISO format). |

#### Smart detection (only with active Blink subscription)

Extracted from the **newest cloud clip** of the camera:

| Datapoint | Type | Description |
|---|---|---|
| `status.smart_detection` | boolean | At least one smart-detect hit present in the last clip. |
| `status.smart_detection_raw` | string | Raw smart-detection payload (JSON, truncated). |
| `status.detection_type` | string | Comma-separated list of detected types. |
| `status.motion_source` | string | Trigger for the clip: `pir`, `cv_motion`, etc. |
| `status.person_detected` | boolean | Person detected. |
| `status.vehicle_detected` | boolean | Vehicle detected. |
| `status.animal_detected` | boolean | Animal detected. |
| `status.package_detected` | boolean | Package detected. |

### `battery` – Extended battery status

Used to avoid repeated notifications.

| Datapoint | Type | Description |
|---|---|---|
| `battery.low` | boolean | Battery is critically low. |
| `battery.warningSent` | boolean | A warning has already been issued (deduplication). |
| `battery.lastMessage` | string | Timestamp of the last status message. |
| `battery.lastWarning` | string | Timestamp of the last warning. |

### `live` – Snapshot and live stream

| Datapoint | Type | Description |
|---|---|---|
| `live.file` | string | Absolute path of the latest snapshot on disk. |
| `live.image_base64` | string | Snapshot as Base64 string (for direct embedding in VIS without file access). |
| `live.mime_type` | string | MIME type of the snapshot (e.g. `image/jpeg`). |
| `live.timestamp` | string | Snapshot timestamp (ISO). |
| `live.stream_active` | boolean | Live stream currently active. |
| `live.stream_url` | string | URL of the active live stream (TTL limited). |

### `video` – Current video

The newest video for the camera. Cloud is preferred automatically; falls back to local storage (Sync Module 2 USB stick) if needed.

| Datapoint | Type | Description |
|---|---|---|
| `video.file` | string | Absolute path of the MP4 (`<CamID>_latest.mp4`). |
| `video.timestamp` | string | Timestamp of the video content (ISO). |
| `video.id` | string | Unique clip ID from the Blink API. |
| `video.size` | number | File size in bytes. |
| `video.ready` | boolean | File was downloaded successfully and is playable. |
| `video.lastError` | string | Last download error. `""` = ok, otherwise message such as `no video available`. |

### `video.history.0` … `video.history.9` – Ring gallery

Each camera has **10 slots** containing the 10 most recent clips.
**Slot 0 = newest clip**, slot 9 = oldest. On each new clip the slots rotate automatically (oldest drops out).

| Datapoint | Type | Description |
|---|---|---|
| `video.history.<N>.file` | string | Absolute path of the MP4 (`<CamID>_history_<N>.mp4`). Constant filename per slot ⇒ stable URLs in VIS. |
| `video.history.<N>.id` | string | Unique clip ID from the Blink API. |
| `video.history.<N>.timestamp` | string | Timestamp of the clip content (ISO). |
| `video.history.<N>.source` | string | Source of the clip: `cloud` or `local_storage`. Empty if slot unused. |

### `commands` – Trigger datapoints

Set to `true` → action is executed, adapter automatically resets to `false`.

| Datapoint | Type | Action |
|---|---|---|
| `commands.snapshot` | boolean | Request a new snapshot (stored as Base64 state). |
| `commands.snapshot_file` | boolean | Additionally save the snapshot to a file. |
| `commands.fetch_video` | boolean | Download the latest video. Smart logic: cloud first, then local-storage fallback. |
| `commands.live_request` | boolean | Open live stream (TTL ~30 s). |
| `commands.motion_detect` | boolean | Toggle motion detection on the camera. |
| `commands.clear_session` | boolean | Clear the auth session (in case of login problems). |

---

## Sync module / network

Each sync module gets its own channel `blink.0.sync.<NetID>`. **Note:** The state path uses the `network_id`, not the actual sync-module device ID.

### `info` – Master data

| Datapoint | Type | Description |
|---|---|---|
| `info.name` | string | Network name (e.g. "Home"). |
| `info.serial` | string | Sync module serial number. |

### `status` – State

| Datapoint | Type | Description |
|---|---|---|
| `status.armed` | boolean | Network armed (enables motion detection on all cameras). |
| `status.last_update` | string | Timestamp of the last refresh (ISO). |

### `commands` – Trigger

| Datapoint | Type | Action |
|---|---|---|
| `commands.armed` | boolean | Sets the entire network armed (`true`) or disarmed (`false`). Affects all cameras in this network. |

---

## File layout in the snapshot directory

Default path: `/opt/iobroker/iobroker-data/blink/`

| File | Description |
|---|---|
| `<CamID>_latest.mp4` | Most recent video of the camera (see `video.file`). |
| `<CamID>_history_<N>.mp4` | History slot `N` of the camera (`video.history.<N>.file`). |
| `<CamID>_snapshot.jpg` | Last snapshot, if saved via `commands.snapshot_file`. |

Filenames are **constant per slot**, contents change on rotation. For web embedding use a cache-buster in the query string (`?t={timestamp}`) so the browser actually reloads the new file.

---

## Tips for VIS integration

For a **live preview** in VIS:
```
{cameras.1754227.video.file}      → absolute path
{cameras.1754227.video.timestamp} → use for cache-busting
{cameras.1754227.video.ready}     → if false, show a "no video" hint
{cameras.1754227.video.lastError} → if non-empty, show as error status
```

For the **history gallery** query slots 0–9 individually:
```
{cameras.1754227.video.history.0.file}
{cameras.1754227.video.history.0.timestamp}
{cameras.1754227.video.history.0.source}
... through slot 9
```

`source = "cloud"` means the clip came directly from the Blink cloud (fast, no stick upload).
`source = "local_storage"` means the clip was uploaded from the Sync Module 2 USB stick through the cloud.

## Notes

- Battery-powered warnings are handled via the `battery.*` states.
- Devices without a built-in battery, such as Mini/Owl/PanTilt-like devices, are excluded from battery warnings.
- In that case, `battery.lastMessage` is set to `no built in battery`.
- Live image states are updated when a snapshot is fetched or when live snapshots are enabled.
- MJPEG stream states are only relevant if streaming is enabled in the adapter configuration.
- Smart Detection states are updated when classified motion metadata is available from Blink Cloud.
  
## DISCLAIMER

All product and company names or logos are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them or any associated subsidiaries! This personal project is maintained in spare time and has no business goal. Blink is a trademark of Amazon Technologies, Inc..

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK in PROGRESS**
* USB/Local Storage manifest is checked first
* Cloud storage is now used only as a fallback
* More robust Local Storage matching: camera_id / cameraId / device_id / deviceId, if present in the manifest otherwise, camera names (trimmed and lowercased)

### 0.0.11 (2026-05-27)
* (Pischleuder1) maximal 3 login attempts to avoid locked account
* Video busy cooldown for HTTP 409 / code 307 error

### 0.0.10 (2026-05-23)
* (Pischleuder1) Fix trusted publisher case mismatch

### 0.0.9 (2026-05-23)
* (Pischleuder1) Use npm trusted publishing

### 0.0.8 (2026-05-23)
* (Pischleuder1) Fix deploy workflow

### 0.0.7 (2026-05-22)
* Adapter requires node.js >= 22 now
* added MJPEG streaming
* Supports Smart Detection states for classified motion events
* Supports cloud stored videos and local stored videos on sc-card

**Note:** For older changes, see [CHANGELOG_OLD.md](CHANGELOG_OLD.md).## License

MIT License

Copyright (c) 2026 Pischleuder1 <pischleuder@gmx.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
