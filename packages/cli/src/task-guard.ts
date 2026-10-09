/** Installed into each opted-in agent container, never the host. Only bash built-ins on the hot path. */
export const TASK_PROFILE = String.raw`# SharedNet cooperative task gate (not a security sandbox).
[ "$SHAREDNET_TASK_GATE" = 1 ] || return 0
[ -n "$BASH_VERSION" ] || return 0
[ -n "$BASH_EXECUTION_STRING" ] || return 0
[ -n "$SHAREDNET_TASK_FILE" ] && [ -s "$SHAREDNET_TASK_FILE" ] && return 0
_sn_communication_only() {
  [[ "$BASH_EXECUTION_STRING" =~ ^[[:space:]]*(/usr/local/bin/)?sharednet([[:space:]]|$) ]] || return 1
  local c quote='' escaped=0
  while IFS= read -r -n 1 c; do
    if [[ "$quote" == "'" ]]; then
      [[ "$c" == "'" ]] && quote=''
      continue
    fi
    if (( escaped )); then escaped=0; continue; fi
    if [[ "$c" == \\ ]]; then escaped=1; continue; fi
    case "$c" in '$'|$'\x60') return 1 ;; esac
    if [[ "$quote" == '"' ]]; then
      [[ "$c" == '"' ]] && quote=''
      continue
    fi
    case "$c" in
      "'"|'"') quote="$c" ;;
      ';'|'&'|'|'|'<'|'>'|'('|')'|'#') return 1 ;;
      '') break ;;
    esac
  done <<< "$BASH_EXECUTION_STRING"
  [[ -z "$quote" ]] && (( ! escaped )) && [[ "$BASH_EXECUTION_STRING" != *$'\n'* ]]
}
if _sn_communication_only; then
  unset -f _sn_communication_only
  return 0
fi
unset -f _sn_communication_only
if [ -n "$SHAREDNET_TASK_AUDIT" ]; then
  printf '%s\tblocked\t%q\n' "$EPOCHREALTIME" "$BASH_EXECUTION_STRING" >> "$SHAREDNET_TASK_AUDIT"
fi
printf '%s\n' 'SharedNet: first claim a task with sharednet task claim "<title>" before running work commands. Run sharednet commands alone, without shell chaining.' >&2
exit 2
`;

export const TASK_HELP = 'Before doing work, understand the goal and claim a task title with sharednet task claim "<title>". When teammates have added tasks you have not seen, a claim first shows you the recent tasks and claims nothing: compare your title with them, and if your work is not the same as any of them, run the same claim again. Use sharednet task list to see all titles. Choose your own tasks; titles differing only by case or whitespace are the same. Only the winning claimant may work on that task and mark it done with sharednet task done "<title>". Run sharednet commands alone, without cd, shell chaining or substitutions when you hold no task. All work tools, including direct file edits, require a held task; the shell enforces shell calls and other tools are audited. Claims and completions do not wake teammates: when a teammate is waiting on your task, tell them with sharednet say. Task done does not end the Room.';
export const MENTION_HELP = 'Recognize the teammates listed above. Use @exact-teammate-name for information or requests a particular teammate needs, and @all for changes everyone needs. Before you say something (including task claim/done), sharednet checks for addressed messages newer than your receipt watermark. If it returns unread_mentions, your post was NOT sent: those messages are now in the tool output. Consider them and explicitly retry or revise your post; you do not have to answer them. Read output advances a separate local read watermark; it does not acknowledge a runner wake.';

/** Claude PreToolUse speaks JSON on stdin/stdout. Reuse the shell validator without executing the pending command. */
export const TASK_HOOK = String.raw`
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
if (process.env.SHAREDNET_TASK_GATE !== '1') process.exit(0);
try { if (fs.statSync(process.env.SHAREDNET_TASK_FILE).size > 0) process.exit(0); } catch {}
let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); }
catch { process.stderr.write('SharedNet: invalid tool input; claim a task before work.'); process.exit(2); }
if (input.tool_name === 'Bash' && typeof input.tool_input?.command === 'string') {
  const check = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', 'BASH_EXECUTION_STRING="$SHAREDNET_PENDING_COMMAND"; . "$SHAREDNET_TASK_PROFILE"'], {
    env: {...process.env, SHAREDNET_PENDING_COMMAND: input.tool_input.command}, encoding: 'utf8'
  });
  if (check.status === 0) process.exit(0);
}
process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'SharedNet: claim a task with sharednet task claim "<title>" before using work tools.'}}));
`;
export const TASK_HOOK_SETTINGS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node /usr/local/lib/sharednet-task-hook.cjs" }] }] } });
