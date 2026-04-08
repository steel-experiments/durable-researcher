# ABOUTME: Typer CLI entry point for the evaluation harness.
# ABOUTME: Subcommands: download, run, judge, score, report.

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

app = typer.Typer(help="Evaluation harness for durable-researcher benchmarks.")
console = Console()

BENCHMARKS = ("researchrubrics", "draco", "all")


def _resolve_data_path(benchmark: str, data_dir: Path) -> Path:
    """Resolve the JSONL path for a benchmark."""
    if benchmark == "researchrubrics":
        return data_dir / "researchrubrics" / "processed_data.jsonl"
    elif benchmark == "draco":
        return data_dir / "draco" / "test.jsonl"
    raise typer.BadParameter(f"Unknown benchmark: {benchmark}")


@app.command()
def download(
    benchmark: str = typer.Argument(
        ..., help="Benchmark to download: researchrubrics, draco, or all"
    ),
    data_dir: Path = typer.Option(
        "data", help="Directory for downloaded datasets"
    ),
) -> None:
    """Download benchmark datasets from HuggingFace."""
    from bench.data import download_draco, download_researchrubrics

    targets = (
        ["researchrubrics", "draco"] if benchmark == "all" else [benchmark]
    )

    for target in targets:
        with console.status(f"Downloading {target}..."):
            if target == "researchrubrics":
                path = download_researchrubrics(data_dir)
            elif target == "draco":
                path = download_draco(data_dir)
            else:
                raise typer.BadParameter(f"Unknown benchmark: {target}")
            console.print(f"  [green]Downloaded[/green] {target} → {path}")


@app.command()
def run(
    benchmark: str = typer.Argument(..., help="Benchmark: researchrubrics or draco"),
    data_dir: Path = typer.Option("data"),
    responses_dir: Path = typer.Option("responses"),
    depth: str = typer.Option("quick", help="Research depth: quick, standard, deep"),
    max_sources: int = typer.Option(10),
    concurrency: int = typer.Option(1),
    timeout: int = typer.Option(900, help="Per-task timeout in seconds"),
    limit: Optional[int] = typer.Option(None, help="Max tasks to run"),
    project_root: Path = typer.Option(
        "..", help="Path to durable-researcher project root"
    ),
) -> None:
    """Run the research agent on benchmark prompts."""
    from bench.data import load_benchmark
    from bench.runner import run_benchmark

    data_path = _resolve_data_path(benchmark, data_dir)
    if not data_path.exists():
        console.print(
            f"[red]Dataset not found at {data_path}. Run 'bench download {benchmark}' first.[/red]"
        )
        raise typer.Exit(1)

    tasks = load_benchmark(benchmark, data_path)
    if limit:
        tasks = tasks[:limit]

    console.print(f"Running {len(tasks)} tasks from {benchmark} (depth={depth})")

    task_tuples = [(t.task_id, t.benchmark, t.prompt) for t in tasks]
    results = asyncio.run(
        run_benchmark(
            task_tuples,
            responses_dir,
            depth=depth,
            max_sources=max_sources,
            concurrency=concurrency,
            timeout=timeout,
            project_root=project_root.resolve(),
        )
    )

    succeeded = sum(1 for r in results if r.success)
    skipped = sum(1 for r in results if r.skipped)
    failed = sum(1 for r in results if not r.success)

    console.print(f"\n[green]{succeeded} succeeded[/green] ({skipped} skipped), [red]{failed} failed[/red]")

    for r in results:
        if not r.success:
            console.print(f"  [red]FAIL[/red] {r.task_id}: {r.error}")


