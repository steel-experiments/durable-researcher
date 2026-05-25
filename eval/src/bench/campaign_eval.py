# ABOUTME: Campaign-specific evaluation dimensions for long-running durable research.
# ABOUTME: Computes quality/runtime, quality/cost, plateau, auditability, freshness, and resume correctness metrics.

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable


@dataclass(frozen=True)
class CampaignSnapshot:
    """One scored checkpoint from a campaign run."""

    label: str
    score: float
    runtime_seconds: float
    cost_usd: float
    supported_claims: int
    total_claims: int
    source_dates: list[datetime]
    resume_failures: int = 0
    duplicate_sources: int = 0
    lost_sources: int = 0


@dataclass(frozen=True)
class CampaignEvalSummary:
    """Aggregated campaign eval dimensions."""

    best_score: float
    best_label: str
    quality_per_hour: float
    quality_per_dollar: float | None
    plateau_detected: bool
    plateau_label: str | None
    auditability_rate: float
    freshness_rate: float
    resume_correct: bool


def _sorted_snapshots(
    snapshots: Iterable[CampaignSnapshot],
) -> list[CampaignSnapshot]:
    return sorted(snapshots, key=lambda s: s.runtime_seconds)


def detect_plateau(
    snapshots: Iterable[CampaignSnapshot],
    *,
    min_snapshots: int = 3,
    epsilon: float = 0.01,
) -> tuple[bool, str | None]:
    """Return whether later snapshots stopped improving meaningfully.

    Plateau means the last `min_snapshots - 1` score deltas are all below epsilon.
    """
    ordered = _sorted_snapshots(snapshots)
    if len(ordered) < min_snapshots:
        return False, None
    window = ordered[-min_snapshots:]
    deltas = [
        window[i].score - window[i - 1].score
        for i in range(1, len(window))
    ]
    plateau = all(delta < epsilon for delta in deltas)
    return plateau, window[0].label if plateau else None


def auditability_rate(snapshot: CampaignSnapshot) -> float:
    if snapshot.total_claims <= 0:
        return 1.0
    return max(0.0, min(1.0, snapshot.supported_claims / snapshot.total_claims))


def freshness_rate(
    snapshot: CampaignSnapshot,
    *,
    cutoff: datetime | None = None,
) -> float:
    """Fraction of dated sources at or after cutoff.

    Defaults to one year before now. Sources without dates should be excluded by
    the caller; freshness cannot be inferred from missing dates.
    """
    if not snapshot.source_dates:
        return 0.0
    if cutoff is None:
        now = datetime.now(timezone.utc)
        cutoff = now.replace(year=now.year - 1)
    fresh = sum(1 for d in snapshot.source_dates if d >= cutoff)
    return fresh / len(snapshot.source_dates)


def resume_correct(snapshot: CampaignSnapshot) -> bool:
    return (
        snapshot.resume_failures == 0
        and snapshot.duplicate_sources == 0
        and snapshot.lost_sources == 0
    )


def summarize_campaign_eval(
    snapshots: Iterable[CampaignSnapshot],
    *,
    freshness_cutoff: datetime | None = None,
) -> CampaignEvalSummary:
    ordered = _sorted_snapshots(snapshots)
    if not ordered:
        raise ValueError("At least one campaign snapshot is required")

    best = max(ordered, key=lambda s: s.score)
    final = ordered[-1]
    hours = max(final.runtime_seconds / 3600, 1e-9)
    quality_per_hour = final.score / hours
    quality_per_dollar = None if final.cost_usd <= 0 else final.score / final.cost_usd
    plateau, plateau_label = detect_plateau(ordered)

    return CampaignEvalSummary(
        best_score=best.score,
        best_label=best.label,
        quality_per_hour=quality_per_hour,
        quality_per_dollar=quality_per_dollar,
        plateau_detected=plateau,
        plateau_label=plateau_label,
        auditability_rate=auditability_rate(final),
        freshness_rate=freshness_rate(final, cutoff=freshness_cutoff),
        resume_correct=all(resume_correct(s) for s in ordered),
    )
