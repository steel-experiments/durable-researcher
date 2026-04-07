# ABOUTME: Runs the durable-researcher agent on benchmark tasks via subprocess.
# ABOUTME: Supports resume (skips existing reports) and concurrency control.

from __future__ import annotations

import asyncio
import time
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


def build_command(
    topic: str,
    output: Path,
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

    # Skip if report already exists and is non-empty
    if output_path.exists() and output_path.stat().st_size > 0:
        return RunResult(
            task_id=task_id,
            benchmark=benchmark,
            success=True,
            skipped=True,
            duration_seconds=0.0,
        )

    cmd = build_command(prompt, output_path, depth, max_sources, project_root)
    start = time.monotonic()

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(project_root),
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
            )
        else:
            return RunResult(
                task_id=task_id,
                benchmark=benchmark,
                success=False,
                skipped=False,
                duration_seconds=round(elapsed, 2),
                error=stderr.decode().strip()[:500] if stderr else "Unknown error",
            )
    except TimeoutError:
        return RunResult(
            task_id=task_id,
            benchmark=benchmark,
            success=False,
            skipped=False,
            duration_seconds=float(timeout),
            error=f"Timed out after {timeout}s",
        )
    except FileNotFoundError as e:
        return RunResult(
            task_id=task_id,
            benchmark=benchmark,
            success=False,
            skipped=False,
            duration_seconds=round(time.monotonic() - start, 2),
            error=str(e),
        )


async def run_benchmark(
    tasks: list[tuple[str, str, str]],
    responses_dir: Path,
    depth: str = "quick",
    max_sources: int = 10,
    concurrency: int = 1,
    timeout: int = 900,
    project_root: Path | None = None,
) -> list[RunResult]:
    """Run agent on all tasks with concurrency control.

    tasks: list of (task_id, benchmark, prompt) tuples.
    """
    sem = asyncio.Semaphore(concurrency)
    results: list[RunResult] = []

    async def _run_one(task_id: str, benchmark: str, prompt: str) -> RunResult:
        async with sem:
            return await run_task(
                task_id=task_id,
                benchmark=benchmark,
                prompt=prompt,
                responses_dir=responses_dir,
                depth=depth,
                max_sources=max_sources,
                timeout=timeout,
                project_root=project_root,
            )

    coros = [_run_one(tid, bench, prompt) for tid, bench, prompt in tasks]
    results = await asyncio.gather(*coros)
    return list(results)
