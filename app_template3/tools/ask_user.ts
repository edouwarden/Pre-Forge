import { wsClient } from '../wsClient';

export async function ask_user(question: string) {
  try {
    if (!question || typeof question !== 'string') {
      return { error: 'No question provided' };
    }
    if (question.length > 2000) {
      return { error: 'Question is too long (max 2000 characters)' };
    }

    const response = await wsClient.askUser(question);

    return {
      success: true,
      answer: response,
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to get user response: ${error.message}`,
    };
  }
}
