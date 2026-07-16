package org.springframework.samples.petclinic.owner;

import java.math.BigDecimal;

/**
 * Expected Act-1 output: the fee-policy leaf contract. Authored as an
 * interface (Domain Type Rule) so Act 2's variance ticket needs no
 * interface extraction — the existing call site is already on an
 * abstraction.
 */
public interface CancellationFeePolicy {

	BigDecimal feeFor(long hoursUntilVisit);

}
