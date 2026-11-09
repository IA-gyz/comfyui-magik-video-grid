# Magik Video Grid — 0.4.0

A ComfyUI video XY comparison node. Inspired by Pixaroma XY Plot's per-cell
workflow scheduling and prompt injection. This is a standalone implementation:
Pixaroma does not need to be installed.

## Install

Extract `Magik_Video_Grid` into `ComfyUI/custom_nodes/`, restart ComfyUI, and
hard-refresh the browser. Requires FFmpeg with libx264 on PATH (CachyOS:
`sudo pacman -S ffmpeg`). NumPy is already part of normal ComfyUI installations.
Find **Magik Video Grid** under **Magik / Video**.

## Your MiniMax workflow

Branch the IMAGE connection that feeds **CreateVideo, node 476** into this
node's **images** input. Leave your original CreateVideo / SaveVideo branch
connected if you also want its normal output. Set **fps = 24**, matching your
CreateVideo node. These comparison clips have no audio.

1. Put Magik Video Grid at the top level of the workflow.
2. Click **Refresh targets** after loading or changing the workflow.
3. For X and optionally Y, choose a **node**, then one of that node's **settings**.
   Each upstream node appears once, identified by its title and ID.
4. Choose values in the adapted editor (see below), or edit the value list directly.
5. Click **Queue XY grid**. This dedicated button submits one independent
   prompt per cell, X first, then Y. Ordinary ComfyUI Run saves a single clip.
6. Results appear as cells finish. Play all, pause all, restart, loop and
   relative seeking apply to the available clips. Individual controls and
   Open / save links are also provided.

## Choosing settings and values

**Refresh targets** reads ComfyUI's node definitions and the current widgets.
Each axis has a node dropdown followed by a setting dropdown. Only upstream
nodes appear. A setting connected by a wire remains selectable when its scalar
type is known; the editor marks it **connected** and explains that the chosen
values replace the wire for that sweep. The displayed reference value comes
from the widget or schema default, rather than evaluating the upstream node.
IMAGE, LATENT and other non-scalar sockets are omitted.

The value editor adapts to the setting:

- **Dropdowns**, including samplers, schedulers and model filenames: searchable
  checkboxes populated from the live widget or node definition. The list shows
  up to 100 matches at once; narrow the search to reach other choices. Select
  filtered replaces the value list with the matches (up to 64). Clear empties it.
- **Booleans**: false/true checkboxes, initially selecting both.
- **Numbers**: current value, available bounds and increment, plus Start / End /
  Step fields. **Use range** generates inclusive, evenly spaced values while
  respecting the direction of the step. An end value is included when the step
  lands on it. **Suggest values** proposes nearby values using the setting name
  (CFG, strength, denoise, steps, seed, dimensions, frame count or FPS). These
  suggestions are heuristics, not model recommendations. Declared bounds are
  respected; unknown constraints cannot be inferred reliably.
- **Text**: a value list, with **Use current**. For multiline prompts the editor
  selects **JSON array** format, so each complete prompt is one value. JSON also
  preserves leading/trailing spaces and empty strings. For example:
  `["first prompt", "second prompt"]`.

The editable value list is the source of truth and shows the selected count.
JSON uses native types: numbers stay numbers and booleans stay booleans.
Each axis supports 1–64 values. Known integer types, finite numbers, min/max
bounds and available dropdown choices are checked before queueing. A removed
model or changed dropdown option produces a validation message rather than
silently using another value. Existing saved plain-text value lists remain
compatible. The editor's format and numeric range fields persist in workflows.

Custom object widgets such as compound LoRA rows are not supported yet. Ordinary
scalar LoRA filename and strength settings are supported. Other constraints
remain subject to ComfyUI's queue validation; a rejected submission stops further
additions.

**Lock seeds** uses the values in the captured API prompt for every cell. It
also keeps the editor unchanged. Turning it off gives fresh random numeric
seed/noise_seed inputs per cell; an explicit seed axis overrides that random
value. The whole plot uses one snapshot, so edits during queueing do not change
later cells. This button bypasses the normal Run batch count and does not
activate Pixaroma's XY queue driver.

**Stop adding cells** stops further submissions. Already queued prompts remain;
use ComfyUI's queue controls to cancel those. All connected output nodes still
run for each cell, including existing SaveVideo nodes. Large sweeps can consume
substantial generation time and disk space. Maximum: 256 cells, 64 values/axis.

## Persistent previews

Save the workflow after results arrive. The node now stores a compact preview
index in workflow properties: session, shared axis labels, per-cell video
references and the combined-video reference when available. Reopening the saved
workflow restores ready clips, pending-cell positions, labels and download links.
Playback stays paused. Restoration does not queue generation or mark the
workflow as modified. The individual-clip **Loop** preference is also saved.

Videos remain separate files in the server's output folder; the workflow does
not embed video data or copy the full execution prompts into its preview index.
Moving a workflow to another machine requires copying its corresponding
`output/magik_video_grid/<session>/` folder as well. Missing or unsupported video
files display an explanation beside the player while retaining the grid labels.
Only previews saved with version 0.3.0 or later can be restored automatically.

**Clear preview** removes the node's saved preview references and releases its
players. It does not delete videos, stop generation, or cancel queued cells.
Further results from the cleared session stay hidden in that node; start a new
grid to display a new session. Save the workflow again to retain the cleared
state. A workflow saved partway through a plot restores only the results it
contained when saved; it does not resume missing cells.

## Combined MP4 export

Enable the node's **export_grid** option before clicking **Queue XY grid**.
The last arriving cell automatically creates **grid.mp4** and **grid.json**
alongside the individual clips. A combined player and Open / save link appear
below the browser grid. No extra video generation is needed.

