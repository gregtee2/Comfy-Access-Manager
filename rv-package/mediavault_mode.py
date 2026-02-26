# Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
# This source code is proprietary and confidential. Unauthorized copying,
# modification, distribution, or use of this file is strictly prohibited.
# See LICENSE file for details.
#
# MediaVault Integration for OpenRV
# Adds "MediaVault" menu with Compare/Switch picker dialogs
# and Prev/Next Version hotkeys for fast version stepping.
#

import rv.rvtypes
import rv.commands as rvc
import rv.extra_commands as rve
import json
import os
import re
import tempfile

import time

try:
    import urllib.request
    import urllib.parse
except ImportError:
    urllib = None

# ─── OpenGL for overlay rendering ─────────────────────────────
_HAS_GL = False
try:
    from OpenGL.GL import (
        glMatrixMode, glPushMatrix, glPopMatrix, glLoadIdentity,
        glEnable, glDisable, glBlendFunc, glColor4f,
        glBegin, glEnd, glVertex2f, glRasterPos2f, glLineWidth,
        glBitmap, glPixelStorei,
        GL_PROJECTION, GL_MODELVIEW, GL_BLEND,
        GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_QUADS, GL_LINE_LOOP,
        GL_UNPACK_ALIGNMENT,
    )
    from OpenGL.GLU import gluOrtho2D
    _HAS_GL = True
except ImportError:
    pass

try:
    from PySide2.QtWidgets import (
        QDialog, QVBoxLayout, QHBoxLayout, QTreeWidget, QTreeWidgetItem,
        QTableWidget, QTableWidgetItem, QHeaderView, QPushButton,
        QCheckBox, QLabel, QFrame, QAbstractItemView, QGroupBox,
        QSplitter, QWidget, QMenu, QAction, QApplication,
        QListWidget, QListWidgetItem
    )
    from PySide2.QtGui import QCursor, QFont, QColor, QBrush, QIcon
    from PySide2.QtCore import Qt, QSize
    HAS_QT = True
except ImportError:
    try:
        from PySide6.QtWidgets import (
            QDialog, QVBoxLayout, QHBoxLayout, QTreeWidget, QTreeWidgetItem,
            QTableWidget, QTableWidgetItem, QHeaderView, QPushButton,
            QCheckBox, QLabel, QFrame, QAbstractItemView, QGroupBox,
            QSplitter, QWidget, QMenu, QApplication,
            QListWidget, QListWidgetItem
        )
        from PySide6.QtGui import QCursor, QAction, QFont, QColor, QBrush, QIcon
        from PySide6.QtCore import Qt, QSize
        HAS_QT = True
    except ImportError:
        HAS_QT = False

DMV_URL = "http://127.0.0.1:7700"

# ─── Dark theme with teal accent ─────────────────────────────────
# Dark charcoal base with teal (#2ec4b6) highlights.

DIALOG_STYLE = """
QDialog {
    background: #1e1e24;
    color: #d4d4d8;
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: 13px;
}
QSplitter::handle { background: #333340; width: 3px; }

/* ── Tree (left) ─────────────── */
QTreeWidget {
    background: #25252d;
    border: 1px solid #3a3a46;
    border-radius: 6px;
    color: #d4d4d8;
    font-size: 13px;
    outline: none;
    padding: 2px;
}
QTreeWidget::item {
    padding: 4px 6px;
    border-radius: 3px;
}
QTreeWidget::item:selected {
    background: #2ec4b6;
    color: #111;
}
QTreeWidget::item:hover:!selected {
    background: #333340;
}
QTreeWidget::branch { background: transparent; }

/* ── Table (center) ──────────── */
QTableWidget {
    background: #25252d;
    border: 1px solid #3a3a46;
    border-radius: 6px;
    gridline-color: #333340;
    color: #d4d4d8;
    font-size: 13px;
    outline: none;
    selection-background-color: #2ec4b650;
    selection-color: #fff;
}
QTableWidget::item {
    padding: 3px 8px;
}
QTableWidget::item:hover {
    background: #333340;
}
QHeaderView::section {
    background: qlineargradient(x1:0,y1:0,x2:0,y2:1, stop:0 #35354a, stop:1 #2a2a3a);
    color: #aaa;
    padding: 5px 8px;
    border: none;
    border-bottom: 2px solid #2ec4b6;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

/* ── Checkboxes (right filter) ── */
QGroupBox {
    background: #25252d;
    border: 1px solid #3a3a46;
    border-radius: 6px;
    margin-top: 14px;
    padding-top: 16px;
    font-weight: bold;
    color: #aaa;
}
QGroupBox::title {
    subcontrol-origin: margin;
    left: 12px;
    padding: 0 6px;
    color: #2ec4b6;
}
QCheckBox {
    color: #bbb;
    spacing: 6px;
    padding: 3px 4px;
}
QCheckBox:hover { color: #fff; }
QCheckBox::indicator {
    width: 16px; height: 16px;
    border-radius: 3px;
    border: 1px solid #555;
    background: #2a2a34;
}
QCheckBox::indicator:checked {
    background: #2ec4b6;
    border: 1px solid #2ec4b6;
}

/* ── Buttons ─────────────────── */
QPushButton {
    background: #35354a;
    color: #ccc;
    border: 1px solid #3a3a46;
    border-radius: 5px;
    padding: 7px 22px;
    font-weight: 600;
    font-size: 13px;
    min-width: 80px;
}
QPushButton:hover {
    background: #43435a;
    border-color: #2ec4b6;
    color: #fff;
}
QPushButton#loadBtn {
    background: qlineargradient(x1:0,y1:0,x2:0,y2:1, stop:0 #2ec4b6, stop:1 #24a89c);
    color: #111;
    border: none;
    font-weight: 700;
}
QPushButton#loadBtn:hover {
    background: qlineargradient(x1:0,y1:0,x2:0,y2:1, stop:0 #3ddbc8, stop:1 #2ec4b6);
}
QPushButton#loadBtn:disabled {
    background: #3a3a46;
    color: #666;
}

QLabel#scopeLabel {
    color: #888;
    font-size: 11px;
    padding: 2px 0;
}
QLabel#titleLabel {
    color: #d4d4d8;
    font-size: 15px;
    font-weight: 700;
}
"""


# ─── Overlay visual constants ─────────────────────────────────
_OV_BG      = (0.0, 0.0, 0.0, 0.55)       # semi-transparent black background
_OV_TEXT    = (1.0, 1.0, 1.0, 0.90)       # white text
_OV_WM      = (1.0, 1.0, 1.0, 0.07)       # very faint watermark
_STATUS_COLORS = {
    "WIP":      (1.0, 0.65, 0.0,  0.85),   # orange
    "Review":   (0.3, 0.6,  1.0,  0.85),   # blue
    "Approved": (0.2, 0.8,  0.2,  0.85),   # green
    "Final":    (0.0, 0.75, 0.95, 0.85),   # cyan
    "Reject":   (1.0, 0.2,  0.2,  0.85),   # red
}

# ─── Built-in 5×7 pixel font (pure GL – no GLUT or freeglut DLL needed) ──────
# Each glyph is 8 px wide (5 used + 3 padding) × 7 rows, stored MSB-first.
# One byte per row, top row first.  Only printable ASCII 32-126 defined.
_GLYPH_W = 6     # advance per character (px) – includes 1px spacing
_GLYPH_H = 8     # bitmap height for glBitmap (px)
_FONT_DATA = {}   # ord(char) -> bytes(7)  filled below

