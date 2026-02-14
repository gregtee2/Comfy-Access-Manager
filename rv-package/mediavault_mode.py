#
# MediaVault Integration for OpenRV
# Adds "MediaVault" menu with Compare/Switch submenus
# Lists roles from the current shot — click a role to load its latest version
#
# Copyright 2026 Digital Media Vault — Apache-2.0
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
    from PySide2.QtWidgets import QMenu, QAction, QApplication
    from PySide2.QtGui import QCursor, QFont
    from PySide2.QtCore import Qt
    HAS_QT = True
except ImportError:
    try:
        from PySide6.QtWidgets import QMenu, QApplication
        from PySide6.QtGui import QCursor, QAction, QFont
        from PySide6.QtCore import Qt
        HAS_QT = True
    except ImportError:
        HAS_QT = False

DMV_URL = "http://localhost:7700"

MENU_STYLE = """
QMenu {
    background: #2a2a2a;
    color: #ccc;
    border: 1px solid #555;
    padding: 4px 0;
    font-size: 13px;
}
QMenu::item {
    padding: 5px 30px 5px 20px;
    min-width: 160px;
}
QMenu::item:selected {
    background: #446;
}
QMenu::item:disabled {
    color: #555;
}
QMenu::separator {
    height: 1px;
    background: #444;
    margin: 4px 8px;
}
"""


class MediaVaultMode(rv.rvtypes.MinorMode):
    """
    Adds a MediaVault menu to OpenRV's menu bar.
    - Compare to ... → submenu listing each role in the shot (latest version per role)
    - Switch to ...  → same but replaces the current source
    - Prev Version / Next Version → cycle versions within the current role
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
            roles: [{ id, name, code, icon,
                       assets: [{ id, vault_name, version, file_ext, file_path }] }]
        }
        """
        if urllib is None:
            return None
        try:
            encoded = urllib.parse.quote(filepath, safe="")
            url = "%s/api/assets/compare-targets-by-path?path=%s" % (DMV_URL, encoded)
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data
        except Exception as e:
            print("[MediaVault] _fetchShotRoles error: %s" % e)
            return None

    def _getRolesData(self):
        """Fetch roles for the current source, with simple caching."""
        filepath = self._getCurrentSourcePath()
        if not filepath:
            rve.displayFeedback("No source loaded — open a file first", 3.0)
            return None, None

        # Use cache if same path
        if filepath == self._cached_path and self._cached_data:
            return self._cached_data, filepath

        data = self._fetchShotRoles(filepath)
        if not data or "error" in data:
            msg = data.get("error", "Could not connect") if data else "Could not connect to MediaVault (port 7700)"
            rve.displayFeedback("MediaVault: %s" % msg, 4.0)
            return None, None

        self._cached_data = data
        self._cached_path = filepath
        return data, filepath

    # ── loading ──────────────────────────────────────────────────

    def _loadAsCompare(self, filepath):
        """Add filepath as a new source for A/B sequence comparison."""
        if not os.path.exists(filepath):
            rve.displayFeedback("File not found: %s" % os.path.basename(filepath), 4.0)
            return
        try:
            rvc.addSourceVerbose([filepath])
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
            rvc.setSourceMedia(srcs[0][0], [filepath])
            # Invalidate cache since we changed the source
            self._cached_data = None
            self._cached_path = None
            rve.displayFeedback(
                "Switched to: %s" % os.path.basename(filepath), 3.0
            )
        except Exception as e:
            print("[MediaVault] _switchTo error: %s" % e)
            rve.displayFeedback("Error: %s" % e, 5.0)

    # ── popup menu builder ───────────────────────────────────────

    def _buildRoleMenu(self, roles, action_fn, current_asset_name):
        """
        Build and show a QMenu listing each role.
        Bold = has assets (clickable). Gray = no assets in vault.
        Clicking a role calls action_fn(latest_file_path).
        """
        if not HAS_QT:
            rve.displayFeedback("Qt not available for popup menu", 4.0)
            return

        try:
            import rv.qtutils
            parent = rv.qtutils.sessionWindow()
        except Exception:
            parent = None

        menu = QMenu(parent)
        menu.setStyleSheet(MENU_STYLE)

        bold_font = QFont()
        bold_font.setBold(True)

        for role in roles:
            role_name = role.get("name", "Unassigned")
            role_icon = role.get("icon", "")
            assets = role.get("assets", [])

            label = "%s %s" % (role_icon, role_name) if role_icon else role_name

            if assets:
                # Find latest version with a valid file
                latest_path = None
                for a in assets:
                    p = a.get("file_path", "")
                    if p and os.path.exists(p):
                        latest_path = p
                        break

                if latest_path:
                    action = menu.addAction(label)
                    action.setFont(bold_font)
                    # Capture path in closure
                    action.triggered.connect(lambda checked=False, fp=latest_path: action_fn(fp))
                else:
                    # Has assets in DB but files missing on disk
                    action = menu.addAction(label)
                    action.setEnabled(False)
            else:
                action = menu.addAction(label)
                action.setEnabled(False)

        # Separator + version navigation
        menu.addSeparator()
        prev_action = menu.addAction("Prev Version")
        prev_action.triggered.connect(lambda: self._stepVersion(-1))
        next_action = menu.addAction("Next Version")
        next_action.triggered.connect(lambda: self._stepVersion(1))

        menu.exec_(QCursor.pos())

    # ── version stepping ─────────────────────────────────────────

    def _stepVersion(self, direction):
        """
        Move to the previous or next version within the same role.
        direction: -1 = prev, +1 = next
        """
        data, filepath = self._getRolesData()
        if not data or not filepath:
            return

        current_name = data.get("asset", {}).get("vault_name", "")

        # Find which role the current file belongs to by checking file paths
        for role in data.get("roles", []):
            assets = role.get("assets", [])
            for i, a in enumerate(assets):
                if a.get("vault_name") == current_name or os.path.normpath(a.get("file_path", "")) == filepath:
                    # Found current asset in this role
                    new_idx = i - direction  # assets sorted version DESC, so -1 = next version, +1 = prev
                    if 0 <= new_idx < len(assets):
                        new_path = assets[new_idx].get("file_path", "")
                        if new_path and os.path.exists(new_path):
                            self._switchTo(new_path)
                            return
                    rve.displayFeedback("No %s version available" % ("previous" if direction < 0 else "next"), 2.0)
                    return

        rve.displayFeedback("Current file not found in vault roles", 3.0)

    # ── menu handlers ────────────────────────────────────────────

    def showCompareMenu(self, event):
        """MediaVault → Compare to ..."""
        data, filepath = self._getRolesData()
        if not data:
            return
        roles = data.get("roles", [])
        if not roles:
            rve.displayFeedback("No other roles found in this shot", 3.0)
            return
        current_name = data.get("asset", {}).get("vault_name", "")
        self._buildRoleMenu(roles, self._loadAsCompare, current_name)

    def showSwitchMenu(self, event):
        """MediaVault → Switch to ..."""
        data, filepath = self._getRolesData()
        if not data:
            return
        roles = data.get("roles", [])
        if not roles:
            rve.displayFeedback("No other roles found in this shot", 3.0)
            return
        current_name = data.get("asset", {}).get("vault_name", "")
        self._buildRoleMenu(roles, self._switchTo, current_name)

    def prevVersion(self, event):
        """MediaVault → Prev Version"""
        self._stepVersion(-1)

    def nextVersion(self, event):
        """MediaVault → Next Version"""
        self._stepVersion(1)


def createMode():
    return MediaVaultMode()
