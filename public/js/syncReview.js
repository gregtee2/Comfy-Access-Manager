/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * RV Sync Review — Frontend module for managing synchronized review sessions.
 *
 * Enables multi-user review: one user hosts an RV session, others join.
 * RV handles all sync (scrub, playback, annotations). CAM handles orchestration.
 */

import { api } from './api.js';
import { showToast } from './utils.js';

// ─── State ───
let activeReviews = [];
let pollTimer = null;
let filterProjectId = null;  // null = show all, number = filter to project
let currentTab = 'active';   // 'active' | 'history' | 'notes'
let historyLoaded = false;
let historySessions = [];
let currentNotesSessionId = null;  // which session's notes are being viewed
let currentNotes = [];
let _hubUrl = null;  // cached hub URL for annotation image resolution
const POLL_INTERVAL = 10000; // 10 seconds

// ─── API ───

/**
 * Fetch active review sessions from the server.
 */
async function fetchReviews() {
    try {
        const params = filterProjectId ? `?project_id=${filterProjectId}` : '';
        const data = await api(`/api/review/sessions${params}`);
        activeReviews = data.sessions || [];
        renderReviewPanel();
        updateBadge();
    } catch (err) {
        console.error('[SyncReview] Failed to fetch sessions:', err.message);
    }
}

/**
 * Start a new sync review with the given asset IDs.
 */
async function startSyncReview(assetIds, title) {
    if (!assetIds || assetIds.length === 0) {
        showToast('Select assets for the review', 4000);
        return;
    }

    try {
        const res = await api('/api/review/start', {
            method: 'POST',
            body: {
                assetIds,
                title: title || undefined,
            }
        });

        if (res.success) {
            showToast(`Sync Review started — others can join from the Reviews panel`, 5000);
            // Show the panel
            const panel = document.getElementById('reviewPanel');
            if (panel) panel.style.display = '';
            await fetchReviews();
        } else {
            showToast(res.error || 'Failed to start review', 5000);
        }
    } catch (err) {
        showToast('Failed to start sync review: ' + err.message, 5000);
    }
}

/**
 * Join an existing review session.
 */
async function joinReview(sessionId) {
    try {
        const res = await api('/api/review/join', {
            method: 'POST',
            body: { sessionId }
        });

        if (res.success) {
            showToast(res.message || 'Joined review session', 4000);
        } else {
            showToast(res.error || 'Failed to join review', 5000);
        }
    } catch (err) {
        showToast('Failed to join review: ' + err.message, 5000);
    }
}

/**
 * End a review session (host only).
 */
async function endReview(sessionId) {
    try {
        const res = await api('/api/review/end', {
            method: 'POST',
            body: { sessionId }
        });

        if (res.success) {
            showToast('Review session ended', 3000);
            await fetchReviews();
        } else {
            showToast(res.error || 'Failed to end review', 5000);
        }
    } catch (err) {
        showToast(err.message || 'Failed to end review', 5000);
    }
}

/**
 * Leave a review session (non-host). Kills local RV but keeps the session alive for others.
 */
async function leaveReview(sessionId) {
    try {
        const res = await api('/api/review/leave', {
            method: 'POST',
            body: { sessionId }
        });

        if (res.success) {
            showToast(res.message || 'Left review session', 3000);
        } else {
            showToast(res.error || 'Failed to leave review', 5000);
        }
    } catch (err) {
        showToast(err.message || 'Failed to leave review', 5000);
    }
}

// ─── Notes API ───

/**
 * Resolve the URL for an annotation image.
 * If the image exists locally (same spoke that captured it), use the local path.
 * Otherwise, try the hub URL so all machines can view the annotation.
 */
