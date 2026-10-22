export type ActorType = 'CREATOR' | 'BUYER' | 'ADMIN' | 'SYSTEM';
export type OperationResult = 'SUCCESS' | 'FAILURE';

export type CoreOperation = 
  | 'prompt-verification'
  | 'wallet-connect'
  | 'escrow-settlement'
  | 'prompt-purchase'
  | 'data-export';

export interface TelemetryEvent {
  operation: CoreOperation;
  actorType: ActorType;
  result: OperationResult;
  latencyMs: number;
  correlationId: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export class TelemetryService {
  private events: TelemetryEvent[] = [];

  private sanitize(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!metadata) return undefined;
    const sanitized = { ...metadata };
    const sensitiveKeys = ['secret', 'privateKey', 'seed', 'password', 'token', 'internalSecret'];
    
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
        sanitized[key] = '[REDACTED]';
      }
    }
    return sanitized;
  }

  public record(
    operation: CoreOperation,
    actorType: ActorType,
    result: OperationResult,
    startTimeMs: number,
    correlationId: string,
    metadata?: Record<string, unknown>
  ): TelemetryEvent {
    const latencyMs = Date.now() - startTimeMs;
    const event: TelemetryEvent = {
      operation,
      actorType,
      result,
      latencyMs,
      correlationId,
      timestamp: new Date().toISOString(),
      metadata: this.sanitize(metadata),
    };

    this.events.push(event);
    console.log(`[Telemetry] ${JSON.stringify(event)}`);
    return event;
  }

  public getEvents(): TelemetryEvent[] {
    return this.events;
  }

  public clear(): void {
    this.events = [];
  }
}

export const globalTelemetry = new TelemetryService();
