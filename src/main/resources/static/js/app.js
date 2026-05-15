const state = {
    projectPath: null,
    scanResult: null,
    userStory: '',
    participants: [],
    sequence: [],
    targetPackage: '',
    // Marks which participant is the System Under Test. When set, the
    // wizard auto-manages the entry interaction ([*] -> SUT) and final
    // return ([*] <-- SUT) steps. DisC requires exactly one system_caller
    // per .puml; this is how we author it.
    sutParticipantId: null,
    // Concept-tree state. tree is populated by POST /api/analyze on enterStep2
    // when a user story is set; null means "haven't analysed yet" or
    // "manual mode" (Start empty). analyzeError is set when claude is missing
    // or the call fails — falls back to manual participant authoring.
    tree: null,
    analyzeError: null,
    analyzing: false
};

// Java package name validator: at least two segments, each starting with a
// lowercase letter, dotted. e.g. com.example.invoice
const JAVA_PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

// Sentinel "participant" id used as callerId on the entry interaction step
// and as calleeId on the final-return step. PlantUML writes the
// system_caller as `[*]` per the Java profile. The sentinel never resolves
// to a real participant — findParticipant() returns null for it and code
// paths special-case it where rendering matters.
const SYSTEM_CALLER_ID = '__system_caller__';
function isSystemCaller(id) { return id === SYSTEM_CALLER_ID; }

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
    participantsCount: document.getElementById('participants-count'),
    analyzeBanner: document.getElementById('analyze-banner'),
    analyzeBannerText: document.getElementById('analyze-banner-text'),
    analyzeBannerAction: document.getElementById('analyze-banner-action'),
    conceptTreeSection: document.getElementById('concept-tree-section'),
    conceptTree: document.getElementById('concept-tree'),
    startEmptyBtn: document.getElementById('start-empty-btn')
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
    populatePackagesDatalist();
}

// Populate the Step 4 target-package autocomplete from the unique
// packageName values scanned in the connected project. Free-typing still
// works — this just lets the user pick from packages that already exist.
//
// The list is also persisted to localStorage so it survives a page reload:
// when the user reopens the wizard before reconnecting a project, the
// dropdown still shows the packages from the last scan.
const PACKAGES_STORAGE_KEY = 'disc.lastScanPackages.v1';

function populatePackagesDatalist() {
    const dl = document.getElementById('packages-datalist');
    if (!dl) return;
    const scan = state.scanResult;
    let packages;
    if (scan) {
        const set = new Set();
        for (const list of [scan.classes, scan.interfaces, scan.dataTypes]) {
            if (!list) continue;
            for (const t of list) {
                if (t && t.packageName) set.add(t.packageName);
            }
        }
        packages = [...set].sort();
        try { localStorage.setItem(PACKAGES_STORAGE_KEY, JSON.stringify(packages)); }
        catch (_) { /* private mode / quota — non-fatal */ }
    } else {
        // No live scan — fall back to the last persisted list so the dropdown
        // still helps after a reload before the user reconnects.
        try {
            const raw = localStorage.getItem(PACKAGES_STORAGE_KEY);
            packages = raw ? JSON.parse(raw) : [];
        } catch (_) {
            packages = [];
        }
    }
    dl.innerHTML = (packages || [])
        .map(p => `<option value="${escapeHtml(p)}">`)
        .join('');
}

// On page load, hydrate the package dropdown from localStorage so it's
// useful immediately — before any scan has had a chance to run.
populatePackagesDatalist();

// --- Participant model ---

function makeParticipant(name = '', implByDefault = true) {
    return { id: newId(), name, implByDefault, methods: [] };
}

function makeMethod(name = '', inputs = [], output = '') {
    return { id: newId(), name, inputs, output };
}

// Walk a concept-tree (depth-first) and produce the participant array the
// rest of the wizard already consumes. The hierarchy is a design aid for the
// user; once flattened, parent/child relationships disappear — what survives
// is the set of named interfaces and their methods. Behaviors[].args become
// method inputs; behaviors[].returns becomes method output.
function flattenTreeToParticipants(root) {
    if (!root || typeof root !== 'object') return [];
    const out = [];
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        const name = (node.name || '').trim();
        if (name) {
            const methods = (node.behaviors || []).map(b => {
                const inputs = (b.args || [])
                    .filter(a => a && (a.name || a.type))
                    .map(a => ({ name: a.name || '', type: a.type || '' }));
                return makeMethod(b.name || '', inputs, b.returns || '');
            });
            out.push({ id: newId(), name, implByDefault: true, methods });
        }
        for (const c of (node.children || [])) visit(c);
    }
    visit(root);
    return out;
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
    renderConceptTree();
    renderParticipants();
    renderSequence();
    maybeAnalyzeStory();
}

// Auto-analyse the user's story when entering Step 2 *for the first time*.
// Guards:
//  - story exists (nothing to analyse otherwise)
//  - state.tree is null (haven't analysed yet OR user explicitly chose
//    "Start empty" — both mean: don't auto-trigger)
//  - no participants yet (demos seed participants directly; don't clobber)
//  - not already analysing (re-entry from goToStep shouldn't re-fire)
function maybeAnalyzeStory() {
    if (!state.userStory) return;
    if (state.tree) return;
    if (state.participants.length > 0) return;
    if (state.analyzing) return;
    runAnalyze(state.userStory);
}