def _def_glyphs():
    """Populate _FONT_DATA with a compact 5×7 bitmap font."""
    # fmt: off
    _raw = {
        ' ': (0x00,0x00,0x00,0x00,0x00,0x00,0x00),
        '!': (0x20,0x20,0x20,0x20,0x20,0x00,0x20),
        '"': (0x50,0x50,0x00,0x00,0x00,0x00,0x00),
        '#': (0x50,0xF8,0x50,0x50,0xF8,0x50,0x00),
        '$': (0x20,0x78,0xA0,0x70,0x28,0xF0,0x20),
        '%': (0xC8,0xD0,0x20,0x40,0x58,0x98,0x00),
        '&': (0x40,0xA0,0x40,0xA8,0x90,0x68,0x00),
        "'": (0x20,0x20,0x00,0x00,0x00,0x00,0x00),
        '(': (0x10,0x20,0x40,0x40,0x40,0x20,0x10),
        ')': (0x40,0x20,0x10,0x10,0x10,0x20,0x40),
        '*': (0x00,0x50,0x20,0xF8,0x20,0x50,0x00),
        '+': (0x00,0x20,0x20,0xF8,0x20,0x20,0x00),
        ',': (0x00,0x00,0x00,0x00,0x00,0x20,0x40),
        '-': (0x00,0x00,0x00,0xF8,0x00,0x00,0x00),
        '.': (0x00,0x00,0x00,0x00,0x00,0x00,0x20),
        '/': (0x08,0x10,0x10,0x20,0x40,0x40,0x80),
        '0': (0x70,0x88,0x98,0xA8,0xC8,0x88,0x70),
        '1': (0x20,0x60,0x20,0x20,0x20,0x20,0x70),
        '2': (0x70,0x88,0x08,0x10,0x20,0x40,0xF8),
        '3': (0x70,0x88,0x08,0x30,0x08,0x88,0x70),
        '4': (0x10,0x30,0x50,0x90,0xF8,0x10,0x10),
        '5': (0xF8,0x80,0xF0,0x08,0x08,0x88,0x70),
        '6': (0x30,0x40,0x80,0xF0,0x88,0x88,0x70),
        '7': (0xF8,0x08,0x10,0x20,0x40,0x40,0x40),
        '8': (0x70,0x88,0x88,0x70,0x88,0x88,0x70),
        '9': (0x70,0x88,0x88,0x78,0x08,0x10,0x60),
        ':': (0x00,0x00,0x20,0x00,0x00,0x20,0x00),
        ';': (0x00,0x00,0x20,0x00,0x00,0x20,0x40),
        '<': (0x08,0x10,0x20,0x40,0x20,0x10,0x08),
        '=': (0x00,0x00,0xF8,0x00,0xF8,0x00,0x00),
        '>': (0x80,0x40,0x20,0x10,0x20,0x40,0x80),
        '?': (0x70,0x88,0x08,0x10,0x20,0x00,0x20),
        '@': (0x70,0x88,0xB8,0xA8,0xB8,0x80,0x78),
        'A': (0x70,0x88,0x88,0xF8,0x88,0x88,0x88),
        'B': (0xF0,0x88,0x88,0xF0,0x88,0x88,0xF0),
        'C': (0x70,0x88,0x80,0x80,0x80,0x88,0x70),
        'D': (0xE0,0x90,0x88,0x88,0x88,0x90,0xE0),
        'E': (0xF8,0x80,0x80,0xF0,0x80,0x80,0xF8),
        'F': (0xF8,0x80,0x80,0xF0,0x80,0x80,0x80),
        'G': (0x70,0x88,0x80,0xB8,0x88,0x88,0x70),
        'H': (0x88,0x88,0x88,0xF8,0x88,0x88,0x88),
        'I': (0x70,0x20,0x20,0x20,0x20,0x20,0x70),
        'J': (0x38,0x10,0x10,0x10,0x10,0x90,0x60),
        'K': (0x88,0x90,0xA0,0xC0,0xA0,0x90,0x88),
        'L': (0x80,0x80,0x80,0x80,0x80,0x80,0xF8),
        'M': (0x88,0xD8,0xA8,0x88,0x88,0x88,0x88),
        'N': (0x88,0xC8,0xA8,0x98,0x88,0x88,0x88),
        'O': (0x70,0x88,0x88,0x88,0x88,0x88,0x70),
        'P': (0xF0,0x88,0x88,0xF0,0x80,0x80,0x80),
        'Q': (0x70,0x88,0x88,0x88,0xA8,0x90,0x68),
        'R': (0xF0,0x88,0x88,0xF0,0xA0,0x90,0x88),
        'S': (0x70,0x88,0x80,0x70,0x08,0x88,0x70),
        'T': (0xF8,0x20,0x20,0x20,0x20,0x20,0x20),
        'U': (0x88,0x88,0x88,0x88,0x88,0x88,0x70),
        'V': (0x88,0x88,0x88,0x88,0x50,0x50,0x20),
        'W': (0x88,0x88,0x88,0x88,0xA8,0xD8,0x88),
        'X': (0x88,0x88,0x50,0x20,0x50,0x88,0x88),
        'Y': (0x88,0x88,0x50,0x20,0x20,0x20,0x20),
        'Z': (0xF8,0x08,0x10,0x20,0x40,0x80,0xF8),
        '[': (0x70,0x40,0x40,0x40,0x40,0x40,0x70),
        '\\': (0x80,0x40,0x40,0x20,0x10,0x10,0x08),
        ']': (0x70,0x10,0x10,0x10,0x10,0x10,0x70),
        '^': (0x20,0x50,0x88,0x00,0x00,0x00,0x00),
        '_': (0x00,0x00,0x00,0x00,0x00,0x00,0xF8),
        '`': (0x40,0x20,0x00,0x00,0x00,0x00,0x00),
        'a': (0x00,0x00,0x70,0x08,0x78,0x88,0x78),
        'b': (0x80,0x80,0xF0,0x88,0x88,0x88,0xF0),
        'c': (0x00,0x00,0x70,0x80,0x80,0x88,0x70),
        'd': (0x08,0x08,0x78,0x88,0x88,0x88,0x78),
        'e': (0x00,0x00,0x70,0x88,0xF8,0x80,0x70),
        'f': (0x30,0x48,0x40,0xE0,0x40,0x40,0x40),
        'g': (0x00,0x00,0x78,0x88,0x78,0x08,0x70),
        'h': (0x80,0x80,0xB0,0xC8,0x88,0x88,0x88),
        'i': (0x20,0x00,0x60,0x20,0x20,0x20,0x70),
        'j': (0x10,0x00,0x30,0x10,0x10,0x90,0x60),
        'k': (0x80,0x80,0x90,0xA0,0xC0,0xA0,0x90),
        'l': (0x60,0x20,0x20,0x20,0x20,0x20,0x70),
        'm': (0x00,0x00,0xD0,0xA8,0xA8,0x88,0x88),
        'n': (0x00,0x00,0xB0,0xC8,0x88,0x88,0x88),
        'o': (0x00,0x00,0x70,0x88,0x88,0x88,0x70),
        'p': (0x00,0x00,0xF0,0x88,0xF0,0x80,0x80),
        'q': (0x00,0x00,0x78,0x88,0x78,0x08,0x08),
        'r': (0x00,0x00,0xB0,0xC8,0x80,0x80,0x80),
        's': (0x00,0x00,0x78,0x80,0x70,0x08,0xF0),
        't': (0x40,0x40,0xE0,0x40,0x40,0x48,0x30),
        'u': (0x00,0x00,0x88,0x88,0x88,0x98,0x68),
        'v': (0x00,0x00,0x88,0x88,0x88,0x50,0x20),
        'w': (0x00,0x00,0x88,0x88,0xA8,0xA8,0x50),
        'x': (0x00,0x00,0x88,0x50,0x20,0x50,0x88),
        'y': (0x00,0x00,0x88,0x88,0x78,0x08,0x70),
        'z': (0x00,0x00,0xF8,0x10,0x20,0x40,0xF8),
        '{': (0x10,0x20,0x20,0x40,0x20,0x20,0x10),
        '|': (0x20,0x20,0x20,0x20,0x20,0x20,0x20),
        '}': (0x40,0x20,0x20,0x10,0x20,0x20,0x40),
        '~': (0x00,0x00,0x48,0xA8,0x90,0x00,0x00),
    }
    # fmt: on
    for ch, rows in _raw.items():
        # glBitmap expects bottom row first, MSB on the left, byte-aligned
        _FONT_DATA[ord(ch)] = bytes(reversed(rows))

_def_glyphs()


