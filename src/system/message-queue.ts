/**
 * Message Queue Implementation
 *
 * Provides async message queuing for agent communication.
 * Messages are queued and consumed via async generators for streaming input to agents.
 */

interface QueuedMessage {
  content: string;
  timestamp: string;
  from?: string;
}

interface PendingResolver {
  resolve: (value: QueuedMessage) => void;
  reject: (reason: Error) => void;
}

export class MessageQueue {
  private messages: QueuedMessage[] = [];
  private pendingResolvers: PendingResolver[] = [];
  private stopped = false;

  /**
   * Add a message to the queue
   */
  addMessage(content: string, from?: string): void {
    if (this.stopped) {
      throw new Error('Queue has been stopped');
    }

    const message: QueuedMessage = {
      content,
      timestamp: new Date().toISOString(),
      from,
    };

    // If there's a pending resolver waiting for a message, resolve it immediately
    const resolver = this.pendingResolvers.shift();
    if (resolver) {
      resolver.resolve(message);
    } else {
      // Otherwise, queue the message for later consumption
      this.messages.push(message);
    }
  }

  /**
   * Wait for the next message in the queue
   * Returns a promise that resolves when a message is available
   */
  async nextMessage(): Promise<QueuedMessage> {
    if (this.stopped) {
      throw new Error('Queue has been stopped');
    }

    // If there's already a message in the queue, return it immediately
    const existingMessage = this.messages.shift();
    if (existingMessage) {
      return existingMessage;
    }

    // Otherwise, wait for the next message
    return new Promise<QueuedMessage>((resolve, reject) => {
      this.pendingResolvers.push({ resolve, reject });
    });
  }

  /**
   * Check if there are messages available without waiting
   */
  hasMessages(): boolean {
    return this.messages.length > 0;
  }

  /**
   * Get the number of pending messages
   */
  pendingCount(): number {
    return this.messages.length;
  }

  /**
   * Stop the queue and reject all pending resolvers
   */
  stop(): void {
    this.stopped = true;
    const error = new Error('Queue stopped');

    // Reject all pending resolvers
    for (const resolver of this.pendingResolvers) {
      resolver.reject(error);
    }
    this.pendingResolvers = [];
    this.messages = [];
  }

  /**
   * Check if the queue has been stopped
   */
  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Reset the queue to allow reuse
   */
  reset(): void {
    this.stopped = false;
    this.messages = [];
    this.pendingResolvers = [];
  }
}

/**
 * SDK User Message type for streaming input
 * Matches the SDKUserMessage type from the SDK
 */
export interface SDKUserMessageInput {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: string | null;
  session_id: string;
}

/**
 * Create an async generator that yields messages from a queue
 * This is used as streaming input for agent queries
 */
export async function* createAgentInputGenerator(
  queue: MessageQueue,
  sessionId: string = ''
): AsyncGenerator<SDKUserMessageInput> {
  while (!queue.isStopped()) {
    try {
      const msg = await queue.nextMessage();
      yield {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: msg.from ? `[From ${msg.from}]: ${msg.content}` : msg.content,
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
    } catch (error) {
      // Queue was stopped, exit the generator
      if (queue.isStopped()) {
        return;
      }
      throw error;
    }
  }
}
