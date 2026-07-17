const state = {
    projectPath: null,
    // Server-built snapshot of the connected project: types[], packages[],
    // glossary[], conventions, fileCount, skippedCount. Used both to ground
    // the AI analyser and to populate Step 2's type autocomplete.
    codebaseCatalog: null,
    userStory: '',
    // The story textarea's verbatim content: story prose + Gherkin AC
    // lines together. Parsed on input into userStory (prose) + ac (rows);
    // kept so the textarea can be restored exactly on step re-entry.
    storyRaw: '',
    // Acceptance criteria as structured Gherkin rows. Each row is
    // { given, when, then }. Parsed from "Given …, when …, then …" lines
    // in the story textarea. Fed to /api/analyze as `acceptanceCriteria`
    // so generated participants/sequence satisfy each row.
    ac: [],
    // Types/entities the participants pass around — records, enums,
    // classes (not interfaces; those are participants). Populated from
    // the analyzer's new entities[] response, then augmented by a
    // frontend derivation pass that scans participant signatures for
    // any names the AI missed. User edits land here via the entity
    // modal. Each entry: { id, name, kind, purpose, existingFqn,
    // fields:[{name,type}], values:[string] }.
    entities: [],
    // The analyzer's variancePlan[] — one entry per variance axis declared
    // in the AC (axis/pattern/criterion/rationale; resolver entries also
    // carry mapping[]). Used by the export step to auto-emit resolver
    // decision-table sidecars. Refreshed on every analyze; empty when no
    // variance axes were declared.
    variancePlan: [],
    participants: [],
    sequence: [],
    targetPackage: '',
    // True while the package field still reflects an auto-derived value.
    // Flipped to false the moment the user types in the input — that makes
    // the user's edit sticky, so subsequent re-analyzes won't clobber it.
    targetPackageAutoFilled: true,
    // Marks which participant is the System Under Test. When set, the
    // wizard auto-manages the entry interaction ([*] -> SUT) and final
    // return ([*] <-- SUT) steps. DisC requires exactly one system_caller
    // per .puml; this is how we author it.
    sutParticipantId: null,
    // Story prose rendered above the participant cards in Step 2.
    // Populated by POST /api/analyze on enterStep2 when a user story is
    // set; empty string means "haven't analysed yet" or "manual mode".
    // analyzeError is set when claude is missing or the call fails —
    // falls back to manual participant authoring.
    story: '',
    // The SUT's name as identified by the analyzer (the `sut` field in
    // the analyzer JSON). Used to auto-select the SUT after analyze
    // lands. Falls back to participants[0].name when absent.
    sutName: '',
    analyzeError: null,
    analyzing: false,
    // Step 3 team-signoff gate — single checkbox confirming the team has
    // reviewed and approved the design. Must be checked before the Generate
    // button enables. In-memory only; resets on page reload. Persists across
    // step-back navigation in the same session.
    teamSignedOff: false,
    // True when the most recent Analyze chain ended with the plugin still
    // refusing after the one allowed retry. Blocks Continue-to-Sign-off
    // until the next Analyze. Cleared at the start of every runAnalyze().
    validatorRefused: false
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
    opt:     { keyword: 'opt',   defaultLabel: 'if optional',   allowsElse: false, glyph: '◇', label: 'opt',      color: '#7c3aed' }
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
    disconnectBtn: document.getElementById('disconnect-btn'),
    browseBtn: document.getElementById('browse-btn'),
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
    els.pathInput.disabled = true;

    try {
        const res = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Scan failed (${res.status})`);

        const prevPath = state.projectPath;
        state.projectPath = data.path;
        state.codebaseCatalog = data;
        applyTargetPackageHeuristics(prevPath, data);
        renderScanResult(data);
        populateTypesDatalist();
        updateConnectGate();
    } catch (err) {
        els.error.textContent = err.message;
        els.error.classList.remove('hidden');
    } finally {
        els.status.classList.add('hidden');
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
            // Auto-scan: connecting = scanning. The user picked a folder,
            // they don't need to also click a Scan button to make it count.
            els.pathInput.dispatchEvent(new Event('input'));
            await runScan(data.path);
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

// Recent-project chips were removed — each connect scans the project fresh.
// Purge any cached paths a returning user still has from a prior version.
try { localStorage.removeItem('disc.recentProjectPaths'); } catch {}

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
    acRows: document.getElementById('ac-rows'),
    acCount: document.getElementById('ac-count'),
    acCoverage: document.getElementById('ac-coverage'),
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

// One textarea carries both the story and the acceptance criteria.
// Lines starting with a Gherkin keyword (Given/When/Then/And) parse into
// structured { given, when, then } rows; everything else is story prose.
// Both inline ("Given …, when …, then …") and multi-line (Given / When /
// Then on separate lines) Gherkin are accepted; "And" extends the last
// clause of the current row.
function parseStoryAndAc(text) {
    const storyLines = [];
    const rows = [];
    let cur = null;
    let lastField = null;
    for (const raw of (text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (!/^(given|when|then|and)\b/i.test(line)) {
            storyLines.push(line);
            cur = null;
            lastField = null;
            continue;
        }
        // "And …" with no other keyword continues the current clause; with no
        // clause to continue it is story prose — never silently dropped.
        if (/^and\b/i.test(line) && !/\b(given|when|then)\b/i.test(line.replace(/^and\b/i, ''))) {
            if (cur && lastField) {
                const txt = line.replace(/^and\b[\s:,]*/i, '').replace(/[\s,;.]+$/, '');
                cur[lastField] = cur[lastField] ? cur[lastField] + ' and ' + txt : txt;
            } else {
                storyLines.push(line);
            }
            continue;
        }
        // Tokenise on the keywords: odd indices are keywords, the
        // element after each is that clause's text.
        const parts = line.split(/\b(given|when|then)\b/i);
        for (let i = 1; i < parts.length; i += 2) {
            const kw = parts[i].toLowerCase();
            const txt = (parts[i + 1] || '').replace(/^[\s:,]+/, '').replace(/[\s,;.]+$/, '');
            if (kw === 'given') {
                cur = { given: txt, when: '', then: '' };
                rows.push(cur);
            } else {
                if (!cur) { cur = { given: '', when: '', then: '' }; rows.push(cur); }
                cur[kw] = cur[kw] ? cur[kw] + ' ' + txt : txt;
            }
            lastField = kw;
        }
    }
    return { story: storyLines.join('\n'), rows };
}

function applyStoryInput(text) {
    state.storyRaw = text;
    const { story, rows } = parseStoryAndAc(text);
    state.userStory = story;
    state.ac = rows;
    renderAcRows();
    updateAnalyzeGate();
}

if (storyInput) {
    storyInput.addEventListener('input', () => applyStoryInput(storyInput.value));
}

// --- Step 2 acceptance criteria (Gherkin rows) ---

// Participants that carry a specific AC row by index. The mapping is
// produced by the analyzer (acIndices field on each participant) and
// adopted onto state.participants by adoptParticipant. Used by the
// per-row carrier-count chip and the cross-highlight hover.
function participantsCoveringAc(rowIdx) {
    return (state.participants || []).filter(p =>
        Array.isArray(p.acIndices) && p.acIndices.includes(rowIdx));
}

// Section-level coverage: how many AC rows have at least one carrier.
// Surfaced as a chip next to the AC count so the user sees orphaned
// scenarios at a glance.
function acCoverageStats() {
    const total = (state.ac || []).length;
    let covered = 0;
    for (let i = 0; i < total; i++) {
        if (participantsCoveringAc(i).length > 0) covered++;
    }
    return { covered, total };
}

// --- AC ↔ Participant cross-highlight ---
//
// One body data-attribute is the single source of truth for hover state;
// CSS dims non-matching items via attribute selectors. The matching cards/
// rows also get an explicit class so CSS can render the accent.

function setAcHover(idx) {
    document.body.setAttribute('data-ac-hover', String(idx));
    document.querySelectorAll('#participants-list .pc-card').forEach(card => {
        const p = findParticipant(card.dataset.id);
        const covered = p && Array.isArray(p.acIndices) && p.acIndices.includes(idx);
        card.classList.toggle('ac-covered', !!covered);
    });
}
function clearAcHover() {
    document.body.removeAttribute('data-ac-hover');
    document.querySelectorAll('.pc-card.ac-covered').forEach(c => c.classList.remove('ac-covered'));
}
function setParticipantHover(participantId) {
    const p = findParticipant(participantId);
    if (!p) return;
    document.body.setAttribute('data-participant-hover', String(participantId));
    const indices = new Set(p.acIndices || []);
    document.querySelectorAll('.ac-row[data-ac-index]').forEach(row => {
        const i = Number(row.getAttribute('data-ac-index'));
        row.classList.toggle('participant-covers', indices.has(i));
    });
}
function clearParticipantHover() {
    document.body.removeAttribute('data-participant-hover');
    document.querySelectorAll('.ac-row.participant-covers').forEach(r => r.classList.remove('participant-covers'));
}

function renderAcRows() {
    const container = step2Els.acRows;
    if (!container) return;
    container.innerHTML = '';
    state.ac.forEach((row, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'ac-row';
        wrap.setAttribute('data-ac-index', String(idx));

        const hasParticipants = (state.participants || []).length > 0;
        const carriers = participantsCoveringAc(idx);
        // Hide the per-row carrier pill until the analyzer has produced
        // participants — otherwise an empty proposal renders as "0
        // PARTICIPANTS" in red on every row, which reads as an error.
        const carrierChip = !hasParticipants ? '' : (() => {
            const carrierWarn = carriers.length === 0 ? ' is-warn' : '';
            const carrierTitle = carriers.length === 0
                ? 'no participant covers this scenario — analyse again, or this AC may be redundant'
                : `Carried by: ${carriers.map(p => p.name || '?').join(', ')}`;
            return `<span class="ac-carrier-chip${carrierWarn}" title="${escapeAttr(carrierTitle)}">${carriers.length} ${carriers.length === 1 ? 'participant' : 'participants'}</span>`;
        })();

        // Read-only: the rows are parsed live from the story textarea —
        // editing happens there, this list just confirms what was parsed
        // and carries the coverage chip + cross-highlight.
        wrap.classList.add('ac-row-readonly');
        wrap.innerHTML = `
            <div class="ac-ro-text">
                <span class="ac-field-label">Given</span> ${escapeHtml(row.given || '—')}
                <span class="ac-field-label">when</span> ${escapeHtml(row.when || '—')}
                <span class="ac-field-label">then</span> ${escapeHtml(row.then || '—')}
            </div>
            ${carrierChip}
        `;
        // Cross-highlight: when this row is hovered, dim non-carrier
        // participants. Cleared on leave.
        wrap.addEventListener('mouseenter', () => setAcHover(idx));
        wrap.addEventListener('mouseleave', clearAcHover);
        container.appendChild(wrap);
    });
    if (step2Els.acCount) {
        const n = state.ac.length;
        step2Els.acCount.textContent = `${n} criteri${n === 1 ? 'on' : 'a'}`;
    }
    if (step2Els.acCoverage) {
        const { covered, total } = acCoverageStats();
        const hasParticipants = (state.participants || []).length > 0;
        if (total === 0 || !hasParticipants) {
            // Coverage is only meaningful after the analyzer has produced
            // participants. Before that, a "0 / N covered" warning would
            // read as an error when nothing has even been proposed yet.
            step2Els.acCoverage.textContent = '';
            step2Els.acCoverage.classList.remove('is-warn');
        } else {
            step2Els.acCoverage.textContent = `${covered} / ${total} covered`;
            step2Els.acCoverage.classList.toggle('is-warn', covered < total);
        }
    }
}

// --- Step 2 Analyze button: explicit trigger (no auto-fire) ---

if (step2Els.analyzeBtn) {
    step2Els.analyzeBtn.addEventListener('click', () => {
        if (!state.userStory || !state.userStory.trim()) return;
        // Block double-clicks while the Analyze chain (analyzer + sequencer
        // + validator + optional retry) is in flight — worst case ~2.5 min,
        // long enough that concurrent chains would race on state.* mutations.
        if (state.analyzing) return;
        // Re-analyzing wipes downstream design so the next state is
        // produced fresh from the current story + AC.
        state.story = '';
        state.sutName = '';
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

// Picks the catalog's "primary" package — the one that's the most likely
// target for new code. Heuristic: shortest name (root package wins over
// children, e.g. com.demo over com.demo.service); tie-break by highest
// typeCount. The root is the natural default because new files typically
// live under it, and the user can still override by typing.
function pickPrimaryPackage(catalog) {
    if (!catalog || !Array.isArray(catalog.packages) || catalog.packages.length === 0) {
        return '';
    }
    const sorted = catalog.packages
        .filter(p => p && p.name)
        .slice()
        .sort((a, b) => {
            if (a.name.length !== b.name.length) return a.name.length - b.name.length;
            return (b.typeCount || 0) - (a.typeCount || 0);
        });
    return (sorted[0] && sorted[0].name) || '';
}

// Common Java role suffixes — stripped from the SUT name when deriving a
// package leaf so e.g. "VisitFeeCalculator" yields "visitfee" rather than
// "visitfeecalculator". Suffix match is case-insensitive on the final
// PascalCase token only.
const ROLE_SUFFIXES = [
    'Calculator', 'Service', 'Controller', 'Manager', 'Handler',
    'Processor', 'Engine', 'Resolver', 'Repository', 'Dao',
    'Mapper', 'Converter', 'Configuration', 'Config', 'Validator'
];

// Turn a PascalCase SUT name into a Java package segment by stripping a
// trailing role suffix and lowercasing the remaining domain tokens. Returns
// null if the result wouldn't be a valid Java identifier (e.g. empty after
// suffix strip, or starts with a digit).
function deriveSutLeafName(sutName) {
    if (!sutName) return null;
    const tokens = sutName.match(/[A-Z][a-z0-9]*/g) || [sutName];
    const last = tokens[tokens.length - 1];
    const domainTokens = ROLE_SUFFIXES.some(s => s.toLowerCase() === last.toLowerCase())
        ? tokens.slice(0, -1)
        : tokens;
    if (!domainTokens.length) return null;
    const leaf = domainTokens.join('').toLowerCase();
    return /^[a-z][a-z0-9_]*$/.test(leaf) ? leaf : null;
}

function packageOfFqn(fqn) {
    if (!fqn) return '';
    const i = fqn.lastIndexOf('.');
    return i < 0 ? '' : fqn.slice(0, i);
}

function longestCommonPackagePrefix(pkgs) {
    if (!pkgs.length) return '';
    const split = pkgs.map(p => p.split('.'));
    const minLen = Math.min(...split.map(s => s.length));
    const out = [];
    for (let i = 0; i < minLen; i++) {
        const seg = split[0][i];
        if (split.every(s => s[i] === seg)) out.push(seg);
        else break;
    }
    return out.join('.');
}

// Recommend the package for the SUT and its co-generated entities. Anchors
// on the packages of non-SUT participants that map to types already in the
// project (existingFqn set). The new package is a sibling of those anchors
// at their shared parent level, suffixed with a leaf derived from the SUT
// name. Returns pickPrimaryPackage(catalog) when no anchor is available
// (greenfield design) or when the SUT name can't be tokenised.
function recommendSutPackage(participants, sutName, catalog) {
    const fallback = () => pickPrimaryPackage(catalog);
    const leaf = deriveSutLeafName(sutName);

    const anchors = (participants || [])
        .filter(p => p && p.name !== sutName && p.existingFqn)
        .map(p => packageOfFqn(p.existingFqn))
        .filter(Boolean);

    if (!anchors.length || !leaf) return fallback();

    const unique = Array.from(new Set(anchors));
    let level;
    if (unique.length === 1) {
        const parts = unique[0].split('.');
        level = parts.length > 1 ? parts.slice(0, -1).join('.') : unique[0];
    } else {
        level = longestCommonPackagePrefix(unique);
    }

    if (!level || level.split('.').length < 2) return fallback();

    return `${level}.${leaf}`;
}

// Called after a successful scan to keep state.targetPackage honest:
//   - If a DIFFERENT project was just connected, clear any package the user
//     typed against the previous one.
//   - If the current targetPackage doesn't match any scanned package prefix,
//     it's almost certainly stale or a typo — clear it.
//   - If targetPackage ends up empty, auto-fill from the catalog's primary
//     package so the user doesn't have to type (or risk typos).
// Sync the visible input + warning so the user sees the auto-fill happen.
function applyTargetPackageHeuristics(prevPath, catalog) {
    const projectChanged = prevPath && catalog && catalog.path && prevPath !== catalog.path;
    if (projectChanged) {
        state.targetPackage = '';
        state.targetPackageAutoFilled = true;
    }

    const current = (state.targetPackage || '').trim();
    if (current && catalog && Array.isArray(catalog.packages)) {
        const matches = catalog.packages.some(p => {
            const n = p && p.name;
            return n && (n === current || n.startsWith(current + '.') || current.startsWith(n + '.'));
        });
        if (!matches) {
            state.targetPackage = '';
            state.targetPackageAutoFilled = true;
        }
    }

    if (!state.targetPackage || state.targetPackageAutoFilled) {
        state.targetPackage = recommendSutPackage(state.participants, state.sutName, catalog);
        state.targetPackageAutoFilled = true;
    }

    if (saveEls && saveEls.pkg) {
        saveEls.pkg.value = state.targetPackage;
        refreshPackageWarning();
    }
}

// Re-run the SUT-aware package recommendation after analyze lands. Only
// updates the field when the value is still the wizard's auto-default —
// the moment the user types anything in #puml-package, targetPackageAutoFilled
// flips to false (see the input listener) and this becomes a no-op so the
// user's choice stays put across re-analyzes.
function maybeRefreshTargetPackage() {
    if (!state.targetPackageAutoFilled) return;
    const next = recommendSutPackage(state.participants, state.sutName, state.codebaseCatalog);
    if (!next || next === state.targetPackage) return;
    state.targetPackage = next;
    if (saveEls && saveEls.pkg) {
        saveEls.pkg.value = next;
        refreshPackageWarning();
        outputEl.textContent = emitPlantUml();
    }
}

// --- Participant model ---

function makeParticipant(name = '', implByDefault = true, purpose = '') {
    return {
        id: newId(),
        name,
        implByDefault,
        methods: [],
        purpose,
        // Declared-only metadata. Defaults are empty/blank so a hand-added
        // participant doesn't synthesise fake scenarios or invariants.
        operationalPrinciple: '',
        invariants: [],
        existingFqn: null,
        signatureConflicts: [],
        // Participant kind (informs Step-2 chips; .puml emission is uniform
        // in MVP — multi-level recursion parked, see TODO.md):
        //   'leaf'         — terminal, AI sees no further collaborators (default)
        //   'orchestrator' — non-leaf custom abstraction; collaborators are
        //                    flattened into the same .puml at this level.
        //   'reuse'        — bound to an existing catalog type (existingFqn set).
        kind: 'leaf'
    };
}

function makeMethod(name = '', inputs = [], output = '', cases = null, boundaries = null) {
    // `isProposed` distinguishes AI-suggested NEW methods on a reused type
    // (which become `+method` extensions in the .puml prelude) from methods
    // that already exist on the catalog type. Default false; adoptParticipant
    // flips it to true for AI-proposed extensions on a reused type.
    //
    // `cases` carries per-AC-row example data the analyzer emits for
    // pure-function-leaf behaviors. Shape: [{ acIndex, description, inputs:{name->expr}, expected:expr }].
    // Null when absent — the save handler auto-emits a sidecar only when non-empty.
    //
    // `boundaries` carries declared thresholds per numeric arg ({argName -> [values]}).
    // The sidecar emitters write it into frontmatter; the plugin enforces that each
    // declared boundary is bracketed by a pair of rows and pins the impl's comparisons.
    return { id: newId(), name, inputs, output, isProposed: false, cases, boundaries };
}

// Entity factory — records / enums / classes the participants pass around.
// `kind` drives both the editor UI (fields list vs values list) and the
// .puml emission stereotype. `existingFqn` set means REUSE (no codegen);
// when null the entity is NEW and the plugin will codegen the source.
function makeEntity(name = '', kind = 'record', purpose = '') {
    return {
        id: newId(),
        name,
        kind,                // 'record' | 'enum' | 'class' | 'interface' | 'sealed-interface'
        purpose,
        existingFqn: null,
        fields: [],          // [{ name, type }] — for record / class
        values: [],          // [string] — for enum
        behaviors: [],       // [{ name, args, returns }] — for interface / sealed-interface
        permits: []          // [variantEntityName] — for sealed-interface
    };
}

// JDK collection generics & primitives that derivation skips when
// scanning method signatures for entity references — these are platform
// types, not domain entities.
const PRIMITIVE_TYPES = new Set([
    // primitives + their lowercase form
    'void', 'boolean', 'byte', 'short', 'char', 'int', 'long', 'float', 'double',
    // boxed primitives + common JDK value types
    'Boolean', 'Byte', 'Short', 'Character', 'Integer', 'Long', 'Float', 'Double',
    'Number', 'BigDecimal', 'BigInteger',
    'String', 'CharSequence', 'Object', 'Void',
    // date/time (java.time + legacy)
    'Instant', 'Duration', 'Period', 'LocalDate', 'LocalTime', 'LocalDateTime',
    'ZonedDateTime', 'OffsetDateTime', 'OffsetTime', 'ZoneId', 'ZoneOffset',
    'Year', 'YearMonth', 'Month', 'MonthDay', 'DayOfWeek', 'Clock', 'Date',
    // misc common
    'UUID', 'URL', 'URI', 'Path', 'File', 'Class',
    'Exception', 'Throwable', 'RuntimeException', 'Error'
]);
const JDK_GENERIC_OUTER = new Set([
    'List', 'Set', 'Map', 'Collection', 'Optional', 'Iterable', 'Iterator',
    'Queue', 'Deque', 'Stream', 'Future', 'CompletableFuture'
]);

// Extract every PascalCase type token from a raw signature fragment like
// "List<Visit>", "Map<String, Order>", "VisitFeeRequest". Token order is
// preserved; primitives + JDK generic outers are dropped by the caller.
function extractTypeRefs(raw) {
    if (!raw) return [];
    return raw.match(/[A-Z][A-Za-z0-9_]*/g) || [];
}

// Reshape an analyzer-supplied entity payload into the local entity model
// (fresh `id`, defaults for omitted fields). Tolerates missing keys so a
// truncated/older AI response still loads cleanly.
function adoptEntity(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const allowedKinds = new Set(['record', 'enum', 'class', 'interface', 'sealed-interface']);
    const kind = allowedKinds.has(raw.kind) ? raw.kind : 'record';
    const existingFqn = (raw.existingFqn || '').trim() || null;
    const fields = Array.isArray(raw.fields)
        ? raw.fields
            .filter(f => f && (f.name || f.type))
            .map(f => ({ name: (f.name || '').trim(), type: (f.type || '').trim() }))
        : [];
    const values = Array.isArray(raw.values)
        ? raw.values.map(v => (v || '').toString().trim()).filter(Boolean)
        : [];
    const behaviors = Array.isArray(raw.behaviors)
        ? raw.behaviors
            .filter(b => b && (b.name || b.returns))
            .map(b => ({
                name: (b.name || '').trim(),
                args: Array.isArray(b.args)
                    ? b.args
                        .filter(a => a && (a.name || a.type))
                        .map(a => ({ name: (a.name || '').trim(), type: (a.type || '').trim() }))
                    : [],
                returns: (b.returns || '').trim() || 'void'
            }))
        : [];
    const permits = Array.isArray(raw.permits)
        ? raw.permits.map(v => (v || '').toString().trim()).filter(Boolean)
        : [];
    return {
        id: newId(),
        name: (raw.name || '').trim(),
        kind,
        purpose: (raw.purpose || '').trim(),
        existingFqn,
        // ownedBy / exposure are analyzer-supplied design metadata. The
        // analyzer reads ownedBy in its R4a self-check before emitting;
        // here it's pass-through with safe defaults, never required for codegen.
        ownedBy: (raw.ownedBy || '').trim() || null,
        exposure: (raw.exposure || '').trim() || 'internal',
        // Reuse entities defer to the existing source — keep authoring
        // arrays empty so the UI doesn't pretend to author them.
        fields: existingFqn ? [] : fields,
        values: existingFqn ? [] : values,
        behaviors: existingFqn ? [] : behaviors,
        permits: existingFqn ? [] : permits
    };
}

// Walk every type reference in every participant method and ensure each
// domain type has a corresponding entry in state.entities. Skips
// primitives, JDK collection outers, and names that are themselves
// participants (those are services, not entities). For NEW types, hydrate
// from state.codebaseCatalog when the name matches a scanned type;
// otherwise drop a placeholder record entity inviting the user to fill
// in fields.
//
// Idempotent: existing entities (AI-supplied or user-typed) are left
// alone; only missing names are added.
function mergeDerivedEntities() {
    const participantNames = new Set(
        state.participants.map(p => (p.name || '').trim()).filter(Boolean)
    );
    const existingNames = new Set(state.entities.map(e => e.name));
    const catalog = state.codebaseCatalog;
    const catalogByName = (catalog && Array.isArray(catalog.types))
        ? Object.fromEntries(catalog.types.map(t => [t.name, t]))
        : {};

    const seen = new Set();
    const queue = [];

    function consider(typeStr) {
        for (const token of extractTypeRefs(typeStr || '')) {
            if (PRIMITIVE_TYPES.has(token)) continue;
            if (JDK_GENERIC_OUTER.has(token)) continue;
            if (participantNames.has(token)) continue;
            if (existingNames.has(token)) continue;
            if (seen.has(token)) continue;
            seen.add(token);
            queue.push(token);
        }
    }

    for (const p of state.participants) {
        for (const m of (p.methods || [])) {
            for (const i of (m.inputs || [])) consider(i.type);
            consider(m.output);
        }
    }

    for (const name of queue) {
        const catalogType = catalogByName[name];
        if (catalogType) {
            // REUSE: bind to the existing FQN. Skip controller / config /
            // exception roles — they aren't entities.
            if (catalogType.role === 'controller' || catalogType.role === 'config' || catalogType.role === 'exception') {
                continue;
            }
            const kind = (catalogType.kind === 'enum' || catalogType.kind === 'class' || catalogType.kind === 'record')
                ? catalogType.kind
                : 'record';
            state.entities.push({
                id: newId(),
                name,
                kind,
                purpose: catalogType.purpose || '',
                existingFqn: catalogType.fqn,
                fields: [],
                values: [],
                behaviors: [],
                permits: []
            });
        } else {
            // NEW placeholder — kind defaults to record (sensible default
            // for a DTO inferred from a signature). User refines via the
            // entity modal; the plugin's codegen needs the right kind.
            state.entities.push({
                id: newId(),
                name,
                kind: 'record',
                purpose: '',
                existingFqn: null,
                fields: [],
                values: [],
                behaviors: [],
                permits: []
            });
        }
    }
}

// Adopt one participant from the analyzer's flat `participants[]` array
// into the wizard's participant-model shape. When the node carries an
// `existingFqn`, methods are pulled from the catalog (not the AI's invented
// signatures) so downstream sequencing uses methods that genuinely exist
// on the user's type; AI-proposed methods that don't exist in the catalog
// are kept as `isProposed: true` and become `+method` entries on the
// .puml `<<@class:fqn, +method>>` stereotype.
// Reshape an analyzer-supplied `cases` payload onto a behavior. Skips
// malformed entries; returns null when nothing usable survives so the
// downstream `(m.cases || []).length === 0` guard short-circuits cleanly.
function adoptCases(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const out = [];
    for (const c of raw) {
        if (!c || typeof c !== 'object') continue;
        const inputs = (c.inputs && typeof c.inputs === 'object') ? { ...c.inputs } : {};
        const expected = (c.expected !== undefined && c.expected !== null) ? String(c.expected) : '';
        if (!expected && Object.keys(inputs).length === 0) continue;
        out.push({
            acIndex: typeof c.acIndex === 'number' ? c.acIndex : null,
            description: (c.description || '').toString(),
            inputs,
            expected
        });
    }
    return out.length > 0 ? out : null;
}

// Reshape an analyzer-supplied `boundaries` payload ({argName -> [numbers]})
// onto a behavior. Drops non-numeric values and empty lists; returns null
// when nothing usable survives so the emitters' truthiness guards short-circuit.
function adoptBoundaries(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const [arg, vals] of Object.entries(raw)) {
        if (!Array.isArray(vals)) continue;
        const nums = vals
            .filter(v => v !== null && v !== '' && !isNaN(Number(v)))
            .map(v => String(v));
        if (nums.length > 0) out[arg] = nums;
    }
    return Object.keys(out).length > 0 ? out : null;
}

function adoptParticipant(node) {
    if (!node || typeof node !== 'object') return null;
    const name = (node.name || '').trim();
    if (!name) return null;

    const catalog = state.codebaseCatalog;
    const byFqn = (catalog && Array.isArray(catalog.types))
        ? Object.fromEntries(catalog.types.map(t => [t.fqn, t]))
        : {};

    const existingFqn = (node.existingFqn || '').trim() || null;
    const catalogType = existingFqn ? byFqn[existingFqn] : null;

    let methods;
    let purpose;
    let implByDefault;
    let signatureConflicts = [];

    if (catalogType) {
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
                const added = makeMethod(bname, inputs, b.returns || '', adoptCases(b.cases), adoptBoundaries(b.boundaries));
                added.isProposed = true;
                methods.push(added);
            } else {
                // AI's behavior overlaps a real method — compare signatures and
                // flag any mismatch. We keep the catalog version; the user can
                // resolve in Step 4.
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
        methods = (node.behaviors || []).map(b => {
            const inputs = (b.args || [])
                .filter(a => a && (a.name || a.type))
                .map(a => ({ name: a.name || '', type: a.type || '' }));
            const m = makeMethod(b.name || '', inputs, b.returns || '', adoptCases(b.cases), adoptBoundaries(b.boundaries));
            m.isProposed = false;
            return m;
        });
        purpose = (node.purpose || '').trim();
        implByDefault = true;
    }

    // Classify kind for the participant model. The chip is a reader hint;
    // the .puml composer emits all three the same way (bare or @class).
    //   reuse        — bound to an existing catalog type
    //   leaf         — terminal (analyzer marked isLeaf: true)
    //   orchestrator — non-leaf custom abstraction
    let kind;
    if (existingFqn) kind = 'reuse';
    else if (node.isLeaf === true) kind = 'leaf';
    else kind = 'orchestrator';

    // Capture analyzer-supplied metadata. operationalPrinciple + invariants
    // are declared-only (rendered, not checked); per-method touches are
    // kept as design metadata even though no rule engine reads them now
    // (the analyzer self-applies R4a before emitting).
    const operationalPrinciple = (node.operationalPrinciple || '').trim();
    const invariants = Array.isArray(node.invariants)
        ? node.invariants.map(s => (s || '').toString().trim()).filter(Boolean)
        : [];
    const behaviorsByName = Object.fromEntries((node.behaviors || []).map(b => [b && b.name, b]));
    methods.forEach(m => {
        const src = behaviorsByName[m.name];
        m.touches = (src && Array.isArray(src.touches))
            ? src.touches
                .filter(t => t && t.entity)
                .map(t => ({
                    entity: (t.entity || '').trim(),
                    fields: Array.isArray(t.fields) ? t.fields.map(f => (f || '').toString().trim()).filter(Boolean) : [],
                    mode: (t.mode || 'read').toString().trim().toLowerCase()
                }))
            : [];
    });

    return {
        id: newId(),
        name,
        implByDefault,
        methods,
        purpose,
        operationalPrinciple,
        invariants,
        existingFqn,
        signatureConflicts,
        kind,
        acIndices: Array.isArray(node.acIndices)
            ? node.acIndices.filter(i => Number.isInteger(i) && i >= 0)
            : []
    };
}

function findParticipant(id) { return state.participants.find(p => p.id === id); }
function findMethod(participantId, methodId) {
    const p = findParticipant(participantId);
    return p ? p.methods.find(m => m.id === methodId) : null;
}

// True when an entity is callable from a sequence arrow: interface or
// sealed-interface with at least one declared behavior. Pure sum types
// (sealed with empty behaviors), records, enums, and classes are not
// callable from a sequence.
function isPolyCallableEntity(e) {
    if (!e) return false;
    if (e.kind !== 'interface' && e.kind !== 'sealed-interface') return false;
    return Array.isArray(e.behaviors) && e.behaviors.some(b => b && b.name);
}

// Unified callee resolver — checks participants first, then poly-callable
// entities. Callers remain participant-only (see usages in resolveCreates
// and emitPlantUml).
function findCallee(id) {
    return state.participants.find(p => p.id === id)
        || state.entities.find(e => e.id === id && isPolyCallableEntity(e))
        || null;
}

// For entity callees the behavior has no stable id; we store the behavior
// NAME in step.methodId. findCalleeMethod resolves both shapes uniformly.
// Returns null when nothing matches.
function findCalleeMethod(calleeId, methodId) {
    const p = state.participants.find(x => x.id === calleeId);
    if (p) return p.methods.find(m => m.id === methodId) || null;
    const e = state.entities.find(x => x.id === calleeId);
    if (e && isPolyCallableEntity(e)) {
        return (e.behaviors || []).find(b => b && b.name === methodId) || null;
    }
    return null;
}

// Bridge participant-method shape ({inputs, output}) with entity-behavior
// shape ({args, returns}) so the signature helpers below treat them
// uniformly. Returns a method-shaped view; the original is unmodified.
function normalizeMethodLike(m) {
    if (!m) return null;
    return {
        name: m.name,
        inputs: m.inputs || m.args || [],
        output: m.output || m.returns || ''
    };
}

function methodSignature(m) {
    const n = normalizeMethodLike(m); if (!n) return '?()';
    const inputs = (n.inputs || []).map(i => `${i.name || ''}${i.type ? ': ' + i.type : ''}`.trim()).filter(Boolean).join(', ');
    return `${n.name || '?'}(${inputs})`;
}

function methodPreviewSignature(m) {
    const n = normalizeMethodLike(m); if (!n) return '?() → void';
    const types = (n.inputs || []).map(i => (i.type || '').trim()).filter(Boolean).join(', ');
    const out = (n.output || '').trim() || 'void';
    return `${n.name || '?'}(${types}) → ${out}`;
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
    const n = normalizeMethodLike(m);
    if (!n || !n.output || n.output.trim() === '' || n.output.trim().toLowerCase() === 'void') return null;
    return n.output.trim();
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
        // Polymorphic dispatch into an entity does not introduce a new
        // participant lifeline — the entity is already declared in the
        // entity prelude. Skip create-detection on entity callees.
        if (state.entities.find(e => e.id === s.calleeId)) { map.set(s.id, null); continue; }
        const method = findCalleeMethod(s.calleeId, s.methodId);
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
    if (step2Els.storyInput && step2Els.storyInput.value !== (state.storyRaw || '')) {
        step2Els.storyInput.value = state.storyRaw || '';
    }
    renderAcRows();
    updateAnalyzeGate();
    populateTypesDatalist();
    renderStoryNarrative();
    renderParticipants();
    mergeDerivedEntities();
    renderEntities();
    renderSequence();
}

async function runAnalyze(context) {
    // Every Analyze starts from a clean slate — the prior refusal (if any)
    // is no longer load-bearing as soon as the user asks for a fresh design.
    state.validatorRefused = false;
    hidePluginRefusal();
    state.analyzing = true;
    state.analyzeError = null;
    showAnalyzeBanner('Analysing your story…', { spinning: true });
    const t0 = performance.now();
    const elapsed = () => Math.round((performance.now() - t0) / 1000);
    const heartbeat = setInterval(() => {
        console.info(`[wizard] still working… ${elapsed()}s elapsed`);
    }, 10000);
    try {
        // Drop empty AC rows so the prompt only includes meaningful criteria.
        const ac = (state.ac || []).filter(r =>
            (r.given || '').trim() || (r.when || '').trim() || (r.then || '').trim());
        const model = (document.getElementById('analyze-model') || {}).value || null;
        console.info(`[wizard] POST /api/analyze — model=${model || 'default'}, story=${(context || '').length} chars, ac=${ac.length} rows`);
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context, catalog: state.codebaseCatalog, acceptanceCriteria: ac, model })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Analyze failed (${res.status})`);
        // Analyser contract: {sut, participants, story, entities}.
        const rawParticipants = Array.isArray(data && data.participants) ? data.participants : [];
        console.info(`[wizard] analyzer done in ${elapsed()}s — ${rawParticipants.length} participants, ${Array.isArray(data && data.entities) ? data.entities.length : 0} entities`);
        const story = (data && data.story) || '';
        state.story = story;
        state.participants = rawParticipants.map(adoptParticipant).filter(Boolean);
        state.sutName = (data && data.sut && String(data.sut).trim())
            || (state.participants[0] && state.participants[0].name)
            || '';
        // Now that we know the SUT + collaborators, re-derive the target
        // package using the callee-anchored heuristic. Only fires if the
        // user hasn't typed a custom value yet.
        maybeRefreshTargetPackage();
        const aiEntities = Array.isArray(data && data.entities) ? data.entities : [];
        state.entities = aiEntities.map(adoptEntity).filter(e => e && e.name);
        // Persist the analyzer's variancePlan as-is — used by the export step
        // to auto-emit resolver decision-table sidecars. Empty array when the
        // AC has no variance.
        state.variancePlan = Array.isArray(data && data.variancePlan) ? data.variancePlan : [];
        mergeDerivedEntities();
        renderStoryNarrative();
        renderParticipants();
        renderEntities();
        renderSequence();

        // Chain straight into sequence composition + plugin validation.
        // Three-phase LLM flow: analyse → compose → validate. One feedback
        // retry on the sequencer if the validator refuses; if it refuses
        // again, surface the refusal panel and stop. The banner narrates
        // each phase across the single continuous progress indicator.
        if (state.participants.length > 0) {
            const ok1 = await runSequence();
            if (!ok1) return;
            // Auto-mark the SUT (the analyzer's `sut` field, matched by
            // name) so the entry interaction [*] -> SUT is auto-managed.
            // Falls back to the first participant if the name doesn't
            // resolve. User can unmark via the SUT chip.
            const sut = state.sutName
                ? state.participants.find(p => p.name === state.sutName)
                : null;
            setSut((sut || state.participants[0]).id);

            // setSut only auto-adds the [*] entry/return rows when the SUT
            // has exactly one method; with 2+ it waits for the user to pick.
            // The validator refuses any .puml without an entry interaction,
            // so default to the SUT's first method (the analyzer lists the
            // entry-point method first) — the user can re-pick afterwards.
            const sutP = findParticipant(state.sutParticipantId);
            const hasEntry = state.sequence.some(s =>
                s.kind === STEP_KIND.CALL && isSystemCaller(s.callerId));
            if (!hasEntry && sutP && (sutP.methods || []).length > 0) {
                addSystemCallerStepsFor(sutP.id, sutP.methods[0].id);
                console.info(`[wizard] SUT has ${sutP.methods.length} methods — defaulted entry to ${sutP.methods[0].name}()`);
                renderSequence();
            }

            // Phase 3: validate against the codegen plugin. One retry on refusal.
            showAnalyzeBanner('Validating the design…', { spinning: true });
            let result = await runValidator();
            if (result && result.refused) {
                showAnalyzeBanner('Refining the sequence…', { spinning: true });
                const ok2 = await runSequence(result.message);
                if (!ok2) return;
                showAnalyzeBanner('Validating the design…', { spinning: true });
                result = await runValidator();
                if (result && result.refused) {
                    state.validatorRefused = true;
                    hideAnalyzeBanner();
                    showPluginRefusal(result.message);
                    return;
                }
            }
            hideAnalyzeBanner();
            console.info(`[wizard] analyze chain complete in ${elapsed()}s`);
        } else {
            hideAnalyzeBanner();
        }
    } catch (err) {
        state.analyzeError = err.message;
        console.error(`[wizard] analyze failed after ${elapsed()}s: ${err.message}`);
        showAnalyzeBanner(
            'Couldn\'t suggest abstractions: ' + err.message + '. Add participants manually below.',
            { spinning: false, error: true, dismissable: true }
        );
    } finally {
        clearInterval(heartbeat);
        state.analyzing = false;
    }
}

