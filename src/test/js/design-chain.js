// Drives the wizard's design chain — sequencer JSON → resolveSequence →
// emitPlantUml — and prints one .puml per case as JSON for the Java side to
// assert against.
//
// Each case is a PROPERTY of the notation, not a scenario. The domain (checkout)
// is deliberately not PetClinic: these guard how bindings behave in general, and
// the PetClinic goldens already guard that one flow byte-for-byte.

const { withApp } = require('./harness');

// Build a design and run one sequencer response through it. `spec.methods` is
// the callees' DECLARED signatures; `spec.steps` is what the sequencer returned.
// The two use different vocabularies on purpose — that gap is the whole point.
const CASE = (spec) => `
const mk = (name, methods) => ({ id: newId(), name, methods, existingFqn: null });
const spec = ${JSON.stringify(spec)};

const methodsByOwner = {};
const participants = spec.participants.map(p => {
    const methods = (spec.methods[p] || []).map(m => makeMethod(m.name, m.inputs || [], m.output || ''));
    methodsByOwner[p] = methods;
    return mk(p, methods);
});
const sut = participants[0];

state.participants = participants;
// Entities matter: the unconsumed-value rule only judges types the design itself
// introduces, and both the wizard and the pipeline always emit an entity prelude.
// A case without one would be testing a design shape that never occurs.
state.entities = (spec.entities || []).map(e => ({
    id: newId(), name: e.name, kind: e.kind || 'record', purpose: '',
    existingFqn: null, fields: e.fields || [], values: [], behaviors: [], permits: []
}));
state.sutParticipantId = sut.id;
state.targetPackage = 'com.example.checkout';
state.sequence = [
    { id: newId(), kind: STEP_KIND.CALL, callerId: SYSTEM_CALLER_ID, calleeId: sut.id,
      methodId: methodsByOwner[sut.name][0].id },
    { id: newId(), kind: STEP_KIND.CALL, callerId: sut.id, calleeId: SYSTEM_CALLER_ID,
      methodId: methodsByOwner[sut.name][0].id }
];

const resolved = resolveSequence({ steps: spec.steps });
applyResolvedSequence(resolved.sequence);
JSON.stringify({ warnings: resolved.warnings, puml: emitPlantUml() });
`;

const ENTRY = { name: 'checkout', inputs: [{ name: 'orderId', type: 'Long' }, { name: 'region', type: 'String' }], output: 'Receipt' };

