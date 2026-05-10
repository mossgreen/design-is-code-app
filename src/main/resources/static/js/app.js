const state = {
    projectPath: null,
    scanResult: null,
    userStory: '',
    participants: [],
    sequence: [],
    targetPackage: ''
};

// Java package name validator: at least two segments, each starting with a
// lowercase letter, dotted. e.g. com.example.invoice
const JAVA_PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

let nextId = 1;
const newId = () => `id-${nextId++}`;

// STEP_KIND. Sequences are linear; fragments are expressed as paired
// frag-start / frag-else / frag-end markers. fragType picks the PlantUML
// keyword (loop, while, foreach, alt, opt, par). LOOP_START/LOOP_END are
// preserved as a back-compat shorthand for plain `loop` fragments and are
// normalised into FRAG markers when emitted/rendered.
const STEP_KIND = {
    CALL: 'call',
    LOOP_START: 'loop-start',
    LOOP_END: 'loop-end',
    FRAG_START: 'frag-start',
    FRAG_ELSE: 'frag-else',
    FRAG_END: 'frag-end'
};

// fragType -> { plantUml keyword, default label, allows else, glyph, label, color }
const FRAG_TYPES = {
    loop:    { keyword: 'loop',  defaultLabel: 'for each item', allowsElse: false, glyph: '↻', label: 'loop',     color: '#4f46e5' },
    while:   { keyword: 'loop',  defaultLabel: 'while condition', allowsElse: false, glyph: '↻', label: 'while',  color: '#4f46e5', emitPrefix: 'while ' },
    foreach: { keyword: 'loop',  defaultLabel: 'for each item in items', allowsElse: false, glyph: '↻', label: 'for each', color: '#4f46e5', emitPrefix: 'for each ' },
    alt:     { keyword: 'alt',   defaultLabel: 'if condition',  allowsElse: true,  glyph: '◇', label: 'if',       color: '#0e7490' },
    opt:     { keyword: 'opt',   defaultLabel: 'if optional',   allowsElse: false, glyph: '◇', label: 'opt',      color: '#7c3aed' },
    par:     { keyword: 'par',   defaultLabel: 'branch A',      allowsElse: true,  glyph: '⇶', label: 'par',      color: '#0891b2' }
};

function fragMeta(type) { return FRAG_TYPES[type] || FRAG_TYPES.loop; }

function isFragStart(s) { return s.kind === STEP_KIND.FRAG_START || s.kind === STEP_KIND.LOOP_START; }
function isFragEnd(s)   { return s.kind === STEP_KIND.FRAG_END   || s.kind === STEP_KIND.LOOP_END; }
function isFragElse(s)  { return s.kind === STEP_KIND.FRAG_ELSE; }

// Normalise a step's effective fragType: legacy LOOP_START is treated as
// fragType: 'loop'. FRAG_START carries its fragType explicitly.
function effectiveFragType(s) {
    if (s.kind === STEP_KIND.LOOP_START) return 'loop';
    if (s.kind === STEP_KIND.FRAG_START) return s.fragType || 'loop';
    return null;
}

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
}

// --- Step 1: story ---

const storyInput = document.getElementById('story-input');
document.getElementById('story-next').addEventListener('click', () => {
    const value = storyInput.value.trim();
    if (!value) { storyInput.focus(); return; }
    state.userStory = value;
    goToStep(2);
});

// --- Step 2: participants & flow ---

const step2Els = {
    storyEcho: document.getElementById('story-echo'),
    participantsList: document.getElementById('participants-list'),
    stepsBoard: document.getElementById('steps-board'),
    stepsCount: document.getElementById('steps-count'),
    sequenceHint: document.getElementById('sequence-hint'),
    typesDatalist: document.getElementById('types-datalist'),
    flowNext: document.getElementById('flow-next'),
    modal: document.getElementById('participant-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalName: document.getElementById('modal-name'),
    modalMethods: document.getElementById('modal-methods'),
    modalAddMethod: document.getElementById('modal-add-method'),
    modalClose: document.getElementById('modal-close'),
    modalDelete: document.getElementById('modal-delete'),
    modalDone: document.getElementById('modal-done'),
    modalImpl: document.getElementById('modal-impl'),
    modalMethodsCount: document.getElementById('modal-methods-count'),
    participantsCount: document.getElementById('participants-count')
};

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function populateTypesDatalist() {
    const items = ['void', 'boolean', 'int', 'long', 'double', 'String'];
    const scan = state.scanResult;
    if (scan) {
        scan.interfaces.forEach(i => items.push(i.name));
        scan.dataTypes.forEach(d => items.push(d.name));
    }
    state.participants.forEach(p => { if (p.name) items.push(p.name); });
    step2Els.typesDatalist.innerHTML = [...new Set(items)]
        .map(t => `<option value="${escapeHtml(t)}">`)
        .join('');
}

// --- Participant model ---

function makeParticipant(name = '', implByDefault = true) {
    return { id: newId(), name, implByDefault, methods: [] };
}

function makeMethod(name = '', inputs = [], output = '') {
    return { id: newId(), name, inputs, output };
}

function findParticipant(id) { return state.participants.find(p => p.id === id); }
function findMethod(participantId, methodId) {
    const p = findParticipant(participantId);
    return p ? p.methods.find(m => m.id === methodId) : null;
}

function methodSignature(m) {
    const inputs = (m.inputs || []).map(i => `${i.name || ''}${i.type ? ': ' + i.type : ''}`.trim()).filter(Boolean).join(', ');
    return `${m.name || '?'}(${inputs})`;
}

function methodPreviewSignature(m) {
    const types = (m.inputs || []).map(i => (i.type || '').trim()).filter(Boolean).join(', ');
    const out = (m.output || '').trim() || 'void';
    return `${m.name || '?'}(${types}) → ${out}`;
}

function returnLabelFor(m) {
    if (!m || !m.output || m.output.trim() === '' || m.output.trim().toLowerCase() === 'void') return null;
    return m.output.trim();
}

// Returns Map<step.id, participant | null>. A call step "creates" a participant
// when (a) its method's output exactly matches a defined participant's name AND
// (b) that participant has not been referenced (caller, callee, or earlier
// create-target) by any prior step in the sequence. Loop fragments are skipped.
function resolveCreates(seq) {
    const seq2 = seq || state.sequence;
    const seen = new Set();
    const map = new Map();
    for (const s of seq2) {
        if (s.kind !== STEP_KIND.CALL) continue;
        const method = findMethod(s.calleeId, s.methodId);
        const ret = method ? returnLabelFor(method) : null;
        let created = null;
        if (ret) {
            const target = state.participants.find(p => p.name && p.name === ret);
            if (target && !seen.has(target.id)) created = target;
        }
        map.set(s.id, created);
        if (s.callerId) seen.add(s.callerId);
        if (s.calleeId) seen.add(s.calleeId);
        if (created) seen.add(created.id);
    }
    return map;
}

// --- Step 2 entry ---

function enterStep2() {
    if (state.userStory) {
        step2Els.storyEcho.textContent = state.userStory;
        step2Els.storyEcho.classList.remove('hidden');
    } else {
        step2Els.storyEcho.classList.add('hidden');
    }
    populateTypesDatalist();
    renderParticipants();
    renderSequence();
}

// --- Participants UI ---

function renderParticipants() {
    const list = step2Els.participantsList;
    list.innerHTML = '';
    const n = state.participants.length;
    step2Els.participantsCount.textContent = `${n} class${n === 1 ? '' : 'es'}`;

    state.participants.forEach((p, idx) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'pc-card';
        if (idx === 0) card.classList.add('caller');
        card.dataset.id = p.id;

        const previewMethods = p.methods.slice(0, 3).map(m => {
            return escapeHtml(methodPreviewSignature(m));
        }).join('<br>');
        const moreCount = p.methods.length - 3;

        card.innerHTML = `
            <div class="pc-card-head">
                ${idx === 0 ? '<span class="caller-badge" title="Caller of the main chain">CALLER</span>' : ''}
                <span class="pc-card-name">${escapeHtml(p.name || '(unnamed)')}</span>
                ${p.implByDefault ? '<span class="impl-badge" title="A default implementation will be generated">IMPL</span>' : ''}
            </div>
            <div class="pc-card-methods">
                ${p.methods.length === 0 ? '<span class="pc-card-empty">no methods</span>' : previewMethods}
                ${moreCount > 0 ? `<div class="pc-card-more">+${moreCount} more</div>` : ''}
            </div>
        `;
        card.addEventListener('click', () => openModal(p.id));
        list.appendChild(card);
    });

    const addTile = document.createElement('button');
    addTile.type = 'button';
    addTile.className = 'pc-add-tile';
    addTile.textContent = '+ new class';
    addTile.addEventListener('click', () => {
        const p = makeParticipant();
        state.participants.push(p);
        openModal(p.id);
    });
    list.appendChild(addTile);
}

// --- Modal ---

let modalParticipantId = null;

function openModal(id) {
    modalParticipantId = id;
    const p = findParticipant(id);
    if (!p) return;
    step2Els.modalTitle.textContent = p.name ? `Edit ${p.name}` : 'New participant';
    step2Els.modalName.value = p.name;
    step2Els.modalImpl.checked = !!p.implByDefault;
    renderModalMethods();
    step2Els.modal.classList.remove('hidden');
    setTimeout(() => step2Els.modalName.focus(), 0);
}