function showAnalyzeBanner(text, opts = {}) {
    // Mirror every phase transition to the console so long LLM calls are
    // observable without watching the server log.
    console.info(`[wizard] ${text}`);
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

    // Callee lookup parallel to findParticipantByName, but also resolves
    // to a poly-callable entity (interface / sealed-interface with
    // behaviors). Callers stay participant-only.
    function findCalleeByName(name) {
        if (!name) return null;
        return state.participants.find(p => p.name === name)
            || state.entities.find(e => e.name === name && isPolyCallableEntity(e))
            || null;
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
            if (fragKind === 'alt') {
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
            const callee = findCalleeByName(s.callee);
            if (!callee) {
                warnings.push(`Dropped call to unknown participant or entity "${s.callee}"`);
                continue;
            }
            // Branch on whether the callee is a participant (methods are
            // mutable; we can invent a new one if needed) or an entity
            // (behaviors are part of the entity contract — never invent).
            let method;
            if (callee.methods) {
                method = findOrCreateMethod(callee, s.method, s.args, s.returns);
                if (!method) {
                    warnings.push(`Dropped call to ${callee.name}: no method name given`);
                    continue;
                }
            } else {
                if (!s.method) {
                    warnings.push(`Dropped call to ${callee.name}: no method name given`);
                    continue;
                }
                method = (callee.behaviors || []).find(b => b && b.name === s.method);
                if (!method) {
                    warnings.push(`Dropped call to ${callee.name}: no behavior "${s.method}" on this entity`);
                    continue;
                }
            }
            seq.push({
                id: newId(),
                kind: STEP_KIND.CALL,
                callerId: caller.id,
                calleeId: callee.id,
                // Participant methods have a stable id; entity behaviors
                // are identified by name (Option A — see findCalleeMethod).
                methodId: method.id || method.name
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

async function runSequence(refusalFeedback = null) {
    if (!state.userStory || state.participants.length === 0) {
        hideAnalyzeBanner();
        return false;
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
            })),
            // Poly-callable entities (interface / sealed-interface with at
            // least one declared behavior) are valid arrow targets too,
            // so the sequencer can model polymorphic dispatch as a single
            // arrow instead of an alt-chain over variants.
            entities: state.entities.filter(isPolyCallableEntity).map(e => ({
                name: e.name,
                kind: e.kind,
                behaviors: (e.behaviors || []).filter(b => b && b.name).map(b => ({
                    name: b.name,
                    args: b.args || [],
                    returns: b.returns || ''
                })),
                permits: e.permits || []
            })),
            model: (document.getElementById('analyze-model') || {}).value || null,
            refusalFeedback: refusalFeedback || null
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
            return false;
        }
        applyResolvedSequence(resolved);
        // AI sequence composition can invent new methods on participants
        // (with their own type signatures) — re-derive so the entities
        // grid catches up.
        mergeDerivedEntities();
        renderParticipants();
        renderEntities();
        renderSequence();

        if (warnings.length > 0) {
            // Non-fatal — sequence is populated, just imperfect. Surface the
            // warnings but keep the success contract so the validator phase
            // can still run.
            showAnalyzeBanner(warnings.join(' · '), { spinning: false, error: true, dismissable: true });
        }
        return true;
    } catch (err) {
        showAnalyzeBanner(
            "Couldn't compose the sequence: " + err.message + '. Add steps manually if needed.',
            { spinning: false, error: true, dismissable: true }
        );
        return false;
    }
}

// --- Plugin validator (chained at the end of runAnalyze) ---
//
// Asks the codegen plugin's Step 1 (--validate-only) whether the in-progress
// .puml would be refused. Three outcomes from the server:
//   {refused: false}              → ok
//   {refused: false, error: ...}  → transport failure; soft-pass (Step 4 will
//                                   surface real generator errors anyway)
//   {refused: true, message}      → plugin refused; caller decides retry
// We never throw — failures are advisory at the wizard level.
async function runValidator() {
    if (!state.projectPath) return { ok: true };
    try {
        const res = await fetch('/api/generator/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: state.projectPath,
                puml: emitPlantUml(),
                model: 'claude-haiku-4-5'
            })
        });
        const body = await res.json().catch(() => ({}));
        if (body && body.refused === true) {
            return { refused: true, message: body.message || '(no message from plugin)' };
        }
        if (body && body.error) {
            console.warn('validator transport failure:', body.error);
        }
        return { ok: true };
    } catch (err) {
        console.warn('runValidator failed:', err);
        return { ok: true };
    }
}

