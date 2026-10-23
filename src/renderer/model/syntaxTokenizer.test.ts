import { describe, expect, it } from 'vitest';
import { syntaxJob } from './syntaxHighlight';
import { highlightText } from './syntaxTokenizer';

/** Each line of a file side with its runs marked «kind:text» and the plain text between them as written. */
function marked(path: string, lines: string[]): string[] {
  const job = syntaxJob(path, lines)!;
  const tokens = highlightText(job.language, job.text);
  expect(tokens).toHaveLength(lines.length);
  return lines.map((line, index) => {
    let text = '';
    let at = 0;
    for (const { from, to, kind } of tokens[index]) {
      text += `${line.slice(at, from)}«${kind}:${line.slice(from, to)}»`;
      at = to;
    }
    return text + line.slice(at);
  });
}

describe('syntax tokenizer', () => {
  it('carries a comment and a template string opened on one line into the next', () => {
    expect(marked('src/a.ts', ['/* opens here', '   closes here */ const a = `one', 'two ${a} three`;'])).toEqual([
      '«comment:/* opens here»',
      '«comment:   closes here */» «keyword:const» a = «string:`one»',
      '«string:two »${a}«string: three`»;'
    ]);
  });

  it('carries the shell mode state across lines', () => {
    expect(marked('scripts/notes.sh', ["cat <<'EOF'", '$HOME is not expanded', 'EOF', 'echo "$HOME" # done'])).toEqual([
      "«function:cat» «string:<<'EOF'»",
      '«string:$HOME is not expanded»',
      '«string:EOF»',
      '«function:echo» «string:\"»$HOME«string:\"» «comment:# done»'
    ]);
  });

  it('colours each kind the same way from one run to the next', () => {
    expect(marked('src/Row.tsx', [
      'export function Row({ line }: Props): JSX.Element {',
      '  return <Tooltip label="Copy" count={2}>{line}</Tooltip>; // one row'
    ])).toEqual([
      '«keyword:export» «keyword:function» «function:Row»({ line }: «type:Props»): «type:JSX».«type:Element» {',
      '  «keyword:return» <«tag:Tooltip» «attribute:label»=«string:"Copy"» «attribute:count»={«number:2»}>{line}</«tag:Tooltip»>; «comment:// one row»'
    ]);
    expect(marked('package.json', ['{ "name": "task-monki", "private": true, "version": 4 }'])).toEqual([
      '{ «attribute:"name"»: «string:"task-monki"», «attribute:"private"»: «number:true», «attribute:"version"»: «number:4» }'
    ]);
    expect(marked('docs/README.md', ['## Syntax colour', '```ts', 'const answer = 42;', '```'])).toEqual([
      '«tag:## Syntax colour»',
      '```«attribute:ts»',
      '«keyword:const» answer = «number:42»;',
      '```'
    ]);
  });
});
