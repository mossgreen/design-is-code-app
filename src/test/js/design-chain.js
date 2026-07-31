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
process.stdout.write(JSON.stringify(out, null, 2));
