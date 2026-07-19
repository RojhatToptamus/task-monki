import type {
  AgentCommandApprovalDecision,
  AgentCommandApprovalRequest,
  AgentInteractionDecision,
  AgentPermissionApprovalRequest,
  AgentProviderPermissionAction,
  InteractionRequestRecord
} from '../../shared/contracts';

/**
 * The inline Approve / Deny decisions offered on an Inbox decision card, derived
 * from an interaction's allowed actions. The Inbox is the app's highest-urgency
 * queue, so the common approve/deny is answerable in place instead of round-
 * tripping through the detail page (audit §03 Inbox). Interactions that need
 * typed input (USER_INPUT) or a filled MCP form get no inline Approve — those
 * still open the task so the answer can be entered.
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

  switch (interaction.type) {
    case 'COMMAND_APPROVAL': {
      const providerOptions = commandProviderOptions(interaction);
      const approvals = providerOptions.filter(
        (option) => option.action === 'ACCEPT' || option.action === 'ACCEPT_FOR_SESSION'
      );
      if (approvals.length === 1) {
        result.approve = {
          label: approvals[0]!.label,
          decision: approvals[0]!.decision
        };
      } else if (providerOptions.length === 0 && has(interaction, 'ACCEPT')) {
        result.approve = {
          label: 'Approve',
          decision: { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' }
        };
      }
      break;
    }
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
    case 'COMMAND_APPROVAL': {
      const providerOptions = commandProviderOptions(interaction);
      const rejections = providerOptions.filter(
        (option) => option.action === 'DECLINE' || option.action === 'DECLINE_FOR_SESSION'
      );
      if (rejections.length === 1) {
        result.deny = {
          label: rejections[0]!.label,
          decision: rejections[0]!.decision
        };
      } else if (providerOptions.length === 0 && has(interaction, 'DECLINE')) {
        result.deny = {
          label: 'Deny',
          decision: { interactionType: 'COMMAND_APPROVAL', action: 'DECLINE' }
        };
      } else if (providerOptions.length === 0 && has(interaction, 'CANCEL')) {
        result.deny = {
          label: 'Cancel',
          decision: { interactionType: 'COMMAND_APPROVAL', action: 'CANCEL' }
        };
      }
      break;
    }
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

function commandProviderOptions(interaction: InteractionRequestRecord): Array<{
  label: string;
  action: AgentProviderPermissionAction;
  decision: AgentCommandApprovalDecision;
}> {
  const request = interaction.request as AgentCommandApprovalRequest;
  return (request.providerOptions ?? []).flatMap((option) => {
    const action = option.action;
    if (!has(interaction, action)) return [];
    return [
      {
        label: option.label,
        action,
        decision: {
          interactionType: 'COMMAND_APPROVAL',
          action,
          providerOptionId: option.id
        } as AgentCommandApprovalDecision
      }
    ];
  });
}
