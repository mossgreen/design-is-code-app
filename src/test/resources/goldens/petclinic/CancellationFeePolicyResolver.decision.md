---
target: CancellationFeePolicyResolver.resolve
package: org.springframework.samples.petclinic.owner
input:
  key: String
output: CancellationFeePolicy
---

| key | expected |
| --- | --- |
| owner | StandardCancellationFee |
| clinic | ClinicInitiatedFee |
