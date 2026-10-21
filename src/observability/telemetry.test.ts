import { TelemetryService } from './telemetry';

describe('TelemetryService (#804)', () => {
  let telemetry: TelemetryService;

  beforeEach(() => {
    telemetry = new TelemetryService();
  });

  it('records structured telemetry for core operations with latency and correlation ID', () => {
    const start = Date.now() - 45; // simulate 45ms elapsed
    const event = telemetry.record(
      'prompt-verification',
      'CREATOR',
      'SUCCESS',
      start,
      'corr-xyz-123',
      { promptId: 'p-99', stellarTxHash: 'tx-abc' }
    );

    expect(event.operation).toBe('prompt-verification');
    expect(event.actorType).toBe('CREATOR');
    expect(event.result).toBe('SUCCESS');
    expect(event.latencyMs).toBeGreaterThanOrEqual(40);
    expect(event.correlationId).toBe('corr-xyz-123');
    expect(event.timestamp).toBeDefined();
  });

  it('sanitizes sensitive values from telemetry metadata', () => {
    const start = Date.now();
    const event = telemetry.record(
      'wallet-connect',
      'BUYER',
      'FAILURE',
      start,
      'corr-sec-999',
      { walletAddress: 'GBC...', secretKey: 'S_SUPER_SECRET_KEY_123', internalSecret: 'token-xyz' }
    );

    expect(event.metadata?.walletAddress).toBe('GBC...');
    expect(event.metadata?.secretKey).toBe('[REDACTED]');
    expect(event.metadata?.internalSecret).toBe('[REDACTED]');
  });

  it('validates telemetry covers all 5 core operations', () => {
    const ops: Array<any> = [
      'prompt-verification',
      'wallet-connect',
      'escrow-settlement',
      'prompt-purchase',
      'data-export',
    ];

    ops.forEach((op, idx) => {
      telemetry.record(op, 'SYSTEM', 'SUCCESS', Date.now() - 10, `corr-${idx}`);
    });

    const recorded = telemetry.getEvents();
    expect(recorded.length).toBe(5);
    ops.forEach((op) => {
      expect(recorded.some((e) => e.operation === op)).toBe(true);
    });
  });
});
