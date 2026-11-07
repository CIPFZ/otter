/** Require npm's interactive 2FA flow so a code is requested at publication time, after checks. */
export function assertInteractivePublish(args: readonly string[], env: NodeJS.ProcessEnv, stdinIsTTY: boolean, stdoutIsTTY: boolean): void {
  if (args.some((arg) => /^--otp(?:=|$)/.test(arg))) {
    throw new Error('Do not pass --otp before the checks. Run without it and enter a fresh code when npm requests it.');
  }
  if (args.includes('--dry-run')) return;
  if (Object.entries(env).some(([key, value]) => /^(?:npm|pnpm)_config_otp$/i.test(key) && value !== undefined && value.trim() !== '')) {
    throw new Error('Remove the pre-set npm/pnpm OTP environment variable; enter a fresh code only when npm requests it.');
  }
  if (!stdinIsTTY || !stdoutIsTTY) {
    throw new Error('First publish needs an interactive terminal for npm 2FA (both stdin and stdout). Use --dry-run for non-interactive checks.');
  }
}
