/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - SQLite Database Layer (sql.js — pure WASM, no native deps)
 * Provides a better-sqlite3–compatible API wrapper around sql.js
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LOCAL_DB_PATH = path.join(DATA_DIR, 'mediavault.db');

let dbPath = LOCAL_DB_PATH;   // Active DB path (may point to shared location)
let db = null;                // DatabaseWrapper instance
let SQL = null;               // sql.js module ref (for reloads)
let lastExternalMtime = 0;    // Track external modifications for polling
let pollTimer = null;         // Polling interval handle
const POLL_INTERVAL = 5000;   // Check for external changes every 5s

// ─── Local Config (machine-specific, NOT in DB) ───

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (e) {
        console.error('[DB] Failed to read config.json:', e.message);
    }
    return {};
}

function saveConfig(config) {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('[DB] Failed to write config.json:', e.message);
    }
}

function resolveDbPath() {
    const config = loadConfig();
    if (config.shared_db_path) {
        const shared = path.join(config.shared_db_path, 'mediavault.db');
        try {
            if (!fs.existsSync(config.shared_db_path)) {
                console.warn(`[DB] Shared path not accessible: ${config.shared_db_path} — falling back to local`);
                return LOCAL_DB_PATH;
            }
            return shared;
        } catch (e) {
            console.warn(`[DB] Shared path error: ${e.message} — falling back to local`);
            return LOCAL_DB_PATH;
        }
    }
    return LOCAL_DB_PATH;
}

// ─── Compatibility Wrapper ───
// Provides the same .prepare().run/get/all() API as better-sqlite3

class PreparedStatement {
    constructor(rawDb, sql, wrapper) {
        this._rawDb = rawDb;
        this._sql = sql;
        this._wrapper = wrapper;
    }

    run(...params) {
        const clean = params.map(p => (p === undefined ? null : p));
        if (clean.length > 0) {
            this._rawDb.run(this._sql, clean);
        } else {
            this._rawDb.run(this._sql);
        }
        const lastRes = this._rawDb.exec('SELECT last_insert_rowid()');
        const lastInsertRowid = lastRes.length ? lastRes[0].values[0][0] : 0;
        const chgRes = this._rawDb.exec('SELECT changes()');
        const changes = chgRes.length ? chgRes[0].values[0][0] : 0;

        if (!this._wrapper._inTransaction) this._wrapper._save();
        return { lastInsertRowid, changes };
    }

    get(...params) {
        const clean = params.map(p => (p === undefined ? null : p));
        let stmt;
        try {
            stmt = this._rawDb.prepare(this._sql);
            if (clean.length > 0) stmt.bind(clean);
            if (stmt.step()) {
                return stmt.getAsObject();
            }
            return undefined;
        } finally {
            if (stmt) stmt.free();
        }
    }

    all(...params) {
        const clean = params.map(p => (p === undefined ? null : p));
        const results = [];
        let stmt;
        try {
            stmt = this._rawDb.prepare(this._sql);
            if (clean.length > 0) stmt.bind(clean);
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
        } finally {
            if (stmt) stmt.free();
        }
        return results;
    }
}

class DatabaseWrapper {
    constructor(rawDb) {
        this._rawDb = rawDb;
        this._inTransaction = false;
    }

    prepare(sql) {
        return new PreparedStatement(this._rawDb, sql, this);
    }

    exec(sql) {
        this._rawDb.exec(sql);
        if (!this._inTransaction) this._save();
    }

    pragma(str) {
        try { this._rawDb.exec(`PRAGMA ${str}`); } catch (_) { /* ignore unsupported */ }
    }

    transaction(fn) {
        const self = this;
        return function (...args) {
            self._rawDb.exec('BEGIN');
            self._inTransaction = true;
            try {
                fn(...args);
                self._rawDb.exec('COMMIT');
                self._inTransaction = false;
                self._save();
            } catch (e) {
                self._rawDb.exec('ROLLBACK');
                self._inTransaction = false;
                throw e;
            }
        };
    }

    close() {
        this._save();
        this._rawDb.close();
    }

    _save() {
        try {
            const data = this._rawDb.export();
            const buffer = Buffer.from(data);
            const tmp = dbPath + '.tmp';
            fs.writeFileSync(tmp, buffer);
            fs.renameSync(tmp, dbPath);
            // Update our own mtime so polling doesn't treat our write as external
            try { lastExternalMtime = fs.statSync(dbPath).mtimeMs; } catch (_) {}
        } catch (e) {
            console.error('[DB] Save failed:', e.message);
        }
    }
}

// ─── Async Init (call once in server.js before starting) ───

