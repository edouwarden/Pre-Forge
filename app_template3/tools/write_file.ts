import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { resolveInsideProject } from './paths';

export async function write_file(data: string) {
  try {
    // Protocol: "path,content". Only the first comma is a delimiter, so
    // content that contains commas is preserved.
    const comma = data.indexOf(',');
    if (comma < 0) {
      return { error: 'Expected "path,content"' };
    }

    const filePath = data.slice(0, comma).trim();
    const content = data.slice(comma + 1);
    const fullPath = resolveInsideProject(filePath);

    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');

    return { success: true, message: `File written to ${fullPath}` };
  } catch (error: any) {
    return { error: `Failed to write file: ${error.message}` };
  }
}
