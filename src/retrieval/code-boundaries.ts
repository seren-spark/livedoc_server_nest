/**
 * @file 代码块安全切分。识别代码结构和可切边界，避免拆断不可分割的代码单元。
 */
import ts from "typescript";

export interface CodeRange {
  start: number;
  end: number;
  owner?: string;
}

export class OversizedCodeError extends Error {}

/**
 * JS/TS 使用语法树确定切分边界，其他语言或不完整代码按完整行切分。
 *
 *  JS/TS use their parser; other languages and incomplete examples use full lines.
 *
 * @param code 错误标识或待解析的代码内容。
 * @param language 代码块使用的语言标识。
 * @param fits 判断内容是否满足当前预算的回调。
 * @returns 整理后的结果列表。
 */
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
      /**
       * 遍历代码语法树，记录函数归属和可安全切分的语句边界。
       *
       * @param node 当前语法树或编辑器节点。
       */
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
    /**
     * 查找指定代码位置所属的语法结构。
     *
     * @param end 区间结束位置。
     * @returns 整理后的文本或标识；未找到或不可用时可能为空。
     */
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
