import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { createAxisEditor, describeSetting, scalarTargetValue, settingValues } from "./axis_editor.mjs";

const CLASS = "MagikVideoGrid";
const nodeDefinitions = new Map();
const make = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; };
const clone = (v) => structuredClone(v);
export function upstreamIds(output, start) {
    const result = new Set(), pending = [String(start)];
    while (pending.length) {
        const id = pending.pop();
        if (result.has(id)) continue;
        result.add(id);
        for (const value of Object.values(output[id]?.inputs || {})) {
            if (Array.isArray(value) && value.length === 2 && Number.isInteger(value[1]) && output[String(value[0])]) pending.push(String(value[0]));
        }
    }
    return result;
}

const keyOf = (id, input) => JSON.stringify([String(id), input]);

export function valuesFor(text, original) {
    return settingValues(text, {value: original, meta: {kind: typeof original === "number" ? "number" : typeof original === "boolean" ? "boolean" : "text"}});
}

// Persist references, never video data or full execution prompts.
export function normalizePreview(value) {
    if (!value || value.version !== 1 || !value.common || !Array.isArray(value.cells)) return null;
    const c = value.common;
    if (typeof c.session !== "string" || !/^[a-f0-9]{32}$/.test(c.session) ||
        !Number.isInteger(c.cols) || !Number.isInteger(c.rows) || c.cols < 1 || c.rows < 1 ||
        c.cols > 64 || c.rows > 64 || c.cols * c.rows > 256 || value.cells.length > 256) return null;
    for (const [key, length] of [["xLabels", c.cols], ["yLabels", c.rows]]) {
        if (!Array.isArray(c[key]) || c[key].length !== length || c[key].some(v => typeof v !== "string" || v.length > 10000)) return null;
    }
    const common = {session: c.session, cols: c.cols, rows: c.rows, xLabels: [...c.xLabels], yLabels: [...c.yLabels],
        xName: String(c.xName || "").slice(0, 1000), yName: String(c.yName || "").slice(0, 1000)};
    const file = data => data && data.type === "output" && typeof data.filename === "string" &&
        /^[A-Za-z0-9_-]+\.mp4$/.test(data.filename) && data.subfolder === `magik_video_grid/${c.session}`;
    const cells = [], indices = new Set();
    for (const data of value.cells) {
        if (!file(data) || !Number.isInteger(data.xi) || !Number.isInteger(data.yi) ||
            data.xi < 0 || data.xi >= c.cols || data.yi < 0 || data.yi >= c.rows ||
            !Number.isFinite(data.fps) || data.fps < 0.1 || data.fps > 240) return null;
        const index = data.yi * c.cols + data.xi;
        if (indices.has(index)) return null;
        indices.add(index);
        cells.push({xi: data.xi, yi: data.yi, fps: data.fps, filename: data.filename,
            subfolder: data.subfolder, type: "output"});
    }
    let combined = null;
    if (value.combined != null) {
        const r = value.combined;
        if (!file(r) || !Number.isFinite(r.duration) || r.duration <= 0 ||
            !Number.isInteger(r.width) || !Number.isInteger(r.height) ||
            r.width < 1 || r.height < 1 || r.width > 8192 || r.height > 8192) return null;
        combined = {session: c.session, filename: r.filename, subfolder: r.subfolder, type: "output",
            width: r.width, height: r.height, duration: r.duration};
    }
    return {version: 1, common, cells, combined};
}

