import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { BotEvent, BotEventSchema } from './schemas/bot-event.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: BotEvent.name, schema: BotEventSchema }])],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
