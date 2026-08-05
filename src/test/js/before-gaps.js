// Drives Step 3's "Before" panel down the SUCCESS path — the one the harness
// could not reach until it gained a stubbable fetch and the real diagram-svg.js.
//
// The property: when derivation could not account for part of the entry body, the
// reviewer is told. Stage A already computes that honestly — `captureGaps` — and
// `POST /api/code-derive-by-path` already returns it inside `slice`. The wizard
// reads `data.sliceModel` and throws `data.slice` away, so the panel shows a
// partial flow and says nothing about the rest.
//
// This repo's own CodeDesignDiffService#deriveByPath derives 8+ gaps. A reviewer
// approving a change to a framework-heavy method is approving against a picture
// with most of the calls missing, with no notice that anything is absent.

const { withApp } = require('./harness');

const SETUP = `
    const entryM = makeMethod('processNewVisitForm', [{ name: 'owner', type: 'Owner' }], 'String');
    const sut = {
        id: newId(), name: 'VisitController', methods: [entryM],
        existingFqn: 'org.springframework.samples.petclinic.owner.VisitController'
    };
    state.participants = [sut];
    state.entities = [];
    state.sutParticipantId = sut.id;
    state.sequence = [{
        id: newId(), kind: STEP_KIND.CALL,
        callerId: SYSTEM_CALLER_ID, calleeId: sut.id, methodId: entryM.id
    }];
    state.projectPath = '/tmp/project';
    state.codebaseCatalog = {
        types: [{
            fqn: 'org.springframework.samples.petclinic.owner.VisitController',
            name: 'VisitController',
            publicMethods: [{ name: 'processNewVisitForm' }]
        }]
    };

    const sliceModel = {
        participants: ['[*]', 'VisitController', 'OwnerRepository'],
        steps: [
            { kind: 'call', from: '[*]', to: 'VisitController', label: 'processNewVisitForm(owner)' },
            { kind: 'call', from: 'VisitController', to: 'OwnerRepository', label: 'save(owner)' }
        ]
    };
`;

// The real shape of a DeriveResult, gaps and all.
const GAPS = [
    'a branch (if / ternary) in the entry body',
    'a loop in the entry body',
    'an unattributable call: visit.getDate().isAfter(LocalDate.now()) (self, chained, or static receiver)'
];

const CASE = (gaps) => `
(async () => {
    ${SETUP}
    stubFetch(async () => jsonResponse({
        slice: {
            sut: 'VisitController',
            entryMethod: { name: 'processNewVisitForm', params: [], returns: 'String' },
            orchestrator: true, callSites: [], dependencies: [], configFacts: [],
            targetPackage: 'org.springframework.samples.petclinic.owner',
            knownTypes: [],
            captureGaps: ${JSON.stringify(gaps)}
        },
        sliceMarkdown: '', slicePuml: '', sliceModel
    }));

    renderReviewBefore();
    await new Promise(r => setTimeout(r, 0));

    const body = document.getElementById('review-before-body');
    return JSON.stringify({
        beforeHtml: String(body.innerHTML),
        drawn: collectSvgText(body),
        deriveFailed: !!state.reviewDeriveFailed
    });
})()
`;

Promise.all([withApp(CASE(GAPS)), withApp(CASE([]))])
    .then(([withGaps, complete]) => {
        process.stdout.write(JSON.stringify({
            gaps: GAPS,
            withGaps: JSON.parse(withGaps),
            complete: JSON.parse(complete)
        }));
    });
