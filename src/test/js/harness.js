// Loads the REAL static/js/app.js in a Node vm behind a permissive DOM stub, so
// the wizard's design-model code can be tested without a browser.
//
// Why this exists: the .puml is assembled in the frontend, and the frontend had
// no tests at all. The 2026-07-30 data_pipe defect lived exactly here — arrows
// echoed the callee's declared parameter names instead of the values the caller
// passes. A defect in untested code is not bad luck.
//
// It must load the production files, never copies. If this ever drifts to a
// fixture of app.js, the tests stop proving anything.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC_JS = path.resolve(__dirname, '..', '..', 'main', 'resources', 'static', 'js');
const APP_JS = path.join(STATIC_JS, 'app.js');
const DIAGRAM_SVG_JS = path.join(STATIC_JS, 'diagram-svg.js');

// Answers any property with something harmless: itself for chaining, a no-op for
// calls. Enough for app.js's load-time DOM wiring, which we neither drive nor assert.
const anyNode = new Proxy(function () {}, {
    get(target, key) {
        if (key === 'style' || key === 'classList' || key === 'dataset') return anyNode;
        if (key === 'value' || key === 'textContent' || key === 'innerHTML') return '';
        if (key === 'checked' || key === 'disabled' || key === 'hidden') return false;
        if (key === 'children' || key === 'options') return [];
        if (key === Symbol.iterator) return [][Symbol.iterator].bind([]);
        if (key === Symbol.toPrimitive) return () => '';
        return anyNode;
    },
    set() { return true; },
    apply() { return anyNode; },
    has() { return true; }
});

// A recording SVG node. Both renderers build their diagrams through
// document.createElementNS, so without this the drawing path cannot be tested at
// all — which is how renderSequenceDiagram silently dropped the entry
// interaction and the final return while the .puml carried both.
//
// getBBox throws on purpose: renderSequenceDiagram catches it and falls back to a
// character-count width estimate, which keeps measurement deterministic here.
// renderSeqSvg never calls it — it sizes from string length by design.
function svgNode(tag) {
    return {
        tagName: tag,
        attrs: {},
        children: [],
        textContent: '',
        style: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) { this.children = this.children.filter(c => c !== child); return child; },
        replaceChildren(...kids) { this.children = kids; },
        getBBox() { throw new Error('no layout engine in node'); }
    };
}

// A recording DOM element, keyed by id. `anyNode` swallows everything, which is
// right for app.js's load-time wiring and useless for assertions: a test cannot
// see what a panel rendered. This records the properties a renderer actually
// writes, and falls through to `anyNode` for anything else, so load-time wiring
// keeps working while `innerHTML` and friends become readable.
function domNode(id) {
    const rec = {
        id,
        tagName: 'DIV',
        attrs: {},
        children: [],
        innerHTML: '',
        textContent: '',
        value: '',
        checked: false,
        disabled: false,
        hidden: false,
        style: {},
        dataset: {},
        classList: {
            _set: new Set(),
            add(...c) { c.forEach(x => this._set.add(x)); },
            remove(...c) { c.forEach(x => this._set.delete(x)); },
            toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) { this._set.add(c); } else { this._set.delete(c); } },
            contains(c) { return this._set.has(c); }
        },
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) { this.children = this.children.filter(c => c !== child); return child; },
        replaceChildren(...kids) { this.children = kids; },
        addEventListener() {},
        removeEventListener() {},
        getBBox() { throw new Error('no layout engine in node'); }
    };
    return new Proxy(rec, {
        get(t, k) { return k in t ? t[k] : anyNode; },
        set(t, k, v) { t[k] = v; return true; },
        has() { return true; }
    });
}

/** Every textContent in a rendered tree, depth-first — the labels a reader sees. */
function svgText(node) {
    const out = [];
    (function walk(n) {
        if (!n) return;
        if (n.textContent) out.push(String(n.textContent));
        (n.children || []).forEach(walk);
    })(node);
    return out;
}

function newContext() {
    // One recording element per id, created on demand and kept, so a case can
    // read back what a renderer wrote to the panel it targets.
    const elements = new Map();
    const document = {
        getElementById: (id) => {
            if (!elements.has(id)) elements.set(id, domNode(id));
            return elements.get(id);
        },
        querySelector: () => anyNode,
        querySelectorAll: () => [],
        createElement: () => anyNode,
        createElementNS: (_ns, tag) => svgNode(tag),
        addEventListener: () => {},
        body: anyNode,
        documentElement: anyNode
    };

    // No test may reach the network by default: a green run must mean the local
    // code is right, not that a server happened to be up. A case that needs to
    // drive a response path calls stubFetch() and supplies its own — which is
    // the only way to reach drawModel's success path at all.
    let fetchImpl = async () => { throw new Error('network disabled in the frontend harness'); };

    const sandbox = {
        document,
        window: { addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) },
        navigator: { userAgent: 'node' },
        console,
        fetch: (...args) => fetchImpl(...args),
        stubFetch: (fn) => { fetchImpl = fn; },
        /** A JSON response shaped the way app.js reads one: res.ok + res.json(). */
        jsonResponse: (body, ok = true, status = 200) =>
            ({ ok, status, json: async () => body }),
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (fn) => fn(),
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        DiagramSvg: { render: () => {} },
        // For cases that drive a renderer and read back what it drew.
        makeSvgContainer: () => svgNode('div'),
        collectSvgText: svgText
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // diagram-svg.js first: app.js's drawModel() calls renderSeqSvg, and without
    // it the Step-3 before-view success path throws ReferenceError.
    vm.runInContext(fs.readFileSync(DIAGRAM_SVG_JS, 'utf8'), sandbox, { filename: 'diagram-svg.js' });
    vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });
    return sandbox;
}

/**
 * Run `script` with the production frontend loaded. The script's final expression
 * is returned, and `state` / every top-level function in app.js is in scope.
 */
function withApp(script) {
    return vm.runInContext(script, newContext(), { filename: 'case' });
}

module.exports = { withApp, APP_JS, DIAGRAM_SVG_JS };