async function getAnnotationUrl(relativePath) {
    if (!relativePath) return null;
    const localUrl = `/review-snapshots/${relativePath}`;
    try {
        // Quick HEAD check to see if the file exists locally
        const resp = await fetch(localUrl, { method: 'HEAD' });
        if (resp.ok) return localUrl;
    } catch { /* not local */ }

    // Fall back to hub URL
    if (!_hubUrl) {
        try {
            const cfg = await api('/api/settings/sync-config');
            _hubUrl = cfg?.hub_url || null;
        } catch { /* standalone mode, no hub */ }
    }
    if (_hubUrl) return `${_hubUrl}/review-snapshots/${relativePath}`;
    return localUrl; // best effort
}

/**
 * Build annotation image URL — synchronous best-guess (local first, hub fallback).
 * For immediate rendering. The actual image tag handles 404 gracefully via onerror.
 */
function annotationImgUrl(relativePath) {
    return `/review-snapshots/${relativePath}`;
}

/**
 * Hub fallback URL for annotation images (used in onerror handler).
 */
function annotationHubFallback(imgEl) {
    if (imgEl.dataset.triedHub) return; // prevent infinite loop
    imgEl.dataset.triedHub = '1';
    // Fetch hub URL and retry
    if (_hubUrl) {
        imgEl.src = `${_hubUrl}/review-snapshots/${imgEl.dataset.annotationPath}`;
        return;
    }
    api('/api/settings/sync-config').then(cfg => {
        _hubUrl = cfg?.hub_url || null;
        if (_hubUrl) {
            imgEl.src = `${_hubUrl}/review-snapshots/${imgEl.dataset.annotationPath}`;
        }
    }).catch(() => {});
}

/**
 * Fetch notes for a specific review session.
 */
async function fetchNotes(sessionId) {
    try {
        const data = await api(`/api/review/notes/${sessionId}`);
        currentNotes = data.notes || [];
        currentNotesSessionId = sessionId;
        renderNotesView(data.session_title, data.session_status);
    } catch (err) {
        console.error('[SyncReview] Failed to fetch notes:', err.message);
        showToast('Failed to load notes', 4000);
    }
}

/**
 * Add a note to the current review session.
 */
async function addReviewNote(sessionId, noteText, assetId, frameNumber) {
    if (!noteText || !noteText.trim()) {
        showToast('Enter a note', 3000);
        return;
    }

    try {
        const res = await api('/api/review/notes', {
            method: 'POST',
            body: {
                sessionId,
                assetId: assetId || undefined,
                frameNumber: frameNumber || undefined,
                noteText: noteText.trim(),
            }
        });

        if (res.success) {
            showToast('Note added', 2000);
            await fetchNotes(sessionId);
        } else {
            showToast(res.error || 'Failed to add note', 5000);
        }
    } catch (err) {
        showToast('Failed to add note: ' + err.message, 5000);
    }
}

/**
 * Update a note's status (open → resolved → wontfix).
 */
async function updateNoteStatus(noteId, newStatus) {
    try {
        const res = await api(`/api/review/notes/${noteId}`, {
            method: 'PUT',
            body: { status: newStatus }
        });

        if (res.success && currentNotesSessionId) {
            await fetchNotes(currentNotesSessionId);
        }
    } catch (err) {
        showToast('Failed to update note', 4000);
    }
}

/**
 * Delete a note.
 */
async function deleteReviewNote(noteId) {
    if (!confirm('Delete this note?')) return;
    try {
        const res = await api(`/api/review/notes/${noteId}`, {
            method: 'DELETE'
        });

        if (res.success && currentNotesSessionId) {
            showToast('Note deleted', 2000);
            await fetchNotes(currentNotesSessionId);
        }
    } catch (err) {
        showToast('Failed to delete note', 4000);
    }
}

/**
 * Export a review note (with annotation image) to ShotGrid/Flow as a Note entity.
 */
