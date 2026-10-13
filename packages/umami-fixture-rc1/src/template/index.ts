// The concurrency-check template: a host-agnostic library for race candidates. Give it a plan
// (how to set a context up, which request to fire, how to record each answer) and a grading (how
// to read an attempt and what counts as clean versus planted), and it fires the requests with
// controlled overlap, records harness-side timing, measures the overlap and classifies the burst.
// The RC-1 backup-code fixture is expressed through it; see ../race.ts and ../classify.ts, and the
// template-guide.md at the package root for how to define a new candidate's checks.

export { classifyConcurrent, classifyReuse, type RaceGrading, type ReuseGrading } from "./classify.ts";
export { fireConcurrent, fireOne, fireSequential, overlapOf } from "./fire.ts";
export type {
  ApiRequest,
  AttemptTiming,
  Burst,
  Clock,
  FireFailure,
  Grade,
  Graded,
  HttpResult,
  RecordAttempt,
  RequestContext,
  RequestOutcome,
  RequestPlan,
  Sequence,
  SetupResult,
  Verdict,
} from "./types.ts";
