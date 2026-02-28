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
 * This middleware is ONLY loaded when mode === 'spoke'.
 */

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
