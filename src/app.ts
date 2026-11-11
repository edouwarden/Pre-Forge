import {
    Client,
    GatewayIntentBits,
    Events,
    CommandInteraction,
    TextChannel,
    Message as DiscordMessage,
} from 'discord.js';
import Docker from 'dockerode';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { timingSafeEqual } from 'crypto';
import type { ServerWebSocket } from 'bun';

dotenv.config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const QUESTION_CHANNEL_ID = process.env.QUESTION_CHANNEL_ID;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const WS_HOST = process.env.WS_HOST || '0.0.0.0';
const WS_PORT = Number(process.env.WS_PORT || 3000);
const WORKER_IMAGE = process.env.WORKER_IMAGE || 'bun-typescript-app';
const PROJECTS_ROOT = path.resolve(process.cwd(), 'projects');
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DISCORD_MESSAGE = 1900;
const MAX_PROMPT_LENGTH = 8000;

const AUTHORIZED_USER_IDS = (process.env.AUTHORIZED_USER_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is required');
if (!QUESTION_CHANNEL_ID) throw new Error('QUESTION_CHANNEL_ID is required');
if (BRIDGE_TOKEN.length < 16) throw new Error('BRIDGE_TOKEN must be at least 16 characters');
if (AUTHORIZED_USER_IDS.length === 0) throw new Error('AUTHORIZED_USER_IDS must contain at least one Discord user ID');
if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required by the supervisor LLM proxy');

fs.mkdirSync(PROJECTS_ROOT, { recursive: true });

// ---------------------------------------------------------------------------
// Bridge protocol
// ---------------------------------------------------------------------------

interface Message {
    type: 'info' | 'error' | 'warn' | 'debug' | 'question' | 'answer' | 'auth';
    context: string;
    message: string;
    meta?: any;
    timestamp: string;
    id?: string;
    expectedFormat?: string;
}

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
});

const activeConnections = new Set<ServerWebSocket<unknown>>();
const pendingAuth = new Map<ServerWebSocket<unknown>, ReturnType<typeof setTimeout>>();
let questionChannel: TextChannel | null = null;
let questionQueue: Promise<void> = Promise.resolve();

function tokenMatches(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false;
    const provided = Buffer.from(candidate);
    const expected = Buffer.from(BRIDGE_TOKEN);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function truncate(value: string, max = MAX_DISCORD_MESSAGE): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function describeMeta(meta: unknown): string {
    if (meta == null) return '';
    if (typeof meta === 'string') return meta;
    try {
        const json = JSON.stringify(meta);
        return json === '{}' ? '' : json;
    } catch {
        return String(meta);
    }
}

async function sendMessageToDiscord(data: Message): Promise<void> {
    try {
        if (!questionChannel) throw new Error('No question channel available');
        const emoji = data.type === 'info' ? 'ℹ️' : data.type === 'error' ? '❌' : '⚠️';
        const meta = describeMeta(data.meta);
        const content = truncate(`${emoji} **${data.context}**\n${data.message}${meta ? `: ${meta}` : ''}`);
        await questionChannel.send({ content, allowedMentions: { parse: [] } });
    } catch (error) {
        console.error('Error sending message to Discord:', error, data);
    }
}

// ---------------------------------------------------------------------------
// Host-side LLM proxy
//
// Workers never receive OPENROUTER_API_KEY. They call this endpoint with the
// bridge token; the supervisor injects the real key and forwards the request.
// ---------------------------------------------------------------------------

async function handleLlmProxy(req: Request): Promise<Response> {
    const authorization = req.headers.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!tokenMatches(token)) return new Response('Unauthorized', { status: 401 });

    const body = await req.text();
    if (body.length > 2_000_000) return new Response('Payload too large', { status: 413 });

    try {
        const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body,
        });
        return new Response(upstream.body, {
            status: upstream.status,
            headers: {
                'Content-Type': upstream.headers.get('content-type') || 'application/json',
            },
        });
    } catch (error) {
        console.error('LLM proxy error:', error);
        return new Response('Upstream LLM request failed', { status: 502 });
    }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const server = Bun.serve({
    hostname: WS_HOST,
    port: WS_PORT,
    async fetch(req, server) {
        const url = new URL(req.url);

        if (req.method === 'POST' && url.pathname === '/llm/chat/completions') {
            return handleLlmProxy(req);
        }
        if (req.method === 'GET' && url.pathname === '/health') {
            return new Response('ok');
        }
        if (url.pathname !== '/ws') {
            return new Response('Not found', { status: 404 });
        }
        if (server.upgrade(req)) return;
        return new Response('Upgrade failed', { status: 400 });
    },
    websocket: {
        open(ws) {
            const timeout = setTimeout(() => {
                pendingAuth.delete(ws);
                try {
                    ws.close(1008, 'Authentication timeout');
                } catch {
                    // Socket already closed.
                }
            }, 5_000);
            pendingAuth.set(ws, timeout);
        },
        message(ws, raw) {
            let data: Message;
            try {
                data = JSON.parse(String(raw)) as Message;
            } catch {
                ws.close(1003, 'Invalid JSON');
                return;
            }

            const timeout = pendingAuth.get(ws);
            if (timeout) {
                if (data.type !== 'auth' || !tokenMatches(data.message)) {
                    ws.close(1008, 'Unauthorized');
                    return;
                }
                clearTimeout(timeout);
                pendingAuth.delete(ws);
                activeConnections.add(ws);
                ws.send(JSON.stringify({
                    type: 'auth',
                    context: 'server',
                    message: 'ok',
                    timestamp: new Date().toISOString(),
                } satisfies Message));
                return;
            }

            if (data.type === 'auth') {
                ws.close(1008, 'Already authenticated');
                return;
            }

            switch (data.type) {
                case 'question':
                    void enqueueQuestion(data, ws);
                    break;
                case 'debug':
                    console.log(`[DEBUG] ${data.context}: ${data.message}`, data.meta);
                    break;
                case 'info':
                case 'error':
                case 'warn':
                    void sendMessageToDiscord(data);
                    break;
                default:
                    break;
            }
        },
        close(ws) {
            const timeout = pendingAuth.get(ws);
            if (timeout) clearTimeout(timeout);
            pendingAuth.delete(ws);
            activeConnections.delete(ws);
        },
    },
});