class AssetPickerDialog(QDialog):
    """
    A full-featured asset browser dialog for loading/comparing vault assets.
    Left: hierarchy tree. Center: scrollable asset table. Right: role filters.
    """

    def __init__(self, parent, data, mode="compare"):
        super(AssetPickerDialog, self).__init__(parent)
        self.setWindowTitle("Compare to ..." if mode == "compare" else "Switch to ...")
        self.setMinimumSize(960, 560)
        self.resize(1050, 620)
        self.setStyleSheet(DIALOG_STYLE)

        self._data = data
        self._mode = mode
        self._all_assets = []   # flat list of all assets from all roles
        self._role_checks = {}  # role_id -> QCheckBox
        self._selected_path = None
        self._current_asset_id = data.get("asset", {}).get("id")
        self._tree_filter = None  # cached tree filter state

        # Gather flat list of all assets
        for role in data.get("roles", []):
            for a in role.get("assets", []):
                a["_role_name"] = role.get("name", "Unassigned")
                a["_role_icon"] = role.get("icon", "")
                a["_role_id"] = role.get("id")
                self._all_assets.append(a)

        self._buildUI()
        self._populateTree()
        self._populateTable()

    # ── UI construction ──────────────────────────────────────────

    def _buildUI(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 10, 12, 10)
        layout.setSpacing(8)

        # ── Title bar ────────────────────────────────────────────
        top_bar = QHBoxLayout()
        title = QLabel("Compare to ..." if self._mode == "compare" else "Switch to ...")
        title.setObjectName("titleLabel")
        top_bar.addWidget(title)

        scope = self._data.get("scope", "none")
        scope_text = {"shot": "Showing: Same Shot", "sequence": "Showing: Same Sequence",
                      "project": "Showing: Same Project"}.get(scope, "")
        if scope_text:
            scope_lbl = QLabel(scope_text)
            scope_lbl.setObjectName("scopeLabel")
            top_bar.addStretch()
            top_bar.addWidget(scope_lbl)

        layout.addLayout(top_bar)

        # ── Splitter: tree | table | filters ─────────────────────
        splitter = QSplitter(Qt.Horizontal)

        # Left: tree
        self._tree = QTreeWidget()
        self._tree.setHeaderHidden(True)
        self._tree.setMinimumWidth(170)
        self._tree.setMaximumWidth(240)
        self._tree.itemClicked.connect(self._onTreeClick)
        splitter.addWidget(self._tree)

        # Center: table
        self._table = QTableWidget()
        self._table.setColumnCount(4)
        self._table.setHorizontalHeaderLabels(["Name", "Role", "Version", "Date"])
        self._table.horizontalHeader().setStretchLastSection(True)
        self._table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self._table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self._table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self._table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self._table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SingleSelection)
        self._table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self._table.verticalHeader().setVisible(False)
        self._table.setShowGrid(False)
        self._table.setAlternatingRowColors(False)
        self._table.setSortingEnabled(True)
        self._table.doubleClicked.connect(self._onDoubleClick)
        self._table.itemSelectionChanged.connect(self._onSelectionChanged)
        splitter.addWidget(self._table)

        # Right: filters
        filter_panel = QWidget()
        filter_layout = QVBoxLayout(filter_panel)
        filter_layout.setContentsMargins(4, 0, 4, 0)
        filter_panel.setMinimumWidth(140)
        filter_panel.setMaximumWidth(180)

        # Role filter group
        role_group = QGroupBox("Roles")
        role_box = QVBoxLayout(role_group)
        role_box.setContentsMargins(8, 8, 8, 8)
        role_box.setSpacing(3)

        # Collect unique roles from the data
        seen_roles = {}
        for a in self._all_assets:
            rid = a.get("_role_id") or 0
            if rid not in seen_roles:
                seen_roles[rid] = {
                    "name": a.get("_role_name", "Unassigned"),
                    "icon": a.get("_role_icon", "")
                }

        for rid, rinfo in sorted(seen_roles.items(), key=lambda x: x[1]["name"]):
            label = "%s %s" % (rinfo["icon"], rinfo["name"]) if rinfo["icon"] else rinfo["name"]
            cb = QCheckBox(label)
            cb.setChecked(True)
            cb.stateChanged.connect(self._applyFilters)
            self._role_checks[rid] = cb
            role_box.addWidget(cb)

        filter_layout.addWidget(role_group)
        filter_layout.addStretch()

        # Asset count label
        self._count_label = QLabel("")
        self._count_label.setObjectName("scopeLabel")
        filter_layout.addWidget(self._count_label)

        splitter.addWidget(filter_panel)

        # Set proportions
        splitter.setSizes([190, 600, 160])
        layout.addWidget(splitter, 1)

        # ── Button row ───────────────────────────────────────────
        btn_row = QHBoxLayout()
        btn_row.addStretch()

        self._load_btn = QPushButton("Load")
        self._load_btn.setObjectName("loadBtn")
        self._load_btn.setEnabled(False)
        self._load_btn.clicked.connect(self.accept)

        cancel_btn = QPushButton("Cancel")
        cancel_btn.clicked.connect(self.reject)

        btn_row.addWidget(self._load_btn)
        btn_row.addWidget(cancel_btn)
        layout.addLayout(btn_row)

    # ── Tree ─────────────────────────────────────────────────────

    def _populateTree(self):
        hierarchy = self._data.get("hierarchy")
        if not hierarchy:
            # Fallback: just show "All Assets" node
            item = QTreeWidgetItem(["All Assets"])
            item.setData(0, Qt.UserRole, {"level": "all"})
            self._tree.addTopLevelItem(item)
            self._tree.expandAll()
            return

        proj = hierarchy
        proj_item = QTreeWidgetItem([proj.get("code", proj.get("name", "Project"))])
        proj_item.setData(0, Qt.UserRole, {"level": "project", "id": proj["id"]})

        bold_font = QFont()
        bold_font.setBold(True)
        proj_item.setFont(0, bold_font)

        for seq in proj.get("sequences", []):
            seq_item = QTreeWidgetItem([seq.get("code", seq.get("name", ""))])
            seq_item.setData(0, Qt.UserRole, {"level": "sequence", "id": seq["id"], "name": seq.get("name", "")})
            for shot in seq.get("shots", []):
                shot_item = QTreeWidgetItem([shot.get("code", shot.get("name", ""))])
                shot_item.setData(0, Qt.UserRole, {"level": "shot", "id": shot["id"], "name": shot.get("name", "")})
                seq_item.addChild(shot_item)
            proj_item.addChild(seq_item)

        self._tree.addTopLevelItem(proj_item)
        self._tree.expandAll()

        # Pre-select project root so all assets show
        self._tree.setCurrentItem(proj_item)

    def _onTreeClick(self, item, col):
        """Filter table to the selected tree level."""
        self._applyFilters()

    # ── Table ────────────────────────────────────────────────────

    def _populateTable(self, assets=None):
        if assets is None:
            assets = self._all_assets

        self._table.setSortingEnabled(False)
        self._table.setRowCount(len(assets))

        current_brush = QBrush(QColor("#2ec4b640"))
        bold_font = QFont()
        bold_font.setBold(True)
        dim_brush = QBrush(QColor("#555"))
        current_row = -1

        for row, a in enumerate(assets):
            name = a.get("vault_name", "unknown")
            role = "%s %s" % (a.get("_role_icon", ""), a.get("_role_name", "")) if a.get("_role_icon") else a.get("_role_name", "")
            version = "v%03d" % a["version"] if a.get("version") else ""
            date_str = (a.get("created_at") or "")[:10]  # YYYY-MM-DD

            # Add shot/sequence context if wider scope
            scope = self._data.get("scope", "shot")
            if scope in ("sequence", "project") and a.get("shot_name"):
                name = "%s  (%s)" % (name, a["shot_name"])
            elif scope == "project" and a.get("seq_name"):
                name = "%s  (%s)" % (name, a["seq_name"])

            items = [
                QTableWidgetItem(name),
                QTableWidgetItem(role),
                QTableWidgetItem(version),
                QTableWidgetItem(date_str),
            ]

            # Store file_path in first column's user data
            items[0].setData(Qt.UserRole, a.get("file_path", ""))
            items[0].setData(Qt.UserRole + 1, a.get("id"))

            is_current = a.get("is_current", False)
            is_missing = not a.get("file_path") or not os.path.exists(a.get("file_path", ""))

            for ci, item in enumerate(items):
                if is_current:
                    item.setBackground(current_brush)
                    item.setFont(bold_font)
                if is_missing:
                    item.setForeground(dim_brush)
                self._table.setItem(row, ci, item)

            if is_current:
                current_row = row

        self._table.setSortingEnabled(True)
        self._count_label.setText("%d assets" % len(assets))

        # Scroll to current asset
        if current_row >= 0:
            self._table.scrollToItem(
                self._table.item(current_row, 0),
                QAbstractItemView.PositionAtCenter
            )

    def _applyFilters(self, _=None):
        """Re-filter table based on role checkboxes and tree selection."""
        # Role filter
        active_roles = set()
        for rid, cb in self._role_checks.items():
            if cb.isChecked():
                active_roles.add(rid)

        filtered = [a for a in self._all_assets if (a.get("_role_id") or 0) in active_roles]

        # Tree filter (if a specific node is selected below project root)
        tree_item = self._tree.currentItem()
        if tree_item:
            meta = tree_item.data(0, Qt.UserRole) or {}
            level = meta.get("level", "all")

            if level == "shot":
                shot_name = tree_item.text(0)
                filtered = [a for a in filtered if a.get("shot_name") == shot_name or
                           (not a.get("shot_name") and self._data.get("scope") == "shot")]
            elif level == "sequence":
                # Collect child shot names
                child_shots = set()
                for i in range(tree_item.childCount()):
                    child_shots.add(tree_item.child(i).text(0))
                if child_shots:
                    filtered = [a for a in filtered if a.get("shot_name") in child_shots or not a.get("shot_name")]
            # "project" or "all" level = show everything (no additional filter)

        self._populateTable(filtered)

    def _onSelectionChanged(self):
        rows = self._table.selectionModel().selectedRows()
        if rows:
            item = self._table.item(rows[0].row(), 0)
            fp = item.data(Qt.UserRole) if item else ""
            self._selected_path = fp
            self._load_btn.setEnabled(bool(fp) and os.path.exists(fp))
        else:
            self._selected_path = None
            self._load_btn.setEnabled(False)

    def _onDoubleClick(self, index):
        """Double-click a row = immediately load."""
        item = self._table.item(index.row(), 0)
        if item:
            fp = item.data(Qt.UserRole)
            if fp and os.path.exists(fp):
                self._selected_path = fp
                self.accept()

    def selectedPath(self):
        return self._selected_path


