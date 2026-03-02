/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 *
 * Voice Chat — WebRTC peer-to-peer audio for review sessions.
 *
 * Enables real-time voice communication during synchronized reviews.
 * Uses WebRTC for peer-to-peer audio with server-side SSE signaling.
 *
 * Mesh topology: each peer connects directly to every other peer.
 * Works well for 2-6 participants (typical review session size).
 */

import { api } from './api.js';
import { showToast } from './utils.js';

// ─── STUN/TURN Configuration ───
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

// ─── State ───
let _sessionId = null;           // Current review session we're voice-chatting in
let _peerId = null;              // Our unique peer ID for this session
let _userName = null;            // Display name
let _localStream = null;         // Our microphone MediaStream
let _sseSource = null;           // EventSource for signaling
let _peers = new Map();          // Map<peerId, { pc: RTCPeerConnection, userName: string }>
let _isMuted = false;            // Whether our mic is muted
let _isConnected = false;        // Whether we're in a voice room
let _signalingBaseUrl = '';      // Hub URL for signaling ('' = local, 'http://hub:7700' = spoke)

// ─── Public API ───

/**
 * Join voice chat for a review session.
 * Requests microphone access, connects to signaling, and establishes peer connections.
 */
async function joinVoiceChat(sessionId) {
    if (_isConnected) {
        if (_sessionId === sessionId) {
            showToast('Already in voice chat for this session', 3000);
            return;
        }
        // Leave current session first
        leaveVoiceChat();
    }

    _sessionId = sessionId;
    _peerId = crypto.randomUUID();
    _userName = localStorage.getItem('cam_user_id') || 'Unknown';

    // Resolve signaling server — in spoke mode, connect directly to hub
    // so all peers share the same in-memory voice room
    try {
        const cfg = await api('/api/settings/sync-config');
        if (cfg?.mode === 'spoke' && cfg?.hub_url) {
            _signalingBaseUrl = cfg.hub_url;
            console.log(`[Voice] Spoke mode — signaling via hub: ${_signalingBaseUrl}`);
        } else {
            _signalingBaseUrl = '';
            console.log('[Voice] Hub/standalone mode — signaling locally');
        }
    } catch {
        _signalingBaseUrl = '';
    }

    // Request microphone access
    try {
        _localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
            video: false,
        });
    } catch (err) {
        console.error('[Voice] Microphone access denied:', err.message);
        if (err.name === 'NotAllowedError') {
            showToast('Microphone access denied — check browser permissions', 5000);
        } else if (err.name === 'NotFoundError') {
            showToast('No microphone found on this device', 5000);
        } else {
            showToast('Failed to access microphone: ' + err.message, 5000);
        }
        _cleanup();
        return;
    }

    // Connect to signaling SSE
    try {
        _connectSignaling();
    } catch (err) {
        console.error('[Voice] Failed to connect signaling:', err.message);
        showToast('Failed to connect to voice signaling', 5000);
        _cleanup();
        return;
    }

    _isConnected = true;
    _isMuted = false;
    updateVoiceUI();
    showToast('Voice chat joined — mic is live', 3000);
    console.log(`[Voice] Joined voice chat for session ${sessionId} as ${_userName}`);
}

/**
 * Leave voice chat — close all connections and release mic.
 */
function leaveVoiceChat() {
    if (!_isConnected) return;

    // Notify server (send directly to signaling server — hub or local)
    if (_sessionId && _peerId) {
        const url = `${_signalingBaseUrl}/api/voice/signal/${_sessionId}`;
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ peerId: _peerId, type: 'leave' }),
        }).catch(() => { /* best effort */ });
    }

    _cleanup();
    showToast('Left voice chat', 2000);
    console.log('[Voice] Left voice chat');
}

/**
 * Toggle mute/unmute.
 */
function toggleVoiceMute() {
    if (!_isConnected || !_localStream) return;

    _isMuted = !_isMuted;
    for (const track of _localStream.getAudioTracks()) {
        track.enabled = !_isMuted;
    }
    updateVoiceUI();
    showToast(_isMuted ? 'Mic muted' : 'Mic unmuted', 2000);
}

/**
 * Check if we're currently in a voice chat.
 */
function isInVoiceChat(sessionId) {
    if (sessionId !== undefined) {
        return _isConnected && _sessionId === sessionId;
    }
    return _isConnected;
}

/**
 * Get current voice state for UI rendering.
 */
function getVoiceState() {
    return {
        connected: _isConnected,
        sessionId: _sessionId,
        muted: _isMuted,
        peerCount: _peers.size,
        peers: Array.from(_peers.entries()).map(([id, p]) => ({
            peerId: id,
            userName: p.userName,
        })),
    };
}


// ─── Signaling (SSE) ───

