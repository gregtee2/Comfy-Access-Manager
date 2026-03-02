/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * DMV - Player Module
 * Built-in media player and external player launch (RV / OpenRV).
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, formatSize, formatDuration, showToast } from './utils.js';

// ===========================================
//  OVERLAY STATE
// ===========================================
let overlayEnabled = false;
let overlayOptions = loadOverlayPrefs();
let overlayRafId = null;
let overlayCanvas = null;
let overlayCtx = null;

// ===========================================
//  POP-OUT PLAYER STATE
// ===========================================
let popoutWindow = null;
let presentationMode = false;
let presentationFrameRaf = null;
let hudTimeout = null;

function loadOverlayPrefs() {
    try {
        const saved = localStorage.getItem('dmv_overlay_prefs');
        if (saved) return JSON.parse(saved);
    } catch {}
    return { burnIn: true, watermark: true, safeAreas: false, frameCounter: true, watermarkText: 'INTERNAL REVIEW' };
}

function saveOverlayPrefs() {
    try { localStorage.setItem('dmv_overlay_prefs', JSON.stringify(overlayOptions)); } catch {}
}

// ===========================================
//  MEDIA PLAYER
// ===========================================

export function openPlayer(index) {
    state.playerAssets = state.assets;
    state.playerIndex = index;

    // If external player is the default, launch it instead of modal
    const defPlayer = state.settings?.default_player || 'browser';
    if (defPlayer !== 'browser') {
        const asset = state.playerAssets[index];
        if (asset) {
            openInExternalPlayer(asset.id);
            return;
        }
    }

    renderPlayer();
    document.getElementById('playerModal').style.display = 'flex';

    // Keyboard navigation
    document.addEventListener('keydown', playerKeyHandler);
}

function closePlayer() {
    destroyAllCaches();
    destroyCachedPlayback();
    document.getElementById('playerModal').style.display = 'none';
    document.removeEventListener('keydown', playerKeyHandler);

    // Hide metadata panel
    metaPanelVisible = false;
    const metaPanel = document.getElementById('playerMetaPanel');
    if (metaPanel) {
        metaPanel.style.display = 'none';
        const body = metaPanel.closest('.player-body');
        if (body) body.classList.remove('meta-open');
    }

    // Stop video if playing
    const video = document.querySelector('#playerContent video');
    if (video) video.pause();

    // Clean up overlay
    cleanupOverlay();
}

function playerKeyHandler(e) {
    // Normal player key handling
    if (e.key === 'Escape') {
        if (presentationMode) { togglePresentationMode(); return; }
        closePlayer();
    }

    // Helper: step frame via transport API (preferred) or fallback
    function keyFrameStep(delta) {
        e.preventDefault();
        if (playerTransportAPI) {
            playerTransportAPI.stepFrame(delta);
        } else if (cachedPlaybackState && frameCache?.ready) {
            cachedPause();
            const newIdx = Math.max(0, Math.min(cachedPlaybackState.frameIdx + delta, frameCache.frames.length - 1));
            cachedPlaybackState.frameIdx = newIdx;
            cachedPlaybackState.startFrame = newIdx;
            cachedPlaybackState.startTime = performance.now();
            showCachedFrame(newIdx / frameCache.fps);
        } else {
            const video = document.querySelector('#playerContent video');
            if (video) {
                video.pause();
                const fps = parseFloat(document.querySelector('.player-transport')?.dataset.fps) || 24;
                video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta * (1 / fps)));
            }
        }
    }

    // Helper: toggle play/pause via transport API (preferred) or fallback
    function keyTogglePlay() {
        e.preventDefault();
        if (playerTransportAPI) {
            playerTransportAPI.togglePlayPause();
        } else if (cachedPlaybackState && frameCache?.ready) {
            if (cachedPlaybackState.playing) cachedPause();
            else cachedPlay();
        } else {
            const video = document.querySelector('#playerContent video');
            if (video) video.paused ? video.play() : video.pause();
        }
    }

    // Arrow keys: frame step if video/cache present, otherwise asset navigation
    if (e.key === 'ArrowRight') {
        e.preventDefault();
        const video = document.querySelector('#playerContent video');
        if (video || cachedPlaybackState) { keyFrameStep(1); }
        else { playerNext(); if (presentationMode) { ensurePresentationHud(); resetPresentationHudTimer(); } }
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const video = document.querySelector('#playerContent video');
        if (video || cachedPlaybackState) { keyFrameStep(-1); }
        else { playerPrev(); if (presentationMode) { ensurePresentationHud(); resetPresentationHudTimer(); } }
    }
    // PageDown/PageUp: always navigate between assets
    if (e.key === 'PageDown') {
        playerNext();
        if (presentationMode) { ensurePresentationHud(); resetPresentationHudTimer(); }
    }
    if (e.key === 'PageUp') {
        playerPrev();
        if (presentationMode) { ensurePresentationHud(); resetPresentationHudTimer(); }
    }
    if (e.key === 'f' || e.key === 'F') togglePresentationMode();
    if ((e.key === 'h' || e.key === 'H') && presentationMode) {
        const modal = document.getElementById('playerModal');
        if (modal) modal.classList.toggle('pres-hud-hidden');
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        toggleMetaPanel();
    }
    if (e.key === ' ') { keyTogglePlay(); }
    // Frame stepping: , = prev frame, . = next frame
    if (e.key === ',' || e.key === '<') { keyFrameStep(-1); }
    if (e.key === '.' || e.key === '>') { keyFrameStep(1); }
    // J/K/L shuttle (video only - cache uses fixed fps)
    if (e.key === 'j' || e.key === 'J') {
        const video = document.querySelector('#playerContent video');
        if (video && !cachedPlaybackState?.playing) { video.playbackRate = Math.max(0.25, (video.playbackRate || 1) - 0.5); video.play(); }
    }
    if (e.key === 'k' || e.key === 'K') {
        if (cachedPlaybackState && frameCache?.ready) { cachedPause(); }
        else { const video = document.querySelector('#playerContent video'); if (video) { video.pause(); video.playbackRate = 1; } }
    }
    if (e.key === 'l') {
        const video = document.querySelector('#playerContent video');
        if (video) { video.playbackRate = Math.min(4, (video.playbackRate || 1) + 0.5); video.play(); }
    }
}

function playerNext() {
    if (state.playerIndex < state.playerAssets.length - 1) {
        state.playerIndex++;
        renderPlayer();
    }
}

function playerPrev() {
    if (state.playerIndex > 0) {
        state.playerIndex--;
        renderPlayer();
    }
}

function renderPlayer() {
    // Abort current build but keep pool intact for instant clip switching
    if (frameCacheAbort) { frameCacheAbort.abort(); frameCacheAbort = null; }
    frameCache = null;
    destroyCachedPlayback();
    const asset = state.playerAssets[state.playerIndex];
    if (!asset) return;

    document.getElementById('playerTitle').textContent = asset.vault_name;
    document.getElementById('playerIndex').textContent = `${state.playerIndex + 1} / ${state.playerAssets.length}`;

    const content = document.getElementById('playerContent');
    const fileUrl = `/api/assets/${asset.id}/file`;

    // Codecs browsers can play natively
    const browserCodecs = new Set(['h264', 'h265', 'hevc', 'vp8', 'vp9', 'av1', 'avc', 'avc1']);
    const needsTranscode = asset.media_type === 'video' && asset.codec && !browserCodecs.has(asset.codec.toLowerCase());

    if (asset.media_type === 'video') {
        const videoUrl = needsTranscode ? `/api/assets/${asset.id}/stream` : fileUrl;
        const fps = asset.fps || 24;
        content.innerHTML = `
            ${needsTranscode ? '<div style="text-align:center;color:var(--accent);font-size:0.75rem;margin-bottom:6px;">* Transcoding from ' + esc(asset.codec) + ' - may take a moment to start</div>' : ''}
            <video autoplay loop src="${videoUrl}" style="max-width:100%;max-height:calc(70vh - 44px);cursor:pointer;"></video>
            <div class="player-transport" data-fps="${fps}">
                <button class="pt-btn pt-play" title="Play/Pause (Space)">||</button>
                <button class="pt-btn pt-prev-frame" title="Previous frame (,)">|<</button>
                <div class="pt-scrub-wrap">
                    <input type="range" class="pt-scrub" min="0" max="1000" value="0" step="1">
                    <div class="pt-scrub-fill" style="width:0%"></div>
                </div>
                <button class="pt-btn pt-next-frame" title="Next frame (.)">>|</button>
                <span class="pt-time">00:00 / 00:00</span>
                <span class="pt-frame-counter"></span>
                <button class="pt-btn pt-loop active" title="Loop (L)"></button>
                <div class="pt-cache-bar" style="display:none" title="Caching frames for instant scrub..."><div class="pt-cache-fill"></div></div>
            </div>
        `;
        initTransportControls(content, fps);
    } else if (asset.media_type === 'image' || asset.media_type === 'exr') {
        content.innerHTML = `<img src="${fileUrl}" alt="${esc(asset.vault_name)}">`;
    } else if (asset.media_type === 'audio') {
        content.innerHTML = `
            <div style="text-align:center;padding:40px;">
                <div style="font-size:4rem;margin-bottom:20px;"></div>
                <audio controls autoplay src="${fileUrl}" style="width:400px;"></audio>
            </div>
        `;
    } else {
        content.innerHTML = `
            <div style="text-align:center;padding:40px;color:var(--text-dim);">
                <div style="font-size:4rem;margin-bottom:12px;"></div>
                <p>Preview not available for this file type.</p>
                <a href="${fileUrl}" download style="color:var(--accent-light);">Download File</a>
            </div>
        `;
    }

    // Meta info
    const meta = document.getElementById('playerMeta');
    const parts = [];
    if (asset.width && asset.height) parts.push(`<span> ${asset.width}x${asset.height}</span>`);
    if (asset.duration) parts.push(`<span>Dur: ${formatDuration(asset.duration)}</span>`);
    if (asset.fps) parts.push(`<span> ${asset.fps} fps</span>`);
    if (asset.codec) parts.push(`<span> ${asset.codec}</span>`);
    parts.push(`<span> ${formatSize(asset.file_size)}</span>`);
    if (asset.original_name !== asset.vault_name) {
        parts.push(`<span> Originally: ${esc(asset.original_name)}</span>`);
    }
    parts.push(`<button class="player-rv-btn" onclick="openInRV(${asset.id})" title="Open in RV"> RV</button>`);
    parts.push(`<button class="player-rv-btn" onclick="sendToRV(${asset.id}, 'merge')" title="Add to running RV session">+ Add to RV</button>`);
    meta.innerHTML = parts.join('');

    // Update generation metadata panel if it's open
    if (metaPanelVisible) renderMetaPanel();

    // Set up overlay after content is rendered
    requestAnimationFrame(() => setupOverlay(asset));
}