function closeModal() {
    if (!modalParticipantId) return;
    const p = findParticipant(modalParticipantId);
    if (p && !p.name.trim() && p.methods.length === 0) {
        // discard empty participants on close
        state.participants = state.participants.filter(x => x.id !== p.id);
    }
    modalParticipantId = null;
    step2Els.modal.classList.add('hidden');
    populateTypesDatalist();
    renderParticipants();
    renderSequence();
}

function renderModalMethods() {
    const p = findParticipant(modalParticipantId);
    if (!p) return;
    step2Els.modalMethods.innerHTML = '';
    p.methods.forEach(m => step2Els.modalMethods.appendChild(renderMethodRow(p, m)));
    step2Els.modalMethodsCount.textContent = String(p.methods.length);
}

step2Els.modalName.addEventListener('input', (e) => {
    const p = findParticipant(modalParticipantId);
    if (p) p.name = e.target.value;
});

step2Els.modalImpl.addEventListener('change', (e) => {
    const p = findParticipant(modalParticipantId);
    if (p) p.implByDefault = e.target.checked;
});

step2Els.modalAddMethod.addEventListener('click', () => {
    const p = findParticipant(modalParticipantId);
    if (!p) return;
    const m = makeMethod();
    p.methods.push(m);
    step2Els.modalMethods.appendChild(renderMethodRow(p, m));
    step2Els.modalMethodsCount.textContent = String(p.methods.length);
});

step2Els.modalDelete.addEventListener('click', () => {
    const p = findParticipant(modalParticipantId);
    if (!p) return;
    state.participants = state.participants.filter(x => x.id !== p.id);
    state.sequence = state.sequence.filter(c =>
        c.kind !== STEP_KIND.CALL || (c.callerId !== p.id && c.calleeId !== p.id)
    );
    modalParticipantId = null;
    step2Els.modal.classList.add('hidden');
    populateTypesDatalist();
    renderParticipants();
    renderSequence();
});

step2Els.modalDone.addEventListener('click', closeModal);
step2Els.modalClose.addEventListener('click', closeModal);
step2Els.modal.addEventListener('click', (e) => {
    if (e.target === step2Els.modal) closeModal();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !step2Els.modal.classList.contains('hidden')) closeModal();
});

function renderMethodRow(participant, method) {
    const row = document.createElement('div');
    row.className = 'method-block';
    row.dataset.id = method.id;

    const head = document.createElement('div');
    head.className = 'mb-head';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'mb-name';
    name.placeholder = 'what it does';
    name.value = method.name;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn mb-remove';
    remove.title = 'Remove method';
    remove.textContent = '×';

    head.append(name, remove);

    const inRow = document.createElement('div');
    inRow.className = 'mb-row';
    const inTag = document.createElement('span');
    inTag.className = 'io-tag';
    inTag.textContent = 'in';
    const inputsWrap = document.createElement('div');
    inputsWrap.className = 'mb-inputs';
    inRow.append(inTag, inputsWrap);

    const renderInputs = () => {
        inputsWrap.innerHTML = '';
        if (method.inputs.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'mb-empty';
            empty.textContent = '(no parameters)';
            inputsWrap.appendChild(empty);
        } else {
            method.inputs.forEach((inp, i) => {
                const pair = document.createElement('span');
                pair.className = 'param-pair';
                pair.innerHTML = `
                    <input type="text" class="p-name" placeholder="name" value="${escapeHtml(inp.name)}">
                    <input type="text" class="p-type" list="types-datalist" placeholder="type" value="${escapeHtml(inp.type)}">
                    <button type="button" class="icon-btn p-remove" title="Remove parameter">×</button>
                `;
                const [pn, pt] = pair.querySelectorAll('input');
                pn.addEventListener('input', e => { method.inputs[i].name = e.target.value; renderSequence(); });
                pt.addEventListener('input', e => { method.inputs[i].type = e.target.value; renderSequence(); });
                pair.querySelector('.p-remove').addEventListener('click', () => {
                    method.inputs.splice(i, 1);
                    renderInputs();
                    renderSequence();
                });
                inputsWrap.appendChild(pair);
            });
        }
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'mb-add-param';
        add.textContent = '+ parameter';
        add.addEventListener('click', () => {
            method.inputs.push({ name: '', type: '' });
            renderInputs();
            renderSequence();
        });
        inputsWrap.appendChild(add);
    };
    renderInputs();

    const outRow = document.createElement('div');
    outRow.className = 'mb-row';
    const outTag = document.createElement('span');
    outTag.className = 'io-tag out';
    outTag.textContent = 'out';
    const output = document.createElement('input');
    output.type = 'text';
    output.className = 'mb-output';
    output.setAttribute('list', 'types-datalist');
    output.placeholder = 'void';
    output.value = method.output;
    outRow.append(outTag, output);

    name.addEventListener('input', e => { method.name = e.target.value; renderSequence(); });
    output.addEventListener('input', e => { method.output = e.target.value; renderSequence(); });
    remove.addEventListener('click', () => {
        participant.methods = participant.methods.filter(m => m.id !== method.id);
        state.sequence = state.sequence.filter(c =>
            c.kind !== STEP_KIND.CALL || !(c.calleeId === participant.id && c.methodId === method.id)
        );
        row.remove();
        if (modalParticipantId === participant.id) {
            step2Els.modalMethodsCount.textContent = String(participant.methods.length);
        }
        renderSequence();
    });

    row.append(head, inRow, outRow);
    return row;
}

// --- Steps (interactions) ---

let dragCallId = null;
let addStepDraft = null;  // { callerId, calleeId, methodId }

function ensureAddStepDraft() {
    if (!addStepDraft) {
        addStepDraft = { callerId: '', calleeId: '', methodId: '' };
        return;
    }
    // Re-validate against current participants — drop refs to deleted entities.
    if (addStepDraft.callerId && !findParticipant(addStepDraft.callerId)) addStepDraft.callerId = '';
    if (addStepDraft.calleeId && !findParticipant(addStepDraft.calleeId)) addStepDraft.calleeId = '';
    if (addStepDraft.methodId && !findMethod(addStepDraft.calleeId, addStepDraft.methodId)) addStepDraft.methodId = '';
}

// How many fragment-start markers are currently unmatched. Used to disable
// the "+ end" / "+ else" buttons when there's nothing to close.
function openFragDepth() {
    let d = 0;
    for (const s of state.sequence) {
        if (isFragStart(s)) d++;
        else if (isFragEnd(s)) d = Math.max(0, d - 1);
    }
    return d;
}

// The fragType of the innermost currently-open fragment, or null. Used to
// gate the "+ else" button: only alt/par fragments allow else.
function currentOpenFragType() {
    const stack = [];
    for (const s of state.sequence) {
        if (isFragStart(s)) stack.push(effectiveFragType(s));
        else if (isFragEnd(s)) stack.pop();
    }
    return stack.length > 0 ? stack[stack.length - 1] : null;
}

// Transient UI state for the inline fragment-insert mini-form. When non-null,
// the composer renders the mini-form instead of the secondary buttons.
// Shape: { type: 'loop'|'while'|'foreach'|'alt'|'opt'|'par', label: '' }
let fragFormOpen = null;

function renderSequence() {
    renderSteps();
    renderAddStep();
    const liveSeq = document.getElementById('live-sequence');
    if (liveSeq) renderSequenceDiagram(state.sequence, liveSeq);
}

