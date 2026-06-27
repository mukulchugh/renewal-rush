#!/usr/bin/env python3
"""Validate Renewal Rush premise research against committed evidence."""

from __future__ import annotations

import json
import sys
from pathlib import Path

GAME_LAB = Path(__file__).resolve().parents[1]
GAME_SCRIPT = GAME_LAB / "data" / "game-script.json"
EVIDENCE = GAME_LAB / "data" / "premise-research-evidence.json"
LANDING = GAME_LAB / "data" / "quivly-landing.json"

REQUIRED_BENCHMARKS = {
    "PagerTron",
    "Wizlympics",
    "Unicorn Startup Simulator",
    "Renewal Rush (Unreal FPS)",
}

REQUIRED_OPTIONS = {
    "signal-triage",
    "renewal-run",
    "next-best-action",
    "signal-sort",
}

REQUIRED_PATTERN_FRAGMENTS = [
    "one input",
    "product metaphor",
    "score",
    "end card",
    "embeddable",
]

REQUIRED_LOOP_STEPS = [
    "timer",
    "healthy",
    "at-risk",
    "deploy",
    "churn",
    "speed",
    "end screen",
]

FORBIDDEN_BENCHMARK_PHRASES = [
    "squash bugs",
    "mom's basement",
    "die in your",
]


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def assert_true(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def validate_evidence_artifacts(evidence: dict, errors: list[str]) -> None:
    for artifact in evidence.get("artifacts", []):
        rel = artifact.get("path", "")
        full = GAME_LAB / rel
        assert_true(full.exists(), f"evidence artifact missing on disk: {rel}", errors)


def validate_benchmark_provenance(data: dict, evidence: dict, errors: list[str]) -> None:
    pr = data["premiseResearch"]
    evidence_benchmarks = evidence.get("benchmarks", {})
    quotes_by_name = {
        name: " ".join(info.get("verbatimQuotes", []) + info.get("blogQuotes", []))
        for name, info in evidence_benchmarks.items()
    }

    for bench in pr.get("benchmarks", []):
        name = bench.get("name")
        blob = json.dumps(bench).lower()
        for phrase in FORBIDDEN_BENCHMARK_PHRASES:
            assert_true(phrase not in blob, f"benchmark {name} contains unverified phrase: {phrase}", errors)

        assert_true(bench.get("sourceUrl"), f"{name} missing sourceUrl", errors)
        assert_true(bench.get("sourceArtifact"), f"{name} missing sourceArtifact", errors)
        assert_true(bench.get("sourceQuote"), f"{name} missing sourceQuote", errors)

        artifact_path = GAME_LAB / bench["sourceArtifact"]
        assert_true(artifact_path.exists(), f"{name} sourceArtifact not found: {bench['sourceArtifact']}", errors)

        if name in quotes_by_name:
            quote_blob = quotes_by_name[name].lower()
            # At least one substantive token from evidence must appear in sourceQuote
            tokens = [t for t in quote_blob.replace("...", " ").split() if len(t) > 4]
            if tokens:
                sq = bench["sourceQuote"].lower()
                assert_true(any(t in sq for t in tokens[:8]), f"{name} sourceQuote not grounded in evidence", errors)


def validate_premise_research(data: dict, errors: list[str]) -> None:
    pr = data.get("premiseResearch")
    assert_true(isinstance(pr, dict), "premiseResearch section missing", errors)
    if not isinstance(pr, dict):
        return

    assert_true(bool(pr.get("researchedAt")), "premiseResearch.researchedAt missing", errors)
    assert_true(pr.get("evidenceFile") == "data/premise-research-evidence.json", "evidenceFile path wrong", errors)

    conclusion = (pr.get("conclusion") or "").lower()
    assert_true("browser" in conclusion, "conclusion must mention browser pattern", errors)

    names = {b.get("name") for b in pr.get("benchmarks", [])}
    missing = REQUIRED_BENCHMARKS - names
    assert_true(not missing, f"benchmarks missing: {sorted(missing)}", errors)

    pattern = " ".join(pr.get("pattern", [])).lower()
    for fragment in REQUIRED_PATTERN_FRAGMENTS:
        assert_true(fragment in pattern, f"pattern missing fragment: {fragment}", errors)

    option_ids = {o.get("id") for o in pr.get("options", [])}
    missing_opts = REQUIRED_OPTIONS - option_ids
    assert_true(not missing_opts, f"options missing: {sorted(missing_opts)}", errors)

    signal = next((o for o in pr.get("options", []) if o.get("id") == "signal-triage"), None)
    assert_true(signal is not None and signal.get("recommended") is True, "signal-triage must have recommended:true", errors)

    assert_true(pr.get("recommendedPremise") == "signal-triage", "recommendedPremise must be signal-triage", errors)
    assert_true(pr.get("unrealFpsStatus") == "demoted-to-learning-sandbox", "unrealFpsStatus must demote Unreal FPS", errors)


def validate_premise_and_loop(data: dict, errors: list[str]) -> None:
    premise = data.get("premise", {})
    assert_true(premise.get("selectedOption") == "signal-triage", "premise.selectedOption must be signal-triage", errors)

    hook = (premise.get("hook") or "").lower()
    assert_true("renewal" in hook, "premise.hook must mention renewal week/day", errors)

    beats = " ".join(premise.get("storyBeats", [])).lower()
    for fragment in ["arr", "health", "draft ready", "rank"]:
        assert_true(fragment in beats, f"storyBeats missing: {fragment}", errors)

    loop = data.get("gameplayLoop", {})
    assert_true("click" in (loop.get("input") or "").lower() or "tap" in (loop.get("input") or "").lower(), "gameplayLoop.input must be click/tap", errors)

    steps = " ".join(loop.get("steps", [])).lower()
    for fragment in REQUIRED_LOOP_STEPS:
        assert_true(fragment in steps, f"gameplayLoop.steps missing: {fragment}", errors)


def validate_meta_and_build(data: dict, errors: list[str]) -> None:
    meta = data.get("meta", {})
    assert_true(meta.get("platformRecommendation") == "browser-first", "meta.platformRecommendation must be browser-first", errors)

    pillars = " ".join(data.get("pillars", [])).lower()
    for fragment in ["browser", "one mechanic", "metaphor", "share"]:
        assert_true(fragment in pillars, f"pillars missing: {fragment}", errors)

    primary = data.get("buildPlan", {}).get("primary", [])
    primary_text = " ".join(primary).lower()
    assert_true("index.html" in primary_text or "canvas" in primary_text, "buildPlan.primary must target Game Lab canvas prototype", errors)


def validate_landing_alignment(game_script: dict, landing: dict, errors: list[str]) -> None:
    landing_steps = [step.get("name") for step in landing.get("productFlow", [])]
    expected = ["Connect", "See", "Score", "Act"]
    assert_true(landing_steps == expected, f"quivly-landing productFlow mismatch: {landing_steps}", errors)

    mapping = game_script.get("premiseResearch", {}).get("selectedPremise", {}).get("productMapping", {})
    for step in expected:
        assert_true(step.lower() in mapping, f"selectedPremise.productMapping missing {step}", errors)


def main() -> int:
    errors: list[str] = []

    for path in (GAME_SCRIPT, EVIDENCE, LANDING):
        assert_true(path.exists(), f"missing required file: {path}", errors)

    if errors:
        for err in errors:
            print(f"  - {err}")
        return 1

    data = load_json(GAME_SCRIPT)
    evidence = load_json(EVIDENCE)
    landing = load_json(LANDING)

    validate_premise_research(data, errors)
    validate_evidence_artifacts(evidence, errors)
    validate_benchmark_provenance(data, evidence, errors)
    validate_premise_and_loop(data, errors)
    validate_meta_and_build(data, errors)
    validate_landing_alignment(data, landing, errors)

    if errors:
        print("FAIL: premise research validation")
        for err in errors:
            print(f"  - {err}")
        return 1

    print("PASS: premise research validation")
    print(f"  status: {data.get('meta', {}).get('status')}")
    print(f"  recommended: {data.get('premiseResearch', {}).get('recommendedPremise')}")
    print(f"  evidence artifacts: {len(evidence.get('artifacts', []))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())