const state = {
    projectPath: null,
    scanResult: null,
    userStory: '',
    entryPoint: null
};

const els = {
    chip: document.getElementById('project-chip'),
    chipLabel: document.getElementById('chip-label'),
    projectPanel: document.getElementById('project-panel'),
    form: document.getElementById('scan-form'),
    pathInput: document.getElementById('path-input'),
    scanBtn: document.getElementById('scan-btn'),
    disconnectBtn: document.getElementById('disconnect-btn'),
    status: document.getElementById('scan-status'),
    statusText: document.getElementById('status-text'),
    error: document.getElementById('scan-error'),
    scanResult: document.getElementById('scan-result'),
    scanSummaryText: document.getElementById('scan-summary-text'),
    panels: document.querySelectorAll('.panel'),
    steps: document.querySelectorAll('.step')
};

// --- Project chip ---

els.chip.addEventListener('click', () => {
    const open = els.projectPanel.classList.toggle('hidden') === false;
    els.chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) setTimeout(() => els.pathInput.focus(), 0);
});

els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const path = els.pathInput.value.trim();
    if (!path) return;
    await runScan(path);
});

els.disconnectBtn.addEventListener('click', () => {
    state.projectPath = null;
    state.scanResult = null;
    els.pathInput.value = '';
    els.scanResult.classList.add('hidden');
    els.disconnectBtn.classList.add('hidden');
    els.chip.classList.remove('connected');
    els.chipLabel.textContent = 'Connect project';
    populateTypesDatalist();
    populateCalleesDatalist();
});

