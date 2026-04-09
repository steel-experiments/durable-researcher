# ABOUTME: Tests for the agent subprocess runner — skip logic, command construction,
# ABOUTME: and timeout handling. No actual subprocess calls in unit tests.

import asyncio
from pathlib import Path

import pytest

from bench.runner import RunResult, build_command, run_task


class TestBuildCommand:
    def test_basic_command(self):
        cmd = build_command(
            topic="quantum computing",
            output=Path("/tmp/out.md"),
            depth="quick",
            max_sources=10,
            project_root=Path("/proj"),
        )
        assert cmd[0] == "bun"
        assert "run" in cmd
        assert "/proj/src/bench.ts" in cmd
        assert "--topic" in cmd
        assert "quantum computing" in cmd
        assert "--output" in cmd
        assert "/tmp/out.md" in cmd
        assert "--depth" in cmd
        assert "quick" in cmd
        assert "--max-sources" in cmd
        assert "10" in cmd

    def test_project_root_in_command(self):
        cmd = build_command(
            topic="test",
            output=Path("/tmp/out.md"),
            depth="standard",
            max_sources=20,
            project_root=Path("/my/project"),
        )
        # bench.ts path should be relative to project root
        bench_path = str(Path("/my/project") / "src" / "bench.ts")
        assert bench_path in cmd


class TestRunTaskSkipLogic:
    @pytest.mark.asyncio
    async def test_skips_existing_report(self, tmp_path: Path):
        # Create an existing report file
        responses_dir = tmp_path / "responses" / "test"
        responses_dir.mkdir(parents=True)
        report_file = responses_dir / "task1.md"
        report_file.write_text("# Existing report")

        result = await run_task(
            task_id="task1",
            benchmark="test",
            prompt="test prompt",
            responses_dir=tmp_path / "responses",
            depth="quick",
            max_sources=10,
            timeout=30,
            project_root=tmp_path,
        )
        assert isinstance(result, RunResult)
        assert result.success is True
        assert result.skipped is True
        assert result.error is None

    @pytest.mark.asyncio
    async def test_skips_empty_report(self, tmp_path: Path):
        # Empty files should not count as existing
        responses_dir = tmp_path / "responses" / "test"
        responses_dir.mkdir(parents=True)
        report_file = responses_dir / "task1.md"
        report_file.write_text("")

        result = await run_task(
            task_id="task1",
            benchmark="test",
            prompt="test prompt",
            responses_dir=tmp_path / "responses",
            depth="quick",
            max_sources=10,
            timeout=30,
            project_root=tmp_path,
        )
        # Empty file means we need to re-run, but since bench.ts doesn't exist
        # in tmp_path, this will fail — that's fine, we're testing skip logic
        assert result.skipped is False


class TestRunTaskExecution:
    @pytest.mark.asyncio
    async def test_passes_timeout_to_agent_via_env(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        captured: dict[str, object] = {}

        class FakeProcess:
            returncode = 0

            async def communicate(self):
                return b"", b""

        async def fake_create_subprocess_exec(*cmd, **kwargs):
            captured["cmd"] = cmd
            captured["env"] = kwargs["env"]
            return FakeProcess()

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

        result = await run_task(
            task_id="task1",
            benchmark="test",
            prompt="test prompt",
            responses_dir=tmp_path / "responses",
            depth="quick",
            max_sources=10,
            timeout=123,
            project_root=tmp_path,
        )

        assert result.success is True
        assert result.skipped is False
        assert captured["env"]["MAX_DURATION"] == "123"
