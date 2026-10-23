import { localError } from "./errors.js";
export function workOptions({ fixedWorkMs = 0, researchEffort = "standard" } = {}, coordination = {}) {
    if (!Number.isSafeInteger(fixedWorkMs) || fixedWorkMs < 0 || (fixedWorkMs && fixedWorkMs < 60000))
        throw localError("invalid_arguments", "--fixed-work must be at least 1m.");
    if (!["standard", "persistent"].includes(researchEffort))
        throw localError("invalid_arguments", "--research-effort is standard or persistent.");
    if ((fixedWorkMs || researchEffort !== "standard") && coordination.enabled)
        throw localError("invalid_arguments", "Work-window experiments require simultaneous startup and any-agent completion; disable planner/quorum.");
    return { fixedWorkMs, researchEffort };
}
export function workTriggers(until, options) {
    if (!options.fixedWorkMs) return until;
    return [...until.filter(x => /^(check|budget)\s/.test(x)), `after ${options.fixedWorkMs / 1000}s`];
}
export function workPrompt(options, deadline, now) {
    const lines = [];
    if (options.fixedWorkMs) lines.push(`Fixed working window ends at ${new Date(deadline).toISOString()}. Remaining: ${Math.max(0, Math.ceil((deadline-now)/1000))} seconds. There is no early finish: DONE and passing checks do not end this run. After your turn ends, the host will wake you again. Continue useful task work until the deadline. Check time with date -u. Keep your best verified report, figures and reproducible code ready; all agents are stopped and artifacts frozen at the deadline. Budget exhaustion, infrastructure failure or owner cancellation may stop the run earlier.`);
    if (options.researchEffort === "persistent") lines.push("Use the available time to produce the strongest scientifically justified answer. Do not say DONE merely because a report exists or a completion check passes. Identify and address consequential gaps: incomplete requirements, untested assumptions, implementation errors, missing experiments or baselines, weak validation and unsupported conclusions. Coordinate to avoid duplicate work and conflicting edits. Prioritize scientific substance over cosmetic changes. If your assignment is finished, independently verify a key claim, review another member's results or take on the highest-priority remaining task. Retain evidence-supported improvements and revert unsuccessful changes. Never fabricate results or claim unperformed experiments. If investigation yields no improvement, report that honestly; do not manufacture changes to appear busy. Keep a reproducible, internally consistent report ready. Do not modify TASK.md or these rules.");
    return lines.join("\n");
}
