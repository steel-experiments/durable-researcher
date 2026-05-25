# ABOUTME: Tests for the sqlite-backed scoreboard — schema, insert, query, render, finalize.
# ABOUTME: All tests use a tmp sqlite path; no shared state between tests.

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from bench.score import Criterion, Verdict
from bench.scoreboard import (
    RunRow,
    TaskScoreRow,
    aggregate_scores,
    finalize_run,
    init_db,
    insert_run,
    latest_runs,
    render_markdown,
)


def _make_verdict(task_id: str, criterion_id: str, met: bool) -> Verdict:
    return Verdict(
        task_id=task_id,
        criterion_id=criterion_id,
        met=met,
        confidence=0.9,
        reasoning="r",
        tokens_used=0,
        model="m",
        duration_seconds=0.0,
    )


class TestInitDb:
    def test_creates_runs_and_task_scores_tables(self, tmp_path: Path):
        db_path = tmp_path / "scoreboard.sqlite"
        init_db(db_path)
        conn = sqlite3.connect(db_path)
        try:
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()}
        finally:
            conn.close()
        assert "runs" in tables
        assert "task_scores" in tables

    def test_idempotent(self, tmp_path: Path):
        db_path = tmp_path / "scoreboard.sqlite"
        init_db(db_path)
        init_db(db_path)  # second call must not raise


class TestInsertAndQueryRuns:
    def test_round_trip(self, tmp_path: Path):
        db_path = tmp_path / "scoreboard.sqlite"
        init_db(db_path)
        run = RunRow(
            run_id="run-1",
            ts="2026-01-01T00:00:00Z",
            benchmark="draco",
            git_sha="abc1234",
            git_dirty=False,
            agent_model="claude-opus-4",
            agent_depth="quick",
            agent_max_sources=10,
            judge_model="glm-4.7-flashx",
            judge_mode="realtime",
            n_tasks=15,
            mean_score=0.42,
            mean_pass_rate=0.5,
            median_score=0.4,
            stdev_score=0.1,
            wall_seconds=900,
            cost_usd=0.05,
            notes="baseline",
        )
        task_rows = [
            TaskScoreRow(
                run_id="run-1",
                task_id="t1",
                score=0.5,
                pass_rate=0.6,
                section_scores={"factual": 0.7},
                criteria_count=10,
                criteria_met=6,
            ),
        ]
        insert_run(db_path, run, task_rows)

        rows = latest_runs(db_path, benchmark="draco", limit=5)
        assert len(rows) == 1
        assert rows[0].run_id == "run-1"
        assert rows[0].mean_score == 0.42
        assert rows[0].git_dirty is False

    def test_cost_usd_nullable(self, tmp_path: Path):
        db_path = tmp_path / "scoreboard.sqlite"
        init_db(db_path)
        run = RunRow(
            run_id="run-x",
            ts="2026-01-01T00:00:00Z",
            benchmark="draco",
            git_sha=None,
            git_dirty=False,
            agent_model=None,
            agent_depth=None,
            agent_max_sources=None,
            judge_model="glm-4.7-flashx",
            judge_mode=None,
            n_tasks=1,
            mean_score=0.1,
            mean_pass_rate=0.1,
            median_score=0.1,
            stdev_score=0.0,
            wall_seconds=None,
            cost_usd=None,
            notes=None,
        )
        insert_run(db_path, run, [])
        rows = latest_runs(db_path, benchmark="draco", limit=5)
        assert rows[0].cost_usd is None

    def test_filters_by_benchmark(self, tmp_path: Path):
        db_path = tmp_path / "scoreboard.sqlite"
        init_db(db_path)
        for bm, rid in [("draco", "r-draco"), ("researchrubrics", "r-rr")]:
            insert_run(
                db_path,
                RunRow(
                    run_id=rid,
                    ts="2026-01-01T00:00:00Z",
                    benchmark=bm,
                    git_sha=None,
                    git_dirty=False,
                    agent_model=None,
                    agent_depth=None,
                    agent_max_sources=None,
                    judge_model="glm-4.7-flashx",
                    judge_mode=None,
                    n_tasks=0,
                    mean_score=0.0,
                    mean_pass_rate=0.0,
                    median_score=0.0,
                    stdev_score=0.0,
                    wall_seconds=None,
                    cost_usd=None,
                    notes=None,
                ),
                [],
            )
        draco = latest_runs(db_path, benchmark="draco", limit=20)
        assert {r.run_id for r in draco} == {"r-draco"}


