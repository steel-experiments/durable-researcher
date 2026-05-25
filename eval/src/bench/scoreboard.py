# ABOUTME: SQLite-backed scoreboard — schema, insert, query, render. Persists one
# ABOUTME: row per benchmark run so every commit's eval score is trackable across time.

from __future__ import annotations

import json
import sqlite3
import statistics
import subprocess
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from bench.judge import load_existing_verdicts
from bench.score import Criterion, TaskScore, Verdict, score_task


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------


@dataclass
class RunRow:
    """One row in the `runs` table — summary metadata for a benchmark run."""

    run_id: str
    ts: str
    benchmark: str
    git_sha: str | None
    git_dirty: bool
    agent_model: str | None
    agent_depth: str | None
    agent_max_sources: int | None
    judge_model: str
    judge_mode: str | None
    n_tasks: int
    mean_score: float
    mean_pass_rate: float
    median_score: float
    stdev_score: float
    wall_seconds: int | None
    cost_usd: float | None
    notes: str | None


@dataclass
class TaskScoreRow:
    """One row in the `task_scores` table — per-task score for a given run."""

    run_id: str
    task_id: str
    score: float
    pass_rate: float
    section_scores: dict[str, float] = field(default_factory=dict)
    criteria_count: int = 0
    criteria_met: int = 0


