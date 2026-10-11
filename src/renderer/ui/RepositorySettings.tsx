import { MoreHorizontal, Plus } from 'lucide-react';
import type { Repository } from '../../shared/contracts';
import { abbreviateHomePath, type RepositoryOption } from '../model/repositories';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { SettingsPane } from './SettingsPane';
import { Chip, type StatusPillTone } from './StatusBadge';

export interface RepositorySettingsActions {
  addingRepository: boolean;
  revealLabel: string;
  onAddRepository(): Promise<boolean>;
  onRefreshRepository(repositoryId: string): Promise<void>;
  onReconnectRepository(repositoryId: string): Promise<void>;
  onDisconnectRepository(repositoryId: string): Promise<void>;
  onRevealRepository(repositoryId: string): Promise<void>;
}

const STATUS: Record<Repository['status'], { label: string; tone: StatusPillTone }> = {
  AVAILABLE: { label: 'Ready', tone: 'neutral' },
  MISSING: { label: 'Missing', tone: 'error' },
  INVALID: { label: 'Not a Git repository', tone: 'error' },
  DISCONNECTED: { label: 'Disconnected', tone: 'neutral' }
};

/**
 * Repositories Task Monki can create tasks in. Lifecycle actions live in each
 * row's menu; New task remembers the repository used last, so nothing here
 * chooses a default.
 */
export function RepositorySettings({
  repositories,
  addingRepository,
  revealLabel,
  onAddRepository,
  onRefreshRepository,
  onReconnectRepository,
  onDisconnectRepository,
  onRevealRepository
}: RepositorySettingsActions & { repositories: RepositoryOption[] }) {
  return (
    <SettingsPane
      id="repositories"
      title="Repositories"
      action={
        <button type="button" className="outline-button button--sm" disabled={addingRepository} onClick={() => void onAddRepository()}>
          <Plus size={13} aria-hidden="true" />
          Add repository
        </button>
      }
    >
      {repositories.length === 0 ? (
        <p className="tm-settings__empty">Add a repository to create tasks in it.</p>
      ) : (
        <div className="tm-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Path</th>
                <th scope="col">Status</th>
                <th scope="col" className="tm-table__num">Tasks</th>
                <th scope="col"><span className="tm-visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {repositories.map((repository) => {
                const status = STATUS[repository.status];
                const items: ActionMenuItem[] = [
                  ...(repository.status !== 'AVAILABLE'
                    ? [{ label: 'Reconnect…', onSelect: () => void onReconnectRepository(repository.id) }]
                    : []),
                  ...(repository.status !== 'DISCONNECTED'
                    ? [{ label: 'Check again', onSelect: () => void onRefreshRepository(repository.id) }]
                    : []),
                  ...(repository.status === 'AVAILABLE'
                    ? [{ label: revealLabel, onSelect: () => void onRevealRepository(repository.id) }]
                    : []),
                  ...(repository.status !== 'DISCONNECTED'
                    ? [{ label: 'Disconnect', danger: true, separated: true, onSelect: () => void onDisconnectRepository(repository.id) }]
                    : [])
                ];
                return (
                  <tr key={repository.id}>
                    <td className="tm-table__primary">{repository.name}</td>
                    <td className="tm-table__mono tm-table__path" title={repository.path}>
                      <span dir="ltr">{abbreviateHomePath(repository.path)}</span>
                    </td>
                    {/* Only a repository that needs something carries a chip. */}
                    <td>{repository.status === 'AVAILABLE' ? <span className="tm-table__quiet">{status.label}</span> : <Chip tone={status.tone} label={status.label} />}</td>
                    <td className="tm-table__num">{repository.taskCount}</td>
                    <td className="tm-table__actions">
                      {items.length ? (
                        <ActionMenu
                          className="tm-table__menu"
                          label={`Actions for ${repository.name}`}
                          tooltip="More actions"
                          side="bottom"
                          trigger={<MoreHorizontal size={16} aria-hidden="true" />}
                          items={items}
                        />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SettingsPane>
  );
}
