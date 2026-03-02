/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault — Network Discovery Service
 * Uses UDP broadcast to discover other MediaVault instances on the LAN.
 * Zero dependencies — uses Node's built-in dgram module.
 *
 * Protocol:
 *   Port 7701 (UDP)
 *   Request:  {"type":"discover"}
 *   Response: {"type":"announce","name":"...","version":"...","port":7700,...}
 */

const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 7701;
const PROTOCOL_VERSION = 1;
const MAGIC = 'DMV_DISCOVER';

let server = null;
let serverInfo = null;    // Set by start()
let savedServers = [];    // Manually saved servers (persisted via settings)

/**
 * Get all LAN broadcast addresses from active network interfaces
 */
function getBroadcastAddresses() {
    const addrs = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                // Calculate broadcast: IP | ~netmask
                const ipParts = iface.address.split('.').map(Number);
                const maskParts = iface.netmask.split('.').map(Number);
                const broadcast = ipParts.map((ip, i) => (ip | (~maskParts[i] & 255))).join('.');
                addrs.push(broadcast);
            }
        }
    }
    return addrs.length > 0 ? addrs : ['255.255.255.255'];
}

/**
 * Get this machine's LAN IP addresses
 */
function getLocalIPs() {
    const ips = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}

/**
 * Start the discovery listener.
 * @param {object} info - { name, version, port, assetCount, vaultRoot }
 */
function start(info) {
    serverInfo = info;

    try {
        server = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        server.on('message', (msg, rinfo) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.magic !== MAGIC) return;

                if (data.type === 'discover') {
                    // Someone is looking for us — announce ourselves
                    const response = JSON.stringify({
                        magic: MAGIC,
                        type: 'announce',
                        protocol: PROTOCOL_VERSION,
                        name: serverInfo.name,
                        hostname: os.hostname(),
                        platform: process.platform,
                        version: serverInfo.version,
                        port: serverInfo.port,
                        assets: serverInfo.assetCount || 0,
                        ip: getLocalIPs(),
                        mode: serverInfo.mode || 'standalone',
                    });
                    const buf = Buffer.from(response);
                    server.send(buf, 0, buf.length, rinfo.port, rinfo.address);
                }
            } catch { /* ignore malformed packets */ }
        });

        server.on('error', (err) => {
            console.log(`[Discovery] UDP listener error: ${err.message}`);
            // Non-fatal — discovery just won't work
        });

        server.bind(DISCOVERY_PORT, () => {
            server.setBroadcast(true);
            console.log(`  🔍 Network discovery active (UDP ${DISCOVERY_PORT})`);
        });
    } catch (err) {
        console.log(`[Discovery] Could not start: ${err.message}`);
    }
}

/**
 * Scan the network for other MediaVault instances.
 * Sends a broadcast and collects responses for `timeoutMs`.
 * @param {number} timeoutMs - How long to wait for responses (default: 2000ms)
 * @returns {Promise<Array>} - Array of discovered server objects
 */
function discover(timeoutMs = 2000) {
    return new Promise((resolve) => {
        const found = new Map(); // keyed by ip:port to dedupe
        const myIPs = new Set(getLocalIPs());
        const myPort = serverInfo?.port || 7700;

        const scanner = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        scanner.on('message', (msg) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.magic !== MAGIC || data.type !== 'announce') return;

                // Pick the first IP that's not us
                const ips = data.ip || [];
                const remoteIP = ips.find(ip => !myIPs.has(ip)) || ips[0];
                if (!remoteIP) return;

                // Skip ourselves
                if (myIPs.has(remoteIP) && data.port === myPort) return;

                const key = `${remoteIP}:${data.port}`;
                if (!found.has(key)) {
                    found.set(key, {
                        name: data.name,
                        hostname: data.hostname,
                        platform: data.platform,
                        version: data.version,
                        ip: remoteIP,
                        port: data.port,
                        url: `http://${remoteIP}:${data.port}`,
                        assets: data.assets,
                        mode: data.mode || 'standalone',
                    });
                }
            } catch { /* ignore */ }
        });

        scanner.bind(() => {
            scanner.setBroadcast(true);

            const request = JSON.stringify({
                magic: MAGIC,
                type: 'discover',
                protocol: PROTOCOL_VERSION,
            });
            const buf = Buffer.from(request);

            // Send to all broadcast addresses
            for (const addr of getBroadcastAddresses()) {
                scanner.send(buf, 0, buf.length, DISCOVERY_PORT, addr);
            }

            // Also try common subnet broadcast
            scanner.send(buf, 0, buf.length, DISCOVERY_PORT, '255.255.255.255');
        });

        setTimeout(() => {
            try { scanner.close(); } catch {}
            resolve(Array.from(found.values()));
        }, timeoutMs);
    });
}

/**
 * Update server info (e.g., when asset count changes)
 */
function updateInfo(info) {
    if (serverInfo) {
        Object.assign(serverInfo, info);
    }
}

/**
 * Stop the discovery listener
 */
function stop() {
    if (server) {
        try { server.close(); } catch {}
        server = null;
    }
}

module.exports = { start, stop, discover, updateInfo, getLocalIPs };
