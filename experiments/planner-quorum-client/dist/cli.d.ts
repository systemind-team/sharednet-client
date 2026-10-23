import { type CommandRunner } from "./guest.ts";
import { type DockerRunner } from "./goal-run.ts";
import type { TurnRunner } from "./wake-driver.ts";
type Environment = Record<string, string | undefined>;
export interface CliDependencies {
    env?: Environment;
    fetch?: typeof globalThis.fetch;
    stdout?: (value: string) => void;
    stderr?: (value: string) => void;
    now?: () => Date;
    /** Where per-project Room state lives; defaults to the process working directory. */
    cwd?: string;
    /** Pause between empty long-polls in `wait`; tests shorten it. */
    sleep?: (ms: number) => Promise<void>;
    /** Opens the approve page during `login`; tests capture the URL instead. */
    openBrowser?: (url: string) => Promise<boolean>;
    /** Runs the `watch --run` command; tests capture it instead of shelling out. */
    exec?: CommandRunner;
    /** Runs `docker` for `goal run`; tests replace it. */
    docker?: DockerRunner;
    /** The running CLI's entry file, mounted into `goal run`'s container; defaults to this process's. */
    cliEntry?: string;
    /** Ends a resident command such as `serve --push`; a person ends it with Ctrl-C instead. */
    signal?: AbortSignal;
    /** Runs one resumed turn of a seat's own session in `serve`; tests replace it. */
    runTurn?: TurnRunner;
    /** Starts `serve` in the background after a join; only the real process (main.ts) supplies it. */
    startWakeService?: (input: {
        env: Environment;
        logFile: string;
    }) => number | null;
}
export declare function runCli(argv: string[], supplied?: CliDependencies): Promise<number>;
export {};
