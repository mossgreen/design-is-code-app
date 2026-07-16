## Derived design slice — CancelVisitService.cancel

- **Entry:** `cancel(ownerId: int, petId: int, visitId: int, initiator: String): CancellationResult`
- **Package:** `org.springframework.samples.petclinic.owner`
- **Wiring:** `ownerLoader: OwnerLoader` (constructor)
- **Wiring:** `cancellationGuard: CancellationGuard` (constructor)
- **Wiring:** `feePolicy: CancellationFeePolicy` (constructor)
- **Wiring:** `owners: OwnerRepository` (constructor)

### Flow — calls on injected collaborators
1. `ownerLoader.load(ownerId)` → `OwnerLoader.load` ⇒ `owner : Owner`
2. `cancellationGuard.check(owner, petId, visitId)` → `CancellationGuard.check` ⇒ `hoursUntilVisit : long`
3. `feePolicy.feeFor(hoursUntilVisit)` → `CancellationFeePolicy.feeFor` ⇒ `fee : BigDecimal`
4. `owners.save(owner)` → `OwnerRepository.save`

### Entity interactions — calls on provided domain types
- `Owner`: `removeVisit(petId, visitId)`

### Capture complete — the orchestrator may be regenerated wholesale
