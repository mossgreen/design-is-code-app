// Loads the REAL static/js/app.js in a Node vm behind a permissive DOM stub, so
// the wizard's design-model code can be tested without a browser.
//
// Why this exists: the .puml is assembled in the frontend, and the frontend had
// no tests at all. The 2026-07-30 data_pipe defect lived exactly here — arrows
// echoed the callee's declared parameter names instead of the values the caller
// passes. A defect in untested code is not bad luck.
//
// It must load the production file, never a copy. If this ever drifts to a
// fixture of app.js, the tests stop proving anything.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.resolve(__dirname, '..', '..', 'main', 'resources', 'static', 'js', 'app.js');

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

function newContext() {
    const document = {
        getElementById: () => anyNode,
        querySelector: () => anyNode,
        querySelectorAll: () => [],
        createElement: () => anyNode,
        addEventListener: () => {},
        body: anyNode,
        documentElement: anyNode
    };
    const sandbox = {
        document,
        window: { addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) },
        navigator: { userAgent: 'node' },
        console,
        // No test may reach the network: a green run must mean the local code is
        // right, not that a server happened to be up.
        fetch: async () => { throw new Error('network disabled in the frontend harness'); },
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (fn) => fn(),
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        DiagramSvg: { render: () => {} }
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });
    return sandbox;
}

/**
 * Run `script` with app.js loaded. The script's final expression is returned, and
 * `state` / every top-level function in app.js is in scope.
 */
function withApp(script) {
    return vm.runInContext(script, newContext(), { filename: 'case' });
}

module.exports = { withApp, APP_JS };