async function runAnalyze(context) {
    state.analyzing = true;
    state.analyzeError = null;
    showAnalyzeBanner('Analysing your story…', { spinning: true });
    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Analyze failed (${res.status})`);
        state.tree = data;
        state.participants = flattenTreeToParticipants(data);
        renderConceptTree();
        renderParticipants();
        renderSequence();
        hideAnalyzeBanner();
    } catch (err) {
        state.analyzeError = err.message;
        showAnalyzeBanner(
            'Couldn\'t suggest abstractions: ' + err.message + '. Add participants manually below.',
            { spinning: false, error: true, dismissable: true }
        );
    } finally {
        state.analyzing = false;
    }
}

function showAnalyzeBanner(text, opts = {}) {
    const b = step2Els.analyzeBanner;
    if (!b) return;
    b.classList.remove('hidden');
    b.classList.toggle('is-error', !!opts.error);
    step2Els.analyzeBannerText.textContent = text;
    const action = step2Els.analyzeBannerAction;
    if (opts.dismissable) {
        action.textContent = 'Dismiss';
        action.classList.remove('hidden');
        action.onclick = hideAnalyzeBanner;
    } else {
        action.classList.add('hidden');
        action.onclick = null;
    }
}

function hideAnalyzeBanner() {
    if (step2Els.analyzeBanner) step2Els.analyzeBanner.classList.add('hidden');
}

// --- Concept tree view ---

function renderConceptTree() {
    if (!step2Els.conceptTreeSection || !step2Els.conceptTree) return;
    if (!state.tree) {
        step2Els.conceptTreeSection.classList.add('hidden');
        step2Els.conceptTree.innerHTML = '';
        return;
    }
    step2Els.conceptTreeSection.classList.remove('hidden');
    step2Els.conceptTree.innerHTML = '';
    step2Els.conceptTree.appendChild(buildTreeNode(state.tree));
}

function buildTreeNode(node) {
    if (!node || typeof node !== 'object') return document.createTextNode('');
    const wrap = document.createElement('div');
    wrap.className = 'tree-node' + (node.isLeaf ? ' is-leaf' : '');

    const head = document.createElement('div');
    head.className = 'tree-node-head';
    const name = document.createElement('span');
    name.className = 'tree-node-name';
    name.textContent = node.name || '(unnamed)';
    head.appendChild(name);
    const tag = document.createElement('span');
    tag.className = 'tree-node-tag';
    tag.textContent = node.isLeaf ? 'leaf' : 'orchestrates';
    head.appendChild(tag);
    wrap.appendChild(head);

    if (node.purpose) {
        const purpose = document.createElement('p');
        purpose.className = 'tree-node-purpose';
        purpose.textContent = node.purpose;
        wrap.appendChild(purpose);
    }

    const attrs = node.attributes || [];
    if (attrs.length > 0) {
        const row = document.createElement('div');
        row.className = 'tree-node-attrs';
        const label = document.createElement('span');
        label.className = 'tree-node-section-label';
        label.textContent = 'has';
        row.appendChild(label);
        for (const a of attrs) {
            const chip = document.createElement('span');
            chip.className = 'tree-chip';
            chip.textContent = `${a.name || '?'}: ${a.type || '?'}`;
            row.appendChild(chip);
        }
        wrap.appendChild(row);
    }

    const behaviors = node.behaviors || [];
    if (behaviors.length > 0) {
        const row = document.createElement('div');
        row.className = 'tree-node-behaviors';
        const label = document.createElement('span');
        label.className = 'tree-node-section-label';
        label.textContent = 'does';
        row.appendChild(label);
        for (const b of behaviors) {
            const chip = document.createElement('span');
            chip.className = 'tree-chip behavior';
            chip.textContent = behaviorSignature(b);
            row.appendChild(chip);
        }
        wrap.appendChild(row);
    }

    const children = node.children || [];
    if (children.length > 0) {
        const kids = document.createElement('div');
        kids.className = 'tree-children';
        for (const c of children) kids.appendChild(buildTreeNode(c));
        wrap.appendChild(kids);
    }

    return wrap;
}

function behaviorSignature(b) {
    const args = (b.args || [])
        .map(a => `${a.name || ''}${a.type ? ': ' + a.type : ''}`.trim())
        .filter(Boolean)
        .join(', ');
    const ret = b.returns && b.returns !== 'void' ? `: ${b.returns}` : (b.returns === 'void' ? ': void' : '');
    return `${b.name || '?'}(${args})${ret}`;
}

// "Start fresh" — drop the suggested tree and let the user author manually.
// Clears participants too (they were derived from the tree). The existing
// "+ new participant" UI takes over.
if (step2Els.startEmptyBtn) {
    step2Els.startEmptyBtn.addEventListener('click', () => {
        if (state.participants.length > 0 && !confirm(
            'Clear the suggested abstractions and start with empty participants?'
        )) return;
        state.tree = null;
        state.participants = [];
        state.sequence = [];
        state.sutParticipantId = null;
        renderConceptTree();
        renderParticipants();
        renderSequence();
    });
}

// --- Participants UI ---

// Remove the auto-managed entry interaction + final return steps from the
// sequence. Used when (un)marking the SUT or deleting the SUT participant.
function removeSystemCallerSteps() {
    state.sequence = state.sequence.filter(s =>
        !(isSystemCaller(s.callerId) || isSystemCaller(s.calleeId)));
}

// Append the entry interaction + final return steps for the given SUT and
// chosen entry method. Called from toggleSut (when the SUT has one method)
// or from the "pick entry method" banner.
function addSystemCallerStepsFor(sutId, methodId) {
    state.sequence.unshift({
        id: newId(),
        kind: STEP_KIND.CALL,
        callerId: SYSTEM_CALLER_ID,
        calleeId: sutId,
        methodId
    });
    state.sequence.push({
        id: newId(),
        kind: STEP_KIND.CALL,
        callerId: sutId,
        calleeId: SYSTEM_CALLER_ID,
        methodId
    });
}

// Click handler for the SUT chip on each participant card. Marking a
// participant as SUT auto-adds the entry interaction + final return; if
// the SUT has exactly one method we use it as the entry method, otherwise
// the user picks via the "pick entry method" banner that renderSteps shows.
function toggleSut(participantId) {
    const p = findParticipant(participantId);
    if (!p) return;
    if (state.sutParticipantId === participantId) {
        state.sutParticipantId = null;
        removeSystemCallerSteps();
    } else {
        removeSystemCallerSteps();
        state.sutParticipantId = participantId;
        if ((p.methods || []).length === 1) {
            addSystemCallerStepsFor(participantId, p.methods[0].id);
        }
        // else: banner in renderSteps prompts the user to pick a method.
    }
    renderParticipants();
    renderSequence();
}

// Called by the "pick entry method" banner dropdown when the SUT has 2+
// methods and no entry interaction is set yet.
function setEntryMethod(methodId) {
    if (!state.sutParticipantId) return;
    removeSystemCallerSteps();
    addSystemCallerStepsFor(state.sutParticipantId, methodId);
    renderSequence();
}

function renderParticipants() {
    const list = step2Els.participantsList;
    list.innerHTML = '';
    const n = state.participants.length;
    step2Els.participantsCount.textContent = `${n} participant${n === 1 ? '' : 's'}`;

    state.participants.forEach((p, idx) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'pc-card';
        if (idx === 0) card.classList.add('caller');
        if (state.sutParticipantId === p.id) card.classList.add('is-sut');
        card.dataset.id = p.id;

        const previewMethods = p.methods.slice(0, 3).map(m => {
            return escapeHtml(methodPreviewSignature(m));
        }).join('<br>');
        const moreCount = p.methods.length - 3;

        const isSut = state.sutParticipantId === p.id;
        // Chip is a <span role=button> to avoid nesting a real <button> inside
        // the card <button> (invalid HTML and triggers DevTools warnings).
        const sutChip = isSut
            ? `<span class="sut-chip sut-chip-on" role="button" tabindex="0" title="System under test — click to unmark">SUT</span>`
            : `<span class="sut-chip sut-chip-add" role="button" tabindex="0" title="Mark as system under test">+ SUT</span>`;

        card.innerHTML = `
            <div class="pc-card-head">
                <span class="pc-card-name">${escapeHtml(p.name || '(unnamed)')}</span>
                ${sutChip}
            </div>
            <div class="pc-card-methods">
                ${p.methods.length === 0 ? '<span class="pc-card-empty">no methods</span>' : previewMethods}
                ${moreCount > 0 ? `<div class="pc-card-more">+${moreCount} more</div>` : ''}
            </div>
        `;
        card.addEventListener('click', (e) => {
            // SUT chip clicks (and keyboard activations) shouldn't open the modal.
            const chip = e.target && e.target.closest && e.target.closest('.sut-chip');
            if (chip) {
                e.preventDefault();
                e.stopPropagation();
                toggleSut(p.id);
                return;
            }
            openModal(p.id);
        });
        list.appendChild(card);
    });

    const addTile = document.createElement('button');
    addTile.type = 'button';
    addTile.className = 'pc-add-tile';
    addTile.textContent = '+ new participant';
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
        // If this empty participant happened to be marked SUT, clear the
        // mark and any orphaned boundary steps that reference it.
        if (state.sutParticipantId === p.id) {
            state.sutParticipantId = null;
            removeSystemCallerSteps();
        }
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
    // Deleting the SUT participant clears the mark; the boundary steps were
    // already removed by the filter above (they reference this participant).
    if (state.sutParticipantId === p.id) {
        state.sutParticipantId = null;
        removeSystemCallerSteps();
    }
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
    }
    // Re-validate against current participants — drop refs to deleted entities.
    if (addStepDraft.callerId && !findParticipant(addStepDraft.callerId)) addStepDraft.callerId = '';
    if (addStepDraft.calleeId && !findParticipant(addStepDraft.calleeId)) addStepDraft.calleeId = '';
    if (addStepDraft.methodId && !findMethod(addStepDraft.calleeId, addStepDraft.methodId)) addStepDraft.methodId = '';

    // Smart caller default: when no caller is set, prefill from the last CALL
    // step's caller (the common "same orchestrator throughout" case). Falls
    // back to the first participant when no calls exist yet.
    if (!addStepDraft.callerId) {
        for (let i = state.sequence.length - 1; i >= 0; i--) {
            const s = state.sequence[i];
            if (s.kind === STEP_KIND.CALL && findParticipant(s.callerId)) {
                addStepDraft.callerId = s.callerId;
                break;
            }
        }
        if (!addStepDraft.callerId && state.participants.length > 0) {
            addStepDraft.callerId = state.participants[0].id;
        }
    }
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

// Where the next "Add step" insertion should land. 'append' = push to end.
// A number = splice at that index. Set by clicking an insert-wedge between
// existing rows; reset to 'append' after the step is added.
let composerInsertAt = 'append';

// Currently-open inline popover element (caller/callee/method picker), or null.
// Only one popover is open at a time; opening a new one closes the previous.
let openStepPopover = null;

function closeStepPopover() {
    if (openStepPopover && openStepPopover.parentNode) {
        openStepPopover.parentNode.removeChild(openStepPopover);
    }
    openStepPopover = null;
}

// Open a pill popover anchored under `anchorEl`, listing `options` (array of
// { value, label, sig? }). When the user picks one, calls `onPick(value)`.
function openPillPopover(anchorEl, options, currentValue, onPick, emptyText) {
    closeStepPopover();
    const pop = document.createElement('div');
    pop.className = 'step-pill-popover';
    if (!options.length) {
        const e = document.createElement('div');
        e.className = 'pop-empty';
        e.textContent = emptyText || 'No choices available';
        pop.appendChild(e);
    } else {
        for (const opt of options) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'pop-option';
            if (opt.value === currentValue) b.classList.add('active');
            b.innerHTML = `<span>${escapeHtml(opt.label)}</span>${opt.sig ? `<span class="pop-sig">${escapeHtml(opt.sig)}</span>` : ''}`;
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                onPick(opt.value);
                closeStepPopover();
            });
            pop.appendChild(b);
        }
    }

    document.body.appendChild(pop);

    // Position under the anchor. Account for scroll: position is page-relative.
    const r = anchorEl.getBoundingClientRect();
    const top = r.bottom + window.scrollY + 4;
    let left = r.left + window.scrollX;
    // Keep within viewport horizontally.
    const popW = pop.offsetWidth;
    const overflow = (left + popW) - (window.scrollX + document.documentElement.clientWidth - 8);
    if (overflow > 0) left -= overflow;
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(8, left)}px`;

    openStepPopover = pop;

    // Outside-click + Esc dismissal. Wait one tick so the click that opened
    // this popover doesn't immediately close it.
    setTimeout(() => {
        const onDocClick = (e) => {
            if (!pop.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
                closeStepPopover();
                document.removeEventListener('mousedown', onDocClick);
                document.removeEventListener('keydown', onKey);
            }
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                closeStepPopover();
                document.removeEventListener('mousedown', onDocClick);
                document.removeEventListener('keydown', onKey);
            }
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
    }, 0);
}

