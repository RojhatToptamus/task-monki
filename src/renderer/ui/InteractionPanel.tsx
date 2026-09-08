import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentCommandApprovalRequest,
  AgentFileChangeApprovalRequest,
  AgentInteractionDecision,
  AgentJsonValue,
  AgentMcpElicitationRequest,
  AgentPermissionApprovalRequest,
  AgentSessionRecord,
  AgentUserInputRequest,
  InteractionRequestRecord
} from '../../shared/contracts';
import { availableProviderCommandOptions } from '../model/agentPermissions';
import { StructuredData } from './display';
import { StatusGlyph } from './StatusBadge';
import { DisclosureChevron } from './DisclosureChevron';

interface InteractionPanelProps {
  interactions: InteractionRequestRecord[];
  sessions: AgentSessionRecord[];
  offerAgentDecision?: boolean;
  onRespond(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
}

export function InteractionPanel({
  interactions,
  sessions,
  offerAgentDecision = false,
  onRespond
}: InteractionPanelProps) {
  const activeInteractions = useMemo(
    () =>
      interactions
        .filter((interaction) =>
          ['PENDING', 'RESPONDING'].includes(interaction.status)
        )
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
    [interactions]
  );
  const active = activeInteractions[0];
  const activeCount = activeInteractions.length;
  const sourceSession = active
    ? sessions.find((session) => session.id === active.sessionId)
    : undefined;

  if (!active) {
    return null;
  }

  const commandApproval = active.type === 'COMMAND_APPROVAL';

  return (
    <section
      className={`interaction-card ${commandApproval ? 'interaction-card--command' : ''}`}
      id="action-required"
      aria-live="polite"
    >
      <header className="interaction-card__header">
        {commandApproval ? (
          <h3>
            <StatusGlyph kind="waiting" />
            {interactionTitle(active)}
          </h3>
        ) : (
          <div>
            <span className="interaction-card__eyebrow">
              <StatusGlyph kind="waiting" />
              Action required
            </span>
            <h3>{interactionTitle(active)}</h3>
          </div>
        )}
        {commandApproval ? (
          activeCount > 1 ? (
            <span className="interaction-card__waiting">{activeCount} pending</span>
          ) : null
        ) : (
          <InteractionWaiting requestedAt={active.requestedAt} count={activeCount} />
        )}
      </header>
      <InteractionBody
        key={active.id}
        interaction={active}
        sourceSession={sourceSession}
        offerAgentDecision={offerAgentDecision}
        onRespond={onRespond}
      />
    </section>
  );
}

function InteractionBody({
  interaction,
  sourceSession,
  offerAgentDecision,
  onRespond
}: {
  interaction: InteractionRequestRecord;
  sourceSession?: AgentSessionRecord;
  offerAgentDecision: boolean;
  onRespond: InteractionPanelProps['onRespond'];
}) {
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [formValues, setFormValues] = useState<Record<string, FormValue>>({});

  const respond = async (decision: AgentInteractionDecision) => {
    if (submittingRef.current || interaction.status !== 'PENDING') {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onRespond(interaction, decision);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not submit the decision.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const disabled = submitting || interaction.status !== 'PENDING';

  return (
    <>
      {interaction.type === 'COMMAND_APPROVAL'
        ? null
        : interaction.policyWarnings.map((warning) => (
            <p className="interaction-card__warning" key={warning}>
              {warning}
            </p>
          ))}
      {interaction.type === 'COMMAND_APPROVAL' ? (
        <CommandRequest
          interaction={interaction}
          disabled={disabled}
          onRespond={respond}
        />
      ) : interaction.type === 'FILE_CHANGE_APPROVAL' ? (
        <FileChangeRequest
          interaction={interaction}
          disabled={disabled}
          onRespond={respond}
        />
      ) : interaction.type === 'PERMISSION_APPROVAL' ? (
        <PermissionRequest
          interaction={interaction}
          disabled={disabled}
          onRespond={respond}
        />
      ) : interaction.type === 'MCP_ELICITATION' ? (
        <McpRequest
          interaction={interaction}
          disabled={disabled}
          formValues={formValues}
          setFormValues={setFormValues}
          onRespond={respond}
        />
      ) : interaction.type === 'USER_INPUT' ? (
        <UserInputRequest
          interaction={interaction}
          disabled={disabled}
          formValues={formValues}
          setFormValues={setFormValues}
          offerAgentDecision={offerAgentDecision}
          onRespond={respond}
        />
      ) : (
        <p className="muted">This dynamic client tool was rejected automatically.</p>
      )}
      {interaction.type === 'COMMAND_APPROVAL' ? null : (
        <InteractionTechnicalDetails
          interaction={interaction}
          sourceSession={sourceSession}
        />
      )}
      {interaction.status === 'RESPONDING' ? (
        <p className="muted">
          {interaction.type === 'USER_INPUT' ? 'Answer' : 'Decision'} sent. Waiting for provider
          confirmation…
        </p>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </>
  );
}

function InteractionWaiting({ requestedAt, count }: { requestedAt: string; count: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className="interaction-card__waiting">
      Waiting {formatElapsed(now - Date.parse(requestedAt))}
      {count > 1 ? ` · ${count} pending` : ''}
    </span>
  );
}

function CommandRequest({
  interaction,
  disabled,
  onRespond
}: InteractionSectionProps) {
  const request = interaction.request as AgentCommandApprovalRequest;
  const displayCommand = unwrapShellCommand(request.command);
  const providerOptions = availableProviderCommandOptions(interaction, request);
  const providerNativeRequest = request.providerOptions !== undefined;
  const canRememberCommand =
    hasAction(interaction, 'ACCEPT_EXEC_POLICY_AMENDMENT') &&
    Boolean(request.proposedExecPolicyAmendment?.length);
  const canAllowForSession = hasAction(interaction, 'ACCEPT_FOR_SESSION');
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const useAlwaysAllow = alwaysAllow && canRememberCommand;

  useEffect(() => {
    setAlwaysAllow(false);
  }, [interaction.id]);

  const submitPersistentChoice = () => {
    if (useAlwaysAllow) {
      return onRespond({
        interactionType: 'COMMAND_APPROVAL',
        action: 'ACCEPT_EXEC_POLICY_AMENDMENT',
        amendment: request.proposedExecPolicyAmendment ?? []
      });
    }
    if (canAllowForSession) {
      return onRespond({
        interactionType: 'COMMAND_APPROVAL',
        action: 'ACCEPT_FOR_SESSION'
      });
    }
    return onRespond({
      interactionType: 'COMMAND_APPROVAL',
      action: 'ACCEPT_EXEC_POLICY_AMENDMENT',
      amendment: request.proposedExecPolicyAmendment ?? []
    });
  };

  return (
    <>
      {providerNativeRequest ? (
        <ProviderCommandContext request={request} displayCommand={displayCommand} />
      ) : null}
      {displayCommand ? (
        <pre className="interaction-command">
          <code>{displayCommand}</code>
        </pre>
      ) : null}
      {interaction.policyWarnings.map((warning) => (
        <p className="interaction-card__warning" key={warning}>
          {warning}
        </p>
      ))}
      <div className="interaction-command__footer">
        {!providerNativeRequest && canRememberCommand && canAllowForSession ? (
          <label className="interaction-remember">
            <input
              type="checkbox"
              checked={alwaysAllow}
              disabled={disabled}
              onChange={(event) => setAlwaysAllow(event.target.checked)}
            />
            <span>Always allow matching commands</span>
          </label>
        ) : (
          <span />
        )}
        <div className="interaction-actions interaction-actions--command">
          {providerNativeRequest ? (
            <>
              {providerOptions.map((option) => (
                <ActionButton
                  key={option.id}
                  label={option.label}
                  variant={
                    option.action === 'ACCEPT' && !option.providerRemembersChoice
                      ? 'primary'
                      : 'secondary'
                  }
                  disabled={disabled}
                  onClick={() => onRespond(option.decision)}
                />
              ))}
              {hasAction(interaction, 'CANCEL') ? (
                <ActionButton
                  label="Cancel request"
                  variant="secondary"
                  disabled={disabled}
                  onClick={() =>
                    onRespond({
                      interactionType: 'COMMAND_APPROVAL',
                      action: 'CANCEL'
                    })
                  }
                />
              ) : null}
            </>
          ) : (
            <>
              <RejectButtons
                interaction={interaction}
                interactionType="COMMAND_APPROVAL"
                disabled={disabled}
                declineLabel="Deny"
                showCancel={false}
                onRespond={onRespond}
              />
              {hasAction(interaction, 'ACCEPT') ? (
                <ActionButton
                  label="Allow once"
                  disabled={disabled}
                  onClick={() =>
                    onRespond({
                      interactionType: 'COMMAND_APPROVAL',
                      action: 'ACCEPT'
                    })
                  }
                />
              ) : null}
              {canAllowForSession || canRememberCommand ? (
                <ActionButton
                  label={
                    useAlwaysAllow || !canAllowForSession
                      ? 'Always allow'
                      : 'Allow for session'
                  }
                  variant="secondary"
                  disabled={disabled}
                  onClick={submitPersistentChoice}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function ProviderCommandContext({
  request,
  displayCommand
}: {
  request: AgentCommandApprovalRequest;
  displayCommand?: string;
}) {
  const network = formatProviderNetworkContext(request.networkApprovalContext);
  const reason = providerReason(request.reason, displayCommand);
  const hasDetails =
    Boolean(reason) ||
    Boolean(request.paths?.length) ||
    Boolean(request.cwd) ||
    Boolean(network);

  if (!hasDetails) {
    return null;
  }

  return (
    <dl className="interaction-details">
      {reason ? (
        <>
          <dt>Reason</dt>
          <dd>{reason}</dd>
        </>
      ) : null}
      {request.paths?.length ? (
        <>
          <dt>Paths</dt>
          <dd><pre>{request.paths.join('\n')}</pre></dd>
        </>
      ) : null}
      {request.cwd ? (
        <>
          <dt>Working directory</dt>
          <dd><code>{request.cwd}</code></dd>
        </>
      ) : null}
      {network ? (
        <>
          <dt>Network</dt>
          <dd><code>{network}</code></dd>
        </>
      ) : null}
    </dl>
  );
}

function providerReason(
  reason: string | undefined,
  displayCommand: string | undefined
): string | undefined {
  if (!reason) return undefined;
  const normalize = (value: string) => value.trim().replace(/^`|`$/gu, '');
  return displayCommand && normalize(reason) === normalize(displayCommand)
    ? undefined
    : reason;
}

function FileChangeRequest({
  interaction,
  disabled,
  onRespond
}: InteractionSectionProps) {
  const request = interaction.request as AgentFileChangeApprovalRequest;
  return (
    <>
      <dl className="interaction-details">
        <dt>Reason</dt>
        <dd>{request.reason ?? 'Agent requested permission to apply file changes.'}</dd>
        {request.grantRoot ? (
          <>
            <dt>Requested root</dt>
            <dd>{request.grantRoot}</dd>
          </>
        ) : null}
        {request.changes?.length ? (
          <>
            <dt>Proposed changes</dt>
            <dd className="interaction-change-list">
              {request.changes.map((change) => (
                <details key={`${change.kind}:${change.path}`}>
                  <summary>
                    <span className="tm-disclosure__label">
                      <DisclosureChevron />
                      {change.kind}: {change.path}
                    </span>
                  </summary>
                  <pre>{change.diff}</pre>
                </details>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
      <div className="interaction-actions">
        {hasAction(interaction, 'ACCEPT') ? (
          <ActionButton
            label="Apply once"
            disabled={disabled}
            onClick={() =>
              onRespond({
                interactionType: 'FILE_CHANGE_APPROVAL',
                action: 'ACCEPT'
              })
            }
          />
        ) : null}
        {hasAction(interaction, 'ACCEPT_FOR_SESSION') ? (
          <ActionButton
            label="Allow root for session"
            variant="secondary"
            disabled={disabled}
            onClick={() =>
              onRespond({
                interactionType: 'FILE_CHANGE_APPROVAL',
                action: 'ACCEPT_FOR_SESSION'
              })
            }
          />
        ) : null}
        <RejectButtons
          interaction={interaction}
          interactionType="FILE_CHANGE_APPROVAL"
          disabled={disabled}
          onRespond={onRespond}
        />
      </div>
    </>
  );
}

function PermissionRequest({
  interaction,
  disabled,
  onRespond
}: InteractionSectionProps) {
  const request = interaction.request as AgentPermissionApprovalRequest;
  return (
    <>
      <dl className="interaction-details">
        <dt>Reason</dt>
        <dd>{request.reason ?? 'Agent requested additional runtime permissions.'}</dd>
        <dt>Working directory</dt>
        <dd>{request.cwd}</dd>
        <dt>Requested permissions</dt>
        <dd>
          <StructuredData value={request.permissions} />
        </dd>
      </dl>
      <div className="interaction-actions">
        {hasAction(interaction, 'GRANT_TURN') ? (
          <ActionButton
            label="Grant for turn"
            disabled={disabled}
            onClick={() =>
              onRespond({
                interactionType: 'PERMISSION_APPROVAL',
                action: 'GRANT_TURN',
                permissions: request.permissions
              })
            }
          />
        ) : null}
        {hasAction(interaction, 'GRANT_SESSION') ? (
          <ActionButton
            label="Grant for session"
            variant="secondary"
            disabled={disabled}
            onClick={() =>
              onRespond({
                interactionType: 'PERMISSION_APPROVAL',
                action: 'GRANT_SESSION',
                permissions: request.permissions
              })
            }
          />
        ) : null}
        {hasAction(interaction, 'DECLINE') ? (
          <button
            type="button"
            className="outline-button"
            disabled={disabled}
            onClick={() =>
              void onRespond({
                interactionType: 'PERMISSION_APPROVAL',
                action: 'DECLINE'
              })
            }
          >
            Decline
          </button>
        ) : null}
      </div>
    </>
  );
}

function McpRequest({
  interaction,
  disabled,
  formValues,
  setFormValues,
  onRespond
}: InteractionSectionProps & FormStateProps) {
  const request = interaction.request as AgentMcpElicitationRequest;
  const content =
    request.mode === 'form'
      ? buildMcpContent(request.requestedSchema, formValues)
      : null;
  return (
    <>
      <dl className="interaction-details">
        <dt>MCP server</dt>
        <dd>{request.serverName}</dd>
        <dt>Message</dt>
        <dd>{request.message}</dd>
        {request.mode === 'url' ? (
          <>
            <dt>URL</dt>
            <dd>
              <code>{request.url}</code>
            </dd>
          </>
        ) : null}
        {request.metadata ? (
          <>
            <dt>Metadata</dt>
            <dd>
              <StructuredData value={request.metadata} />
            </dd>
          </>
        ) : null}
      </dl>
      {request.mode === 'form' ? (
        <McpForm
          schema={request.requestedSchema}
          values={formValues}
          setValues={setFormValues}
          disabled={disabled}
        />
      ) : null}
      <div className="interaction-actions">
        {hasAction(interaction, 'ACCEPT') ? (
          <ActionButton
            label="Accept"
            disabled={disabled}
            onClick={() =>
              onRespond({
                interactionType: 'MCP_ELICITATION',
                action: 'ACCEPT',
                content
              })
            }
          />
        ) : null}
        <RejectButtons
          interaction={interaction}
          interactionType="MCP_ELICITATION"
          disabled={disabled}
          onRespond={onRespond}
        />
      </div>
    </>
  );
}

function UserInputRequest({
  interaction,
  disabled,
  formValues,
  setFormValues,
  offerAgentDecision,
  onRespond
}: InteractionSectionProps & FormStateProps & { offerAgentDecision: boolean }) {
  const request = interaction.request as AgentUserInputRequest;
  const answers = Object.fromEntries(
    request.questions.map((question) => [
      question.id,
      userInputAnswers(question, formValues[question.id])
    ])
  );
  const canSubmit = Object.values(answers).every(
    (values) => values.length > 0 && values.every((value) => value.trim())
  );
  const canDelegate =
    offerAgentDecision &&
    request.questions.every(
      (question) => question.isOther && Boolean(question.options?.length)
    );
  return (
    <>
      <div className="interaction-form">
        {request.questions.map((question) => (
          <UserInputQuestion
            key={question.id}
            question={question}
            value={formValues[question.id]}
            disabled={disabled}
            onChange={(value) =>
              setFormValues((current) => ({
                ...current,
                [question.id]: value
              }))
            }
          />
        ))}
      </div>
      {hasAction(interaction, 'ANSWER') ? (
        <div className="interaction-actions">
          <ActionButton
            label="Submit answers"
            disabled={disabled || !canSubmit}
            onClick={() =>
              onRespond({
                interactionType: 'USER_INPUT',
                action: 'ANSWER',
                answers
              })
            }
          />
          {canDelegate ? (
            <ActionButton
              label="Decide for me"
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                onRespond({
                  interactionType: 'USER_INPUT',
                  action: 'ANSWER',
                  answers: Object.fromEntries(
                    request.questions.map((question) => [
                      question.id,
                      ['Decide for me']
                    ])
                  )
                })
              }
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function UserInputQuestion({
  question,
  value,
  disabled,
  onChange
}: {
  question: AgentUserInputRequest['questions'][number];
  value: FormValue | undefined;
  disabled: boolean;
  onChange(value: FormValue): void;
}) {
  if (!question.options?.length) {
    return (
      <label className="field">
        <span>{question.header}</span>
        <small>{question.question}</small>
        <input
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  const choice = userInputChoiceValue(value);
  const inputType = question.allowsMultiple ? 'checkbox' : 'radio';
  const chooseOption = (label: string, checked: boolean) => {
    const selected = question.allowsMultiple
      ? checked
        ? [...choice.selected, label]
        : choice.selected.filter((candidate) => candidate !== label)
      : checked
        ? [label]
        : [];
    onChange({
      ...choice,
      selected,
      customSelected: question.allowsMultiple ? choice.customSelected : false
    });
  };
  const chooseCustom = (checked: boolean) => {
    onChange({
      ...choice,
      selected: question.allowsMultiple ? choice.selected : [],
      customSelected: checked
    });
  };

  return (
    <fieldset className="interaction-question">
      <legend>{question.header}</legend>
      <p className="interaction-question__prompt">{question.question}</p>
      <div className="interaction-choice-list">
        {question.options.map((option, index) => (
          <label className="interaction-choice" key={`${index}:${option.label}`}>
            <input
              type={inputType}
              name={question.id}
              disabled={disabled}
              checked={choice.selected.includes(option.label)}
              onChange={(event) => chooseOption(option.label, event.target.checked)}
            />
            <span>
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </span>
          </label>
        ))}
        {question.isOther ? (
          <div className="interaction-choice interaction-choice--other">
            <label>
              <input
                type={inputType}
                name={question.id}
                disabled={disabled}
                checked={choice.customSelected}
                onChange={(event) => chooseCustom(event.target.checked)}
              />
              <strong>Other</strong>
            </label>
            <input
              aria-label={`${question.header} other answer`}
              disabled={disabled}
              value={choice.custom}
              onFocus={() => chooseCustom(true)}
              onChange={(event) =>
                onChange({
                  ...choice,
                  selected: question.allowsMultiple ? choice.selected : [],
                  customSelected: true,
                  custom: event.target.value
                })
              }
            />
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

function userInputAnswers(
  question: AgentUserInputRequest['questions'][number],
  value: FormValue | undefined
): string[] {
  if (!question.options?.length) {
    return [typeof value === 'string' ? value : ''];
  }
  const choice = userInputChoiceValue(value);
  return [
    ...choice.selected,
    ...(choice.customSelected ? [choice.custom] : [])
  ];
}

function userInputChoiceValue(value: FormValue | undefined): UserInputChoiceValue {
  return isUserInputChoiceValue(value)
    ? value
    : { selected: [], customSelected: false, custom: '' };
}

function isUserInputChoiceValue(value: FormValue | undefined): value is UserInputChoiceValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray(value.selected) &&
    typeof value.customSelected === 'boolean' &&
    typeof value.custom === 'string'
  );
}

function McpForm({
  schema,
  values,
  setValues,
  disabled
}: {
  schema: { [key: string]: AgentJsonValue };
  values: Record<string, FormValue>;
  setValues: FormStateProps['setFormValues'];
  disabled: boolean;
}) {
  const properties = isObject(schema.properties) ? schema.properties : {};
  return (
    <div className="interaction-form">
      {Object.entries(properties).map(([key, value]) => {
        const field = isObject(value) ? value : {};
        const label =
          typeof field.title === 'string' ? field.title : key;
        if (field.type === 'boolean') {
          return (
            <label className="interaction-checkbox" key={key}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={Boolean(values[key])}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [key]: event.target.checked
                  }))
                }
              />
              <span>{label}</span>
            </label>
          );
        }
        const options = enumValues(field);
        const multiSelect = field.type === 'array' && Boolean(options);
        return (
          <label className="field" key={key}>
            <span>{label}</span>
            {options ? (
              <select
                multiple={multiSelect}
                disabled={disabled}
                value={
                  multiSelect
                    ? Array.isArray(values[key])
                      ? values[key]
                      : []
                    : String(values[key] ?? '')
                }
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [key]: multiSelect
                      ? Array.from(
                          event.target.selectedOptions,
                          (option) => option.value
                        )
                      : event.target.value
                  }))
                }
              >
                {!multiSelect ? <option value="">Select…</option> : null}
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={
                  field.type === 'number' || field.type === 'integer'
                    ? 'number'
                    : 'text'
                }
                disabled={disabled}
                value={String(values[key] ?? '')}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [key]: event.target.value
                  }))
                }
              />
            )}
            {typeof field.description === 'string' ? (
              <small>{field.description}</small>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

interface InteractionSectionProps {
  interaction: InteractionRequestRecord;
  disabled: boolean;
  onRespond(decision: AgentInteractionDecision): Promise<void>;
}

interface FormStateProps {
  formValues: Record<string, FormValue>;
  setFormValues: React.Dispatch<
    React.SetStateAction<Record<string, FormValue>>
  >;
}

interface UserInputChoiceValue {
  selected: string[];
  customSelected: boolean;
  custom: string;
}

function RejectButtons({
  interaction,
  interactionType,
  disabled,
  declineLabel = 'Deny request',
  showCancel = true,
  onRespond
}: InteractionSectionProps & {
  interactionType: 'COMMAND_APPROVAL' | 'FILE_CHANGE_APPROVAL' | 'MCP_ELICITATION';
  declineLabel?: string;
  showCancel?: boolean;
}) {
  return (
    <>
      {hasAction(interaction, 'DECLINE') ? (
        <button
          type="button"
          className="outline-button"
          disabled={disabled}
          onClick={() =>
            void onRespond({
              interactionType,
              action: 'DECLINE'
            } as AgentInteractionDecision)
          }
        >
          {declineLabel}
        </button>
      ) : null}
      {interactionType === 'COMMAND_APPROVAL' &&
      hasAction(interaction, 'DECLINE_FOR_SESSION') ? (
        <button
          type="button"
          className="outline-button"
          disabled={disabled}
          onClick={() =>
            void onRespond({
              interactionType: 'COMMAND_APPROVAL',
              action: 'DECLINE_FOR_SESSION'
            })
          }
        >
          Deny for session
        </button>
      ) : null}
      {showCancel && hasAction(interaction, 'CANCEL') ? (
        <button
          type="button"
          className="outline-button outline-button--danger interaction-actions__stop"
          disabled={disabled}
          onClick={() =>
            void onRespond({
              interactionType,
              action: 'CANCEL'
            } as AgentInteractionDecision)
          }
        >
          Stop current turn…
        </button>
      ) : null}
    </>
  );
}

function ActionButton({
  label,
  variant = 'primary',
  disabled,
  onClick
}: {
  label: string;
  variant?: 'primary' | 'secondary';
  disabled: boolean;
  onClick(): Promise<void>;
}) {
  return (
    <button
      type="button"
      className={variant === 'primary' ? 'primary-button' : 'outline-button'}
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {label}
    </button>
  );
}

function formatProviderNetworkContext(
  context: AgentCommandApprovalRequest['networkApprovalContext']
): string | undefined {
  if (context?.protocol && context.host) {
    return `${context.protocol} · ${context.host}`;
  }
  return context?.protocol ?? context?.host;
}

function InteractionTechnicalDetails({
  interaction,
  sourceSession
}: {
  interaction: InteractionRequestRecord;
  sourceSession?: AgentSessionRecord;
}) {
  const commandRequest =
    interaction.type === 'COMMAND_APPROVAL'
      ? (interaction.request as AgentCommandApprovalRequest)
      : undefined;
  return (
    <details className="interaction-technical">
      <summary><DisclosureChevron />Request details</summary>
      <dl className="interaction-details interaction-details--technical">
        <dt>Source</dt>
        <dd>{formatSessionSource(sourceSession, interaction.sessionId)}</dd>
        <dt>Request ID</dt>
        <dd><code>{String(interaction.providerRequestId)}</code></dd>
        {commandRequest?.command ? (
          <>
            <dt>Exact command</dt>
            <dd><code>{commandRequest.command}</code></dd>
          </>
        ) : null}
        {commandRequest?.cwd ? (
          <>
            <dt>Working directory</dt>
            <dd><code>{commandRequest.cwd}</code></dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}

function unwrapShellCommand(command: string | undefined): string | undefined {
  if (!command) {
    return undefined;
  }
  const match = command.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/);
  return match?.[2] ?? command;
}

function buildMcpContent(
  schema: { [key: string]: AgentJsonValue },
  values: Record<string, FormValue>
): AgentJsonValue {
  const properties = isObject(schema.properties) ? schema.properties : {};
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const field = isObject(properties[key]) ? properties[key] : {};
      if (
        typeof value === 'string' &&
        (field.type === 'number' || field.type === 'integer')
      ) {
        return [key, Number(value)];
      }
      return [key, value];
    })
  );
}

function enumValues(schema: { [key: string]: AgentJsonValue }): string[] | undefined {
  if (Array.isArray(schema.enum)) {
    return schema.enum.filter((value): value is string => typeof value === 'string');
  }
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (alternatives) {
    return alternatives
      .filter(isObject)
      .map((value) => value.const)
      .filter((value): value is string => typeof value === 'string');
  }
  if (isObject(schema.items)) {
    return enumValues(schema.items);
  }
  return undefined;
}

type FormValue = string | boolean | string[] | UserInputChoiceValue;

function hasAction(
  interaction: InteractionRequestRecord,
  action: InteractionRequestRecord['allowedActions'][number]
): boolean {
  return interaction.allowedActions.includes(action);
}

function interactionTitle(interaction: InteractionRequestRecord): string {
  switch (interaction.type) {
    case 'COMMAND_APPROVAL':
      return (interaction.request as AgentCommandApprovalRequest).providerOptions !==
        undefined
        ? 'Tool approval'
        : 'Command approval';
    case 'FILE_CHANGE_APPROVAL':
      return 'File change approval';
    case 'PERMISSION_APPROVAL':
      return 'Permission approval';
    case 'MCP_ELICITATION':
      return 'Respond to MCP request';
    case 'USER_INPUT':
      return 'Answer agent question';
    case 'DYNAMIC_TOOL':
      return 'Unsupported dynamic tool';
  }
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatSessionSource(
  session: AgentSessionRecord | undefined,
  fallbackId: string
): string {
  if (!session) {
    return `Unknown local session ${fallbackId.slice(0, 8)}`;
  }
  const label =
    session.providerNickname ??
    session.providerRole ??
    (session.role === 'SUBAGENT' ? 'Subagent' : 'Primary agent');
  return `${label} · ${session.providerSessionId ?? session.id}`;
}

function isObject(
  value: AgentJsonValue | undefined
): value is { [key: string]: AgentJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
