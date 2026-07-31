package com.designiscode.app.service;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Reading the plugin's {@code --validate-only} verdict.
 *
 * <p>This is a gate that fails open on purpose — an unparseable answer must not
 * block a design over what might be a transport hiccup. That design is only safe
 * if a real verdict is reliably recognised, and it was not: the JSON envelope was
 * read only when it began the output, so any run where the model narrated first
 * ("I'll load the language profile…") fell straight through to the soft pass.
 * The gate stopped gating and reported success.
 *
 * <p>Found 2026-08-01 by {@code PluginContractEvalTest}, where it turned two of
 * four real verdicts into skips. In production it was worse: {@code
 * runValidator} asks for haiku, which narrates more, so the check was quietly
 * passing designs it had never actually judged.
 */
class RunServiceValidateVerdictTest {

    private static final ObjectMapper JSON = JsonMapper.builder().build();

    private static Map<String, Object> verdict(String stdout) {
        return RunService.interpretValidateOutput(stdout, JSON);
    }

    @Test
    void aBareEnvelopeIsAPass() {
        Map<String, Object> r = verdict("{\"ok\": true}");
        assertEquals(false, r.get("refused"));
        assertNull(r.get("error"), () -> "a clean pass must carry no diagnostic: " + r);
    }

    /** The regression: the model explains itself, then answers. */
    @Test
    void anEnvelopeAfterNarrationIsStillAPass() {
        Map<String, Object> r = verdict("""
                I'll run the validation in validate-only mode. Let me check for the
                language profile first, then validate the design.

                **Loading language profile:** java_spring.md

                {"ok": true}
                """);
        assertEquals(false, r.get("refused"));
        assertNull(r.get("error"),
                () -> "narration before the verdict must not degrade it to a soft pass: " + r);
    }

    /** And when it quotes the shape it is about to emit, the real one is the last. */
    @Test
    void theLastEnvelopeWinsWhenAnExampleIsQuotedFirst() {
        Map<String, Object> r = verdict("""
                On success I will print {"ok": true}. Checking now.

                {"ok": false, "message": "sealed family Fee has 1 permit"}
                """);
        assertEquals(true, r.get("refused"));
        assertTrue(String.valueOf(r.get("message")).contains("1 permit"), () -> r.toString());
    }

    @Test
    void aRefusalBlockIsARefusal() {
        Map<String, Object> r = verdict("#### REFUSAL — STOP\n\nthe boundary has no bracketing pair");
        assertEquals(true, r.get("refused"));
        assertTrue(String.valueOf(r.get("message")).contains("bracketing"), () -> r.toString());
    }

    /**
     * A refusal that quotes the pass envelope while explaining what it did not
     * find must never read as a pass. Refusal is checked first for exactly this.
     */
    @Test
    void aRefusalThatMentionsTheOkEnvelopeIsStillARefusal() {
        Map<String, Object> r = verdict("""
                #### REFUSAL — STOP

                I could not emit {"ok": true} because the design declares a boundary
                with no bracketing pair.
                """);
        assertEquals(true, r.get("refused"), () -> "refusal must win over a quoted envelope: " + r);
    }

    /** Genuinely unreadable output still fails open — but says so. */
    @Test
    void unreadableOutputSoftPassesWithADiagnostic() {
        Map<String, Object> r = verdict("the CLI printed something nobody expected");
        assertEquals(false, r.get("refused"));
        assertNotNull(r.get("error"), "a soft pass must carry the reason it could not judge");
    }

    @Test
    void emptyOutputSoftPassesRatherThanThrowing() {
        assertEquals(false, verdict("").get("refused"));
        assertEquals(false, verdict(null).get("refused"));
    }
}
