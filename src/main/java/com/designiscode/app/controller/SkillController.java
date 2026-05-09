package com.designiscode.app.controller;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Exposes static metadata about the DisC skill so the wizard can render a
 * step-by-step checklist that matches what the agent will actually do.
 *
 * <p>The titles are sourced from the skill definition checked into this repo
 * at {@code .claude/skills/disc/SKILL.md} (the canonical copy the user owns).
 * If that file is missing or unparseable, the endpoint returns an empty list
 * and the frontend falls back to a generic numbered list.
 */
@RestController
@RequestMapping("/api")
public class SkillController {

    private static final Path SKILL_PATH =
            Paths.get(".claude/skills/disc/SKILL.md").toAbsolutePath().normalize();

    /** Matches `### Step 1: Validate Inputs` (1-3 hashes, integer step number). */
    private static final Pattern STEP_HEADING =
            Pattern.compile("^#{1,3}\\s*Step\\s+(\\d+):\\s*(.+?)\\s*$");

    @GetMapping(value = "/disc-steps", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> discSteps() {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("source", SKILL_PATH.toString());

        List<Map<String, Object>> steps = new ArrayList<>();
        if (Files.isReadable(SKILL_PATH)) {
            try {
                for (String line : Files.readAllLines(SKILL_PATH)) {
                    Matcher m = STEP_HEADING.matcher(line);
                    if (m.matches()) {
                        Map<String, Object> step = new LinkedHashMap<>();
                        step.put("n", Integer.parseInt(m.group(1)));
                        // Strip a parenthetical suffix like "(apply Transformation Rules)" —
                        // it's helpful in the SKILL.md but noisy in a UI checklist.
                        String title = m.group(2).replaceFirst("\\s*\\(.*\\)\\s*$", "");
                        step.put("title", title);
                        steps.add(step);
                    }
                }
            } catch (IOException ex) {
                response.put("error", "failed to read skill: " + ex.getMessage());
            }
        } else {
            response.put("error", "SKILL.md not found at " + SKILL_PATH);
        }

        response.put("steps", steps);
        return response;
    }
}
