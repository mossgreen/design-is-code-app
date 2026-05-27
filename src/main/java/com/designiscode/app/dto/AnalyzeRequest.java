package com.designiscode.app.dto;

import java.util.List;

/**
 * Body for {@code POST /api/analyze}.
 *
 * <p>{@code catalog} is optional — present only when the user has connected
 * and scanned a Java/Spring project in Step 1. When present, the analyser
 * lexically filters it to the most relevant types and injects them as
 * grounding into the prompt so the proposed tree reuses existing names
 * rather than inventing parallels.
 *
 * <p>{@code acceptanceCriteria} carries the Step-2 Gherkin rows; the analyser
 * renders them under an "Acceptance criteria" section of the prompt so the
 * generated participants and sequence must satisfy each row. May be null or
 * empty when the user supplied no AC.
 *
 * <p>{@code model} is optional — when present and on the allowlist
 * ({@link com.designiscode.app.service.Models#ALLOWED}) it's forwarded as
 * {@code --model X} to the {@code claude} subprocess. Otherwise the CLI's
 * configured default model is used.
 */
public record AnalyzeRequest(
        String context,
        ScanCatalog catalog,
        List<AcRow> acceptanceCriteria,
        String model
) {}
