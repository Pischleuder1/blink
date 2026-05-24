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
- Supports Smart Detection states for classified motion events (works only on paid cloud services)
- Supports cloud stored videos and local stored videos on sd-card (SyncModule 2 and XR) via local server on port 8085 - JavaScript needed, see below !
- The script requires ffmpeg installed and a lot resources and is only partially suitable for Raspberry Pis (min. 4GB — more is better)
- initial release for live view with javascript

<details>
<summary>press here to see the Script</summary>

```javascript
// ============================================================
// Blink Multi-Camera Server + Grid + History + LiveView/HLS
//   http://<host>:8085/grid                 → Alle Kameras im Grid inkl. History + Live
//   http://<host>:8085/cameras              → JSON mit Kameras
//   http://<host>:8085/live/start?camera=ID → LiveView starten
//   http://<host>:8085/live/stop            → LiveView stoppen
//   http://<host>:8085/live/last-session    → Debug/Status
//   http://<host>:8085/live/debug-cameras   → LiveView-Discovery Debug
//   http://<host>:8085/live-hls/<file>      → HLS Playlist/Segmente
//   http://<host>:8085/blink/<file>         → gespeicherte Video-Dateien
// ============================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

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

// Blink/API/IMMI-Dateien auf dem Pi
const LIVEVIEW_DIR          = '/opt/iobroker/node_modules/iobroker.blink/lib';
const LIVEVIEW_REST_SCRIPT  = path.join(LIVEVIEW_DIR, 'blink-liveview-iobroker.js');
const LIVEVIEW_HLS_SCRIPT   = path.join(LIVEVIEW_DIR, 'immi-live-hls.js');
const HLS_DIR               = '/tmp/blink_hls';
const LIVEVIEW_RUNTIME_SEC  = 300;

// Zugangsdaten hier eintragen. PIN nur setzen, wenn Blink gerade einen Code verlangt.
const LIVEVIEW_EMAIL        = 'YOUR-EMAIL';
const LIVEVIEW_PASSWORD     = 'YOUR-PASSWORD';
const LIVEVIEW_PIN          = 'PIN';

// Fallbacks, weil dein ioBroker-Blink-Objektbaum account/network nicht pro Kamera enthält.
const DEFAULT_ACCOUNT_ID    = 'YOUR-ACCOUNT-ID';
const DEFAULT_NETWORK_ID    = 'YOUR DEFAULT NETWORK ID';

// Typen/Seriennummern überschreiben/ergänzen. Serial wird sonst aus blink.0.cameras.<id>.info.serial gelesen.
const LIVEVIEW_CAMERA_OVERRIDES = {
    '1754227': { type: 'camera', name: 'Auffahrt' },
    '548730':  { type: 'camera', name: 'Dach vorne' },
    '451140':  { type: 'camera', name: 'Keller' },
    '1136121': { type: 'camera', name: 'Kellertreppe' },
    '1934050': { type: 'camera', name: 'Kellertreppe 2' },
    '1136145': { type: 'camera', name: 'Terrasse' },
    '1723473': { type: 'camera', name: 'vorne Grill' },
    '773578':  { type: 'owl', serial: 'G8T1940153360515', name: 'Mini - 0515' }
};
// =========================================

if (typeof globalThis.__blinkServer !== 'undefined') {
    try { globalThis.__blinkServer.close(); log('Vorherigen Blink-Server gestoppt'); }
    catch (e) { /* ignore */ }
}

let liveStatus = {
    enabled: true,
    running: false,
    pid: null,
    playlist: false,
    hls_url: null,
    camera_id: null,
    camera_name: null,
    device_type: null,
    session_file: null,
    last_error: '',
    last_log: ''
};

function shellQuote(s) {
    return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'";
}

function execPromise(cmd, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        exec(cmd, opts, (err, stdout, stderr) => {
            resolve({ err: err, stdout: stdout || '', stderr: stderr || '' });
        });
    });
}

function readFileSafe(file, maxLen) {
    try {
        let s = fs.readFileSync(file, 'utf8');
        if (maxLen && s.length > maxLen) s = s.slice(-maxLen);
        return s;
    } catch (e) {
        return '';
    }
}

function safeJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return null; }
}

function getPiHost(req) {
    const host = (req && req.headers && req.headers.host) ? String(req.headers.host).split(':')[0] : '127.0.0.1';
    return host || '127.0.0.1';
}

function publicHlsUrl(req) {
    return 'http://' + getPiHost(req) + ':' + PORT + '/live-hls/live.m3u8?t=' + Date.now();
}

function getStateAsync(id) {
    return new Promise((resolve) => {
        try {
            getState(id, (err, st) => resolve(!err && st ? st : null));
        } catch (e) {
            resolve(null);
        }
    });
}

function objectExists(id) {
    try {
        if (typeof existsState === 'function') return !!existsState(id);
    } catch (e) {}
    try {
        if (typeof existsObject === 'function') return !!existsObject(id);
    } catch (e) {}
    return true;
}

async function readStateString(id) {
    if (!objectExists(id)) return '';
    const st = await getStateAsync(id);
    if (!st || st.val === null || typeof st.val === 'undefined') return '';
    return String(st.val).trim();
}

async function readFirstStateString(ids) {
    for (const id of ids) {
        const v = await readStateString(id);
        if (v) return v;
    }
    return '';
}

async function buildLiveviewConfigForCamera(cam) {
    const id = String(cam.id);
    const ov = LIVEVIEW_CAMERA_OVERRIDES[id] || {};

    const serial = ov.serial || await readFirstStateString([
        CAMERA_PREFIX + id + '.info.serial',
        CAMERA_PREFIX + id + '.serial',
        CAMERA_PREFIX + id + '.device.serial',
        CAMERA_PREFIX + id + '.info.serial_number',
        CAMERA_PREFIX + id + '.info.serialNumber'
    ]);

    const type = ov.type || await readFirstStateString([
        CAMERA_PREFIX + id + '.info.type',
        CAMERA_PREFIX + id + '.type',
        CAMERA_PREFIX + id + '.device.type',
        CAMERA_PREFIX + id + '.info.device_type',
        CAMERA_PREFIX + id + '.info.deviceType'
    ]);

    const accountId = ov.accountId || DEFAULT_ACCOUNT_ID;
    const networkId = ov.networkId || DEFAULT_NETWORK_ID;

    const missing = [];
    if (!accountId) missing.push('accountId');
    if (!networkId) missing.push('networkId');
    if (!type) missing.push('type');
    if (!id) missing.push('id');
    if (!serial) missing.push('serial');

    if (missing.length) {
        return { liveview: null, missing: missing };
    }

    return {
        liveview: {
            id: id,
            name: ov.name || cam.name || ('Kamera ' + id),
            accountId: String(accountId),
            networkId: String(networkId),
            type: String(type),
            serial: String(serial),
            hasSerial: true
        },
        missing: []
    };
}

// ---------- Kameras automatisch entdecken ----------
async function discoverCameras() {
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
                name: null,
                liveview: null,
                liveCapable: false,
                liveMissing: []
            });
        }
    });

    for (const c of cams) {
        const name = await readStateString(CAMERA_PREFIX + c.id + NAME_STATE);
        if (name) c.name = name;
        const live = await buildLiveviewConfigForCamera(c);
        c.liveview = live.liveview;
        c.liveCapable = !!live.liveview;
        c.liveMissing = live.missing || [];
    }

    return cams.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

function cleanupHlsDir() {
    try {
        if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });
        const files = fs.readdirSync(HLS_DIR);
        for (const file of files) {
            const full = path.join(HLS_DIR, file);
            try { fs.rmSync(full, { recursive: true, force: true }); }
            catch (e) { log('HLS-Datei konnte nicht geloescht werden: ' + full + ' / ' + e.message, 'warn'); }
        }
        try { fs.chmodSync(HLS_DIR, 0o777); } catch (e) {}
    } catch (e) {
        log('HLS-Cleanup Fehler: ' + e.message, 'warn');
    }
}

async function stopLiveViewProcess() {
    const pid = liveStatus.pid;
    if (pid) {
        await execPromise('kill ' + shellQuote(pid) + ' 2>/dev/null || true');
    }
    await execPromise('pkill -f immi-live-hls || true; pkill -f ffmpeg || true');
    liveStatus.running = false;
    liveStatus.pid = null;
    liveStatus.playlist = fs.existsSync(path.join(HLS_DIR, 'live.m3u8'));
}

function waitForPlaylist(timeoutMs) {
    const start = Date.now();
    const playlist = path.join(HLS_DIR, 'live.m3u8');
    return new Promise((resolve) => {
        const t = setInterval(() => {
            const ok = fs.existsSync(playlist) && fs.statSync(playlist).size > 0;
            if (ok) { clearInterval(t); resolve(true); return; }
            if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(false); }
        }, 500);
    });
}

async function startLiveForCamera(cameraId, req) {
    const cams = await discoverCameras();
    const cam = cams.find(c => String(c.id) === String(cameraId));
    if (!cam) throw new Error('Unbekannte Kamera-ID: ' + cameraId);
    if (!cam.liveview) throw new Error('LiveView nicht konfiguriert fuer Kamera ' + cameraId + ': fehlt ' + (cam.liveMissing || []).join(', '));

    const lv = cam.liveview;
    log('Starte LiveView fuer Kamera "' + lv.name + '" id=' + lv.id + ' type=' + lv.type + ' serial=' + (lv.serial ? 'ja' : 'nein'));

    await stopLiveViewProcess();
    cleanupHlsDir();

    const sessionFile = '/tmp/blink_liveview_session_' + lv.id + '.json';
    const bridgeLog = '/tmp/blink_liveview_bridge_' + lv.id + '.log';
    try { fs.rmSync(sessionFile, { force: true }); } catch (e) {}
    try { fs.rmSync('/tmp/blink_liveview_session.json', { force: true }); } catch (e) {}
    try { fs.rmSync(bridgeLog, { force: true }); } catch (e) {}

    const restCmd =
        'cd ' + shellQuote(LIVEVIEW_DIR) + ' && ' +
        'BLINK_EMAIL=' + shellQuote(LIVEVIEW_EMAIL) + ' ' +
        'BLINK_PASSWORD=' + shellQuote(LIVEVIEW_PASSWORD) + ' ' +
        'BLINK_PIN=' + shellQuote(LIVEVIEW_PIN) + ' ' +
        'BLINK_ACCOUNT_ID=' + shellQuote(lv.accountId) + ' ' +
        'BLINK_NETWORK_ID=' + shellQuote(lv.networkId) + ' ' +
        'BLINK_DEVICE_TYPE=' + shellQuote(lv.type) + ' ' +
        'BLINK_DEVICE_ID=' + shellQuote(lv.id) + ' ' +
        'BLINK_DEBUG=1 BLINK_POLL_ATTEMPTS=1 ' +
        '/usr/bin/node ' + shellQuote(LIVEVIEW_REST_SCRIPT);

    const rest = await execPromise(restCmd, { timeout: 80000 });
    if (rest.err) {
        const msg = (rest.stdout || rest.stderr || rest.err.message || 'REST LiveView fehlgeschlagen');
        liveStatus.last_error = msg;
        liveStatus.last_log = msg;
        throw new Error(msg);
    }

    if (!fs.existsSync('/tmp/blink_liveview_session.json')) {
        const msg = 'REST LiveView hat keine Session-Datei erzeugt. Log: ' + (rest.stdout || rest.stderr || '');
        liveStatus.last_error = msg;
        liveStatus.last_log = msg;
        throw new Error(msg);
    }
    fs.copyFileSync('/tmp/blink_liveview_session.json', sessionFile);

    const session = safeJson(sessionFile);
    if (!session || !session.server || !String(session.server).startsWith('immis://')) {
        const msg = 'Session-Datei enthaelt keinen gueltigen immis:// Server.';
        liveStatus.last_error = msg;
        liveStatus.last_log = JSON.stringify(session || {}, null, 2).slice(0, 2000);
        throw new Error(msg);
    }
    if (String(session.device_id) !== String(lv.id)) {
        const msg = 'Falsche Session-ID: erwartet ' + lv.id + ', erhalten ' + session.device_id;
        liveStatus.last_error = msg;
        liveStatus.last_log = JSON.stringify(session || {}, null, 2).slice(0, 2000);
        throw new Error(msg);
    }

    const hlsUrl = publicHlsUrl(req);
    const bridgeCmd =
        'cd ' + shellQuote(LIVEVIEW_DIR) + ' && ' +
        'IMMI_SERIAL=' + shellQuote(lv.serial) + ' ' +
        'IMMI_RUNTIME_SECONDS=' + shellQuote(LIVEVIEW_RUNTIME_SEC) + ' ' +
        'NODE_TLS_REJECT_UNAUTHORIZED=0 ' +
        'nohup /usr/bin/node ' + shellQuote(LIVEVIEW_HLS_SCRIPT) + ' ' + shellQuote(sessionFile) +
        ' > ' + shellQuote(bridgeLog) + ' 2>&1 & echo $!';

    const bridge = await execPromise(bridgeCmd, { timeout: 5000 });
    const pid = String(bridge.stdout || '').trim().split(/\s+/).pop();

    liveStatus = {
        enabled: true,
        running: true,
        pid: pid || null,
        playlist: false,
        hls_url: hlsUrl,
        camera_id: lv.id,
        camera_name: lv.name,
        device_type: lv.type,
        session_file: sessionFile,
        last_error: '',
        last_log: ''
    };

    const ok = await waitForPlaylist(30000);
    liveStatus.playlist = ok;
    liveStatus.last_log = readFileSafe(bridgeLog, 12000);

    if (!ok) {
        liveStatus.running = false;
        liveStatus.last_error = 'HLS-Playlist wurde nicht erzeugt.';
        throw new Error('HLS-Playlist wurde nicht erzeugt. Bridge-Log:\n' + liveStatus.last_log);
    }

    return {
        ok: true,
        camera_id: lv.id,
        camera_name: lv.name,
        hls_url: hlsUrl,
        pid: liveStatus.pid
    };
}

function serveFile(req, res, fullPath, contentType, noCache) {
    fs.stat(fullPath, (err, stat) => {
        if (err || !stat.isFile()) { res.writeHead(404); res.end('File Not Found'); return; }
        const headers = {
            'Content-Type': contentType || 'application/octet-stream',
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*'
        };
        if (noCache) {
            headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
            headers['Pragma'] = 'no-cache';
            headers['Expires'] = '0';
        }
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            if (!isNaN(start) && !isNaN(end)) {
                res.writeHead(206, {
                    ...headers,
                    'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
                    'Content-Length': end - start + 1
                });
                fs.createReadStream(fullPath, { start, end }).pipe(res);
                return;
            }
        }
        res.writeHead(200, headers);
        fs.createReadStream(fullPath).pipe(res);
    });
}

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
  const t = typeof ms === 'string' ? new Date(ms).getTime() : ms;
  if (!t || isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'gerade eben';
  const min = Math.floor(sec / 60);
  if (min < 60) return 'vor ' + min + ' Min';
  const h = Math.floor(min / 60);
  if (h < 24) return 'vor ' + h + ' Std';
  const d = Math.floor(h / 24);
  if (d < 30) return 'vor ' + d + ' Tag' + (d===1?'':'en');
  return new Date(t).toLocaleDateString('de-DE');
}
function isVideoValid(value, ready, lastError) {
  if (!value) return false;
  if (lastError && String(lastError).trim() !== '' && String(lastError).toLowerCase() !== 'null') return false;
  if (ready === false) return false;
  return true;
}
`;

