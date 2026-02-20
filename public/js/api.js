/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * DMV - API Helper
 * Centralized fetch wrapper for all backend calls.
 */

export async function api(url, opts = {}) {
    const userId = localStorage.getItem('cam_user_id');
    const options = {
        headers: {
            'Content-Type': 'application/json',
            ...(userId ? { 'X-CAM-User': userId } : {}),
        },
        ...opts,
    };
    // Merge caller-provided headers with our defaults
    if (opts.headers) {
        options.headers = { ...options.headers, ...opts.headers };
    }
    if (opts.body && typeof opts.body === 'object') {
        options.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, options);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'API error');
    }
    return res.json();
}

