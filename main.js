'use strict';
/*
 * Created with @iobroker/create-adapter v3.1.2
 */

const utils = require('@iobroker/adapter-core');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const blinkApi = require('./lib/blink-api');
const { MjpegServer } = require('./lib/mjpeg-server');

class BlinkAdapter extends utils.Adapter {
	constructor(options = {}) {
		super({ ...options, name: 'blink' });
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.pollTimer = null;
		this.liveTimer = null;
		this.liveInProgress = false;
		this.liveSnapshotCursor = 0;
		this.videoSyncInProgress = false;
		this.videoCheckCooldownMs = 25 * 1000;
		this.lastVideoCheckByDevId = new Map();
		this.camerasById = new Map();
		this.syncById = new Map();
		this.session = null;
		this.mjpegServer = null;
		this.mjpegStatusTimer = null;

		// Neues Gerüst für echten 30s-Livestream (später Blink-App-Liveview / RTSP/HLS)
		this.liveSessions = new Map();
		this.liveStopTimers = new Map();
		this.liveProcesses = new Map();
		this.hlsServer = null;
	}

	async onReady() {
		const debugLogEnabled = this.config.debugLogEnabled === true;
		blinkApi.setDebugEnabled(debugLogEnabled);

		try {
			fs.rmSync('/tmp/blink_debug.log', { force: true });
		} catch {
			// Datei existiert evtl. nicht – das ist kein Fehler.
		}

		this.setState('info.connection', false, true);

		const email = (this.config.email || '').trim();
		const password = this.config.password || '';
		const pin = this.config.pin || '';
		const pollIntervalSec = Math.max(15, Number(this.config.pollIntervalSec) || 60);
		const snapshotDir = (this.config.snapshotDir || '/opt/iobroker/iobroker-data/blink').trim();
		const liveSnapshotEnabled = this.config.liveSnapshotEnabled !== false;
		const liveSnapshotIntervalSec = Math.max(5, Number(this.config.liveSnapshotIntervalSec) || 30);
		const storeBase64 = this.config.storeBase64 !== false;
		const cleanupOldSnapshots = this.config.cleanupOldSnapshots !== false;
		const maxSnapshotAgeHours = Math.max(1, Number(this.config.maxSnapshotAgeHours) || 24);
		const batteryWarningEnabled = this.config.batteryWarningEnabled === true;
		const batteryWarningThresholdVolt = Number(this.config.batteryWarningThresholdVolt) || 1.1;
		const batteryWarningPushoverInst = (this.config.batteryWarningPushoverInstance || 'pushover.0').trim();
		const batteryWarningCooldownHours = Math.max(1, Number(this.config.batteryWarningCooldownHours) || 24);

		// MJPEG-Streaming-Konfiguration (alle Felder optional, Streaming ist opt-in)
		const streamEnabled = this.config.streamEnabled === true;
		const streamPort = Math.max(1024, Math.min(65535, Number(this.config.streamPort) || 8089));
		const hlsPort = Math.max(1024, Math.min(65535, Number(this.config.hlsPort) || (streamPort + 1)));
		let streamToken = (this.config.streamToken || '').trim();
		const streamPublicHost = (this.config.streamPublicHost || '').trim();
		const streamWiredIntervalSec = Math.max(5, Number(this.config.streamWiredIntervalSec) || 8);
		const streamBatteryIntervalSec = Math.max(8, Number(this.config.streamBatteryIntervalSec) || 10);
		const streamBatteryIdleTimeoutSec = Math.max(15, Number(this.config.streamBatteryIdleTimeoutSec) || 60);
		const streamBatteryMinLevel = Math.max(0, Math.min(3, this.toNum(this.config.streamBatteryMinLevel) ?? 2));
		const ffmpegPath = (this.config.ffmpegPath || '').trim();

		// Token automatisch generieren, wenn leer und Streaming aktiv – und in
		// der eigenen Adapter-Konfiguration persistieren, damit der Token nach
		// einem Restart stabil bleibt und in der Admin-UI erscheint.
		if (streamEnabled && !streamToken) {
			streamToken = crypto.randomBytes(16).toString('hex');
			this.log.info('Stream-Token wurde automatisch generiert und in der Adapter-Konfiguration gespeichert.');
			try {
				await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
					native: { streamToken },
				});
			} catch (e) {
				this.log.warn(
					`Stream-Token konnte nicht persistiert werden – beim n\u00e4chsten Restart wird ein neuer generiert: ${e?.message || e}`,
				);
			}
		}

		this.cfg = {
			email,
			password,
			pin,
			pollIntervalSec,
			snapshotDir,
			liveSnapshotEnabled,
			liveSnapshotIntervalSec,
			storeBase64,
			cleanupOldSnapshots,
			maxSnapshotAgeHours,
			batteryWarningEnabled,
			batteryWarningThresholdVolt,
			batteryWarningPushoverInst,
			batteryWarningCooldownHours,
			streamEnabled,
			streamPort,
			hlsPort,
			streamToken,
			streamPublicHost,
			streamWiredIntervalSec,
			streamBatteryIntervalSec,
			streamBatteryIdleTimeoutSec,
			streamBatteryMinLevel,
			ffmpegPath,
		};

		if (!email || !password) {
			this.log.error('Bitte E-Mail und Passwort in der Konfiguration eintragen.');
			return;
		}

		try {
			fs.mkdirSync(snapshotDir, { recursive: true });
		} catch {
			// Verzeichnis existiert bereits oder kann nicht angelegt werden – beim Schreiben fällt das ohnehin auf.
		}

		await this.setObjectNotExistsAsync('info.connection', {
			type: 'state',
			common: { name: 'Connected', type: 'boolean', role: 'indicator.connected', read: true, write: false },
			native: {},
		});

		this.subscribeStates('cameras.*.commands.*');
		this.subscribeStates('sync.*.commands.*');

		try {
			this.session = await blinkApi.getSession(email, password, pin);
			await this.pollOnce();
			if (cleanupOldSnapshots) {
				this.cleanupSnapshots();
			}
			this.setState('info.connection', true, true);
			if (this.cfg.streamEnabled) {
				await this.startMjpegServer();
			}
		} catch (e) {
			this.log.error(`Initialer Connect/Poll fehlgeschlagen: ${e?.message || e}`);
			this.setState('info.connection', false, true);
		}

		this.pollTimer = setInterval(async () => {
			try {
				this.session = await blinkApi.getSession(email, password, pin);
				await this.pollOnce();
			} catch (err) {
				this.log.warn(`Poll-Fehler: ${err?.message || err}`);
				this.setState('info.connection', false, true);
			}
		}, pollIntervalSec * 1000);

		if (liveSnapshotEnabled) {
			this.liveTimer = setInterval(
				() => this.updateLiveSnapshots().catch(e => this.log.warn(`Live-Snapshot-Fehler: ${e?.message || e}`)),
				liveSnapshotIntervalSec * 1000,
			);
		}
	}

	findSyncIdForNetwork(networkId) {
		for (const mod of this.syncById.values()) {
			if (String(mod?.network_id) === String(networkId)) {
				return mod?.sync_id || null;
			}
		}
		return null;
	}

	async pollOnce() {
		const { cameras, syncModules } = await blinkApi.getDevices(this.session);

		for (const mod of syncModules) {
			const devId = this.sanitizeId(mod.id || mod.name);
			const base = `sync.${devId}`;
			this.syncById.set(devId, mod);

			await this.ensureSyncObjects(base, mod);
			await this.setSyncStates(base, mod);
		}

		for (const cam of cameras) {
			const devId = this.sanitizeId(cam.id || cam.name);
			const base = `cameras.${devId}`;
			this.camerasById.set(devId, cam);

			await this.ensureDeviceObjects(base, cam);
			await this.setCameraStates(base, cam, devId);
		}

		await this.syncLatestCloudVideos(cameras);
		this.setState('info.connection', true, true);

		if (this.mjpegServer) {
			await this.refreshMjpegCameraRegistry();
		}
	}

	async ensureDeviceObjects(base, cam) {
		await this.setObjectNotExistsAsync(base, {
			type: 'device',
			common: { name: cam.name || base },
			native: { blinkId: cam.id },
		});
		for (const ch of ['info', 'status', 'battery', 'commands', 'video', 'live']) {
			await this.setObjectNotExistsAsync(`${base}.${ch}`, { type: 'channel', common: { name: ch }, native: {} });
		}

		await this.ensureState(`${base}.info.name`, 'Name', 'string', 'text', false);
		await this.ensureState(`${base}.info.serial`, 'Serial', 'string', 'text', false);
		await this.ensureState(`${base}.info.network_id`, 'Netzwerk-ID', 'number', 'value', false);

		await this.ensureState(`${base}.status.battery`, 'Batterie (V)', 'number', 'value.battery', false);
		await this.ensureState(`${base}.status.battery_raw`, 'Batterie roh', 'number', 'value', false);
		await this.ensureState(`${base}.status.battery_volt`, 'Batteriespannung (V)', 'number', 'value.voltage', false);
		await this.ensureState(`${base}.status.battery_text`, 'Batterie Hinweis', 'string', 'text', false);
		await this.ensureState(`${base}.status.temperature`, 'Temperatur (°C)', 'number', 'value.temperature', false);
		await this.ensureState(`${base}.status.temperature_f`, 'Temperatur (°F)', 'number', 'value.temperature', false);
		await this.ensureState(`${base}.status.temperature_text`, 'Temperatur Hinweis', 'string', 'text', false);
		await this.ensureState(`${base}.status.wifi_strength`, 'WLAN-Stärke', 'number', 'value.signal', false);
		await this.ensureState(
			`${base}.status.motion_detect_enabled`,
			'Bewegungserkennung',
			'boolean',
			'switch.enable',
			false,
		);
		await this.ensureState(`${base}.status.armed`, 'Scharf (System)', 'boolean', 'indicator.armed', false);
		await this.ensureState(`${base}.status.last_update`, 'Letztes Update', 'string', 'date', false);
		await this.ensureState(
			`${base}.status.smart_detection`,
			'Smart Detection aktiv',
			'boolean',
			'indicator',
			false,
		);
		await this.ensureState(`${base}.status.person_detected`, 'Person erkannt', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.status.vehicle_detected`, 'Fahrzeug erkannt', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.status.animal_detected`, 'Tier erkannt', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.status.package_detected`, 'Paket erkannt', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.status.detection_type`, 'Erkennungstyp', 'string', 'text', false);
		await this.ensureState(
			`${base}.status.smart_detection_raw`,
			'Smart Detection Rohdaten',
			'string',
			'json',
			false,
		);
		await this.ensureState(`${base}.status.motion_source`, 'Bewegungsquelle', 'string', 'text', false);

		await this.ensureState(`${base}.battery.low`, 'Batterie niedrig', 'boolean', 'indicator.warning', false);
		await this.ensureState(`${base}.battery.lastWarning`, 'Letzter Hinweis', 'string', 'date', false);
		await this.ensureState(`${base}.battery.warningSent`, 'Warnung gesendet', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.battery.lastMessage`, 'Letzter Warnhinweis-Text', 'string', 'text', false);

		await this.ensureState(
			`${base}.commands.motion_detect`,
			'Bewegungserkennung setzen',
			'boolean',
			'switch.enable',
			true,
		);
		await this.ensureState(`${base}.commands.snapshot`, 'Snapshot auslösen', 'boolean', 'button', true);
		await this.ensureState(`${base}.commands.snapshot_file`, 'Letzter Snapshot-Pfad', 'string', 'text', false);
		await this.ensureState(`${base}.commands.fetch_video`, 'Neuestes MP4 laden', 'boolean', 'button', true);
		await this.ensureState(`${base}.commands.clear_session`, 'Session-Cache löschen', 'boolean', 'button', true);

		await this.ensureState(`${base}.video.file`, 'MP4-Datei', 'string', 'text', false);
		await this.ensureState(`${base}.video.timestamp`, 'MP4-Zeitstempel', 'string', 'date', false);
		await this.ensureState(`${base}.video.id`, 'MP4 Cloud-ID', 'string', 'text', false);
		await this.ensureState(`${base}.video.size`, 'MP4-Dateigröße', 'number', 'value', false);
		await this.ensureState(`${base}.video.ready`, 'MP4 bereit', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.video.lastError`, 'MP4 letzter Fehler', 'string', 'text', false);

		// Galerie: 10 Slots pro Kamera (0 = neuester, 9 = ältester)
		for (let i = 0; i < 10; i++) {
			await this.ensureState(
				`${base}.video.history.${i}.file`,
				`History ${i} – MP4-Datei`,
				'string',
				'text',
				false,
			);
			await this.ensureState(
				`${base}.video.history.${i}.timestamp`,
				`History ${i} – Zeitstempel`,
				'string',
				'date',
				false,
			);
			await this.ensureState(`${base}.video.history.${i}.id`, `History ${i} – Clip-ID`, 'string', 'text', false);
			await this.ensureState(
				`${base}.video.history.${i}.source`,
				`History ${i} – Quelle (cloud|local_storage)`,
				'string',
				'text',
				false,
			);
		}

		await this.ensureState(`${base}.live.file`, 'Live-Snapshot Datei', 'string', 'text', false);
		await this.ensureState(`${base}.live.image_base64`, 'Live-Snapshot Base64', 'string', 'text', false);
		await this.ensureState(`${base}.live.mime_type`, 'Bild MIME-Typ', 'string', 'text', false);
		await this.ensureState(`${base}.live.timestamp`, 'Live-Snapshot Zeitstempel', 'string', 'date', false);
		await this.ensureState(`${base}.live.stream_url`, 'MJPEG-Stream URL', 'string', 'text.url', false);
		await this.ensureState(
			`${base}.live.stream_active`,
			'Stream wird aktuell gepollt',
			'boolean',
			'indicator',
			false,
		);
		await this.ensureState(
			`${base}.commands.live_request`,
			'Stream-Polling manuell aktivieren (60s)',
			'boolean',
			'button',
			true,
		);

		// Neues Gerüst für echten 30s-Livestream
		await this.ensureState(`${base}.live.mode`, 'Live-Modus', 'string', 'text', false);
		await this.ensureState(`${base}.live.active`, 'Echte Live-Session aktiv', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.live.url`, 'Live-URL', 'string', 'text.url', false);
		await this.ensureState(`${base}.live.expires_at`, 'Live läuft bis', 'string', 'date', false);
		await this.ensureState(`${base}.live.last_error`, 'Letzter Live-Fehler', 'string', 'text', false);
		await this.ensureState(`${base}.live.session_id`, 'Live Session-ID', 'string', 'text', false);
		await this.ensureState(`${base}.live.backend`, 'Live Backend', 'string', 'text', false);

		await this.ensureState(`${base}.commands.start_live`, 'Echten Live-Stream starten', 'boolean', 'button', true);
		await this.ensureState(`${base}.commands.stop_live`, 'Echten Live-Stream stoppen', 'boolean', 'button', true);

		await this.initStateIfUnset(`${base}.status.armed`, false);
		await this.initStateIfUnset(`${base}.status.battery_text`, '');
		await this.initStateIfUnset(`${base}.status.temperature_text`, '');
		await this.initStateIfUnset(`${base}.status.smart_detection`, false);
		await this.initStateIfUnset(`${base}.status.person_detected`, false);
		await this.initStateIfUnset(`${base}.status.vehicle_detected`, false);
		await this.initStateIfUnset(`${base}.status.animal_detected`, false);
		await this.initStateIfUnset(`${base}.status.package_detected`, false);
		await this.initStateIfUnset(`${base}.status.detection_type`, '');
		await this.initStateIfUnset(`${base}.status.smart_detection_raw`, '');
		await this.initStateIfUnset(`${base}.status.motion_source`, '');
		await this.initStateIfUnset(`${base}.battery.low`, false);
		await this.initStateIfUnset(`${base}.battery.lastWarning`, '');
		await this.initStateIfUnset(`${base}.battery.warningSent`, false);
		await this.initStateIfUnset(`${base}.battery.lastMessage`, '');
		await this.initStateIfUnset(`${base}.commands.motion_detect`, false);
		await this.initStateIfUnset(`${base}.commands.snapshot`, false);
		await this.initStateIfUnset(`${base}.commands.snapshot_file`, '');
		await this.initStateIfUnset(`${base}.commands.fetch_video`, false);
		await this.initStateIfUnset(`${base}.commands.clear_session`, false);
		await this.initStateIfUnset(`${base}.video.file`, '');
		await this.initStateIfUnset(`${base}.video.timestamp`, '');
		await this.initStateIfUnset(`${base}.video.id`, '');
		await this.initStateIfUnset(`${base}.video.size`, 0);
		await this.initStateIfUnset(`${base}.video.ready`, false);
		await this.initStateIfUnset(`${base}.video.lastError`, '');
		for (let i = 0; i < 10; i++) {
			await this.initStateIfUnset(`${base}.video.history.${i}.file`, '');
			await this.initStateIfUnset(`${base}.video.history.${i}.timestamp`, '');
			await this.initStateIfUnset(`${base}.video.history.${i}.id`, '');
			await this.initStateIfUnset(`${base}.video.history.${i}.source`, '');
		}
		await this.initStateIfUnset(`${base}.live.file`, '');
		await this.initStateIfUnset(`${base}.live.image_base64`, '');
		await this.initStateIfUnset(`${base}.live.mime_type`, '');
		await this.initStateIfUnset(`${base}.live.timestamp`, '');
		await this.initStateIfUnset(`${base}.live.stream_url`, '');
		await this.initStateIfUnset(`${base}.live.stream_active`, false);
		await this.initStateIfUnset(`${base}.commands.live_request`, false);

		await this.initStateIfUnset(`${base}.live.mode`, 'idle');
		await this.initStateIfUnset(`${base}.live.active`, false);
		await this.initStateIfUnset(`${base}.live.url`, '');
		await this.initStateIfUnset(`${base}.live.expires_at`, '');
		await this.initStateIfUnset(`${base}.live.last_error`, '');
		await this.initStateIfUnset(`${base}.live.session_id`, '');
		await this.initStateIfUnset(`${base}.live.backend`, '');
		await this.initStateIfUnset(`${base}.commands.start_live`, false);
		await this.initStateIfUnset(`${base}.commands.stop_live`, false);
	}

	async setCameraStates(base, cam, devId) {
		await this.setStateAsync(`${base}.info.name`, String(cam.name || ''), true);
		await this.setStateAsync(`${base}.info.serial`, String(cam.serial || ''), true);
		await this.setNumStateIfValid(`${base}.info.network_id`, cam.network_id);

		const apiType = String(cam.apiType || '').toLowerCase();
		const nameLc = String(cam.name || '').toLowerCase();
		const serialLc = String(cam.serial || '').toLowerCase();

		await this.setNumStateIfValid(`${base}.status.battery`, cam.battery_volt);
		await this.setNumStateIfValid(`${base}.status.battery_raw`, cam.battery_raw);
		await this.setNumStateIfValid(`${base}.status.battery_volt`, cam.battery_volt);

		const batteryVolt = this.toNum(cam.battery_volt);
		const batteryRaw = this.toNum(cam.battery_raw);

		const noBatteryDevice =
			apiType === 'owl' ||
			apiType === 'mini' ||
			nameLc.includes('pantilt') ||
			nameLc.includes('pan tilt') ||
			nameLc.includes('blink mini') ||
			nameLc.includes('mini') ||
			serialLc.includes('mini');

		const noBatteryData =
			(batteryVolt === null && batteryRaw === null) ||
			((batteryVolt === 0 || batteryVolt === null) && (batteryRaw === 0 || batteryRaw === null));

		if (noBatteryDevice && noBatteryData) {
			await this.setStateAsync(`${base}.status.battery`, { val: null, ack: true });
			await this.setStateAsync(`${base}.status.battery_raw`, { val: null, ack: true });
			await this.setStateAsync(`${base}.status.battery_volt`, { val: null, ack: true });
			await this.setStateAsync(`${base}.status.battery_text`, 'not available', true);
		} else {
			await this.setStateAsync(`${base}.status.battery_text`, '', true);
		}

		const tempC = this.toNum(cam.temperature);
		const tempF = this.toNum(cam.temperature_f);

		const noTemperatureDevice =
			apiType === 'owl' ||
			apiType === 'mini' ||
			nameLc.includes('pantilt') ||
			nameLc.includes('pan tilt') ||
			nameLc.includes('blink mini') ||
			nameLc.includes('mini') ||
			serialLc.includes('mini');

		const noTemperatureData =
			(tempC === null && tempF === null) || ((tempC === 0 || tempC === null) && (tempF === 0 || tempF === null));

		const doorbellNoTemp =
			apiType === 'doorbell' &&
			((tempC === null && tempF === null) ||
				((tempC === 0 || tempC === null) && (tempF === 0 || tempF === null)));

		if (doorbellNoTemp || (noTemperatureDevice && noTemperatureData)) {
			await this.setStateAsync(`${base}.status.temperature`, { val: null, ack: true });
			await this.setStateAsync(`${base}.status.temperature_f`, { val: null, ack: true });
			await this.setStateAsync(`${base}.status.temperature_text`, 'not available', true);
		} else {
			if (tempC !== null) {
				await this.setStateAsync(`${base}.status.temperature`, tempC, true);
			}
			if (tempF !== null) {
				await this.setStateAsync(`${base}.status.temperature_f`, tempF, true);
			}
			await this.setStateAsync(`${base}.status.temperature_text`, '', true);
		}

		await this.setNumStateIfValid(`${base}.status.wifi_strength`, cam.wifi_strength);
		await this.setBoolStateIfDefined(`${base}.status.motion_detect_enabled`, cam.motion_detect_enabled);
		await this.setStateAsync(`${base}.status.smart_detection`, !!cam.smart_detection, true);
		await this.setStateAsync(`${base}.status.person_detected`, !!cam.person_detected, true);
		await this.setStateAsync(`${base}.status.vehicle_detected`, !!cam.vehicle_detected, true);
		await this.setStateAsync(`${base}.status.animal_detected`, !!cam.animal_detected, true);
		await this.setStateAsync(`${base}.status.package_detected`, !!cam.package_detected, true);
		await this.setStateAsync(`${base}.status.detection_type`, String(cam.detection_type || ''), true);
		await this.setStateAsync(`${base}.status.smart_detection_raw`, String(cam.smart_detection_raw || ''), true);
		await this.setStateAsync(`${base}.status.motion_source`, String(cam.motion_source || ''), true);

		const sync = [...this.syncById.values()].find(mod => String(mod?.network_id) === String(cam?.network_id));
		const effectiveArmed = cam.armed != null ? cam.armed : sync?.armed != null ? sync.armed : null;
		if (effectiveArmed != null) {
			await this.setStateAsync(`${base}.status.armed`, !!effectiveArmed, true);
		}

		if (cam.updated != null) {
			await this.setStateAsync(`${base}.status.last_update`, String(cam.updated || ''), true);
		}

		await this.checkBatteryWarning(devId, cam);

		if (cam.motion_detect_enabled != null) {
			await this.setStateAsync(`${base}.commands.motion_detect`, !!cam.motion_detect_enabled, true);
		}

		await this.setStateAsync(`${base}.commands.fetch_video`, false, true);
		await this.setStateAsync(`${base}.commands.start_live`, false, true);
		await this.setStateAsync(`${base}.commands.stop_live`, false, true);
	}

	async ensureSyncObjects(base, mod) {
		await this.setObjectNotExistsAsync(base, {
			type: 'device',
			common: { name: mod.name || base },
			native: { blinkId: mod.id },
		});
		for (const ch of ['info', 'status', 'commands']) {
			await this.setObjectNotExistsAsync(`${base}.${ch}`, { type: 'channel', common: { name: ch }, native: {} });
		}

		await this.ensureState(`${base}.info.name`, 'Name', 'string', 'text', false);
		await this.ensureState(`${base}.info.serial`, 'Serial', 'string', 'text', false);
		await this.ensureState(`${base}.status.armed`, 'Scharf', 'boolean', 'indicator.armed', false);
		await this.ensureState(`${base}.status.last_update`, 'Letztes Update', 'string', 'date', false);
		await this.ensureState(`${base}.commands.armed`, 'Scharf/Unscharf', 'boolean', 'switch.enable', true);

		await this.initStateIfUnset(`${base}.commands.armed`, false);
	}

	async setSyncStates(base, mod) {
		await this.setStateAsync(`${base}.info.name`, String(mod.name || ''), true);
		await this.setStateAsync(`${base}.info.serial`, String(mod.serial || ''), true);
		await this.setBoolStateIfDefined(`${base}.status.armed`, mod.armed);

		if (mod.updated != null) {
			await this.setStateAsync(`${base}.status.last_update`, String(mod.updated || ''), true);
		}
		if (mod.armed != null) {
			await this.setStateAsync(`${base}.commands.armed`, !!mod.armed, true);
		}
	}

	async updateLiveSnapshots() {
		if (this.liveInProgress || !this.session) {
			return;
		}
		this.liveInProgress = true;
		try {
			const cams = [...this.camerasById.entries()].filter(([, cam]) => !!cam?.id);
			if (cams.length === 0) {
				return;
			}

			const index = this.liveSnapshotCursor % cams.length;
			this.liveSnapshotCursor = (index + 1) % cams.length;

			const [devId, cam] = cams[index];
			const file = path.join(this.cfg.snapshotDir, `${devId}_live.jpg`);

			try {
				await blinkApi.snapshot(this.session, cam.network_id, cam.id, cam.thumbnail, file, cam.apiType);
				await this.setLiveStates(devId, file);
				if (this.mjpegServer) {
					try {
						const buf = fs.readFileSync(file);
						this.mjpegServer.pushSnapshot(devId, buf);
					} catch {
						// Cache-Push ist optional – Fehler nicht eskalieren.
					}
				}
			} catch (e) {
				const msg = String(e?.message || e);
				if (msg.includes('HTTP 409') && msg.includes('System is busy')) {
					this.log.debug(`Live-Snapshot übersprungen für ${cam.name}: ${msg}`);
				} else {
					this.log.warn(`Live-Snapshot Fehler für ${cam.name}: ${msg}`);
				}
			}

			if (this.cfg.cleanupOldSnapshots) {
				this.cleanupSnapshots();
			}
		} finally {
			this.liveInProgress = false;
		}
	}

	async setLiveStates(devId, file) {
		const base = `cameras.${devId}`;
		await this.setStateAsync(`${base}.commands.snapshot_file`, file, true);
		await this.setStateAsync(`${base}.live.file`, file, true);
		await this.setStateAsync(`${base}.live.mime_type`, 'image/jpeg', true);
		await this.setStateAsync(`${base}.live.timestamp`, new Date().toISOString(), true);

		if (this.cfg.storeBase64) {
			try {
				const b64 = fs.readFileSync(file).toString('base64');
				await this.setStateAsync(`${base}.live.image_base64`, `data:image/jpeg;base64,${b64}`, true);
			} catch {
				// base64-State ist optional – Lesefehler nicht eskalieren.
			}
		}
	}

	resolveStreamHost() {
		const override = (this.cfg.streamPublicHost || '').trim();
		if (override) {
			return override;
		}
		try {
			const hn = (os.hostname() || '').trim();
			if (hn && hn.toLowerCase() !== 'localhost') {
				return hn;
			}
		} catch {
			// Hostname-Auflösung fehlgeschlagen – weiter mit IP-Detection.
		}
		try {
			const ifaces = os.networkInterfaces();
			for (const list of Object.values(ifaces)) {
				for (const addr of list || []) {
					if (addr.family === 'IPv4' && !addr.internal && addr.address) {
						return addr.address;
					}
				}
			}
		} catch {
			// Netzwerk-Interfaces nicht ermittelbar.
		}
		return 'localhost';
	}


	async startHlsServer() {
		if (this.hlsServer) {
			return;
		}
		const port = Number(this.cfg.hlsPort) || (Number(this.cfg.streamPort) + 1) || 8090;
		const rootDir = path.join(this.cfg.snapshotDir, 'live');
		const MIME = {
			'.m3u8': 'application/vnd.apple.mpegurl',
			'.ts': 'video/mp2t',
			'.m4s': 'video/iso.segment',
			'.mp4': 'video/mp4',
		};

		this.hlsServer = http.createServer((req, res) => {
			try {
				res.setHeader('Access-Control-Allow-Origin', '*');
				res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
				if (req.method === 'OPTIONS') {
					res.writeHead(204);
					res.end();
					return;
				}

				const u = new URL(req.url, `http://127.0.0.1:${port}`);
				const m = u.pathname.match(/^\/live\/([^/]+)\/([^/]+)$/);
				if (!m) {
					res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
					res.end('Not found');
					return;
				}
				const devId = decodeURIComponent(m[1]);
				const filename = decodeURIComponent(m[2]);
				if (!/^[A-Za-z0-9_.-]+$/.test(filename)) {
					res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
					res.end('Forbidden');
					return;
				}
				const filePath = path.join(rootDir, devId, filename);
				const normRoot = path.resolve(rootDir);
				const normPath = path.resolve(filePath);
				if (!normPath.startsWith(normRoot + path.sep) && normPath !== normRoot) {
					res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
					res.end('Forbidden');
					return;
				}
				fs.stat(normPath, (err, stat) => {
					if (err || !stat.isFile()) {
						res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
						res.end('File Not Found');
						return;
					}
					const ext = path.extname(filename).toLowerCase();
					res.writeHead(200, {
						'Content-Type': MIME[ext] || 'application/octet-stream',
						'Content-Length': stat.size,
						'Cache-Control': 'no-cache, no-store, must-revalidate',
						'Pragma': 'no-cache',
						'Expires': '0',
					});
					fs.createReadStream(normPath).pipe(res);
				});
			} catch (e) {
				res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end(String(e?.message || e));
			}
		});

		await new Promise((resolve, reject) => {
			this.hlsServer.once('error', reject);
			this.hlsServer.listen(port, () => resolve());
		});

		this.log.info(`HLS-Server: öffentliche URL-Basis http://${this.resolveStreamHost()}:${port}/live/`);
	}

	async stopHlsServer() {
		if (!this.hlsServer) {
			return;
		}
		const srv = this.hlsServer;
		this.hlsServer = null;
		await new Promise(resolve => {
			try {
				srv.close(() => resolve());
			} catch {
				resolve();
			}
		});
	}


	resolveFfmpegBinary() {
		const configured = String(this.config.ffmpegPath || this.cfg?.ffmpegPath || '').trim();
		if (configured && fs.existsSync(configured)) {
			return configured;
		}
		const candidates = [
			'/usr/bin/ffmpeg',
			'/usr/local/bin/ffmpeg',
			'/bin/ffmpeg',
		];
		for (const candidate of candidates) {
			try {
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			} catch {
				// ignore
			}
		}
		return 'ffmpeg';
	}

	async startMjpegServer() {
		if (this.mjpegServer) {
			return;
		}
		const publicHost = this.resolveStreamHost();
		this.log.info(`MJPEG-Server: öffentliche URL-Basis http://${publicHost}:${this.cfg.streamPort}/`);

		this.mjpegServer = new MjpegServer({
			adapter: this,
			port: this.cfg.streamPort,
			token: this.cfg.streamToken,
			publicHost,
			wiredIntervalSec: this.cfg.streamWiredIntervalSec,
			batteryIntervalSec: this.cfg.streamBatteryIntervalSec,
			batteryIdleTimeoutSec: this.cfg.streamBatteryIdleTimeoutSec,
			batteryMinLevel: this.cfg.streamBatteryMinLevel,
		});

		await this.refreshMjpegCameraRegistry();

		try {
			await this.mjpegServer.start();
		} catch (e) {
			this.log.error(`MJPEG-Server konnte nicht starten: ${e?.message || e}`);
			this.mjpegServer = null;
			return;
		}

		for (const devId of this.camerasById.keys()) {
			await this.setStateAsync(`cameras.${devId}.live.stream_url`, this.mjpegServer.streamUrl(devId), true);
		}

		this.mjpegStatusTimer = setInterval(() => {
			if (!this.mjpegServer) {
				return;
			}
			for (const devId of this.camerasById.keys()) {
				this.setStateAsync(`cameras.${devId}.live.stream_active`, this.mjpegServer.isActive(devId), true).catch(
					() => {},
				);
			}
		}, 5000);
	}

	async refreshMjpegCameraRegistry() {
		if (!this.mjpegServer) {
			return;
		}
		for (const [devId, cam] of this.camerasById.entries()) {
			if (!cam?.id || !cam?.network_id) {
				continue;
			}
			const apiType = String(cam.apiType || '').toLowerCase();
			const wired = apiType === 'owl' || apiType === 'mini' || apiType === 'doorbell';
			const meta = {
				name: cam.name || devId,
				apiType: apiType || 'camera',
				wired,
				batteryLevel: this.toNum(cam.battery_state) ?? null,
			};
			const fetchSnapshot = async () => {
				return await blinkApi.snapshotBuffer(this.session, cam.network_id, cam.id, cam.thumbnail, cam.apiType);
			};
			this.mjpegServer.registerCamera(devId, meta, fetchSnapshot);
		}
	}

	requestLive(devId) {
		if (!this.mjpegServer) {
			this.log.warn(`Stream-Anforderung ignoriert: MJPEG-Server nicht aktiv (${devId})`);
			return;
		}
		this.mjpegServer.manualWake(devId);
	}

	async setRealLiveStates(devId, patch = {}) {
		const base = `cameras.${devId}.live`;
		if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
			await this.setStateAsync(`${base}.mode`, String(patch.mode || ''), true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'active')) {
			await this.setStateAsync(`${base}.active`, !!patch.active, true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'url')) {
			await this.setStateAsync(`${base}.url`, String(patch.url || ''), true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'expires_at')) {
			await this.setStateAsync(`${base}.expires_at`, String(patch.expires_at || ''), true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'last_error')) {
			await this.setStateAsync(`${base}.last_error`, String(patch.last_error || ''), true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'session_id')) {
			await this.setStateAsync(`${base}.session_id`, String(patch.session_id || ''), true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'backend')) {
			await this.setStateAsync(`${base}.backend`, String(patch.backend || ''), true);
		}
	}

	async startHlsProxy(devId, live) {
		const { spawn } = require('node:child_process');
		await this.startHlsServer();
		const outDir = path.join(this.cfg.snapshotDir, 'live', devId);
		fs.mkdirSync(outDir, { recursive: true });
		const playlist = path.join(outDir, 'index.m3u8');

		try {
			for (const f of fs.readdirSync(outDir)) {
				fs.unlinkSync(path.join(outDir, f));
			}
		} catch {
			// ignore
		}

		const args = [
			'-rtsp_transport', 'tcp',
			'-i', String(live.sourceUrl || ''),
			'-an',
			'-c:v', 'copy',
			'-t', '30',
			'-f', 'hls',
			'-hls_time', '1',
			'-hls_list_size', '10',
			'-hls_flags', 'delete_segments+append_list+independent_segments',
			'-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'),
			playlist,
		];

		const ffmpegBin = this.resolveFfmpegBinary();
		let stderr = '';
		let spawnError = null;
		this.log.info(`ffmpeg live ${devId} starte: ${ffmpegBin}`);
		let proc;
		try {
			proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
		} catch (e) {
			throw new Error(`ffmpeg konnte nicht gestartet werden (${ffmpegBin}): ${e?.message || e}`);
		}
		proc.on('error', err => {
			spawnError = err;
		});
		proc.stderr.on('data', chunk => {
			stderr += String(chunk || '');
			if (stderr.length > 4000) {
				stderr = stderr.slice(-4000);
			}
		});
		proc.on('exit', code => {
			if (code && code !== 0) {
				this.log.warn(`ffmpeg live ${devId} exit=${code}: ${stderr.slice(-1000)}`);
			}
			this.liveProcesses.delete(devId);
		});
		this.liveProcesses.set(devId, proc);

		const start = Date.now();
		while (Date.now() - start < 10000) {
			if (spawnError) {
				throw new Error(`ffmpeg Startfehler (${ffmpegBin}): ${spawnError?.message || spawnError}`);
			}
			if (fs.existsSync(playlist)) {
				break;
			}
			if (proc.exitCode != null && proc.exitCode !== 0) {
				throw new Error(`ffmpeg beendet mit Code ${proc.exitCode}: ${stderr.slice(-500)}`);
			}
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		if (!fs.existsSync(playlist)) {
			throw new Error(`HLS-Playlist wurde nicht erzeugt: ${stderr.slice(-500)}`);
		}

		return `http://${this.resolveStreamHost()}:${this.cfg.hlsPort}/live/${encodeURIComponent(devId)}/index.m3u8`;
	}

	async startRealLive(devId) {
		const cam = this.camerasById.get(devId);
		if (!cam?.id || !cam?.network_id) {
			this.log.warn(`startRealLive: Kamera ${devId} nicht gefunden`);
			return;
		}

		await this.stopRealLive(devId, 'restart');

		await this.setRealLiveStates(devId, {
			mode: 'starting',
			active: false,
			url: '',
			expires_at: '',
			last_error: '',
			session_id: '',
			backend: '',
		});

		try {
			let backend = '';
			let publicUrl = '';
			let sessionId = '';
			let expiresAt = new Date(Date.now() + 30000).toISOString();

			let usedFallback = false;

			if (typeof blinkApi.startLiveView === 'function') {
				try {
					const live = await blinkApi.startLiveView(this.session, cam.network_id, cam.id, cam.apiType);
					backend = String(live?.backend || '');
					sessionId = String(live?.sessionId || '');
					expiresAt = String(live?.expiresAt || expiresAt);

					if (backend === 'blink_direct') {
						publicUrl = String(live?.sourceUrl || '');
					} else if (backend === 'rtsp_hls') {
						publicUrl = await this.startHlsProxy(devId, live);
					} else {
						throw new Error(`Unbekanntes Live-Backend: ${backend || 'leer'}`);
					}
				} catch (e) {
					this.log.warn(`startLiveView fehlgeschlagen, nutze MJPEG-Fallback für ${devId}: ${e?.message || e}`);
					usedFallback = true;
				}
			} else {
				usedFallback = true;
			}

			if (usedFallback) {
				if (!this.mjpegServer) {
					throw new Error('Weder echter Liveview noch MJPEG-Server verfügbar');
				}
				this.requestLive(devId);
				backend = 'mjpeg_fallback';
				publicUrl = this.mjpegServer.streamUrl(devId);
				sessionId = `mjpeg-${Date.now()}`;
				expiresAt = new Date(Date.now() + 30000).toISOString();
			}

			this.liveSessions.set(devId, {
				sessionId,
				backend,
				publicUrl,
				expiresAt,
				networkId: cam.network_id,
				cameraId: cam.id,
				apiType: cam.apiType || 'camera',
			});

			await this.setRealLiveStates(devId, {
				mode: 'running',
				active: true,
				url: publicUrl,
				expires_at: expiresAt,
				session_id: sessionId,
				backend,
			});

			const t = setTimeout(() => {
				this.stopRealLive(devId, 'timeout').catch(e =>
					this.log.warn(`stopRealLive timeout ${devId}: ${e?.message || e}`),
				);
			}, 30000);
			this.liveStopTimers.set(devId, t);
		} catch (e) {
			await this.setRealLiveStates(devId, {
				mode: 'error',
				active: false,
				last_error: e?.message || String(e),
			});
			this.log.warn(`startRealLive ${devId}: ${e?.message || e}`);
		}
	}

	async stopRealLive(devId, reason = 'manual') {
		const timer = this.liveStopTimers.get(devId);
		if (timer) {
			clearTimeout(timer);
			this.liveStopTimers.delete(devId);
		}

		const proc = this.liveProcesses.get(devId);
		if (proc) {
			try {
				proc.kill('SIGTERM');
			} catch {
				// ignore
			}
			this.liveProcesses.delete(devId);
		}

		const liveSession = this.liveSessions.get(devId);
		if (!liveSession) {
			await this.setRealLiveStates(devId, {
				mode: 'idle',
				active: false,
				url: '',
				expires_at: '',
				session_id: '',
				backend: '',
				last_error: '',
			});
			return;
		}

		await this.setRealLiveStates(devId, { mode: 'stopping' });

		try {
			if (liveSession.backend !== 'mjpeg_fallback' && typeof blinkApi.stopLiveView === 'function') {
				await blinkApi.stopLiveView(this.session, liveSession);
			}
		} catch (e) {
			this.log.debug(`stopLiveView ${devId}: ${e?.message || e}`);
		}

		this.liveSessions.delete(devId);
		await this.setRealLiveStates(devId, {
			mode: 'idle',
			active: false,
			url: '',
			expires_at: '',
			session_id: '',
			backend: '',
			last_error: reason === 'timeout' ? '' : '',
		});
	}

	async onStateChange(id, state) {
		if (!state || state.ack) {
			return;
		}
		if (!this.session) {
			this.log.warn('Noch nicht verbunden.');
			return;
		}

		const parts = id.split('.');
		const cmd = parts[parts.length - 1];
		const devId = parts[parts.length - 3];
		const group = parts[parts.length - 4];

		if (cmd === 'clear_session') {
			blinkApi.clearSession(this.cfg.email);
			this.log.info('Blink Session-Cache gelöscht.');
			await this.setStateAsync(this.stripNs(id), false, true);
			return;
		}

		try {
			if (group === 'cameras') {
				const cam = this.camerasById.get(devId);
				if (!cam) {
					throw new Error('Kamera unbekannt (warte auf nächsten Poll)');
				}

				if (cmd === 'start_live') {
					if (state.val !== true) {
						return;
					}
					await this.startRealLive(devId);
					await this.setStateAsync(this.stripNs(id), false, true);
				} else if (cmd === 'stop_live') {
					if (state.val !== true) {
						return;
					}
					await this.stopRealLive(devId, 'manual');
					await this.setStateAsync(this.stripNs(id), false, true);
				} else if (cmd === 'motion_detect') {
					const enable = state.val === true;
					await blinkApi.setMotion(this.session, cam.network_id, cam.id, enable, cam.apiType);
					await this.setStateAsync(`cameras.${devId}.status.motion_detect_enabled`, enable, true);
					await this.setStateAsync(this.stripNs(id), enable, true);
				} else if (cmd === 'snapshot') {
					if (state.val !== true) {
						return;
					}
					const file = path.join(this.cfg.snapshotDir, `${devId}.jpg`);
					await blinkApi.snapshot(this.session, cam.network_id, cam.id, cam.thumbnail, file, cam.apiType);
					await this.setLiveStates(devId, file);
					await this.setStateAsync(this.stripNs(id), false, true);
				} else if (cmd === 'fetch_video') {
					if (state.val !== true) {
						return;
					}
					const ts = new Date().toISOString().replace(/[:.]/g, '-');
					const file = path.join(this.cfg.snapshotDir, `${devId}_${ts}.mp4`);
					try {
						const res = await blinkApi.downloadLatestVideoSmart(
							this.session,
							cam.network_id,
							cam.id,
							cam.name,
							file,
							{ syncId: this.findSyncIdForNetwork(cam.network_id) },
						);
						await this.updateVideoStates(devId, res);
					} catch (e) {
						await this.setStateAsync(`cameras.${devId}.video.ready`, false, true);
						await this.setStateAsync(`cameras.${devId}.video.lastError`, String(e?.message || e), true);
						this.log.warn(`Video-Download fehlgeschlagen (${cam.name}): ${e?.message || e}`);
					}
					await this.setStateAsync(this.stripNs(id), false, true);
				} else if (cmd === 'live_request') {
					if (state.val !== true) {
						return;
					}
					this.requestLive(devId);
					await this.setRealLiveStates(devId, {
						mode: 'running',
						active: true,
						url: this.mjpegServer ? this.mjpegServer.streamUrl(devId) : '',
						expires_at: new Date(Date.now() + 30000).toISOString(),
						session_id: `mjpeg-${Date.now()}`,
						backend: 'mjpeg_fallback',
						last_error: '',
					});
					await this.setStateAsync(this.stripNs(id), false, true);
				}
			} else if (group === 'sync') {
				const mod = this.syncById.get(devId);
				if (!mod) {
					throw new Error('Sync-Modul unbekannt (warte auf nächsten Poll)');
				}

				if (cmd === 'armed') {
					const armed = state.val === true;
					await blinkApi.setArmed(this.session, mod.network_id, armed);
					await this.setStateAsync(`sync.${devId}.status.armed`, armed, true);
					await this.setStateAsync(this.stripNs(id), armed, true);
				}
			}
		} catch (e) {
			this.log.warn(`Befehl fehlgeschlagen (${id}): ${e?.message || e}`);
		}
	}

	async syncLatestCloudVideos(cameras) {
		if (this.videoSyncInProgress || !this.session) {
			return;
		}
		this.videoSyncInProgress = true;

		// Manifest-Cache pro Sync-Module für diesen Lauf – wird nur befüllt,
		// wenn überhaupt jemand auf Local-Storage zurückfällt.
		const manifestCacheBySyncId = new Map();
		const getManifestFor = async (networkId, syncId) => {
			if (!syncId) {
				return null;
			}
			const key = String(syncId);
			if (manifestCacheBySyncId.has(key)) {
				return manifestCacheBySyncId.get(key);
			}
			try {
				const m = await blinkApi.getLocalStorageClips(this.session, networkId, syncId);
				manifestCacheBySyncId.set(key, m);
				return m;
			} catch (e) {
				this.log.debug(`Local-Storage-Manifest nicht abrufbar (sync ${syncId}): ${e?.message || e}`);
				manifestCacheBySyncId.set(key, null);
				return null;
			}
		};

		try {
			for (const cam of cameras) {
				const devId = this.sanitizeId(cam.id || cam.name);
				const lastCheck = this.lastVideoCheckByDevId.get(devId) || 0;
				if (Date.now() - lastCheck < this.videoCheckCooldownMs) {
					continue;
				}
				this.lastVideoCheckByDevId.set(devId, Date.now());

				try {
					let latest = null;
					let useLocal = false;
					try {
						latest = await blinkApi.getLatestVideoInfo(this.session, cam.network_id, cam.id);
					} catch (e) {
						if (e?.code !== 'NO_VIDEO') {
							throw e;
						}
						useLocal = true;
					}

					let summary;
					let latestId;
					let latestTs;
					let localClip = null;
					let localManifest = null;

					if (useLocal) {
						const syncId = this.findSyncIdForNetwork(cam.network_id);
						localManifest = await getManifestFor(cam.network_id, syncId);
						if (!localManifest) {
							continue;
						}
						const matches = localManifest.clips
							.filter(c => String(c.camera_name) === String(cam.name))
							.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
						if (!matches.length) {
							continue;
						}
						localClip = matches[0];
						summary = { id: localClip.id, created_at: localClip.created_at };
						latestId = String(localClip.id);
						latestTs = String(localClip.created_at);
					} else {
						if (!latest) {
							continue;
						}
						summary = {
							id: latest?.id || latest?.video_id || null,
							created_at: latest?.created_at || '',
							...(await blinkApi.getLatestVideoSummary(this.session, cam.network_id, cam.id)),
						};
						latestId = String(summary.id || latest?.created_at || latest?.url || '');
						latestTs = String(summary.created_at || '');
					}

					const tsState = await this.getStateAsync(`cameras.${devId}.video.timestamp`);
					const fileState = await this.getStateAsync(`cameras.${devId}.video.file`);
					const idState = await this.getStateAsync(`cameras.${devId}.video.id`);

					const currentTs = String(tsState?.val || '');
					const currentId = String(idState?.val || '');
					const currentFile = String(fileState?.val || '');
					const haveLocalFile = currentFile && fs.existsSync(currentFile);

					const isSameVideo =
						(latestId && currentId && latestId === currentId) ||
						(latestTs && currentTs && latestTs === currentTs);

					if (isSameVideo && haveLocalFile) {
						await this.updateDetectionStates(devId, summary);
						continue;
					}

					const file = path.join(this.cfg.snapshotDir, `${devId}_latest.mp4`);
					let res;
					if (useLocal) {
						res = await blinkApi.downloadLocalClip(
							this.session,
							cam.network_id,
							this.findSyncIdForNetwork(cam.network_id),
							localManifest.manifestId,
							localClip.id,
							file,
						);
						res = { ...res, source: 'local_storage', created_at: localClip.created_at };
					} else {
						res = await blinkApi.downloadVideo(this.session, cam.network_id, cam.id, file, latest);
					}
					await this.updateVideoStates(devId, res);

					// Galerie pflegen – läuft unabhängig vom Live-Sync-Pfad.
					// Cloud wird intern bevorzugt, Local-Storage ist Fallback.
					try {
						await this.syncCameraHistory(cam, devId, localManifest);
					} catch (e) {
						this.log.debug(`History-Sync übersprungen (${cam.name || devId}): ${e?.message || e}`);
					}
				} catch (e) {
					this.log.debug(`Cloud-Video Sync übersprungen (${cam.name || devId}): ${e?.message || e}`);
				}
			}
		} finally {
			this.videoSyncInProgress = false;
		}
	}

	/**
	 * Pflegt die Galerie der 10 neuesten Clips einer Kamera als Ring-Buffer.
	 * Slot 0 ist der neueste Clip, Slot 9 der älteste. Quelle: zuerst Cloud
	 * (schneller, kein Stick-Upload nötig), Fallback Local-Storage.
	 *
	 * @param {object} cam - Kamera-Objekt aus getDevices.
	 * @param {string} devId - sanitized Device-ID.
	 * @param {object} [localManifestHint] - Optionales bereits geholtes Local-Manifest.
	 */
	async syncCameraHistory(cam, devId, localManifestHint = null) {
		const HISTORY_SIZE = 10;
		const base = `cameras.${devId}.video.history`;

		// 1) Vereinheitlichte Clip-Liste holen – Cloud zuerst, Local als Fallback.
		const syncId = this.findSyncIdForNetwork(cam.network_id);
		const { clips: wanted, source } = await blinkApi.getHistoryClips(
			this.session,
			cam.network_id,
			cam.id,
			cam.name,
			{ syncId, localManifest: localManifestHint, limit: HISTORY_SIZE },
		);

		if (!wanted.length) {
			return;
		}

		// 2) Bekannte Clip-IDs pro Slot einsammeln.
		const knownIds = [];
		for (let i = 0; i < HISTORY_SIZE; i++) {
			const st = await this.getStateAsync(`${base}.${i}.id`);
			knownIds.push(String(st?.val || ''));
		}

		// 3) Wenn dieselbe Reihenfolge derselben IDs in den Slots steht, nichts tun.
		const wantedIds = wanted.map(c => String(c.id));
		const same = wantedIds.every((id, idx) => id === knownIds[idx]);
		if (same) {
			return;
		}

		// 4) Für jeden Slot festlegen: Reuse aus altem Slot oder neu downloaden?
		const slotFile = i => path.join(this.cfg.snapshotDir, `${devId}_history_${i}.mp4`);
		const tmpFile = i => path.join(this.cfg.snapshotDir, `.${devId}_history_${i}.tmp.mp4`);

		const sources = new Array(HISTORY_SIZE).fill(null); // 'reuse:<oldIdx>' | 'download'
		for (let newIdx = 0; newIdx < wanted.length; newIdx++) {
			const oldIdx = knownIds.indexOf(wantedIds[newIdx]);
			sources[newIdx] = oldIdx >= 0 ? `reuse:${oldIdx}` : 'download';
		}

		// 4a) Reuse: alte Slot-Datei → Temp-Datei.
		for (let i = 0; i < wanted.length; i++) {
			const src = sources[i];
			if (typeof src === 'string' && src.startsWith('reuse:')) {
				const oldIdx = Number(src.slice(6));
				const from = slotFile(oldIdx);
				const to = tmpFile(i);
				try {
					fs.copyFileSync(from, to);
				} catch (e) {
					sources[i] = 'download';
					this.log.debug(`History reuse fehlgeschlagen Slot ${oldIdx}→${i}: ${e.message}`);
				}
			}
		}

		// 4b) Download: je nach Quelle Cloud oder Local Storage.
		for (let i = 0; i < wanted.length; i++) {
			if (sources[i] !== 'download') {
				continue;
			}
			const clip = wanted[i];
			try {
				if (source === 'cloud') {
					await blinkApi.downloadCloudClip(this.session, clip, tmpFile(i));
				} else {
					// Local Storage – manifestId stammt aus dem Hint oder muss frisch geholt werden.
					let manifestId = localManifestHint?.manifestId;
					if (!manifestId) {
						const m = await blinkApi.getLocalStorageClips(this.session, cam.network_id, syncId);
						manifestId = m.manifestId;
					}
					await blinkApi.downloadLocalClip(
						this.session,
						cam.network_id,
						syncId,
						manifestId,
						clip.id,
						tmpFile(i),
					);
				}
			} catch (e) {
				this.log.warn(`History-Download fehlgeschlagen (${cam.name} Slot ${i}, clip ${clip.id}): ${e.message}`);
				return; // Slot-Lauf abbrechen, alte Daten bleiben erhalten
			}
		}

		// 4c) Temp → Slot umbenennen (atomar), überzählige Slots löschen.
		for (let i = 0; i < wanted.length; i++) {
			try {
				fs.renameSync(tmpFile(i), slotFile(i));
			} catch (e) {
				this.log.warn(`History-Rename Slot ${i} fehlgeschlagen: ${e.message}`);
			}
		}
		for (let i = wanted.length; i < HISTORY_SIZE; i++) {
			try {
				fs.unlinkSync(slotFile(i));
			} catch {
				// Slot-Datei existiert ggf. nicht; ignorieren.
			}
		}

		// 5) States schreiben.
		for (let i = 0; i < HISTORY_SIZE; i++) {
			if (i < wanted.length) {
				const clip = wanted[i];
				await this.setStateAsync(`${base}.${i}.file`, slotFile(i), true);
				await this.setStateAsync(`${base}.${i}.timestamp`, String(clip.created_at || ''), true);
				await this.setStateAsync(`${base}.${i}.id`, String(clip.id || ''), true);
				await this.setStateAsync(`${base}.${i}.source`, source, true);
			} else {
				await this.setStateAsync(`${base}.${i}.file`, '', true);
				await this.setStateAsync(`${base}.${i}.timestamp`, '', true);
				await this.setStateAsync(`${base}.${i}.id`, '', true);
				await this.setStateAsync(`${base}.${i}.source`, '', true);
			}
		}
		this.log.debug(`History aktualisiert für ${cam.name}: ${wanted.length} Slots (${source})`);
	}

	async updateDetectionStates(devId, summary) {
		await this.setStateAsync(`cameras.${devId}.status.smart_detection`, !!summary?.smart_detection, true);
		await this.setStateAsync(`cameras.${devId}.status.person_detected`, !!summary?.person_detected, true);
		await this.setStateAsync(`cameras.${devId}.status.vehicle_detected`, !!summary?.vehicle_detected, true);
		await this.setStateAsync(`cameras.${devId}.status.animal_detected`, !!summary?.animal_detected, true);
		await this.setStateAsync(`cameras.${devId}.status.package_detected`, !!summary?.package_detected, true);
		await this.setStateAsync(`cameras.${devId}.status.detection_type`, String(summary?.detection_type || ''), true);
		await this.setStateAsync(
			`cameras.${devId}.status.smart_detection_raw`,
			String(summary?.smart_detection_raw || ''),
			true,
		);
		await this.setStateAsync(`cameras.${devId}.status.motion_source`, String(summary?.motion_source || ''), true);
	}

	async updateVideoStates(devId, res) {
		const ts = String(res?.created_at || new Date().toISOString());
		const videoId = String(res?.id || res?.video_id || '');
		await this.setStateAsync(`cameras.${devId}.video.file`, String(res?.file || ''), true);
		await this.setStateAsync(`cameras.${devId}.video.timestamp`, ts, true);
		await this.setStateAsync(`cameras.${devId}.video.id`, videoId, true);
		await this.setStateAsync(`cameras.${devId}.video.size`, Number(res?.size || 0), true);
		await this.setStateAsync(`cameras.${devId}.video.ready`, true, true);
		await this.setStateAsync(`cameras.${devId}.video.lastError`, '', true);
		await this.updateDetectionStates(devId, res);
	}

	async checkBatteryWarning(devId, cam) {
		const base = `cameras.${devId}`;

		const apiType = String(cam.apiType || '').toLowerCase();
		const nameLc = String(cam.name || '').toLowerCase();
		const serialLc = String(cam.serial || '').toLowerCase();

		const noBatteryDevice =
			apiType === 'owl' ||
			apiType === 'mini' ||
			nameLc.includes('pantilt') ||
			nameLc.includes('pan tilt') ||
			nameLc.includes('blink mini') ||
			nameLc.includes('mini') ||
			serialLc.includes('mini');

		if (noBatteryDevice) {
			await this.setStateAsync(`${base}.battery.low`, false, true);
			await this.setStateAsync(`${base}.battery.warningSent`, false, true);
			await this.setStateAsync(`${base}.battery.lastMessage`, 'no built in battery', true);
			return;
		}

		const volt = this.toNum(cam.battery_volt ?? cam.battery);
		const thresh = this.toNum(this.cfg.batteryWarningThresholdVolt) ?? 1.1;

		if (volt === null) {
			await this.setStateAsync(`${base}.battery.low`, false, true);
			return;
		}

		const isLow = volt <= thresh;
		await this.setStateAsync(`${base}.battery.low`, isLow, true);

		if (!this.cfg.batteryWarningEnabled || !isLow) {
			if (!isLow) {
				await this.setStateAsync(`${base}.battery.warningSent`, false, true);
			}
			return;
		}

		const cooldownMs = this.cfg.batteryWarningCooldownHours * 3600 * 1000;
		const last = await this.getStateAsync(`${base}.battery.lastWarning`);
		const lastTs = last?.val ? Date.parse(String(last.val)) : 0;

		if (lastTs && Date.now() - lastTs < cooldownMs) {
			return;
		}

		const msg = `Blink Batterie niedrig\n\nKamera: ${cam.name || devId}\nSpannung: ${volt.toFixed(2)} V\nGrenzwert: ${thresh.toFixed(2)} V`;
		await this.setStateAsync(`${base}.battery.lastMessage`, msg, true);

		try {
			await new Promise((res, rej) => {
				this.sendTo(
					this.cfg.batteryWarningPushoverInst,
					'send',
					{ title: 'Blink Batterie niedrig', message: msg, priority: 0 },
					r => (r?.error ? rej(new Error(String(r.error))) : res(r)),
				);
			});
			await this.setStateAsync(`${base}.battery.warningSent`, true, true);
			await this.setStateAsync(`${base}.battery.lastWarning`, new Date().toISOString(), true);
		} catch (e) {
			this.log.warn(`Pushover-Warnung fehlgeschlagen (${cam.name}): ${e?.message || e}`);
		}
	}

	cleanupSnapshots() {
		const dir = this.cfg.snapshotDir;
		const maxAgeMs = this.cfg.maxSnapshotAgeHours * 3600 * 1000;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const now = Date.now();
		for (const e of entries) {
			if (!e.isFile()) {
				continue;
			}
			if (!/\.(jpg|jpeg|mp4)$/i.test(e.name)) {
				continue;
			}
			const full = path.join(dir, e.name);
			try {
				if (now - fs.statSync(full).mtimeMs > maxAgeMs) {
					fs.unlinkSync(full);
				}
			} catch {
				// Lösch-/Stat-Fehler ignorieren.
			}
		}
	}

	async ensureState(id, name, type, role, writable) {
		await this.setObjectNotExistsAsync(id, {
			type: 'state',
			common: { name, type, role, read: true, write: !!writable },
			native: {},
		});
	}

	async initStateIfUnset(id, defaultValue) {
		const cur = await this.getStateAsync(id);
		if (!cur || cur.val === null || cur.val === undefined) {
			await this.setStateAsync(id, defaultValue, true);
		}
	}

	async setNumStateIfValid(id, value) {
		const n = this.toNum(value);
		if (n !== null) {
			await this.setStateAsync(id, n, true);
		}
	}

	async setBoolStateIfDefined(id, value) {
		if (value !== null && value !== undefined) {
			await this.setStateAsync(id, !!value, true);
		}
	}

	sanitizeId(id) {
		return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
	}

	toNum(v) {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}

	stripNs(fullId) {
		const ns = `${this.namespace}.`;
		return fullId.startsWith(ns) ? fullId.slice(ns.length) : fullId;
	}

	onUnload(cb) {
		try {
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
			}
			if (this.liveTimer) {
				clearInterval(this.liveTimer);
			}
			if (this.mjpegStatusTimer) {
				clearInterval(this.mjpegStatusTimer);
				this.mjpegStatusTimer = null;
			}

			for (const timer of this.liveStopTimers.values()) {
				clearTimeout(timer);
			}
			this.liveStopTimers.clear();

			for (const proc of this.liveProcesses.values()) {
				try {
					proc.kill('SIGTERM');
				} catch {
					// ignore
				}
			}
			this.liveProcesses.clear();
			this.liveSessions.clear();

			const finish = () => {
				this.stopHlsServer()
					.catch(() => {})
					.finally(() => cb());
			};

			if (this.mjpegServer) {
				this.mjpegServer
					.stop()
					.catch(() => {})
					.finally(() => {
						this.mjpegServer = null;
						finish();
					});
				return;
			}
			finish();
		} catch {
			cb();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new BlinkAdapter(options);
} else {
	new BlinkAdapter();
}
