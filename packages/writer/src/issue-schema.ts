import { z } from "zod";

/** The user-style bug report the model writes. */
export const IssueOutputSchema = z
  .object({
    title: z.string().min(1),
    reproduction_steps: z.array(z.string().min(1)).min(1),
    expected_result: z.string().min(1),
    actual_result: z.string().min(1),
    environment: z.string().min(1),
  })
  .strict();
export type IssueOutput = z.infer<typeof IssueOutputSchema>;

/** Text fields of an issue, each with the name the check report uses for it. */
export function issueFields(issue: IssueOutput): { field: string; text: string }[] {
  return [
    { field: "title", text: issue.title },
    ...issue.reproduction_steps.map((text, index) => ({ field: `reproduction_steps[${String(index)}]`, text })),
    { field: "expected_result", text: issue.expected_result },
    { field: "actual_result", text: issue.actual_result },
    { field: "environment", text: issue.environment },
  ];
}
