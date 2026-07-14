import { describe, expect, it } from 'vitest';
import {
  ACP_RUNTIME_PROFILES,
  CURSOR_ACP_PROFILE,
  GEMINI_ACP_PROFILE,
  GROK_ACP_PROFILE,
  CLAUDE_AGENT_ACP_PROFILE,
  acpCapabilities
} from './AcpRuntimeProfiles';

describe('ACP runtime profiles', () => {
  it('defines unique first-class runtime identities', () => {
    const ids = ACP_RUNTIME_PROFILES.map((profile) => profile.descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'gemini-acp',
      'grok-acp',
      'cursor-agent-acp',
      'claude-agent-acp'
    ]);
  });

  it('uses provider-native ACP launch forms', () => {
    expect(GEMINI_ACP_PROFILE.argv).toEqual(['--acp']);
    expect(GROK_ACP_PROFILE.argv).toEqual(['--no-auto-update', 'agent', 'stdio']);
    expect(CURSOR_ACP_PROFILE.argv).toEqual(['acp']);
    expect(CURSOR_ACP_PROFILE.discoveryIdentity?.argv).toEqual(['help', 'acp']);
    expect(CLAUDE_AGENT_ACP_PROFILE.argv).toEqual([]);
  });

  it('enables optional lifecycle features only after negotiation', () => {
    expect(acpCapabilities(GEMINI_ACP_PROFILE).sessionResume.maturity).toBe('inferred');
    expect(
      acpCapabilities(GEMINI_ACP_PROFILE, {
        resume: false,
        loadSession: false,
        close: false,
        prompt: {}
      }).sessionResume.maturity
    ).toBe('unsupported');
    expect(
      acpCapabilities(GEMINI_ACP_PROFILE, {
        resume: true,
        close: true,
        prompt: { image: true }
      }).sessionResume.maturity
    ).toBe('stable');
    expect(
      acpCapabilities(GEMINI_ACP_PROFILE, {
        close: true,
        prompt: {}
      }).extensions.sessionClose?.maturity
    ).toBe('stable');
  });

  it('never claims Task Monki client terminal execution', () => {
    for (const profile of ACP_RUNTIME_PROFILES) {
      expect(acpCapabilities(profile).backgroundTerminals.maturity).toBe('unsupported');
    }
  });
});
