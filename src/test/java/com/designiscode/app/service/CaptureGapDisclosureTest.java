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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Defends P1b — <b>the reviewer sees what derivation found, gaps included</b>.
 *
 * <p>Stage A is honest about what it could not account for: a branch, a loop, a
 * chained or static receiver, a source that would not parse. It records each as a
 * {@code captureGap}, and {@code POST /api/code-derive-by-path} returns them
 * inside {@code slice}. The wizard read {@code data.sliceModel} and threw
 * {@code data.slice} away.
 *
 * <p>So the Before panel drew a partial flow and said nothing about the rest.
 * This repo's own {@code CodeDesignDiffService#deriveByPath} derives <b>8+
 * gaps</b>; {@code slice-act1} shows 3 arrows for an 8-call method. A reviewer
 * approving a change to any framework-heavy method was approving against a
 * picture with most of the calls missing, with no notice anything was absent.
 *
 * <p>Honesty that never reaches the reader is not honesty. The derivation
 * soundness work only pays off here.
 */
class CaptureGapDisclosureTest {

	private static final ObjectMapper JSON = JsonMapper.builder().build();
	private static final Path SCRIPT = Path.of("src", "test", "js", "before-gaps.js");

	private static JsonNode result;

	@BeforeAll
	static void renderBeforePanel() throws IOException, InterruptedException {
		Assumptions.assumeTrue(Files.exists(SCRIPT), "before-gaps.js missing");
		ProcessBuilder pb = new ProcessBuilder("node", SCRIPT.toString());
		Process p;
		try {
			p = pb.start();
		} catch (IOException e) {
			Assumptions.abort("node not on PATH — capture gap disclosure test skipped");
			return;
		}
		String out = new String(p.getInputStream().readAllBytes());
		String err = new String(p.getErrorStream().readAllBytes());
		assertTrue(p.waitFor(60, TimeUnit.SECONDS), "before-gaps.js timed out");
		assertEquals(0, p.exitValue(), () -> "before-gaps.js failed:\nstdout:\n" + out + "\nstderr:\n" + err);
		result = JSON.readTree(out);
	}

	/** Everything the Before panel rendered: its markup plus any drawn labels. */
	private static String rendered(String caseName) {
		JsonNode c = result.get(caseName);
		return c.get("beforeHtml").asString() + "\n" + c.get("drawn").toString();
	}

	private static List<String> gaps() {
		List<String> out = new ArrayList<>();
		result.get("gaps").forEach(g -> out.add(g.asString()));
		return out;
	}

	// --- the property ------------------------------------------------------------

	/**
	 * Each gap must be named. A count ("3 calls not derived") would tell a reviewer
	 * something is missing without telling them what to go and read, which is the
	 * difference between a disclosure and a shrug.
	 */
	@Test
	void everyCaptureGapIsNamedInTheBeforePanel() {
		String panel = rendered("withGaps");
		List<String> missing = new ArrayList<>();
		for (String gap : gaps()) {
			if (!panel.contains(gap)) missing.add(gap);
		}
		assertTrue(missing.isEmpty(),
				() -> "derivation reported these gaps and the reviewer is never shown them, so the "
						+ "Before panel presents a partial flow as if it were the whole one:\n  "
						+ String.join("\n  ", missing) + "\npanel was:\n" + panel);
	}

	/**
	 * The other direction. A panel that says nothing when capture is complete is
	 * indistinguishable from one whose disclosure silently stopped working — the
	 * failure mode this project keeps meeting.
	 */
	@Test
	void completeCaptureIsStatedRatherThanLeftSilent() {
		String panel = rendered("complete");
		assertTrue(panel.toLowerCase().contains("complete"),
				() -> "with no gaps the panel must say capture was complete, so silence never has "
						+ "to be interpreted. panel was:\n" + panel);
	}

	// --- anti-vacuity -------------------------------------------------------------

	/**
	 * Guards both tests above. The fixture has to reach {@code drawModel}'s success
	 * path — the one that needs a stubbed fetch and the real {@code renderSeqSvg} —
	 * or it would be asserting about a panel showing an error banner.
	 */
	@Test
	void theFixtureReachesTheSuccessPathWithRealGaps() {
		assertFalse(result.get("withGaps").get("deriveFailed").asBoolean(),
				"the derive must succeed, or this is testing the failure banner instead");
		assertFalse(result.get("complete").get("deriveFailed").asBoolean(),
				"the derive must succeed in the gap-free case too");
		assertTrue(gaps().size() >= 3,
				() -> "the fixture needs several distinct gaps to prove each is named: " + gaps());
	}
}