const cases = {

    // The defect this whole change exists to prevent: the callee declares `key`
    // and `hours`; the caller holds `region` and `subtotal`. The arrow must show
    // what is passed, because the plugin turns it into verify(collab).m(value).
    bindingWinsOverDeclaration: {
        participants: ['CheckoutService', 'TaxResolver', 'TaxCalculator'],
        methods: {
            CheckoutService: [ENTRY],
            TaxResolver: [{ name: 'resolve', inputs: [{ name: 'key', type: 'String' }], output: 'TaxCalculator' }],
            TaxCalculator: [{ name: 'calculate', inputs: [{ name: 'hours', type: 'BigDecimal' }], output: 'BigDecimal' }]
        },
        steps: [
            { caller: 'CheckoutService', callee: 'TaxResolver', method: 'resolve', args: ['region'], resultName: 'strategy' },
            { caller: 'CheckoutService', callee: 'TaxCalculator', method: 'calculate', args: ['orderId'], resultName: 'tax' }
        ]
    },

    // A hand-built or pre-binding step carries no args. Rather than emitting an
    // empty call, fall back to the declared names — still valid, and the linter
    // then judges whether those names actually resolve.
    fallsBackToDeclaredNames: {
        participants: ['CheckoutService', 'OrderLoader'],
        methods: {
            CheckoutService: [ENTRY],
            OrderLoader: [{ name: 'load', inputs: [{ name: 'orderId', type: 'Long' }], output: 'Order' }]
        },
        steps: [{ caller: 'CheckoutService', callee: 'OrderLoader', method: 'load' }]
    },

    // The old response shape put {name,type} objects in `args`. Those are a
    // signature, not a binding: they must not be mistaken for values.
    oldShapeResponseStillResolves: {
        participants: ['CheckoutService', 'OrderLoader'],
        methods: { CheckoutService: [ENTRY] },
        steps: [{
            caller: 'CheckoutService', callee: 'OrderLoader', method: 'load',
            args: [{ name: 'orderId', type: 'Long' }], returns: 'Order'
        }]
    },

    // Severed flow: a discount is fetched and handed to nobody, and `basket`
    // arrives from nowhere. Both are invisible to arrow-parity checks.
    severedFlowIsVisible: {
        participants: ['CheckoutService', 'DiscountRepository', 'PriceCalculator'],
        methods: {
            CheckoutService: [ENTRY],
            DiscountRepository: [{ name: 'findFor', inputs: [{ name: 'region', type: 'String' }], output: 'Discount' }],
            PriceCalculator: [{ name: 'price', inputs: [{ name: 'basket', type: 'Basket' }], output: 'BigDecimal' }]
        },
        entities: [{ name: 'Discount', kind: 'record', fields: [{ name: 'percentOff', type: 'int' }] }],
        steps: [
            { caller: 'CheckoutService', callee: 'DiscountRepository', method: 'findFor', args: ['region'], resultName: 'discount' },
            { caller: 'CheckoutService', callee: 'PriceCalculator', method: 'price', args: ['basket'], resultName: 'total' }
        ]
    },

    // A non-void step with no resultName still has to chain: the name is inferred
    // from the consumer that needs its type, so the next call resolves.
    unnamedResultStillChains: {
        participants: ['CheckoutService', 'OrderLoader', 'PriceCalculator'],
        methods: {
            CheckoutService: [ENTRY],
            OrderLoader: [{ name: 'load', inputs: [{ name: 'orderId', type: 'Long' }], output: 'Order' }],
            PriceCalculator: [{ name: 'price', inputs: [{ name: 'order', type: 'Order' }], output: 'BigDecimal' }]
        },
        steps: [
            { caller: 'CheckoutService', callee: 'OrderLoader', method: 'load', args: ['orderId'] },
            { caller: 'CheckoutService', callee: 'PriceCalculator', method: 'price', args: ['order'], resultName: 'total' }
        ]
    }
};

const out = {};
for (const [name, spec] of Object.entries(cases)) {
    out[name] = JSON.parse(withApp(CASE(spec)));
}

// The accessor rule is only as good as the catalogue the wizard sends it. This
// is the other half of that contract: reused types are included with their real
// methods, types the design is creating are not (they have no methods yet), and
// an unbound project sends nothing at all so the rule stays silent.
out.knownTypesPayload = JSON.parse(withApp(`
state.codebaseCatalog = { types: [
  { fqn: 'com.example.Visit', name: 'Visit', publicMethods: [{name:'getDate'},{name:'getPet'}] },
  { fqn: 'com.example.Owner', name: 'Owner', publicMethods: [{name:'getPets'}] }
]};
state.participants = [{ id: newId(), name: 'CancelService', methods: [], existingFqn: null }];
state.entities = [
  { id: newId(), name: 'Visit', kind: 'class', existingFqn: 'com.example.Visit', fields: [] },
  { id: newId(), name: 'Fee',   kind: 'record', existingFqn: null, fields: [] }
];
const bound = reusedTypeMethods();
state.codebaseCatalog = null;
JSON.stringify({ bound, unconnected: reusedTypeMethods() });
`));

