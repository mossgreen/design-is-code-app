package com.designiscode.app.service;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Update-mode grounding plumbing (2026-07-20 brownfield-grounding fix set):
 * the {@code {CURRENT_FLOWS}} placeholder exists in the template, the flows
 * section renders both states, and the update-mode rule file is present with
 * well-formed frontmatter. Guards against the silent failure where the
 * analyzer designs blind to the code it will overwrite.
 */
class AnalyzeServicePromptTest {

    private static final Path PROMPTS = Path.of("src", "main", "resources", "prompts");

    @Test
    void templateCarriesCurrentFlowsPlaceholder() throws IOException {
        String template = Files.readString(PROMPTS.resolve("analyzer.md"));
        assertTrue(template.contains("{CURRENT_FLOWS}"),
                "analyzer.md must carry the {CURRENT_FLOWS} placeholder");
        assertTrue(template.contains("Preserve every call"),
                "analyzer.md must state the preservation rule next to the flows");
    }

    @Test
    void renderCurrentFlowsHandlesBothStates() {
        String none = AnalyzeService.renderCurrentFlows(null);
        assertTrue(none.contains("None"), "absent flows must render an explicit none-line");
        assertTrue(AnalyzeService.renderCurrentFlows(List.of("  ", "")).contains("None"),
                "blank entries count as absent");

        String two = AnalyzeService.renderCurrentFlows(List.of("## Flow A", "## Flow B"));
        assertTrue(two.contains("## Flow A") && two.contains("## Flow B"));
        assertTrue(two.contains("---"), "multiple flows are visibly separated");
    }

    @Test
    void updateModeRuleExistsAndIsWellFormed() throws IOException {
        Path rule = PROMPTS.resolve("rules").resolve("update-mode-binding.md");
        assertTrue(Files.exists(rule), "update-mode-binding.md rule file missing");
        String body = Files.readString(rule);
        assertTrue(body.startsWith("---"), "rule needs frontmatter");
        assertTrue(body.contains("id: update-mode-binding"));
        assertTrue(body.contains("severity: must"));
        assertTrue(body.contains("existingFqn"), "the binding obligation is the rule's point");
    }

    @Test
    void everyRuleFileHasFrontmatterId() throws IOException {
        try (Stream<Path> files = Files.list(PROMPTS.resolve("rules"))) {
            files.filter(p -> p.toString().endsWith(".md")).forEach(p -> {
                try {
                    String body = Files.readString(p);
                    assertTrue(body.contains("id: "), p + " missing frontmatter id");
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            });
        }
    }
}
