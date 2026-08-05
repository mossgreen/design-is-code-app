package com.designiscode.app.service;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Defends P3a — <b>what the human approved equals what was written</b>.
 *
 * <p>The wizard shows a design twice and writes it once. Step 2's live diagram
 * and Step 3's <i>after</i> panel both come from {@code renderSequenceDiagram};
 * the file the plugin reads comes from {@code emitPlantUml}. Until 2026-08-01
 * each resolved the sequence for itself, and they disagreed: {@code emitPlantUml}
 * special-cased the system caller to emit {@code [*] -> SUT} and
 * {@code [*] <-- SUT}, while the renderer had no such branch, so
 * {@code findParticipant('__system_caller__')} returned undefined and its guard
 * dropped both steps. The reviewer signed off a picture with no entry signature
 * and no return type, and the file carried both anyway.
 *
 * <p>{@code resolveSteps()} now makes that disagreement unrepresentable — one
 * selection, two renderings. This is the net that stops them drifting apart
 * again, so the fixture <b>must</b> carry an entry step and a final return: for
 * ordinary calls the two paths share a guard and always did, and a fixture built
 * only from those cannot fail no matter how far the code regresses.
 */
class DesignAgreementTest {

	private static final ObjectMapper JSON = JsonMapper.builder().build();
	private static final Path SCRIPT = Path.of("src", "test", "js", "design-agreement.js");
	private static final String SYSTEM_LIFELINE = "[*]";

	/** {@code LEFT -> RIGHT : label}, where the label may itself contain " : ". */
	private static final Pattern ARROW =
			Pattern.compile("^(\\S+) (->|<--|-->) (\\S+) : (.*)$");

	private static JsonNode result;

	@BeforeAll
	static void render() throws IOException, InterruptedException {
		Assumptions.assumeTrue(Files.exists(SCRIPT), "design-agreement.js missing");
		ProcessBuilder pb = new ProcessBuilder("node", SCRIPT.toString()).redirectErrorStream(true);
		Process p;
		try {
			p = pb.start();
		} catch (IOException e) {
			Assumptions.abort("node not on PATH — design agreement test skipped");
			return;
		}
		String out = new String(p.getInputStream().readAllBytes());
		assertTrue(p.waitFor(60, TimeUnit.SECONDS), "design-agreement.js timed out");
		assertEquals(0, p.exitValue(), () -> "design-agreement.js failed:\n" + out);
		result = JSON.readTree(out);
	}

	/** Arrow lines of the emitted .puml, in order, normalised to `arrow left right label`. */
	private static List<String> pumlArrows() {
		List<String> out = new ArrayList<>();
		for (String line : result.get("puml").asString().split("\n")) {
			Matcher m = ARROW.matcher(line.trim());
			if (m.matches()) {
				out.add(m.group(2) + " " + m.group(1) + " " + m.group(3) + " " + m.group(4));
			}
		}
		return out;
	}

	/**
	 * The arrows the shared selection implies, in the same normalised form. This
	 * derives from {@code resolveSteps()} output — the list the renderer draws —
	 * so comparing it to the text is comparing the two surfaces.
	 */
	private static List<String> interactionArrows() {
		List<String> out = new ArrayList<>();
		for (JsonNode it : result.get("interactions")) {
			String kind = it.get("kind").asString();
			String from = name(it, "from");
			String to = name(it, "to");
			String label = it.get("label").isNull() ? null : it.get("label").asString();
			String ret = it.get("ret").isNull() ? null : it.get("ret").asString();

			switch (kind) {
				case "entry" -> out.add("-> " + SYSTEM_LIFELINE + " " + to + " " + label);
				case "exit" -> out.add("<-- " + SYSTEM_LIFELINE + " " + from + " " + ret);
				default -> {
					out.add("-> " + from + " " + to + " " + label);
					if (it.get("isCreate").asBoolean()) {
						String created = it.get("createsName").asString();
						out.add("--> " + to + " " + from + " "
								+ it.get("createdValue").asString() + " : " + created);
					} else if (ret != null) {
						out.add("<-- " + from + " " + to + " " + ret);
					}
				}
			}
		}
		return out;
	}

	/** Same fallback for an unnamed participant that {@code emitPlantUml} applies. */
	private static String name(JsonNode it, String field) {
		JsonNode n = it.get(field);
		if (n == null || n.isNull()) return "_";
		String s = n.asString();
		return s.isEmpty() ? "_" : s;
	}

	private static List<String> drawnLabels() {
		List<String> out = new ArrayList<>();
		result.get("drawn").forEach(n -> out.add(n.asString()));
		return out;
	}

	/** Just the label of each .puml arrow, in order. */
	private static List<String> pumlArrowLabels() {
		List<String> out = new ArrayList<>();
		for (String line : result.get("puml").asString().split("\n")) {
			Matcher m = ARROW.matcher(line.trim());
			if (m.matches()) out.add(m.group(4));
		}
		return out;
	}

