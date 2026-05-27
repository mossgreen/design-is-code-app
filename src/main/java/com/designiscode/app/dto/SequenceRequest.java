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
 *
 * <p>{@code model} is optional — when present and on the allowlist
 * ({@link com.designiscode.app.service.Models#ALLOWED}) it's forwarded as
 * {@code --model X} to the {@code claude} subprocess. Otherwise the CLI's
 * configured default model is used.
 *
 * <p>{@code refusalFeedback} is set only on retry. When the plugin's
 * validator refuses the first attempt, the wizard re-posts the sequence
 * request with the refusal markdown in this field; the prompt threads it
 * into a "Previous attempt" section so the model can produce a corrected
 * sequence. Null/blank on the first attempt — the prompt substitutes a
 * "first attempt" sentinel.
 */
public record SequenceRequest(
        String story,
        List<Map<String, Object>> participants,
        String sut,
        String model,
        String refusalFeedback
) {}