class MediaVaultMode(rv.rvtypes.MinorMode):
    """
    Adds a MediaVault menu to OpenRV's menu bar.
    - Compare to ... -> picker dialog to add a source for A/B compare
    - Switch to ...  -> picker dialog to replace the current source
    - Prev Version / Next Version -> cycle versions within the current role
    """

    def __init__(self):
        rv.rvtypes.MinorMode.__init__(self)

        # ── Overlay state ────────────────────────────────────────
        self._overlay_enabled  = False
        self._show_metadata    = True   # on by default when overlay enabled
        self._show_status      = True
        self._show_watermark   = False  # off by default (opt-in)
        self._overlay_meta     = None   # cached API response
        self._overlay_path     = None   # path the cache belongs to
        self._overlay_tick     = 0      # frame counter for lazy refresh

        # ── Compare / version cache ──────────────────────────────
        self._cached_data = None
        self._cached_path = None

        print("[MediaVault] Initialising mediavault-mode (overlay build)")

        # Fetch real roles from CAM at init (falls back to defaults if
        # the server isn't running yet).
        self._all_role_names = self._fetchAllRoleNames()
        print("[MediaVault] Roles for submenu: %s" % self._all_role_names)

        def _role_state(role_name):
            """Return a state callback that grays out *role_name* when
            it has no assets for the current shot.

            Eagerly fetches from the CAM API on first menu open so
            roles are grayed out correctly even before any Compare /
            Switch / Version action."""
            def _check(*args, **kwargs):
                # Populate cache on first access (fast localhost call,
                # _getRolesData caches by path so only the first
                # callback in the batch actually hits the network).
                if not self._cached_data:
                    try:
                        self._getRolesData()
                    except Exception:
                        pass
                if not self._cached_data:
                    return rvc.NeutralMenuState   # server unreachable
                for role in self._cached_data.get("roles", []):
                    if (role.get("name") or "").lower() == role_name.lower():
                        if role.get("assets"):
                            return rvc.NeutralMenuState
                return rvc.DisabledMenuState
            return _check

        def _role_items(mode):
            """Build submenu item list for a given mode (compare/switch)."""
            items = []
            for r in self._all_role_names:
                items.append(
                    (r,
                     lambda e, _m=mode, _r=r: self._loadRoleLatest(_m, _r),
                     None,
                     _role_state(r))
                )
            items.append(("_", None))
            items.append(
                ("Prev Version",
                 lambda e, _m=mode: self._stepVersion(1, _m), None, None))
            items.append(
                ("Next Version",
                 lambda e, _m=mode: self._stepVersion(-1, _m), None, None))
            items.append(("_", None))
            items.append(
                ("Browse All ...",
                 lambda e, _m=mode: self._showPickerDialog(_m), None, None)
            )
            return items

        self.init(
            "mediavault-mode",
            [
                ("key-down--alt--v", self._showCompareRoleMenu,
                 "Compare to ... role popup"),
                ("key-down--alt--shift--v", self._showSwitchRoleMenu,
                 "Switch to ... role popup"),
            ],
            None,
            [("MediaVault", [
                ("Compare to ...", _role_items("compare")),
                ("Switch to ...", _role_items("switch")),
                ("Browse All ...", self.showBrowseAll, "alt+b", None),
                ("_", None),
                ("Prev Version", self.prevVersion, "alt+Left", None),
                ("Next Version", self.nextVersion, "alt+Right", None),
                ("_", None),
                ("Set Status", [
                    ("WIP", lambda *args, **kwargs: self.setStatus("WIP"), None, None),
                    ("Review", lambda *args, **kwargs: self.setStatus("Review"), None, None),
                    ("Approved", lambda *args, **kwargs: self.setStatus("Approved"), "alt+a", None),
                    ("Final", lambda *args, **kwargs: self.setStatus("Final"), None, None),
                    ("_", None),
                    ("Reject", lambda *args, **kwargs: self.setStatus("Reject"), "alt+r", None),
                ]),
                ("_", None),
                ("Publish Frame", self.publishFrame, "alt+p", None),
                ("Add to Crate ...", self.addToCrateMenu, "alt+c", None),
                ("_", None),
                ("Toggle Overlay", self._toggleOverlay, "shift+o",
                 lambda *args, **kwargs: rvc.CheckedMenuState if self._overlay_enabled
                         else rvc.UncheckedMenuState),
                ("  Metadata Burn-in", self._toggleMetadata, None,
                 lambda *args, **kwargs: rvc.CheckedMenuState if self._show_metadata
                         else rvc.UncheckedMenuState),
                ("  Status Stamp", self._toggleStatus, None,
                 lambda *args, **kwargs: rvc.CheckedMenuState if self._show_status
                         else rvc.UncheckedMenuState),
                ("  Watermark", self._toggleWatermark, None,
                 lambda *args, **kwargs: rvc.CheckedMenuState if self._show_watermark
                         else rvc.UncheckedMenuState),
            ])]
        )

    # ── source path resolution ───────────────────────────────────

    def _writeDiagLog(self, lines, force=False):
        """Write diagnostic log to stdout and file.

        Only writes on failure (force=True) or when MV_DEBUG env var is set.
        This keeps the RV console clean during normal operation.
        """
        if not force and not os.environ.get("MV_DEBUG"):
            return
        for line in lines:
            print("[MV-DIAG] %s" % str(line))
        try:
            import datetime
            for log_path in ["C:/mediavault_rv_diag.log",
                             os.path.join(os.path.expanduser("~"),
                                          "mediavault_rv_diag.log")]:
                try:
                    with open(log_path, "a") as f:
                        f.write("\n=== %s ===\n"
                                % datetime.datetime.now().isoformat())
                        for line in lines:
                            f.write("  %s\n" % str(line))
                    break
                except Exception:
                    continue
        except Exception:
            pass

    def _getCurrentSourcePath(self):
        """Return the file path of the currently VIEWED source.

        When multiple clips are loaded (sequence or stack), this must
        return the clip the user is currently viewing, not the first
        source.  Diagnostic output is written to a temp-file log so
        failures can be debugged without relying on RV console capture.

        Strategy order:
          1. viewNode — if viewNode is an RVSourceGroup (user pressed
             PageUp/Down), read its media directly.  For RVStackGroup
             use the active layer.  Skip RVSequenceGroup.
          2. sourcesAtFrame + .media.movie property — the proven pattern
             used by OpenRV's own built-in plugins.  Read the source's
             .media.movie property, then use nodeRangeInfo to determine
             if we need frame-to-file mapping.
          3. Fallback — walk rvc.sources() and read .media.movie.
        """
        LOG = []
        try:
            frame = rvc.frame()
            try:
                fs = rvc.frameStart()
                fe = rvc.frameEnd()
            except Exception:
                fs = fe = frame
            LOG.append("frame=%d  range=[%d,%d]" % (frame, fs, fe))

            # --- Strategy 1: viewNode IS a source group (PageUp/Down) ---
            try:
                vn = rvc.viewNode()
                if vn:
                    vn_type = rvc.nodeType(vn)
                    LOG.append("viewNode=%s type=%s" % (vn, vn_type))

                    if vn_type == "RVSourceGroup":
                        path = self._pathFromSourceGroup(vn, frame)
                        if path:
                            LOG.append("Strategy1 (RVSourceGroup): %s" % path)
                            self._writeDiagLog(LOG)
                            return path

                    if vn_type == "RVStackGroup":
                        try:
                            for node in rvc.nodesInGroup(vn):
                                if rvc.nodeType(node) == "RVStack":
                                    idx = rvc.getIntProperty(
                                        node + ".output.active")[0]
                                    sgs = [sg for sg in rvc.nodesOfType(
                                        "RVSourceGroup")]
                                    if 0 <= idx < len(sgs):
                                        path = self._pathFromSourceGroup(
                                            sgs[idx])
                                        if path:
                                            LOG.append("Strategy1 (Stack active=%d): %s" % (idx, path))
                                            self._writeDiagLog(LOG)
                                            return path
                        except Exception:
                            pass
            except Exception as e:
                LOG.append("Strategy1 error: %s" % e)

            # --- Strategy 2: sourcesAtFrame + .media.movie property ---
            # This mirrors the pattern used by OpenRV's own
            # collapse_missing_frames.py plugin which is known to work.
            try:
                saf = rvc.sourcesAtFrame(frame)
                LOG.append("sourcesAtFrame(%d) = %s" % (frame, saf))
                if saf:
                    source = saf[-1]
                    if isinstance(source, (list, tuple)):
                        source = source[0]

                    # Read .media.movie directly (same pattern as OpenRV
                    # collapse_missing_frames.py line 46)
                    media_path = self._readMediaMovie(source, LOG)

                    if media_path:
                        result = self._resolveMediaPath(
                            media_path, source, frame, fs, fe, LOG)
                        if result:
                            self._writeDiagLog(LOG)
                            return result
            except Exception as e:
                LOG.append("Strategy2 error: %s" % e)

            # --- Strategy 3: Fallback — walk all sources ---
            try:
                all_srcs = rvc.sources()
                LOG.append("sources() = %s" % (all_srcs,))
                if all_srcs:
                    for s in all_srcs:
                        name = s[0] if isinstance(s, (list, tuple)) else s
                        media_path = self._readMediaMovie(name, LOG)
                        if media_path:
                            result = self._resolveMediaPath(
                                media_path, name, frame, fs, fe, LOG)
                            if result:
                                LOG.append("Strategy3: %s" % result)
                                self._writeDiagLog(LOG)
                                return result
            except Exception as e:
                LOG.append("Strategy3 error: %s" % e)

            LOG.append("*** ALL STRATEGIES FAILED ***")
            self._writeDiagLog(LOG, force=True)
            return None
        except Exception as e:
            LOG.append("FATAL: %s" % e)
            import traceback
            LOG.append(traceback.format_exc())
            self._writeDiagLog(LOG, force=True)
            return None

    @staticmethod
    def _readMediaMovie(source_node, LOG):
        """Read the .media.movie property from a source node.

        Tries several approaches since the node may be an RVFileSource
        (has .media.movie directly) or a group name that requires
        walking inner nodes.
        """
        # Approach A: direct property read (works for RVFileSource nodes
        # returned by sourcesAtFrame — proven pattern from OpenRV source)
        try:
            mp = rvc.getStringProperty(source_node + ".media.movie")
            if mp and mp[0]:
                LOG.append("  readMedia(%s) direct: %s" % (source_node, mp[0]))
                return mp[0]
        except Exception:
            pass

        # Approach B: sourceMedia() accessor
        try:
            mp = rvc.sourceMedia(source_node)
            if mp and mp[0]:
                LOG.append("  readMedia(%s) sourceMedia: %s" % (source_node, mp[0]))
                return mp[0]
        except Exception:
            pass

        # Approach C: walk inner nodes of the group
        try:
            group = source_node
            try:
                group = rvc.nodeGroup(source_node)
            except Exception:
                pass
            for n in rvc.nodesInGroup(group):
                try:
                    mp = rvc.getStringProperty(n + ".media.movie")
                    if mp and mp[0]:
                        LOG.append("  readMedia(%s->%s) inner: %s"
                                   % (source_node, n, mp[0]))
                        return mp[0]
                except Exception:
                    pass
        except Exception:
            pass

        LOG.append("  readMedia(%s): NOT FOUND" % source_node)
        return None

    def _resolveMediaPath(self, media_path, source_node, frame, fs, fe, LOG):
        """Resolve a .media.movie path to the actual file for the current frame.

        Handles three cases:
          A. Sequence notation  (e.g. prefix_v025-62@@@.png)
          B. Plain file from a SINGLE-frame source → return directly
          C. Plain file from a MULTI-frame source → map frame to sibling
        """
        LOG.append("  resolve: media='%s' frame=%d" % (media_path, frame))

        # --- Case A: RV sequence notation (@@@ or ###) ---
        seq_m = re.search(r'(\d+)-(\d+)(@+|#+)(\.[\w]+)$', media_path)
        if seq_m:
            resolved = self._resolveSequenceNotation(
                media_path, seq_m, frame, source_node, fs, LOG)
            if resolved:
                return resolved

        # --- Determine if this is a multi-frame source ---
        src_start = src_end = frame
        try:
            ri = rvc.nodeRangeInfo(source_node)
            src_start = int(ri.get("start", frame))
            src_end = int(ri.get("end", frame))
        except Exception:
            # nodeRangeInfo may need the group name
            try:
                sg = rvc.nodeGroup(source_node)
                ri = rvc.nodeRangeInfo(sg)
                src_start = int(ri.get("start", frame))
                src_end = int(ri.get("end", frame))
            except Exception:
                pass
        is_multi = (src_end > src_start)
        LOG.append("  resolve: range=[%d,%d] multi=%s" % (src_start, src_end, is_multi))

        # --- Case B: Plain file, single-frame source → return directly ---
        if os.path.exists(media_path) and not is_multi:
            LOG.append("  resolve: DIRECT (single frame) %s" % media_path)
            return os.path.normpath(media_path)

        # --- Case C: Plain file, multi-frame source → map frame to sibling ---
        if os.path.exists(media_path) and is_multi:
            mapped = self._mapFrameToSibling(
                media_path, frame, src_start, src_end, LOG)
            if mapped:
                return mapped
            # If mapping failed, return as-is as last resort
            LOG.append("  resolve: MAP FAILED, returning first file as-is")
            return os.path.normpath(media_path)

        # --- File doesn't exist on disk (unrecognized notation?) ---
        LOG.append("  resolve: NOT ON DISK: %s" % media_path)
        return None

    @staticmethod
    def _resolveSequenceNotation(media_path, match, frame, source_node,
                                 global_start, LOG):
        """Resolve RV sequence notation like prefix_v025-62@@@.png to a
        specific file using frame range mapping.

        CRITICAL INSIGHT (from diagnostic 2026-02-26):
          nodeRangeInfo(source) returns FILE-NATIVE numbers (e.g. [46,62])
          NOT global playback frames (e.g. [1,17]).
          We must use the global frameStart() (passed as global_start)
          to compute the offset: file_num = file_start + (frame - global_start)
        """
        prefix = media_path[:match.start()]
        file_start = int(match.group(1))
        file_end = int(match.group(2))
        padding = len(match.group(3))
        ext = match.group(4)

        # Map global playback frame → file number
        # Global frame 1 → file_start, global frame 2 → file_start+1, etc.
        file_num = file_start + (frame - global_start)
        file_num = max(file_start, min(file_end, file_num))

        candidate = "%s%s%s" % (prefix, str(file_num).zfill(padding), ext)
        LOG.append("  SEQ: file_range=[%d,%d] global_start=%d frame=%d → file_num=%d"
                   % (file_start, file_end, global_start, frame, file_num))
        LOG.append("  SEQ: candidate=%s exists=%s"
                   % (candidate, os.path.exists(candidate)))

        if os.path.exists(candidate):
            return os.path.normpath(candidate)

        # Glob fallback
        import glob
        pattern = "%s%s%s" % (prefix, "?" * padding, ext)
        matches = sorted(glob.glob(pattern))
        if matches:
            LOG.append("  SEQ: glob fallback → %s" % matches[0])
            return os.path.normpath(matches[0])
        return None

    @staticmethod
    def _mapFrameToSibling(first_file, frame, src_start, src_end, LOG):
        """Map an RV frame number to the correct sibling file.

        When .media.movie returns a plain file path (e.g., v025.png)
        but the source spans multiple frames, we need to find which
        numbered sibling corresponds to the current frame.

        Uses two strategies:
          1. Offset mapping: base_num + (frame - src_start)
          2. Positional: index into sorted sibling list
        """
        dirname = os.path.dirname(first_file)
        basename = os.path.basename(first_file)

        # Find trailing number: "prefix_v025.png" → ("prefix_v", "025", ".png")
        m = re.search(r'(\d+)(\.[\w]+)$', basename)
        if not m:
            LOG.append("  MAP: no number pattern in '%s'" % basename)
            return None

        num_str = m.group(1)
        ext = m.group(2)
        prefix = basename[:m.start()]
        pad = len(num_str)
        base_num = int(num_str)

        # Strategy 1: offset mapping — base_num anchors to src_start
        file_num = base_num + (frame - src_start)
        candidate = os.path.join(
            dirname, "%s%s%s" % (prefix, str(file_num).zfill(pad), ext))
        LOG.append("  MAP: base=%d src_start=%d frame=%d → file=%d"
                   % (base_num, src_start, frame, file_num))

        if os.path.exists(candidate):
            LOG.append("  MAP: HIT %s" % candidate)
            return os.path.normpath(candidate)

        # Strategy 2: positional — glob siblings and index by position
        import glob
        pattern = os.path.join(dirname, prefix + "[0-9]" * pad + ext)
        siblings = sorted(glob.glob(pattern))
        LOG.append("  MAP: offset miss, glob found %d siblings" % len(siblings))

        if siblings:
            idx = frame - src_start
            if 0 <= idx < len(siblings):
                LOG.append("  MAP: positional idx=%d → %s"
                           % (idx, siblings[idx]))
                return os.path.normpath(siblings[idx])

        return None

    def _pathFromSourceGroup(self, sg, source_frame=None):
        """Extract file path from an RVSourceGroup node.

        Used by Strategy 1 (viewNode is an RVSourceGroup, e.g. after
        pressing PageUp/Down).  For multi-frame sources this still
        relies on the caller providing source_frame or falls back to
        returning the first file.
        """
        try:
            for n in rvc.nodesInGroup(sg):
                try:
                    prop = rvc.getStringProperty(n + ".media.movie", 0, 1)
                    if prop and prop[0]:
                        raw = prop[0]
                        if source_frame is not None:
                            seq_path = self._resolveRVSequencePath(
                                raw, source_frame=source_frame)
                            if seq_path:
                                return seq_path
                        if os.path.exists(raw):
                            return os.path.normpath(raw)
                        seq_path = self._resolveRVSequencePath(raw)
                        if seq_path:
                            return seq_path
                except Exception:
                    pass
        except Exception:
            pass
        return None

    @staticmethod
    def _resolveRVSequencePath(raw_path, source_frame=None):
        """Resolve RV sequence notation (@@@ or ###) to a file path.

        Kept as a utility for _pathFromSourceGroup and other callers.
        The main resolution path now goes through _resolveMediaPath.
        """
        m = re.search(r'(\d+)-(\d+)(@+|#+)(\.[\w]+)$', raw_path)
        if not m:
            return None
        prefix = raw_path[:m.start()]
        start_frame = int(m.group(1))
        end_frame = int(m.group(2))
        padding = len(m.group(3))
        ext = m.group(4)

        frames_to_try = []
        if source_frame is not None:
            frames_to_try.append(source_frame)
        try:
            gf = rvc.frame()
            if gf not in frames_to_try:
                frames_to_try.append(gf)
            off1 = start_frame + (gf - 1)
            if off1 not in frames_to_try:
                frames_to_try.append(off1)
        except Exception:
            pass
        if start_frame not in frames_to_try:
            frames_to_try.append(start_frame)

        for fr in frames_to_try:
            if fr < start_frame or fr > end_frame:
                continue
            candidate = "%s%s%s" % (prefix, str(fr).zfill(padding), ext)
            if os.path.exists(candidate):
                return os.path.normpath(candidate)

        import glob
        pattern = "%s%s%s" % (prefix, "?" * padding, ext)
        matches = glob.glob(pattern)
        if matches:
            return os.path.normpath(matches[0])
        return None

    # ── API ──────────────────────────────────────────────────────

    def _fetchShotRoles(self, filepath):
        """
        GET /api/assets/compare-targets-by-path?path=<filepath>
        Returns: {
            asset: { id, vault_name },
            scope: 'shot' | 'sequence' | 'project' | 'none',
            roles: [{ id, name, code, icon,
                       assets: [{ id, vault_name, version, file_ext, file_path,
                                  created_at, shot_name, seq_name, is_current }] }],
            allRoles: [...],
            hierarchy: { id, name, code, sequences: [...] }
        }
        Falls back: shot -> sequence -> project if no siblings at narrower scope.
        """
        if urllib is None:
            print("[MediaVault] urllib not available — cannot connect to server")
            return None
        try:
            encoded = urllib.parse.quote(filepath, safe="")
            url = "%s/api/assets/compare-targets-by-path?path=%s" % (DMV_URL, encoded)
            print("[MediaVault] Fetching: %s" % url)
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data
        except Exception as e:
            print("[MediaVault] _fetchShotRoles error: %s" % e)
            return {"error": str(e)}

    def _getRolesData(self, force_refresh=False):
        """Fetch roles for the current source, with simple caching."""
        filepath = self._getCurrentSourcePath()
        if not filepath:
            rve.displayFeedback("No source loaded \u2014 open a file first", 3.0)
            return None, None

        # Use cache if same path (unless forced)
        if not force_refresh and filepath == self._cached_path and self._cached_data:
            return self._cached_data, filepath

        data = self._fetchShotRoles(filepath)
        if not data or "error" in data:
            msg = data.get("error", "Could not connect") if data else "Could not connect to MediaVault (port 7700)"
            print("[MediaVault] Connection failed: %s (path: %s)" % (msg, filepath))
            rve.displayFeedback("MediaVault: %s" % msg, 4.0)
            return None, None

        self._cached_data = data
        self._cached_path = filepath
        return data, filepath

    # ── loading ──────────────────────────────────────────────────

    def _stripAutoAudio(self, source_group, intended_path):
        """Aggressively remove any auto-discovered audio from a source group.

        RV's source_setup scans nearby directories for audio and can add it
        as: (a) extra entries in .media.movie, (b) a .media.audio property,
        or (c) an entirely separate RVFileSource node.  We handle all three.
        """
        try:
            intended_norm = os.path.normpath(intended_path)
            nodes = rvc.nodesInGroup(source_group)

            for node in nodes:
                node_type = rvc.nodeType(node)

                # --- Handle RVFileSource nodes ---
                if node_type == "RVFileSource":
                    # (a) Clear .media.movie of anything that isn't our file
                    try:
                        media = rvc.getStringProperty(node + ".media.movie")
                        if media:
                            clean = [m for m in media
                                     if os.path.normpath(m) == intended_norm]
                            if not clean:
                                # This whole node is an audio-only addition —
                                # blank it out so RV can't play it
                                rvc.setStringProperty(
                                    node + ".media.movie", [""], True)
                                print("[MediaVault] Blanked auto-audio node: "
                                      "%s (%s)" % (node, media))
                            elif len(clean) < len(media):
                                rvc.setStringProperty(
                                    node + ".media.movie", clean, True)
                                print("[MediaVault] Stripped %d extra file(s) "
                                      "from %s" % (len(media) - len(clean), node))
                    except Exception:
                        pass

                    # (b) Clear .media.audio property
                    try:
                        audio = rvc.getStringProperty(node + ".media.audio")
                        if audio and any(a for a in audio if a):
                            rvc.setStringProperty(
                                node + ".media.audio", [""], True)
                            print("[MediaVault] Cleared .media.audio on %s: "
                                  "%s" % (node, audio))
                    except Exception:
                        pass

                # --- Handle RVSoundTrack nodes ---
                elif node_type == "RVSoundTrack":
                    try:
                        media = rvc.getStringProperty(node + ".media.movie")
                        if media and any(m for m in media if m):
                            rvc.setStringProperty(
                                node + ".media.movie", [""], True)
                            print("[MediaVault] Cleared soundtrack: "
                                  "%s (%s)" % (node, media))
                    except Exception:
                        pass

                # --- Clear any node's request.audioFile ---
                try:
                    af = rvc.getStringProperty(node + ".request.audioFile")
                    if af and any(a for a in af if a):
                        rvc.setStringProperty(
                            node + ".request.audioFile", [""], True)
                        print("[MediaVault] Cleared request.audioFile on "
                              "%s" % node)
                except Exception:
                    pass

        except Exception as e:
            print("[MediaVault] _stripAutoAudio error: %s" % e)

    def _loadAsCompare(self, filepath):
        """Add filepath as a new source for A/B sequence comparison."""
        if not os.path.exists(filepath):
            rve.displayFeedback("File not found: %s" % os.path.basename(filepath), 4.0)
            return
        try:
            # Track existing source groups so we can find the new one
            before = set(rvc.nodesOfType("RVSourceGroup"))

            rvc.addSourceVerbose([filepath])

            # Strip any auto-discovered audio from the newly created source
            after = set(rvc.nodesOfType("RVSourceGroup"))
            for sg in (after - before):
                self._stripAutoAudio(sg, filepath)

            rvc.setViewNode("defaultSequence")
            rve.displayFeedback(
                "Compare: %s" % os.path.basename(filepath), 3.0
            )
        except Exception as e:
            print("[MediaVault] _loadAsCompare error: %s" % e)
            rve.displayFeedback("Error: %s" % e, 5.0)

    def _switchTo(self, filepath):
        """Replace the current source with filepath."""
        if not os.path.exists(filepath):
            rve.displayFeedback("File not found: %s" % os.path.basename(filepath), 4.0)
            return
        try:
            # Find the RVFileSource node inside the first source group
            sourceGroups = rvc.nodesOfType("RVSourceGroup")
            if not sourceGroups:
                rve.displayFeedback("No source to replace", 3.0)
                return
            file_source = None
            for node in rvc.nodesInGroup(sourceGroups[0]):
                if rvc.nodeType(node) == "RVFileSource":
                    file_source = node
                    break
            if not file_source:
                rve.displayFeedback("No file source node found", 3.0)
                return
            rvc.setSourceMedia(file_source, [filepath])

            # Strip auto-audio from ALL source groups
            for sg in rvc.nodesOfType("RVSourceGroup"):
                self._stripAutoAudio(sg, filepath)

            # Invalidate cache since we changed the source
            self._cached_data = None
            self._cached_path = None
            rve.displayFeedback(
                "Switched to: %s" % os.path.basename(filepath), 3.0
            )
        except Exception as e:
            print("[MediaVault] _switchTo error: %s" % e)
            rve.displayFeedback("Error: %s" % e, 5.0)

    def setStatus(self, status):
        """Update the status of the currently viewed asset."""
        filepath = self._getCurrentSourcePath()
        if not filepath:
            rve.displayFeedback("No source loaded", 3.0)
            return

        basename = os.path.basename(filepath)
        print("[MediaVault] setStatus('%s') on: %s" % (status, basename))

        # We need the asset ID to update status. We can get it from overlay-info or compare-targets
        # Let's fetch overlay-info to get the asset ID
        if not urllib:
            rve.displayFeedback("urllib not available", 4.0)
            return

        try:
            url = "%s/api/assets/overlay-info?path=%s" % (DMV_URL, urllib.parse.quote(filepath))
            req = urllib.request.Request(url)
            req.add_header("X-CAM-User", "rv-plugin")
            with urllib.request.urlopen(req, timeout=2.0) as response:
                data = json.loads(response.read().decode("utf-8"))
                
            if not data or "asset_id" not in data:
                rve.displayFeedback("Asset not found in MediaVault", 4.0)
                return
                
            asset_id = data["asset_id"]
            
            # Now send the PUT request to update status
            put_url = "%s/api/assets/%s/status" % (DMV_URL, asset_id)
            put_data = json.dumps({"status": status}).encode("utf-8")
            put_req = urllib.request.Request(put_url, data=put_data, method="PUT")
            put_req.add_header("Content-Type", "application/json")
            put_req.add_header("X-CAM-User", "rv-plugin")
            
            with urllib.request.urlopen(put_req, timeout=2.0) as put_response:
                put_result = json.loads(put_response.read().decode("utf-8"))
                
            if put_result.get("success"):
                rve.displayFeedback("%s -> %s" % (basename, status), 3.0)
                # Force overlay refresh
                self._overlay_meta = None
                self._overlay_tick = 0
            else:
                rve.displayFeedback("Failed to set status", 4.0)
                
        except Exception as e:
            print("[MediaVault] setStatus error: %s" % e)
            rve.displayFeedback("Error setting status", 4.0)

    # ── picker dialog ────────────────────────────────────────────

    def _showPickerDialog(self, mode):
        """
        Open the asset picker dialog.
        mode: 'compare' or 'switch'
        """
        if not HAS_QT:
            rve.displayFeedback("Qt not available for dialog", 4.0)
            return

        data, filepath = self._getRolesData(force_refresh=True)
        if not data:
            return

        roles = data.get("roles", [])
        if not roles:
            rve.displayFeedback("No other assets found in this project", 3.0)
            return

        try:
            import rv.qtutils
            parent = rv.qtutils.sessionWindow()
        except Exception:
            parent = None

        dlg = AssetPickerDialog(parent, data, mode=mode)
        result = dlg.exec_()

        if result == QDialog.Accepted:
            path = dlg.selectedPath()
            if path:
                if mode == "compare":
                    self._loadAsCompare(path)
                else:
                    self._switchTo(path)

    # ── version stepping ─────────────────────────────────────────

    def _fetchAllRoleNames(self):
        """Fetch every role name from CAM (GET /api/roles).

        Used at init to build the submenu items.  Falls back to the
        default seeded roles if the server is unreachable."""
        _DEFAULTS = ["Comp", "Light", "Anim", "FX",
                     "Enviro", "Layout", "Matchmove", "Roto"]
        try:
            url = DMV_URL + "/api/roles"
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            resp = urllib.request.urlopen(req, timeout=3)
            data = json.loads(resp.read().decode("utf-8"))
            if isinstance(data, list) and data:
                names = [r.get("name") for r in data if r.get("name")]
                return sorted(names, key=str.lower) if names else _DEFAULTS
        except Exception as e:
            print("[MediaVault] Could not fetch roles from CAM: %s (using defaults)" % e)
        return _DEFAULTS

    def _loadRoleLatest(self, mode, role_name):
        """Load the latest version of *role_name* for compare or switch.

        Prefers assets whose file extension matches the currently loaded
        source (e.g. if you have a .mov open, pick the .mov from the
        target role rather than a .png).  Falls back to any available
        asset if no same-type match exists on disk.
        """
        data, filepath = self._getRolesData()
        if not data:
            return

        # Determine the extension of the currently loaded source
        current_ext = ""
        if filepath:
            _, current_ext = os.path.splitext(filepath)
            current_ext = current_ext.lower()          # e.g. ".mov"

        for role in data.get("roles", []):
            if (role.get("name") or "").lower() == role_name.lower():
                assets = role.get("assets", [])
                if not assets:
                    rve.displayFeedback("No files for %s" % role_name, 2.0)
                    return
                sorted_assets = sorted(
                    assets,
                    key=lambda a: self._extract_version(a.get("vault_name", "")),
                    reverse=True
                )

                # 1) Try same media type first (highest version that exists)
                if current_ext:
                    for a in sorted_assets:
                        fp = a.get("file_path", "")
                        a_ext = (a.get("file_ext") or os.path.splitext(fp)[1]).lower()
                        # Normalise: DB stores ".mov" or "mov" — handle both
                        if not a_ext.startswith("."):
                            a_ext = "." + a_ext
                        if a_ext == current_ext and fp and os.path.exists(fp):
                            if mode == "compare":
                                self._loadAsCompare(fp)
                            else:
                                self._switchTo(fp)
                            return

                # 2) Fallback — any asset that exists on disk
                for a in sorted_assets:
                    fp = a.get("file_path", "")
                    if fp and os.path.exists(fp):
                        if mode == "compare":
                            self._loadAsCompare(fp)
                        else:
                            self._switchTo(fp)
                        return
                rve.displayFeedback("Files for %s not on disk" % role_name, 3.0)
                return

        rve.displayFeedback("Role '%s' not found for this shot" % role_name, 2.0)

    @staticmethod
    def _extract_version(vault_name):
        """Extract numeric version from vault_name.

        Patterns matched:
          SH010_comfyui_v205.mp4  → 205
          PROJ_video_0247_v003.mp4 → 3
          my_file_v12.exr          → 12
        Falls back to 0 if no _vNNN pattern found.
        """
        import re
        m = re.search(r'_v(\d+)', vault_name or '')
        return int(m.group(1)) if m else 0

    def _stepVersion(self, direction, mode="switch"):
        """
        Move to the previous or next version within the same role.
        direction: -1 = prev, +1 = next
        mode: "switch" (replace current) or "compare" (A/B wipe)
        Sorts assets by version extracted from the filename (vault_name)
        to handle cases where the DB version column is unreliable.
        """
        data, filepath = self._getRolesData()
        if not data or not filepath:
            return

        current_id = data.get("asset", {}).get("id")
        current_name = data.get("asset", {}).get("vault_name", "")

        # Search all roles for the current asset (now included with is_current flag)
        for role in data.get("roles", []):
            raw_assets = role.get("assets", [])
            # Sort by version extracted from filename (DESC) — DB version
            # column can be unreliable (all '1') for convention-named files
            assets = sorted(
                raw_assets,
                key=lambda a: self._extract_version(a.get("vault_name", "")),
                reverse=True
            )
            for i, a in enumerate(assets):
                is_match = (
                    a.get("is_current", False)
                    or a.get("id") == current_id
                    or a.get("vault_name") == current_name
                    or os.path.normpath(a.get("file_path", "")) == filepath
                )
                if is_match:
                    # Assets are sorted version DESC, so:
                    #   direction +1 (next) = move toward higher version = lower index
                    #   direction -1 (prev) = move toward lower version = higher index
                    new_idx = i - direction
                    if 0 <= new_idx < len(assets):
                        new_path = assets[new_idx].get("file_path", "")
                        if new_path and os.path.exists(new_path):
                            if mode == "compare":
                                self._loadAsCompare(new_path)
                            else:
                                self._switchTo(new_path)
                            return
                    label = "previous" if direction < 0 else "next"
                    rve.displayFeedback("No %s version available" % label, 2.0)
                    return

        rve.displayFeedback("Current file not found in vault roles", 3.0)

    # ── menu handlers ────────────────────────────────────────────

    def _showRoleMenu(self, mode):
        """Pop up a Qt context menu listing roles from the API.

        Each role entry loads the LATEST version for that role.
        'Browse All...' at the bottom opens the full picker dialog.
        mode: 'compare' or 'switch'
        """
        if not HAS_QT:
            # Fallback to dialog if Qt unavailable
            self._showPickerDialog(mode)
            return

        data, filepath = self._getRolesData(force_refresh=True)
        if not data:
            return
        roles = data.get("roles", [])
        if not roles:
            rve.displayFeedback("No related assets found", 3.0)
            return

        # Find current asset's role so we can highlight it
        current_role_id = None
        for role in roles:
            for a in role.get("assets", []):
                if a.get("is_current"):
                    current_role_id = role.get("id")
                    break
            if current_role_id is not None:
                break

        try:
            menu = QMenu()
            menu.setStyleSheet("""
                QMenu {
                    background: #2a2a30;
                    color: #d4d4d8;
                    border: 1px solid #555;
                    font-family: "Segoe UI", Arial, sans-serif;
                    font-size: 13px;
                    padding: 4px 0;
                }
                QMenu::item {
                    padding: 6px 28px 6px 12px;
                }
                QMenu::item:selected {
                    background: #2ec4b6;
                    color: #111;
                }
                QMenu::separator {
                    height: 1px;
                    background: #444;
                    margin: 4px 8px;
                }
            """)

            # Sort roles by name, skip the current role's entry
            sorted_roles = sorted(roles, key=lambda r: (r.get("name") or "").lower())
            for role in sorted_roles:
                role_name = role.get("name", "Unassigned")
                role_id = role.get("id")
                assets = role.get("assets", [])

                # Sort this role's assets by extracted version (DESC)
                # so [0] is the latest version
                sorted_assets = sorted(
                    assets,
                    key=lambda a: self._extract_version(a.get("vault_name", "")),
                    reverse=True
                )

                # Skip role if it only contains the current file for 'switch'
                if role_id == current_role_id and mode == "switch":
                    non_current = [a for a in sorted_assets if not a.get("is_current")]
                    if not non_current:
                        continue  # nothing else in this role to switch to

                # Pick the latest asset that isn't the current file
                target = None
                for a in sorted_assets:
                    if not a.get("is_current"):
                        fp = a.get("file_path", "")
                        if fp and os.path.exists(fp):
                            target = a
                            break
                # If every asset is 'current' (single-version role in compare)
                # use the first asset anyway for compare mode
                if not target and mode == "compare" and sorted_assets:
                    fp = sorted_assets[0].get("file_path", "")
                    if fp and os.path.exists(fp):
                        target = sorted_assets[0]

                if not target:
                    continue

                # Build label: role name + version count hint
                count = len(sorted_assets)
                label = role_name
                if count > 1:
                    label += "  (%d versions)" % count

                # Bold the current role
                action = menu.addAction(label)
                if role_id == current_role_id:
                    font = action.font()
                    font.setBold(True)
                    action.setFont(font)

                # Store file path on the action for retrieval
                action.setData(target.get("file_path", ""))

            if menu.isEmpty():
                rve.displayFeedback("No roles with available files", 3.0)
                return

            menu.addSeparator()
            browse_action = menu.addAction("Browse All ...")
            browse_action.setData("__browse__")

            # Show at cursor
            chosen = menu.exec_(QCursor.pos())
            if chosen:
                path = chosen.data()
                if path == "__browse__":
                    self._showPickerDialog(mode)
                elif path:
                    if mode == "compare":
                        self._loadAsCompare(path)
                    else:
                        self._switchTo(path)

        except Exception as e:
            print("[MediaVault] _showRoleMenu error: %s" % e)
            # Fallback
            self._showPickerDialog(mode)

    def _showCompareRoleMenu(self, event):
        """MediaVault -> Compare to ... (role submenu)"""
        self._showRoleMenu("compare")

    def _showSwitchRoleMenu(self, event):
        """MediaVault -> Switch to ... (role submenu)"""
        self._showRoleMenu("switch")

    def showCompareMenu(self, event):
        """Legacy: full picker dialog for Compare."""
        self._showPickerDialog("compare")

    def showSwitchMenu(self, event):
        """Legacy: full picker dialog for Switch."""
        self._showPickerDialog("switch")

    def showBrowseAll(self, event):
        """MediaVault -> Browse All ... — full picker dialog (switch mode)."""
        self._showPickerDialog("switch")

    # ── publish frame ─────────────────────────────────────────

    def publishFrame(self, event):
        """MediaVault -> Publish Frame — save current frame as a Ref asset.
        Exports the composited displayed frame (including annotations and
        paint-overs) via exportCurrentFrame, then sends the rendered file
        to the CAM server for vault import.
        """
        if urllib is None:
            rve.displayFeedback("urllib not available", 4.0)
            return

        filepath = self._getCurrentSourcePath()
        if not filepath:
            rve.displayFeedback("No source loaded", 3.0)
            return

        frame = rvc.frame()
        rve.displayFeedback("Publishing frame %d ..." % frame, 2.0)

        renderedPath = None
        tempDir = None
        try:
            # Export the currently displayed frame (with annotations/paint-overs/
            # LUTs baked in) to a temp PNG so CAM imports what the user sees.
            tempDir = tempfile.mkdtemp(prefix="cam_rv_publish_")
            renderedPath = os.path.join(
                tempDir, "frame_%04d.png" % frame
            )
            try:
                rvc.exportCurrentFrame(renderedPath)
                # Validate the file was actually written
                if (not os.path.exists(renderedPath)
                        or os.path.getsize(renderedPath) < 100):
                    print("[MediaVault] exportCurrentFrame produced no/tiny file")
                    renderedPath = None
            except Exception as e:
                print("[MediaVault] exportCurrentFrame failed: %s" % e)
                renderedPath = None

            payload_data = {
                "sourcePath": filepath,
                "frameNumber": frame,
            }
            # If we got a rendered frame, tell CAM to use that file directly
            if renderedPath:
                payload_data["renderedFramePath"] = renderedPath

            payload = json.dumps(payload_data).encode("utf-8")

            url = "%s/api/assets/publish-frame" % DMV_URL
            req = urllib.request.Request(
                url, data=payload,
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))

            if result.get("success"):
                names = [a.get("vault_name", "?") for a in result.get("assets", [])]
                rve.displayFeedback(
                    "Published: %s" % ", ".join(names), 5.0
                )
            else:
                rve.displayFeedback(
                    "Publish failed: %s" % result.get("error", "Unknown"), 5.0
                )
        except Exception as e:
            print("[MediaVault] publishFrame error: %s" % e)
            rve.displayFeedback("Publish error: %s" % e, 5.0)
        finally:
            # Clean up temp directory
            if tempDir:
                try:
                    import shutil
                    shutil.rmtree(tempDir, ignore_errors=True)
                except Exception:
                    pass

    # ── add to crate ──────────────────────────────────────────

    def addToCrateMenu(self, event):
        """MediaVault -> Add to Crate ... — add current clip to a crate."""
        if urllib is None:
            rve.displayFeedback("urllib not available", 4.0)
            return

        filepath = self._getCurrentSourcePath()
        if not filepath:
            rve.displayFeedback("No source loaded", 3.0)
            return

        # Fetch available crates
        try:
            url = "%s/api/crates" % DMV_URL
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                crates = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print("[MediaVault] Failed to fetch crates: %s" % e)
            rve.displayFeedback("Cannot connect to MediaVault: %s" % e, 4.0)
            return

        if not crates:
            rve.displayFeedback("No crates found \u2014 create one in the browser first", 4.0)
            return

        # Show crate picker dialog
        crateId = self._showCratePickerDialog(crates)
        if crateId is None:
            return  # User cancelled

        # Add to crate via API
        try:
            _diag_frame = rvc.frame()
        except Exception:
            _diag_frame = '?'
        print("[MediaVault] addToCrate: frame=%s  path='%s'  crate=%s"
              % (_diag_frame, filepath, crateId))
        try:
            payload = json.dumps({"filePath": filepath}).encode("utf-8")
            url = "%s/api/crates/%s/add-by-path" % (DMV_URL, crateId)
            req = urllib.request.Request(
                url, data=payload,
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))

            print("[MediaVault] addToCrate response: %s" % result)
            if result.get("ok"):
                rve.displayFeedback(
                    "Added \"%s\" to crate \"%s\"" % (
                        result.get("vaultName", os.path.basename(filepath)),
                        result.get("crateName", "?")),
                    4.0
                )
            elif result.get("error"):
                rve.displayFeedback(
                    "Failed: %s" % result.get("error", "Unknown"), 4.0
                )
            else:
                rve.displayFeedback(
                    "Failed: %s" % result.get("error", "Unknown"), 4.0
                )
        except Exception as e:
            print("[MediaVault] addToCrate error: %s" % e)
            rve.displayFeedback("Add to crate error: %s" % e, 4.0)

    def _showCratePickerDialog(self, crates):
        """Show a simple Qt dialog listing available crates. Returns crate ID or None."""
        if not HAS_QT:
            # No Qt available — fall back to first crate
            print("[MediaVault] No Qt — using first crate: %s" % crates[0].get("name"))
            rve.displayFeedback("Using crate: %s (no Qt for picker)" % crates[0].get("name"), 2.0)
            return crates[0].get("id")

        try:
            dialog = QDialog()
            dialog.setWindowTitle("Add to Crate")
            dialog.setMinimumSize(320, 200)
            dialog.setStyleSheet("""
                QDialog { background: #1e1e1e; color: #e0e0e0; }
                QListWidget { background: #2a2a2a; color: #e0e0e0;
                              border: 1px solid #444; font-size: 13px;
                              selection-background-color: #2ec4b6;
                              selection-color: #000; }
                QListWidget::item { padding: 8px; }
                QLabel { color: #aaa; font-size: 12px; }
                QPushButton { background: #2ec4b6; color: #000;
                              border: none; padding: 8px 20px;
                              border-radius: 4px; font-weight: bold;
                              font-size: 13px; }
                QPushButton:hover { background: #26a89c; }
                QPushButton#cancelBtn { background: #444; color: #ccc; }
                QPushButton#cancelBtn:hover { background: #555; }
            """)

            layout = QVBoxLayout(dialog)
            layout.setContentsMargins(16, 16, 16, 16)
            layout.setSpacing(12)

            label = QLabel("Select a crate:")
            layout.addWidget(label)

            listWidget = QListWidget()
            for c in crates:
                count = c.get("item_count", 0)
                item_text = "%s  (%d item%s)" % (c["name"], count, "" if count == 1 else "s")
                item = QListWidgetItem(item_text)
                item.setData(256, c["id"])  # Qt.UserRole = 256
                listWidget.addItem(item)

            if listWidget.count() > 0:
                listWidget.setCurrentRow(0)
            layout.addWidget(listWidget)

            # Buttons
            btnLayout = QHBoxLayout()
            btnLayout.addStretch()
            cancelBtn = QPushButton("Cancel")
            cancelBtn.setObjectName("cancelBtn")
            cancelBtn.clicked.connect(dialog.reject)
            btnLayout.addWidget(cancelBtn)
            addBtn = QPushButton("Add to Crate")
            addBtn.clicked.connect(dialog.accept)
            btnLayout.addWidget(addBtn)
            layout.addLayout(btnLayout)

            # Double-click to accept
            listWidget.itemDoubleClicked.connect(lambda _: dialog.accept())

            result = dialog.exec_()

            if result == QDialog.Accepted:
                selected = listWidget.currentItem()
                if selected:
                    return selected.data(256)  # Qt.UserRole
            return None

        except Exception as e:
            print("[MediaVault] Crate picker dialog error: %s" % e)
            rve.displayFeedback("Crate picker error: %s" % e, 4.0)
            return None

    def prevVersion(self, event):
        """MediaVault -> Prev Version"""
        self._stepVersion(1)

    def nextVersion(self, event):
        """MediaVault -> Next Version"""
        self._stepVersion(-1)

    # ── overlay toggle handlers ──────────────────────────────────

    def _toggleOverlay(self, event):
        self._overlay_enabled = not self._overlay_enabled
        print("[MediaVault] Overlay toggled: %s  GL=%s" % (
            self._overlay_enabled, _HAS_GL))
        if self._overlay_enabled:
            self._refreshOverlayMeta()
        rve.displayFeedback(
            "Overlay: %s" % ("ON" if self._overlay_enabled else "OFF"), 2.0)

    def _toggleMetadata(self, event):
        self._show_metadata = not self._show_metadata
        if self._show_metadata and not self._overlay_enabled:
            self._overlay_enabled = True
            self._refreshOverlayMeta()
        rve.displayFeedback(
            "Metadata: %s" % ("ON" if self._show_metadata else "OFF"), 1.5)

    def _toggleStatus(self, event):
        self._show_status = not self._show_status
        if self._show_status and not self._overlay_enabled:
            self._overlay_enabled = True
            self._refreshOverlayMeta()
        rve.displayFeedback(
            "Status Stamp: %s" % ("ON" if self._show_status else "OFF"), 1.5)

    def _toggleWatermark(self, event):
        self._show_watermark = not self._show_watermark
        if self._show_watermark and not self._overlay_enabled:
            self._overlay_enabled = True
        rve.displayFeedback(
            "Watermark: %s" % ("ON" if self._show_watermark else "OFF"), 1.5)

    # ── overlay metadata fetch ───────────────────────────────────

    def _refreshOverlayMeta(self):
        """Fetch lightweight overlay metadata from CAM server."""
        filepath = self._getCurrentSourcePath()
        if not filepath:
            self._overlay_meta = None
            return

        # Already cached for this path
        if filepath == self._overlay_path and self._overlay_meta:
            return

        if urllib is None:
            self._overlay_meta = {"vault_name": os.path.basename(filepath)}
            self._overlay_path = filepath
            return

        try:
            encoded = urllib.parse.quote(filepath, safe="")
            url = "%s/api/assets/overlay-info?path=%s" % (DMV_URL, encoded)
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                self._overlay_meta = data if data.get("found") else {
                    "vault_name": os.path.basename(filepath)}
                self._overlay_path = filepath
        except Exception as e:
            print("[MediaVault] Overlay fetch error: %s" % e)
            self._overlay_meta = {"vault_name": os.path.basename(filepath)}
            self._overlay_path = filepath

    # ── overlay GL rendering ─────────────────────────────────────

    def render(self, event):
        """Called every frame by RV (auto-bound by MinorMode name convention).
        Draw overlay when enabled."""
        if not self._overlay_enabled or not _HAS_GL:
            return

        # One-time render confirmation
        if not hasattr(self, '_render_logged'):
            print("[MediaVault] render() called – drawing overlay (w=%s, h=%s)" %
                  (event.domain()[0], event.domain()[1]))
            self._render_logged = True

        try:
            domain = event.domain()
            w = int(domain[0])
            h = int(domain[1])
            if w < 100 or h < 100:
                return

            # Re-fetch metadata if source changed (check every 30 frames)
            self._overlay_tick += 1
            if self._overlay_tick % 30 == 1:
                cur = self._getCurrentSourcePath()
                if cur and cur != self._overlay_path:
                    self._refreshOverlayMeta()

            # ── Set up 2D ortho projection ──
            glMatrixMode(GL_PROJECTION)
            glPushMatrix()
            glLoadIdentity()
            gluOrtho2D(0, w, 0, h)
            glMatrixMode(GL_MODELVIEW)
            glPushMatrix()
            glLoadIdentity()

            glEnable(GL_BLEND)
            glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)

            if self._show_metadata:
                self._drawMetadataBurnIn(w, h)
            if self._show_status:
                self._drawStatusStamp(w, h)
            if self._show_watermark:
                self._drawWatermarkText(w, h)

            glDisable(GL_BLEND)
            glPopMatrix()
            glMatrixMode(GL_PROJECTION)
            glPopMatrix()
            glMatrixMode(GL_MODELVIEW)

        except Exception:
            pass  # never crash RV's render loop

    # ── GL drawing helpers ───────────────────────────────────────

    @staticmethod
    def _glText(x, y, text, scale=1):
        """Render *text* at pixel coords (x, y) using built-in glBitmap font.
        *scale* is ignored for bitmap fonts but kept for API compat."""
        if not _HAS_GL or not text:
            return
        try:
            glPixelStorei(GL_UNPACK_ALIGNMENT, 1)
            glRasterPos2f(float(x), float(y))
            for ch in text:
                code = ord(ch)
                glyph = _FONT_DATA.get(code)
                if glyph is None:
                    glyph = _FONT_DATA.get(ord(' '), b'\x00' * 7)
                glBitmap(8, 7, 0.0, 0.0, float(_GLYPH_W), 0.0, glyph)
        except Exception:
            pass

    @staticmethod
    def _textW(text, scale=1):
        """Text width in pixels for the built-in font."""
        if not text:
            return 0
        return len(text) * _GLYPH_W

    @staticmethod
    def _box(x, y, bw, bh, color):
        """Draw a filled rectangle."""
        glColor4f(*color)
        glBegin(GL_QUADS)
        glVertex2f(x, y)
        glVertex2f(x + bw, y)
        glVertex2f(x + bw, y + bh)
        glVertex2f(x, y + bh)
        glEnd()

    @staticmethod
    def _boxOutline(x, y, bw, bh, color, width=1.0):
        """Draw a rectangle outline."""
        glColor4f(*color)
        glLineWidth(width)
        glBegin(GL_LINE_LOOP)
        glVertex2f(x, y)
        glVertex2f(x + bw, y)
        glVertex2f(x + bw, y + bh)
        glVertex2f(x, y + bh)
        glEnd()

    # ── metadata burn-in (top-left) ──────────────────────────────

    def _drawMetadataBurnIn(self, w, h):
        meta = self._overlay_meta or {}

        # Shot name: prefer shot > sequence > project > filename > RV path
        shot = (meta.get("shot_name")
                or meta.get("sequence_name")
                or meta.get("project_name")
                or meta.get("vault_name")
                or meta.get("original_name"))
        if not shot:
            try:
                src = self._getCurrentSourcePath()
                shot = os.path.basename(src) if src else None
            except Exception:
                pass
        shot = shot or "Unknown"

        # Frame number – 4-digit zero-padded
        frame_str = "0001"
        try:
            frame_str = "%04d" % rvc.frame()
        except Exception:
            pass

        label = "%s  %s" % (shot, frame_str)

        padding = 8
        tw = self._textW(label)
        bw = tw + padding * 2 + 4
        bh = _GLYPH_H + padding * 2
        bx = w - bw - 10         # right-aligned
        by = 55                   # above RV's timeline/transport bar

        self._box(bx, by, bw, bh, _OV_BG)
        glColor4f(*_OV_TEXT)
        self._glText(bx + padding, by + padding, label)

    # ── status stamp (top-right) ─────────────────────────────────

    def _drawStatusStamp(self, w, h):
        meta = self._overlay_meta or {}
        status = meta.get("status", "WIP")
        color = _STATUS_COLORS.get(status, _STATUS_COLORS["WIP"])

        label = status.upper()
        tw = self._textW(label)

        pad = 12
        badge_w = tw + pad * 2
        badge_h = 24
        badge_x = w - badge_w - 15
        badge_y = h - badge_h - 15

        # Filled badge with thin outline
        self._box(badge_x, badge_y, badge_w, badge_h, color)
        self._boxOutline(badge_x, badge_y, badge_w, badge_h,
                         (0.0, 0.0, 0.0, 0.3), 1.5)

        # Dark text on bright badge
        glColor4f(0.0, 0.0, 0.0, 0.9)
        self._glText(badge_x + pad, badge_y + 9, label)

    # ── watermark (center) ───────────────────────────────────────

    def _drawWatermarkText(self, w, h):
        text = "C O N F I D E N T I A L"
        tw = self._textW(text)
        tx = (w - tw) // 2
        ty = h // 2

        glColor4f(*_OV_WM)
        self._glText(tx, ty, text)

        # second line for emphasis
        text2 = "INTERNAL USE ONLY"
        tw2 = self._textW(text2)
        tx2 = (w - tw2) // 2
        self._glText(tx2, ty - 20, text2)


def createMode():
    return MediaVaultMode()