// --- Story narrative ---
//
// The analyser returns {sut, participants, story, entities}. The story is
// a prose narrative rendered above the participant cards — coloured per
// participant so the user can follow the link from "name in the paragraph"
// to "card below".

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

// Compute the variance-axis count for a single participant, derived
// from the AC rows the analyzer assigned to it via acIndices. Per the
// "Complexity budget per participant" rule in analyzer.md, an axis is
// a dimension that varies across the participant's AC subset:
//   - distinct `Given` patterns → one axis
//   - distinct `When`  patterns → one axis
// Both varying → 2 axes (the maximum within budget).
// Returns null when the participant carries no AC rows (chip suppressed).
function axesCoveredByParticipant(p) {
    const indices = (p && Array.isArray(p.acIndices)) ? p.acIndices : [];
    if (indices.length === 0) return null;
    const acRows = state.ac || [];
    const subset = indices.map(i => acRows[i]).filter(Boolean);
    if (subset.length === 0) return null;
    const norm = (s) => (s || '').toString().trim().toLowerCase();
    const givens = new Set(subset.map(r => norm(r.given)).filter(Boolean));
    const whens  = new Set(subset.map(r => norm(r.when)).filter(Boolean));
    const axes = (givens.size > 1 ? 1 : 0) + (whens.size > 1 ? 1 : 0);
    return { axes, scenarios: subset.length };
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
            kindChip = `<span class="pc-kind-chip kind-orchestrator" title="Non-leaf — internals are designed at this level alongside its collaborators">orchestrator</span>`;
            card.classList.add('is-orchestrator');
        } else if (p.kind === 'reuse') {
            kindChip = `<span class="pc-kind-chip kind-reuse" title="Bound to an existing class">reuse</span>`;
        } else if (p.kind === 'leaf') {
            kindChip = `<span class="pc-kind-chip kind-leaf" title="Terminal — pure function, stereotype boundary, or single platform method">leaf</span>`;
        }

        // Axes chip — surfaces the variance-axis count the participant
        // carries (derived from acIndices + state.ac). Only shown when the
        // participant carries at least one AC row. Per the 2-axis rule:
        // axes >= 3 lights up the warning style so the user can decompose
        // into a sub-design via the modal's kind selector.
        const axesInfo = axesCoveredByParticipant(p);
        let axesChip = '';
        if (axesInfo) {
            const label = `${axesInfo.axes} ${axesInfo.axes === 1 ? 'axis' : 'axes'}`;
            const warn = axesInfo.axes >= 3 ? ' is-warn' : '';
            const title = `${axesInfo.scenarios} acceptance criterion${axesInfo.scenarios === 1 ? '' : 'a'} across ${label} — ${axesInfo.axes >= 3 ? 'consider decomposing into a sub-design' : 'within the 2-axis budget'}`;
            axesChip = `<span class="pc-axes-chip${warn}" title="${escapeAttr(title)}">${label}</span>`;
        }

        // One-sentence purpose, surfaced from the analyzer (or user-typed
        // via the modal). Empty-state placeholder doubles as a discovery
        // hint that purpose is editable.
        const purposeText = (p.purpose || '').trim();
        const purposeRow = purposeText
            ? `<div class="pc-card-purpose" title="${escapeAttr(purposeText)}">${escapeHtml(purposeText)}</div>`
            : `<div class="pc-card-purpose is-empty">Click to describe what this does</div>`;

        // Jackson-style operational principle ("After X, then Y"). Declared-
        // only — no rule fires on it; rendered as muted italic under the
        // purpose so the reviewer reads scenarios, not just names.
        const opPrinciple = (p.operationalPrinciple || '').trim();
        const opPrincipleRow = opPrinciple
            ? `<div class="pc-card-op-principle" title="Operational principle (scenario)">${escapeHtml(opPrinciple)}</div>`
            : '';

        // Meyer/DbC-style invariants. Declared-only; rendered as a tiny
        // foldable so cards don't grow tall when invariants are present.
        const invariants = Array.isArray(p.invariants) ? p.invariants : [];
        const invariantsRow = invariants.length > 0
            ? `<details class="pc-card-invariants" onclick="event.stopPropagation()">
                  <summary>Promises (${invariants.length})</summary>
                  <ul>${invariants.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
               </details>`
            : '';

        card.innerHTML = `
            <div class="pc-card-head">
                <span class="pc-card-name">${escapeHtml(p.name || '(unnamed)')}</span>
                ${kindChip}
                ${axesChip}
                ${sutChip}
            </div>
            ${fqnChip}
            ${purposeRow}
            ${opPrincipleRow}
            <div class="pc-card-methods">
                ${p.methods.length === 0 ? '<span class="pc-card-empty">no methods</span>' : previewMethods}
                ${moreCount > 0 ? `<div class="pc-card-more">+${moreCount} more</div>` : ''}
            </div>
            ${invariantsRow}
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
        // Cross-highlight: hovering a card lights up only the AC rows it
        // carries. Lets the user verify which scenarios this participant
        // is responsible for at a glance.
        card.addEventListener('mouseenter', () => setParticipantHover(p.id));
        card.addEventListener('mouseleave', clearParticipantHover);
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

    // Keep the AC carrier chips + coverage indicator in sync with the
    // current participant set. Participants own the acIndices mapping;
    // adding / editing / removing one shifts coverage on the AC side.
    renderAcRows();
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
            msg = 'Bare participant in the .puml prelude — DisC will CREATE the interface + stub-impl; its collaborators are listed alongside it at this level.';
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
    // A participant edit can rename / add / remove method types, which
    // shifts what entities the design references. Re-derive so any new
    // type names get cards immediately.
    mergeDerivedEntities();
    renderParticipants();
    renderEntities();
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
    mergeDerivedEntities();
    renderParticipants();
    renderEntities();
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

// --- Entities (records / enums / classes) ---
//
// Parallel surface to participants: data types the design passes around.
// state.entities is populated by the analyzer's entities[] response and
// augmented by mergeDerivedEntities() which scans participant signatures
// for any names the AI missed. Cards are smaller than participant cards
// (no SUT chip, no sequence colour); clicking opens the entity modal.

const entityEls = {
    section: document.getElementById('entities-section'),
    list: document.getElementById('entities-list'),
    count: document.getElementById('entities-count'),
    modal: document.getElementById('entity-modal'),
    modalTitle: document.getElementById('entity-modal-title'),
    modalName: document.getElementById('entity-modal-name'),
    modalKind: document.getElementById('entity-modal-kind'),
    modalPurpose: document.getElementById('entity-modal-purpose'),
    modalFqn: document.getElementById('entity-modal-fqn'),
    modalFieldsField: document.getElementById('entity-modal-fields-field'),
    modalFields: document.getElementById('entity-modal-fields'),
    modalFieldsCount: document.getElementById('entity-modal-fields-count'),
    modalAddField: document.getElementById('entity-modal-add-field'),
    modalValuesField: document.getElementById('entity-modal-values-field'),
    modalValues: document.getElementById('entity-modal-values'),
    modalValuesCount: document.getElementById('entity-modal-values-count'),
    modalAddValue: document.getElementById('entity-modal-add-value'),
    modalBehaviorsField: document.getElementById('entity-modal-behaviors-field'),
    modalBehaviors: document.getElementById('entity-modal-behaviors'),
    modalBehaviorsCount: document.getElementById('entity-modal-behaviors-count'),
    modalAddBehavior: document.getElementById('entity-modal-add-behavior'),
    modalPermitsField: document.getElementById('entity-modal-permits-field'),
    modalPermits: document.getElementById('entity-modal-permits'),
    modalDelete: document.getElementById('entity-modal-delete'),
    modalDone: document.getElementById('entity-modal-done'),
    modalClose: document.getElementById('entity-modal-close')
};

let entityModalId = null;

function findEntity(id) {
    return state.entities.find(e => e.id === id) || null;
}

function renderEntities() {
    if (!entityEls.list) return;
    if (!state.entities.length) {
        entityEls.section.classList.add('hidden');
        entityEls.list.innerHTML = '';
        if (entityEls.count) entityEls.count.textContent = '0 types';
        return;
    }
    entityEls.section.classList.remove('hidden');
    if (entityEls.count) {
        const n = state.entities.length;
        entityEls.count.textContent = `${n} type${n === 1 ? '' : 's'}`;
    }

    entityEls.list.innerHTML = '';
    for (const e of state.entities) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `ec-card kind-${e.kind}`;
        if (e.existingFqn) card.classList.add('is-reused');
        card.dataset.id = e.id;

        const provenance = e.existingFqn
            ? `<span class="ec-provenance-chip is-reuse" title="Existing type in your project — the plugin won't codegen this">REUSE</span>`
            : `<span class="ec-provenance-chip is-new" title="New type — the plugin will codegen the source from these fields">NEW</span>`;

        const kindChip = `<span class="ec-kind-chip kind-${e.kind}" title="${e.kind}">${escapeHtml(e.kind)}</span>`;

        const fqnRow = e.existingFqn
            ? `<div class="ec-fqn-chip" title="${escapeHtml(e.existingFqn)}">${escapeHtml(e.existingFqn)}</div>`
            : '';

        const purposeText = (e.purpose || '').trim();
        const purposeRow = purposeText
            ? `<div class="ec-card-purpose" title="${escapeAttr(purposeText)}">${escapeHtml(purposeText)}</div>`
            : `<div class="ec-card-purpose is-empty">Click to describe what this carries</div>`;

        let bodyRow = '';
        let permitsRow = '';
        if (e.existingFqn) {
            bodyRow = `<div class="ec-card-fields is-reused-note">defers to existing source</div>`;
        } else if (e.kind === 'enum') {
            const preview = (e.values || []).slice(0, 4).map(v => escapeHtml(v)).join('<br>');
            const more = (e.values || []).length - 4;
            bodyRow = (e.values && e.values.length)
                ? `<div class="ec-card-fields">${preview}${more > 0 ? `<div class="ec-card-more">+${more} more</div>` : ''}</div>`
                : `<div class="ec-card-fields ec-card-empty">no values yet</div>`;
        } else if (e.kind === 'interface' || e.kind === 'sealed-interface') {
            const behaviors = (e.behaviors || []).filter(b => b && b.name);
            const preview = behaviors.slice(0, 4).map(b => {
                const args = (b.args || [])
                    .map(a => `${escapeHtml(a.name || '?')}: ${escapeHtml(a.type || '?')}`)
                    .join(', ');
                const ret = escapeHtml((b.returns || 'void').trim() || 'void');
                return `${escapeHtml(b.name)}(${args}) → ${ret}`;
            }).join('<br>');
            const more = behaviors.length - 4;
            bodyRow = behaviors.length
                ? `<div class="ec-card-fields">${preview}${more > 0 ? `<div class="ec-card-more">+${more} more</div>` : ''}</div>`
                : `<div class="ec-card-fields ec-card-empty">no behaviours yet</div>`;
            if (e.kind === 'sealed-interface') {
                const permits = (e.permits || []).filter(Boolean);
                permitsRow = permits.length
                    ? `<div class="ec-permits-row" title="permits ${escapeAttr(permits.join(', '))}"><span class="ec-permits-label">permits:</span> ${permits.map(p => `<span class="ec-permit-tag">${escapeHtml(p)}</span>`).join(' ')}</div>`
                    : `<div class="ec-permits-row is-empty">no variants permitted yet</div>`;
            }
        } else {
            const preview = (e.fields || []).slice(0, 4).map(f =>
                `${escapeHtml(f.name || '?')}: ${escapeHtml(f.type || '?')}`
            ).join('<br>');
            const more = (e.fields || []).length - 4;
            bodyRow = (e.fields && e.fields.length)
                ? `<div class="ec-card-fields">${preview}${more > 0 ? `<div class="ec-card-more">+${more} more</div>` : ''}</div>`
                : `<div class="ec-card-fields ec-card-empty">no fields yet</div>`;
        }

        card.innerHTML = `
            <div class="ec-card-head">
                <span class="ec-card-name">${escapeHtml(e.name || '(unnamed)')}</span>
                ${kindChip}
                ${provenance}
            </div>
            ${fqnRow}
            ${purposeRow}
            ${bodyRow}
            ${permitsRow}
        `;
        card.addEventListener('click', () => openEntityModal(e.id));
        entityEls.list.appendChild(card);
    }
}

function openEntityModal(id) {
    entityModalId = id;
    const e = findEntity(id);
    if (!e) return;
    entityEls.modalTitle.textContent = e.name ? `Edit ${e.name}` : 'New type';
    entityEls.modalName.value = e.name || '';
    entityEls.modalKind.value = e.kind || 'record';
    entityEls.modalPurpose.value = e.purpose || '';
    entityEls.modalFqn.value = e.existingFqn || '';
    syncEntityModalKind();
    renderEntityFields();
    renderEntityValues();
    renderEntityBehaviors();
    renderEntityPermits();
    entityEls.modal.classList.remove('hidden');
    setTimeout(() => entityEls.modalName.focus(), 0);
}

function closeEntityModal() {
    if (!entityModalId) return;
    const e = findEntity(entityModalId);
    if (e && !e.name.trim()) {
        // discard empty entity on close
        state.entities = state.entities.filter(x => x.id !== e.id);
    }
    entityModalId = null;
    entityEls.modal.classList.add('hidden');
    mergeDerivedEntities();
    renderEntities();
}

// Toggle which body section is visible based on the current kind. Reuse
// (FQN bound) hides all authoring bodies — the existing source is the
// source of truth and the plugin won't codegen.
function syncEntityModalKind() {
    const kind = entityEls.modalKind.value;
    const isReuse = (entityEls.modalFqn.value || '').trim().length > 0;
    const showFields = !isReuse && (kind === 'record' || kind === 'class');
    const showValues = !isReuse && kind === 'enum';
    const showBehaviors = !isReuse && (kind === 'interface' || kind === 'sealed-interface');
    const showPermits = !isReuse && kind === 'sealed-interface';
    entityEls.modalFieldsField.classList.toggle('hidden', !showFields);
    entityEls.modalValuesField.classList.toggle('hidden', !showValues);
    if (entityEls.modalBehaviorsField) {
        entityEls.modalBehaviorsField.classList.toggle('hidden', !showBehaviors);
    }
    if (entityEls.modalPermitsField) {
        entityEls.modalPermitsField.classList.toggle('hidden', !showPermits);
    }
}

function renderEntityFields() {
    const e = findEntity(entityModalId);
    if (!e) return;
    entityEls.modalFields.innerHTML = '';
    (e.fields || []).forEach((f, idx) => {
        const row = document.createElement('div');
        row.className = 'entity-field-row';
        row.innerHTML = `
            <input type="text" class="ef-name" placeholder="fieldName" value="${escapeAttr(f.name || '')}">
            <span class="ef-sep">:</span>
            <input type="text" class="ef-type" list="types-datalist" placeholder="Type" value="${escapeAttr(f.type || '')}">
            <button type="button" class="ef-remove" aria-label="Remove field">×</button>
        `;
        row.querySelector('.ef-name').addEventListener('input', ev => {
            e.fields[idx].name = ev.target.value;
        });
        row.querySelector('.ef-type').addEventListener('input', ev => {
            e.fields[idx].type = ev.target.value;
        });
        row.querySelector('.ef-remove').addEventListener('click', () => {
            e.fields.splice(idx, 1);
            renderEntityFields();
        });
        entityEls.modalFields.appendChild(row);
    });
    entityEls.modalFieldsCount.textContent = String((e.fields || []).length);
}

function renderEntityValues() {
    const e = findEntity(entityModalId);
    if (!e) return;
    entityEls.modalValues.innerHTML = '';
    (e.values || []).forEach((v, idx) => {
        const row = document.createElement('div');
        row.className = 'entity-value-row';
        row.innerHTML = `
            <input type="text" class="ev-name" placeholder="VALUE_NAME" value="${escapeAttr(v || '')}">
            <button type="button" class="ev-remove" aria-label="Remove value">×</button>
        `;
        row.querySelector('.ev-name').addEventListener('input', ev => {
            e.values[idx] = ev.target.value;
        });
        row.querySelector('.ev-remove').addEventListener('click', () => {
            e.values.splice(idx, 1);
            renderEntityValues();
        });
        entityEls.modalValues.appendChild(row);
    });
    entityEls.modalValuesCount.textContent = String((e.values || []).length);
}

// Render the behavior editor (interface / sealed-interface): rows of
// { name, args[], returns } — same shape as participant methods but with
// the analyzer's field names (args / returns vs inputs / output). Each
// row clones the participant method-block aesthetic for visual parity.
function renderEntityBehaviors() {
    if (!entityEls.modalBehaviors) return;
    const e = findEntity(entityModalId);
    if (!e) return;
    entityEls.modalBehaviors.innerHTML = '';
    (e.behaviors || []).forEach((b, idx) => {
        entityEls.modalBehaviors.appendChild(renderEntityBehaviorRow(e, b, idx));
    });
    if (entityEls.modalBehaviorsCount) {
        entityEls.modalBehaviorsCount.textContent = String((e.behaviors || []).length);
    }
}

function renderEntityBehaviorRow(entity, behavior, idx) {
    const row = document.createElement('div');
    row.className = 'method-block';

    const head = document.createElement('div');
    head.className = 'mb-head';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'mb-name';
    name.placeholder = 'operation';
    name.value = behavior.name || '';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn mb-remove';
    remove.title = 'Remove behavior';
    remove.textContent = '×';
    head.append(name, remove);

    const inRow = document.createElement('div');
    inRow.className = 'mb-row';
    const inTag = document.createElement('span');
    inTag.className = 'io-tag';
    inTag.textContent = 'in';
    const argsWrap = document.createElement('div');
    argsWrap.className = 'mb-inputs';
    inRow.append(inTag, argsWrap);

    const renderArgs = () => {
        argsWrap.innerHTML = '';
        const args = behavior.args || [];
        if (args.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'mb-empty';
            empty.textContent = '(no parameters)';
            argsWrap.appendChild(empty);
        } else {
            args.forEach((arg, i) => {
                const pair = document.createElement('span');
                pair.className = 'param-pair';
                pair.innerHTML = `
                    <input type="text" class="p-name" placeholder="name" value="${escapeHtml(arg.name || '')}">
                    <input type="text" class="p-type" list="types-datalist" placeholder="type" value="${escapeHtml(arg.type || '')}">
                    <button type="button" class="icon-btn p-remove" title="Remove parameter">×</button>
                `;
                const [pn, pt] = pair.querySelectorAll('input');
                pn.addEventListener('input', ev => { args[i].name = ev.target.value; });
                pt.addEventListener('input', ev => { args[i].type = ev.target.value; });
                pair.querySelector('.p-remove').addEventListener('click', () => {
                    args.splice(i, 1);
                    renderArgs();
                });
                argsWrap.appendChild(pair);
            });
        }
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'mb-add-param';
        add.textContent = '+ parameter';
        add.addEventListener('click', () => {
            if (!Array.isArray(behavior.args)) behavior.args = [];
            behavior.args.push({ name: '', type: '' });
            renderArgs();
        });
        argsWrap.appendChild(add);
    };
    renderArgs();

    const outRow = document.createElement('div');
    outRow.className = 'mb-row';
    const outTag = document.createElement('span');
    outTag.className = 'io-tag out';
    outTag.textContent = 'out';
    const ret = document.createElement('input');
    ret.type = 'text';
    ret.className = 'mb-output';
    ret.setAttribute('list', 'types-datalist');
    ret.placeholder = 'void';
    ret.value = behavior.returns || '';
    outRow.append(outTag, ret);

    name.addEventListener('input', ev => { behavior.name = ev.target.value; });
    ret.addEventListener('input', ev => { behavior.returns = ev.target.value; });
    remove.addEventListener('click', () => {
        entity.behaviors.splice(idx, 1);
        renderEntityBehaviors();
    });

    row.append(head, inRow, outRow);
    return row;
}

// Render the permits picker for a sealed-interface: a checkbox list of
// every other entity whose kind is record (or class). Selection updates
// entity.permits[] by name. Permits resolve by NAME because the plugin
// contract uses names (not ids), and round-trip through .puml carries
// only names.
function renderEntityPermits() {
    if (!entityEls.modalPermits) return;
    const e = findEntity(entityModalId);
    if (!e) return;
    entityEls.modalPermits.innerHTML = '';
    const candidates = state.entities.filter(other =>
        other.id !== e.id
        && (other.kind === 'record' || other.kind === 'class')
        && (other.name || '').trim().length > 0
    );
    if (candidates.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'entity-permits-empty';
        empty.textContent = 'No record / class entities to permit yet. Create the variants first.';
        entityEls.modalPermits.appendChild(empty);
        return;
    }
    const selected = new Set(e.permits || []);
    candidates.forEach(other => {
        const label = document.createElement('label');
        label.className = 'entity-permit-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = other.name;
        cb.checked = selected.has(other.name);
        cb.addEventListener('change', () => {
            if (!Array.isArray(e.permits)) e.permits = [];
            const idx = e.permits.indexOf(other.name);
            if (cb.checked && idx < 0) e.permits.push(other.name);
            if (!cb.checked && idx >= 0) e.permits.splice(idx, 1);
        });
        const nameSpan = document.createElement('span');
        nameSpan.className = 'entity-permit-name';
        nameSpan.textContent = other.name;
        const kindChip = document.createElement('span');
        kindChip.className = `entity-permit-kind kind-${other.kind}`;
        kindChip.textContent = other.kind;
        label.append(cb, nameSpan, kindChip);
        entityEls.modalPermits.appendChild(label);
    });
}

entityEls.modalName.addEventListener('input', () => {
    const e = findEntity(entityModalId);
    if (e) e.name = entityEls.modalName.value;
});
entityEls.modalKind.addEventListener('change', () => {
    const e = findEntity(entityModalId);
    if (!e) return;
    e.kind = entityEls.modalKind.value;
    syncEntityModalKind();
    // The newly-visible section needs its rows rendered (the lists
    // persist across kind switches — switching is a silent reset only
    // visually; underlying arrays keep their content).
    renderEntityBehaviors();
    renderEntityPermits();
});
entityEls.modalPurpose.addEventListener('input', () => {
    const e = findEntity(entityModalId);
    if (e) e.purpose = entityEls.modalPurpose.value;
});
entityEls.modalFqn.addEventListener('input', () => {
    const e = findEntity(entityModalId);
    if (!e) return;
    const v = entityEls.modalFqn.value.trim();
    e.existingFqn = v || null;
    syncEntityModalKind();
});
entityEls.modalAddField.addEventListener('click', () => {
    const e = findEntity(entityModalId);
    if (!e) return;
    e.fields.push({ name: '', type: '' });
    renderEntityFields();
});
entityEls.modalAddValue.addEventListener('click', () => {
    const e = findEntity(entityModalId);
    if (!e) return;
    e.values.push('');
    renderEntityValues();
});
if (entityEls.modalAddBehavior) {
    entityEls.modalAddBehavior.addEventListener('click', () => {
        const e = findEntity(entityModalId);
        if (!e) return;
        if (!Array.isArray(e.behaviors)) e.behaviors = [];
        e.behaviors.push({ name: '', args: [], returns: 'void' });
        renderEntityBehaviors();
    });
}
entityEls.modalDelete.addEventListener('click', () => {
    if (!entityModalId) return;
    state.entities = state.entities.filter(x => x.id !== entityModalId);
    entityModalId = null;
    entityEls.modal.classList.add('hidden');
    renderEntities();
});
entityEls.modalDone.addEventListener('click', closeEntityModal);
entityEls.modalClose.addEventListener('click', closeEntityModal);
entityEls.modal.addEventListener('click', (e) => {
    if (e.target === entityEls.modal) closeEntityModal();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !entityEls.modal.classList.contains('hidden')) closeEntityModal();
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
    // Re-validate against current cast — drop refs to deleted entities.
    // Caller must be a participant; callee may also be a poly-callable entity.
    if (addStepDraft.callerId && !findParticipant(addStepDraft.callerId)) addStepDraft.callerId = '';
    if (addStepDraft.calleeId && !findCallee(addStepDraft.calleeId)) addStepDraft.calleeId = '';
    if (addStepDraft.methodId && !findCalleeMethod(addStepDraft.calleeId, addStepDraft.methodId)) addStepDraft.methodId = '';

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
// Shape: { type: 'loop'|'while'|'foreach'|'alt'|'opt', label: '' }
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
    const partOpts = state.participants
        .filter(p => p.id !== step.callerId)
        .map(p => ({
            value: p.id,
            label: p.name || '(unnamed)',
            sig: (p.methods || []).length === 0 ? 'no methods' : ''
        }));
    const entOpts = state.entities
        .filter(isPolyCallableEntity)
        .map(e => ({
            value: e.id,
            label: e.name || '(unnamed)',
            sig: e.kind   // 'interface' or 'sealed-interface'
        }));
    const options = [...partOpts, ...entOpts];
    openPillPopover(anchorEl, options, step.calleeId, (value) => {
        step.calleeId = value;
        // Drop methodId if the new callee doesn't expose the current method.
        if (!findCalleeMethod(value, step.methodId)) step.methodId = '';
        renderSequence();
    }, 'No callees available — add a participant or a polymorphic entity');
}

function openMethodPopover(stepId, anchorEl) {
    const step = state.sequence.find(s => s.id === stepId);
    if (!step) return;
    const callee = findCallee(step.calleeId);
    // Participant methods have ids; entity behaviors don't — fall back to
    // the behavior name as the option value so findCalleeMethod can
    // resolve it later.
    const sourceList = callee ? (callee.methods || callee.behaviors || []) : [];
    const options = sourceList.filter(m => m && m.name).map(m => ({
        value: m.id || m.name,
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
            const elseLabel = 'else if';
            row.innerHTML = `
                <span class="step-num frag-glyph" title="${escapeHtml(elseLabel)}">⇅</span>
                <div class="step-lines">
                    <div class="step-line">
                        <span class="frag-tag">else</span>
                        <input type="text" class="frag-label" placeholder="else condition" value="${escapeHtml(step.label || '')}">
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
        const callee = findCallee(call.calleeId);
        const method = findCalleeMethod(call.calleeId, call.methodId);
        if (!caller || !callee || !method) return;

        callIdx++;
        const callerName = caller.name || '(unnamed)';
        const calleeName = callee.name || '(unnamed)';
        const inputArgs = (normalizeMethodLike(method).inputs || []).map(i => i.name || i.type || '').filter(Boolean).join(', ');
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

    // A step needs at least one participant (caller) AND at least one
    // possible callee — another participant OR a poly-callable entity.
    const polyEntityCount = state.entities.filter(isPolyCallableEntity).length;
    const possibleCallees = (state.participants.length - 1) + polyEntityCount;
    if (state.participants.length === 0 || possibleCallees < 1) {
        const msg = document.createElement('div');
        msg.className = 'add-step-empty';
        msg.textContent = state.participants.length === 0
            ? 'Add at least one participant (the caller) to define a step.'
            : 'Add one more participant — or a polymorphic entity — so the caller has someone to call.';
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
    const calleeParticipantOpts = state.participants
        .filter(p => p.id !== addStepDraft.callerId)
        .map(p => `<option value="${p.id}" ${p.id === addStepDraft.calleeId ? 'selected' : ''}>${escapeHtml(p.name || '(unnamed)')}</option>`);
    const calleeEntityOpts = state.entities
        .filter(isPolyCallableEntity)
        .map(e => `<option value="${e.id}" ${e.id === addStepDraft.calleeId ? 'selected' : ''}>${escapeHtml(e.name || '(unnamed)')} · ${e.kind}</option>`);
    const calleeOptions = ['<option value="">callee</option>']
        .concat(calleeParticipantOpts, calleeEntityOpts)
        .join('');
    const callee = findCallee(addStepDraft.calleeId);
    const calleeMethodSource = callee ? (callee.methods || callee.behaviors || []) : [];
    const methodOptions = ['<option value="">method</option>']
        .concat(calleeMethodSource
            .filter(m => m && m.name)
            .map(m => {
                const v = m.id || m.name;
                return `<option value="${v}" ${v === addStepDraft.methodId ? 'selected' : ''}>${escapeHtml(m.name || '?')}</option>`;
            }))
        .join('');
    const method = findCalleeMethod(addStepDraft.calleeId, addStepDraft.methodId);
    const methodInputs = method ? (normalizeMethodLike(method).inputs || []) : [];
    const argsPreview = method ? methodInputs.map(i => i.name || i.type || '').filter(Boolean).join(', ') : '';
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

// Continue-to-Sign-off is pure navigation. The plugin pre-flight that used
// to live here has moved upstream into runAnalyze, so by the time the user
// reaches this button the design is either already validated or already
// known-refused (in which case state.validatorRefused gates the advance).
step2Els.flowNext.addEventListener('click', () => {
    if (state.sequence.length === 0) {
        step2Els.sequenceHint.classList.add('warn');
        return;
    }
    step2Els.sequenceHint.classList.remove('warn');
    if (state.validatorRefused) return;   // refusal panel is visible; user must re-Analyze
    goToStep(3);
});

function showPluginRefusal(message) {
    const panel = document.getElementById('plugin-refusal-panel');
    const body = document.getElementById('plugin-refusal-body');
    if (!panel || !body) return;
    body.textContent = message;
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    syncFlowNext();
}

function hidePluginRefusal() {
    const panel = document.getElementById('plugin-refusal-panel');
    const body = document.getElementById('plugin-refusal-body');
    if (panel) panel.classList.add('hidden');
    if (body) body.textContent = '';
    syncFlowNext();
}

// Continue-to-Sign-off is disabled while a refusal is on screen. The button
// also blocks the click handler internally — this is the primary visual cue.
function syncFlowNext() {
    if (!step2Els.flowNext) return;
    step2Els.flowNext.disabled = !!state.validatorRefused;
}

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

    // Entity prelude: declare every record / enum / class the design uses.
    // Emitted BEFORE the participant prelude so the .puml reads data-first
    // (matches the Step 2 UX). The DisC plugin reads the <<record>> /
    // <<enum>> / <<class>> stereotype to codegen Java source from the
    // field/value listing. REUSE entities (existingFqn set) emit only the
    // @class binding, no body — the plugin verifies the FQN resolves and
    // otherwise leaves the file alone.
    if (state.entities && state.entities.length > 0) {
        lines.push("' @disc-entities type declarations the participants pass around (record / enum / class / interface / sealed-interface)");
        for (const e of state.entities) {
            const name = (e.name || '').trim();
            if (!name) continue;
            const fqn = (e.existingFqn || '').trim();
            if (fqn) {
                lines.push(`class ${name} <<@class:${fqn}>>`);
                continue;
            }
            const allowed = new Set(['record', 'enum', 'class', 'interface', 'sealed-interface']);
            const kind = allowed.has(e.kind) ? e.kind : 'record';
            if (kind === 'enum') {
                const values = (e.values || []).map(v => (v || '').trim()).filter(Boolean);
                if (values.length === 0) {
                    lines.push(`class ${name} <<enum>>`);
                } else {
                    lines.push(`class ${name} <<enum>> {`);
                    for (const v of values) lines.push(`  + ${v}`);
                    lines.push('}');
                }
            } else if (kind === 'interface' || kind === 'sealed-interface') {
                const behaviors = (e.behaviors || []).filter(b => b && b.name);
                const stereoBits = [`<<${kind}>>`];
                // `<<@permits:>>` is valid on BOTH sealed-interface (Java
                // sealed family) AND plain interface (resolver strategy
                // family — plugin emits `class V implements Parent` per
                // permit, no `sealed` keyword). See plugin's java_spring.md.
                if (kind === 'sealed-interface' || kind === 'interface') {
                    const permits = (e.permits || []).filter(Boolean);
                    if (permits.length > 0) stereoBits.push(`<<@permits:${permits.join(',')}>>`);
                }
                const stereos = stereoBits.join(' ');
                if (behaviors.length === 0) {
                    lines.push(`class ${name} ${stereos}`);
                } else {
                    lines.push(`class ${name} ${stereos} {`);
                    for (const b of behaviors) {
                        const args = (b.args || [])
                            .map(a => `${(a.name || '').trim() || '_'}: ${(a.type || '').trim() || 'Object'}`)
                            .join(', ');
                        const ret = (b.returns || '').trim() || 'void';
                        lines.push(`  + ${b.name}(${args}): ${ret}`);
                    }
                    lines.push('}');
                }
            } else {
                const fields = (e.fields || []).filter(f => f && (f.name || f.type));
                if (fields.length === 0) {
                    lines.push(`class ${name} <<${kind}>>`);
                } else {
                    lines.push(`class ${name} <<${kind}>> {`);
                    for (const f of fields) {
                        const fname = (f.name || '').trim() || '_';
                        const ftype = (f.type || '').trim() || 'Object';
                        lines.push(`  + ${fname}: ${ftype}`);
                    }
                    lines.push('}');
                }
            }
        }
        lines.push('');  // blank line before the participant prelude
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
    for (const p of state.participants) {
        if (!referenced.has(p.id)) continue;
        const name = (p.name || '').trim();
        if (!name) continue;
        const fqn = (p.existingFqn || '').trim();
        const newMethods = (p.methods || []).filter(m => m.isProposed).map(m => '+' + m.name);
        let stereotype = '';
        if (fqn && newMethods.length > 0) {
            stereotype = ` <<@class:${fqn}, ${newMethods.join(', ')}>>`;
        } else if (fqn) {
            stereotype = ` <<@class:${fqn}>>`;
        }
        // Else: bare `participant Name` — DisC reads this as CREATE.
        // `kind === 'orchestrator'` is a reader hint only; collaborators are
        // listed alongside it at this level. Multi-level recursion is
        // parked (see TODO.md).
        preludeLines.push(`participant ${name}${stereotype}`);
    }
    if (preludeLines.length > 0) {
        lines.push("' @disc-classification CREATE (no stereotype), REUSE (@class), UPDATE (@class + +methods)");
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
        // Callee may be a participant OR a poly-callable entity (interface
        // / sealed-interface with behaviors). The entity prelude declared
        // it via `class Foo <<interface>>` so the arrow `caller -> Foo`
        // is a valid PlantUML sequence line.
        const callee = findCallee(s.calleeId);
        const method = findCalleeMethod(s.calleeId, s.methodId);
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
        const callee = findCallee(s.calleeId);
        const method = findCalleeMethod(s.calleeId, s.methodId);
        if (!caller || !callee || !method) continue;
        const fromName = caller.name || '(unnamed)';
        const toName = callee.name || '(unnamed)';
        if (!lifelines.includes(fromName)) lifelines.push(fromName);
        if (!lifelines.includes(toName)) lifelines.push(toName);
        const argText = (normalizeMethodLike(method).inputs || []).map(i => i.name || i.type || '').filter(Boolean).join(', ');
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
            const callee = findCallee(s.calleeId);
            const method = findCalleeMethod(s.calleeId, s.methodId);
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
    sequence: document.getElementById('review-sequence'),
    diff: document.getElementById('review-diff'),
    beforeBody: document.getElementById('review-before-body'),
    reasonsBlock: document.getElementById('review-reasons-block'),
    reasonsList: document.getElementById('review-reasons')
};

// --- Step 3 team-signoff gate ---

function syncSignoffUI() {
    const input = document.getElementById('signoff-team');
    const signed = !!state.teamSignedOff;
    if (input) input.checked = signed;

    const status = document.getElementById('signoff-status');
    if (status) {
        status.textContent = signed
            ? 'Team signoff received — ready to generate.'
            : 'Not yet signed off';
        status.classList.toggle('complete', signed);
    }
    const nextBtn = document.getElementById('preview-next');
    if (nextBtn) nextBtn.disabled = !signed;
}

function allSignedOff() {
    return !!state.teamSignedOff;
}

(() => {
    const input = document.getElementById('signoff-team');
    if (!input) return;
    input.addEventListener('change', (e) => {
        state.teamSignedOff = !!e.target.checked;
        syncSignoffUI();
    });
})();

// --- Step 3 design diff: before (what exists) vs after (under review) ---

// The entry under review: the SUT participant + the method the system-caller
// entry row targets. Null when no SUT/entry is set.
function resolveReviewEntry() {
    const sut = findParticipant(state.sutParticipantId);
    if (!sut) return null;
    const entry = (state.sequence || []).find(s =>
        s.kind === STEP_KIND.CALL && isSystemCaller(s.callerId));
    if (!entry) return null;
    const m = (sut.methods || []).find(mm => mm.id === entry.methodId);
    return m ? { sut, methodName: m.name } : null;
}

// "Why this design" — the analyzer's variancePlan, surfaced at review time
// instead of being used only for sidecar export. Hidden when no variance.
function renderReviewReasons() {
    if (!reviewEls.reasonsBlock || !reviewEls.reasonsList) return;
    const plans = (state.variancePlan || []).filter(v => v && v.axis);
    if (plans.length === 0) {
        reviewEls.reasonsBlock.classList.add('hidden');
        return;
    }
    reviewEls.reasonsBlock.classList.remove('hidden');
    reviewEls.reasonsList.innerHTML = '';
    for (const v of plans) {
        const li = document.createElement('li');
        const mapping = Array.isArray(v.mapping) && v.mapping.length
            ? ` <span class="muted">(${v.mapping.length} rule row${v.mapping.length === 1 ? '' : 's'})</span>`
            : '';
        li.innerHTML = `<b>${escapeHtml(v.axis)}</b> — <code>${escapeHtml(v.pattern || '?')}</code>: `
            + `${escapeHtml(v.rationale || '')}${mapping}`;
        reviewEls.reasonsList.appendChild(li);
    }
}

// Before = the current status of this feature. Brownfield (the entry method
// already exists in the connected project) → derive its what-IS slice
// server-side and draw it. Greenfield → a slim banner; everything after is
// new. Derive failures fall back to the banner — the review never blocks.
const reviewBeforeCache = Object.create(null);

function greenfieldBannerHtml() {
    const existing = [
        ...(state.participants || []).filter(p => p && p.existingFqn).map(p => p.existingFqn),
        ...(state.entities || []).filter(e => e && e.existingFqn).map(e => e.existingFqn)
    ];
    const builds = existing.length
        ? `<div class="review-before-reuse">Builds on existing: ${existing.map(f => `<code>${escapeHtml(f)}</code>`).join(', ')}</div>`
        : '';
    return `<div class="review-before-banner">Greenfield — this flow doesn't exist yet. Everything in the proposed design is new.${builds}</div>`;
}

function renderReviewBefore() {
    const body = reviewEls.beforeBody;
    if (!body || !reviewEls.diff) return;
    const showBanner = (extraNote) => {
        reviewEls.diff.classList.remove('has-before');
        body.innerHTML = greenfieldBannerHtml()
            + (extraNote ? `<div class="review-before-note muted">${escapeHtml(extraNote)}</div>` : '');
    };

    const entry = resolveReviewEntry();
    const catalog = state.codebaseCatalog;
    const fqn = entry && entry.sut.existingFqn ? entry.sut.existingFqn.trim() : null;
    const catalogType = (fqn && catalog && Array.isArray(catalog.types))
        ? catalog.types.find(t => t.fqn === fqn)
        : null;
    const existsInCode = !!(state.projectPath && catalogType
        && (catalogType.publicMethods || []).some(m => m.name === entry.methodName));
    if (!existsInCode) { showBanner(); return; }

    const key = `${state.projectPath}::${entry.sut.name}#${entry.methodName}`;
    const drawModel = (model) => {
        reviewEls.diff.classList.add('has-before');
        body.innerHTML = '';
        renderSeqSvg(model, body, '#64748b',
            { line: '#cbd5e1', ink: '#1f2937', muted: '#64748b', box: '#f1f5f9' });
    };
    const cached = reviewBeforeCache[key];
    if (cached) {
        if (cached.model) drawModel(cached.model);
        else showBanner(cached.note);
        return;
    }

    body.innerHTML = '<div class="muted">Deriving the current code…</div>';
    fetch('/api/code-derive-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            projectPath: state.projectPath,
            entryClass: entry.sut.name,
            entryMethod: entry.methodName
        })
    })
        .then(async res => {
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `derive failed (${res.status})`);
            reviewBeforeCache[key] = { model: data.sliceModel };
            drawModel(data.sliceModel);
        })
        .catch(err => {
            const note = `Couldn't derive the current code: ${err.message}`;
            reviewBeforeCache[key] = { note };
            console.warn('[wizard] before-derive failed:', err);
            showBanner(note);
        });
}

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
        const op = (p.operationalPrinciple || '').trim();
        const opLine = op
            ? `<div class="review-op-principle">${escapeHtml(op)}</div>`
            : '';
        const invs = Array.isArray(p.invariants) ? p.invariants : [];
        const invsBlock = invs.length > 0
            ? `<div class="review-invariants-label">Promises:</div><ul class="review-invariants">${invs.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
            : '';
        return `<li><strong>${escapeHtml(p.name || '(unnamed)')}</strong> <span class="muted">— ${escapeHtml(desc)}</span>${fqn}${opLine}${invsBlock}</li>`;
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
    renderReviewReasons();
    renderReviewBefore();
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
    pkgSuggest: document.getElementById('package-suggest'),
    save: document.getElementById('save-to-project'),
    result: document.getElementById('save-result'),
    resultPath: document.getElementById('save-result-path'),
    resultCommand: document.getElementById('save-result-command'),
    copyCommand: document.getElementById('copy-command'),
    error: document.getElementById('save-error'),
    warn: document.getElementById('save-warn'),
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
        const res = await fetch('/api/generator/status');
        pluginStatus = await res.json();
    } catch {
        pluginStatus = { state: 'NOT_INSTALLED', version: null, installPath: null, latestVersion: null, installCommand: null };
    }
    renderPluginStatus();
}

function renderPluginStatus() {
    if (!saveEls.pluginPill || !saveEls.pluginMissing) return;

    // State drives three branches: NOT_INSTALLED → install prompt;
    // OUTDATED → update prompt (Run still enabled, current version still
    // works); READY → quiet pill.
    const state = (pluginStatus && pluginStatus.state) || 'NOT_INSTALLED';

    if (state === 'NOT_INSTALLED') {
        saveEls.pluginPill.classList.add('hidden');
        saveEls.pluginPill.removeAttribute('data-state');
        saveEls.pluginMissing.classList.remove('hidden');
        if (saveEls.pluginUpdate) saveEls.pluginUpdate.classList.add('hidden');
        if (saveEls.runBtn) {
            saveEls.runBtn.disabled = true;
            saveEls.runBtn.title = 'Configure the code generator first';
        }
        // Generator surfaces its own install command — render it from the
        // status payload rather than hard-coding a Claude-specific string
        // in the UI.
        const cmdHost = document.getElementById('plugin-install-command');
        if (cmdHost) cmdHost.textContent = (pluginStatus && pluginStatus.installCommand) || '';
        return;
    }

    const installed = pluginStatus.version;
    const latest = pluginStatus.latestVersion;
    const skipped = sessionStorage.getItem(SKIPPED_UPDATE_KEY);
    const outdated = state === 'OUTDATED' && latest && installed && skipped !== latest;

    saveEls.pluginPill.classList.remove('hidden');
    saveEls.pluginMissing.classList.add('hidden');
    if (saveEls.runBtn) {
        saveEls.runBtn.disabled = false;
        saveEls.runBtn.title = '';
    }

    if (outdated) {
        saveEls.pluginPill.textContent = `Generator v${installed} → v${latest} ↻`;
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
        saveEls.pluginPill.textContent = `Generator v${installed} ✓`;
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

// `@package` is mandatory — the DisC plugin refuses any .puml without it.
// Soft-warning the user isn't enough; we also gate the save button.
function isPackageValid(pkg) {
    const v = (pkg || '').trim();
    return v.length > 0 && JAVA_PACKAGE_RE.test(v);
}

function refreshPackageWarning() {
    const v = state.targetPackage.trim();
    if (!v) {
        saveEls.pkgWarn.textContent = 'Required — DisC will refuse this file without a package. Enter a Java package like com.example.invoice.';
        saveEls.pkgWarn.className = 'package-warn error';
    } else if (!JAVA_PACKAGE_RE.test(v)) {
        saveEls.pkgWarn.textContent = `"${v}" doesn't look like a Java package (expected e.g. com.example.invoice). DisC will refuse this file.`;
        saveEls.pkgWarn.className = 'package-warn error';
    } else {
        saveEls.pkgWarn.textContent = '';
        saveEls.pkgWarn.className = 'package-warn hidden';
    }
    refreshPackageSuggestion();
    syncSaveButtonGate();
}