async function exportNoteToFlow(noteId) {
    try {
        // Check if Flow is configured
        const flowStatus = await api('/api/flow/status').catch(() => null);
        if (!flowStatus || !flowStatus.configured) {
            showToast('Flow is not configured. Go to Settings → Flow.', 5000);
            return;
        }

        // Get Flow-linked projects
        const mappings = await api('/api/flow/mappings/projects');
        if (!mappings || mappings.length === 0) {
            showToast('No projects linked to Flow. Sync a project first.', 5000);
            return;
        }

        // Build a quick project picker modal
        const projectOptions = mappings.map(p =>
            `<option value="${p.flow_id}" data-local-id="${p.id}">${p.code || p.name} (Flow #${p.flow_id})</option>`
        ).join('');

        const modalHtml = `
            <h3>🔀 Export Note to Flow</h3>
            <p style="font-size:0.85em; color:#aaa; margin-bottom:12px;">
                Creates a Note in ShotGrid with the annotation image attached.
            </p>
            <label>Flow Project</label>
            <select id="flowNoteProject" style="width:100%; padding:8px; background:#2a2a2a; color:#eee; border:1px solid #444; border-radius:4px; margin-bottom:10px;">
                ${projectOptions}
            </select>
            <label>Subject (optional)</label>
            <input type="text" id="flowNoteSubject" placeholder="Auto-generated if blank" style="width:100%; padding:8px; background:#2a2a2a; color:#eee; border:1px solid #444; border-radius:4px; margin-bottom:10px;">
            <label>Additional Comments</label>
            <textarea id="flowNoteBody" rows="3" placeholder="Optional description..." style="width:100%; padding:8px; background:#2a2a2a; color:#eee; border:1px solid #444; border-radius:4px; margin-bottom:12px;"></textarea>
            <div class="form-actions">
                <button class="btn-cancel" onclick="closeModal()">Cancel</button>
                <button class="btn-primary" onclick="submitNoteToFlow(${noteId})">Export to Flow</button>
            </div>
        `;

        document.getElementById('modalContent').innerHTML = modalHtml;
        document.getElementById('modal').style.display = 'flex';
    } catch (err) {
        showToast('Failed to open Flow export: ' + err.message, 5000);
    }
}

/**
 * Submit the note export after the user picks a project.
 */
async function submitNoteToFlow(noteId) {
    const projectSelect = document.getElementById('flowNoteProject');
    const flowProjectId = parseInt(projectSelect.value);
    const subject = document.getElementById('flowNoteSubject').value.trim() || undefined;
    const body = document.getElementById('flowNoteBody').value.trim() || undefined;

    // Close modal immediately
    document.getElementById('modal').style.display = 'none';

    showToast('Exporting note to Flow...', 3000);

    try {
        const result = await api('/api/flow/publish/note', {
            method: 'POST',
            body: {
                reviewNoteId: noteId,
                flowProjectId,
                subject,
                body,
            },
        });

        if (result.success) {
            showToast(`✅ Note exported to Flow (ID: ${result.note?.flow_id || '?'})`, 5000);
            // Refresh notes to show the disabled export button
            if (currentNotesSessionId) {
                await fetchNotes(currentNotesSessionId);
            }
        } else {
            showToast('Flow export failed: ' + (result.error || 'Unknown error'), 5000);
        }
    } catch (err) {
        showToast('Flow export failed: ' + err.message, 5000);
    }
}

/**
 * Fetch session history (ended sessions).
 */
async function fetchHistory() {
    try {
        const params = filterProjectId ? `?project_id=${filterProjectId}` : '';
        const data = await api(`/api/review/history${params}`);
        historySessions = data.sessions || [];
        historyLoaded = true;
        renderHistoryPanel();
    } catch (err) {
        console.error('[SyncReview] Failed to fetch history:', err.message);
    }
}

/**
 * Switch tabs in the review panel.
 */
