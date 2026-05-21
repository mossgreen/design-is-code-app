package com.designiscode.app.dto;

import java.util.List;

/**
 * Request payload for the per-participant build-status check.
 *
 * <p>Studio sends the participant names visible in the current Step 4
 * plan-panel. The server walks {@code <projectPath>/src/main/java} once
 * and returns a status (real / stubbed / pending) per name.
 */
public record BuildStatusRequest(String projectPath, List<String> participantNames) {}
