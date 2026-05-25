# ABOUTME: Tests for LLM-as-judge prompt construction, verdict parsing, and resume logic.
# ABOUTME: No actual LLM calls — tests the mechanical parts of the judge pipeline.

import json
from pathlib import Path

from bench.judge import (
    Judge,
    Verdict,
    build_user_prompt,
    estimate_judge_cost,
    extract_batch_row_error,
    get_zai_concurrency_limit,
    load_existing_verdicts,
    parse_verdict_response,
    resolve_effective_concurrency,
    resolve_batch_output_key,
)
from bench.score import Criterion

FIXTURES = Path(__file__).parent / "fixtures"


class TestBuildUserPromptResearchRubrics:
    def test_contains_report(self):
        criterion = Criterion(
            id="t:0", text="Discusses X", weight=5.0, section="Explicit Criteria"
        )
        prompt = build_user_prompt("# My Report\n\nContent here.", criterion, "researchrubrics")
        assert "# My Report" in prompt
        assert "Content here." in prompt

    def test_contains_criterion_text(self):
        criterion = Criterion(
            id="t:0", text="Discusses quantum codes", weight=5.0, section="Factual"
        )
        prompt = build_user_prompt("report text", criterion, "researchrubrics")
        assert "Discusses quantum codes" in prompt

    def test_contains_section(self):
        criterion = Criterion(
            id="t:0", text="test", weight=5.0, section="Citation Quality"
        )
        prompt = build_user_prompt("report", criterion, "researchrubrics")
        assert "Citation Quality" in prompt

    def test_contains_weight(self):
        criterion = Criterion(id="t:0", text="test", weight=7.5, section="s")
        prompt = build_user_prompt("report", criterion, "researchrubrics")
        assert "7.5" in prompt


class TestBuildUserPromptDraco:
    def test_contains_response(self):
        criterion = Criterion(id="t:0", text="States X", weight=1.0, section="accuracy")
        prompt = build_user_prompt("Response content here.", criterion, "draco", query="What is X?")
        assert "Response content here." in prompt
        assert "<response>" in prompt

    def test_contains_criterion(self):
        criterion = Criterion(id="t:0", text="Mentions the year 2024", weight=1.0, section="accuracy")
        prompt = build_user_prompt("report", criterion, "draco", query="query")
        assert "Mentions the year 2024" in prompt
        assert "<criterion>" in prompt

    def test_positive_criterion_type(self):
        criterion = Criterion(id="t:0", text="test", weight=1.0, section="s")
        prompt = build_user_prompt("report", criterion, "draco", query="query")
        assert "positive" in prompt

    def test_negative_criterion_type(self):
        criterion = Criterion(id="t:0", text="test", weight=-1.0, section="s")
        prompt = build_user_prompt("report", criterion, "draco", query="query")
        assert "negative" in prompt

    def test_contains_query(self):
        criterion = Criterion(id="t:0", text="test", weight=1.0, section="s")
        prompt = build_user_prompt("report", criterion, "draco", query="What are the effects of climate change?")
        assert "What are the effects of climate change?" in prompt


