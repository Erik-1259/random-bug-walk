# Roadmap

This file lists planned work beyond the current release. An item here is a plan, not a feature: nothing it describes is available until a release says so, and no figure for it counts as measured until the runs below are done.

## Open behaviors on Umami

**Goal.** Let a customer build an open behavior on Umami: any non-security Umami behavior a customer describes, graded by a rule the customer can edit, as open behaviors work on the task-report service.

**Why it is not in the current release.** Today Umami builds only the proven time-zone grouping behavior. An Umami card about anything else is translated into the closest equivalent failure in the task-report service and built there, or refused as out of scope. The builder's Umami path is built around Umami's date-grouped reports, while the task-report qualification is generic. The full reasoning is in [Why open behaviors are built only on the task-report service](otf/SPEC.md#810-why-open-behaviors-are-built-only-on-the-task-report-service).

**What it takes.**
- An Umami lane runner and lane instructions that accept an arbitrary open rule (family, observable failure and failure code), not only the time-zone behavior.
- An admission and qualification sequence that works for any Umami behavior, not just the date-grouped reports. It must keep the current qualification checks: the original suite passes on clean, buggy and fixed copies, and the added checks fail only on the buggy copy, with the rule's failure code.
- Measured build times and costs from paid runs, since Umami's original suite is much larger and slower than the task-report suite.
- Umami's out-of-scope areas (sign-in, identity, permissions and races) stay excluded.

**How it will be measured.** Paid builder runs on a set of open Umami specs, recording the build time and the model cost for each qualified bug, along with the attempt and qualification counts. Until those runs are done and committed as evidence, Umami open behaviors are labeled "not measured yet", and no time, cost or success rate is shown for them.

**Status.** Planned, after the hackathon.
