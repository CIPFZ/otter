import { describe, expect, it } from 'vitest';
import { assertInteractivePublish } from '../lib/publish-input.ts';

describe('first publish authentication input', () => {
  it('allows dry-run checks without a terminal or an OTP', () => {
    expect(() => assertInteractivePublish(['--dry-run'], {}, false, false)).not.toThrow();
  });

  it('requires interactive input for the actual publish', () => {
    expect(() => assertInteractivePublish([], {}, false, false)).toThrow('interactive terminal');
    expect(() => assertInteractivePublish([], {}, true, false)).toThrow('interactive terminal');
    expect(() => assertInteractivePublish([], {}, false, true)).toThrow('interactive terminal');
    expect(() => assertInteractivePublish([], {}, true, true)).not.toThrow();
  });

  it.each([['--otp=123456'], ['--otp', '123456'], ['--dry-run', '--otp=123456']])('rejects codes supplied before checks: %j', (...args) => {
    let message = '';
    try { assertInteractivePublish(args, {}, true, true); } catch (error) { message = String(error); }
    expect(message).toContain('Do not pass --otp');
    expect(message).not.toContain('123456');
  });

  it.each(['NPM_CONFIG_OTP', 'npm_config_otp', 'PNPM_CONFIG_OTP', 'pnpm_config_otp'])('rejects an inherited %s without exposing its value', (key) => {
    let message = '';
    try { assertInteractivePublish([], { [key]: '654321' }, true, true); } catch (error) { message = String(error); }
    expect(message).toContain('pre-set');
    expect(message).not.toContain('654321');
  });

  it('does not treat an empty OTP variable or unrelated authentication as a supplied code', () => {
    expect(() => assertInteractivePublish([], { npm_config_otp: '', NODE_AUTH_TOKEN: 'test-token' }, true, true)).not.toThrow();
  });
});
