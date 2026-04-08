# ABOUTME: LLM-as-judge for binary criterion evaluation.
# ABOUTME: Supports Anthropic Claude and Google Gemini, aligned with ResearchRubrics methodology.

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import anthropic

from bench.score import Criterion, Verdict

# Aligned with ResearchRubrics paper: src/prompts/system_prompt.txt
SYSTEM_PROMPT = """You are an expert evaluator tasked with assessing whether a document satisfies specific rubric criteria. Your evaluation must be precise, objective, and based solely on the evidence present in the document.

## Evaluation Framework

You will evaluate each rubric criterion using a binary satisfaction scale:

1. **Not Satisfied (Score: 0.0)**: The document fails to meet the criterion. Key elements are missing, incorrect, or inadequately addressed.

2. **Satisfied (Score: 1.0)**: The document fully meets the criterion. All required elements are present, well-developed, and appropriately detailed.

## Evaluation Process

1. **Understand the Criterion**: Carefully read and interpret what the rubric is asking for.

2. **Search for Evidence**: Systematically review the document for relevant content that addresses the criterion.

3. **Assess Completeness**: Evaluate whether the evidence satisfies or fails to satisfy the criterion.

4. **Provide Reasoning**: Explain your evaluation with specific references to the document content.

## Important Guidelines

- Base your evaluation ONLY on what is explicitly present in the document
- Do not make assumptions about implied or missing content
- Consider the quality, completeness, and relevance of the evidence
- Be consistent in your evaluation standards across all criteria
- Provide specific examples from the document to support your verdict

Note: Example lists in these rubrics are intended to illustrate possible reasoning patterns or relevant topics. These example lists contain correct answers but are not exhaustive. Use them as guidance, but also make your own final judgment about what qualifies as correct when appropriate."""

# Aligned with ResearchRubrics paper: src/prompts/user_prompt.txt
USER_PROMPT_TEMPLATE = """## Document Content
{document_content}

## Rubric Criterion to Evaluate

**Title**: {rubric_title}
**Category**: {rubric_category}
**Weight**: {rubric_weight}

## Your Task

Evaluate whether the above document satisfies this specific rubric criterion.

## Required Response Format

Provide your evaluation in the following JSON format:

```json
{{
  "verdict": "[Not Satisfied/Satisfied]",
  "score": [0.0/1.0],
  "confidence": [0.0-1.0],
  "reasoning": "Detailed explanation with specific evidence from the document",
  "evidence_quotes": ["Direct quote 1", "Direct quote 2", ...],
  "missing_elements": ["Element 1 that would improve satisfaction", ...]
}}
```

Ensure your response is ONLY the JSON object, with no additional text."""


def build_user_prompt(report: str, criterion: Criterion) -> str:
    """Build the user prompt for a single criterion evaluation."""
    return USER_PROMPT_TEMPLATE.format(
        document_content=report,
        rubric_title=criterion.text,
        rubric_category=criterion.section,
        rubric_weight=criterion.weight,
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

    # Parse verdict: "Satisfied" → met=True, "Not Satisfied" → met=False
    verdict_str = data.get("verdict", "").strip()
    if verdict_str.lower() == "satisfied":
        met = True
    elif verdict_str.lower() == "not satisfied":
        met = False
    elif verdict_str.upper() == "MET":
        met = True
    elif verdict_str.upper() == "UNMET":
        met = False
    else:
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
        met=met,
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


def _is_gemini_model(model: str) -> bool:
    """Check if a model string refers to a Google Gemini model."""
    return model.startswith("gemini-")


class Judge:
    """LLM-as-judge supporting Anthropic Claude and Google Gemini models."""

    def __init__(
        self,
        model: str = "claude-haiku-4-5-20251001",
        max_concurrent: int = 20,
        max_retries: int = 3,
    ):
        self.model = model
        self.max_retries = max_retries
        self._sem = asyncio.Semaphore(max_concurrent)
        self._use_gemini = _is_gemini_model(model)

        if self._use_gemini:
            from google import genai
            api_key = os.environ.get("GEMINI_API_KEY")
            if not api_key:
                raise ValueError(
                    "GEMINI_API_KEY environment variable is required for Gemini judge models"
                )
            self._gemini_client = genai.Client(api_key=api_key)
        else:
            self._anthropic_client = anthropic.AsyncAnthropic()

    @staticmethod
    def remaining_criteria(
        all_criteria: list[Criterion], existing_verdicts: list[Verdict]
    ) -> list[Criterion]:
        """Return criteria not yet judged."""
        judged_ids = {v.criterion_id for v in existing_verdicts}
        return [c for c in all_criteria if c.id not in judged_ids]

    async def _judge_anthropic(
        self, user_prompt: str, task_id: str, criterion_id: str
    ) -> tuple[str, int]:
        """Call Anthropic Claude and return (raw_text, tokens_used)."""
        response = await self._anthropic_client.messages.create(
            model=self.model,
            max_tokens=50000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
        )
        raw = response.content[0].text
        tokens = response.usage.input_tokens + response.usage.output_tokens
        return raw, tokens

    async def _judge_gemini(
        self, user_prompt: str, task_id: str, criterion_id: str
    ) -> tuple[str, int]:
        """Call Google Gemini and return (raw_text, tokens_used).

        Matches the ResearchRubrics paper setup: no thinking mode,
        JSON response format, 50k max output tokens, separate system instruction.
        """
        from google.genai import types

        # Gemini SDK is synchronous — run in thread pool to not block the event loop
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: self._gemini_client.models.generate_content(
                model=self.model,
                contents=[
                    types.Content(
                        role="user",
                        parts=[types.Part.from_text(text=user_prompt)],
                    ),
                ],
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    max_output_tokens=50000,
                    response_mime_type="application/json",
                ),
            ),
        )

        raw = response.text or ""
        tokens = 0
        if response.usage_metadata:
            tokens = (
                (response.usage_metadata.prompt_token_count or 0)
                + (response.usage_metadata.candidates_token_count or 0)
            )
        return raw, tokens

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
                    if self._use_gemini:
                        raw, tokens = await self._judge_gemini(
                            user_prompt, task_id, criterion.id
                        )
                    else:
                        raw, tokens = await self._judge_anthropic(
                            user_prompt, task_id, criterion.id
                        )
                elapsed = time.monotonic() - start
                verdict = parse_verdict_response(raw, task_id, criterion.id)
                return Verdict(
                    task_id=verdict.task_id,
                    criterion_id=verdict.criterion_id,
                    met=verdict.met,
                    confidence=verdict.confidence,
                    reasoning=verdict.reasoning,
                    tokens_used=tokens,
                    model=self.model,
                    duration_seconds=round(elapsed, 2),
                )
            except anthropic.RateLimitError:
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(2**attempt)
                    continue
                raise
            except (anthropic.APIError, Exception) as e:
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
        """Judge all tasks in a benchmark."""
        results_dir.mkdir(parents=True, exist_ok=True)
        all_verdicts: dict[str, list[Verdict]] = {}
        for task_id, report_path, criteria in tasks:
            verdicts = await self.judge_task(
                report_path, criteria, task_id, results_dir
            )
            all_verdicts[task_id] = verdicts
        return all_verdicts
