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
import torch
import cv2

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

    print("[MediaVault] ✓ Dynamic dropdown routes registered on ComfyUI server")

except ImportError:
    print("[MediaVault] ⚠ PromptServer not available — dynamic dropdowns disabled (standalone mode?)")


# ═══════════════════════════════════════════
#  API Helpers
# ═══════════════════════════════════════════
def mv_api(path, method="GET", data=None):
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
        with urllib.request.urlopen(req, timeout=3) as resp:
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
ALL_FORMATS = IMAGE_FORMATS + list(VIDEO_FORMATS.keys())


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
                "format": (ALL_FORMATS, {"default": "png"}),
                "quality": ("INT", {"default": 95, "min": 1, "max": 100, "step": 1,
                                    "tooltip": "Image: JPEG/WebP quality. Video: CRF (lower=better, 18-28 typical)"}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.01,
                                  "tooltip": "Frames per second for video output"}),
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

    def _send_to_vault(self, file_path, project_id, sequence_id, shot_id, role_id, custom_name):
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

        result = mv_api("/api/comfyui/save", method="POST", data=save_data)

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

    def _save_images(self, images, format, quality, project_id, sequence_id, shot_id, role_id, custom_name):
        """Save frames as individual image files."""
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
                img.save(temp_path, "PNG")

            vault_path = self._send_to_vault(temp_path, project_id, sequence_id, shot_id, role_id, custom_name)
            saved_paths.append(vault_path)

        return saved_paths

    def _save_video(self, images, format, quality, fps, project_id, sequence_id, shot_id, role_id, custom_name):
        """Encode all frames into a single video file via FFmpeg."""
        vfmt = VIDEO_FORMATS[format]
        ext = vfmt["ext"]
        timestamp = int(time.time() * 1000)
        name_part = custom_name if custom_name else "comfyui_output"
        temp_video = os.path.join(os.path.dirname(__file__), "..", "temp", f"{name_part}_{timestamp}.{ext}")
        os.makedirs(os.path.dirname(temp_video), exist_ok=True)

        # Get frame dimensions from first image
        h, w = images[0].shape[0], images[0].shape[1]
        num_frames = len(images)

        print(f"[MediaVault] Encoding {num_frames} frames → {format} ({w}x{h} @ {fps}fps)")

        # Build FFmpeg command: pipe raw RGB frames in, encode to file
        cmd = [
            "ffmpeg", "-y",
            "-f", "rawvideo",
            "-vcodec", "rawvideo",
            "-s", f"{w}x{h}",
            "-pix_fmt", "rgb24",
            "-r", str(fps),
            "-i", "pipe:0",
            "-vcodec", vfmt["vcodec"],
            "-pix_fmt", vfmt["pix_fmt"],
        ]

        # Codec-specific quality settings
        if vfmt["vcodec"] == "libx264":
            crf = max(0, min(51, 51 - int(quality * 51 / 100)))  # quality 95→2, quality 50→25
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

        cmd.append(os.path.abspath(temp_video))

        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # Feed frames to FFmpeg
        for i, image in enumerate(images):
            frame_np = image.cpu().numpy()
            frame_np = (frame_np * 255).clip(0, 255).astype(np.uint8)
            proc.stdin.write(frame_np.tobytes())

        proc.stdin.close()
        _, stderr = proc.communicate()

        if proc.returncode != 0:
            err_msg = stderr.decode("utf-8", errors="replace")[-500:]
            raise RuntimeError(f"[MediaVault] FFmpeg encode failed (exit {proc.returncode}):\n{err_msg}")

        file_size = os.path.getsize(temp_video)
        print(f"[MediaVault] ✓ Video saved: {os.path.basename(temp_video)} ({file_size / 1024 / 1024:.1f} MB)")

        vault_path = self._send_to_vault(temp_video, project_id, sequence_id, shot_id, role_id, custom_name)
        return [vault_path]

    def save_output(self, images, project, custom_name="", format="png", quality=95, fps=24.0,
                    sequence="* (All Sequences)", shot="* (All Shots)", role="* (All Roles)"):
        project_id, sequence_id, shot_id, role_id = self._resolve_ids(project, sequence, shot, role)

        if format in VIDEO_FORMATS:
            saved_paths = self._save_video(images, format, quality, fps,
                                           project_id, sequence_id, shot_id, role_id, custom_name)
        else:
            saved_paths = self._save_images(images, format, quality,
                                            project_id, sequence_id, shot_id, role_id, custom_name)

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
                "frame_start": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
                "frame_end": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1,
                                      "tooltip": "0 = load to end of video"}),
                "frame_step": ("INT", {"default": 1, "min": 1, "max": 100, "step": 1,
                                       "tooltip": "1 = every frame, 2 = every other frame, etc."}),
                "max_frames": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1,
                                       "tooltip": "0 = no limit (careful with long videos!)"}),
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
                   frame_start=0, frame_end=0, frame_step=1, max_frames=0):

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
        start = min(frame_start, total_frames - 1)
        end = total_frames if frame_end <= 0 else min(frame_end + 1, total_frames)
        step = max(1, frame_step)

        print(f"[MediaVault] Loading video: {os.path.basename(file_path)}")
        print(f"[MediaVault]   Total: {total_frames} frames @ {fps:.2f} fps")
        print(f"[MediaVault]   Range: {start}–{end - 1}, step={step}")

        frames = []
        cap.set(cv2.CAP_PROP_POS_FRAMES, start)
        idx = start

        while idx < end:
            if max_frames > 0 and len(frames) >= max_frames:
                print(f"[MediaVault]   Hit max_frames cap ({max_frames})")
                break

            ret, frame = cap.read()
            if not ret:
                break

            if (idx - start) % step == 0:
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
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
        loaded_fps = fps / step if step > 0 else fps
        loaded_duration = loaded / loaded_fps if loaded_fps > 0 else 0.0
        print(f"[MediaVault]   Loaded {loaded} frames → tensor {list(image_tensor.shape)}")

        video_info = {
            "source_fps": fps,
            "source_frame_count": total_frames,
            "source_duration": source_duration,
            "source_width": source_width,
            "source_height": source_height,
            "loaded_fps": loaded_fps,
            "loaded_frame_count": loaded,
            "loaded_duration": loaded_duration,
            "loaded_width": loaded_width,
            "loaded_height": loaded_height,
        }

        return (image_tensor, file_path, loaded, fps, video_info)


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
