import { realpathSync } from 'fs';
import { dirname, resolve, sep } from 'path';

export const PROJECT_ROOT = resolve(process.env.PROJECT_DIR || '/app');

function isInside(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolve a user-supplied path inside the project root.
 *
 * This blocks `../` traversal and absolute paths, and follows symlinks for
 * paths that already exist. The container is still the real security boundary;
 * this is a guardrail so the agent stays inside its workspace.
 */
export function resolveInsideProject(filePath: string, mustExist = false): string {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
        throw new Error('Invalid path');
    }

    const fullPath = resolve(PROJECT_ROOT, filePath);
    if (!isInside(PROJECT_ROOT, fullPath)) {
        throw new Error('Path escapes the project root');
    }

    if (mustExist) {
        const realPath = realpathSync(fullPath);
        if (!isInside(PROJECT_ROOT, realPath)) {
            throw new Error('Path escapes the project root');
        }
        return realPath;
    }

    // If the parent exists, make sure it is not a symlink leaving the root.
    try {
        const realParent = realpathSync(dirname(fullPath));
        if (!isInside(PROJECT_ROOT, realParent)) {
            throw new Error('Path escapes the project root');
        }
    } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
    }

    return fullPath;
}
