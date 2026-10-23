import { describe, expect, it } from 'vitest';
import { redactCredentialText } from './AgentCredentialRedaction';

describe('redactCredentialText', () => {
  it('reads text a repository controls in linear time and still finds the credentials in it', () => {
    // A job log or a file can hold these shapes; each made a pattern read on from every word boundary.
    for (const hostile of ['a-'.repeat(100_000), 'eyJ-'.repeat(50_000)]) {
      const startedAt = performance.now();
      expect(redactCredentialText(`${hostile} OPENAI_API_KEY=opaque-provider-key`)).toBe(`${hostile} OPENAI_API_KEY=[REDACTED]`);
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    }
    // A name's prefix of any depth, joined by either separator, still names the credential.
    expect(redactCredentialText('MY_TEAM_SERVICE_PROD_EU_WEST_1_DB_ADMIN_PASSWORD=hunter2 my-app-client-secret: abc'))
      .toBe('MY_TEAM_SERVICE_PROD_EU_WEST_1_DB_ADMIN_PASSWORD=[REDACTED] my-app-client-secret: [REDACTED]');
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactCredentialText(`token ${jwt} "${jwt}" url=https://example.test/?t=${jwt}`))
      .toBe('token [REDACTED] "[REDACTED]" url=https://example.test/?t=[REDACTED]');
    // A JWT right after a hyphen, as a flag or a joined name writes it.
    expect(redactCredentialText(`--jwt-${jwt} --${jwt}`)).toBe('--jwt-[REDACTED] --[REDACTED]');
  });
});
