# ABOUTME: Scoring formulas for ResearchRubrics compliance and DRACO normalized/pass_rate.
# ABOUTME: Pure functions operating on Verdict and Criterion dataclasses.

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Criterion:
    """A single evaluation criterion from either benchmark."""

    id: str
    text: str
    weight: float
    section: str


@dataclass(frozen=True)
class Verdict:
    """Judge's binary verdict on a single criterion."""

    task_id: str
    criterion_id: str
    met: bool
    confidence: float
    reasoning: str
    tokens_used: int
    model: str
    duration_seconds: float


@dataclass
class TaskScore:
    """Aggregated score for a single benchmark task."""

    task_id: str
    benchmark: str
    score: float
    pass_rate: float
    section_scores: dict[str, float] = field(default_factory=dict)
    criteria_count: int = 0
    criteria_met: int = 0


def _build_verdict_map(verdicts: list[Verdict]) -> dict[str, bool]:
    """Map criterion_id -> met for quick lookup."""
    return {v.criterion_id: v.met for v in verdicts}


def researchrubrics_compliance(
    verdicts: list[Verdict], criteria: list[Criterion]
) -> float:
    """ResearchRubrics compliance score.

    Formula: sum(weight * met) / sum(positive_weights)
    Negative-weight criteria subtract from numerator but not denominator.
    """
    if not criteria:
        return 0.0

    positive_weight_sum = sum(c.weight for c in criteria if c.weight > 0)
    if positive_weight_sum == 0:
        return 0.0

    met_map = _build_verdict_map(verdicts)
    numerator = sum(
        c.weight * (1.0 if met_map.get(c.id, False) else 0.0) for c in criteria
    )
    return numerator / positive_weight_sum


def draco_normalized_score(
    verdicts: list[Verdict], criteria: list[Criterion]
) -> float:
    """DRACO normalized score.

    Formula: clamp(sum(weight * met) / sum(positive_weights), 0, 1)
    """
    if not criteria:
        return 0.0

    positive_weight_sum = sum(c.weight for c in criteria if c.weight > 0)
    if positive_weight_sum == 0:
        return 0.0

    met_map = _build_verdict_map(verdicts)
    raw = sum(
        c.weight * (1.0 if met_map.get(c.id, False) else 0.0) for c in criteria
    )
    return max(0.0, min(1.0, raw / positive_weight_sum))


def draco_pass_rate(verdicts: list[Verdict], criteria: list[Criterion]) -> float:
    """DRACO pass rate: fraction of criteria correctly handled.

    Positive-weight criteria pass when MET.
    Negative-weight criteria pass when UNMET (error absent).
    """
    if not criteria:
        return 0.0

    met_map = _build_verdict_map(verdicts)
    passed = 0
    for c in criteria:
        is_met = met_map.get(c.id, False)
        if c.weight > 0 and is_met:
            passed += 1
        elif c.weight < 0 and not is_met:
            passed += 1
    return passed / len(criteria)


def draco_section_scores(
    verdicts: list[Verdict], criteria: list[Criterion]
) -> dict[str, float]:
    """Per-section DRACO normalized scores."""
    if not criteria:
        return {}

    sections: dict[str, list[Criterion]] = {}
    for c in criteria:
        sections.setdefault(c.section, []).append(c)

    met_map = _build_verdict_map(verdicts)
    result = {}
    for section, section_criteria in sections.items():
        pos_sum = sum(c.weight for c in section_criteria if c.weight > 0)
        if pos_sum == 0:
            result[section] = 0.0
            continue
        raw = sum(
            c.weight * (1.0 if met_map.get(c.id, False) else 0.0)
            for c in section_criteria
        )
        result[section] = max(0.0, min(1.0, raw / pos_sum))
    return result


def score_task(
    verdicts: list[Verdict],
    criteria: list[Criterion],
    benchmark: str,
    task_id: str,
) -> TaskScore:
    """Score a single task, dispatching to the correct benchmark formula."""
    met_count = sum(1 for v in verdicts if v.met)

    if benchmark == "researchrubrics":
        score = researchrubrics_compliance(verdicts, criteria)
        pass_rate = met_count / len(criteria) if criteria else 0.0
        section_scores: dict[str, float] = {}
    elif benchmark == "draco":
        score = draco_normalized_score(verdicts, criteria)
        pass_rate = draco_pass_rate(verdicts, criteria)
        section_scores = draco_section_scores(verdicts, criteria)
    else:
        raise ValueError(f"Unknown benchmark: {benchmark}")

    return TaskScore(
        task_id=task_id,
        benchmark=benchmark,
        score=score,
        pass_rate=pass_rate,
        section_scores=section_scores,
        criteria_count=len(criteria),
        criteria_met=met_count,
    )
