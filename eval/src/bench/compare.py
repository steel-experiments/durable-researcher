# ABOUTME: Cross-run comparison logic — load per-task scores from multiple results dirs,
# ABOUTME: compute intersection / deltas / per-section means / win-loss tallies, render markdown.

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from pathlib import Path

from bench.data import load_benchmark
from bench.judge import load_existing_verdicts
from bench.score import TaskScore, score_task

TIE_EPSILON = 1e-6


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------


@dataclass
class PerTaskRow:
    """One row of the per-task comparison table."""

    task_id: str
    baseline_score: float
    candidate_scores: list[float]
    deltas: list[float]


@dataclass
class PerSectionRow:
    """One row of the per-section means table.

    candidate_means / deltas use None for sections absent from that candidate.
    """

    section: str
    baseline_mean: float
    candidate_means: list[float | None]
    deltas: list[float | None]


@dataclass
class CandidateStats:
    """Win/loss/tie tallies for a single candidate vs baseline."""

    label: str
    wins: int = 0
    losses: int = 0
    ties: int = 0
    mean_win_delta: float = 0.0
    mean_loss_delta: float = 0.0


@dataclass
class RunComparison:
    """Aggregated comparison data ready for rendering."""

    baseline_label: str
    candidate_labels: list[str]
    intersection_task_ids: list[str]
    per_task: list[PerTaskRow]
    per_section: list[PerSectionRow]
    candidate_stats: list[CandidateStats]
    baseline_overall_mean: float
    candidate_overall_means: list[float]


# ---------------------------------------------------------------------------
# Loading scores from a results directory
# ---------------------------------------------------------------------------


def load_run_scores(
    results_dir: Path,
    benchmark: str,
    judge_model: str,
    data_path: Path,
) -> dict[str, TaskScore]:
    """Load per-task scores from a results dir.

    Looks under {results_dir}/{benchmark}/{judge_model}/*.jsonl and scores
    each task using bench.score.score_task with the benchmark's criteria.
    Returns a {task_id: TaskScore} map. Tasks without verdicts are omitted.
    """
    verdicts_dir = results_dir / benchmark / judge_model
    if not verdicts_dir.is_dir():
        return {}

    tasks = load_benchmark(benchmark, data_path)
    out: dict[str, TaskScore] = {}
    for task in tasks:
        verdicts_path = verdicts_dir / f"{task.task_id}.jsonl"
        if not verdicts_path.exists():
            continue
        verdicts = load_existing_verdicts(verdicts_path)
        if not verdicts:
            continue
        out[task.task_id] = score_task(verdicts, task.criteria, benchmark, task.task_id)
    return out


# ---------------------------------------------------------------------------
# Comparison computation
# ---------------------------------------------------------------------------


def _classify(delta: float) -> str:
    if delta > TIE_EPSILON:
        return "win"
    if delta < -TIE_EPSILON:
        return "loss"
    return "tie"