@dataclass
class AggregatedScores:
    """Aggregated stats across all tasks in a run."""

    n_tasks: int
    mean_score: float
    mean_pass_rate: float
    median_score: float
    stdev_score: float
    task_rows: list[TaskScoreRow]


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    benchmark TEXT NOT NULL,
    git_sha TEXT,
    git_dirty INTEGER,
    agent_model TEXT,
    agent_depth TEXT,
    agent_max_sources INTEGER,
    judge_model TEXT,
    judge_mode TEXT,
    n_tasks INTEGER,
    mean_score REAL,
    mean_pass_rate REAL,
    median_score REAL,
    stdev_score REAL,
    wall_seconds INTEGER,
    cost_usd REAL,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS task_scores (
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    score REAL,
    pass_rate REAL,
    section_scores TEXT,
    criteria_count INTEGER,
    criteria_met INTEGER,
    PRIMARY KEY (run_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_runs_benchmark_ts
    ON runs(benchmark, ts DESC);
"""


def init_db(db_path: Path) -> None:
    """Create the schema if it doesn't already exist. Idempotent."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Insert / query
# ---------------------------------------------------------------------------


def insert_run(
    db_path: Path,
    run: RunRow,
    task_rows: list[TaskScoreRow],
) -> None:
    """Insert a run row and its task_scores rows in a single transaction."""
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """INSERT INTO runs (
                run_id, ts, benchmark, git_sha, git_dirty,
                agent_model, agent_depth, agent_max_sources,
                judge_model, judge_mode, n_tasks,
                mean_score, mean_pass_rate, median_score, stdev_score,
                wall_seconds, cost_usd, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                run.run_id,
                run.ts,
                run.benchmark,
                run.git_sha,
                1 if run.git_dirty else 0,
                run.agent_model,
                run.agent_depth,
                run.agent_max_sources,
                run.judge_model,
                run.judge_mode,
                run.n_tasks,
                run.mean_score,
                run.mean_pass_rate,
                run.median_score,
                run.stdev_score,
                run.wall_seconds,
                run.cost_usd,
                run.notes,
            ),
        )
        for tr in task_rows:
            conn.execute(
                """INSERT INTO task_scores (
                    run_id, task_id, score, pass_rate,
                    section_scores, criteria_count, criteria_met
                ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    tr.run_id,
                    tr.task_id,
                    tr.score,
                    tr.pass_rate,
                    json.dumps(tr.section_scores),
                    tr.criteria_count,
                    tr.criteria_met,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def latest_runs(
    db_path: Path,
    benchmark: str,
    limit: int = 20,
) -> list[RunRow]:
    """Return the most recent N runs for a benchmark, newest first."""
    if not db_path.exists():
        return []
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """SELECT * FROM runs WHERE benchmark = ?
               ORDER BY ts DESC, run_id DESC LIMIT ?""",
            (benchmark, limit),
        ).fetchall()
    finally:
        conn.close()

    return [_row_to_runrow(r) for r in rows]


def _row_to_runrow(r: sqlite3.Row) -> RunRow:
    return RunRow(
        run_id=r["run_id"],
        ts=r["ts"],
        benchmark=r["benchmark"],
        git_sha=r["git_sha"],
        git_dirty=bool(r["git_dirty"]) if r["git_dirty"] is not None else False,
        agent_model=r["agent_model"],
        agent_depth=r["agent_depth"],
        agent_max_sources=r["agent_max_sources"],
        judge_model=r["judge_model"],
        judge_mode=r["judge_mode"],
        n_tasks=r["n_tasks"] or 0,
        mean_score=r["mean_score"] or 0.0,
        mean_pass_rate=r["mean_pass_rate"] or 0.0,
        median_score=r["median_score"] or 0.0,
        stdev_score=r["stdev_score"] or 0.0,
        wall_seconds=r["wall_seconds"],
        cost_usd=r["cost_usd"],
        notes=r["notes"],
    )


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def aggregate_scores(
    verdicts_by_task: dict[str, list[Verdict]],
    criteria_by_task: dict[str, list[Criterion]],
    benchmark: str,
) -> AggregatedScores:
    """Score each task and compute run-level summary stats."""
    task_scores: list[TaskScore] = []
    task_rows: list[TaskScoreRow] = []

    for task_id, verdicts in verdicts_by_task.items():
        criteria = criteria_by_task.get(task_id)
        if not criteria:
            continue
        ts = score_task(verdicts, criteria, benchmark, task_id)
        task_scores.append(ts)
        task_rows.append(
            TaskScoreRow(
                run_id="",  # set later by caller
                task_id=task_id,
                score=ts.score,
                pass_rate=ts.pass_rate,
                section_scores=dict(ts.section_scores),
                criteria_count=ts.criteria_count,
                criteria_met=ts.criteria_met,
            )
        )

    scores = [t.score for t in task_scores]
    pass_rates = [t.pass_rate for t in task_scores]
    n = len(scores)

    if n == 0:
        return AggregatedScores(
            n_tasks=0,
            mean_score=0.0,
            mean_pass_rate=0.0,
            median_score=0.0,
            stdev_score=0.0,
            task_rows=[],
        )

    return AggregatedScores(
        n_tasks=n,
        mean_score=statistics.mean(scores),
        mean_pass_rate=statistics.mean(pass_rates),
        median_score=statistics.median(scores),
        stdev_score=statistics.stdev(scores) if n > 1 else 0.0,
        task_rows=task_rows,
    )


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------


def git_head_sha(repo_dir: Path | None = None) -> str | None:
    """Return `git rev-parse HEAD` for the given repo dir, or None on failure."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_dir) if repo_dir else None,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return out.decode().strip()


def git_is_dirty(repo_dir: Path | None = None) -> bool:
    """Return True if `git status --porcelain` is non-empty."""
    try:
        out = subprocess.check_output(
            ["git", "status", "--porcelain"],
            cwd=str(repo_dir) if repo_dir else None,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False
    return len(out.decode().strip()) > 0


# ---------------------------------------------------------------------------
# Finalize — read verdicts on disk, aggregate, persist
# ---------------------------------------------------------------------------


def finalize_run(
    db_path: Path,
    results_dir: Path,
    benchmark: str,
    judge_model: str,
    criteria_by_task: dict[str, list[Criterion]],
    git_sha: str | None,
    git_dirty: bool,
    agent_model: str | None = None,
    agent_depth: str | None = None,
    agent_max_sources: int | None = None,
    judge_mode: str | None = None,
    wall_seconds: int | None = None,
    cost_usd: float | None = None,
    notes: str | None = None,
    run_id: str | None = None,
) -> str:
    """Read verdicts from results_dir/{benchmark}/{judge_model}/*.jsonl, score them,
    and insert one runs row + N task_scores rows. Returns the new run_id.
    """
    verdicts_dir = results_dir / benchmark / judge_model
    verdicts_by_task: dict[str, list[Verdict]] = {}
    for task_id, criteria in criteria_by_task.items():
        path = verdicts_dir / f"{task_id}.jsonl"
        if not path.exists():
            continue
        verdicts = load_existing_verdicts(path)
        if verdicts:
            verdicts_by_task[task_id] = verdicts

    agg = aggregate_scores(
        verdicts_by_task=verdicts_by_task,
        criteria_by_task=criteria_by_task,
        benchmark=benchmark,
    )

    rid = run_id or uuid.uuid4().hex[:12]
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")

    run = RunRow(
        run_id=rid,
        ts=ts,
        benchmark=benchmark,
        git_sha=git_sha,
        git_dirty=git_dirty,
        agent_model=agent_model,
        agent_depth=agent_depth,
        agent_max_sources=agent_max_sources,
        judge_model=judge_model,
        judge_mode=judge_mode,
        n_tasks=agg.n_tasks,
        mean_score=agg.mean_score,
        mean_pass_rate=agg.mean_pass_rate,
        median_score=agg.median_score,
        stdev_score=agg.stdev_score,
        wall_seconds=wall_seconds,
        cost_usd=cost_usd,
        notes=notes,
    )

    task_rows = [
        TaskScoreRow(
            run_id=rid,
            task_id=tr.task_id,
            score=tr.score,
            pass_rate=tr.pass_rate,
            section_scores=tr.section_scores,
            criteria_count=tr.criteria_count,
            criteria_met=tr.criteria_met,
        )
        for tr in agg.task_rows
    ]

    insert_run(db_path, run, task_rows)
    return rid


# ---------------------------------------------------------------------------
# Markdown render
# ---------------------------------------------------------------------------


def render_markdown(
    db_path: Path,
    benchmark: str | None = None,
    limit: int = 20,
) -> str:
    """Render a markdown scoreboard sorted by ts descending.

    Shows mean_score and a Δ-vs-previous-run column for the same benchmark.
    When benchmark is None, renders one section per benchmark present in the DB.
    """
    if not db_path.exists():
        return "# Scoreboard\n\n_(no runs yet)_\n"

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        if benchmark is None:
            benchmarks = [
                r[0] for r in conn.execute(
                    "SELECT DISTINCT benchmark FROM runs ORDER BY benchmark"
                ).fetchall()
            ]
        else:
            benchmarks = [benchmark]
    finally:
        conn.close()

    if not benchmarks:
        return "# Scoreboard\n\n_(no runs yet)_\n"

    lines: list[str] = ["# Scoreboard", ""]
    for bm in benchmarks:
        rows = latest_runs(db_path, benchmark=bm, limit=limit)
        lines.append(f"## {bm}")
        lines.append("")
        if not rows:
            lines.append("_(no runs)_")
            lines.append("")
            continue
        lines.append(_render_section(rows))
        lines.append("")
    return "\n".join(lines)


def _render_section(rows: list[RunRow]) -> str:
    """Render a table for one benchmark's runs. Rows are newest-first.

    Δ column compares each row to the next row in the list (i.e. the previous
    run by timestamp). The oldest row in the slice has no delta.
    """
    header = (
        "| run_id | ts | sha | dirty | agent | depth | n | mean | Δ | "
        "median | stdev | judge | mode | wall | cost |"
    )
    sep = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    out = [header, sep]
    for i, row in enumerate(rows):
        prev_score = rows[i + 1].mean_score if i + 1 < len(rows) else None
        if prev_score is None:
            delta = "—"
        else:
            d = row.mean_score - prev_score
            sign = "+" if d > 0 else ""
            delta = f"{sign}{d:.3f}"
        sha = (row.git_sha or "—")[:7]
        out.append(
            "| "
            + " | ".join(
                [
                    row.run_id,
                    row.ts.replace("T", " ").replace("+00:00", "Z"),
                    sha,
                    "yes" if row.git_dirty else "no",
                    row.agent_model or "—",
                    row.agent_depth or "—",
                    str(row.n_tasks),
                    f"{row.mean_score:.3f}",
                    delta,
                    f"{row.median_score:.3f}",
                    f"{row.stdev_score:.3f}",
                    row.judge_model or "—",
                    row.judge_mode or "—",
                    f"{row.wall_seconds}s" if row.wall_seconds is not None else "—",
                    f"${row.cost_usd:.2f}" if row.cost_usd is not None else "—",
                ]
            )
            + " |"
        )
    return "\n".join(out)
