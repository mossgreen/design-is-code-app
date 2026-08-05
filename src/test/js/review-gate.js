// Drives Step 3's dropped-call gate down the path where deriving the current
// code FAILS.
//
// renderReviewBefore() clears the gate up front (`setDroppedCalls([])`, "no
// before, no gate — until a flow is derived below") and only recomputes inside
// drawModel(). The fetch's .catch shows a banner and returns, so the gate keeps
// the cleared value and reports "no drops" — after learning nothing. It then
// caches {note}, so every later visit to Step 3 replays the banner and never
// recomputes either.
//
// A derive that failed is not a design with no dropped calls. It is a design
// nobody checked, and sign-off must not treat the two the same. Greenfield is
// genuinely different and must stay open; that case takes an early return above
// the fetch and never reaches here.
//
// The harness disables fetch by design, so simply calling renderReviewBefore()
// with a bound SUT reaches the failure path.

const { withApp } = require('./harness');

const CASE = `
(async () => {
    const entryM = makeMethod('cancel', [{ name: 'visitId', type: 'Long' }], 'CancellationResult');
    const sut = {
        id: newId(), name: 'CancelVisitService', methods: [entryM],
        existingFqn: 'com.example.CancelVisitService'
    };

    state.participants = [sut];
    state.entities = [];
    state.sutParticipantId = sut.id;
    state.sequence = [{
        id: newId(), kind: STEP_KIND.CALL,
        callerId: SYSTEM_CALLER_ID, calleeId: sut.id, methodId: entryM.id
    }];
    // A bound SUT whose entry method exists in the scan — everything the
    // early returns check for, so control reaches the fetch.
    state.projectPath = '/tmp/project';
    state.codebaseCatalog = {
        types: [{
            fqn: 'com.example.CancelVisitService',
            name: 'CancelVisitService',
            publicMethods: [{ name: 'cancel' }]
        }]
    };

    const gate = () => (typeof signoffBlocked === 'function')
        ? signoffBlocked()
        : signoffBlockedByDrops();

    renderReviewBefore();
    // Read the gate BEFORE letting the rejected fetch settle. This is the
    // in-flight window: the old answer is cleared and the new one has not
    // arrived, and reading it as "no dropped calls" enables Next on a design
    // nothing has checked.
    const blockedWhileInFlight = gate();
    const pending = !!state.reviewDerivePending;

    await new Promise(r => setTimeout(r, 0));   // let the rejected fetch settle
    const blocked = gate();

    // Second visit. Failures are deliberately not cached, so this retries the
    // fetch rather than replaying a remembered banner — a transient error must
    // not lock the gate for the session.
    renderReviewBefore();
    await new Promise(r => setTimeout(r, 0));
    const blockedOnRevisit = gate();

    return JSON.stringify({
        dropped: state.reviewDropped || [],
        deriveFailed: !!state.reviewDeriveFailed,
        pending,
        blockedWhileInFlight,
        blocked,
        blockedOnRevisit,
        failureCached: Object.values(reviewBeforeCache).some(v => v && !v.model)
    });
})()
`;

// A second, synchronous case: the dropped-call gate's own view of the proposal.
//
// computeDroppedCalls asks proposedCallSet() "does the design still make this
// call?". proposedCallSet resolves the sequence ITSELF and omits the caller check
// resolveSteps applies, so a step whose caller does not resolve emits no arrow
// while the gate still counts the call as proposed. The design silently drops the
// call and the gate reports nothing — a false release, in the gate built to catch
// exactly that.
const FOURTH_RESOLUTION = `
const mk = (n, ms) => ({ id: newId(), name: n, methods: ms, existingFqn: null });
const save = makeMethod('save', [{ name: 'owner', type: 'Owner' }], 'void');
const sut = mk('VisitController', [makeMethod('processNewVisitForm', [], 'String')]);
const repo = mk('OwnerRepository', [save]);

state.participants = [sut, repo];
state.entities = [];
state.sutParticipantId = sut.id;
// callerId resolves to nothing — the state an orphaned step leaves behind.
state.sequence = [{
    id: newId(), kind: STEP_KIND.CALL,
    callerId: 'ghost-participant', calleeId: repo.id, methodId: save.id, args: ['owner']
}];

// The current code makes the call the proposal has silently lost.
const beforeModel = {
    participants: ['[*]', 'VisitController', 'OwnerRepository'],
    steps: [{ kind: 'call', from: 'VisitController', to: 'OwnerRepository', label: 'save(owner)' }]
};

JSON.stringify({
    arrowsEmitted: resolveSteps(state.sequence).length,
    proposed: Array.from(proposedCallSet()),
    dropped: computeDroppedCalls(beforeModel)
});
`;

Promise.all([withApp(CASE), Promise.resolve(withApp(FOURTH_RESOLUTION))])
    .then(([gate, fourth]) => {
        process.stdout.write(JSON.stringify({
            ...JSON.parse(gate),
            fourthResolution: JSON.parse(fourth)
        }));
    });
