export type RuntimeKind = string;
export interface RuntimeSession {
    runtimeKind: RuntimeKind;
    anchor: string;
}
type Environment = Record<string, string | undefined>;
/** The driver's session, when the driver exposes one. See runtime-detection.ts. */
export declare function detectRuntimeSession(env: Environment): RuntimeSession | null;
export declare function computeLocalInstanceKey(installationSecret: string, runtimeKind: RuntimeKind, providerSessionAnchor: string): string;
export {};
