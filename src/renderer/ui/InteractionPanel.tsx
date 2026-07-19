import { useEffect, useMemo, useState } from 'react';
import type {
  AgentCommandApprovalRequest,
  AgentFileChangeApprovalRequest,
  AgentInteractionDecision,
  AgentJsonValue,
  AgentMcpElicitationRequest,
  AgentPermissionApprovalRequest,
  AgentProviderPermissionAction,
  AgentSessionRecord,
  AgentUserInputRequest,
  InteractionRequestRecord
} from '../../shared/contracts';
import { StructuredData } from './display';

interface InteractionPanelProps {
  interactions: InteractionRequestRecord[];
  sessions: AgentSessionRecord[];
  onRespond(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
}

export function InteractionPanel({
  interactions,
  sessions,
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
            <span className="interaction-card__dot" aria-hidden="true" />
            {interactionTitle(active.type)}
          </h3>
        ) : (
          <div>
            <span className="interaction-card__eyebrow">
              <span className="interaction-card__dot" aria-hidden="true" />
              Action required
            </span>
            <h3>{interactionTitle(active.type)}</h3>
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
        interaction={active}
        sourceSession={sourceSession}
        onRespond={onRespond}
      />
    </section>
  );
}

function InteractionBody({
  interaction,
  sourceSession,
  onRespond
}: {
  interaction: InteractionRequestRecord;
  sourceSession?: AgentSessionRecord;
  onRespond: InteractionPanelProps['onRespond'];
}) {
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, FormValue>>({});

  useEffect(() => {
    setError(undefined);
    setFormValues({});
  }, [interaction.id]);

  const respond = async (decision: AgentInteractionDecision) => {
    setSubmitting(true);
    setError(undefined);
    try {
      await onRespond(interaction, decision);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not submit the decision.');
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = submitting || interaction.status !== 'PENDING';

  return (
    <>
      {interaction.policyWarnings.map((warning) => (
        <p className="interaction-card__warning" key={warning}>
          <span aria-hidden="true" />
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
        <p className="muted">Decision sent. Waiting for App Server confirmation…</p>
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
  const providerOptions = providerCommandOptions(interaction, request);
  const hasProviderOptions = Boolean(request.providerOptions?.length);
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
      {displayCommand ? (
        <pre className="interaction-command">
          <code>{displayCommand}</code>
        </pre>
      ) : null}
      <div className="interaction-command__footer">
        {!hasProviderOptions && canRememberCommand && canAllowForSession ? (
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
          {hasProviderOptions ? (
            providerOptions.length > 0 ? (
              providerOptions.map((option) => (
                <ActionButton
                  key={option.id}
                  label={option.label}
                  variant={option.action === 'ACCEPT' ? 'primary' : 'secondary'}
                  disabled={disabled}
                  onClick={() =>
                    onRespond({
                      interactionType: 'COMMAND_APPROVAL',
                      action: option.action,
                      providerOptionId: option.id
                    })
                  }
                />
              ))
            ) : hasAction(interaction, 'CANCEL') ? (
              <ActionButton
                label="Cancel"
                variant="secondary"
                disabled={disabled}
                onClick={() =>
                  onRespond({
                    interactionType: 'COMMAND_APPROVAL',
                    action: 'CANCEL'
                  })
                }
              />
            ) : null
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
                  variant="secondary"
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
                    {change.kind}: {change.path}
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
  onRespond
}: InteractionSectionProps & FormStateProps) {
  const request = interaction.request as AgentUserInputRequest;
  return (
    <>
      <div className="interaction-form">
        {request.questions.map((question) => (
          <label className="field" key={question.id}>
            <span>{question.header}</span>
            {question.options ? (
              <select
                disabled={disabled}
                value={String(formValues[question.id] ?? '')}
                onChange={(event) =>
                  setFormValues((current) => ({
                    ...current,
                    [question.id]: event.target.value
                  }))
                }
              >
                <option value="">Select…</option>
                {question.options.map((option) => (
                  <option key={option.label} value={option.label}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                disabled={disabled}
                value={String(formValues[question.id] ?? '')}
                onChange={(event) =>
                  setFormValues((current) => ({
                    ...current,
                    [question.id]: event.target.value
                  }))
                }
              />
            )}
            <small>{question.question}</small>
          </label>
        ))}
      </div>
      {hasAction(interaction, 'ANSWER') ? (
        <div className="interaction-actions">
          <ActionButton
            label="Submit answers"
            disabled={disabled}
            onClick={() =>
              onRespond({
                interactionType: 'USER_INPUT',
                action: 'ANSWER',
                answers: Object.fromEntries(
                  request.questions.map((question) => [
                    question.id,
                    [String(formValues[question.id] ?? '')]
                  ])
                )
              })
            }
          />
        </div>
      ) : null}
    </>
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

function providerCommandOptions(
  interaction: InteractionRequestRecord,
  request: AgentCommandApprovalRequest
): Array<{
  id: string;
  label: string;
  action: AgentProviderPermissionAction;
}> {
  return (request.providerOptions ?? []).flatMap((option) => {
    return hasAction(interaction, option.action)
      ? [{ id: option.id, label: option.label, action: option.action }]
      : [];
  });
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
      <summary>Request details</summary>
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

type FormValue = string | boolean | string[];

function hasAction(
  interaction: InteractionRequestRecord,
  action: InteractionRequestRecord['allowedActions'][number]
): boolean {
  return interaction.allowedActions.includes(action);
}

function interactionTitle(type: InteractionRequestRecord['type']): string {
  switch (type) {
    case 'COMMAND_APPROVAL':
      return 'Command approval';
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
