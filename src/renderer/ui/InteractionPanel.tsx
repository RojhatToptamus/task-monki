import { useEffect, useMemo, useState } from 'react';
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
import { StructuredData, humanizeEnum } from './display';

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

  return (
    <section className="interaction-card" id="action-required" aria-live="polite">
      <header className="interaction-card__header">
        <div>
          <span className="interaction-card__eyebrow">Action required</span>
          <h3>{interactionTitle(active.type)}</h3>
        </div>
        <span className="count-pill">
          {activeCount > 1 ? `${activeCount} pending` : humanizeEnum(active.status)}
        </span>
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
  const [now, setNow] = useState(Date.now());
  const [formValues, setFormValues] = useState<Record<string, FormValue>>({});

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

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
      <div className="interaction-card__meta">
        <span>Waiting {formatElapsed(now - Date.parse(interaction.requestedAt))}</span>
        <span>Request {String(interaction.providerRequestId)}</span>
      </div>
      <div className="interaction-card__source">
        <strong>Source thread</strong>
        <span>{formatSessionSource(sourceSession, interaction.sessionId)}</span>
      </div>
      {interaction.policyWarnings.map((warning) => (
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
          onRespond={respond}
        />
      ) : (
        <p className="muted">This dynamic client tool was rejected automatically.</p>
      )}
      {interaction.status === 'RESPONDING' ? (
        <p className="muted">Decision sent. Waiting for App Server confirmation…</p>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </>
  );
}

function CommandRequest({
  interaction,
  disabled,
  onRespond
}: InteractionSectionProps) {
  const request = interaction.request as AgentCommandApprovalRequest;
  return (
    <>
      <dl className="interaction-details">
        {request.command ? (
          <>
            <dt>Command</dt>
            <dd>
              <code>{request.command}</code>
            </dd>
          </>
        ) : null}
        {request.cwd ? (
          <>
            <dt>Working directory</dt>
            <dd>{request.cwd}</dd>
          </>
        ) : null}
        {request.reason ? (
          <>
            <dt>Reason</dt>
            <dd>{request.reason}</dd>
          </>
        ) : null}
        {request.networkApprovalContext ? (
          <>
            <dt>Network</dt>
            <dd>
              {request.networkApprovalContext.protocol}://
              {request.networkApprovalContext.host}
            </dd>
          </>
        ) : null}
        {request.commandActions?.length ? (
          <>
            <dt>Parsed actions</dt>
            <dd>
              <StructuredData value={request.commandActions} />
            </dd>
          </>
        ) : null}
      </dl>
      <div className="interaction-actions">
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
        {hasAction(interaction, 'ACCEPT_FOR_SESSION') ? (
          <ActionButton
            label="Allow for session"
            disabled={disabled}
            onClick={() =>
              onRespond({
                interactionType: 'COMMAND_APPROVAL',
                action: 'ACCEPT_FOR_SESSION'
              })
            }
          />
        ) : null}
        {hasAction(interaction, 'ACCEPT_EXEC_POLICY_AMENDMENT') &&
        request.proposedExecPolicyAmendment ? (
          <ActionButton
            label="Apply command rule"
            disabled={disabled}
            onClick={() =>
              onRespond({
                interactionType: 'COMMAND_APPROVAL',
                action: 'ACCEPT_EXEC_POLICY_AMENDMENT',
                amendment: request.proposedExecPolicyAmendment ?? []
              })
            }
          />
        ) : null}
        {hasAction(interaction, 'APPLY_NETWORK_POLICY_AMENDMENT')
          ? request.proposedNetworkPolicyAmendments?.map((amendment) => (
              <ActionButton
                key={`${amendment.action}:${amendment.host}`}
                label={`${amendment.action} ${amendment.host}`}
                disabled={disabled}
                onClick={() =>
                  onRespond({
                    interactionType: 'COMMAND_APPROVAL',
                    action: 'APPLY_NETWORK_POLICY_AMENDMENT',
                    amendment
                  })
                }
              />
            ))
          : null}
        <RejectButtons
          interaction={interaction}
          interactionType="COMMAND_APPROVAL"
          disabled={disabled}
          onRespond={onRespond}
        />
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
        <dd>{request.reason ?? 'Codex requested permission to apply file changes.'}</dd>
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
        <dd>{request.reason ?? 'Codex requested additional runtime permissions.'}</dd>
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
  onRespond
}: InteractionSectionProps & {
  interactionType: 'COMMAND_APPROVAL' | 'FILE_CHANGE_APPROVAL' | 'MCP_ELICITATION';
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
          Decline
        </button>
      ) : null}
      {hasAction(interaction, 'CANCEL') ? (
        <button
          type="button"
          className="danger-button"
          disabled={disabled}
          onClick={() =>
            void onRespond({
              interactionType,
              action: 'CANCEL'
            } as AgentInteractionDecision)
          }
        >
          Cancel turn
        </button>
      ) : null}
    </>
  );
}

function ActionButton({
  label,
  disabled,
  onClick
}: {
  label: string;
  disabled: boolean;
  onClick(): Promise<void>;
}) {
  return (
    <button
      type="button"
      className="primary-button"
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {label}
    </button>
  );
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
      return 'Review command execution';
    case 'FILE_CHANGE_APPROVAL':
      return 'Review file changes';
    case 'PERMISSION_APPROVAL':
      return 'Review additional permissions';
    case 'MCP_ELICITATION':
      return 'Respond to MCP request';
    case 'USER_INPUT':
      return 'Answer Codex question';
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