function _connectSignaling() {
    const url = `${_signalingBaseUrl}/api/voice/signal/${_sessionId}?peerId=${encodeURIComponent(_peerId)}&userName=${encodeURIComponent(_userName)}`;
    _sseSource = new EventSource(url);

    _sseSource.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            _handleSignal(msg);
        } catch (err) {
            console.error('[Voice] Failed to parse signal:', err);
        }
    };

    _sseSource.onerror = (err) => {
        console.error('[Voice] SSE connection error:', err);
        // EventSource auto-reconnects, but if we've been cleaned up, stop
        if (!_isConnected) {
            _sseSource?.close();
        }
    };
}

/**
 * Send a signaling message to the server.
 */
async function _sendSignal(data) {
    try {
        const url = `${_signalingBaseUrl}/api/voice/signal/${_sessionId}`;
        const body = JSON.stringify({ peerId: _peerId, ...data });
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            console.error('[Voice] Signal error:', err.error || resp.statusText);
        }
    } catch (err) {
        console.error('[Voice] Failed to send signal:', err.message);
    }
}

/**
 * Handle incoming signaling messages.
 */
async function _handleSignal(msg) {
    switch (msg.type) {
        case 'peers':
            // Initial peer list — create offers to each existing peer
            console.log(`[Voice] Room has ${msg.peers.length} existing peer(s)`);
            for (const peer of msg.peers) {
                await _createPeerConnection(peer.peerId, peer.userName, true);
            }
            break;

        case 'peer-joined':
            // A new peer joined — they will send us an offer, so just wait
            console.log(`[Voice] ${msg.userName} joined voice chat`);
            updateVoiceUI();
            break;

        case 'peer-left':
            // A peer left — close their connection
            console.log(`[Voice] ${msg.userName || msg.peerId} left voice chat`);
            _closePeerConnection(msg.peerId);
            updateVoiceUI();
            break;

        case 'offer':
            // Received an offer — create answer
            console.log(`[Voice] Received offer from ${msg.peerId}`);
            await _handleOffer(msg.peerId, msg.sdp);
            break;

        case 'answer':
            // Received an answer to our offer
            console.log(`[Voice] Received answer from ${msg.peerId}`);
            await _handleAnswer(msg.peerId, msg.sdp);
            break;

        case 'ice':
            // Received an ICE candidate
            await _handleIceCandidate(msg.peerId, msg.candidate);
            break;

        default:
            console.warn(`[Voice] Unknown signal type: ${msg.type}`);
    }
}


// ─── WebRTC Peer Connections ───

/**
 * Create a new peer connection. If `createOffer` is true, we initiate.
 */
async function _createPeerConnection(remotePeerId, userName, createOffer) {
    // Don't create duplicate connections
    if (_peers.has(remotePeerId)) {
        console.log(`[Voice] Already connected to ${remotePeerId}, skipping`);
        return;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    _peers.set(remotePeerId, { pc, userName: userName || 'Unknown' });

    // Add our local audio tracks to the connection
    if (_localStream) {
        for (const track of _localStream.getTracks()) {
            pc.addTrack(track, _localStream);
        }
    }

    // Handle incoming remote audio
    pc.ontrack = (event) => {
        console.log(`[Voice] Received audio track from ${userName || remotePeerId}`);
        _playRemoteAudio(remotePeerId, event.streams[0]);
    };

    // ICE candidate handling
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            _sendSignal({
                type: 'ice',
                targetPeerId: remotePeerId,
                candidate: event.candidate,
            });
        }
    };

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
        console.log(`[Voice] Connection to ${userName || remotePeerId}: ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            // Try reconnecting after a brief delay
            setTimeout(() => {
                if (pc.connectionState === 'failed') {
                    console.log(`[Voice] Cleaning up failed connection to ${remotePeerId}`);
                    _closePeerConnection(remotePeerId);
                    updateVoiceUI();
                }
            }, 5000);
        }
        updateVoiceUI();
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[Voice] ICE state for ${userName || remotePeerId}: ${pc.iceConnectionState}`);
    };

    // If we're the initiator, create and send an offer
    if (createOffer) {
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await _sendSignal({
                type: 'offer',
                targetPeerId: remotePeerId,
                sdp: pc.localDescription,
            });
        } catch (err) {
            console.error(`[Voice] Failed to create offer for ${remotePeerId}:`, err);
        }
    }

    updateVoiceUI();
}

/**
 * Handle an incoming WebRTC offer.
 */
async function _handleOffer(remotePeerId, sdp) {
    // Create the peer connection if it doesn't exist
    if (!_peers.has(remotePeerId)) {
        await _createPeerConnection(remotePeerId, null, false);
    }

    const peer = _peers.get(remotePeerId);
    if (!peer) return;

    try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await _sendSignal({
            type: 'answer',
            targetPeerId: remotePeerId,
            sdp: peer.pc.localDescription,
        });
    } catch (err) {
        console.error(`[Voice] Failed to handle offer from ${remotePeerId}:`, err);
    }
}

/**
 * Handle an incoming WebRTC answer.
 */
async function _handleAnswer(remotePeerId, sdp) {
    const peer = _peers.get(remotePeerId);
    if (!peer) {
        console.warn(`[Voice] Received answer from unknown peer ${remotePeerId}`);
        return;
    }

    try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
        console.error(`[Voice] Failed to handle answer from ${remotePeerId}:`, err);
    }
}

