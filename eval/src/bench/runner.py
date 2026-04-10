# ABOUTME: Runs the durable-researcher agent on benchmark tasks via subprocess.
# ABOUTME: Supports resume (skips existing reports) and concurrency control.

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path


@dataclass
class RunResult:
    """Result of running the agent on a single benchmark task."""

    task_id: str
    benchmark: str
    success: bool
    skipped: bool
    duration_seconds: float
    error: str | None = None
    usage_path: str | None = None


def build_command(
    topic: str,
    output: Path,
    usage_output: Path,
    depth: str,
    max_sources: int,
    project_root: Path,
) -> list[str]:
    """Build the subprocess command to invoke the agent bridge."""
    bench_ts = str(project_root / "src" / "bench.ts")
    return [
        "bun",
        "run",
        bench_ts,
        "--topic",
        topic,
        "--output",
        str(output),
        "--usage-output",
        str(usage_output),
        "--depth",
        depth,
        "--max-sources",
        str(max_sources),
    ]


async def run_task(
    task_id: str,
    benchmark: str,
    prompt: str,
    responses_dir: Path,
    depth: str = "quick",
    max_sources: int = 10,
    timeout: int = 900,
    project_root: Path | None = None,
) -> RunResult:
    """Run the agent on a single benchmark task.

    Skips if a non-empty report file already exists (resume support).
    """
    if project_root is None:
        # Default: assume eval/ is inside the project root
        project_root = Path(__file__).parent.parent.parent.parent

    output_dir = responses_dir / benchmark
    output_dir.mkdir(parents=True, exist_ok=True)
    # Must be absolute — bench.ts runs with cwd=project_root
    output_path = (output_dir / f"{task_id}.md").resolve()
    usage_path = output_path.with_suffix(".usage.json")

    # Skip only when both the report and its usage sidecar already exist.
    # Older benchmark runs may have markdown reports without usage metadata.
    if (
        output_path.exists()
        and output_path.stat().st_size > 0
        and usage_path.exists()
    ):
        return RunResult(
            task_id=task_id,
            benchmark=benchmark,
            success=True,
            skipped=True,
            duration_seconds=0.0,
            usage_path=str(usage_path) if usage_path.exists() else None,
        )

    cmd = build_command(prompt, output_path, usage_path, depth, max_sources, project_root)
    start = time.monotonic()

    try:
        env = os.environ.copy()
        env["MAX_DURATION"] = str(timeout)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(project_root),
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        elapsed = time.monotonic() - start

        if proc.returncode == 0:
            return RunResult(
                task_id=task_id,
                benchmark=benchmark,
                success=True,
                skipped=False,
                duration_seconds=round(elapsed, 2),
                usage_path=str(usage_path) if usage_path.exists() else None,
            )
        else:
            return RunResult(
                task_id=task_id,
                benchmark=benchmark,
                success=False,
                skipped=False,
                duration_seconds=round(elapsed, 2),
                error=stderr.decode().strip()[:500] if stderr else "Unknown error",
                usage_path=str(usage_path) if usage_path.exists() else None,
            )
    except TimeoutError:
        return RunResult(
            task_id=task_id,
            benchmark=benchmark,
            success=False,
            skipped=False,
            duration_seconds=float(timeout),
            error=f"Timed out after {timeout}s",
            usage_path=str(usage_path) if usage_path.exists() else None,
        )
    except FileNotFoundError as e:
        return RunResult(
            task_id=task_id,
            benchmark=benchmark,
            success=False,
            skipped=False,
            duration_seconds=round(time.monotonic() - start, 2),
            error=str(e),
            usage_path=str(usage_path) if usage_path.exists() else None,
        )


async def run_benchmark(
    tasks: list[tuple[str, str, str]],
    responses_dir: Path,
    depth: str = "quick",
    max_sources: int = 10,
    concurrency: int = 1,
    timeout: int = 900,
    project_root: Path | None = None,
    on_task_done: Callable[[RunResult], None] | None = None,
) -> list[RunResult]:
    """Run agent on all tasks with concurrency control.

    tasks: list of (task_id, benchmark, prompt) tuples.
    on_task_done: called after each task completes (for progress updates).
    """
    sem = asyncio.Semaphore(concurrency)
    results: list[RunResult] = []

    async def _run_one(task_id: str, benchmark: str, prompt: str) -> RunResult:
        async with sem:
            result = await run_task(
                task_id=task_id,
                benchmark=benchmark,
                prompt=prompt,
                responses_dir=responses_dir,
                depth=depth,
                max_sources=max_sources,
                timeout=timeout,
                project_root=project_root,
            )
            if on_task_done:
                on_task_done(result)
            return result

    coros = [_run_one(tid, bench, prompt) for tid, bench, prompt in tasks]
    results = await asyncio.gather(*coros)
    return list(results)
