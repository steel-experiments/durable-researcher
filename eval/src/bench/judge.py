# ABOUTME: LLM-as-judge for binary criterion evaluation.
# ABOUTME: Supports Anthropic Claude and Google Gemini with benchmark-specific prompts and configs.

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path

from rich.progress import Progress

import anthropic

from bench.score import Criterion, Verdict

# ---------------------------------------------------------------------------
# ResearchRubrics prompts — exact copy from scaleapi/researchrubrics repo
# src/prompts/system_prompt.txt and src/prompts/user_prompt.txt
# ---------------------------------------------------------------------------

RESEARCHRUBRICS_SYSTEM_PROMPT = """You are an expert evaluator tasked with assessing whether a document satisfies specific rubric criteria. Your evaluation must be precise, objective, and based solely on the evidence present in the document.

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

RESEARCHRUBRICS_USER_TEMPLATE = """## Document Content
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

# ---------------------------------------------------------------------------
# DRACO prompts — exact copy from Appendix F.5 of the DRACO paper
# (arXiv:2602.11685, perplexity-ai/draco)
# ---------------------------------------------------------------------------

DRACO_SYSTEM_PROMPT = """You are evaluating a response for a given query against a single criterion.

You will receive the response to evaluate, a single criterion to check, and a <criterion_type> field indicating if the criterion is positive or negative.

CRITERION TYPES:
The <criterion_type> field tells you whether this criterion describes something desirable (positive) or undesirable (negative). Your job is THE SAME for both types: determine if the thing described in the criterion is actually present in the response.

POSITIVE CRITERIA:
Positive criteria describe desired traits, requirements, or content that should be present.
- MET (criterion_status: "MET"): The response contains/satisfies the requirement
- UNMET (criterion_status: "UNMET"): The response does not contain/satisfy the requirement

NEGATIVE CRITERIA:
Negative criteria describe active errors or mistakes that the response is making.
- MET (criterion_status: "MET"): The response advocates, states, or recommends the problematic thing
- UNMET (criterion_status: "UNMET"): The response does NOT make this error, OR it mentions the thing only to warn against it or mention why it's wrong

Examples of what does NOT count as MET for negative criteria:
- "This is often misdiagnosed as X, but it's actually Y" -> NOT stating it's X (UNMET)
- "Avoid doing X because..." -> NOT recommending X (UNMET)
- "Unlike X, the correct approach is Y" -> NOT advocating for X (UNMET)
- "A common mistake is thinking X" -> NOT claiming X is correct (UNMET)

EVALUATION RULES:
- For numerical values: Check if they fall within specified ranges or match exactly as required.
- For factual claims: Verify the information is present and accurate, regardless of exact phrasing.
- For required elements: Confirm presence, counting precisely when numbers are specified.
- For exclusion requirements: Confirm that restricted content is absent.
- For length requirements: Carefully measure the number of words, characters, items, etc.
- Be strict about factual accuracy and flexible about wording.
- Accept semantically equivalent statements or implications where appropriate.
- Pay careful attention to negation, warnings, and contrasts.

CONDITIONAL VS UNCONDITIONAL ACTIONS (CRITICAL):
When a criterion requires an action to be done "immediately", "now", "as soon as possible", or unconditionally, you must distinguish:
- UNCONDITIONAL: "Give epinephrine now" or "Administer X immediately" -> action IS being taken
- CONDITIONAL: "If Y occurs, give epinephrine" or "Start X if condition Z" -> action is NOT being taken immediately; it's contingent on a future condition

If the criterion says something should happen "immediately" or without conditions, a conditional statement does NOT satisfy the criterion. Mark as UNMET.

Example:
- Criterion: "Administers alteplase immediately for acute ischemic stroke"
- Output: "If CT confirms no hemorrhage, consider alteplase" -> UNMET (conditional, not immediate)
- Output: "Give alteplase now per acute stroke protocol" -> MET (immediate, unconditional)

IMPLICIT VS EXPLICIT SATISFACTION:
Consider whether a criterion can be satisfied implicitly through context, tone, or logical implication, not just explicit statements:
- "States there is no location in China" can be MET by "Locations are only in United States and Canada"--if locations are ONLY in US and Canada, China is excluded; no need to mention China
- "Confirms the user is logged out" can be MET by "Session expired at 3:42 PM"--an expired session means the user is logged out, even without stating it directly

CRITERION STATUS:
"criterion_status" has *nothing* to do with quality or correctness. It only means:
- "MET": The thing described in the criterion IS present/occurring in the response
- "UNMET": The thing described in the criterion IS NOT present/occurring in the response

Your response must be valid JSON with this exact format:

{
"explanation": "Brief explanation of why the criterion is MET.",
"criterion_status": "MET"
}

Examples:

Positive criterion: "States Q4 2023 base margin 17.2%"
Response: "The Q4 2023 base margin was 17.2% before adjustments."
{
"explanation": "The response states Q4 2023 base margin as 17.2%, as required.",
"criterion_status": "MET"
}

Negative criterion: "States that the patient has celiac disease"
Response: "This patient does not have celiac disease."
{
"explanation": "The response explicitly states the patient does NOT have celiac disease, so this error is not present.",
"criterion_status": "UNMET"
}

Positive criterion: "Administers epinephrine immediately for anaphylaxis"
Response: "If symptoms worsen, give epinephrine and call for help."
{
"explanation": "Epinephrine is mentioned only as a conditional action contingent on symptom worsening, not as an immediate intervention.",
"criterion_status": "UNMET"
}

Positive criterion: "States there is no location in China"
Response: "Locations are only in United States and Canada."
{
"explanation": "If locations are only in US and Canada, China is excluded. The response logically entails no China location without mentioning China.",
"criterion_status": "MET"
}

Return only raw JSON starting with {, no back-ticks, no 'json' prefix."""

