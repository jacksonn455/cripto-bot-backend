import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ControlModule } from '../../control/control.module';
import { BotEvent, BotEventSchema } from '../../events/schemas/bot-event.schema';
import { EquitySnapshot, EquitySnapshotSchema } from '../../reports/schemas/equity-snapshot.schema';
import { SignalRecord, SignalSchema } from '../../risk/schemas/signal.schema';
import { Trade, TradeSchema } from '../../trades/schemas/trade.schema';
import { NotificationsModule } from '../notifications.module';
import { DailyReportService } from './daily-report.service';
import { DailyReportRun, DailyReportRunSchema } from './schemas/daily-report-run.schema';

/** Separate from NotificationsModule so that one stays free of trading/control dependencies. */
@Module({
  imports: [
    NotificationsModule,
    ControlModule,
    MongooseModule.forFeature([
      { name: DailyReportRun.name, schema: DailyReportRunSchema },
      { name: Trade.name, schema: TradeSchema },
      { name: EquitySnapshot.name, schema: EquitySnapshotSchema },
      { name: BotEvent.name, schema: BotEventSchema },
      { name: SignalRecord.name, schema: SignalSchema },
    ]),
  ],
  providers: [DailyReportService],
})
export class DailyReportModule {}