- **tile_width / tile_height** set each video's area in pixels (default 480×270).
  Videos retain their aspect ratio and receive black bars when needed.
- Labels are drawn above each tile, with a dark background and small gaps.
  Long values wrap and are truncated to four lines; JSON retains the full labels.
- **duration_mode = shortest** ends the grid at the shortest clip.
- **duration_mode = longest_hold** ends at the longest clip; shorter clips hold
  their final frame. All clips start at zero; no clip loops during export.
- The output FPS is the grid node's FPS when composition runs. Clips with
  different source FPS are resampled to that output rate. Lengths round to
  whole frames (shortest rounds down, longest_hold rounds up, at least one frame).
- Export uses H.264 / YUV420p at the selected CRF and contains no audio.
- Combined export is limited to **16 cells** and **8192 pixels per side**.
  Disable export_grid to use the full 256-cell browser grid. Oversized explicit
  sweeps are rejected before submission.

FFmpeg composes the already saved clips without loading complete video batches
into Python memory. It uses one decoding thread per input, one filter thread,
and two encoder threads. ComfyUI interrupts terminate the composition process
and remove its temporary files. If optional composition fails, individual clips
are retained and the node displays the export error.

The third output, **grid_path**, is empty while cells are pending and contains
the combined MP4 path on the execution that completes the grid. The existing
images and cell_path outputs keep their original positions.

## Saved results

Each plot writes to `ComfyUI/output/magik_video_grid/<session>/`:

- `cell_YYY_XXX.mp4`: H.264, CRF-controlled, RGB converted to 8-bit YUV420p.
- `cell_YYY_XXX.json`: labels, coordinates, FPS, frame count and execution API
  prompt. Also includes the editor workflow snapshot when ComfyUI supplies it.
  With `--disable-metadata`, the prompt and workflow are omitted.
  The API prompt contains the exact per-cell overrides; the editor snapshot
  keeps the original widget values. These files can contain your prompt text.

Odd dimensions are padded by at most one pixel. Frames are streamed to FFmpeg
one at a time; the accumulator does not retain GPU tensors or full frame batches.
The current cell's input batch is still required in memory by ComfyUI.
The outputs pass through the original IMAGE batch and return the saved clip path.
Existing files are never reused across newly created plot sessions.

## Current limits / validation

The browser grid and combined MP4 provide two ways to compare clips. Shared
browser controls start playback and seek clips together;
browser decoders do not provide frame-exact synchronization. Different durations
loop independently, and relative seeking aligns percentages of each clip.
Audio is omitted. Previews restore from saved workflow properties; video files
must remain in the corresponding server output folder. Avoid starting overlapping plots on the
same node. Results are displayed through ComfyUI's standard node execution UI.

Top-level nodes only; the target selector can include expanded API entries from
subgraphs but the grid node itself must not be nested. No remote API-only sweep
scheduler is included: each API call represents one cell.

Validated: Python/JavaScript syntax; ten backend regression tests using real
FFmpeg and an isolated ComfyUI/tensor adapter; odd-size RGBA input; H.264 codec
and frame count; JSON with non-finite values; metadata disabling; interrupt and
encoder-failure cleanup; malformed sessions and coordinates. A DOM/API test
harness covers restored settings, upstream target filtering, 2×2 queue ordering,
per-cell injection, seed locking, immutable snapshots, stale plot results and
submission cancellation, combined playback delivery and export preflight limits.
Preview checks cover a workflow-JSON round trip, partial-grid restoration,
compact label storage, missing-file errors, loop persistence, invalid snapshot
rejection, and clearing previews without queue submissions or load-time edits.
Combined export is checked with real 2×2 compositions: tile positions and label
pixels, shortest duration, held final-frame pixels, mixed FPS/resolutions and
interrupt cleanup.

Run checks from the directory containing this package:

```bash
python Magik_Video_Grid/tests/test_backend.py
node Magik_Video_Grid/tests/test_frontend.mjs
```
Not yet validated inside a live ComfyUI instance, including the current frontend
DOM widget rendering. No ComfyUI server or torch is installed in the build
workspace; the encode test used a tensor-interface adapter.


## 0.1.1 review fixes

- Target discovery no longer serializes a partially restored graph at node creation.
- Saved axis selections are restored alongside their text values.
- Only parameters feeding this grid appear in the target selector.
- Refreshes cannot race each other or an ongoing queue submission.
- Late results from a previous plot cannot replace the newly selected plot.
- Encoding checks ComfyUI's interrupt flag between frames and before publishing.
- Frame conversion explicitly uses CPU float32, including bfloat16 input support.
- FFmpeg pipe failures produce useful errors and clean up temporary files.
- Saved JSON is strict; non-finite execution-cache values become null.
- ComfyUI's metadata flag suppresses prompt/workflow storage.


## 0.2.0

Added automatic labeled combined-video export, shortest/longest-hold duration
policies, configurable tile sizes, combined player/download link, grid_path
output and export regression tests. Existing individual clip saving remains
available with export_grid disabled (the default).


## 0.3.0

Added workflow-persistent previews for individual clips and the combined MP4,
compact reference storage, persistent loop settings, missing-video messages and
Clear preview. Added frontend regression coverage for save/load and cleanup.
Python encoding and combined-export behavior are unchanged.


## 0.4.0

Replaced the flat setting list with node / setting selectors. Added typed value
editors, live dropdown discovery, searchable choice lists, boolean checkboxes,
numeric ranges and heuristic suggestions, bounds validation, JSON multiline
values and connected scalar settings. Selection regression coverage includes
live option changes, whole-number bounds, large seeds and link overrides.
Browser execution could not be checked in the build workspace because its
Playwright browser executable is unavailable; live ComfyUI verification remains
necessary.
