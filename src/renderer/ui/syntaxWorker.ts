import type { SyntaxLanguage, TokenLine } from '../model/syntaxHighlight';
import { highlightText } from '../model/syntaxTokenizer';

/** A file side for the worker to tokenize. */
export interface SyntaxRequest {
  id: number;
  language: SyntaxLanguage;
  text: string;
}

/** The side's runs per line; none when the tokenizer failed on it. */
export interface SyntaxAnswer {
  id: number;
  lines?: TokenLine[];
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SyntaxRequest>) => void) | null;
  postMessage(answer: SyntaxAnswer): void;
};

scope.onmessage = ({ data: { id, language, text } }) => {
  try {
    scope.postMessage({ id, lines: highlightText(language, text) });
  } catch {
    // A side the tokenizer cannot read stays plain; the requests after it are unaffected.
    scope.postMessage({ id });
  }
};
