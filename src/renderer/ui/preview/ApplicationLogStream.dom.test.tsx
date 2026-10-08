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
      matchesOnly={false}
      follow={false}
      onFollow={() => {}}
      truncated={false}
      expired={false}
      empty=""
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
    matchesOnly: false,
    follow: true,
    onFollow,
    truncated: false,
    expired: false,
    empty: '',
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
    screen.getByRole('button', { name: '1 new lines · Resume follow' })
  );
  expect(onFollow).toHaveBeenLastCalledWith(true);
  fireEvent.keyDown(stream, { key: 'Home' });
  expect(stream.scrollTop).toBe(0);
  fireEvent.keyDown(stream, { key: 'End' });
  expect(stream.scrollTop).toBe(1000);
});


it('keeps follow paused when failure navigation itself scrolls to the end', () => {
  const onFollow = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function () {
    const stream = this.closest('[role="region"]') as HTMLElement;
    Object.defineProperties(stream, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
    stream.scrollTop = 800;
  };
  try {
    render(<ApplicationLogStream name="Application" lines={[...lines,
      { id: 3, source: 'web', text: 'web failed', marker: 'failed' }]}
      lanes={false} query="" matchesOnly={false} follow={false} onFollow={onFollow}
      truncated={false} expired={false} empty="" failureTarget="failed:web" active />);
    const stream = screen.getByRole('region', { name: 'Application logs' });
    fireEvent.scroll(stream);
    expect(onFollow).not.toHaveBeenCalled();
    stream.scrollTop = 100;
    fireEvent.scroll(stream);
    stream.scrollTop = 800;
    fireEvent.scroll(stream);
    expect(onFollow).toHaveBeenLastCalledWith(true);
  } finally { HTMLElement.prototype.scrollIntoView = original; }
});