function renderSteps() {
    const board = step2Els.stepsBoard;
    board.innerHTML = '';
    const callCount = state.sequence.filter(s => s.kind === STEP_KIND.CALL).length;
    step2Els.stepsCount.textContent = `${callCount} added`;

    if (state.sequence.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'steps-empty';
        empty.textContent = 'No steps yet. Add the first call to start the sequence.';
        board.appendChild(empty);
    }

    const creates = resolveCreates();
    let callIdx = 0;

    // Track the open fragment stack so frag-end rows know what they're closing
    // and frag-else rows know which fragment they belong to.
    const fragStack = [];

    state.sequence.forEach(step => {
        if (isFragStart(step)) {
            const type = effectiveFragType(step);
            const meta = fragMeta(type);
            fragStack.push({ type, depth: fragStack.length });
            const row = document.createElement('div');
            row.className = `step-row frag-start frag-${type}`;
            row.dataset.id = step.id;
            row.draggable = false;
            row.style.setProperty('--frag-color', meta.color);
            row.innerHTML = `
                <span class="step-num frag-glyph" title="${escapeHtml(meta.label)} start">${meta.glyph}</span>
                <div class="step-lines">
                    <div class="step-line">
                        <span class="frag-tag">${escapeHtml(meta.label)}</span>
                        <input type="text" class="frag-label" placeholder="${escapeHtml(meta.defaultLabel)}" value="${escapeHtml(step.label || '')}">
                    </div>
                </div>
                <button type="button" class="icon-btn step-remove" title="Remove ${escapeHtml(meta.label)}">×</button>
            `;
            row.querySelector('.frag-label').addEventListener('input', (e) => {
                step.label = e.target.value;
                const liveSeq = document.getElementById('live-sequence');
                if (liveSeq) renderSequenceDiagram(state.sequence, liveSeq);
            });
            row.querySelector('.step-remove').addEventListener('click', () => {
                state.sequence = state.sequence.filter(s => s.id !== step.id);
                renderSequence();
            });
            board.appendChild(row);
            return;
        }

        if (isFragElse(step)) {
            const open = fragStack[fragStack.length - 1];
            const type = open ? open.type : 'alt';
            const meta = fragMeta(type);
            const row = document.createElement('div');
            row.className = `step-row frag-else frag-${type}`;
            row.dataset.id = step.id;
            row.draggable = false;
            row.style.setProperty('--frag-color', meta.color);
            const elseLabel = type === 'par' ? 'else (parallel branch)' : 'else if';
            row.innerHTML = `
                <span class="step-num frag-glyph" title="${escapeHtml(elseLabel)}">⇅</span>
                <div class="step-lines">
                    <div class="step-line">
                        <span class="frag-tag">else</span>
                        <input type="text" class="frag-label" placeholder="${escapeHtml(elseLabel === 'else if' ? 'else condition' : 'parallel branch label')}" value="${escapeHtml(step.label || '')}">
                    </div>
                </div>
                <button type="button" class="icon-btn step-remove" title="Remove else">×</button>
            `;
            row.querySelector('.frag-label').addEventListener('input', (e) => {
                step.label = e.target.value;
                const liveSeq = document.getElementById('live-sequence');
                if (liveSeq) renderSequenceDiagram(state.sequence, liveSeq);
            });
            row.querySelector('.step-remove').addEventListener('click', () => {
                state.sequence = state.sequence.filter(s => s.id !== step.id);
                renderSequence();
            });
            board.appendChild(row);
            return;
        }

        if (isFragEnd(step)) {
            const open = fragStack.pop();
            const type = open ? open.type : 'loop';
            const meta = fragMeta(type);
            const row = document.createElement('div');
            row.className = `step-row frag-end frag-${type}`;
            row.dataset.id = step.id;
            row.draggable = false;
            row.style.setProperty('--frag-color', meta.color);
            row.innerHTML = `
                <span class="step-num frag-glyph" title="${escapeHtml(meta.label)} end">↺</span>
                <div class="step-lines">
                    <div class="step-line"><span class="frag-tag">end ${escapeHtml(meta.label)}</span></div>
                </div>
                <button type="button" class="icon-btn step-remove" title="Remove end">×</button>
            `;
            row.querySelector('.step-remove').addEventListener('click', () => {
                state.sequence = state.sequence.filter(s => s.id !== step.id);
                renderSequence();
            });
            board.appendChild(row);
            return;
        }

        // CALL
        const call = step;
        const caller = findParticipant(call.callerId);
        const callee = findParticipant(call.calleeId);
        const method = findMethod(call.calleeId, call.methodId);
        if (!caller || !callee || !method) return;

        callIdx++;
        const callerName = escapeHtml(caller.name || '(unnamed)');
        const calleeName = escapeHtml(callee.name || '(unnamed)');
        const inputArgs = (method.inputs || []).map(i => i.name || i.type || '').filter(Boolean).join(', ');
        const methodCall = `.${method.name || '?'}(${inputArgs})`;
        const ret = returnLabelFor(method);
        const created = creates.get(call.id);

        let returnLine;
        if (created) {
            returnLine = `<div class="step-line return create"><span class="dir">↪</span><span class="payload create-payload">creates ${escapeHtml(created.name)}</span></div>`;
        } else if (ret) {
            returnLine = `<div class="step-line return"><span class="dir">↩</span><span class="who from">${calleeName}</span><span class="arrow">→</span><span class="who to">${callerName}</span><span class="payload">${escapeHtml(ret)}</span></div>`;
        } else {
            returnLine = `<div class="step-line return leaf"><span class="dir">⤬</span><span class="payload">no return (void)</span></div>`;
        }

        const row = document.createElement('div');
        row.className = 'step-row';
        if (created) row.classList.add('is-create');
        row.draggable = true;
        row.dataset.id = call.id;
        row.innerHTML = `
            <span class="step-num">${callIdx}</span>
            <div class="step-lines">
                <div class="step-line call">
                    <span class="who from">${callerName}</span>
                    <span class="arrow">→</span>
                    <span class="who to">${calleeName}</span>
                    <span class="step-method">${escapeHtml(methodCall)}</span>
                </div>
                ${returnLine}
            </div>
            <button type="button" class="icon-btn step-remove" title="Remove step">×</button>
        `;

        row.addEventListener('dragstart', (e) => { dragCallId = call.id; e.dataTransfer.effectAllowed = 'move'; });
        row.addEventListener('dragend', () => { dragCallId = null; row.classList.remove('dragging'); });
        row.addEventListener('dragover', (e) => {
            if (!dragCallId || dragCallId === call.id) return;
            e.preventDefault();
            row.classList.add('drop-above');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-above'));
        row.addEventListener('drop', (e) => {
            row.classList.remove('drop-above');
            if (!dragCallId || dragCallId === call.id) return;
            e.preventDefault();
            const fromIdx = state.sequence.findIndex(c => c.id === dragCallId);
            const toIdx = state.sequence.findIndex(c => c.id === call.id);
            if (fromIdx < 0 || toIdx < 0) return;
            const [moved] = state.sequence.splice(fromIdx, 1);
            state.sequence.splice(toIdx, 0, moved);
            renderSequence();
        });

        row.querySelector('.step-remove').addEventListener('click', () => {
            state.sequence = state.sequence.filter(c => c.id !== call.id);
            renderSequence();
        });

        board.appendChild(row);
    });
}

function renderAddStep() {
    // Idempotent: strip any existing composer before appending a fresh one.
    const existing = step2Els.stepsBoard.querySelector('.add-step-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.className = 'add-step-panel';
    step2Els.stepsBoard.appendChild(panel);

    if (state.participants.length < 2) {
        const msg = document.createElement('div');
        msg.className = 'add-step-empty';
        msg.textContent = state.participants.length === 0
            ? 'Add at least two participants to define a step.'
            : 'Add one more participant — a step needs a caller and a callee.';
        panel.appendChild(msg);
        return;
    }

    ensureAddStepDraft();

    const stepNum = state.sequence.length + 1;
    const callerOptions = ['<option value="">caller</option>']
        .concat(state.participants.map(p =>
            `<option value="${p.id}" ${p.id === addStepDraft.callerId ? 'selected' : ''}>${escapeHtml(p.name || '(unnamed)')}</option>`))
        .join('');
    const calleeOptions = ['<option value="">callee</option>']
        .concat(state.participants
            .filter(p => p.id !== addStepDraft.callerId)
            .map(p => `<option value="${p.id}" ${p.id === addStepDraft.calleeId ? 'selected' : ''}>${escapeHtml(p.name || '(unnamed)')}</option>`))
        .join('');
    const callee = findParticipant(addStepDraft.calleeId);
    const methodOptions = ['<option value="">method</option>']
        .concat((callee ? callee.methods : [])
            .map(m => `<option value="${m.id}" ${m.id === addStepDraft.methodId ? 'selected' : ''}>${escapeHtml(m.name || '?')}</option>`))
        .join('');
    const method = findMethod(addStepDraft.calleeId, addStepDraft.methodId);
    const argsPreview = method ? (method.inputs || []).map(i => i.name || i.type || '').filter(Boolean).join(', ') : '';
    const retPreview = method ? (returnLabelFor(method) || 'void') : '';
    const ready = !!(addStepDraft.callerId && addStepDraft.calleeId && addStepDraft.methodId);
    const hint = !addStepDraft.callerId
        ? 'who is calling?'
        : !addStepDraft.calleeId
            ? 'who do they call?'
            : !addStepDraft.methodId
                ? 'which method?'
                : 'ready to add';

    const argsPart = method
        ? `<span class="as-paren">(</span><span class="as-args">${argsPreview ? escapeHtml(argsPreview) : ''}</span><span class="as-paren">)</span>`
        : '';

    // Would this draft step create a participant? Simulate by appending it.
    let draftCreates = null;
    if (method) {
        const draftId = '__draft__';
        const simulated = state.sequence.concat([{
            id: draftId,
            kind: STEP_KIND.CALL,
            callerId: addStepDraft.callerId,
            calleeId: addStepDraft.calleeId,
            methodId: addStepDraft.methodId
        }]);
        const map = resolveCreates(simulated);
        draftCreates = map.get(draftId);
    }

    const retPart = method
        ? (draftCreates
            ? `<span class="as-ret-arrow">→</span><span class="as-creates-hint" title="The next step would introduce ${escapeHtml(draftCreates.name)} as a new lifeline">↪ creates ${escapeHtml(draftCreates.name)}</span>`
            : `<span class="as-ret-arrow">→</span><span class="as-return ${retPreview === 'void' ? 'is-void' : ''}">${escapeHtml(retPreview)}</span>`)
        : '';

    const depth = openFragDepth();
    const openType = currentOpenFragType();
    const elseAllowed = openType ? fragMeta(openType).allowsElse : false;
    let secondaryStrip;
    if (fragFormOpen) {
        const ft = fragFormOpen.type;
        const meta = fragMeta(ft);
        secondaryStrip = `<div class="as-secondary as-frag-form-strip">
               <form class="as-frag-form" autocomplete="off" data-frag-type="${ft}">
                   <span class="as-frag-form-label" style="color: ${meta.color}">${escapeHtml(meta.label)}:</span>
                   <input type="text" class="as-frag-input" placeholder="${escapeHtml(meta.defaultLabel)}" autofocus>
                   <button type="submit" class="as-frag-confirm">Add ${escapeHtml(meta.label)}</button>
                   <button type="button" class="as-frag-cancel">Cancel</button>
               </form>
           </div>`;
    } else {
        const elseBtn = elseAllowed
            ? `<button type="button" class="as-frag-else-btn" data-frag-type="${openType}">+ else</button>`
            : '';
        const endLabel = openType ? ` (${fragMeta(openType).label})` : '';
        secondaryStrip = `<div class="as-secondary">
               <span class="as-secondary-label">flow control:</span>
               <button type="button" class="as-frag-add" data-frag-type="loop">+ loop</button>
               <button type="button" class="as-frag-add" data-frag-type="while">+ while</button>
               <button type="button" class="as-frag-add" data-frag-type="foreach">+ for-each</button>
               <button type="button" class="as-frag-add" data-frag-type="alt">+ if/else</button>
               <button type="button" class="as-frag-add" data-frag-type="opt">+ opt</button>
               <button type="button" class="as-frag-add" data-frag-type="par">+ par</button>
               ${elseBtn}
               <button type="button" class="as-frag-end-btn" ${depth > 0 ? '' : 'disabled'}>+ end${depth > 0 ? endLabel : ' (none open)'}</button>
           </div>`;
    }

    panel.innerHTML = `
        <div class="add-step-head">
            <span class="step-badge">${stepNum}</span>
            <div class="add-step-title">
                <strong>Step ${stepNum}</strong>
                <span class="add-step-status">${escapeHtml(hint)}</span>
            </div>
        </div>
        <form class="add-step-form" autocomplete="off">
            <select class="as-caller">${callerOptions}</select>
            <span class="as-arrow">→</span>
            <select class="as-callee">${calleeOptions}</select>
            <span class="as-dot">.</span>
            <select class="as-method method-pill">${methodOptions}</select>
            ${argsPart}
            ${retPart}
            <div class="as-actions">
                <button type="submit" class="as-add" ${ready ? '' : 'disabled'}>Add step ${stepNum} ↵</button>
                <span class="as-hint">${ready ? 'Enter to add the next step' : 'fill the dropdowns left to right'}</span>
            </div>
        </form>
        ${secondaryStrip}
    `;

    const form = panel.querySelector('.add-step-form');
    const callerSel = panel.querySelector('.as-caller');
    const calleeSel = panel.querySelector('.as-callee');
    const methodSel = panel.querySelector('.as-method');

    // Secondary actions: open a fragment-insert mini-form for any frag type.
    panel.querySelectorAll('.as-frag-add').forEach(btn => {
        btn.addEventListener('click', () => {
            fragFormOpen = { type: btn.dataset.fragType };
            renderAddStep();
            const input = step2Els.stepsBoard.querySelector('.as-frag-input');
            if (input) input.focus();
        });
    });

    // + else: insert FRAG_ELSE row inside the current open fragment.
    const elseBtn = panel.querySelector('.as-frag-else-btn');
    if (elseBtn) {
        elseBtn.addEventListener('click', () => {
            if (!currentOpenFragType()) return;
            state.sequence.push({ id: newId(), kind: STEP_KIND.FRAG_ELSE, label: '' });
            renderSequence();
        });
    }

    // + end: close the innermost open fragment.
    const endBtn = panel.querySelector('.as-frag-end-btn');
    if (endBtn) {
        endBtn.addEventListener('click', () => {
            if (openFragDepth() === 0) return;
            state.sequence.push({ id: newId(), kind: STEP_KIND.FRAG_END });
            renderSequence();
        });
    }

    // Mini-form submit: push a FRAG_START with the chosen type + label.
    const fragForm = panel.querySelector('.as-frag-form');
    if (fragForm) {
        fragForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = panel.querySelector('.as-frag-input');
            const label = (input ? input.value : '').trim();
            const type = fragForm.dataset.fragType || 'loop';
            state.sequence.push({ id: newId(), kind: STEP_KIND.FRAG_START, fragType: type, label });
            fragFormOpen = null;
            renderSequence();
        });
        panel.querySelector('.as-frag-cancel').addEventListener('click', () => {
            fragFormOpen = null;
            renderAddStep();
        });
    }

    callerSel.addEventListener('change', e => {
        addStepDraft.callerId = e.target.value;
        // If the chosen caller equals the current callee, clear callee + method.
        if (addStepDraft.calleeId === addStepDraft.callerId) {
            addStepDraft.calleeId = '';
            addStepDraft.methodId = '';
        }
        renderAddStep();
    });
    calleeSel.addEventListener('change', e => {
        addStepDraft.calleeId = e.target.value;
        addStepDraft.methodId = '';  // method belongs to the callee, so reset
        renderAddStep();
    });
    methodSel.addEventListener('change', e => {
        addStepDraft.methodId = e.target.value;
        renderAddStep();
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!addStepDraft.callerId || !addStepDraft.calleeId || !addStepDraft.methodId) return;
        state.sequence.push({
            id: newId(),
            kind: STEP_KIND.CALL,
            callerId: addStepDraft.callerId,
            calleeId: addStepDraft.calleeId,
            methodId: addStepDraft.methodId
        });
        // Clear the draft after add — next step starts fresh, matching the
        // progressive "who is calling?" prompt.
        addStepDraft = { callerId: '', calleeId: '', methodId: '' };
        renderSequence();
        // Refocus the caller in the freshly-rendered composer so the next
        // step is one keystroke away. No scroll — the live diagram below
        // updates in place; users can glance down to see the new arrow.
        const composer = step2Els.stepsBoard.querySelector('.add-step-panel');
        if (composer) {
            const nextCallerSel = composer.querySelector('.as-caller');
            if (nextCallerSel) nextCallerSel.focus({ preventScroll: true });
        }
    });
}

