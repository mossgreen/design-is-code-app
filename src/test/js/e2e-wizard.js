// End-to-end wizard run against a real Spring project, driving the real browser.
//
// This is the one test that exercises everything at once: scan → analyzer →
// sequencer → design assembly → data-flow gate → .puml. It costs model calls, so
// it is never part of `./gradlew test`; run it deliberately:
//
//   node src/test/js/e2e-wizard.js --repo /path/to/a/spring/project [--model claude-opus-4-8]
//
// What it is really checking: whether the model honours the 2026-07-30 sequencer
// contract — that a call arrow carries the VALUES the caller passes rather than
// the callee's declared parameter names. Everything else is plumbing that the
// free tests already cover.
//
// Requires the app on :8080 (./gradlew bootRun) and the `claude` CLI on PATH.

const path = require('path');
const fs = require('fs');

const PW = '/Users/mossgu/.npm/_npx/9833c18b2d85bc59/node_modules/playwright';
const { chromium } = require(PW);

const arg = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const REPO = arg('--repo', null);
const MODEL = arg('--model', 'claude-opus-4-8');
const OUT = arg('--out', path.join('build', 'e2e'));
const BASE = arg('--base', 'http://localhost:8080');
// Opus on a real story runs FOUR model calls end to end, not one. Observed
// 2026-07-31: analyze 275s, sequence 12s, sequence retry 56s (the data-flow gate
// asking for a fix), then the plugin's Step-1 validate — itself a full claude
// invocation of several minutes. 15 minutes was not enough; 25 is.
const CHAIN_TIMEOUT_MS = Number(arg('--timeout', '1500000'));

if (!REPO) {
    console.error('usage: node e2e-wizard.js --repo <spring project> [--model <id>]');
    process.exit(2);
}

const STORY = `As an owner, I want to cancel an upcoming visit for my pet, so that the slot is freed and I know what it costs me.

Given a visit at least 48 hours away, when the owner cancels, then the visit is removed and no fee is charged.
Given a visit less than 48 hours away, when the owner cancels, then the visit is removed and a 20 dollar late fee is charged.
Given a cancellation initiated by the clinic, when the visit is cancelled, then the visit is removed and no fee is charged.`;

