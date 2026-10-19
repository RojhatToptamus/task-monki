import type { BugReplayLeaseRequest } from '../../../shared/bugReplay';

/**
 * What replays will run, read before anything starts: one label and value per row, as the
 * task's Details are, then the commands in a well. Approving covers exactly this for a number of
 * replays until Task Monki quits, or, kept, for every replay in the repository until revoked in
 * Settings; nothing runs from a recording or an agent turn without one.
 */
export function BugLeaseFacts({ lease }: { lease: BugReplayLeaseRequest }) {
  return (
    <div className="tm-buglease">
      <dl className="tm-props tm-buglease__facts">
        {lease.facts.map((fact) => (
          <div key={fact.label} className="tm-props__row">
            <dt>{fact.label}</dt>
            <dd title={fact.value}>{fact.value}</dd>
          </div>
        ))}
      </dl>
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
    </div>
  );
}
