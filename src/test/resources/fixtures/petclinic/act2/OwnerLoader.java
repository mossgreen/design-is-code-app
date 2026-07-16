package org.springframework.samples.petclinic.owner;

import org.springframework.stereotype.Component;

/**
 * Expected Act-1 output: loader leaf wrapping the repository's
 * {@code Optional} so the orchestrator stays chain-free (REGEN-clean).
 */
@Component
public class OwnerLoader {

	private final OwnerRepository owners;

	public OwnerLoader(OwnerRepository owners) {
		this.owners = owners;
	}

	public Owner load(int ownerId) {
		return this.owners.findById(ownerId)
			.orElseThrow(() -> new IllegalArgumentException("Owner not found with id: " + ownerId));
	}

}
