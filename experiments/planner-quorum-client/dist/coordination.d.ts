import type { SeatRecord, WakeShape } from "./goal-run.js";

export interface CoordinationOptions {
    startupMode?: "simultaneous" | "planner-first";
    completionPolicy?: "any-agent" | "all-agents-done";
    plannerSeed?: string;
}
export interface ResolvedCoordinationOptions extends CoordinationOptions {
    enabled: boolean;
    startupMode: "simultaneous" | "planner-first";
    completionPolicy: "any-agent" | "all-agents-done";
}
export type CoordinationStatus = "running" | "completed" | "completed_degraded" | "failed" | "timeout" | "budget_exhausted" | "stopped";
export interface CoordinationSummary {
    schema_version: number;
    reopen_protocol: string;
    accepted_reopen_requests: number;
    coordination_revision: number;
    status: CoordinationStatus;
    startup_mode: string;
    completion_policy: string;
    planner_seed: string;
    planner_selections: Array<{ name: string; draw: number; candidates: string[]; reason: string; epoch: number }>;
    configured_roster: Array<{ name: string; member_id: string | null; driver: string; model: string | null; active: boolean }>;
    configured_count: number;
    started_count: number;
    participating_count: number;
    participating_models: Record<string, number>;
    participation_definition: string;
    remaining_count: number;
    remaining_models: Record<string, number>;
    exits: Array<Record<string, unknown>>;
    agents: Array<{ name: string; active: boolean; done: boolean; turns_started: number; successful_turns: number; consecutive_failures: number; outstanding_requests: Array<Record<string, unknown>> }>;
}
export declare function coordinationOptions(options?: CoordinationOptions, until?: string[]): ResolvedCoordinationOptions;
export declare function parseReopenRequest(content: unknown): { recipient: string; request_id: string; instruction: string } | null;
export declare function randomPicker(seed: string): (names: string[]) => { name: string; draw: number };
export declare class Coordination {
    constructor(input: {
        records: SeatRecord[];
        options: ResolvedCoordinationOptions;
        goal: string;
        roomId: string;
        until?: string[];
        runTurn: (seat: SeatRecord, prompt: string, wake: WakeShape) => Promise<boolean>;
        cancelTurn?: (seat: SeatRecord) => Promise<void>;
        notifyRecovery?: (content: string) => Promise<unknown>;
        recoveryGraceMs?: number;
        now?: () => Date;
        event?: (event: Record<string, unknown>) => void;
    });
    readonly allDoneMode: boolean;
    readonly ready: boolean;
    readonly idle: boolean;
    phase: "planning" | "work" | "failed";
    status: CoordinationStatus;
    revision: number;
    stopped: boolean;
    observe(message: WakeShape["messages"][number] & { sender_instance_id?: string }): void;
    tick(): void;
    checkFailed(feedback: string): void;
    approveCompletion(expectedRevision?: number): void;
    finish(end: { trigger: string; detail?: string | null } | null): void;
    summary(): CoordinationSummary;
    drain(): Promise<void>;
}
