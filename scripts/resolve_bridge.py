#!/usr/bin/env python3
"""
Comfy Asset Manager - DaVinci Resolve Bridge
Connects to a running DaVinci Resolve instance and executes commands.

Usage:
    python resolve_bridge.py <command> [--json '{"key":"value"}']

Commands:
    status          - Check if Resolve is running and reachable
    list_bins       - List all bins (folders) in the current project's media pool
    send_to_bin     - Import media files into a specific bin path
    get_projects    - List all projects in Resolve's project manager

JSON params for send_to_bin:
    {
        "files": ["/path/to/file1.exr", "/path/to/file2.mov"],
        "bin_path": "ProjectName/SequenceName/ShotName",
        "create_bins": true
    }

Cross-platform: Windows, macOS, Linux
Requires: DaVinci Resolve running with scripting enabled
"""

import sys
import os
import json
import platform


def get_resolve():
    """
    Connect to a running DaVinci Resolve instance.
    Cross-platform module loading following BMD's official pattern.
    Returns the Resolve object or None.
    """
    try:
        import DaVinciResolveScript as bmd
        return bmd.scriptapp("Resolve")
    except ImportError:
        pass

    # Fallback: manually set up paths based on platform
    system = platform.system()

    if system == "Windows":
        # Windows paths
        script_api = os.path.join(
            os.environ.get("PROGRAMDATA", r"C:\ProgramData"),
            "Blackmagic Design", "DaVinci Resolve", "Support", "Developer", "Scripting"
        )
        lib_path = os.path.join(
            os.environ.get("PROGRAMFILES", r"C:\Program Files"),
            "Blackmagic Design", "DaVinci Resolve", "fusionscript.dll"
        )
    elif system == "Darwin":
        # macOS paths
        script_api = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
        lib_path = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so"
    else:
        # Linux paths
        script_api = "/opt/resolve/Developer/Scripting"
        lib_path = "/opt/resolve/libs/Fusion/fusionscript.so"

    # Add Modules path for import
    modules_path = os.path.join(script_api, "Modules")
    if modules_path not in sys.path:
        sys.path.insert(0, modules_path)

    # Set environment variables
    os.environ["RESOLVE_SCRIPT_API"] = script_api
    os.environ["RESOLVE_SCRIPT_LIB"] = lib_path

    try:
        import DaVinciResolveScript as bmd
        return bmd.scriptapp("Resolve")
    except Exception:
        return None


def cmd_status(resolve, params):
    """Check if Resolve is running and return project info."""
    if not resolve:
        return {"success": True, "running": False, "message": "DaVinci Resolve is not running or scripting is not enabled"}

    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()

    result = {
        "success": True,
        "running": True,
        "version": resolve.GetVersionString() if hasattr(resolve, 'GetVersionString') else "unknown",
        "currentProject": project.GetName() if project else None,
        "currentPage": resolve.GetCurrentPage() if hasattr(resolve, 'GetCurrentPage') else None,
    }

    if project:
        mp = project.GetMediaPool()
        root = mp.GetRootFolder()
        result["mediaPoolRoot"] = root.GetName() if root else None
        result["timelineCount"] = project.GetTimelineCount()

    return result


def _get_folder_tree(folder, prefix=""):
    """Recursively build folder tree."""
    items = []
    name = folder.GetName()
    clip_count = len(folder.GetClipList())

    items.append({
        "name": name,
        "path": prefix + name if prefix else name,
        "clipCount": clip_count,
        "children": []
    })

    for sub in folder.GetSubFolderList():
        sub_path = (prefix + name + "/") if prefix else (name + "/")
        child_items = _get_folder_tree(sub, sub_path)
        items[0]["children"].extend(child_items)

    return items


def cmd_list_bins(resolve, params):
    """List all bins (folders) in the current project's media pool."""
    if not resolve:
        return {"success": False, "error": "Resolve not running"}

    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        return {"success": False, "error": "No project open in Resolve"}

    mp = project.GetMediaPool()
    root = mp.GetRootFolder()

    tree = _get_folder_tree(root)

    return {
        "success": True,
        "project": project.GetName(),
        "bins": tree
    }


def _find_or_create_folder(media_pool, parent_folder, folder_name):
    """Find an existing subfolder by name, or create it."""
    for sub in parent_folder.GetSubFolderList():
        if sub.GetName() == folder_name:
            return sub
    # Create new
    new_folder = media_pool.AddSubFolder(parent_folder, folder_name)
    return new_folder


