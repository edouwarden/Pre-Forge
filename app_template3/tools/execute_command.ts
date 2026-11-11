import { exec } from 'child_process';
import { promisify } from 'util';
import { basename } from 'path';
import { PROJECT_ROOT } from './paths';

const execPromise = promisify(exec);

const DEFAULT_ALLOWED = [
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'echo',
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'bun', 'node', 'npx', 'tsc',
  'git', 'diff', 'sed', 'awk', 'wc', 'sort', 'uniq', 'test',
];

const rawAllowlist = process.env.ALLOWED_COMMANDS;
const allowlist = rawAllowlist === '*'
  ? null
  : new Set(
      (rawAllowlist ? rawAllowlist.split(',') : DEFAULT_ALLOWED)
        .map(item => item.trim())
        .filter(Boolean),
    );

const SHELL_META = /[;&|><`$()\n\r]/;

export async function execute_command(command: string) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { success: false, error: 'No command provided' };
  }
  if (command.length > 4000) {
    return { success: false, error: 'Command is too long' };
  }

  const executable = basename(command.trim().split(/\s+/)[0]);
  if (allowlist && !allowlist.has(executable)) {
    return {
      success: false,
      error: `Command "${executable}" is not allowed. Configure ALLOWED_COMMANDS to change this.`,
    };
  }
  if (allowlist && SHELL_META.test(command)) {
    return {
      success: false,
      error: 'Shell metacharacters are blocked while the allowlist is active. Set ALLOWED_COMMANDS=* to opt out.',
    };
  }

  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: PROJECT_ROOT,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    return {
      success: true,
      stdout,
      stderr: stderr || null,
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to execute command: ${error.message}`,
    };
  }
}