const GRID_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blink Cameras</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/2.3.0/socket.io.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.20/hls.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background:#1a1a1a; color:#eee; font-family:-apple-system,system-ui,sans-serif; min-height:100vh; padding:12px; }
.topbar { display:flex; justify-content:space-between; align-items:center; padding:0 4px 12px; gap:12px; }
.topbar .title { font-size:14px; font-weight:600; }
.status { font-size:11px; padding:3px 8px; border-radius:10px; background:#555; }
.status.ok { background:#2d6a3e; }
.status.err { background:#8b2d2d; }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:12px; }
.cam { background:#2a2a2a; border-radius:10px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.3); display:flex; flex-direction:column; }
.cam-head { padding:8px 12px; background:#333; display:flex; justify-content:space-between; align-items:center; gap:8px; }
.cam-name { font-size:13px; font-weight:600; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cam-time { font-size:11px; color:#aaa; flex-shrink:0; }
.cam-content { display:block; position:relative; }
.cam-video-wrap { position:relative; background:#000; aspect-ratio:16/9; cursor:pointer; }
.cam-video-wrap video { width:100%; height:100%; display:block; object-fit:contain; background:#000; }
.cam-video-wrap.live-playing video { object-fit:contain; }
.cam-video-wrap .overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none; background:rgba(0,0,0,0.25); transition:opacity 0.2s; }
.cam-video-wrap.playing .overlay, .cam-video-wrap.live-playing .overlay { opacity:0; }
.cam-video-wrap .play-btn { width:56px; height:56px; border-radius:50%; background:rgba(0,0,0,0.6); border:2px solid rgba(255,255,255,0.8); display:flex; align-items:center; justify-content:center; }
.cam-video-wrap .play-btn::after { content:''; width:0; height:0; margin-left:4px; border-top:10px solid transparent; border-bottom:10px solid transparent; border-left:16px solid white; }
.cam-video-wrap .slot-badge { position:absolute; top:6px; left:6px; background:rgba(0,0,0,0.7); color:white; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; pointer-events:none; }
.cam-empty { aspect-ratio:16/9; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; color:#888; font-size:13px; background:#1a1a1a; padding:8px; text-align:center; }
.cam-empty .err-msg { color:#e88; font-size:11px; white-space:pre-wrap; max-height:160px; overflow:auto; }
.cam-actions { display:flex; align-items:center; gap:8px; padding:8px 12px; border-top:1px solid #383838; background:#252525; flex-wrap:wrap; }
.cam-actions button { border:none; border-radius:7px; padding:6px 10px; color:#fff; cursor:pointer; font-weight:600; }
.cam-actions button.live { background:#19618a; }
.cam-actions button.stop { background:#8b332b; }
.cam-actions button:disabled { opacity:.4; cursor:not-allowed; }
.cam-actions .live-label { color:#bbb; font-size:12px; }
.cam-nav { display:flex; align-items:center; justify-content:space-between; padding:8px 8px; background:#222; gap:8px; border-top:1px solid #383838; }
.cam-nav button { background:#444; color:#eee; border:none; padding:7px 12px; border-radius:7px; font-size:13px; cursor:pointer; min-width:44px; }
.cam-nav button:hover { background:#555; }
.cam-nav button:disabled { opacity:0.35; cursor:not-allowed; }
.cam-nav .label { font-size:12px; color:#bbb; flex:1; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cam-nav .label .source { font-size:9px; padding:1px 4px; border-radius:3px; background:#444; margin-left:4px; vertical-align:middle; }
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
const cards = {};
let cameras = [];
window.__blinkLiveState = { running:false, camera_id:null, hls_url:null };

function setStatus(t, c) { $status.textContent = t; $status.className = 'status' + (c?' '+c:''); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>\"]/g, function(ch){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[ch]; }); }

function attachLiveHls(video, url) {
  if (video._hls) { try { video._hls.destroy(); } catch(e) {} video._hls = null; }
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 8,
      maxLiveSyncPlaybackRate: 1.0,
      backBufferLength: 20,
      maxBufferLength: 20,
      maxMaxBufferLength: 30,
      enableWorker: true
    });

    video._hls = hls;
    video.muted = true;
    video.controls = true;
    video.autoplay = true;

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      video.play().catch(function(e){ console.warn('Video play Fehler:', e); });
    });

    hls.on(Hls.Events.ERROR, function (event, data) {
      console.warn('HLS Fehler:', data);

      if (data && data.details === 'bufferStalledError') {
        try {
          video.currentTime = Math.max(video.currentTime - 0.5, 0);
          video.play().catch(function(){});
        } catch (e) {}
        return;
      }

      if (data && data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          try { hls.startLoad(); } catch (e) {}
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch (e) {}
        } else {
          try { hls.destroy(); } catch (e) {}
        }
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.muted = true;
    video.play().catch(function(){});
  } else {
    console.error('HLS wird von diesem Browser nicht unterstützt');
  }
}

function cleanupVideoElement(el) {
  if (!el) return;
  const vids = el.querySelectorAll ? el.querySelectorAll('video') : [];
  vids.forEach(function(v){ if (v._hls) { try { v._hls.destroy(); } catch(e) {} v._hls = null; } });
}

function clearContent(c) {
  while (c.contentHost.firstChild) {
    cleanupVideoElement(c.contentHost.firstChild);
    c.contentHost.removeChild(c.contentHost.firstChild);
  }
  c.currentMode = null;
  c.liveUrl = null;
}

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

  const actions = document.createElement('div');
  actions.className = 'cam-actions';
  const liveBtn = document.createElement('button');
  liveBtn.className = 'live';
  liveBtn.textContent = '📡 Live';
  liveBtn.disabled = !cam.liveCapable;
  liveBtn.title = cam.liveCapable ? 'LiveView starten' : ('LiveView nicht verfügbar: ' + (cam.liveMissing || []).join(', '));
  const stopBtn = document.createElement('button');
  stopBtn.className = 'stop';
  stopBtn.textContent = '▪ Stop';
  const liveLabel = document.createElement('span');
  liveLabel.className = 'live-label';
  actions.appendChild(liveBtn);
  actions.appendChild(stopBtn);
  actions.appendChild(liveLabel);

  const nav = document.createElement('div');
  nav.className = 'cam-nav';
  const olderBtn = document.createElement('button');
  olderBtn.textContent = '◀';
  olderBtn.title = 'Älterer Clip';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'Aktuell';
  const currentBtn = document.createElement('button');
  currentBtn.textContent = 'Aktuell';
  currentBtn.title = 'Aktuellen Clip anzeigen';
  const newerBtn = document.createElement('button');
  newerBtn.textContent = '▶';
  newerBtn.title = 'Neuerer Clip';
  nav.appendChild(olderBtn);
  nav.appendChild(label);
  nav.appendChild(currentBtn);
  nav.appendChild(newerBtn);

  card.appendChild(head);
  card.appendChild(contentHost);
  card.appendChild(actions);
  card.appendChild(nav);
  $grid.appendChild(card);

  cards[cam.id] = {
    value: null, ts: null, ready: null, error: null,
    hist: new Array(HISTORY_SIZE).fill(null).map(function(){ return {}; }),
    pickIdx: null,
    root: card, contentHost: contentHost, timeEl: timeSpan,
    olderBtn: olderBtn, newerBtn: newerBtn, currentBtn: currentBtn, label: label,
    liveBtn: liveBtn, stopBtn: stopBtn, liveLabel: liveLabel,
    datapoint: cam.datapoint,
    ts_datapoint: cam.ts_datapoint,
    ready_datapoint: cam.ready_datapoint,
    error_datapoint: cam.error_datapoint,
    history: cam.history,
    name: cam.name || ('Kamera ' + cam.id),
    liveCapable: !!cam.liveCapable,
    liveMissing: cam.liveMissing || [],
    currentMode: null,
    liveUrl: null
  };

  olderBtn.addEventListener('click', function(){ navigate(cam.id, +1); });
  newerBtn.addEventListener('click', function(){ navigate(cam.id, -1); });
  currentBtn.addEventListener('click', function(){ cards[cam.id].pickIdx = null; renderCard(cam.id); });
  liveBtn.addEventListener('click', function(){ startLive(cam.id); });
  stopBtn.addEventListener('click', function(){ stopLive(); });
}

function navigate(camId, delta) {
  const c = cards[camId];
  if (!c) return;
  let next = c.pickIdx == null ? 0 : c.pickIdx + delta;
  if (next < 0) { c.pickIdx = null; renderCard(camId); return; }
  if (next >= HISTORY_SIZE) next = HISTORY_SIZE - 1;
  while (next >= 0 && next < HISTORY_SIZE && !c.hist[next].file) next += delta;
  if (next >= 0 && next < HISTORY_SIZE) c.pickIdx = next;
  else c.pickIdx = null;
  renderCard(camId);
}

function setEmpty(c, text, errMsg) {
  clearContent(c);
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

function renderLiveCard(camId, hlsUrl) {
  const c = cards[camId];
  if (!c) return;

  c.liveLabel.textContent = 'LIVE: ' + c.name + ' (' + camId + ')';
  if (c.timeEl) c.timeEl.textContent = 'LIVE';
  c.label.textContent = 'LIVE · ' + c.name;

  const iframeSrc = '/live-player?camera=' + encodeURIComponent(camId) + '&t=' + Date.now();

  if (c.currentMode === 'live' && c.liveUrl === hlsUrl && c.contentHost.querySelector('iframe')) {
    return;
  }

  clearContent(c);
  c.currentMode = 'live';
  c.liveUrl = hlsUrl;

  const wrap = document.createElement('div');
  wrap.className = 'cam-video-wrap playing live-playing';

  const iframe = document.createElement('iframe');
  iframe.src = iframeSrc;
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.style.display = 'block';
  iframe.allow = 'autoplay; fullscreen';
  iframe.allowFullscreen = true;
  iframe.title = 'Blink LiveView ' + c.name;

  wrap.appendChild(iframe);
  c.contentHost.appendChild(wrap);
}

function renderCard(camId) {
  const c = cards[camId];
  if (!c) return;

  if (window.__blinkLiveState && window.__blinkLiveState.running &&
      String(window.__blinkLiveState.camera_id) === String(camId) &&
      window.__blinkLiveState.hls_url) {
    renderLiveCard(camId, window.__blinkLiveState.hls_url);
    updateNav(c);
    return;
  }

  c.liveLabel.textContent = '';
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
    slotLabel = null;
    c.pickIdx = null;
  } else {
    const errText = c.error && String(c.error).trim() && String(c.error).toLowerCase() !== 'null' ? String(c.error) : null;
    setEmpty(c, 'Kein aktuelles Video', errText);
    updateNav(c);
    return;
  }

  const url = buildUrl(showFile, showTs);
  if (!url) { setEmpty(c, 'Kein Video'); updateNav(c); return; }

  if (c.currentMode === 'clip' && c.clipUrl === url) {
    updateNav(c);
    return;
  }

  clearContent(c);
  c.currentMode = 'clip';
  c.clipUrl = url;

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

  wrap.addEventListener('click', function() {
    if (video.paused) {
      video.controls = true;
      wrap.classList.add('playing');
      video.muted = false;
      video.play().catch(function(){ video.muted = true; video.play().catch(function(){}); });
    }
  });
  video.addEventListener('ended', function(){ wrap.classList.remove('playing'); video.controls = false; });
  video.addEventListener('pause', function(){ if (video.ended) wrap.classList.remove('playing'); });

  c.contentHost.appendChild(wrap);
  video.load();

  let lbl = (slotLabel ? (slotLabel + ' · ') : 'Aktuell · ') + (formatTs(showTs).replace(/, \\d{4}/, '') || '—');
  if (showSource) lbl += '<span class="source ' + showSource + '">' + showSource + '</span>';
  c.label.innerHTML = lbl;

  updateNav(c);
}

function updateNav(c) {
  const nextIdx = c.pickIdx == null ? 0 : c.pickIdx + 1;
  c.olderBtn.disabled = !c.hist.slice(nextIdx).some(function(h){ return h && h.file; });
  c.newerBtn.disabled = c.pickIdx === null;
  c.currentBtn.disabled = c.pickIdx === null;
}

function renderAllCards() {
  Object.keys(cards).forEach(function(id){ renderCard(id); });
}

function updateAllTimes() {
  Object.keys(cards).forEach(function(id) {
    const c = cards[id];
    if (window.__blinkLiveState.running && String(window.__blinkLiveState.camera_id) === String(id)) {
      if (c.timeEl) c.timeEl.textContent = 'LIVE';
    } else if (c.timeEl) {
      c.timeEl.textContent = c.ts ? relativeTime(c.ts) : '';
    }
  });
}
setInterval(updateAllTimes, 30000);

async function refreshLiveState() {
  try {
    const r = await fetch('/live/last-session?t=' + Date.now(), { cache: 'no-store' });
    const j = await r.json();
    const st = j.status || {};
    const oldCam = window.__blinkLiveState.camera_id;
    window.__blinkLiveState = {
      running: !!(st.running && st.hls_url),
      camera_id: st.camera_id || null,
      hls_url: st.hls_url || null
    };
    if (oldCam && String(oldCam) !== String(window.__blinkLiveState.camera_id || '')) renderCard(oldCam);
    if (window.__blinkLiveState.camera_id) renderCard(window.__blinkLiveState.camera_id);
  } catch (e) {}
}
setInterval(refreshLiveState, 5000);

async function startLive(camId) {
  const c = cards[camId];
  if (!c) return;
  c.liveLabel.textContent = 'Starte LiveView…';
  try {
    const r = await fetch('/live/start?camera=' + encodeURIComponent(camId) + '&t=' + Date.now(), { cache: 'no-store' });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(text); }
    if (!data.ok) throw new Error(data.error || 'Start fehlgeschlagen');

    const previous = window.__blinkLiveState.camera_id;
    window.__blinkLiveState = { running:true, camera_id:String(data.camera_id), hls_url:data.hls_url };
    if (previous && String(previous) !== String(data.camera_id)) renderCard(previous);
    renderCard(data.camera_id);
  } catch (e) {
    c.liveLabel.textContent = '';
    setEmpty(c, 'LiveView Startfehler', e.message || String(e));
  }
}

async function stopLive() {
  try { await fetch('/live/stop?t=' + Date.now(), { cache: 'no-store' }); } catch (e) {}
  const old = window.__blinkLiveState.camera_id;
  window.__blinkLiveState = { running:false, camera_id:null, hls_url:null };
  if (old) renderCard(old);
  renderAllCards();
}

fetch('/cameras?t=' + Date.now(), { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(list) {
  cameras = list;
  if (!list.length) {
    setStatus('Keine Kameras', 'err');
    $grid.innerHTML = '<div style="padding:40px;text-align:center;color:#777">Keine Kameras gefunden</div>';
    return;
  }
  list.forEach(buildCard);

  if (typeof io === 'undefined') { setStatus('Socket.IO Lib fehlt', 'err'); return; }
  socket = io(IOBROKER_URL, { transports: ['websocket', 'polling'] });
  socket.on('connect', function() {
    setStatus('Verbunden', 'ok');
    list.forEach(function(cam) {
      let pending = 4 + 4 * HISTORY_SIZE;
      const done = function(){ if (--pending === 0) renderCard(cam.id); };

      socket.emit('getState', cam.ts_datapoint, function(e, st){ if (st && st.val) cards[cam.id].ts = st.val; done(); });
      socket.emit('getState', cam.ready_datapoint, function(e, st){ if (st) cards[cam.id].ready = st.val; done(); });
      socket.emit('getState', cam.error_datapoint, function(e, st){ if (st) cards[cam.id].error = st.val; done(); });
      socket.emit('getState', cam.datapoint, function(e, st){ if (st) cards[cam.id].value = st.val; done(); });

      socket.emit('subscribe', cam.datapoint);
      socket.emit('subscribe', cam.ts_datapoint);
      socket.emit('subscribe', cam.ready_datapoint);
      socket.emit('subscribe', cam.error_datapoint);

      cam.history.forEach(function(h, idx) {
        socket.emit('getState', h.file_datapoint, function(e, st){ cards[cam.id].hist[idx].file = st ? st.val : null; done(); });
        socket.emit('getState', h.timestamp_datapoint, function(e, st){ cards[cam.id].hist[idx].timestamp = st ? st.val : null; done(); });
        socket.emit('getState', h.id_datapoint, function(e, st){ cards[cam.id].hist[idx].id = st ? st.val : null; done(); });
        socket.emit('getState', h.source_datapoint, function(e, st){ cards[cam.id].hist[idx].source = st ? st.val : null; done(); });
        socket.emit('subscribe', h.file_datapoint);
        socket.emit('subscribe', h.timestamp_datapoint);
        socket.emit('subscribe', h.id_datapoint);
        socket.emit('subscribe', h.source_datapoint);
      });
    });
    refreshLiveState();
  });
  socket.on('disconnect', function(){ setStatus('Getrennt', 'err'); });
  socket.on('connect_error', function(e){ setStatus('Verbindungsfehler', 'err'); console.error(e); });
  socket.on('stateChange', function(id, state) {
    if (!state) return;
    for (const cam of list) {
      if (id === cam.datapoint)        { cards[cam.id].value = state.val; cards[cam.id].ts = state.ts || cards[cam.id].ts; renderCard(cam.id); return; }
      if (id === cam.ts_datapoint)     { if (state.val) cards[cam.id].ts = state.val; renderCard(cam.id); return; }
      if (id === cam.ready_datapoint)  { cards[cam.id].ready = state.val; renderCard(cam.id); return; }
      if (id === cam.error_datapoint)  { cards[cam.id].error = state.val; renderCard(cam.id); return; }
      for (let idx = 0; idx < HISTORY_SIZE; idx++) {
        const h = cam.history[idx];
        if (id === h.file_datapoint)      { cards[cam.id].hist[idx].file = state.val; renderCard(cam.id); return; }
        if (id === h.timestamp_datapoint) { cards[cam.id].hist[idx].timestamp = state.val; renderCard(cam.id); return; }
        if (id === h.id_datapoint)        { cards[cam.id].hist[idx].id = state.val; renderCard(cam.id); return; }
        if (id === h.source_datapoint)    { cards[cam.id].hist[idx].source = state.val; renderCard(cam.id); return; }
      }
    }
  });
}).catch(function(e){ setStatus('Server-Fehler', 'err'); console.error(e); });
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
const GRID_PAGE = buildHTML(GRID_HTML);

const MIME = {
    '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime',
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
    '.html':'text/html; charset=utf-8','.json':'application/json'
};

const server = http.createServer(async (req, res) => {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const parsed = new URL(req.url, 'http://localhost');
        const urlPath = parsed.pathname;

        if (urlPath === '/cameras') {
            const cams = await discoverCameras();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
            res.end(JSON.stringify(cams));
            return;
        }

        if (urlPath === '/live/debug-cameras' || urlPath === '/debug-cameras') {
            const cams = await discoverCameras();
            const out = cams.map(c => ({
                id: c.id,
                name: c.name,
                liveview: c.liveview ? {
                    id: c.liveview.id,
                    name: c.liveview.name,
                    accountId: c.liveview.accountId,
                    networkId: c.liveview.networkId,
                    type: c.liveview.type,
                    hasSerial: !!c.liveview.serial
                } : null,
                missing: c.liveMissing || []
            }));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
            res.end(JSON.stringify(out, null, 2));
            return;
        }

        if (urlPath === '/live/start') {
            const cameraId = parsed.searchParams.get('camera');
            if (!cameraId) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok:false, error:'camera fehlt' })); return; }
            try {
                const out = await startLiveForCamera(cameraId, req);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
                res.end(JSON.stringify(out));
            } catch (e) {
                log('LiveView Startfehler fuer Kamera ' + cameraId + ': ' + (e.message || e), 'warn');
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
                res.end(JSON.stringify({ ok:false, error:e.message || String(e), status:liveStatus }));
            }
            return;
        }

        if (urlPath === '/live/stop') {
            await stopLiveViewProcess();
            liveStatus.running = false;
            liveStatus.pid = null;
            liveStatus.playlist = fs.existsSync(path.join(HLS_DIR, 'live.m3u8'));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
            res.end(JSON.stringify({ ok:true, status: liveStatus }));
            return;
        }

        if (urlPath === '/live/last-session') {
            liveStatus.playlist = fs.existsSync(path.join(HLS_DIR, 'live.m3u8'));
            let session = null;
            if (liveStatus.session_file) {
                const raw = safeJson(liveStatus.session_file);
                if (raw) {
                    session = {
                        device_id: raw.device_id,
                        device_type: raw.device_type,
                        command_id: raw.command_id,
                        state_condition: raw.state_condition,
                        status_msg: raw.status_msg,
                        server_present: !!raw.server,
                        token_present: !!raw.liveview_token
                    };
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
            res.end(JSON.stringify({ status: liveStatus, session: session }, null, 2));
            return;
        }

        if (urlPath === '/live-player') {
            const html = String.raw`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blink LiveView</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.20/hls.min.js"></script>
<style>
html, body { margin:0; padding:0; width:100%; height:100%; background:#000; overflow:hidden; }
body { display:flex; align-items:center; justify-content:center; }
video { width:100%; height:100%; background:#000; object-fit:contain; }
.status { position:absolute; left:8px; bottom:8px; color:#fff; background:rgba(0,0,0,.68); padding:4px 8px; border-radius:6px; font:12px system-ui,-apple-system,sans-serif; max-width:calc(100% - 16px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; z-index:5; }
</style>
</head>
<body>
<video id="v" controls autoplay muted playsinline></video>
<div class="status" id="s">Warte auf LiveView-Playlist…</div>
<script>
(function(){
  const video = document.getElementById('v');
  const statusEl = document.getElementById('s');
  const manifestUrl = '/live-hls/live.m3u8';
  let hls = null;
  let manifestAttempts = 0;
  let started = false;

  function setStatus(t) {
    statusEl.style.display = '';
    statusEl.textContent = t;
  }

  function hideStatusSoon() {
    setTimeout(function(){ statusEl.style.display = 'none'; }, 2500);
  }

  async function waitForManifest() {
    manifestAttempts++;
    setStatus('Warte auf Playlist… ' + manifestAttempts);

    try {
      const r = await fetch(manifestUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      if (txt.indexOf('#EXTM3U') < 0) throw new Error('keine M3U8');
      if (txt.indexOf('#EXTINF') < 0 || txt.indexOf('.ts') < 0) throw new Error('noch keine Segmente');
      startPlayer();
      return;
    } catch (e) {
      if (manifestAttempts < 80) {
        setTimeout(waitForManifest, 500);
      } else {
        setStatus('Playlist nicht verfügbar: ' + (e && e.message ? e.message : e));
      }
    }
  }

  function playVideo() {
    video.muted = true;
    video.controls = true;
    video.play().then(function(){
      setStatus('LiveView läuft');
      hideStatusSoon();
    }).catch(function(){
      setStatus('Autoplay blockiert – bitte ins Video klicken');
    });
  }

  function destroyHls() {
    if (hls) {
      try { hls.destroy(); } catch(e) {}
      hls = null;
    }
  }

  function restartSoon(reason) {
    setStatus('HLS Neustart: ' + reason);
    destroyHls();
    started = false;
    manifestAttempts = 0;
    setTimeout(waitForManifest, 1000);
  }

  function startPlayer() {
    if (started) return;
    started = true;
    const url = manifestUrl + '?t=' + Date.now();

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: false,
        liveSyncDurationCount: 4,
        liveMaxLatencyDurationCount: 8,
        maxLiveSyncPlaybackRate: 1.0,
        backBufferLength: 20,
        maxBufferLength: 20,
        maxMaxBufferLength: 30,
        enableWorker: true,
        startFragPrefetch: true,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 20,
        manifestLoadingRetryDelay: 500,
        manifestLoadingMaxRetryTimeout: 5000,
        levelLoadingMaxRetry: 20,
        levelLoadingRetryDelay: 500,
        fragLoadingMaxRetry: 12,
        fragLoadingRetryDelay: 500
      });

      hls.on(Hls.Events.MEDIA_ATTACHED, function () {
        setStatus('Player verbunden, lade Manifest…');
        hls.loadSource(url);
      });

      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        setStatus('Manifest geladen');
        playVideo();
      });

      hls.on(Hls.Events.ERROR, function (event, data) {
        console.warn('HLS Fehler:', data);
        const details = data && data.details ? data.details : 'Fehler';
        setStatus('HLS: ' + details);

        if (details === 'bufferStalledError') {
          try { hls.startLoad(-1); } catch(e) {}
          try { video.play().catch(function(){}); } catch(e) {}
          return;
        }

        if (details === 'manifestLoadError' || details === 'manifestLoadTimeOut') {
          if (data && data.fatal) restartSoon(details);
          return;
        }

        if (data && data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            try { hls.startLoad(); } catch(e) { restartSoon(details); }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try { hls.recoverMediaError(); } catch(e) { restartSoon(details); }
          } else {
            restartSoon(details);
          }
        }
      });

      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      playVideo();
    } else {
      setStatus('HLS wird nicht unterstützt');
    }
  }

  video.addEventListener('click', function(){ video.play().catch(function(){}); });
  video.addEventListener('playing', function(){ setStatus('LiveView läuft'); hideStatusSoon(); });
  video.addEventListener('waiting', function(){ setStatus('Puffert…'); });
  video.addEventListener('error', function(){ setStatus('Video-Fehler'); });

  waitForManifest();
})();
</script>
</body>
</html>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
            res.end(html);
            return;
        }

        if (urlPath === '/grid' || urlPath === '/grid.html' || urlPath === '/' || urlPath === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
            res.end(GRID_PAGE);
            return;
        }

        if (urlPath.startsWith('/live-hls/')) {
            const filename = decodeURIComponent(urlPath.slice('/live-hls/'.length));
            if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) { res.writeHead(403); res.end('Forbidden'); return; }
            const ext = path.extname(filename).toLowerCase();
            const type = ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : (ext === '.ts' ? 'video/mp2t' : 'application/octet-stream');
            serveFile(req, res, path.join(HLS_DIR, filename), type, true);
            return;
        }

        if (urlPath.startsWith(VIDEO_BASE)) {
            const filename = decodeURIComponent(urlPath.slice(VIDEO_BASE.length));
            if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) { res.writeHead(403); res.end('Forbidden'); return; }
            const fullPath = path.join(ROOT_DIR, filename);
            if (!fullPath.startsWith(ROOT_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
            const ext = path.extname(filename).toLowerCase();
            serveFile(req, res, fullPath, MIME[ext] || 'application/octet-stream', ext === '.mp4');
            return;
        }

        res.writeHead(404); res.end('Not Found');
    } catch (e) {
        log('Server-Request Fehler: ' + (e.stack || e.message || e), 'error');
        try { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Server error: ' + (e.message || e)); } catch (ignore) {}
    }
});

server.listen(PORT, () => {
    log(`Blink-Server läuft: http://<host>:${PORT}/grid`);
});
server.on('error', (err) => log(`Blink-Server Fehler: ${err.message}`, 'error'));

globalThis.__blinkServer = server;

onStop(() => {
    if (server) { server.close(); log('Blink-Server gestoppt'); }
    try { stopLiveViewProcess(); } catch (e) {}
}, 2000);

```
</details>

# Blink Adapter: Datapoints

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

### 0.0.6 (2026-04-28)
* Blink PanTilt and Blink Mini - temperature_text and battery_text set to "not available" because of no built in temperature and battery indicator
* blink.0.xxx.xxx.status.wifi_strength fixed

## License

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
