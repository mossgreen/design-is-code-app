package com.designiscode.app.dto;

/**
 * A single acceptance-criterion row in structured Gherkin form
 * (Given / When / Then). Sent as part of {@link AnalyzeRequest} so the
 * analyser can constrain participants and sequence steps to satisfy each
 * row.
 *
 * <p>Any of the three fields may be empty; rows with all three blank are
 * dropped client-side before being POSTed.
 */
public record AcRow(String given, String when, String then) {}
