"""
MediaVault ComfyUI Custom Nodes

Install: Symlink or copy this folder to ComfyUI/custom_nodes/mediavault/
"""

from .mediavault_node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

WEB_DIRECTORY = "./js"