function openCallerPopover(stepId, anchorEl) {
    const step = state.sequence.find(s => s.id === stepId);
    if (!step) return;
    const options = state.participants.map(p => ({
        value: p.id,
        label: p.name || '(unnamed)'
    }));
    openPillPopover(anchorEl, options, step.callerId, (value) => {
        step.callerId = value;
        // If callee == new caller, clear callee (a participant can't call itself).
        if (step.calleeId === value) { step.calleeId = ''; step.methodId = ''; }
        renderSequence();
    }, 'No participants defined');
}

function openCalleePopover(stepId, anchorEl) {
    const step = state.sequence.find(s => s.id === stepId);
    if (!step) return;
    const options = state.participants
        .filter(p => p.id !== step.callerId)
        .map(p => ({
            value: p.id,
            label: p.name || '(unnamed)',
            sig: (p.methods || []).length === 0 ? 'no methods' : ''
        }));
    openPillPopover(anchorEl, options, step.calleeId, (value) => {
        step.calleeId = value;
        // Drop methodId if the new callee doesn't expose the current method.
        if (!findMethod(value, step.methodId)) step.methodId = '';
        renderSequence();
    }, 'Add another participant first');
}

function openMethodPopover(stepId, anchorEl) {
    const step = state.sequence.find(s => s.id === stepId);
    if (!step) return;
    const callee = findParticipant(step.calleeId);
    const options = (callee ? callee.methods : []).map(m => ({
        value: m.id,
        label: m.name || '?',
        sig: methodPreviewSignature(m)
    }));
    openPillPopover(anchorEl, options, step.methodId, (value) => {
        step.methodId = value;
        renderSequence();
    }, callee ? `${callee.name} has no methods yet` : 'Pick a callee first');
}

// Build a hover-target wedge between two rows. Clicking it relocates the
// composer to splice at `insertIndex` instead of appending. The "active"
// wedge (matching the current composerInsertAt) gets a stronger visual.
function makeInsertWedge(insertIndex) {
    const wedge = document.createElement('div');
    wedge.className = 'step-insert-wedge';
    wedge.dataset.insertAt = String(insertIndex);
    if (composerInsertAt === insertIndex) wedge.classList.add('is-target');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wedge-btn';
    btn.textContent = '+ insert here';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Toggle: clicking the active wedge again returns to append-mode.
        composerInsertAt = (composerInsertAt === insertIndex) ? 'append' : insertIndex;
        renderSequence();
    });
    wedge.appendChild(btn);
    return wedge;
}

// Deep-clone a step including its decisionTable rows + config. Used by the
// row-level duplicate button. Fragment steps are also cloneable.
function duplicateStepAt(index) {
    const orig = state.sequence[index];
    if (!orig) return;
    const copy = { ...orig, id: newId() };
    if (orig.decisionTable) {
        copy.decisionTable = {
            config: { ...orig.decisionTable.config },
            rows: (orig.decisionTable.rows || []).map(r => ({
                values: (r.values || []).slice(),
                expected: r.expected || ''
            }))
        };
    }
    state.sequence.splice(index + 1, 0, copy);
    renderSequence();
}

function renderSequence() {
    renderSteps();
    renderAddStep();
    const liveSeq = document.getElementById('live-sequence');
    if (liveSeq) renderSequenceDiagram(state.sequence, liveSeq);
}

