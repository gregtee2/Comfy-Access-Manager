# Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
# This source code is proprietary and confidential. Unauthorized copying,
# modification, distribution, or use of this file is strictly prohibited.
# See LICENSE file for details.
#!/usr/bin/env python3
"""
Flow Production Tracking (ShotGrid) Bridge for Comfy Asset Manager
Communicates with Flow via shotgun_api3, outputs JSON to stdout for Node.js consumption.

Usage:
    python flow_bridge.py <command> [--site URL] [--script-name NAME] [--api-key KEY] [--json ARGS]

Commands:
    test_connection      - Test Flow connection
    sync_projects        - Fetch all active projects
    sync_sequences       - Fetch sequences for a project (requires --json '{"project_id": 123}')
    sync_shots           - Fetch shots for a project (requires --json '{"project_id": 123}')
    sync_steps           - Fetch pipeline steps (become Roles in MediaVault)
    publish_version      - Create a Version in Flow (requires --json '{"project_id":..., ...}')
    upload_thumbnail     - Upload thumbnail to a Version (requires --json '{"version_id":..., "path":"..."}')
"""

import sys
import json
import argparse
import os
import traceback

def get_sg_connection(site, script_name, api_key):
    """Create and return a Shotgun API connection."""
    try:
        import shotgun_api3
    except ImportError:
        return None, "shotgun_api3 not installed. Run: pip install shotgun_api3"
    
    try:
        sg = shotgun_api3.Shotgun(site, script_name=script_name, api_key=api_key)
        return sg, None
    except Exception as e:
        return None, f"Connection failed: {str(e)}"

def output(data):
    """Print JSON to stdout for Node.js to consume."""
    print(json.dumps(data, default=str))
    sys.stdout.flush()

def error(message, details=None):
    """Print error JSON."""
    result = {"success": False, "error": message}
    if details:
        result["details"] = details
    output(result)
    sys.exit(1)

# ─── Commands ───────────────────────────────────────────────

def cmd_test_connection(sg, args):
    """Test the Flow connection by fetching server info."""
    try:
        info = sg.info()
        output({
            "success": True,
            "message": "Connected to Flow Production Tracking",
            "server_info": {
                "version": info.get("version", []),
                "site_url": args.site,
            }
        })
    except Exception as e:
        error(f"Connection test failed: {str(e)}")

def cmd_sync_projects(sg, args):
    """Fetch all active projects from Flow."""
    try:
        projects = sg.find("Project", 
            filters=[["sg_status", "is", "Active"]],
            fields=["code", "name", "sg_description", "sg_status", "id"],
            order=[{"field_name": "name", "direction": "asc"}]
        )
        
        result = []
        for p in projects:
            result.append({
                "flow_id": p["id"],
                "name": p.get("name", ""),
                "code": p.get("code") or p.get("name", "").upper().replace(" ", "_")[:10],
                "description": p.get("sg_description", "") or "",
                "status": p.get("sg_status", "Active"),
            })
        
        output({"success": True, "projects": result, "count": len(result)})
    except Exception as e:
        error(f"Failed to fetch projects: {str(e)}")

def cmd_sync_sequences(sg, args):
    """Fetch sequences for a given project."""
    params = json.loads(args.json) if args.json else {}
    project_id = params.get("project_id")
    if not project_id:
        error("project_id required in --json")
    
    try:
        sequences = sg.find("Sequence",
            filters=[["project", "is", {"type": "Project", "id": int(project_id)}]],
            fields=["code", "description", "sg_status_list", "id"],
            order=[{"field_name": "code", "direction": "asc"}]
        )
        
        result = []
        for seq in sequences:
            result.append({
                "flow_id": seq["id"],
                "code": seq.get("code", ""),
                "name": seq.get("code", ""),  # Sequences typically use code as name
                "description": seq.get("description", "") or "",
                "status": seq.get("sg_status_list", ""),
            })
        
        output({"success": True, "sequences": result, "count": len(result)})
    except Exception as e:
        error(f"Failed to fetch sequences: {str(e)}")

def cmd_sync_shots(sg, args):
    """Fetch shots for a given project, including sequence links."""
    params = json.loads(args.json) if args.json else {}
    project_id = params.get("project_id")
    if not project_id:
        error("project_id required in --json")
    
    try:
        shots = sg.find("Shot",
            filters=[["project", "is", {"type": "Project", "id": int(project_id)}]],
            fields=["code", "description", "sg_status_list", "sg_sequence", 
                     "sg_cut_in", "sg_cut_out", "sg_cut_duration", "id"],
            order=[{"field_name": "code", "direction": "asc"}]
        )
        
        result = []
        for shot in shots:
            seq = shot.get("sg_sequence")
            result.append({
                "flow_id": shot["id"],
                "code": shot.get("code", ""),
                "name": shot.get("code", ""),
                "description": shot.get("description", "") or "",
                "status": shot.get("sg_status_list", ""),
                "sequence_flow_id": seq["id"] if seq else None,
                "sequence_code": seq.get("name", "") if seq else None,
                "cut_in": shot.get("sg_cut_in"),
                "cut_out": shot.get("sg_cut_out"),
                "cut_duration": shot.get("sg_cut_duration"),
            })
        
        output({"success": True, "shots": result, "count": len(result)})
    except Exception as e:
        error(f"Failed to fetch shots: {str(e)}")

