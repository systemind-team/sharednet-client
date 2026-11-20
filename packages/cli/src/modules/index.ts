/**
 * The harness's module slots, beside its fixed core (containers, network, accounts, the turn
 * loop, the record). Each slot has one default, today's behaviour, so a `goal run` without module
 * options runs exactly as before; a run that sets them records which it used (`modules` in the
 * run record), so two runs can be told apart by their modules alone.
 *
 *   slot         option(s)                         default      module file
 *   state        --task-judge, --activity-view     off, off     state.ts
 *   topology     --topology                        all          topology.ts
 *   protocol     --message-schema                  free         protocol.ts
 *   information  --probe, --probe-every            none         information.ts
 *   environment  --env-push, --env-audience        off          environment.ts
 *   workspace    --workspace-layout, --land-check  shared       workspace.ts
 *
 * See docs/harness-modules.md for what each slot is for and what an experiment changes in it.
 */
import type { EnvironmentModule } from "./environment.ts";
import type { Probe } from "./information.ts";
import type { MessageSchema } from "./protocol.ts";
import type { TaskJudge } from "./state.ts";
import type { Topology } from "./topology.ts";
import type { WorkspaceModule } from "./workspace.ts";

export interface HarnessModules {
  taskJudge: TaskJudge;
  activityView: boolean;
  topology: Topology;
  messageSchema: MessageSchema;
  probe: Probe | null;
  environment: EnvironmentModule;
  workspace: WorkspaceModule;
}

export const DEFAULT_MODULES: HarnessModules = Object.freeze({
  taskJudge: "off",
  activityView: false,
  topology: Object.freeze({ kind: "all" }) as Topology,
  messageSchema: "free",
  probe: null,
  environment: Object.freeze({ push: "off", audience: "affected", watch: Object.freeze([]) as unknown as EnvironmentModule["watch"] }) as EnvironmentModule,
  workspace: Object.freeze({ layout: "shared", landCheck: null }) as WorkspaceModule,
}) as HarnessModules;

export function isDefaultModules(modules: HarnessModules): boolean {
  return modules.taskJudge === "off" && !modules.activityView && modules.topology.kind === "all" && modules.messageSchema === "free" && modules.probe === null && modules.environment.push === "off" && modules.workspace.layout === "shared";
}

/** What a run record says about its modules. */
export function describeModules(modules: HarnessModules): Record<string, unknown> {
  return {
    state: { task_judge: modules.taskJudge, activity_view: modules.activityView },
    topology: modules.topology.kind === "islands" ? `islands:${modules.topology.count}` : "all",
    protocol: modules.messageSchema,
    information: modules.probe ? { probe: modules.probe.command, every_ms: modules.probe.everyMs } : null,
    environment: modules.environment.push === "off" ? null : { push: modules.environment.push, audience: modules.environment.audience, ...(modules.environment.watch.length > 0 ? { watch: modules.environment.watch.map((root) => root.mount) } : {}) },
    workspace: modules.workspace.layout === "shared" ? null : { layout: modules.workspace.layout, land_check: modules.workspace.landCheck },
  };
}

/** The environment a seat's own `sharednet` needs for the modules that act inside its container. */
export function seatEnvironment(modules: HarnessModules): string[] {
  return [
    ...(modules.taskJudge !== "off" ? ["-e", `SHAREDNET_TASK_JUDGE=${modules.taskJudge}`] : []),
    ...(modules.messageSchema !== "free" ? ["-e", `SHAREDNET_MESSAGE_SCHEMA=${modules.messageSchema}`] : []),
  ];
}