async function initDb() {
    if (db) return db;

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    SQL = await initSqlJs();

    // Resolve DB path (local or shared)
    dbPath = resolveDbPath();
    const isShared = dbPath !== LOCAL_DB_PATH;
    console.log(`[DB] Using ${isShared ? 'SHARED' : 'local'} database: ${dbPath}`);

    // If shared path has no DB yet, copy local DB there (first-time share setup)
    if (isShared && !fs.existsSync(dbPath) && fs.existsSync(LOCAL_DB_PATH)) {
        console.log('[DB] Copying local database to shared location...');
        fs.copyFileSync(LOCAL_DB_PATH, dbPath);
    }

    let rawDb;
    if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        rawDb = new SQL.Database(buffer);
    } else {
        rawDb = new SQL.Database();
    }

    db = new DatabaseWrapper(rawDb);
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    // Track mtime for external change detection
    try { lastExternalMtime = fs.statSync(dbPath).mtimeMs; } catch (_) {}

    // Start polling for external changes (other machines writing to shared DB)
    if (isShared) startPolling();

    return db;
}

// ─── External Change Detection (Shared DB Sync) ───

function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        try {
            if (!fs.existsSync(dbPath)) return;
            const stat = fs.statSync(dbPath);
            if (stat.mtimeMs > lastExternalMtime + 500) {
                console.log('[DB] External change detected — reloading shared database');
                reloadFromDisk();
            }
        } catch (e) {
            // Network drive temporarily unavailable — ignore
        }
    }, POLL_INTERVAL);
    pollTimer.unref();  // Don't prevent process exit
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function reloadFromDisk() {
    try {
        const buffer = fs.readFileSync(dbPath);
        const rawDb = new SQL.Database(buffer);
        const oldRaw = db._rawDb;
        db._rawDb = rawDb;
        try { oldRaw.close(); } catch (_) {}
        db.pragma('foreign_keys = ON');
        lastExternalMtime = fs.statSync(dbPath).mtimeMs;
        console.log('[DB] Shared database reloaded successfully');
    } catch (e) {
        console.error('[DB] Reload failed:', e.message);
    }
}

function getDb() {
    if (!db) throw new Error('Database not initialized — call initDb() first');
    return db;
}

// ─── Schema ───

