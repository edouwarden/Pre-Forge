import { wsClient } from './wsClient.ts';
import { z } from 'zod';
import { plan } from './agents/planner.ts';
import { createAssistantMessage, createSystemMessage, createUserMessage, Message } from './tools/ai';
import { think, think_with_tools } from './agents/thinking.ts';
import { coder } from './agents/coder.ts';

const MAX_TASKS = 50;

function parseTasks(planText: string): string[] {
  return planText
    .split(/[\n;]+/)
    .map(task => task.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_TASKS);
}

function parseTask(task: string): { agent: string; description: string } {
  const match = task.match(/^([A-Za-z0-9_]+)\.\s*(.*)$/s);
  if (!match) {
    return { agent: 'thinking_employe', description: task };
  }
  return { agent: match[1].toLowerCase(), description: match[2].trim() || task };
}

class Manager {
  private async handleFailure(errors: string[]): Promise<void> {
    wsClient.error('Manager', 'Task failed', errors);
  }

  private async handleSuccess(result: any): Promise<void> {
    wsClient.info('Manager', 'Task completed successfully', result);
  }

  async handleInstruction(prompt: string, attachments: string[] = []): Promise<void> {
    try {
      let history: Message[] = [];
      let taskUnderstanding: string;

      wsClient.info('Manager', 'Starting task analysis 🔎');

      while (true) {
        taskUnderstanding = String(await plan(`${prompt}\n${attachments.join('\n')}`, history));

        if (!taskUnderstanding.trim()) {
          wsClient.error('Manager', '❌ The planner returned an empty plan');
          return;
        }

        wsClient.debug('Manager', 'My plan is:\n' + taskUnderstanding);

        const userConfirmation = await wsClient.ask(
          'Manager',
          'Here is my plan:\n' + taskUnderstanding + '\nConfirm the task?',
          z.enum(['yes', 'retry', 'stop']),
        );

        if (userConfirmation === 'stop') {
          wsClient.info('Manager', '❌ Task cancelled by user ❌');
          return;
        }

        if (userConfirmation === 'retry') {
          const problem = await wsClient.ask('Manager', 'What is the problem?', z.string());
          wsClient.info('Manager', 'Task will be retried ⚠️', { problem });
          prompt += `\n${problem}`;
          continue;
        }

        wsClient.info('Manager', 'Task confirmed by user ✅');
        break;
      }

      const tasks = parseTasks(taskUnderstanding);
      if (tasks.length === 0) {
        wsClient.error('Manager', '❌ No executable tasks found in the plan');
        return;
      }

      history = [createUserMessage(prompt), createAssistantMessage(taskUnderstanding)];

      for (const task of tasks) {
        if (wsClient.AgentshouldStop) {
          wsClient.warn('Manager', '⏹️ Stop requested by the user');
          break;
        }

        const { agent, description } = parseTask(task);
        wsClient.info('Manager', `▶️ ${agent}: ${description}`);

        try {
          let taskResult: any;
          if (agent.includes('coder')) {
            taskResult = await coder(description, history);
          } else if (agent.includes('think')) {
            taskResult = await think_with_tools(description, history);
          } else {
            taskResult = await think(description, history);
          }

          history.push(createAssistantMessage(`${agent}: ${String(taskResult)}`));
          wsClient.info('Manager', `✅ ${agent}`, { result: taskResult });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          wsClient.error('Manager', `❌ ${agent} failed`, { error: message });
          history.push(createSystemMessage(`Task failed (${agent}): ${message}`));
        }
      }

      const resume = await think(
        "Fais moi un resume des operations effectuees par l'assistant dans l'historique des messages",
        history,
      );
      wsClient.info('Manager', '📃 Resume of the tasks', resume);

      const result = await think(
        "Selon l'historique des messages, quelle est la reponse a la question initiale ?",
        history,
      );
      wsClient.info('Manager', '🎯 Result of the tasks', result);

      await this.handleSuccess(result);
    } catch (error) {
      wsClient.error('Manager', '❌❌ Error processing instruction', error);
      await this.handleFailure([error instanceof Error ? error.message : String(error)]);
      throw error;
    }
  }
}

const manager = new Manager();
console.log('Manager started');

const prompt = process.env.command || '';
const attachments = (process.env.attachments || process.env.attachements || '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

if (!prompt) {
  console.error('Please provide an instruction');
  wsClient.error('Manager', '❌❌ Please provide an instruction, Manager stopped');
  process.exit(1);
}

wsClient.info('Manager', '🟢 Started, instruction received:', { prompt, attachments });

// The container is created with AutoRemove. Exit once the task is done so it
// does not linger forever, but give the last bridge messages a moment to flush.
try {
  await manager.handleInstruction(prompt, attachments);
} catch (error) {
  console.error(error);
} finally {
  await new Promise(resolve => setTimeout(resolve, 500));
  wsClient.close();
  process.exit(0);
}