// The .decision.md frontmatter contract, across all three sidecar emitters at
// once. The plugin refuses at Step 1 when a required_decision is pinned by
// neither rows nor `config:` — but resolver mode is exempt, because its body is
// a Map lookup with no such decision in it. Emitting the wrong one either way is
// a file the generator will not accept, and nothing tested this before.
out.decisionFrontmatter = JSON.parse(withApp(`
state.targetPackage = 'com.example.checkout';

const feeLeaf = { id: newId(), name: 'LateFeeCalculator', kind: 'leaf', existingFqn: null, methods: [
  makeMethod('calculate', [{ name: 'hours', type: 'Integer' }], 'BigDecimal',
             [{ inputs: { hours: 12 }, expected: '20.00' },
              { inputs: { hours: 72 }, expected: '0.00' }])
]};
const rateTable = { id: newId(), name: 'FeeRateTable', kind: 'leaf', existingFqn: null, methods: [
  makeMethod('ruleFor', [{ name: 'initiator', type: 'String' }], 'FeeRate')
]};
const resolver = { id: newId(), name: 'FeePolicyResolver', kind: 'leaf', existingFqn: null, methods: [
  makeMethod('resolve', [{ name: 'initiator', type: 'String' }], 'FeePolicy')
]};
state.participants = [feeLeaf, rateTable, resolver];

state.entities = [
  { id: newId(), name: 'FeeRate', kind: 'record', existingFqn: null,
    fields: [{ name: 'percent', type: 'int' }, { name: 'cap', type: 'BigDecimal' }],
    values: [], behaviors: [], permits: [] },
  { id: newId(), name: 'FeePolicy', kind: 'interface', existingFqn: null, fields: [], values: [],
    behaviors: [{ name: 'feeFor' }], permits: ['StandardFee', 'ClinicInitiatedFee'] }
];

state.variancePlan = [
  { axis: 'initiator', pattern: 'resolver', mapping: [
      { key: 'owner', strategy: 'StandardFee' },
      { key: 'clinic', strategy: 'ClinicInitiatedFee' } ] },
  { axis: 'rate', pattern: 'rule-table', mapping: [
      { key: 'owner', expected: { percent: 20, cap: '50.00' } },
      { key: 'clinic', expected: { percent: 0, cap: '0.00' } } ] }
];

JSON.stringify({
  resolver: collectResolverDecisionTables(),
  ruleTable: collectRuleTableDecisionTables(),
  leaf: collectPureFunctionLeafDecisionTables(),
  all: collectAllDecisionTables().map(d => d.fileName)
});
`));

// Save writes one set of sidecars and the gate judges one set; they must be the
// same set, or the reviewer is warned about files that never land. Precedence
// matters too: a table the human filled in must not be replaced by a
// synthesised one for the same participant.
out.decisionPrecedence = JSON.parse(withApp(`
state.targetPackage = 'com.example.checkout';
const leaf = { id: newId(), name: 'LateFeeCalculator', kind: 'leaf', existingFqn: null, methods: [
  makeMethod('calculate', [{ name: 'hours', type: 'Integer' }], 'BigDecimal',
             [{ inputs: { hours: 12 }, expected: '20.00' }])
]};
state.participants = [leaf];
state.entities = [];
state.variancePlan = [];
const auto = collectAllDecisionTables();

// Now attach a human-authored table to the same participant via a CALL step.
state.sequence = [{ id: newId(), kind: STEP_KIND.CALL, callerId: SYSTEM_CALLER_ID,
                    calleeId: leaf.id, methodId: leaf.methods[0].id,
                    decisionTable: { config: { nullHandling: 'passThrough' },
                                     rows: [{ values: ['12'], expected: '99.99' }] } }];
const authored = collectAllDecisionTables();

JSON.stringify({
  autoCount: auto.length,
  authoredCount: authored.length,
  authoredContent: authored[0].content
});
`));