// ===========================================
//  REVIEW OVERLAY SYSTEM
// ===========================================

function setupOverlay(asset) {
    // Stop any existing overlay loop
    if (overlayRafId) { cancelAnimationFrame(overlayRafId); overlayRafId = null; }

    // Find the media element (video or image)
    const content = document.getElementById('playerContent');
    const mediaEl = content.querySelector('video') || content.querySelector('img');
    if (!mediaEl) return;

    // Remove existing overlay canvas
    const existing = content.querySelector('.overlay-canvas');
    if (existing) existing.remove();

    // Make content container position:relative for overlay positioning
    content.style.position = 'relative';

    // Create canvas overlay
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.className = 'overlay-canvas';
    overlayCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:10;';
    content.appendChild(overlayCanvas);
    overlayCtx = overlayCanvas.getContext('2d');

    // Store asset info on canvas for rendering
    overlayCanvas._asset = asset;
    overlayCanvas._mediaEl = mediaEl;

    // Size the canvas to match media once loaded
    const sizeCanvas = () => {
        const rect = mediaEl.getBoundingClientRect();
        const containerRect = content.getBoundingClientRect();
        overlayCanvas.width = rect.width;
        overlayCanvas.height = rect.height;
        // Position canvas exactly over the media
        overlayCanvas.style.left = (rect.left - containerRect.left) + 'px';
        overlayCanvas.style.top = (rect.top - containerRect.top) + 'px';
        overlayCanvas.style.width = rect.width + 'px';
        overlayCanvas.style.height = rect.height + 'px';
    };

    if (mediaEl.tagName === 'VIDEO') {
        mediaEl.addEventListener('loadeddata', sizeCanvas, { once: true });
        mediaEl.addEventListener('playing', sizeCanvas, { once: true });
        // Also try immediately if already loaded
        if (mediaEl.readyState >= 2) sizeCanvas();
    } else {
        if (mediaEl.complete) sizeCanvas();
        else mediaEl.addEventListener('load', sizeCanvas, { once: true });
    }

    // Resize handler
    const resizeObs = new ResizeObserver(sizeCanvas);
    resizeObs.observe(mediaEl);
    overlayCanvas._resizeObs = resizeObs;

    // Start render loop
    renderOverlayToolbar();
    if (overlayEnabled) startOverlayLoop();
}

function startOverlayLoop() {
    if (overlayRafId) cancelAnimationFrame(overlayRafId);

    function loop() {
        drawOverlay();
        overlayRafId = requestAnimationFrame(loop);
    }
    overlayRafId = requestAnimationFrame(loop);
}