class TestParseVerdictResponse:
    def test_valid_met(self):
        raw = json.dumps(
            {"verdict": "MET", "confidence": 0.95, "reasoning": "Found evidence."}
        )
        result = parse_verdict_response(raw, "task1", "task1:0")
        assert result.met is True
        assert result.confidence == 0.95
        assert result.reasoning == "Found evidence."

    def test_valid_unmet(self):
        raw = json.dumps(
            {"verdict": "UNMET", "confidence": 0.8, "reasoning": "Not found."}
        )
        result = parse_verdict_response(raw, "task1", "task1:0")
        assert result.met is False

    def test_case_insensitive_verdict(self):
        raw = json.dumps(
            {"verdict": "met", "confidence": 0.9, "reasoning": "ok"}
        )
        result = parse_verdict_response(raw, "task1", "task1:0")
        assert result.met is True

    def test_extracts_json_from_markdown_block(self):
        raw = '```json\n{"verdict": "MET", "confidence": 0.9, "reasoning": "ok"}\n```'
        result = parse_verdict_response(raw, "task1", "task1:0")
        assert result.met is True

    def test_malformed_json_returns_unmet(self):
        result = parse_verdict_response("not json at all", "task1", "task1:0")
        assert result.met is False
        assert "parse" in result.reasoning.lower()

    def test_missing_verdict_field_returns_unmet(self):
        raw = json.dumps({"confidence": 0.9, "reasoning": "ok"})
        result = parse_verdict_response(raw, "task1", "task1:0")
        assert result.met is False

    def test_satisfied_verdict(self):
        raw = json.dumps({"verdict": "Satisfied", "score": 1.0, "confidence": 0.9, "reasoning": "ok"})
        result = parse_verdict_response(raw, "task1", "task1:0")
        assert result.met is True

    def test_not_satisfied_verdict(self):
        raw = json.dumps({"verdict": "Not Satisfied", "score": 0.0, "confidence": 0.8, "reasoning": "nope"})
        result = parse_verdict_response(raw, "task1", "task1:0")
        assert result.met is False

    def test_draco_criterion_status_met(self):
        raw = json.dumps({"criterion_status": "MET", "explanation": "Found it."})
        result = parse_verdict_response(raw, "task1", "task1:0")
        assert result.met is True
        assert result.reasoning == "Found it."

    def test_draco_criterion_status_unmet(self):
        raw = json.dumps({"criterion_status": "UNMET", "explanation": "Not found."})
        result = parse_verdict_response(raw, "task1", "task1:0")
        assert result.met is False
        assert result.reasoning == "Not found."


class TestLoadExistingVerdicts:
    def test_loads_from_jsonl(self):
        verdicts = load_existing_verdicts(FIXTURES / "sample_verdicts.jsonl")
        assert len(verdicts) == 2
        assert verdicts[0].task_id == "aaa111aaa111aaa111aaa111"
        assert verdicts[0].met is True

    def test_returns_empty_for_missing_file(self):
        verdicts = load_existing_verdicts(FIXTURES / "nonexistent.jsonl")
        assert verdicts == []

    def test_criterion_ids_correct(self):
        verdicts = load_existing_verdicts(FIXTURES / "sample_verdicts.jsonl")
        ids = {v.criterion_id for v in verdicts}
        assert "aaa111aaa111aaa111aaa111:0" in ids
        assert "aaa111aaa111aaa111aaa111:1" in ids


class TestJudgeResumeLogic:
    def test_remaining_criteria_excludes_judged(self):
        judge = Judge.__new__(Judge)
        existing = [
            Verdict(
                task_id="t",
                criterion_id="t:0",
                met=True,
                confidence=0.9,
                reasoning="ok",
                tokens_used=100,
                model="test",
                duration_seconds=1.0,
            )
        ]
        all_criteria = [
            Criterion(id="t:0", text="a", weight=5.0, section="s"),
            Criterion(id="t:1", text="b", weight=3.0, section="s"),
        ]
        remaining = Judge.remaining_criteria(all_criteria, existing)
        assert len(remaining) == 1
        assert remaining[0].id == "t:1"


class TestBatchHelpers:
    def test_resolve_batch_output_key_prefers_explicit_key(self):
        key = resolve_batch_output_key({"key": "task1:t:0"}, 0, ["task1:t:0"])
        assert key == "task1:t:0"

    def test_resolve_batch_output_key_falls_back_to_submission_order(self):
        key = resolve_batch_output_key({}, 1, ["task1:t:0", "task1:t:1"])
        assert key == "task1:t:1"

    def test_extract_batch_row_error_from_error_dict(self):
        error = extract_batch_row_error(
            {"error": {"message": "quota exceeded"}, "response": None}
        )
        assert error == "quota exceeded"

    def test_save_batch_response_rejects_missing_response(self, tmp_path: Path):
        judge = Judge.__new__(Judge)
        judge.model = "gemini-2.5-pro"

        saved, error = Judge._save_batch_response(
            judge,
            {"error": {"message": "rate limited"}, "response": None},
            "task1",
            "task1:0",
            tmp_path,
        )

        assert saved is False
        assert error == "rate limited"

    def test_save_batch_response_persists_successful_row(self, tmp_path: Path):
        judge = Judge.__new__(Judge)
        judge.model = "gemini-2.5-pro"

        saved, error = Judge._save_batch_response(
            judge,
            {
                "response": {
                    "candidates": [
                        {
                            "content": {
                                "parts": [
                                    {
                                        "text": '{"criterion_status":"MET","explanation":"Found it."}'
                                    }
                                ]
                            }
                        }
                    ],
                    "usageMetadata": {
                        "promptTokenCount": 10,
                        "candidatesTokenCount": 5,
                    },
                }
            },
            "task1",
            "task1:0",
            tmp_path,
        )

        assert saved is True
        assert error is None
        verdicts = load_existing_verdicts(tmp_path / "task1.jsonl")
        assert len(verdicts) == 1
        assert verdicts[0].met is True
        assert verdicts[0].tokens_used == 15