DRACO_USER_TEMPLATE = """<criterion_type>
{criterion_type}
</criterion_type>

<criterion>
{criterion_text}
</criterion>

{query_text}

<response>
{response_text}
</response>"""


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

def build_user_prompt(
    report: str,
    criterion: Criterion,
    benchmark: str,
    query: str = "",
) -> str:
    """Build the user prompt for a single criterion evaluation."""
    if benchmark == "draco":
        criterion_type = "positive" if criterion.weight > 0 else "negative"
        return DRACO_USER_TEMPLATE.format(
            criterion_type=criterion_type,
            criterion_text=criterion.text,
            query_text=query,
            response_text=report,
        )
    else:
        return RESEARCHRUBRICS_USER_TEMPLATE.format(
            document_content=report,
            rubric_title=criterion.text,
            rubric_category=criterion.section,
            rubric_weight=criterion.weight,
        )


def get_system_prompt(benchmark: str) -> str:
    """Get the system prompt for the given benchmark."""
    if benchmark == "draco":
        return DRACO_SYSTEM_PROMPT
    return RESEARCHRUBRICS_SYSTEM_PROMPT


# ---------------------------------------------------------------------------
# Verdict parsing
# ---------------------------------------------------------------------------

def parse_verdict_response(
    raw: str, task_id: str, criterion_id: str
) -> Verdict:
    """Parse judge LLM response into a Verdict, with fallback for malformed output."""
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

    # Support both ResearchRubrics ("Satisfied"/"Not Satisfied") and DRACO ("MET"/"UNMET")
    verdict_str = (
        data.get("verdict", "")
        or data.get("criterion_status", "")
    ).strip()

    if verdict_str.lower() == "satisfied" or verdict_str.upper() == "MET":
        met = True
    elif verdict_str.lower() == "not satisfied" or verdict_str.upper() == "UNMET":
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
        reasoning=data.get("reasoning", "") or data.get("explanation", ""),
        tokens_used=0,
        model="",
        duration_seconds=0.0,
    )


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Model detection
# ---------------------------------------------------------------------------

def _is_gemini_model(model: str) -> bool:
    """Check if a model string refers to a Google Gemini model."""
    return model.startswith("gemini-")


# ---------------------------------------------------------------------------
# Batch pricing (per 1M tokens) — 50% of standard pricing
# ---------------------------------------------------------------------------

BATCH_PRICING: dict[str, dict[str, float]] = {
    "gemini-2.5-pro-preview-06-05": {"input": 0.625, "output": 5.00},
    "gemini-2.5-pro": {"input": 0.625, "output": 5.00},
    "gemini-3-pro-preview": {"input": 1.00, "output": 6.00},
}

# Fallback for unknown models — use gemini-2.5-pro pricing
_DEFAULT_BATCH_PRICING = {"input": 0.625, "output": 5.00}


