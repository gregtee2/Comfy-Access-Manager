/**
 * DMV — Player Module
 * Built-in media player, external player launch (mrViewer2), compare view.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, formatSize, formatDuration, showToast } from './utils.js';

// ═══════════════════════════════════════════
//  COMPARE STATE
// ═══════════════════════════════════════════
let compareMode = null;       // null | 'side-by-side' | 'toggle'
let compareRoles = [];        // Array of { role, assets } for comparison
let compareActiveIdx = 0;     // Index into compareRoles for toggle mode

// ═══════════════════════════════════════════
//  OVERLAY STATE
// ═══════════════════════════════════════════
let overlayEnabled = false;
let overlayOptions = loadOverlayPrefs();
let overlayRafId = null;
let overlayCanvas = null;
let overlayCtx = null;

// ═══════════════════════════════════════════
//  POP-OUT PLAYER STATE
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
//  MEDIA PLAYER
// ═══════════════════════════════════════════

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
    // Compare mode key handling
    if (compareMode) {
        if (e.key === 'Escape') { exitCompareMode(); return; }
        if (compareMode === 'toggle') {
            if (e.key === 'ArrowRight') {
                compareActiveIdx = (compareActiveIdx + 1) % compareRoles.length;
                renderRoleCompare();
                return;
            }
            if (e.key === 'ArrowLeft') {
                compareActiveIdx = (compareActiveIdx - 1 + compareRoles.length) % compareRoles.length;
                renderRoleCompare();
                return;
            }
        }
        return;
    }

    // Normal player key handling
    if (e.key === 'Escape') {
        if (presentationMode) { togglePresentationMode(); return; }
        closePlayer();
    }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        playerNext();
        if (presentationMode) { ensurePresentationHud(); resetPresentationHudTimer(); }
    }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
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
    if (e.key === ' ') {
        e.preventDefault();
        const video = document.querySelector('#playerContent video');
        if (video) video.paused ? video.play() : video.pause();
    }
    // Frame stepping: , = prev frame, . = next frame
    if (e.key === ',' || e.key === '<') {
        e.preventDefault();
        const video = document.querySelector('#playerContent video');
        if (video) {
            video.pause();
            const fps = parseFloat(document.querySelector('.player-transport')?.dataset.fps) || 24;
            video.currentTime = Math.max(0, video.currentTime - (1 / fps));
        }
    }
    if (e.key === '.' || e.key === '>') {
        e.preventDefault();
        const video = document.querySelector('#playerContent video');
        if (video) {
            video.pause();
            const fps = parseFloat(document.querySelector('.player-transport')?.dataset.fps) || 24;
            video.currentTime = Math.min(video.duration || 0, video.currentTime + (1 / fps));
        }
    }
    // J/K/L shuttle: J = rewind, K = pause, L = play
    if (e.key === 'j' || e.key === 'J') {
        const video = document.querySelector('#playerContent video');
        if (video) { video.playbackRate = Math.max(0.25, (video.playbackRate || 1) - 0.5); video.play(); }
    }
    if (e.key === 'k' || e.key === 'K') {
        const video = document.querySelector('#playerContent video');
        if (video) { video.pause(); video.playbackRate = 1; }
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
            ${needsTranscode ? '<div style="text-align:center;color:var(--accent);font-size:0.75rem;margin-bottom:6px;">⚡ Transcoding from ' + esc(asset.codec) + ' — may take a moment to start</div>' : ''}
            <video autoplay loop src="${videoUrl}" style="max-width:100%;max-height:calc(70vh - 44px);cursor:pointer;"></video>
            <div class="player-transport" data-fps="${fps}">
                <button class="pt-btn pt-play" title="Play/Pause (Space)">⏸</button>
                <button class="pt-btn pt-prev-frame" title="Previous frame (,)">⏮</button>
                <div class="pt-scrub-wrap">
                    <input type="range" class="pt-scrub" min="0" max="1000" value="0" step="1">
                    <div class="pt-scrub-fill" style="width:0%"></div>
                </div>
                <button class="pt-btn pt-next-frame" title="Next frame (.)">⏭</button>
                <span class="pt-time">00:00 / 00:00</span>
                <span class="pt-frame-counter"></span>
                <button class="pt-btn pt-loop active" title="Loop (L)">🔁</button>
            </div>
        `;
        initTransportControls(content, fps);
    } else if (asset.media_type === 'image' || asset.media_type === 'exr') {
        content.innerHTML = `<img src="${fileUrl}" alt="${esc(asset.vault_name)}">`;
    } else if (asset.media_type === 'audio') {
        content.innerHTML = `
            <div style="text-align:center;padding:40px;">
                <div style="font-size:4rem;margin-bottom:20px;">🔊</div>
                <audio controls autoplay src="${fileUrl}" style="width:400px;"></audio>
            </div>
        `;
    } else {
        content.innerHTML = `
            <div style="text-align:center;padding:40px;color:var(--text-dim);">
                <div style="font-size:4rem;margin-bottom:12px;">📎</div>
                <p>Preview not available for this file type.</p>
                <a href="${fileUrl}" download style="color:var(--accent-light);">Download File</a>
            </div>
        `;
    }

    // Meta info
    const meta = document.getElementById('playerMeta');
    const parts = [];
    if (asset.width && asset.height) parts.push(`<span>📐 ${asset.width}×${asset.height}</span>`);
    if (asset.duration) parts.push(`<span>⏱️ ${formatDuration(asset.duration)}</span>`);
    if (asset.fps) parts.push(`<span>🎞️ ${asset.fps} fps</span>`);
    if (asset.codec) parts.push(`<span>🔧 ${asset.codec}</span>`);
    parts.push(`<span>📦 ${formatSize(asset.file_size)}</span>`);
    if (asset.original_name !== asset.vault_name) {
        parts.push(`<span>📄 Originally: ${esc(asset.original_name)}</span>`);
    }
    parts.push(`<button class="player-mrv2-btn" onclick="openInMrViewer2(${asset.id})" title="Open in mrViewer2">🎬 mrViewer2</button>`);
    parts.push(`<button class="player-mrv2-btn" onclick="openInRV(${asset.id})" title="Open in RV (ShotGrid)">🎬 RV</button>`);
    parts.push(`<button class="player-mrv2-btn player-review-btn" onclick="openReviewInMrv2(${asset.id})" title="Open in mrViewer2 with burn-in overlays (hierarchy, watermark, frame counter)">📋 Review</button>`);
    meta.innerHTML = parts.join('');

    // Update generation metadata panel if it's open
    if (metaPanelVisible) renderMetaPanel();

    // Set up overlay after content is rendered
    requestAnimationFrame(() => setupOverlay(asset));
}

// ═══════════════════════════════════════════
//  REVIEW OVERLAY SYSTEM
// ═══════════════════════════════════════════

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

    // ─── Safe Areas ───
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

    // ─── Burn-in Text (top-left: metadata, top-right: resolution/codec) ───
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
        const hierStr = hierarchy.length > 0 ? hierarchy.join(' › ') : '';

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
        if (asset.width && asset.height) techParts.push(`${asset.width}×${asset.height}`);
        if (asset.codec) techParts.push(asset.codec.toUpperCase());
        if (asset.fps) techParts.push(`${asset.fps}fps`);
        ctx.fillText(techParts.join('  •  '), w - padding, padding * 0.5);

        // File size on second line top-right
        ctx.font = `${fontSize * 0.85}px monospace`;
        ctx.fillStyle = '#cccccc';
        ctx.fillText(formatSize(asset.file_size), w - padding, padding * 0.5 + fontSize * 1.2);

        ctx.textAlign = 'left';
    }

    // ─── Frame Counter + Timecode (bottom-left) ───
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

    // ─── Watermark (center, semi-transparent) ───
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

// ─── Overlay Toolbar ───

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
            🎬 Overlay ${overlayEnabled ? 'ON' : 'OFF'}
        </button>
        ${overlayEnabled ? `
            <button class="overlay-opt-btn ${overlayOptions.burnIn ? 'active' : ''}" 
                    onclick="toggleOverlayOption('burnIn')" title="Burn-in metadata text">🔤</button>
            <button class="overlay-opt-btn ${overlayOptions.frameCounter ? 'active' : ''}" 
                    onclick="toggleOverlayOption('frameCounter')" title="Frame counter + timecode">🎞️</button>
            <button class="overlay-opt-btn ${overlayOptions.watermark ? 'active' : ''}" 
                    onclick="toggleOverlayOption('watermark')" title="Watermark text">💧</button>
            <button class="overlay-opt-btn ${overlayOptions.safeAreas ? 'active' : ''}" 
                    onclick="toggleOverlayOption('safeAreas')" title="Safe area guides">📐</button>
            <button class="overlay-opt-btn" onclick="editWatermarkText()" title="Edit watermark text">✏️</button>
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

// ═══════════════════════════════════════════
//  EXTERNAL PLAYER LAUNCH
// ═══════════════════════════════════════════

async function openInExternalPlayer(assetId) {
    try {
        const player = state.settings?.default_player || 'mrviewer2';
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

async function openInMrViewer2(assetId) {
    try {
        await api(`/api/assets/${assetId}/open-external`, { method: 'POST', body: { player: 'mrviewer2' } });
        showToast('Launched in mrViewer2');
        window.blur();
    } catch (err) {
        showToast('Failed to launch mrViewer2: ' + err.message, 5000);
    }
}

async function openCompareInMrViewer2() {
    if (state.selectedAssets.length < 2) {
        showToast('Select at least 2 clips to compare (Ctrl-click or Shift-click)', 4000);
        return;
    }
    try {
        const res = await api('/api/assets/open-compare', {
            method: 'POST',
            body: { ids: state.selectedAssets, viewer: 'mrviewer2' }
        });
        if (res.mode === 'wipe') {
            showToast(`Loaded ${res.count} clips in mrViewer2 — Wipe compare`);
        } else {
            showToast(`Loaded ${res.count} clips in mrViewer2 — use ← → to flip, or Panel → Compare → Tile`);
        }
        window.blur();
    } catch (err) {
        showToast('Failed to launch compare: ' + err.message, 5000);
    }
}

async function openAllInMrv2() {
    if (state.selectedAssets.length < 1) {
        showToast('Select clips to open (Ctrl-click or Shift-click)', 4000);
        return;
    }
    try {
        const res = await api('/api/assets/open-compare', {
            method: 'POST',
            body: { ids: state.selectedAssets, viewer: 'mrviewer2', mode: 'files' }
        });
        showToast(`Loaded ${res.count} clips — PageUp/PageDown to switch clips, F4 for Files panel`, 6000);
        window.blur();
    } catch (err) {
        showToast('Failed to launch mrViewer2: ' + err.message, 5000);
    }
}

async function openInRV(assetId) {
    try {
        await api(`/api/assets/${assetId}/open-external`, { method: 'POST', body: { player: 'rv' } });
        showToast('Launched in RV');
        window.blur();
    } catch (err) {
        showToast('Failed to launch RV: ' + err.message, 5000);
    }
}

async function openReviewInMrv2(assetId) {
    try {
        const opts = loadOverlayPrefs();
        showToast('Generating review file with overlays...', 4000);
        const res = await api(`/api/assets/${assetId}/open-review`, {
            method: 'POST',
            body: {
                burnIn: opts.burnIn,
                watermark: opts.watermark,
                safeAreas: opts.safeAreas,
                frameCounter: opts.frameCounter,
                watermarkText: opts.watermarkText || 'INTERNAL REVIEW',
            }
        });
        if (res.mode === 'direct') {
            showToast('Launched in mrViewer2 (no overlays selected)');
        } else {
            showToast('Review file generating — mrViewer2 will open when ready');
        }
        window.blur();
    } catch (err) {
        showToast('Failed to generate review: ' + err.message, 5000);
    }
}

async function openCompareInRV() {
    if (state.selectedAssets.length < 2) {
        showToast('Select at least 2 clips to compare (Ctrl-click or Shift-click)', 4000);
        return;
    }
    try {
        const res = await api('/api/assets/open-compare', {
            method: 'POST',
            body: { ids: state.selectedAssets, viewer: 'rv' }
        });
        showToast(`Loaded ${res.count} clips in RV — wipe mode`);
        window.blur();
    } catch (err) {
        showToast('Failed to launch RV compare: ' + err.message, 5000);
    }
}

// ═══════════════════════════════════════════
//  ROLE COMPARISON MODE
// ═══════════════════════════════════════════

async function openRoleCompare(shotId) {
    if (!shotId && !state.currentShot?.id) {
        showToast('Select a shot first to compare roles', 4000);
        return;
    }
    const targetShot = shotId || state.currentShot.id;
    const projectId = state.currentProject?.id;
    if (!projectId) return;

    try {
        // Get all assets in this shot, grouped by role
        const result = await api(`/api/assets?project_id=${projectId}&shot_id=${targetShot}`);
        const assets = result.assets || [];

        // Group by role
        const grouped = {};
        for (const a of assets) {
            const key = a.role_id || 0;
            if (!grouped[key]) {
                grouped[key] = {
                    role: a.role_id ? { id: a.role_id, name: a.role_name, code: a.role_code, color: a.role_color, icon: a.role_icon } : { id: 0, name: 'Unassigned', code: 'NONE', color: '#888', icon: '📎' },
                    assets: [],
                };
            }
            grouped[key].assets.push(a);
        }

        compareRoles = Object.values(grouped).filter(g => g.assets.length > 0);
        if (compareRoles.length < 2) {
            showToast('Need assets in at least 2 roles to compare', 4000);
            return;
        }

        compareActiveIdx = 0;
        compareMode = 'side-by-side';
        renderRoleCompare();

        document.getElementById('playerModal').style.display = 'flex';
        document.addEventListener('keydown', playerKeyHandler);
    } catch (err) {
        showToast('Failed to load role comparison: ' + err.message, 4000);
    }
}

function renderRoleCompare() {
    const content = document.getElementById('playerContent');
    const compare = document.getElementById('playerCompare');
    const roleBar = document.getElementById('playerRoleBar');

    if (!compareMode || compareRoles.length < 2) {
        compare.style.display = 'none';
        roleBar.style.display = 'none';
        return;
    }

    content.style.display = 'none';
    compare.style.display = 'flex';
    roleBar.style.display = 'flex';

    // Title
    document.getElementById('playerTitle').textContent = 'Role Comparison';
    document.getElementById('playerIndex').textContent = `${compareRoles.length} roles`;

    // Mode toggle bar
    roleBar.innerHTML = `
        <div class="compare-mode-toggle">
            <button class="${compareMode === 'side-by-side' ? 'active' : ''}" onclick="setCompareMode('side-by-side')">⬛⬜ Side by Side</button>
            <button class="${compareMode === 'toggle' ? 'active' : ''}" onclick="setCompareMode('toggle')">🔄 Toggle</button>
            <button onclick="exitCompareMode()">✕ Exit Compare</button>
        </div>
        <div class="compare-role-pills">
            ${compareRoles.map((g, i) => `
                <span class="compare-pill ${compareMode === 'toggle' && compareActiveIdx === i ? 'active' : ''}" 
                    style="border-color:${g.role.color};${compareMode === 'toggle' && compareActiveIdx === i ? `background:${g.role.color}30` : ''}"
                    onclick="setCompareActive(${i})">
                    ${g.role.icon} ${esc(g.role.name)} <span class="pill-count">${g.assets.length}</span>
                </span>
            `).join('')}
        </div>
    `;

    if (compareMode === 'side-by-side') {
        renderSideBySide();
    } else {
        renderToggleView();
    }
}

function renderSideBySide() {
    const compare = document.getElementById('playerCompare');
    compare.className = 'player-compare side-by-side';

    compare.innerHTML = compareRoles.map(g => {
        const a = g.assets[0]; // Show first asset per role
        if (!a) return '';
        const fileUrl = `/api/assets/${a.id}/file`;
        const isVideo = a.media_type === 'video';
        return `
            <div class="compare-panel">
                <div class="compare-panel-header" style="border-bottom-color:${g.role.color}">
                    ${g.role.icon} <strong style="color:${g.role.color}">${esc(g.role.name)}</strong>
                    <span style="opacity:.6;font-size:.8em;margin-left:8px;">${esc(a.vault_name)}</span>
                </div>
                <div class="compare-panel-media">
                    ${isVideo 
                        ? `<video controls loop src="${fileUrl}" style="max-width:100%;max-height:60vh;"></video>`
                        : `<img src="${fileUrl}" alt="${esc(a.vault_name)}" style="max-width:100%;max-height:60vh;object-fit:contain;">`
                    }
                </div>
                ${g.assets.length > 1 ? `<div class="compare-panel-nav">
                    ${g.assets.map((aa, j) => `<span class="compare-thumb-pill${j === 0 ? ' active' : ''}" onclick="swapCompareAsset(${compareRoles.indexOf(g)}, ${j})">${j + 1}</span>`).join('')}
                </div>` : ''}
            </div>
        `;
    }).join('');
}

function renderToggleView() {
    const compare = document.getElementById('playerCompare');
    compare.className = 'player-compare toggle-view';

    const g = compareRoles[compareActiveIdx];
    if (!g) return;
    const a = g.assets[0];
    if (!a) return;
    const fileUrl = `/api/assets/${a.id}/file`;
    const isVideo = a.media_type === 'video';

    compare.innerHTML = `
        <div class="compare-panel full">
            <div class="compare-panel-header" style="border-bottom-color:${g.role.color}">
                ${g.role.icon} <strong style="color:${g.role.color}">${esc(g.role.name)}</strong>
                <span style="opacity:.6;font-size:.8em;margin-left:8px;">${esc(a.vault_name)}</span>
                <span style="margin-left:auto;font-size:.8em;color:var(--text-dim);">← → to switch roles</span>
            </div>
            <div class="compare-panel-media">
                ${isVideo 
                    ? `<video controls loop src="${fileUrl}" style="max-width:100%;max-height:65vh;"></video>`
                    : `<img src="${fileUrl}" alt="${esc(a.vault_name)}" style="max-width:100%;max-height:65vh;object-fit:contain;">`
                }
            </div>
        </div>
    `;
}

function setCompareMode(mode) {
    compareMode = mode;
    renderRoleCompare();
}

function setCompareActive(idx) {
    compareActiveIdx = idx;
    renderRoleCompare();
}

function swapCompareAsset(roleIdx, assetIdx) {
    const g = compareRoles[roleIdx];
    if (!g || !g.assets[assetIdx]) return;
    // Move the selected asset to front
    const selected = g.assets.splice(assetIdx, 1)[0];
    g.assets.unshift(selected);
    renderRoleCompare();
}

function exitCompareMode() {
    compareMode = null;
    compareRoles = [];
    const content = document.getElementById('playerContent');
    const compare = document.getElementById('playerCompare');
    const roleBar = document.getElementById('playerRoleBar');
    content.style.display = '';
    compare.style.display = 'none';
    roleBar.style.display = 'none';
    closePlayer();
}

/**
 * Open built-in player using whatever is already set in state.playerAssets/playerIndex.
 * Called by browser.js playSelectedAssets() which pre-populates the filtered list.
 */
