import { readFileSync } from 'fs';
import { join } from 'path';
import {
    query,
    Message,
    LLM_options,
    createAssistantMessage,
    createUserMessage,
    createSystemMessage,
} from '../tools/ai';
import { wsClient } from '../wsClient';
import { z } from 'zod';

export enum Agents {
    THINKING = 'thinking_employe',
    PLANNER = 'planner_employe',
    CODER = 'coder_employe',
}

export enum Tools {
    GET_CURRENT_TIME = 'get_current_time',
    WRITE_FILE = 'write_file',
    READ_FILE = 'read_file',
    EXECUTE_COMMAND = 'execute_command',
    ASK_USER = 'ask_user',
}

interface Tool {
    name: string;
    description: string;
    input?: Record<string, any>;
    output?: Record<string, any>;
}

interface AIResponse {
    type: 'tool' | 'end';
    content: string | null;
    name?: string | null;
}

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const MAX_TOOL_RESULT = 20_000;
const MAX_TOOL_REPEATS = 3;

export async function start(
    initialPrompt: string,
    tools_allowed: string[],
    goal: string,
    chatHistory?: Message[],
    expectedResult?: string,
    options?: LLM_options,
): Promise<any> {
    chatHistory = chatHistory || [];

    const toolsPath = join(__dirname, '../tools/tools.json');
    const toolsData = JSON.parse(readFileSync(toolsPath, 'utf-8'));
    const tools: Tool[] = toolsData.tools;

    const accessible: Tool[] = tools.filter(tool =>
        tools_allowed.length > 0 &&
        (tools_allowed.includes('all') || tools_allowed.includes(tool.name)),
    );

    const systemPrompt: Message = createSystemMessage(
        initialPrompt +
        (accessible.length > 0
            ? `\n\nTu peux, uniquement si c'est necessaire pour remplir l'objectif, utiliser les outils suivants:\n${accessible
                  .map(tool => `- ${tool.name}: ${tool.description}`)
                  .join('\n')}`
            : '') +
        '\nUne fois l\'objectif rempli, Tu dois repondre avec "type":"end" et le resultat.',
    );

    chatHistory = [...chatHistory, systemPrompt, createUserMessage(goal)];

    let lastTool = '';
    let toolCount = 0;

    while (true) {
        const response = await query(
            chatHistory,
            accessible.length > 0
                ? z.object({
                      type: z.enum(['tool', 'end']),
                      name: z
                          .string()
                          .nullable()
                          .optional()
                          .describe('tool_name as string | null'),
                      content: z
                          .string()
                          .nullable()
                          .describe(
                              `tool_arguments as string | ${
                                  expectedResult ? expectedResult : 'resultat demander par le systeme'
                              } as string | null`,
                          ),
                  })
                : z.object({
                      type: z.enum(['end']),
                      content: z
                          .string()
                          .describe(
                              `${expectedResult ? expectedResult : 'resultat demander par le systeme'} as string`,
                          ),
                  }),
            options,
        );

        if (!response.success || response.data == null) {
            wsClient.error('Thinking', '❌AI Error', { error: response.error });
            throw new Error(`AI Error: ${JSON.stringify(response)}`);
        }

        const data = response.data as AIResponse;

        if (data.type === 'end') {
            return data.content;
        }

        if (data.type !== 'tool') {
            throw new Error(`Unexpected response type: ${String(data.type)}`);
        }
        if (!data.name || !TOOL_NAME.test(data.name)) {
            throw new Error(`Invalid tool name: ${String(data.name)}`);
        }
        if (!accessible.some(tool => tool.name === data.name)) {
            throw new Error(`Tool not available: ${data.name}`);
        }

        if (data.name === lastTool) {
            toolCount++;
        } else {
            lastTool = data.name;
            toolCount = 1;
        }
        if (toolCount > MAX_TOOL_REPEATS) {
            wsClient.error('Thinking', '❌Tool spammed', { error: `Tool spammed: ${data.name}` });
            return 'failed';
        }

        try {
            const toolModule = await import(`../tools/${data.name}`);
            const toolResult = await toolModule[data.name](data.content ?? '');

            const serialized = JSON.stringify(toolResult) ?? 'null';
            chatHistory.push(createAssistantMessage(JSON.stringify(data)));
            chatHistory.push(
                createSystemMessage(
                    `Resultat de ${data.name}: ${serialized.slice(0, MAX_TOOL_RESULT)}`,
                ),
            );
            chatHistory.push(
                createSystemMessage(
                    `${data.name} a ete utilise. Votre but reste de remplir l'objectif demande par l'utilisateur.\nUne fois l'objectif rempli, repondez avec "end" et le resultat.`,
                ),
            );
        } catch (error) {
            wsClient.error('Thinking', '❌Error processing response', { error });
            throw error;
        }
    }
}
