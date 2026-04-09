# ABOUTME: Typer CLI entry point for the evaluation harness.
# ABOUTME: Subcommands: download, run, judge, score, report.

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
import typer

# Load .env from project root (parent of eval/) — shell env takes precedence
_project_root = Path(__file__).resolve().parent.parent.parent.parent
load_dotenv(_project_root / ".env", override=False)
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

    console.print(f"Running {len(tasks)} tasks from {benchmark} (depth={depth})\n")

    from rich.progress import Progress, BarColumn, TextColumn, MofNCompleteColumn, TimeElapsedColumn
    from bench.runner import RunResult as _RunResult

    task_tuples = [(t.task_id, t.benchmark, t.prompt) for t in tasks]

    async def _run_with_progress():
        with Progress(
            TextColumn("[bold]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            TimeElapsedColumn(),
            console=console,
        ) as progress:
            bar = progress.add_task("Running", total=len(task_tuples))

            def _on_done(result: _RunResult):
                status = "skip" if result.skipped else ("ok" if result.success else "FAIL")
                elapsed = f"{result.duration_seconds:.0f}s" if result.duration_seconds > 0 else "cached"
                progress.console.print(
                    f"  {result.task_id[:12]}… {status} ({elapsed})"
                )
                progress.advance(bar)

            return await run_benchmark(
                task_tuples,
                responses_dir,
                depth=depth,
                max_sources=max_sources,
                concurrency=concurrency,
                timeout=timeout,
                project_root=project_root.resolve(),
                on_task_done=_on_done,
            )

    results = asyncio.run(_run_with_progress())

    succeeded = sum(1 for r in results if r.success)
    skipped = sum(1 for r in results if r.skipped)
    failed = sum(1 for r in results if not r.success)

    console.print(f"\n[green]{succeeded} succeeded[/green] ({skipped} skipped), [red]{failed} failed[/red]")

    for r in results:
        if not r.success:
            console.print(f"  [red]FAIL[/red] {r.task_id}: {r.error}")


def _resolve_judge_config(benchmark: str) -> dict:
    """Resolve benchmark-specific judge defaults from env vars.

    Env var format: {BENCHMARK}_JUDGE_MODEL, {BENCHMARK}_JUDGE_TEMPERATURE, etc.
    Falls back to JUDGE_* vars, then to paper defaults.
    """
    bm = benchmark.upper()

    # Paper defaults per benchmark
    defaults = {
        "researchrubrics": {
            "model": "gemini-2.5-pro-preview-06-05",
            "temperature": None,
            "thinking_level": None,
        },
        "draco": {
            "model": "gemini-3-pro-preview",
            "temperature": 0.2,
            "thinking_level": "low",
        },
    }
    d = defaults.get(benchmark, defaults["researchrubrics"])

    model = (
        os.environ.get(f"{bm}_JUDGE_MODEL")
        or os.environ.get("JUDGE_MODEL")
        or d["model"]
    )
    temp_str = (
        os.environ.get(f"{bm}_JUDGE_TEMPERATURE")
        or os.environ.get("JUDGE_TEMPERATURE")
    )
    temperature = float(temp_str) if temp_str else d["temperature"]
    thinking_level = (
        os.environ.get(f"{bm}_JUDGE_THINKING")
        or os.environ.get("JUDGE_THINKING")
        or d["thinking_level"]
    )
    if thinking_level == "none" or thinking_level == "off" or thinking_level == "disabled":
        thinking_level = None

    return {"model": model, "temperature": temperature, "thinking_level": thinking_level}


@app.command()
def judge(
    benchmark: str = typer.Argument(..., help="Benchmark: researchrubrics or draco"),
    data_dir: Path = typer.Option("data"),
    responses_dir: Path = typer.Option("responses"),
    results_dir: Path = typer.Option("results"),
    model: Optional[str] = typer.Option(None, help="Override judge model"),
    concurrency: int = typer.Option(20, help="Max concurrent judge API calls"),
    limit: Optional[int] = typer.Option(None, help="Max tasks to judge"),
) -> None:
    """Judge agent reports using LLM-as-judge with benchmark-specific prompts and config."""
    from bench.data import load_benchmark
    from bench.judge import Judge

    # Resolve config: CLI --model overrides env vars, which override paper defaults
    config = _resolve_judge_config(benchmark)
    if model:
        config["model"] = model

    data_path = _resolve_data_path(benchmark, data_dir)
    if not data_path.exists():
        console.print(f"[red]Dataset not found. Run 'bench download {benchmark}' first.[/red]")
        raise typer.Exit(1)

    tasks = load_benchmark(benchmark, data_path)
    if limit:
        tasks = tasks[:limit]

    # Build list of tasks that have reports, including the query for DRACO
    judge_tasks = []
    for task in tasks:
        report_path = responses_dir / benchmark / f"{task.task_id}.md"
        if report_path.exists() and report_path.stat().st_size > 0:
            judge_tasks.append((task.task_id, report_path, task.criteria, task.prompt))
        else:
            console.print(f"  [yellow]SKIP[/yellow] {task.task_id}: no report found")

    if not judge_tasks:
        console.print("[red]No reports to judge.[/red]")
        raise typer.Exit(1)

    config_desc = f"model={config['model']}"
    if config["temperature"] is not None:
        config_desc += f", temp={config['temperature']}"
    if config["thinking_level"]:
        config_desc += f", thinking={config['thinking_level']}"

    console.print(
        f"Judging {len(judge_tasks)} tasks from {benchmark} "
        f"({config_desc}, concurrency={concurrency})"
    )

    bench_results_dir = results_dir / benchmark / config["model"]
    j = Judge(
        model=config["model"],
        benchmark=benchmark,
        max_concurrent=concurrency,
        temperature=config["temperature"],
        thinking_level=config["thinking_level"],
    )

    # Canary check before full run
    with console.status("Running canary check (1 criterion)..."):
        try:
            asyncio.run(j.canary_check(judge_tasks))
        except RuntimeError as e:
            console.print(f"[red]Canary check failed:[/red] {e}")
            raise typer.Exit(1)
    console.print("[green]Canary passed[/green] — proceeding with full run")

    from rich.progress import Progress, BarColumn, TextColumn, MofNCompleteColumn, TimeElapsedColumn

    async def _run_with_progress():
        with Progress(
            TextColumn("[bold]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            TimeElapsedColumn(),
            console=console,
        ) as progress:
            return await j.judge_benchmark(judge_tasks, bench_results_dir, skip_canary=True, progress=progress)

    all_verdicts = asyncio.run(_run_with_progress())

    total_criteria = sum(len(v) for v in all_verdicts.values())
    total_met = sum(sum(1 for v in vs if v.met) for vs in all_verdicts.values())
    console.print(f"\n[green]{total_criteria} criteria across {len(all_verdicts)} tasks[/green]")
    if total_criteria > 0:
        console.print(f"  Met: {total_met}/{total_criteria} ({100*total_met/total_criteria:.1f}%)")


@app.command()
def score(
    benchmark: str = typer.Argument(..., help="Benchmark: researchrubrics or draco"),
    data_dir: Path = typer.Option("data"),
    results_dir: Path = typer.Option("results"),
    judge_model: Optional[str] = typer.Option(None, help="Judge model subdir to score"),
) -> None:
    """Compute scores from judge verdicts."""
    from bench.data import load_benchmark
    from bench.judge import load_existing_verdicts
    from bench.score import score_task

    data_path = _resolve_data_path(benchmark, data_dir)
    tasks = load_benchmark(benchmark, data_path)

    # Resolve judge model subdir: results/{benchmark}/{model}/
    bench_base = results_dir / benchmark
    if judge_model:
        bench_results_dir = bench_base / judge_model
    elif bench_base.exists() and any(p.is_dir() for p in bench_base.iterdir()):
        models = sorted(p.name for p in bench_base.iterdir() if p.is_dir())
        if models:
            judge_model = models[0]
            bench_results_dir = bench_base / judge_model
            console.print(f"Auto-detected judge model: {judge_model}")
        else:
            bench_results_dir = bench_base
    else:
        bench_results_dir = bench_base

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
    judge_model: Optional[str] = typer.Option(None, help="Judge model subdir to report on"),
    output: Optional[Path] = typer.Option(None, help="Output path for report markdown"),
) -> None:
    """Generate summary report from scores."""
    from bench.data import load_benchmark
    from bench.judge import load_existing_verdicts
    from bench.report import generate_report, save_report
    from bench.score import score_task

    data_path = _resolve_data_path(benchmark, data_dir)
    tasks = load_benchmark(benchmark, data_path)

    bench_base = results_dir / benchmark
    if judge_model:
        bench_results_dir = bench_base / judge_model
    elif bench_base.exists() and any(p.is_dir() for p in bench_base.iterdir()):
        models = sorted(p.name for p in bench_base.iterdir() if p.is_dir())
        if models:
            judge_model = models[0]
            bench_results_dir = bench_base / judge_model
            console.print(f"Auto-detected judge model: {judge_model}")
        else:
            bench_results_dir = bench_base
    else:
        bench_results_dir = bench_base

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
