# ABOUTME: Tests for markdown report generation, including optional usage summaries.

from bench.report import generate_report
from bench.score import TaskScore


def _task_score(
    task_id: str,
    score: float,
    pass_rate: float,
    section_scores: dict[str, float] | None = None,
) -> TaskScore:
    return TaskScore(
        task_id=task_id,
        benchmark="draco",
        score=score,
        pass_rate=pass_rate,
        section_scores=section_scores or {},
        criteria_count=10,
        criteria_met=7,
    )


class TestGenerateReport:
    def test_includes_resource_usage_when_available(self):
        scores = [
            _task_score("task1", 0.7, 0.8, {"factual-accuracy": 0.6}),
            _task_score("task2", 0.5, 0.6, {"factual-accuracy": 0.4}),
        ]
        usage_by_task = {
            "task1": {"inputTokens": 1000, "outputTokens": 200, "cacheReadTokens": 50},
            "task2": {"inputTokens": 3000, "outputTokens": 400, "cacheReadTokens": 0},
        }

        report = generate_report(scores, "draco", usage_by_task=usage_by_task)

        assert "## Resource Usage" in report
        assert "Tasks with usage data**: 2/2" in report
        assert "| Input Tokens | 2000.000 | 2000.000 | 1414.214 | 1000.000 | 3000.000 |" in report
        assert "| Output Tokens | 300.000 | 300.000 | 141.421 | 200.000 | 400.000 |" in report
        assert "| Cache Read Tokens | 25.000 | 25.000 | 35.355 | 0.000 | 50.000 |" in report

    def test_omits_resource_usage_when_missing(self):
        scores = [_task_score("task1", 0.7, 0.8)]

        report = generate_report(scores, "draco")

        assert "## Resource Usage" not in report

    def test_includes_campaign_eval_when_available(self):
        scores = [_task_score("task1", 0.7, 0.8)]
        campaign_eval_by_task = {
            "task1": {
                "quality_per_hour": 0.2,
                "quality_per_dollar": 0.07,
                "auditability_rate": 0.9,
                "freshness_rate": 0.5,
                "plateau_detected": True,
                "resume_correct": True,
            }
        }

        report = generate_report(
            scores,
            "draco",
            campaign_eval_by_task=campaign_eval_by_task,
        )

        assert "## Campaign Eval" in report
        assert "Plateau detected**: 1/1" in report
        assert "| Auditability Rate | 0.900 |" in report
