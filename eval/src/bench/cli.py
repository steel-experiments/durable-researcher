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
    concurrency: int = typer.Option(6),
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


def _resolve_results_dir(
    results_dir: Path, benchmark: str, judge_model: str | None
) -> tuple[Path, str | None]:
    """Resolve the results directory for a benchmark + judge model.

    Returns (resolved_dir, detected_model_name).
    Supports both new layout (results/{benchmark}/{model}/) and
    legacy flat layout (results/{benchmark}/).
    """
    bench_base = results_dir / benchmark

    if judge_model:
        return bench_base / judge_model, judge_model

    # Auto-detect: look for model subdirectories
    if bench_base.exists():
        model_dirs = sorted(p.name for p in bench_base.iterdir() if p.is_dir())
        if model_dirs:
            return bench_base / model_dirs[0], model_dirs[0]

    # Fallback: flat layout (legacy) — results/{benchmark}/*.jsonl
    return bench_base, None


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
            "model": "gemini-3.1-pro-preview",
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

    # Rate limit: requests per minute (0 = no limit)
    rpm_str = (
        os.environ.get(f"{bm}_JUDGE_RPM")
        or os.environ.get("JUDGE_RPM")
    )
    rpm = int(rpm_str) if rpm_str else 0

    return {"model": model, "temperature": temperature, "thinking_level": thinking_level, "rpm": rpm}


