# ABOUTME: LLM-as-judge for binary criterion evaluation using the Anthropic SDK.
# ABOUTME: Unified judge works for both ResearchRubrics and DRACO benchmarks.

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import anthropic

from bench.score import Criterion, Verdict

SYSTEM_PROMPT = """You are an expert evaluator assessing whether a research document satisfies a specific criterion. Your evaluation must be precise, objective, and based solely on evidence present in the document.

Evaluate using a binary scale:
- MET: The document satisfies the criterion. Required elements are present and adequately addressed.
- UNMET: The document fails to satisfy the criterion. Key elements are missing, incorrect, or inadequately addressed.

Rules:
- Base evaluation ONLY on what is explicitly present in the document.
- Do not assume implied or missing content.
- Provide specific evidence from the document to support your verdict.
- Example lists in criteria illustrate possible answers but are not exhaustive.
- For numerical values: check if they fall within specified ranges or match exactly.
- For factual claims: verify the information is present, regardless of exact phrasing.
- Accept semantically equivalent statements or logical entailments.
- Be strict about factual accuracy and flexible about wording.

Respond with ONLY valid JSON, no markdown fences:
{"verdict": "MET" or "UNMET", "confidence": 0.0-1.0, "reasoning": "brief explanation"}"""


USER_PROMPT_TEMPLATE = """## Research Report
{report}

## Criterion to Evaluate
**Section**: {section}
**Weight**: {weight}
**Criterion**: {criterion}

Evaluate whether the report satisfies this criterion."""


def build_user_prompt(report: str, criterion: Criterion) -> str:
    """Build the user prompt for a single criterion evaluation."""
    return USER_PROMPT_TEMPLATE.format(
        report=report,
        section=criterion.section,
        weight=criterion.weight,
        criterion=criterion.text,
    )


def parse_verdict_response(
    raw: str, task_id: str, criterion_id: str
) -> Verdict:
    """Parse judge LLM response into a Verdict, with fallback for malformed output."""
    # Strip markdown code fences if present
    cleaned = raw.strip()
    md_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", cleaned, re.DOTALL)
    if md_match:
        cleaned = md_match.group(1).strip()

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        return Verdict(
            task_id=task_id,
            criterion_id=criterion_id,
            met=False,
            confidence=0.0,
            reasoning=f"Failed to parse judge response: {raw[:200]}",
            tokens_used=0,
            model="",
            duration_seconds=0.0,
        )

    verdict_str = data.get("verdict", "").upper()
    if verdict_str not in ("MET", "UNMET"):
        return Verdict(
            task_id=task_id,
            criterion_id=criterion_id,
            met=False,
            confidence=0.0,
            reasoning=f"Missing or invalid verdict field: {data}",
            tokens_used=0,
            model="",
            duration_seconds=0.0,
        )

    return Verdict(
        task_id=task_id,
        criterion_id=criterion_id,
        met=verdict_str == "MET",
        confidence=float(data.get("confidence", 0.0)),
        reasoning=data.get("reasoning", ""),
        tokens_used=0,
        model="",
        duration_seconds=0.0,
    )


def load_existing_verdicts(jsonl_path: Path) -> list[Verdict]:
    """Load previously computed verdicts from a JSONL file."""
    if not jsonl_path.exists():
        return []
    verdicts = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            data = json.loads(line)
            verdicts.append(Verdict(**data))
    return verdicts


def save_verdict(verdict: Verdict, jsonl_path: Path) -> None:
    """Append a single verdict to a JSONL file."""
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    with open(jsonl_path, "a") as f:
        f.write(json.dumps(asdict(verdict)) + "\n")


class Judge:
    """LLM-as-judge using the Anthropic SDK."""

    def __init__(
        self,
        model: str = "claude-sonnet-4-6",
        max_concurrent: int = 20,
        max_retries: int = 3,
    ):
        self.model = model
        self.max_retries = max_retries
        self._client = anthropic.AsyncAnthropic()
        self._sem = asyncio.Semaphore(max_concurrent)

    @staticmethod
    def remaining_criteria(
        all_criteria: list[Criterion], existing_verdicts: list[Verdict]
    ) -> list[Criterion]:
        """Return criteria not yet judged."""
        judged_ids = {v.criterion_id for v in existing_verdicts}
        return [c for c in all_criteria if c.id not in judged_ids]

    async def judge_criterion(
        self,
        report: str,
        criterion: Criterion,
        task_id: str,
    ) -> Verdict:
        """Judge a single criterion against a report."""
        user_prompt = build_user_prompt(report, criterion)
        start = time.monotonic()

        for attempt in range(self.max_retries):
            try:
                async with self._sem:
                    response = await self._client.messages.create(
                        model=self.model,
                        max_tokens=512,
                        system=SYSTEM_PROMPT,
                        messages=[{"role": "user", "content": user_prompt}],
                    )
                elapsed = time.monotonic() - start
                raw = response.content[0].text
                verdict = parse_verdict_response(raw, task_id, criterion.id)
                # Fill in metadata from the actual call
                return Verdict(
                    task_id=verdict.task_id,
                    criterion_id=verdict.criterion_id,
                    met=verdict.met,
                    confidence=verdict.confidence,
                    reasoning=verdict.reasoning,
                    tokens_used=response.usage.input_tokens
                    + response.usage.output_tokens,
                    model=self.model,
                    duration_seconds=round(elapsed, 2),
                )
            except anthropic.RateLimitError:
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(2**attempt)
                    continue
                raise
            except anthropic.APIError as e:
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(2**attempt)
                    continue
                return Verdict(
                    task_id=task_id,
                    criterion_id=criterion.id,
                    met=False,
                    confidence=0.0,
                    reasoning=f"API error after {self.max_retries} retries: {e}",
                    tokens_used=0,
                    model=self.model,
                    duration_seconds=round(time.monotonic() - start, 2),
                )
        # Should not reach here, but satisfy type checker
        raise RuntimeError("Exhausted retries without returning")

    async def judge_task(
        self,
        report_path: Path,
        criteria: list[Criterion],
        task_id: str,
        results_dir: Path,
    ) -> list[Verdict]:
        """Judge all criteria for a single task with resume support."""
        report = report_path.read_text()
        verdicts_path = results_dir / f"{task_id}.jsonl"

        existing = load_existing_verdicts(verdicts_path)
        remaining = self.remaining_criteria(criteria, existing)

        if not remaining:
            return existing

        async def _judge_and_save(criterion: Criterion) -> Verdict:
            verdict = await self.judge_criterion(report, criterion, task_id)
            save_verdict(verdict, verdicts_path)
            return verdict

        new_verdicts = await asyncio.gather(
            *[_judge_and_save(c) for c in remaining]
        )
        return existing + list(new_verdicts)

    async def judge_benchmark(
        self,
        tasks: list[tuple[str, Path, list[Criterion]]],
        results_dir: Path,
    ) -> dict[str, list[Verdict]]:
        """Judge all tasks in a benchmark.

        tasks: list of (task_id, report_path, criteria) tuples.
        Only tasks with existing report files should be included.
        """
        results_dir.mkdir(parents=True, exist_ok=True)
        all_verdicts: dict[str, list[Verdict]] = {}
        for task_id, report_path, criteria in tasks:
            verdicts = await self.judge_task(
                report_path, criteria, task_id, results_dir
            )
            all_verdicts[task_id] = verdicts
        return all_verdicts
