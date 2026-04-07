# ABOUTME: Generates human-readable markdown summary reports from scored benchmark results.
# ABOUTME: Includes aggregate stats, per-section breakdowns, and worst-performing tasks.

from __future__ import annotations

import statistics
from pathlib import Path

from bench.score import TaskScore


def generate_report(scores: list[TaskScore], benchmark: str) -> str:
    """Generate a markdown summary report from task scores."""
    if not scores:
        return f"# {benchmark} — No Results\n\nNo scored tasks found.\n"

    all_scores = [s.score for s in scores]
    all_pass_rates = [s.pass_rate for s in scores]

    lines = [
        f"# {benchmark} Evaluation Report",
        "",
        "## Summary",
        "",
        f"- **Tasks scored**: {len(scores)}",
        f"- **Total criteria**: {sum(s.criteria_count for s in scores)}",
        f"- **Total criteria met**: {sum(s.criteria_met for s in scores)}",
        "",
        "## Scores",
        "",
        f"| Metric | Mean | Median | Std Dev | Min | Max |",
        f"|--------|------|--------|---------|-----|-----|",
    ]

    def _row(name: str, values: list[float]) -> str:
        if not values:
            return f"| {name} | — | — | — | — | — |"
        mean = statistics.mean(values)
        median = statistics.median(values)
        stdev = statistics.stdev(values) if len(values) > 1 else 0.0
        return (
            f"| {name} "
            f"| {mean:.3f} "
            f"| {median:.3f} "
            f"| {stdev:.3f} "
            f"| {min(values):.3f} "
            f"| {max(values):.3f} |"
        )

    lines.append(_row("Score", all_scores))
    lines.append(_row("Pass Rate", all_pass_rates))
    lines.append("")

    # Per-section breakdown (DRACO)
    section_data: dict[str, list[float]] = {}
    for s in scores:
        for section, val in s.section_scores.items():
            section_data.setdefault(section, []).append(val)

    if section_data:
        lines.extend([
            "## Per-Section Scores",
            "",
            "| Section | Mean | Median | Min | Max |",
            "|---------|------|--------|-----|-----|",
        ])
        for section in sorted(section_data):
            vals = section_data[section]
            mean = statistics.mean(vals)
            median = statistics.median(vals)
            lines.append(
                f"| {section} "
                f"| {mean:.3f} "
                f"| {median:.3f} "
                f"| {min(vals):.3f} "
                f"| {max(vals):.3f} |"
            )
        lines.append("")

    # Per-domain breakdown
    domain_data: dict[str, list[float]] = {}
    for s in scores:
        # Domain is stored in metadata via score_task, but TaskScore doesn't carry it.
        # We'll group by task_id prefix or skip if no domain info available.
        pass

    # Worst-performing tasks
    sorted_scores = sorted(scores, key=lambda s: s.score)
    worst = sorted_scores[:5]
    lines.extend([
        "## Lowest-Scoring Tasks",
        "",
        "| Task ID | Score | Pass Rate | Criteria Met |",
        "|---------|-------|-----------|-------------|",
    ])
    for s in worst:
        lines.append(
            f"| {s.task_id[:24]} "
            f"| {s.score:.3f} "
            f"| {s.pass_rate:.3f} "
            f"| {s.criteria_met}/{s.criteria_count} |"
        )
    lines.append("")

    return "\n".join(lines)


def save_report(report: str, output_path: Path) -> None:
    """Write a report to disk."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(report)
