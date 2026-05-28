---
id: R-dataflow
name: dataflow scope
summary: Every method-call argument must be sourceable from the SUT entry or a prior call's return
applies-to: every CALL row in the sequence you emit
---

Every argument in every `caller -> callee : method(arg1, arg2, ...)` row
of your sequence MUST be **sourceable** from one of these three places:

1. **An entry parameter of the SUT** — a top-level parameter of the
   SUT's entry method. If the entry method is
   `calculate(request: VisitFeeRequest)`, then `request` is in scope.
2. **A field of an entry parameter** — accessed via record component
   or getter (`request.petId`, `request.category()`,
   `order.carrier`). The field must exist on the entity declared in
   the analyzer's `entities[]` block.
3. **The return value of a prior call in the same scope** — the LHS
   of an earlier `caller <-- callee : ReturnType` row. The implied
   binding is the **lowercased simple name of the return type**
   (`Pet pet`, `Order order`, `DiscountRule discountRule`). Reference
   the value by that name in subsequent rows.

## When the AC implies a value you cannot source

If the AC mentions an entity by name but the entry parameter only
carries an ID (e.g. AC says "for a cat" but the SUT was given
`petId: int`), you MUST insert an explicit lookup step **before** any
call that needs the derived value:

```
SUT -> PetRepository : findById(petId)
SUT <-- PetRepository : Pet
```

Subsequent rows can then reference `pet.type`, `pet.name`, etc.

**Prefer REUSE participants** from the codebase catalog (e.g. an
existing `PetRepository`). Only invent a new lookup participant when
no catalog match exists for the entity you need.

## Self-check before emitting

Mentally walk each row top to bottom:

- For each `caller -> callee : method(a, b, c)`, can you point to
  exactly where each of `a, b, c` came from in scope?
- If no — insert a lookup row **above** the offending call, or
  restate the SUT's entry method signature to carry the value
  directly.

Examples of violations the wizard's validator will surface:

- ❌ `findApplicable(petType, daysSinceLastVisit)` when SUT entry is
  `(petId, visitDate)` and no `petRepository.findById(petId)` step
  precedes it.
- ❌ `apply(rule, baseFee)` when no earlier row binds `rule` (i.e.
  no row returns a `DiscountRule`).

A row that fails this check leaves the generated orchestrator with
`TODO design gap` comments and broken arguments — the worst possible
output, because tests compile but production code does nothing.
