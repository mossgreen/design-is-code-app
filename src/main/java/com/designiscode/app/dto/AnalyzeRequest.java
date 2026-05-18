package com.designiscode.app.dto;

/**
 * Body for {@code POST /api/analyze}.
 *
 * <p>{@code catalog} is optional — present only when the user has connected
 * and scanned a Java/Spring project in Step 1. When present, the analyser
 * lexically filters it to the most relevant types and injects them as
 * grounding into the prompt so the proposed tree reuses existing names
 * rather than inventing parallels.
 */
public record AnalyzeRequest(String context, ScanCatalog catalog) {}
