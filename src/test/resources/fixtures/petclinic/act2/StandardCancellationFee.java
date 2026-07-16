package org.springframework.samples.petclinic.owner;

import java.math.BigDecimal;

import org.springframework.stereotype.Component;

/**
 * Expected Act-1 output: the 48-hour rule from the decision table —
 * >= 48h free, under 48h a $20 late fee (boundary pinned by the 48/47
 * bracketing pair).
 */
@Component
public class StandardCancellationFee implements CancellationFeePolicy {

	private static final BigDecimal LATE_FEE = new BigDecimal("20.00");

	@Override
	public BigDecimal feeFor(long hoursUntilVisit) {
		if (hoursUntilVisit >= 48) {
			return BigDecimal.ZERO;
		}
		return LATE_FEE;
	}

}