function stopOverlayLoop() {
    if (overlayRafId) { cancelAnimationFrame(overlayRafId); overlayRafId = null; }
    if (overlayCtx && overlayCanvas) {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
}

function drawOverlay() {
    if (!overlayCanvas || !overlayCtx || !overlayEnabled) return;
    const ctx = overlayCtx;
    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    if (w === 0 || h === 0) return;

    const asset = overlayCanvas._asset;
    const mediaEl = overlayCanvas._mediaEl;

    ctx.clearRect(0, 0, w, h);

    const fontSize = Math.max(12, Math.min(w * 0.018, 22));
    const padding = fontSize * 0.8;

    // --- Safe Areas ---
    if (overlayOptions.safeAreas) {
        // Action safe = 90% of frame
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([8, 4]);
        const ax = w * 0.05, ay = h * 0.05, aw = w * 0.9, ah = h * 0.9;
        ctx.strokeRect(ax, ay, aw, ah);

        // Title safe = 80% of frame
        ctx.strokeStyle = 'rgba(255, 200, 0, 0.35)';
        ctx.setLineDash([4, 4]);
        const tx = w * 0.1, ty = h * 0.1, tw = w * 0.8, th = h * 0.8;
        ctx.strokeRect(tx, ty, tw, th);
        ctx.setLineDash([]);

        // Labels
        ctx.font = `${fontSize * 0.6}px monospace`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.fillText('ACTION SAFE', ax + 4, ay + fontSize * 0.7);
        ctx.fillStyle = 'rgba(255, 200, 0, 0.35)';
        ctx.fillText('TITLE SAFE', tx + 4, ty + fontSize * 0.7);

        // Center crosshair
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 8]);
        ctx.beginPath();
        ctx.moveTo(w / 2, h * 0.4); ctx.lineTo(w / 2, h * 0.6);
        ctx.moveTo(w * 0.4, h / 2); ctx.lineTo(w * 0.6, h / 2);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // --- Burn-in Text (top-left: metadata, top-right: resolution/codec) ---
    if (overlayOptions.burnIn) {
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.textBaseline = 'top';

        // Semi-transparent background strip at top
        const stripH = fontSize * 2.6;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, 0, w, stripH);

        // Top-left: hierarchy info
        ctx.fillStyle = '#ffffff';
        const hierarchy = [];
        if (asset.project_name) hierarchy.push(asset.project_name);
        if (asset.sequence_name) hierarchy.push(asset.sequence_name);
        if (asset.shot_name) hierarchy.push(asset.shot_name);
        const hierStr = hierarchy.length > 0 ? hierarchy.join(' > ') : '';

        ctx.fillText(hierStr || asset.vault_name, padding, padding * 0.5);

        // Second line: filename + role
        ctx.font = `${fontSize * 0.85}px monospace`;
        ctx.fillStyle = '#cccccc';
        let line2 = asset.vault_name;
        if (asset.role_name) line2 += `  [${asset.role_name}]`;
        ctx.fillText(line2, padding, padding * 0.5 + fontSize * 1.2);

        // Top-right: resolution + codec + fps
        ctx.textAlign = 'right';
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.fillStyle = '#ffffff';
        const techParts = [];
        if (asset.width && asset.height) techParts.push(`${asset.width}x${asset.height}`);
        if (asset.codec) techParts.push(asset.codec.toUpperCase());
        if (asset.fps) techParts.push(`${asset.fps}fps`);
        ctx.fillText(techParts.join('  .  '), w - padding, padding * 0.5);

        // File size on second line top-right
        ctx.font = `${fontSize * 0.85}px monospace`;
        ctx.fillStyle = '#cccccc';
        ctx.fillText(formatSize(asset.file_size), w - padding, padding * 0.5 + fontSize * 1.2);

        ctx.textAlign = 'left';
    }

    // --- Frame Counter + Timecode (bottom-left) ---
    if (overlayOptions.frameCounter && mediaEl.tagName === 'VIDEO') {
        const fps = asset.fps || 24;
        const currentTime = mediaEl.currentTime || 0;
        const totalDuration = mediaEl.duration || 0;
        const currentFrame = Math.floor(currentTime * fps);
        const totalFrames = Math.floor(totalDuration * fps);

        // Timecode: HH:MM:SS:FF
        const tc = timeToTimecode(currentTime, fps);
        const tcTotal = timeToTimecode(totalDuration, fps);

        ctx.font = `bold ${fontSize * 1.1}px monospace`;
        ctx.textBaseline = 'bottom';

        // Background strip at bottom-left
        const tcText = `${tc}  F${String(currentFrame).padStart(5, '0')} / ${totalFrames}`;
        const tcWidth = ctx.measureText(tcText).width + padding * 2;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, h - fontSize * 2.2, tcWidth, fontSize * 2.2);

        ctx.fillStyle = '#00ff88';
        ctx.fillText(tc, padding, h - padding * 0.6);

        ctx.font = `${fontSize * 0.85}px monospace`;
        ctx.fillStyle = '#aaaaaa';
        ctx.fillText(`F${String(currentFrame).padStart(5, '0')} / ${totalFrames}`, padding, h - padding * 0.6 - fontSize * 1.1);
    }

    // --- Watermark (center, semi-transparent) ---
    if (overlayOptions.watermark && overlayOptions.watermarkText) {
        const wmText = overlayOptions.watermarkText;
        const wmSize = Math.max(16, w * 0.04);
        ctx.font = `bold ${wmSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Measure and draw
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(-Math.PI / 12); // Slight diagonal
        ctx.fillText(wmText, 0, 0);
        ctx.restore();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
    }
}

function timeToTimecode(seconds, fps) {
    const totalFrames = Math.floor(seconds * fps);
    const ff = totalFrames % fps;
    const totalSeconds = Math.floor(seconds);
    const ss = totalSeconds % 60;
    const mm = Math.floor(totalSeconds / 60) % 60;
    const hh = Math.floor(totalSeconds / 3600);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

// --- Overlay Toolbar ---

function renderOverlayToolbar() {
    // Insert toolbar into player header if not already there
    let toolbar = document.getElementById('overlayToolbar');
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'overlayToolbar';
        toolbar.className = 'overlay-toolbar';
        const header = document.querySelector('.player-header');
        if (header) {
            // Insert before close button
            const closeBtn = header.querySelector('.player-close');
            header.insertBefore(toolbar, closeBtn);
        }
    }

    toolbar.innerHTML = `
        <button class="overlay-toggle ${overlayEnabled ? 'active' : ''}" 
                onclick="toggleOverlayMaster()" title="Toggle review overlays">
             Overlay ${overlayEnabled ? 'ON' : 'OFF'}
        </button>
        ${overlayEnabled ? `
            <button class="overlay-opt-btn ${overlayOptions.burnIn ? 'active' : ''}" 
                    onclick="toggleOverlayOption('burnIn')" title="Burn-in metadata text"></button>
            <button class="overlay-opt-btn ${overlayOptions.frameCounter ? 'active' : ''}" 
                    onclick="toggleOverlayOption('frameCounter')" title="Frame counter + timecode"></button>
            <button class="overlay-opt-btn ${overlayOptions.watermark ? 'active' : ''}" 
                    onclick="toggleOverlayOption('watermark')" title="Watermark text"></button>
            <button class="overlay-opt-btn ${overlayOptions.safeAreas ? 'active' : ''}" 
                    onclick="toggleOverlayOption('safeAreas')" title="Safe area guides"></button>
            <button class="overlay-opt-btn" onclick="editWatermarkText()" title="Edit watermark text">Edit</button>
        ` : ''}
    `;
}

function toggleOverlayMaster() {
    overlayEnabled = !overlayEnabled;
    renderOverlayToolbar();
    if (overlayEnabled) {
        startOverlayLoop();
    } else {
        stopOverlayLoop();
    }
}

function toggleOverlayOption(key) {
    overlayOptions[key] = !overlayOptions[key];
    saveOverlayPrefs();
    renderOverlayToolbar();
}

function editWatermarkText() {
    const newText = prompt('Watermark text:', overlayOptions.watermarkText || 'INTERNAL REVIEW');
    if (newText !== null) {
        overlayOptions.watermarkText = newText;
        saveOverlayPrefs();
    }
}

function cleanupOverlay() {
    if (overlayRafId) { cancelAnimationFrame(overlayRafId); overlayRafId = null; }
    if (overlayCanvas && overlayCanvas._resizeObs) {
        overlayCanvas._resizeObs.disconnect();
    }
    // Remove toolbar
    const toolbar = document.getElementById('overlayToolbar');
    if (toolbar) toolbar.remove();
}

// ===========================================
//  EXTERNAL PLAYER LAUNCH
// ===========================================

async function openInExternalPlayer(assetId) {
    try {
        const player = state.settings?.default_player || 'rv';
        const customPath = state.settings?.custom_player_path || '';
        await api(`/api/assets/${assetId}/open-external`, {
            method: 'POST',
            body: { player, customPath }
        });
        showToast('Launched in external player');
        window.blur();
    } catch (err) {
        showToast('Failed to launch player: ' + err.message, 5000);
    }
}



async function openInRV(assetId) {
    try {
        // Use rv-push endpoint for persistent session (uses rvpush if RV running, launches new if not)
        await api('/api/assets/rv-push', { method: 'POST', body: { ids: [assetId], mode: 'set' } });
        showToast('Loaded in RV');
        window.blur();
    } catch (err) {
        showToast('Failed to launch RV: ' + err.message, 5000);
    }
}

/**
 * Send a single asset to an already-running RV session (merge mode = add, not replace).
 * If RV isn't running, starts a new session with -network.
 */
async function sendToRV(assetId, mode = 'merge') {
    try {
        const res = await api('/api/assets/rv-push', {
            method: 'POST',
            body: { ids: [assetId], mode }
        });
        showToast(res.message || `Sent to RV (${mode})`);
        window.blur();
    } catch (err) {
        showToast('Failed to send to RV: ' + err.message, 5000);
    }
}

/**
 * Send all selected assets to RV (merge or set mode).
 * Default: 'set' for replace, 'merge' to add to existing sources.
 */
async function sendSelectedToRV(mode = 'set') {
    const { state } = await import('./state.js');
    if (!state.selectedAssets || state.selectedAssets.length === 0) {
        showToast('Select clips first (Ctrl-click or Shift-click)', 4000);
        return;
    }
    try {
        const res = await api('/api/assets/rv-push', {
            method: 'POST',
            body: { ids: state.selectedAssets, mode }
        });
        showToast(res.message || `${state.selectedAssets.length} clip(s) sent to RV`);
        window.blur();
    } catch (err) {
        showToast('Failed to send to RV: ' + err.message, 5000);
    }
}



// ===========================================

/**
 * Open built-in player using whatever is already set in state.playerAssets/playerIndex.
 * Called by browser.js playSelectedAssets() which pre-populates the filtered list.
 */
function openPlayerDirect() {
    renderPlayer();
    document.getElementById('playerModal').style.display = 'flex';
    document.addEventListener('keydown', playerKeyHandler);
}

// ===========================================
//  CUSTOM VIDEO TRANSPORT CONTROLS + FRAME CACHE
// ===========================================

// Active frame cache pointer (points to an entry in the pool)
let frameCache = null;  // { frames: ImageBitmap[], fps, duration, width, height, ready }
let frameCacheAbort = null;  // AbortController for current clip's cache build

// --- Multi-Clip Cache Pool (RV-style pre-buffering) ---
const frameCachePool = new Map();  // Map<assetId, { frames, fps, duration, width, height, ready }>
const precacheAborts = new Map();  // Map<assetId, AbortController>
const MAX_POOL_SIZE = 5;           // Max clips to keep cached in memory

/** Clear active cache pointer + abort current build (pool entries preserved) */
function destroyFrameCache() {
    if (frameCacheAbort) { frameCacheAbort.abort(); frameCacheAbort = null; }
    frameCache = null;  // Don't close bitmaps - they live in the pool
}

/** Close all ImageBitmaps in a cache entry (handles gap-fill shared refs) */
function _closeCacheEntry(entry) {
    if (!entry?.frames) return;
    const unique = new Set(entry.frames.filter(Boolean));
    for (const bmp of unique) { try { bmp.close(); } catch {} }
}

/** Remove a specific clip from the cache pool and free its memory */
function evictFromPool(assetId) {
    const entry = frameCachePool.get(assetId);
    if (entry) { _closeCacheEntry(entry); frameCachePool.delete(assetId); }
    const ac = precacheAborts.get(assetId);
    if (ac) { ac.abort(); precacheAborts.delete(assetId); }
}

/** Evict furthest-from-current clips when pool exceeds MAX_POOL_SIZE */
function evictOldCaches(keepAssetId) {
    if (frameCachePool.size <= MAX_POOL_SIZE) return;
    const currentIdx = state.playerAssets?.findIndex(a => a.id === keepAssetId) ?? -1;
    const ids = [...frameCachePool.keys()].filter(id => id !== keepAssetId);
    ids.sort((a, b) => {
        const aIdx = state.playerAssets?.findIndex(x => x.id === a) ?? 999;
        const bIdx = state.playerAssets?.findIndex(x => x.id === b) ?? 999;
        return Math.abs(bIdx - currentIdx) - Math.abs(aIdx - currentIdx);
    });
    while (frameCachePool.size > MAX_POOL_SIZE && ids.length) {
        evictFromPool(ids.shift());
    }
}

/** Destroy ALL caches (pool + active) - call on player close */
function destroyAllCaches() {
    for (const [, ac] of precacheAborts) ac.abort();
    precacheAborts.clear();
    if (frameCacheAbort) { frameCacheAbort.abort(); frameCacheAbort = null; }
    for (const [, entry] of frameCachePool) _closeCacheEntry(entry);
    frameCachePool.clear();
    frameCache = null;
}

/**
 * Show a cached frame on the scrub canvas overlay - instant, no decode lag.
 * Can be called from anywhere (keyboard handler, scrub, frame step).
 * Accepts optional canvas/ctx/video elements, or finds them from DOM.
 */
function showCachedFrame(timePos, canvas, ctx, videoEl) {
    if (!frameCache?.ready) return false;
    const frameIdx = Math.min(
        Math.floor(timePos * frameCache.fps),
        frameCache.frames.length - 1
    );
    if (frameIdx < 0 || !frameCache.frames[frameIdx]) return false;

    // Find elements if not provided
    if (!canvas) canvas = document.querySelector('.pt-scrub-canvas');
    if (!canvas) return false;
    if (!ctx) ctx = canvas.getContext('2d');
    if (!videoEl) videoEl = document.querySelector('#playerContent video');

    // Size canvas to match display area (use container since video may be hidden)
    const container = (videoEl || canvas).parentElement || document.getElementById('playerContent');
    const rect = canvas._cachedRect || container.getBoundingClientRect();
    if (canvas.width !== frameCache.width) canvas.width = frameCache.width;
    if (canvas.height !== frameCache.height) canvas.height = frameCache.height;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    canvas.style.display = 'block';
    if (videoEl) videoEl.style.visibility = 'hidden';

    ctx.drawImage(frameCache.frames[frameIdx], 0, 0);
    return true;
}

/**
 * Frame cache builder - dispatches to WebCodecs (primary) or RVFC (fallback).
 *
 * WebCodecs + mp4box.js gives 100% frame-accurate decode at GPU speed.
 * RVFC fallback handles WebM or browsers without WebCodecs.
 */
async function buildFrameCache(videoSrc, fps, onProgress, externalAbort) {
    const ac = externalAbort || new AbortController();
    if (!externalAbort) frameCacheAbort = ac;

    console.log('[FrameCache] buildFrameCache called. WebCodecs:', typeof VideoDecoder !== 'undefined', 'MP4Box:', typeof MP4Box !== 'undefined');

    // Primary: WebCodecs + mp4box demuxer (MP4/MOV with H.264/H.265/VP9/AV1)
    if (typeof VideoDecoder !== 'undefined' && typeof MP4Box !== 'undefined') {
        try {
            const result = await _buildCacheWebCodecs(videoSrc, fps, onProgress, ac);
            if (result) return result;
            console.warn('[FrameCache] WebCodecs returned null, falling back to RVFC');
        } catch (e) {
            console.warn('[FrameCache] WebCodecs failed, falling back to RVFC:', e.message);
        }
    }

    // Fallback: RVFC (requestVideoFrameCallback) or seek-per-frame
    return _buildCacheRVFC(videoSrc, fps, onProgress, ac);
}

/**
 * WebCodecs path: fetch -> mp4box demux -> VideoDecoder -> ImageBitmap[].
 * Split into 3 phases to avoid async race conditions in mp4box callbacks:
 *   Phase 1: Download video file
 *   Phase 2: Demux - parse MP4 container and collect all encoded samples (fully sync)
 *   Phase 3: Decode - validate config, decode frames with VideoDecoder
 */
async function _buildCacheWebCodecs(videoSrc, fps, onProgress, ac) {
    // -- Phase 1: Download --
    console.log('[FrameCache] WC: fetching video...');
    const response = await fetch(videoSrc, { signal: ac.signal });
    const buffer = await response.arrayBuffer();
    console.log('[FrameCache] WC: downloaded', (buffer.byteLength / 1024 / 1024).toFixed(1), 'MB');
    if (ac.signal.aborted) return null;

    // -- Phase 2: Demux (all mp4box callbacks are synchronous - no awaits!) --
    const demux = await _demuxMP4(buffer);
    if (!demux) return null;

    const { track, trak, samples, duration } = demux;

    // Get coded dimensions from sample entry
    const sampleEntry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
    const w = sampleEntry?.width || track.track_width || 0;
    const h = sampleEntry?.height || track.track_height || 0;
    if (!w || !h) { console.warn('[FrameCache] Could not determine video dimensions'); return null; }

    const totalFrames = Math.ceil(duration * fps);
    if (totalFrames > 1800) { if (onProgress) onProgress(-1, totalFrames); return null; }

    console.log('[FrameCache] WC: demuxed', samples.length, 'samples, codec:', track.codec, w + 'x' + h);

    // -- Phase 3: Decode (async is fine here - no mp4box interaction) --
    const description = _getCodecDescription(trak);

    let config = { codec: track.codec, codedWidth: w, codedHeight: h, hardwareAcceleration: 'prefer-hardware' };
    if (description) config.description = description;

    // Validate config with fallback chain
    let supported = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!supported.supported) {
        config.hardwareAcceleration = 'no-preference';
        supported = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    }
    if (!supported.supported && description) {
        delete config.description;
        supported = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    }
    if (!supported.supported) { console.warn('[FrameCache] Codec not supported:', track.codec); return null; }

    console.log('[FrameCache] WC: config accepted, decoding', totalFrames, 'frames...');
    return _decodeAllFrames(samples, supported.config || config, totalFrames, fps, w, h, duration, onProgress, ac);
}

/**
 * Phase 2: Demux MP4 container with mp4box.js - extract track info and all encoded samples.
 * CRITICAL: onReady is NOT async - everything is synchronous so mp4box can deliver
 * samples during appendBuffer/flush without race conditions.
 */
function _demuxMP4(buffer) {
    return new Promise((resolve) => {
        const file = MP4Box.createFile();
        let trackInfo = null;
        const collectedSamples = [];
        let expectedSamples = 0;
        let resolved = false;

        const finish = () => {
            if (resolved) return;
            resolved = true;
            if (!trackInfo || collectedSamples.length === 0) {
                resolve(null);
            } else {
                resolve({
                    track: trackInfo.track,
                    trak: trackInfo.trak,
                    samples: collectedSamples,
                    duration: trackInfo.info.duration / trackInfo.info.timescale
                });
            }
        };

        file.onReady = (info) => {
            // NOT async - must be fully synchronous so samples arrive during appendBuffer/flush
            const track = info.videoTracks?.[0];
            if (!track) { finish(); return; }

            const trak = file.getTrackById(track.id);
            trackInfo = { track, trak, info };
            expectedSamples = track.nb_samples;

            file.onSamples = (id, ref, samps) => {
                collectedSamples.push(...samps);
                if (collectedSamples.length >= expectedSamples) finish();
            };
            file.setExtractionOptions(track.id);
            file.start();
        };

        file.onError = () => finish();

        buffer.fileStart = 0;
        file.appendBuffer(buffer);
        file.flush();

        // If all samples were delivered synchronously (common for single-buffer feeds)
        if (trackInfo && collectedSamples.length >= expectedSamples) {
            finish();
        }
        // Safety timeout if samples don't arrive
        setTimeout(() => { if (!resolved) { console.warn('[FrameCache] mp4box sample extraction timed out'); finish(); } }, 5000);
    });
}

/**
 * Phase 3: Decode all collected samples with VideoDecoder -> ImageBitmap array.
 * Samples are pre-collected from demux phase - no mp4box interaction needed.
 */
function _decodeAllFrames(samples, config, totalFrames, fps, w, h, duration, onProgress, ac) {
    const frames = new Array(totalFrames).fill(null);
    const pendingBitmaps = [];
    let captured = 0;

    // OffscreenCanvas materializes GPU-backed VideoFrames to CPU memory
    const matCanvas = new OffscreenCanvas(w, h);
    const matCtx = matCanvas.getContext('2d');
    const cacheStartTime = performance.now();

    return new Promise((resolve) => {
        const decoder = new VideoDecoder({
            output: (frame) => {
                if (ac.signal.aborted) { frame.close(); return; }
                const frameIdx = Math.min(Math.round(frame.timestamp / 1e6 * fps), totalFrames - 1);
                matCtx.drawImage(frame, 0, 0);
                frame.close();
                const p = createImageBitmap(matCanvas).then(bmp => {
                    if (ac.signal.aborted) { bmp.close(); return; }
                    frames[frameIdx] = bmp;
                    captured++;
                    if (onProgress && captured % 10 === 0) onProgress(captured, totalFrames);
                }).catch(() => {});
                pendingBitmaps.push(p);
            },
            error: (e) => {
                console.warn('[FrameCache] VideoDecoder error:', e.message);
                try { decoder.close(); } catch {}
                resolve(null);
            }
        });

        decoder.configure(config);

        // Feed all encoded samples to decoder
        for (const sample of samples) {
            if (ac.signal.aborted) break;
            decoder.decode(new EncodedVideoChunk({
                type: sample.is_sync ? 'key' : 'delta',
                timestamp: (1e6 * sample.cts) / sample.timescale,
                duration: (1e6 * sample.duration) / sample.timescale,
                data: sample.data
            }));
        }

        // Flush decoder - waits for all queued frames to be decoded
        decoder.flush().then(async () => {
            await Promise.all(pendingBitmaps);
            if (ac.signal.aborted) { resolve(null); return; }

            _fillFrameGaps(frames);
            if (onProgress) onProgress(totalFrames, totalFrames);

            const elapsed = ((performance.now() - cacheStartTime) / 1000).toFixed(1);
            const gaps = frames.filter(f => !f).length;
            console.log(`[FrameCache] Success: WebCodecs: ${totalFrames} frames in ${elapsed}s (${gaps} gaps), codec: ${config.codec}, ${w}x${h}`);
            try { decoder.close(); } catch {}
            resolve({ frames, fps, duration, width: w, height: h, ready: true });
        }).catch(() => resolve(null));
    });
}

/**
 * Extract codec-specific description (SPS/PPS for H.264, etc.) from mp4box trak box.
 * Required by VideoDecoder.configure() for proper initialization.
 */
function _getCodecDescription(trak) {
    try {
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
            const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
            if (box) {
                const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                box.write(stream);
                // Skip 8-byte box header (4 bytes size + 4 bytes type)
                return new Uint8Array(stream.buffer, 8);
            }
        }
    } catch (e) {
        console.warn('[FrameCache] Could not extract codec description:', e.message);
    }
    return undefined;
}

/**
 * RVFC fallback: plays video at 2x with requestVideoFrameCallback to capture frames.
 * Works for any format the browser can play, but may drop frames at high speeds.
 * Final fallback within this: seek-per-frame (slow but universal).
 */
async function _buildCacheRVFC(videoSrc, fps, onProgress, ac) {
    console.log('[FrameCache] Using RVFC fallback path');
    return new Promise((resolve) => {
        const extractor = document.createElement('video');
        extractor.muted = true;
        extractor.preload = 'auto';
        extractor.playsInline = true;
        extractor.src = videoSrc;

        extractor.addEventListener('loadedmetadata', () => {
            if (ac.signal.aborted) { resolve(null); return; }

            const duration = extractor.duration;
            if (!isFinite(duration) || duration <= 0) { resolve(null); return; }

            const totalFrames = Math.ceil(duration * fps);
            const w = extractor.videoWidth;
            const h = extractor.videoHeight;

            if (totalFrames > 1800) {
                if (onProgress) onProgress(-1, totalFrames);
                resolve(null);
                return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: false });

            const frames = new Array(totalFrames).fill(null);
            let captured = 0;
            const pendingBitmaps = [];

            const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

            if (hasRVFC) {
                const captureFrame = (now, metadata) => {
                    if (ac.signal.aborted) return;

                    const frameIdx = Math.min(
                        Math.round(metadata.mediaTime * fps),
                        totalFrames - 1
                    );

                    if (frameIdx >= 0 && !frames[frameIdx]) {
                        ctx.drawImage(extractor, 0, 0, w, h);
                        try {
                            const p = createImageBitmap(canvas).then(bmp => {
                                if (ac.signal.aborted) { bmp.close(); return; }
                                frames[frameIdx] = bmp;
                                captured++;
                                if (onProgress && captured % 10 === 0) onProgress(captured, totalFrames);
                            });
                            pendingBitmaps.push(p);
                        } catch { /* skip frame */ }
                    }

                    if (!extractor.ended && !ac.signal.aborted) {
                        extractor.requestVideoFrameCallback(captureFrame);
                    }
                };

                extractor.requestVideoFrameCallback(captureFrame);
                extractor.playbackRate = 2;
                extractor.play().catch(() => {});

                extractor.addEventListener('ended', async () => {
                    if (ac.signal.aborted) { resolve(null); return; }
                    await Promise.all(pendingBitmaps);
                    if (ac.signal.aborted) { resolve(null); return; }
                    _fillFrameGaps(frames);
                    const result = { frames, fps, duration, width: w, height: h, ready: true };
                    if (onProgress) onProgress(totalFrames, totalFrames);
                    extractor.src = '';
                    resolve(result);
                });
            } else {
                (async () => {
                    const frameDur = 1 / fps;
                    for (let i = 0; i < totalFrames; i++) {
                        if (ac.signal.aborted) { resolve(null); return; }
                        extractor.currentTime = Math.min(i * frameDur, duration - 0.001);
                        await new Promise(r => {
                            const onSeeked = () => { extractor.removeEventListener('seeked', onSeeked); r(); };
                            extractor.addEventListener('seeked', onSeeked);
                        });
                        if (ac.signal.aborted) { resolve(null); return; }
                        ctx.drawImage(extractor, 0, 0, w, h);
                        try { frames[i] = await createImageBitmap(canvas); } catch { frames[i] = null; }
                        captured++;
                        if (onProgress && captured % 5 === 0) onProgress(captured, totalFrames);
                    }
                    if (ac.signal.aborted) { resolve(null); return; }
                    const result = { frames, fps, duration, width: w, height: h, ready: true };
                    if (onProgress) onProgress(totalFrames, totalFrames);
                    extractor.src = '';
                    resolve(result);
                })();
            }
        });

        extractor.addEventListener('error', () => { resolve(null); });
    });
}

/** Fill gaps in frame array with nearest available frame (for high-speed capture) */
function _fillFrameGaps(frames) {
    // Forward pass: fill nulls with last known good frame
    let lastGood = null;
    for (let i = 0; i < frames.length; i++) {
        if (frames[i]) lastGood = frames[i];
        else if (lastGood) frames[i] = lastGood;
    }
    // Backward pass: fill any remaining leading nulls
    lastGood = null;
    for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i]) lastGood = frames[i];
        else if (lastGood) frames[i] = lastGood;
    }
}

/**
 * Pre-cache adjacent clips (next + prev) so clip switching is instant.
 * Runs serially in the background after the current clip finishes caching.
 */
async function precacheAdjacent(currentAssetId) {
    const idx = state.playerAssets?.findIndex(a => a.id === currentAssetId) ?? -1;
    if (idx < 0 || !state.playerAssets) return;

    // Determine which adjacent clips to pre-cache
    const adjacentIds = new Set();
    if (idx + 1 < state.playerAssets.length) adjacentIds.add(state.playerAssets[idx + 1].id);
    if (idx - 1 >= 0) adjacentIds.add(state.playerAssets[idx - 1].id);

    // Cancel precaches for clips that are no longer adjacent
    for (const [id, ac] of precacheAborts) {
        if (!adjacentIds.has(id)) { ac.abort(); precacheAborts.delete(id); }
    }

    const browserCodecs = new Set(['h264', 'h265', 'hevc', 'vp8', 'vp9', 'av1', 'avc', 'avc1']);

    for (const adjId of adjacentIds) {
        if (frameCachePool.has(adjId)) continue;    // Already cached
        if (precacheAborts.has(adjId)) continue;    // Already being cached

        const asset = state.playerAssets.find(a => a.id === adjId);
        if (!asset || asset.media_type !== 'video') continue;

        const needsTranscode = asset.codec && !browserCodecs.has(asset.codec.toLowerCase());
        const videoUrl = needsTranscode
            ? `/api/assets/${asset.id}/stream`
            : `/api/assets/${asset.id}/file`;
        const clipFps = asset.fps || 24;

        const ac = new AbortController();
        precacheAborts.set(adjId, ac);

        try {
            const cache = await buildFrameCache(videoUrl, clipFps, null, ac);
            if (cache && !ac.signal.aborted) {
                frameCachePool.set(adjId, cache);
                evictOldCaches(currentAssetId);
            }
        } catch { /* ignore precache failures */ }

        precacheAborts.delete(adjId);
    }
}

// ===========================================
//  CACHED PLAYBACK ENGINE (RV-style)
//  Once cache is ready, all playback runs from
//  the ImageBitmap array - no video decode needed.
// ===========================================

let cachedPlaybackState = null; // { playing, frameIdx, loop, rafId, startTime, startFrame, onTick }
let playerTransportAPI = null;  // { stepFrame(delta), togglePlayPause() } - set by initTransportControls

function destroyCachedPlayback() {
    if (cachedPlaybackState?.rafId) cancelAnimationFrame(cachedPlaybackState.rafId);
    cachedPlaybackState = null;
    playerTransportAPI = null;
}

/** Start cached playback from current frame */
function cachedPlay() {
    if (!frameCache?.ready || !cachedPlaybackState) return;
    const st = cachedPlaybackState;
    st.playing = true;
    st.startTime = performance.now();
    st.startFrame = st.frameIdx;

    // Resume hidden video for audio output
    if (st._video && st._video.paused) {
        const targetTime = st.frameIdx / frameCache.fps;
        st._video.currentTime = targetTime;
        st._video.play().catch(() => {});
    }

    function tick(now) {
        if (!st.playing || !frameCache?.ready) return;
        const elapsed = (now - st.startTime) / 1000;
        let newFrame = st.startFrame + Math.floor(elapsed * frameCache.fps);

        if (newFrame >= frameCache.frames.length) {
            if (st.loop) {
                newFrame = newFrame % frameCache.frames.length;
                st.startTime = now;
                st.startFrame = 0;
                // Loop audio too
                if (st._video) st._video.currentTime = 0;
            } else {
                st.frameIdx = frameCache.frames.length - 1;
                st.playing = false;
                if (st._video) st._video.pause();
                if (st.onTick) st.onTick(st.frameIdx, false);
                return;
            }
        }

        if (newFrame !== st.frameIdx) {
            st.frameIdx = newFrame;
            if (st.onTick) st.onTick(st.frameIdx, true);
        }
        // Always schedule next frame - even when frame index hasn't changed.
        // At 24fps on a 60Hz monitor, the same frame must persist for 2-3 refreshes.
        st.rafId = requestAnimationFrame(tick);
    }

    st.rafId = requestAnimationFrame(tick);
}

/** Pause cached playback */
function cachedPause() {
    if (!cachedPlaybackState) return;
    cachedPlaybackState.playing = false;
    if (cachedPlaybackState.rafId) {
        cancelAnimationFrame(cachedPlaybackState.rafId);
        cachedPlaybackState.rafId = null;
    }
    // Pause hidden video (stops audio)
    if (cachedPlaybackState._video && !cachedPlaybackState._video.paused) {
        cachedPlaybackState._video.pause();
    }
}

/** Set cached playback to specific frame index */
function cachedSeekFrame(frameIdx) {
    if (!cachedPlaybackState) return;
    cachedPlaybackState.frameIdx = Math.max(0, Math.min(frameIdx, (frameCache?.frames.length || 1) - 1));
    // Reset start reference so play() continues from here
    cachedPlaybackState.startTime = performance.now();
    cachedPlaybackState.startFrame = cachedPlaybackState.frameIdx;
    // Sync hidden video position for audio alignment
    if (cachedPlaybackState._video && frameCache?.fps) {
        cachedPlaybackState._video.currentTime = cachedPlaybackState.frameIdx / frameCache.fps;
    }
}

/** Set cached playback to specific time position */
function cachedSeekTime(time) {
    if (!frameCache?.ready) return;
    const frameIdx = Math.min(Math.floor(time * frameCache.fps), frameCache.frames.length - 1);
    cachedSeekFrame(frameIdx);
}

function initTransportControls(container, fps) {
    const video = container.querySelector('video');
    const transport = container.querySelector('.player-transport');
    if (!video || !transport) return;

    const scrub = transport.querySelector('.pt-scrub');
    const fill = transport.querySelector('.pt-scrub-fill');
    const playBtn = transport.querySelector('.pt-play');
    const prevBtn = transport.querySelector('.pt-prev-frame');
    const nextBtn = transport.querySelector('.pt-next-frame');
    const loopBtn = transport.querySelector('.pt-loop');
    const timeEl = transport.querySelector('.pt-time');
    const frameEl = transport.querySelector('.pt-frame-counter');
    const cacheBar = transport.querySelector('.pt-cache-bar');
    const cacheFill = transport.querySelector('.pt-cache-fill');

    // Canvas overlay for cached frame display
    const scrubCanvas = document.createElement('canvas');
    scrubCanvas.className = 'pt-scrub-canvas';
    scrubCanvas.style.display = 'none';
    video.parentElement.insertBefore(scrubCanvas, video);
    // desynchronized: bypass vsync compositor - canvas paints independently, reducing latency
    // alpha: false - canvas is opaque, skip alpha-blending during composite
    const scrubCtx = scrubCanvas.getContext('2d', { desynchronized: true, alpha: false });

    let isScrubbing = false;
    const frameDuration = 1 / fps;
    let useCache = false;  // Flips to true when cache is ready

    // Format seconds -> MM:SS or HH:MM:SS
    function fmtTime(sec) {
        if (!isFinite(sec)) return '00:00';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }

    // --- Draw a cached frame by index and update transport UI ---
    let _lastDrawnRect = null;  // Cache to avoid redundant style updates
    let _uiThrottle = 0;        // Throttle DOM updates during playback
    function drawCachedFrame(idx) {
        if (!frameCache?.ready) return;
        idx = Math.max(0, Math.min(idx, frameCache.frames.length - 1));
        const bmp = frameCache.frames[idx];
        if (!bmp) return;

        // Size canvas - use cached rect, only recompute if missing
        if (!_lastDrawnRect) {
            const container = video.parentElement || document.getElementById('playerContent');
            _lastDrawnRect = scrubCanvas._cachedRect || container.getBoundingClientRect();
        }
        if (scrubCanvas.width !== frameCache.width) scrubCanvas.width = frameCache.width;
        if (scrubCanvas.height !== frameCache.height) scrubCanvas.height = frameCache.height;
        // Only set style dimensions once (avoid layout thrash)
        if (scrubCanvas._styleW !== _lastDrawnRect.width) {
            scrubCanvas.style.width = _lastDrawnRect.width + 'px';
            scrubCanvas._styleW = _lastDrawnRect.width;
        }
        if (scrubCanvas._styleH !== _lastDrawnRect.height) {
            scrubCanvas.style.height = _lastDrawnRect.height + 'px';
            scrubCanvas._styleH = _lastDrawnRect.height;
        }

        // HOT PATH - blit the bitmap (this is the only thing that MUST happen every frame)
        scrubCtx.drawImage(bmp, 0, 0);

        // Transport UI updates - throttle during playback to reduce DOM layout churn.
        // During playback: update every 3rd frame (~8x/sec at 24fps, still visually smooth).
        // When paused/stepping: always update immediately.
        const isPlaying = cachedPlaybackState?.playing;
        if (isPlaying && ++_uiThrottle < 3) return;
        _uiThrottle = 0;

        const totalFrames = frameCache.frames.length;
        const timePos = idx / frameCache.fps;
        if (!isScrubbing) {
            scrub.value = (timePos / frameCache.duration) * 1000;
            fill.style.width = ((timePos / frameCache.duration) * 100) + '%';
        }
        timeEl.textContent = `${fmtTime(timePos)} / ${fmtTime(frameCache.duration)}`;
        frameEl.textContent = `F ${idx} / ${totalFrames}`;
    }

    // --- Update UI from video state (used before cache is ready) ---
    function updateTransport() {
        if (useCache) return; // Cache handles its own UI
        if (!video.duration || !isFinite(video.duration)) return;
        const pct = (video.currentTime / video.duration) * 100;
        if (!isScrubbing) {
            scrub.value = (video.currentTime / video.duration) * 1000;
            fill.style.width = pct + '%';
        }
        timeEl.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
        const currentFrame = Math.floor(video.currentTime * fps);
        const totalFrames = Math.floor(video.duration * fps);
        frameEl.textContent = `F ${currentFrame} / ${totalFrames}`;
        playBtn.textContent = video.paused ? 'Play' : '||';
    }

    video.addEventListener('timeupdate', updateTransport);
    video.addEventListener('loadedmetadata', updateTransport);
    video.addEventListener('play', () => { if (!useCache) { playBtn.textContent = '||'; } });
    video.addEventListener('pause', () => { if (!useCache) { playBtn.textContent = 'Play'; } });

    // --- Switch to cached playback mode ---
    function activateCache() {
        useCache = true;
        // DON'T pause video - keep it playing (hidden) for AUDIO output.
        // Canvas handles visuals; video provides audio.

        // Capture display rect - prefer video, fallback to container (pre-cache hit case)
        let rect = video.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            const cont = video.parentElement || document.getElementById('playerContent');
            rect = cont.getBoundingClientRect();
        }
        scrubCanvas._cachedRect = rect;

        video.style.visibility = 'hidden';
        scrubCanvas.style.display = 'block';

        // Reset cached playback state WITHOUT nulling playerTransportAPI
        // (destroyCachedPlayback nulls playerTransportAPI which breaks keyboard frame stepping)
        if (cachedPlaybackState?.rafId) cancelAnimationFrame(cachedPlaybackState.rafId);
        const currentFrame = Math.floor((video.currentTime || 0) * fps);
        const wasPlaying = !video.paused;
        cachedPlaybackState = {
            playing: false,
            frameIdx: Math.min(currentFrame, frameCache.frames.length - 1),
            loop: video.loop,
            rafId: null,
            startTime: 0,
            startFrame: 0,
            _video: video,  // Reference for cachedPlay/Pause/Seek to control audio
            onTick: (idx, playing) => {
                drawCachedFrame(idx);
                // Sync video currentTime to cached position for audio alignment
                if (frameCache?.fps) {
                    const targetTime = idx / frameCache.fps;
                    // Only seek video if drift > 0.15s (avoids constant seeking)
                    if (Math.abs(video.currentTime - targetTime) > 0.15) {
                        video.currentTime = targetTime;
                    }
                }
                // Only update play button on actual state transitions (not every frame)
                if (!playing) playBtn.textContent = 'Play';
            }
        };
        // Show first frame
        drawCachedFrame(cachedPlaybackState.frameIdx);
        // If video was playing before cache activated, resume cached + video playback
        if (wasPlaying) {
            cachedPlay();
            playBtn.textContent = '||';
        } else {
            video.pause();
            playBtn.textContent = 'Play';
        }
    }

    // --- Unified toggle play/pause (works for both video and cache) ---
    function togglePlayPause() {
        if (useCache) {
            if (cachedPlaybackState?.playing) {
                cachedPause();
                playBtn.textContent = 'Play';
            } else {
                cachedPlay();
                playBtn.textContent = '||';
            }
        } else {
            video.paused ? video.play() : video.pause();
        }
    }

    // --- Unified frame step ---
    function stepFrame(delta) {
        if (useCache && cachedPlaybackState) {
            cachedPause();
            const frames = frameCache?.frames;
            const maxIdx = (frames?.length || 1) - 1;
            let newIdx = cachedPlaybackState.frameIdx;
            const currentBmp = frames?.[newIdx];

            // Skip over duplicate bitmaps (gap-fill produces same ImageBitmap in adjacent slots)
            // Keep stepping in the delta direction until we find a different bitmap or hit bounds
            let steps = 0;
            do {
                newIdx = Math.max(0, Math.min(newIdx + delta, maxIdx));
                steps++;
                // Stop if we hit boundary or found a different frame (or after max 10 steps)
                if (newIdx === 0 || newIdx === maxIdx) break;
                if (steps > 10) break;
            } while (frames?.[newIdx] === currentBmp);

            cachedPlaybackState.frameIdx = newIdx;
            cachedPlaybackState.startFrame = newIdx;
            cachedPlaybackState.startTime = performance.now();
            drawCachedFrame(newIdx);
            // Sync video position for audio (paused, so it just sets the seek point)
            if (frameCache?.fps) video.currentTime = newIdx / frameCache.fps;
            playBtn.textContent = 'Play';
        } else {
            video.pause();
            const newTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta * frameDuration));
            video.currentTime = newTime;
        }
    }

    // Expose transport API for keyboard handler
    playerTransportAPI = { stepFrame, togglePlayPause };

    // --- Scrub handling ---
    scrub.addEventListener('input', () => {
        isScrubbing = true;
        if (useCache && frameCache?.ready) {
            const seekTo = (scrub.value / 1000) * frameCache.duration;
            const frameIdx = Math.min(Math.floor(seekTo * frameCache.fps), frameCache.frames.length - 1);
            fill.style.width = ((scrub.value / 1000) * 100) + '%';
            drawCachedFrame(frameIdx);
            cachedSeekFrame(frameIdx);
        } else if (video.duration && isFinite(video.duration)) {
            const seekTo = (scrub.value / 1000) * video.duration;
            fill.style.width = ((seekTo / video.duration) * 100) + '%';
            timeEl.textContent = `${fmtTime(seekTo)} / ${fmtTime(video.duration)}`;
            const currentFrame = Math.floor(seekTo * fps);
            const totalFrames = Math.floor(video.duration * fps);
            frameEl.textContent = `F ${currentFrame} / ${totalFrames}`;
            video.currentTime = seekTo;
        }
    });

    let wasPlaying = false;
    scrub.addEventListener('mousedown', () => {
        wasPlaying = useCache ? (cachedPlaybackState?.playing || false) : !video.paused;
        if (useCache) { cachedPause(); } else if (wasPlaying) { video.pause(); }
        isScrubbing = true;
    });
    scrub.addEventListener('mouseup', () => {
        isScrubbing = false;
        if (useCache) {
            if (wasPlaying) cachedPlay();
        } else {
            if (video.duration && isFinite(video.duration)) {
                video.currentTime = (scrub.value / 1000) * video.duration;
            }
            if (wasPlaying) video.play();
        }
    });
    scrub.addEventListener('touchstart', () => {
        wasPlaying = useCache ? (cachedPlaybackState?.playing || false) : !video.paused;
        if (useCache) { cachedPause(); } else if (wasPlaying) { video.pause(); }
        isScrubbing = true;
    }, { passive: true });
    scrub.addEventListener('touchend', () => {
        isScrubbing = false;
        if (useCache) {
            if (wasPlaying) cachedPlay();
        } else {
            if (video.duration && isFinite(video.duration)) {
                video.currentTime = (scrub.value / 1000) * video.duration;
            }
            if (wasPlaying) video.play();
        }
    });

    // Click canvas or video to toggle play/pause
    scrubCanvas.addEventListener('click', togglePlayPause);
    video.addEventListener('click', togglePlayPause);

    // Buttons
    playBtn.addEventListener('click', togglePlayPause);
    prevBtn.addEventListener('click', () => stepFrame(-1));
    nextBtn.addEventListener('click', () => stepFrame(1));
    loopBtn.addEventListener('click', () => {
        const isLoop = !video.loop;
        video.loop = isLoop;
        if (cachedPlaybackState) cachedPlaybackState.loop = isLoop;
        loopBtn.classList.toggle('active', isLoop);
    });

    // Pointer events to prevent node drag in player
    transport.addEventListener('pointerdown', (e) => e.stopPropagation());
    scrubCanvas.style.pointerEvents = 'auto'; // Allow click on canvas

    // Start frame caching in background after video loads
    video.addEventListener('loadedmetadata', () => {
        const currentAssetId = state.playerAssets?.[state.playerIndex]?.id;
        const totalFrames = Math.ceil(video.duration * fps);

        // --- Pool HIT: instant activation (pre-cached by adjacent clip pre-fetch) ---
        if (currentAssetId && frameCachePool.has(currentAssetId)) {
            frameCache = frameCachePool.get(currentAssetId);
            if (cacheBar) cacheBar.style.display = 'none';
            activateCache();
            precacheAdjacent(currentAssetId);
            return;
        }

        // --- Pool MISS: build cache for this clip ---
        if (totalFrames > 1800) {
            if (cacheBar) { cacheBar.title = 'Clip too long for frame cache (>60s)'; cacheFill.style.width = '0%'; }
            return;
        }
        if (cacheBar) { cacheBar.style.display = ''; }

        const cachePromise = buildFrameCache(video.src, fps, (done, total) => {
            if (done === -1) {
                if (cacheBar) cacheBar.style.display = 'none';
                return;
            }
            if (cacheFill) cacheFill.style.width = ((done / total) * 100) + '%';
        });

        cachePromise.then(result => {
            if (!result) return;
            frameCache = result;
            if (currentAssetId) {
                frameCachePool.set(currentAssetId, result);
                evictOldCaches(currentAssetId);
            }
            activateCache();
            if (cacheBar) {
                setTimeout(() => { cacheBar.style.opacity = '0'; }, 500);
                setTimeout(() => { cacheBar.style.display = 'none'; }, 1000);
            }
            if (currentAssetId) precacheAdjacent(currentAssetId);
        });
    }, { once: true });
}

// ===========================================
//  GENERATION METADATA PANEL (Tab key toggle)
// ===========================================

let metaPanelVisible = false;

function toggleMetaPanel() {
    const panel = document.getElementById('playerMetaPanel');
    if (!panel) return;

    metaPanelVisible = !metaPanelVisible;
    panel.style.display = metaPanelVisible ? 'flex' : 'none';

    // Add class to player-body for layout adjustment
    const body = panel.closest('.player-body');
    if (body) body.classList.toggle('meta-open', metaPanelVisible);

    if (metaPanelVisible) {
        renderMetaPanel();
    }
}

function renderMetaPanel() {
    const container = document.getElementById('metaPanelContent');
    if (!container) return;

    const asset = state.playerAssets?.[state.playerIndex];
    if (!asset) {
        container.innerHTML = '<div class="meta-empty">No asset loaded.</div>';
        return;
    }

    // Parse metadata JSON
    let meta = {};
    try { meta = typeof asset.metadata === 'string' ? JSON.parse(asset.metadata || '{}') : (asset.metadata || {}); } catch { meta = {}; }
    const gen = meta.generation;

    if (!gen || Object.keys(gen).length === 0) {
        container.innerHTML = `
            <div class="meta-empty">
                <div style="font-size:1.6rem;margin-bottom:8px;"></div>
                No generation metadata for this asset.
                <div style="margin-top:8px;font-size:0.72rem;color:#666;">
                    Generation info is automatically captured when saving from ComfyUI via the SaveToMediaVault node.
                </div>
            </div>
        `;
        return;
    }

    let html = '';

    // Model
    if (gen.model) {
        html += metaRow('', 'Model', gen.model);
    }

    // Sampler + Scheduler
    if (gen.sampler || gen.scheduler) {
        const parts = [];
        if (gen.sampler) parts.push(gen.sampler);
        if (gen.scheduler) parts.push(gen.scheduler);
        html += metaRow('', 'Sampler', parts.join(' / '));
    }

    // Steps + CFG
    if (gen.steps != null || gen.cfg != null) {
        const parts = [];
        if (gen.steps != null) parts.push(`${gen.steps} steps`);
        if (gen.cfg != null) parts.push(`CFG ${gen.cfg}`);
        html += metaRow('Settings', 'Settings', parts.join(', '));
    }

    // Denoise
    if (gen.denoise != null) {
        html += metaRow('', 'Denoise', gen.denoise);
    }

    // Seed
    if (gen.seed != null) {
        html += metaRow('', 'Seed', gen.seed);
    }

    // VAE
    if (gen.vae) {
        html += metaRow('', 'VAE', gen.vae);
    }

    // LoRAs
    if (gen.loras && gen.loras.length) {
        const loraHtml = gen.loras.map(l => `<div class="meta-lora">${esc(l.name)} <span class="meta-dim">@ ${l.strength}</span></div>`).join('');
        html += `<div class="meta-section"><div class="meta-label"> LoRAs</div><div class="meta-value">${loraHtml}</div></div>`;
    }

    // Upscale model
    if (gen.upscale_model) {
        html += metaRow('', 'Upscaler', gen.upscale_model);
    }

    // Prompt
    if (gen.prompt) {
        const promptText = Array.isArray(gen.prompt) ? gen.prompt.join('\\n---\\n') : gen.prompt;
        html += `<div class="meta-section meta-section-prompt">
            <div class="meta-label"> Prompt</div>
            <div class="meta-prompt">${esc(promptText)}</div>
        </div>`;
    }

    // File info section
    html += '<div class="meta-divider"></div>';
    if (asset.width && asset.height) html += metaRow('', 'Resolution', `${asset.width}x${asset.height}`);
    if (asset.codec) html += metaRow('', 'Codec', asset.codec);
    if (asset.file_size) html += metaRow('', 'Size', formatSize(asset.file_size));
    if (asset.created_at) html += metaRow('', 'Created', new Date(asset.created_at).toLocaleString());

    container.innerHTML = html;
}

function metaRow(icon, label, value) {
    return `<div class="meta-section"><div class="meta-label">${icon} ${label}</div><div class="meta-value">${esc(String(value))}</div></div>`;
}

// ===========================================
//  POP-OUT PLAYER (separate window for second monitor)
// ===========================================

function popoutPlayer() {
    // If pop-out already open, focus it
    if (popoutWindow && !popoutWindow.closed) {
        popoutWindow.focus();
        sendToPopout('dmv-popout-init', {
            assets: state.playerAssets,
            index: state.playerIndex
        });
        return;
    }

    // Open new window - sized for a secondary monitor
    popoutWindow = window.open(
        '/popout-player.html',
        'dmv-player',
        'width=1280,height=720,menubar=no,toolbar=no,status=no,resizable=yes'
    );

    if (!popoutWindow) {
        showToast('Pop-up blocked - allow pop-ups for this site', 4000);
        return;
    }

    // Listen for messages from the pop-out
    window.addEventListener('message', handlePopoutMessage);

    // Close the inline modal since we're popping out
    closePlayer();
}

function handlePopoutMessage(e) {
    if (e.origin !== window.location.origin) return;
    const msg = e.data;

    if (msg.type === 'dmv-popout-ready') {
        // Pop-out window is ready - send it the assets
        sendToPopout('dmv-popout-init', {
            assets: state.playerAssets,
            index: state.playerIndex
        });
    }

    if (msg.type === 'dmv-popout-navigate') {
        // Pop-out navigated - keep main window state in sync
        state.playerIndex = msg.index;
    }

    if (msg.type === 'dmv-popout-closed') {
        popoutWindow = null;
        window.removeEventListener('message', handlePopoutMessage);
    }
}

function sendToPopout(type, data) {
    if (popoutWindow && !popoutWindow.closed) {
        popoutWindow.postMessage({ type, ...data }, window.location.origin);
    }
}

// ===========================================
//  PRESENTATION MODE (fullscreen in main player)
// ===========================================

function togglePresentationMode() {
    const modal = document.getElementById('playerModal');
    const container = document.querySelector('.player-container');
    if (!modal || !container) return;

    presentationMode = !presentationMode;

    if (presentationMode) {
        modal.classList.add('presentation-mode');
        modal.requestFullscreen?.().catch(() => {});
        ensurePresentationHud();
        showToast('Presentation Mode - F to exit, H to toggle HUD, <--> to navigate', 4000);
        resetPresentationHudTimer();
    } else {
        modal.classList.remove('presentation-mode');
        if (document.fullscreenElement) document.exitFullscreen?.();
        removePresentationHud();
    }
}

function ensurePresentationHud() {
    const content = document.getElementById('playerContent');
    if (!content) return;

    // Remove old if exists
    removePresentationHud();

    const prefs = loadPresentationPrefs();
    const asset = state.playerAssets[state.playerIndex];
    if (!asset) return;

    // Top HUD - shot name + index
    const hudTop = document.createElement('div');
    hudTop.className = 'pres-hud pres-hud-top';
    hudTop.id = 'presHudTop';
    hudTop.innerHTML = `
        <div class="pres-hud-shot" id="presHudShot">${prefs.shotName !== false ? esc(asset.vault_name || '') : ''}</div>
        <div class="pres-hud-index" id="presHudIndex">${prefs.index !== false ? `${state.playerIndex + 1} / ${state.playerAssets.length}` : ''}</div>
    `;
    content.appendChild(hudTop);

    // Bottom HUD - frame counter + resolution
    const hudBot = document.createElement('div');
    hudBot.className = 'pres-hud pres-hud-bottom';
    hudBot.id = 'presHudBottom';
    hudBot.innerHTML = `
        <div class="pres-hud-frame" id="presHudFrame"></div>
        <div class="pres-hud-res" id="presHudRes">${prefs.resolution && asset.width ? `${asset.width}x${asset.height}` : ''}</div>
    `;
    content.appendChild(hudBot);

    // Start frame counter for video
    const video = content.querySelector('video');
    if (video && prefs.frame !== false) {
        startPresentationFrameCounter(video, asset);
    }
}

function removePresentationHud() {
    if (presentationFrameRaf) { cancelAnimationFrame(presentationFrameRaf); presentationFrameRaf = null; }
    document.getElementById('presHudTop')?.remove();
    document.getElementById('presHudBottom')?.remove();
    clearTimeout(hudTimeout);
}

function updatePresentationHud() {
    const prefs = loadPresentationPrefs();
    const asset = state.playerAssets?.[state.playerIndex];
    if (!asset) return;

    const shotEl = document.getElementById('presHudShot');
    const idxEl = document.getElementById('presHudIndex');
    const resEl = document.getElementById('presHudRes');

    if (shotEl) shotEl.textContent = prefs.shotName !== false ? (asset.vault_name || '') : '';
    if (idxEl) idxEl.textContent = prefs.index !== false ? `${state.playerIndex + 1} / ${state.playerAssets.length}` : '';
    if (resEl) resEl.textContent = prefs.resolution && asset.width ? `${asset.width}x${asset.height}` : '';
}

function startPresentationFrameCounter(video, asset) {
    const fps = asset.fps || 24;
    const frameEl = document.getElementById('presHudFrame');
    if (!frameEl) return;

    function tick() {
        const frame = Math.floor(video.currentTime * fps);
        const total = Math.floor(video.duration * fps) || '?';
        frameEl.textContent = `Frame ${frame} / ${total}`;
        presentationFrameRaf = requestAnimationFrame(tick);
    }
    presentationFrameRaf = requestAnimationFrame(tick);
}

function resetPresentationHudTimer() {
    const modal = document.getElementById('playerModal');
    if (!modal) return;
    modal.classList.remove('pres-hud-hidden');
    clearTimeout(hudTimeout);
    hudTimeout = setTimeout(() => {
        if (presentationMode) modal.classList.add('pres-hud-hidden');
    }, 3000);
}

function loadPresentationPrefs() {
    try { return JSON.parse(localStorage.getItem('dmv_pres_hud') || 'null') || {}; } catch { return {}; }
}

// Exit presentation mode when fullscreen exits
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && presentationMode) {
        presentationMode = false;
        const modal = document.getElementById('playerModal');
        if (modal) modal.classList.remove('presentation-mode', 'pres-hud-hidden');
        removePresentationHud();
    }
});

// Mouse movement shows HUD in presentation mode
document.addEventListener('mousemove', () => {
    if (presentationMode) resetPresentationHudTimer();
});

// ===========================================
//  PLAYER CONTEXT MENU (Ctrl + Right-click)
//  Shows sibling assets by role for quick swap / RV push
// ===========================================

function dismissPlayerCtxMenu() {
    const old = document.getElementById('playerCtxMenu');
    if (old) old.remove();
}

// Ctrl+Right-click in the player -> version/role context menu
document.addEventListener('contextmenu', async (e) => {
    const modal = document.getElementById('playerModal');
    const content = document.getElementById('playerContent');

    // Only fire inside the player modal + only when Ctrl is held
    if (!modal || modal.style.display === 'none') return;
    if (!content || !content.contains(e.target)) return;
    if (!e.ctrlKey) return; // Regular right-click -> native menu

    e.preventDefault();
    e.stopImmediatePropagation(); // Prevent dismiss listener on same event from killing the menu
    dismissPlayerCtxMenu();

    const asset = state.playerAssets?.[state.playerIndex];
    if (!asset) return;

    // Build menu shell with loading state
    const menu = document.createElement('div');
    menu.id = 'playerCtxMenu';
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.innerHTML = `<div class="ctx-item ctx-muted" style="pointer-events:none;font-size:0.75rem;opacity:0.6;"> ${esc(asset.vault_name)}</div>`
        + `<div class="ctx-separator"></div>`
        + `<div class="ctx-item ctx-loading" style="pointer-events:none">Loading versions...</div>`;
    document.body.appendChild(menu);

    // Keep menu within viewport
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
    });

    // Fetch shot siblings (other roles/versions in same shot)
    try {
        const resp = await fetch(`/api/assets/${asset.id}/shot-siblings`);
        const data = await resp.json();

        if (!data.roles || data.roles.length === 0) {
            menu.innerHTML = `<div class="ctx-item ctx-muted" style="pointer-events:none;font-size:0.75rem;opacity:0.6;"> ${esc(asset.vault_name)}</div>`
                + `<div class="ctx-separator"></div>`
                + `<div class="ctx-item ctx-muted" style="pointer-events:none">No other versions in this shot</div>`;
            return;
        }

        let html = `<div class="ctx-item ctx-muted" style="pointer-events:none;font-size:0.75rem;opacity:0.6;"> ${esc(asset.vault_name)}</div>`
            + `<div class="ctx-separator"></div>`;

        for (const role of data.roles) {
            if (role.assets.length === 1) {
                const a = role.assets[0];
                const ext = (a.file_ext || '').toLowerCase();
                const vLabel = a.version ? `v${String(a.version).padStart(3, '0')}` : ext;
                // Single asset - show action sub-menu on hover
                html += `<div class="ctx-item ctx-item-parent" style="position:relative">`
                    + `<span>${role.icon || ''} ${esc(role.name)} - ${vLabel} ${ext}</span>`
                    + `<div class="ctx-submenu">`
                    + `<div class="ctx-sub-item" data-pctx-play="${a.id}">Play Play Here</div>`
                    + `<div class="ctx-sub-item" data-pctx-rv-set="${a.id}"> Send to RV</div>`
                    + `<div class="ctx-sub-item" data-pctx-rv-merge="${a.id}">+ Add to RV</div>`
                    + `</div></div>`;
            } else {
                // Multiple versions - nested: role -> version -> actions
                html += `<div class="ctx-item ctx-item-parent" style="position:relative">`
                    + `<span>${role.icon || ''} ${esc(role.name)} (${role.assets.length})</span>`
                    + `<div class="ctx-submenu">`;
                for (const a of role.assets) {
                    const ext = (a.file_ext || '').toLowerCase();
                    const vLabel = a.version ? `v${String(a.version).padStart(3, '0')}` : a.vault_name;
                    html += `<div class="ctx-sub-item ctx-item-parent" style="position:relative">`
                        + `<span>${vLabel} ${ext}</span>`
                        + `<div class="ctx-submenu">`
                        + `<div class="ctx-sub-item" data-pctx-play="${a.id}">Play Play Here</div>`
                        + `<div class="ctx-sub-item" data-pctx-rv-set="${a.id}"> Send to RV</div>`
                        + `<div class="ctx-sub-item" data-pctx-rv-merge="${a.id}">+ Add to RV</div>`
                        + `</div></div>`;
                }
                html += `</div></div>`;
            }
        }

        menu.innerHTML = html;

        // Reposition after content change
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
            if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
        });
    } catch (err) {
        menu.innerHTML = `<div class="ctx-item ctx-muted" style="pointer-events:none">Error loading versions</div>`;
    }

    // Click handler
    menu.addEventListener('click', (ev) => {
        const item = ev.target.closest('[data-pctx-play], [data-pctx-rv-set], [data-pctx-rv-merge]');
        if (!item) return;
        dismissPlayerCtxMenu();

        const playId = item.dataset.pctxPlay;
        const rvSetId = item.dataset.pctxRvSet;
        const rvMergeId = item.dataset.pctxRvMerge;

        if (playId) {
            openPlayerById(parseInt(playId));
        } else if (rvSetId) {
            sendToRV(parseInt(rvSetId), 'set');
        } else if (rvMergeId) {
            sendToRV(parseInt(rvMergeId), 'merge');
        }
    });
});

// Dismiss player context menu on click anywhere or any right-click
document.addEventListener('click', dismissPlayerCtxMenu);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismissPlayerCtxMenu();
});

// ===========================================
//  EXPOSE ON WINDOW (for HTML onclick handlers)
// ===========================================

window.openPlayer = openPlayer;
window.openPlayerDirect = openPlayerDirect;
window.closePlayer = closePlayer;
window.playerPrev = playerPrev;
window.playerNext = playerNext;
window.openInExternalPlayer = openInExternalPlayer;
window.openInRV = openInRV;
window.sendToRV = sendToRV;
window.sendSelectedToRV = sendSelectedToRV;
window.toggleOverlayMaster = toggleOverlayMaster;
window.toggleOverlayOption = toggleOverlayOption;
window.editWatermarkText = editWatermarkText;
window.popoutPlayer = popoutPlayer;
window.togglePresentationMode = togglePresentationMode;
window.toggleMetaPanel = toggleMetaPanel;

// Open player by asset ID (for format variant sub-menu)
function openPlayerById(assetId) {
    // Find index in current state.assets
    const idx = state.assets.findIndex(a => a.id === assetId);
    if (idx >= 0) {
        openPlayer(idx);
    } else {
        // Asset not in current view - fetch it and play directly
        fetch(`/api/assets/${assetId}`)
            .then(r => r.json())
            .then(asset => {
                if (asset && asset.id) {
                    state.playerAssets = [asset];
                    state.playerIndex = 0;
                    const defPlayer = state.settings?.default_player || 'browser';
                    if (defPlayer !== 'browser') {
                        openInExternalPlayer(asset.id);
                    } else {
                        renderPlayer();
                        document.getElementById('playerModal').style.display = 'flex';
                        document.addEventListener('keydown', playerKeyHandler);
                    }
                }
            })
            .catch(() => showToast('Failed to load asset', 3000));
    }
}
window.openPlayerById = openPlayerById;


