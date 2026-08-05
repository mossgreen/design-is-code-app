## Derived design slice — VisitController.processNewVisitForm

- **Entry:** `processNewVisitForm(owner: Owner, petId: int, visit: Visit, result: BindingResult, redirectAttributes: RedirectAttributes): String`
- **Package:** `org.springframework.samples.petclinic.owner`
- **Wiring:** `owners: OwnerRepository` (constructor)

### Flow — calls on injected collaborators
1. `owners.save(owner)` → `OwnerRepository.save`

### Entity interactions — calls on provided domain types
- `Visit`: `getDate()` ×2
- `Owner`: `addVisit(petId, visit)`

### Not derived — framework, static, or chained receivers
- `LocalDate.now()` — receiver type unresolved (static or unprovided)
- `result.rejectValue("date", "typeMismatch.visitDate")` — `BindingResult` not among the provided sources
- `result.hasErrors()` — `BindingResult` not among the provided sources
- `redirectAttributes.addFlashAttribute("message", "Your visit has been booked")` — `RedirectAttributes` not among the provided sources

### Capture gaps — wholesale REGEN blocked; add-only UPDATE is the fallback
- a branch (if / ternary) in the entry body
- an unattributable call: visit.getDate().isAfter(LocalDate.now()) (self, chained, or static receiver)
- a static call, so there is no collaborator to be an arrow to: LocalDate.now()
- a call on an unprovided type: result.rejectValue() on 'BindingResult'
- a call on an unprovided type: result.hasErrors() on 'BindingResult'
- a call on an unprovided type: redirectAttributes.addFlashAttribute() on 'RedirectAttributes'