def compute_comparison(
    baseline: dict[str, TaskScore],
    candidates: list[dict[str, TaskScore]],
    candidate_labels: list[str],
    baseline_label: str = "baseline",
) -> RunComparison:
    """Compute per-task / per-section / win-loss data for baseline vs N candidates.

    Tasks are intersected: only task_ids present in baseline AND every candidate
    contribute. Sections are taken from baseline; candidates missing a section
    appear as None in candidate_means / deltas.
    """
    if len(candidates) != len(candidate_labels):
        raise ValueError("candidates and candidate_labels must be the same length")

    # Intersect task IDs
    common: set[str] = set(baseline.keys())
    for cand in candidates:
        common &= set(cand.keys())
    intersection = sorted(common)

    # Per-task rows
    per_task: list[PerTaskRow] = []
    for tid in intersection:
        b_score = baseline[tid].score
        c_scores = [c[tid].score for c in candidates]
        deltas = [cs - b_score for cs in c_scores]
        per_task.append(
            PerTaskRow(
                task_id=tid,
                baseline_score=b_score,
                candidate_scores=c_scores,
                deltas=deltas,
            )
        )

    # Per-section means
    # Collect baseline section values across the intersection
    baseline_section_values: dict[str, list[float]] = {}
    for tid in intersection:
        for section, val in baseline[tid].section_scores.items():
            baseline_section_values.setdefault(section, []).append(val)

    # Collect per-candidate section values
    candidate_section_values: list[dict[str, list[float]]] = []
    for cand in candidates:
        per_cand: dict[str, list[float]] = {}
        for tid in intersection:
            for section, val in cand[tid].section_scores.items():
                per_cand.setdefault(section, []).append(val)
        candidate_section_values.append(per_cand)

    per_section: list[PerSectionRow] = []
    for section in sorted(baseline_section_values.keys()):
        baseline_vals = baseline_section_values[section]
        baseline_mean = statistics.mean(baseline_vals) if baseline_vals else 0.0
        c_means: list[float | None] = []
        c_deltas: list[float | None] = []
        for per_cand in candidate_section_values:
            vals = per_cand.get(section, [])
            if vals:
                cm = statistics.mean(vals)
                c_means.append(cm)
                c_deltas.append(cm - baseline_mean)
            else:
                c_means.append(None)
                c_deltas.append(None)
        per_section.append(
            PerSectionRow(
                section=section,
                baseline_mean=baseline_mean,
                candidate_means=c_means,
                deltas=c_deltas,
            )
        )

    # Win / loss / tie per candidate
    candidate_stats: list[CandidateStats] = []
    for ci, label in enumerate(candidate_labels):
        wins = 0
        losses = 0
        ties = 0
        win_deltas: list[float] = []
        loss_deltas: list[float] = []
        for row in per_task:
            d = row.deltas[ci]
            cls = _classify(d)
            if cls == "win":
                wins += 1
                win_deltas.append(d)
            elif cls == "loss":
                losses += 1
                loss_deltas.append(d)
            else:
                ties += 1
        candidate_stats.append(
            CandidateStats(
                label=label,
                wins=wins,
                losses=losses,
                ties=ties,
                mean_win_delta=statistics.mean(win_deltas) if win_deltas else 0.0,
                mean_loss_delta=statistics.mean(loss_deltas) if loss_deltas else 0.0,
            )
        )

    # Overall means across the intersection
    baseline_overall = (
        statistics.mean(row.baseline_score for row in per_task) if per_task else 0.0
    )
    candidate_overall = []
    for ci in range(len(candidates)):
        if per_task:
            candidate_overall.append(
                statistics.mean(row.candidate_scores[ci] for row in per_task)
            )
        else:
            candidate_overall.append(0.0)

    return RunComparison(
        baseline_label=baseline_label,
        candidate_labels=list(candidate_labels),
        intersection_task_ids=intersection,
        per_task=per_task,
        per_section=per_section,
        candidate_stats=candidate_stats,
        baseline_overall_mean=baseline_overall,
        candidate_overall_means=candidate_overall,
    )


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------


def _fmt(v: float | None, places: int = 3) -> str:
    if v is None:
        return "—"
    return f"{v:.{places}f}"


def _fmt_delta(v: float | None, places: int = 3) -> str:
    if v is None:
        return "—"
    sign = "+" if v > 0 else ("" if v == 0 else "")
    return f"{sign}{v:.{places}f}"


def format_comparison_report(
    comparison: RunComparison,
    benchmark: str,
    judge_model: str,
    baseline_label: str,
    candidate_labels: list[str],
) -> str:
    """Render a RunComparison as a markdown document."""
    lines: list[str] = [
        f"# {benchmark} Comparison Report",
        "",
        f"- **Judge model**: `{judge_model}`",
        f"- **Baseline**: `{baseline_label}`",
        f"- **Candidates**: {', '.join(f'`{c}`' for c in candidate_labels)}",
        f"- **Tasks in intersection**: {len(comparison.intersection_task_ids)}",
        "",
    ]

    if not comparison.per_task:
        lines.append("> No tasks present in baseline AND every candidate.")
        lines.append("")
        return "\n".join(lines)

    # Per-task table
    lines.extend(_render_per_task_table(comparison, baseline_label, candidate_labels))
    lines.append("")

    # Per-section table (only if there are sections)
    if comparison.per_section:
        lines.extend(
            _render_per_section_table(comparison, baseline_label, candidate_labels)
        )
        lines.append("")

    # Overall mean row
    lines.extend(_render_overall_means(comparison, baseline_label, candidate_labels))
    lines.append("")

    # Win/loss/tie summary
    lines.extend(_render_win_loss_summary(comparison))
    lines.append("")

    return "\n".join(lines)


def _render_per_task_table(
    comparison: RunComparison,
    baseline_label: str,
    candidate_labels: list[str],
) -> list[str]:
    header_cells = ["task_id", baseline_label]
    for label in candidate_labels:
        header_cells.append(label)
        header_cells.append(f"Δ {label}")
    sep = ["---"] * len(header_cells)

    lines = [
        "## Per-Task Scores",
        "",
        "| " + " | ".join(header_cells) + " |",
        "| " + " | ".join(sep) + " |",
    ]

    for row in comparison.per_task:
        cells = [row.task_id[:24], _fmt(row.baseline_score)]
        for cs, d in zip(row.candidate_scores, row.deltas):
            cells.append(_fmt(cs))
            cells.append(_fmt_delta(d))
        lines.append("| " + " | ".join(cells) + " |")
    return lines


