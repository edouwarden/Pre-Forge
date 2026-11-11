import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { resolveInsideProject } from './paths';

export async function write_file(data: string) {
  try {
    let filePath: string | undefined;
    let content: string | undefined;

    // Some models emit a JSON object instead of the documented "path,content"
    // string. Accept both so a single bad generation does not fail the task.
    const trimmed = data.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed?.path === 'string' && typeof parsed?.content === 'string') {
          filePath = parsed.path;
          content = parsed.content;
        }
      } catch {
        // Fall through to the comma protocol.
      }
    }

    if (filePath === undefined || content === undefined) {
      // Protocol: "path,content". Only the first comma is a delimiter, so
      // content that contains commas is preserved.
      const comma = data.indexOf(',');
      if (comma < 0) {
        return { error: 'Expected "path,content"' };
      }
      filePath = data.slice(0, comma).trim();
      content = data.slice(comma + 1);
    }

    const fullPath = resolveInsideProject(filePath);

    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');

    return { success: true, message: `File written to ${fullPath}` };
  } catch (error: any) {
    return { error: `Failed to write file: ${error.message}` };
  }
}
