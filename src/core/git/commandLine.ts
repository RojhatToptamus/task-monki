export interface ParsedCommandLine {
  executable: string;
  argv: string[];
}

export function parseCommandLine(commandLine: string): ParsedCommandLine {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of commandLine.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += '\\';
  }

  if (quote) {
    throw new Error('Unclosed quote in command line.');
  }

  if (current) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    throw new Error('Command is required.');
  }

  return {
    executable: tokens[0],
    argv: tokens.slice(1)
  };
}
