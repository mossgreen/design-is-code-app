---
id: dataflow-provenance
title: every value has a source
why: a design whose values do not connect generates code that compiles, passes its tests, and does nothing — the failure is invisible to every check that counts arrows instead of tracing values
applies-when: always
severity: must
assertion: every argument of every non-entry behavior is either a parameter of the SUT's entry behavior or the return of another behavior in the design; the SUT's entry signature carries every discriminator named in `variancePlan`; and no placeholder name (`key`, `input`, `value`, `data`) survives into a signature
---

A sequence of calls is only a design if the values connect. Two participants can
be perfectly named, in a perfectly sensible order, and still describe a feature
that does nothing.

**The direction of the contract.** A leaf does not author its own signature. The
caller's need pins it: the orchestrator holds certain values, and the leaf's
parameters are whatever the orchestrator can actually hand over. Design the
orchestrator's flow first, then give each leaf the signature that flow requires.
Designing a leaf in isolation and hoping the orchestrator can feed it is how
severed designs happen.

(This does not contradict `leaf-freestandingness`. That rule governs a leaf's
*purpose* — it must be describable without naming another participant. This rule
governs its *signature* — which the caller determines. A leaf can be
conceptually freestanding and still take exactly the arguments its caller has.)

**Where values come from.** At any point in the orchestrator, the values that
exist are: the entry behavior's parameters, the returns of behaviors called
earlier, fields reached from one of those, and literals. That is the whole
universe. A parameter that cannot be filled from it is a parameter the design
cannot honour.

One behavior's `returns` becoming the next behavior's argument is a **`data_pipe`**
— the term the plugin's own methodology uses for it. Your design is a chain of
`data_pipe`s, and this rule says the chain must not have gaps at either end: no
argument without a source, no result without a consumer.

**Three concrete duties:**

1. **Every argument traces back.** For each behavior's `args[]`, ask: which entry
   parameter or which other behavior's `returns` supplies this? If the answer is
   "nothing", you have either forgotten a behavior that produces it, or the entry
   signature is missing an input.
2. **Every produced value is used.** If a behavior returns something and no other
   behavior takes that type as an argument, and it is not the operation's
   outcome, then either a call is missing or that behavior should not exist.
   This is the exact shape of a real failure: a rule was fetched from a rule
   table and never handed to the participant that applies it. Everything looked
   right; the feature did nothing.
3. **The discriminator is an input.** When `variancePlan` selects on a
   discriminator, the SUT's entry behavior must actually receive it, or a
   behavior in the flow must return it. A variance axis keyed on a value the
   orchestrator never sees cannot be implemented.

**A reused type's methods are fixed.** When a participant or entity carries an
`existingFqn`, it already exists in the codebase and its public surface is
whatever the catalog says it is — you cannot add to it by wishing. If the flow
needs a value that type does not expose, do not write `thing.somethingConvenient()`
and hope: introduce a participant that computes the value from what the type
*does* expose, and let it return the value the flow needs. A design that invokes
a method the class does not have produces code that will not compile, and the
catalog above is the list of what is really there.

**Never ship a placeholder.** The pattern sketches elsewhere in this prompt use
abstract names — `key`, `input`, `rule`, `Strategy` — because they describe
shapes, not domains. In your output every one of them becomes a real name from
this story's vocabulary: not `resolve(key)` but `resolve(initiator)`; not
`apply(input)` but `apply(cancellationRequest)`. A literal `key` in a signature
is a sign the shape was copied rather than instantiated.
