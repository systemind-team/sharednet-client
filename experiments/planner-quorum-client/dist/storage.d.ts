import { type SeatWake } from "./wake-driver.ts";
type Environment = Record<string, string | undefined>;
export interface StoragePaths {
    configDir: string;
    credentialsFile: string;
    installationFile: string;
    stateDir: string;
    sessionsDir: string;
    /** One file per seat: rooms/<room_id>/<member_id>.json, so two Agents on one machine can sit in one Room. */
    roomsDir: string;
}
/**
 * A guest seat in one Room: the member token the join handed back, owner-only
 * under the config directory, never inside a project tree.
 */
export interface StoredRoomCredential {
    schema_version: 1;
    base_url: string;
    room_id: string;
    member_id: string;
    name: string;
    member_token: string;
    joined_at: string;
    /** The session that took the seat, which `serve` resumes when the seat is addressed. */
    wake?: SeatWake;
}
/**
 * The per-project cursor: which Room this checkout is in and the last
 * sequence it has seen. Nothing here is secret, and the directory ignores
 * itself so it never rides into a commit.
 */
/** One seat's view of the directory's Room: what say, wait and watch act as. */
export interface ProjectRoomState {
    schema_version: 1;
    base_url: string;
    room_id: string;
    member_id: string;
    last_sequence: number;
}
/**
 * The directory's Room, with every seat this directory has taken in it and
 * a cursor per seat. Two Agent sessions in one checkout are two seats, each
 * tied to its own session by `anchor_key` (the local Instance key derived
 * from the driver's session id and this machine's installation secret; never
 * the raw session id), so neither ever speaks or reads as the other.
 */
export interface ProjectRoom {
    schema_version: 2;
    base_url: string;
    room_id: string;
    seats: Record<string, ProjectSeat>;
}
export interface ProjectSeat {
    last_sequence: number;
    anchor_key: string | null;
    joined_at: string | null;
}
export declare const PROJECT_STATE_DIR = ".sharednet";
export interface StoredApiCredential {
    schema_version: 1;
    base_url: string;
    principal_id: string;
    api_key_id: string;
    api_key: string;
    installation_secret: string;
    created_at: string;
    expires_at: string | null;
}
export interface StoredSession {
    schema_version: 1;
    base_url: string;
    principal_id: string;
    /** The tag this Instance was under when the session file was written; null when untagged. */
    agent_id: string | null;
    instance_id: string;
    local_instance_key: string | null;
    instance_token: string;
    created_at: string;
    lease_expires_at: string;
    /** Always null since Instances became permanent; kept so old files still parse. */
    expires_at: string | null;
}
export declare function getStoragePaths(env?: Environment): StoragePaths;
export declare function readStoredApiCredential(paths: StoragePaths): Promise<StoredApiCredential | null>;
/** Written by `sharednet login`; owner-only, and never printed back. */
export declare function writeStoredApiCredential(paths: StoragePaths, credential: StoredApiCredential): Promise<void>;
export declare function getOrCreateInstallationSecret(paths: StoragePaths): Promise<string>;
export declare function writeSession(paths: StoragePaths, session: StoredSession): Promise<void>;
export declare function listSessions(paths: StoragePaths): Promise<StoredSession[]>;
export declare function readSessionById(paths: StoragePaths, instanceId: string): Promise<StoredSession | null>;
export declare function deleteSession(paths: StoragePaths, instanceId: string): Promise<void>;
export declare function writeRoomCredential(paths: StoragePaths, credential: StoredRoomCredential): Promise<void>;
export declare function readRoomCredential(paths: StoragePaths, roomId: string, memberId: string): Promise<StoredRoomCredential | null>;
export declare function readProjectRoom(cwd: string): Promise<ProjectRoom | null>;
/**
 * Records one seat's cursor in the directory's Room. A different Room
 * replaces the file: a directory is in one Room at a time. `anchorKey` ties
 * the seat to the session that took it; omitted, an existing tie is kept.
 */
export declare function writeProjectRoomState(cwd: string, state: ProjectRoomState, options?: {
    anchorKey?: string | null;
    joinedAt?: string;
}): Promise<void>;
/**
 * The seat this call acts as. In order: `--as` or SHAREDNET_SEAT; the seat
 * tied to this session; the only seat there is. Two seats and no way to
 * tell them apart is refused rather than guessed, since guessing is how one
 * session ends up speaking as another.
 */
export declare function selectProjectSeat(cwd: string, choice: {
    explicit?: string;
    anchorKey: string | null;
}): Promise<ProjectRoomState | null>;
export {};
