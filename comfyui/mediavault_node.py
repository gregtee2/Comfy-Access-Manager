# Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
# This source code is proprietary and confidential. Unauthorized copying,
# modification, distribution, or use of this file is strictly prohibited.
# See LICENSE file for details.
"""
MediaVault — ComfyUI Custom Nodes
Load images/videos from MediaVault and save outputs back to it.
Persistent mapping: remembers which asset was loaded per node, so
re-opening a workflow auto-loads the same file.

Installation:
  Copy this folder (mediavault/) into ComfyUI/custom_nodes/
  Or junction:  mklink /J  ComfyUI\\custom_nodes\\mediavault  C:\\MediaVault\\comfyui
"""

import os
import json
import time
import shutil
import subprocess
import urllib.request
import urllib.error
import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import torch
import cv2
import tempfile

# Optional: torchaudio for native audio saving
try:
    import torchaudio
    TORCHAUDIO_AVAILABLE = True
except ImportError:
    TORCHAUDIO_AVAILABLE = False

# File extensions recognised as video (not loadable by PIL)
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".m4v", ".mpg", ".mpeg"}

# MediaVault API base — change if needed
MEDIAVAULT_URL = os.environ.get("MEDIAVAULT_URL", "http://localhost:7700")

# Connection health cache — avoids spamming errors when MediaVault is down
_mv_alive = True          # assume alive until first failure
_mv_last_check = 0.0      # timestamp of last failed attempt
_MV_BACKOFF_SEC = 60      # seconds to wait before retrying after failure
_mv_warned = False         # only print the "offline" warning once