step2Els.flowNext.addEventListener('click', () => {
    if (state.sequence.length === 0) {
        step2Els.sequenceHint.classList.add('warn');
        return;
    }
    step2Els.sequenceHint.classList.remove('warn');
    goToStep(3);
});

// --- UML emission + parsing (preserved for Step 3 preview & Step 4 generate) ---

let parsedUml = { arrows: [], items: [], participants: [], errors: [] };

const UML_LINE_RE = /^([A-Za-z_][\w]*)\s*(->|<-)\s*([A-Za-z_][\w]*)\s*(?::\s*(.+?))?\s*$/;

function parseUml(text) {
    const arrows = [];
    const items = [];
    const participantSet = new Set();
    const errors = [];
    const stack = [];

    text.split('\n').forEach((raw, idx) => {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('@')) return;

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
    const lines = ['@startuml'];
    // Emit the DisC target_placement declaration when set. DisC's Step 1
    // refuses .puml files without this header, so the warning in Step 4 nudges
    // the user to fill it before save/run.
    if (state.targetPackage && state.targetPackage.trim()) {
        lines.push(`' @package ${state.targetPackage.trim()}`);
    }
    const creates = resolveCreates();
    let indent = 0;
    const pad = () => '  '.repeat(indent);

    // Track the open fragment stack so that:
    //  (a) FRAG_ELSE emits the right keyword (`else` for alt/opt, also `else`
    //      for par — PlantUML uses `else` to separate par branches);
    //  (b) FRAG_END knows which fragment it's closing (only matters for
    //      tooling — PlantUML always closes with `end`).
    const fragStack = [];

    state.sequence.forEach(s => {
        if (isFragStart(s)) {
            const type = effectiveFragType(s);
            const meta = fragMeta(type);
            fragStack.push(type);
            const rawLabel = (s.label || '').replace(/\n/g, ' ').trim();
            const label = (meta.emitPrefix && rawLabel && !rawLabel.toLowerCase().startsWith(meta.emitPrefix.trim()))
                ? meta.emitPrefix + rawLabel
                : rawLabel;
            lines.push(`${pad()}${meta.keyword} ${label}`.trimEnd());
            indent++;
            return;
        }
        if (isFragElse(s)) {
            // else lives at the parent fragment's indent; the call lines
            // between two else markers stay one level deeper than the frag.
            const elseIndent = Math.max(0, indent - 1);
            const label = (s.label || '').replace(/\n/g, ' ').trim();
            lines.push(`${'  '.repeat(elseIndent)}else ${label}`.trimEnd());
            return;
        }
        if (isFragEnd(s)) {
            indent = Math.max(0, indent - 1);
            fragStack.pop();
            lines.push(`${pad()}end`);
            return;
        }
        // CALL
        const caller = findParticipant(s.callerId);
        const callee = findParticipant(s.calleeId);
        const method = findMethod(s.calleeId, s.methodId);
        if (!caller || !callee || !method) return;
        const callerName = caller.name || '_';
        const calleeName = callee.name || '_';
        const created = creates.get(s.id);
        if (created) {
            // PlantUML's idiom for "Service asks Factory to create Builder":
            //   1. Service -> Factory : create()        (regular call to factory)
            //   2. create Builder                       (declares the new lifeline)
            //   3. Factory --> Service : Builder        (factory returns the new instance)
            // The `create` keyword between the call and the return makes
            // PlantUML start Builder's lifeline mid-diagram, faithfully
            // reflecting the "constructed at this point" semantics.
            const createdName = created.name;
            lines.push(`${pad()}${callerName} -> ${calleeName} : ${methodSignature(method)}`);
            lines.push(`${pad()}create ${createdName}`);
            lines.push(`${pad()}${calleeName} --> ${callerName} : ${createdName}`);
            return;
        }
        lines.push(`${pad()}${callerName} -> ${calleeName} : ${methodSignature(method)}`);
        const ret = returnLabelFor(method);
        if (ret) {
            lines.push(`${pad()}${callerName} <- ${calleeName} : ${ret}`);
        }
    });
    // Auto-close any unbalanced loops so we always emit valid PlantUML.
    while (indent > 0) {
        indent--;
        lines.push(`${'  '.repeat(indent)}end`);
    }
    lines.push('@enduml');
    return lines.join('\n') + '\n';
}

function refreshParsedUml() {
    parsedUml = parseUml(emitPlantUml());
}

// Sequence diagram renderer — emits a stand-alone SVG into the given container.
// Lifelines appear in the order participants are first referenced (caller, then
// callee, per step). Each call step renders as a forward arrow + dashed return.
// Create-style steps (where the method's return type is itself a participant)
// render as a dashed <<create>> arrow that also positions the new lifeline's
// head at the step's row, with no separate return arrow. Loop fragments render
// as translucent indigo brackets behind the wrapped step rows.
function renderSequenceDiagram(steps, container) {
    container.innerHTML = '';

    if (!steps || steps.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'seq-empty';
        empty.textContent = 'add your first step — pick a caller and a callee';
        container.appendChild(empty);
        return;
    }

    const creates = resolveCreates(steps);

    // Resolve calls; build lifelines + remember which step (by index) creates which.
    const resolved = [];
    const lifelines = [];
    for (const s of steps) {
        if (s.kind !== STEP_KIND.CALL) continue;
        const caller = findParticipant(s.callerId);
        const callee = findParticipant(s.calleeId);
        const method = findMethod(s.calleeId, s.methodId);
        if (!caller || !callee || !method) continue;
        const fromName = caller.name || '(unnamed)';
        const toName = callee.name || '(unnamed)';
        if (!lifelines.includes(fromName)) lifelines.push(fromName);
        if (!lifelines.includes(toName)) lifelines.push(toName);
        const argText = (method.inputs || []).map(i => i.name || i.type || '').filter(Boolean).join(', ');
        const created = creates.get(s.id);
        if (created && !lifelines.includes(created.name)) lifelines.push(created.name);
        resolved.push({
            from: fromName,
            to: toName,
            label: `${method.name || '?'}(${argText})`,
            ret: returnLabelFor(method),
            isCreate: !!created,
            createsName: created ? created.name : null
        });
    }

    if (resolved.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'seq-empty';
        empty.textContent = 'no valid steps to render';
        container.appendChild(empty);
        return;
    }

    const colW = 150;
    const padX = 60;
    const headTop = 14;
    const headH = 30;
    const stepGap = 56;
    const stepStart = headTop + headH + 28;
    const w = Math.max(560, padX * 2 + colW * Math.max(lifelines.length - 1, 1));
    const h = stepStart + resolved.length * stepGap + 30;
    const xOf = (name) => padX + lifelines.indexOf(name) * colW;

    // Per-lifeline head Y. Default headTop; create-target's head sits at the
    // create step's *response* row so the dashed create-arrow lands on it
    // (visually: "Builder appeared as the result of Factory.create()").
    const headY = {};
    for (const name of lifelines) headY[name] = headTop;
    resolved.forEach((s, i) => {
        if (s.isCreate && s.createsName && headY[s.createsName] === headTop) {
            const callY = stepStart + i * stepGap;
            // Center the head rect ~28px below the call arrow so it sits
            // between the call (top) and next step (below).
            headY[s.createsName] = callY + 28 - Math.floor(headH / 2);
        }
    });

    // Fragment spans (computed off raw `steps`, indexed by call ordinal).
    // Each span gets its frag type's color + label; alt/par fragments also
    // record their `else` divider Y positions so the renderer can draw
    // dashed cross-lines between branches.
    const fragSpans = [];
    {
        const stack = [];
        let callIdx = 0;
        const isValidCall = (s) => {
            if (s.kind !== STEP_KIND.CALL) return false;
            const caller = findParticipant(s.callerId);
            const callee = findParticipant(s.calleeId);
            const method = findMethod(s.calleeId, s.methodId);
            return !!(caller && callee && method);
        };
        for (const s of steps) {
            if (isFragStart(s)) {
                const type = effectiveFragType(s);
                stack.push({
                    type,
                    label: s.label || '',
                    startCallIdx: callIdx,
                    depth: stack.length,
                    elseYs: []  // [{y, label}, ...]
                });
            } else if (isFragElse(s)) {
                const open = stack[stack.length - 1];
                if (open) {
                    open.elseYs.push({
                        // Position the else divider just above the next call row.
                        y: stepStart + callIdx * stepGap - 22,
                        label: s.label || ''
                    });
                }
            } else if (isFragEnd(s)) {
                const open = stack.pop();
                if (!open) continue;
                const innerCount = callIdx - open.startCallIdx;
                fragSpans.push({
                    type: open.type,
                    label: open.label,
                    yStart: stepStart + open.startCallIdx * stepGap - 22,
                    yEnd:   stepStart + Math.max(callIdx - 1, open.startCallIdx) * stepGap + 26,
                    depth:  open.depth,
                    empty:  innerCount === 0,
                    elseYs: open.elseYs
                });
            } else if (isValidCall(s)) {
                callIdx++;
            }
        }
        // Auto-close any still-open fragments at the bottom.
        while (stack.length > 0) {
            const open = stack.pop();
            const innerCount = callIdx - open.startCallIdx;
            fragSpans.push({
                type: open.type,
                label: open.label,
                yStart: stepStart + open.startCallIdx * stepGap - 22,
                yEnd:   stepStart + Math.max(callIdx - 1, open.startCallIdx) * stepGap + 26,
                depth:  open.depth,
                empty:  innerCount === 0,
                elseYs: open.elseYs
            });
        }
    }

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('class', 'seq-svg');

    const el = (tag, attrs, text) => {
        const node = document.createElementNS(SVG_NS, tag);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        if (text != null) node.textContent = text;
        return node;
    };

    // Fragment brackets — draw first so steps render on top. Each bracket's
    // color comes from FRAG_TYPES; alt/par also draw dashed `else` dividers.
    for (const span of fragSpans) {
        const meta = fragMeta(span.type);
        const inset = span.depth * 8;
        const bx = padX - 28 - inset;
        const bw = w - 2 * (padX - 28 - inset);

        // Translucent fill (use the frag color via a low-alpha rgba).
        // Convert the meta hex to rgba 0.06 by splitting the channels.
        const hex = meta.color.replace('#', '');
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const fill = `rgba(${r},${g},${b},0.06)`;
        const stroke = `rgba(${r},${g},${b},0.55)`;

        svg.appendChild(el('rect', {
            x: bx, y: span.yStart, width: bw, height: span.yEnd - span.yStart,
            fill,
            stroke, 'stroke-width': '1', 'stroke-dasharray': '4 4',
            rx: '4'
        }));
        const labelText = `${meta.glyph} ${meta.label}${span.label ? ' · ' + span.label : ''}${span.empty ? ' (empty)' : ''}`;
        svg.appendChild(el('text', {
            x: bx + 8, y: span.yStart + 13,
            'font-size': '10', fill: meta.color, 'font-weight': '700'
        }, labelText));

        // Else dividers: dashed horizontal lines spanning the bracket, with
        // an inline label.
        for (const e of (span.elseYs || [])) {
            svg.appendChild(el('line', {
                x1: bx + 4, y1: e.y, x2: bx + bw - 4, y2: e.y,
                stroke, 'stroke-width': '1', 'stroke-dasharray': '6 3'
            }));
            const elseText = `else${e.label ? ' · ' + e.label : ''}`;
            svg.appendChild(el('text', {
                x: bx + 12, y: e.y - 3,
                'font-size': '10', fill: meta.color, 'font-weight': '700', 'font-style': 'italic'
            }, elseText));
        }
    }

    // Lifeline heads + dashed verticals.
    for (const name of lifelines) {
        const x = xOf(name);
        const y = headY[name];
        svg.appendChild(el('rect', { x: x - 50, y: y, width: 100, height: headH, fill: '#ffffff', stroke: '#1a1a1a', 'stroke-width': '1.5', rx: '3' }));
        svg.appendChild(el('text', { x, y: y + 19, 'text-anchor': 'middle', 'font-size': '13', fill: '#1a1a1a', 'font-weight': '700' }, name));
        svg.appendChild(el('line', { x1: x, y1: y + headH, x2: x, y2: h - 8, stroke: '#444444', 'stroke-width': '1', 'stroke-dasharray': '4 4' }));
    }

    // Steps.
    resolved.forEach((s, i) => {
        const x1 = xOf(s.from);
        const x2 = xOf(s.to);
        const y = stepStart + i * stepGap;
        const ry = y + 22;
        const dir = x2 > x1 ? 1 : -1;
        const head = 6;

        if (s.isCreate) {
            // Two-arrow rendering of "Service asks Factory.create() to make Builder":
            //   1. Solid call arrow Service -> Factory at the call row (y), labeled with the method name.
            //   2. Dashed creation arrow Factory --> Builder, landing at Builder's head rect, at its head Y.
            // Builder's head rect already sits below the call row (per headY map above).

            // (1) Regular call from caller to callee.
            svg.appendChild(el('text', {
                x: (x1 + x2) / 2, y: y - 8,
                'text-anchor': 'middle', 'font-size': '11', fill: '#444444'
            }, `${i + 1}. ${s.label}`));
            svg.appendChild(el('path', {
                d: `M ${x1} ${y} L ${x2 - dir * head} ${y}`,
                fill: 'none', stroke: '#1a1a1a', 'stroke-width': '1.4'
            }));
            svg.appendChild(el('polygon', {
                points: `${x2 - dir * head},${y - 4} ${x2},${y} ${x2 - dir * head},${y + 4}`,
                fill: '#1a1a1a'
            }));

            // (2) Dashed creation arrow callee --> created, ending at the
            // new lifeline's head rect.
            const xCreated = xOf(s.createsName);
            const createeDir = xCreated > x2 ? 1 : -1;
            const targetX = xCreated - createeDir * 50;  // stop at head rect edge
            const createY = headY[s.createsName] + Math.floor(headH / 2);
            svg.appendChild(el('text', {
                x: (x2 + targetX) / 2, y: createY - 5,
                'text-anchor': 'middle', 'font-size': '10', fill: '#5b21b6', 'font-weight': '700', 'font-style': 'italic'
            }, `«create» ${s.createsName}`));
            svg.appendChild(el('path', {
                d: `M ${x2} ${createY} L ${targetX} ${createY}`,
                fill: 'none', stroke: '#5b21b6', 'stroke-width': '1.4', 'stroke-dasharray': '5 3'
            }));
            svg.appendChild(el('polygon', {
                points: `${targetX - createeDir * head},${createY - 4} ${targetX},${createY} ${targetX - createeDir * head},${createY + 4}`,
                fill: '#5b21b6'
            }));
            return;
        }

        // Regular call: forward arrow.
        svg.appendChild(el('text', { x: (x1 + x2) / 2, y: y - 8, 'text-anchor': 'middle', 'font-size': '11', fill: '#444444' }, `${i + 1}. ${s.label}`));
        svg.appendChild(el('path', { d: `M ${x1} ${y} L ${x2 - dir * head} ${y}`, fill: 'none', stroke: '#1a1a1a', 'stroke-width': '1.4' }));
        svg.appendChild(el('polygon', { points: `${x2 - dir * head},${y - 4} ${x2},${y} ${x2 - dir * head},${y + 4}`, fill: '#1a1a1a' }));
        // Return arrow: dashed back. Label "← ret" or "← ack" if void.
        const respLabel = s.ret || 'ack';
        svg.appendChild(el('text', { x: (x1 + x2) / 2, y: ry - 5, 'text-anchor': 'middle', 'font-size': '10', fill: '#888888', 'font-style': 'italic' }, `← ${respLabel}`));
        svg.appendChild(el('path', { d: `M ${x2} ${ry} L ${x1 + dir * head} ${ry}`, fill: 'none', stroke: '#444444', 'stroke-width': '1.2', 'stroke-dasharray': '5 3' }));
        svg.appendChild(el('polygon', { points: `${x1 + dir * head},${ry - 3.5} ${x1},${ry} ${x1 + dir * head},${ry + 3.5}`, fill: '#444444' }));
    });

    container.appendChild(svg);
}

// --- Step 3: review ---

const reviewEls = {
    story: document.getElementById('review-story'),
    summary: document.getElementById('review-summary'),
    sequence: document.getElementById('review-sequence')
};

function enterStep3() {
    reviewEls.story.textContent = state.userStory || '(no story given)';
    if (!state.userStory) reviewEls.story.classList.add('muted');
    else reviewEls.story.classList.remove('muted');

    const pCount = state.participants.length;
    const sCount = state.sequence.length;
    const usedIds = new Set();
    state.sequence.forEach(c => { usedIds.add(c.callerId); usedIds.add(c.calleeId); });
    const usedParticipants = state.participants.filter(p => usedIds.has(p.id));
    const unused = state.participants.filter(p => !usedIds.has(p.id));

    const partLines = usedParticipants.map(p => {
        const methodNames = p.methods.map(m => m.name || '?').join(', ') || '(no methods)';
        return `<li><strong>${escapeHtml(p.name || '(unnamed)')}</strong> <span class="muted">— ${escapeHtml(methodNames)}</span></li>`;
    }).join('');
    const unusedLine = unused.length > 0
        ? `<div class="review-warn">${unused.length} unused participant${unused.length === 1 ? '' : 's'}: ${unused.map(p => escapeHtml(p.name || '(unnamed)')).join(', ')}</div>`
        : '';

    reviewEls.summary.innerHTML = `
        <div class="review-counts">${pCount} participant${pCount === 1 ? '' : 's'} · ${sCount} step${sCount === 1 ? '' : 's'}</div>
        <ul class="review-participants">${partLines || '<li class="muted">no participants</li>'}</ul>
        ${unusedLine}
    `;

    renderSequenceDiagram(state.sequence, reviewEls.sequence);
}

document.getElementById('preview-next').addEventListener('click', () => goToStep(4));

// --- Step 4: generate ---

const outputEl = document.getElementById('output');
const copyFeedbackEl = document.getElementById('copy-feedback');

const saveEls = {
    filename: document.getElementById('puml-filename'),
    pkg: document.getElementById('puml-package'),
    pkgWarn: document.getElementById('package-warn'),
    save: document.getElementById('save-to-project'),
    result: document.getElementById('save-result'),
    resultPath: document.getElementById('save-result-path'),
    resultCommand: document.getElementById('save-result-command'),
    copyCommand: document.getElementById('copy-command'),
    error: document.getElementById('save-error'),
    commandFeedback: document.getElementById('command-feedback'),
    runBtn: document.getElementById('run-disc'),
    runConsole: document.getElementById('run-console'),
    runPanel: document.getElementById('run-progress'),
    runStatus: document.getElementById('run-status'),
    runStatusText: document.getElementById('run-status-text'),
    runElapsed: document.getElementById('run-elapsed'),
    runChecklist: document.getElementById('run-checklist'),
    runActivity: document.getElementById('run-activity-current'),
    runCancel: document.getElementById('run-cancel'),
    pluginPill: document.getElementById('plugin-pill'),
    pluginMissing: document.getElementById('plugin-missing'),
    installBtn: document.getElementById('install-plugin'),
    pluginUpdate: document.getElementById('plugin-update'),
    pluginUpdateLatest: document.getElementById('plugin-update-latest'),
    pluginUpdateCurrent: document.getElementById('plugin-update-current'),
    pluginUpdateChangelog: document.getElementById('plugin-update-changelog'),
    updateBtn: document.getElementById('update-plugin'),
    skipUpdateBtn: document.getElementById('plugin-skip-update')
};

// Session-storage key tracking which "update available" version the user
// already dismissed via the Skip button. If a NEWER version comes out later
// in the session, the prompt re-appears (we only suppress the exact version
// the user said no to).
const SKIPPED_UPDATE_KEY = 'disc-plugin-skipped-update';

// Cached plugin status — refreshed on Step 4 enter and after a successful
// install. Shape: { installed: boolean, version: string|null, installPath: string|null }.
let pluginStatus = null;

async function refreshPluginStatus() {
    try {
        const res = await fetch('/api/disc-plugin-status');
        pluginStatus = await res.json();
    } catch {
        pluginStatus = { installed: false, version: null, installPath: null };
    }
    renderPluginStatus();
}

function renderPluginStatus() {
    if (!saveEls.pluginPill || !saveEls.pluginMissing) return;

    // Three branches: not installed → install prompt; installed and outdated
    // → update prompt (Run still enabled, the old plugin still works);
    // installed and current (or unable to check upstream) → quiet pill.
    if (!pluginStatus || !pluginStatus.installed) {
        saveEls.pluginPill.classList.add('hidden');
        saveEls.pluginPill.removeAttribute('data-state');
        saveEls.pluginMissing.classList.remove('hidden');
        if (saveEls.pluginUpdate) saveEls.pluginUpdate.classList.add('hidden');
        if (saveEls.runBtn) {
            saveEls.runBtn.disabled = true;
            saveEls.runBtn.title = 'Install the design-is-code plugin first';
        }
        return;
    }

    // Installed. Now decide between "current" and "outdated."
    const installed = pluginStatus.version;
    const latest = pluginStatus.latestVersion;
    const skipped = sessionStorage.getItem(SKIPPED_UPDATE_KEY);
    const outdated = latest && installed && latest !== installed && skipped !== latest;

    saveEls.pluginPill.classList.remove('hidden');
    saveEls.pluginMissing.classList.add('hidden');
    if (saveEls.runBtn) {
        saveEls.runBtn.disabled = false;
        saveEls.runBtn.title = '';
    }

    if (outdated) {
        saveEls.pluginPill.textContent = `DisC plugin v${installed} → v${latest} ↻`;
        saveEls.pluginPill.dataset.state = 'outdated';
        if (saveEls.pluginUpdate) {
            saveEls.pluginUpdate.classList.remove('hidden');
            saveEls.pluginUpdateLatest.textContent = `v${latest}`;
            saveEls.pluginUpdateCurrent.textContent = `v${installed}`;
            // Tag-page link works even when no GitHub Release exists for the version.
            saveEls.pluginUpdateChangelog.href =
                `https://github.com/mossgreen/design-is-code-plugin/releases/tag/v${latest}`;
        }
    } else {
        saveEls.pluginPill.textContent = `DisC plugin v${installed} ✓`;
        saveEls.pluginPill.dataset.state = 'current';
        if (saveEls.pluginUpdate) saveEls.pluginUpdate.classList.add('hidden');
    }
}

function flashRestartRequired(newVersion) {
    if (!saveEls.pluginPill) return;
    saveEls.pluginPill.textContent = `DisC plugin updated to v${newVersion} — restart Claude Code`;
    saveEls.pluginPill.dataset.state = 'restart';
    saveEls.pluginPill.classList.remove('hidden');
    setTimeout(() => {
        // Refresh status — the new pill shape will replace this flash.
        refreshPluginStatus();
    }, 8000);
}

// --- Step-checklist state for the "Run it for me" panel ---
//
// Pulled from /api/disc-steps on first use; cached so we don't refetch every
// run. The fallback list mirrors the DisC v0.2.1 SKILL.md so users running
// against a different skill version still see something sensible.
const FALLBACK_DISC_STEPS = [
    { n: 1, title: 'Validate Inputs' },
    { n: 2, title: 'Classify' },
    { n: 3, title: 'Discover Context' },
    { n: 4, title: 'Generate' },
    { n: 5, title: 'Quality Gate' },
    { n: 6, title: 'Implement' },
    { n: 7, title: 'Write Files' },
    { n: 8, title: 'Report' }
];
let discSteps = null;
async function loadDiscSteps() {
    if (discSteps) return discSteps;
    try {
        const res = await fetch('/api/disc-steps');
        const data = await res.json();
        if (Array.isArray(data.steps) && data.steps.length > 0) {
            discSteps = data.steps;
        }
    } catch {}
    if (!discSteps || discSteps.length === 0) discSteps = FALLBACK_DISC_STEPS;
    return discSteps;
}

function renderRunChecklist() {
    if (!saveEls.runChecklist || !discSteps) return;
    saveEls.runChecklist.innerHTML = discSteps.map(s => `
        <li class="checklist-row" data-step="${s.n}">
            <span class="checklist-dot" aria-hidden="true"></span>
            <span class="checklist-num">${s.n}</span>
            <span class="checklist-title">${escapeHtml(s.title)}</span>
        </li>
    `).join('');
}

let runState = null;   // { runId, abort, ticker, startedAt, currentStep }

function resetRunState() {
    if (runState && runState.ticker) clearInterval(runState.ticker);
    runState = null;
}

function setRunStatus(kind, label) {
    // kind: running | done | failed | cancelled
    if (!saveEls.runStatus) return;
    saveEls.runStatus.dataset.kind = kind;
    saveEls.runStatusText.textContent = label;
}

function fmtElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function startElapsedTicker() {
    const startedAt = Date.now();
    saveEls.runElapsed.textContent = '0:00';
    return setInterval(() => {
        if (!runState) return;
        saveEls.runElapsed.textContent = fmtElapsed(Date.now() - startedAt);
    }, 1000);
}

function setStepActive(n) {
    if (!saveEls.runChecklist) return;
    const rows = saveEls.runChecklist.querySelectorAll('.checklist-row');
    rows.forEach(row => {
        const step = parseInt(row.dataset.step, 10);
        row.classList.remove('active', 'done', 'pending');
        if (step < n) row.classList.add('done');
        else if (step === n) row.classList.add('active');
        else row.classList.add('pending');
    });
}

function markAllDone() {
    if (!saveEls.runChecklist) return;
    saveEls.runChecklist.querySelectorAll('.checklist-row').forEach(row => {
        row.classList.remove('active', 'pending');
        row.classList.add('done');
    });
}

function appendRawLine(text) {
    if (!saveEls.runConsole) return;
    saveEls.runConsole.textContent += text + '\n';
    saveEls.runConsole.scrollTop = saveEls.runConsole.scrollHeight;
}

function setActivity(text) {
    if (saveEls.runActivity) saveEls.runActivity.textContent = text;
}

// Splits a streaming UTF-8 byte sequence into newline-delimited JSON events,
// buffering partial lines across chunks. Returns parsed objects; raw strings
// for any line that fails JSON.parse (the server already wraps unparseable
// CLI lines in {event:"raw"}, so this branch is unlikely in practice).
function makeNdjsonReader() {
    let buf = '';
    return {
        push(chunk) {
            buf += chunk;
            const events = [];
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                try { events.push(JSON.parse(line)); }
                catch { events.push({ event: 'raw', text: line }); }
            }
            return events;
        }
    };
}

