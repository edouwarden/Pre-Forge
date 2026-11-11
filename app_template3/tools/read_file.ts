import { readFileSync } from 'fs';
import { resolveInsideProject } from './paths';

export async function read_file(filePath: string) {
  try {
    const fullPath = resolveInsideProject(filePath, true);
    const content = readFileSync(fullPath, 'utf-8');
    return content;
  } catch (error: any) {
    return { error: `Failed to read file: ${error.message}` };
  }
}