def _mv_is_reachable():
    """Check if MediaVault server is reachable (with backoff cache)."""
    global _mv_alive, _mv_last_check, _mv_warned
    now = time.time()
    if _mv_alive:
        return True
    if now - _mv_last_check < _MV_BACKOFF_SEC:
        return False  # still in backoff period — skip silently
    # Backoff expired — try again
    try:
        req = urllib.request.Request(f"{MEDIAVAULT_URL}/api/settings/status", method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            _mv_alive = True
            _mv_warned = False
            print("[MediaVault] ✓ Reconnected to MediaVault server")
            return True
    except Exception:
        _mv_last_check = now
        if not _mv_warned:
            print(f"[MediaVault] ⚠ Server not running at {MEDIAVAULT_URL} — dropdowns will show defaults. Retrying every {_MV_BACKOFF_SEC}s.")
            _mv_warned = True
        return False

# ═══════════════════════════════════════════
#  ComfyUI Server Routes (for dynamic dropdowns)
#  These register on ComfyUI's aiohttp server so the
#  frontend JS extension can query MediaVault without CORS.
# ═══════════════════════════════════════════
try:
    from aiohttp import web
    from server import PromptServer

    def _proxy_mv(path):
        """Synchronous fetch from MediaVault API (runs inside async handler)."""
        if not _mv_is_reachable():
            return []
        url = f"{MEDIAVAULT_URL}{path}"
        try:
            req = urllib.request.Request(url, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            global _mv_alive, _mv_last_check
            _mv_alive = False
            _mv_last_check = time.time()
            print(f"[MediaVault] proxy error (backing off {_MV_BACKOFF_SEC}s): {e}")
            return []

    @PromptServer.instance.routes.get("/mediavault/projects")
    async def mv_projects(request):
        data = _proxy_mv("/api/comfyui/projects")
        return web.json_response(data or [])

    @PromptServer.instance.routes.get("/mediavault/sequences")
    async def mv_sequences(request):
        project_id = request.rel_url.query.get("project_id", "")
        path = "/api/comfyui/sequences"
        if project_id and project_id != "0":
            path += f"?project_id={project_id}"
        data = _proxy_mv(path)
        return web.json_response(data or [])

    @PromptServer.instance.routes.get("/mediavault/shots")
    async def mv_shots(request):
        params = []
        for key in ("project_id", "sequence_id"):
            val = request.rel_url.query.get(key, "")
            if val and val != "0":
                params.append(f"{key}={val}")
        path = "/api/comfyui/shots"
        if params:
            path += "?" + "&".join(params)
        data = _proxy_mv(path)
        return web.json_response(data or [])

    @PromptServer.instance.routes.get("/mediavault/roles")
    async def mv_roles(request):
        data = _proxy_mv("/api/comfyui/roles")
        return web.json_response(data or [])

    @PromptServer.instance.routes.get("/mediavault/assets")
    async def mv_assets(request):
        params = []
        for key in ("project_id", "sequence_id", "shot_id", "role_id", "media_type"):
            val = request.rel_url.query.get(key, "")
            if val and val != "0":
                params.append(f"{key}={val}")
        path = "/api/comfyui/assets"
        if params:
            path += "?" + "&".join(params)
        data = _proxy_mv(path)
        return web.json_response(data or [])

    @PromptServer.instance.routes.get("/mediavault/thumbnail/{asset_id}")
    async def mv_thumbnail(request):
        """Proxy thumbnail image from MediaVault (avoids CORS)."""
        if not _mv_is_reachable():
            return web.Response(status=503, text="MediaVault not available")
        asset_id = request.match_info["asset_id"]
        url = f"{MEDIAVAULT_URL}/api/assets/{asset_id}/thumbnail"
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = resp.read()
                ct = resp.headers.get("Content-Type", "image/jpeg")
                return web.Response(body=data, content_type=ct)
        except Exception as e:
            print(f"[MediaVault] thumbnail proxy error: {e}")
            return web.Response(status=404, text="Not found")

    @PromptServer.instance.routes.get("/mediavault/probe-video/{asset_id}")
    async def mv_probe_video(request):
        """Probe a video asset and return metadata (frame count, fps, resolution, duration).
        Used by the JS extension to show video info on the node before execution."""
        asset_id = request.match_info["asset_id"]
        path_data = _proxy_mv(f"/api/assets/{asset_id}")
        file_path = path_data.get("file_path") if isinstance(path_data, dict) else None
        if not file_path:
            return web.json_response({"error": "Asset not found"}, status=404)

        if not os.path.exists(file_path):
            return web.json_response({"error": "File not found on disk"}, status=404)

        ext = os.path.splitext(file_path)[1].lower()
        if ext not in VIDEO_EXTENSIONS:
            return web.json_response({"error": "Not a video file"}, status=400)

        try:
            cap = cv2.VideoCapture(file_path)
            if not cap.isOpened():
                return web.json_response({"error": "Cannot open video"}, status=500)

            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            duration = total_frames / fps if fps > 0 else 0.0
            cap.release()

            return web.json_response({
                "frame_count": total_frames,
                "fps": round(fps, 2),
                "width": width,
                "height": height,
                "duration": round(duration, 2),
            })
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    # ── Pending Workflow (one-shot storage for "Load in ComfyUI") ──
    _pending_workflow = None

    @PromptServer.instance.routes.post("/mediavault/load-workflow")
    async def mv_store_pending_workflow(request):
        """Store a workflow JSON sent from CAM. The JS extension picks it up on page load."""
        global _pending_workflow
        try:
            data = await request.json()
            _pending_workflow = data
            print(f"[MediaVault] ✓ Pending workflow stored ({len(data.get('nodes', []))} nodes)")
            return web.json_response({"success": True})
        except Exception as e:
            return web.json_response({"success": False, "error": str(e)}, status=400)

    @PromptServer.instance.routes.get("/mediavault/load-workflow")
    async def mv_get_pending_workflow(request):
        """Retrieve and clear the pending workflow (one-shot)."""
        global _pending_workflow
        if _pending_workflow is not None:
            data = _pending_workflow
            _pending_workflow = None
            return web.json_response({"hasWorkflow": True, "workflow": data})
        return web.json_response({"hasWorkflow": False})

    # ── Pending Assets (one-shot storage for "Send to ComfyUI") ──
    _pending_assets = None
    _active_tab_id = None  # Most-recently-focused tab gets priority

    @PromptServer.instance.routes.post("/mediavault/set-active-tab")
    async def mv_set_active_tab(request):
        """Register a ComfyUI tab as the active receiver for Send to ComfyUI."""
        global _active_tab_id
        try:
            data = await request.json()
            _active_tab_id = data.get("tabId")
            return web.json_response({"success": True, "activeTab": _active_tab_id})
        except Exception as e:
            return web.json_response({"success": False, "error": str(e)}, status=400)

    @PromptServer.instance.routes.post("/mediavault/send-assets")
    async def mv_store_pending_assets(request):
        """Store asset list sent from CAM. The JS extension picks them up and creates loader nodes."""
        global _pending_assets
        try:
            data = await request.json()
            _pending_assets = data.get("assets", [])
            print(f"[MediaVault] ✓ Pending assets stored ({len(_pending_assets)} assets)")
            return web.json_response({"success": True})
        except Exception as e:
            return web.json_response({"success": False, "error": str(e)}, status=400)

    @PromptServer.instance.routes.get("/mediavault/send-assets")
    async def mv_get_pending_assets(request):
        """Retrieve and clear pending assets (one-shot).
        Only the most-recently-focused tab receives the assets."""
        global _pending_assets, _active_tab_id
        if _pending_assets is not None and len(_pending_assets) > 0:
            tab_id = request.rel_url.query.get("tabId")
            # If an active tab is registered, only that tab gets the assets
            if _active_tab_id and tab_id != _active_tab_id:
                return web.json_response({"hasAssets": False})
            data = _pending_assets
            _pending_assets = None
            return web.json_response({"hasAssets": True, "assets": data})
        return web.json_response({"hasAssets": False})

    print("[MediaVault] ✓ Dynamic dropdown routes registered on ComfyUI server")

except ImportError:
    print("[MediaVault] ⚠ PromptServer not available — dynamic dropdowns disabled (standalone mode?)")


# ═══════════════════════════════════════════
#  API Helpers
# ═══════════════════════════════════════════
def mv_api(path, method="GET", data=None, timeout=3):
    """Call MediaVault REST API."""
    if not _mv_is_reachable():
        return None
    url = f"{MEDIAVAULT_URL}{path}"
    headers = {"Content-Type": "application/json"}

    if data is not None:
        req = urllib.request.Request(url, data=json.dumps(data).encode(), headers=headers, method=method)
    else:
        req = urllib.request.Request(url, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        global _mv_alive, _mv_last_check
        _mv_alive = False
        _mv_last_check = time.time()
        print(f"[MediaVault] API error (backing off {_MV_BACKOFF_SEC}s): {e}")
        return None
    except json.JSONDecodeError:
        return None


def get_projects():
    """Fetch project list for dropdown."""
    result = mv_api("/api/comfyui/projects")
    if result:
        return {f"{p['name']} ({p['code']})": str(p['id']) for p in result}
    return {"No projects found": "0"}


def get_sequences():
    """Fetch all sequences for dropdown."""
    result = mv_api("/api/comfyui/sequences")
    if result:
        d = {"* (All Sequences)": "0"}
        for s in result:
            d[f"{s['name']} ({s['code']})"] = str(s['id'])
        return d
    return {"* (All Sequences)": "0"}


def get_shots():
    """Fetch all shots for dropdown."""
    result = mv_api("/api/comfyui/shots")
    if result:
        d = {"* (All Shots)": "0"}
        for s in result:
            d[f"{s['name']} ({s['code']})"] = str(s['id'])
        return d
    return {"* (All Shots)": "0"}


def get_roles():
    """Fetch all roles for dropdown."""
    result = mv_api("/api/comfyui/roles")
    if result:
        d = {"* (All Roles)": "0"}
        for r in result:
            d[f"{r['name']} ({r['code']})"] = str(r['id'])
        return d
    return {"* (All Roles)": "0"}


def get_assets(project_id=None, sequence_id=None, shot_id=None, role_id=None, media_type=None):
    """Fetch asset list for dropdown, filtered by hierarchy."""
    params = []
    if project_id and project_id != "0":
        params.append(f"project_id={project_id}")
    if sequence_id and sequence_id != "0":
        params.append(f"sequence_id={sequence_id}")
    if shot_id and shot_id != "0":
        params.append(f"shot_id={shot_id}")
    if role_id and role_id != "0":
        params.append(f"role_id={role_id}")
    if media_type:
        params.append(f"media_type={media_type}")
    query = "&".join(params)
    path = f"/api/comfyui/assets?{query}" if query else "/api/comfyui/assets"

    result = mv_api(path)
    if result:
        return {f"{a['vault_name']}": str(a['id']) for a in result}
    return {"No assets found": "0"}


def get_asset_path(asset_id):
    """Get the absolute file path for an asset."""
    result = mv_api(f"/api/comfyui/asset/{asset_id}/path")
    if result and result.get("path"):
        return result["path"]
    return None


def save_mapping(workflow_id, node_id, asset_id):
    """Save persistent node → asset mapping."""
    mv_api("/api/comfyui/mapping", method="POST", data={
        "workflow_id": workflow_id,
        "node_id": node_id,
        "asset_id": int(asset_id),
    })


def load_mapping(workflow_id, node_id):
    """Load persistent mapping for this node."""
    result = mv_api(f"/api/comfyui/mapping?workflow_id={workflow_id}&node_id={node_id}")
    if result and result.get("asset_id"):
        return result
    return None


# ═══════════════════════════════════════════
#  Load From MediaVault
# ═══════════════════════════════════════════
class LoadFromMediaVault:
    """
    Load an image from MediaVault.
    Browse by Project → Sequence → Shot → Role to find your asset.
    Supports persistent mapping — when you save and reload a workflow,
    the same asset is loaded automatically.
    """

    @classmethod
    def INPUT_TYPES(cls):
        # Static defaults — NEVER call API here (blocks ComfyUI startup)
        # The JS extension (mediavault_dynamic.js) populates dropdowns live
        return {
            "required": {
                "project": (["(Load MediaVault...)"], {"default": "(Load MediaVault...)"}),
                "sequence": (["* (All Sequences)"], {"default": "* (All Sequences)"}),
                "shot": (["* (All Shots)"], {"default": "* (All Shots)"}),
                "role": (["* (All Roles)"], {"default": "* (All Roles)"}),
                "asset": (["(Select project first)"], {"default": "(Select project first)"}),
            },
            "optional": {
                "workflow_id": ("STRING", {"default": "default", "multiline": False}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "file_path")
    FUNCTION = "load_image"
    CATEGORY = "MediaVault"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # Dropdowns are dynamically populated by JS extension — skip combo validation
        return True

    def load_image(self, project, asset, sequence="* (All Sequences)",
                   shot="* (All Shots)", role="* (All Roles)", workflow_id="default"):
        # Resolve IDs from display names
        projects = get_projects()
        project_id = projects.get(project, "0")

        sequences_map = get_sequences()
        sequence_id = sequences_map.get(sequence, "0")

        shots_map = get_shots()
        shot_id = shots_map.get(shot, "0")

        roles_map = get_roles()
        role_id = roles_map.get(role, "0")

        # Find asset from the filtered list
        assets = get_assets(
            project_id=project_id if project_id != "0" else None,
            sequence_id=sequence_id if sequence_id != "0" else None,
            shot_id=shot_id if shot_id != "0" else None,
            role_id=role_id if role_id != "0" else None,
        )
        asset_id = assets.get(asset, "0")

        if asset_id == "0":
            # Fallback: try project-only lookup (filters may not match asset tags)
            all_project_assets = get_assets(
                project_id=project_id if project_id != "0" else None
            )
            asset_id = all_project_assets.get(asset, "0")

        if asset_id == "0":
            # Fallback: try completely unfiltered lookup
            all_assets = get_assets()
            asset_id = all_assets.get(asset, "0")

        if asset_id == "0":
            # Last resort: try persistent mapping
            mapping = load_mapping(workflow_id, self.__class__.__name__)
            if mapping:
                asset_id = str(mapping["asset_id"])

        # Get file path
        file_path = get_asset_path(asset_id)
        if not file_path or not os.path.exists(file_path):
            raise FileNotFoundError(f"[MediaVault] Asset not found: {asset} (id={asset_id})")

        # Save mapping for persistence
        save_mapping(workflow_id, self.__class__.__name__, asset_id)

        # Detect video vs image
        _, ext = os.path.splitext(file_path)
        if ext.lower() in VIDEO_EXTENSIONS:
            # Extract first frame from video using OpenCV
            cap = cv2.VideoCapture(file_path)
            if not cap.isOpened():
                raise RuntimeError(f"[MediaVault] Cannot open video: {file_path}")
            ret, frame = cap.read()
            cap.release()
            if not ret or frame is None:
                raise RuntimeError(f"[MediaVault] Cannot read frame from video: {file_path}")
            # OpenCV returns BGR, convert to RGBA
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            img = Image.fromarray(frame_rgb).convert("RGBA")
            print(f"[MediaVault] Extracted first frame from video: {os.path.basename(file_path)} ({frame_rgb.shape[1]}x{frame_rgb.shape[0]})")
        else:
            # Load image normally
            img = Image.open(file_path)
            img = img.convert("RGBA")
        image_np = np.array(img).astype(np.float32) / 255.0

        # Split RGB and Alpha
        rgb = image_np[:, :, :3]
        alpha = image_np[:, :, 3]

        image_tensor = torch.from_numpy(rgb).unsqueeze(0)  # [1, H, W, 3]
        mask_tensor = torch.from_numpy(1.0 - alpha).unsqueeze(0)  # [1, H, W]

        return (image_tensor, mask_tensor, file_path)


# ═══════════════════════════════════════════
#  Save To MediaVault
# ═══════════════════════════════════════════

# Formats that produce a single video file from the entire frame batch
VIDEO_FORMATS = {
    "mp4 (H.264)":   {"ext": "mp4",  "vcodec": "libx264",  "pix_fmt": "yuv420p"},
    "mp4 (H.265)":   {"ext": "mp4",  "vcodec": "libx265",  "pix_fmt": "yuv420p"},
    "webm (VP9)":     {"ext": "webm", "vcodec": "libvpx-vp9", "pix_fmt": "yuv420p"},
    "mov (ProRes)":   {"ext": "mov",  "vcodec": "prores_ks", "pix_fmt": "yuva444p10le", "profile": "4"},
    "avi (FFV1)":     {"ext": "avi",  "vcodec": "ffv1",     "pix_fmt": "yuv420p"},
}

IMAGE_FORMATS = ["png", "jpg", "webp"]

AUDIO_FORMATS = {
    "wav":  {"ext": "wav"},
    "flac": {"ext": "flac"},
    "mp3":  {"ext": "mp3"},
    "ogg":  {"ext": "ogg"},
}

ALL_FORMATS = IMAGE_FORMATS + list(VIDEO_FORMATS.keys())
ALL_FORMATS_WITH_AUDIO = ALL_FORMATS + list(AUDIO_FORMATS.keys())


class SaveToMediaVault:
    """
    Save ComfyUI outputs into MediaVault.
    - Image formats (png/jpg/webp): each frame saved as a separate file.
    - Video formats (mp4/webm/mov/avi): all frames encoded into one video.
    Select Project, Sequence, Shot, and Role to place the file correctly.
    """

    @classmethod
    def INPUT_TYPES(cls):
        # Static defaults — NEVER call API here (blocks ComfyUI startup)
        # The JS extension (mediavault_dynamic.js) populates dropdowns live
        return {
            "required": {
                "images": ("IMAGE",),
                "project": (["(Load MediaVault...)"], {"default": "(Load MediaVault...)"}),
                "sequence": (["* (All Sequences)"], {"default": "* (All Sequences)"}),
                "shot": (["* (All Shots)"], {"default": "* (All Shots)"}),
                "role": (["* (All Roles)"], {"default": "* (All Roles)"}),
                "custom_name": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": {
                "images_b": ("IMAGE", {"tooltip": "Optional second image batch for side-by-side A|B comparison video (doubles output width)"}),
                "audio": ("AUDIO", {"tooltip": "Optional audio to mux into the video file"}),
                "format": (ALL_FORMATS_WITH_AUDIO, {"default": "png"}),
                "quality": ("INT", {"default": 95, "min": 1, "max": 100, "step": 1,
                                    "tooltip": "Image: JPEG/WebP quality. Video: CRF (lower=better, 18-28 typical)"}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.01,
                                  "tooltip": "Frames per second for video output"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("saved_path",)
    FUNCTION = "save_output"
    CATEGORY = "MediaVault"
    OUTPUT_NODE = True

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # Dropdowns are dynamically populated by JS extension — skip combo validation
        return True

    def _resolve_ids(self, project, sequence, shot, role):
        """Resolve display names to IDs."""
        projects = get_projects()
        project_id = projects.get(project, "0")
        if project_id == "0":
            raise ValueError(f"[MediaVault] Project not found: {project}")

        sequences_map = get_sequences()
        sequence_id = sequences_map.get(sequence, "0")

        shots_map = get_shots()
        shot_id = shots_map.get(shot, "0")

        roles_map = get_roles()
        role_id = roles_map.get(role, "0")

        return project_id, sequence_id, shot_id, role_id

    def _send_to_vault(self, file_path, project_id, sequence_id, shot_id, role_id, custom_name, gen_info=None):
        """Upload a file to MediaVault via API."""
        save_data = {
            "file_path": os.path.abspath(file_path),
            "project_id": int(project_id),
            "custom_name": custom_name or None,
        }
        if sequence_id != "0":
            save_data["sequence_id"] = int(sequence_id)
        if shot_id != "0":
            save_data["shot_id"] = int(shot_id)
        if role_id != "0":
            save_data["role_id"] = int(role_id)
        if gen_info:
            save_data["generation_info"] = gen_info

        result = mv_api("/api/comfyui/save", method="POST", data=save_data, timeout=120)

        if result and result.get("asset"):
            vault_path = result["asset"].get("file_path", file_path)
            try:
                os.remove(file_path)
            except OSError:
                pass
            return vault_path
        else:
            print(f"[MediaVault] Warning: API save failed, file kept at {file_path}")
            return file_path

    def _save_images(self, images, format, quality, project_id, sequence_id, shot_id, role_id, custom_name, gen_info=None, extra_pnginfo=None, prompt=None):
        """Save frames as individual image files. Embeds ComfyUI workflow in PNG metadata."""
        saved_paths = []
        for i, image in enumerate(images):
            img_np = image.cpu().numpy()
            img_np = (img_np * 255).clip(0, 255).astype(np.uint8)
            img = Image.fromarray(img_np)

            timestamp = int(time.time() * 1000)
            name_part = custom_name if custom_name else "comfyui_output"
            if len(images) > 1:
                name_part += f"_{i + 1:03d}"
            temp_name = f"{name_part}_{timestamp}.{format}"
            temp_path = os.path.join(os.path.dirname(__file__), "..", "temp", temp_name)
            os.makedirs(os.path.dirname(temp_path), exist_ok=True)

            if format == "jpg":
                img = img.convert("RGB")
                img.save(temp_path, "JPEG", quality=quality)
            elif format == "webp":
                img.save(temp_path, "WEBP", quality=quality)
            else:
                # Embed workflow + prompt in PNG tEXt chunks (same as ComfyUI built-in save)
                metadata = PngInfo()
                if extra_pnginfo:
                    for key, value in extra_pnginfo.items():
                        metadata.add_text(key, json.dumps(value))
                if prompt:
                    metadata.add_text("prompt", json.dumps(prompt))
                img.save(temp_path, "PNG", pnginfo=metadata)

            vault_path = self._send_to_vault(temp_path, project_id, sequence_id, shot_id, role_id, custom_name, gen_info)
            saved_paths.append(vault_path)

        return saved_paths

    def _save_video(self, images, format, quality, fps, project_id, sequence_id, shot_id, role_id, custom_name, gen_info=None, audio=None, images_b=None, extra_pnginfo=None, prompt=None):
        """Encode all frames into a single video file via FFmpeg.
        Supports optional audio muxing, side-by-side A|B comparison,
        and embedding ComfyUI workflow in metadata comment."""
        vfmt = VIDEO_FORMATS[format]
        ext = vfmt["ext"]
        timestamp = int(time.time() * 1000)
        name_part = custom_name if custom_name else "comfyui_output"
        temp_dir = os.path.join(os.path.dirname(__file__), "..", "temp")
        os.makedirs(temp_dir, exist_ok=True)
        temp_video = os.path.join(temp_dir, f"{name_part}_{timestamp}.{ext}")

        # --- Side-by-side: determine composite frame dimensions ---
        h, w = images[0].shape[0], images[0].shape[1]
        num_frames_a = len(images)
        side_by_side = images_b is not None and len(images_b) > 0

        if side_by_side:
            h_b, w_b = images_b[0].shape[0], images_b[0].shape[1]
            num_frames_b = len(images_b)
            num_frames = max(num_frames_a, num_frames_b)
            # Heights must match for horizontal concat; use A's height as reference
            out_h = h
            scaled_w_b = w_b if h_b == h else int(w_b * h / h_b)
            out_w = w + scaled_w_b
            # H.264/H.265 with yuv420p require even width AND height
            if out_w % 2 != 0:
                out_w += 1
                scaled_w_b += 1  # pad B side by 1px
            if out_h % 2 != 0:
                out_h += 1
            print(f"[MediaVault] Side-by-side: A={w}x{h} ({num_frames_a}f) | B={w_b}x{h_b} ({num_frames_b}f) → {out_w}x{out_h}")
        else:
            num_frames = num_frames_a
            out_h, out_w = h, w
            # Ensure even dimensions for YUV 4:2:0 codecs
            if out_w % 2 != 0:
                out_w += 1
            if out_h % 2 != 0:
                out_h += 1

        print(f"[MediaVault] Encoding {num_frames} frames → {format} ({out_w}x{out_h} @ {fps}fps)")

        # --- Prepare optional audio temp file ---
        temp_audio = None
        if audio is not None:
            try:
                waveform = audio["waveform"]  # [batch, channels, samples]
                sample_rate = audio["sample_rate"]
                wav_data = waveform.squeeze(0)  # [channels, samples]
                if wav_data.dim() == 1:
                    wav_data = wav_data.unsqueeze(0)
                temp_audio = os.path.join(temp_dir, f"{name_part}_{timestamp}_audio.wav")
                if TORCHAUDIO_AVAILABLE:
                    torchaudio.save(temp_audio, wav_data.cpu(), sample_rate)
                else:
                    import wave
                    wav_np = (wav_data.cpu().numpy() * 32767).clip(-32768, 32767).astype(np.int16)
                    n_channels = wav_np.shape[0]
                    with wave.open(temp_audio, 'wb') as wf:
                        wf.setnchannels(n_channels)
                        wf.setsampwidth(2)
                        wf.setframerate(sample_rate)
                        wf.writeframes(wav_np.T.tobytes())
                print(f"[MediaVault] Audio: {sample_rate}Hz, {wav_data.shape[0]}ch, {wav_data.shape[1]} samples")
            except Exception as e:
                print(f"[MediaVault] ⚠ Audio prep failed, encoding video without audio: {e}")
                temp_audio = None

        # --- Build FFmpeg command (inputs section) ---
        cmd = [
            "ffmpeg", "-y",
            "-f", "rawvideo",
            "-vcodec", "rawvideo",
            "-s", f"{out_w}x{out_h}",
            "-pix_fmt", "rgb24",
            "-r", str(fps),
            "-i", "pipe:0",
        ]

        # Add audio input if available
        if temp_audio:
            cmd += ["-i", temp_audio]

        # Embed workflow JSON as metadata comment (same format as VHS Video Combine)
        # NOTE: Write to a temp metadata file instead of passing on the command line,
        # because Windows has a ~32K character limit on command lines and workflow
        # JSON can easily exceed that (WinError 206).
        # IMPORTANT: The metadata -i MUST come before output options (codec, crf, etc.)
        # or FFmpeg applies output options to the metadata input and fails.
        workflow_json = None
        metadata_path = None
        metadata_input_idx = None  # Track which input index the metadata is
        if extra_pnginfo and "workflow" in extra_pnginfo:
            try:
                workflow_json = json.dumps(extra_pnginfo["workflow"])
                # Write FFmpeg metadata file format: https://ffmpeg.org/ffmpeg-formats.html#metadata-1
                metadata_file = tempfile.NamedTemporaryFile(
                    mode='w', suffix='.txt', delete=False,
                    prefix='mv_meta_', encoding='utf-8'
                )
                metadata_path = metadata_file.name
                metadata_file.write(";FFMETADATA1\n")
                # Escape special chars per FFmpeg metadata spec: = ; # \ and newline
                escaped = workflow_json.replace("\\", "\\\\").replace("=", "\\=").replace(";", "\\;").replace("#", "\\#").replace("\n", "\\\n")
                metadata_file.write(f"comment={escaped}\n")
                metadata_file.close()
                # Input index: 0=pipe, 1=audio(if present) or metadata, etc.
                metadata_input_idx = 2 if temp_audio else 1
                cmd += ["-f", "ffmetadata", "-i", metadata_path]
                print(f"[MediaVault] Embedding workflow metadata via file ({len(workflow_json)} chars)")
            except Exception as e:
                print(f"[MediaVault] ⚠ Could not embed workflow: {e}")
                metadata_path = None

        # --- Output options (codec, quality, etc.) ---
        # Video codec settings
        cmd += ["-vcodec", vfmt["vcodec"], "-pix_fmt", vfmt["pix_fmt"]]

        if vfmt["vcodec"] == "libx264":
            crf = max(0, min(51, 51 - int(quality * 51 / 100)))
            cmd += ["-crf", str(crf), "-preset", "medium"]
        elif vfmt["vcodec"] == "libx265":
            crf = max(0, min(51, 51 - int(quality * 51 / 100)))
            cmd += ["-crf", str(crf), "-preset", "medium", "-tag:v", "hvc1"]
        elif vfmt["vcodec"] == "libvpx-vp9":
            crf = max(0, min(63, 63 - int(quality * 63 / 100)))
            cmd += ["-crf", str(crf), "-b:v", "0"]
        elif vfmt["vcodec"] == "prores_ks":
            cmd += ["-profile:v", vfmt.get("profile", "3")]
        elif vfmt["vcodec"] == "ffv1":
            cmd += ["-level", "3"]

        # Audio codec (when audio is present)
        if temp_audio:
            if ext == "mp4" or ext == "mov":
                cmd += ["-acodec", "aac", "-b:a", "192k"]
            elif ext == "webm":
                cmd += ["-acodec", "libvorbis", "-b:a", "192k"]
            elif ext == "avi":
                cmd += ["-acodec", "pcm_s16le"]
            cmd += ["-shortest"]

        # Map metadata from the metadata input file (if we have one)
        if metadata_input_idx is not None:
            cmd += ["-map_metadata", str(metadata_input_idx)]

        cmd.append(os.path.abspath(temp_video))
        print(f"[MediaVault] FFmpeg cmd: {' '.join(cmd[:20])}{'...' if len(cmd) > 20 else ''}")

        # --- Redirect stderr to temp file to avoid Windows pipe deadlock ---
        stderr_file = tempfile.NamedTemporaryFile(mode='w', suffix='.log', delete=False, prefix='mv_ffmpeg_')
        stderr_path = stderr_file.name

        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=stderr_file,
        )

        # --- Feed frames to FFmpeg (with BrokenPipeError handling) ---
        try:
            for i in range(num_frames):
                # Get frame A (hold last if past end)
                idx_a = min(i, num_frames_a - 1)
                frame_a = images[idx_a].cpu().numpy()
                frame_a = (frame_a * 255).clip(0, 255).astype(np.uint8)

                if side_by_side:
                    idx_b = min(i, num_frames_b - 1)
                    frame_b = images_b[idx_b].cpu().numpy()
                    frame_b = (frame_b * 255).clip(0, 255).astype(np.uint8)
                    # Resize B to match A's height if needed
                    if frame_b.shape[0] != h:
                        new_w = int(frame_b.shape[1] * h / frame_b.shape[0])
                        frame_b = cv2.resize(frame_b, (new_w, h), interpolation=cv2.INTER_LANCZOS4)
                    frame_np = np.concatenate([frame_a, frame_b], axis=1)
                else:
                    frame_np = frame_a

                # Pad to match declared out_w x out_h (even-dimension enforcement)
                if frame_np.shape[1] != out_w or frame_np.shape[0] != out_h:
                    padded = np.zeros((out_h, out_w, 3), dtype=np.uint8)
                    padded[:frame_np.shape[0], :frame_np.shape[1]] = frame_np
                    frame_np = padded

                proc.stdin.write(frame_np.tobytes())
        except (BrokenPipeError, OSError) as e:
            print(f"[MediaVault] ⚠ FFmpeg stdin pipe broke ({type(e).__name__}: {e}) — reading error log...")

        proc.stdin.close()
        proc.wait()
        stderr_file.close()

        # Read FFmpeg log
        ffmpeg_log = ""
        try:
            with open(stderr_path, 'r', errors='replace') as f:
                ffmpeg_log = f.read()
        except Exception:
            pass
        finally:
            try:
                os.remove(stderr_path)
            except OSError:
                pass

        # Clean up metadata temp file
        if metadata_path:
            try:
                os.remove(metadata_path)
            except OSError:
                pass

        if proc.returncode != 0:
            err_tail = ffmpeg_log[-500:] if ffmpeg_log else "(no log)"
            raise RuntimeError(f"[MediaVault] FFmpeg encode failed (exit {proc.returncode}):\n{err_tail}")

        # Clean up temp audio
        if temp_audio:
            try:
                os.remove(temp_audio)
            except OSError:
                pass

        file_size = os.path.getsize(temp_video)
        print(f"[MediaVault] ✓ Video saved: {os.path.basename(temp_video)} ({file_size / 1024 / 1024:.1f} MB)")

        vault_path = self._send_to_vault(temp_video, project_id, sequence_id, shot_id, role_id, custom_name, gen_info)
        return [vault_path]

    def _save_audio(self, audio, format, project_id, sequence_id, shot_id, role_id, custom_name, gen_info=None):
        """Save standalone audio file."""
        afmt = AUDIO_FORMATS[format]
        ext = afmt["ext"]
        timestamp = int(time.time() * 1000)
        name_part = custom_name if custom_name else "comfyui_output"
        temp_dir = os.path.join(os.path.dirname(__file__), "..", "temp")
        os.makedirs(temp_dir, exist_ok=True)
        temp_audio = os.path.join(temp_dir, f"{name_part}_{timestamp}.{ext}")

        waveform = audio["waveform"].squeeze(0)  # [channels, samples]
        sample_rate = audio["sample_rate"]
        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0)

        if TORCHAUDIO_AVAILABLE:
            torchaudio.save(temp_audio, waveform.cpu(), sample_rate)
        else:
            # Fallback: save WAV then convert with FFmpeg
            import wave
            temp_wav = temp_audio + ".tmp.wav"
            wav_np = (waveform.cpu().numpy() * 32767).clip(-32768, 32767).astype(np.int16)
            n_channels = wav_np.shape[0]
            with wave.open(temp_wav, 'wb') as wf:
                wf.setnchannels(n_channels)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(wav_np.T.tobytes())
            if ext == "wav":
                shutil.move(temp_wav, temp_audio)
            else:
                subprocess.run(["ffmpeg", "-y", "-i", temp_wav, temp_audio],
                               capture_output=True, check=True)
                os.remove(temp_wav)

        file_size = os.path.getsize(temp_audio)
        print(f"[MediaVault] ✓ Audio saved: {os.path.basename(temp_audio)} ({file_size / 1024:.1f} KB)")

        vault_path = self._send_to_vault(temp_audio, project_id, sequence_id, shot_id, role_id, custom_name, gen_info)
        return [vault_path]

    @staticmethod
    def _extract_generation_info(prompt):
        """
        Scan the ComfyUI prompt dict for known node types and extract
        generation parameters (model, sampler, scheduler, steps, CFG, seed, etc.).
        """
        if not prompt or not isinstance(prompt, dict):
            return {}

        info = {}

        # Map of ComfyUI class_type → which fields to grab
        CHECKPOINT_TYPES = {"CheckpointLoaderSimple", "CheckpointLoader", "UNETLoader",
                           "unCLIPCheckpointLoader"}
        SAMPLER_TYPES = {"KSampler", "KSamplerAdvanced", "SamplerCustom",
                        "KSamplerSelect"}
        CLIP_TYPES = {"CLIPTextEncode", "CLIPTextEncodeSDXL"}
        LORA_TYPES = {"LoraLoader", "LoraLoaderModelOnly"}
        VAE_TYPES = {"VAELoader"}
        UPSCALE_TYPES = {"UpscaleModelLoader"}

        loras = []
        positive_prompts = []
        negative_prompts = []

        for node_id, node_data in prompt.items():
            ct = node_data.get("class_type", "")
            inputs = node_data.get("inputs", {})

            # Checkpoint / Model
            if ct in CHECKPOINT_TYPES:
                ckpt = inputs.get("ckpt_name") or inputs.get("unet_name") or ""
                if ckpt:
                    info["model"] = ckpt

            # Sampler / Scheduler
            if ct in SAMPLER_TYPES:
                for key in ["sampler_name", "sampler"]:
                    if key in inputs and isinstance(inputs[key], str):
                        info["sampler"] = inputs[key]
                if "scheduler" in inputs and isinstance(inputs["scheduler"], str):
                    info["scheduler"] = inputs["scheduler"]
                if "steps" in inputs and isinstance(inputs["steps"], (int, float)):
                    info["steps"] = int(inputs["steps"])
                if "cfg" in inputs and isinstance(inputs["cfg"], (int, float)):
                    info["cfg"] = round(float(inputs["cfg"]), 2)
                if "seed" in inputs and isinstance(inputs["seed"], (int, float)):
                    info["seed"] = int(inputs["seed"])
                if "denoise" in inputs and isinstance(inputs["denoise"], (int, float)):
                    info["denoise"] = round(float(inputs["denoise"]), 3)

            # CLIP text (positive / negative)
            if ct in CLIP_TYPES:
                text = inputs.get("text", "")
                if isinstance(text, str) and text.strip():
                    # Heuristic: try to classify as positive or negative
                    # by checking if this node's output feeds a "negative" input
                    # Fallback: just collect all
                    positive_prompts.append(text.strip())

            # LoRAs
            if ct in LORA_TYPES:
                lora_name = inputs.get("lora_name", "")
                strength = inputs.get("strength_model", 1.0)
                if lora_name:
                    loras.append({"name": lora_name, "strength": round(float(strength), 2)})

            # VAE
            if ct in VAE_TYPES:
                vae = inputs.get("vae_name", "")
                if vae:
                    info["vae"] = vae

            # Upscale model
            if ct in UPSCALE_TYPES:
                model = inputs.get("model_name", "")
                if model:
                    info["upscale_model"] = model

        if loras:
            info["loras"] = loras
        if positive_prompts:
            info["prompt"] = positive_prompts[0] if len(positive_prompts) == 1 else positive_prompts

        return info

    def save_output(self, images, project, custom_name="", format="png", quality=95, fps=24.0,
                    sequence="* (All Sequences)", shot="* (All Shots)", role="* (All Roles)",
                    prompt=None, extra_pnginfo=None, audio=None, images_b=None):
        project_id, sequence_id, shot_id, role_id = self._resolve_ids(project, sequence, shot, role)

        # Extract generation metadata from prompt
        gen_info = self._extract_generation_info(prompt)
        if gen_info:
            print(f"[MediaVault] Generation info captured: model={gen_info.get('model','?')}, "
                  f"sampler={gen_info.get('sampler','?')}, steps={gen_info.get('steps','?')}")

        if format in VIDEO_FORMATS:
            saved_paths = self._save_video(images, format, quality, fps,
                                           project_id, sequence_id, shot_id, role_id, custom_name, gen_info,
                                           audio=audio, images_b=images_b,
                                           extra_pnginfo=extra_pnginfo, prompt=prompt)
        elif format in AUDIO_FORMATS:
            if audio is None:
                raise ValueError("[MediaVault] Audio format selected but no audio input connected!")
            saved_paths = self._save_audio(audio, format,
                                           project_id, sequence_id, shot_id, role_id, custom_name, gen_info)
        else:
            saved_paths = self._save_images(images, format, quality,
                                            project_id, sequence_id, shot_id, role_id, custom_name, gen_info,
                                            extra_pnginfo=extra_pnginfo, prompt=prompt)

        return (", ".join(saved_paths),)


# ═══════════════════════════════════════════
#  Load Video From MediaVault
# ═══════════════════════════════════════════
class LoadVideoFromMediaVault:
    """
    Load a full video from MediaVault as a batch of frames.
    Returns IMAGE tensor [N, H, W, 3] suitable for video workflows.
    Browse by Project → Sequence → Shot → Role to find your video.

    Controls:
      frame_start  – first frame to load (0 = beginning)
      frame_end    – last frame to load (0 = all remaining)
      frame_step   – load every Nth frame (1 = every frame, 2 = every other, etc.)
      max_frames   – hard cap to avoid OOM (0 = no limit)
    """

    @classmethod
    def INPUT_TYPES(cls):
        # Static defaults — NEVER call API here (blocks ComfyUI startup)
        # The JS extension (mediavault_dynamic.js) populates dropdowns live
        return {
            "required": {
                "project": (["(Load MediaVault...)"], {"default": "(Load MediaVault...)"}),
                "sequence": (["* (All Sequences)"], {"default": "* (All Sequences)"}),
                "shot": (["* (All Shots)"], {"default": "* (All Shots)"}),
                "role": (["* (All Roles)"], {"default": "* (All Roles)"}),
                "asset": (["(Select project first)"], {"default": "(Select project first)"}),
            },
            "optional": {
                "force_rate": ("INT", {"default": 0, "min": 0, "max": 120, "step": 1,
                                       "tooltip": "Force output FPS. 0 = use the video's native fps."}),
                "custom_width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1,
                                         "tooltip": "Resize width. 0 = original. If only width is set, height scales proportionally."}),
                "custom_height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1,
                                          "tooltip": "Resize height. 0 = original. If only height is set, width scales proportionally."}),
                "frame_load_cap": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1,
                                           "tooltip": "Maximum number of frames to load. 0 = no limit (load entire video)."}),
                "skip_first_frames": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1,
                                              "tooltip": "Skip this many frames from the beginning of the video."}),
                "select_every_nth": ("INT", {"default": 1, "min": 1, "max": 100, "step": 1,
                                             "tooltip": "1 = every frame, 2 = every other frame, 3 = every 3rd, etc."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "INT", "FLOAT", "VHS_VIDEOINFO")
    RETURN_NAMES = ("images", "file_path", "frame_count", "fps", "video_info")
    FUNCTION = "load_video"
    CATEGORY = "MediaVault"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # Dropdowns are dynamically populated by JS extension — skip combo validation
        return True

    def load_video(self, project, asset,
                   sequence="* (All Sequences)", shot="* (All Shots)", role="* (All Roles)",
                   force_rate=0, custom_width=0, custom_height=0,
                   frame_load_cap=0, skip_first_frames=0, select_every_nth=1,
                   **kwargs):

        # Defensive coercion — saved workflows with old param names may send None / ""
        def _int(v, default):
            if v is None or v == "":
                return default
            try:
                return int(v)
            except (ValueError, TypeError):
                return default

        force_rate = _int(force_rate, 0)
        custom_width = _int(custom_width, 0)
        custom_height = _int(custom_height, 0)
        frame_load_cap = _int(frame_load_cap, 0)
        skip_first_frames = _int(skip_first_frames, 0)
        select_every_nth = max(1, _int(select_every_nth, 1))

        # Resolve hierarchy IDs
        projects = get_projects()
        project_id = projects.get(project, "0")

        sequences_map = get_sequences()
        sequence_id = sequences_map.get(sequence, "0")

        shots_map = get_shots()
        shot_id = shots_map.get(shot, "0")

        roles_map = get_roles()
        role_id = roles_map.get(role, "0")

        assets = get_assets(
            project_id=project_id if project_id != "0" else None,
            sequence_id=sequence_id if sequence_id != "0" else None,
            shot_id=shot_id if shot_id != "0" else None,
            role_id=role_id if role_id != "0" else None,
        )
        asset_id = assets.get(asset, "0")

        if asset_id == "0":
            all_project_assets = get_assets(
                project_id=project_id if project_id != "0" else None
            )
            asset_id = all_project_assets.get(asset, "0")

        if asset_id == "0":
            all_assets = get_assets()
            asset_id = all_assets.get(asset, "0")

        file_path = get_asset_path(asset_id)

        if not file_path or not os.path.exists(file_path):
            raise FileNotFoundError(f"[MediaVault] Video not found: {asset} (id={asset_id})")

        cap = cv2.VideoCapture(file_path)
        if not cap.isOpened():
            raise RuntimeError(f"[MediaVault] Cannot open video: {file_path}")

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
        source_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        source_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        source_duration = total_frames / fps if fps > 0 else 0.0

        # Resolve range
        start = min(skip_first_frames, total_frames - 1) if skip_first_frames > 0 else 0
        step = max(1, select_every_nth)

        # Determine target resize dimensions
        resize_w, resize_h = 0, 0
        if custom_width > 0 and custom_height > 0:
            resize_w, resize_h = custom_width, custom_height
        elif custom_width > 0:
            # Scale height proportionally
            resize_w = custom_width
            resize_h = int(source_height * (custom_width / source_width))
        elif custom_height > 0:
            # Scale width proportionally
            resize_h = custom_height
            resize_w = int(source_width * (custom_height / source_height))

        # Determine output FPS
        output_fps = float(force_rate) if force_rate > 0 else fps
        # Effective fps accounts for frame stepping
        effective_fps = output_fps / step if step > 1 and force_rate == 0 else output_fps

        resize_label = f", resize={resize_w}×{resize_h}" if resize_w > 0 else ""
        rate_label = f", force_rate={force_rate}" if force_rate > 0 else ""
        cap_label = f", cap={frame_load_cap}" if frame_load_cap > 0 else ""
        print(f"[MediaVault] Loading video: {os.path.basename(file_path)}")
        print(f"[MediaVault]   Source: {total_frames} frames @ {fps:.2f} fps, {source_width}×{source_height}")
        print(f"[MediaVault]   Settings: skip={start}, step={step}{cap_label}{rate_label}{resize_label}")

        frames = []
        cap.set(cv2.CAP_PROP_POS_FRAMES, start)
        idx = start

        while idx < total_frames:
            if frame_load_cap > 0 and len(frames) >= frame_load_cap:
                print(f"[MediaVault]   Hit frame_load_cap ({frame_load_cap})")
                break

            ret, frame = cap.read()
            if not ret:
                break

            if (idx - start) % step == 0:
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                # Resize if custom dimensions are set
                if resize_w > 0 and resize_h > 0:
                    frame_rgb = cv2.resize(frame_rgb, (resize_w, resize_h),
                                           interpolation=cv2.INTER_LANCZOS4)

                frame_np = frame_rgb.astype(np.float32) / 255.0
                frames.append(frame_np)

            idx += 1

        cap.release()

        if not frames:
            raise RuntimeError(f"[MediaVault] No frames read from video: {file_path}")

        # Stack into batch tensor [N, H, W, 3]
        image_tensor = torch.from_numpy(np.stack(frames, axis=0))
        loaded = image_tensor.shape[0]
        loaded_width = image_tensor.shape[2]
        loaded_height = image_tensor.shape[1]
        loaded_duration = loaded / effective_fps if effective_fps > 0 else 0.0
        print(f"[MediaVault]   Loaded {loaded} frames → {loaded_width}×{loaded_height} @ {effective_fps:.2f} fps")

        video_info = {
            "source_fps": fps,
            "source_frame_count": total_frames,
            "source_duration": source_duration,
            "source_width": source_width,
            "source_height": source_height,
            "loaded_fps": effective_fps,
            "loaded_frame_count": loaded,
            "loaded_duration": loaded_duration,
            "loaded_width": loaded_width,
            "loaded_height": loaded_height,
        }

        return (image_tensor, file_path, loaded, effective_fps, video_info)


# ═══════════════════════════════════════════
#  ComfyUI Registration
# ═══════════════════════════════════════════
NODE_CLASS_MAPPINGS = {
    "LoadFromMediaVault": LoadFromMediaVault,
    "SaveToMediaVault": SaveToMediaVault,
    "LoadVideoFromMediaVault": LoadVideoFromMediaVault,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadFromMediaVault": "📂 Load from MediaVault",
    "SaveToMediaVault": "💾 Save to MediaVault",
    "LoadVideoFromMediaVault": "🎬 Load Video (MediaVault)",
}
