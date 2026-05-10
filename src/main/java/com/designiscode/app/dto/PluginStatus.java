package com.designiscode.app.dto;

/**
 * Snapshot of whether the design-is-code Claude Code plugin is installed in
 * the user's profile, and (if so) which version. Both fields are null when
 * {@code installed} is false.
 */
public record PluginStatus(boolean installed, String version, String installPath) {

    public static PluginStatus missing() {
        return new PluginStatus(false, null, null);
    }
}
