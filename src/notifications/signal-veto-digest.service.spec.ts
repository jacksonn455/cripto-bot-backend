import type { NotificationsService } from './notifications.service';
import type { SignalRecordedEvent } from './report-notices';
import { SignalVetoDigestService } from './signal-veto-digest.service';

function signal(overrides: Partial<SignalRecordedEvent> = {}): SignalRecordedEvent {
  return {
    symbol: 'BTCUSDT',
    strategy: 'TrendRegimeStrategy',
    signal: 'BUY',
    price: 65_000,
    approved: false,
    rejectReason: 'MAX_OPEN_POSITIONS',
    mode: 'PAPER',
    candleTime: '2026-10-01T10:59:59.999Z',
    ...overrides,
  };
}

function make(minutes: number) {
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const service = new SignalVetoDigestService(
    { dispatch } as unknown as NotificationsService,
    { signalVetoDigestMinutes: minutes, timeZone: 'America/Sao_Paulo' } as never,
  );
  return { service, dispatch };
}

describe('SignalVetoDigestService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('groups every veto of the window into one notification', () => {
    const { service, dispatch } = make(60);
    service.onSignal(signal());
    service.onSignal(signal({ symbol: 'ETHUSDT' }));
    expect(dispatch).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60 * 60_000);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].report.headline).toBe('2 sinais vetados pelo risco');
  });

  it('ignores approved signals (they become trade.opened)', () => {
    const { service, dispatch } = make(60);
    service.onSignal(signal({ approved: true, rejectReason: null }));
    jest.advanceTimersByTime(60 * 60_000);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('sends each veto immediately when the window is 0', () => {
    const { service, dispatch } = make(0);
    service.onSignal(signal());
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].report.headline).toBe('Sinal vetado pelo risco');
  });

  it('flushes the open window on shutdown', () => {
    const { service, dispatch } = make(60);
    service.onSignal(signal());
    service.onModuleDestroy();
    expect(dispatch).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60 * 60_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