// Surface the callee-anchored recommendation as a clickable chip so the user
// can see what DisC would pick — even after they've typed something different
// or cleared the field. Hidden when the field already equals the suggestion or
// when no suggestion is available (greenfield + no REUSE anchors + empty catalog).
function refreshPackageSuggestion() {
    if (!saveEls || !saveEls.pkgSuggest) return;
    const suggestion = recommendSutPackage(state.participants, state.sutName, state.codebaseCatalog);
    const current = (state.targetPackage || '').trim();
    if (!suggestion || suggestion === current) {
        saveEls.pkgSuggest.classList.add('hidden');
        saveEls.pkgSuggest.textContent = '';
        return;
    }
    saveEls.pkgSuggest.classList.remove('hidden');
    saveEls.pkgSuggest.textContent = '';
    const label = document.createElement('span');
    label.textContent = 'Suggested:';
    const code = document.createElement('code');
    code.textContent = suggestion;
    const sep = document.createTextNode(' — ');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'package-suggest-apply';
    btn.textContent = 'use this';
    btn.addEventListener('click', () => {
        state.targetPackage = suggestion;
        state.targetPackageAutoFilled = true;
        saveEls.pkg.value = suggestion;
        refreshPackageWarning();
        outputEl.textContent = emitPlantUml();
    });
    saveEls.pkgSuggest.append(label, code, sep, btn);
}

