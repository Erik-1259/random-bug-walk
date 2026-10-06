# Development evidence: local run of 2026-10-06

This run is development evidence from the local runner (`tools/local-runner`) on Docker. It makes no admission claim, it is not a validated release, and the planted bug is synthetic: it was introduced on purpose into a copy of Umami and is not a real Umami bug.

The run's root and execution IDs here are placeholders for this fixture.

## What this record holds

- `generated/symptom.json`: the observed symptom (an `ObservedSymptom`), copied from `tools/local-runner/candidates/umami-tz-arg-001/writer-input.json`. Its observed counts come from the planted copy's responses below.
- `results/<observation>/planted-01/`: the planted copy's response bodies for the four checks, round 1 of the observation job, copied from `tools/local-runner/candidates/umami-tz-arg-001/observed/`.

## What it does not hold

The kit-check and admission jobs' records (their evidence and decisions) are not part of this record, so it shows no original-suite or added-check results for the clean, planted and fixed copies.