@app.command()
def judge(
    benchmark: str = typer.Argument(..., help="Benchmark: researchrubrics or draco"),
    data_dir: Path = typer.Option("data"),
    responses_dir: Path = typer.Option("responses"),
    results_dir: Path = typer.Option("results"),
    model: Optional[str] = typer.Option(None, help="Override judge model"),
    concurrency: int = typer.Option(20, help="Max concurrent judge API calls"),
    limit: Optional[int] = typer.Option(None, help="Max tasks to judge"),
    batch: bool = typer.Option(False, help="Use Gemini Batch API (50% cost, async)"),
    yes: bool = typer.Option(False, "-y", "--yes", help="Skip confirmation prompts"),
) -> None:
    """Judge agent reports using LLM-as-judge with benchmark-specific prompts and config."""
    from bench.data import load_benchmark
    from bench.judge import Judge, RateLimitExceeded, estimate_judge_cost

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

    if batch and not config["model"].strip().lower().startswith("gemini-"):
        console.print("[red]Batch mode is only supported for Gemini models.[/red]")
        raise typer.Exit(1)

    config_desc = f"model={config['model']}"
    if config["temperature"] is not None:
        config_desc += f", temp={config['temperature']}"
    if config["thinking_level"]:
        config_desc += f", thinking={config['thinking_level']}"
    if config["rpm"]:
        config_desc += f", rpm={config['rpm']}"

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
        rpm=config["rpm"],
    )

    effective_concurrency = j.effective_concurrency
    if effective_concurrency != concurrency:
        console.print(
            f"  Requested concurrency {concurrency} reduced to [bold]{effective_concurrency}[/bold]"
        )
    if j.concurrency_note:
        console.print(f"  [dim]{j.concurrency_note}[/dim]")

    # Cost estimate and confirmation
    mode = "batch" if batch else "realtime"
    estimate = estimate_judge_cost(
        judge_tasks,
        bench_results_dir,
        config["model"],
        benchmark,
        mode=mode,
        thinking_level=config["thinking_level"],
    )
    if estimate["remaining_criteria"] == 0:
        console.print("[yellow]All criteria already judged — nothing to do.[/yellow]")
        raise typer.Exit(0)

    mode_label = "batch" if batch else "real-time"

    console.print(f"\n  Criteria to judge: [bold]{estimate['remaining_criteria']}[/bold] of {estimate['total_criteria']} ({estimate['total_criteria'] - estimate['remaining_criteria']} cached)")
    console.print(f"  Estimated tokens:  ~{estimate['est_input_tokens']:,} input + ~{estimate['est_output_tokens']:,} output")
    if estimate["est_cost_usd"] is not None:
        console.print(f"  Estimated cost:    [bold]${estimate['est_cost_usd']:.2f}[/bold] ({mode_label})")
    else:
        console.print(f"  Estimated cost:    [yellow]unavailable[/yellow] ({mode_label})")
    if estimate["pricing"]:
        pricing_mode = "exact" if estimate["pricing_exact"] else "fallback"
        console.print(f"  Pricing source:    {estimate['pricing_label']} ({pricing_mode})")
    else:
        console.print(f"  Pricing source:    {estimate['pricing_label']}")
    console.print()

    if not yes:
        confirm = typer.confirm("Proceed?", default=True)
        if not confirm:
            console.print("[yellow]Aborted.[/yellow]")
            raise typer.Exit(0)

    if batch:
        all_verdicts = j.judge_batch(
            judge_tasks, bench_results_dir,
            on_status=lambda msg: console.print(f"  [dim]{msg}[/dim]"),
        )
    else:
        # Real-time mode — canary check first
        with console.status("Running canary check (1 criterion)..."):
            try:
                asyncio.run(j.canary_check(judge_tasks, bench_results_dir))
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

        try:
            all_verdicts = asyncio.run(_run_with_progress())
        except RateLimitExceeded as e:
            console.print(f"\n[red bold]RATE LIMIT ABORT:[/red bold] {e}")
            console.print("[yellow]Partial results saved. Re-run to resume from where it stopped.[/yellow]")
            raise typer.Exit(1)

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

    bench_results_dir, detected_model = _resolve_results_dir(results_dir, benchmark, judge_model)
    if detected_model and not judge_model:
        console.print(f"Auto-detected judge model: {detected_model}")

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
    responses_dir: Path = typer.Option("responses"),
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

    bench_results_dir, detected_model = _resolve_results_dir(results_dir, benchmark, judge_model)
    if detected_model and not judge_model:
        console.print(f"Auto-detected judge model: {detected_model}")

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

    usage_by_task = {}
    usage_dir = responses_dir / benchmark
    for score in scores:
        usage_path = usage_dir / f"{score.task_id}.usage.json"
        if not usage_path.exists():
            continue
        try:
            usage_by_task[score.task_id] = json.loads(usage_path.read_text())
        except json.JSONDecodeError:
            console.print(f"[yellow]Skipping invalid usage file:[/yellow] {usage_path}")

    report_text = generate_report(
        scores,
        benchmark,
        usage_by_task=usage_by_task or None,
    )

    if output:
        save_report(report_text, output)
        console.print(f"Report saved to {output}")
    else:
        console.print(report_text)


