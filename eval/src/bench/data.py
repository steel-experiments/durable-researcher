# ABOUTME: Downloads benchmark datasets from HuggingFace and loads them into
# ABOUTME: unified BenchmarkTask/Criterion dataclasses for ResearchRubrics, DRACO,
# ABOUTME: and the local mode-balanced golden set.

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from bench.score import Criterion


@dataclass
class BenchmarkTask:
    """A single benchmark prompt with its evaluation criteria."""

    benchmark: str
    task_id: str
    prompt: str
    criteria: list[Criterion]
    metadata: dict[str, str] = field(default_factory=dict)


def download_researchrubrics(data_dir: Path) -> Path:
    """Download processed_data.jsonl from HuggingFace ScaleAI/researchrubrics."""
    from huggingface_hub import hf_hub_download

    return Path(
        hf_hub_download(
            repo_id="ScaleAI/researchrubrics",
            filename="processed_data.jsonl",
            repo_type="dataset",
            local_dir=str(data_dir / "researchrubrics"),
        )
    )


def download_draco(data_dir: Path) -> Path:
    """Download test.jsonl from HuggingFace perplexity-ai/draco."""
    from huggingface_hub import hf_hub_download

    return Path(
        hf_hub_download(
            repo_id="perplexity-ai/draco",
            filename="test.jsonl",
            repo_type="dataset",
            local_dir=str(data_dir / "draco"),
        )
    )


def load_researchrubrics(jsonl_path: Path) -> list[BenchmarkTask]:
    """Parse ResearchRubrics JSONL into BenchmarkTask list."""
    tasks = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            criteria = []
            for i, rubric in enumerate(entry["rubrics"]):
                criteria.append(
                    Criterion(
                        id=f"{entry['sample_id']}:{i}",
                        text=rubric["criterion"],
                        weight=rubric["weight"],
                        section=rubric["axis"],
                    )
                )
            tasks.append(
                BenchmarkTask(
                    benchmark="researchrubrics",
                    task_id=entry["sample_id"],
                    prompt=entry["prompt"],
                    criteria=criteria,
                    metadata={
                        "domain": entry.get("domain", ""),
                        "conceptual_breadth": entry.get("conceptual_breadth", ""),
                        "logical_nesting": entry.get("logical_nesting", ""),
                        "exploration": entry.get("exploration", ""),
                    },
                )
            )
    return tasks


def load_draco(jsonl_path: Path) -> list[BenchmarkTask]:
    """Parse DRACO JSONL into BenchmarkTask list."""
    tasks = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            answer = json.loads(entry["answer"])
            criteria = []
            idx = 0
            for section in answer["sections"]:
                for criterion in section["criteria"]:
                    criteria.append(
                        Criterion(
                            id=f"{entry['id']}:{idx}",
                            text=criterion["requirement"],
                            weight=float(criterion["weight"]),
                            section=section["id"],
                        )
                    )
                    idx += 1
            tasks.append(
                BenchmarkTask(
                    benchmark="draco",
                    task_id=entry["id"],
                    prompt=entry["problem"],
                    criteria=criteria,
                    metadata={
                        "domain": entry.get("domain", ""),
                    },
                )
            )
    return tasks


def load_modegolden(jsonl_path: Path) -> list[BenchmarkTask]:
    """Parse local mode-balanced golden JSONL into BenchmarkTask list.

    The deterministic scorer in bench.golden owns the answer-key scoring. We
    still expose expected answers as positive criteria so the shared runner,
    reporting, and task metadata can treat the golden set like any other
    benchmark while calling the real agent loop.
    """
    tasks = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            task_id = entry["task_id"]
            expected_answers = list(entry["expected_answers"])
            criteria = [
                Criterion(
                    id=f"{task_id}:{i}",
                    text=f"Report includes deterministic answer key: {answer}",
                    weight=1.0,
                    section="deterministic-answer",
                )
                for i, answer in enumerate(expected_answers)
            ]
            tasks.append(
                BenchmarkTask(
                    benchmark="modegolden",
                    task_id=task_id,
                    prompt=entry["prompt"],
                    criteria=criteria,
                    metadata={
                        "mode": entry["mode"],
                        "expected_confidence": entry.get("expected_confidence", "medium"),
                    },
                )
            )
    return tasks


def load_benchmark(benchmark: str, data_path: Path) -> list[BenchmarkTask]:
    """Load a benchmark dataset from a JSONL file."""
    if benchmark == "researchrubrics":
        return load_researchrubrics(data_path)
    elif benchmark == "draco":
        return load_draco(data_path)
    elif benchmark == "modegolden":
        return load_modegolden(data_path)
    else:
        raise ValueError(f"Unknown benchmark: {benchmark}")
