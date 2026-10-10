import type {
  AgentCommandApprovalRequest,
  AgentInteractionDecision,
  AgentUserInputRequest,
  InteractionRequestRecord
} from '../../shared/contracts';
import { displayApprovalCommand } from './approvalCommand';

/**
 * The inline decisions offered on an Inbox row. A decision is
 * answerable in place only when the row shows everything it approves: a plain
 * command approval whose command fits whole on one line, with no policy
 * warning, network host, extra paths or provider-native choices. Everything
 * else — file changes that need their diff, permission profiles, warnings,
 * typed input and forms — opens the task, where the full request is shown.
 * Labels and order match the Agent tab so one decision has one name.
 */
export interface InboxInteractionDecisions {
  /** The command the decision applies to, exactly as the Agent tab shows it. */
  subject?: string;
  /** What the agent asks, when it waits for answers; the answers are given in the task. */
  question?: { text: string; more: number };
  approve?: { label: string; decision: AgentInteractionDecision };
  deny?: { label: string; decision: AgentInteractionDecision };
}

/** The longest command the Inbox row shows whole beside an inline decision. */
export const INLINE_APPROVAL_COMMAND_MAX_LENGTH = 120;

function has(interaction: InteractionRequestRecord, action: string): boolean {
  return (interaction.allowedActions as string[]).includes(action);
}

export function inboxInteractionDecisions(
  interaction: InteractionRequestRecord
): InboxInteractionDecisions {
  if (interaction.status === 'PENDING' && interaction.type === 'USER_INPUT') {
    const questions = (interaction.request as AgentUserInputRequest).questions ?? [];
    const text = questions[0]?.question.trim();
    return text ? { question: { text, more: questions.length - 1 } } : {};
  }
  if (
    interaction.status !== 'PENDING' ||
    interaction.type !== 'COMMAND_APPROVAL' ||
    interaction.policyWarnings.length > 0
  ) {
    return {};
  }
  const request = interaction.request as AgentCommandApprovalRequest;
  const subject = displayApprovalCommand(request.command);
  if (
    !subject ||
    /[\r\n]/.test(subject) ||
    subject.length > INLINE_APPROVAL_COMMAND_MAX_LENGTH ||
    request.providerOptions !== undefined ||
    request.networkApprovalContext !== undefined ||
    Boolean(request.paths?.length) ||
    !has(interaction, 'ACCEPT')
  ) {
    return {};
  }

  return {
    subject,
    approve: {
      label: 'Allow once',
      decision: { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' }
    },
    ...(has(interaction, 'DECLINE')
      ? {
          deny: {
            label: 'Deny',
            decision: { interactionType: 'COMMAND_APPROVAL', action: 'DECLINE' } as const
          }
        }
      : {})
  };
}