@app.command()
def compare(
    benchmark: str = typer.Argument(..., help="Benchmark: researchrubrics or draco"),
    baseline: Path = typer.Option(
        ..., help="Baseline results dir (e.g. results-baseline-15)"
    ),
    candidate: list[Path] = typer.Option(
        ...,
        "--candidate",
        help="Candidate results dir(s); pass --candidate multiple times for multi-way",
    ),
    judge_model: str = typer.Option(
        ..., help="Judge model subdir (e.g. glm-4.7-flashx)"
    ),
    data_dir: Path = typer.Option("data", help="Benchmark dataset directory"),
    out: Optional[Path] = typer.Option(None, help="Write markdown report to this path"),
) -> None:
    """Compare task scores across one baseline and one or more candidate result dirs."""
    from bench.compare import (
        compute_comparison,
        format_comparison_report,
        load_run_scores,
        save_comparison_report,
    )

    data_path = _resolve_data_path(benchmark, data_dir)
    if not data_path.exists():
        console.print(
            f"[red]Dataset not found at {data_path}. Run 'bench download {benchmark}' first.[/red]"
        )
        raise typer.Exit(1)

    baseline_scores = load_run_scores(
        results_dir=baseline,
        benchmark=benchmark,
        judge_model=judge_model,
        data_path=data_path,
    )
    if not baseline_scores:
        console.print(
            f"[red]No verdicts found in baseline: "
            f"{baseline / benchmark / judge_model}[/red]"
        )
        raise typer.Exit(1)

    candidate_score_maps = []
    candidate_labels = []
    for cand_dir in candidate:
        scores = load_run_scores(
            results_dir=cand_dir,
            benchmark=benchmark,
            judge_model=judge_model,
            data_path=data_path,
        )
        if not scores:
            console.print(
                f"[yellow]Warning: no verdicts found in candidate "
                f"{cand_dir / benchmark / judge_model}[/yellow]"
            )
        candidate_score_maps.append(scores)
        candidate_labels.append(cand_dir.name)

    comparison = compute_comparison(
        baseline=baseline_scores,
        candidates=candidate_score_maps,
        candidate_labels=candidate_labels,
        baseline_label=baseline.name,
    )

    markdown = format_comparison_report(
        comparison,
        benchmark=benchmark,
        judge_model=judge_model,
        baseline_label=baseline.name,
        candidate_labels=candidate_labels,
    )

    if out:
        save_comparison_report(markdown, out)
        console.print(f"[green]Comparison report written to {out}[/green]")
    console.print(markdown)


DEFAULT_SCOREBOARD_DB = Path("runs/scoreboard.sqlite")
DEFAULT_SCOREBOARD_MD = Path("runs/SCOREBOARD.md")


def _ensure_scoreboard_dir(db_path: Path, md_path: Path) -> None:
    """Make sure the parent dir exists for the sqlite db and markdown output."""
    for p in (db_path, md_path):
        p.parent.mkdir(parents=True, exist_ok=True)


@app.command()
def scoreboard(
    benchmark: str = typer.Option(
        None, help="Filter to a single benchmark (default: all benchmarks in DB)"
    ),
    db: Path = typer.Option(
        DEFAULT_SCOREBOARD_DB, help="Path to scoreboard sqlite DB"
    ),
    limit: int = typer.Option(20, help="Max runs to show per benchmark"),
) -> None:
    """Print recent runs from the sqlite scoreboard with delta-vs-previous."""
    from bench.scoreboard import latest_runs, render_markdown

    if not db.exists():
        console.print(
            f"[yellow]No scoreboard at {db}. Run 'bench finalize' first.[/yellow]"
        )
        raise typer.Exit(0)

    if benchmark:
        rows = latest_runs(db, benchmark=benchmark, limit=limit)
        if not rows:
            console.print(f"[yellow]No runs for benchmark={benchmark}[/yellow]")
            raise typer.Exit(0)
        table = Table(title=f"{benchmark} scoreboard")
        table.add_column("run_id")
        table.add_column("ts")
        table.add_column("sha")
        table.add_column("agent")
        table.add_column("n", justify="right")
        table.add_column("mean", justify="right")
        table.add_column("Δ", justify="right")
        table.add_column("judge")
        for i, r in enumerate(rows):
            prev_score = rows[i + 1].mean_score if i + 1 < len(rows) else None
            if prev_score is None:
                delta = "—"
            else:
                d = r.mean_score - prev_score
                sign = "+" if d > 0 else ""
                delta = f"{sign}{d:.3f}"
            table.add_row(
                r.run_id,
                r.ts.replace("T", " ").replace("+00:00", "Z"),
                (r.git_sha or "—")[:7],
                r.agent_model or "—",
                str(r.n_tasks),
                f"{r.mean_score:.3f}",
                delta,
                r.judge_model or "—",
            )
        console.print(table)
    else:
        # Render the full markdown across all benchmarks
        md = render_markdown(db, benchmark=None, limit=limit)
        console.print(md)


