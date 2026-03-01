/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 *
 * Voice Chat Signaling Routes — WebRTC signaling for review session voice chat.
 *
 * Architecture:
 *   - SSE endpoint per session for real-time signaling delivery
 *   - POST endpoint for sending offers, answers, and ICE candidates
 *   - Peers connect in a mesh topology (suitable for 2-6 participants)
 *   - Audio streams flow peer-to-peer via WebRTC after signaling completes
 *
 * Flow:
 *   1. User clicks mic button → browser requests getUserMedia({audio:true})
 *   2. Client connects to GET /api/voice/signal/:sessionId (SSE)
 *   3. Client sends POST /api/voice/signal/:sessionId with { type: 'join' }
 *   4. Existing peers receive 'join' → create RTCPeerConnection → send offer
 *   5. New peer receives offer → creates answer → sends back
 *   6. ICE candidates exchanged until connection established
 *   7. Audio flows peer-to-peer (no server relay)
 */

const express = require('express');
const router = express.Router();
const os = require('os');

// ─── Per-session signaling rooms ───
// Map<sessionId, Set<{ res, peerId, userName }>>
const _voiceRooms = new Map();

/**
 * Get or create a voice room for a session.
 */
function getRoom(sessionId) {
    if (!_voiceRooms.has(sessionId)) {
        _voiceRooms.set(sessionId, new Set());
    }
    return _voiceRooms.get(sessionId);
}

/**
 * Broadcast a signaling message to all peers in a room except the sender.
 */
function broadcastToRoom(sessionId, senderId, message) {
    const room = _voiceRooms.get(sessionId);
    if (!room) return;

    const payload = JSON.stringify(message);
    for (const client of room) {
        if (client.peerId !== senderId) {
            client.res.write(`data: ${payload}\n\n`);
        }
    }
}

/**
 * Send a signaling message to a specific peer in a room.
 */
function sendToPeer(sessionId, targetPeerId, message) {
    const room = _voiceRooms.get(sessionId);
    if (!room) return;

    const payload = JSON.stringify(message);
    for (const client of room) {
        if (client.peerId === targetPeerId) {
            client.res.write(`data: ${payload}\n\n`);
            return;
        }
    }
}

/**
 * Get list of current peers in a room (for the peers list).
 */
function getRoomPeers(sessionId) {
    const room = _voiceRooms.get(sessionId);
    if (!room) return [];
    return Array.from(room).map(c => ({
        peerId: c.peerId,
        userName: c.userName,
    }));
}


// ═══════════════════════════════════════════
//  GET /api/voice/signal/:sessionId — SSE signaling channel
//
//  Each connected client gets real-time signaling messages:
//  offers, answers, ICE candidates, join/leave notifications.
// ═══════════════════════════════════════════
router.get('/signal/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const peerId = req.query.peerId;
    const userName = req.query.userName || 'Unknown';

    if (!peerId) {
        return res.status(400).json({ error: 'peerId query parameter required' });
    }

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    res.write(':\n\n'); // keepalive comment

    const room = getRoom(sessionId);
    const client = { res, peerId, userName };

    // Tell the new peer about existing peers
    const existingPeers = getRoomPeers(sessionId);
    res.write(`data: ${JSON.stringify({ type: 'peers', peers: existingPeers })}\n\n`);

    // Add to room
    room.add(client);
    console.log(`[Voice] ${userName} (${peerId}) joined voice room for session ${sessionId} (${room.size} peers)`);

    // Notify others that a new peer joined
    broadcastToRoom(sessionId, peerId, {
        type: 'peer-joined',
        peerId,
        userName,
    });

    // Keepalive every 30s
    const keepalive = setInterval(() => {
        try { res.write(':\n\n'); } catch { /* closed */ }
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
        clearInterval(keepalive);
        room.delete(client);
        console.log(`[Voice] ${userName} (${peerId}) left voice room for session ${sessionId} (${room.size} peers)`);

        // Notify remaining peers
        broadcastToRoom(sessionId, peerId, {
            type: 'peer-left',
            peerId,
            userName,
        });

        // Clean up empty rooms
        if (room.size === 0) {
            _voiceRooms.delete(sessionId);
            console.log(`[Voice] Room for session ${sessionId} closed (empty)`);
        }
    });
});


// ═══════════════════════════════════════════
//  POST /api/voice/signal/:sessionId — Send a signaling message
//
//  Body: { peerId, targetPeerId?, type, ... }
//
//  Message types:
//    - offer:     WebRTC SDP offer   → sent to targetPeerId
//    - answer:    WebRTC SDP answer  → sent to targetPeerId
//    - ice:       ICE candidate      → sent to targetPeerId
//    - leave:     Peer leaving       → broadcast to all
// ═══════════════════════════════════════════
router.post('/signal/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { peerId, targetPeerId, type } = req.body || {};

    if (!peerId || !type) {
        return res.status(400).json({ error: 'peerId and type are required' });
    }

    const room = _voiceRooms.get(sessionId);
    if (!room || room.size === 0) {
        return res.status(404).json({ error: 'No active voice room for this session' });
    }

    switch (type) {
        case 'offer':
        case 'answer':
        case 'ice':
            // These are targeted messages → send to specific peer
            if (!targetPeerId) {
                return res.status(400).json({ error: 'targetPeerId required for offer/answer/ice' });
            }
            sendToPeer(sessionId, targetPeerId, {
                type,
                peerId,
                sdp: req.body.sdp,
                candidate: req.body.candidate,
            });
            break;

        case 'leave':
            // Broadcast to all peers
            broadcastToRoom(sessionId, peerId, {
                type: 'peer-left',
                peerId,
            });
            break;

        default:
            return res.status(400).json({ error: `Unknown signal type: ${type}` });
    }

    res.json({ ok: true });
});


// ═══════════════════════════════════════════
//  GET /api/voice/peers/:sessionId — Get current peers in a voice room
// ═══════════════════════════════════════════
router.get('/peers/:sessionId', (req, res) => {
    const peers = getRoomPeers(req.params.sessionId);
    res.json({ peers, count: peers.length });
});


module.exports = router;