function renderSteps() {
    const board = step2Els.stepsBoard;
    board.innerHTML = '';
    // Count only non-boundary CALL steps for the "N added" indicator —
    // the entry/final-return rows are framework boundary, not user-authored.
    const callCount = state.sequence.filter(s =>
        s.kind === STEP_KIND.CALL && !isSystemCaller(s.callerId) && !isSystemCaller(s.calleeId)
    ).length;
    step2Els.stepsCount.textContent = `${callCount} added`;

    // "Pick entry method" banner: SUT marked, has 2+ methods, and no entry
    // interaction in the sequence yet.
    const sut = state.sutParticipantId ? findParticipant(state.sutParticipantId) : null;
    const hasEntry = state.sequence.some(s => isSystemCaller(s.callerId));
    if (sut && (sut.methods || []).length >= 2 && !hasEntry) {
        const banner = document.createElement('div');
        banner.className = 'entry-method-banner';
        const sel = document.createElement('select');
        sel.innerHTML = `<option value="">— pick entry method —</option>` +
            sut.methods.map(m => `<option value="${m.id}">${escapeHtml(methodPreviewSignature(m))}</option>`).join('');
        sel.addEventListener('change', (e) => {
            if (e.target.value) setEntryMethod(e.target.value);
        });
        banner.innerHTML = `<span class="entry-method-text"><strong>${escapeHtml(sut.name)}</strong> is the system under test — pick its entry method:</span>`;
        banner.appendChild(sel);
        board.appendChild(banner);
    }

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

    state.sequence.forEach((step, stepIdx) => {
        // Insert a wedge BEFORE this row when it's not the first step. The wedge's
        // "data-insert-at" matches the index this step currently occupies — clicking
        // it relocates the composer to that position.
        if (stepIdx > 0) {
            board.appendChild(makeInsertWedge(stepIdx));
        }
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

        // System-caller boundary rows (entry interaction + final return).
        // Rendered as non-editable rows so the user can see the entry/exit
        // exists but can't accidentally delete or rewire it. Marking/
        // unmarking a SUT is the way to add/remove these.
        if (isSystemCaller(step.callerId) || isSystemCaller(step.calleeId)) {
            const isEntry = isSystemCaller(step.callerId);
            const sutId = isEntry ? step.calleeId : step.callerId;
            const sut = findParticipant(sutId);
            const method = findMethod(sutId, step.methodId);
            if (!sut || !method) return;
            const sutName = sut.name || '(unnamed)';
            const inputArgs = (method.inputs || []).map(i => i.name || i.type || '').filter(Boolean).join(', ');
            const methodCall = `.${method.name || '?'}(${inputArgs})`;
            const ret = returnLabelFor(method);
            const row = document.createElement('div');
            row.className = 'step-row sys-edge';
            row.dataset.id = step.id;
            row.draggable = false;
            if (isEntry) {
                // [*] -> SUT . method(args) → ReturnType   ⟦entry⟧
                row.innerHTML = `
                    <span class="step-grip sys-grip" aria-hidden="true" title="Entry interaction — managed by the SUT mark">·</span>
                    <span class="step-num sys-glyph" title="Entry interaction">⇥</span>
                    <div class="step-lines">
                        <div class="step-line call">
                            <span class="step-pill who from sys-pill" title="System caller — boundary, not editable">[*]</span>
                            <span class="arrow">→</span>
                            <span class="step-pill who to sys-pill" title="System under test">${escapeHtml(sutName)}</span>
                            <span class="as-dot">.</span>
                            <span class="step-pill step-method sys-pill" title="Entry method">${escapeHtml(methodCall)}</span>
                            ${ret ? `<span class="ret-suffix"><span class="ret-arrow">→</span><span class="payload">${escapeHtml(ret)}</span></span>` : `<span class="ret-suffix leaf"><span class="payload">void</span></span>`}
                            <span class="sys-tag">entry</span>
                        </div>
                    </div>
                    <div class="step-actions"></div>
                `;
            } else {
                // [*] <-- SUT : ReturnType   ⟦return⟧
                // The boundary marker [*] anchors the LEFT side of every line
                // (entry AND return), per the canonical demo .puml shape and
                // the SKILL v0.5.1 changelog. Arrow direction conveys data flow.
                row.innerHTML = `
                    <span class="step-grip sys-grip" aria-hidden="true" title="Final return — managed by the SUT mark">·</span>
                    <span class="step-num sys-glyph" title="Final return to system caller">⇤</span>
                    <div class="step-lines">
                        <div class="step-line call">
                            <span class="step-pill who from sys-pill" title="System caller — boundary, not editable">[*]</span>
                            <span class="arrow">⇠</span>
                            <span class="step-pill who to sys-pill" title="System under test">${escapeHtml(sutName)}</span>
                            ${ret ? `<span class="ret-suffix"><span class="ret-arrow">:</span><span class="payload">${escapeHtml(ret)}</span></span>` : `<span class="ret-suffix leaf"><span class="payload">void</span></span>`}
                            <span class="sys-tag">return</span>
                        </div>
                    </div>
                    <div class="step-actions"></div>
                `;
            }
            board.appendChild(row);
            return;
        }

        const call = step;
        const caller = findParticipant(call.callerId);
        const callee = findParticipant(call.calleeId);
        const method = findMethod(call.calleeId, call.methodId);
        if (!caller || !callee || !method) return;

        callIdx++;
        const callerName = caller.name || '(unnamed)';
        const calleeName = callee.name || '(unnamed)';
        const inputArgs = (method.inputs || []).map(i => i.name || i.type || '').filter(Boolean).join(', ');
        const methodCall = `.${method.name || '?'}(${inputArgs})`;
        const ret = returnLabelFor(method);
        const created = creates.get(call.id);

        // Inline trailing return suffix on the same line as the call.
        let retSuffix;
        if (created) {
            retSuffix = `<span class="ret-suffix create"><span class="ret-arrow">↪</span><span class="payload">creates ${escapeHtml(created.name)}</span></span>`;
        } else if (ret) {
            retSuffix = `<span class="ret-suffix"><span class="ret-arrow">→</span><span class="payload">${escapeHtml(ret)}</span></span>`;
        } else {
            retSuffix = `<span class="ret-suffix leaf"><span class="payload">void</span></span>`;
        }

        const dt = call.decisionTable;
        const dtStale = dt ? decisionTableIsStale(method, dt) : false;
        let dtChip;
        if (dt && dtStale) {
            dtChip = `<button type="button" class="dt-chip dt-chip-stale" title="Method signature changed — review rows">DT · stale ⚠</button>`;
        } else if (dt) {
            const n = (dt.rows || []).length;
            dtChip = `<button type="button" class="dt-chip dt-chip-on" title="Edit decision table">DT · ${n} row${n === 1 ? '' : 's'}</button>`;
        } else {
            dtChip = `<button type="button" class="dt-chip dt-chip-add" title="Mark this method as decision-table backed">+ DT</button>`;
        }

        const row = document.createElement('div');
        row.className = 'step-row';
        if (created) row.classList.add('is-create');
        if (dt) row.classList.add('has-dt');
        row.draggable = true;
        row.dataset.id = call.id;
        row.innerHTML = `
            <span class="step-grip" aria-hidden="true" title="Drag to reorder">⠿</span>
            <span class="step-num">${callIdx}</span>
            <div class="step-lines">
                <div class="step-line call">
                    <button type="button" class="step-pill who from" data-role="caller" title="Change caller">${escapeHtml(callerName)}</button>
                    <span class="arrow">→</span>
                    <button type="button" class="step-pill who to" data-role="callee" title="Change callee">${escapeHtml(calleeName)}</button>
                    <span class="as-dot">.</span>
                    <button type="button" class="step-pill step-method" data-role="method" title="Change method">${escapeHtml(methodCall)}</button>
                    ${retSuffix}
                </div>
            </div>
            <div class="step-actions">
                ${dtChip}
                <button type="button" class="step-duplicate" title="Duplicate this step">⎘</button>
                <button type="button" class="icon-btn step-remove" title="Remove step">×</button>
            </div>
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

        row.querySelector('.step-duplicate').addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = state.sequence.findIndex(s => s.id === call.id);
            if (idx >= 0) duplicateStepAt(idx);
        });

        row.querySelector('.dt-chip').addEventListener('click', (e) => {
            e.stopPropagation();
            openDecisionTableModal(call.id);
        });

        // Click-to-edit pills: caller, callee, method.
        row.querySelectorAll('.step-pill').forEach(pill => {
            pill.addEventListener('click', (e) => {
                e.stopPropagation();
                const role = pill.dataset.role;
                if (role === 'caller') openCallerPopover(call.id, pill);
                else if (role === 'callee') openCalleePopover(call.id, pill);
                else if (role === 'method') openMethodPopover(call.id, pill);
            });
            // Prevent drag from starting when the user is interacting with a pill.
            pill.addEventListener('mousedown', (e) => e.stopPropagation());
            pill.draggable = false;
        });

        board.appendChild(row);
    });

    // Trailing wedge: between the last row and the composer, so users can
    // also "insert at end" via the wedge UI (or just keep using the composer
    // which lives below). Skipped when there are no rows.
    if (state.sequence.length > 0) {
        board.appendChild(makeInsertWedge(state.sequence.length));
    }
}

function renderAddStep() {
    // Idempotent: strip any existing composer before appending a fresh one.
    const existing = step2Els.stepsBoard.querySelector('.add-step-panel');
    if (existing) existing.remove();

    // Snap a stale insert-index back to "append" if the sequence shrunk.
    if (typeof composerInsertAt === 'number' && composerInsertAt > state.sequence.length) {
        composerInsertAt = 'append';
    }

    const board = step2Els.stepsBoard;
    const panel = document.createElement('div');
    panel.className = 'add-step-panel';
    // When the user clicked a wedge between rows, splice the composer in at
    // that wedge's position rather than appending to the end.
    if (typeof composerInsertAt === 'number') {
        panel.classList.add('inline-insert');
        const wedge = board.querySelector(`.step-insert-wedge[data-insert-at="${composerInsertAt}"]`);
        if (wedge && wedge.parentNode === board) {
            board.insertBefore(panel, wedge.nextSibling);
        } else {
            board.appendChild(panel);
        }
    } else {
        board.appendChild(panel);
    }

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

    // Composer's "Step N" matches the numbering shown on the rendered CALL rows
    // (step-num badges), which count only user-authored CALLs — fragment markers
    // and SUT boundary edges aren't numbered. Count CALLs before the insertion
    // point (sequence end in append mode, the wedge index in insert mode).
    const sliceEnd = typeof composerInsertAt === 'number' ? composerInsertAt : state.sequence.length;
    const priorCalls = state.sequence.slice(0, sliceEnd).filter(s =>
        s.kind === STEP_KIND.CALL && !isSystemCaller(s.callerId) && !isSystemCaller(s.calleeId)
    ).length;
    const stepNum = priorCalls + 1;
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
        const newStep = {
            id: newId(),
            kind: STEP_KIND.CALL,
            callerId: addStepDraft.callerId,
            calleeId: addStepDraft.calleeId,
            methodId: addStepDraft.methodId
        };
        if (typeof composerInsertAt === 'number' && composerInsertAt >= 0 && composerInsertAt <= state.sequence.length) {
            state.sequence.splice(composerInsertAt, 0, newStep);
        } else {
            state.sequence.push(newStep);
        }
        // Reset to append-mode after each add so the next step lands at the end
        // unless the user clicks another wedge.
        composerInsertAt = 'append';
        // Clear callee/method after add but KEEP the caller — the smart-default
        // logic in ensureAddStepDraft will pick the same one back up. Setting
        // it blank here would force a re-pick of the same value.
        addStepDraft = { callerId: addStepDraft.callerId, calleeId: '', methodId: '' };
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

        // Entry interaction: [*] -> SUT : method(args). The methodId points
        // at a method on the SUT (callee); the caller is the system_caller
        // sentinel. Only emits a call line — the return arrow is a separate
        // step in the sequence.
        if (isSystemCaller(s.callerId)) {
            const callee = findParticipant(s.calleeId);
            const method = findMethod(s.calleeId, s.methodId);
            if (!callee || !method) return;
            lines.push(`${pad()}[*] -> ${callee.name || '_'} : ${methodSignature(method)}`);
            return;
        }
        // Final return: SUT --> [*] : returnType. Only emits a return line.
        if (isSystemCaller(s.calleeId)) {
            const caller = findParticipant(s.callerId);
            const method = findMethod(s.callerId, s.methodId);
            if (!caller || !method) return;
            const ret = returnLabelFor(method);
            if (ret) {
                lines.push(`${pad()}[*] <-- ${caller.name || '_'} : ${ret}`);
            }
            // void entry method → no final return arrow emitted, which
            // matches the language profile (entry can return void).
            return;
        }

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
            // Returns use the dashed `<--` form (PlantUML's conventional return
            // arrow) so they're visually distinct from the solid call arrows
            // above. Matches the canonical source .puml files in design-is-code-demo.
            lines.push(`${pad()}${callerName} <-- ${calleeName} : ${ret}`);
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

    // Measure each lifeline name with the real 13px/700 font using a
    // throwaway off-screen SVG. Box width = measured text width + 24px
    // horizontal padding (12px each side), with a 100px floor so short
    // names don't look cramped. Robust to font + browser-zoom variation.
    const HEAD_BOX_MIN = 100;
    const headBoxWidth = {};
    {
        const probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        probe.style.position = 'fixed';
        probe.style.left = '-9999px';
        probe.style.top = '0';
        document.body.appendChild(probe);
        for (const name of lifelines) {
            const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            t.setAttribute('font-size', '13');
            t.setAttribute('font-weight', '700');
            t.textContent = name;
            probe.appendChild(t);
            let mw;
            try { mw = t.getBBox().width; }
            catch (_) { mw = (name || '').length * 8; }
            headBoxWidth[name] = Math.max(HEAD_BOX_MIN, Math.ceil(mw) + 24);
        }
        document.body.removeChild(probe);
    }

    // Column spacing: must keep every adjacent pair's boxes apart with a gap.
    // Center-to-center distance ≥ (leftBox/2 + rightBox/2 + gap).
    const COL_GAP = 36;
    let colW = 150;
    for (let i = 1; i < lifelines.length; i++) {
        const need = headBoxWidth[lifelines[i - 1]] / 2 + headBoxWidth[lifelines[i]] / 2 + COL_GAP;
        if (need > colW) colW = need;
    }
    colW = Math.ceil(colW);

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

    // Lifeline heads + dashed verticals. Uses the pre-measured box widths.
    for (const name of lifelines) {
        const x = xOf(name);
        const y = headY[name];
        const boxW = headBoxWidth[name];
        svg.appendChild(el('rect', { x: x - boxW / 2, y: y, width: boxW, height: headH, fill: '#ffffff', stroke: '#1a1a1a', 'stroke-width': '1.5', rx: '3' }));
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

function flashUpdated(newVersion) {
    if (!saveEls.pluginPill) return;
    // The new plugin is already on disk and the next "Run it for me" will
    // spawn a fresh `claude` subprocess that picks it up — no user action
    // required. Show a brief confirmation then refresh status normally.
    saveEls.pluginPill.textContent = `DisC plugin updated to v${newVersion} ✓`;
    saveEls.pluginPill.dataset.state = 'updated';
    saveEls.pluginPill.classList.remove('hidden');
    setTimeout(() => {
        refreshPluginStatus();
    }, 4000);
}

// --- Step-checklist for the "Run it for me" panel ---
//
// Hardcoded against the DisC v0.5.1 SKILL. The run-event regex
// (StreamJsonMapper.STEP_RE) matches step NUMBERS only, so a title mismatch
// would never break event mapping — it would only show stale labels. When the
// DisC plugin renames steps, update this array. That's the entire maintenance
// burden; no manual snapshot of SKILL.md required.
const DISC_STEPS = [
    { n: 1, title: 'Validate Design' },
    { n: 2, title: 'Classify Participants' },
    { n: 3, title: 'Resolve Targets' },
    { n: 4, title: 'Generate Tests' },
    { n: 5, title: 'Check Tests' },
    { n: 6, title: 'Generate Implementation' },
    { n: 7, title: 'Write Files' },
    { n: 8, title: 'Report' }
];

function renderRunChecklist() {
    if (!saveEls.runChecklist) return;
    saveEls.runChecklist.innerHTML = DISC_STEPS.map(s => `
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

    // Collect any decision tables attached to CALL steps and serialize each
    // as a YAML+markdown sidecar. The backend writes them next to the .puml.
    const decisionTables = [];
    for (const step of state.sequence) {
        if (step.kind !== STEP_KIND.CALL || !step.decisionTable) continue;
        const participant = findParticipant(step.calleeId);
        const method = findMethod(step.calleeId, step.methodId);
        if (!participant || !method) continue;
        decisionTables.push({
            fileName: decisionTableFileName(participant),
            content: emitDecisionTable(participant, method, step.decisionTable, state.targetPackage)
        });
    }

    try {
        const res = await fetch('/api/design', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: state.projectPath, fileName, content, decisionTables })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);

        const dtCount = data.decisionTableCount || 0;
        saveEls.resultPath.textContent = dtCount > 0
            ? `${data.savedPath}  · +${dtCount} decision table${dtCount === 1 ? '' : 's'}`
            : data.savedPath;
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
        const modelSelect = document.getElementById('run-model');
        const response = await fetch('/api/run-disc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: state.projectPath,
                filePath: lastSavedRelativePath,
                model: modelSelect ? modelSelect.value : null
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
                // Confirm the update briefly; the new plugin is already live
                // for the next "Run it for me" subprocess.
                if (targetVersion) flashUpdated(targetVersion);
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

// --- Decision tables ---
// A CALL step can carry an optional `decisionTable` field describing rule-driven
// behavior as a YAML+markdown sidecar that DisC's codegen consumes. Header
// columns (input names) and the output type are *derived* from the called
// method's signature, so editing the method automatically reshapes the DT.

const NUMERIC_OUTPUT_TYPES = new Set([
    'BigDecimal', 'java.math.BigDecimal',
    'Integer', 'Long', 'Double', 'Float', 'Short', 'Byte',
    'int', 'long', 'double', 'float', 'short', 'byte',
    'Number'
]);

function isNumericOutput(method) {
    if (!method) return false;
    const out = (method.output || '').trim();
    return NUMERIC_OUTPUT_TYPES.has(out);
}

function defaultDecisionConfig(method) {
    const config = {
        nullHandling: 'throw',
        exceptionType: 'java.lang.IllegalArgumentException'
    };
    if (isNumericOutput(method)) {
        config.rounding = 'HALF_UP';
        config.scale = 2;
    }
    return config;
}

function makeDecisionTable(method, rows) {
    return {
        config: defaultDecisionConfig(method),
        rows: rows && rows.length ? rows : [{ values: (method.inputs || []).map(() => ''), expected: '' }]
    };
}

function decisionTableIsStale(method, dt) {
    if (!method || !dt) return false;
    const expected = (method.inputs || []).length;
    return (dt.rows || []).some(r => (r.values || []).length !== expected);
}

function decisionTableFileName(participant) {
    const name = (participant && participant.name ? participant.name : 'Participant').trim() || 'Participant';
    return `${name}.decision.md`;
}

// Markdown-table column-width formatter: pads each column to its longest cell
// (header included) so the saved sidecar reads cleanly when opened in an editor.
function emitMarkdownTable(headers, rows) {
    const widths = headers.map((h, i) => {
        const cellMax = rows.reduce((max, r) => Math.max(max, String(r[i] || '').length), 0);
        return Math.max(String(h).length, cellMax);
    });
    const fmtRow = (cells) => '| ' + cells.map((c, i) => String(c || '').padEnd(widths[i])).join(' | ') + ' |';
    const sep = '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|';
    return [fmtRow(headers), sep, ...rows.map(r => fmtRow(r))].join('\n');
}

function emitDecisionTable(participant, method, dt, targetPackage) {
    const inputs = (method.inputs || []).map(i => ({
        name: (i.name || '').trim() || '?',
        type: (i.type || '').trim() || '?'
    }));
    const output = (method.output || '').trim() || 'void';
    const config = dt.config || defaultDecisionConfig(method);

    const lines = [];
    lines.push('---');
    lines.push(`target: ${participant.name || '?'}.${method.name || '?'}`);
    if (targetPackage) lines.push(`package: ${targetPackage}`);
    lines.push('input:');
    inputs.forEach(i => lines.push(`  ${i.name}: ${i.type}`));
    lines.push(`output: ${output}`);
    lines.push('config:');
    if (isNumericOutput(method)) {
        if (config.rounding) lines.push(`  rounding: ${config.rounding}`);
        if (config.scale !== undefined && config.scale !== '') lines.push(`  scale: ${config.scale}`);
    }
    if (config.nullHandling) lines.push(`  nullHandling: ${config.nullHandling}`);
    if (config.nullHandling === 'throw' && config.exceptionType) {
        lines.push(`  exceptionType: ${config.exceptionType}`);
    }
    if (config.nullHandling === 'defaultValue' && config.defaultValue) {
        lines.push(`  defaultValue: ${config.defaultValue}`);
    }
    if (config.locale && config.locale.trim()) {
        lines.push(`  locale: ${config.locale.trim()}`);
    }
    lines.push('---');
    lines.push('');

    const headers = [...inputs.map(i => i.name), 'expected'];
    const tableRows = (dt.rows || []).map(r => {
        const values = (r.values || []).slice(0, inputs.length);
        while (values.length < inputs.length) values.push('');
        return [...values.map(v => String(v || '')), String(r.expected || '')];
    });
    lines.push(emitMarkdownTable(headers, tableRows));
    lines.push('');
    return lines.join('\n');
}

// --- DT modal ---

const dtModalEls = {
    backdrop: document.getElementById('dt-modal'),
    title: document.getElementById('dt-modal-title'),
    close: document.getElementById('dt-modal-close'),
    body: document.getElementById('dt-modal-body'),
    remove: document.getElementById('dt-modal-remove'),
    done: document.getElementById('dt-modal-done')
};

let dtModalActive = null;  // { stepId, method, participant }

function openDecisionTableModal(stepId) {
    const step = state.sequence.find(s => s.id === stepId);
    if (!step || step.kind !== STEP_KIND.CALL) return;
    const participant = findParticipant(step.calleeId);
    const method = findMethod(step.calleeId, step.methodId);
    if (!participant || !method) return;

    if (!step.decisionTable) {
        step.decisionTable = makeDecisionTable(method);
    } else if ((step.decisionTable.rows || []).length === 0) {
        step.decisionTable.rows = [{ values: (method.inputs || []).map(() => ''), expected: '' }];
    }

    dtModalActive = { stepId, method, participant };
    dtModalEls.title.textContent = `Decision table · ${participant.name}.${method.name}`;
    renderDecisionModalBody();
    dtModalEls.backdrop.classList.remove('hidden');
}

function closeDecisionTableModal() {
    dtModalActive = null;
    dtModalEls.backdrop.classList.add('hidden');
    renderSequence();
}

function renderDecisionModalBody() {
    if (!dtModalActive) return;
    const step = state.sequence.find(s => s.id === dtModalActive.stepId);
    if (!step) { closeDecisionTableModal(); return; }
    const { participant, method } = dtModalActive;
    const dt = step.decisionTable;
    const inputs = method.inputs || [];
    const numeric = isNumericOutput(method);
    const stale = decisionTableIsStale(method, dt);

    const targetSig = `${participant.name || '?'}.${method.name || '?'}`;
    const inputsLabel = inputs.length
        ? inputs.map(i => `${(i.name || '?')}: ${(i.type || '?')}`).join(', ')
        : '(none)';
    const outputLabel = (method.output || '').trim() || 'void';

    const body = dtModalEls.body;
    body.innerHTML = '';

    // Header strip
    const strip = document.createElement('dl');
    strip.className = 'dt-target-strip';
    strip.innerHTML = `
        <dt>target</dt><dd>${escapeHtml(targetSig)}</dd>
        <dt>package</dt><dd>${escapeHtml(state.targetPackage || '(unset)')}</dd>
        <dt>input</dt><dd>${escapeHtml(inputsLabel)}</dd>
        <dt>output</dt><dd>${escapeHtml(outputLabel)}</dd>
    `;
    body.appendChild(strip);

    if (stale) {
        const banner = document.createElement('div');
        banner.className = 'dt-stale-banner';
        banner.textContent = 'Method signature changed since rows were last edited. Review row values below.';
        body.appendChild(banner);
    }

    // Config
    const cfgLabel = document.createElement('span');
    cfgLabel.className = 'dt-section-label';
    cfgLabel.textContent = 'Config';
    body.appendChild(cfgLabel);

    const cfgGrid = document.createElement('div');
    cfgGrid.className = 'dt-config-grid';

    const currentNullHandling = dt.config.nullHandling || 'throw';

    const nullHandlingLabel = document.createElement('label');
    nullHandlingLabel.innerHTML = `<span>null handling</span>`;
    const seg = document.createElement('div');
    seg.className = 'dt-segmented';
    ['throw', 'passThrough', 'defaultValue'].forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = opt;
        if (currentNullHandling === opt) btn.classList.add('active');
        btn.addEventListener('click', () => {
            dt.config.nullHandling = opt;
            // Clear orphaned dependent fields when switching modes so the
            // emitted YAML doesn't carry stale keys.
            if (opt !== 'throw') delete dt.config.exceptionType;
            if (opt !== 'defaultValue') delete dt.config.defaultValue;
            renderDecisionModalBody();
        });
        seg.appendChild(btn);
    });
    nullHandlingLabel.appendChild(seg);
    cfgGrid.appendChild(nullHandlingLabel);

    if (currentNullHandling === 'throw') {
        const exLabel = document.createElement('label');
        exLabel.innerHTML = `<span>exception type</span>`;
        const exInput = document.createElement('input');
        exInput.type = 'text';
        exInput.value = dt.config.exceptionType || '';
        exInput.placeholder = 'java.lang.IllegalArgumentException';
        exInput.addEventListener('input', e => { dt.config.exceptionType = e.target.value; });
        exLabel.appendChild(exInput);
        cfgGrid.appendChild(exLabel);
    } else if (currentNullHandling === 'defaultValue') {
        const dvLabel = document.createElement('label');
        dvLabel.innerHTML = `<span>default value</span>`;
        const dvInput = document.createElement('input');
        dvInput.type = 'text';
        dvInput.value = dt.config.defaultValue || '';
        dvInput.placeholder = 'e.g. BigDecimal.ZERO';
        dvInput.addEventListener('input', e => { dt.config.defaultValue = e.target.value; });
        dvLabel.appendChild(dvInput);
        cfgGrid.appendChild(dvLabel);
    }

    if (numeric) {
        const roundLabel = document.createElement('label');
        roundLabel.innerHTML = `<span>rounding</span>`;
        const roundSel = document.createElement('select');
        ['HALF_UP', 'HALF_EVEN', 'HALF_DOWN', 'CEILING', 'FLOOR'].forEach(r => {
            const opt = document.createElement('option');
            opt.value = r; opt.textContent = r;
            if ((dt.config.rounding || 'HALF_UP') === r) opt.selected = true;
            roundSel.appendChild(opt);
        });
        roundSel.addEventListener('change', e => { dt.config.rounding = e.target.value; });
        roundLabel.appendChild(roundSel);
        cfgGrid.appendChild(roundLabel);

        const scaleLabel = document.createElement('label');
        scaleLabel.innerHTML = `<span>scale</span>`;
        const scaleInput = document.createElement('input');
        scaleInput.type = 'number';
        scaleInput.min = '0';
        scaleInput.value = dt.config.scale != null ? dt.config.scale : 2;
        scaleInput.addEventListener('input', e => {
            const n = parseInt(e.target.value, 10);
            dt.config.scale = isNaN(n) ? '' : n;
        });
        scaleLabel.appendChild(scaleInput);
        cfgGrid.appendChild(scaleLabel);
    }

    const localeLabel = document.createElement('label');
    localeLabel.innerHTML = `<span>locale <small style="color: var(--text-3); font-weight: 400;">(optional — default ROOT)</small></span>`;
    const localeInput = document.createElement('input');
    localeInput.type = 'text';
    localeInput.value = dt.config.locale || '';
    localeInput.placeholder = 'ROOT or BCP-47 tag (e.g. en-US)';
    localeInput.addEventListener('input', e => {
        const v = e.target.value.trim();
        if (v) dt.config.locale = v;
        else delete dt.config.locale;
    });
    localeLabel.appendChild(localeInput);
    cfgGrid.appendChild(localeLabel);

    body.appendChild(cfgGrid);

    // Rows
    const rowsLabel = document.createElement('span');
    rowsLabel.className = 'dt-section-label';
    rowsLabel.textContent = `Rows · ${(dt.rows || []).length}`;
    body.appendChild(rowsLabel);

    const wrap = document.createElement('div');
    wrap.className = 'dt-rows-wrap';
    const tbl = document.createElement('table');
    tbl.className = 'dt-rows-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    inputs.forEach(i => {
        const th = document.createElement('th');
        th.textContent = i.name || '?';
        headRow.appendChild(th);
    });
    const expTh = document.createElement('th');
    expTh.textContent = 'expected';
    headRow.appendChild(expTh);
    const actTh = document.createElement('th');
    actTh.className = 'dt-col-action';
    actTh.textContent = '';
    headRow.appendChild(actTh);
    thead.appendChild(headRow);
    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');
    (dt.rows || []).forEach((row, rIdx) => {
        const tr = document.createElement('tr');
        // pad/trim row.values to match inputs.length
        const values = (row.values || []).slice(0, inputs.length);
        while (values.length < inputs.length) values.push('');
        row.values = values;

        inputs.forEach((_, cIdx) => {
            const td = document.createElement('td');
            const input = document.createElement('input');
            input.className = 'dt-cell';
            input.type = 'text';
            input.value = values[cIdx] || '';
            input.addEventListener('input', e => { row.values[cIdx] = e.target.value; });
            td.appendChild(input);
            tr.appendChild(td);
        });

        const expTd = document.createElement('td');
        const expInput = document.createElement('input');
        expInput.className = 'dt-cell';
        expInput.type = 'text';
        expInput.value = row.expected || '';
        expInput.addEventListener('input', e => { row.expected = e.target.value; });
        expTd.appendChild(expInput);
        tr.appendChild(expTd);

        const actTd = document.createElement('td');
        actTd.className = 'dt-col-action';
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'dt-row-remove';
        rm.title = 'Remove row';
        rm.textContent = '×';
        rm.addEventListener('click', () => {
            dt.rows.splice(rIdx, 1);
            if (dt.rows.length === 0) {
                dt.rows.push({ values: inputs.map(() => ''), expected: '' });
            }
            renderDecisionModalBody();
        });
        actTd.appendChild(rm);
        tr.appendChild(actTd);

        tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    body.appendChild(wrap);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'dt-add-row';
    addBtn.textContent = '+ Add row';
    addBtn.addEventListener('click', () => {
        dt.rows.push({ values: inputs.map(() => ''), expected: '' });
        renderDecisionModalBody();
    });
    body.appendChild(addBtn);
}

dtModalEls.close.addEventListener('click', closeDecisionTableModal);
dtModalEls.done.addEventListener('click', closeDecisionTableModal);
dtModalEls.remove.addEventListener('click', () => {
    if (!dtModalActive) return;
    const step = state.sequence.find(s => s.id === dtModalActive.stepId);
    if (step) delete step.decisionTable;
    closeDecisionTableModal();
});
dtModalEls.backdrop.addEventListener('click', (e) => {
    if (e.target === dtModalEls.backdrop) closeDecisionTableModal();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dtModalEls.backdrop.classList.contains('hidden')) {
        closeDecisionTableModal();
    }
});

