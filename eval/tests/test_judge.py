# ABOUTME: Tests for LLM-as-judge prompt construction, verdict parsing, and resume logic.
# ABOUTME: No actual LLM calls — tests the mechanical parts of the judge pipeline.

import json
from pathlib import Path

from bench.judge import (
    Judge,
    Verdict,
    build_user_prompt,
    load_existing_verdicts,
    parse_verdict_response,
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
