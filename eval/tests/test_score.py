# ABOUTME: Tests for scoring formulas — ResearchRubrics compliance and DRACO normalized/pass_rate.
# ABOUTME: Pure math tests with no external dependencies.

from bench.score import (
    Criterion,
    TaskScore,
    Verdict,
    draco_normalized_score,
    draco_pass_rate,
    draco_section_scores,
    researchrubrics_compliance,
    score_task,
)


def _criterion(id: str, weight: float, section: str = "Explicit Criteria") -> Criterion:
    return Criterion(id=id, text=f"criterion {id}", weight=weight, section=section)


def _verdict(criterion_id: str, met: bool) -> Verdict:
    return Verdict(
        task_id="task1",
        criterion_id=criterion_id,
        met=met,
        confidence=0.9,
        reasoning="test",
        tokens_used=100,
        model="test",
        duration_seconds=1.0,
    )


# --- ResearchRubrics compliance ---


class TestResearchRubricsCompliance:
    def test_all_satisfied(self):
        criteria = [_criterion("0", 5.0), _criterion("1", 3.0)]
        verdicts = [_verdict("0", True), _verdict("1", True)]
        assert researchrubrics_compliance(verdicts, criteria) == 1.0

    def test_none_satisfied(self):
        criteria = [_criterion("0", 5.0), _criterion("1", 3.0)]
        verdicts = [_verdict("0", False), _verdict("1", False)]
        assert researchrubrics_compliance(verdicts, criteria) == 0.0

    def test_partial_satisfaction(self):
        criteria = [_criterion("0", 5.0), _criterion("1", 3.0)]
        verdicts = [_verdict("0", True), _verdict("1", False)]
        # 5.0 / (5.0 + 3.0) = 0.625
        assert researchrubrics_compliance(verdicts, criteria) == 0.625

    def test_negative_weight_penalty(self):
        criteria = [_criterion("0", 5.0), _criterion("1", -4.0)]
        # criterion 0 satisfied (weight 5), criterion 1 (penalty) satisfied (bad thing found)
        verdicts = [_verdict("0", True), _verdict("1", True)]
        # numerator: 5*1 + (-4)*1 = 1, denominator: 5 (only positive weights)
        assert researchrubrics_compliance(verdicts, criteria) == 1.0 / 5.0

    def test_negative_weight_not_triggered(self):
        criteria = [_criterion("0", 5.0), _criterion("1", -4.0)]
        verdicts = [_verdict("0", True), _verdict("1", False)]
        # numerator: 5*1 + (-4)*0 = 5, denominator: 5
        assert researchrubrics_compliance(verdicts, criteria) == 1.0

    def test_all_negative_weights_returns_zero(self):
        criteria = [_criterion("0", -5.0), _criterion("1", -3.0)]
        verdicts = [_verdict("0", False), _verdict("1", False)]
        # denominator is 0 (no positive weights)
        assert researchrubrics_compliance(verdicts, criteria) == 0.0

    def test_empty_criteria(self):
        assert researchrubrics_compliance([], []) == 0.0


# --- DRACO normalized score ---


class TestDracoNormalizedScore:
    def test_all_met(self):
        criteria = [_criterion("0", 10), _criterion("1", 8)]
        verdicts = [_verdict("0", True), _verdict("1", True)]
        assert draco_normalized_score(verdicts, criteria) == 1.0

    def test_none_met(self):
        criteria = [_criterion("0", 10), _criterion("1", 8)]
        verdicts = [_verdict("0", False), _verdict("1", False)]
        assert draco_normalized_score(verdicts, criteria) == 0.0

    def test_partial(self):
        criteria = [_criterion("0", 10), _criterion("1", 8)]
        verdicts = [_verdict("0", True), _verdict("1", False)]
        # 10 / 18 ≈ 0.5556
        result = draco_normalized_score(verdicts, criteria)
        assert abs(result - 10.0 / 18.0) < 1e-9

    def test_clamped_at_zero(self):
        # Negative weight met brings score below 0
        criteria = [_criterion("0", 2), _criterion("1", -500)]
        verdicts = [_verdict("0", False), _verdict("1", True)]
        # raw: 0 + (-500) = -500, denominator: 2, clamped to 0
        assert draco_normalized_score(verdicts, criteria) == 0.0

    def test_clamped_at_one(self):
        criteria = [_criterion("0", 10)]
        verdicts = [_verdict("0", True)]
        assert draco_normalized_score(verdicts, criteria) == 1.0

    def test_empty(self):
        assert draco_normalized_score([], []) == 0.0


# --- DRACO pass rate ---


class TestDracoPassRate:
    def test_all_pass(self):
        criteria = [_criterion("0", 10), _criterion("1", 8)]
        verdicts = [_verdict("0", True), _verdict("1", True)]
        assert draco_pass_rate(verdicts, criteria) == 1.0

    def test_none_pass(self):
        criteria = [_criterion("0", 10), _criterion("1", 8)]
        verdicts = [_verdict("0", False), _verdict("1", False)]
        assert draco_pass_rate(verdicts, criteria) == 0.0

    def test_negative_weight_unmet_counts_as_pass(self):
        # Negative weight criterion: UNMET means the error is absent = pass
        criteria = [_criterion("0", 10), _criterion("1", -500)]
        verdicts = [_verdict("0", True), _verdict("1", False)]
        # Both pass: positive met + negative unmet
        assert draco_pass_rate(verdicts, criteria) == 1.0

    def test_negative_weight_met_counts_as_fail(self):
        # Negative weight criterion MET means the error IS present = fail
        criteria = [_criterion("0", 10), _criterion("1", -500)]
        verdicts = [_verdict("0", True), _verdict("1", True)]
        # Only first passes
        assert draco_pass_rate(verdicts, criteria) == 0.5

    def test_empty(self):
        assert draco_pass_rate([], []) == 0.0


# --- DRACO section scores ---


class TestDracoSectionScores:
    def test_groups_by_section(self):
        criteria = [
            _criterion("0", 10, section="factual-accuracy"),
            _criterion("1", 8, section="factual-accuracy"),
            _criterion("2", 5, section="citation-quality"),
        ]
        verdicts = [_verdict("0", True), _verdict("1", False), _verdict("2", True)]
        scores = draco_section_scores(verdicts, criteria)
        # factual-accuracy: 10/18 ≈ 0.556
        assert abs(scores["factual-accuracy"] - 10.0 / 18.0) < 1e-9
        # citation-quality: 5/5 = 1.0
        assert scores["citation-quality"] == 1.0

    def test_empty(self):
        assert draco_section_scores([], []) == {}


# --- score_task dispatch ---


class TestScoreTask:
    def test_researchrubrics_dispatch(self):
        criteria = [_criterion("0", 5.0), _criterion("1", 3.0)]
        verdicts = [_verdict("0", True), _verdict("1", True)]
        result = score_task(verdicts, criteria, benchmark="researchrubrics", task_id="t1")
        assert isinstance(result, TaskScore)
        assert result.benchmark == "researchrubrics"
        assert result.score == 1.0
        assert result.criteria_count == 2
        assert result.criteria_met == 2

    def test_draco_dispatch(self):
        criteria = [
            _criterion("0", 10, section="factual-accuracy"),
            _criterion("1", 5, section="citation-quality"),
        ]
        verdicts = [_verdict("0", True), _verdict("1", False)]
        result = score_task(verdicts, criteria, benchmark="draco", task_id="t1")
        assert result.benchmark == "draco"
        assert abs(result.score - 10.0 / 15.0) < 1e-9
        assert result.criteria_met == 1
        assert "factual-accuracy" in result.section_scores
