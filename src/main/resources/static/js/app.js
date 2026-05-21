const state = {
    projectPath: null,
    // Server-built snapshot of the connected project: types[], packages[],
    // glossary[], conventions, fileCount, skippedCount. Used both to ground
    // the AI analyser and to populate Step 2's type autocomplete.
    codebaseCatalog: null,
    userStory: '',
    // Acceptance criteria as structured Gherkin rows. Each row is
    // { given, when, then }. Fed to /api/analyze as `acceptanceCriteria`
    // so generated participants/sequence satisfy each row.
    ac: [],
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
    // "manual mode" (Start empty). story is the prose narrative rendered
    // above the participant cards (tree is preserved as latent context, not
    // visualised). analyzeError is set when claude is missing or the call
    // fails — falls back to manual participant authoring.
    tree: null,
    story: '',
    analyzeError: null,
    analyzing: false,
    // Step 3 team-signoff gate — four hardcoded reviewers. All four must be
    // checked before the Generate button enables. In-memory only; resets on
    // page reload. Persists across step-back navigation in the same session.
    signoffs: { peter: false, john: false, chen: false, wang: false }
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
    projectPanel: document.getElementById('project-panel'),
    form: document.getElementById('scan-form'),
    pathInput: document.getElementById('path-input'),
    scanBtn: document.getElementById('scan-btn'),
    disconnectBtn: document.getElementById('disconnect-btn'),
    browseBtn: document.getElementById('browse-btn'),
    recentPaths: document.getElementById('recent-paths'),
    status: document.getElementById('scan-status'),
    statusText: document.getElementById('status-text'),
    error: document.getElementById('scan-error'),
    scanResult: document.getElementById('scan-result'),
    scanSummaryText: document.getElementById('scan-summary-text'),
    connectNext: document.getElementById('connect-next'),
    panels: document.querySelectorAll('.panel'),
    steps: document.querySelectorAll('.step')
};

// Step 1 (Connect) → Step 2 gate. Enabled only after a successful scan
// (state.codebaseCatalog is populated). Disconnecting re-disables.
function updateConnectGate() {
    if (!els.connectNext) return;
    els.connectNext.disabled = !(state.codebaseCatalog && Array.isArray(state.codebaseCatalog.types));
}

// --- Project connect panel (lives inside Step 1) ---

els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const path = els.pathInput.value.trim();
    if (!path) return;
    await runScan(path);
});

els.disconnectBtn.addEventListener('click', () => {
    state.projectPath = null;
    state.codebaseCatalog = null;
    els.pathInput.value = '';
    els.scanResult.classList.add('hidden');
    els.disconnectBtn.classList.add('hidden');
    populateTypesDatalist();
    updateConnectGate();
});

