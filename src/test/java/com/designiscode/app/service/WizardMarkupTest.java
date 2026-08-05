package com.designiscode.app.service;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Structural checks on {@code index.html} — the ones where being in the wrong
 * place makes a feature silently do nothing.
 *
 * <p>The wizard hides a step by putting {@code .hidden} on its
 * {@code <section class="panel">}, and {@code .hidden} is
 * {@code display: none !important}. So un-hiding a node whose section is hidden
 * reveals nothing, and {@code scrollIntoView} on it scrolls nowhere. Placement is
 * therefore behaviour, not layout, and it is invisible to every test that only
 * exercises JavaScript: the function runs, the class comes off, the assertion
 * passes, and the user sees a blank screen.
 *
 * <p>Written after exactly that shipped: the plugin-refusal panel stayed in
 * panel-2 when its only caller moved to the Generate button in panel-4, so a
 * refused generation produced no message at all — the button flickered and
 * nothing happened.
 */
class WizardMarkupTest {

    private static final Path INDEX =
            Path.of("src", "main", "resources", "static", "index.html");

    private static String html;

    @BeforeAll
    static void read() throws IOException {
        assertTrue(Files.exists(INDEX), "index.html missing at " + INDEX);
        html = Files.readString(INDEX);
    }

    /**
     * The refusal panel must live in the step it can fire from. Its only caller is
     * the Generate button's handler, which runs while the user stands on panel-4.
     */
    @Test
    void theRefusalPanelLivesInTheStepThatCanShowIt() {
        assertEquals("panel-4", enclosingPanelOf("plugin-refusal-panel"),
                "the plugin refusal is raised from the Generate handler; anywhere but "
                        + "panel-4 and un-hiding it shows the user nothing");
    }

    /**
     * The data-flow / contract panel is the Step-3 sign-off gate, so it belongs to
     * panel-3 for the same reason. Included so the rule reads as a rule rather
     * than a patch for one incident.
     */
    @Test
    void theSignoffGatePanelLivesInTheSignoffStep() {
        assertEquals("panel-3", enclosingPanelOf("review-dataflow"),
                "the sign-off gate must render in the step that gates sign-off");
    }

    /**
     * Which {@code <section class="panel" id="panel-N">} encloses the element with
     * this id: the last panel to open before it. The markup nests one panel per
     * step and never nests panels, so "most recent opening tag" is the enclosing
     * one.
     */
    private static String enclosingPanelOf(String elementId) {
        int at = html.indexOf("id=\"" + elementId + "\"");
        assertTrue(at >= 0, "no element with id=\"" + elementId + "\" in index.html");

        Matcher m = Pattern.compile("<section[^>]*id=\"(panel-\\d+)\"").matcher(html);
        String enclosing = null;
        while (m.find() && m.start() < at) {
            enclosing = m.group(1);
        }
        assertTrue(enclosing != null, elementId + " sits outside every step panel");
        return enclosing;
    }
}
