/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * SpokeService — Remote client that syncs with a central hub
 *
 * When the app runs in "spoke" mode, this service:
 *   - Connects to the hub via SSE for real-time DB change events
 *   - Downloads a full DB snapshot on first connect / when out of sync
 *   - Forwards write operations (POST/PUT/DELETE) to the hub
 *   - Applies incoming changes to the local replica DB
 *
 * This module is ONLY loaded when mode === 'spoke'.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const EventEmitter = require('events');

class SpokeService extends EventEmitter {
    constructor(hubUrl, hubSecret, localName) {
        super();
        this.hubUrl = hubUrl.replace(/\/+$/, ''); // strip trailing slash
        this.hubSecret = hubSecret || '';
        this.localName = localName || require('os').hostname();
        this._eventSource = null;
        this._reconnectTimer = null;
        this._connected = false;
        this._lastEventId = null;
        this._reconnectDelay = 2000; // start at 2s, back off to 30s
    }

    /**
     * Start the spoke: download DB snapshot if needed, then connect SSE.
     */
    async start() {
        console.log(`[Spoke] Connecting to hub: ${this.hubUrl}`);

        // 1. Check hub health
        try {
            const status = await this._apiGet('/api/sync/status');
            console.log(`[Spoke] Hub online: "${status.name}" v${status.version} (${status.assetCount} assets, mode: ${status.mode})`);
        } catch (err) {
            console.error(`[Spoke] Hub unreachable: ${err.message}`);
            console.log('[Spoke] Will retry in background...');
            this._scheduleReconnect();
            return;
        }

        // 2. Sync DB snapshot
        try {
            await this.syncDatabase();
        } catch (err) {
            console.error(`[Spoke] DB sync failed: ${err.message}`);
        }

        // 3. Sync thumbnails from hub
        try {
            await this.syncThumbnails();
        } catch (err) {
            console.error(`[Spoke] Thumbnail sync failed: ${err.message}`);
        }

        // 4. Connect SSE for real-time updates
        this._connectSSE();
    }

