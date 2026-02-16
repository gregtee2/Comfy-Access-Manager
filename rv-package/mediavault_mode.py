# Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
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

try:
    import urllib.request
    import urllib.parse
except ImportError:
    urllib = None

try:
    from PySide2.QtWidgets import (
        QDialog, QVBoxLayout, QHBoxLayout, QTreeWidget, QTreeWidgetItem,
        QTableWidget, QTableWidgetItem, QHeaderView, QPushButton,
        QCheckBox, QLabel, QFrame, QAbstractItemView, QGroupBox,
        QSplitter, QWidget, QMenu, QAction, QApplication
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
            QSplitter, QWidget, QMenu, QApplication
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
        self.init(
            "mediavault-mode",
            None,
            None,
            [("MediaVault", [
                ("Compare to ...", self.showCompareMenu, "alt+v", None),
                ("Switch to ...", self.showSwitchMenu, "alt+shift+v", None),
                ("_", None),
                ("Prev Version", self.prevVersion, "alt+Left", None),
                ("Next Version", self.nextVersion, "alt+Right", None),
            ])]
        )
        self._cached_data = None
        self._cached_path = None

    # ── source path resolution ───────────────────────────────────

    def _getCurrentSourcePath(self):
        """Return the file path of the first/current source."""
        try:
            srcs = rvc.sources()
            if not srcs:
                return None

            source_name = srcs[0][0]

            if os.path.exists(source_name):
                return os.path.normpath(source_name)

            try:
                media = rvc.sourceMedia(source_name)
                if media and media[0] and os.path.exists(media[0]):
                    return os.path.normpath(media[0])
            except Exception:
                pass

            for sg in rvc.nodesOfType("RVSourceGroup"):
                try:
                    for n in rvc.nodesInGroup(sg):
                        try:
                            prop = rvc.getStringProperty(n + ".media.movie", 0, 1)
                            if prop and os.path.exists(prop[0]):
                                return os.path.normpath(prop[0])
                        except Exception:
                            pass
                except Exception:
                    pass

            return None
        except Exception as e:
            print("[MediaVault] _getCurrentSourcePath error: %s" % e)
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
        """Remove any media files RV auto-discovered (e.g. audio from nearby
        directories) that weren't explicitly loaded. RV's source_setup scans
        parent directories for audio files, which on a NAS can pull audio
        from unrelated projects."""
        try:
            intended_norm = os.path.normpath(intended_path)
            for node in rvc.nodesInGroup(source_group):
                try:
                    media = rvc.getStringProperty(node + ".media.movie")
                    if media and len(media) > 1:
                        clean = [m for m in media
                                 if os.path.normpath(m) == intended_norm]
                        if not clean:
                            clean = [media[0]]  # keep at least the primary
                        if len(clean) < len(media):
                            rvc.setStringProperty(
                                node + ".media.movie", clean, True)
                            removed = len(media) - len(clean)
                            print("[MediaVault] Stripped %d auto-loaded "
                                  "file(s) from %s" % (removed, node))
                except Exception:
                    pass  # not all nodes have media.movie
        except Exception as e:
            print("[MediaVault] _stripAutoAudio: %s" % e)

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
            srcs = rvc.sources()
            if not srcs:
                rve.displayFeedback("No source to replace", 3.0)
                return
            # Set only the intended file — no auto-audio
            rvc.setSourceMedia(srcs[0][0], [filepath])

            # Also strip from the source group node level in case
            # source_setup re-fires and adds audio
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

    def _stepVersion(self, direction):
        """
        Move to the previous or next version within the same role.
        direction: -1 = prev, +1 = next
        Uses the is_current flag returned by the API to find the current
        asset in the results, then steps to the adjacent version.
        """
        data, filepath = self._getRolesData()
        if not data or not filepath:
            return

        current_id = data.get("asset", {}).get("id")
        current_name = data.get("asset", {}).get("vault_name", "")

        # Search all roles for the current asset (now included with is_current flag)
        for role in data.get("roles", []):
            assets = role.get("assets", [])
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
                            self._switchTo(new_path)
                            return
                    label = "previous" if direction < 0 else "next"
                    rve.displayFeedback("No %s version available" % label, 2.0)
                    return

        rve.displayFeedback("Current file not found in vault roles", 3.0)

    # ── menu handlers ────────────────────────────────────────────

    def showCompareMenu(self, event):
        """MediaVault -> Compare to ..."""
        self._showPickerDialog("compare")

    def showSwitchMenu(self, event):
        """MediaVault -> Switch to ..."""
        self._showPickerDialog("switch")

    def prevVersion(self, event):
        """MediaVault -> Prev Version"""
        self._stepVersion(-1)

    def nextVersion(self, event):
        """MediaVault -> Next Version"""
        self._stepVersion(1)


def createMode():
    return MediaVaultMode()
