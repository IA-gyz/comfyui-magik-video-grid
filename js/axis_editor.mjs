const scalar = value => ['string', 'number', 'boolean'].includes(typeof value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const option = (make, value, label = value) => { const e = make('option', String(label)); e.value = String(value); return e; };

export function scalarTargetValue(input, supplied, definition, widget) {
    if (scalar(supplied)) return supplied;
    if (!Array.isArray(supplied) || supplied.length !== 2) return undefined;
    const spec = definition?.input?.required?.[input] ?? definition?.input?.optional?.[input];
    if (!Array.isArray(spec)) return undefined;
    const type = spec[0], options = spec[1] || {};
    if (!Array.isArray(type) && !['INT','FLOAT','BOOLEAN','STRING','COMBO'].includes(type)) return undefined;
    const sample = Array.isArray(type) ? type.find(scalar) : type === 'INT' || type === 'FLOAT' ? 0 : type === 'BOOLEAN' ? false : '';
    for (const value of [widget?.value, options.default, sample]) {
        if (scalar(value) && typeof value === typeof sample) return value;
    }
    return undefined;
}

export function describeSetting(input, value, definition, widget) {
    const spec = definition?.input?.required?.[input] ?? definition?.input?.optional?.[input];
    const type = Array.isArray(spec) ? spec[0] : null;
    const declared = Array.isArray(spec) ? spec[1] || {} : {};
    const live = widget?.options || {};
    let available = live.values;
    if (typeof available === 'function') {
        try { available = available.call(live, widget); } catch { available = null; }
    }
    if (!Array.isArray(available)) available = Array.isArray(type) ? type : declared.options;
    const choices = Array.isArray(available) ? [...new Set(available.filter(v => scalar(v) && typeof v === typeof value))] : [];
    const meta = {kind: typeof value === 'boolean' ? 'boolean' : choices.length ? 'choices' : typeof value === 'number' ? 'number' : 'text',
        choices, current: value, multiline: declared.multiline === true || (typeof value === 'string' && value.includes('\n')),
        source: spec ? 'Node definition' : widget ? 'Live widget' : 'Inferred from current value'};
    if (meta.kind === 'number') {
        meta.integer = type === 'INT' || (type !== 'FLOAT' && /(^|[_.])(seed|noise_seed|steps|width|height|length|frames|frame_count|batch_size)$/.test(input));
        meta.min = finite(declared.min) ? declared.min : finite(live.min) ? live.min : null;
        meta.max = finite(declared.max) ? declared.max : finite(live.max) ? live.max : null;
        // Legacy LiteGraph numeric widgets expose ten times the actual step.
        meta.step = finite(declared.step) && declared.step > 0 ? declared.step :
            finite(live.step) && live.step > 0 ? live.step / (widget?.type === 'number' ? 10 : 1) : meta.integer ? 1 : 0.1;
    }
    return meta;
}

export function numericRange(start, end, step, meta = {}) {
    if ([start, end, step].some(v => typeof v === 'string' && !v.trim())) throw new Error('Fill in start, end and step.');
    start = Number(start); end = Number(end); step = Number(step);
    if (![start, end, step].every(Number.isFinite) || step === 0) throw new Error('Use finite numbers and a nonzero step.');
    if ((end - start) * step < 0) throw new Error('The step must move from start toward end.');
    const count = Math.floor((end - start) / step + 1e-9) + 1;
    if (count < 1 || count > 64) throw new Error('A range must contain 1–64 values.');
    const result = Array.from({length: count}, (_, i) => Number.isInteger(start + i * step) ? start + i * step : Number((start + i * step).toPrecision(15)));
    validateNumbers(result, meta);
    return result;
}

function validateNumbers(values, meta) {
    for (const value of values) {
        if (!Number.isFinite(value)) throw new Error('Values must be finite numbers.');
        if (meta.integer && !Number.isSafeInteger(value)) throw new Error('This setting requires whole numbers within JavaScript’s safe integer range.');
        if (meta.min != null && value < meta.min) throw new Error(`Minimum value: ${meta.min}`);
        if (meta.max != null && value > meta.max) throw new Error(`Maximum value: ${meta.max}`);
    }
}

export function suggestedNumbers(input, meta) {
    const current = meta.current;
    let values;
    if (/(^|[_.])(noise_)?seed$/.test(input)) values = [current, current + 1, current + 2];
    else if (/(^|[_.])(width|height)$/.test(input)) {
        const snap = Math.max(8, meta.step || 1);
        values = [0.75, 1, 1.25].map(f => Math.round(current * f / snap) * snap);
    } else if (/(^|[_.])(steps|length|frames|frame_count|batch_size)$/.test(input)) values = [0.5, 1, 1.5].map(f => Math.max(1, Math.round((current * f - current) / Math.max(1,meta.step)) * Math.max(1,meta.step) + current));
    else if (/fps|frame_rate/.test(input)) values = [12, 16, 24, 30, 48, 60, current];
    else if (/denoise/.test(input)) values = [0.25, 0.5, 0.75, 1, current];
    else if (/strength/.test(input)) values = [0.5, 0.75, 1, 1.25, 1.5, current];
    else if (/cfg|guidance/.test(input)) values = [Math.max(0, current - 2), current, current + 2];
    else values = [current - meta.step, current, current + meta.step];
    return [...new Set(values.map(v => Number.isInteger(v) ? v : Number(v.toPrecision(15))))].filter(v => {
        try { validateNumbers([v], meta); return true; } catch { return false; }
    });
}

export function settingValues(text, target, format = 'lines') {
    let values;
    if (format === 'json') {
        try { values = JSON.parse(text); } catch { throw new Error('Enter a JSON array of values.'); }
        if (!Array.isArray(values)) throw new Error('Enter a JSON array of values.');
    } else {
        values = text.split('\n').map(s => s.trim()).filter(Boolean).map(value => {
            if (typeof target.value === 'boolean') {
                if (!/^(true|false)$/i.test(value)) throw new Error('Boolean values must be true or false.');
                return value.toLowerCase() === 'true';
            }
            return typeof target.value === 'number' ? Number(value) : value;
        });
    }
    if (!values.length || values.length > 64) throw new Error('Select 1–64 values.');
    if (values.some(v => typeof v !== typeof target.value)) throw new Error(`Values must have type ${typeof target.value}.`);
    if (values.some(v => typeof v === 'string' && v.length > 10000)) throw new Error('Each text value must be at most 10,000 characters.');
    const meta = target.meta;
    if (typeof target.value === 'number') validateNumbers(values, meta);
    if (meta.kind === 'choices' && values.some(v => !meta.choices.includes(v))) throw new Error('Some values are no longer available. Refresh the choices and select again.');
    return values;
}

export function createAxisEditor({axis, make, config, changed, targetMap}) {
    const box = make('div'); box.style.cssText = 'min-width:0;background:#222b3b;border-radius:7px;padding:8px';
    const heading = make('b', `${axis.toUpperCase()} axis`);
    const nodes = make('select'), settings = make('select');
    nodes.title = 'Choose the node'; settings.title = 'Choose a setting on this node';
    for (const select of [nodes, settings]) select.style.cssText = 'width:100%;box-sizing:border-box;margin-top:6px';
    const info = make('div'); info.style.cssText = 'font-size:11px;opacity:.8;margin:6px 0;overflow-wrap:anywhere';
    const panel = make('div'); panel.style.cssText = 'margin:6px 0';
    const format = make('select'); format.append(option(make, 'lines', 'One value per line'), option(make, 'json', 'JSON array / multiline text'));
    format.style.cssText = 'width:100%;margin:6px 0';
    const textarea = make('textarea'); textarea.rows = 4; textarea.placeholder = 'One value per line';
    textarea.style.cssText = 'box-sizing:border-box;width:100%;resize:vertical';
    const summary = make('div'); summary.style.cssText = 'font-size:12px;color:#ffd180;margin-top:5px';
    box.append(heading, nodes, settings, info, panel, format, textarea, summary);
    let groups = new Map();
    const selectedTarget = () => targetMap().get(config()[axis]);
    const save = () => { config()[axis+'v'] = textarea.value; config()[axis+'format'] = format.value; changed(); updateSummary(); };
    function updateSummary() {
        const target = selectedTarget();
        if (!target) { summary.textContent = 'Choose a node and setting.'; return; }
        try { const values = settingValues(textarea.value, target, format.value); summary.textContent = `${values.length} selected value${values.length === 1 ? '' : 's'}`; }
        catch (error) { summary.textContent = error.message; }
    }
    function write(values) {
        textarea.value = format.value === 'json' ? JSON.stringify(values, null, 2) : values.map(String).join('\n');
        save();
    }
    function readSelection() {
        try { return settingValues(textarea.value, selectedTarget(), format.value); } catch { return []; }
    }
    function renderPanel() {
        panel.replaceChildren();
        const target = selectedTarget();
        if (!target) { info.textContent = ''; updateSummary(); return; }
        const meta = target.meta;
        const current = String(target.value).replace(/\s+/g,' ').slice(0,120);
        info.textContent = `${target.connected ? "Connected input: chosen values override its wire. Widget/default reference · " : ""}${meta.source} · ${meta.kind}${meta.integer ? ' (integer)' : ''} · Current: ${current}`;
        const currentButton = make('button', 'Use current'); currentButton.onclick = () => { write([target.value]); renderPanel(); };
        panel.append(currentButton);
        if (meta.kind === 'choices' || meta.kind === 'boolean') {
            const choices = meta.kind === 'boolean' ? [false, true] : meta.choices;
            const filter = make('input'); filter.type = 'search'; filter.placeholder = `Search ${choices.length} choices`;
            filter.style.cssText = 'box-sizing:border-box;width:100%;margin:6px 0';
            const actions = make('div'), all = make('button', 'Select filtered'), none = make('button', 'Clear');
            actions.append(all, none);
            const list = make('div'); list.style.cssText = 'max-height:180px;overflow:auto;margin-top:5px';
            const note = make('div'); note.style.fontSize = '11px';
            const filtered = () => choices.filter(v => String(v).toLowerCase().includes(filter.value.toLowerCase()));
            const renderChoices = () => {
                list.replaceChildren();
                const chosen = readSelection(), matches = filtered();
                note.textContent = `Showing ${Math.min(matches.length,100)} / ${matches.length} matches. Maximum 64 selected.`;
                for (const value of matches.slice(0,100)) {
                    const label = make('label'); label.style.cssText = 'display:flex;gap:5px;overflow-wrap:anywhere;margin:3px 0';
                    const checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.checked = chosen.includes(value);
                    checkbox.onchange = () => {
                        const next = readSelection().filter(v => v !== value);
                        if (checkbox.checked) next.push(value);
                        if (next.length > 64) { checkbox.checked = false; summary.textContent = 'Maximum 64 values per axis.'; return; }
                        write(next);
                    };
                    label.append(checkbox, make('span',String(value))); list.append(label);
                }
            };
            all.onclick = () => { const values = filtered(); if (values.length > 64) { summary.textContent = 'Narrow the search to 64 choices or fewer.'; return; } write(values); renderChoices(); };
            none.onclick = () => { write([]); renderChoices(); };
            filter.oninput = renderChoices;
            panel.append(filter, actions, list, note); renderChoices();
        } else if (meta.kind === 'number') {
            const bounds = make('div', `${meta.min == null ? 'No declared minimum' : 'Min '+meta.min} · ${meta.max == null ? 'No declared maximum' : 'Max '+meta.max} · step ${meta.step}`);
            bounds.style.cssText = 'font-size:11px;margin:6px 0';
            const range = config()[axis+'range'] || {start: target.value, end: target.value + meta.step * 4, step: meta.step};
            const inputs = {}, fields = make('div'); fields.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px';
            for (const key of ['start','end','step']) {
                const label = make('label',key[0].toUpperCase()+key.slice(1)); label.style.minWidth = '0';
                const input = make('input'); input.type = 'number'; input.value = String(range[key]); input.step = String(meta.integer ? Math.max(1,meta.step) : meta.step);
                input.style.cssText = 'width:100%;box-sizing:border-box';
                if (key !== 'step' && meta.min != null) input.min = String(meta.min);
                if (key !== 'step' && meta.max != null) input.max = String(meta.max);
                input.oninput = () => { config()[axis+'range'] = Object.fromEntries(Object.entries(inputs).map(([k,e])=>[k,e.value])); changed(); };
                label.append(input); fields.append(label); inputs[key] = input;
            }
            const apply = make('button','Use range'), suggest = make('button','Suggest values');
            apply.onclick = () => { try { write(numericRange(inputs.start.value,inputs.end.value,inputs.step.value,meta)); } catch (error) { summary.textContent = error.message; } };
            suggest.onclick = () => write(suggestedNumbers(target.input,meta));
            panel.append(bounds, fields, apply, suggest);
        } else {
            const hint = make('div', meta.multiline ? 'Use a JSON array to compare complete multiline prompts. Example: ["first prompt", "second prompt"].' : 'Enter text alternatives below, or use a JSON array to preserve whitespace and empty strings.');
            hint.style.cssText = 'font-size:12px;margin-top:6px'; panel.append(hint);
        }
        updateSummary();
    }
    function populateSettings(nodeId) {
        settings.replaceChildren(option(make,'','Choose a setting'));
        for (const [key,target] of groups.get(nodeId) || []) settings.append(option(make,key,target.settingLabel));
        settings.value = targetMap().has(config()[axis]) && selectedTarget().id === nodeId ? config()[axis] : '';
    }
    function sync() {
        textarea.value = config()[axis+'v'] || '';
        format.value = config()[axis+'format'] === 'json' ? 'json' : 'lines';
        const target = selectedTarget();
        nodes.value = target?.id || '';
        populateSettings(nodes.value); renderPanel();
    }
    function setTargets() {
        groups = new Map();
        for (const [key,target] of targetMap()) {
            if (!groups.has(target.id)) groups.set(target.id,[]);
            groups.get(target.id).push([key,target]);
        }
        nodes.replaceChildren(option(make,'','Choose a node'));
        for (const [id,entries] of [...groups].sort((a,b)=>a[1][0][1].nodeLabel.localeCompare(b[1][0][1].nodeLabel,undefined,{numeric:true}))) nodes.append(option(make,id,entries[0][1].nodeLabel));
        sync();
    }
    nodes.onchange = () => { config()[axis] = ''; config()[axis+'v'] = ''; textarea.value = ''; panel.replaceChildren(); populateSettings(nodes.value); info.textContent = ''; changed(); updateSummary(); };
    settings.onchange = () => {
        config()[axis] = settings.value; delete config()[axis+'range'];
        const target = selectedTarget();
        format.value = target?.meta.multiline ? 'json' : 'lines';
        if (target) write(target.meta.kind === 'boolean' ? [false,true] : [target.value]); else write([]);
        renderPanel();
    };
    textarea.oninput = () => { save(); renderPanel(); };
    format.onchange = () => {
        const oldFormat = config()[axis+'format'] === 'json' ? 'json' : 'lines';
        try {
            const values = settingValues(textarea.value,selectedTarget(),oldFormat);
            if (format.value === 'lines' && values.some(v => typeof v === 'string' && (v.includes('\n') || v.trim() !== v || !v.length))) {
                format.value = oldFormat;
                summary.textContent = 'Keep JSON format to preserve multiline text, whitespace and empty strings.';
                return;
            }
            textarea.value = format.value === 'json' ? JSON.stringify(values,null,2) : values.map(String).join('\n');
        } catch { /* Preserve incomplete edits. */ }
        save(); renderPanel();
    };
    return {box, nodes, settings, textarea, panel, format, summary, setTargets, sync};
}
