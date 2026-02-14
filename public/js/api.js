/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * DMV — API Helper
 * Centralized fetch wrapper for all backend calls.
 */

export async function api(url, opts = {}) {
    const options = {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
    };
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
