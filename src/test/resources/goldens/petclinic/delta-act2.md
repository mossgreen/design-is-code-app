## Design delta — generate

- **Discriminator:** `initiator` — request-dynamic (source: request)
- **Why:** `initiator` roots in the entry method's input (initiator) → per-request
- **Strategy interface:** `CancellationFeePolicy` — resolver `CancellationFeePolicyResolver`
- **Orchestrator apply mode:** regen — body capture complete; overwritten wholesale from the design

### Changes
| op | element | name | detail |
| --- | --- | --- | --- |
| reuse | entity | `CancellationFeePolicy` | existing strategy interface |
| reuse | entity | `StandardCancellationFee` | existing variant — leaf untouched |
| add | entity | `ClinicInitiatedFee` | new strategy implementing CancellationFeePolicy |
| add | participant | `CancellationFeePolicyResolver` | resolver (isLeaf): resolve(key) -> CancellationFeePolicy |
| add | variance-axis | `CancellationFeePolicy` | resolver; bindingTime=request-dynamic; discriminatorSource=request; mapping owner->StandardCancellationFee, clinic->ClinicInitiatedFee |
| add | sidecar | `CancellationFeePolicyResolver.decision.md` | 2 rows: key -> strategy |
| modify | arrow | `CancelVisitService` | CancelVisitService -> CancellationFeePolicyResolver.resolve(key), then dispatch to CancellationFeePolicy (regenerated wholesale; linear, no branch at the orchestrator) |

### Resolver mapping — `initiator` → strategy
| key | strategy |
| --- | --- |
| owner | `StandardCancellationFee` |
| clinic | `ClinicInitiatedFee` |

### What this design does not pin
_No warnings — the delta is minimal and fully derivable._