// --- Demo prefill ---
// Wired to the "Load simple/complex demo" buttons on Step 1. Seeds the wizard
// with story + participants + sequence so users can see the editor end-to-end
// without typing. The demos do NOT pretend a project is connected — to save
// the .puml the user still has to point the header chip at a real local
// project. By default (no click) every field starts empty.

// Minimum-viable example: 3 participants, 2 CALL steps, 1 decision table.
// Teaches the wizard's core concepts without loops/factories/mutators.
// Minimum-viable example based on design/03_loop.puml from the demo corpus:
// 4 participants, 4 CALL steps wrapped in one loop, no decision tables.
// Teaches the loop fragment alongside the orchestrator/repository/factory/
// builder vocabulary. The complex demo continues to be the DT showcase.
function loadSimpleDemo() {
    storyInput.value =
        "As accounting, I want to generate an invoice for a customer that " +
        "includes every order they've placed, so we can bill them in one go.";

    state.userStory = storyInput.value;
    state.targetPackage = 'com.disc.loop';

    const invoiceService = makeParticipant('InvoiceService');
    const createInvoice = makeMethod('createInvoice', [{ name: 'customerId', type: 'UUID' }], 'Invoice');
    invoiceService.methods.push(createInvoice);

    const orderRepository = makeParticipant('OrderRepository');
    const findAllByCustomerId = makeMethod('findAllByCustomerId', [{ name: 'customerId', type: 'UUID' }], 'List<Order>');
    orderRepository.methods.push(findAllByCustomerId);

    const invoiceBuilderFactory = makeParticipant('InvoiceBuilderFactory');
    const createBuilder = makeMethod('create', [], 'InvoiceBuilder');
    invoiceBuilderFactory.methods.push(createBuilder);

    const invoiceBuilder = makeParticipant('InvoiceBuilder');
    const addLine = makeMethod('addLine', [{ name: 'order', type: 'Order' }], 'void');
    const buildInvoice = makeMethod('build', [], 'Invoice');
    invoiceBuilder.methods.push(addLine, buildInvoice);

    state.participants = [invoiceService, orderRepository, invoiceBuilderFactory, invoiceBuilder];
    state.sutParticipantId = invoiceService.id;

    state.sequence = [
        // [*] -> InvoiceService : createInvoice(customerId)
        { id: newId(), kind: STEP_KIND.CALL, callerId: SYSTEM_CALLER_ID, calleeId: invoiceService.id, methodId: createInvoice.id },
        // Body
        { id: newId(), kind: STEP_KIND.CALL, callerId: invoiceService.id, calleeId: orderRepository.id, methodId: findAllByCustomerId.id },
        { id: newId(), kind: STEP_KIND.CALL, callerId: invoiceService.id, calleeId: invoiceBuilderFactory.id, methodId: createBuilder.id },
        { id: newId(), kind: STEP_KIND.LOOP_START, label: 'for each order in orders' },
        { id: newId(), kind: STEP_KIND.CALL, callerId: invoiceService.id, calleeId: invoiceBuilder.id, methodId: addLine.id },
        { id: newId(), kind: STEP_KIND.LOOP_END },
        { id: newId(), kind: STEP_KIND.CALL, callerId: invoiceService.id, calleeId: invoiceBuilder.id, methodId: buildInvoice.id },
        // [*] <-- InvoiceService : Invoice
        { id: newId(), kind: STEP_KIND.CALL, callerId: invoiceService.id, calleeId: SYSTEM_CALLER_ID, methodId: createInvoice.id }
    ];

    renderParticipants();
    renderSequence();
}

