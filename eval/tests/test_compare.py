# ABOUTME: Tests for cross-run comparison logic — intersection, per-section averaging,
# ABOUTME: win/loss/tie tallies, and markdown rendering of comparison reports.

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pytest

from bench.compare import (
    RunComparison,
    compute_comparison,
    discover_runs,
    format_comparison_report,
    load_run_scores,
)
from bench.score import Criterion, TaskScore, Verdict

FIXTURES = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _task_score(
    task_id: str,
    score: float,
    pass_rate: float = 0.5,
    section_scores: dict[str, float] | None = None,
) -> TaskScore:
    return TaskScore(
        task_id=task_id,
        benchmark="draco",
        score=score,
        pass_rate=pass_rate,
        section_scores=section_scores or {},
        criteria_count=4,
        criteria_met=2,
    )


def _write_verdicts(path: Path, task_id: str, criteria_ids: list[str], met_flags: list[bool]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for cid, met in zip(criteria_ids, met_flags):
            v = Verdict(
                task_id=task_id,
                criterion_id=cid,
                met=met,
                confidence=0.9,
                reasoning="test",
                tokens_used=100,
                model="test-model",
                duration_seconds=0.5,
            )
            f.write(json.dumps(asdict(v)) + "\n")


# ---------------------------------------------------------------------------
# compute_comparison: intersection logic
# ---------------------------------------------------------------------------


class TestComputeComparisonIntersection:
    def test_intersects_task_ids_across_baseline_and_candidates(self):
        baseline = {
            "t1": _task_score("t1", 0.6),
            "t2": _task_score("t2", 0.5),
            "t3": _task_score("t3", 0.7),
        }
        candidate = {
            "t2": _task_score("t2", 0.8),
            "t3": _task_score("t3", 0.4),
            "t4": _task_score("t4", 0.9),  # not in baseline — dropped
        }

        result = compute_comparison(baseline, [candidate], ["cand"])

        # Only t2 and t3 are in both
        task_ids = [row.task_id for row in result.per_task]
        assert sorted(task_ids) == ["t2", "t3"]

    def test_intersection_across_multiple_candidates(self):
        baseline = {"t1": _task_score("t1", 0.5), "t2": _task_score("t2", 0.6), "t3": _task_score("t3", 0.7)}
        cand_a = {"t1": _task_score("t1", 0.55), "t2": _task_score("t2", 0.65)}
        cand_b = {"t2": _task_score("t2", 0.7), "t3": _task_score("t3", 0.75)}

        result = compute_comparison(baseline, [cand_a, cand_b], ["a", "b"])

        # Only t2 is present in baseline, cand_a, AND cand_b
        assert [row.task_id for row in result.per_task] == ["t2"]

    def test_empty_intersection_returns_empty_per_task(self):
        baseline = {"t1": _task_score("t1", 0.5)}
        candidate = {"t2": _task_score("t2", 0.6)}

        result = compute_comparison(baseline, [candidate], ["cand"])

        assert result.per_task == []


# ---------------------------------------------------------------------------
# Per-task deltas and per-section means
# ---------------------------------------------------------------------------


class TestComputeComparisonValues:
    def test_per_task_delta_is_candidate_minus_baseline(self):
        baseline = {"t1": _task_score("t1", 0.4)}
        candidate = {"t1": _task_score("t1", 0.7)}

        result = compute_comparison(baseline, [candidate], ["cand"])

        row = result.per_task[0]
        assert row.baseline_score == pytest.approx(0.4)
        assert row.candidate_scores == [pytest.approx(0.7)]
        assert row.deltas == [pytest.approx(0.3)]

    def test_per_section_means_across_intersection(self):
        baseline = {
            "t1": _task_score("t1", 0.5, section_scores={"factual": 0.6, "citations": 0.4}),
            "t2": _task_score("t2", 0.5, section_scores={"factual": 0.8, "citations": 0.6}),
        }
        candidate = {
            "t1": _task_score("t1", 0.7, section_scores={"factual": 0.9, "citations": 0.5}),
            "t2": _task_score("t2", 0.7, section_scores={"factual": 1.0, "citations": 0.7}),
        }

        result = compute_comparison(baseline, [candidate], ["cand"])

        section_means = {row.section: row for row in result.per_section}
        # factual baseline mean: (0.6+0.8)/2 = 0.7; candidate mean: (0.9+1.0)/2 = 0.95
        assert section_means["factual"].baseline_mean == pytest.approx(0.7)
        assert section_means["factual"].candidate_means[0] == pytest.approx(0.95)
        assert section_means["factual"].deltas[0] == pytest.approx(0.25)
        # citations baseline mean: 0.5; candidate mean: 0.6
        assert section_means["citations"].baseline_mean == pytest.approx(0.5)
        assert section_means["citations"].candidate_means[0] == pytest.approx(0.6)
        assert section_means["citations"].deltas[0] == pytest.approx(0.1)

    def test_section_only_present_in_baseline_is_skipped_for_candidate_mean(self):
        # If a candidate is missing a section that baseline has, we report 0 candidates for it.
        baseline = {
            "t1": _task_score("t1", 0.5, section_scores={"factual": 0.6, "extra": 0.5}),
        }
        candidate = {
            "t1": _task_score("t1", 0.7, section_scores={"factual": 0.8}),
        }

        result = compute_comparison(baseline, [candidate], ["cand"])

        section_means = {row.section: row for row in result.per_section}
        # 'extra' present only in baseline — included with NaN/None candidate mean
        assert "extra" in section_means
        assert section_means["extra"].baseline_mean == pytest.approx(0.5)
        assert section_means["extra"].candidate_means[0] is None
        assert section_means["extra"].deltas[0] is None

    def test_aggregate_mean_across_intersection(self):
        baseline = {
            "t1": _task_score("t1", 0.4),
            "t2": _task_score("t2", 0.6),
        }
        candidate = {
            "t1": _task_score("t1", 0.6),
            "t2": _task_score("t2", 0.8),
        }

        result = compute_comparison(baseline, [candidate], ["cand"])

        assert result.baseline_overall_mean == pytest.approx(0.5)
        assert result.candidate_overall_means[0] == pytest.approx(0.7)


# ---------------------------------------------------------------------------
# Win / loss / tie tallies
# ---------------------------------------------------------------------------


class TestWinLossTie:
    def test_counts_win_loss_tie(self):
        baseline = {
            "t1": _task_score("t1", 0.4),  # candidate wins
            "t2": _task_score("t2", 0.7),  # candidate loses
            "t3": _task_score("t3", 0.5),  # tie
        }
        candidate = {
            "t1": _task_score("t1", 0.6),
            "t2": _task_score("t2", 0.5),
            "t3": _task_score("t3", 0.5),
        }

        result = compute_comparison(baseline, [candidate], ["cand"])

        stats = result.candidate_stats[0]
        assert stats.wins == 1
        assert stats.losses == 1
        assert stats.ties == 1

    def test_mean_win_and_loss_deltas(self):
        baseline = {
            "t1": _task_score("t1", 0.4),  # win Δ +0.2
            "t2": _task_score("t2", 0.5),  # win Δ +0.4
            "t3": _task_score("t3", 0.8),  # loss Δ -0.3
        }
        candidate = {
            "t1": _task_score("t1", 0.6),
            "t2": _task_score("t2", 0.9),
            "t3": _task_score("t3", 0.5),
        }

        result = compute_comparison(baseline, [candidate], ["cand"])

        stats = result.candidate_stats[0]
        assert stats.mean_win_delta == pytest.approx(0.3)  # (0.2 + 0.4) / 2
        assert stats.mean_loss_delta == pytest.approx(-0.3)

    def test_no_wins_or_losses_returns_zero_means(self):
        baseline = {"t1": _task_score("t1", 0.5)}
        candidate = {"t1": _task_score("t1", 0.5)}

        result = compute_comparison(baseline, [candidate], ["cand"])

        stats = result.candidate_stats[0]
        assert stats.wins == 0
        assert stats.losses == 0
        assert stats.ties == 1
        assert stats.mean_win_delta == 0.0
        assert stats.mean_loss_delta == 0.0

    def test_tie_uses_epsilon(self):
        # Tiny differences below 1e-6 should be ties, not wins/losses
        baseline = {"t1": _task_score("t1", 0.5)}
        candidate = {"t1": _task_score("t1", 0.5 + 1e-9)}

        result = compute_comparison(baseline, [candidate], ["cand"])

        stats = result.candidate_stats[0]
        assert stats.ties == 1


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------


class TestFormatComparisonReport:
    def test_single_candidate_table_has_expected_columns(self):
        baseline = {"t1abc": _task_score("t1abc", 0.4, section_scores={"factual": 0.5})}
        candidate = {"t1abc": _task_score("t1abc", 0.7, section_scores={"factual": 0.9})}

        result = compute_comparison(baseline, [candidate], ["v3"])
        md = format_comparison_report(
            result,
            benchmark="draco",
            judge_model="glm-4.7-flashx",
            baseline_label="baseline",
            candidate_labels=["v3"],
        )

        # Header columns
        assert "task_id" in md
        assert "baseline" in md
        assert "v3" in md
        assert "Δ" in md
        # Per-task row
        assert "t1abc" in md
        # Per-section table
        assert "factual" in md
        # Stats
        assert "wins" in md.lower() or "Wins" in md

    def test_multi_candidate_emits_columns_for_each(self):
        baseline = {"t1": _task_score("t1", 0.4)}
        cand_a = {"t1": _task_score("t1", 0.5)}
        cand_b = {"t1": _task_score("t1", 0.6)}

        result = compute_comparison(baseline, [cand_a, cand_b], ["a", "b"])
        md = format_comparison_report(
            result,
            benchmark="draco",
            judge_model="glm-4.7-flashx",
            baseline_label="base",
            candidate_labels=["a", "b"],
        )

        assert "| a |" in md or "| a " in md
        assert "| b |" in md or "| b " in md

    def test_empty_intersection_renders_warning(self):
        baseline = {"t1": _task_score("t1", 0.5)}
        candidate = {"t9": _task_score("t9", 0.5)}

        result = compute_comparison(baseline, [candidate], ["cand"])
        md = format_comparison_report(
            result,
            benchmark="draco",
            judge_model="glm-4.7-flashx",
            baseline_label="base",
            candidate_labels=["cand"],
        )

        assert "No tasks" in md or "no tasks" in md.lower()


# ---------------------------------------------------------------------------
# load_run_scores: integrates with on-disk verdicts
# ---------------------------------------------------------------------------


class TestLoadRunScores:
    def test_loads_scores_from_verdicts_dir(self, tmp_path):
        # Build a tiny DRACO results dir
        results_dir = tmp_path / "results-x" / "draco" / "glm-4.7-flashx"
        results_dir.mkdir(parents=True)

        # Use a known task ID from the fixture
        _write_verdicts(
            results_dir / "test-task-001.jsonl",
            task_id="test-task-001",
            criteria_ids=[
                "test-task-001:0",  # attention-mechanism-origin (w=10)
                "test-task-001:1",  # bert-gpt-timeline (w=8)
                "test-task-001:2",  # scaling-laws-discussion (w=6)
                "test-task-001:3",  # technical-terminology (w=5)
                "test-task-001:4",  # cites-vaswani-2017 (w=5)
            ],
            met_flags=[True, True, False, True, False],
        )

        scores = load_run_scores(
            results_dir=tmp_path / "results-x",
            benchmark="draco",
            judge_model="glm-4.7-flashx",
            data_path=FIXTURES / "draco_sample.jsonl",
        )

        assert "test-task-001" in scores
        ts = scores["test-task-001"]
        # raw = 10+8+5 = 23, denominator = 10+8+6+5+5 = 34 → 23/34 ≈ 0.676
        assert ts.score == pytest.approx(23.0 / 34.0)
        assert ts.criteria_met == 3

    def test_missing_judge_model_dir_returns_empty(self, tmp_path):
        scores = load_run_scores(
            results_dir=tmp_path / "nope",
            benchmark="draco",
            judge_model="glm-4.7-flashx",
            data_path=FIXTURES / "draco_sample.jsonl",
        )
        assert scores == {}


# ---------------------------------------------------------------------------
# Output file write
# ---------------------------------------------------------------------------


class TestReportFileWrite:
    def test_writes_markdown_to_output_path(self, tmp_path):
        from bench.compare import save_comparison_report

        baseline = {"t1": _task_score("t1", 0.4)}
        candidate = {"t1": _task_score("t1", 0.6)}
        result = compute_comparison(baseline, [candidate], ["cand"])
        md = format_comparison_report(
            result,
            benchmark="draco",
            judge_model="glm-4.7-flashx",
            baseline_label="base",
            candidate_labels=["cand"],
        )

        out = tmp_path / "report.md"
        save_comparison_report(md, out)

        assert out.exists()
        text = out.read_text()
        assert "task_id" in text


# ---------------------------------------------------------------------------
# discover_runs (scoreboard helper)
# ---------------------------------------------------------------------------


class TestDiscoverRuns:
    def test_finds_results_dirs_with_matching_judge_model(self, tmp_path):
        # Build two results dirs
        (tmp_path / "results-foo" / "draco" / "glm-4.7-flashx").mkdir(parents=True)
        (tmp_path / "results-bar" / "draco" / "glm-4.7-flashx").mkdir(parents=True)
        (tmp_path / "results-other" / "draco" / "different-model").mkdir(parents=True)

        # Touch a verdict file in each
        (tmp_path / "results-foo" / "draco" / "glm-4.7-flashx" / "t.jsonl").write_text("")
        (tmp_path / "results-bar" / "draco" / "glm-4.7-flashx" / "t.jsonl").write_text("")

        runs = discover_runs(tmp_path, benchmark="draco", judge_model="glm-4.7-flashx")

        names = sorted(r.name for r in runs)
        assert names == ["results-bar", "results-foo"]

    def test_skips_dirs_without_matching_model(self, tmp_path):
        (tmp_path / "results-x" / "draco" / "other-model").mkdir(parents=True)

        runs = discover_runs(tmp_path, benchmark="draco", judge_model="glm-4.7-flashx")
        assert runs == []
