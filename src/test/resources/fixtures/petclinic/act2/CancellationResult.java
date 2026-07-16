package org.springframework.samples.petclinic.owner;

import java.math.BigDecimal;

/**
 * Expected Act-1 output: the cancellation confirmation — the fee charged and
 * who initiated the cancellation (shown on the confirmation screen).
 */
public record CancellationResult(BigDecimal fee, String initiator) {
}
