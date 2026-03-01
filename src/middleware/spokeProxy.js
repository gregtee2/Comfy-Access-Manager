/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * spokeProxy — Express middleware that intercepts write requests in spoke mode
 *
 * In spoke mode, the local CAM instance keeps a read-only replica of the hub's
 * database. All write operations (POST, PUT, DELETE to /api/*) are forwarded
 * to the hub via the SpokeService, rather than hitting the local DB.
 *
 * GET requests pass through normally (served from local replica for speed).
 *
 * Certain POST endpoints that launch local processes (RV, external players,
 * FFmpeg review renders) or only read data (PIN verification) are excluded
 * from forwarding — they must execute on the local machine.
 *
 * This middleware is ONLY loaded when mode === 'spoke'.
 */

// Endpoints that must execute locally even though they use POST/PUT/DELETE.
// These either launch local processes or are read-only checks disguised as POST.
const LOCAL_ONLY_PATTERNS = [
    '/api/assets/rv-push',         // Launch / push to RV (local process)
    '/api/users/verify-pin',       // PIN check — read-only, use local replica
    '/api/assets/rv-status',       // Check local RV status
    '/api/settings/sync-config',   // Per-machine hub/spoke config (local config.json)
    '/api/settings/db-config',     // Per-machine shared DB path (local config.json)
    '/api/assets/publish-frame',   // RV frame publish — reads local temp files, runs FFmpeg
    '/api/settings',               // Settings (vault_root, rv_path etc.) are per-machine
    '/api/settings/sync-rv-plugin', // Deploy RV plugin locally
];
// Regex patterns for parameterised routes that must run locally
const LOCAL_ONLY_REGEX = [
    /^\/api\/assets\/\d+\/open-review$/,    // FFmpeg render + open in RV (local)
    /^\/api\/assets\/\d+\/open-external$/,  // Open in external player (local)
    /^\/api\/settings(\/.*)?$/,             // ALL settings writes — vault_root, rv_path, ffmpeg_path, path_mappings, preferences are per-machine
    /^\/api\/export/,                       // FFmpeg transcode — runs locally
];

/**
 * Create the spoke proxy middleware.
 *
 * @param {SpokeService} spokeService - Initialized SpokeService instance
 * @returns {Function} Express middleware
 */
function createSpokeProxy(spokeService) {
    return function spokeProxyMiddleware(req, res, next) {
        // Only intercept write methods on API routes
        if (!req.path.startsWith('/api/')) return next();
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

        // Never intercept sync routes (those are spoke → hub communication)
        if (req.path.startsWith('/api/sync/')) return next();

        // Don't intercept internal hub writes (avoid loop when hub calls itself)
        if (req.headers['x-hub-internal']) return next();

        // Don't intercept local-only endpoints (process launches, read-only checks)
        if (LOCAL_ONLY_PATTERNS.includes(req.path)) return next();
        if (LOCAL_ONLY_REGEX.some(rx => rx.test(req.path))) return next();

        // Forward the write to the hub
        const forwardPath = req.originalUrl || req.url;
        const method = req.method;
        const body = req.body;
        const headers = {
            'x-cam-user': req.headers['x-cam-user'] || '',
        };

        console.log(`[SpokeProxy] Forwarding ${method} ${forwardPath} → hub`);

        spokeService.forwardRequest(method, '/api/sync/write', {
            method,
            path: forwardPath,
            body,
            headers,
            spokeName: spokeService.localName,
        })
            .then((hubResponse) => {
                // Forward the hub's response back to the client
                const statusCode = hubResponse?.status || 200;
                if (typeof hubResponse === 'object') {
                    // The hub returns the response body directly from the /write endpoint
                    res.json(hubResponse);
                } else {
                    res.send(hubResponse);
                }
            })
            .catch((err) => {
                console.error(`[SpokeProxy] Forward failed:`, err.message);

                // If hub is unreachable, let the user know
                if (!spokeService.isConnected) {
                    return res.status(503).json({
                        error: 'Hub is unreachable. Write operations are temporarily unavailable.',
                        mode: 'spoke',
                        hubUrl: spokeService.hubUrl,
                    });
                }

                res.status(502).json({
                    error: `Hub write failed: ${err.message}`,
                    mode: 'spoke',
                });
            });
    };
}

module.exports = { createSpokeProxy };
