import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ApplicationLogStream } from './ApplicationLogStream';

const lines = [
  { id: 1, source: 'install', text: 'packages installed' },
  { id: 2, source: 'web', text: 'listening on allocated port' }
];

it('copies a native multi-source selection with its source labels', () => {
  render(
    <ApplicationLogStream
      name="All"
      lines={lines}
      lanes
      query=""
      follow={false}
      onFollow={() => {}}
      truncated={false}
      active
    />
  );
  const stream = screen.getByRole('region', { name: 'All logs' });
  const range = document.createRange();
  range.setStart(screen.getByText('packages installed').firstChild!, 9);
  range.setEnd(screen.getByText('listening on allocated port').firstChild!, 9);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const setData = vi.fn();
  fireEvent.copy(stream, { clipboardData: { setData } });
  expect(setData).toHaveBeenCalledWith(
    'text/plain',
    '[install] installed\n[web] listening'
  );
  selection.removeAllRanges();
});

it('pauses on upward scrolling, retains incoming lines, and resumes explicitly', () => {
  const onFollow = vi.fn();
  const props = {
    name: 'All',
    lines,
    lanes: true,
    query: '',
    follow: true,
    onFollow,
    truncated: false,
    active: true
  };
  const view = render(<ApplicationLogStream {...props} />);
  const stream = screen.getByRole('region', { name: 'All logs' });
  Object.defineProperties(stream, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 }
  });
  stream.scrollTop = 100;
  fireEvent.scroll(stream);
  expect(onFollow).toHaveBeenLastCalledWith(false);
  view.rerender(
    <ApplicationLogStream
      {...props}
      follow={false}
      lines={[...lines, { id: 3, source: 'web', text: 'request received' }]}
    />
  );
  expect(stream.scrollTop).toBe(100);
  expect(screen.getByText('request received')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: '1 new line' })
  );
  expect(onFollow).toHaveBeenLastCalledWith(true);
  fireEvent.keyDown(stream, { key: 'Home' });
  expect(stream.scrollTop).toBe(0);
  fireEvent.keyDown(stream, { key: 'End' });
  expect(stream.scrollTop).toBe(1000);
});


it('keeps follow paused when failure navigation itself scrolls to the end', () => {
  const onFollow = vi.fn();
  const withMarker = [...lines, { id: 3, source: 'web', text: 'web', marker: 'failed' }];
  const props = { name: 'Application', lines: withMarker, lanes: false, query: '',
    follow: false, onFollow, truncated: false, active: true };
  const view = render(<ApplicationLogStream {...props} />);
  const stream = screen.getByRole('region', { name: 'Application logs' });
  Object.defineProperties(stream, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
  stream.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  const marker = stream.querySelector<HTMLElement>('[data-failure="true"]')!;
  marker.getBoundingClientRect = () => ({ top: 900 }) as DOMRect;
  Object.defineProperty(marker, 'offsetHeight', { value: 20 });
  view.rerender(<ApplicationLogStream {...props} failureTarget="failed:web" />);
  expect(stream.scrollTop).toBe(810);
  fireEvent.scroll(stream);
  expect(onFollow).not.toHaveBeenCalled();
  stream.scrollTop = 100;
  fireEvent.scroll(stream);
  stream.scrollTop = 800;
  fireEvent.scroll(stream);
  expect(onFollow).toHaveBeenLastCalledWith(true);
});

it('does not count output shown by a failure jump as new when the marker was observed first', () => {
  // The status marker can be observed before the log read that contains its
  // output, so it keeps a smaller offset while sitting after that output.
  const output = [
    { id: 10, source: 'migrate', text: 'applying 0003_add_tags.sql' },
    { id: 40, source: 'migrate', text: 'Error: relation "notes" does not exist' },
    { id: 0, source: 'migrate', text: 'migrate', marker: 'failed' }
  ];
  render(
    <ApplicationLogStream name="Application" lines={output} lanes={false} query=""
      follow={false} onFollow={() => {}} truncated={false} failureTarget="run:migrate" active />
  );
  expect(screen.queryByRole('button', { name: /new line/ })).toBeNull();
});
