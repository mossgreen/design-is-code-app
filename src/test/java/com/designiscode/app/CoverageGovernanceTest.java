package com.designiscode.app;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Defends the coverage map itself.
 *
 * <p>This project's recurring defect is <b>a mechanism existed and did not
 * run</b> — the soft-pass verdict parser, the refusal panel inside a hidden
 * step, the unreachable Stage D guard, the dropped-call fail-open. Guarding
 * against that with a convention ("check it in review") would be the same kind
 * of object as the things that failed. So the coverage map is executable.
 *
 * <p>Three assertions, in the order they matter:
 *
 * <ol>
 *   <li><b>Forward, {@code WHY.md}</b> — every test cited by a {@code ✅} claim
 *       resolves to a file, is tracked by git, and carries no
 *       {@code @Tag("eval")}. A claim may not cite evidence a fresh clone lacks,
 *       nor evidence that {@code ./gradlew test} skips.</li>
 *   <li><b>Forward, {@code TESTING.md}</b> — every property not marked
 *       {@code ⛔} names at least one test, and each passes the same predicate.</li>
 *   <li><b>Reverse</b> — every file under {@code src/test/java} maps to a
 *       property or to a declared bucket. A file matching nothing fails, because
 *       classifying it is a decision someone has to make.</li>
 * </ol>
 *
 * <p>What this cannot do: judge whether a listed test defends the property it is
 * listed under. It catches absence and staleness. Relevance needs a reader, and
 * {@code TESTING.md} says so.
 *
 * <p>Defends: the map behind every property in {@code TESTING.md}.
 */
@DisplayName("TESTING.md and WHY.md describe tests that exist, run, and are tracked")
class CoverageGovernanceTest {

	private static final Path TESTING_MD = Path.of("TESTING.md");
	private static final Path WHY_MD = Path.of("WHY.md");
	private static final Path TEST_ROOT = Path.of("src", "test", "java");

	/**
	 * A backticked Java identifier or glob: `DataflowLinterTest`,
	 * `CodeDesignDiff*`, `*EvalTest`. The leading {@code *} is load-bearing — the
	 * first version of this pattern required a letter, so the `*EvalTest` bucket
	 * silently parsed to nothing and three eval classes fell through. The reverse
	 * check below is what caught it.
	 */
	private static final Pattern BACKTICKED = Pattern.compile("`([A-Za-z*][A-Za-z0-9_*]*)`");

	/** A property row: leading cell is P1a / P2b / P3c. */
	private static final Pattern PROPERTY_ROW = Pattern.compile("^\\|\\s*(P\\d[a-z])\\s*\\|");

	// ---------------------------------------------------------------- helpers

	private static String read(Path p) {
		try {
			return Files.readString(p);
		} catch (IOException e) {
			throw new UncheckedIOException("cannot read " + p.toAbsolutePath(), e);
		}
	}

	/** Cells of a markdown table row, outer pipes stripped. */
	private static List<String> cells(String row) {
		String trimmed = row.trim();
		if (trimmed.startsWith("|")) trimmed = trimmed.substring(1);
		if (trimmed.endsWith("|")) trimmed = trimmed.substring(0, trimmed.length() - 1);
		return List.of(trimmed.split("\\|", -1));
	}

	private static List<String> backtickedIn(String text) {
		List<String> out = new ArrayList<>();
		Matcher m = BACKTICKED.matcher(text);
		while (m.find()) out.add(m.group(1));
		return out;
	}

	/**
	 * True when this tree is a git checkout. A source export — GitHub's
	 * "Source code (zip)" asset, a vendored copy, a tarball build — has no
	 * {@code .git}, and there the tracked-evidence question cannot be asked at
	 * all. In a worktree {@code .git} is a file rather than a directory.
	 */
	private static boolean insideGitRepo() {
		Path dotGit = Path.of(".git");
		return Files.isDirectory(dotGit) || Files.isRegularFile(dotGit);
	}

	/**
	 * Skip the tracked-evidence half when there is no git to ask, and say so
	 * loudly. Skipping is normally the failure mode this whole file exists to
	 * prevent — the guarantee that it cannot happen unnoticed lives in
	 * {@code .github/workflows/test.yml}, which fails the build when the skip
	 * count moves off its expected value. CI checks out a real repository, so
	 * these two never skip there.
	 */
	private static void requireGit() {
		Assumptions.assumeTrue(insideGitRepo(),
				"no .git in " + Path.of("").toAbsolutePath() + " — this is a source export, so the "
						+ "tracked-evidence check cannot run. CI asserts the skip count, so this "
						+ "cannot pass unnoticed where it matters.");
	}

