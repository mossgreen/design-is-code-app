package com.designiscode.app.dto;

/**
 * Derive-only result (Stage A + rendering, no delta): the "what IS" view of
 * one entry method, used when a ticket is additive rather than a variance —
 * the design-first PR's context half. See {@code POST /api/code-derive}.
 */
public record DeriveResult(
        DerivedSlice slice,
        String sliceMarkdown,
        String slicePuml
) {}
