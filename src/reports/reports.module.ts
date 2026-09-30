import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Trade, TradeSchema } from '../trades/schemas/trade.schema';
import { EquitySnapshot, EquitySnapshotSchema } from './schemas/equity-snapshot.schema';
import { EquitySnapshotsService } from './equity-snapshots.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Trade.name, schema: TradeSchema },
      { name: EquitySnapshot.name, schema: EquitySnapshotSchema },
    ]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService, EquitySnapshotsService],
  exports: [ReportsService, EquitySnapshotsService],
})
export class ReportsModule {}