// Mirror the path input into state.projectPath so picker / chip / manual
// typing all count as "project connected" — Export downstream just needs
// a path, scan is an optional analysis pass on top.
els.pathInput.addEventListener('input', () => {
    state.projectPath = els.pathInput.value.trim() || null;
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
        state.codebaseCatalog = data;
        renderScanResult(data);
        populateTypesDatalist();
        addRecentPath(data.path);
        updateConnectGate();
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
    const types = data.types || [];
    const byKind = {};
    for (const t of types) byKind[t.kind] = (byKind[t.kind] || 0) + 1;
    const parts = [];
    if (byKind.class)     parts.push(`${byKind.class} class${byKind.class === 1 ? '' : 'es'}`);
    if (byKind.interface) parts.push(`${byKind.interface} interface${byKind.interface === 1 ? '' : 's'}`);
    if (byKind.record)    parts.push(`${byKind.record} record${byKind.record === 1 ? '' : 's'}`);
    if (byKind.enum)      parts.push(`${byKind.enum} enum${byKind.enum === 1 ? '' : 's'}`);
    const breakdown = parts.length ? ' · ' + parts.join(' · ') : '';
    els.scanSummaryText.textContent =
        `✓ ${name} · ${data.fileCount} files · ${types.length} types${breakdown}` +
        (data.skippedCount > 0 ? ` · ${data.skippedCount} skipped` : '');
    els.scanResult.classList.remove('hidden');
    els.disconnectBtn.classList.remove('hidden');
}

function shortProjectName(path) {
    if (!path) return 'project';
    const parts = path.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || path;
}

// --- Folder picker (OS-native, served via /api/fs/pick-folder) ---
//
// DisC Studio is a localhost dev tool, so we can shell out to the host's
// real folder dialog (Finder on macOS, zenity on Linux, FolderBrowserDialog
// on Windows). The Browse button POSTs to /api/fs/pick-folder; the call
// blocks while the OS dialog is open, returns { path } on selection or
// { canceled: true } on cancel.

const RECENT_PATHS_KEY = 'disc.recentProjectPaths';
const RECENT_PATHS_MAX = 5;

let folderPickerInFlight = false;

els.browseBtn.addEventListener('click', async () => {
    if (folderPickerInFlight) return;
    folderPickerInFlight = true;
    els.browseBtn.disabled = true;
    els.browseBtn.classList.add('is-busy');
    try {
        const seed = els.pathInput.value.trim() || null;
        const res = await fetch('/api/fs/pick-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seedPath: seed })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Picker failed (${res.status})`);
        if (data.canceled) return;
        if (data.path) {
            els.pathInput.value = data.path;
            // Keep state.projectPath + Continue gate in sync via the
            // existing input listener.
            els.pathInput.dispatchEvent(new Event('input'));
            els.pathInput.focus();
        }
    } catch (err) {
        els.error.textContent = err.message;
        els.error.classList.remove('hidden');
    } finally {
        folderPickerInFlight = false;
        els.browseBtn.disabled = false;
        els.browseBtn.classList.remove('is-busy');
    }
});

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function escapeAttr(s) {
    return escapeHtml(s);
}

// --- Recent project paths (localStorage, max 5) ---

function loadRecentPaths() {
    try {
        const raw = localStorage.getItem(RECENT_PATHS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

function saveRecentPaths(paths) {
    try {
        localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(paths));
    } catch {
        // localStorage unavailable — silently ignore
    }
}

function addRecentPath(path) {
    if (!path) return;
    const current = loadRecentPaths().filter(p => p !== path);
    current.unshift(path);
    const trimmed = current.slice(0, RECENT_PATHS_MAX);
    saveRecentPaths(trimmed);
    renderRecentPaths();
}

function renderRecentPaths() {
    const paths = loadRecentPaths();
    if (paths.length === 0) {
        els.recentPaths.classList.add('hidden');
        els.recentPaths.innerHTML = '';
        return;
    }
    const chips = paths.map(p =>
        `<button type="button" class="recent-chip" data-recent="${escapeAttr(p)}" title="${escapeAttr(p)}">${escapeHtml(p)}</button>`
    ).join('');
    els.recentPaths.innerHTML = `<span class="recent-label">Recent:</span>${chips}`;
    els.recentPaths.classList.remove('hidden');
    els.recentPaths.querySelectorAll('[data-recent]').forEach(btn => {
        btn.addEventListener('click', () => {
            els.pathInput.value = btn.dataset.recent;
            els.pathInput.dispatchEvent(new Event('input'));
            els.pathInput.focus();
        });
    });
}

renderRecentPaths();

// --- Navigation ---

document.addEventListener('click', (e) => {
    const back = e.target.closest('[data-back]');
    if (back) goToStep(parseInt(back.dataset.back, 10));
});

function goToStep(n) {
    // Sub-designs inherit the parent's project, so Step 1 (Connect) is
    // off-limits — redirect to Step 2 instead. subDesignContext is declared
    // later but goToStep is only invoked from user gestures / nested
    // handlers, so the binding is initialised by then.
    const inSub = !!subDesignContext;
    if (n === 1 && inSub) n = 2;
    els.panels.forEach(p => p.classList.toggle('hidden', p.id !== `panel-${n}`));
    els.steps.forEach(s => {
        const step = parseInt(s.dataset.step, 10);
        s.classList.toggle('active', step === n);
        s.classList.toggle('done', step < n);
        // Dim Step 1 in sub-design context (Connect is inherited from parent).
        s.classList.toggle('disabled', inSub && step === 1);
    });
    if (n === 2) enterStep2();
    if (n === 3) enterStep3();
    if (n === 4) enterStep4();
    // Anchor the viewport to the top of the new step. rAF runs after the
    // browser applies autofocus-triggered scrollIntoView, so this wins.
    requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
}

// --- Step 1: Connect → Design gate ---

if (els.connectNext) {
    els.connectNext.addEventListener('click', () => {
        if (els.connectNext.disabled) return;
        goToStep(2);
    });
}

// Initialise the Step 1 Continue gate on page load (defaults to disabled
// since no scan has happened yet).
updateConnectGate();

// Step 2 story input — wired further down where step2Els is defined.
const storyInput = document.getElementById('story-input');

// --- Step 2: participants & flow ---

const step2Els = {
    storyInput: storyInput,
    acSection: document.getElementById('ac-section'),
    acRows: document.getElementById('ac-rows'),
    acAdd: document.getElementById('ac-add'),
    acCount: document.getElementById('ac-count'),
    analyzeBtn: document.getElementById('analyze-btn'),
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
    modalKind: document.getElementById('modal-kind'),
    modalKindHelp: document.getElementById('modal-kind-help'),
    modalPurpose: document.getElementById('modal-purpose'),
    modalMethodsCount: document.getElementById('modal-methods-count'),
    participantsCount: document.getElementById('participants-count'),
    analyzeBanner: document.getElementById('analyze-banner'),
    analyzeBannerText: document.getElementById('analyze-banner-text'),
    analyzeBannerAction: document.getElementById('analyze-banner-action'),
    storyNarrativeSection: document.getElementById('story-narrative-section'),
    storyNarrative: document.getElementById('story-narrative')
};

// Step 2 story textarea: mirror to state.userStory and re-evaluate the
// analyze-gate (disabled until story is non-empty).
function updateAnalyzeGate() {
    if (!step2Els.analyzeBtn) return;
    step2Els.analyzeBtn.disabled = !(state.userStory && state.userStory.trim().length);
}

if (storyInput) {
    storyInput.addEventListener('input', () => {
        state.userStory = storyInput.value;
        updateAnalyzeGate();
    });
}

// --- Step 2 acceptance criteria (Gherkin rows) ---

function renderAcRows() {
    const container = step2Els.acRows;
    if (!container) return;
    container.innerHTML = '';
    state.ac.forEach((row, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'ac-row';
        wrap.innerHTML = `
            <div class="ac-field">
                <span class="ac-field-label">Given</span>
                <textarea data-ac-field="given" rows="2" placeholder="a precondition">${escapeHtml(row.given || '')}</textarea>
            </div>
            <div class="ac-field">
                <span class="ac-field-label">When</span>
                <textarea data-ac-field="when" rows="2" placeholder="an action">${escapeHtml(row.when || '')}</textarea>
            </div>
            <div class="ac-field">
                <span class="ac-field-label">Then</span>
                <textarea data-ac-field="then" rows="2" placeholder="the expected outcome">${escapeHtml(row.then || '')}</textarea>
            </div>
            <button type="button" class="ac-remove" data-ac-remove="${idx}" aria-label="Remove this row">×</button>
        `;
        wrap.querySelectorAll('textarea[data-ac-field]').forEach(ta => {
            ta.addEventListener('input', () => {
                const field = ta.dataset.acField;
                state.ac[idx][field] = ta.value;
            });
        });
        wrap.querySelector('[data-ac-remove]').addEventListener('click', () => {
            state.ac.splice(idx, 1);
            renderAcRows();
        });
        container.appendChild(wrap);
    });
    if (step2Els.acCount) {
        const n = state.ac.length;
        step2Els.acCount.textContent = `${n} row${n === 1 ? '' : 's'}`;
    }
}

if (step2Els.acAdd) {
    step2Els.acAdd.addEventListener('click', () => {
        state.ac.push({ given: '', when: '', then: '' });
        renderAcRows();
    });
}

// --- Step 2 Analyze button: explicit trigger (no auto-fire) ---

if (step2Els.analyzeBtn) {
    step2Els.analyzeBtn.addEventListener('click', () => {
        if (!state.userStory || !state.userStory.trim()) return;
        // Re-analyzing wipes downstream design so the next state is
        // produced fresh from the current story + AC. Sub-design context
        // is preserved.
        state.tree = null;
        state.story = '';
        state.participants = [];
        state.sequence = [];
        state.sutParticipantId = null;
        hideAnalyzeBanner();
        renderStoryNarrative();
        renderParticipants();
        renderSequence();
        runAnalyze(state.userStory);
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function populateTypesDatalist() {
    const items = ['void', 'boolean', 'int', 'long', 'double', 'String'];
    const catalog = state.codebaseCatalog;
    if (catalog && Array.isArray(catalog.types)) {
        for (const t of catalog.types) {
            // Skip controllers/configs/exceptions — not useful as participant
            // method types. Everything else (entities, value objects, DTOs,
            // services, repositories, enums) is fair game.
            if (t.role === 'controller' || t.role === 'config' || t.role === 'exception') continue;
            if (t.name) items.push(t.name);
        }
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
    const catalog = state.codebaseCatalog;
    let packages;
    if (catalog && Array.isArray(catalog.packages)) {
        packages = catalog.packages.map(p => p.name).filter(Boolean).sort();
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

function makeParticipant(name = '', implByDefault = true, purpose = '') {
    return {
        id: newId(),
        name,
        implByDefault,
        methods: [],
        purpose,
        existingFqn: null,
        signatureConflicts: [],
        // v0.7 multi-level support:
        //   'leaf'         — terminal, AI sees no further collaborators (default)
        //   'orchestrator' — has its own internal call graph; design later in a
        //                    sub-.puml via "Design this level". Emitted as
        //                    <<defer-design:...>> in the parent's PlantUML.
        //   'reuse'        — bound to an existing catalog type (existingFqn set).
        kind: 'leaf',
        // The AI's sub-tree for an orchestrator child, preserved so the drill-in
        // wizard can pre-populate the inner level instead of re-asking the AI.
        // Null for leaf and reuse participants.
        subDesignNode: null
    };
}

function makeMethod(name = '', inputs = [], output = '') {
    // `isProposed` distinguishes AI-suggested NEW methods on a reused type
    // (which become `+method` extensions in the .puml prelude) from methods
    // that already exist on the catalog type. Default false; the merge in
    // flattenTreeToParticipants flips it for proposed extensions only.
    return { id: newId(), name, inputs, output, isProposed: false };
}

// Walk a concept-tree (depth-first) and produce the participant array the
// rest of the wizard already consumes. The hierarchy is a design aid for the
// user; once flattened, parent/child relationships disappear — what survives
// is the set of named interfaces and their methods. Behaviors[].args become
// method inputs; behaviors[].returns becomes method output.
//
// When a node carries an `existingFqn`, the analyser is signalling reuse —
// the participant's purpose and methods are pulled from the real catalog
// entry (not the AI's invented signatures) so downstream sequencing uses
// methods that genuinely exist on the user's type.
function flattenTreeToParticipants(root) {
    if (!root || typeof root !== 'object') return [];
    const out = [];
    const catalog = state.codebaseCatalog;
    const byFqn = (catalog && Array.isArray(catalog.types))
        ? Object.fromEntries(catalog.types.map(t => [t.fqn, t]))
        : {};

    function visit(node) {
        if (!node || typeof node !== 'object') return;
        const name = (node.name || '').trim();
        if (name) {
            const existingFqn = (node.existingFqn || '').trim() || null;
            const catalogType = existingFqn ? byFqn[existingFqn] : null;

            let methods;
            let purpose;
            let implByDefault;

            let signatureConflicts = [];

            if (catalogType) {
                // Reuse path: catalog methods are the source of truth (real
                // signatures). AI-proposed methods that DON'T exist in the
                // catalog are kept as "extensions" — these become `+method`
                // entries in the .puml prelude so the plugin opens the
                // existing type in UPDATE mode.
                const catalogMethodNames = new Set((catalogType.publicMethods || []).map(m => m.name));

                methods = (catalogType.publicMethods || []).map(m => {
                    const inputs = (m.params || [])
                        .filter(p => p && (p.name || p.type))
                        .map(p => ({ name: p.name || '', type: p.type || '' }));
                    const real = makeMethod(m.name || '', inputs, m.returnType || '');
                    real.isProposed = false;
                    return real;
                });

                for (const b of (node.behaviors || [])) {
                    const bname = (b.name || '').trim();
                    if (!bname) continue;
                    const inputs = (b.args || [])
                        .filter(a => a && (a.name || a.type))
                        .map(a => ({ name: a.name || '', type: a.type || '' }));
                    if (!catalogMethodNames.has(bname)) {
                        // AI proposed a NEW method on a reused type — keep it as
                        // an extension. Maps to `<<@class:fqn, +bname>>` later.
                        const added = makeMethod(bname, inputs, b.returns || '');
                        added.isProposed = true;
                        methods.push(added);
                    } else {
                        // AI's behavior overlaps a real method — compare
                        // signatures and flag any mismatch. We keep the catalog
                        // version; the user can resolve in Step 4.
                        const real = methods.find(m => m.name === bname);
                        const aiSig = renderSignature(bname, inputs, b.returns || '');
                        const realSig = renderSignature(real.name, real.inputs, real.output);
                        if (aiSig !== realSig) {
                            signatureConflicts.push({
                                methodName: bname,
                                aiSignature: aiSig,
                                catalogSignature: realSig
                            });
                        }
                    }
                }

                purpose = (catalogType.purpose || node.purpose || '').trim();
                implByDefault = false;  // existing type — don't (re)generate its impl
            } else {
                // New-abstraction path: use the AI's behaviors verbatim.
                methods = (node.behaviors || []).map(b => {
                    const inputs = (b.args || [])
                        .filter(a => a && (a.name || a.type))
                        .map(a => ({ name: a.name || '', type: a.type || '' }));
                    const m = makeMethod(b.name || '', inputs, b.returns || '');
                    m.isProposed = false;  // every method on a new type is "real"
                    return m;
                });
                purpose = (node.purpose || '').trim();
                implByDefault = true;
            }

            // Classify kind for v0.7 multi-level support:
            //   reuse        — bound to an existing catalog type
            //   leaf         — terminal (AI marked isLeaf, or no children)
            //   orchestrator — non-leaf custom abstraction; its children are
            //                  held in subDesignNode for later drill-in
            const hasChildren = Array.isArray(node.children) && node.children.length > 0;
            let kind;
            if (existingFqn) kind = 'reuse';
            else if (node.isLeaf === true) kind = 'leaf';
            else if (hasChildren) kind = 'orchestrator';
            else kind = 'leaf';     // non-leaf with empty children — treat as leaf

            out.push({
                id: newId(),
                name,
                implByDefault,
                methods,
                purpose,
                existingFqn,
                signatureConflicts,
                kind,
                // Preserve the AI's sub-tree only for orchestrators; everything else
                // discards it. Children we WALK into get their own top-level
                // participants in this run (existing v0.6 behaviour) — capturing
                // the raw node here is for the future "Design this level" flow.
                subDesignNode: kind === 'orchestrator' ? node : null
            });
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

// Compact normal form used for comparing AI-proposed signatures against the
// real catalog signature when both reference the same method name on a
// reused type. Equality of these strings is the conflict check.
function renderSignature(name, inputs, output) {
    const types = (inputs || []).map(i => (i.type || '').trim()).filter(Boolean).join(', ');
    const ret = (output || '').trim() || 'void';
    return `${(name || '').trim()}(${types}) -> ${ret}`;
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
    if (step2Els.storyInput && step2Els.storyInput.value !== (state.userStory || '')) {
        step2Els.storyInput.value = state.userStory || '';
    }
    renderAcRows();
    updateAnalyzeGate();
    populateTypesDatalist();
    renderStoryNarrative();
    renderParticipants();
    renderSequence();
}

async function runAnalyze(context) {
    state.analyzing = true;
    state.analyzeError = null;
    showAnalyzeBanner('Analysing your story…', { spinning: true });
    try {
        // Drop empty AC rows so the prompt only includes meaningful criteria.
        const ac = (state.ac || []).filter(r =>
            (r.given || '').trim() || (r.when || '').trim() || (r.then || '').trim());
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context, catalog: state.codebaseCatalog, acceptanceCriteria: ac })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Analyze failed (${res.status})`);
        // New analyser contract: {tree, story}. Tolerate the older shape
        // (root tree object directly) so a stale-prompt response still works.
        const tree  = (data && data.tree)  || (data && data.name ? data : null);
        const story = (data && data.story) || '';
        state.tree = tree;
        state.story = story;
        state.participants = flattenTreeToParticipants(tree);
        renderStoryNarrative();
        renderParticipants();
        renderSequence();

        // Chain straight into sequence composition. Two-phase LLM flow:
        // analyse → participants land → compose → sequence + live diagram.
        // The banner stays visible across both phases for a single
        // continuous progress indicator.
        if (state.participants.length > 0) {
            await runSequence();
            // Auto-mark the use-case orchestrator (root of the concept
            // tree = first flattened participant) as the SUT. Domain-
            // correct default — the use case IS the system being
            // designed. User can unmark via the SUT chip.
            setSut(state.participants[0].id);
        } else {
            hideAnalyzeBanner();
        }
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

// --- AI sequence composition (auto-fires after analyse) ---
//
// Given the story and the just-landed participant set, asks the model to
// produce a recursive sequence of calls + fragments via POST /api/sequence,
// then walks the response and writes into state.sequence using the same
// shape the manual composer produces. The wizard sees no difference between
// AI-generated and hand-authored steps once resolved.
//
// Called automatically at the end of runAnalyze — no user gesture. The
// existing analyze-banner is reused for the busy/error state across both
// phases (one continuous progress indicator).

// Walk the AI's recursive {steps} response and produce state.sequence
// entries. Caller/callee names resolve to participant IDs; methods
// resolve by name on the named callee, and if missing are AUTO-CREATED
// on that participant using the AI's args/returns (or empty/void).
// Unknown participants → step dropped + warning surfaced.
function resolveSequence(aiResponse) {
    const seq = [];
    const warnings = [];

    function findParticipantByName(name) {
        if (!name) return null;
        return state.participants.find(p => p.name === name) || null;
    }

    function findOrCreateMethod(callee, methodName, args, returns) {
        if (!methodName) return null;
        let m = callee.methods.find(mm => mm.name === methodName);
        if (m) return m;
        const inputs = (args || [])
            .filter(a => a && (a.name || a.type))
            .map(a => ({ name: a.name || '', type: a.type || '' }));
        m = makeMethod(methodName, inputs, returns || '');
        callee.methods.push(m);
        return m;
    }

    function visit(steps) {
        if (!Array.isArray(steps)) return;
        for (const s of steps) {
            if (!s || typeof s !== 'object') continue;

            // Fragment kinds map 1:1 to FRAG_TYPES keys.
            const fragKind = s.kind;
            if (fragKind === 'loop' || fragKind === 'while' || fragKind === 'foreach' ||
                fragKind === 'opt') {
                seq.push({ id: newId(), kind: STEP_KIND.FRAG_START, fragType: fragKind, label: s.label || '' });
                visit(s.steps || []);
                seq.push({ id: newId(), kind: STEP_KIND.FRAG_END });
                continue;
            }
            if (fragKind === 'alt' || fragKind === 'par') {
                seq.push({ id: newId(), kind: STEP_KIND.FRAG_START, fragType: fragKind, label: s.label || '' });
                visit(s.steps || []);
                if (Array.isArray(s.elseSteps) && s.elseSteps.length > 0) {
                    seq.push({ id: newId(), kind: STEP_KIND.FRAG_ELSE, label: '' });
                    visit(s.elseSteps);
                }
                seq.push({ id: newId(), kind: STEP_KIND.FRAG_END });
                continue;
            }

            // CALL step
            const caller = findParticipantByName(s.caller);
            if (!caller) {
                warnings.push(`Dropped call from unknown participant "${s.caller}"`);
                continue;
            }
            const callee = findParticipantByName(s.callee);
            if (!callee) {
                warnings.push(`Dropped call to unknown participant "${s.callee}"`);
                continue;
            }
            const method = findOrCreateMethod(callee, s.method, s.args, s.returns);
            if (!method) {
                warnings.push(`Dropped call to ${callee.name}: no method name given`);
                continue;
            }
            seq.push({
                id: newId(),
                kind: STEP_KIND.CALL,
                callerId: caller.id,
                calleeId: callee.id,
                methodId: method.id
            });
        }
    }

    visit(aiResponse && aiResponse.steps);
    return { sequence: seq, warnings };
}

// Splice the AI-resolved body between the existing SUT boundary rows
// when an SUT is set. Otherwise replace state.sequence entirely.
function applyResolvedSequence(resolved) {
    if (!state.sutParticipantId) {
        state.sequence = resolved;
        return;
    }
    // Keep entry row (first system_caller row from [*] -> SUT) and return
    // row (last [*] <-- SUT row), drop everything else, then splice the
    // AI body in between.
    const entry  = state.sequence.find(s => s.kind === STEP_KIND.CALL && isSystemCaller(s.callerId));
    const ret    = state.sequence.find(s => s.kind === STEP_KIND.CALL && isSystemCaller(s.calleeId));
    state.sequence = [];
    if (entry) state.sequence.push(entry);
    state.sequence.push(...resolved);
    if (ret) state.sequence.push(ret);
}

async function runSequence() {
    if (!state.userStory || state.participants.length === 0) {
        hideAnalyzeBanner();
        return;
    }
    showAnalyzeBanner('Composing the sequence…', { spinning: true });
    try {
        const sutName = state.sutParticipantId
            ? (findParticipant(state.sutParticipantId)?.name || '')
            : '';
        const payload = {
            story: state.userStory,
            sut: sutName,
            participants: state.participants.map(p => ({
                name: p.name,
                methods: (p.methods || []).map(m => ({
                    name: m.name,
                    args: m.inputs || [],
                    returns: m.output || ''
                }))
            }))
        };
        const res = await fetch('/api/sequence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Sequence composition failed (${res.status})`);

        const { sequence: resolved, warnings } = resolveSequence(data);
        if (resolved.length === 0) {
            showAnalyzeBanner(
                'AI returned no resolvable calls. Edit the story or add participants manually.',
                { spinning: false, error: true, dismissable: true }
            );
            return;
        }
        applyResolvedSequence(resolved);
        renderSequence();

        if (warnings.length > 0) {
            showAnalyzeBanner(warnings.join(' · '), { spinning: false, error: true, dismissable: true });
        } else {
            hideAnalyzeBanner();
        }
    } catch (err) {
        showAnalyzeBanner(
            "Couldn't compose the sequence: " + err.message + '. Add steps manually if needed.',
            { spinning: false, error: true, dismissable: true }
        );
    }
}

// --- Story narrative (replaces the concept-tree visualisation) ---
//
// The analyser returns {tree, story}. We keep state.tree as latent context
// for future features (expand-further, sequence suggestion), but render
// only the story prose here — coloured per participant so the user can
// follow the link from "name in the paragraph" to "card below".

// Fixed palette, cycled by participant index. All six pass WCAG AA on
// white. The hex values match the participant card's left-border
// (--participant-color CSS var on .pc-card). If we ever need more than 6,
// the cycle is graceful — just visually repeats.
const PARTICIPANT_PALETTE = [
    '#4338ca', // 0 indigo  — orchestrator / root
    '#047857', // 1 emerald — repository / data
    '#b45309', // 2 amber   — service / gateway
    '#9f1239', // 3 rose    — validator / parser
    '#0e7490', // 4 cyan    — notifier / dispatcher
    '#6d28d9'  // 5 violet  — misc
];

function participantColor(name) {
    if (!name) return null;
    const idx = state.participants.findIndex(p => p.name === name);
    if (idx < 0) return null;
    return PARTICIPANT_PALETTE[idx % PARTICIPANT_PALETTE.length];
}

function renderStoryNarrative() {
    const section = step2Els.storyNarrativeSection;
    const target = step2Els.storyNarrative;
    if (!section || !target) return;
    if (!state.story) {
        section.classList.add('hidden');
        target.innerHTML = '';
        return;
    }
    section.classList.remove('hidden');
    target.innerHTML = '';

    // Tokenise on [...] bracket pairs. Anything between brackets becomes a
    // coloured participant reference; anything outside is plain prose. The
    // regex is non-greedy and tolerant of brackets with names that aren't
    // in state.participants (renders as muted text, not coloured).
    const tokens = state.story.split(/(\[[^\]]+\])/g);
    for (const t of tokens) {
        if (!t) continue;
        const match = t.match(/^\[([^\]]+)\]$/);
        if (match) {
            const name = match[1].trim();
            const color = participantColor(name);
            const span = document.createElement('span');
            if (color) {
                span.className = 'participant-ref';
                span.style.setProperty('--participant-color', color);
            } else {
                span.className = 'participant-ref unknown';
            }
            span.textContent = name;
            target.appendChild(span);
        } else {
            target.appendChild(document.createTextNode(t));
        }
    }
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
// Idempotent SUT setter. Sets sutParticipantId to the given id, manages
// the boundary system-caller entry/return steps, and re-renders. No-op if
// the requested id is already the SUT.
function setSut(participantId) {
    if (state.sutParticipantId === participantId) return;
    const p = findParticipant(participantId);
    if (!p) return;
    removeSystemCallerSteps();
    state.sutParticipantId = participantId;
    if ((p.methods || []).length === 1) {
        addSystemCallerStepsFor(participantId, p.methods[0].id);
    }
    // else: banner in renderSteps prompts the user to pick a method.
    renderParticipants();
    renderSequence();
}

function toggleSut(participantId) {
    if (state.sutParticipantId === participantId) {
        state.sutParticipantId = null;
        removeSystemCallerSteps();
        renderParticipants();
        renderSequence();
    } else {
        setSut(participantId);
    }
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
        if (p.existingFqn) card.classList.add('is-reused');
        card.dataset.id = p.id;
        // Cycle through the participant palette so the card's left edge
        // matches the colour of the same name in the story narrative.
        card.style.setProperty('--participant-color', PARTICIPANT_PALETTE[idx % PARTICIPANT_PALETTE.length]);

        const previewMethods = p.methods.slice(0, 3).map(m => {
            const sig = escapeHtml(methodPreviewSignature(m));
            // AI-proposed NEW method on a reused type → render a small
            // "+ new" chip so the user can see the design extends the
            // existing abstraction.
            const proposedTag = m.isProposed
                ? ' <span class="method-proposed-chip" title="New method — would be added to the existing type">+ new</span>'
                : '';
            return sig + proposedTag;
        }).join('<br>');
        const moreCount = p.methods.length - 3;

        const isSut = state.sutParticipantId === p.id;
        // Chip is a <span role=button> to avoid nesting a real <button> inside
        // the card <button> (invalid HTML and triggers DevTools warnings).
        const sutChip = isSut
            ? `<span class="sut-chip sut-chip-on" role="button" tabindex="0" title="System under test — click to unmark">SUT</span>`
            : `<span class="sut-chip sut-chip-add" role="button" tabindex="0" title="Mark as system under test">+ SUT</span>`;

        // When the analyser pinned this participant to an existing type in
        // the user's codebase, surface the FQN so the user can spot reuse
        // at a glance. Title carries the full FQN for hover-preview when
        // the chip ellipsifies.
        const fqnChip = p.existingFqn
            ? `<div class="pc-fqn-chip" title="${escapeHtml(p.existingFqn)}">${escapeHtml(p.existingFqn)}</div>`
            : '';

        // Kind chip — every participant carries one so kind is always
        // explicit rather than inferred from the absence of decoration.
        // Three colors map 1:1 to the three values of state.participants[].kind.
        let kindChip = '';
        if (p.kind === 'orchestrator') {
            kindChip = `<span class="pc-kind-chip kind-orchestrator" title="Non-leaf — will emit <<defer-design>>; design its internals in a sub-.puml">orchestrator</span>`;
            card.classList.add('is-orchestrator');
        } else if (p.kind === 'reuse') {
            kindChip = `<span class="pc-kind-chip kind-reuse" title="Bound to an existing class">reuse</span>`;
        } else if (p.kind === 'leaf') {
            kindChip = `<span class="pc-kind-chip kind-leaf" title="Terminal — pure function, stereotype boundary, or single platform method">leaf</span>`;
        }

        // One-sentence purpose, surfaced from the analyzer (or user-typed
        // via the modal). Empty-state placeholder doubles as a discovery
        // hint that purpose is editable.
        const purposeText = (p.purpose || '').trim();
        const purposeRow = purposeText
            ? `<div class="pc-card-purpose" title="${escapeAttr(purposeText)}">${escapeHtml(purposeText)}</div>`
            : `<div class="pc-card-purpose is-empty">Click to describe what this does</div>`;

        card.innerHTML = `
            <div class="pc-card-head">
                <span class="pc-card-name">${escapeHtml(p.name || '(unnamed)')}</span>
                ${kindChip}
                ${sutChip}
            </div>
            ${fqnChip}
            ${purposeRow}
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
    if (step2Els.modalKind) {
        step2Els.modalKind.value = p.kind || 'leaf';
        updateKindHelp(p);
    }
    if (step2Els.modalPurpose) {
        step2Els.modalPurpose.value = p.purpose || '';
    }
    renderModalMethods();
    step2Els.modal.classList.remove('hidden');
    setTimeout(() => step2Els.modalName.focus(), 0);
}

function updateKindHelp(p) {
    if (!step2Els.modalKindHelp) return;
    const kind = (p && p.kind) || step2Els.modalKind.value;
    let msg;
    switch (kind) {
        case 'orchestrator':
            msg = 'Emits <<defer-design>> in the .puml prelude. The plugin will generate the interface and a throwing stub-impl. Click "Design this level" in Step 4 to drill in and design the sub-.puml.';
            break;
        case 'reuse':
            msg = 'Bound to an existing class via existingFqn. The plugin won\'t generate files for this participant; it\'s mocked at the SUT\'s test.';
            break;
        case 'leaf':
        default:
            msg = 'Terminal: pure function, stereotype boundary, or single platform method. The plugin generates interface + impl + tests at this level.';
            break;
    }
    step2Els.modalKindHelp.textContent = msg;
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

if (step2Els.modalPurpose) {
    step2Els.modalPurpose.addEventListener('input', (e) => {
        const p = findParticipant(modalParticipantId);
        if (p) p.purpose = e.target.value;
    });
}

if (step2Els.modalKind) {
    step2Els.modalKind.addEventListener('change', (e) => {
        const p = findParticipant(modalParticipantId);
        if (!p) return;
        const newKind = e.target.value;
        // Switching to 'reuse' without an existingFqn is invalid — warn but
        // accept (user may set the FQN below). Switching away from 'reuse'
        // clears the FQN since it no longer applies.
        if (p.kind === 'reuse' && newKind !== 'reuse') {
            p.existingFqn = null;
        }
        // Switching to 'orchestrator' clears implByDefault — the plugin emits
        // a Pending<Name> stub, not a real impl, at this level.
        if (newKind === 'orchestrator') {
            p.implByDefault = false;
            if (step2Els.modalImpl) step2Els.modalImpl.checked = false;
        } else if (newKind === 'leaf' && !p.existingFqn) {
            p.implByDefault = true;
            if (step2Els.modalImpl) step2Els.modalImpl.checked = true;
        }
        p.kind = newKind;
        updateKindHelp(p);
    });
}

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
            const methodCall = `${method.name || '?'}(${inputArgs})`;
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
        const methodCall = `${method.name || '?'}(${inputArgs})`;
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

    // Participant prelude: declare every participant that appears in the
    // sequence, decorated with its `participant_target` stereotype. The plugin
    // reads this in its Step 2.6.5 to drive CREATE / REUSE / UPDATE in Step 3f.
    // Plugins older than v0.6.0 ignore the stereotypes and fall back to glob-
    // based file-mode detection — the prelude is backward-compatible.
    const referenced = new Set();
    for (const s of state.sequence) {
        if (s.kind !== STEP_KIND.CALL) continue;
        if (s.callerId && !isSystemCaller(s.callerId)) referenced.add(s.callerId);
        if (s.calleeId && !isSystemCaller(s.calleeId)) referenced.add(s.calleeId);
    }
    const preludeLines = [];
    // Filename stem (without .puml) of the design currently being emitted.
    // Used to build the default defer-design path for orchestrator children
    // when the user hasn't authored one explicitly. Read from the Step-4
    // filename input when it has been populated; fall back to defaultFileName().
    const rawName = (saveEls && saveEls.filename && saveEls.filename.value && saveEls.filename.value.trim())
        || defaultFileName();
    const pumlStem = rawName.replace(/\.puml$/i, '');
    for (const p of state.participants) {
        if (!referenced.has(p.id)) continue;
        const name = (p.name || '').trim();
        if (!name) continue;
        const fqn = (p.existingFqn || '').trim();
        const newMethods = (p.methods || []).filter(m => m.isProposed).map(m => '+' + m.name);
        let stereotype = '';
        if (p.kind === 'orchestrator' && !fqn) {
            // Non-leaf custom abstraction — defer to its own .puml. The path is
            // sibling-folder convention: <parent-stem>/<ChildName>.puml relative
            // to the parent's folder. The plugin reads this as defer:<path>.
            const subPath = `${pumlStem}/${name}.puml`;
            stereotype = ` <<defer-design:${subPath}>>`;
        } else if (fqn && newMethods.length > 0) {
            stereotype = ` <<@class:${fqn}, ${newMethods.join(', ')}>>`;
        } else if (fqn) {
            stereotype = ` <<@class:${fqn}>>`;
        }
        preludeLines.push(`participant ${name}${stereotype}`);
    }
    if (preludeLines.length > 0) {
        lines.push("' @disc-classification CREATE (no stereotype), REUSE (@class), UPDATE (@class + +methods), DEFER (defer-design)");
        for (const line of preludeLines) lines.push(line);
        lines.push('');  // blank line before the sequence interactions
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

    // padX must clear the half-width of the first and last head boxes so
    // they don't poke past the SVG viewBox edges. Kept symmetric — the
    // fragment-bracket math below assumes the same pad at both ends.
    const EDGE_GAP = 16;
    const firstBoxHalf = headBoxWidth[lifelines[0]] / 2;
    const lastBoxHalf  = headBoxWidth[lifelines[lifelines.length - 1]] / 2;
    const padX = Math.max(60, Math.ceil(firstBoxHalf + EDGE_GAP), Math.ceil(lastBoxHalf + EDGE_GAP));
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
    acBlock: document.getElementById('review-ac-block'),
    acList: document.getElementById('review-ac'),
    summary: document.getElementById('review-summary'),
    sequence: document.getElementById('review-sequence')
};

// --- Step 3 team-signoff gate ---

function syncSignoffUI() {
    const inputs = Array.from(document.querySelectorAll('#review-signoff input[data-signoff]'));
    let signed = 0;
    for (const input of inputs) {
        const key = input.dataset.signoff;
        input.checked = !!state.signoffs[key];
        if (input.checked) signed++;
    }
    const total = inputs.length;
    const all = signed === total && total > 0;

    const status = document.getElementById('signoff-status');
    if (status) {
        status.textContent = all
            ? `All ${total} signoffs received — ready to generate.`
            : `${signed} of ${total} signed off`;
        status.classList.toggle('complete', all);
    }
    const nextBtn = document.getElementById('preview-next');
    if (nextBtn) nextBtn.disabled = !all;
}

function allSignedOff() {
    return ['peter', 'john', 'chen', 'wang'].every(k => !!state.signoffs[k]);
}

(() => {
    const signoffGroup = document.getElementById('review-signoff');
    if (!signoffGroup) return;
    signoffGroup.addEventListener('change', (e) => {
        const key = e.target?.dataset?.signoff;
        if (!key) return;
        state.signoffs[key] = !!e.target.checked;
        syncSignoffUI();
    });
})();

function enterStep3() {
    reviewEls.story.textContent = state.userStory || '(no story given)';
    if (!state.userStory) reviewEls.story.classList.add('muted');
    else reviewEls.story.classList.remove('muted');

    // Acceptance criteria — render filled rows only; hide whole block if
    // none. Each row reads as a single "Given …, when …, then …" sentence.
    if (reviewEls.acBlock && reviewEls.acList) {
        const filled = (state.ac || []).filter(r =>
            (r.given || '').trim() || (r.when || '').trim() || (r.then || '').trim());
        if (filled.length === 0) {
            reviewEls.acBlock.classList.add('hidden');
            reviewEls.acList.innerHTML = '';
        } else {
            reviewEls.acBlock.classList.remove('hidden');
            reviewEls.acList.innerHTML = filled.map(r => `
                <li>
                    <span class="ac-given"><span class="ac-key">Given</span>${escapeHtml((r.given || '').trim() || '—')}</span>,
                    <span class="ac-when"><span class="ac-key">when</span>${escapeHtml((r.when || '').trim() || '—')}</span>,
                    <span class="ac-then"><span class="ac-key">then</span>${escapeHtml((r.then || '').trim() || '—')}</span>.
                </li>
            `).join('');
        }
    }

    const pCount = state.participants.length;
    const sCount = state.sequence.length;
    const usedIds = new Set();
    state.sequence.forEach(c => { usedIds.add(c.callerId); usedIds.add(c.calleeId); });
    const usedParticipants = state.participants.filter(p => usedIds.has(p.id));
    const unused = state.participants.filter(p => !usedIds.has(p.id));

    const partLines = usedParticipants.map(p => {
        const purpose = (p.purpose || '').trim();
        const fallback = p.methods.map(m => m.name || '?').join(', ') || '(no methods)';
        const desc = purpose || fallback;
        const fqn = p.existingFqn
            ? ` <span class="review-fqn">(${escapeHtml(p.existingFqn)})</span>`
            : '';
        return `<li><strong>${escapeHtml(p.name || '(unnamed)')}</strong> <span class="muted">— ${escapeHtml(desc)}</span>${fqn}</li>`;
    }).join('');
    const unusedLine = unused.length > 0
        ? `<div class="review-warn">${unused.length} unused participant${unused.length === 1 ? '' : 's'}: ${unused.map(p => escapeHtml(p.name || '(unnamed)')).join(', ')}</div>`
        : '';

    // The per-participant lines now duplicate what each Step 2 card already
    // surfaces, so collapse them behind a <details>. Counts and any unused-
    // participant warning stay visible up-front for the sign-off ritual.
    reviewEls.summary.innerHTML = `
        <div class="review-counts">${pCount} participant${pCount === 1 ? '' : 's'} · ${sCount} step${sCount === 1 ? '' : 's'}</div>
        ${unusedLine}
        <details class="review-participants-details">
            <summary>Show participant list</summary>
            <ul class="review-participants">${partLines || '<li class="muted">no participants</li>'}</ul>
        </details>
    `;

    renderSequenceDiagram(state.sequence, reviewEls.sequence);
    syncSignoffUI();
}

document.getElementById('preview-next').addEventListener('click', () => {
    if (!allSignedOff()) return;
    goToStep(4);
});

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
    renderPlanPanel();          // per-participant CREATE/REUSE/UPDATE table
    outputEl.textContent = emitPlantUml();
    if (!saveEls.filename.value.trim()) {
        saveEls.filename.value = defaultFileName();
    }
    saveEls.result.classList.add('hidden');
    saveEls.error.classList.add('hidden');
    // Hide any stale plugin-plan preview from a previous visit.
    const pr = document.getElementById('preview-result');
    if (pr) pr.classList.add('hidden');
    // Plugin status drives whether the Run button is enabled. Always refresh
    // on enter — the user might have installed the plugin in a separate
    // terminal between visits.
    refreshPluginStatus();
}

// --- Step 4 plan panel + plugin preview ---

// Per-participant action picker. Reads each participant's existingFqn + any
// isProposed methods to infer a default action (CREATE / REUSE / UPDATE),
// renders a row per used participant with a dropdown, and lets the user
// override the action. Changes mutate the participant and re-emit the .puml.
function renderPlanPanel() {
    const host = document.getElementById('plan-panel');
    const conflictsHost = document.getElementById('plan-conflicts');
    if (!host) return;

    // Only show participants referenced by the sequence — others won't be
    // emitted in the .puml prelude anyway.
    const referenced = new Set();
    for (const s of state.sequence) {
        if (s.kind !== STEP_KIND.CALL) continue;
        if (s.callerId && !isSystemCaller(s.callerId)) referenced.add(s.callerId);
        if (s.calleeId && !isSystemCaller(s.calleeId)) referenced.add(s.calleeId);
    }
    const used = state.participants.filter(p => referenced.has(p.id));

    if (used.length === 0) {
        host.innerHTML = '<div class="plan-row"><span class="plan-participant" style="grid-column: 1 / -1; color: var(--text-3); font-style: italic;">No participants in the sequence yet.</span></div>';
        if (conflictsHost) conflictsHost.classList.add('hidden');
        return;
    }

    host.innerHTML = used.map(p => {
        const action = inferAction(p);
        const target = describeTarget(p, action);
        const safeName = escapeAttr(p.name || '');
        return `<div class="plan-row action-${action.toLowerCase()}" data-participant-id="${escapeAttr(p.id)}" data-name="${safeName}">
            <span class="plan-participant"><span class="build-status-dot" data-build-status-for="${safeName}" title="Build state — pending"></span>${escapeHtml(p.name || '(unnamed)')}</span>
            <span class="plan-action">
                <select data-plan-action data-participant-id="${escapeAttr(p.id)}">
                    <option value="CREATE" ${action === 'CREATE' ? 'selected' : ''}>CREATE — new</option>
                    <option value="REUSE"  ${action === 'REUSE'  ? 'selected' : ''}>REUSE — existing</option>
                    <option value="UPDATE" ${action === 'UPDATE' ? 'selected' : ''}>UPDATE — add methods</option>
                    <option value="SKIP"   ${action === 'SKIP'   ? 'selected' : ''}>SKIP — leave alone</option>
                </select>
            </span>
            <span class="plan-target" title="${escapeAttr(target)}">${escapeHtml(target)}</span>
        </div>`;
    }).join('');

    host.querySelectorAll('select[data-plan-action]').forEach(sel => {
        sel.addEventListener('change', (e) => {
            const id = e.target.dataset.participantId;
            const action = e.target.value;
            applyPlanAction(id, action);
        });
    });

    renderPlanConflicts(used);

    // Async per-participant build-state fetch. Non-blocking; dots stay
    // at the neutral pre-fetch state if the request fails. Skip entirely
    // when the project isn't connected (typical in demo / fresh state).
    if (state.projectPath) {
        const names = used.map(p => (p.name || '').trim()).filter(Boolean);
        if (names.length > 0) fetchAndRenderBuildStatus(host, names);
    }
}

// One-shot fetch of build-status for the participants currently in the
// plan-panel. Updates each `.build-status-dot` in place. Defensive on
// every failure path — a 5xx or a fetch error leaves the dots at their
// neutral pre-fetch appearance.
async function fetchAndRenderBuildStatus(host, names) {
    try {
        const res = await fetch('/api/build-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: state.projectPath, participantNames: names })
        });
        if (!res.ok) return;
        const data = await res.json();
        const map = (data && data.statusByName) || {};
        for (const dot of host.querySelectorAll('.build-status-dot')) {
            const name = dot.getAttribute('data-build-status-for');
            const status = map[name] || 'pending';
            // Clear any prior status class before applying the new one so
            // repeat renders (e.g. after action toggles) don't accumulate.
            dot.classList.remove('status-real', 'status-stubbed', 'status-pending');
            dot.classList.add(`status-${status}`);
            dot.title = `Build state — ${status}`;
        }
    } catch (e) {
        // Silent — the panel remains usable, dots just stay neutral.
        console.warn('build-status fetch failed (non-fatal):', e);
    }
}

// Default action for a participant, derived from its current state:
//   existingFqn null                       → CREATE
//   existingFqn set, no isProposed methods → REUSE
//   existingFqn set, has isProposed        → UPDATE
function inferAction(p) {
    if (!p.existingFqn) return 'CREATE';
    const hasProposed = (p.methods || []).some(m => m.isProposed);
    return hasProposed ? 'UPDATE' : 'REUSE';
}

function describeTarget(p, action) {
    if (action === 'CREATE') {
        const pkg = (state.targetPackage || '').trim() || '(no @package)';
        return `${pkg}.${p.name}`;
    }
    if (action === 'SKIP') {
        return '(skipped — DisC will not touch this)';
    }
    const fqn = (p.existingFqn || '').trim() || '(no fqn set)';
    if (action === 'UPDATE') {
        const adds = (p.methods || []).filter(m => m.isProposed).map(m => '+' + m.name);
        if (adds.length > 0) return `${fqn}   ${adds.join(', ')}`;
        return fqn;
    }
    return fqn;
}

// Applying an action mutates the participant in place and re-emits the .puml.
// We honour user intent over the catalog: switching CREATE → REUSE blanks
// existingFqn; switching REUSE → CREATE clears it. UPDATE only differs from
// REUSE by carrying isProposed methods.
function applyPlanAction(participantId, action) {
    const p = findParticipant(participantId);
    if (!p) return;

    if (action === 'CREATE') {
        p.existingFqn = null;
        // Drop any isProposed flag — proposed-on-reuse no longer applies.
        for (const m of (p.methods || [])) m.isProposed = false;
        p.skipped = false;
    } else if (action === 'REUSE') {
        // Keep existingFqn if already set; if not, the user picked REUSE
        // without a target — they need to supply one. We don't have UI for
        // that yet, so the row will show "(no fqn set)" and the plugin
        // would refuse. Acceptable v1.
        for (const m of (p.methods || [])) m.isProposed = false;
        p.skipped = false;
    } else if (action === 'UPDATE') {
        // Mark every method that the catalog DID NOT carry as isProposed.
        // For now, if the user manually picks UPDATE on a fresh participant,
        // we have no way to know which methods are "new" — they'd all be
        // proposed. Acceptable v1.
        for (const m of (p.methods || [])) m.isProposed = true;
        p.skipped = false;
    } else if (action === 'SKIP') {
        p.skipped = true;
    }

    renderPlanPanel();
    outputEl.textContent = emitPlantUml();
}

function renderPlanConflicts(participants) {
    const host = document.getElementById('plan-conflicts');
    if (!host) return;
    const items = [];
    for (const p of participants) {
        for (const c of (p.signatureConflicts || [])) {
            items.push({ participant: p, conflict: c });
        }
    }
    if (items.length === 0) {
        host.classList.add('hidden');
        host.innerHTML = '';
        return;
    }
    host.classList.remove('hidden');
    host.innerHTML = `<strong>⚠ ${items.length} signature conflict${items.length === 1 ? '' : 's'}</strong>
        ${items.map(({ participant, conflict }) => `
            <span class="plan-conflict-line">
                ${escapeHtml(participant.name)}.${escapeHtml(conflict.methodName)} —
                design: <code>${escapeHtml(conflict.aiSignature)}</code>;
                catalog: <code>${escapeHtml(conflict.catalogSignature)}</code>
            </span>
        `).join('')}
        <div class="plan-conflict-actions">
            <button type="button" data-resolve-conflicts="catalog">Use catalog signatures</button>
        </div>`;
    const resolveBtn = host.querySelector('[data-resolve-conflicts]');
    if (resolveBtn) {
        resolveBtn.addEventListener('click', () => {
            // Clearing the conflicts list is sufficient — methods[] already
            // holds the catalog signatures (the merge logic chose them as
            // the authoritative form). This button just acknowledges.
            for (const p of state.participants) {
                p.signatureConflicts = [];
            }
            renderPlanPanel();
            outputEl.textContent = emitPlantUml();
        });
    }
}

// "Preview changes" — writes the .puml to disk first (same path the user
// would Export to), then calls /api/plan-disc to ask the plugin what it
// would do without mutating anything. Renders the response in the
// preview-result panel.
async function previewPlan() {
    const previewBtn = document.getElementById('preview-plan');
    const previewResult = document.getElementById('preview-result');
    saveEls.error.classList.add('hidden');

    const projectPath = state.projectPath || (els.pathInput.value || '').trim();
    if (!projectPath) {
        saveEls.error.textContent = 'No project path — go back to Step 1 and pick a folder (or paste a path).';
        saveEls.error.classList.remove('hidden');
        return;
    }

    const content = outputEl.textContent;
    if (!content || !content.trim()) {
        saveEls.error.textContent = 'Nothing to preview — add some steps in Step 2.';
        saveEls.error.classList.remove('hidden');
        return;
    }

    const fileName = saveEls.filename.value.trim() || defaultFileName();
    if (previewBtn) {
        previewBtn.disabled = true;
        previewBtn.textContent = 'Previewing…';
    }
    if (previewResult) previewResult.classList.add('hidden');

    try {
        // Step 1: write the .puml + decision tables. Plan needs the file on disk.
        const decisionTables = collectDecisionTablesForSave();
        const saveRes = await fetch('/api/design', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath, fileName, content, decisionTables })
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) throw new Error(saveData.error || `Write failed (${saveRes.status})`);

        // Step 2: ask the plugin for the plan.
        const modelSelect = document.getElementById('run-model');
        const model = modelSelect ? modelSelect.value : null;
        const planRes = await fetch('/api/plan-disc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath, filePath: saveData.relativePath, model })
        });
        const plan = await planRes.json();
        if (!planRes.ok) throw new Error(plan.error || `Plan failed (${planRes.status})`);

        renderPluginPlan(plan);
    } catch (err) {
        saveEls.error.textContent = err.message;
        saveEls.error.classList.remove('hidden');
    } finally {
        if (previewBtn) {
            previewBtn.disabled = false;
            previewBtn.textContent = 'Preview changes';
        }
    }
}

// Walks state.sequence for any attached decision tables, serialises each one
// to its YAML+markdown sidecar form, and returns the array the /api/design
// endpoint expects. Extracted so previewPlan and the existing save handler
// share the same builder. (Refactor: the original was inline in saveEls.save's
// handler — see below where we keep a thin wrapper for compatibility.)
function collectDecisionTablesForSave() {
    const out = [];
    for (const step of state.sequence) {
        if (step.kind !== STEP_KIND.CALL || !step.decisionTable) continue;
        const participant = findParticipant(step.calleeId);
        const method = findMethod(step.calleeId, step.methodId);
        if (!participant || !method) continue;
        out.push({
            fileName: decisionTableFileName(participant),
            content: emitDecisionTable(participant, method, step.decisionTable, state.targetPackage)
        });
    }
    return out;
}

// Render the plugin's plan envelope: { actions, warnings, summary }.
function renderPluginPlan(plan) {
    const panel = document.getElementById('preview-result');
    const list  = document.getElementById('preview-result-list');
    const meta  = document.getElementById('preview-result-meta');
    const warn  = document.getElementById('preview-result-warnings');
    if (!panel || !list) return;

    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
    const summary = plan.summary || {};

    list.innerHTML = actions.length === 0
        ? '<li class="preview-detail">No actions — nothing to do.</li>'
        : actions.map(a => {
            const type = (a.type || '').toUpperCase();
            const marker = type === 'CREATE' ? '+' : type === 'UPDATE' ? '~' : type === 'REUSE' ? '✓' : '?';
            const cls   = type === 'CREATE' ? 'preview-action-create'
                       : type === 'UPDATE' ? 'preview-action-update'
                       : type === 'REUSE'  ? 'preview-action-reuse'
                       : '';
            const adds = Array.isArray(a.addedMethods) && a.addedMethods.length > 0
                ? `<span class="preview-detail">add: ${escapeHtml(a.addedMethods.join(', '))}</span>`
                : '';
            return `<li class="${cls}">
                <span class="preview-action-marker">${marker}</span> ${type}  ${escapeHtml(a.path || a.participant || '')}
                ${a.reason ? `<span class="preview-detail">${escapeHtml(a.reason)}</span>` : ''}
                ${adds}
            </li>`;
        }).join('');

    const parts = [];
    if (summary.create != null) parts.push(`${summary.create} create`);
    if (summary.update != null) parts.push(`${summary.update} update`);
    if (summary.reuse  != null) parts.push(`${summary.reuse} reuse`);
    if (summary.verifyTests != null) parts.push(`${summary.verifyTests} verify_tests`);
    if (summary.resultTests != null) parts.push(`${summary.resultTests} result_tests`);
    if (meta) meta.textContent = parts.join(' · ');

    if (warn) {
        if (warnings.length > 0) {
            warn.classList.remove('hidden');
            warn.innerHTML = warnings.map(w => `<div>⚠ ${escapeHtml(String(w))}</div>`).join('');
        } else {
            warn.classList.add('hidden');
            warn.innerHTML = '';
        }
    }

    panel.classList.remove('hidden');
}

// Wire the Preview button (only when present — backward-compat).
(() => {
    const previewBtn = document.getElementById('preview-plan');
    if (previewBtn) previewBtn.addEventListener('click', previewPlan);
})();

saveEls.save.addEventListener('click', async () => {
    saveEls.error.classList.add('hidden');
    saveEls.result.classList.add('hidden');

    if (!state.projectPath) {
        saveEls.error.textContent = 'No project path — go back to Step 1 and pick a folder (or paste a path).';
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
        // If a parent design context is active (we're saving a sub-level),
        // write at the explicit relativePath; otherwise legacy design/<fileName>.
        const designBody = subDesignContext
            ? { projectPath: state.projectPath, relativePath: subDesignContext.relativePath, content, decisionTables }
            : { projectPath: state.projectPath, fileName, content, decisionTables };

        const res = await fetch('/api/design', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(designBody)
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

        // After writing the .puml, write the _index.json manifest alongside.
        // Failures here are non-fatal — the .puml is saved either way, but
        // multi-level tree-walking won't work until the manifest exists.
        try {
            await saveManifestForCurrentDesign(data.relativePath);
        } catch (err) {
            console.warn('manifest write failed (non-fatal):', err);
        }

        // Show the tree-view if any orchestrator children were declared.
        renderTreeView(data.relativePath);
    } catch (err) {
        saveEls.error.textContent = err.message;
        saveEls.error.classList.remove('hidden');
    } finally {
        saveEls.save.disabled = false;
        saveEls.save.textContent = originalLabel;
    }
});

// --- Multi-level state -----------------------------------------------------
//
// When the user clicks "Design this level" on an orchestrator participant,
// the wizard re-enters Step 2 with this context populated. Re-export at
// Step 4 will write the child .puml at subDesignContext.relativePath and
// the child manifest with parent contract hashing.
//
// Null on the root-level wizard run (default state).
let subDesignContext = null;
// Stack of snapshots so the user can step back up after finishing a sub-design.
const subDesignStack = [];

async function saveManifestForCurrentDesign(savedRelativePath) {
    // savedRelativePath is the path of the just-written .puml, relative to
    // the project root. The manifest's folder is its parent directory.
    const slash = savedRelativePath.lastIndexOf('/');
    const manifestFolder = slash < 0 ? '' : savedRelativePath.substring(0, slash);
    const pumlBasename = slash < 0 ? savedRelativePath : savedRelativePath.substring(slash + 1);
    const pumlStem = pumlBasename.replace(/\.puml$/i, '');

    // Children list — every orchestrator participant becomes a defer entry.
    const orchestrators = state.participants.filter(p => p.kind === 'orchestrator');
    const children = orchestrators.map(p => ({
        name: p.name,
        puml: `${pumlStem}/${p.name}.puml`,
        kind: 'orchestrator'
    }));

    // contractHash hashes THIS design as a whole-file fingerprint. When a
    // future child is created from this parent, it stores its own
    // contract_hash for its specific slice; this overall hash is purely
    // diagnostic ("did anything in this file change?").
    const ownHash = await fetchContractHash(savedRelativePath, '__self__');

    const manifest = {
        puml: pumlBasename,
        parent: subDesignContext
            ? { puml: relativeUp(manifestFolder, subDesignContext.parentRelativePath),
                contractHash: subDesignContext.parentContractHash }
            : null,
        children,
        contractHash: ownHash
    };

    await fetch('/api/tree/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            projectPath: state.projectPath,
            manifestFolder,
            manifest
        })
    });

    // If we just saved a child, also append ourselves to the parent manifest's
    // children list (if not already present). Idempotent.
    if (subDesignContext) {
        await appendChildToParentManifest(subDesignContext);
    }
}

async function fetchContractHash(parentPumlRelativePath, childName) {
    try {
        const res = await fetch('/api/tree/contract-hash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: state.projectPath,
                parentPuml: parentPumlRelativePath,
                childName
            })
        });
        const data = await res.json();
        return data.contractHash || null;
    } catch (e) {
        console.warn('contract-hash fetch failed:', e);
        return null;
    }
}

// Compute path from manifestFolder back up to parentRelativePath. Both
// are project-relative. Returns a relative path usable inside the child
// manifest's "parent.puml" field, e.g. "../CreateSale.puml".
function relativeUp(manifestFolder, parentRelativePath) {
    const fromParts = manifestFolder ? manifestFolder.split('/') : [];
    const toParts = parentRelativePath.split('/');
    let common = 0;
    while (common < fromParts.length && common < toParts.length
            && fromParts[common] === toParts[common]) common++;
    const ups = fromParts.length - common;
    const down = toParts.slice(common);
    const parts = [];
    for (let i = 0; i < ups; i++) parts.push('..');
    return parts.concat(down).join('/');
}

async function appendChildToParentManifest(ctx) {
    // Load parent manifest, ensure our entry is in children, save back.
    const parentFolder = ctx.parentManifestFolder;
    const childName = ctx.childName;
    const childPuml = `${ctx.parentPumlStem}/${childName}.puml`;
    try {
        const loadRes = await fetch('/api/tree/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: state.projectPath, rootFolder: parentFolder })
        });
        const tree = (await loadRes.json()).manifests || {};
        const pm = tree[parentFolder];
        if (!pm) return;
        const next = {
            ...pm,
            children: Array.isArray(pm.children) ? pm.children.slice() : []
        };
        if (!next.children.some(c => c.name === childName)) {
            next.children.push({ name: childName, puml: childPuml, kind: 'orchestrator' });
            await fetch('/api/tree/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectPath: state.projectPath,
                    manifestFolder: parentFolder,
                    manifest: next
                })
            });
        }
    } catch (e) {
        console.warn('parent manifest append failed:', e);
    }
}

// --- Tree view + Design this level + Build all ----------------------------

const treeEls = {
    panel: document.getElementById('tree-view'),
    list: document.getElementById('tree-view-list'),
    meta: document.getElementById('tree-view-meta'),
    banner: document.getElementById('tree-view-banner'),
    buildAll: document.getElementById('build-all'),
    buildAllProgress: document.getElementById('build-all-progress'),
    buildAllStatus: document.getElementById('build-all-status'),
    buildAllNodes: document.getElementById('build-all-nodes'),
    exitSub: document.getElementById('exit-sub-design')
};

async function renderTreeView(rootRelativePath) {
    if (!treeEls.panel) return;
    const slash = rootRelativePath.lastIndexOf('/');
    const rootFolder = slash < 0 ? '' : rootRelativePath.substring(0, slash);

    let manifests = {};
    try {
        const res = await fetch('/api/tree/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: state.projectPath, rootFolder })
        });
        manifests = (await res.json()).manifests || {};
    } catch (e) {
        console.warn('tree/load failed:', e);
    }

    // If there's no manifest yet and no orchestrators in current state, the
    // tree view has nothing to show — hide and bail.
    const hasOrchestrators = state.participants.some(p => p.kind === 'orchestrator');
    if (Object.keys(manifests).length === 0 && !hasOrchestrators) {
        treeEls.panel.classList.add('hidden');
        return;
    }

    // Build a renderable list. Root first, then each child (and recursively).
    // Each row shows: kind chip, name, status, "Design this level" button when
    // it's an orchestrator with no sub-design yet.
    const rows = [];
    const root = manifests[rootFolder];
    if (root) {
        walkManifestForView(rootFolder, root, manifests, rows, 0);
    } else {
        // No manifest written — render orchestrators from in-memory state as
        // pending design-this-level prompts. This shouldn't normally happen
        // after a successful save; it's a defensive fallback.
        rows.push({ depth: 0, label: 'this design', status: 'designed', folder: rootFolder, manifest: null });
        for (const p of state.participants.filter(p => p.kind === 'orchestrator')) {
            rows.push({ depth: 1, label: p.name, status: 'pending', folder: null, manifest: null, participant: p });
        }
    }

    treeEls.list.innerHTML = rows.map(r => {
        const pad = '&nbsp;'.repeat(r.depth * 4);
        let chip;
        if (r.status === 'designed') chip = '<span class="tree-chip tree-chip-designed">☑ designed</span>';
        else if (r.status === 'stale') chip = '<span class="tree-chip tree-chip-stale">⚠ stale</span>';
        else chip = '<span class="tree-chip tree-chip-pending">☐ design pending</span>';

        const action = (r.status === 'pending' && r.participant)
            ? `<button type="button" class="link-btn tree-design-this" data-participant-id="${escapeHtml(r.participant.id)}">Design this level →</button>`
            : '';
        return `<li class="tree-row tree-row-${r.status}">
            ${pad}<span class="tree-row-name">${escapeHtml(r.label)}</span>
            ${chip}
            ${action}
        </li>`;
    }).join('');

    // Wire design-this-level buttons.
    treeEls.list.querySelectorAll('.tree-design-this').forEach(btn => {
        btn.addEventListener('click', () => {
            const pid = btn.getAttribute('data-participant-id');
            const p = state.participants.find(x => String(x.id) === pid);
            if (p) startSubDesign(p, rootRelativePath, rootFolder);
        });
    });

    const total = rows.length;
    const designed = rows.filter(r => r.status === 'designed').length;
    treeEls.meta.textContent = `${designed} / ${total} designed`;

    // Build-all is enabled only when every orchestrator has a manifest.
    const pending = rows.filter(r => r.status === 'pending').length;
    if (treeEls.buildAll) {
        treeEls.buildAll.disabled = pending > 0;
        treeEls.buildAll.title = pending > 0
            ? `${pending} sub-design${pending === 1 ? '' : 's'} pending — design them first`
            : 'Walk the tree bottom-up, run the plugin per .puml';
    }

    treeEls.panel.classList.remove('hidden');
}

// Recursive view-row builder. Each manifest's puml file is one row; its
// children are rendered indented underneath. Pending children (declared as
// orchestrators in the parent manifest but with no child manifest yet) get
// a "Design this level" button instead of a status chip.
function walkManifestForView(folder, manifest, allManifests, rows, depth) {
    rows.push({
        depth,
        label: manifest.puml,
        status: 'designed',
        folder,
        manifest
    });
    if (!Array.isArray(manifest.children)) return;
    for (const child of manifest.children) {
        const childFolderRel = child.puml.includes('/')
            ? child.puml.substring(0, child.puml.lastIndexOf('/'))
            : '';
        const childFolder = folder ? (childFolderRel ? `${folder}/${childFolderRel}` : folder) : childFolderRel;
        const childManifest = allManifests[childFolder];
        if (childManifest) {
            walkManifestForView(childFolder, childManifest, allManifests, rows, depth + 1);
        } else {
            // Find the in-memory participant matching this name so the
            // design-this-level button can pass it through.
            const participant = state.participants.find(p => p.name === child.name && p.kind === 'orchestrator');
            rows.push({
                depth: depth + 1,
                label: child.name + ' (sub-design)',
                status: 'pending',
                folder: childFolder,
                manifest: null,
                participant
            });
        }
    }
}

async function startSubDesign(participant, parentRelativePath, parentManifestFolder) {
    // Compute parent's contract hash slice for this child so we can detect
    // drift later. Failures are non-fatal; null hash means "no drift check".
    const parentHash = await fetchContractHash(parentRelativePath, participant.name);
    const parentPumlBasename = parentRelativePath.substring(parentRelativePath.lastIndexOf('/') + 1);
    const parentPumlStem = parentPumlBasename.replace(/\.puml$/i, '');
    const childRelative = parentManifestFolder
        ? `${parentManifestFolder}/${parentPumlStem}/${participant.name}.puml`
        : `${parentPumlStem}/${participant.name}.puml`;

    // Snapshot the current wizard state. Used to restore when user clicks
    // "Back to parent design".
    subDesignStack.push(snapshotWizardState());

    subDesignContext = {
        parentRelativePath,
        parentManifestFolder,
        parentPumlStem,
        parentContractHash: parentHash,
        childName: participant.name,
        relativePath: childRelative
    };

    // Reset state to a fresh wizard run, keeping the project context.
    state.userStory = `Design the internals of ${participant.name}. ` +
        `Called by ${parentPumlStem} with: ${(participant.methods || []).map(m => methodPreviewSignature(m)).join('; ')}.`;
    state.ac = [];
    state.participants = [];
    state.sequence = [];
    state.tree = null;
    state.story = '';
    state.sutParticipantId = null;
    state.signoffs = { peter: false, john: false, chen: false, wang: false };

    // Seed the SUT participant from the parent's call signature on this child.
    // The user can then add its own internal collaborators.
    const sut = makeParticipant(participant.name, true, participant.purpose || '');
    sut.kind = 'leaf';
    sut.methods = (participant.methods || []).map(m => {
        const copy = makeMethod(m.name, (m.inputs || []).map(i => ({ name: i.name, type: i.type })), m.output || '');
        copy.isProposed = false;
        return copy;
    });
    state.participants.push(sut);
    state.sutParticipantId = sut.id;

    // If the analyser provided a sub-tree for this orchestrator, expand its
    // children into participants now so the user starts with the AI's
    // suggested collaborators instead of an empty canvas.
    if (participant.subDesignNode && Array.isArray(participant.subDesignNode.children)) {
        for (const childNode of participant.subDesignNode.children) {
            const fromTree = flattenTreeToParticipants(childNode);
            for (const np of fromTree) state.participants.push(np);
        }
    }

    // Suggest a child file name in the save panel.
    if (saveEls.filename) {
        saveEls.filename.value = `${participant.name}.puml`;
    }

    // Reveal the "back to parent" button.
    if (treeEls.exitSub) treeEls.exitSub.classList.remove('hidden');

    // Jump to Step 2 to let the user refine.
    goToStep(2);
}

function snapshotWizardState() {
    return {
        userStory: state.userStory,
        ac: JSON.parse(JSON.stringify(state.ac || [])),
        participants: JSON.parse(JSON.stringify(state.participants)),
        sequence: JSON.parse(JSON.stringify(state.sequence)),
        targetPackage: state.targetPackage,
        sutParticipantId: state.sutParticipantId,
        tree: state.tree ? JSON.parse(JSON.stringify(state.tree)) : null,
        story: state.story,
        signoffs: { ...state.signoffs },
        subDesignContext,
        lastSavedRelativePath
    };
}

function exitSubDesign() {
    const snapshot = subDesignStack.pop();
    if (!snapshot) {
        subDesignContext = null;
        if (treeEls.exitSub) treeEls.exitSub.classList.add('hidden');
        return;
    }
    state.userStory = snapshot.userStory;
    state.ac = snapshot.ac || [];
    state.participants = snapshot.participants;
    state.sequence = snapshot.sequence;
    state.targetPackage = snapshot.targetPackage;
    state.sutParticipantId = snapshot.sutParticipantId;
    state.tree = snapshot.tree;
    state.story = snapshot.story;
    state.signoffs = snapshot.signoffs;
    subDesignContext = snapshot.subDesignContext;
    lastSavedRelativePath = snapshot.lastSavedRelativePath;
    if (treeEls.exitSub && subDesignStack.length === 0) {
        treeEls.exitSub.classList.add('hidden');
    }
    goToStep(4);  // back to parent's Step 4 (export)
}

if (treeEls.exitSub) {
    treeEls.exitSub.addEventListener('click', exitSubDesign);
}

if (treeEls.buildAll) {
    treeEls.buildAll.addEventListener('click', runBuildAll);
}

async function runBuildAll() {
    if (!state.projectPath || !lastSavedRelativePath) return;
    treeEls.buildAllProgress.classList.remove('hidden');
    treeEls.buildAllNodes.innerHTML = '';
    treeEls.buildAllStatus.textContent = 'Building…';
    treeEls.buildAll.disabled = true;
    const originalLabel = treeEls.buildAll.textContent;
    treeEls.buildAll.textContent = 'Building…';

    const modelSelect = document.getElementById('run-model');
    const reader = makeNdjsonReader();
    const nodeRows = new Map();   // puml path -> <li> element

    try {
        const response = await fetch('/api/build-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: state.projectPath,
                filePath: lastSavedRelativePath,
                model: modelSelect ? modelSelect.value : null
            })
        });
        if (!response.ok || !response.body) {
            treeEls.buildAllStatus.textContent = `Failed (${response.status})`;
            return;
        }
        const decoder = new TextDecoder();
        const bodyReader = response.body.getReader();
        while (true) {
            const { done, value } = await bodyReader.read();
            if (done) break;
            const events = reader.push(decoder.decode(value, { stream: true }));
            for (const ev of events) handleBuildAllEvent(ev, nodeRows);
        }
        treeEls.buildAllStatus.textContent = 'Done';
    } catch (e) {
        treeEls.buildAllStatus.textContent = 'Failed';
        const li = document.createElement('li');
        li.className = 'build-all-node build-all-node-failed';
        li.textContent = String(e);
        treeEls.buildAllNodes.appendChild(li);
    } finally {
        treeEls.buildAll.disabled = false;
        treeEls.buildAll.textContent = originalLabel;
    }
}

function handleBuildAllEvent(ev, nodeRows) {
    if (!ev || !ev.event) return;
    switch (ev.event) {
        case 'build-all-start':
            treeEls.buildAllStatus.textContent = `Building ${ev.nodes} nodes…`;
            break;
        case 'node-start': {
            const li = document.createElement('li');
            li.className = 'build-all-node build-all-node-running';
            li.innerHTML = `<span class="build-all-node-status">▶</span> <code>${escapeHtml(ev.puml)}</code>`;
            treeEls.buildAllNodes.appendChild(li);
            nodeRows.set(ev.puml, li);
            break;
        }
        case 'node-done': {
            const li = nodeRows.get(ev.puml);
            if (!li) return;
            li.classList.remove('build-all-node-running');
            if (ev.error || ev.exit !== 0) {
                li.classList.add('build-all-node-failed');
                li.querySelector('.build-all-node-status').textContent = '✗';
                if (ev.error) {
                    const errSpan = document.createElement('div');
                    errSpan.className = 'build-all-node-error';
                    errSpan.textContent = String(ev.error);
                    li.appendChild(errSpan);
                }
            } else {
                li.classList.add('build-all-node-done');
                li.querySelector('.build-all-node-status').textContent = '✓';
            }
            break;
        }
        case 'build-all-done':
            treeEls.buildAllStatus.textContent = ev.error
                ? `Stopped: ${ev.error} (${ev.succeeded}/${ev.total} done)`
                : `Done — ${ev.succeeded}/${ev.total} succeeded`;
            // Refresh the tree-view so newly-implemented nodes flip to ☑.
            if (lastSavedRelativePath) renderTreeView(lastSavedRelativePath);
            break;
        default:
            // Per-step plugin events from inside each node — render only their
            // raw stdout into the most-recent node row's hover-output (kept
            // simple for v1; users wanting full output run them one at a time).
            break;
    }
}

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

