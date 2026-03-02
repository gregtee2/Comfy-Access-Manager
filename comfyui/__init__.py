# Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
# This source code is proprietary and confidential. Unauthorized copying,
# modification, distribution, or use of this file is strictly prohibited.
# See LICENSE file for details.
"""
MediaVault ComfyUI Custom Nodes

Install: Symlink or copy this folder to ComfyUI/custom_nodes/mediavault/
"""

from .mediavault_node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

WEB_DIRECTORY = "./js"
