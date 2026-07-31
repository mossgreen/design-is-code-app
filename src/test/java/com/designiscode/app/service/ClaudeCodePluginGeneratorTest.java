package com.designiscode.app.service;

import com.designiscode.app.dto.GenerationStatus;
import com.designiscode.app.dto.PluginStatus;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The command the banner tells a user to run has to be the command that
 * actually works.
 *
 * <p>This exists because of a real failure, 2026-07-31: an installed-but-old
 * plugin was handed `claude plugin install …`, which succeeds, prints "already
 * installed", and changes nothing. The user runs what the tool told them, sees
 * success, and stays on the broken version — here, the 0.11.0 that predates the
 * resolver-permit fix. A wrong command that fails loudly is recoverable; one
 * that reports success is not.
 */
class ClaudeCodePluginGeneratorTest {

    /** Only {@code status()} is exercised; the rest of the collaborators stay unused. */
    private static ClaudeCodePluginGenerator generatorSeeing(PluginStatus status) {
        PluginService stub = new PluginService(new CancelRegistry()) {
            @Override
            public PluginStatus status() {
                return status;
            }
        };
        return new ClaudeCodePluginGenerator(null, stub);
    }

    @Test
    void anOutdatedPluginIsToldToUpdateNotInstall() {
        GenerationStatus s = generatorSeeing(
                new PluginStatus(true, "0.11.0", "/cache/0.11.0", "0.11.2", null)).status();

        assertEquals(GenerationStatus.State.OUTDATED, s.state());
        assertTrue(s.installCommand().contains("plugin update"),
                () -> "an installed plugin upgrades with `update`: " + s.installCommand());
        assertTrue(!s.installCommand().contains("plugin install"),
                () -> "`install` is a no-op here and must not be suggested: " + s.installCommand());
    }

    @Test
    void aMissingPluginIsStillToldToInstall() {
        GenerationStatus s = generatorSeeing(PluginStatus.missing()).status();

        assertEquals(GenerationStatus.State.NOT_INSTALLED, s.state());
        assertTrue(s.installCommand().contains("plugin install"),
                () -> "nothing to update yet: " + s.installCommand());
    }

    @Test
    void anUpToDatePluginIsReady() {
        GenerationStatus s = generatorSeeing(
                new PluginStatus(true, "0.11.2", "/cache/0.11.2", "0.11.2", null)).status();

        assertEquals(GenerationStatus.State.READY, s.state());
    }

    /**
     * No upstream version means no evidence of being behind. Guessing OUTDATED
     * would nag every offline user into re-running an upgrade they do not need.
     */
    @Test
    void anUnknownLatestVersionIsNotTreatedAsOutdated() {
        GenerationStatus s = generatorSeeing(
                new PluginStatus(true, "0.11.2", "/cache/0.11.2", null, null)).status();

        assertEquals(GenerationStatus.State.READY, s.state());
    }
}
