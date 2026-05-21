package com.designiscode.app.dto;

import java.util.List;

/**
 * Request payload for writing a .puml + (optionally) its decision tables.
 *
 * <p>Two addressing modes:
 * <ul>
 *   <li>Legacy / root design: {@code fileName} only. Writes to
 *       {@code <project>/design/<fileName>.puml}.</li>
 *   <li>Nested sub-design: {@code relativePath} is set (path within the
 *       project, e.g. {@code design/05_sale/CreateSale/DiscountCalculator.puml}).
 *       Takes precedence over {@code fileName}. Decision tables are written
 *       to the same folder.</li>
 * </ul>
 */
public record DesignRequest(
        String projectPath,
        String fileName,
        String content,
        List<DecisionTableFile> decisionTables,
        String relativePath
) {}