// Disable the save button when @package is empty or malformed. Hover-tooltip
// explains why so the user doesn't get a silently-dead control.
function syncSaveButtonGate() {
    if (!saveEls || !saveEls.save) return;
    const valid = isPackageValid(state.targetPackage);
    saveEls.save.disabled = !valid;
    saveEls.save.title = valid
        ? ''
        : 'Set a Java package (e.g. com.example.invoice) before saving';
}

saveEls.pkg.addEventListener('input', (e) => {
    state.targetPackage = e.target.value;
    // A non-empty keystroke means the user owns this value — block re-analyze
    // from overwriting it. But if they clear the field back to empty, treat
    // it as "give me the suggestion back" so the next analyze re-fills, and
    // the suggestion chip immediately re-appears (since suggestion !== '').
    state.targetPackageAutoFilled = !e.target.value.trim();
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
        const method = findCalleeMethod(firstCall.calleeId, firstCall.methodId);
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

    const entityRowsHtml = renderEntityPlanRows();
    const participantRowsHtml = used.map(p => {
        const action = inferAction(p);
        const target = describeTarget(p, action);
        const safeName = escapeAttr(p.name || '');
        return `<div class="plan-row action-${action.toLowerCase()}" data-participant-id="${escapeAttr(p.id)}" data-name="${safeName}">
            <span class="plan-participant">${escapeHtml(p.name || '(unnamed)')}</span>
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

    const participantsHeader = '<div class="plan-group-header">Participants</div>';
    host.innerHTML = entityRowsHtml + participantsHeader + participantRowsHtml;

    host.querySelectorAll('select[data-plan-action]').forEach(sel => {
        sel.addEventListener('change', (e) => {
            const id = e.target.dataset.participantId;
            const action = e.target.value;
            applyPlanAction(id, action);
        });
    });

    renderPlanConflicts(used);
}

// Build a small block of plan rows for each declared entity, grouped by a
// header above the participant rows. Surfaces what the plugin will codegen
// from the entity prelude — sealed families, records, enums, REUSE bindings.
// Variants of sealed families nest one indent under their parent so the
// hierarchy is visible at a glance.
function renderEntityPlanRows() {
    if (!state.entities || state.entities.length === 0) return '';

    // Index permits → parent for quick "is this entity a variant?" lookup.
    const permitOf = new Map();  // permitName -> parentName
    for (const e of state.entities) {
        if (e.kind === 'sealed-interface' && Array.isArray(e.permits)) {
            for (const v of e.permits) {
                if (v) permitOf.set(v.trim(), e.name);
            }
        }
    }

    const pkg = (state.targetPackage || '').trim();
    const rowsHtml = state.entities.map(e => {
        const name = (e.name || '').trim();
        if (!name) return '';
        const fqn = (e.existingFqn || '').trim();
        const reuse = !!fqn;
        const action = reuse ? 'REUSE' : 'CREATE';
        const kindLabel = e.kind || 'record';
        const isPermit = permitOf.has(name);
        const target = reuse
            ? fqn
            : (pkg ? `${pkg}.entity.${name}` : `${name} (no @package)`);
        const indentClass = isPermit ? ' plan-row-indent' : '';
        const kindBadge = `<span class="plan-kind-badge" title="entity kind">${escapeHtml(kindLabel)}</span>`;
        const parentNote = isPermit
            ? ` <span class="plan-kind-note">permits ${escapeHtml(permitOf.get(name))}</span>`
            : '';
        const sealedNote = (e.kind === 'sealed-interface' && Array.isArray(e.permits) && e.permits.length > 0)
            ? ` <span class="plan-kind-note">${e.permits.length} variants</span>`
            : '';
        return `<div class="plan-row plan-row-entity action-${action.toLowerCase()}${indentClass}" data-entity-name="${escapeAttr(name)}">
            <span class="plan-participant">${escapeHtml(name)}${kindBadge}${parentNote}${sealedNote}</span>
            <span class="plan-action plan-action-static">${action}</span>
            <span class="plan-target" title="${escapeAttr(target)}">${escapeHtml(target)}</span>
        </div>`;
    }).join('');

    if (!rowsHtml) return '';
    return '<div class="plan-group-header">Entities</div>' + rowsHtml;
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

// Walks state.sequence for any attached decision tables, serialises each one
// to its YAML+markdown sidecar form, and returns the array the /api/design
// endpoint expects.
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

// "Optional<DiscountRule>" -> "DiscountRule"; anything else trimmed as-is. The
// rule-table / resolver carrier matchers correlate a lookup leaf by its return
// type, but a leaf that returns Optional<X> (the correct shape for a Map lookup
// whose miss means "no entry") must still match the bare record/interface X.
function unwrapOptional(t) {
    const m = /^Optional<(.+)>$/.exec((t || '').trim());
    return m ? m[1].trim() : (t || '').trim();
}

// For each resolver entry in state.variancePlan, synthesise the resolver's
// decision-table sidecar (key → strategy class) so the plugin can generate
// a working Map-based resolver implementation. The analyzer's variancePlan
// surfaces mapping[]; this function correlates it with the strategy
// interface entity in state.entities and the resolver participant in
// state.participants, then emits one .decision.md file per resolver.
//
// Returns an array of { fileName, content } shaped identically to
// collectDecisionTablesForSave(). Skips entries that can't be correlated
// (mismatch between mapping strategies and any interface entity's permits,
// or no participant returning that interface) — the user can author the
// table by hand in that fallback case.
function collectResolverDecisionTables() {
    const out = [];
    const resolverPlans = (state.variancePlan || [])
        .filter(v => v && v.pattern === 'resolver' && Array.isArray(v.mapping) && v.mapping.length > 0);
    for (const v of resolverPlans) {
        const strategySet = new Set(v.mapping.map(m => m && m.strategy).filter(Boolean));
        if (strategySet.size === 0) continue;
        // Find the StrategyInterface entity: an interface (or sealed-interface)
        // whose permits[] matches the mapping's strategy values exactly.
        const iface = state.entities.find(e =>
            isPolyCallableEntity(e)
            && Array.isArray(e.permits) && e.permits.length === strategySet.size
            && e.permits.every(p => strategySet.has(p))
        );
        if (!iface) continue;
        // Find the resolver participant: any participant whose method
        // returns the interface entity by name.
        const resolver = state.participants.find(p =>
            (p.methods || []).some(m => unwrapOptional(m.output) === iface.name)
        );
        if (!resolver) continue;
        const resolveMethod = (resolver.methods || []).find(m => unwrapOptional(m.output) === iface.name);
        if (!resolveMethod) continue;
        const input = (resolveMethod.inputs || [])[0];
        if (!input || !input.name) continue;
        // Build the YAML+markdown sidecar directly — the plugin's resolver
        // mode (see java_spring.md "Resolver impl from decision table")
        // recognises this shape and generates a Map-based resolver.
        const lines = [];
        lines.push('---');
        lines.push(`target: ${resolver.name}.${resolveMethod.name}`);
        if (state.targetPackage) lines.push(`package: ${state.targetPackage}`);
        lines.push('input:');
        lines.push(`  ${input.name}: ${input.type || '?'}`);
        lines.push(`output: ${iface.name}`);
        lines.push('---');
        lines.push('');
        const headers = [input.name, 'expected'];
        const rows = v.mapping.map(m => [String(m.key || ''), String(m.strategy || '')]);
        lines.push(emitMarkdownTable(headers, rows));
        lines.push('');
        out.push({
            fileName: decisionTableFileName(resolver),
            content: lines.join('\n')
        });
    }
    return out;
}

// For each rule-table entry in state.variancePlan, synthesise the
// repository's decision-table sidecar (key → rule-record field values)
// so the plugin's pure-function filled mode generates a working Map-based
// lookup. The analyzer's variancePlan surfaces mapping[] with rows shaped
// { key, expected: {field1: v1, field2: v2, ...} }; this function
// correlates the expected-key set with a record entity in state.entities
// and a participant method returning that record, then emits one
// .decision.md per rule-table axis.
//
// Skips entries that can't be correlated (no matching record entity, no
// participant method returning it, or expected-key set doesn't match any
// record's fields) — the user can author the sidecar by hand via the UI's
// +DT chip in that fallback case.
function collectRuleTableDecisionTables() {
    const out = [];
    const plans = (state.variancePlan || [])
        .filter(v => v && v.pattern === 'rule-table' && Array.isArray(v.mapping) && v.mapping.length > 0);

    for (const v of plans) {
        const first = v.mapping[0];
        if (!first || !first.expected || typeof first.expected !== 'object') continue;
        const fieldNames = Object.keys(first.expected);
        if (fieldNames.length === 0) continue;
        const fieldSet = new Set(fieldNames);

        const rule = state.entities.find(e =>
            e && e.kind === 'record'
            && Array.isArray(e.fields) && e.fields.length === fieldSet.size
            && e.fields.every(f => f && fieldSet.has(f.name))
        );
        if (!rule) continue;

        let repo = null, method = null;
        for (const p of state.participants) {
            // Skip reused/existing repos — the human owns that data and the
            // plugin mocks it; a sidecar targeting an existing FQN would be
            // ignored or conflict. Only the pure-function lookup leaf is filled.
            if (p.kind === 'reuse' || p.existingFqn) continue;
            const m = (p.methods || []).find(mm =>
                unwrapOptional(mm.output) === rule.name
                && Array.isArray(mm.inputs) && mm.inputs.length === 1
            );
            if (m) { repo = p; method = m; break; }
        }
        if (!repo || !method) continue;

        const input = method.inputs[0];
        if (!input || !input.name) continue;

        const lines = [];
        lines.push('---');
        lines.push(`target: ${repo.name}.${method.name}`);
        if (state.targetPackage) lines.push(`package: ${state.targetPackage}`);
        lines.push('input:');
        lines.push(`  ${input.name}: ${input.type || '?'}`);
        lines.push(`output: ${rule.name}`);
        lines.push('---');
        lines.push('');
        const headers = [input.name, ...fieldNames.map(f => `expected.${f}`)];
        const rows = v.mapping.map(m => [
            String(m.key || ''),
            ...fieldNames.map(f => {
                const val = (m.expected || {})[f];
                return val === undefined || val === null ? '' : String(val);
            })
        ]);
        lines.push(emitMarkdownTable(headers, rows));
        lines.push('');

        out.push({
            fileName: decisionTableFileName(repo),
            content: lines.join('\n')
        });
    }
    return out;
}

// For each pure-function-leaf participant whose method carries a non-empty
// `cases[]` (per-AC-row examples from the analyzer), synthesise a sidecar
// the plugin's pure-function FILLED mode reads to derive the implementation
// AND emit one test per row. This closes the loop for pattern-1 appliers
// (and any other AC-driven pure function leaf): every AC row gets a real
// generated impl + a passing test; adding a new AC row regenerates a new
// case + new test without changing the design.
function collectPureFunctionLeafDecisionTables() {
    const out = [];
    for (const p of state.participants) {
        if (!p || p.kind !== 'leaf') continue;
        for (const m of (p.methods || [])) {
            const cases = m.cases || [];
            if (cases.length === 0) continue;
            const inputs = (m.inputs || []);
            if (inputs.length === 0) continue;

            const lines = [];
            lines.push('---');
            lines.push(`target: ${p.name}.${m.name}`);
            if (state.targetPackage) lines.push(`package: ${state.targetPackage}`);
            lines.push('input:');
            inputs.forEach(i => lines.push(`  ${i.name}: ${i.type || '?'}`));
            lines.push(`output: ${m.output || 'void'}`);
            boundariesFrontmatterLines(m).forEach(l => lines.push(l));
            lines.push('---');
            lines.push('');

            const headers = [...inputs.map(i => i.name), 'expected'];
            const rows = cases.map(c => {
                const ins = c.inputs || {};
                return [
                    ...inputs.map(i => {
                        const v = ins[i.name];
                        return v === undefined || v === null ? '' : String(v);
                    }),
                    String(c.expected || '')
                ];
            });
            lines.push(emitMarkdownTable(headers, rows));
            lines.push('');

            out.push({
                fileName: decisionTableFileName(p),
                content: lines.join('\n')
            });
        }
    }
    return out;
}

// Detect designs that WILL ship a silent no-op stub or an unwired bean,
// using the SAME predicates the emitters above use to decide skip-vs-emit
// — so the warning can never disagree with what actually gets written. The
// Step-2 plugin validator only sees the .puml (never these sidecars, which
// are generated here at save), so this is the only place these gaps surface.
// Non-blocking: a partial design still saves; the user re-runs Analyze to
// fill it. Returns a list of human-readable gap messages.
function collectVarianceGaps() {
    const gaps = [];
    const ruleTableSourceIds = new Set();

    // Rule-table axes — mirror collectRuleTableDecisionTables' skip branches.
    for (const v of (state.variancePlan || [])) {
        if (!v || v.pattern !== 'rule-table') continue;
        const axis = v.axis || '(unnamed axis)';
        const mapping = Array.isArray(v.mapping) ? v.mapping : [];
        if (mapping.length === 0) {
            gaps.push(`Rule-table axis "${axis}" has an empty mapping[] — its rule data is missing. Re-run Analyze.`);
            continue;
        }
        const first = mapping[0];
        if (!first || !first.expected || typeof first.expected !== 'object') continue;
        const fieldNames = Object.keys(first.expected);
        if (fieldNames.length === 0) continue;
        const fieldSet = new Set(fieldNames);

        const rule = state.entities.find(e =>
            e && e.kind === 'record'
            && Array.isArray(e.fields) && e.fields.length === fieldSet.size
            && e.fields.every(f => f && fieldSet.has(f.name))
        );
        if (!rule) {
            gaps.push(`Rule-table axis "${axis}" has no matching ${fieldSet.size}-field record entity — its rule data will NOT be generated. Re-run Analyze.`);
            continue;
        }
        // The lookup source must be a NON-reused leaf (a reused/existing repo
        // is the human's — the plugin mocks it, so no sidecar is emitted).
        const source = state.participants.find(p =>
            p && p.kind !== 'reuse' && !p.existingFqn
            && (p.methods || []).some(mm =>
                unwrapOptional(mm.output) === rule.name
                && Array.isArray(mm.inputs) && mm.inputs.length === 1)
        );
        if (!source) {
            gaps.push(`Rule-table axis "${axis}": no lookup leaf returns ${rule.name} from a single key — name the data source a ${rule.name}Table.ruleFor(key) pure-function leaf (not a *Repository). Re-run Analyze.`);
        } else {
            ruleTableSourceIds.add(source.id);
        }
    }

    // Pure-function leaves on the SUT call path that would stub out for lack
    // of cases[]. Exclude rule-table sources (filled via mapping[], not cases[]).
    for (const p of state.participants) {
        if (!p || p.kind !== 'leaf') continue;
        if (ruleTableSourceIds.has(p.id)) continue;
        const called = (state.sequence || []).some(s =>
            s && s.kind === STEP_KIND.CALL && s.calleeId === p.id);
        if (!called) continue;
        // "Output varies" proxy: the AC subset this leaf carries varies on
        // given/when (axes >= 1). A genuinely constant leaf has axes === 0 and
        // must NOT warn — that is the false-positive guard.
        const axesInfo = axesCoveredByParticipant(p);
        if (!axesInfo || axesInfo.axes < 1) continue;
        for (const m of (p.methods || [])) {
            if ((m.cases || []).length === 0 && (m.inputs || []).length > 0) {
                gaps.push(`Leaf ${p.name}.${m.name} varies across its AC rows but has no cases[] — it will ship as a no-op stub. Re-run Analyze.`);
            }
        }
    }

    return gaps;
}

saveEls.save.addEventListener('click', async () => {
    saveEls.error.classList.add('hidden');
    saveEls.warn.classList.add('hidden');
    saveEls.result.classList.add('hidden');

    if (!state.projectPath) {
        saveEls.error.textContent = 'No project path — go back to Step 1 and pick a folder (or paste a path).';
        saveEls.error.classList.remove('hidden');
        return;
    }

    // Pre-flight guard: @package is mandatory (plugin refuses without it).
    // The button is also disabled via syncSaveButtonGate, but cover the
    // case where the gate was bypassed (programmatic click, stale state).
    if (!isPackageValid(state.targetPackage)) {
        saveEls.error.textContent = 'Set a Java package (e.g. com.example.invoice) in the field above before saving — DisC will refuse the file without one.';
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
    // Auto-emit a decision-table sidecar per resolver / rule-table entry in
    // the analyzer's variancePlan. The plugin reads these and generates
    // working Map-based / lookup implementations; without them participants
    // stay as UnsupportedOperationException skeletons. Deduplicate by
    // fileName so a user-authored table for the same participant wins over
    // the auto one.
    const existingNames = new Set(decisionTables.map(d => d.fileName));
    for (const dt of collectResolverDecisionTables()) {
        if (existingNames.has(dt.fileName)) continue;
        decisionTables.push(dt);
        existingNames.add(dt.fileName);
    }
    for (const dt of collectRuleTableDecisionTables()) {
        if (existingNames.has(dt.fileName)) continue;
        decisionTables.push(dt);
        existingNames.add(dt.fileName);
    }
    for (const dt of collectPureFunctionLeafDecisionTables()) {
        if (existingNames.has(dt.fileName)) continue;
        decisionTables.push(dt);
        existingNames.add(dt.fileName);
    }

    // Surface any design that will generate stubs (non-blocking — the save
    // still proceeds so the user can iterate). These are invisible to the
    // Step-2 plugin validator, which never sees the sidecars.
    const gaps = collectVarianceGaps();
    if (gaps.length > 0) {
        saveEls.warn.textContent =
            'Heads up — these will generate stubs; re-run Analyze:\n• ' + gaps.join('\n• ');
        saveEls.warn.classList.remove('hidden');
    }

    try {
        const designBody = { projectPath: state.projectPath, fileName, content, decisionTables };
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
        cancelUrl: '/api/generator/cancel'
    };

    const reader = makeNdjsonReader();
    let terminal = null;  // 'done' | 'cancelled' | 'failed'

    try {
        const modelSelect = document.getElementById('run-model');
        const response = await fetch('/api/generator/run', {
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
        fetchUrl: '/api/generator/install',
        cancelUrl: '/api/generator/cancel',
        runningLabel: 'Installing generator…',
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
            fetchUrl: '/api/generator/update',
            cancelUrl: '/api/generator/cancel',
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

// Emit the `boundaries:` frontmatter block for a method's declared thresholds,
// keyed in the method's input order. No-op (returns []) when none are declared.
function boundariesFrontmatterLines(method) {
    const bounds = method && method.boundaries;
    if (!bounds) return [];
    const lines = [];
    (method.inputs || []).forEach(i => {
        const vals = bounds[i.name];
        if (Array.isArray(vals) && vals.length > 0) {
            lines.push(`  ${i.name}: [${vals.join(', ')}]`);
        }
    });
    return lines.length > 0 ? ['boundaries:', ...lines] : [];
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
    boundariesFrontmatterLines(method).forEach(l => lines.push(l));
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

// Dev hook — exposes the module-scoped state and element bag for
// in-browser debugging and automated UI verification. No prod effect;
// nothing in the wizard reads window.__disc.
if (typeof window !== 'undefined') {
    window.__disc = { state, step2Els };
}