function install(node) {
    node.properties ??= {};
    node.properties.magikVideoGrid ??= { x: "", y: "", xv: "", yv: "", lockSeed: true };
    const defaults = { x: "", y: "", xv: "", yv: "", lockSeed: true };
    const config = () => {
        node.properties ??= {};
        const value = node.properties.magikVideoGrid;
        if (!value || typeof value !== "object" || Array.isArray(value)) node.properties.magikVideoGrid = {...defaults};
        return node.properties.magikVideoGrid;
    };
    const changed = () => { node.graph?.change?.(); node.setDirtyCanvas?.(true, true); };
    const root = make("div");
    root.className = "magik-video-grid";
    root.style.cssText = "padding:10px;background:#171c27;color:#e4e9f3;font:13px system-ui;box-sizing:border-box;width:100%;height:100%;overflow:auto;";
    const controls = make("div"); controls.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:10px";
    const axes = {};
    for (const axis of ["x", "y"]) {
        axes[axis] = createAxisEditor({axis, make, config, changed, targetMap: () => targets});
        controls.append(axes[axis].box);
    }
    const row = make("div"); row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin:10px 0";
    const refresh = make("button", "Refresh targets"), run = make("button", "Queue XY grid");
    const stop = make("button", "Stop adding cells"); stop.disabled = true;
    const lockLabel = make("label"), lock = make("input"); lock.type = "checkbox";
    lock.onchange = () => { config().lockSeed = lock.checked; changed(); };
    lockLabel.append(lock, " Lock seeds");
    const clear = make("button", "Clear preview");
    clear.title = "Clear this node's preview references; saved video files remain on disk";
    row.append(refresh, run, stop, lockLabel, clear);
    const status = make("div", "Connect video frames, choose axes, then Queue XY grid.");
    const playback = make("div"); playback.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin:10px 0";
    const play = make("button", "Play all"), pause = make("button", "Pause all"), restart = make("button", "Restart");
    const scrub = make("input"); scrub.type = "range"; scrub.min = "0"; scrub.max = "1"; scrub.step = "0.001"; scrub.value = "0";
    scrub.title = "Seek all clips by relative position";
    const loopLabel = make("label"), loop = make("input"); loop.type = "checkbox"; loop.checked = true; loopLabel.append(loop, " Loop");
    playback.append(play, pause, restart, scrub, loopLabel);
    const grid = make("div"); grid.style.cssText = "display:grid;gap:8px;align-items:start";
    const combined = make("div");
    combined.style.cssText = "margin-top:12px;border-top:1px solid #46516a;padding-top:10px";
    root.append(controls, row, status, playback, grid, combined);
    const widget = node.addDOMWidget("video_grid_panel", "MAGIK_VIDEO_GRID", root, {serialize: false});
    widget.computeSize = () => [560, 540];
    node.setSize([620, 670]);
    let targets = new Map(), alive = true, cancelled = false, busy = false, session = null;
    const players = new Map();
    const retiredSessions = new Set();
    let refreshVersion = 0;
    let combinedPlayer = null;
    let previewState = null;
    let restoring = false;
    const videos = () => [...players.values()];
    const syncConfig = () => {
        for (const a of ["x", "y"]) axes[a].sync();
        lock.checked = config().lockSeed !== false;
        loop.checked = config().loop !== false;
    };
    async function refreshTargets() {
        const version = ++refreshVersion;
        const prompt = await app.graphToPrompt();
        if (typeof api.getNodeDefs === "function") {
            try {
                const definitions = await api.getNodeDefs();
                for (const [name, definition] of Object.entries(definitions || {})) nodeDefinitions.set(name, definition);
            } catch (error) { console.warn("[Magik Video Grid] Using cached definitions/live widgets", error); }
        }
        const nextTargets = new Map();
        const upstream = upstreamIds(prompt.output || {}, node.id);
        for (const [id, entry] of Object.entries(prompt.output || {})) {
            if (entry.class_type === CLASS || !upstream.has(id)) continue;
            const liveNode = app.graph?.getNodeById?.(id) || (/^\d+$/.test(id) ? app.graph?.getNodeById?.(Number(id)) : null);
            const definition = nodeDefinitions.get(entry.class_type) || liveNode?.constructor?.nodeData;
            const nodeLabel = `${entry._meta?.title || liveNode?.title || definition?.display_name || entry.class_type} [${id}]`;
            for (const [input, supplied] of Object.entries(entry.inputs || {})) {
                const widget = liveNode?.widgets?.find(w => w.name === input);
                const value = scalarTargetValue(input, supplied, definition, widget);
                if (value === undefined) continue;
                const key = keyOf(id, input);
                const settingLabel = (widget?.label || input) + (Array.isArray(supplied) ? " (connected)" : "");
                nextTargets.set(key, {id, input, value, nodeLabel, settingLabel,
                    label: `${nodeLabel} · ${settingLabel}`, connected: Array.isArray(supplied), meta: describeSetting(input, value, definition, widget)});
            }
        }
        if (!alive || version !== refreshVersion) throw new Error("Target refresh was superseded. Try again.");
        targets = nextTargets;
        for (const a of ["x", "y"]) axes[a].setTargets();
        syncConfig();
        return prompt;
    }
    refresh.onclick = () => refreshTargets().catch(error => { status.textContent = error.message; });
    function clearPlayers() {
        for (const video of videos()) { video.pause(); video.removeAttribute("src"); video.load(); }
        players.clear(); grid.replaceChildren();
        if (combinedPlayer) { combinedPlayer.pause(); combinedPlayer.removeAttribute("src"); combinedPlayer.load(); combinedPlayer = null; }
        combined.replaceChildren();
    }
    function switchSession(id) {
        if (session && session !== id) retiredSessions.add(session);
        // Results from older queued plots must not erase a newer plot.
        clearPlayers(); session = id;
        previewState = null;
        if (!restoring) { delete node.properties.magikVideoGridPreview; changed(); }
    }
    function persistPreview() {
        if (restoring || !previewState) return;
        node.properties.magikVideoGridPreview = clone(previewState);
        changed();
    }
    function accept(cell) {
        if (!alive || !cell || retiredSessions.has(cell.session)) return;
        const normalized = normalizePreview({version: 1, common: cell, cells: [cell]});
        if (!normalized) return;
        cell = {...normalized.common, ...normalized.cells[0]};
        if (session !== cell.session) switchSession(cell.session);
        if (!previewState) previewState = {version: 1, common: normalized.common, cells: [], combined: null};
        if (previewState.common.cols !== cell.cols || previewState.common.rows !== cell.rows ||
            JSON.stringify(previewState.common.xLabels) !== JSON.stringify(cell.xLabels) ||
            JSON.stringify(previewState.common.yLabels) !== JSON.stringify(cell.yLabels)) return;
        grid.style.gridTemplateColumns = `repeat(${cell.cols},minmax(150px,1fr))`;
        const index = cell.yi * cell.cols + cell.xi;
        if (!grid.children.length) {
            for (let y = 0; y < cell.rows; y++) for (let x = 0; x < cell.cols; x++) {
                const tile = make("div"); tile.style.cssText = "background:#252d3e;padding:6px;border-radius:6px;min-width:0";
                const title = make("div", `${cell.xName || "X"}: ${cell.xLabels[x]} · ${cell.yName || "Y"}: ${cell.yLabels[y]}`); title.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:5px;max-height:100px;overflow:auto";
                tile.append(title, make("div", "Pending")); grid.append(tile);
            }
        }
        const tile = grid.children[index]; if (!tile) return;
        const old = players.get(index); if (old) { old.pause(); old.removeAttribute("src"); old.load(); }
        while (tile.children.length > 1) tile.lastChild.remove();
        const params = new URLSearchParams({filename: cell.filename, subfolder: cell.subfolder, type: cell.type});
        const url = api.apiURL(`/view?${params}`);
        const video = make("video"); video.src = url; video.controls = true; video.muted = true; video.loop = loop.checked;
        video.preload = "metadata"; video.playsInline = true; video.style.cssText = "width:100%;display:block;background:black";
        const link = make("a", "Open / save clip"); link.href = url; link.target = "_blank"; link.rel = "noopener";
        const unavailable = make("div"); unavailable.style.cssText = "color:#ffd180;margin-top:4px";
        video.onerror = () => {
            if (alive && session === cell.session && players.get(index) === video) {
                unavailable.textContent = "Clip unavailable or unsupported. Check that its saved MP4 still exists.";
            }
        };
        tile.append(video, link, unavailable); players.set(index, video);
        if (previewState.combined && !restoring) {
            previewState.combined = null;
            if (combinedPlayer) { combinedPlayer.pause(); combinedPlayer.removeAttribute("src"); combinedPlayer.load(); combinedPlayer = null; }
            combined.replaceChildren();
        }
        previewState.cells = previewState.cells.filter(c => c.yi * cell.cols + c.xi !== index);
        previewState.cells.push(normalized.cells[0]);
        persistPreview();
        status.textContent = `${players.size}/${cell.cols * cell.rows} cells ready · ${cell.fps} FPS`;
    }
    play.onclick = async () => {
        const results = await Promise.allSettled(videos().map(v => v.play()));
        if (results.some(r => r.status === "rejected")) status.textContent = "Some clips could not play. Use their individual controls.";
    };
    pause.onclick = () => videos().forEach(v => v.pause());
    restart.onclick = () => { videos().forEach(v => { v.currentTime = 0; }); scrub.value = "0"; };
    scrub.oninput = () => videos().forEach(v => { if (Number.isFinite(v.duration)) v.currentTime = Number(scrub.value) * v.duration; });
    loop.onchange = () => {
        config().loop = loop.checked;
        videos().forEach(v => { v.loop = loop.checked; });
        changed();
    };
    clear.onclick = () => {
        if (session) retiredSessions.add(session);
        clearPlayers(); session = null; previewState = null;
        delete node.properties.magikVideoGridPreview;
        status.textContent = "Preview cleared. Saved video files remain on disk.";
        changed();
    };
    stop.onclick = () => { cancelled = true; status.textContent = "Stopping submissions; already queued cells remain in ComfyUI."; };
    run.onclick = async () => {
        if (busy) return;
        busy = true; cancelled = false; run.disabled = true; refresh.disabled = true; stop.disabled = false;
        try {
            const saved = clone(config());
            const base = await refreshTargets();
            const own = base.output[String(node.id)];
            if (!own || own.class_type !== CLASS) throw new Error("Place Magik Video Grid at the top level of the workflow.");
            if (node.mode === 2 || node.mode === 4) throw new Error("Enable Magik Video Grid before running.");
            if (!Array.isArray(own.inputs.images)) throw new Error("Connect a video IMAGE batch to images.");
            const axis = a => {
                if (!saved[a]) return {values: [null], label: "", target: null};
                const target = targets.get(saved[a]);
                if (!target) throw new Error(`${a.toUpperCase()} target is missing. Refresh targets and choose it again.`);
                return {target, label: target.label, values: settingValues(saved[a + "v"], target, saved[a + "format"] || "lines")};
            };
            const x = axis("x"), y = axis("y");
            if (!x.target && !y.target) throw new Error("Choose at least one axis.");
            if (saved.x && saved.x === saved.y) throw new Error("X and Y must target different inputs.");
            const total = x.values.length * y.values.length;
            if (total > 256) throw new Error("Maximum 256 cells per plot.");
            if (own.inputs.export_grid === true) {
                if (total > 16) throw new Error("Combined export supports up to 16 cells. Disable export_grid for larger browser grids.");
                const width = 8 + x.values.length * ((own.inputs.tile_width ?? 480) + 8);
                const height = 8 + y.values.length * ((own.inputs.tile_height ?? 270) + 96);
                if (Math.max(width, height) > 8192) throw new Error("Combined grid exceeds 8192 pixels per side. Reduce tile dimensions.");
            }
            const id = crypto.randomUUID().replaceAll("-", "");
            switchSession(id);
            let submitted = 0;
            for (let yi = 0; yi < y.values.length && !cancelled && alive; yi++) {
                for (let xi = 0; xi < x.values.length && !cancelled && alive; xi++) {
                    const data = clone(base);
                    if (saved.lockSeed === false) {
                        for (const e of Object.values(data.output)) for (const name of ["seed", "noise_seed"]) {
                            if (typeof e.inputs?.[name] === "number") e.inputs[name] = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
                        }
                    }
                    for (const [a, index] of [[x, xi], [y, yi]]) if (a.target) data.output[a.target.id].inputs[a.target.input] = a.values[index];
                    data.output[String(node.id)].inputs.grid_state = JSON.stringify({session: id, xi, yi, cols: x.values.length, rows: y.values.length,
                        xName: x.label, yName: y.label, xLabels: x.values.map(v => v == null ? "" : String(v)), yLabels: y.values.map(v => v == null ? "" : String(v))});
                    // Keep the exact API prompt with its cell. The editor workflow remains an untouched snapshot.
                    const result = await api.queuePrompt(0, data);
                    if (result?.error || !result?.prompt_id) throw new Error(JSON.stringify(result?.error || result));
                    submitted++;
                    status.textContent = `Queued ${submitted}/${total} cells. Results appear as execution finishes.`;
                }
            }
        } catch (error) { status.textContent = `Grid error: ${error.message}`; console.error("[Magik Video Grid]", error); }
        finally { busy = false; run.disabled = false; refresh.disabled = false; stop.disabled = true; }
    };
    function acceptCombined(result) {
        if (!alive || !previewState || result?.session !== session) return;
        const normalized = normalizePreview({...previewState, combined: result});
        if (!normalized?.combined) return;
        result = normalized.combined;
        combined.replaceChildren();
        if (combinedPlayer) { combinedPlayer.pause(); combinedPlayer.removeAttribute("src"); combinedPlayer.load(); }
        const url = api.apiURL(`/view?${new URLSearchParams({filename: result.filename, subfolder: result.subfolder, type: result.type})}`);
        combinedPlayer = make("video"); combinedPlayer.src = url; combinedPlayer.controls = true;
        combinedPlayer.muted = true; combinedPlayer.preload = "metadata"; combinedPlayer.playsInline = true;
        combinedPlayer.style.cssText = "display:block;width:100%;background:black;margin:6px 0";
        const link = make("a", "Open / save combined MP4"); link.href = url; link.target = "_blank"; link.rel = "noopener";
        const unavailable = make("div"); unavailable.style.cssText = "color:#ffd180;margin-top:4px";
        const player = combinedPlayer;
        player.onerror = () => {
            if (alive && session === result.session && combinedPlayer === player) unavailable.textContent = "Combined MP4 unavailable or unsupported. Check that grid.mp4 still exists.";
        };
        combined.append(make("b", `Combined grid · ${result.width} × ${result.height} · ${result.duration.toFixed(2)}s`), combinedPlayer, link, unavailable);
        previewState.combined = normalized.combined;
        persistPreview();
        status.textContent = "Grid complete. Combined MP4 is ready below.";
    }
    function restorePreview() {
        const saved = normalizePreview(node.properties?.magikVideoGridPreview);
        clearPlayers(); session = null; previewState = null; retiredSessions.clear();
        if (!saved) {
            status.textContent = "Connect video frames, choose axes, then Queue XY grid.";
            return;
        }
        restoring = true;
        try {
            session = saved.common.session;
            previewState = {version: 1, common: saved.common, cells: [], combined: null};
            for (const cell of saved.cells) accept({...saved.common, ...cell});
            if (saved.combined) acceptCombined(saved.combined);
            if (!saved.combined) status.textContent = `Restored ${saved.cells.length}/${saved.common.cols * saved.common.rows} saved clips.`;
        } finally { restoring = false; }
    }
    const executed = node.onExecuted;
    node.onExecuted = function(message) {
        executed?.apply(this, arguments);
        for (const cell of message?.magik_video_cell || []) accept(cell);
        for (const result of message?.magik_video_export || []) acceptCombined(result);
        if (message?.magik_video_export_error?.length && message.magik_video_cell?.some(c => c.session === session)) {
            status.textContent = `Cells saved; combined export failed: ${message.magik_video_export_error[0]}`;
        }
    };
    const configure = node.onConfigure;
    node.onConfigure = function() { configure?.apply(this, arguments); syncConfig(); restorePreview(); };
    const removed = node.onRemoved;
    node.onRemoved = function() { alive = false; cancelled = true; clearPlayers(); removed?.apply(this, arguments); };
    const state = node.widgets?.find(w => w.name === "grid_state");
    if (state) { state.type = "converted-widget"; state.computeSize = () => [0, -4]; state.serializeValue = () => "{}"; }
    syncConfig();
    // Graph serialization during onNodeCreated races workflow restoration and
    // can recurse when graphToPrompt itself creates virtual nodes. Refresh only
    // on an explicit action, once the complete graph exists.
}

app.registerExtension({
    name: "Magik.VideoGrid",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        nodeDefinitions.set(nodeData.name, nodeData);
        if (nodeData.name !== CLASS) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() { created?.apply(this, arguments); install(this); };
    },
});
