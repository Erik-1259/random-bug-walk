# Bug discovery and evaluation answer different questions

**Research note — 17 October 2026.** This note explains methodological distinctions and proposes directions for future exploration. It does not change the [admission rules](admission-rules.md), the [implemented pipeline](bug-generation-pipeline.md), the [UC1 pre-registration](uc1-preregistration.md), or any completed result. It introduces no new execution mode or implementation commitment.

## A useful bug is more than a code change

A faulty edit is a starting point. A useful experimental case also needs a correct reference state, a meaningful behavioral failure, a reproducible environment, an independent way to check the result, and a clear statement of the question it answers.

Requiring one case to be realistic, reliably reproducible, missed by existing tests, hard to diagnose from source, and improved by a particular tool greatly narrows the candidate set. Failure at one of those requirements does not make the case useless for every other purpose. The distinctions below are especially relevant when exploring concurrency bugs.

| Question | Evidence that answers it | What it does not establish |
|---|---|---|
| Does a harness distinguish faulty from correct behavior? | The clean and repaired states pass an independent behavioral check; the planted state produces the specified mismatch | A test-suite blind spot or a difficult debugging task |
| Does an ordinary suite miss the defect? | The unchanged suite passes while added checks distinguish the defect; an RBW claim also needs the full admission profile | That agents cannot diagnose it, or that runtime evidence helps them |
| Can an agent diagnose or repair the defect? | A declared task, information set, budget, and independent assessment of its answer or submitted repair | Performance with other prompts, models, budgets, or workspaces |
| Does a developer tool help? | A separately specified comparison on a chosen endpoint, with the intended difference in tool access | General effectiveness from one selected example |

A known reference repair helps validate the case; it is not evidence that an agent independently repaired it. Missing executions, setup errors, and unrelated crashes are not successful detections of the intended defect.

## What the current RBW rules require

RBW admission concerns a test-suite blind spot under a declared profile. [ADM-08](admission-rules.md#rules) requires the original suite to pass across the profile's copies and the added checks to produce their declared outcomes. A local clean/planted/fixed demonstration is preliminary evidence, not a substitute for admission, release, or hosted replay.

Static difficulty is a separate concern. The [pipeline's static-headroom discussion](bug-generation-pipeline.md#the-static-headroom-screen) describes the concern behind selecting a case for a logs comparison. The [UC1 protocol](uc1-preregistration.md#bug-selection) defines that experiment's selection requirements and its separately described fallback. Those requirements remain in force. They should not be read as a universal definition of a useful bug or of every possible future tool evaluation.

A future study could measure verified repair, time to diagnosis, or evidence completeness instead of requiring source-only diagnosis to fail. Each would need its own declared endpoint and comparison before evaluation. Changing the question after observing the answer would not validate the original claim.

## Why concurrency alone does not ensure difficulty

Recognizing that code permits a race, reproducing a particular interleaving, explaining an incident, and verifying a repair are different tasks. A source reader may recognize a possible race immediately while runtime evidence still helps establish which operations overlapped or which state was observed.

Artificial source complexity is a poor substitute for a plausible failure mechanism. More files, less descriptive names, or extra indirection do not by themselves establish a useful debugging problem. A small controlled application can isolate a mechanism; an existing application can provide context and constraints that the controlled example omits. Neither choice establishes representativeness on its own.

For a concurrency case, an explicit schedule is useful only if it is feasible under the declared execution model. Test coordination should expose a permitted interleaving, not create a state the application could never reach. Repetition and delays alone do not show why a failure occurred or how often it occurs in ordinary use.

## What related research supports

| Source | Relevant lesson | Boundary of the evidence |
|---|---|---|
| [SWE-smith](https://arxiv.org/html/2504.21798v1) | Several mutation approaches can produce executable repair tasks | Its accepted mutations break existing passing tests. That differs from RBW's original-suite-survival objective, and training-task scale is not an expected yield for blind-spot discovery |
| [Anchored Self-Play for Code Repair](https://proceedings.mlr.press/v306/choi26f.html) | Increasing difficulty on self-generated bugs can diverge from performance on more realistic tasks; reference examples can help constrain that drift | Its evidence concerns Python function-level repair with test feedback, including deliberately injected human edits; it does not establish a concurrency-specific strategy |
| [CHESS](https://static.usenix.org/events/osdi08/tech/full_papers/musuvathi/musuvathi_html/index.html) | Controlled exploration and replay of schedules can expose concurrency failures missed by stress testing | Its scheduling implementation is not a drop-in solution for an arbitrary application/database stack, and reproduction is not the same as diagnosis |
| [Defects4J](https://github.com/rjust/defects4j) | Curated faulty/fixed versions, triggering tests, and reproducible environments make historical bugs useful research artifacts | Its historical Java cases differ from newly planted faults; transferring a patch to another version or application needs fresh validation |

These sources motivate candidate diversity, reproducibility, and reference cases. They do not establish that a custom application is generally better than an existing application, or predict how many candidates will satisfy RBW admission.

## Proposed exploration before integration

The following is a research proposal, not an alternative admission path or a description of newly implemented automation. It can be recorded in ordinary candidate notes without adding a new framework.

- **Establish the semantic fault first.** State the invariant, plausible workload, reference behavior, faulty behavior, and an independent oracle. Confirm the clean baseline before interpreting the planted result.
- **Check the intended use cheaply.** Run the frozen ordinary suite and a focused reproduction in separate disposable copies. Record whether the suite catches the defect. Preserve a valid case as a control or repair task even when it is unsuitable for the blind-spot claim.
- **For concurrency, establish causality.** Record the shared state, operation boundaries, evidence of overlap, sequential and different-target controls, and why the chosen interleaving is possible. Distinguish controlled-schedule reproduction from natural occurrence rates.
- **Keep dispositions separate.** Record semantic validity, ordinary-suite behavior, repeatability, measured diagnosis or repair results, and estimated integration work. Do not assign an admission or tool-benefit label from these preliminary checks.
- **Commit to full integration only for the intended question.** Packaging, issue generation, formal admission, publication, and a solver comparison serve different purposes. A promising local result still has to pass every applicable existing requirement.

Broader exploration could combine historical fixes, different mutation mechanisms, and multiple host applications. Reversing a historical fix is a candidate-generation technique, not evidence that the transferred defect behaves correctly in a new host.

## Specifications and experimental separation

Precise behavioral specifications help identify real failures. Prescribing the exact correct implementation to a test author or solver also supplies information that can make a case easier. Future records should distinguish the following:

- the required behavior and permitted outcomes;
- the author's fault mechanism and reference repair;
- the ordinary-suite author's inputs and any exposure to the candidate;
- the solver's incident report, source, tests, tools, and budget;
- the independent oracle used to judge behavior or a submitted repair.

These distinctions call for honest provenance, not removing tests or rewriting completed results. Existing ordinary suites stay unchanged. A future historical dataset may use a documented pre-regression suite plus a separate triggering regression test, but that is a different declared dataset design.

Candidate selection and effect confirmation also need separation. Examples selected because preliminary trials showed a positive tool effect can illustrate feasibility; they cannot by themselves estimate the tool's effect on an unselected population. Future evaluation should disclose selection, preserve failures and inconclusive outcomes, and use independent confirmation appropriate to its claim.

The current Umami demonstration, release records, admission rules, and UC1 protocol remain the authority for what RBW has done and what its existing claims mean. This note adds vocabulary for future decisions, not new results.
