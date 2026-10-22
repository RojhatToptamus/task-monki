/**
 * The `query=` argument for `gh api graphql`, on one line. GraphQL ignores the
 * whitespace, and a `gh` installed as a Windows batch shim runs through
 * cmd.exe, which drops everything after an argument's first line break.
 */
export function graphQlQueryArgument(query: string): string {
  return `query=${query.replace(/\s+/g, ' ').trim()}`;
}