    /**
     * Stop the spoke: disconnect SSE, cancel timers.
     */
    stop() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._eventSource) {
            this._eventSource.destroy();
            this._eventSource = null;
        }
        this._connected = false;
        console.log('[Spoke] Disconnected from hub');
    }

    /**
     * Settings keys that are local to this machine and must survive DB syncs.
     * These are saved before replacing the DB and restored afterward.
     */
    static LOCAL_SETTINGS = [
        'path_mappings',    // cross-platform path translation (per-machine)
        'rv_path',          // path to RV executable (differs per OS/install)
        'ffmpeg_path',      // path to FFmpeg (differs per machine)
        'vault_root',       // local vault root folder
    ];

    /**
     * Download a full DB snapshot from the hub and replace local DB.
     */
    async syncDatabase() {
        console.log('[Spoke] Downloading DB snapshot from hub...');

        const { DATA_DIR, closeDb, initDb, getDb, getSetting } = require('../database');
        const localDb = path.join(DATA_DIR, 'mediavault.db');
        const tempDb = path.join(DATA_DIR, 'mediavault_hub_sync.db');

        // ── Preserve local-only settings before replacing DB ──
        const localSettings = {};
        try {
            const db = getDb();
            for (const key of SpokeService.LOCAL_SETTINGS) {
                const val = getSetting(key);
                if (val != null) localSettings[key] = val;
            }
            if (Object.keys(localSettings).length > 0) {
                console.log(`[Spoke] Preserving ${Object.keys(localSettings).length} local setting(s): ${Object.keys(localSettings).join(', ')}`);
            }
        } catch { /* DB may not be open yet on first sync */ }

        // Download to temp file first
        await this._downloadFile('/api/sync/db', tempDb);

        // Get file sizes for logging
        const size = fs.statSync(tempDb).size;
        console.log(`[Spoke] Downloaded DB snapshot: ${(size / 1024 / 1024).toFixed(1)} MB`);

        // Close existing DB, replace, reopen
        closeDb();

        // Backup current local DB
        if (fs.existsSync(localDb)) {
            const backup = localDb + '.spoke-backup';
            fs.copyFileSync(localDb, backup);
        }

        // Replace with hub's DB
        fs.copyFileSync(tempDb, localDb);
        fs.unlinkSync(tempDb);

        // Re-initialize DB
        await initDb();

        // ── Restore local-only settings into the new DB ──
        if (Object.keys(localSettings).length > 0) {
            try {
                const db = getDb();
                const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
                for (const [key, val] of Object.entries(localSettings)) {
                    upsert.run(key, val);
                }
                console.log(`[Spoke] Restored ${Object.keys(localSettings).length} local setting(s)`);
            } catch (err) {
                console.error('[Spoke] Failed to restore local settings:', err.message);
            }
        }

        console.log('[Spoke] Local DB updated from hub snapshot');

        this.emit('db-synced');
    }

    /**
     * Download all thumbnails from the hub.
     * Uses a binary stream format (see syncRoutes GET /thumbnails).
     */
    async syncThumbnails() {
        console.log('[Spoke] Downloading thumbnails from hub...');

        const thumbDir = path.join(__dirname, '..', '..', 'thumbnails');
        if (!fs.existsSync(thumbDir)) {
            fs.mkdirSync(thumbDir, { recursive: true });
        }

        // Download binary thumbnail bundle
        const data = await this._downloadBuffer('/api/sync/thumbnails');

        // Parse the binary format: [4B nameLen][nameBytes][4B dataLen][dataBytes] ... [4B 0x00 sentinel]
        let offset = 0;
        let count = 0;

        while (offset + 4 <= data.length) {
            const nameLen = data.readUInt32BE(offset);
            offset += 4;

            if (nameLen === 0) break; // sentinel — end of stream

            if (offset + nameLen + 4 > data.length) break; // malformed
            const fileName = data.slice(offset, offset + nameLen).toString('utf8');
            offset += nameLen;

            const dataLen = data.readUInt32BE(offset);
            offset += 4;

            if (offset + dataLen > data.length) break; // malformed
            const fileData = data.slice(offset, offset + dataLen);
            offset += dataLen;

            // Write thumbnail to disk
            const destPath = path.join(thumbDir, fileName);
            fs.writeFileSync(destPath, fileData);
            count++;
        }

        console.log(`[Spoke] Synced ${count} thumbnails from hub (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
    }

    /**
     * Download a single thumbnail by asset ID from the hub.
     * Called when a new asset is added via SSE.
     */
    async fetchSingleThumbnail(assetId) {
        const thumbDir = path.join(__dirname, '..', '..', 'thumbnails');
        if (!fs.existsSync(thumbDir)) {
            fs.mkdirSync(thumbDir, { recursive: true });
        }

        const destPath = path.join(thumbDir, `thumb_${assetId}.jpg`);

        try {
            await this._downloadFile(`/api/sync/thumbnail/${assetId}`, destPath);
        } catch (err) {
            // Not all assets have thumbnails — this is fine
        }
    }

    /**
     * Forward a write request (POST/PUT/DELETE) to the hub.
     * Returns the hub's response.
     */
    async forwardRequest(method, path, body, headers = {}) {
        return this._apiRequest(method, path, body, headers);
    }

    /**
     * Connect to the hub's SSE endpoint for real-time change events.
     */
    _connectSSE() {
        const url = new URL(`${this.hubUrl}/api/sync/events?name=${encodeURIComponent(this.localName)}`);
        const isHttps = url.protocol === 'https:';
        const transport = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
                ...(this.hubSecret ? { 'X-Hub-Secret': this.hubSecret } : {}),
                ...(this._lastEventId ? { 'Last-Event-ID': this._lastEventId } : {}),
            },
        };

        const req = transport.request(options, (res) => {
            if (res.statusCode !== 200) {
                console.error(`[Spoke] SSE connection failed: HTTP ${res.statusCode}`);
                res.resume();
                this._scheduleReconnect();
                return;
            }

            this._connected = true;
            this._reconnectDelay = 2000; // reset backoff on success
            console.log('[Spoke] SSE connected — listening for hub changes');
            this.emit('connected');

            let buffer = '';
            res.setEncoding('utf8');

            res.on('data', (chunk) => {
                buffer += chunk;
                // Parse SSE events from buffer
                const events = buffer.split('\n\n');
                buffer = events.pop(); // keep incomplete event in buffer

                for (const raw of events) {
                    if (!raw.trim() || raw.trim().startsWith(':')) continue; // keepalive / comment
                    this._handleSSEEvent(raw);
                }
            });

            res.on('end', () => {
                console.log('[Spoke] SSE connection closed by hub');
                this._connected = false;
                this._scheduleReconnect();
            });

            res.on('error', (err) => {
                console.error('[Spoke] SSE stream error:', err.message);
                this._connected = false;
                this._scheduleReconnect();
            });
        });

        req.on('error', (err) => {
            console.error('[Spoke] SSE connection error:', err.message);
            this._connected = false;
            this._scheduleReconnect();
        });

        req.end();
        this._eventSource = req;
    }

    /**
     * Parse and handle a single SSE event.
     */
    _handleSSEEvent(raw) {
        let eventType = 'message';
        let data = '';
        let id = null;

        for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
            else if (line.startsWith('id: ')) id = line.slice(4).trim();
        }

        if (id) this._lastEventId = id;

        if (eventType === 'db-change') {
            try {
                const change = JSON.parse(data);
                this._applyChange(change);
            } catch (err) {
                console.error('[Spoke] Failed to parse db-change event:', err.message);
            }
        } else if (eventType === 'full-sync') {
            // Hub is telling us to do a full DB re-sync
            console.log('[Spoke] Hub requested full sync');
            this.syncDatabase().catch(err => {
                console.error('[Spoke] Full sync failed:', err.message);
            });
        }
    }

    /**
     * Apply a single incremental DB change from the hub.
     */
    _applyChange(change) {
        const { table, action, data } = change;

        try {
            const { getDb } = require('../database');
            const db = getDb();

            if (action === 'insert' && data.record) {
                const record = data.record;
                const cols = Object.keys(record);
                const placeholders = cols.map(() => '?').join(', ');
                const stmt = db.prepare(
                    `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`
                );
                stmt.run(...cols.map(c => record[c]));
            } else if (action === 'update' && data.record && data.id) {
                const record = data.record;
                const sets = Object.keys(record).map(k => `${k} = ?`).join(', ');
                const stmt = db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`);
                stmt.run(...Object.values(record), data.id);
            } else if (action === 'delete' && data.id) {
                db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(data.id);
            } else if (action === 'bulk-insert' && data.records) {
                const records = data.records;
                if (records.length === 0) return;
                const cols = Object.keys(records[0]);
                const placeholders = cols.map(() => '?').join(', ');
                const stmt = db.prepare(
                    `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`
                );
                const txn = db.transaction((rows) => {
                    for (const row of rows) {
                        stmt.run(...cols.map(c => row[c]));
                    }
                });
                txn(records);
            }

            this.emit('change', { table, action, data });

            // Sync thumbnail for newly inserted assets
            if (table === 'assets' && (action === 'insert' || action === 'bulk-insert')) {
                const ids = action === 'bulk-insert' && data.records
                    ? data.records.map(r => r.id).filter(Boolean)
                    : data.record?.id ? [data.record.id] : [];
                for (const id of ids) {
                    this.fetchSingleThumbnail(id).catch(err => {
                        console.error(`[Spoke] Thumbnail sync failed for asset ${id}:`, err.message);
                    });
                }
            }
        } catch (err) {
            console.error(`[Spoke] Failed to apply ${table}.${action}:`, err.message);
            // On failure, schedule a full re-sync
            console.log('[Spoke] Scheduling full re-sync due to apply failure');
            this.syncDatabase().catch(() => {});
        }
    }

    /**
     * Schedule a reconnect with exponential backoff.
     */
    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        console.log(`[Spoke] Reconnecting in ${this._reconnectDelay / 1000}s...`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connectSSE();
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 30000);
    }

    // ─── HTTP helpers ───

    async _apiGet(apiPath) {
        return this._apiRequest('GET', apiPath);
    }

    async _apiRequest(method, apiPath, body, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.hubUrl + apiPath);
            const isHttps = url.protocol === 'https:';
            const transport = isHttps ? https : http;

            const headers = {
                'Content-Type': 'application/json',
                ...(this.hubSecret ? { 'X-Hub-Secret': this.hubSecret } : {}),
                ...extraHeaders,
            };

            const bodyStr = body ? JSON.stringify(body) : null;
            if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method,
                headers,
            };

            const req = transport.request(options, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        try {
                            const err = JSON.parse(data);
                            reject(new Error(err.error || `HTTP ${res.statusCode}`));
                        } catch {
                            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                        }
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data);
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(30000, () => {
                req.destroy(new Error('Request timeout'));
            });

            if (bodyStr) req.write(bodyStr);
            req.end();
        });
    }

    async _downloadFile(apiPath, destPath) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.hubUrl + apiPath);
            const isHttps = url.protocol === 'https:';
            const transport = isHttps ? https : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + (url.search || '') + (this.hubSecret ? `${url.search ? '&' : '?'}secret=${this.hubSecret}` : ''),
                method: 'GET',
                headers: {
                    ...(this.hubSecret ? { 'X-Hub-Secret': this.hubSecret } : {}),
                },
            };

            const req = transport.request(options, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                    return;
                }

                const ws = fs.createWriteStream(destPath);
                res.pipe(ws);
                ws.on('finish', () => {
                    ws.close();
                    resolve();
                });
                ws.on('error', reject);
            });

            req.on('error', reject);
            req.setTimeout(120000, () => {
                req.destroy(new Error('Download timeout'));
            });
            req.end();
        });
    }

    /**
     * Download a URL and return the response as a Buffer (in-memory).
     * Used for thumbnail bundle download where we parse the binary format.
     */
    async _downloadBuffer(apiPath) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.hubUrl + apiPath);
            const isHttps = url.protocol === 'https:';
            const transport = isHttps ? https : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + (url.search || '') + (this.hubSecret ? `${url.search ? '&' : '?'}secret=${this.hubSecret}` : ''),
                method: 'GET',
                headers: {
                    ...(this.hubSecret ? { 'X-Hub-Secret': this.hubSecret } : {}),
                },
            };

            const req = transport.request(options, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                    return;
                }

                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });

            req.on('error', reject);
            req.setTimeout(300000, () => { // 5 min timeout for large bundles
                req.destroy(new Error('Download timeout'));
            });
            req.end();
        });
    }

    /**
     * Is the spoke currently connected to the hub?
     */
    get isConnected() {
        return this._connected;
    }
}

module.exports = SpokeService;
