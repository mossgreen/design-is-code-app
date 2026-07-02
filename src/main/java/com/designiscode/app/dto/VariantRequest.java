package com.designiscode.app.dto;

import java.util.List;

/**
 * The ticket specifics Stage C needs to compute a delta: which call site is the
 * variation point, the new variant to introduce, and the discriminator→strategy
 * mapping the AC defines.
 *
 * @param calleeType            the type being varied (the variation point), e.g.
 *                              {@code TaxCalculator} (an interface) or
 *                              {@code DomesticTax} (a concrete class needing DIP)
 * @param newVariant            the new strategy class to introduce, e.g.
 *                              {@code InternationalTax}
 * @param mapping               discriminator value → strategy (existing + new),
 *                              e.g. {@code DOMESTIC→DomesticTax,
 *                              INTERNATIONAL→InternationalTax}
 * @param strategyInterfaceName the abstraction to extract — required only when
 *                              {@code calleeType} is a concrete class; null when
 *                              the call site is already on an interface
 */
public record VariantRequest(
        String calleeType,
        String newVariant,
        List<DesignDelta.MappingRow> mapping,
        String strategyInterfaceName
) {}