// ---------------------------------------------------------------------------
// Discord handlers
// ---------------------------------------------------------------------------

client.once(Events.ClientReady, async () => {
    console.log(`Bot connected as ${client.user?.tag}`);

    try {
        const channel = await client.channels.fetch(QUESTION_CHANNEL_ID);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            throw new Error('QUESTION_CHANNEL_ID is not a guild text channel');
        }
        questionChannel = channel as TextChannel;
        console.log(`Question channel set to: ${questionChannel.name}`);
    } catch (error) {
        console.error('Unable to initialize question channel:', error);
        process.exit(1);
    }
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'create-container') {
        await handleCreateContainer(interaction);
    }
});

// ---------------------------------------------------------------------------
// Container creation
// ---------------------------------------------------------------------------

function resolveWorkspace(folderName: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(folderName)) {
        throw new Error('Invalid folder name');
    }

    const workdir = path.resolve(PROJECTS_ROOT, folderName);
    if (path.dirname(workdir) !== PROJECTS_ROOT) {
        throw new Error('Invalid folder path');
    }
    if (!fs.existsSync(workdir) || !fs.lstatSync(workdir).isDirectory()) {
        throw new Error('Folder does not exist or is not a directory');
    }

    const realRoot = fs.realpathSync(PROJECTS_ROOT);
    const realWorkdir = fs.realpathSync(workdir);
    if (realWorkdir !== realRoot && !realWorkdir.startsWith(realRoot + path.sep)) {
        throw new Error('Folder resolves outside projects/');
    }
    return realWorkdir;
}

function validateContainerName(name: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
        throw new Error('Invalid container name');
    }
}

async function handleCreateContainer(interaction: CommandInteraction): Promise<void> {
    if (!AUTHORIZED_USER_IDS.includes(interaction.user.id)) {
        await interaction.reply({ content: 'You are not authorized to create containers.', ephemeral: true });
        return;
    }

    const folderName = interaction.options.get('folder')?.value as string;
    const containerName = interaction.options.get('name')?.value as string;
    const command = interaction.options.get('command')?.value as string;
    const attachmentsRaw = (interaction.options.get('attachments')?.value as string | undefined) || '';

    try {
        if (!command || command.length > MAX_PROMPT_LENGTH || command.includes('\0')) {
            throw new Error(`Command must be between 1 and ${MAX_PROMPT_LENGTH} characters`);
        }

        const attachments = attachmentsRaw
            .split(',')
            .map(item => item.trim())
            .filter(Boolean)
            .slice(0, 20);

        const workdir = resolveWorkspace(folderName);
        validateContainerName(containerName);

        await interaction.deferReply({ ephemeral: true });

        const container = await docker.createContainer({
            Image: WORKER_IMAGE,
            name: containerName,
            WorkingDir: '/app',
            Env: [
                `command=${command}`,
                `attachments=${attachments.join(',')}`,
                `BRIDGE_TOKEN=${BRIDGE_TOKEN}`,
                `WS_URL=ws://host.docker.internal:${WS_PORT}/ws`,
                `LLM_ENDPOINT=http://host.docker.internal:${WS_PORT}/llm/chat/completions`,
                `ALLOWED_COMMANDS=${process.env.ALLOWED_COMMANDS || ''}`,
            ],
            HostConfig: {
                Binds: [`${workdir}:/app`],
                NetworkMode: 'bridge',
                ExtraHosts: ['host.docker.internal:host-gateway'],
                AutoRemove: true,
                Memory: 2 * 1024 * 1024 * 1024,
                NanoCpus: 2_000_000_000,
                PidsLimit: 512,
                CapDrop: ['ALL'],
                SecurityOpt: ['no-new-privileges'],
                Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=512m' },
            },
        });

        await container.start();

        await interaction.editReply(
            `Container "${containerName}" created and started.\n` +
            `- Folder: ${folderName} -> /app\n` +
            `- Container ID: ${container.id}\n` +
            `- Instruction: ${command}\n` +
            `- Network: bridge (host.docker.internal:${WS_PORT})\n` +
            `- LLM access: host-side proxy\n` +
            `- Command allowlist: ${process.env.ALLOWED_COMMANDS || 'worker default'}`,
        );
    } catch (error) {
        console.error('Error creating container:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(`Could not create the container: ${message}`);
        } else {
            await interaction.reply({ content: `Could not create the container: ${message}`, ephemeral: true });
        }
    }
}