def cmd_sync_steps(sg, args):
    """Fetch pipeline steps (mapped to Roles in MediaVault)."""
    try:
        steps = sg.find("Step",
            filters=[],
            fields=["code", "short_name", "description", "entity_type", 
                     "department", "color", "list_order", "id"],
            order=[{"field_name": "list_order", "direction": "asc"}]
        )
        
        result = []
        for step in steps:
            # Only include steps for Shot entity type (most relevant)
            if step.get("entity_type") and step["entity_type"] != "Shot":
                continue
            
            color = step.get("color")
            hex_color = "#888888"
            if color and isinstance(color, str) and "," in color:
                # Flow stores colors as "R,G,B" strings
                try:
                    parts = [int(x.strip()) for x in color.split(",")]
                    if len(parts) == 3:
                        hex_color = "#{:02x}{:02x}{:02x}".format(*parts)
                except:
                    pass
            elif color and isinstance(color, str) and color.startswith("#"):
                hex_color = color
            
            result.append({
                "flow_id": step["id"],
                "code": step.get("short_name") or step.get("code", ""),
                "name": step.get("code", ""),
                "description": step.get("description", "") or "",
                "color": hex_color,
                "sort_order": step.get("list_order", 0) or 0,
                "department": step.get("department", {}).get("name", "") if isinstance(step.get("department"), dict) else "",
            })
        
        output({"success": True, "steps": result, "count": len(result)})
    except Exception as e:
        error(f"Failed to fetch pipeline steps: {str(e)}")

def cmd_publish_version(sg, args):
    """Create a Version entity in Flow linked to a Shot."""
    params = json.loads(args.json) if args.json else {}
    
    required = ["project_id", "code", "description"]
    for field in required:
        if field not in params:
            error(f"'{field}' required in --json")
    
    try:
        data = {
            "project": {"type": "Project", "id": int(params["project_id"])},
            "code": params["code"],
            "description": params.get("description", ""),
            "sg_status_list": params.get("status", "rev"),  # Pending Review
        }
        
        # Link to shot if provided
        if params.get("shot_id"):
            data["entity"] = {"type": "Shot", "id": int(params["shot_id"])}
        
        # Link to task/step if provided
        if params.get("task_id"):
            data["sg_task"] = {"type": "Task", "id": int(params["task_id"])}
        
        # Path to frames/movie
        if params.get("path_to_frames"):
            data["sg_path_to_frames"] = params["path_to_frames"]
        
        if params.get("path_to_movie"):
            data["sg_path_to_movie"] = params["path_to_movie"]
        
        # User
        if params.get("user_id"):
            data["user"] = {"type": "HumanUser", "id": int(params["user_id"])}
        
        version = sg.create("Version", data)
        
        output({
            "success": True,
            "version": {
                "flow_id": version["id"],
                "code": params["code"],
                "type": "Version",
            },
            "message": f"Version '{params['code']}' created (ID: {version['id']})"
        })
    except Exception as e:
        error(f"Failed to create version: {str(e)}")

def cmd_upload_thumbnail(sg, args):
    """Upload a thumbnail image to a Version."""
    params = json.loads(args.json) if args.json else {}
    
    version_id = params.get("version_id")
    thumb_path = params.get("path")
    entity_type = params.get("entity_type", "Version")
    
    if not version_id or not thumb_path:
        error("'version_id' and 'path' required in --json")
    
    if not os.path.exists(thumb_path):
        error(f"Thumbnail file not found: {thumb_path}")
    
    try:
        attachment_id = sg.upload_thumbnail(entity_type, int(version_id), thumb_path)
        output({
            "success": True,
            "attachment_id": attachment_id,
            "message": f"Thumbnail uploaded to {entity_type} {version_id}"
        })
    except Exception as e:
        error(f"Failed to upload thumbnail: {str(e)}")

# ─── Main ───────────────────────────────────────────────────

COMMANDS = {
    "test_connection": cmd_test_connection,
    "sync_projects": cmd_sync_projects,
    "sync_sequences": cmd_sync_sequences,
    "sync_shots": cmd_sync_shots,
    "sync_steps": cmd_sync_steps,
    "publish_version": cmd_publish_version,
    "upload_thumbnail": cmd_upload_thumbnail,
}

def main():
    parser = argparse.ArgumentParser(description="Flow Production Tracking Bridge for Comfy Asset Manager")
    parser.add_argument("command", choices=COMMANDS.keys(), help="Command to execute")
    parser.add_argument("--site", required=True, help="Flow site URL (e.g., https://mysite.shotgrid.autodesk.com)")
    parser.add_argument("--script-name", required=True, help="Flow Script name")
    parser.add_argument("--api-key", required=True, help="Flow Script API key")
    parser.add_argument("--json", default=None, help="JSON string with command-specific parameters")
    
    args = parser.parse_args()
    
    # Connect to Flow
    sg, err = get_sg_connection(args.site, args.script_name, args.api_key)
    if err:
        error(err)
    
    # Execute command
    try:
        COMMANDS[args.command](sg, args)
    except SystemExit:
        raise
    except Exception as e:
        error(f"Unexpected error: {str(e)}", traceback.format_exc())

if __name__ == "__main__":
    main()