@app.command()
def finalize(
    benchmark: str = typer.Argument(
        ..., help="Benchmark: researchrubrics or draco"
    ),
    results_dir: Path = typer.Option(
        ..., help="Results dir holding {benchmark}/{judge_model}/*.jsonl"
    ),
    judge_model: str = typer.Option(
        ..., help="Judge model subdir (e.g. glm-4.7-flashx)"
    ),
    data_dir: Path = typer.Option("data", help="Benchmark dataset directory"),
    db: Path = typer.Option(
        DEFAULT_SCOREBOARD_DB, help="Path to scoreboard sqlite DB"
    ),
    markdown: Path = typer.Option(
        DEFAULT_SCOREBOARD_MD,
        help="Path to write the regenerated SCOREBOARD.md",
    ),
    agent_model: str = typer.Option(None, help="Override the agent_model column"),
    agent_depth: str = typer.Option(None, help="Override the agent_depth column"),
    agent_max_sources: int = typer.Option(
        None, help="Override the agent_max_sources column"
    ),
    judge_mode: str = typer.Option(
        None, help="Override the judge_mode column (realtime|batch)"
    ),
    wall_seconds: int = typer.Option(None, help="Wall time in seconds for this run"),
    cost_usd: float = typer.Option(None, help="Estimated USD cost for this run"),
    notes: str = typer.Option(None, help="Free-form notes attached to this run"),
    run_id: str = typer.Option(
        None, help="Explicit run_id (default: random 12-hex)"
    ),
    project_root: Path = typer.Option(
        "..", help="Project root for git rev-parse / git status"
    ),
) -> None:
    """Read verdicts under results_dir/<benchmark>/<judge_model>/ and insert one
    row in the sqlite scoreboard. Regenerates SCOREBOARD.md from the DB."""
    from bench.data import load_benchmark
    from bench.scoreboard import (
        finalize_run,
        git_head_sha,
        git_is_dirty,
        render_markdown,
    )

    data_path = _resolve_data_path(benchmark, data_dir)
    if not data_path.exists():
        console.print(
            f"[red]Dataset not found at {data_path}. Run 'bench download {benchmark}' first.[/red]"
        )
        raise typer.Exit(1)

    tasks = load_benchmark(benchmark, data_path)
    criteria_by_task = {t.task_id: t.criteria for t in tasks}

    sha = git_head_sha(project_root.resolve())
    dirty = git_is_dirty(project_root.resolve())

    _ensure_scoreboard_dir(db, markdown)

    rid = finalize_run(
        db_path=db,
        results_dir=results_dir,
        benchmark=benchmark,
        judge_model=judge_model,
        criteria_by_task=criteria_by_task,
        git_sha=sha,
        git_dirty=dirty,
        agent_model=agent_model,
        agent_depth=agent_depth,
        agent_max_sources=agent_max_sources,
        judge_mode=judge_mode,
        wall_seconds=wall_seconds,
        cost_usd=cost_usd,
        notes=notes,
        run_id=run_id,
    )

    console.print(f"[green]Recorded run {rid}[/green] in {db}")

    md = render_markdown(db, benchmark=None, limit=20)
    markdown.write_text(md + "\n")
    console.print(f"Regenerated {markdown}")


