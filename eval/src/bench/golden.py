# ABOUTME: Deterministic mode-balanced golden-set scoring and confidence calibration.
# ABOUTME: Complements LLM-judge benchmarks with answer-key checks across task modes.

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path


CONFIDENCE_VALUE = {
    "low": 0.33,
    "medium": 0.66,
    "high": 0.9,
}


@dataclass(frozen=True)
class GoldenTask:
    task_id: str
    mode: str
    prompt: str
    expected_answers: list[str]
    expected_confidence: str


@dataclass(frozen=True)
class GoldenScore:
    task_id: str
    mode: str
    score: float
    matched: int
    expected: int
    reported_confidence: str
    confidence_probability: float
    brier: float


def load_golden_tasks(path: Path) -> list[GoldenTask]:
    tasks: list[GoldenTask] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            tasks.append(
                GoldenTask(
                    task_id=row["task_id"],
                    mode=row["mode"],
                    prompt=row["prompt"],
                    expected_answers=list(row["expected_answers"]),
                    expected_confidence=row.get("expected_confidence", "medium"),
                )
            )
    return tasks


def score_report(task: GoldenTask, report: str) -> GoldenScore:
    normalized = report.casefold()
    matched = sum(1 for answer in task.expected_answers if answer.casefold() in normalized)
    expected = len(task.expected_answers)
    score = matched / expected if expected else 0.0
    reported_confidence = extract_reported_confidence(report) or task.expected_confidence
    probability = CONFIDENCE_VALUE.get(reported_confidence, CONFIDENCE_VALUE["medium"])
    # Binary correctness target for calibration: fully correct vs not fully correct.
    actual = 1.0 if score >= 1.0 else 0.0
    brier = (probability - actual) ** 2
    return GoldenScore(
        task_id=task.task_id,
        mode=task.mode,
        score=score,
        matched=matched,
        expected=expected,
        reported_confidence=reported_confidence,
        confidence_probability=probability,
        brier=brier,
    )


def score_golden_dir(tasks: list[GoldenTask], responses_dir: Path) -> list[GoldenScore]:
    scores: list[GoldenScore] = []
    for task in tasks:
        report_path = responses_dir / "modegolden" / f"{task.task_id}.md"
        if not report_path.exists():
            continue
        scores.append(score_report(task, report_path.read_text()))
    return scores


def aggregate_by_mode(scores: list[GoldenScore]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for mode in sorted({score.mode for score in scores}):
        rows = [score for score in scores if score.mode == mode]
        if not rows:
            continue
        out[mode] = {
            "tasks": float(len(rows)),
            "mean_score": sum(row.score for row in rows) / len(rows),
            "mean_brier": sum(row.brier for row in rows) / len(rows),
        }
    return out


def extract_reported_confidence(report: str) -> str | None:
    match = re.search(r"\bconfidence\s*[:=]\s*(high|medium|low)\b", report, re.I)
    if match:
        return match.group(1).lower()
    for value in ("high", "medium", "low"):
        if re.search(rf"\b{value}\s+confidence\b", report, re.I):
            return value
    return None


def format_golden_report(scores: list[GoldenScore]) -> str:
    if not scores:
        return "# Mode Golden Evaluation\n\nNo scored reports found.\n"
    overall_score = sum(score.score for score in scores) / len(scores)
    overall_brier = sum(score.brier for score in scores) / len(scores)
    lines = [
        "# Mode Golden Evaluation",
        "",
        "## Summary",
        "",
        f"- **Tasks scored**: {len(scores)}",
        f"- **Mean deterministic score**: {overall_score:.3f}",
        f"- **Mean Brier calibration**: {overall_brier:.3f}",
        "",
        "## By Mode",
        "",
        "| Mode | Tasks | Mean Score | Mean Brier |",
        "|------|-------|------------|------------|",
    ]
    for mode, row in aggregate_by_mode(scores).items():
        lines.append(
            f"| {mode} | {int(row['tasks'])} | {row['mean_score']:.3f} | {row['mean_brier']:.3f} |"
        )
    lines.extend([
        "",
        "## Tasks",
        "",
        "| Task | Mode | Score | Matched | Confidence | Brier |",
        "|------|------|-------|---------|------------|-------|",
    ])
    for score in scores:
        lines.append(
            f"| {score.task_id} | {score.mode} | {score.score:.3f} | {score.matched}/{score.expected} | {score.reported_confidence} | {score.brier:.3f} |"
        )
    lines.append("")
    return "\n".join(lines)