def estimate_batch_cost(
    tasks: list[tuple[str, Path, list[Criterion], str]],
    results_dir: Path,
    model: str,
    benchmark: str,
) -> dict:
    """Estimate cost for a batch judge run.

    Returns dict with: total_criteria, remaining_criteria, est_input_tokens,
    est_output_tokens, est_cost_usd, pricing_per_1m.
    """
    pricing = BATCH_PRICING.get(model, _DEFAULT_BATCH_PRICING)

    total_criteria = 0
    remaining_criteria = 0
    est_input_chars = 0

    system_prompt = get_system_prompt(benchmark)
    system_chars = len(system_prompt)

    for task_id, report_path, criteria, query in tasks:
        total_criteria += len(criteria)
        existing = load_existing_verdicts(results_dir / f"{task_id}.jsonl")
        remaining = Judge.remaining_criteria(criteria, existing)
        remaining_criteria += len(remaining)

        if remaining:
            report_chars = report_path.stat().st_size
            for criterion in remaining:
                # Each request: system prompt + user prompt (report + criterion + query)
                criterion_chars = len(criterion.text) + len(criterion.section)
                query_chars = len(query) if benchmark == "draco" else 0
                est_input_chars += system_chars + report_chars + criterion_chars + query_chars + 200  # overhead

    # Rough estimate: 1 token ≈ 4 characters
    est_input_tokens = est_input_chars // 4
    est_output_tokens = remaining_criteria * 150  # ~150 tokens per verdict JSON

    est_cost = (
        (est_input_tokens / 1_000_000) * pricing["input"]
        + (est_output_tokens / 1_000_000) * pricing["output"]
    )

    return {
        "total_criteria": total_criteria,
        "remaining_criteria": remaining_criteria,
        "est_input_tokens": est_input_tokens,
        "est_output_tokens": est_output_tokens,
        "est_cost_usd": est_cost,
        "pricing": pricing,
    }


def _is_zai_model(model: str) -> bool:
    """Check if a model string refers to a Z.ai GLM model."""
    return model.startswith("glm-")


# ---------------------------------------------------------------------------
# Judge class
# ---------------------------------------------------------------------------

