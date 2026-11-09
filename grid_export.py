"""Compose saved clips with FFmpeg; never load video batches into Python RAM."""
import json
import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from comfy.model_management import throw_exception_if_processing_interrupted
from PIL import Image, ImageDraw, ImageFont

MAX_EXPORT_CELLS = 16
MAX_EXPORT_SIDE = 8192
GAP = 8
CAPTION = 88


def export_geometry(cols, rows, tile_width, tile_height):
    for name, value, low, high in (("tile_width", tile_width, 128, 1280),
                                    ("tile_height", tile_height, 72, 720)):
        if type(value) is not int or not low <= value <= high or value % 2:
            raise ValueError(f"{name} must be an even integer between {low} and {high}")
    if cols * rows > MAX_EXPORT_CELLS:
        raise ValueError("Combined export supports up to 16 cells; disable export for larger browser grids")
    width = GAP + cols * (tile_width + GAP)
    height = GAP + rows * (tile_height + CAPTION + GAP)
    if max(width, height) > MAX_EXPORT_SIDE:
        raise ValueError("Combined grid exceeds 8192 pixels on one side; reduce tile dimensions")
    return width, height


def _font():
    try:
        return ImageFont.truetype("DejaVuSans.ttf", 14)
    except OSError:
        try:
            return ImageFont.load_default(size=14)
        except TypeError:
            return ImageFont.load_default()


def _wrapped(draw, text, font, width, limit=4):
    # Bound pathological prompt labels. Full values remain in cell JSON.
    lines, line = [], ""
    for char in text[:4000]:
        if char == "\n" or draw.textlength(line + char, font=font) > width:
            lines.append(line)
            line = "" if char == "\n" else char
            if len(lines) == limit:
                lines[-1] = lines[-1][:-3] + "..."
                return lines
        else:
            line += char
    if line:
        lines.append(line)
    return lines[:limit]


def _background(path, state, tile_width, tile_height):
    width, height = export_geometry(state["cols"], state["rows"], tile_width, tile_height)
    image = Image.new("RGB", (width, height), (19, 24, 34))
    draw = ImageDraw.Draw(image)
    font = _font()
    for yi in range(state["rows"]):
        for xi in range(state["cols"]):
            x = GAP + xi * (tile_width + GAP)
            y = GAP + yi * (tile_height + CAPTION + GAP)
            draw.rectangle((x, y, x + tile_width - 1, y + CAPTION + tile_height - 1), fill=(37, 45, 62))
            text = f'{state.get("xName") or "X"}: {state["xLabels"][xi]}\n{state.get("yName") or "Y"}: {state["yLabels"][yi]}'
            for line_index, line in enumerate(_wrapped(draw, text, font, tile_width - 12)):
                draw.text((x + 6, y + 5 + line_index * 19), line, font=font, fill=(234, 239, 249))
    image.save(path)
    return width, height


def export_grid(directory, state, fps, crf, tile_width=480, tile_height=270, duration_mode="shortest"):
    """Return None until all cells exist. Export whenever the last missing cell lands."""
    width, height = export_geometry(state["cols"], state["rows"], tile_width, tile_height)
    if duration_mode not in ("shortest", "longest_hold"):
        raise ValueError("Unknown export duration policy")
    directory = Path(directory)
    clips, durations = [], []
    for yi in range(state["rows"]):
        for xi in range(state["cols"]):
            clip = directory / f"cell_{yi:03d}_{xi:03d}.mp4"
            sidecar = clip.with_suffix(".json")
            if not clip.is_file() or not sidecar.is_file():
                return None
            record = json.loads(sidecar.read_text(encoding="utf-8"))
            for key in ("session", "cols", "rows", "xLabels", "yLabels"):
                if record.get(key) != state[key]:
                    raise ValueError("Saved cells do not belong to the same grid configuration")
            if record.get("xi") != xi or record.get("yi") != yi:
                raise ValueError("Saved cell coordinates do not match")
            source_fps, count = record.get("fps"), record.get("frame_count")
            if not isinstance(source_fps, (int, float)) or not math.isfinite(source_fps) or source_fps <= 0 or type(count) is not int or count < 1:
                raise ValueError("Invalid saved clip duration")
            clips.append(clip)
            durations.append(count / source_fps)
    duration = min(durations) if duration_mode == "shortest" else max(durations)
    frame_count = max(1, math.floor(duration * fps + 1e-6) if duration_mode == "shortest" else math.ceil(duration * fps - 1e-6))
    output_duration = frame_count / fps
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required for combined export")
    target = directory / "grid.mp4"
    with tempfile.TemporaryDirectory(prefix=".grid-export-", dir=directory) as work:
        work = Path(work)
        _background(work / "labels.png", state, tile_width, tile_height)
        partial = work / "grid.mp4"
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-filter_complex_threads", "1",
                   "-loop", "1", "-framerate", str(fps), "-i", str(work / "labels.png")]
        for clip in clips:
            command += ["-threads", "1", "-i", str(clip)]
        filters = ["[0:v]format=yuv420p,setpts=PTS-STARTPTS[base0]"]
        for index, _ in enumerate(clips):
            xi, yi = index % state["cols"], index // state["cols"]
            filters.append(
                f"[{index+1}:v]setpts=PTS-STARTPTS,fps={fps},"
                f"scale={tile_width}:{tile_height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                f"pad={tile_width}:{tile_height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,"
                f"tpad=stop_mode=clone:stop_duration={output_duration + 1},"
                f"trim=duration={output_duration},format=yuv420p[cell{index}]")
            filters.append(f"[base{index}][cell{index}]overlay=x={GAP+xi*(tile_width+GAP)}:"
                           f"y={GAP+CAPTION+yi*(tile_height+CAPTION+GAP)}:shortest=1[base{index+1}]")
        command += ["-filter_complex", ";".join(filters), "-map", f"[base{len(clips)}]", "-an",
                    "-frames:v", str(frame_count), "-r", str(fps), "-c:v", "libx264", "-threads", "2",
                    "-preset", "fast", "-crf", str(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(partial)]
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors)
            try:
                while True:
                    throw_exception_if_processing_interrupted()
                    try:
                        code = process.wait(timeout=0.2)
                        break
                    except subprocess.TimeoutExpired:
                        continue
                if code:
                    errors.seek(0)
                    raise RuntimeError("Combined export FFmpeg: " + errors.read()[-4000:].decode(errors="replace"))
                throw_exception_if_processing_interrupted()
            except BaseException:
                process.kill()
                process.wait()
                raise
        manifest = {"session": state["session"], "cols": state["cols"], "rows": state["rows"],
                    "xName": state.get("xName", ""), "yName": state.get("yName", ""),
                    "xLabels": state["xLabels"], "yLabels": state["yLabels"],
                    "fps": fps, "frame_count": frame_count, "duration": output_duration,
                    "width": width, "height": height, "tile_width": tile_width, "tile_height": tile_height,
                    "duration_mode": duration_mode, "clips": [p.name for p in clips]}
        (work / "grid.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(partial, target)
        os.replace(work / "grid.json", target.with_suffix(".json"))
    return manifest
