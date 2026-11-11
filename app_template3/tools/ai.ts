import { z } from 'zod';
import { wsClient } from '../wsClient';

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'http://host.docker.internal:3000/llm/chat/completions';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';

if (!BRIDGE_TOKEN) {
  throw new Error('BRIDGE_TOKEN is required');
}

// Subtypes first
const TextContent = z.object({
  type: z.literal('text'),
  text: z.string()
});

const ImageContentPart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(), // URL or base64 encoded image data
    detail: z.string().optional().default('auto')
  })
});

const ContentPart = z.discriminatedUnion('type', [
  TextContent,
  ImageContentPart
]);

export type Message = z.infer<typeof Message>;
const Message = z.discriminatedUnion('role', [
  z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.union([z.string(), z.array(ContentPart)]),
    name: z.string().optional()
  }),
  z.object({
    role: z.literal('tool'),
    content: z.string(),
    tool_call_id: z.string().optional(),
    name: z.string().optional()
  })
]);

const FunctionDescription = z.object({
  description: z.string().optional(),
  name: z.string(),
  parameters: z.record(z.any()) // JSON Schema object
});

const Tool = z.object({
  type: z.literal('function'),
  function: FunctionDescription
});

const ToolChoice = z.union([
  z.literal('none'),
  z.literal('auto'),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string()
    })
  })
]);

const JsonSchemaFormat = z.object({
  type: z.literal('json_schema'),
  json_schema: z.object({
    name: z.string(),
    strict: z.boolean(),
    schema: z.record(z.any()) // JSON Schema object
  })
});

const Plugin = z.object({
  id: z.string(),
  max_results: z.number().int().min(1).optional(),
  search_prompt: z.string().optional()
});

const MaxPrice = z.object({
  prompt: z.number().optional(),
  completion: z.number().optional(),
  request: z.number().optional(),
  image: z.number().optional()
});

// Main request schema
export const OpenRouterRequestSchema = z.object({
  // Required: either messages or prompt
  messages: z.array(Message).optional(),
  prompt: z.string().optional(),
  
  // Model selection
  model: z.string().optional(), // If omitted, uses user's default
  
  // Output format
  response_format: z.union([
    z.object({ type: z.literal('json_object') }),
    JsonSchemaFormat
  ]).optional(),
  
  // Basic parameters
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(), // Enable streaming
  
  // Token generation parameters
  max_tokens: z.number().int().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  
  // Tool calling
  tools: z.array(Tool).optional(),
  tool_choice: ToolChoice.optional(),
  
  // Advanced parameters
  seed: z.number().int().optional(),
  top_p: z.number().gt(0).lte(1).optional(),
  top_k: z.number().min(1).optional(), // Not for OpenAI models
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  repetition_penalty: z.number().gt(0).lte(2).optional(),
  logit_bias: z.record(z.number()).optional(),
  top_logprobs: z.number().int().optional(),
  min_p: z.number().min(0).max(1).optional(),
  top_a: z.number().min(0).max(1).optional(),
  
  // Latency optimization
  prediction: z.object({
    type: z.literal('content'),
    content: z.string()
  }).optional(),
  
  // OpenRouter-specific parameters
  transforms: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  route: z.literal('fallback').optional(),
  provider: z.record(z.any()).optional(), // ProviderPreferences
  
  // Multimodal support
  modalities: z.array(z.enum(['text', 'image'])).optional(),
  
  // Web search plugin
  plugins: z.array(Plugin).optional(),
  
  // Structured outputs
  structured_outputs: z.boolean().optional(),
  
  // Max price settings
  max_price: MaxPrice.optional(),
  
  // Logprobs
  logprobs: z.boolean().optional()
}).refine(
  data => data.messages !== undefined || data.prompt !== undefined,
  {
    message: "Either 'messages' or 'prompt' must be provided"
  }
);

// Free model IDs rotate. Keep the default in one place and let the supervisor
// inject LLM_MODEL when a different endpoint/model is preferred.
const DEFAULT_MODEL = process.env.LLM_MODEL || 'cohere/north-mini-code:free';

const defaultOptions: z.infer<typeof OpenRouterRequestSchema> = {
    model: DEFAULT_MODEL,
};

export type LLM_options = Partial<z.infer<typeof OpenRouterRequestSchema>>;

function getZodType(schema: z.ZodType<any>) {
    if (schema instanceof z.ZodString) return 'string';
    if (schema instanceof z.ZodNumber) return 'number';
    if (schema instanceof z.ZodBoolean) return 'boolean';
    if (schema instanceof z.ZodArray) return 'array';
    if (schema instanceof z.ZodEnum) return schema.options.map((opt: string) => `"${opt}"`).join(' | ');
    if (schema instanceof z.ZodObject) return 'object';
    if (schema instanceof z.ZodNullable) {
        const inner: string = getZodType(schema.unwrap());
        return `${inner} | null`;
    }
    if (schema instanceof z.ZodOptional) {
        const inner: string = getZodType(schema.unwrap());
        return `${inner} | null (optional)`; // assuming undefined treated as null
    }
    return 'unknown';
}