class Judge:
    """LLM-as-judge supporting Anthropic Claude, Google Gemini, and Z.ai GLM models.

    Per-benchmark configuration:
    - ResearchRubrics: gemini-2.5-pro-preview-06-05, no thinking, JSON response
    - DRACO: gemini-3-pro-preview, thinking=low, temperature=0.2, raw JSON response
    """

    def __init__(
        self,
        model: str = "gemini-2.5-pro-preview-06-05",
        benchmark: str = "researchrubrics",
        max_concurrent: int = 20,
        max_retries: int = 3,
        temperature: float | None = None,
        thinking_level: str | None = None,
    ):
        self.model = model
        self.benchmark = benchmark
        self.max_retries = max_retries
        self.temperature = temperature
        self.thinking_level = thinking_level
        # Z.ai has lower rate limits — cap concurrency automatically
        effective_concurrent = max_concurrent
        if _is_zai_model(model) and max_concurrent > 5:
            effective_concurrent = 5
        self._sem = asyncio.Semaphore(effective_concurrent)
        self._use_gemini = _is_gemini_model(model)
        self._use_zai = _is_zai_model(model)

        if self._use_gemini:
            from google import genai
            api_key = os.environ.get("GEMINI_API_KEY")
            if not api_key:
                raise ValueError(
                    "GEMINI_API_KEY environment variable is required for Gemini judge models"
                )
            self._gemini_client = genai.Client(api_key=api_key)
        elif self._use_zai:
            from openai import AsyncOpenAI
            api_key = os.environ.get("ZAI_API_KEY")
            if not api_key:
                raise ValueError(
                    "ZAI_API_KEY environment variable is required for Z.ai judge models"
                )
            self._zai_client = AsyncOpenAI(
                api_key=api_key,
                base_url="https://api.z.ai/api/paas/v4/",
            )
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
        self, system_prompt: str, user_prompt: str
    ) -> tuple[str, int]:
        """Call Anthropic Claude and return (raw_text, tokens_used)."""
        kwargs: dict = {
            "model": self.model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
        }
        if self.temperature is not None:
            kwargs["temperature"] = self.temperature
        response = await self._anthropic_client.messages.create(**kwargs)
        raw = response.content[0].text
        tokens = response.usage.input_tokens + response.usage.output_tokens
        return raw, tokens

    async def _judge_gemini(
        self, system_prompt: str, user_prompt: str
    ) -> tuple[str, int]:
        """Call Google Gemini and return (raw_text, tokens_used)."""
        from google.genai import types

        config_kwargs: dict = {
            "system_instruction": system_prompt,
            "max_output_tokens": 50000,
        }
        if self.temperature is not None:
            config_kwargs["temperature"] = self.temperature

        # Gemini's thinking mode is incompatible with response_mime_type JSON mode.
        # When thinking is enabled, we rely on the prompt to enforce JSON output.
        if self.thinking_level:
            level_map = {
                "low": types.ThinkingLevel.LOW,
                "medium": types.ThinkingLevel.MEDIUM,
                "high": types.ThinkingLevel.HIGH,
                "minimal": types.ThinkingLevel.MINIMAL,
            }
            level = level_map.get(self.thinking_level)
            if level:
                config_kwargs["thinking_config"] = types.ThinkingConfig(
                    thinking_level=level,
                )
            else:
                console_msg = f"Warning: unknown thinking_level '{self.thinking_level}', ignoring"
                import sys
                print(console_msg, file=sys.stderr)
        else:
            config_kwargs["response_mime_type"] = "application/json"

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
                config=types.GenerateContentConfig(**config_kwargs),
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

    async def _judge_zai(
        self, system_prompt: str, user_prompt: str
    ) -> tuple[str, int]:
        """Call Z.ai GLM via OpenAI-compatible API and return (raw_text, tokens_used)."""
        kwargs: dict = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": 4096,
        }
        if self.temperature is not None:
            kwargs["temperature"] = self.temperature

        response = await self._zai_client.chat.completions.create(**kwargs)

        raw = response.choices[0].message.content or ""
        tokens = 0
        if response.usage:
            tokens = (response.usage.prompt_tokens or 0) + (response.usage.completion_tokens or 0)
        return raw, tokens

    async def judge_criterion(
        self,
        report: str,
        criterion: Criterion,
        task_id: str,
        query: str = "",
    ) -> Verdict:
        """Judge a single criterion against a report."""
        system_prompt = get_system_prompt(self.benchmark)
        user_prompt = build_user_prompt(report, criterion, self.benchmark, query)
        start = time.monotonic()

        for attempt in range(self.max_retries):
            try:
                async with self._sem:
                    if self._use_gemini:
                        raw, tokens = await self._judge_gemini(system_prompt, user_prompt)
                    elif self._use_zai:
                        raw, tokens = await self._judge_zai(system_prompt, user_prompt)
                    else:
                        raw, tokens = await self._judge_anthropic(system_prompt, user_prompt)
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
            except Exception as e:
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(2**attempt)
                    continue
                # Don't save a fake verdict — raise so the criterion stays
                # unjudged and gets retried on the next run via resume support
                raise RuntimeError(
                    f"Failed to judge criterion {criterion.id} "
                    f"after {self.max_retries} retries: {e}"
                ) from e
        raise RuntimeError("Exhausted retries without returning")

    async def judge_task(
        self,
        report_path: Path,
        criteria: list[Criterion],
        task_id: str,
        results_dir: Path,
        query: str = "",
        on_criterion_done: Callable[[], None] | None = None,
    ) -> list[Verdict]:
        """Judge all criteria for a single task with resume support."""
        report = report_path.read_text()
        verdicts_path = results_dir / f"{task_id}.jsonl"

        existing = load_existing_verdicts(verdicts_path)
        remaining = self.remaining_criteria(criteria, existing)

        if not remaining:
            return existing

        async def _judge_and_save(criterion: Criterion) -> Verdict | None:
            try:
                verdict = await self.judge_criterion(report, criterion, task_id, query)
                save_verdict(verdict, verdicts_path)
                if on_criterion_done:
                    on_criterion_done()
                return verdict
            except RuntimeError:
                # Rate limit or API failure — don't save, will be retried next run
                if on_criterion_done:
                    on_criterion_done()
                return None

        new_verdicts = await asyncio.gather(
            *[_judge_and_save(c) for c in remaining]
        )
        successful = [v for v in new_verdicts if v is not None]
        return existing + successful

    async def canary_check(
        self,
        tasks: list[tuple[str, Path, list[Criterion], str]],
        results_dir: Path,
    ) -> None:
        """Judge a single criterion to verify API + parsing before full run.

        Persists the verdict so it's not re-judged during the full run.
        Raises RuntimeError if the canary fails, preventing wasted token spend.
        """
        if not tasks:
            return

        task_id, report_path, criteria, query = tasks[0]
        if not criteria:
            return

        # Check if canary criterion is already judged
        verdicts_path = results_dir / f"{task_id}.jsonl"
        existing = load_existing_verdicts(verdicts_path)
        remaining = self.remaining_criteria(criteria, existing)
        if not remaining:
            return  # All criteria already judged, canary unnecessary

        report = report_path.read_text()
        criterion = remaining[0]

        verdict = await self.judge_criterion(report, criterion, task_id, query)

        if verdict.reasoning.startswith("Failed to parse") or verdict.reasoning.startswith("API error"):
            raise RuntimeError(
                f"Canary check failed for model={self.model}: "
                f"{verdict.reasoning}. "
                f"Aborting before full run to avoid wasting tokens."
            )

        # Persist canary verdict so it's not re-judged in the full run
        save_verdict(verdict, verdicts_path)

    async def judge_benchmark(
        self,
        tasks: list[tuple[str, Path, list[Criterion], str]],
        results_dir: Path,
        skip_canary: bool = False,
        progress: Progress | None = None,
    ) -> dict[str, list[Verdict]]:
        """Judge all tasks in a benchmark.

        tasks: list of (task_id, report_path, criteria, query) tuples.
        progress: optional Rich Progress instance for live display.
        """
        if not skip_canary:
            await self.canary_check(tasks, results_dir)

        results_dir.mkdir(parents=True, exist_ok=True)
        all_verdicts: dict[str, list[Verdict]] = {}

        for i, (task_id, report_path, criteria, query) in enumerate(tasks, 1):
            task_label = f"[{i}/{len(tasks)}] {task_id[:12]}…"

            if progress:
                task_bar = progress.add_task(
                    task_label, total=len(criteria),
                )
                # Count skipped (already judged) criteria
                existing = load_existing_verdicts(results_dir / f"{task_id}.jsonl")
                skipped = len(criteria) - len(self.remaining_criteria(criteria, existing))
                if skipped > 0:
                    progress.advance(task_bar, skipped)

                def _advance(bar=task_bar):
                    progress.advance(bar)

                verdicts = await self.judge_task(
                    report_path, criteria, task_id, results_dir, query,
                    on_criterion_done=_advance,
                )
            else:
                verdicts = await self.judge_task(
                    report_path, criteria, task_id, results_dir, query,
                )

            all_verdicts[task_id] = verdicts

        return all_verdicts

    def judge_batch(
        self,
        tasks: list[tuple[str, Path, list[Criterion], str]],
        results_dir: Path,
        on_status: Callable[[str], None] | None = None,
        poll_interval: int = 15,
    ) -> dict[str, list[Verdict]]:
        """Judge all tasks using Gemini Batch API (synchronous, blocking).

        Submits all unjudged criteria as a single batch job, polls for
        completion, then parses and saves results. Only supports Gemini models.
        """
        if not self._use_gemini:
            raise ValueError("Batch mode is only supported for Gemini models")

        from google.genai import types
        import time as _time

        results_dir.mkdir(parents=True, exist_ok=True)
        system_prompt = get_system_prompt(self.benchmark)

        # Build batch requests for all unjudged criteria
        batch_requests: list[dict] = []
        request_keys: list[str] = []
        request_map: dict[str, tuple[str, str]] = {}  # key → (task_id, criterion_id)

        for task_id, report_path, criteria, query in tasks:
            report = report_path.read_text()
            existing = load_existing_verdicts(results_dir / f"{task_id}.jsonl")
            remaining = self.remaining_criteria(criteria, existing)

            for criterion in remaining:
                key = f"{task_id}:{criterion.id}"
                user_prompt = build_user_prompt(report, criterion, self.benchmark, query)

                gen_config: dict = {"max_output_tokens": 50000}
                if self.temperature is not None:
                    gen_config["temperature"] = self.temperature

                if self.thinking_level:
                    level_map = {
                        "low": "LOW", "medium": "MEDIUM",
                        "high": "HIGH", "minimal": "MINIMAL",
                    }
                    level_str = level_map.get(self.thinking_level)
                    if level_str:
                        gen_config["thinking_config"] = {"thinking_level": level_str}
                else:
                    gen_config["response_mime_type"] = "application/json"

                batch_requests.append({
                    "key": key,
                    "request": {
                        "contents": [{"parts": [{"text": user_prompt}], "role": "user"}],
                        "system_instruction": {"parts": [{"text": system_prompt}]},
                        "generation_config": gen_config,
                    },
                })
                request_keys.append(key)
                request_map[key] = (task_id, criterion.id)

        if not batch_requests:
            if on_status:
                on_status("All criteria already judged")
            all_verdicts: dict[str, list[Verdict]] = {}
            for task_id, _, criteria, _ in tasks:
                all_verdicts[task_id] = load_existing_verdicts(results_dir / f"{task_id}.jsonl")
            return all_verdicts

        # Submit via JSONL file upload — the file format supports "key" fields
        # for mapping responses back to requests. Inline format does not support
        # keys, so we always use file upload for reliable response mapping.
        if on_status:
            on_status(f"Submitting {len(batch_requests)} criteria...")

        import tempfile
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".jsonl", delete=False, prefix="batch_judge_"
        ) as f:
            for req in batch_requests:
                f.write(json.dumps(req) + "\n")
            tmp_path = f.name

        uploaded = self._gemini_client.files.upload(
            file=tmp_path,
            config=types.UploadFileConfig(
                display_name=f"judge-{self.benchmark}",
                mime_type="jsonl",
            ),
        )
        os.unlink(tmp_path)

        batch_job = self._gemini_client.batches.create(
            model=self.model,
            src=uploaded.name,
            config={"display_name": f"judge-{self.benchmark}"},
        )

        if on_status:
            on_status(f"Batch job created: {batch_job.name}")

        # Poll for completion
        completed_states = {"JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED",
                           "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"}

        last_status = ""
        while True:
            batch_job = self._gemini_client.batches.get(name=batch_job.name)
            state = batch_job.state.name
            if state in completed_states:
                break
            stats = ""
            try:
                if batch_job.completion_stats:
                    cs = batch_job.completion_stats
                    done = (cs.successful_count or 0) + (cs.failed_count or 0)
                    total = done + (cs.incomplete_count or 0)
                    if total == 0:
                        total = len(batch_requests)
                    stats = f" ({done}/{total} done)"
            except Exception:
                pass
            current_status = f"{state}{stats}"
            if on_status and current_status != last_status:
                on_status(current_status)
                last_status = current_status
            _time.sleep(poll_interval)

        if batch_job.state.name != "JOB_STATE_SUCCEEDED":
            raise RuntimeError(
                f"Batch job {batch_job.name} finished with state: {batch_job.state.name}"
            )

        if on_status:
            on_status("Batch succeeded — downloading results...")

        # Parse results from the output file
        verdicts_saved = 0

        if batch_job.dest and batch_job.dest.file_name:
            content_bytes = self._gemini_client.files.download(
                file=batch_job.dest.file_name
            )
            content = content_bytes.decode("utf-8")
            for line in content.splitlines():
                if not line.strip():
                    continue
                entry = json.loads(line)
                key = entry.get("key", "")
                if key not in request_map:
                    continue
                task_id, criterion_id = request_map[key]
                self._save_batch_response(entry.get("response"), task_id, criterion_id, results_dir)
                verdicts_saved += 1
        else:
            if on_status:
                on_status("Warning: no result file found in batch response")

        if on_status:
            on_status(f"Saved {verdicts_saved} verdicts")

        # Load all verdicts (existing + new batch results)
        all_verdicts_final: dict[str, list[Verdict]] = {}
        for task_id, _, criteria, _ in tasks:
            all_verdicts_final[task_id] = load_existing_verdicts(results_dir / f"{task_id}.jsonl")
        return all_verdicts_final

    def _save_batch_response(
        self, response: dict | None, task_id: str, criterion_id: str, results_dir: Path
    ) -> None:
        """Parse and save a single batch response entry."""
        if not response:
            return
        raw_text = ""
        tokens = 0
        if "candidates" in response and response["candidates"]:
            parts = response["candidates"][0].get("content", {}).get("parts", [])
            raw_text = "".join(p.get("text", "") for p in parts)
        if "usageMetadata" in response:
            um = response["usageMetadata"]
            tokens = (um.get("promptTokenCount", 0) + um.get("candidatesTokenCount", 0))

        verdict = parse_verdict_response(raw_text, task_id, criterion_id)
        save_verdict(Verdict(
            task_id=verdict.task_id, criterion_id=verdict.criterion_id,
            met=verdict.met, confidence=verdict.confidence,
            reasoning=verdict.reasoning, tokens_used=tokens,
            model=self.model, duration_seconds=0.0,
        ), results_dir / f"{task_id}.jsonl")