function runMigrations(wrapper) {
    wrapper.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            code TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL DEFAULT 'flexible',
            description TEXT DEFAULT '',
            thumbnail_path TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sequences (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            code TEXT NOT NULL,
            description TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(project_id, code)
        );

        CREATE TABLE IF NOT EXISTS shots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            code TEXT NOT NULL,
            description TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(sequence_id, code)
        );

        CREATE TABLE IF NOT EXISTS assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            sequence_id INTEGER REFERENCES sequences(id) ON DELETE SET NULL,
            shot_id INTEGER REFERENCES shots(id) ON DELETE SET NULL,
            original_name TEXT NOT NULL,
            vault_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            media_type TEXT NOT NULL,
            file_ext TEXT NOT NULL,
            file_size INTEGER DEFAULT 0,
            width INTEGER,
            height INTEGER,
            duration REAL,
            fps REAL,
            codec TEXT,
            take_number INTEGER,
            version INTEGER DEFAULT 1,
            thumbnail_path TEXT,
            proxy_path TEXT,
            tags TEXT DEFAULT '[]',
            notes TEXT DEFAULT '',
            metadata TEXT DEFAULT '{}',
            comfyui_node_id TEXT,
            comfyui_workflow TEXT,
            starred INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS watch_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
            auto_import INTEGER DEFAULT 0,
            file_pattern TEXT DEFAULT '*',
            last_scanned TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS comfyui_mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id TEXT,
            node_id TEXT NOT NULL,
            asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
            file_path TEXT NOT NULL,
            last_used TEXT DEFAULT (datetime('now')),
            UNIQUE(workflow_id, node_id)
        );

        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            entity_type TEXT,
            entity_id INTEGER,
            details TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            code TEXT NOT NULL UNIQUE,
            color TEXT DEFAULT '#888888',
            icon TEXT DEFAULT '🎭',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
        CREATE INDEX IF NOT EXISTS idx_assets_sequence ON assets(sequence_id);
        CREATE INDEX IF NOT EXISTS idx_assets_shot ON assets(shot_id);
        CREATE INDEX IF NOT EXISTS idx_assets_media_type ON assets(media_type);
        CREATE INDEX IF NOT EXISTS idx_assets_vault_name ON assets(vault_name);
        CREATE INDEX IF NOT EXISTS idx_sequences_project ON sequences(project_id);
        CREATE INDEX IF NOT EXISTS idx_shots_sequence ON shots(sequence_id);
        CREATE INDEX IF NOT EXISTS idx_comfyui_mappings_node ON comfyui_mappings(node_id);
    `);

    // ─── Add role_id column to assets if missing (migration) ───
    try {
        const cols = [];
        let st = wrapper._rawDb.prepare('PRAGMA table_info(assets)');
        while (st.step()) cols.push(st.getAsObject().name);
        st.free();
        if (!cols.includes('role_id')) {
            wrapper.exec('ALTER TABLE assets ADD COLUMN role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL');
        }
        // Create index after column exists
        wrapper.exec('CREATE INDEX IF NOT EXISTS idx_assets_role ON assets(role_id)');
    } catch (_) { /* column already exists */ }

    // ─── Add is_linked column to assets if missing (linked/reference import) ───
    try {
        const assetCols2 = [];
        let stLink = wrapper._rawDb.prepare('PRAGMA table_info(assets)');
        while (stLink.step()) assetCols2.push(stLink.getAsObject().name);
        stLink.free();
        if (!assetCols2.includes('is_linked')) {
            wrapper.exec('ALTER TABLE assets ADD COLUMN is_linked INTEGER DEFAULT 0');
        }
    } catch (_) { /* column already exists */ }

    // ─── Add sequence + derivative columns to assets ───
    const seqDerivCols = {
        is_sequence:     'INTEGER DEFAULT 0',
        frame_start:     'INTEGER',
        frame_end:       'INTEGER',
        frame_count:     'INTEGER',
        frame_pattern:   'TEXT',
        parent_asset_id: 'INTEGER',
        is_derivative:   'INTEGER DEFAULT 0',
    };
    try {
        const assetColsSD = [];
        let stSD = wrapper._rawDb.prepare('PRAGMA table_info(assets)');
        while (stSD.step()) assetColsSD.push(stSD.getAsObject().name);
        stSD.free();
        for (const [col, typedef] of Object.entries(seqDerivCols)) {
            if (!assetColsSD.includes(col)) {
                wrapper.exec(`ALTER TABLE assets ADD COLUMN ${col} ${typedef}`);
            }
        }
        wrapper.exec('CREATE INDEX IF NOT EXISTS idx_assets_parent ON assets(parent_asset_id)');
        wrapper.exec('CREATE INDEX IF NOT EXISTS idx_assets_sequence_flag ON assets(is_sequence)');
    } catch (_) { /* columns already exist */ }

    // ─── Add flow_id columns for Flow Production Tracking integration ───
    const flowTables = ['projects', 'sequences', 'shots', 'roles'];
    for (const table of flowTables) {
        try {
            const cols = [];
            let st2 = wrapper._rawDb.prepare(`PRAGMA table_info(${table})`);
            while (st2.step()) cols.push(st2.getAsObject().name);
            st2.free();
            if (!cols.includes('flow_id')) {
                wrapper.exec(`ALTER TABLE ${table} ADD COLUMN flow_id INTEGER`);
                wrapper.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_flow_id ON ${table}(flow_id)`);
            }
        } catch (_) { /* column already exists */ }
    }

    // ─── Seed default roles if roles table is empty ───
    const roleCount = wrapper.prepare('SELECT COUNT(*) as count FROM roles').get();
    if (roleCount.count === 0) {
        const insertRole = wrapper.prepare('INSERT OR IGNORE INTO roles (name, code, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)');
        const defaultRoles = [
            ['Comp',       'COMP',       '#4fc3f7', '🎨', 1],
            ['Light',      'LIGHT',      '#fff176', '💡', 2],
            ['Anim',       'ANIM',       '#81c784', '🏃', 3],
            ['FX',         'FX',         '#ff8a65', '✨', 4],
            ['Enviro',     'ENVIRO',     '#a5d6a7', '🌲', 5],
            ['Layout',     'LAYOUT',     '#ce93d8', '📐', 6],
            ['Matchmove',  'MATCHMOVE',  '#90a4ae', '📍', 7],
            ['Roto',       'ROTO',       '#f48fb1', '✂️', 8],
        ];
        const seedRoles = wrapper.transaction((roles) => {
            for (const r of roles) insertRole.run(...r);
        });
        seedRoles(defaultRoles);
    }

    // Seed defaults if settings table is empty
    const row = wrapper.prepare('SELECT COUNT(*) as count FROM settings').get();
    if (row.count === 0) {
        const insert = wrapper.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
        const defaults = {
            vault_root: '',
            naming_template: '{project}_{sequence}_{shot}_{take}_{counter}',
            thumbnail_size: '320',
            proxy_enabled: 'false',
            proxy_resolution: '1280',
            comfyui_url: 'http://127.0.0.1:8188',
            comfyui_output_path: '',
            comfyui_watch_enabled: 'false',
            auto_thumbnail: 'true',
            default_project_type: 'flexible',
        };
        const insertMany = wrapper.transaction((entries) => {
            for (const [key, value] of entries) {
                insert.run(key, value);
            }
        });
        insertMany(Object.entries(defaults));
    }
}

// ─── Settings Helpers ───

function getSetting(key) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setSetting(key, value) {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
    const rows = getDb().prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

// ─── Activity Log ───

function logActivity(action, entityType, entityId, details = {}) {
    getDb().prepare(
        'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)'
    ).run(action, entityType, entityId, JSON.stringify(details));
}

function getRecentActivity(limit = 50) {
    return getDb().prepare(
        'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
}

// ─── Close gracefully ───

function closeDb() {
    stopPolling();
    if (db) {
        db.close();
        db = null;
    }
}

module.exports = {
    initDb,
    getDb,
    getSetting,
    setSetting,
    getAllSettings,
    logActivity,
    getRecentActivity,
    closeDb,
    loadConfig,
    saveConfig,
    resolveDbPath,
    reloadFromDisk,
    get dbPath() { return dbPath; },
    get DB_PATH() { return dbPath; },  // Backward compat
    CONFIG_PATH,
    DATA_DIR,
};
