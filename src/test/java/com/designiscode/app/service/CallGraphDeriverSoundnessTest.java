package com.designiscode.app.service;

import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.VariantRequest;
import com.github.javaparser.JavaParser;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.MethodCallExpr;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Stage A <b>soundness</b> — a different and stronger property than the one
 * {@link DerivationStabilityTest} proves.
 *
 * <p>Stability says the deriver is a pure function: same code in, same design
 * out. A deriver that silently dropped half the body would satisfy every one of
 * those assertions. What is missing, and what this file adds, is <b>fidelity</b>:
 *
 * <blockquote>Every method call in the entry body is either <i>captured</i> as a
 * call site, or <i>disclosed</i> as a capture gap. There is no third
 * category.</blockquote>
 *
 * <p>The third category is the dangerous one. REGEN overwrites an orchestrator
 * <i>wholesale</i> from the derived design, so a call that is neither captured
 * nor disclosed is a call deleted from the user's repository — and the slice
 * that omitted it looks exactly as confident as a complete one. Everything the
 * pipeline does to stay safe hangs off {@link DerivedSlice#captureComplete()}
 * ({@code DesignDiffer} only sets {@code sutMode=regen} when it holds;
 * {@code DesignDeltaValidator} refuses regen when it does not), so that flag has
 * to be earned rather than assumed.
 *
 * <p>These tests also cover the ways the <i>derivable world</i> can be smaller
 * than the real one — a source that will not parse, a type name that resolves to
 * two different types. Both are silent by nature and neither is visible to a
 * stability check, because both are perfectly deterministic.
 */
class CallGraphDeriverSoundnessTest {

	private final CallGraphDeriver deriver = new CallGraphDeriver();

	private static final JavaParser PARSER = new JavaParser(
			new ParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21));

	/**
	 * Every call in {@code entryClass#entryMethod}'s body, read straight from the
	 * source rather than from the slice — an independent count is the only way an
	 * omission test can be independent of the thing it is testing.
	 */
	private static List<MethodCallExpr> callsInBody(List<String> sources, String entryClass, String entryMethod) {
		for (String src : sources) {
			CompilationUnit unit = PARSER.parse(src).getResult().orElse(null);
			if (unit == null) continue;
			for (ClassOrInterfaceDeclaration type : unit.findAll(ClassOrInterfaceDeclaration.class)) {
				if (!type.getNameAsString().equals(entryClass)) continue;
				for (MethodDeclaration m : type.getMethods()) {
					if (m.getNameAsString().equals(entryMethod) && m.getBody().isPresent()) {
						return m.getBody().get().findAll(MethodCallExpr.class);
					}
				}
			}
		}
		throw new IllegalStateException("no bodied " + entryClass + "#" + entryMethod + " in the sources");
	}

	/**
	 * The property. A call counts as captured when a call site carries its
	 * receiver and method name, and as disclosed when some gap mentions it.
	 */
	private void assertEveryCallIsCapturedOrDisclosed(List<String> sources, String entryClass, String entryMethod) {
		DerivedSlice slice = deriver.derive(sources, entryClass, entryMethod);
		List<String> unaccounted = new ArrayList<>();

		for (MethodCallExpr call : callsInBody(sources, entryClass, entryMethod)) {
			String receiver = call.getScope().map(Object::toString).orElse(null);
			String method = call.getNameAsString();

			boolean captured = slice.callSites().stream().anyMatch(cs -> cs.method().equals(method)
					&& receiver != null
					&& (receiver.equals(cs.receiver()) || receiver.equals("this." + cs.receiver())));
			boolean disclosed = slice.captureGaps().stream().anyMatch(g -> g.contains(call.toString())
					|| (g.contains(method + "(") && (receiver == null || g.contains(receiver))));

			if (!captured && !disclosed) unaccounted.add(call.toString());
		}

		assertTrue(unaccounted.isEmpty(),
				() -> "these calls are in the body but neither captured as call sites nor disclosed as gaps, "
						+ "so a wholesale REGEN would delete them silently:\n  "
						+ String.join("\n  ", unaccounted)
						+ "\ncall sites: " + slice.callSites().stream()
								.map(cs -> cs.receiver() + "." + cs.method()).toList()
						+ "\ngaps: " + slice.captureGaps());
	}

	// --- the property, on both fixture sets -------------------------------------

	/** The REGEN-clean shape. Every call is a real collaborator call, so nothing is disclosed. */
	@Test
	void everyCallInTheCleanOrchestratorIsCaptured() {
		assertEveryCallIsCapturedOrDisclosed(PetclinicFixtures.sources("act2"), "CancelVisitService", "cancel");
		DerivedSlice slice = deriver.derive(PetclinicFixtures.sources("act2"), "CancelVisitService", "cancel");
		assertTrue(slice.captureComplete(),
				() -> "act2 is the fixture REGEN depends on; it must stay gap-free: " + slice.captureGaps());
	}

	/** Real upstream PetClinic — branches, chained and static calls, and calls on JDK types. */
	@Test
	void everyCallInRealUpstreamCodeIsCapturedOrDisclosed() {
		assertEveryCallIsCapturedOrDisclosed(PetclinicFixtures.sources("act1"),
				"VisitController", "processNewVisitForm");
	}

	// --- a static call is a gap, not a phantom collaborator ---------------------

	/**
	 * {@code Type.method()} parses as a call on the name {@code Type}, which is no
	 * field, parameter or local. Stage E emits no arrow for it, so REGEN would drop
	 * it — it has to block the gate rather than pass as a call site.
	 */
	@Test
	void aStaticCallBlocksRegenInsteadOfLookingLikeACollaborator() {
		String service = """
				package com.demo;
				public class Clock2Service {
					private final Sink sink;
					public Clock2Service(Sink sink) { this.sink = sink; }
					public void run(String id) {
						String stamp = Instant.now();
						this.sink.accept(id, stamp);
					}
				}
				""";
		String sink = """
				package com.demo;
				public interface Sink { void accept(String id, String stamp); }
				""";

		DerivedSlice slice = deriver.derive(List.of(service, sink), "Clock2Service", "run");

		assertFalse(slice.captureComplete(), "a static call means the flow is not fully derivable");
		assertTrue(slice.captureGaps().stream().anyMatch(g -> g.contains("Instant") && g.contains("now")),
				() -> "the static call must be named in the gaps: " + slice.captureGaps());
	}

	/** A call on a variable whose type was never provided is equally unemittable. */
	@Test
	void aCallOnAnUnprovidedTypeBlocksRegen() {
		String service = """
				package com.demo;
				public class TotalService {
					private final Sink sink;
					public TotalService(Sink sink) { this.sink = sink; }
					public void run(java.math.BigDecimal amount) {
						java.math.BigDecimal doubled = amount.add(amount);
						this.sink.accept(doubled);
					}
				}
				""";
		String sink = """
				package com.demo;
				public interface Sink { void accept(java.math.BigDecimal v); }
				""";

		DerivedSlice slice = deriver.derive(List.of(service, sink), "TotalService", "run");

		assertFalse(slice.captureComplete(), "BigDecimal is not among the provided sources");
		assertTrue(slice.captureGaps().stream().anyMatch(g -> g.contains("BigDecimal")),
				() -> "the unprovided callee type must be named: " + slice.captureGaps());
	}

	// --- the world can be smaller than it looks ---------------------------------

	/**
	 * A source that will not parse used to be dropped without a word: the slice
	 * came back complete, having never seen the file. Deterministically wrong, so
	 * no stability check could ever notice.
	 */
	@Test
	void aSourceThatDoesNotParseIsDisclosedRatherThanSkipped() {
		List<String> sources = new ArrayList<>(PetclinicFixtures.sources("act2"));
		sources.add("package com.demo; public class Broken { this is not java }");

		DerivedSlice slice = deriver.derive(sources, "CancelVisitService", "cancel");

		assertFalse(slice.captureComplete(), "an unparsed source shrinks the world; that must block REGEN");
		assertTrue(slice.captureGaps().stream().anyMatch(g -> g.contains("did not parse") && g.contains("Broken")),
				() -> "the unparsed source must be named: " + slice.captureGaps());
	}

	/** The caller's own blind spots (an unreadable file) arrive by the same door. */
	@Test
	void aCallerReportedGapIsCarriedIntoTheSlice() {
		DerivedSlice slice = deriver.derive(PetclinicFixtures.sources("act2"), "CancelVisitService", "cancel",
				List.of("a source could not be read: Owner.java (permission denied)"));

		assertFalse(slice.captureComplete(), "a file the caller could not read must block REGEN too");
		assertTrue(slice.captureGaps().stream().anyMatch(g -> g.contains("permission denied")),
				() -> "the caller's gap must survive into the slice: " + slice.captureGaps());
	}

	/**
	 * Receiver resolution is lexical and keyed by simple name, so two same-named
	 * types in different packages silently shadow one another and every call on
	 * that receiver is attributed to whichever was indexed first. Deterministic
	 * and wrong — the one failure mode stability testing is structurally blind to.
	 */
	@Test
	void twoTypesSharingASimpleNameAreDisclosedRatherThanGuessed() {
		String service = """
				package com.demo;
				public class ReportService {
					private final Formatter formatter;
					public ReportService(Formatter formatter) { this.formatter = formatter; }
					public String run(String id) { return this.formatter.format(id); }
				}
				""";
		String mine = """
				package com.demo;
				public interface Formatter { String format(String id); }
				""";
		String theirs = """
				package com.other;
				public interface Formatter { String render(String id); }
				""";

		DerivedSlice slice = deriver.derive(List.of(service, mine, theirs), "ReportService", "run");

		assertFalse(slice.captureComplete(), "an ambiguous simple name must not be resolved by coin flip");
		assertTrue(slice.captureGaps().stream()
						.anyMatch(g -> g.contains("Formatter") && g.contains("com.other")),
				() -> "the collision must name both types: " + slice.captureGaps());
	}

	/** The same type handed in twice is not a collision — a duplicate source must stay silent. */
	@Test
	void theSameTypeProvidedTwiceIsNotReportedAsACollision() {
		String service = """
				package com.demo;
				public class EchoService {
					private final Sink sink;
					public EchoService(Sink sink) { this.sink = sink; }
					public void run(String id) { this.sink.accept(id); }
				}
				""";
		String sink = """
				package com.demo;
				public interface Sink { void accept(String id); }
				""";

		DerivedSlice slice = deriver.derive(List.of(service, sink, sink), "EchoService", "run");

		assertTrue(slice.captureComplete(),
				() -> "a duplicated source is not an ambiguity: " + slice.captureGaps());
	}

	// --- the consequence: a gap really does stop REGEN --------------------------

	/**
	 * The gaps above are only worth recording if the pipeline acts on them. Same
	 * ticket, same sources, one unparseable file added: Stage C must fall back
	 * from a wholesale overwrite to an add-only UPDATE. Without this, every
	 * assertion in this file would be checking a flag nobody reads.
	 */
	@Test
	void anUnparseableSourceDowngradesStageCFromRegenToAddOnlyUpdate() {
		CodeDesignDiffService pipeline = new CodeDesignDiffService(
				new CallGraphDeriver(), new BindingTimeClassifier(), new DesignDiffer(),
				new DesignDeltaEmitter(), new DesignService(),
				new SliceRenderer(), new DeltaRenderer(),
				new CounterfactualRenderer(), new WhyRenderer());
		String ac = "The cancellation form records who initiated the cancellation. "
				+ "Clinic-initiated cancellations are always free; "
				+ "owner-initiated cancellations keep the 48-hour rule.";
		VariantRequest request = new VariantRequest("CancellationFeePolicy", "ClinicInitiatedFee",
				List.of(new MappingRow("owner", "StandardCancellationFee"),
						new MappingRow("clinic", "ClinicInitiatedFee")),
				null);

		List<String> clean = PetclinicFixtures.sources("act2");
		assertEquals(DesignDelta.SUT_REGEN,
				pipeline.run(clean, "CancelVisitService", "cancel", "initiator", ac, request).delta().sutMode(),
				"baseline: the clean fixture is the one act2 regenerates wholesale");

		List<String> withBroken = new ArrayList<>(clean);
		withBroken.add("package com.demo; public class Broken { this is not java }");

		assertEquals(DesignDelta.SUT_UPDATE,
				pipeline.run(withBroken, "CancelVisitService", "cancel", "initiator", ac, request).delta().sutMode(),
				"a file the deriver could not read must force the add-only fallback — overwriting an "
						+ "orchestrator from a slice built on an incomplete world deletes whatever it missed");
	}

	// --- anti-vacuity ------------------------------------------------------------

	/**
	 * Guards the property tests above. If {@code callsInBody} silently matched
	 * nothing, every assertion would pass while checking nothing at all.
	 */
	@Test
	void theBodyScannerActuallyFindsCalls() {
		assertTrue(callsInBody(PetclinicFixtures.sources("act2"), "CancelVisitService", "cancel").size() >= 5,
				"the act2 orchestrator has five collaborator calls; the scanner must see them");
		assertTrue(callsInBody(PetclinicFixtures.sources("act1"), "VisitController", "processNewVisitForm")
				.size() >= 1, "the upstream controller body is not empty");
	}
}
