import type {
  AgentCommandApprovalRequest,
  AgentInteractionDecision,
  AgentPermissionApprovalRequest,
  InteractionRequestRecord
} from '../../shared/contracts';

/**
 * The inline Approve / Deny decisions offered on an Inbox decision card, derived
 * from an interaction's allowed actions. The Inbox is the app's highest-urgency
 * queue, so the common approve/deny is answerable in place instead of round-
 * tripping through the detail page (audit §03 Inbox). Interactions that need
 * operation context or warnings (provider-native approvals), typed input
 * (USER_INPUT), or a filled MCP form get no inline decision — those still open
 * the task so the user can make an informed choice.
 */
export interface InboxInteractionDecisions {
  approve?: { label: string; decision: AgentInteractionDecision };
  deny?: { label: string; decision: AgentInteractionDecision };
}

function has(interaction: InteractionRequestRecord, action: string): boolean {
  return (interaction.allowedActions as string[]).includes(action);
}

export function inboxInteractionDecisions(
  interaction: InteractionRequestRecord
): InboxInteractionDecisions {
  const result: InboxInteractionDecisions = {};
  if (interaction.status !== 'PENDING') {
    return result;
  }
  if (interaction.type === 'COMMAND_APPROVAL' && hasCommandProviderOptions(interaction)) {
    return result;
  }

  switch (interaction.type) {
    case 'COMMAND_APPROVAL':
      if (has(interaction, 'ACCEPT')) {
        result.approve = {
          label: 'Approve',
          decision: { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' }
        };
      }
      break;
    case 'FILE_CHANGE_APPROVAL':
      if (has(interaction, 'ACCEPT')) {
        result.approve = {
          label: 'Approve',
          decision: { interactionType: 'FILE_CHANGE_APPROVAL', action: 'ACCEPT' }
        };
      }
      break;
    case 'PERMISSION_APPROVAL':
      if (has(interaction, 'GRANT_TURN')) {
        result.approve = {
          label: 'Approve',
          decision: {
            interactionType: 'PERMISSION_APPROVAL',
            action: 'GRANT_TURN',
            permissions: (interaction.request as AgentPermissionApprovalRequest).permissions
          }
        };
      }
      break;
    // USER_INPUT (needs typed answers) and MCP_ELICITATION (may need a form) get
    // no inline Approve — they open the task where the input is entered.
  }

  switch (interaction.type) {
    case 'COMMAND_APPROVAL':
      if (has(interaction, 'DECLINE')) {
        result.deny = {
          label: 'Deny',
          decision: { interactionType: 'COMMAND_APPROVAL', action: 'DECLINE' }
        };
      } else if (has(interaction, 'CANCEL')) {
        result.deny = {
          label: 'Cancel',
          decision: { interactionType: 'COMMAND_APPROVAL', action: 'CANCEL' }
        };
      }
      break;
    case 'FILE_CHANGE_APPROVAL':
    case 'MCP_ELICITATION':
      if (has(interaction, 'DECLINE')) {
        result.deny = {
          label: 'Deny',
          decision: { interactionType: interaction.type, action: 'DECLINE' } as AgentInteractionDecision
        };
      } else if (has(interaction, 'CANCEL')) {
        result.deny = {
          label: 'Cancel',
          decision: { interactionType: interaction.type, action: 'CANCEL' } as AgentInteractionDecision
        };
      }
      break;
    case 'PERMISSION_APPROVAL':
      if (has(interaction, 'DECLINE')) {
        result.deny = {
          label: 'Deny',
          decision: { interactionType: 'PERMISSION_APPROVAL', action: 'DECLINE' }
        };
      }
      break;
    case 'USER_INPUT':
    case 'DYNAMIC_TOOL':
      break;
  }

  return result;
}

function hasCommandProviderOptions(
  interaction: InteractionRequestRecord
): boolean {
  const request = interaction.request as AgentCommandApprovalRequest;
  return request.providerOptions !== undefined;
}
