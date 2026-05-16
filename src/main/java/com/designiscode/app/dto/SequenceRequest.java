package com.designiscode.app.dto;

import java.util.List;
import java.util.Map;

/**
 * Request body for POST /api/sequence.
 *
 * <p>{@code participants} is intentionally loose-typed (List of Maps) — the
 * model only reads name / methods / args / returns / purpose; future schema
 * changes to participants don't ripple into this DTO.
 *
 * <p>{@code sut} is the participant NAME marked as System Under Test, or
 * empty/null if none. If set, the prompt instructs the model to make every
 * call originate from this orchestrator and to omit the [*] boundary rows
 * (which the wizard manages separately).
 */
public record SequenceRequest(
        String story,
        List<Map<String, Object>> participants,
        String sut
) {}
