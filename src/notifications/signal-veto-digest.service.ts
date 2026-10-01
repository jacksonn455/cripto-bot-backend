import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { notificationsConfig } from '../config/configuration';
import { formatClock } from '../incidents/incident-format.util';
import { NotificationsService } from './notifications.service';
import { signalVetoDigestNotice, type SignalRecordedEvent } from './report-notices';

/**
 * Risk-vetoed entry signals (paper/live) → one grouped notification per SIGNAL_VETO_DIGEST_MINUTES
 * window, so a strategy hitting the same veto every candle produces one message, not dozens.
 * The window opens on the first veto; 0 sends each veto on its own. Approved signals aren't
 * reported here: they become `trade.opened`.
 */
@Injectable()
export class SignalVetoDigestService implements OnModuleDestroy {
  private pending: SignalRecordedEvent[] = [];
  private windowStart?: Date;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly notifications: NotificationsService,
    @Inject(notificationsConfig.KEY) private readonly config: ReturnType<typeof notificationsConfig>,
  ) {}

  @OnEvent('signal.recorded')
  onSignal(e: SignalRecordedEvent): void {
    if (e.approved) return;
    this.pending.push(e);
    this.windowStart ??= new Date();
    const windowMs = this.config.signalVetoDigestMinutes * 60_000;
    if (windowMs === 0) return this.flush();
    this.timer ??= setTimeout(() => this.flush(), windowMs);
  }

  /** Sends what is pending (also on shutdown, so a restart doesn't drop the open window). */
  flush(now = new Date()): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const vetoes = this.pending;
    const from = this.windowStart ?? now;
    this.pending = [];
    this.windowStart = undefined;
    const notice = signalVetoDigestNotice(vetoes, from, now, (d) => formatClock(d, this.config.timeZone));
    void this.notifications.dispatch({ kind: 'report', report: notice });
  }

  onModuleDestroy(): void {
    this.flush();
  }
}
