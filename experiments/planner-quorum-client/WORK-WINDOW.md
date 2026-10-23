# Optional working-window experiment
Version 0.1.12-work-window.1. Independent copy of planner-quorum.3; existing deployment untouched.
Default behavior unchanged. These flags require simultaneous startup / any-agent completion and reject enabled planner/quorum.

- `--fixed-work 30m`: removes said/count/message/idle/other time end triggers, retains diagnostic checks and token safety limit, installs after 1800s. Deadline measured from server goal.started_at (includes container startup). Passing checks and DONE cannot close early. Exact DONE receives remaining-time feedback even with quiet checks. Each seat retains a serial loop, with a 10-second timer wake when no messages arrive, until deadline or safety stop. Failed seats retain baseline failure behavior; no experimental redistribution.
- `--research-effort persistent`: adds research-specific diligence/verification instructions at opening and every wake. Does not change early termination rules by itself.

Three arms: time-only (fixed-work), prompt-only (research-effort), both. All start simultaneously. No four-arms, planner-first, quorum, or REOPEN protocols. Prompt-only retains legacy 45m maximum and may finish early. All three receive the same 15M fresh-token ceiling. This ceiling excludes cached tokens, as in the baseline; usage reporting is not an instantaneous hard billing limit.

Fixed mode does not guarantee 30m of successful inference: failures, budget exhaustion, service/owner closure or host guards can interrupt. Record these separately. Deadline triggers stopping containers; shutdown/export can take additional seconds. Final queue artifacts are frozen only after containers stop; workspace.git snapshots taken by the watcher before stopping are not the final submission.

Evidence: episode.work_policy records flags/deadline; work-window.ndjson records DONE ignored and continuation wakes; wakes.ndjson retains per-turn start/end/failure; checks.ndjson records diagnostic checks. No model calls in offline tests.