async function runScan(path) {
    els.error.classList.add('hidden');
    els.scanResult.classList.add('hidden');
    els.status.classList.remove('hidden');
    els.statusText.textContent = 'Scanning project…';
    els.scanBtn.disabled = true;
    els.pathInput.disabled = true;

    try {
        const res = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Scan failed (${res.status})`);

        state.projectPath = data.path;
        state.scanResult = data;
        renderScanResult(data);
        populateTypesDatalist();
        populateCalleesDatalist();
    } catch (err) {
        els.error.textContent = err.message;
        els.error.classList.remove('hidden');
    } finally {
        els.status.classList.add('hidden');
        els.scanBtn.disabled = false;
        els.pathInput.disabled = false;
    }
}

function renderScanResult(data) {
    const name = shortProjectName(data.path);
    els.chip.classList.add('connected');
    els.chipLabel.textContent = name;
    els.chip.title = data.path;

    els.scanSummaryText.textContent =
        `${data.fileCount} files · ${data.classes.length} classes · ${data.interfaces.length} interfaces · ${data.dataTypes.length} data types` +
        (data.skippedCount > 0 ? ` · ${data.skippedCount} skipped` : '');
    els.scanResult.classList.remove('hidden');
    els.disconnectBtn.classList.remove('hidden');
}

function shortProjectName(path) {
    if (!path) return 'project';
    const parts = path.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || path;
}

// --- Navigation ---

document.addEventListener('click', (e) => {
    const back = e.target.closest('[data-back]');
    if (back) goToStep(parseInt(back.dataset.back, 10));
});

function goToStep(n) {
    els.panels.forEach(p => p.classList.toggle('hidden', p.id !== `panel-${n}`));
    els.steps.forEach(s => {
        const step = parseInt(s.dataset.step, 10);
        s.classList.toggle('active', step === n);
        s.classList.toggle('done', step < n);
    });
    if (n === 2) enterStep2();
    if (n === 3) enterStep3();
    if (n === 4) enterStep4();
    if (n === 5) enterStep5();
}

// --- Step 1: story ---

const storyInput = document.getElementById('story-input');
document.getElementById('story-next').addEventListener('click', () => {
    const value = storyInput.value.trim();
    if (!value) { storyInput.focus(); return; }
    state.userStory = value;
    goToStep(2);
});

// --- Step 2: entry point ---

const STOPWORDS = new Set('the a an is are was were to for of and or but with from by on in at as it this that these those be been being have has had i you we they he she want wants will would should could may might do does did not if so am as user users their our your my'.split(' '));

function storyKeywords(text) {
    if (!text) return new Set();
    return new Set(
        text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3 && !STOPWORDS.has(w))
    );
}

function splitCamel(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
               .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
               .toLowerCase()
               .split(/\s+/)
               .filter(Boolean);
}

function scoreAgainstStory(name, kwSet) {
    const tokens = splitCamel(name);
    return tokens.filter(t => kwSet.has(t)).length;
}

const entryEls = {
    storyEcho: document.getElementById('story-echo'),
    sutClass: document.getElementById('sut-class'),
    sutClassSuggestions: document.getElementById('sut-class-suggestions'),
    sutClassNewHint: document.getElementById('sut-class-new-hint'),
    sutPackage: document.getElementById('sut-package'),
    sutMethod: document.getElementById('sut-method'),
    methodPicks: document.getElementById('method-picks'),
    paramsList: document.getElementById('params-list'),
    addParam: document.getElementById('add-param'),
    sutReturn: document.getElementById('sut-return'),
    typesDatalist: document.getElementById('types-datalist'),
    entryNext: document.getElementById('entry-next')
};

function enterStep2() {
    if (state.userStory) {
        entryEls.storyEcho.textContent = state.userStory;
        entryEls.storyEcho.classList.remove('hidden');
    } else {
        entryEls.storyEcho.classList.add('hidden');
    }
    populateTypesDatalist();
    updateClassIsNew();
}

function populateTypesDatalist() {
    const items = ['void', 'boolean', 'int', 'long', 'double', 'String'];
    const scan = state.scanResult;
    if (scan) {
        scan.interfaces.forEach(i => items.push(i.name));
        scan.dataTypes.forEach(d => items.push(d.name));
    }
    entryEls.typesDatalist.innerHTML = [...new Set(items)]
        .map(t => `<option value="${escapeHtml(t)}">`)
        .join('');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function scannedServices() {
    const scan = state.scanResult;
    if (!scan) return [];
    return [...scan.classes, ...scan.interfaces];
}

function refreshClassSuggestions() {
    const all = scannedServices();
    if (all.length === 0) {
        entryEls.sutClassSuggestions.classList.add('hidden');
        updateClassIsNew();
        return;
    }
    const query = entryEls.sutClass.value.trim().toLowerCase();
    const kwSet = storyKeywords(state.userStory);

    const filtered = all
        .filter(c => !query || c.name.toLowerCase().includes(query))
        .map(c => ({
            c,
            score: scoreAgainstStory(c.name, kwSet),
            starts: query ? c.name.toLowerCase().startsWith(query) : false
        }))
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.starts !== a.starts) return (b.starts ? 1 : 0) - (a.starts ? 1 : 0);
            return a.c.name.localeCompare(b.c.name);
        })
        .slice(0, 8);

    if (filtered.length === 0) {
        entryEls.sutClassSuggestions.classList.add('hidden');
        updateClassIsNew();
        return;
    }

    entryEls.sutClassSuggestions.innerHTML = filtered.map(({ c, score }) => `
        <div class="suggestion" data-name="${escapeHtml(c.name)}" data-pkg="${escapeHtml(c.packageName)}">
            <div><strong>${escapeHtml(c.name)}</strong><span class="pkg">${escapeHtml(c.packageName)}</span></div>
            ${score > 0 ? '<span class="match-badge">story match</span>' : ''}
        </div>
    `).join('');
    entryEls.sutClassSuggestions.classList.remove('hidden');
    updateClassIsNew();
}

function updateClassIsNew() {
    const name = entryEls.sutClass.value.trim();
    if (!name) {
        entryEls.sutClassNewHint.className = 'hint hidden';
        entryEls.methodPicks.classList.add('hidden');
        return;
    }
    const match = scannedServices().find(c => c.name === name);
    if (match) {
        entryEls.sutClassNewHint.textContent = `Existing service — found in ${match.packageName}`;
        entryEls.sutClassNewHint.className = 'hint hint-found';
        renderMethodPicks(match.methods);
    } else {
        const implName = 'Default' + name;
        entryEls.sutClassNewHint.textContent = `New service — ${implName} will be created`;
        entryEls.sutClassNewHint.className = 'hint hint-new';
        entryEls.methodPicks.classList.add('hidden');
    }
}

function renderMethodPicks(methods) {
    if (!methods || methods.length === 0) {
        entryEls.methodPicks.classList.add('hidden');
        return;
    }
    entryEls.methodPicks.innerHTML = methods
        .map(m => `<button type="button" class="method-pick" data-method="${escapeHtml(m)}">${escapeHtml(m)}</button>`)
        .join('');
    entryEls.methodPicks.classList.remove('hidden');
}

entryEls.sutClass.addEventListener('input', refreshClassSuggestions);
entryEls.sutClass.addEventListener('focus', refreshClassSuggestions);

entryEls.sutClassSuggestions.addEventListener('click', (e) => {
    const row = e.target.closest('.suggestion');
    if (!row) return;
    entryEls.sutClass.value = row.dataset.name;
    entryEls.sutPackage.value = row.dataset.pkg;
    entryEls.sutClassSuggestions.classList.add('hidden');
    updateClassIsNew();
    entryEls.sutMethod.focus();
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('.typeahead')) {
        entryEls.sutClassSuggestions.classList.add('hidden');
    }
});

entryEls.methodPicks.addEventListener('click', (e) => {
    const btn = e.target.closest('.method-pick');
    if (!btn) return;
    entryEls.sutMethod.value = btn.dataset.method;
});

function addParamRow(name = '', type = '') {
    const row = document.createElement('div');
    row.className = 'param-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'name (e.g. orderId)';
    nameInput.value = name;
    const typeInput = document.createElement('input');
    typeInput.type = 'text';
    typeInput.setAttribute('list', 'types-datalist');
    typeInput.placeholder = 'type (e.g. Long)';
    typeInput.value = type;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-param';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => row.remove());
    row.append(nameInput, typeInput, removeBtn);
    entryEls.paramsList.appendChild(row);
}

entryEls.addParam.addEventListener('click', () => addParamRow());

function collectParams() {
    return Array.from(entryEls.paramsList.querySelectorAll('.param-row'))
        .map(row => {
            const [nameInput, typeInput] = row.querySelectorAll('input');
            return { name: nameInput.value.trim(), type: typeInput.value.trim() };
        })
        .filter(p => p.name || p.type);
}

entryEls.entryNext.addEventListener('click', () => {
    const className = entryEls.sutClass.value.trim();
    const packageName = entryEls.sutPackage.value.trim();
    const methodName = entryEls.sutMethod.value.trim();
    const returnType = entryEls.sutReturn.value.trim();

    if (!className) { entryEls.sutClass.focus(); return; }
    if (!methodName) { entryEls.sutMethod.focus(); return; }

    const scan = state.scanResult;
    const matchClass = scan ? scan.classes.find(c => c.name === className) : null;
    const matchMethod = matchClass ? matchClass.methods.includes(methodName) : false;

    state.entryPoint = {
        className,
        packageName,
        isNew: !matchClass,
        method: {
            name: methodName,
            parameters: collectParams(),
            returnType,
            isNew: !matchMethod
        }
    };

    goToStep(3);
});

// --- Step 3: collaborators (PlantUML-style text editor) ---

const umlEls = {
    textarea: document.getElementById('uml-input'),
    participants: document.getElementById('uml-participants'),
    errors: document.getElementById('uml-errors'),
    next: document.getElementById('arrows-next')
};

let parsedUml = { arrows: [], items: [], participants: [], errors: [] };

const UML_LINE_RE = /^([A-Za-z_][\w]*)\s*(->|<-)\s*([A-Za-z_][\w]*)\s*(?::\s*(.+?))?\s*$/;
const LOOP_LINE_RE = /^loop\b\s*(.*)$/i;
const END_LINE_RE = /^end$/i;

function parseUml(text) {
    const arrows = [];
    const items = [];
    const participantSet = new Set();
    const errors = [];
    const stack = [];

    text.split('\n').forEach((raw, idx) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;

        const loopMatch = line.match(LOOP_LINE_RE);
        if (loopMatch) {
            items.push({ kind: 'loop', text: loopMatch[1].trim(), lineNo: idx + 1 });
            return;
        }
        if (END_LINE_RE.test(line)) {
            items.push({ kind: 'end', lineNo: idx + 1 });
            return;
        }

        const m = line.match(UML_LINE_RE);
        if (!m) {
            errors.push({ lineNo: idx + 1, msg: `Can't parse "${line}"` });
            return;
        }
        const [, left, dir, right, label = ''] = m;
        participantSet.add(left);
        participantSet.add(right);

        if (dir === '->') {
            const depth = stack.length;
            const arrow = { kind: 'call', left, right, label, depth, lineNo: idx + 1 };
            arrows.push(arrow);
            items.push(arrow);
            stack.push({ caller: left, callee: right, depth });
        } else {
            let matchIdx = -1;
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].caller === left && stack[i].callee === right) {
                    matchIdx = i;
                    break;
                }
            }
            let depth;
            if (matchIdx === -1) {
                errors.push({ lineNo: idx + 1, msg: `"${line}" has no matching call` });
                depth = stack.length;
            } else {
                depth = stack[matchIdx].depth;
                stack.splice(matchIdx, 1);
            }
            const arrow = { kind: 'return', left, right, label, depth, lineNo: idx + 1 };
            arrows.push(arrow);
            items.push(arrow);
        }
    });

    return { arrows, items, participants: [...participantSet], errors };
}