function refreshPackageWarning() {
    const v = state.targetPackage.trim();
    if (!v) {
        saveEls.pkgWarn.textContent = 'No package set — DisC will refuse this file. Enter a Java package like com.example.invoice.';
        saveEls.pkgWarn.className = 'package-warn warn';
    } else if (!JAVA_PACKAGE_RE.test(v)) {
        saveEls.pkgWarn.textContent = `"${v}" doesn't look like a Java package (expected e.g. com.example.invoice). DisC may refuse this file.`;
        saveEls.pkgWarn.className = 'package-warn warn';
    } else {
        saveEls.pkgWarn.textContent = '';
        saveEls.pkgWarn.className = 'package-warn hidden';
    }
}

saveEls.pkg.addEventListener('input', (e) => {
    state.targetPackage = e.target.value;
    refreshPackageWarning();
    // Re-render the output preview so the user sees the @package header land.
    outputEl.textContent = emitPlantUml();
});

let lastSavedRelativePath = null;

function kebab(s) {
    return String(s || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
}

function defaultFileName() {
    const caller = state.participants[0];
    if (!caller) return 'design.puml';
    const cls = kebab(caller.name || 'design');
    const firstCall = state.sequence[0];
    if (firstCall) {
        const method = findMethod(firstCall.calleeId, firstCall.methodId);
        if (method && method.name) return `${cls}-${kebab(method.name)}.puml`;
    }
    return `${cls}.puml`;
}

function enterStep4() {
    if (saveEls.pkg.value !== state.targetPackage) {
        saveEls.pkg.value = state.targetPackage;
    }
    refreshPackageWarning();
    outputEl.textContent = emitPlantUml();
    if (!saveEls.filename.value.trim()) {
        saveEls.filename.value = defaultFileName();
    }
    saveEls.result.classList.add('hidden');
    saveEls.error.classList.add('hidden');
    // Plugin status drives whether the Run button is enabled. Always refresh
    // on enter — the user might have installed the plugin in a separate
    // terminal between visits.
    refreshPluginStatus();
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
        if (saveEls.runPanel) saveEls.runPanel.classList.add('hidden');
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

    // Reset UI for a fresh run.
    await loadDiscSteps();
    renderRunChecklist();
    setStepActive(0);  // all pending until the agent reports a Step
    saveEls.runConsole.textContent = '';
    saveEls.runActivity.textContent = '—';
    saveEls.runPanel.classList.remove('hidden');
    setRunStatus('running', 'Running…');

    saveEls.runBtn.disabled = true;
    const originalLabel = saveEls.runBtn.textContent;
    saveEls.runBtn.textContent = 'Running…';

    const abort = new AbortController();
    runState = {
        runId: null,
        abort,
        ticker: startElapsedTicker(),
        startedAt: Date.now(),
        currentStep: 0,
        cancelUrl: '/api/run-disc/cancel'
    };

    const reader = makeNdjsonReader();
    let terminal = null;  // 'done' | 'cancelled' | 'failed'

    try {
        const response = await fetch('/api/run-disc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: state.projectPath,
                filePath: lastSavedRelativePath
            }),
            signal: abort.signal
        });

        if (!response.ok || !response.body) {
            const text = await response.text();
            appendRawLine(text || `Request failed (${response.status})`);
            terminal = 'failed';
            return;
        }

        const decoder = new TextDecoder();
        const bodyReader = response.body.getReader();
        while (true) {
            const { done, value } = await bodyReader.read();
            if (done) break;
            const events = reader.push(decoder.decode(value, { stream: true }));
            for (const ev of events) {
                const result = handleRunEvent(ev);
                if (result) terminal = result;
            }
        }
    } catch (err) {
        if (err && err.name === 'AbortError') {
            terminal = terminal || 'cancelled';
        } else {
            appendRawLine(`[error] ${err.message}`);
            terminal = terminal || 'failed';
        }
    } finally {
        // Defensive: if the server never emitted a terminal event, force one.
        if (!terminal) terminal = 'failed';
        if (terminal === 'done') {
            markAllDone();
            setRunStatus('done', '✓ Done');
        } else if (terminal === 'cancelled') {
            setRunStatus('cancelled', 'Cancelled');
        } else {
            setRunStatus('failed', '✗ Failed');
        }
        resetRunState();
        saveEls.runBtn.disabled = false;
        saveEls.runBtn.textContent = originalLabel;
    }
});

