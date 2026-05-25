# ABOUTME: Tests campaign-specific eval dimensions for long-running research runs.
# ABOUTME: Covers plateau detection, auditability, freshness, cost/runtime, and resume correctness.

from datetime import datetime, timezone

from bench.campaign_eval import (
    CampaignSnapshot,
    auditability_rate,
    detect_plateau,
    freshness_rate,
    resume_correct,
    summarize_campaign_eval,
)


def test_detect_plateau_when_recent_scores_stop_improving():
    snapshots = [
        CampaignSnapshot("20m", 0.50, 1200, 1, 8, 10, []),
        CampaignSnapshot("2h", 0.62, 7200, 3, 9, 10, []),
        CampaignSnapshot("12h", 0.625, 43200, 7, 9, 10, []),
        CampaignSnapshot("24h", 0.627, 86400, 12, 9, 10, []),
    ]

    plateau, label = detect_plateau(snapshots, epsilon=0.01)

    assert plateau is True
    assert label == "2h"


def test_auditability_rate_counts_supported_claims():
    snapshot = CampaignSnapshot("final", 0.8, 1, 0, 17, 20, [])

    assert auditability_rate(snapshot) == 0.85


def test_freshness_rate_uses_cutoff():
    snapshot = CampaignSnapshot(
        "final",
        0.8,
        1,
        0,
        1,
        1,
        [
            datetime(2026, 1, 1, tzinfo=timezone.utc),
            datetime(2024, 1, 1, tzinfo=timezone.utc),
        ],
    )

    assert freshness_rate(
        snapshot,
        cutoff=datetime(2025, 1, 1, tzinfo=timezone.utc),
    ) == 0.5


def test_resume_correct_flags_duplicate_or_lost_state():
    ok = CampaignSnapshot("ok", 0.7, 1, 0, 1, 1, [])
    bad = CampaignSnapshot("bad", 0.7, 1, 0, 1, 1, [], duplicate_sources=1)

    assert resume_correct(ok) is True
    assert resume_correct(bad) is False


def test_summarize_campaign_eval_reports_new_dimensions():
    snapshots = [
        CampaignSnapshot("20m", 0.50, 1200, 2, 5, 8, []),
        CampaignSnapshot("2h", 0.700, 7200, 10, 7, 8, []),
        CampaignSnapshot("12h", 0.705, 43200, 20, 8, 8, []),
        CampaignSnapshot("24h", 0.709, 86400, 30, 8, 8, []),
    ]

    summary = summarize_campaign_eval(snapshots)

    assert summary.best_score == 0.709
    assert summary.best_label == "24h"
    assert summary.quality_per_dollar == 0.709 / 30
    assert summary.auditability_rate == 1.0
    assert summary.plateau_detected is True
    assert summary.resume_correct is True