function emitPlantUml() {
    reparseUml();
    const lines = ['@startuml'];
    let loopDepth = 0;
    const indent = () => '    '.repeat(loopDepth);

    parsedUml.items.forEach(it => {
        if (it.kind === 'loop') {
            const text = it.text ? ` ${it.text}` : '';
            lines.push(`${indent()}loop${text}`);
            loopDepth++;
        } else if (it.kind === 'end') {
            loopDepth = Math.max(0, loopDepth - 1);
            lines.push(`${indent()}end`);
        } else if (it.kind === 'call') {
            const isCreate = it.label && it.label.trim() === '<<create>>';
            const arrow = isCreate ? '-->' : '->';
            const suffix = it.label ? `: ${it.label}` : '';
            lines.push(`${indent()}${it.left} ${arrow} ${it.right}${suffix}`);
        } else if (it.kind === 'return') {
            const suffix = it.label ? `: ${it.label}` : '';
            lines.push(`${indent()}${it.left} <-- ${it.right}${suffix}`);
        }
    });

    lines.push('@enduml');
    return lines.join('\n') + '\n';
}

function renderUmlFeedback() {
    const { arrows, participants, errors } = parsedUml;

    umlEls.participants.innerHTML = participants.length === 0
        ? '<span class="uml-empty">No participants yet.</span>'
        : participants.map((p, i) =>
            `<span class="participant-pill ${i === 0 ? 'sut' : ''}">${escapeHtml(p)}</span>`
        ).join('');

    if (errors.length === 0) {
        umlEls.errors.classList.add('hidden');
        umlEls.errors.innerHTML = '';
    } else {
        umlEls.errors.classList.remove('hidden');
        umlEls.errors.innerHTML = errors.map(e =>
            `<div class="uml-error">Line ${e.lineNo}: ${escapeHtml(e.msg)}</div>`
        ).join('');
    }
}

