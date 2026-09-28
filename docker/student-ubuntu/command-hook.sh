# Linux Lab command logging. Sourced by /etc/bash.bashrc for every
# interactive shell (including nested ones).
#
# Reports to the exam server, as invisible terminal control sequences
# (OSC 7337) that the server strips before output reaches the browser:
#   - "cmd" just BEFORE a command runs (via PS0): history number, working
#     directory, command line. Reporting first means even a command that
#     tries to disable logging is itself logged.
#   - "exit" when the prompt returns (via PROMPT_COMMAND): its exit status.
#
# The functions and variables are made read-only so they can't be unset or
# redefined in this shell. Only command lines are reported, never keystrokes
# typed into programs, so input at password prompts is never captured.

if [[ $- == *i* && -z ${__LL_HOOKED-} ]]; then
  __LL_HOOKED=1

  __ll_cmd() {
    local entry
    entry=$(HISTTIMEFORMAT='' builtin history 1)
    [[ $entry =~ ^[[:space:]]*([0-9]+)[*]?[[:space:]]+(.*)$ ]] || return 0
    builtin printf '\033]7337;v2;cmd;%s;%s;%s\007' "${BASH_REMATCH[1]}" \
      "$(builtin printf '%s' "$PWD" | base64 -w0)" \
      "$(builtin printf '%s' "${BASH_REMATCH[2]:0:4096}" | base64 -w0)"
  }

  __ll_exit() {
    local status=$? entry
    # Log repeated commands and ones starting with a space too.
    HISTCONTROL=
    entry=$(HISTTIMEFORMAT='' builtin history 1)
    if [[ $entry =~ ^[[:space:]]*([0-9]+) ]]; then
      builtin printf '\033]7337;v2;exit;%s;%s\007' "${BASH_REMATCH[1]}" "$status"
    fi
    return $status
  }

  PS0="\$(__ll_cmd)${PS0-}"
  PROMPT_COMMAND="__ll_exit${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  readonly -f __ll_cmd __ll_exit
  readonly PS0 PROMPT_COMMAND __LL_HOOKED
fi