function loadComplexDemo() {
    storyInput.value =
        "As a customer, I want to place an order for one or more products in a " +
        "single checkout, so that I receive everything I need in one delivery " +
        "and pay one shipping fee.";

    state.userStory = storyInput.value;
    state.targetPackage = 'com.disc.order';

    const orderService = makeParticipant('OrderService');
    const placeOrder = makeMethod('placeOrder', [
        { name: 'customerId', type: 'UUID' },
        { name: 'orderRequest', type: 'OrderRequest' }
    ], 'Order');
    orderService.methods.push(placeOrder);

    const customerRepository = makeParticipant('CustomerRepository');
    const findCustomer = makeMethod('findById', [{ name: 'customerId', type: 'UUID' }], 'Customer');
    customerRepository.methods.push(findCustomer);

    const orderBuilderFactory = makeParticipant('OrderBuilderFactory');
    const createBuilder = makeMethod('create', [{ name: 'customer', type: 'Customer' }], 'OrderBuilder');
    orderBuilderFactory.methods.push(createBuilder);

    const productRepository = makeParticipant('ProductRepository');
    const findProduct = makeMethod('findById', [{ name: 'productId', type: 'UUID' }], 'Product');
    productRepository.methods.push(findProduct);

    const stockValidator = makeParticipant('StockValidator');
    const validateStock = makeMethod('validate', [
        { name: 'availableQty', type: 'Integer' },
        { name: 'requestedQty', type: 'Integer' }
    ], 'void');
    stockValidator.methods.push(validateStock);

    const lineSubtotalCalculator = makeParticipant('LineSubtotalCalculator');
    const calculateLineSubtotal = makeMethod('calculate', [
        { name: 'quantity', type: 'Integer' },
        { name: 'unitPrice', type: 'BigDecimal' }
    ], 'BigDecimal');
    lineSubtotalCalculator.methods.push(calculateLineSubtotal);

    const orderBuilder = makeParticipant('OrderBuilder');
    const addLine = makeMethod('addLine', [
        { name: 'lineItem', type: 'LineItem' },
        { name: 'lineSubtotal', type: 'BigDecimal' }
    ], 'void');
    const buildOrder = makeMethod('build', [], 'Order');
    orderBuilder.methods.push(addLine, buildOrder);

    const order = makeParticipant('Order');
    const subtotal = makeMethod('subtotal', [], 'BigDecimal');
    const applyShipping = makeMethod('applyShipping', [{ name: 'shippingFee', type: 'BigDecimal' }], 'void');
    order.methods.push(subtotal, applyShipping);

    const shippingFeeCalculator = makeParticipant('ShippingFeeCalculator');
    const calculateShipping = makeMethod('calculate', [
        { name: 'orderTotal', type: 'BigDecimal' },
        { name: 'region', type: 'String' }
    ], 'BigDecimal');
    shippingFeeCalculator.methods.push(calculateShipping);

    const orderRepository = makeParticipant('OrderRepository');
    const saveOrder = makeMethod('save', [{ name: 'order', type: 'Order' }], 'Order');
    orderRepository.methods.push(saveOrder);

    state.participants = [
        orderService, customerRepository, orderBuilderFactory, productRepository,
        stockValidator, lineSubtotalCalculator, orderBuilder, order,
        shippingFeeCalculator, orderRepository
    ];
    state.sutParticipantId = orderService.id;

    const stockValidatorDT = {
        config: {
            nullHandling: 'throw',
            exceptionType: 'java.lang.IllegalArgumentException'
        },
        rows: [
            { values: ['10', '1'],   expected: '(no exception)' },
            { values: ['10', '10'],  expected: '(no exception)' },
            { values: ['5', '0'],    expected: '(no exception)' },
            { values: ['10', '11'],  expected: 'throws: InsufficientStockException' },
            { values: ['0', '1'],    expected: 'throws: InsufficientStockException' },
            { values: ['5', '-1'],   expected: 'throws: IllegalArgumentException' }
        ]
    };

    const lineSubtotalDT = {
        config: {
            rounding: 'HALF_UP',
            scale: 2,
            nullHandling: 'throw',
            exceptionType: 'java.lang.IllegalArgumentException'
        },
        rows: [
            { values: ['1', '100.00'],  expected: '100.00' },
            { values: ['2', '49.99'],   expected: '99.98' },
            { values: ['3', '20.00'],   expected: '60.00' },
            { values: ['0', '100.00'],  expected: '0.00' },
            { values: ['3', '0.333'],   expected: '1.00' },
            { values: ['-1', '100.00'], expected: 'throws: IllegalArgumentException' }
        ]
    };

    const shippingFeeDT = {
        config: {
            rounding: 'HALF_UP',
            scale: 2,
            nullHandling: 'throw',
            exceptionType: 'java.lang.IllegalArgumentException'
        },
        rows: [
            { values: ['100.00', '"DOMESTIC"'],      expected: '0.00' },
            { values: ['100.00', '"INTERNATIONAL"'], expected: '0.00' },
            { values: ['250.00', '"DOMESTIC"'],      expected: '0.00' },
            { values: ['99.99', '"DOMESTIC"'],       expected: '5.00' },
            { values: ['50.00', '"DOMESTIC"'],       expected: '5.00' },
            { values: ['0.00', '"DOMESTIC"'],        expected: '5.00' },
            { values: ['99.99', '"INTERNATIONAL"'],  expected: '25.00' },
            { values: ['50.00', '"INTERNATIONAL"'],  expected: '25.00' },
            { values: ['50.00', '"ZZZ"'],            expected: 'throws: IllegalArgumentException' }
        ]
    };

    state.sequence = [
        // [*] -> OrderService : placeOrder(customerId, orderRequest)
        { id: newId(), kind: STEP_KIND.CALL, callerId: SYSTEM_CALLER_ID, calleeId: orderService.id, methodId: placeOrder.id },
        // Body
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: customerRepository.id, methodId: findCustomer.id },
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: orderBuilderFactory.id, methodId: createBuilder.id },
        { id: newId(), kind: STEP_KIND.LOOP_START, label: 'for each lineItem in orderRequest.lineItems' },
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: productRepository.id, methodId: findProduct.id },
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: stockValidator.id, methodId: validateStock.id, decisionTable: stockValidatorDT },
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: lineSubtotalCalculator.id, methodId: calculateLineSubtotal.id, decisionTable: lineSubtotalDT },
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: orderBuilder.id, methodId: addLine.id },
        { id: newId(), kind: STEP_KIND.LOOP_END },
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: orderBuilder.id, methodId: buildOrder.id },
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: order.id, methodId: subtotal.id },
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: shippingFeeCalculator.id, methodId: calculateShipping.id, decisionTable: shippingFeeDT },
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: order.id, methodId: applyShipping.id },
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: orderRepository.id, methodId: saveOrder.id },
        // [*] <-- OrderService : Order
        { id: newId(), kind: STEP_KIND.CALL, callerId: orderService.id, calleeId: SYSTEM_CALLER_ID, methodId: placeOrder.id }
    ];

    renderParticipants();
    renderSequence();
}

document.getElementById('load-simple-demo-btn').addEventListener('click', loadSimpleDemo);
document.getElementById('load-complex-demo-btn').addEventListener('click', loadComplexDemo);
