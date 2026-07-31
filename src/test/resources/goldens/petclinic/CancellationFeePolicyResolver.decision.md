---
target: CancellationFeePolicyResolver.resolve
package: org.springframework.samples.petclinic.owner
input:
  initiator: String
output: CancellationFeePolicy
---

| initiator | expected |
| --- | --- |
| owner | StandardCancellationFee |
| clinic | ClinicInitiatedFee |
