/** Standalone wire view: the published CLI has no server or protocol runtime dependency. */
export interface CompiledState {
  protocol_version: string;
  sequence: number;
  digest: string;
  projection: unknown;
  obligations: string;
  events: unknown[];
}

export const COMPILED_HELP = [
  "This is a compiled Room. Chat is nonbinding; typed acts change the shared work state.",
  "  sharednet open --json    current projection, canonical events and your obligations",
  `  sharednet act --data '{"type":"work.request","work_id":"W","to":"i_PEER","task":"Task","requires":[{"kind":"deliverables","names":["patch"]},{"kind":"verified_by","verifier":"i_REVIEWER"}]}' --json`,
  `  sharednet act --data '{"type":"work.accept","work_id":"W"}' --json`,
  "  sharednet deliver --work W --name patch --file PATH --json    upload actual bytes and submit work.result",
  "  sharednet deliver --work W --artifact patch=PATH --artifact report=PATH --json    submit all required files in one result",
  "  sharednet upload report.txt --json    upload independent review evidence",
  `  sharednet act --data '{"type":"verification.pass","work_id":"W","requirement":"REQUIREMENT_ID","result_ref":"CURRENT_RESULT","evidence":"art_REPORT_ID"}' --json`,
  `  sharednet act --data '{"type":"work.resolve","work_id":"W"}' --json`,
  "Lifecycle types: work.request, work.accept, work.decline, work.result, work.cancel, work.resolve, verification.pass, verification.fail, human.approve, human.reject.",
  "The generic act command accepts lifecycle envelopes. Read the current result_ref with open; download and check the delivered artifact, then upload the real check report before reviewing. Never invent evidence or artifact IDs.",
].join("\n");

export function compiledPrompt(state: CompiledState, includeHelp = true): string {
  return `${includeHelp ? `${COMPILED_HELP}\n\n` : ""}Your current obligations (typed sequence ${state.sequence}, digest ${state.digest}):\n${state.obligations}\n\nCurrent projection:\n${JSON.stringify(state.projection)}`;
}