function reparseUml() {
    parsedUml = parseUml(umlEls.textarea.value);
    renderUmlFeedback();
}

umlEls.textarea.addEventListener('input', reparseUml);

function enterStep3() {
    reparseUml();
}

umlEls.next.addEventListener('click', () => {
    reparseUml();
    const calls = parsedUml.arrows.filter(a => a.kind === 'call');
    if (calls.length === 0) {
        umlEls.textarea.focus();
        return;
    }
    goToStep(4);
});

// --- Step 4: preview ---

const previewEl = document.getElementById('preview-area');

function enterStep4() {
    reparseUml();
    const { arrows, items, participants } = parsedUml;

    if (arrows.length === 0) {
        previewEl.innerHTML = '<div class="preview-empty">No arrows defined. Go back and add some.</div>';
        return;
    }

    const sutName = state.entryPoint ? state.entryPoint.className : (participants[0] || '');
    const ordered = [sutName, ...participants.filter(p => p !== sutName)];

    const pills = ordered.map((p, i) =>
        `<span class="participant-pill ${i === 0 ? 'sut' : ''}">${escapeHtml(p)}</span>`
    ).join('');

    const rows = items.map(it => {
        if (it.kind === 'loop') {
            return `
                <div class="preview-row fragment">
                    <span class="fragment-label">loop</span>
                    <span class="fragment-text">${escapeHtml(it.text || '')}</span>
                </div>
            `;
        }
        if (it.kind === 'end') {
            return `
                <div class="preview-row fragment">
                    <span class="fragment-label">end</span>
                    <span class="fragment-text"></span>
                </div>
            `;
        }
        const label = it.label ? escapeHtml(it.label) : '';
        const pad = it.depth * 1.5;
        return `
            <div class="preview-row ${it.kind}" style="padding-left:${pad}rem">
                <span class="who left">${escapeHtml(it.left)}</span>
                <span class="arrow-line">
                    ${label ? `<span class="arrow-label">${label}</span>` : ''}
                    <span class="arrow-glyph"></span>
                </span>
                <span class="who right">${escapeHtml(it.right)}</span>
            </div>
        `;
    }).join('');

    previewEl.innerHTML = `
        <div class="preview-participants">${pills}</div>
        ${rows}
    `;
}