// Handle one parsed NDJSON event from the server. Returns a terminal-state
// string ('done' | 'cancelled' | 'failed') if this event ends the run,
// otherwise null. Pure UI-side dispatch — never touches the network.
function handleRunEvent(ev) {
    if (!ev || !ev.event) return null;
    switch (ev.event) {
        case 'runId':
            if (runState) runState.runId = ev.runId;
            return null;
        case 'start':
            appendRawLine('[start]');
            return null;
        case 'step': {
            const n = parseInt(ev.n, 10);
            if (n >= 1 && n <= 8 && runState && n > runState.currentStep) {
                runState.currentStep = n;
                setStepActive(n);
            }
            return null;
        }
        case 'tool': {
            const tool = ev.tool || '?';
            const summary = ev.summary || '';
            setActivity(`⟳ ${tool}${summary ? ' · ' + summary : ''}`);
            appendRawLine(`[tool] ${tool}${summary ? ' ' + summary : ''}`);
            return null;
        }
        case 'text':
            if (ev.text) appendRawLine(ev.text);
            return null;
        case 'raw':
            if (ev.text) appendRawLine(ev.text);
            return null;
        case 'done': {
            const exit = typeof ev.exit === 'number' ? ev.exit : 0;
            if (ev.error) appendRawLine(`[error] ${ev.error}`);
            appendRawLine(`[exit ${exit}]`);
            if (ev.error || exit !== 0) return 'failed';
            return 'done';
        }
        default:
            return null;
    }
}

