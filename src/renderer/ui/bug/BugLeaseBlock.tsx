import type { ReactNode } from 'react';
import type { BugReplayLeaseRequest } from '../../../shared/bugReplay';
import { DecisionBlock } from '../DecisionBlock';

/** What clean runs will run: one fact per line, then the commands. */
export function BugLeaseFacts({ lease }: { lease: BugReplayLeaseRequest }) {
  return (
    <>
      <ul className="tm-buglease__facts">
        {lease.facts.map((fact) => <li key={fact}>{fact}</li>)}
      </ul>
      {lease.commands.length ? (
        <div className="tm-buglease__commands" aria-label="Commands">
          {lease.commands.map((command) => (
            <div key={`${command.service}:${command.command}`} className="tm-buglease__command">
              <span className="tm-buglease__service">{command.service}</span>
              <code>{command.command}</code>
              {command.directory && command.directory !== '.' ? <span className="tm-buglease__directory">{command.directory}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * Approve clean runs: what will run, from which code, with which data, secrets and files, and the
 * execution boundary, read before anything starts. One approval covers this app's recipe for a
 * number of runs until Task Monki quits; nothing runs from a recording or an agent turn without it.
 */
export function BugLeaseBlock({
  lease,
  busy,
  onAllow,
  secondary
}: {
  lease: BugReplayLeaseRequest;
  busy: boolean;
  onAllow(): void;
  secondary?: ReactNode;
}) {
  return (
    <DecisionBlock
      kind={lease.title}
      tone="action"
      summary={lease.sameAsRunningPreview ? 'The same commands as this task’s running preview, on a separate copy.' : undefined}
      actions={
        <>
          {secondary}
          <button type="button" className="primary-button" disabled={busy} onClick={onAllow}>
            Approve clean runs
          </button>
        </>
      }
    >
      <BugLeaseFacts lease={lease} />
    </DecisionBlock>
  );
}