// ---------------------------------------------------------------------------
// Human escalation
//
// Questions are serialized: one collector at a time per channel, otherwise two
// concurrent questions would race for the same human reply.
// ---------------------------------------------------------------------------

function enqueueQuestion(data: Message, ws: ServerWebSocket<unknown>): Promise<void> {
    const run = () => processQuestion(data, ws);
    questionQueue = questionQueue.then(run, run);
    return questionQueue;
}

async function processQuestion(data: Message, ws: ServerWebSocket<unknown>): Promise<void> {
    try {
        if (!questionChannel) throw new Error('No question channel available');

        let formatDisplay = '';
        if (data.expectedFormat) {
            try {
                const parsed = JSON.parse(data.expectedFormat);
                const values = parsed?._def?.values;
                if (Array.isArray(values) && values.length > 0) {
                    formatDisplay = `\n\n*Expected format*: \`${values.join(' | ')}\``;
                }
            } catch {
                // The schema is only used for display.
            }
        }

        let question = data.message;
        if (question.includes('Here is my plan:')) {
            question = question
                .replace(/;/g, '\n- ')
                .replace('Here is my plan:\n', 'Here is my plan:\n- ')
                .replace(/\n- $/g, '');
        }

        const questionMsg = await questionChannel.send({
            content: truncate(
                `📝 **Question**:\n${question}${formatDisplay}\n\nPlease answer within 10 minutes.`,
            ),
            allowedMentions: { parse: [] },
        });

        const filter = (m: DiscordMessage) =>
            !m.author.bot && m.channelId === questionChannel?.id && m.content.trim().length > 0;
        const collector = questionChannel.createMessageCollector({
            filter,
            time: QUESTION_TIMEOUT_MS,
            max: 1,
        });

        collector.on('collect', async message => {
            if (!activeConnections.has(ws)) {
                await questionMsg.reply('The worker disconnected before the answer was received.').catch(console.error);
                return;
            }

            const response: Message = {
                type: 'answer',
                context: data.context,
                message: message.content,
                timestamp: new Date().toISOString(),
                id: data.id,
            };

            try {
                ws.send(JSON.stringify(response));
            } catch (error) {
                console.error('Error sending answer to worker:', error);
                return;
            }

            await message.react('✅').catch(console.error);
            await questionMsg.reply({ content: 'Answer sent to the worker.', allowedMentions: { parse: [] } }).catch(console.error);
        });

        collector.on('end', collected => {
            if (collected.size > 0) return;

            const timeoutResponse: Message = {
                type: 'error',
                context: data.context,
                message: 'No response received within the time limit',
                timestamp: new Date().toISOString(),
                id: data.id,
            };

            if (activeConnections.has(ws)) {
                try {
                    ws.send(JSON.stringify(timeoutResponse));
                } catch (error) {
                    console.error('Error sending timeout to worker:', error);
                }
            }
            void questionMsg.reply('No response received within the time limit.').catch(console.error);
        });
    } catch (error) {
        console.error('Error processing question:', error);
        if (activeConnections.has(ws)) {
            try {
                ws.send(JSON.stringify({
                    type: 'error',
                    context: 'server',
                    message: `Failed to process question: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    timestamp: new Date().toISOString(),
                } satisfies Message));
            } catch {
                // Socket already closed.
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

console.log(`WebSocket server listening on ws://${WS_HOST}:${server.port}/ws`);
console.log(`LLM proxy listening on http://${WS_HOST}:${server.port}/llm/chat/completions`);

client.login(DISCORD_TOKEN).catch(error => {
    console.error('Discord login failed:', error);
    process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
    console.log(`Received ${signal}, shutting down...`);
    try {
        await client.destroy();
    } catch {
        // Best-effort shutdown.
    }
    server.stop();
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
