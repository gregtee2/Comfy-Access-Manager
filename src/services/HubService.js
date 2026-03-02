/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * HubService — Central server broadcast & sync coordination
 *
 * When the app runs in "hub" mode, this service:
 *   - Maintains SSE connections to all spoke clients
 *   - Broadcasts DB change events so spokes stay in sync
 *   - Provides DB snapshot download for initial spoke setup
 *   - Tracks connected spokes for monitoring
 *
 * This module is ONLY loaded when mode === 'hub'.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Connected spoke clients (SSE) ───
const _spokeClients = new Map(); // id -> { res, name, connectedAt }

let _hubSecret = null;

/**
 * Initialize the hub service with shared secret
 */
function init(secret) {
    _hubSecret = secret;
    console.log('[Hub] Service initialized');
    console.log(`[Hub] Auth secret: ${secret ? secret.substring(0, 4) + '****' : '(none — open access)'}`);
}

/**
 * Validate a spoke's auth token.
 * Returns true if valid, false otherwise.
 */
function validateToken(token) {
    if (!_hubSecret) return true; // No secret = open access
    return token === _hubSecret;
}

/**
 * Middleware: Require valid hub secret on sync API routes
 */
function requireAuth(req, res, next) {
    if (!_hubSecret) return next();
    const token = req.headers['x-hub-secret'] || req.query.secret;
    if (!token || token !== _hubSecret) {
        return res.status(401).json({ error: 'Invalid or missing hub secret' });
    }
    next();
}

/**
 * Register a spoke SSE client.
 * Called from syncRoutes when a spoke connects to /api/sync/events.
 */
function addSpokeClient(id, res, name) {
    _spokeClients.set(id, {
        res,
        name: name || 'unknown',
        connectedAt: new Date().toISOString(),
    });
    console.log(`[Hub] Spoke connected: "${name}" (${_spokeClients.size} total)`);
}

/**
 * Remove a spoke SSE client.
 */
function removeSpokeClient(id) {
    const client = _spokeClients.get(id);
    _spokeClients.delete(id);
    console.log(`[Hub] Spoke disconnected: "${client?.name || id}" (${_spokeClients.size} remaining)`);
}

/**
 * Broadcast a change event to all connected spokes.
 * Called after any DB write operation in hub mode.
 *
 * @param {string} table - Table that changed (e.g., 'assets', 'projects')
 * @param {string} action - 'insert', 'update', 'delete'
 * @param {object} data - The changed record(s)
 */
function broadcast(table, action, data = {}) {
    if (_spokeClients.size === 0) return;

    const event = {
        table,
        action,
        data,
        timestamp: Date.now(),
        id: crypto.randomUUID(),
    };

    const payload = `id: ${event.id}\nevent: db-change\ndata: ${JSON.stringify(event)}\n\n`;

    let delivered = 0;
    for (const [id, client] of _spokeClients) {
        try {
            client.res.write(payload);
            delivered++;
        } catch (err) {
            console.error(`[Hub] Failed to send to spoke "${client.name}":`, err.message);
            _spokeClients.delete(id);
        }
    }

    if (delivered > 0) {
        console.log(`[Hub] Broadcast ${table}.${action} to ${delivered} spoke(s)`);
    }
}

/**
 * Get list of connected spokes (for monitoring / settings UI).
 */
function getConnectedSpokes() {
    const spokes = [];
    for (const [id, client] of _spokeClients) {
        spokes.push({
            id,
            name: client.name,
            connectedAt: client.connectedAt,
        });
    }
    return spokes;
}

/**
 * Get the current DB file path for snapshot download.
 */
function getDbFilePath() {
    const database = require('../database');
    return database.dbPath;
}

/**
 * Get a DB checkpoint for consistent snapshot.
 * Forces WAL checkpoint so the .db file is complete.
 */
function checkpointDb() {
    const { getDb } = require('../database');
    const db = getDb();
    db.pragma('wal_checkpoint(TRUNCATE)');
}

module.exports = {
    init,
    validateToken,
    requireAuth,
    addSpokeClient,
    removeSpokeClient,
    broadcast,
    getConnectedSpokes,
    getDbPath: getDbFilePath,
    checkpointDb,
};