if (saveEls.runCancel) {
    saveEls.runCancel.addEventListener('click', async () => {
        if (!runState) return;
        const runId = runState.runId;
        // Tell the server first (best effort), then abort the fetch so the
        // reader loop unwinds promptly. cancelUrl varies by run mode (DisC
        // vs plugin install) so we pick whichever is active.
        if (runId && runState.cancelUrl) {
            try {
                await fetch(runState.cancelUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ runId })
                });
            } catch { /* server may have already exited */ }
        }
        try { runState.abort.abort(); } catch {}
        // The finally{} block on the run handler will set the cancelled state.
    });
}

// Shared streaming flow for the install + update plugin operations. Both
// reuse the run-progress panel in install-mode (DisC checklist hidden via
// CSS), and both terminate by re-fetching plugin status. The on-success
// callback is the only thing that differs (update flashes the restart hint).
async function streamPluginAction({ button, fetchUrl, cancelUrl, runningLabel, busyLabel, doneLabel, failLabel, onSuccess }) {
    saveEls.runConsole.textContent = '';
    saveEls.runActivity.textContent = '—';
    saveEls.runPanel.dataset.mode = 'install';
    saveEls.runPanel.classList.remove('hidden');
    setRunStatus('running', runningLabel);
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = busyLabel;

    const abort = new AbortController();
    runState = {
        runId: null,
        abort,
        ticker: startElapsedTicker(),
        startedAt: Date.now(),
        currentStep: 0,
        cancelUrl
    };

    const reader = makeNdjsonReader();
    let terminal = null;

    try {
        const response = await fetch(fetchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: abort.signal
        });
        if (!response.ok || !response.body) {
            appendRawLine(`Request failed (${response.status})`);
            terminal = 'failed';
            return;
        }
        const decoder = new TextDecoder();
        const bodyReader = response.body.getReader();
        while (true) {
            const { done, value } = await bodyReader.read();
            if (done) break;
            const events = reader.push(decoder.decode(value, { stream: true }));
            for (const ev of events) {
                const result = handleRunEvent(ev);
                if (result) terminal = result;
            }
        }
    } catch (err) {
        if (err && err.name === 'AbortError') {
            terminal = terminal || 'cancelled';
        } else {
            appendRawLine(`[error] ${err.message}`);
            terminal = terminal || 'failed';
        }
    } finally {
        if (!terminal) terminal = 'failed';
        if (terminal === 'done') {
            setRunStatus('done', doneLabel);
            if (typeof onSuccess === 'function') onSuccess();
            else refreshPluginStatus();
        } else if (terminal === 'cancelled') {
            setRunStatus('cancelled', 'Cancelled');
        } else {
            setRunStatus('failed', failLabel);
        }
        delete saveEls.runPanel.dataset.mode;
        resetRunState();
        button.disabled = false;
        button.textContent = originalLabel;
    }
}