function convertZodToText(zodSchema: z.ZodType<any>) {
    if (!(zodSchema instanceof z.ZodObject)) {
        return getZodType(zodSchema);
    }

    const shape = zodSchema._def.shape();

    let output = '{';
    for (const key in shape) {
        const schema = shape[key];
        const described = schema.description;

        if (described) {
            output += ` ${key}: ${described},`;
        } else {
            const type = getZodType(schema);
            output += ` ${key}: ${type},`;
        }
    }
    // remove last comma
    output = output.replace(/,$/, '');
    output += '}';

    return output;
}


function formatPrompt(prompt: string | Message[], expectedFormat?: z.ZodType<any>): Message[] {
    const messages = Array.isArray(prompt) ? prompt : [{
        role: 'user' as const,
        content: prompt
    }];
    if (expectedFormat) {
        const description = convertZodToText(expectedFormat);
        const instruction = expectedFormat instanceof z.ZodObject
            ? `un objet JSON stringifie dans le format suivant (sans formatage Markdown):\`\`\`${description}\`\`\``
            : `une valeur JSON valide (pour un string, une chaine entre guillemets) decrite ainsi: ${description}`;
        messages.push({
            role: 'system' as const,
            content: `Ta reponse doit etre ${instruction}`
        });
    }
    return messages;
}

export function createUserMessage(prompt: string): Message {
    return {
        role: 'user' as const,
        content: prompt
    };
}

export function createAssistantMessage(prompt: string): Message {
    return {
        role: 'assistant' as const,
        content: prompt
    };
}

export function createSystemMessage(prompt: string): Message {
    return {
        role: 'system' as const,
        content: prompt
    };
}
async function openrouter(messages: Message[], options: LLM_options = {}) {
    const body = JSON.stringify({
        ...defaultOptions,
        ...options,
        messages
    });
    const response = await fetch(LLM_ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${BRIDGE_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body
    });
    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Erreur HTTP: ${response.status}, ${response.statusText}, ${details}`);
    }
    const responseData = await response.json();
    if(responseData.error && responseData.error.code == 429)
    {
        wsClient.error('AI', '❌Free daily limit reached', { messages, response, error: responseData.error });
        throw new Error(`Erreur free daily limit reached`);
    }
    return responseData?.choices?.[0]?.message?.content;
}
export async function query(prompt: string | Message[], expectedFormat?: z.ZodType<any>, options?: LLM_options): Promise<{ success: boolean; error?:string; data?: string | {} ; raw?: any }> {
    const messages = formatPrompt(prompt, expectedFormat);
    const maxRetries = Math.max(1, Math.min(5, Number(process.env.MAX_RETRIES) || 3));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let response = await openrouter(messages, options);
            wsClient.debug('AI', 'Ask', { messages, options, response });
            if (!response || typeof response !== 'string')
                return { success: false, error: 'Empty response', raw: null };
            if (!expectedFormat)
                return { success: true, data: response };

            // A plain string is the common case for ask_user and the manager's
            // free-text questions. Accept both raw text and a JSON string.
            if (expectedFormat instanceof z.ZodString) {
                let value = response.trim();
                if (value.startsWith('```')) {
                    value = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
                }
                try {
                    const parsed = JSON.parse(value);
                    if (typeof parsed === 'string') value = parsed;
                } catch {
                    // Raw text is valid here.
                }
                return { success: true, data: expectedFormat.parse(value), raw: response };
            }

            try {
                // Safe JSON parsing that handles potential escape characters
                let parsedResponse;
                try {
                    if(response.includes("```json"))
                        response = response.replace("```json", "").replace("```", "");
                    parsedResponse = JSON.parse(response);
                } catch (parseError) {
                    // If parsing fails, try to sanitize the string and parse again
                    const sanitizedResponse = response.replace(/\\'/g, "'").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
                    parsedResponse = JSON.parse(sanitizedResponse);
                }
                
                if (!expectedFormat) {
                    return { success: true, data: parsedResponse };
                }
                
                const validatedResponse = expectedFormat.parse(parsedResponse);
                return { success: true, data: validatedResponse, raw: parsedResponse };
            } catch (error) {
                console.error(`Attempt ${attempt}/${maxRetries}: Format parsing error:`, error, response);
                if (attempt === maxRetries) {
                    return { success: false, error: 'Invalid format after multiple attempts', raw: response };
                }
                wsClient.error('Thinking', '❌Invalid format, attempt ' + attempt + ' of ' + maxRetries, { messages, response, error });
            }
        } catch (error) {
            console.error(`Attempt ${attempt}/${maxRetries}: Request error:`, error);
            if (attempt === maxRetries) {
                return { success: false, error: error instanceof Error ? error.message : 'Unknown error', raw: error };
            }
            wsClient.error('Thinking', '❌Unexpected error, attempt ' + attempt + ' of ' + maxRetries, { messages, error });
        }
    }

    return { success: false, error: '❌Unexpected error, all attempts failed', raw: null };
}
