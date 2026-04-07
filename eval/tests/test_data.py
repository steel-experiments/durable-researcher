# ABOUTME: Tests for dataset loading — parsing ResearchRubrics and DRACO JSONL into
# ABOUTME: unified BenchmarkTask/Criterion dataclasses.

from pathlib import Path

from bench.data import BenchmarkTask, load_draco, load_researchrubrics

FIXTURES = Path(__file__).parent / "fixtures"


class TestLoadResearchRubrics:
    def test_loads_correct_count(self):
        tasks = load_researchrubrics(FIXTURES / "researchrubrics_sample.jsonl")
        assert len(tasks) == 2

    def test_task_fields(self):
        tasks = load_researchrubrics(FIXTURES / "researchrubrics_sample.jsonl")
        task = tasks[0]
        assert isinstance(task, BenchmarkTask)
        assert task.benchmark == "researchrubrics"
        assert task.task_id == "aaa111aaa111aaa111aaa111"
        assert "quantum error correction" in task.prompt
        assert task.metadata["domain"] == "AI & ML"

    def test_criteria_mapping(self):
        tasks = load_researchrubrics(FIXTURES / "researchrubrics_sample.jsonl")
        task = tasks[0]
        assert len(task.criteria) == 4
        c0 = task.criteria[0]
        assert c0.id == "aaa111aaa111aaa111aaa111:0"
        assert c0.weight == 5.0
        assert c0.section == "Explicit Criteria"
        assert "two distinct quantum error correction" in c0.text

    def test_negative_weight_preserved(self):
        tasks = load_researchrubrics(FIXTURES / "researchrubrics_sample.jsonl")
        task = tasks[0]
        negative = [c for c in task.criteria if c.weight < 0]
        assert len(negative) == 1
        assert negative[0].weight == -4.0

    def test_second_task(self):
        tasks = load_researchrubrics(FIXTURES / "researchrubrics_sample.jsonl")
        task = tasks[1]
        assert task.task_id == "bbb222bbb222bbb222bbb222"
        assert len(task.criteria) == 3


class TestLoadDraco:
    def test_loads_correct_count(self):
        tasks = load_draco(FIXTURES / "draco_sample.jsonl")
        assert len(tasks) == 2

    def test_task_fields(self):
        tasks = load_draco(FIXTURES / "draco_sample.jsonl")
        task = tasks[0]
        assert isinstance(task, BenchmarkTask)
        assert task.benchmark == "draco"
        assert task.task_id == "test-task-001"
        assert "transformer architectures" in task.prompt
        assert task.metadata["domain"] == "Academic"

    def test_criteria_from_sections(self):
        tasks = load_draco(FIXTURES / "draco_sample.jsonl")
        task = tasks[0]
        # 2 factual + 1 breadth + 1 presentation + 1 citation = 5
        assert len(task.criteria) == 5

    def test_section_ids_preserved(self):
        tasks = load_draco(FIXTURES / "draco_sample.jsonl")
        task = tasks[0]
        sections = {c.section for c in task.criteria}
        assert sections == {
            "factual-accuracy",
            "breadth-and-depth-of-analysis",
            "presentation-quality",
            "citation-quality",
        }

    def test_criterion_ids_unique(self):
        tasks = load_draco(FIXTURES / "draco_sample.jsonl")
        for task in tasks:
            ids = [c.id for c in task.criteria]
            assert len(ids) == len(set(ids))

    def test_negative_weight_preserved(self):
        tasks = load_draco(FIXTURES / "draco_sample.jsonl")
        task = tasks[1]  # crypto task has -500 weight
        negative = [c for c in task.criteria if c.weight < 0]
        assert len(negative) == 1
        assert negative[0].weight == -500

    def test_criterion_text_from_requirement(self):
        tasks = load_draco(FIXTURES / "draco_sample.jsonl")
        task = tasks[0]
        c0 = task.criteria[0]
        assert "Vaswani" in c0.text