def _render_per_section_table(
    comparison: RunComparison,
    baseline_label: str,
    candidate_labels: list[str],
) -> list[str]:
    header_cells = ["section", baseline_label]
    for label in candidate_labels:
        header_cells.append(label)
        header_cells.append(f"Δ {label}")
    sep = ["---"] * len(header_cells)

    lines = [
        "## Per-Section Means (across intersection)",
        "",
        "| " + " | ".join(header_cells) + " |",
        "| " + " | ".join(sep) + " |",
    ]

    for row in comparison.per_section:
        cells = [row.section, _fmt(row.baseline_mean)]
        for cm, d in zip(row.candidate_means, row.deltas):
            cells.append(_fmt(cm))
            cells.append(_fmt_delta(d))
        lines.append("| " + " | ".join(cells) + " |")
    return lines


def _render_overall_means(
    comparison: RunComparison,
    baseline_label: str,
    candidate_labels: list[str],
) -> list[str]:
    header_cells = ["scope", baseline_label]
    for label in candidate_labels:
        header_cells.append(label)
        header_cells.append(f"Δ {label}")
    sep = ["---"] * len(header_cells)

    cells = ["overall", _fmt(comparison.baseline_overall_mean)]
    for cm in comparison.candidate_overall_means:
        cells.append(_fmt(cm))
        cells.append(_fmt_delta(cm - comparison.baseline_overall_mean))

    return [
        "## Overall Means",
        "",
        "| " + " | ".join(header_cells) + " |",
        "| " + " | ".join(sep) + " |",
        "| " + " | ".join(cells) + " |",
    ]


def _render_win_loss_summary(comparison: RunComparison) -> list[str]:
    lines = [
        "## Win / Loss / Tie",
        "",
        "| candidate | wins | losses | ties | mean Δ (wins) | mean Δ (losses) |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for stats in comparison.candidate_stats:
        lines.append(
            f"| {stats.label} | {stats.wins} | {stats.losses} | {stats.ties} | "
            f"{_fmt_delta(stats.mean_win_delta)} | {_fmt_delta(stats.mean_loss_delta)} |"
        )
    return lines


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------


def save_comparison_report(markdown: str, output_path: Path) -> None:
    """Write a comparison report to disk."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(markdown)


# ---------------------------------------------------------------------------
# Scoreboard helpers
# ---------------------------------------------------------------------------


@dataclass
class RunInfo:
    """Summary metadata for one results dir."""

    name: str
    path: Path
    judge_model: str
    benchmark: str
    task_count: int = 0
    mean_score: float | None = None
    mtime: float = 0.0


def discover_runs(
    search_root: Path,
    benchmark: str,
    judge_model: str,
) -> list[RunInfo]:
    """Find all `results*` dirs under search_root with verdicts for benchmark/judge_model.

    Each result dir contains {benchmark}/{judge_model}/*.jsonl. Returns RunInfo
    entries (no score computation — call `score_run_info` for that).
    """
    if not search_root.is_dir():
        return []

    runs: list[RunInfo] = []
    for child in sorted(search_root.iterdir()):
        if not child.is_dir():
            continue
        # Accept anything starting with "results"; this captures results, results-*, etc.
        if not child.name.startswith("results"):
            continue
        verdicts_dir = child / benchmark / judge_model
        if not verdicts_dir.is_dir():
            continue
        jsonl_files = list(verdicts_dir.glob("*.jsonl"))
        if not jsonl_files:
            continue
        runs.append(
            RunInfo(
                name=child.name,
                path=child,
                judge_model=judge_model,
                benchmark=benchmark,
                task_count=len(jsonl_files),
                mtime=verdicts_dir.stat().st_mtime,
            )
        )
    return runs


def score_run_info(run: RunInfo, data_path: Path) -> RunInfo:
    """Populate `mean_score` on a RunInfo by loading its scores."""
    scores = load_run_scores(
        results_dir=run.path,
        benchmark=run.benchmark,
        judge_model=run.judge_model,
        data_path=data_path,
    )
    if scores:
        run.mean_score = statistics.mean(s.score for s in scores.values())
        run.task_count = len(scores)
    return run
