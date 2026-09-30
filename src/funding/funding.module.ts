import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FundingController } from './funding.controller';
import { FundingService } from './funding.service';
import { FundingRate, FundingRateSchema } from './schemas/funding-rate.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: FundingRate.name, schema: FundingRateSchema }])],
  controllers: [FundingController],
  providers: [FundingService],
})
export class FundingModule {}
