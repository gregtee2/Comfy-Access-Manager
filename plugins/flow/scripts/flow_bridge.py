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
    fetch_thumbnail_urls - Get thumbnail URLs for Versions + PublishedFiles (requires --json '{"project_id":...}')
    fetch_shot_thumbnails - Get thumbnail URLs for Shots in a project (requires --json '{"project_id":...}')
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

def sanitize_sg_datetime(iso_str):
    """Convert ISO 8601 string to ShotGrid-accepted format (no milliseconds).
    ShotGrid requires '2026-03-03T16:43:02Z' — not '2026-03-03T16:43:02.739Z'."""
    if not iso_str:
        return iso_str
    from datetime import datetime
    try:
        # Parse ISO format (handles both with and without ms)
        dt = datetime.fromisoformat(iso_str.replace('Z', '+00:00'))
        return dt.strftime('%Y-%m-%dT%H:%M:%SZ')
    except (ValueError, AttributeError):
        return iso_str  # return as-is if unparseable

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
        filters = [["project", "is", {"type": "Project", "id": int(project_id)}]]

        # Optional: delta sync — only shots updated since a timestamp
        since = sanitize_sg_datetime(params.get("since"))
        if since:
            filters.append(["updated_at", "greater_than", since])

        shots = sg.find("Shot",
            filters=filters,
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

def cmd_sync_tasks(sg, args):
    """Fetch tasks for a given project, including assignment and status."""
    params = json.loads(args.json) if args.json else {}
    project_id = params.get("project_id")
    if not project_id:
        error("project_id required in --json")

    try:
        filters = [["project", "is", {"type": "Project", "id": int(project_id)}]]

        # Optionally filter by entity type (Shot, Asset, etc.)
        entity_type = params.get("entity_type")
        if entity_type:
            filters.append(["entity", "type_is", entity_type])

        # Optional: delta sync — only tasks updated since a timestamp
        since = sanitize_sg_datetime(params.get("since"))
        if since:
            filters.append(["updated_at", "greater_than", since])

        tasks = sg.find("Task",
            filters=filters,
            fields=["content", "sg_status_list", "task_assignees", "step",
                    "entity", "start_date", "due_date", "sg_description",
                    "est_in_mins", "time_logs_sum", "id"],
            order=[{"field_name": "content", "direction": "asc"}]
        )

        result = []
        for task in tasks:
            step = task.get("step")
            entity = task.get("entity")
            assignees = task.get("task_assignees") or []

            result.append({
                "flow_id": task["id"],
                "content": task.get("content", ""),
                "status": task.get("sg_status_list", ""),
                "description": task.get("sg_description", "") or "",
                "step_id": step["id"] if step else None,
                "step_name": step.get("name", "") if step else None,
                "entity_type": entity["type"] if entity else None,
                "entity_id": entity["id"] if entity else None,
                "entity_name": entity.get("name", "") if entity else None,
                "assignees": [{"id": a["id"], "name": a.get("name", ""), "type": a["type"]} for a in assignees],
                "start_date": task.get("start_date"),
                "due_date": task.get("due_date"),
                "est_minutes": task.get("est_in_mins"),
                "logged_minutes": task.get("time_logs_sum"),
            })

        output({"success": True, "tasks": result, "count": len(result)})
    except Exception as e:
        error(f"Failed to fetch tasks: {str(e)}")

def cmd_update_task_status(sg, args):
    """Update a Task's status in Flow."""
    params = json.loads(args.json) if args.json else {}
    task_id = params.get("task_id")
    status = params.get("status")
    if not task_id or not status:
        error("'task_id' and 'status' required in --json")

    try:
        sg.update("Task", int(task_id), {"sg_status_list": status})
        output({
            "success": True,
            "message": f"Task {task_id} status updated to '{status}'"
        })
    except Exception as e:
        error(f"Failed to update task status: {str(e)}")

def cmd_upload_media(sg, args):
    """Upload a movie or image to a Version for Screening Room playback."""
    params = json.loads(args.json) if args.json else {}
    version_id = params.get("version_id")
    media_path = params.get("path")
    field_name = params.get("field", "sg_uploaded_movie")

    if not version_id or not media_path:
        error("'version_id' and 'path' required in --json")

    if not os.path.exists(media_path):
        error(f"Media file not found: {media_path}")

    try:
        sg.upload("Version", int(version_id), media_path, field_name=field_name)
        output({
            "success": True,
            "message": f"Media uploaded to Version {version_id} (field: {field_name})"
        })
    except Exception as e:
        error(f"Failed to upload media: {str(e)}")

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

def cmd_create_note(sg, args):
    """Create a Note entity in Flow, optionally with an image attachment."""
    params = json.loads(args.json) if args.json else {}

    project_id = params.get("project_id")
    subject = params.get("subject")
    body = params.get("body", "")

    if not project_id or not subject:
        error("'project_id' and 'subject' required in --json")

    try:
        data = {
            "project": {"type": "Project", "id": int(project_id)},
            "subject": subject,
            "content": body,
        }

        # Link to Shot if provided
        if params.get("shot_id"):
            data["note_links"] = [{"type": "Shot", "id": int(params["shot_id"])}]

        # Link to Version if provided (adds to note_links)
        if params.get("version_id"):
            links = data.get("note_links", [])
            links.append({"type": "Version", "id": int(params["version_id"])})
            data["note_links"] = links

        # Addressees (list of user IDs) — people who should see it
        if params.get("addressee_ids"):
            data["addressings_to"] = [
                {"type": "HumanUser", "id": int(uid)} for uid in params["addressee_ids"]
            ]

        note = sg.create("Note", data)
        note_id = note["id"]

        # Upload attachment image if provided
        attachment_id = None
        if params.get("attachment_path"):
            att_path = params["attachment_path"]
            if os.path.exists(att_path):
                attachment_id = sg.upload("Note", note_id, att_path, field_name="attachments")
            else:
                # Non-fatal — note still created
                pass

        output({
            "success": True,
            "note": {
                "flow_id": note_id,
                "subject": subject,
                "type": "Note",
            },
            "attachment_id": attachment_id,
            "message": f"Note '{subject}' created (ID: {note_id})" + (f" with attachment" if attachment_id else "")
        })
    except Exception as e:
        error(f"Failed to create note: {str(e)}")

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

def cmd_sync_versions(sg, args):
    """Fetch Versions for a project with file paths for bulk import."""
    params = json.loads(args.json) if args.json else {}
    project_id = params.get("project_id")
    if not project_id:
        error("project_id required in --json")

    try:
        filters = [[
            "project", "is", {"type": "Project", "id": int(project_id)}
        ]]

        # Optional: filter by status
        statuses = params.get("statuses")
        if statuses:
            filters.append(["sg_status_list", "in", statuses])

        # Optional: delta sync — only fetch versions updated since a timestamp
        since = sanitize_sg_datetime(params.get("since"))
        if since:
            filters.append(["updated_at", "greater_than", since])

        versions = sg.find("Version",
            filters=filters,
            fields=[
                "code", "description", "sg_status_list",
                "sg_path_to_frames", "sg_path_to_movie",
                "entity",           # linked Shot/Asset
                "sg_task",          # linked Task (has pipeline step)
                "sg_task.Task.step",
                "created_at", "id"
            ],
            order=[{"field_name": "created_at", "direction": "desc"}]
        )

        result = []
        for v in versions:
            entity = v.get("entity")
            task = v.get("sg_task")
            # Get step from task
            step = None
            if task:
                task_step = v.get("sg_task.Task.step")
                if task_step:
                    step = task_step

            # Collect all available file paths
            paths = []
            if v.get("sg_path_to_frames"):
                p = v["sg_path_to_frames"]
                # Can be a dict with 'local_path' or a string
                if isinstance(p, dict):
                    for key in ("local_path", "local_path_windows", "local_path_mac", "local_path_linux"):
                        if p.get(key):
                            paths.append(p[key])
                elif isinstance(p, str) and p:
                    paths.append(p)

            if v.get("sg_path_to_movie"):
                p = v["sg_path_to_movie"]
                if isinstance(p, dict):
                    for key in ("local_path", "local_path_windows", "local_path_mac", "local_path_linux"):
                        if p.get(key):
                            paths.append(p[key])
                elif isinstance(p, str) and p:
                    paths.append(p)

            # Deduplicate paths
            paths = list(dict.fromkeys(paths))

            result.append({
                "flow_id": v["id"],
                "code": v.get("code", ""),
                "description": v.get("description", "") or "",
                "status": v.get("sg_status_list", ""),
                "entity_type": entity["type"] if entity else None,
                "entity_id": entity["id"] if entity else None,
                "entity_name": entity.get("name", "") if entity else None,
                "step_id": step["id"] if step else None,
                "step_name": step.get("name", "") if step else None,
                "paths": paths,
                "created_at": v.get("created_at"),
            })

        output({"success": True, "versions": result, "count": len(result)})
    except Exception as e:
        error(f"Failed to fetch versions: {str(e)}")


def cmd_sync_published_files(sg, args):
    """Fetch PublishedFiles for a project with file paths."""
    params = json.loads(args.json) if args.json else {}
    project_id = params.get("project_id")
    if not project_id:
        error("project_id required in --json")

    try:
        filters = [["project", "is", {"type": "Project", "id": int(project_id)}]]

        # Optional: delta sync — only published files updated since a timestamp
        since = sanitize_sg_datetime(params.get("since"))
        if since:
            filters.append(["updated_at", "greater_than", since])

        pfiles = sg.find("PublishedFile",
            filters=filters,
            fields=[
                "code", "description", "sg_status_list",
                "path", "path_cache",
                "entity",           # linked Shot/Asset
                "task",             # linked Task
                "task.Task.step",
                "published_file_type",
                "version_number",
                "created_at", "id"
            ],
            order=[{"field_name": "created_at", "direction": "desc"}]
        )

        result = []
        for pf in pfiles:
            entity = pf.get("entity")
            task = pf.get("task")
            step = None
            if task:
                task_step = pf.get("task.Task.step")
                if task_step:
                    step = task_step

            paths = []
            # path field
            p = pf.get("path")
            if p:
                if isinstance(p, dict):
                    for key in ("local_path", "local_path_windows", "local_path_mac", "local_path_linux"):
                        if p.get(key):
                            paths.append(p[key])
                elif isinstance(p, str) and p:
                    paths.append(p)

            # path_cache as fallback
            pc = pf.get("path_cache")
            if pc and isinstance(pc, str):
                paths.append(pc)

            paths = list(dict.fromkeys(paths))

            pf_type = pf.get("published_file_type")

            result.append({
                "flow_id": pf["id"],
                "code": pf.get("code", ""),
                "description": pf.get("description", "") or "",
                "status": pf.get("sg_status_list", ""),
                "entity_type": entity["type"] if entity else None,
                "entity_id": entity["id"] if entity else None,
                "entity_name": entity.get("name", "") if entity else None,
                "step_id": step["id"] if step else None,
                "step_name": step.get("name", "") if step else None,
                "paths": paths,
                "file_type": pf_type.get("name", "") if pf_type else None,
                "version_number": pf.get("version_number"),
                "created_at": pf.get("created_at"),
            })

        output({"success": True, "published_files": result, "count": len(result)})
    except Exception as e:
        error(f"Failed to fetch published files: {str(e)}")


def cmd_fetch_shot_thumbnails(sg, args):
    """Fetch thumbnail URLs for all Shots in a project that have images."""
    params = json.loads(args.json) if args.json else {}
    project_id = params.get("project_id")
    if not project_id:
        error("project_id required in --json")

    try:
        shots = sg.find("Shot",
            filters=[["project", "is", {"type": "Project", "id": int(project_id)}]],
            fields=["id", "code", "image"],
            order=[{"field_name": "code", "direction": "asc"}])

        thumbnails = []
        for s in shots:
            if s.get("image"):
                thumbnails.append({
                    "flow_id": s["id"],
                    "code": s.get("code", ""),
                    "url": s["image"],
                })

        output({"success": True, "thumbnails": thumbnails, "count": len(thumbnails)})
    except Exception as e:
        error(f"Failed to fetch shot thumbnails: {str(e)}")


def cmd_fetch_role_thumbnails(sg, args):
    """Fetch the latest Version thumbnail per Shot+Step combo in a project.
    This gives role-level thumbnails: e.g. the latest Paint version's thumbnail for shot 104_0100.
    """
    params = json.loads(args.json) if args.json else {}
    project_id = params.get("project_id")
    if not project_id:
        error("project_id required in --json")

    try:
        # Get all Versions with thumbnails, linked to a Shot, with task step info
        versions = sg.find("Version",
            filters=[
                ["project", "is", {"type": "Project", "id": int(project_id)}],
                ["image", "is_not", None],
                ["entity", "type_is", "Shot"],
            ],
            fields=["id", "image", "entity", "sg_task", "sg_task.Task.step", "created_at"],
            order=[{"field_name": "created_at", "direction": "desc"}]  # newest first
        )

        # Group by (shot_flow_id, step_flow_id) — keep only the latest (first seen due to sort)
        seen = {}  # key: "shotId_stepId" -> {shot_flow_id, step_flow_id, url}
        for v in versions:
            entity = v.get("entity")
            if not entity or entity.get("type") != "Shot":
                continue

            # Get step from task link
            step = None
            task = v.get("sg_task")
            if task:
                task_step = v.get("sg_task.Task.step")
                if task_step:
                    step = task_step

            if not step:
                continue  # skip versions without a pipeline step

            key = f"{entity['id']}_{step['id']}"
            if key not in seen:
                seen[key] = {
                    "shot_flow_id": entity["id"],
                    "shot_name": entity.get("name", ""),
                    "step_flow_id": step["id"],
                    "step_name": step.get("name", ""),
                    "url": v["image"],
                    "version_id": v["id"],
                }

        thumbnails = list(seen.values())
        output({"success": True, "thumbnails": thumbnails, "count": len(thumbnails)})
    except Exception as e:
        error(f"Failed to fetch role thumbnails: {str(e)}")


def cmd_fetch_thumbnail_urls(sg, args):
    """Fetch thumbnail URLs for Versions and PublishedFiles in a project.
    Returns {flow_id: url} for each entity that has a thumbnail.
    """
    params = json.loads(args.json) if args.json else {}
    project_id = params.get("project_id")
    if not project_id:
        error("project_id required in --json")

    source = params.get("source", "both")
    # flow_ids: optional list of specific IDs to look up (for incremental fetch)
    flow_ids = params.get("flow_ids")

    thumbnails = []

    try:
        if source in ("versions", "both"):
            filters = [["project", "is", {"type": "Project", "id": int(project_id)}]]
            if flow_ids:
                filters.append(["id", "in", flow_ids])

            versions = sg.find("Version", filters=filters,
                fields=["id", "image", "entity"],
                order=[{"field_name": "id", "direction": "asc"}])

            for v in versions:
                if v.get("image"):
                    thumbnails.append({
                        "flow_id": v["id"],
                        "entity_type": "Version",
                        "url": v["image"],
                        "linked_entity_type": v["entity"]["type"] if v.get("entity") else None,
                        "linked_entity_id": v["entity"]["id"] if v.get("entity") else None,
                    })

        if source in ("published_files", "both"):
            filters = [["project", "is", {"type": "Project", "id": int(project_id)}]]
            if flow_ids:
                filters.append(["id", "in", flow_ids])

            pfs = sg.find("PublishedFile", filters=filters,
                fields=["id", "image", "entity"],
                order=[{"field_name": "id", "direction": "asc"}])

            for pf in pfs:
                if pf.get("image"):
                    thumbnails.append({
                        "flow_id": pf["id"],
                        "entity_type": "PublishedFile",
                        "url": pf["image"],
                        "linked_entity_type": pf["entity"]["type"] if pf.get("entity") else None,
                        "linked_entity_id": pf["entity"]["id"] if pf.get("entity") else None,
                    })

        output({"success": True, "thumbnails": thumbnails, "count": len(thumbnails)})
    except Exception as e:
        error(f"Failed to fetch thumbnail URLs: {str(e)}")


COMMANDS = {
    "test_connection": cmd_test_connection,
    "sync_projects": cmd_sync_projects,
    "sync_sequences": cmd_sync_sequences,
    "sync_shots": cmd_sync_shots,
    "sync_steps": cmd_sync_steps,
    "sync_tasks": cmd_sync_tasks,
    "sync_versions": cmd_sync_versions,
    "sync_published_files": cmd_sync_published_files,
    "update_task_status": cmd_update_task_status,
    "publish_version": cmd_publish_version,
    "upload_thumbnail": cmd_upload_thumbnail,
    "upload_media": cmd_upload_media,
    "create_note": cmd_create_note,
    "fetch_thumbnail_urls": cmd_fetch_thumbnail_urls,
    "fetch_shot_thumbnails": cmd_fetch_shot_thumbnails,
    "fetch_role_thumbnails": cmd_fetch_role_thumbnails,
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
