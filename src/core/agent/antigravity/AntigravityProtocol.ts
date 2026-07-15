import type { AgentModel } from '../../../shared/agent';
import { ANTIGRAVITY_RUNTIME_ID } from './AntigravityCapabilities';

const MAX_CATALOG_BYTES = 128 * 1024;
const MAX_MODEL_COUNT = 256;
const MAX_MODEL_LABEL_BYTES = 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export function parseAntigravityModels(stdout: string): AgentModel[] {
  if (Buffer.byteLength(stdout) > MAX_CATALOG_BYTES) {
    throw new Error('Antigravity returned a model catalog larger than 128 KiB.');
  }
  const labels = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (labels.length === 0) {
    throw new Error('Antigravity returned an empty model catalog.');
  }
  if (labels.length > MAX_MODEL_COUNT) {
    throw new Error(`Antigravity returned more than ${MAX_MODEL_COUNT} models.`);
  }

  const seen = new Set<string>();
  return labels.map((label) => {
    if (
      Buffer.byteLength(label) > MAX_MODEL_LABEL_BYTES ||
      CONTROL_CHARACTER.test(label)
    ) {
      throw new Error('Antigravity returned a malformed model label.');
    }
    if (seen.has(label)) {
      throw new Error(`Antigravity returned duplicate model label ${label}.`);
    }
    seen.add(label);
    const modelProvider = antigravityModelProvider(label);
    return {
      id: `${ANTIGRAVITY_RUNTIME_ID}:${modelProvider}/${label}`,
      runtimeId: ANTIGRAVITY_RUNTIME_ID,
      modelProvider,
      model: label,
      displayName: label,
      description: 'Exact model label advertised by Antigravity.',
      hidden: false,
      supportedReasoningEfforts: [],
      serviceTiers: [],
      inputModalities: ['text'],
      isDefault: false,
      native: {
        source: 'agy models',
        advertisedLabel: label
      }
    };
  });
}

function antigravityModelProvider(label: string): string {
  if (/^Gemini\b/iu.test(label)) return 'google';
  if (/^Claude\b/iu.test(label)) return 'anthropic';
  if (/^GPT(?:-|\b)/iu.test(label)) return 'openai';
  return ANTIGRAVITY_RUNTIME_ID;
}