	/**
	 * Every path git knows about under the test root, as simple class names. The
	 * untracked case is the one this exists for, so a file present on disk and
	 * absent here must fail rather than skip.
	 */
	private static Set<String> gitTrackedTestClasses() {
		try {
			Process p = new ProcessBuilder("git", "ls-files", TEST_ROOT.toString())
					.redirectErrorStream(true).start();
			String out = new String(p.getInputStream().readAllBytes());
			if (!p.waitFor(30, TimeUnit.SECONDS) || p.exitValue() != 0) {
				fail("`git ls-files` failed, so the tracked-evidence check cannot run:\n" + out);
			}
			Set<String> names = new LinkedHashSet<>();
			for (String line : out.split("\n")) {
				String f = line.trim();
				if (f.endsWith(".java")) names.add(simpleName(Path.of(f)));
			}
			return names;
		} catch (IOException | InterruptedException e) {
			throw new IllegalStateException("git unavailable; this check must not be skipped", e);
		}
	}

	private static String simpleName(Path javaFile) {
		String n = javaFile.getFileName().toString();
		return n.substring(0, n.length() - ".java".length());
	}

	private static List<Path> allTestSources() {
		try (var paths = Files.walk(TEST_ROOT)) {
			return paths.filter(p -> p.toString().endsWith(".java")).sorted().toList();
		} catch (IOException e) {
			throw new UncheckedIOException("cannot walk " + TEST_ROOT, e);
		}
	}

	/** Simple name → source file, for every test source on disk. */
	private static Map<String, Path> sourcesByName() {
		Map<String, Path> byName = new LinkedHashMap<>();
		for (Path p : allTestSources()) byName.put(simpleName(p), p);
		return byName;
	}

	/** Property id → cited test names, from TESTING.md's Properties table. */
	private static Map<String, List<String>> propertyRows() {
		Map<String, List<String>> rows = new LinkedHashMap<>();
		for (String line : read(TESTING_MD).split("\n")) {
			Matcher m = PROPERTY_ROW.matcher(line);
			if (!m.find()) continue;
			List<String> c = cells(line);
			if (c.size() < 4) fail("malformed property row in TESTING.md: " + line);
			rows.put(m.group(1) + " " + c.get(3).trim(), backtickedIn(c.get(2)));
		}
		assertTrue(rows.size() >= 5, "TESTING.md's Properties table did not parse — found " + rows.size()
				+ " rows. A governance test that parses nothing passes for free.");
		return rows;
	}

	/**
	 * Bucket patterns in declared order; first match wins.
	 *
	 * <p>A data row yielding no pattern is a parse failure rather than an empty
	 * bucket, and it fails here. Counting total patterns would not have caught the
	 * {@code *EvalTest} bug, because fifteen other patterns cleared any floor.
	 */
	private static List<String> bucketPatterns() {
		List<String> patterns = new ArrayList<>();
		List<String> emptyRows = new ArrayList<>();
		boolean inBuckets = false;
		for (String line : read(TESTING_MD).split("\n")) {
			if (line.startsWith("## ")) inBuckets = line.startsWith("## Buckets");
			if (!inBuckets || !line.trim().startsWith("|")) continue;
			List<String> c = cells(line);
			if (c.size() < 2) continue;
			String bucket = c.get(0).trim();
			if (bucket.equals("Bucket") || bucket.matches("^:?-{2,}:?$")) continue; // header / separator
			List<String> found = backtickedIn(c.get(1));
			if (found.isEmpty()) emptyRows.add(bucket);
			patterns.addAll(found);
		}
		assertTrue(emptyRows.isEmpty(), () -> "these bucket rows in TESTING.md parsed to zero patterns, "
				+ "so every file they should claim falls through: " + emptyRows);
		assertTrue(patterns.size() >= 4, "TESTING.md's Buckets table did not parse — found "
				+ patterns.size() + " patterns.");
		return patterns;
	}

	private static boolean matches(String name, String glob) {
		if (!glob.contains("*")) return name.equals(glob);
		return name.matches(Pattern.quote(glob).replace("*", "\\E.*\\Q"));
	}

	/**
	 * The shared predicate: a cited test must resolve, be tracked, and run under
	 * {@code ./gradlew test}. Returns the reason it fails, or null when it holds.
	 */
	private static String whyUnusableAsEvidence(String testName, Map<String, Path> onDisk,
			Set<String> tracked) {
		Path source = onDisk.get(testName);
		if (source == null) return "no file src/test/java/**/" + testName + ".java";
		if (!tracked.contains(testName)) {
			return testName + ".java exists but is NOT tracked by git — a fresh clone has the claim "
					+ "and no test (`git add " + source + "`)";
		}
		if (read(source).contains("@Tag(\"eval\")")) {
			return testName + " carries @Tag(\"eval\"), so `./gradlew test` never runs it";
		}
		return null;
	}