// A default the wizard picked is a decision nobody made, and the sign-off panel
// is the last place it can still be caught. The summary is what that panel
// renders from, so it must name the file and the specific keys — "some defaults
// were applied" tells a reviewer nothing they can act on.
out.appliedDefaultsSummary = JSON.parse(withApp(`
state.targetPackage = 'com.example.checkout';
const leaf = { id: newId(), name: 'LateFeeCalculator', kind: 'leaf', existingFqn: null, methods: [
  makeMethod('calculate', [{ name: 'hours', type: 'Integer' }], 'BigDecimal',
             [{ inputs: { hours: 12 }, expected: '20.00' },
              { inputs: { hours: 72 }, expected: '0.00' }])
]};
const resolver = { id: newId(), name: 'FeePolicyResolver', kind: 'leaf', existingFqn: null, methods: [
  makeMethod('resolve', [{ name: 'initiator', type: 'String' }], 'FeePolicy')
]};
state.participants = [leaf, resolver];
state.entities = [
  { id: newId(), name: 'FeePolicy', kind: 'interface', existingFqn: null, fields: [], values: [],
    behaviors: [{ name: 'feeFor' }], permits: ['StandardFee', 'ClinicInitiatedFee'] }
];
state.variancePlan = [
  { axis: 'initiator', pattern: 'resolver', mapping: [
      { key: 'owner', strategy: 'StandardFee' },
      { key: 'clinic', strategy: 'ClinicInitiatedFee' } ] }
];

// Nothing authored yet: the numeric leaf should report every config key as a
// default, and the resolver — which emits no config block — should not appear.
const untouched = appliedDefaultsSummary();

// Now the human states nullHandling. It must drop out of the summary while the
// arithmetic keys it did not state stay.
state.sequence = [{ id: newId(), kind: STEP_KIND.CALL, callerId: SYSTEM_CALLER_ID,
                    calleeId: leaf.id, methodId: leaf.methods[0].id,
                    decisionTable: { config: { nullHandling: 'passThrough' },
                                     rows: [{ values: ['12'], expected: '20.00' }] } }];
const authored = appliedDefaultsSummary();

JSON.stringify({
  untouched: untouched,
  authored: authored,
  resolverListed: untouched.some(s => s.fileName.indexOf('Resolver') !== -1)
});
`));

// The contract checks read the ANALYZER model shape, but the wizard holds an
// edited form where behaviors are `methods` and args are `inputs`, and the SUT
// is an id. designModelForContract() is that translation, and if it is wrong the
// sign-off panel reports violations about a design nobody has. So: project a
// known-good design and a deliberately broken one, and let Java judge both
// through the real validator.
//
// EVERY entity here is built the way the APP builds one — makeEntity() for a
// hand-added entity, mergeDerivedEntities() for one inferred from a signature —
// never as an object literal. The first version of this fixture wrote its
// entities by hand, complete with the `ownedBy` the analyzer supplies and the
// wizard does not, so it proved the projection worked on data the projection
// never sees. A fixture shaped to pass tests the fixture.
out.contractProjection = JSON.parse(withApp(`
state.targetPackage = 'com.example.checkout';
state.story = 'An owner cancels a visit and may be charged a late fee.';
state.ac = [{ given: 'a visit', when: 'cancelled late', then: 'a fee applies' }];

const policy = { id: newId(), name: 'CancellationFeePolicy', kind: 'leaf', existingFqn: null, methods: [
  makeMethod('feeFor', [{ name: 'hoursUntilVisit', type: 'long' }], 'BigDecimal',
             [{ acIndex: 0, inputs: { hoursUntilVisit: 47 }, expected: '20.00' }])
]};
const svc = { id: newId(), name: 'CancelVisitService', kind: 'orchestrator', existingFqn: null, methods: [
  makeMethod('cancel', [{ name: 'ownerId', type: 'int' }], 'CancellationResult')
]};
state.participants = [svc, policy];
state.sutParticipantId = svc.id;
state.entities = [];
state.variancePlan = [];

// CancellationResult is named by cancel()'s return type, so this is the path a
// real Analyze takes: the wizard invents the entity from the signature.
mergeDerivedEntities();

const good = designModelForContract();
const derivedNames = state.entities.map(e => e.name);

// Break exactly one rule the validator owns: a sealed family needs >= 2 permits.
// Built with makeEntity(), the same call the "+ Entity" button makes.
const fam = makeEntity('FeePolicy', 'sealed-interface');
fam.behaviors = [{ name: 'feeFor', args: [], returns: 'BigDecimal' }];
fam.permits = ['OnlyOne'];
const only = makeEntity('OnlyOne', 'record');
state.entities = state.entities.concat([fam, only]);
const broken = designModelForContract();

JSON.stringify({ good: good, broken: broken, derivedNames: derivedNames });
`));

process.stdout.write(JSON.stringify(out, null, 2));