function openPlayerDirect() {
    renderPlayer();
    document.getElementById('playerModal').style.display = 'flex';
    document.addEventListener('keydown', playerKeyHandler);
}

// ═══════════════════════════════════════════
//  CUSTOM VIDEO TRANSPORT CONTROLS
// ═══════════════════════════════════════════

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

    let isScrubbing = false;
    const frameDuration = 1 / fps;

    // Format seconds → MM:SS or HH:MM:SS
    function fmtTime(sec) {
        if (!isFinite(sec)) return '00:00';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }

    // Update UI from video state
    function updateTransport() {
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
        playBtn.textContent = video.paused ? '▶' : '⏸';
    }

    // Update loop on timeupdate (smooth display during playback)
    video.addEventListener('timeupdate', updateTransport);
    video.addEventListener('loadedmetadata', updateTransport);
    video.addEventListener('play', () => { playBtn.textContent = '⏸'; });
    video.addEventListener('pause', () => { playBtn.textContent = '▶'; });

    // Real-time scrubbing: seek on every input event (as slider drags)
    scrub.addEventListener('input', () => {
        isScrubbing = true;
        if (video.duration && isFinite(video.duration)) {
            const seekTo = (scrub.value / 1000) * video.duration;
            video.currentTime = seekTo;
            fill.style.width = ((seekTo / video.duration) * 100) + '%';
            timeEl.textContent = `${fmtTime(seekTo)} / ${fmtTime(video.duration)}`;
            const currentFrame = Math.floor(seekTo * fps);
            const totalFrames = Math.floor(video.duration * fps);
            frameEl.textContent = `F ${currentFrame} / ${totalFrames}`;
        }
    });

    // Pause video while scrubbing for instant frame display
    let wasPlaying = false;
    scrub.addEventListener('mousedown', () => {
        wasPlaying = !video.paused;
        if (wasPlaying) video.pause();
        isScrubbing = true;
    });
    scrub.addEventListener('mouseup', () => {
        isScrubbing = false;
        if (wasPlaying) video.play();
    });
    // Touch support
    scrub.addEventListener('touchstart', () => {
        wasPlaying = !video.paused;
        if (wasPlaying) video.pause();
        isScrubbing = true;
    }, { passive: true });
    scrub.addEventListener('touchend', () => {
        isScrubbing = false;
        if (wasPlaying) video.play();
    });

    // Click video to toggle play/pause
    video.addEventListener('click', () => {
        video.paused ? video.play() : video.pause();
    });

    // Buttons
    playBtn.addEventListener('click', () => { video.paused ? video.play() : video.pause(); });
    prevBtn.addEventListener('click', () => {
        video.pause();
        video.currentTime = Math.max(0, video.currentTime - frameDuration);
    });
    nextBtn.addEventListener('click', () => {
        video.pause();
        video.currentTime = Math.min(video.duration, video.currentTime + frameDuration);
    });
    loopBtn.addEventListener('click', () => {
        video.loop = !video.loop;
        loopBtn.classList.toggle('active', video.loop);
    });

    // Pointer events to prevent node drag in player
    transport.addEventListener('pointerdown', (e) => e.stopPropagation());
}