@app.command()
def judge(
    benchmark: str = typer.Argument(..., help="Benchmark: researchrubrics or draco"),
    data_dir: Path = typer.Option("data"),
    responses_dir: Path = typer.Option("responses"),
    results_dir: Path = typer.Option("results"),
    model: str = typer.Option(
        os.environ.get("JUDGE_MODEL", "claude-haiku-4-5-20251001"),
        help="Judge model (e.g. claude-haiku-4-5-20251001, gemini-2.5-pro). Set JUDGE_MODEL env var to change default.",
    ),
    concurrency: int = typer.Option(20, help="Max concurrent judge API calls"),
    limit: Optional[int] = typer.Option(None, help="Max tasks to judge"),
) -> None:
    """Judge agent reports using Claude as LLM-as-judge."""
    from bench.data import load_benchmark
    from bench.judge import Judge

    data_path = _resolve_data_path(benchmark, data_dir)
    if not data_path.exists():
        console.print(f"[red]Dataset not found. Run 'bench download {benchmark}' first.[/red]")
        raise typer.Exit(1)

    tasks = load_benchmark(benchmark, data_path)
    if limit:
        tasks = tasks[:limit]

    # Build list of tasks that have reports
    judge_tasks = []
    for task in tasks:
        report_path = responses_dir / benchmark / f"{task.task_id}.md"
        if report_path.exists() and report_path.stat().st_size > 0:
            judge_tasks.append((task.task_id, report_path, task.criteria))
        else:
            console.print(f"  [yellow]SKIP[/yellow] {task.task_id}: no report found")

    if not judge_tasks:
        console.print("[red]No reports to judge.[/red]")
        raise typer.Exit(1)

    console.print(
        f"Judging {len(judge_tasks)} tasks from {benchmark} "
        f"(model={model}, concurrency={concurrency})"
    )

    bench_results_dir = results_dir / benchmark
    j = Judge(model=model, max_concurrent=concurrency)

    all_verdicts = asyncio.run(
        j.judge_benchmark(judge_tasks, bench_results_dir)
    )

    total_criteria = sum(len(v) for v in all_verdicts.values())
    total_met = sum(sum(1 for v in vs if v.met) for vs in all_verdicts.values())
    console.print(f"\n[green]Judged {total_criteria} criteria across {len(all_verdicts)} tasks[/green]")
    console.print(f"  Met: {total_met}/{total_criteria} ({100*total_met/total_criteria:.1f}%)")


@app.command()
def score(
    benchmark: str = typer.Argument(..., help="Benchmark: researchrubrics or draco"),
    data_dir: Path = typer.Option("data"),
    results_dir: Path = typer.Option("results"),
) -> None:
    """Compute scores from judge verdicts."""
    from bench.data import load_benchmark
    from bench.judge import load_existing_verdicts
    from bench.score import score_task

    data_path = _resolve_data_path(benchmark, data_dir)
    tasks = load_benchmark(benchmark, data_path)
    bench_results_dir = results_dir / benchmark

    scores = []
    for task in tasks:
        verdicts_path = bench_results_dir / f"{task.task_id}.jsonl"
        if not verdicts_path.exists():
            continue
        verdicts = load_existing_verdicts(verdicts_path)
        if verdicts:
            ts = score_task(verdicts, task.criteria, benchmark, task.task_id)
            scores.append(ts)

    if not scores:
        console.print("[red]No verdicts found. Run 'bench judge' first.[/red]")
        raise typer.Exit(1)

    table = Table(title=f"{benchmark} Scores")
    table.add_column("Task ID", max_width=24)
    table.add_column("Score", justify="right")
    table.add_column("Pass Rate", justify="right")
    table.add_column("Met", justify="right")

    for s in sorted(scores, key=lambda x: x.score, reverse=True):
        table.add_row(
            s.task_id[:24],
            f"{s.score:.3f}",
            f"{s.pass_rate:.3f}",
            f"{s.criteria_met}/{s.criteria_count}",
        )

    console.print(table)

    import statistics

    mean_score = statistics.mean(s.score for s in scores)
    console.print(f"\n[bold]Mean score: {mean_score:.3f}[/bold]")


@app.command()
def report(
    benchmark: str = typer.Argument(..., help="Benchmark: researchrubrics or draco"),
    data_dir: Path = typer.Option("data"),
    results_dir: Path = typer.Option("results"),
    output: Optional[Path] = typer.Option(None, help="Output path for report markdown"),
) -> None:
    """Generate summary report from scores."""
    from bench.data import load_benchmark
    from bench.judge import load_existing_verdicts
    from bench.report import generate_report, save_report
    from bench.score import score_task

    data_path = _resolve_data_path(benchmark, data_dir)
    tasks = load_benchmark(benchmark, data_path)
    bench_results_dir = results_dir / benchmark

    scores = []
    for task in tasks:
        verdicts_path = bench_results_dir / f"{task.task_id}.jsonl"
        if not verdicts_path.exists():
            continue
        verdicts = load_existing_verdicts(verdicts_path)
        if verdicts:
            ts = score_task(verdicts, task.criteria, benchmark, task.task_id)
            scores.append(ts)

    if not scores:
        console.print("[red]No scored tasks found.[/red]")
        raise typer.Exit(1)

    report_text = generate_report(scores, benchmark)

    if output:
        save_report(report_text, output)
        console.print(f"Report saved to {output}")
    else:
        console.print(report_text)


if __name__ == "__main__":
    app()