document.getElementById('preview-next').addEventListener('click', () => goToStep(5));

// --- Step 5: generate ---

const outputEl = document.getElementById('output');
const copyFeedbackEl = document.getElementById('copy-feedback');

const saveEls = {
    filename: document.getElementById('puml-filename'),
    save: document.getElementById('save-to-project'),
    result: document.getElementById('save-result'),
    resultPath: document.getElementById('save-result-path'),
    resultCommand: document.getElementById('save-result-command'),
    copyCommand: document.getElementById('copy-command'),
    error: document.getElementById('save-error'),
    commandFeedback: document.getElementById('command-feedback'),
    runBtn: document.getElementById('run-disc'),
    runConsole: document.getElementById('run-console')
};

let lastSavedRelativePath = null;

function kebab(s) {
    return String(s || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
}

function defaultFileName() {
    const ep = state.entryPoint;
    if (!ep) return 'design.puml';
    const cls = kebab(ep.className || 'design');
    const method = kebab(ep.method && ep.method.name || '');
    return method ? `${cls}-${method}.puml` : `${cls}.puml`;
}

function enterStep5() {
    outputEl.textContent = emitPlantUml();
    if (!saveEls.filename.value.trim()) {
        saveEls.filename.value = defaultFileName();
    }
    saveEls.result.classList.add('hidden');
    saveEls.error.classList.add('hidden');
}

saveEls.save.addEventListener('click', async () => {
    saveEls.error.classList.add('hidden');
    saveEls.result.classList.add('hidden');

    if (!state.projectPath) {
        saveEls.error.textContent = 'Connect a project first — click the chip in the header and paste your project path.';
        saveEls.error.classList.remove('hidden');
        return;
    }

    const content = outputEl.textContent;
    if (!content || !content.trim()) {
        saveEls.error.textContent = 'Nothing to save — add some arrows in Step 3.';
        saveEls.error.classList.remove('hidden');
        return;
    }

    const fileName = saveEls.filename.value.trim() || defaultFileName();
    saveEls.save.disabled = true;
    const originalLabel = saveEls.save.textContent;
    saveEls.save.textContent = 'Saving…';

    try {
        const res = await fetch('/api/design', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: state.projectPath, fileName, content })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);

        saveEls.resultPath.textContent = data.savedPath;
        saveEls.resultCommand.textContent = `/design-is-code:disc ${data.relativePath}`;
        lastSavedRelativePath = data.relativePath;
        saveEls.runConsole.textContent = '';
        saveEls.runConsole.classList.add('hidden');
        saveEls.result.classList.remove('hidden');
    } catch (err) {
        saveEls.error.textContent = err.message;
        saveEls.error.classList.remove('hidden');
    } finally {
        saveEls.save.disabled = false;
        saveEls.save.textContent = originalLabel;
    }
});

