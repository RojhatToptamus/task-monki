import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BugReplayKeptApproval } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import { formatShortAge } from '../../model/timeAgo';
import { ActionMenu } from '../ActionMenu';
import { SettingsSubsection } from '../SettingsPane';

/**
 * Replays the person keeps approved for a repository, one row per recipe they approved: the
 * repository, the commands they read with the env files and outside hosts replays get, and when.
 * Revoking ends the approval at once, and the next replay of that recipe asks again. Nothing is
 * shown until an approval was kept.
 */
export function ReplayApprovalSettings() {
  const [approvals, setApprovals] = useState<BugReplayKeptApproval[]>([]);
  // Once shown, the list stays while Settings is open, so revoking the last one keeps focus here.
  const [listed, setListed] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const [error, setError] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    taskManagerApi.listBugReplayApprovals().then(
      (list) => {
        if (disposed) return;
        setApprovals(list);
        setListed(list.length > 0);
      },
      (cause: unknown) => {
        if (!disposed) setError(messageOf(cause));
      }
    );
    return () => {
      disposed = true;
    };
  }, []);

  const revoke = async (approval: BugReplayKeptApproval) => {
    setRevoking(approval.id);
    setError(undefined);
    try {
      setApprovals(await taskManagerApi.revokeBugReplayApproval({ approvalId: approval.id }));
      // The row and its menu are gone; the list keeps focus.
      listRef.current?.focus({ preventScroll: true });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRevoking(undefined);
    }
  };

  if (!listed && !error) return null;
  return (
    <SettingsSubsection title="Replay approvals">
      {/* A list that could not be read says only that. */}
      {listed ? (
        <div ref={listRef} className={approvals.length ? 'tm-table tm-replayapprovals' : 'tm-replayapprovals'} tabIndex={-1}>
          {approvals.length ? (
            <table>
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col">What runs</th>
                  <th scope="col">Approved</th>
                  <th scope="col" className="tm-table__actions"><span className="tm-visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {approvals.map((approval) => (
                  <ApprovalRow key={approval.id} approval={approval} disabled={Boolean(revoking)} onRevoke={() => void revoke(approval)} />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="tm-settings__empty">No replay approvals</p>
          )}
        </div>
      ) : null}
      {error ? <p className="tm-error" role="alert">{error}</p> : null}
    </SettingsSubsection>
  );
}

/** One kept approval: its repository, what it runs, and when it was kept. */
function ApprovalRow({ approval, disabled, onRevoke }: { approval: BugReplayKeptApproval; disabled: boolean; onRevoke(): void }) {
  const commands = recipeCommands(approval);
  // What else replays get sets apart two approvals of the same commands.
  const uses = [...approval.envFiles, ...approval.calls];
  return (
    <tr>
      <td className="tm-table__primary">{approval.repositoryName}</td>
      <td className="tm-replayapprovals__runs" title={[...commands, ...uses].join('\n')}>
        <span className="tm-replayapprovals__line">
          {commands.map((command, index) => <span key={index} className="tm-replayapprovals__item">{command}</span>)}
        </span>
        {uses.length ? (
          <span className="tm-replayapprovals__line tm-replayapprovals__line--uses">
            {uses.map((use, index) => <span key={index} className="tm-replayapprovals__item">{use}</span>)}
          </span>
        ) : null}
      </td>
      <td className="tm-table__quiet tm-replayapprovals__when">
        <time dateTime={approval.keptAt} title={new Date(approval.keptAt).toLocaleString()}>{formatShortAge(approval.keptAt)}</time>
      </td>
      <td className="tm-table__actions">
        <ActionMenu
          className="tm-table__menu"
          // Named by all the row shows, so two approvals of the same commands are told apart.
          label={`Actions for ${[approval.repositoryName, ...commands, ...uses].join(', ')}`}
          tooltip="More actions"
          side="bottom"
          disabled={disabled}
          trigger={<MoreHorizontal size={16} aria-hidden="true" />}
          items={[{ label: 'Revoke approval', onSelect: onRevoke }]}
        />
      </td>
    </tr>
  );
}

/** The recipe's own commands; the install Task Monki adds reads the same in every repository. */
function recipeCommands(approval: BugReplayKeptApproval): string[] {
  const own = approval.commands.filter((command) => command.service !== 'install');
  return (own.length ? own : approval.commands).map((command) => command.command);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
