from bench.golden import (
    GoldenTask,
    aggregate_by_mode,
    extract_reported_confidence,
    format_golden_report,
    score_report,
)


def test_score_report_matches_answers_and_computes_brier():
    task = GoldenTask(
        task_id="lookup-1",
        mode="lookup",
        prompt="p",
        expected_answers=["Sample Answer"],
        expected_confidence="high",
    )
    score = score_report(task, "The answer is Sample Answer. Confidence: high")
    assert score.score == 1.0
    assert score.matched == 1
    assert round(score.brier, 3) == 0.01


def test_score_report_penalizes_overconfident_wrong_answer():
    task = GoldenTask(
        task_id="lookup-1",
        mode="lookup",
        prompt="p",
        expected_answers=["Sample Answer"],
        expected_confidence="medium",
    )
    score = score_report(task, "Different answer. high confidence")
    assert score.score == 0.0
    assert round(score.brier, 3) == 0.81


def test_extract_reported_confidence():
    assert extract_reported_confidence("Confidence: medium") == "medium"
    assert extract_reported_confidence("This is a low confidence result") == "low"
    assert extract_reported_confidence("No marker") is None


def test_aggregate_and_format_report():
    scores = [
        score_report(
            GoldenTask("a", "lookup", "p", ["x"], "high"),
            "x Confidence: high",
        ),
        score_report(
            GoldenTask("b", "survey", "p", ["y"], "medium"),
            "missing Confidence: medium",
        ),
    ]
    by_mode = aggregate_by_mode(scores)
    assert by_mode["lookup"]["mean_score"] == 1.0
    assert by_mode["survey"]["mean_score"] == 0.0
    report = format_golden_report(scores)
    assert "Mean Brier" in report
    assert "| lookup |" in report