if (saveEls.installBtn) {
    saveEls.installBtn.addEventListener('click', () => streamPluginAction({
        button: saveEls.installBtn,
        fetchUrl: '/api/install-plugin',
        cancelUrl: '/api/install-plugin/cancel',
        runningLabel: 'Installing plugin…',
        busyLabel: 'Installing…',
        doneLabel: '✓ Installed',
        failLabel: '✗ Install failed'
    }));
}

if (saveEls.updateBtn) {
    saveEls.updateBtn.addEventListener('click', () => {
        // Capture the version we're updating TO so the post-success flash
        // can name it. After streamPluginAction's onSuccess runs, the
        // pluginStatus may have been refreshed with this version.
        const targetVersion = pluginStatus && pluginStatus.latestVersion;
        return streamPluginAction({
            button: saveEls.updateBtn,
            fetchUrl: '/api/update-plugin',
            cancelUrl: '/api/update-plugin/cancel',
            runningLabel: 'Updating plugin…',
            busyLabel: 'Updating…',
            doneLabel: '✓ Updated',
            failLabel: '✗ Update failed',
            onSuccess: () => {
                // Surface the restart-required hint, then re-fetch status so
                // the pill settles to the new installed version.
                if (targetVersion) flashRestartRequired(targetVersion);
                else refreshPluginStatus();
            }
        });
    });
}

if (saveEls.skipUpdateBtn) {
    saveEls.skipUpdateBtn.addEventListener('click', () => {
        // Suppress the prompt for THIS upstream version only — if a newer
        // one ships during the same session, the prompt will re-appear.
        const v = pluginStatus && pluginStatus.latestVersion;
        if (v) sessionStorage.setItem(SKIPPED_UPDATE_KEY, v);
        renderPluginStatus();
    });
}

// "Re-check ↻" buttons in both the missing-state and update-available cards.
// Each one re-fires the status endpoint and re-renders. Useful when the user
// installed/updated the plugin in a separate terminal.
document.querySelectorAll('[data-recheck]').forEach(btn => {
    btn.addEventListener('click', () => {
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Re-checking…';
        refreshPluginStatus().finally(() => {
            btn.disabled = false;
            btn.textContent = original;
        });
    });
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

    state.targetPackage = 'com.example.invoice';

    const invoiceService = makeParticipant('InvoiceService');
    const generateInvoice = makeMethod('generateInvoice', [{ name: 'customerId', type: 'UUID' }], 'Invoice');
    invoiceService.methods.push(generateInvoice);

    const orderRepository = makeParticipant('OrderRepository');
    const findAllByCustomerId = makeMethod('findAllByCustomerId', [{ name: 'customerId', type: 'UUID' }], 'List<Order>');
    orderRepository.methods.push(findAllByCustomerId);

    const invoiceBuilderFactory = makeParticipant('InvoiceBuilderFactory');
    const create = makeMethod('create', [], 'InvoiceBuilder');
    invoiceBuilderFactory.methods.push(create);

    const invoiceBuilder = makeParticipant('InvoiceBuilder');
    const addLine = makeMethod('addLine', [{ name: 'order', type: 'Order' }], 'void');
    const build = makeMethod('build', [], 'Invoice');
    invoiceBuilder.methods.push(addLine, build);

    state.participants = [invoiceService, orderRepository, invoiceBuilderFactory, invoiceBuilder];
    state.sequence = [
        { id: newId(), kind: STEP_KIND.CALL, callerId: invoiceService.id, calleeId: orderRepository.id, methodId: findAllByCustomerId.id },
        { id: newId(), kind: STEP_KIND.CALL, callerId: invoiceService.id, calleeId: invoiceBuilderFactory.id, methodId: create.id },
        { id: newId(), kind: STEP_KIND.LOOP_START, label: 'for each order in orders' },
        { id: newId(), kind: STEP_KIND.CALL, callerId: invoiceService.id, calleeId: invoiceBuilder.id, methodId: addLine.id },
        { id: newId(), kind: STEP_KIND.LOOP_END },
        { id: newId(), kind: STEP_KIND.CALL, callerId: invoiceService.id, calleeId: invoiceBuilder.id, methodId: build.id }
    ];

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
