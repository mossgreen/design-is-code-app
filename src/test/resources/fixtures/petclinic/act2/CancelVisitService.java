package org.springframework.samples.petclinic.owner;

import java.math.BigDecimal;

import org.springframework.stereotype.Service;

/**
 * Hand-written EXPECTED Act-1 output (see demo.md): the REGEN-clean
 * orchestrator the DisC plugin is expected to generate from the Act-1
 * "cancel a visit" design. Linear body — no branches, no chained or static
 * calls — so Stage A capture is complete and Act 2 may regenerate it
 * wholesale.
 */
@Service
public class CancelVisitService {

	private final OwnerLoader ownerLoader;

	private final CancellationGuard cancellationGuard;

	private final CancellationFeePolicy feePolicy;

	private final OwnerRepository owners;

	public CancelVisitService(OwnerLoader ownerLoader, CancellationGuard cancellationGuard,
			CancellationFeePolicy feePolicy, OwnerRepository owners) {
		this.ownerLoader = ownerLoader;
		this.cancellationGuard = cancellationGuard;
		this.feePolicy = feePolicy;
		this.owners = owners;
	}

	public CancellationResult cancel(int ownerId, int petId, int visitId, String initiator) {
		Owner owner = this.ownerLoader.load(ownerId);
		long hoursUntilVisit = this.cancellationGuard.check(owner, petId, visitId);
		BigDecimal fee = this.feePolicy.feeFor(hoursUntilVisit);
		owner.removeVisit(petId, visitId);
		this.owners.save(owner);
		return new CancellationResult(fee, initiator);
	}

}