function switchReviewTab(tab) {
    currentTab = tab;

    // Update tab buttons
    document.querySelectorAll('.review-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Show/hide tab content
    const tabActive = document.getElementById('reviewTabActive');
    const tabHistory = document.getElementById('reviewTabHistory');
    const tabNotes = document.getElementById('reviewTabNotes');
    if (tabActive) tabActive.style.display = tab === 'active' ? '' : 'none';
    if (tabHistory) tabHistory.style.display = tab === 'history' ? '' : 'none';
    if (tabNotes) tabNotes.style.display = tab === 'notes' ? '' : 'none';

    // Load data for the tab
    if (tab === 'history' && !historyLoaded) {
        fetchHistory();
    }

    // Show filter bar only on active tab
    const filterBar = document.getElementById('reviewFilterBar');
    if (filterBar) filterBar.style.display = tab === 'active' ? '' : 'none';
}


// ─── UI Rendering ───

/**
 * Render the active reviews list inside the review panel.
 */
function renderReviewPanel() {
    const container = document.getElementById('reviewSessionsList');
    if (!container) return;

    if (activeReviews.length === 0) {
        container.innerHTML = `<div class="review-empty">No active review sessions${filterProjectId ? ' for this project' : ''}</div>`;
        return;
    }

    // Group sessions by project
    const grouped = {};
    const noProject = [];
    for (const session of activeReviews) {
        if (session.project_name) {
            if (!grouped[session.project_name]) grouped[session.project_name] = [];
            grouped[session.project_name].push(session);
        } else {
            noProject.push(session);
        }
    }

    let html = '';

    // Render grouped by project
    for (const [projectName, sessions] of Object.entries(grouped)) {
        html += `<div class="review-project-group">`;
        html += `<div class="review-project-label">${escHtml(projectName)}</div>`;
        for (const session of sessions) {
            html += renderSessionCard(session);
        }
        html += `</div>`;
    }

    // Render ungrouped sessions
    if (noProject.length > 0 && Object.keys(grouped).length > 0) {
        html += `<div class="review-project-group">`;
        html += `<div class="review-project-label" style="opacity:0.5">Other</div>`;
        for (const session of noProject) {
            html += renderSessionCard(session);
        }
        html += `</div>`;
    } else {
        for (const session of noProject) {
            html += renderSessionCard(session);
        }
    }

    container.innerHTML = html;
}

/**
 * Render a single review session card with asset details.
 */
function renderSessionCard(session) {
    const assetCount = Array.isArray(session.asset_ids) ? session.asset_ids.length : 0;
    const startedAgo = formatTimeAgo(session.started_at);

    // Build asset name list (show up to 3 names, then "+N more")
    let assetNames = '';
    if (session.assets && session.assets.length > 0) {
        const maxShow = 3;
        const shown = session.assets.slice(0, maxShow);
        const names = shown.map(a => escHtml(a.vault_name || `Asset #${a.id}`)).join(', ');
        const remaining = session.assets.length - maxShow;
        assetNames = remaining > 0 ? `${names} +${remaining} more` : names;
    } else if (assetCount > 0) {
        assetNames = `${assetCount} asset${assetCount !== 1 ? 's' : ''}`;
    }

    // Project badge
    const projectBadge = session.project_name
        ? `<span class="review-project-badge">${escHtml(session.project_code || session.project_name)}</span>`
        : '';

    // Action buttons: host sees "End", others see "Leave"
    let actionButtons;
    // Voice chat button (available for both host and participants)
    const voiceBtn = `<button class="btn-small btn-voice" onclick="joinVoiceChat(${session.id})" title="Join voice chat for this session">\uD83C\uDF99\uFE0F Voice</button>`;

    if (session.is_owner) {
        actionButtons = `
            ${voiceBtn}
            <button class="btn-small btn-notes" onclick="viewSessionNotes(${session.id})" title="Add or view notes for this session">\uD83D\uDCDD Notes</button>
            <button class="btn-small btn-end" onclick="endReview(${session.id})" title="End this review session for all participants">\u2715 End Session</button>
        `;
    } else {
        actionButtons = `
            <button class="btn-small btn-join" onclick="joinReview(${session.id})" title="Opens RV on your machine and connects to the host's synced session">
                \u25B6 Join &amp; Launch RV
            </button>
            ${voiceBtn}
            <button class="btn-small btn-notes" onclick="viewSessionNotes(${session.id})" title="Add or view notes for this session">\uD83D\uDCDD Notes</button>
            <button class="btn-small btn-leave" onclick="leaveReview(${session.id})" title="Disconnect your RV — the session stays active for others">\u21A9 Leave</button>
        `;
    }

    return `
    <div class="review-session-card${session.is_owner ? ' review-session-owned' : ''}" data-session-id="${session.id}">
        <div class="review-session-header">
            <span class="review-session-title">${escHtml(session.title || 'Untitled Review')}</span>
            ${session.is_owner ? '<span class="review-session-owner-badge">YOUR SESSION</span>' : ''}
            <span class="review-session-status">\u25CF LIVE</span>
        </div>
        <div class="review-session-meta">
            ${projectBadge}
            <span>Host: <strong>${escHtml(session.host_name)}</strong></span>
            <span>by <strong>${escHtml(session.started_by || 'Unknown')}</strong></span>
            <span>${startedAgo}</span>
        </div>
        ${assetNames ? `<div class="review-session-assets" title="${escHtml(assetNames)}">\uD83C\uDFAC ${assetNames}</div>` : ''}
        <div class="review-session-actions">
            ${actionButtons}
        </div>
    </div>`;
}

/**
 * Render the session history list (ended sessions).
 */
function renderHistoryPanel() {
    const container = document.getElementById('reviewHistoryList');
    if (!container) return;

    if (historySessions.length === 0) {
        container.innerHTML = `<div class="review-empty">No past review sessions</div>`;
        return;
    }

    let html = '';
    for (const session of historySessions) {
        const endedAgo = formatTimeAgo(session.ended_at);
        const startedAgo = formatTimeAgo(session.started_at);
        const projectBadge = session.project_name
            ? `<span class="review-project-badge">${escHtml(session.project_code || session.project_name)}</span>`
            : '';
        const notesBadge = session.note_count > 0
            ? `<span class="review-notes-badge">${session.note_count} note${session.note_count !== 1 ? 's' : ''}</span>`
            : '<span class="review-notes-badge review-notes-badge-empty">no notes</span>';

        html += `
        <div class="review-session-card review-session-ended" data-session-id="${session.id}">
            <div class="review-session-header">
                <span class="review-session-title">${escHtml(session.title || 'Untitled Review')}</span>
                <span class="review-session-status review-session-status-ended">\u2713 ENDED</span>
            </div>
            <div class="review-session-meta">
                ${projectBadge}
                <span>by <strong>${escHtml(session.started_by || 'Unknown')}</strong></span>
                <span>${startedAgo} \u2192 ${endedAgo}</span>
            </div>
            <div class="review-session-actions">
                <button class="btn-small btn-notes" onclick="viewSessionNotes(${session.id})" title="View notes from this review session">
                    \uD83D\uDCDD ${notesBadge}
                </button>
            </div>
        </div>`;
    }

    container.innerHTML = html;
}

/**
 * View notes for a specific session (switches to Notes tab).
 */
function viewSessionNotes(sessionId) {
    switchReviewTab('notes');
    fetchNotes(sessionId);
}

/**
 * Render the notes view for a session.
 */
function renderNotesView(sessionTitle, sessionStatus) {
    const container = document.getElementById('reviewNotesList');
    if (!container) return;

    // Note input form (only for active sessions)
    const isActive = sessionStatus === 'active';
    let html = `
    <div class="review-notes-header">
        <button class="review-notes-back" onclick="switchReviewTab('${isActive ? 'active' : 'history'}')" title="Back">\u2190</button>
        <span class="review-notes-title">${escHtml(sessionTitle || 'Review Notes')}</span>
        <span class="review-notes-count">${currentNotes.length} note${currentNotes.length !== 1 ? 's' : ''}</span>
    </div>`;

    if (isActive) {
        html += `
    <div class="review-note-form">
        <div class="review-note-form-row">
            <input type="number" id="reviewNoteFrame" class="review-note-frame-input" placeholder="Frame #" min="0" title="Frame number (optional)">
            <input type="text" id="reviewNoteText" class="review-note-text-input" placeholder="Add a note..." onkeydown="if(event.key==='Enter')submitReviewNote(${currentNotesSessionId})">
            <button class="btn-small btn-add-note" onclick="submitReviewNote(${currentNotesSessionId})" title="Add note">\u2795</button>
        </div>
        <div class="review-note-form-row">
            <select id="reviewNoteAsset" class="review-note-asset-select" title="Asset (optional)">
                <option value="">Any asset</option>
            </select>
        </div>
    </div>`;
    }

    if (currentNotes.length === 0) {
        html += `<div class="review-empty">No notes yet${isActive ? ' \u2014 add one above' : ''}</div>`;
    } else {
        // Group notes by asset
        const byAsset = {};
        const general = [];
        for (const note of currentNotes) {
            if (note.asset_id && note.asset_name) {
                if (!byAsset[note.asset_name]) byAsset[note.asset_name] = [];
                byAsset[note.asset_name].push(note);
            } else {
                general.push(note);
            }
        }

        // Render general notes first
        if (general.length > 0) {
            for (const note of general) {
                html += renderNoteCard(note);
            }
        }

        // Render by asset group
        for (const [assetName, notes] of Object.entries(byAsset)) {
            html += `<div class="review-notes-asset-group">`;
            html += `<div class="review-notes-asset-label">\uD83C\uDFAC ${escHtml(assetName)}</div>`;
            for (const note of notes) {
                html += renderNoteCard(note);
            }
            html += `</div>`;
        }
    }

    container.innerHTML = html;

    // Populate asset select dropdown if active session
    if (isActive) {
        populateNoteAssetSelect();
    }
}

/**
 * Render a single note card.
 */
function renderNoteCard(note) {
    const timeAgo = formatTimeAgo(note.created_at);
    const frameLabel = note.frame_number != null ? `<span class="review-note-frame">F${note.frame_number}</span>` : '';
    const timecodeLabel = note.timecode ? `<span class="review-note-timecode">${escHtml(note.timecode)}</span>` : '';

    const statusClass = note.status === 'resolved' ? 'resolved' : note.status === 'wontfix' ? 'wontfix' : 'open';
    const statusIcon = note.status === 'resolved' ? '\u2705' : note.status === 'wontfix' ? '\u274C' : '\u2B55';

    // Cycle through statuses: open → resolved → wontfix → open
    const nextStatus = note.status === 'open' ? 'resolved' : note.status === 'resolved' ? 'wontfix' : 'open';

    // Annotation image (frame snapshot from RV with paint-overs)
    const annotationHtml = note.annotation_image
        ? `<div class="review-note-annotation">
               <img src="/review-snapshots/${escHtml(note.annotation_image)}" 
                    alt="Annotated frame ${note.frame_number || ''}" 
                    class="review-note-annotation-img"
                    data-annotation-path="${escHtml(note.annotation_image)}"
                    onclick="openAnnotationFullscreen(this.src)"
                    onerror="annotationHubFallback(this)"
                    title="Click to view full size">
               <span class="review-note-annotation-badge">\uD83C\uDFA8 Annotated Frame</span>
           </div>`
        : '';

    return `
    <div class="review-note-card review-note-${statusClass}" data-note-id="${note.id}">
        <div class="review-note-card-header">
            <div class="review-note-card-meta">
                ${frameLabel}${timecodeLabel}
                <span class="review-note-author">${escHtml(note.author)}</span>
                <span class="review-note-time">${timeAgo}</span>
            </div>
            <div class="review-note-card-actions">
                <button class="review-note-flow-btn" onclick="exportNoteToFlow(${note.id})" title="Export to ShotGrid/Flow"${note.flow_note_id ? ' disabled style="opacity:0.4"' : ''}>\uD83D\uDD00</button>
                <button class="review-note-status-btn" onclick="updateNoteStatus(${note.id}, '${nextStatus}')" title="Status: ${note.status} (click to change)">${statusIcon}</button>
                <button class="review-note-delete-btn" onclick="deleteReviewNote(${note.id})" title="Delete note">\uD83D\uDDD1</button>
            </div>
        </div>
        ${annotationHtml}
        <div class="review-note-text">${escHtml(note.note_text)}</div>
    </div>`;
}

/**
 * Populate the asset dropdown in the note form from the active session's assets.
 */
function populateNoteAssetSelect() {
    const select = document.getElementById('reviewNoteAsset');
    if (!select || !currentNotesSessionId) return;

    // Find the session in active reviews
    const session = activeReviews.find(s => s.id === currentNotesSessionId);
    if (!session || !session.assets) return;

    for (const asset of session.assets) {
        const opt = document.createElement('option');
        opt.value = asset.id;
        opt.textContent = asset.vault_name || `Asset #${asset.id}`;
        select.appendChild(opt);
    }
}

/**
 * Submit a note from the form.
 */
async function submitReviewNote(sessionId) {
    const textEl = document.getElementById('reviewNoteText');
    const frameEl = document.getElementById('reviewNoteFrame');
    const assetEl = document.getElementById('reviewNoteAsset');
    if (!textEl) return;

    const noteText = textEl.value.trim();
    const frameNumber = frameEl && frameEl.value ? parseInt(frameEl.value, 10) : null;
    const assetId = assetEl && assetEl.value ? parseInt(assetEl.value, 10) : null;

    await addReviewNote(sessionId, noteText, assetId, frameNumber);
    textEl.value = '';
    if (frameEl) frameEl.value = '';
}

/**
 * Update the badge count on the review button in the header.
 */
function updateBadge() {
    const btn = document.getElementById('reviewBtn');
    const badge = document.getElementById('reviewBadge');
    if (!btn || !badge) return;

    const count = activeReviews.length;
    badge.textContent = count;

    // Always show the button; badge only when there are active reviews
    btn.style.display = '';
    if (count > 0) {
        btn.classList.add('has-reviews');
        badge.style.display = '';
    } else {
        btn.classList.remove('has-reviews');
        badge.style.display = 'none';
    }
}

/**
 * Toggle the review panel visibility.
 */
function toggleReviewPanel() {
    const panel = document.getElementById('reviewPanel');
    if (!panel) return;
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : '';
    if (!isVisible) {
        // Auto-set filter to current project if user is in a project view
        autoSetProjectFilter();
        fetchReviews();
    }
}

/**
 * Auto-set the project filter based on the user's current project context.
 * If they're browsing a project, default to filtering that project's sessions.
 */
async function autoSetProjectFilter() {
    try {
        const { state } = await import('./state.js');
        if (state.currentProject && state.currentProject.id) {
            filterProjectId = state.currentProject.id;
        } else {
            filterProjectId = null;
        }
        renderFilterBar();
    } catch {
        filterProjectId = null;
        renderFilterBar();
    }
}

/**
 * Render the filter bar inside the review panel header area.
 */
function renderFilterBar() {
    const bar = document.getElementById('reviewFilterBar');
    if (!bar) return;

    if (filterProjectId) {
        bar.innerHTML = `
            <span class="review-filter-label">Filtered to current project</span>
            <button class="review-filter-btn" onclick="clearReviewFilter()" title="Show all reviews across all projects">Show All</button>
        `;
        bar.style.display = '';
    } else {
        bar.innerHTML = `<span class="review-filter-label" style="opacity:0.5">Showing all projects</span>`;
        bar.style.display = '';
    }
}

/**
 * Clear the project filter — show all reviews.
 */
function clearReviewFilter() {
    filterProjectId = null;
    renderFilterBar();
    fetchReviews();
}

/**
 * Set the filter to a specific project.
 */
function setReviewProjectFilter(projectId) {
    filterProjectId = projectId || null;
    renderFilterBar();
    fetchReviews();
}


// ─── Annotation Fullscreen Viewer ───

/**
 * Open an annotated frame snapshot in a fullscreen overlay.
 */
function openAnnotationFullscreen(imgSrc) {
    // Remove existing overlay if any
    const existing = document.getElementById('annotationOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'annotationOverlay';
    overlay.className = 'annotation-overlay';
    overlay.innerHTML = `
        <div class="annotation-overlay-bg" onclick="closeAnnotationFullscreen()"></div>
        <img src="${imgSrc}" class="annotation-overlay-img" alt="Annotated frame">
        <button class="annotation-overlay-close" onclick="closeAnnotationFullscreen()">\u2715</button>
    `;
    document.body.appendChild(overlay);

    // Close on Escape
    overlay._keyHandler = (e) => { if (e.key === 'Escape') closeAnnotationFullscreen(); };
    document.addEventListener('keydown', overlay._keyHandler);
}

function closeAnnotationFullscreen() {
    const overlay = document.getElementById('annotationOverlay');
    if (overlay) {
        document.removeEventListener('keydown', overlay._keyHandler);
        overlay.remove();
    }
}


// ─── Polling ───

/**
 * Start polling for active review sessions.
 * Only polls when in hub or spoke mode (standalone doesn't need it for multi-user,
 * but we enable it anyway for future use).
 */
function startPolling() {
    if (pollTimer) return;
    fetchReviews(); // Initial fetch
    pollTimer = setInterval(fetchReviews, POLL_INTERVAL);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}


// ─── Helpers ───

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatTimeAgo(isoDate) {
    if (!isoDate) return '';
    const d = new Date(isoDate + (isoDate.endsWith('Z') ? '' : 'Z'));
    const now = Date.now();
    const diffMin = Math.floor((now - d.getTime()) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.floor(diffHr / 24)}d ago`;
}

/**
 * Start a sync review from the selection toolbar (uses current selection).
 */
async function startSyncReviewFromSelection() {
    const { state } = await import('./state.js');
    if (!state.selectedAssets || state.selectedAssets.length === 0) {
        showToast('Select assets first, then start a sync review', 4000);
        return;
    }
    await startSyncReview([...state.selectedAssets]);
}


// ─── Expose to global scope ───
window.startSyncReview = startSyncReview;
window.joinReview = joinReview;
window.endReview = endReview;
window.leaveReview = leaveReview;
window.toggleReviewPanel = toggleReviewPanel;
window.startSyncReviewFromSelection = startSyncReviewFromSelection;
window.clearReviewFilter = clearReviewFilter;
window.setReviewProjectFilter = setReviewProjectFilter;
window.switchReviewTab = switchReviewTab;
window.viewSessionNotes = viewSessionNotes;
window.submitReviewNote = submitReviewNote;
window.addReviewNote = addReviewNote;
window.updateNoteStatus = updateNoteStatus;
window.deleteReviewNote = deleteReviewNote;
window.openAnnotationFullscreen = openAnnotationFullscreen;
window.closeAnnotationFullscreen = closeAnnotationFullscreen;
window.annotationHubFallback = annotationHubFallback;

// ─── Init ───
// Start polling when module loads
startPolling();

export {
    startSyncReview,
    joinReview,
    endReview,
    fetchReviews,
    toggleReviewPanel,
    startSyncReviewFromSelection,
};
