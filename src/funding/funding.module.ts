import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FundingController } from './funding.controller';
import { FundingHistoryService } from './funding-history.service';
import { FundingService } from './funding.service';
import { FundingHistory, FundingHistorySchema } from './schemas/funding-history.schema';
import { FundingRate, FundingRateSchema } from './schemas/funding-rate.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FundingRate.name, schema: FundingRateSchema },
      { name: FundingHistory.name, schema: FundingHistorySchema },
    ]),
  ],
  controllers: [FundingController],
  providers: [FundingService, FundingHistoryService],
  exports: [FundingHistoryService],
})
export class FundingModule {}