@app.command()
def eval(
    benchmark: str = typer.Argument(..., help="Benchmark: researchrubrics or draco"),
    results_dir: Path = typer.Option(
        ..., help="Results dir for verdicts (e.g. results-latest)"
    ),
    responses_dir: Path = typer.Option(
        Path("responses"), help="Responses dir for agent reports"
    ),
    data_dir: Path = typer.Option("data", help="Benchmark dataset directory"),
    db: Path = typer.Option(
        DEFAULT_SCOREBOARD_DB, help="Path to scoreboard sqlite DB"
    ),
    markdown: Path = typer.Option(
        DEFAULT_SCOREBOARD_MD, help="Path to SCOREBOARD.md"
    ),
    depth: str = typer.Option("quick"),
    max_sources: int = typer.Option(10),
    concurrency: int = typer.Option(6),
    timeout: int = typer.Option(900),
    limit: int = typer.Option(None, help="Limit number of tasks (debugging)"),
    judge_model: str = typer.Option(None, help="Override judge model"),
    judge_concurrency: int = typer.Option(20),
    batch: bool = typer.Option(False, help="Use Gemini Batch API for judging"),
    notes: str = typer.Option(None, help="Free-form notes attached to this run"),
    project_root: Path = typer.Option(
        "..", help="Project root for git + bench.ts"
    ),
) -> None:
    """Orchestrator: run → judge → score → report → finalize in one command.

    Note: this is a convenience wrapper for the common eval-loop. For more
    granular control, invoke run/judge/score/finalize separately.
    """
    import time

    from rich.progress import (
        BarColumn,
        MofNCompleteColumn,
        Progress,
        TextColumn,
        TimeElapsedColumn,
    )

    from bench.data import load_benchmark
    from bench.runner import run_benchmark, RunResult as _RunResult

    data_path = _resolve_data_path(benchmark, data_dir)
    if not data_path.exists():
        console.print(
            f"[red]Dataset not found at {data_path}. Run 'bench download {benchmark}' first.[/red]"
        )
        raise typer.Exit(1)

    tasks = load_benchmark(benchmark, data_path)
    if limit:
        tasks = tasks[:limit]

    console.print(f"[bold]bench eval[/bold] benchmark={benchmark} n={len(tasks)} depth={depth}")
    started = time.monotonic()

    # 1. Run
    task_tuples = [(t.task_id, t.benchmark, t.prompt) for t in tasks]

    import asyncio

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
                elapsed_s = f"{result.duration_seconds:.0f}s" if result.duration_seconds > 0 else "cached"
                progress.console.print(f"  {result.task_id[:12]}… {status} ({elapsed_s})")
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

    asyncio.run(_run_with_progress())

    # 2. Judge
    judge_config = _resolve_judge_config(benchmark)
    if judge_model:
        judge_config["model"] = judge_model
    console.print(f"\n[bold]Judging[/bold] with {judge_config['model']}")
    from bench.judge import Judge, estimate_judge_cost

    judge_tasks = []
    for task in tasks:
        report_path = responses_dir / benchmark / f"{task.task_id}.md"
        if report_path.exists() and report_path.stat().st_size > 0:
            judge_tasks.append((task.task_id, report_path, task.criteria, task.prompt))

    if judge_tasks:
        bench_results_dir = results_dir / benchmark / judge_config["model"]
        j = Judge(
            model=judge_config["model"],
            benchmark=benchmark,
            max_concurrent=judge_concurrency,
            temperature=judge_config["temperature"],
            thinking_level=judge_config["thinking_level"],
            rpm=judge_config["rpm"],
        )
        if batch and judge_config["model"].strip().lower().startswith("gemini-"):
            j.judge_batch(
                judge_tasks, bench_results_dir,
                on_status=lambda msg: console.print(f"  [dim]{msg}[/dim]"),
            )
        else:
            asyncio.run(j.judge_benchmark(judge_tasks, bench_results_dir))

    wall = int(time.monotonic() - started)

    # 3. Finalize — invoke as a function call so the user sees the same output path
    finalize(
        benchmark=benchmark,
        results_dir=results_dir,
        judge_model=judge_config["model"],
        data_dir=data_dir,
        db=db,
        markdown=markdown,
        agent_model=None,
        agent_depth=depth,
        agent_max_sources=max_sources,
        judge_mode="batch" if batch else "realtime",
        wall_seconds=wall,
        cost_usd=None,
        notes=notes,
        run_id=None,
        project_root=project_root,
    )


if __name__ == "__main__":
    app()
