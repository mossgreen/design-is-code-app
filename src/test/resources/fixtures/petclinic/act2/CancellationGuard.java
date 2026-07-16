package org.springframework.samples.petclinic.owner;

import java.time.Duration;
import java.time.LocalDateTime;

import org.springframework.stereotype.Component;

/**
 * Expected Act-1 output: guard leaf owning the past-visit branch (the
 * orchestrator stays linear) and the hours-until-visit computation, both of
 * which need "now". Throws on past visits; returns the hours the fee policy
 * needs.
 */
@Component
public class CancellationGuard {

	public long check(Owner owner, int petId, int visitId) {
		Visit visit = owner.getPet(petId)
			.getVisits()
			.stream()
			.filter(v -> Integer.valueOf(visitId).equals(v.getId()))
			.findFirst()
			.orElseThrow(() -> new IllegalArgumentException("Visit not found: " + visitId));
		LocalDateTime visitStart = visit.getDate().atStartOfDay();
		long hours = Duration.between(LocalDateTime.now(), visitStart).toHours();
		if (hours < 0) {
			throw new IllegalStateException("Past visits cannot be cancelled");
		}
		return hours;
	}

}