const log = (...a) => console.log('[e2e]', ...a);

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    const consoleErrors = [];
    const failedRequests = [];
    // A missing favicon is a real 404 but not a product defect, and letting it
    // fail the run buries the findings that matter.
    const IGNORED = /favicon\.ico/;
    page.on('console', m => {
        // Chrome's console text for a failed request carries no URL, so it cannot
        // be filtered by name. Network failures are judged from the response log
        // below, which does have URLs; the console is for script errors only.
        if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) {
            consoleErrors.push(m.text());
        }
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('response', r => {
        if (r.status() >= 400 && !IGNORED.test(r.url())) failedRequests.push(r.status() + ' ' + r.url());
    });

    const shot = async (name) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
    const fail = async (why, extra) => {
        await shot('failure');
        console.error('[e2e] FAIL:', why);
        if (extra) console.error(extra);
        await browser.close();
        process.exit(1);
    };

    try {
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        log('loaded', await page.title());

        // --- Step 1a: connect the project (scan) ---
        await page.fill('#path-input', REPO);
        await page.press('#path-input', 'Enter');
        await page.waitForSelector('#scan-result:not(.hidden)', { timeout: 120000 });
        const scanned = (await page.textContent('#scan-summary-text')).trim();
        log('scanned:', scanned);
        await shot('1-scanned');

        // Connect is its own sub-step; the story block only appears after it.
        await page.click('#connect-next');
        await page.waitForSelector('#story-input', { state: 'visible', timeout: 30000 });

        // --- Step 1b: the story, the model, and the long wait ---
        await page.fill('#story-input', STORY);
        await page.selectOption('#analyze-model', MODEL);
        log('model:', MODEL, '— running analyze + sequence (minutes)');
        await page.click('#analyze-btn');

        // Wait for the DESIGN, not for the whole chain. What is under test is the
        // sequencer contract and the data-flow gate; the plugin's Step-1 validate
        // that runs afterwards is a separate multi-minute model call this test does
        // not depend on. Waiting for it once cost a 15-minute timeout on a run that
        // had already produced everything worth measuring.
        await page.waitForFunction(() => {
            const composed = (state.sequence || []).some(s =>
                s.kind === STEP_KIND.CALL && !isSystemCaller(s.callerId) && !isSystemCaller(s.calleeId));
            if (!composed) return false;
            const b = document.getElementById('analyze-banner');
            if (!b || b.classList.contains('hidden')) return true;
            // Still allow "Validating…" through: by then the design is final.
            return !/Analys|Composing|asking for a fix/i.test(b.textContent || '');
        }, null, { timeout: CHAIN_TIMEOUT_MS, polling: 2000 });
        const banner = (await page.textContent('#analyze-banner')) || '';
        log('banner settled:', banner.trim().slice(0, 160) || '(hidden)');
        await shot('2-analyzed');

        // --- what the model actually produced ---
        const design = await page.evaluate(() => ({
            sut: (state.participants.find(p => p.id === state.sutParticipantId) || {}).name || null,
            participants: state.participants.map(p => p.name),
            // Only the collaborator calls are the model's work. The two [*]
            // boundary rows are wizard-managed and carry no binding by design;
            // counting them as unbound would report a defect that is not there.
            steps: state.sequence
                .filter(s => s.kind === 'call'
                    && !isSystemCaller(s.callerId) && !isSystemCaller(s.calleeId))
                .map(s => {
                    const m = findCalleeMethod(s.calleeId, s.methodId);
                    const out = ((normalizeMethodLike(m) || {}).output || '').trim();
                    return {
                        label: callSignature(s, m),
                        args: s.args || [],
                        resultName: s.resultName || null,
                        returnsValue: !!out && out.toLowerCase() !== 'void'
                    };
                }),
            variancePlan: (state.variancePlan || []).map(v => ({ axis: v.axis, pattern: v.pattern })),
            puml: emitPlantUml()
        }));
        fs.writeFileSync(path.join(OUT, 'design.puml'), design.puml);
        fs.writeFileSync(path.join(OUT, 'design.json'), JSON.stringify(design, null, 2));
        log('SUT:', design.sut, '| participants:', design.participants.join(', '));
        log('variance:', JSON.stringify(design.variancePlan));

        // --- the contract under test ---
        const needResult = design.steps.filter(s => s.returnsValue);
        const bound = design.steps.filter(s => s.args.length > 0).length;
        const named = needResult.filter(s => s.resultName).length;
        log(`bindings: ${bound}/${design.steps.length} calls carry args; `
            + `${named}/${needResult.length} non-void calls name their result`);
        design.steps.forEach(s => log('  ', s.label,
            s.resultName ? '-> ' + s.resultName : (s.returnsValue ? '-> UNNAMED' : '(void)')));

        // --- the gate's own verdict, from the server ---
        const lint = await page.evaluate(async () => {
            const res = await fetch('/api/design/lint', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ puml: emitPlantUml() })
            });
            return res.json();
        });
        fs.writeFileSync(path.join(OUT, 'lint.json'), JSON.stringify(lint, null, 2));
        log('lint violations:', lint.violations.length, '| warnings:', lint.warnings.length);
        lint.violations.forEach(v => log('  VIOLATION', v));
        lint.warnings.forEach(v => log('  warning  ', v));

        // --- Step 3: the review surface a human would actually see ---
        await page.click('#flow-next').catch(() => {});
        await page.waitForTimeout(1500);
        await shot('3-review');
        const review = await page.evaluate(() => {
            const panel = document.getElementById('review-dataflow');
            return {
                dataflowPanelShown: !!panel && !panel.classList.contains('hidden'),
                dataflowText: panel ? (panel.textContent || '').trim().slice(0, 300) : '',
                signoffStatus: (document.getElementById('signoff-status') || {}).textContent || ''
            };
        });
        log('review panel shown:', review.dataflowPanelShown, '|', review.signoffStatus.trim());

        // --- the gate must also BLOCK, or it is not a gate ---
        //
        // Everything above watches a good design pass. Blocking is the entire
        // product claim, so break the design on purpose — strip one argument from
        // one call — and confirm the review panel appears and sign-off is refused.
        // No extra model calls: this reuses the design already composed.
        const blocking = await page.evaluate(async () => {
            const call = state.sequence.find(s =>
                s.kind === STEP_KIND.CALL && Array.isArray(s.args) && s.args.length > 0);
            if (!call) return { skipped: 'no bound call to break' };
            const original = call.args.slice();
            call.args = ['aValueNothingProduces'];
            renderSequence();
            await refreshDataflowLint();

            const panel = document.getElementById('review-dataflow');
            const state_ = {
                panelShown: !!panel && !panel.classList.contains('hidden'),
                panelText: panel ? (panel.textContent || '').trim().slice(0, 200) : '',
                signoffStatus: ((document.getElementById('signoff-status') || {}).textContent || '').trim(),
                nextDisabled: !!(document.getElementById('preview-next') || {}).disabled,
                blockedByGate: typeof signoffBlockedByDataflow === 'function' && signoffBlockedByDataflow()
            };

            call.args = original;          // leave the run on a clean design
            renderSequence();
            await refreshDataflowLint();
            state_.recovered = !(typeof signoffBlockedByDataflow === 'function' && signoffBlockedByDataflow());
            return state_;
        });
        if (blocking.skipped) {
            log('blocking check skipped:', blocking.skipped);
        } else {
            log('blocking check — panel:', blocking.panelShown,
                '| blocked:', blocking.blockedByGate,
                '| next disabled:', blocking.nextDisabled,
                '| recovered:', blocking.recovered);
            log('  status said:', blocking.signoffStatus);
        }

        console.log('\n--- emitted design ---\n' + design.puml);

        const problems = [];
        if (!blocking.skipped) {
            if (!blocking.panelShown) problems.push('a broken design did not show the data-flow panel');
            if (!blocking.blockedByGate) problems.push('a broken design did not block sign-off');
            if (!blocking.recovered) problems.push('the gate stayed blocked after the design was repaired');
        }
        if (!design.sut) problems.push('no SUT was chosen');
        if (design.steps.length === 0) problems.push('no call steps were produced');
        if (lint.violations.length > 0) problems.push(`${lint.violations.length} data-flow violation(s)`);
        const unbound = design.steps.filter(s => s.args.length === 0).length;
        if (unbound > 0) {
            problems.push(`${unbound} call(s) carried no argument binding — the sequencer contract only partly landed`);
        }
        const unnamed = needResult.length - named;
        if (unnamed > 0) problems.push(`${unnamed} non-void call(s) did not name their result`);
        if (consoleErrors.length) problems.push('console errors: ' + consoleErrors.slice(0, 3).join(' | '));
        if (failedRequests.length) problems.push('failed requests: ' + failedRequests.slice(0, 3).join(' | '));

        if (problems.length) await fail(problems.join('; '));
        log('PASS — artifacts in', path.resolve(OUT));
        await browser.close();
    } catch (e) {
        await fail(e.message, e.stack);
    }
})();
