import { createHmac } from "node:crypto";
import { localError } from "./errors.js";
import { detectRuntime } from "./runtime-detection.js";
/** The driver's session, when the driver exposes one. See runtime-detection.ts. */
export function detectRuntimeSession(env) {
    const detected = detectRuntime(env, { parentProcess: () => null });
    return detected.anchor === null ? null : { runtimeKind: detected.kind, anchor: detected.anchor };
}
export function computeLocalInstanceKey(installationSecret, runtimeKind, providerSessionAnchor) {
    let key;
    try {
        key = Buffer.from(installationSecret, "base64url");
    }
    catch {
        throw localError("invalid_local_state", "The installation secret is invalid.");
    }
    if (key.byteLength !== 32) {
        throw localError("invalid_local_state", "The installation secret is invalid.");
    }
    if (!providerSessionAnchor) {
        throw localError("runtime_session_not_detected", "The current runtime session could not be detected.");
    }
    return createHmac("sha256", key)
        .update(`${runtimeKind}\0${providerSessionAnchor}`, "utf8")
        .digest("hex");
}