def _navigate_to_bin(media_pool, root_folder, bin_path, create=True):
    """
    Navigate to a bin path like "Project/Sequence/Shot", creating folders if needed.
    Returns the target Folder object, or None on failure.
    """
    parts = [p.strip() for p in bin_path.split("/") if p.strip()]
    current = root_folder

    for part in parts:
        found = None
        for sub in current.GetSubFolderList():
            if sub.GetName() == part:
                found = sub
                break

        if found:
            current = found
        elif create:
            new_folder = media_pool.AddSubFolder(current, part)
            if not new_folder:
                return None
            current = new_folder
        else:
            return None

    return current


def cmd_send_to_bin(resolve, params):
    """
    Import media files into a specific bin in Resolve's media pool.

    params:
        files: list of absolute file paths
        bin_path: slash-separated bin path (e.g. "MyProject/Comp/SH010")
        create_bins: bool, create missing bin folders (default True)
    """
    if not resolve:
        return {"success": False, "error": "Resolve not running"}

    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        return {"success": False, "error": "No project open in Resolve"}

    files = params.get("files", [])
    bin_path = params.get("bin_path", "")
    create_bins = params.get("create_bins", True)

    if not files:
        return {"success": False, "error": "No files specified"}

    # Validate files exist
    missing = [f for f in files if not os.path.exists(f)]
    if missing:
        return {"success": False, "error": f"Files not found: {', '.join(missing)}"}

    mp = project.GetMediaPool()
    root = mp.GetRootFolder()

    # Navigate to (or create) target bin
    if bin_path:
        target_folder = _navigate_to_bin(mp, root, bin_path, create=create_bins)
        if not target_folder:
            return {"success": False, "error": f"Could not navigate to bin: {bin_path}"}
    else:
        target_folder = root

    # Set current folder to target
    mp.SetCurrentFolder(target_folder)

    # Import media
    imported_items = mp.ImportMedia(files)

    if not imported_items:
        return {
            "success": False,
            "error": "ImportMedia returned no items. Files may already exist in the bin or be unsupported."
        }

    # Build result with imported clip info
    imported_info = []
    for item in imported_items:
        info = {
            "name": item.GetName(),
            "mediaId": item.GetMediaId() if hasattr(item, 'GetMediaId') else None,
        }
        # Get basic clip properties
        try:
            props = item.GetClipProperty()
            if props:
                info["resolution"] = props.get("Resolution", "")
                info["fps"] = props.get("FPS", "")
                info["duration"] = props.get("Duration", "")
                info["codec"] = props.get("Video Codec", "")
                info["filePath"] = props.get("File Path", "")
        except Exception:
            pass
        imported_info.append(info)

    return {
        "success": True,
        "project": project.GetName(),
        "bin": bin_path or "Master",
        "imported": len(imported_info),
        "items": imported_info
    }


def cmd_get_projects(resolve, params):
    """List all projects in Resolve's current database."""
    if not resolve:
        return {"success": False, "error": "Resolve not running"}

    pm = resolve.GetProjectManager()

    # Save current project name to restore later
    current = pm.GetCurrentProject()
    current_name = current.GetName() if current else None

    # Go to root folder and list
    pm.GotoRootFolder()
    projects = pm.GetProjectListInCurrentFolder()

    return {
        "success": True,
        "currentProject": current_name,
        "projects": sorted(projects) if projects else []
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: resolve_bridge.py <command> [--json '{...}']"}))
        sys.exit(1)

    command = sys.argv[1]

    # Parse optional JSON params
    params = {}
    if "--json" in sys.argv:
        idx = sys.argv.index("--json")
        if idx + 1 < len(sys.argv):
            try:
                params = json.loads(sys.argv[idx + 1])
            except json.JSONDecodeError as e:
                print(json.dumps({"success": False, "error": f"Invalid JSON: {e}"}))
                sys.exit(1)

    # Connect to Resolve
    resolve = get_resolve()

    # Dispatch command
    commands = {
        "status": cmd_status,
        "list_bins": cmd_list_bins,
        "send_to_bin": cmd_send_to_bin,
        "get_projects": cmd_get_projects,
    }

    handler = commands.get(command)
    if not handler:
        print(json.dumps({"success": False, "error": f"Unknown command: {command}. Available: {', '.join(commands.keys())}"}))
        sys.exit(1)

    try:
        result = handler(resolve, params)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"success": False, "error": f"{type(e).__name__}: {str(e)}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
