# Incident: an acknowledged completion is missing from the daily report

## What users see

A client records a completion for an existing task. The service answers `201 Created` and returns
the new completion, with its ID, the task ID and the requested `completed_at` instant. When the
client then asks for the daily completion report for that date in UTC, the count does not include
the completion it was just given. Reading the report again some seconds later shows the same
count, so the completion never shows up.

## When it happens

It has been seen only while the service is busy with many requests at once, and only when, at
about the same moment, another client tries to record a completion for a task that does not exist
(that request correctly gets `404 Not Found`). With light traffic, every acknowledged completion is
counted.

Nothing else looks wrong: no request fails with a server error, no error is reported to either
client, and response times stay normal.

## Expected behavior

Every completion the service answers with `201` is kept and counted by the daily report for its
date, as the service's contract says (behaviors C-7 and C-8), however busy the service is and
whatever other requests arrive at the same time.