	/**
	 * Each arrow label the renderer actually drew, in order. Calls come through
	 * as {@code "3. feeFor(hours)"} and returns as {@code "← fee : BigDecimal"};
	 * lifeline names carry neither prefix and drop out.
	 *
	 * <p>Scope: call and return arrows. A create step also draws a separate
	 * creation arrow, which the .puml expresses as a {@code create X} line rather
	 * than an arrow — the fixture has no create step, and adding one would need
	 * this mapping extended.
	 */
	private static List<String> drawnArrowLabels() {
		Pattern call = Pattern.compile("^\\d+\\. (.*)$");
		Pattern ret = Pattern.compile("^← (.*)$");
		List<String> out = new ArrayList<>();
		for (String label : drawnLabels()) {
			Matcher c = call.matcher(label);
			Matcher r = ret.matcher(label);
			if (c.matches()) out.add(c.group(1));
			else if (r.matches()) out.add(r.group(1));
		}
		return out;
	}

	// --- the property ------------------------------------------------------------

	/**
	 * The two surfaces, compared directly: what the renderer put on screen against
	 * what the emitter wrote to the file.
	 *
	 * <p>An earlier version of this test compared {@code resolveSteps()} to the
	 * .puml and left the renderer unobserved. Reverting the renderer to its old
	 * behaviour left it green, which is the failure mode it exists to catch, so it
	 * now reads the drawn output.
	 */
	@Test
	void theDrawnDiagramAndThePumlCarryTheSameArrowsInTheSameOrder() {
		assertEquals(pumlArrowLabels(), drawnArrowLabels(),
				"the picture the reviewer approves and the file the plugin reads disagree. "
						+ "One selection, two renderings — see resolveSteps() in app.js");
	}

	/**
	 * And the emitter against the shared selection, so a regression in
	 * {@code emitPlantUml} alone is reported against the source rather than only
	 * as a mismatch with the diagram.
	 */
	@Test
	void thePumlIsExactlyWhatTheSharedSelectionImplies() {
		assertEquals(interactionArrows(), pumlArrows(),
				"emitPlantUml no longer formats resolveSteps()'s output faithfully");
	}

	/**
	 * The case that was broken, named so a regression reports itself in one line
	 * rather than as a diff of two long lists.
	 */
	@Test
	void theEntryInteractionAndTheFinalReturnReachBothSurfaces() {
		List<String> arrows = pumlArrows();
		assertTrue(arrows.stream().anyMatch(a -> a.startsWith("-> " + SYSTEM_LIFELINE)),
				() -> "the .puml lost its entry interaction: " + arrows);
		assertTrue(arrows.stream().anyMatch(a -> a.startsWith("<-- " + SYSTEM_LIFELINE)),
				() -> "the .puml lost its final return: " + arrows);

		List<String> drawn = drawnLabels();
		assertTrue(drawn.contains(SYSTEM_LIFELINE),
				() -> "the drawn diagram has no [*] lifeline, so the reviewer cannot see who "
						+ "enters the system or what comes back: " + drawn);
		assertTrue(drawn.stream().anyMatch(d -> d.contains("cancel(visitId: Long, initiator: String)")),
				() -> "the entry signature is missing from the drawn diagram: " + drawn);
		assertTrue(drawn.stream().anyMatch(d -> d.contains("result : CancellationResult")),
				() -> "the return type is missing from the drawn diagram: " + drawn);
	}

	// --- anti-vacuity -------------------------------------------------------------

	/**
	 * Guards the two tests above. For an ordinary call both paths share the same
	 * guard and always did, so a fixture without a system-caller step cannot fail
	 * this file however far the code regresses. If these assertions ever stop
	 * holding, the fixture stopped exercising the divergence.
	 */
	@Test
	void theFixtureExercisesTheCaseThatUsedToDiverge() {
		List<String> kinds = new ArrayList<>();
		result.get("interactions").forEach(it -> kinds.add(it.get("kind").asString()));

		assertTrue(kinds.contains("entry"), () -> "fixture has no entry interaction: " + kinds);
		assertTrue(kinds.contains("exit"), () -> "fixture has no final return: " + kinds);
		assertTrue(kinds.stream().filter("call"::equals).count() >= 2,
				() -> "fixture needs ordinary calls beside the boundary steps: " + kinds);
		assertTrue(pumlArrows().size() >= 6, () -> "the arrow parser matched almost nothing, so the "
				+ "comparison above is comparing two empty lists: " + pumlArrows());
		assertTrue(drawnLabels().size() >= 6, () -> "the renderer drew almost nothing, so the drawn "
				+ "assertions prove nothing: " + drawnLabels());
	}
}
