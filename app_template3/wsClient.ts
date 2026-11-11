import { z } from 'zod';

interface Message {
    type: 'info' | 'error' | 'warn' | 'debug' | 'question' | 'answer' | 'auth';
    context: string;
    message: string;
    meta?: any;
    timestamp: string;
    id?: string;
    expectedFormat?: string;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    expectedFormat?: z.ZodType<any>;
}

export class WSClient {
    private socket: WebSocket;
    private readonly url: string;
    public isConnected: boolean = false;
    public AgentshouldStop: boolean = false;
    private authenticated: boolean = false;
    private authTimer?: ReturnType<typeof setTimeout>;
    private pendingRequests: Map<string, PendingRequest> = new Map();

    constructor(url: string = process.env.WS_URL || 'ws://host.docker.internal:3000/ws') {
        this.url = url;
        this.socket = new WebSocket(url);
        this.setupEventListeners();
    }

    private sendRaw(message: Message): boolean {
        if (this.socket.readyState !== WebSocket.OPEN) return false;
        try {
            this.socket.send(JSON.stringify(message));
            return true;
        } catch (error) {
            console.error('WebSocket send failed:', error);
            return false;
        }
    }

    private rejectPending(reason: any): void {
        for (const [, request] of this.pendingRequests) {
            request.reject(reason);
        }
        this.pendingRequests.clear();
    }

    private setupEventListeners() {
        this.socket.onopen = () => {
            const token = process.env.BRIDGE_TOKEN;
            if (!token) {
                console.error('BRIDGE_TOKEN is required');
                this.socket.close();
                return;
            }

            this.sendRaw({
                type: 'auth',
                context: 'worker',
                message: token,
                timestamp: new Date().toISOString(),
            });

            this.authTimer = setTimeout(() => {
                if (!this.authenticated) {
                    console.error('Bridge authentication timed out');
                    this.socket.close();
                }
            }, 10_000);
        };

        this.socket.onclose = (event) => {
            this.isConnected = false;
            this.authenticated = false;
            if (this.authTimer) clearTimeout(this.authTimer);
            console.log('Disconnected from WebSocket server');
            console.log('Close event code:', event.code);
            console.log('Close event reason:', event.reason);
            this.rejectPending(new Error('WebSocket connection closed'));
        };

        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            console.error('Attempting to connect to:', this.url);
            this.rejectPending(error);
        };

        this.socket.onmessage = (event) => {
            let message: Message;
            try {
                message = JSON.parse(event.data as string) as Message;
            } catch (error) {
                console.error('Error parsing message:', error);
                return;
            }

            if (message.type === 'auth') {
                if (message.message === 'ok') {
                    this.authenticated = true;
                    this.isConnected = true;
                    if (this.authTimer) clearTimeout(this.authTimer);
                    console.log('Authenticated with WebSocket server');
                } else {
                    console.error('Bridge authentication rejected');
                    this.socket.close();
                }
                return;
            }

            if (!this.authenticated) return;

            if (message.message === 'stop') {
                this.AgentshouldStop = true;
            }

            // A supervisor-side failure (for example a question timeout) should
            // reject the matching ask() instead of leaving it until its own timer.
            if (message.type === 'error' && message.id) {
                const failed = this.pendingRequests.get(message.id);
                if (failed) {
                    this.pendingRequests.delete(message.id);
                    failed.reject(new Error(message.message));
                }
                return;
            }

            if (message.type !== 'answer' || !message.id) return;

            const request = this.pendingRequests.get(message.id);
            if (!request) return;

            try {
                let value: any = message.message;
                if (request.expectedFormat) {
                    if (!(request.expectedFormat instanceof z.ZodString)) {
                        try {
                            value = JSON.parse(message.message);
                        } catch {
                            value = message.message;
                        }
                    }
                    const validated = request.expectedFormat.safeParse(value);
                    if (!validated.success) {
                        request.reject(new Error(`Response does not match expected format: ${validated.error.message}`));
                        this.pendingRequests.delete(message.id);
                        return;
                    }
                    value = validated.data;
                }

                this.pendingRequests.delete(message.id);
                request.resolve(value);
            } catch (error) {
                this.pendingRequests.delete(message.id);
                request.reject(error);
            }
        };
    }

    public send(message: Message): boolean {
        if (!this.isConnected) {
            console.warn('Not connected to server');
            return false;
        }
        return this.sendRaw(message);
    }

    public async ask(
        context: string,
        question: string,
        expectedFormat?: z.ZodType<any>,
        meta: any = {},
        timeout: number = 10 * 60 * 1000,
    ): Promise<any> {
        if (!this.isConnected) throw new Error('Not connected to server');

        const id = crypto.randomUUID();
        const message: Message = {
            type: 'question',
            context,
            message: question,
            meta,
            timestamp: new Date().toISOString(),
            id,
            expectedFormat: expectedFormat ? JSON.stringify(expectedFormat) : undefined,
        };

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error('Request timed out'));
            }, timeout);

            this.pendingRequests.set(id, {
                resolve: value => {
                    clearTimeout(timeoutId);
                    resolve(value);
                },
                reject: reason => {
                    clearTimeout(timeoutId);
                    reject(reason);
                },
                expectedFormat,
            });

            if (!this.send(message)) {
                clearTimeout(timeoutId);
                this.pendingRequests.delete(id);
                reject(new Error('Failed to send question'));
            }
        });
    }

    public async askUser(question: string, timeout: number = 10 * 60 * 1000): Promise<string> {
        return this.ask('Agent', question, z.string(), {}, timeout);
    }

    public info(context: string, message: string, meta: any = {}) {
        this.send({
            type: 'info',
            context,
            message,
            meta,
            timestamp: new Date().toISOString(),
        });
    }

    public error(context: string, message: string, meta: any = {}) {
        this.send({
            type: 'error',
            context,
            message,
            meta,
            timestamp: new Date().toISOString(),
        });
    }

    public warn(context: string, message: string, meta: any = {}) {
        this.send({
            type: 'warn',
            context,
            message,
            meta,
            timestamp: new Date().toISOString(),
        });
    }

    public debug(context: string, message: string, meta: any = {}) {
        this.send({
            type: 'debug',
            context,
            message,
            meta,
            timestamp: new Date().toISOString(),
        });
    }

    public close() {
        this.socket.close();
    }
}

let wsClientInstance: WSClient | null = null;

async function getWSClient(): Promise<WSClient> {
    if (wsClientInstance) return wsClientInstance;

    wsClientInstance = new WSClient();

    for (let i = 0; i < 30; i++) {
        if (wsClientInstance.isConnected) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!wsClientInstance.isConnected) {
        console.error('Failed to connect to WebSocket server');
        process.exit(1);
    }

    return wsClientInstance;
}

const wsClient = await getWSClient();

export { wsClient };
