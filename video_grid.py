"""Disk-backed video cells: no persistent tensors or module-level sessions."""
import json
import math
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import folder_paths
from comfy.cli_args import args
from comfy.model_management import throw_exception_if_processing_interrupted
import numpy as np
import torch

from .grid_export import export_geometry, export_grid as encode_grid


def json_safe(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [json_safe(v) for v in value]
    return value


def checked_state(raw):
    state = json.loads(raw)
    if not isinstance(state, dict):
        raise ValueError("Grid state must be an object")
    if not state:
        return {"session": uuid.uuid4().hex, "cols": 1, "rows": 1, "xi": 0, "yi": 0,
                "xLabels": ["Video"], "yLabels": [""]}
    session = state.get("session", "")
    if not isinstance(session, str) or len(session) != 32 or any(c not in "0123456789abcdef" for c in session):
        raise ValueError("Invalid grid session")
    for name in ("cols", "rows", "xi", "yi"):
        if type(state.get(name)) is not int:
            raise ValueError(f"{name} must be an integer")
    if not (1 <= state["cols"] <= 64 and 1 <= state["rows"] <= 64
            and state["cols"] * state["rows"] <= 256):
        raise ValueError("Grid is limited to 256 cells and 64 values per axis")
    if not (0 <= state["xi"] < state["cols"] and 0 <= state["yi"] < state["rows"]):
        raise ValueError("Cell lies outside grid")
    for key, count in (("xLabels", state["cols"]), ("yLabels", state["rows"])):
        labels = state.get(key)
        if not isinstance(labels, list) or len(labels) != count or any(not isinstance(v, str) or len(v) > 10000 for v in labels):
            raise ValueError(f"Invalid {key}")
    return state


def encode_frames(images, target, fps, crf):
    if len(images.shape) != 4 or images.shape[-1] not in (3, 4) or images.shape[0] < 1:
        raise ValueError("Connect an IMAGE batch shaped [frames, height, width, RGB/RGBA]")
    _, height, width, _ = images.shape
    if min(height, width) < 1:
        raise ValueError("Video dimensions cannot be empty")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required. On CachyOS: sudo pacman -S ffmpeg")
    args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
            "-pixel_format", "rgb24", "-video_size", f"{width}x{height}",
            "-framerate", str(fps), "-i", "pipe:0", "-an", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-c:v", "libx264", "-preset", "fast", "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(target)]
    # File-backed stderr cannot fill a pipe and deadlock while frames are written.
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors)
        try:
            for frame in images:
                throw_exception_if_processing_interrupted()
                array = frame[..., :3].detach().to(device="cpu", dtype=torch.float32).numpy()
                array = np.nan_to_num(array, nan=0, posinf=1, neginf=0)
                process.stdin.write((np.clip(array, 0, 1) * 255).round().astype(np.uint8).tobytes())
            process.stdin.close()
            code = process.wait(timeout=300)
            if code:
                errors.seek(0)
                raise RuntimeError("FFmpeg: " + errors.read()[-4000:].decode(errors="replace"))
        except BaseException as exc:
            process.kill()
            process.wait()
            errors.seek(0)
            detail = errors.read()[-4000:].decode(errors="replace")
            if isinstance(exc, BrokenPipeError):
                raise RuntimeError("FFmpeg stopped accepting frames: " + (detail or "encoder exited unexpectedly")) from exc
            raise
        finally:
            if process.stdin and not process.stdin.closed:
                try:
                    process.stdin.close()
                except OSError:
                    pass


class MagikVideoGrid:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "fps": ("FLOAT", {"default": 24.0, "min": 0.1, "max": 240.0, "step": 0.1}),
            "crf": ("INT", {"default": 20, "min": 0, "max": 40}),
            "grid_state": ("STRING", {"default": "{}", "multiline": False}),
        }, "optional": {
            "export_grid": ("BOOLEAN", {"default": False}),
            "tile_width": ("INT", {"default": 480, "min": 128, "max": 1280, "step": 2}),
            "tile_height": ("INT", {"default": 270, "min": 72, "max": 720, "step": 2}),
            "duration_mode": (["shortest", "longest_hold"],),
        }, "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("images", "cell_path", "grid_path")
    FUNCTION = "execute"
    CATEGORY = "Magik/Video"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def execute(self, images, fps=24.0, crf=20, grid_state="{}", prompt=None, extra_pnginfo=None,
                export_grid=False, tile_width=480, tile_height=270, duration_mode="shortest"):
        state = checked_state(grid_state)
        if not math.isfinite(fps) or not 0.1 <= fps <= 240:
            raise ValueError("FPS must be between 0.1 and 240")
        if type(crf) is not int or not 0 <= crf <= 40:
            raise ValueError("CRF must be between 0 and 40")
        if export_grid:
            export_geometry(state["cols"], state["rows"], tile_width, tile_height)
            if duration_mode not in ("shortest", "longest_hold"):
                raise ValueError("Unknown export duration policy")
        # Serialize metadata before encoding, so metadata errors cannot leave a
        # completed clip reported as a failed generation. Honor ComfyUI's flag.
        metadata = dict(state, fps=fps, crf=crf, frame_count=int(images.shape[0]))
        record = dict(metadata)
        if not getattr(args, "disable_metadata", False):
            record.update(prompt=prompt, workflow=(extra_pnginfo or {}).get("workflow"))
        record_json = json.dumps(json_safe(record), ensure_ascii=False, indent=2, allow_nan=False)
        relative = Path("magik_video_grid") / state["session"]
        directory = Path(folder_paths.get_output_directory()) / relative
        directory.mkdir(parents=True, exist_ok=True)
        filename = f"cell_{state['yi']:03d}_{state['xi']:03d}.mp4"
        target = directory / filename
        partial = directory / (uuid.uuid4().hex + ".mp4")
        try:
            encode_frames(images, partial, fps, crf)
            throw_exception_if_processing_interrupted()
            # Both writes use private files; cancellation cannot publish a partial MP4.
            partial.with_suffix(".json").write_text(record_json, encoding="utf-8")
            os.replace(partial, target)
            os.replace(partial.with_suffix(".json"), target.with_suffix(".json"))
        finally:
            partial.unlink(missing_ok=True)
            partial.with_suffix(".json").unlink(missing_ok=True)
        cell = dict(metadata, filename=filename, subfolder=relative.as_posix(), type="output")
        ui = {"magik_video_cell": [cell]}
        grid_path = ""
        if export_grid:
            try:
                result = encode_grid(directory, state, fps, crf, tile_width, tile_height, duration_mode)
                if result:
                    grid_path = str(directory / "grid.mp4")
                    ui["magik_video_export"] = [dict(result, filename="grid.mp4", subfolder=relative.as_posix(), type="output")]
            except (OSError, ValueError, RuntimeError) as error:
                throw_exception_if_processing_interrupted()
                # A failed optional composition must not hide successfully saved cells.
                ui["magik_video_export_error"] = [str(error)]
        return {"ui": ui, "result": (images, str(target), grid_path)}
