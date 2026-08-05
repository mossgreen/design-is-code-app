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
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Defends P3c — <b>the gates enforcing the approval actually fire</b>.
 *
 * <p>Step 3's dropped-call gate blocks sign-off when the proposal removes a call
 * the current code makes. It is a headline v0.7.0 feature. It failed open.
 *
 * <p>{@code renderReviewBefore()} clears the gate before deriving anything and
 * recomputes it only inside {@code drawModel()}. The fetch's {@code .catch} shows
 * a banner and returns, so a derive error left the cleared value in place and the
 * gate reported "no drops" having judged nothing. It then cached the failure, so
 * every later visit to Step 3 replayed the banner and skipped the recompute too.
 *
 * <p>A failed derive is not a design with no dropped calls. It is a design nobody
 * checked. Greenfield genuinely has no baseline and must stay open — that case
 * returns early, above the fetch, and is unaffected.
 *
 * <p>This is the fourth mechanism in this project that existed and did not run,
 * after the soft-pass verdict parser, the refusal panel inside a hidden step, and
 * the unreachable Stage D guard. {@code TESTING.md} rule 4 exists because of them:
 * every new gate ships with its liveness test.
 */
class ReviewGateTest {

	private static final ObjectMapper JSON = JsonMapper.builder().build();
	private static final Path SCRIPT = Path.of("src", "test", "js", "review-gate.js");

	private static JsonNode result;

	@BeforeAll
	static void driveTheGate() throws IOException, InterruptedException {
		Assumptions.assumeTrue(Files.exists(SCRIPT), "review-gate.js missing");
		// stderr is NOT merged: the script's failure path logs a console.warn on
		// purpose, and merging it would corrupt the JSON on stdout.
		ProcessBuilder pb = new ProcessBuilder("node", SCRIPT.toString());
		Process p;
		try {
			p = pb.start();
		} catch (IOException e) {
			Assumptions.abort("node not on PATH — review gate test skipped");
			return;
		}
		String out = new String(p.getInputStream().readAllBytes());
		String err = new String(p.getErrorStream().readAllBytes());
		assertTrue(p.waitFor(60, TimeUnit.SECONDS), "review-gate.js timed out");
		assertEquals(0, p.exitValue(), () -> "review-gate.js failed:\nstdout:\n" + out + "\nstderr:\n" + err);
		result = JSON.readTree(out);
	}

	/**
	 * The gate must refuse to say "clean" about a design it could not check.
	 * Reporting no drops after learning nothing is the failure that matters: it
	 * releases sign-off silently, and silence reads exactly like success.
	 */
	@Test
	void aFailedDeriveLeavesSignOffBlocked() {
		assertTrue(result.get("deriveFailed").asBoolean(),
				"the fixture must actually reach the failure path, or this proves nothing");
		assertTrue(result.get("blocked").asBoolean(),
				() -> "the derive failed and the gate reported clean. Sign-off is released on a "
						+ "design nobody checked. state=" + result);
	}

	/**
	 * The narrower half of the same fail-open. {@code renderReviewBefore()} returns
	 * synchronously and the fetch settles later, so between those two moments the
	 * gate has cleared its previous answer and has no new one. Reading that gap as
	 * "no dropped calls" enables Next on a design nothing has checked yet.
	 */
	@Test
	void signOffIsBlockedWhileTheDeriveIsStillInFlight() {
		assertTrue(result.get("pending").asBoolean(),
				"the fixture must observe the in-flight window, or this proves nothing");
		assertTrue(result.get("blockedWhileInFlight").asBoolean(),
				() -> "the gate reported clean while the derive that decides it was still "
						+ "running. state=" + result);
	}

	/**
	 * Blocking must not become a trap. Caching the failure would replay the banner
	 * on every later visit, never retry the fetch, and — with no acknowledgement
	 * affordance — lock sign-off for the rest of the session. A false block that
	 * cannot be cleared is how people learn to distrust a gate, which `WHY.md`
	 * names as worse than a missing one. Only successes are cached.
	 */
	@Test
	void aTransientFailureDoesNotLockTheGateForTheSession() {
		assertFalse(result.get("failureCached").asBoolean(),
				() -> "a derive failure was cached, so the next visit replays it instead of "
						+ "retrying, and nothing can release the gate. state=" + result);
		assertTrue(result.get("blockedOnRevisit").asBoolean(),
				() -> "the retry failed again — in this harness the network is always down — so "
						+ "the gate must still block. state=" + result);
	}

	/**
	 * The gate must judge the proposal the design actually emits.
	 *
	 * <p>{@code computeDroppedCalls} asks {@code proposedCallSet()} whether the
	 * design still makes a call. That function resolved the sequence for itself
	 * and omitted the caller check {@code resolveSteps()} applies, so a step whose
	 * caller does not resolve produced <b>no arrow</b> while the gate still counted
	 * the call as proposed. The design silently loses the call, the gate reports
	 * nothing, and sign-off is released — a false release in the gate built to
	 * catch precisely that.
	 *
	 * <p>The fourth independent resolution of the sequence, after the three
	 * {@code resolveSteps()} unified.
	 */
	@Test
	void aCallTheDesignDoesNotEmitCountsAsDropped() {
		JsonNode f = result.get("fourthResolution");
		assertEquals(0, f.get("arrowsEmitted").asInt(),
				() -> "the fixture must emit no arrow, or it is not exercising the divergence: " + f);
		assertEquals(0, f.get("proposed").size(),
				() -> "the gate believes a call is proposed that the design emits no arrow for. "
						+ "proposedCallSet must read the same selection emitPlantUml does: " + f);
		assertEquals(1, f.get("dropped").size(),
				() -> "the current code makes a call the proposal has silently lost, and the gate "
						+ "did not flag it: " + f);
	}

	/**
	 * Anti-vacuity. The gate could trivially block by reporting phantom drops; it
	 * must block because the derive failed, with the drop list still empty.
	 */
	@Test
	void theGateBlocksBecauseTheDeriveFailedRatherThanBecauseOfInventedDrops() {
		assertFalse(result.get("dropped").isNull(), "dropped list missing from the driver output");
		assertEquals(0, result.get("dropped").size(),
				() -> "no drops can be known when the derive failed, so any entry here is invented: "
						+ result.get("dropped"));
	}
}
