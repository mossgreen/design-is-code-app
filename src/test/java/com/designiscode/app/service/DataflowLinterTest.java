package com.designiscode.app.service;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The data-flow gate, exercised over the PetClinic goldens and the two real
 * failures it exists to catch (deterministic, no model calls).
 */
class DataflowLinterTest {

    private static final Path GOLDENS = Path.of("src", "test", "resources", "goldens", "petclinic");

    private static String golden(String name) {
        try {
            return Files.readString(GOLDENS.resolve(name));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Test
    void derivedSliceIsClean() {
        // The what-IS view of working code must never be refused: a false
        // violation here would make the review surface untrustworthy.
        DataflowLinter.Report r = DataflowLinter.lint(golden("slice-act2.puml"));
        assertTrue(r.ok(), () -> "derived slice flagged: " + r.violations());
        assertEquals(List.of(), r.warnings(), "derived slice should not warn either");
    }

    @Test
    void act2DesignIsClean() {
        DataflowLinter.Report r = DataflowLinter.lint(golden("CancelVisitService.puml"));
        assertTrue(r.ok(), () -> "act-2 design flagged: " + r.violations());
    }

    @Test
    void unsourcedArgumentIsAViolation() {
        // The bug this golden shipped with: resolve(key) when the entry
        // signature offers ownerId/petId/visitId/initiator and nothing binds "key".
        String puml = golden("CancelVisitService.puml")
                .replace("resolve(initiator)", "resolve(key)");
        DataflowLinter.Report r = DataflowLinter.lint(puml);
        assertFalse(r.ok());
        assertEquals(1, r.violations().size(), () -> r.violations().toString());
        assertTrue(r.violations().get(0).contains("nothing in this flow produces 'key'"),
                () -> r.violations().get(0));
    }

    @Test
    void severedVarianceIsCaught() {
        // 2026-07-24, reproduced: the rule is fetched and never handed to the
        // leaf that varies on it, and hoursUntilVisit arrives from nowhere.
        String puml = """
                @startuml
                ' @package org.springframework.samples.petclinic.owner

                class CancellationFeeRule <<class>>
                participant CancelVisitService
                participant CancellationFeeRuleRepository
                participant CancellationFeePolicy

                [*] -> CancelVisitService : cancel(ownerId, visitId, initiator)
                CancelVisitService -> CancellationFeeRuleRepository : findBy(initiator)
                CancelVisitService <-- CancellationFeeRuleRepository : rule : CancellationFeeRule
                CancelVisitService -> CancellationFeePolicy : feeFor(hoursUntilVisit)
                CancelVisitService <-- CancellationFeePolicy : fee : BigDecimal
                CancelVisitService --> [*] : result : CancellationResult
                @enduml
                """;
        DataflowLinter.Report r = DataflowLinter.lint(puml);

        assertEquals(1, r.violations().size(), () -> r.violations().toString());
        assertTrue(r.violations().get(0).contains("'hoursUntilVisit'"), () -> r.violations().get(0));

        assertEquals(1, r.warnings().size(), () -> r.warnings().toString());
        assertTrue(r.warnings().get(0).contains("'rule' is produced but never used"),
                () -> r.warnings().get(0));
    }

    @Test
    void resolvedStrategyCountsAsUsedWhenItBecomesTheCallee() {
        // The whole Act-2 shape: resolve() hands back a strategy that is "used"
        // by being called, never by being passed. Warning here would be noise.
        String puml = """
                @startuml
                class TaxCalculator <<interface>>
                participant SaleService
                participant TaxCalculatorResolver

                [*] -> SaleService : checkout(order, region)
                SaleService -> TaxCalculatorResolver : resolve(region)
                TaxCalculatorResolver --> SaleService : strategy : TaxCalculator
                SaleService -> TaxCalculator : calculate(order)
                SaleService <-- TaxCalculator : tax : Money
                SaleService --> [*] : receipt : Receipt
                @enduml
                """;
        DataflowLinter.Report r = DataflowLinter.lint(puml);
        assertTrue(r.ok(), () -> r.violations().toString());
        assertEquals(List.of(), r.warnings(), "a resolved strategy that is called is used");
    }

    @Test
    void aCreatedTypeCountsAsDeclared() {
        // The wizard's factory idiom declares the lifeline with `create X` instead
        // of a prelude participant. Without that, a fetched-and-dropped value of a
        // created type would slip through the unconsumed-result rule.
        String puml = """
                @startuml
                participant SaleService
                participant RuleRepository

                [*] -> SaleService : checkout(region)
                SaleService -> RuleRepository : findBy(region)
                create PricingRule
                RuleRepository --> SaleService : pricingRule : PricingRule
                @enduml
                """;
        DataflowLinter.Report r = DataflowLinter.lint(puml);
        assertTrue(r.ok());
        assertEquals(1, r.warnings().size(), () -> r.warnings().toString());
        assertTrue(r.warnings().get(0).contains("'pricingRule' is produced but never used"),
                () -> r.warnings().get(0));
    }

    @Test
    void bareTypeReturnLabelWarns() {
        // What the wizard emits today (returnLabelFor → the type). The value has
        // no name, so no later call can reference it — flag it, don't refuse it.
        String puml = """
                @startuml
                participant SaleService
                participant OwnerLoader

                [*] -> SaleService : checkout(ownerId)
                SaleService -> OwnerLoader : load(ownerId)
                SaleService <-- OwnerLoader : Owner
                @enduml
                """;
        DataflowLinter.Report r = DataflowLinter.lint(puml);
        assertTrue(r.ok());
        assertEquals(1, r.warnings().size(), () -> r.warnings().toString());
        assertTrue(r.warnings().get(0).contains("bare type"), () -> r.warnings().get(0));
    }

    @Test
    void useBeforeProduceIsAViolation() {
        String puml = """
                @startuml
                participant SaleService
                participant Pricer
                participant Loader

                [*] -> SaleService : checkout(orderId)
                SaleService -> Pricer : price(order)
                SaleService <-- Pricer : total : Money
                SaleService -> Loader : load(orderId)
                SaleService <-- Loader : order : Order
                @enduml
                """;
        DataflowLinter.Report r = DataflowLinter.lint(puml);
        assertEquals(1, r.violations().size(), () -> r.violations().toString());
        assertTrue(r.violations().get(0).contains("consumed before"), () -> r.violations().get(0));
    }

    @Test
    void literalsFieldAccessAndTypedArgsAreAccepted() {
        // Typed args are the wizard's form; literals and dotted access off a
        // produced value are ordinary design vocabulary, not dangling references.
        String puml = """
                @startuml
                participant SaleService
                participant Loader
                participant Auditor

                [*] -> SaleService : checkout(ownerId: Integer)
                SaleService -> Loader : load(ownerId: Integer)
                SaleService <-- Loader : owner : Owner
                SaleService -> Auditor : record(owner.getId(), "checkout", 3, true)
                @enduml
                """;
        DataflowLinter.Report r = DataflowLinter.lint(puml);
        assertTrue(r.ok(), () -> r.violations().toString());
    }

    // --- accessors on reused types ---
    //
    // Once arguments became real expressions, a design could call a method on a
    // type it did not write. Seen in half of a set of live runs
    // (`visit.hoursUntilVisit()` on a real Visit that has only getDate/getPet):
    // the root is genuinely in scope, so the other rules stay silent, and the
    // generated code does not compile.

    private static final String REUSED_ACCESSOR = """
            @startuml
            participant CancelVisitService
            participant FeePolicy

            [*] -> CancelVisitService : cancel(visit: Visit)
            CancelVisitService -> FeePolicy : feeFor(visit.%s())
            CancelVisitService <-- FeePolicy : fee : BigDecimal
            @enduml
            """;

    @Test
    void anAccessorThatTheReusedTypeDoesNotHaveIsAViolation() {
        DataflowLinter.Report r = DataflowLinter.lint(REUSED_ACCESSOR.formatted("hoursUntilVisit"),
                Map.of("Visit", List.of("getDate", "getDescription", "getPet")));
        assertEquals(1, r.violations().size(), () -> r.violations().toString());
        String v = r.violations().get(0);
        assertTrue(v.contains("hoursUntilVisit"), v);
        // The message must name what IS available, or the reader cannot act on it.
        assertTrue(v.contains("getDate") && v.contains("getPet"), v);
    }

    @Test
    void anAccessorTheReusedTypeDoesHaveIsClean() {
        assertTrue(DataflowLinter.lint(REUSED_ACCESSOR.formatted("getDate"),
                Map.of("Visit", List.of("getDate", "getDescription", "getPet"))).ok());
    }

    /**
     * Silence on unknown types is the design, not a limitation: a type the design
     * is creating has no implementation yet, so there is no method list to check
     * against and an opinion would be noise.
     */
    @Test
    void anAccessorOnATypeTheScanCannotSeeIsNotJudged() {
        assertTrue(DataflowLinter.lint(REUSED_ACCESSOR.formatted("hoursUntilVisit"),
                Map.of("SomeOtherType", List.of("x"))).ok());
        assertTrue(DataflowLinter.lint(REUSED_ACCESSOR.formatted("hoursUntilVisit"), Map.of()).ok(),
                "no catalog supplied means the rule is off entirely");
    }

    /**
     * A collection's methods are the collection's, not the payload's. Without this,
     * {@code visits.size()} would be judged against {@code Visit} and refused — a
     * false refusal, which costs the gate more credibility than a missed catch.
     */
    @Test
    void aCallOnAContainerIsNotJudgedAgainstItsPayloadType() {
        String puml = """
                @startuml
                participant VisitService
                participant Repo
                participant Counter

                [*] -> VisitService : summarise(ownerId: Integer)
                VisitService -> Repo : findAll(ownerId)
                VisitService <-- Repo : visits : List<Visit>
                VisitService -> Counter : count(visits.size())
                @enduml
                """;
        assertTrue(DataflowLinter.lint(puml, Map.of("Visit", List.of("getDate"))).ok(),
                () -> DataflowLinter.lint(puml, Map.of("Visit", List.of("getDate"))).violations().toString());
    }

    @Test
    void aPlainValueWithNoAccessorIsUnaffectedByTheRule() {
        String puml = """
                @startuml
                participant CancelVisitService
                participant Repo

                [*] -> CancelVisitService : cancel(visit: Visit)
                CancelVisitService -> Repo : save(visit)
                @enduml
                """;
        assertTrue(DataflowLinter.lint(puml, Map.of("Visit", List.of("getDate"))).ok());
    }

    // --- decision-table sidecars against the flow ---
    //
    // A design is two kinds of file, and until now nothing compared them. The
    // .puml says what calls what; the .decision.md says what the code must
    // compute. Each can be right alone and wrong together.

    @Test
    void theShippedResolverSidecarAgreesWithItsFlow() {
        // The golden pair, byte-for-byte as they ship. A false violation here
        // would mean the gate refuses the project's own worked example.
        DataflowLinter.Report r = DataflowLinter.lintDecision(
                golden("CancelVisitService.puml"),
                Map.of("CancellationFeePolicyResolver.decision.md",
                        golden("CancellationFeePolicyResolver.decision.md")));
        assertTrue(r.ok(), () -> r.violations().toString());
    }

    @Test
    void aSidecarWhoseTargetIsNeverCalledIsAViolation() {
        // Easy to emit by accident: the wizard finds a sidecar's participant by
        // name and return type, never by whether the sequence calls it.
        String orphan = golden("CancellationFeePolicyResolver.decision.md")
                .replace("target: CancellationFeePolicyResolver.resolve",
                        "target: SomeOtherResolver.resolve");
        DataflowLinter.Report r = DataflowLinter.lintDecision(
                golden("CancelVisitService.puml"), Map.of("orphan.decision.md", orphan));
        assertEquals(1, r.violations().size(), () -> r.violations().toString());
        assertTrue(r.violations().get(0).contains("nothing in the flow calls SomeOtherResolver.resolve"),
                () -> r.violations().get(0));
    }

    @Test
    void twoRowsMappingTheSameInputsToDifferentOutputsIsAViolation() {
        String contradictory = golden("CancellationFeePolicyResolver.decision.md")
                .replace("| clinic | ClinicInitiatedFee |", "| owner | ClinicInitiatedFee |");
        DataflowLinter.Report r = DataflowLinter.lintDecision(
                golden("CancelVisitService.puml"),
                Map.of("CancellationFeePolicyResolver.decision.md", contradictory));
        assertEquals(1, r.violations().size(), () -> r.violations().toString());
        String v = r.violations().get(0);
        assertTrue(v.contains("StandardCancellationFee") && v.contains("ClinicInitiatedFee"), v);
    }

    /** The same inputs mapping to the same output is duplication, not contradiction. */
    @Test
    void anExactlyRepeatedRowIsNotAContradiction() {
        String repeated = golden("CancellationFeePolicyResolver.decision.md")
                + "| owner | StandardCancellationFee |\n";
        assertTrue(DataflowLinter.lintDecision(golden("CancelVisitService.puml"),
                Map.of("dup.decision.md", repeated)).ok());
    }

    /**
     * Multi-column tables key on the whole input tuple. Rows that differ in any
     * column are different cases, however similar the rest looks.
     */
    @Test
    void rowsDifferingInAnyInputColumnAreDistinctCases() {
        String multi = """
                ---
                target: ShippingFeeCalculator.calculate
                input:
                  orderTotal: BigDecimal
                  region: String
                output: BigDecimal
                ---

                | orderTotal | region          | expected |
                |------------|-----------------|----------|
                | 99.99      | "DOMESTIC"      | 5.00     |
                | 99.99      | "INTERNATIONAL" | 25.00    |
                """;
        String puml = """
                @startuml
                participant OrderService
                participant ShippingFeeCalculator

                [*] -> OrderService : place(orderTotal, region)
                OrderService -> ShippingFeeCalculator : calculate(orderTotal, region)
                OrderService <-- ShippingFeeCalculator : fee : BigDecimal
                @enduml
                """;
        assertTrue(DataflowLinter.lintDecision(puml, Map.of("s.decision.md", multi)).ok(),
                () -> DataflowLinter.lintDecision(puml, Map.of("s.decision.md", multi)).violations().toString());
    }

    @Test
    void aSidecarWithNoTargetIsAViolation() {
        DataflowLinter.Report r = DataflowLinter.lintDecision(
                golden("CancelVisitService.puml"),
                Map.of("headless.decision.md", "---\ninput:\n  x: String\n---\n\n| x | expected |\n|---|---|\n| a | B |\n"));
        assertEquals(1, r.violations().size(), () -> r.violations().toString());
        assertTrue(r.violations().get(0).contains("no 'target:'"), () -> r.violations().get(0));
    }

    /**
     * Without a diagram there is nothing to compare a target against. Reporting
     * every sidecar as an orphan would make the gate useless exactly when the
     * user is part-way through composing a design.
     */
    @Test
    void sidecarsAreNotJudgedAgainstAnAbsentFlow() {
        Map<String, String> one = Map.of("r.decision.md",
                golden("CancellationFeePolicyResolver.decision.md"));
        assertTrue(DataflowLinter.lintDecision(null, one).ok());
        assertTrue(DataflowLinter.lintDecision("", one).ok());
        assertTrue(DataflowLinter.lintDecision("@startuml\n@enduml\n", one).ok());
        assertTrue(DataflowLinter.lintDecision(golden("CancelVisitService.puml"), Map.of()).ok());
    }

    @Test
    void emptyAndPreludeOnlyInputAreClean() {
        assertTrue(DataflowLinter.lint(null).ok());
        assertTrue(DataflowLinter.lint("").ok());
        assertTrue(DataflowLinter.lint("@startuml\nparticipant A\n@enduml\n").ok());
    }
}
