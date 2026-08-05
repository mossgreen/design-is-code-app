// Drives BOTH consumers of the shared step selection against one design, and
// prints what each produced for the Java side to compare.
//
// The property: the picture the reviewer approves and the .puml the plugin reads
// describe the same interactions. Before resolveSteps() they were resolved
// independently, and they disagreed — emitPlantUml emitted `[*] -> SUT` and
// `[*] <-- SUT`, while renderSequenceDiagram had no system-caller branch and
// dropped both steps. Step 3's *after* panel is that renderer, so the reviewer
// signed off a picture missing the entry signature and the return type.
//
// The fixture therefore MUST carry an entry step and a final return. A design
// built only from ordinary calls cannot fail this test: both paths share the
// same guard there, and always did.

const { withApp } = require('./harness');

const CASE = `
const mk = (name, methods) => ({ id: newId(), name, methods, existingFqn: null });

const entry = makeMethod('cancel',
    [{ name: 'visitId', type: 'Long' }, { name: 'initiator', type: 'String' }], 'CancellationResult');
const load = makeMethod('load', [{ name: 'id', type: 'Long' }], 'Visit');
const feeFor = makeMethod('feeFor', [{ name: 'hours', type: 'long' }], 'BigDecimal');

const sut = mk('CancelVisitService', [entry]);
const loader = mk('VisitLoader', [load]);
const policy = mk('CancellationFeePolicy', [feeFor]);

state.participants = [sut, loader, policy];
state.entities = [
    { id: newId(), name: 'CancellationResult', kind: 'record', purpose: '', existingFqn: null,
      fields: [{ name: 'fee', type: 'BigDecimal' }], values: [], behaviors: [], permits: [] }
];
state.sutParticipantId = sut.id;
state.targetPackage = 'com.example.visit';

// Entry, two ordinary calls, final return — the full shape of a wizard design.
state.sequence = [
    { id: newId(), kind: STEP_KIND.CALL, callerId: SYSTEM_CALLER_ID, calleeId: sut.id, methodId: entry.id },
    { id: newId(), kind: STEP_KIND.CALL, callerId: sut.id, calleeId: loader.id, methodId: load.id,
      args: ['visitId'], resultName: 'visit' },
    { id: newId(), kind: STEP_KIND.CALL, callerId: sut.id, calleeId: policy.id, methodId: feeFor.id,
      args: ['hoursUntil'], resultName: 'fee' },
    { id: newId(), kind: STEP_KIND.CALL, callerId: sut.id, calleeId: SYSTEM_CALLER_ID, methodId: entry.id }
];

const container = makeSvgContainer();
renderSequenceDiagram(state.sequence, container);

JSON.stringify({
    interactions: resolveSteps(state.sequence),
    puml: emitPlantUml(),
    drawn: collectSvgText(container)
});
`;

process.stdout.write(withApp(CASE));
