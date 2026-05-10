package com.designiscode.app.dto;

/**
 * Snapshot of whether the design-is-code Claude Code plugin is installed in
 * the user's profile, and (if so) which version. The {@code latestVersion}
 * field is populated from the upstream plugin.json when an installed plugin
 * is detected; null when network is unavailable or when the plugin isn't
 * installed (in which case "install" supersedes "update").
 */
public record PluginStatus(
        boolean installed,
        String version,
        String installPath,
        String latestVersion,
        String latestCheckedAt
) {

    public static PluginStatus missing() {
        return new PluginStatus(false, null, null, null, null);
    }
}
