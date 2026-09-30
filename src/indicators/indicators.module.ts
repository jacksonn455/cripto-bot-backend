import { Module } from '@nestjs/common';
import { IndicatorsService } from './indicators.service';

@Module({
  providers: [IndicatorsService],
  exports: [IndicatorsService],
})
export class IndicatorsModule {}