// ═══════════════════════════════════════════
//  GENERATION METADATA PANEL (Tab key toggle)
// ═══════════════════════════════════════════

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
                <div style="font-size:1.6rem;margin-bottom:8px;">🤖</div>
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
        html += metaRow('🧠', 'Model', gen.model);
    }

    // Sampler + Scheduler
    if (gen.sampler || gen.scheduler) {
        const parts = [];
        if (gen.sampler) parts.push(gen.sampler);
        if (gen.scheduler) parts.push(gen.scheduler);
        html += metaRow('🎛️', 'Sampler', parts.join(' / '));
    }

    // Steps + CFG
    if (gen.steps != null || gen.cfg != null) {
        const parts = [];
        if (gen.steps != null) parts.push(`${gen.steps} steps`);
        if (gen.cfg != null) parts.push(`CFG ${gen.cfg}`);
        html += metaRow('⚙️', 'Settings', parts.join(', '));
    }

    // Denoise
    if (gen.denoise != null) {
        html += metaRow('🔽', 'Denoise', gen.denoise);
    }

    // Seed
    if (gen.seed != null) {
        html += metaRow('🎲', 'Seed', gen.seed);
    }

    // VAE
    if (gen.vae) {
        html += metaRow('📦', 'VAE', gen.vae);
    }

    // LoRAs
    if (gen.loras && gen.loras.length) {
        const loraHtml = gen.loras.map(l => `<div class="meta-lora">${esc(l.name)} <span class="meta-dim">@ ${l.strength}</span></div>`).join('');
        html += `<div class="meta-section"><div class="meta-label">🔗 LoRAs</div><div class="meta-value">${loraHtml}</div></div>`;
    }

    // Upscale model
    if (gen.upscale_model) {
        html += metaRow('🔍', 'Upscaler', gen.upscale_model);
    }

    // Prompt
    if (gen.prompt) {
        const promptText = Array.isArray(gen.prompt) ? gen.prompt.join('\\n---\\n') : gen.prompt;
        html += `<div class="meta-section meta-section-prompt">
            <div class="meta-label">📝 Prompt</div>
            <div class="meta-prompt">${esc(promptText)}</div>
        </div>`;
    }

    // File info section
    html += '<div class="meta-divider"></div>';
    if (asset.width && asset.height) html += metaRow('📐', 'Resolution', `${asset.width}×${asset.height}`);
    if (asset.codec) html += metaRow('🔧', 'Codec', asset.codec);
    if (asset.file_size) html += metaRow('📦', 'Size', formatSize(asset.file_size));
    if (asset.created_at) html += metaRow('📅', 'Created', new Date(asset.created_at).toLocaleString());

    container.innerHTML = html;
}