	/**
	 * True when a test only runs if someone passes a system property — so a plain
	 * {@code ./gradlew test} skips every case in it.
	 *
	 * <p>This is a different thing from a toolchain skip. {@code FrontendChainTest}
	 * aborts when node is missing, and node is present in CI by construction, so it
	 * runs. {@code DerivationStabilityForeignRepoTest} gates on
	 * {@code disc.stability.repo}, which nothing sets by default: it reports 3
	 * tests, 3 skipped, 0 executed on every ordinary run.
	 *
	 * <p>Such a test is still real evidence. It is not evidence a reader reproduces
	 * by running the suite, so a {@code ✅} citing it has to say so.
	 */
	private static boolean isOptIn(Path source) {
		String src = read(source);
		return src.contains("Assumptions.assume") && src.contains("System.getProperty");
	}

	// ------------------------------------------------------------- assertions

	@Test
	@DisplayName("every test WHY.md cites for a ✅ claim resolves, is tracked, and is not eval-tagged")
	void whyMdCitesOnlyUsableEvidence() {
		requireGit();
		Map<String, Path> onDisk = sourcesByName();
		Set<String> tracked = gitTrackedTestClasses();

		List<String> problems = new ArrayList<>();
		int citations = 0;
		for (String line : read(WHY_MD).split("\n")) {
			if (!line.trim().startsWith("|") || !line.contains("✅")) continue;
			for (String name : backtickedIn(line)) {
				if (!name.endsWith("Test")) continue;   // prose cites files and fields too
				citations++;
				String why = whyUnusableAsEvidence(name, onDisk, tracked);
				if (why != null) problems.add("claim row cites " + name + " — " + why);

				// A ✅ tells a reader "run the suite and see this pass". An opt-in
				// test does not pass on a plain run — it skips — so the cell must
				// say so rather than let the tick imply otherwise.
				Path source = onDisk.get(name);
				if (source != null && isOptIn(source) && !line.toLowerCase().contains("opt-in")) {
					problems.add("claim row cites " + name + " as ✅, but it gates on a system "
							+ "property and skips on a plain `./gradlew test`. Mark the cell "
							+ "\"opt-in\" so the tick does not overstate what a reader will see");
				}
			}
		}

		// Anti-vacuity. Claim 1's ✅ names an artifact rather than a test, which is
		// why this asserts a floor instead of one-per-row; a parser matching nothing
		// would otherwise pass in silence.
		assertTrue(citations >= 5, "parsed only " + citations + " test citations from WHY.md's ✅ rows; "
				+ "the table format changed and this check stopped checking");

		assertTrue(problems.isEmpty(), () -> "WHY.md cites evidence a fresh clone cannot run:\n  "
				+ String.join("\n  ", problems));
	}

	@Test
	@DisplayName("every TESTING.md property that claims coverage names tests that resolve, are tracked, and run")
	void testingMdPropertiesNameUsableTests() {
		requireGit();
		Map<String, Path> onDisk = sourcesByName();
		Set<String> tracked = gitTrackedTestClasses();

		List<String> problems = new ArrayList<>();
		for (Map.Entry<String, List<String>> row : propertyRows().entrySet()) {
			String[] idAndStatus = row.getKey().split(" ", -1);
			String id = idAndStatus[0];
			boolean claimsNothing = idAndStatus[1].contains("⛔");

			if (row.getValue().isEmpty()) {
				if (!claimsNothing) problems.add(id + " claims coverage and names no test");
				continue;
			}
			if (claimsNothing) {
				problems.add(id + " is marked ⛔ yet names " + row.getValue() + " — pick one");
			}
			for (String name : row.getValue()) {
				String why = whyUnusableAsEvidence(name, onDisk, tracked);
				if (why != null) problems.add(id + " names " + name + " — " + why);
			}
		}
		assertTrue(problems.isEmpty(), () -> "TESTING.md's property map is stale:\n  "
				+ String.join("\n  ", problems));
	}

	@Test
	@DisplayName("every file under src/test/java maps to a property or a declared bucket")
	void everyTestSourceIsAccountedFor() {
		Set<String> claimed = new TreeSet<>();
		propertyRows().values().forEach(claimed::addAll);
		List<String> buckets = bucketPatterns();

		List<String> unaccounted = new ArrayList<>();
		for (Path source : allTestSources()) {
			String name = simpleName(source);
			if (claimed.contains(name)) continue;
			if (buckets.stream().anyMatch(g -> matches(name, g))) continue;
			unaccounted.add(source.toString());
		}

		assertTrue(unaccounted.isEmpty(), () -> "these test files defend no named property and sit in "
				+ "no declared bucket. Add each to TESTING.md — deciding which is the point:\n  "
				+ String.join("\n  ", unaccounted));
	}
}