/**
 * Handle an incoming ICE candidate.
 */
async function _handleIceCandidate(remotePeerId, candidate) {
    const peer = _peers.get(remotePeerId);
    if (!peer) return;

    try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        // ICE candidate errors are often non-fatal
        console.warn(`[Voice] ICE candidate error for ${remotePeerId}:`, err.message);
    }
}


// ─── Audio Playback ───

/**
 * Play remote audio from a peer using an invisible <audio> element.
 */
function _playRemoteAudio(peerId, stream) {
    // Remove existing audio element for this peer
    const existingEl = document.getElementById(`voice-audio-${peerId}`);
    if (existingEl) existingEl.remove();

    const audio = document.createElement('audio');
    audio.id = `voice-audio-${peerId}`;
    audio.autoplay = true;
    audio.srcObject = stream;
    audio.style.display = 'none';
    document.body.appendChild(audio);

    // Some browsers need an explicit play() call
    audio.play().catch(err => {
        console.warn(`[Voice] Autoplay blocked for ${peerId}:`, err.message);
    });
}


// ─── Cleanup ───

function _cleanup() {
    // Close SSE
    if (_sseSource) {
        _sseSource.close();
        _sseSource = null;
    }

    // Close all peer connections
    for (const [peerId, peer] of _peers) {
        try { peer.pc.close(); } catch { /* ignore */ }
        const audioEl = document.getElementById(`voice-audio-${peerId}`);
        if (audioEl) audioEl.remove();
    }
    _peers.clear();

    // Release microphone
    if (_localStream) {
        for (const track of _localStream.getTracks()) {
            track.stop();
        }
        _localStream = null;
    }

    _isConnected = false;
    _sessionId = null;
    _peerId = null;
    _isMuted = false;

    updateVoiceUI();
}

/**
 * Close a specific peer connection.
 */
function _closePeerConnection(peerId) {
    const peer = _peers.get(peerId);
    if (peer) {
        try { peer.pc.close(); } catch { /* ignore */ }
        const audioEl = document.getElementById(`voice-audio-${peerId}`);
        if (audioEl) audioEl.remove();
        _peers.delete(peerId);
    }
}


// ─── UI Updates ───

/**
 * Update all voice-related UI elements.
 * Called whenever voice state changes.
 */
function updateVoiceUI() {
    // Update all voice buttons in review session cards
    document.querySelectorAll('.review-session-card').forEach(card => {
        const cardSessionId = parseInt(card.dataset.sessionId, 10);
        const voiceBtn = card.querySelector('.btn-voice');
        if (!voiceBtn) return;

        const inThisSession = _isConnected && _sessionId === cardSessionId;

        if (inThisSession) {
            voiceBtn.classList.add('voice-active');
            voiceBtn.title = 'Connected to voice chat (click to leave)';
        } else {
            voiceBtn.classList.remove('voice-active');
            voiceBtn.title = 'Join voice chat for this session';
        }
    });

    // Update the floating voice controls bar
    _renderVoiceControls();
}

/**
 * Render the floating voice controls bar (shown when in a voice chat).
 */
function _renderVoiceControls() {
    let bar = document.getElementById('voiceControlBar');

    if (!_isConnected) {
        if (bar) bar.remove();
        return;
    }

    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'voiceControlBar';
        bar.className = 'voice-control-bar';
        document.body.appendChild(bar);
    }

    const peerList = Array.from(_peers.values())
        .map(p => p.userName || 'Unknown')
        .join(', ');

    const peerCount = _peers.size;
    const micIcon = _isMuted ? '\uD83D\uDD07' : '\uD83C\uDF99\uFE0F';
    const micLabel = _isMuted ? 'Unmute' : 'Mute';

    bar.innerHTML = `
        <div class="voice-control-status">
            <span class="voice-control-indicator"></span>
            <span class="voice-control-label">Voice Chat</span>
            <span class="voice-control-peers">${peerCount} peer${peerCount !== 1 ? 's' : ''}</span>
            ${peerList ? `<span class="voice-control-names" title="${peerList}">${peerList}</span>` : ''}
        </div>
        <div class="voice-control-actions">
            <button class="voice-control-btn ${_isMuted ? 'voice-muted' : ''}" onclick="toggleVoiceMute()" title="${micLabel}">
                ${micIcon}
            </button>
            <button class="voice-control-btn voice-leave-btn" onclick="leaveVoiceChat()" title="Leave voice chat">
                \u260E\uFE0F Leave
            </button>
        </div>
    `;
}


// ─── Expose to global scope ───
window.joinVoiceChat = joinVoiceChat;
window.leaveVoiceChat = leaveVoiceChat;
window.toggleVoiceMute = toggleVoiceMute;
window.isInVoiceChat = isInVoiceChat;
window.getVoiceState = getVoiceState;

export {
    joinVoiceChat,
    leaveVoiceChat,
    toggleVoiceMute,
    isInVoiceChat,
    getVoiceState,
};