class TestBatchStateFile:
    def test_helpers_exist(self):
        """Idempotent batch resubmission needs a state-path helper."""
        from bench.judge import batch_state_path

        p = batch_state_path(Path("/tmp/results/draco/gemini"))
        assert p.name == ".batch-state.json"
        assert p.parent == Path("/tmp/results/draco/gemini")

    def test_read_write_roundtrip(self, tmp_path: Path):
        from bench.judge import read_batch_state, write_batch_state

        write_batch_state(tmp_path, "batches/abc-123")
        state = read_batch_state(tmp_path)
        assert state == "batches/abc-123"

    def test_read_returns_none_when_missing(self, tmp_path: Path):
        from bench.judge import read_batch_state

        assert read_batch_state(tmp_path) is None


class TestBatchDisplayName:
    def test_display_name_is_unique_per_call(self):
        from bench.judge import make_batch_display_name

        a = make_batch_display_name("draco")
        b = make_batch_display_name("draco")
        # Each invocation must produce a unique suffix so we don't collide on
        # Gemini's "duplicate filename" error.
        assert a.startswith("judge-draco-")
        assert b.startswith("judge-draco-")
        assert a != b


class TestZaiConcurrencyHelpers:
    def test_known_limit_for_glm_5_1(self):
        assert get_zai_concurrency_limit("glm-5.1") == 1

    def test_known_limit_for_glm_5(self):
        assert get_zai_concurrency_limit("GLM-5") == 2

    def test_resolve_effective_concurrency_caps_to_documented_limit(self):
        effective, note = resolve_effective_concurrency("glm-5.1", 8)
        assert effective == 1
        assert note is not None
        assert "documented Z.ai API concurrency limit" in note

    def test_resolve_effective_concurrency_handles_uppercase_model_names(self):
        effective, note = resolve_effective_concurrency("GLM-5.1", 8)
        assert effective == 1
        assert note is not None
        assert "documented Z.ai API concurrency limit" in note

    def test_resolve_effective_concurrency_is_conservative_for_unknown_glm(self):
        effective, note = resolve_effective_concurrency("glm-9-experimental", 4)
        assert effective == 1
        assert note is not None
        assert "conservative cap=1" in note


class TestJudgeCostEstimate:
    def test_glm_5_1_uses_zai_realtime_pricing(self, tmp_path: Path):
        report_path = tmp_path / "task1.md"
        report_path.write_text("A short report.")
        criteria = [
            Criterion(id="task1:0", text="Mentions X", weight=1.0, section="accuracy")
        ]

        estimate = estimate_judge_cost(
            [("task1", report_path, criteria, "What is X?")],
            tmp_path / "results",
            "glm-5.1",
            "draco",
            mode="realtime",
        )

        assert estimate["pricing"] == {
            "input": 1.40,
            "cached_input": 0.26,
            "output": 4.40,
        }
        assert estimate["pricing_label"] == "Z.ai real-time pricing"
        assert estimate["pricing_exact"] is True
        assert estimate["est_cost_usd"] is not None

    def test_anthropic_pricing_is_reported_as_unavailable(self, tmp_path: Path):
        report_path = tmp_path / "task1.md"
        report_path.write_text("A short report.")
        criteria = [
            Criterion(id="task1:0", text="Mentions X", weight=1.0, section="accuracy")
        ]

        estimate = estimate_judge_cost(
            [("task1", report_path, criteria, "")],
            tmp_path / "results",
            "claude-sonnet-4-5",
            "researchrubrics",
            mode="realtime",
        )

        assert estimate["pricing"] is None
        assert estimate["pricing_label"] == "pricing unavailable for this provider"
        assert estimate["est_cost_usd"] is None