class TestAggregateScores:
    def test_dispatches_to_bench_score(self):
        criteria = [
            Criterion(id="t:0", text="a", weight=1.0, section="s"),
            Criterion(id="t:1", text="b", weight=1.0, section="s"),
        ]
        verdicts = [_make_verdict("t", "t:0", True), _make_verdict("t", "t:1", False)]
        agg = aggregate_scores(
            verdicts_by_task={"t": verdicts},
            criteria_by_task={"t": criteria},
            benchmark="draco",
        )
        assert agg.n_tasks == 1
        assert agg.task_rows[0].task_id == "t"
        assert 0 <= agg.task_rows[0].score <= 1.0
        # 1 of 2 met
        assert agg.task_rows[0].criteria_met == 1


class TestFinalizeRun:
    def test_inserts_one_run_and_n_task_scores(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # Set up a fake results-X/draco/glm-4.7-flashx/<task>.jsonl
        results_root = tmp_path / "results-foo"
        verdicts_dir = results_root / "draco" / "glm-4.7-flashx"
        verdicts_dir.mkdir(parents=True)
        # Build a fixture jsonl for two tasks
        data = {
            "task1": [
                _make_verdict("task1", "task1:0", True),
                _make_verdict("task1", "task1:1", False),
            ],
            "task2": [
                _make_verdict("task2", "task2:0", True),
            ],
        }
        for task_id, verdicts in data.items():
            from dataclasses import asdict
            with open(verdicts_dir / f"{task_id}.jsonl", "w") as f:
                for v in verdicts:
                    f.write(json.dumps(asdict(v)) + "\n")

        # Stub criteria loader so we don't need the real dataset
        criteria_by_task = {
            "task1": [
                Criterion(id="task1:0", text="a", weight=1.0, section="s"),
                Criterion(id="task1:1", text="b", weight=1.0, section="s"),
            ],
            "task2": [
                Criterion(id="task2:0", text="a", weight=1.0, section="s"),
            ],
        }

        db_path = tmp_path / "scoreboard.sqlite"
        init_db(db_path)

        run_id = finalize_run(
            db_path=db_path,
            results_dir=results_root,
            benchmark="draco",
            judge_model="glm-4.7-flashx",
            criteria_by_task=criteria_by_task,
            git_sha="abc1234",
            git_dirty=False,
            agent_model="claude",
            agent_depth="quick",
            agent_max_sources=10,
            judge_mode="realtime",
            wall_seconds=None,
            cost_usd=None,
            notes=None,
        )

        rows = latest_runs(db_path, benchmark="draco", limit=10)
        assert len(rows) == 1
        assert rows[0].run_id == run_id
        assert rows[0].n_tasks == 2

        conn = sqlite3.connect(db_path)
        try:
            task_count = conn.execute(
                "SELECT count(*) FROM task_scores WHERE run_id = ?", (run_id,),
            ).fetchone()[0]
        finally:
            conn.close()
        assert task_count == 2


class TestRenderMarkdown:
    def test_lists_runs_with_delta(self, tmp_path: Path):
        db_path = tmp_path / "scoreboard.sqlite"
        init_db(db_path)

        for i, score in enumerate([0.3, 0.4, 0.5]):
            insert_run(
                db_path,
                RunRow(
                    run_id=f"r{i}",
                    ts=f"2026-01-0{i + 1}T00:00:00Z",
                    benchmark="draco",
                    git_sha=f"sha{i}",
                    git_dirty=(i % 2 == 1),
                    agent_model="claude",
                    agent_depth="quick",
                    agent_max_sources=10,
                    judge_model="glm-4.7-flashx",
                    judge_mode="realtime",
                    n_tasks=15,
                    mean_score=score,
                    mean_pass_rate=score,
                    median_score=score,
                    stdev_score=0.1,
                    wall_seconds=600,
                    cost_usd=0.05,
                    notes=None,
                ),
                [],
            )

        md = render_markdown(db_path, benchmark="draco", limit=10)
        # Expect a table-like header and presence of all three run IDs
        assert "draco" in md
        assert "r0" in md
        assert "r1" in md
        assert "r2" in md
        # Delta should show up for any later run vs an earlier one
        assert "0.100" in md or "+0.100" in md or "Δ" in md
