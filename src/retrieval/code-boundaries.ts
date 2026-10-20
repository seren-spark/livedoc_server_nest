import ts from "typescript";

export interface CodeRange {
  start: number;
  end: number;
  owner?: string;
}

export class OversizedCodeError extends Error {}

/** JS/TS use their parser; other languages and incomplete examples use full lines. */
export function codeRanges(
  code: string,
  language: string,
  fits: (start: number, end: number, owner?: string) => boolean,
): CodeRange[] {
  const kinds: Record<string, ts.ScriptKind> = {
    ts: ts.ScriptKind.TS, typescript: ts.ScriptKind.TS,
    tsx: ts.ScriptKind.TSX, js: ts.ScriptKind.JS, javascript: ts.ScriptKind.JS,
    jsx: ts.ScriptKind.JSX,
  };
  const primary = new Set<number>([code.length]);
  const secondary = new Set<number>();
  const owners: Array<{ start: number; end: number; name: string }> = [];
  const kind = kinds[language.toLowerCase()];
  if (kind !== undefined) {
    const source = ts.createSourceFile("chunk", code, ts.ScriptTarget.Latest, true, kind);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
    if (!diagnostics.length) {
      for (const statement of source.statements) primary.add(statement.end);
      const visit = (node: ts.Node) => {
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
          for (const member of node.members) secondary.add(member.end);
        }
        if (ts.isBlock(node)) {
          secondary.add(node.getStart(source) + 1);
          for (const statement of node.statements) secondary.add(statement.end);
        }
        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
          const name = "name" in node && node.name
            ? node.name.getText(source)
            : ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(source)
            : ts.isConstructorDeclaration(node) ? "constructor" : "anonymous";
          let parent = node.parent;
          while (parent && !ts.isClassDeclaration(parent) && !ts.isClassExpression(parent)) parent = parent.parent;
          const className = parent && (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))
            ? parent.name?.getText(source) : undefined;
          const signature = `${className ? `${className}.` : ""}${name}(${node.parameters.map((parameter) => parameter.getText(source)).join(", ")})`;
          owners.push({ start: node.getFullStart(), end: node.end, name: signature });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  const lines = [...code.matchAll(/\n/gu)].map((match) => match.index + 1);
  lines.push(code.length);
  const boundaryGroups = [primary, secondary, new Set(lines)].map((group) => [...group].sort((a, b) => a - b));
  const result: CodeRange[] = [];
  let cursor = 0;
  while (cursor < code.length) {
    if (!code.slice(cursor).trim()) {
      if (result.length) result[result.length - 1]!.end = code.length;
      break;
    }
    const contentStart = cursor + (code.slice(cursor).match(/^\s*/u)?.[0].length ?? 0);
    const owner = owners.filter((entry) => entry.start <= contentStart && entry.end > contentStart)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    const ownerAt = (end: number) => owner && end <= owner.end ? owner.name : undefined;
    let end: number | undefined;
    for (const boundaries of boundaryGroups) {
      for (const boundary of boundaries) {
        if (boundary <= cursor) continue;
        if (!fits(cursor, boundary, ownerAt(boundary))) break;
        if (code.slice(cursor, boundary).trim()) end = boundary;
      }
      if (end !== undefined) break;
    }
    if (end === undefined) {
      throw new OversizedCodeError("Code contains a line exceeding the chunk budget; shorten the line or increase CHUNK_MAX_TOKENS");
    }
    result.push({ start: cursor, end, owner: ownerAt(end) });
    cursor = end;
  }
  return result;
}