function metaRow(icon, label, value) {
    return `<div class="meta-section"><div class="meta-label">${icon} ${label}</div><div class="meta-value">${esc(String(value))}</div></div>`;
}

// ═══════════════════════════════════════════
//  POP-OUT PLAYER (separate window for second monitor)
// ═══════════════════════════════════════════

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

    // Open new window — sized for a secondary monitor
    popoutWindow = window.open(
        '/popout-player.html',
        'dmv-player',
        'width=1280,height=720,menubar=no,toolbar=no,status=no,resizable=yes'
    );

    if (!popoutWindow) {
        showToast('Pop-up blocked — allow pop-ups for this site', 4000);
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
        // Pop-out window is ready — send it the assets
        sendToPopout('dmv-popout-init', {
            assets: state.playerAssets,
            index: state.playerIndex
        });
    }

    if (msg.type === 'dmv-popout-navigate') {
        // Pop-out navigated — keep main window state in sync
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

// ═══════════════════════════════════════════
//  PRESENTATION MODE (fullscreen in main player)
// ═══════════════════════════════════════════

function togglePresentationMode() {
    const modal = document.getElementById('playerModal');
    const container = document.querySelector('.player-container');
    if (!modal || !container) return;

    presentationMode = !presentationMode;

    if (presentationMode) {
        modal.classList.add('presentation-mode');
        modal.requestFullscreen?.().catch(() => {});
        ensurePresentationHud();
        showToast('Presentation Mode — F to exit, H to toggle HUD, ←→ to navigate', 4000);
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

    // Top HUD — shot name + index
    const hudTop = document.createElement('div');
    hudTop.className = 'pres-hud pres-hud-top';
    hudTop.id = 'presHudTop';
    hudTop.innerHTML = `
        <div class="pres-hud-shot" id="presHudShot">${prefs.shotName !== false ? esc(asset.vault_name || '') : ''}</div>
        <div class="pres-hud-index" id="presHudIndex">${prefs.index !== false ? `${state.playerIndex + 1} / ${state.playerAssets.length}` : ''}</div>
    `;
    content.appendChild(hudTop);

    // Bottom HUD — frame counter + resolution
    const hudBot = document.createElement('div');
    hudBot.className = 'pres-hud pres-hud-bottom';
    hudBot.id = 'presHudBottom';
    hudBot.innerHTML = `
        <div class="pres-hud-frame" id="presHudFrame"></div>
        <div class="pres-hud-res" id="presHudRes">${prefs.resolution && asset.width ? `${asset.width}×${asset.height}` : ''}</div>
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
    if (resEl) resEl.textContent = prefs.resolution && asset.width ? `${asset.width}×${asset.height}` : '';
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

// ═══════════════════════════════════════════
//  EXPOSE ON WINDOW (for HTML onclick handlers)
// ═══════════════════════════════════════════

window.openPlayer = openPlayer;
window.openPlayerDirect = openPlayerDirect;
window.closePlayer = closePlayer;
window.playerPrev = playerPrev;
window.playerNext = playerNext;
window.openInExternalPlayer = openInExternalPlayer;
window.openInMrViewer2 = openInMrViewer2;
window.openCompareInMrViewer2 = openCompareInMrViewer2;
window.openAllInMrv2 = openAllInMrv2;
window.openInRV = openInRV;
window.openReviewInMrv2 = openReviewInMrv2;
window.openCompareInRV = openCompareInRV;
window.openRoleCompare = openRoleCompare;
window.setCompareMode = setCompareMode;
window.setCompareActive = setCompareActive;
window.swapCompareAsset = swapCompareAsset;
window.exitCompareMode = exitCompareMode;
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
        // Asset not in current view — fetch it and play directly
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