saveEls.runBtn.addEventListener('click', async () => {
    if (!lastSavedRelativePath || !state.projectPath) return;

    saveEls.runBtn.disabled = true;
    const originalLabel = saveEls.runBtn.textContent;
    saveEls.runBtn.textContent = 'Running…';
    saveEls.runConsole.textContent = '';
    saveEls.runConsole.classList.remove('hidden');

    try {
        const response = await fetch('/api/run-disc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: state.projectPath,
                filePath: lastSavedRelativePath
            })
        });

        if (!response.ok || !response.body) {
            const text = await response.text();
            saveEls.runConsole.textContent += text || `Request failed (${response.status})`;
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            saveEls.runConsole.textContent += decoder.decode(value, { stream: true });
            saveEls.runConsole.scrollTop = saveEls.runConsole.scrollHeight;
        }
    } catch (err) {
        saveEls.runConsole.textContent += `\n[error] ${err.message}\n`;
    } finally {
        saveEls.runBtn.disabled = false;
        saveEls.runBtn.textContent = originalLabel;
    }
});

saveEls.copyCommand.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(saveEls.resultCommand.textContent);
        saveEls.commandFeedback.textContent = 'Copied ✓';
        setTimeout(() => { saveEls.commandFeedback.textContent = ''; }, 1800);
    } catch {
        saveEls.commandFeedback.textContent = 'Copy failed';
    }
});

document.getElementById('copy-output').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(outputEl.textContent);
        copyFeedbackEl.textContent = 'Copied ✓';
        setTimeout(() => { copyFeedbackEl.textContent = ''; }, 1800);
    } catch (err) {
        copyFeedbackEl.textContent = 'Copy failed';
    }
});

// --- Demo prefill ---
// Seeded with the "generate invoice" example so a blank-slate run of the
// wizard produces a valid PlantUML diagram end-to-end. Everything below is
// just default input values — the user can edit any field.

const DEMO_PROJECT_PATH = '/Users/mossgu/Downloads/demo';

(function initDemo() {
    storyInput.value =
        "As accounting, I want to generate an invoice for a customer that " +
        "includes every order they've placed, so we can bill them in one go.";

    entryEls.sutClass.value = 'InvoiceService';
    entryEls.sutPackage.value = 'com.example.invoice';
    entryEls.sutMethod.value = 'generateInvoice';
    addParamRow('customerId', 'UUID');
    entryEls.sutReturn.value = 'Invoice';

    umlEls.textarea.value = [
        'InvoiceService -> OrderRepository : findAllByCustomerId(customerId)',
        'InvoiceService <- OrderRepository : orders: List<Order>',
        'InvoiceService -> InvoiceBuilderFactory : create()',
        'InvoiceBuilderFactory -> InvoiceBuilder : <<create>>',
        'InvoiceService <- InvoiceBuilderFactory : invoiceBuilder: InvoiceBuilder',
        'loop for each order in orders',
        '    InvoiceService -> InvoiceBuilder : addLine(order)',
        'end',
        'InvoiceService -> InvoiceBuilder : build()',
        'InvoiceService <- InvoiceBuilder : invoice: Invoice'
    ].join('\n');

    // Default target project + auto-connect so the save-to-project step
    // "just works" with no manual path entry. If the path doesn't exist
    // the scan shows an error and the user can edit the path chip.
    els.pathInput.value = DEMO_PROJECT_PATH;
    state.projectPath = DEMO_PROJECT_PATH;
    els.chip.classList.add('connected');
    els.chipLabel.textContent = shortProjectName(DEMO_PROJECT_PATH);
    els.chip.title = DEMO_PROJECT_PATH;
    runScan(DEMO_PROJECT_PATH);
})();
