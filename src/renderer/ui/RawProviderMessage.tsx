import { useState } from 'react';
import type { AgentProtocolMessageReference } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';

export function RawProviderMessage({
  reference
}: {
  reference?: AgentProtocolMessageReference;
}) {
  const [raw, setRaw] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  if (!reference) {
    return <span className="provenance-badge">Provider response · journaled</span>;
  }

  const load = async () => {
    if (raw || loading) {
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const record = await taskManagerApi.readProtocolMessage({ reference });
      setRaw(prettyJson(record.raw));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read provider event.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <details className="raw-provider-event" onToggle={(event) => {
      if (event.currentTarget.open) {
        void load();
      }
    }}>
      <summary>
        Raw provider event · #{reference.sequence}
      </summary>
      {error ? <p className="form-error">{error}</p> : null}
      <pre>{loading ? 'Loading…' : raw ?? 'Open to load the journal entry.'}</pre>
    </details>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
