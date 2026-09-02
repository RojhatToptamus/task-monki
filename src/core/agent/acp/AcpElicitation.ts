import type {
  AgentInteractionDecision,
  AgentInteractionRequestPayload,
  AgentJsonValue,
  AgentMcpElicitationRequest,
  AgentUserInputQuestion,
  AgentUserInputRequest,
  InteractionRequestType
} from '../../../shared/agent';
import type { AcpCreateFormElicitationParams } from './AcpProtocol';

type MappedAcpElicitation =
  | { type: 'USER_INPUT'; request: AgentUserInputRequest }
  | { type: 'MCP_ELICITATION'; request: AgentMcpElicitationRequest };

const CUSTOM_ANSWER_META_KEY = '_askUserQuestionCustomAnswer';

export function mapAcpFormElicitation(
  input: AcpCreateFormElicitationParams,
  providerName: string
): MappedAcpElicitation {
  const questions = mapAskUserQuestions(input);
  if (questions) {
    return { type: 'USER_INPUT', request: { questions } };
  }
  return {
    type: 'MCP_ELICITATION',
    request: {
      mode: 'form',
      serverName: providerName,
      message: input.message,
      requestedSchema: input.requestedSchema as Record<string, AgentJsonValue>
    }
  };
}

export function mapAcpElicitationResponse(
  type: InteractionRequestType,
  request: AgentInteractionRequestPayload,
  decision: AgentInteractionDecision
): { action: 'accept'; content: AgentJsonValue } | { action: 'decline' | 'cancel' } {
  if (type === 'MCP_ELICITATION' && decision.interactionType === 'MCP_ELICITATION') {
    return decision.action === 'ACCEPT'
      ? { action: 'accept', content: decision.content }
      : { action: decision.action === 'DECLINE' ? 'decline' : 'cancel' };
  }
  if (type !== 'USER_INPUT' || decision.interactionType !== 'USER_INPUT') {
    throw new Error('ACP elicitation response does not match the pending interaction.');
  }

  const content: Record<string, AgentJsonValue> = {};
  for (const question of (request as AgentUserInputRequest).questions) {
    const answers = decision.answers[question.id] ?? [];
    const optionLabels = new Set(question.options?.map((option) => option.label) ?? []);
    const custom = answers.filter((answer) => !optionLabels.has(answer));
    if (custom.length > 0) {
      content[`${question.id}_custom`] = custom.join(', ');
    } else if (question.allowsMultiple) {
      content[question.id] = answers;
    } else {
      content[question.id] = answers[0] ?? '';
    }
  }
  return { action: 'accept', content };
}

function mapAskUserQuestions(
  input: AcpCreateFormElicitationParams
): AgentUserInputQuestion[] | undefined {
  const properties = input.requestedSchema.properties;
  if (!isRecord(properties)) return undefined;
  const entries = Object.entries(properties);
  const questionEntries = entries.filter(([key]) => /^question_\d+$/u.test(key));
  if (questionEntries.length === 0) return undefined;

  const questions = questionEntries
    .sort(([left], [right]) => questionIndex(left) - questionIndex(right))
    .map(([id, value]) =>
      mapAskUserQuestion(input, properties, id, value, questionEntries.length)
    );
  if (questions.some((question) => question === undefined)) return undefined;

  const recognizedKeys = new Set(
    questionEntries.flatMap(([id]) => [id, `${id}_custom`])
  );
  if (entries.some(([key]) => !recognizedKeys.has(key))) return undefined;
  return questions as AgentUserInputQuestion[];
}

function mapAskUserQuestion(
  input: AcpCreateFormElicitationParams,
  properties: Record<string, unknown>,
  id: string,
  value: unknown,
  questionCount: number
): AgentUserInputQuestion | undefined {
  if (!isRecord(value)) return undefined;
  const allowsMultiple = value.type === 'array';
  const optionValues = allowsMultiple
    ? isRecord(value.items) && Array.isArray(value.items.anyOf)
      ? value.items.anyOf
      : undefined
    : value.type === 'string' && Array.isArray(value.oneOf)
      ? value.oneOf
      : undefined;
  if (!optionValues?.length) return undefined;

  const options = optionValues.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.const !== 'string') return undefined;
    if (candidate.title !== undefined && candidate.title !== candidate.const) return undefined;
    return {
      label: candidate.const,
      description: typeof candidate.description === 'string' ? candidate.description : ''
    };
  });
  if (options.some((option) => option === undefined)) return undefined;

  const header = typeof value.title === 'string' && value.title.trim()
    ? value.title
    : `Choice ${questionIndex(id) + 1}`;
  const question = typeof value.description === 'string' && value.description.trim()
    ? value.description
    : questionCount === 1
      ? input.message
      : undefined;
  if (!question) return undefined;

  return {
    id,
    header,
    question,
    isOther: isCustomAnswerProperty(properties[`${id}_custom`], id),
    isSecret: false,
    ...(allowsMultiple ? { allowsMultiple: true } : {}),
    options: options as Array<{ label: string; description: string }>
  };
}

function isCustomAnswerProperty(value: unknown, questionId: string): boolean {
  if (!isRecord(value) || value.type !== 'string' || !isRecord(value._meta)) return false;
  const marker = value._meta[CUSTOM_ANSWER_META_KEY];
  return (
    isRecord(marker) &&
    marker.questionId === questionId &&
    marker.isCustomAnswer === true
  );
}

function questionIndex(value: string): number {
  return Number(value.slice('question_'.length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
